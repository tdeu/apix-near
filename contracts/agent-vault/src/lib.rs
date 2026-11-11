//! APIX Agent Vault
//!
//! Gives an AI agent money on NEAR without giving it the keys to everything.
//!
//! The vault account is created by APIX in one transaction that deploys this
//! contract and adds a single *function-call* access key for the agent, limited
//! to `pay` and `request_approval` on this contract. No full-access key is ever
//! added, so nobody (not the agent, not the owner, not APIX) holds a key that can
//! bypass the rules below. Everything the owner does goes through owner-only
//! methods, checked against `predecessor_account_id`.
//!
//! Rules enforced on-chain for every agent payment:
//!   - the vault is not paused
//!   - the call is signed by a registered agent key on this account
//!   - the receiver is on the allowlist
//!   - amount <= per-transaction limit
//!   - amount + spent in the current 24h window <= daily limit
//!   - the vault keeps enough balance for its own storage and a gas reserve
//!
//! A payment that breaks a limit can instead be filed with `request_approval`;
//! it waits for the owner to `approve` or `reject` it.

use near_sdk::store::{IterableMap, IterableSet};
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, Promise, PublicKey,
};
use near_sdk::Allowance;

/// One day, in nanoseconds (block timestamps are in ns)
pub const WINDOW_NS: u64 = 24 * 60 * 60 * 1_000_000_000;
/// Kept back from payments so the vault can always pay its storage and the
/// agent key's gas allowance.
pub const GAS_RESERVE: NearToken = NearToken::from_millinear(100);
/// Gas allowance given to each agent key (spent from the vault balance)
pub const AGENT_KEY_ALLOWANCE: NearToken = NearToken::from_millinear(250);
/// Methods an agent key may call
pub const AGENT_METHODS: &str = "pay,request_approval";
/// Upper bound on a memo, to keep storage and logs small
pub const MAX_MEMO_LEN: usize = 256;
/// Upper bound on open approval requests, so a leaked key can't fill storage
pub const MAX_PENDING: u32 = 20;

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Allowlist,
    AgentKeys,
    Pending,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Policy {
    pub per_tx_limit: NearToken,
    pub daily_limit: NearToken,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct PaymentRequest {
    pub id: u64,
    pub receiver_id: AccountId,
    pub amount: NearToken,
    pub memo: Option<String>,
    pub reason: String,
    pub requested_at_ns: u64,
}

#[near(serializers = [json])]
pub struct SpendStatus {
    pub paused: bool,
    pub policy: Policy,
    pub spent_in_window: NearToken,
    pub remaining_today: NearToken,
    pub window_resets_at_ns: u64,
    pub available_balance: NearToken,
    pub payments_made: u64,
    pub pending_requests: u32,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct AgentVault {
    owner_id: AccountId,
    policy: Policy,
    paused: bool,
    allowlist: IterableSet<AccountId>,
    agent_keys: IterableSet<PublicKey>,
    window_start_ns: u64,
    spent_in_window: NearToken,
    payments_made: u64,
    next_request_id: u64,
    pending: IterableMap<u64, PaymentRequest>,
}

#[near]
impl AgentVault {
    /// Called once, in the same transaction that creates the vault account.
    #[init]
    pub fn new(
        owner_id: AccountId,
        per_tx_limit: NearToken,
        daily_limit: NearToken,
        allowlist: Vec<AccountId>,
        agent_key: Option<PublicKey>,
    ) -> Self {
        validate_limits(per_tx_limit, daily_limit);
        let mut vault = Self {
            owner_id,
            policy: Policy { per_tx_limit, daily_limit },
            paused: false,
            allowlist: IterableSet::new(StorageKey::Allowlist),
            agent_keys: IterableSet::new(StorageKey::AgentKeys),
            window_start_ns: env::block_timestamp(),
            spent_in_window: NearToken::from_yoctonear(0),
            payments_made: 0,
            next_request_id: 0,
            pending: IterableMap::new(StorageKey::Pending),
        };
        for account in allowlist {
            vault.allowlist.insert(account);
        }
        // The key itself is added by the creating transaction (AddKey action);
        // here we only record it as an agent key.
        if let Some(key) = agent_key {
            vault.agent_keys.insert(key);
        }
        vault
    }

    // ---------------------------------------------------------------- agent

    /// Pay `amount` to `receiver_id`, within the policy. Panics with a reason
    /// starting with "POLICY:" when a rule is broken.
    pub fn pay(&mut self, receiver_id: AccountId, amount: NearToken, memo: Option<String>) -> Promise {
        self.assert_agent();
        let memo = clean_memo(memo);
        if let Some(reason) = self.policy_violation(&receiver_id, amount) {
            env::panic_str(&format!("POLICY: {reason}"));
        }
        self.spent_in_window = self.spent_in_window.saturating_add(amount);
        self.payments_made += 1;
        log_event(
            "payment",
            &format!(
                r#"{{"receiver_id":"{}","amount":"{}","memo":{}}}"#,
                receiver_id,
                amount.as_yoctonear(),
                json_string_or_null(&memo)
            ),
        );
        Promise::new(receiver_id).transfer(amount)
    }

    /// File a payment the policy would refuse, for the owner to approve.
    /// The receiver must still be on the allowlist and the vault not paused:
    /// approvals are for amounts, not for new destinations.
    pub fn request_approval(
        &mut self,
        receiver_id: AccountId,
        amount: NearToken,
        memo: Option<String>,
        reason: Option<String>,
    ) -> u64 {
        self.assert_agent();
        require!(!self.paused, "POLICY: vault is paused");
        require!(
            self.allowlist.contains(&receiver_id),
            "POLICY: receiver is not on the allowlist"
        );
        require!(amount.as_yoctonear() > 0, "amount must be greater than 0");
        require!(self.pending.len() < MAX_PENDING, "too many pending requests");
        let id = self.next_request_id;
        self.next_request_id += 1;
        let request = PaymentRequest {
            id,
            receiver_id,
            amount,
            memo: clean_memo(memo),
            reason: clean_memo(reason).unwrap_or_else(|| "over limit".to_string()),
            requested_at_ns: env::block_timestamp(),
        };
        log_event("approval_requested", &format!(r#"{{"id":{id},"amount":"{}"}}"#, amount.as_yoctonear()));
        self.pending.insert(id, request);
        id
    }

    // ---------------------------------------------------------------- owner

    pub fn approve(&mut self, id: u64) -> Promise {
        self.assert_owner();
        let request = self.pending.remove(&id).unwrap_or_else(|| env::panic_str("no such request"));
        require!(
            request.amount <= self.available_balance(),
            "vault balance too low for this payment"
        );
        self.payments_made += 1;
        log_event("approved", &format!(r#"{{"id":{id}}}"#));
        Promise::new(request.receiver_id).transfer(request.amount)
    }

    pub fn reject(&mut self, id: u64) {
        self.assert_owner();
        require!(self.pending.remove(&id).is_some(), "no such request");
        log_event("rejected", &format!(r#"{{"id":{id}}}"#));
    }

    pub fn set_limits(&mut self, per_tx_limit: NearToken, daily_limit: NearToken) {
        self.assert_owner();
        validate_limits(per_tx_limit, daily_limit);
        self.policy = Policy { per_tx_limit, daily_limit };
    }

    pub fn allow_receiver(&mut self, account_id: AccountId) {
        self.assert_owner();
        self.allowlist.insert(account_id);
    }

    pub fn remove_receiver(&mut self, account_id: AccountId) {
        self.assert_owner();
        self.allowlist.remove(&account_id);
    }

    pub fn pause(&mut self) {
        self.assert_owner();
        self.paused = true;
        log_event("paused", "{}");
    }

    pub fn unpause(&mut self) {
        self.assert_owner();
        self.paused = false;
        log_event("unpaused", "{}");
    }

    /// Add a new agent key, limited to `pay` and `request_approval` on this vault.
    pub fn add_agent_key(&mut self, public_key: PublicKey) -> Promise {
        self.assert_owner();
        require!(!self.agent_keys.contains(&public_key), "key is already an agent key");
        self.agent_keys.insert(public_key.clone());
        Promise::new(env::current_account_id()).add_access_key_allowance(
            public_key,
            Allowance::limited(AGENT_KEY_ALLOWANCE).unwrap(),
            env::current_account_id(),
            AGENT_METHODS,
        )
    }

    /// Delete an agent key from the vault account. Takes effect immediately.
    pub fn revoke_agent_key(&mut self, public_key: PublicKey) -> Promise {
        self.assert_owner();
        require!(self.agent_keys.remove(&public_key), "not an agent key");
        log_event("key_revoked", "{}");
        Promise::new(env::current_account_id()).delete_key(public_key)
    }

    /// Send funds back to the owner.
    pub fn withdraw(&mut self, amount: NearToken) -> Promise {
        self.assert_owner();
        require!(amount <= self.available_balance(), "amount exceeds available balance");
        Promise::new(self.owner_id.clone()).transfer(amount)
    }

    // ---------------------------------------------------------------- views

    pub fn get_owner(&self) -> AccountId {
        self.owner_id.clone()
    }

    pub fn get_policy(&self) -> Policy {
        self.policy.clone()
    }

    pub fn get_status(&self) -> SpendStatus {
        let (spent, resets_at) = self.current_window();
        SpendStatus {
            paused: self.paused,
            policy: self.policy.clone(),
            spent_in_window: spent,
            remaining_today: self.policy.daily_limit.saturating_sub(spent),
            window_resets_at_ns: resets_at,
            available_balance: self.available_balance(),
            payments_made: self.payments_made,
            pending_requests: self.pending.len(),
        }
    }

    pub fn get_allowlist(&self) -> Vec<AccountId> {
        self.allowlist.iter().cloned().collect()
    }

    pub fn get_agent_keys(&self) -> Vec<PublicKey> {
        self.agent_keys.iter().cloned().collect()
    }

    pub fn get_pending(&self) -> Vec<PaymentRequest> {
        self.pending.values().cloned().collect()
    }

    /// Dry run: why would `pay` refuse this payment right now? None means it would go through.
    pub fn check_payment(&self, receiver_id: AccountId, amount: NearToken) -> Option<String> {
        let mut copy_window = (self.window_start_ns, self.spent_in_window);
        if env::block_timestamp().saturating_sub(copy_window.0) >= WINDOW_NS {
            copy_window = (env::block_timestamp(), NearToken::from_yoctonear(0));
        }
        self.violation_with_window(&receiver_id, amount, copy_window.1)
    }

    // ---------------------------------------------------------------- internal

    fn assert_owner(&self) {
        require!(
            env::predecessor_account_id() == self.owner_id,
            "only the vault owner can call this method"
        );
    }

    /// Agent calls come from a function-call key on this very account, so the
    /// predecessor is the vault itself and the signer key is a registered agent key.
    fn assert_agent(&self) {
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "only an agent key on this vault can call this method"
        );
        require!(
            self.agent_keys.contains(&env::signer_account_pk()),
            "signing key is not a registered agent key"
        );
    }

    /// Roll the 24h window if it has expired, then check the rules.
    fn policy_violation(&mut self, receiver_id: &AccountId, amount: NearToken) -> Option<String> {
        let now = env::block_timestamp();
        if now.saturating_sub(self.window_start_ns) >= WINDOW_NS {
            self.window_start_ns = now;
            self.spent_in_window = NearToken::from_yoctonear(0);
        }
        self.violation_with_window(receiver_id, amount, self.spent_in_window)
    }

    fn violation_with_window(&self, receiver_id: &AccountId, amount: NearToken, spent: NearToken) -> Option<String> {
        if self.paused {
            return Some("vault is paused".into());
        }
        if amount.as_yoctonear() == 0 {
            return Some("amount must be greater than 0".into());
        }
        if !self.allowlist.contains(receiver_id) {
            return Some(format!("receiver {receiver_id} is not on the allowlist"));
        }
        if amount > self.policy.per_tx_limit {
            return Some(format!(
                "amount {} exceeds the per-transaction limit of {}",
                amount.exact_amount_display(),
                self.policy.per_tx_limit.exact_amount_display()
            ));
        }
        let after = spent.saturating_add(amount);
        if after > self.policy.daily_limit {
            return Some(format!(
                "amount would bring today's spending to {}, over the daily limit of {}",
                after.exact_amount_display(),
                self.policy.daily_limit.exact_amount_display()
            ));
        }
        if amount > self.available_balance() {
            return Some("vault balance too low for this payment".into());
        }
        None
    }

    fn current_window(&self) -> (NearToken, u64) {
        let now = env::block_timestamp();
        if now.saturating_sub(self.window_start_ns) >= WINDOW_NS {
            (NearToken::from_yoctonear(0), now + WINDOW_NS)
        } else {
            (self.spent_in_window, self.window_start_ns + WINDOW_NS)
        }
    }

    /// Balance the vault can spend: total minus storage staking and the gas reserve.
    fn available_balance(&self) -> NearToken {
        let storage = env::storage_byte_cost().saturating_mul(env::storage_usage() as u128);
        env::account_balance()
            .saturating_sub(storage)
            .saturating_sub(GAS_RESERVE)
    }
}

fn validate_limits(per_tx_limit: NearToken, daily_limit: NearToken) {
    require!(per_tx_limit.as_yoctonear() > 0, "per_tx_limit must be greater than 0");
    require!(per_tx_limit <= daily_limit, "per_tx_limit can't be higher than daily_limit");
}

fn clean_memo(memo: Option<String>) -> Option<String> {
    memo.map(|m| m.chars().filter(|c| !c.is_control()).take(MAX_MEMO_LEN).collect::<String>())
        .filter(|m| !m.is_empty())
}

fn json_string_or_null(value: &Option<String>) -> String {
    match value {
        Some(v) => near_sdk::serde_json::to_string(v).unwrap(),
        None => "null".into(),
    }
}

/// NEP-297 event log
fn log_event(event: &str, data: &str) {
    env::log_str(&format!(
        r#"EVENT_JSON:{{"standard":"apix-agent-vault","version":"1.0.0","event":"{event}","data":[{data}]}}"#
    ));
}

#[cfg(test)]
mod tests;
