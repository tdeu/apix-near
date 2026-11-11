#![allow(unused_must_use)]
use super::*;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;

fn vault_id() -> AccountId {
    "vault.owner.testnet".parse().unwrap()
}
fn owner() -> AccountId {
    "owner.testnet".parse().unwrap()
}
fn shop() -> AccountId {
    "shop.testnet".parse().unwrap()
}
fn stranger() -> AccountId {
    "stranger.testnet".parse().unwrap()
}
fn agent_pk() -> PublicKey {
    "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp".parse().unwrap()
}
fn other_pk() -> PublicKey {
    "ed25519:DcA2MzgpJbrUATQLLceocVckhhAqrkingax4oJ9kZ847".parse().unwrap()
}
fn near(n: u128) -> NearToken {
    NearToken::from_near(n)
}
fn milli(n: u128) -> NearToken {
    NearToken::from_millinear(n)
}

/// Context for a call made with an agent key on the vault account
fn as_agent(pk: PublicKey, now_ns: u64) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(vault_id())
        .predecessor_account_id(vault_id())
        .signer_account_id(vault_id())
        .signer_account_pk(pk)
        .account_balance(near(10))
        .block_timestamp(now_ns)
        .build());
}

fn as_account(account: AccountId) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(vault_id())
        .predecessor_account_id(account.clone())
        .signer_account_id(account)
        .account_balance(near(10))
        .build());
}

fn new_vault() -> AgentVault {
    as_account(owner());
    AgentVault::new(owner(), milli(500), near(2), vec![shop()], Some(agent_pk()))
}

#[test]
fn agent_pays_within_policy() {
    let mut vault = new_vault();
    as_agent(agent_pk(), 0);
    vault.pay(shop(), milli(400), Some("api credits".into()));
    let status = vault.get_status();
    assert_eq!(status.spent_in_window, milli(400));
    assert_eq!(status.remaining_today, milli(1600));
    assert_eq!(status.payments_made, 1);
}

#[test]
#[should_panic(expected = "POLICY: amount 0.6 NEAR exceeds the per-transaction limit")]
fn per_transaction_limit_is_enforced() {
    let mut vault = new_vault();
    as_agent(agent_pk(), 0);
    vault.pay(shop(), milli(600), None);
}

#[test]
#[should_panic(expected = "over the daily limit")]
fn daily_limit_is_enforced() {
    let mut vault = new_vault();
    as_agent(agent_pk(), 0);
    for _ in 0..4 {
        vault.pay(shop(), milli(500), None);
    }
    vault.pay(shop(), milli(1), None);
}

#[test]
fn daily_window_resets_after_24h() {
    let mut vault = new_vault();
    as_agent(agent_pk(), 0);
    for _ in 0..4 {
        vault.pay(shop(), milli(500), None);
    }
    as_agent(agent_pk(), WINDOW_NS);
    vault.pay(shop(), milli(500), None);
    assert_eq!(vault.get_status().spent_in_window, milli(500));
}

#[test]
#[should_panic(expected = "POLICY: receiver stranger.testnet is not on the allowlist")]
fn allowlist_is_enforced() {
    let mut vault = new_vault();
    as_agent(agent_pk(), 0);
    vault.pay(stranger(), milli(1), None);
}

#[test]
#[should_panic(expected = "POLICY: vault is paused")]
fn paused_vault_refuses_payments() {
    let mut vault = new_vault();
    as_account(owner());
    vault.pause();
    as_agent(agent_pk(), 0);
    vault.pay(shop(), milli(1), None);
}

#[test]
#[should_panic(expected = "signing key is not a registered agent key")]
fn unregistered_key_is_refused() {
    let mut vault = new_vault();
    as_agent(other_pk(), 0);
    vault.pay(shop(), milli(1), None);
}

#[test]
#[should_panic(expected = "only an agent key on this vault can call this method")]
fn other_accounts_cannot_pay() {
    let mut vault = new_vault();
    as_account(stranger());
    vault.pay(shop(), milli(1), None);
}

#[test]
#[should_panic(expected = "only an agent key on this vault can call this method")]
fn owner_cannot_use_agent_methods() {
    let mut vault = new_vault();
    as_account(owner());
    vault.pay(shop(), milli(1), None);
}

#[test]
#[should_panic(expected = "only the vault owner can call this method")]
fn agent_cannot_change_policy() {
    let mut vault = new_vault();
    as_agent(agent_pk(), 0);
    vault.set_limits(near(100), near(100));
}

#[test]
#[should_panic(expected = "only the vault owner can call this method")]
fn agent_cannot_approve_its_own_request() {
    let mut vault = new_vault();
    as_agent(agent_pk(), 0);
    let id = vault.request_approval(shop(), near(1), None, None);
    vault.approve(id);
}

#[test]
fn over_limit_payment_goes_through_owner_approval() {
    let mut vault = new_vault();
    as_agent(agent_pk(), 0);
    let id = vault.request_approval(shop(), near(1), Some("annual plan".into()), Some("over per-tx limit".into()));
    assert_eq!(vault.get_pending().len(), 1);
    assert_eq!(vault.get_pending()[0].amount, near(1));

    as_account(owner());
    vault.approve(id);
    assert!(vault.get_pending().is_empty());
    assert_eq!(vault.get_status().payments_made, 1);
}

#[test]
fn owner_can_reject_a_request() {
    let mut vault = new_vault();
    as_agent(agent_pk(), 0);
    let id = vault.request_approval(shop(), near(1), None, None);
    as_account(owner());
    vault.reject(id);
    assert!(vault.get_pending().is_empty());
    assert_eq!(vault.get_status().payments_made, 0);
}

#[test]
#[should_panic(expected = "POLICY: receiver is not on the allowlist")]
fn approval_requests_cannot_add_new_receivers() {
    let mut vault = new_vault();
    as_agent(agent_pk(), 0);
    vault.request_approval(stranger(), near(1), None, None);
}

#[test]
#[should_panic(expected = "too many pending requests")]
fn pending_requests_are_capped() {
    let mut vault = new_vault();
    as_agent(agent_pk(), 0);
    for _ in 0..=MAX_PENDING {
        vault.request_approval(shop(), near(1), None, None);
    }
}

#[test]
fn revoked_key_is_removed() {
    let mut vault = new_vault();
    as_account(owner());
    vault.revoke_agent_key(agent_pk());
    assert!(vault.get_agent_keys().is_empty());
}

#[test]
#[should_panic(expected = "signing key is not a registered agent key")]
fn revoked_key_cannot_pay() {
    let mut vault = new_vault();
    as_account(owner());
    vault.revoke_agent_key(agent_pk());
    as_agent(agent_pk(), 0);
    vault.pay(shop(), milli(1), None);
}

#[test]
fn owner_adds_a_second_agent_key() {
    let mut vault = new_vault();
    as_account(owner());
    vault.add_agent_key(other_pk());
    as_agent(other_pk(), 0);
    vault.pay(shop(), milli(1), None);
}

#[test]
fn check_payment_explains_without_spending() {
    let vault = new_vault();
    as_agent(agent_pk(), 0);
    assert_eq!(vault.check_payment(shop(), milli(100)), None);
    assert!(vault.check_payment(shop(), near(1)).unwrap().contains("per-transaction limit"));
    assert!(vault.check_payment(stranger(), milli(1)).unwrap().contains("allowlist"));
}

#[test]
#[should_panic(expected = "per_tx_limit can't be higher than daily_limit")]
fn limits_must_be_consistent() {
    as_account(owner());
    AgentVault::new(owner(), near(3), near(2), vec![], None);
}

#[test]
fn memo_is_trimmed_and_cleaned() {
    let long = "a".repeat(1000) + "\n";
    let cleaned = clean_memo(Some(long)).unwrap();
    assert_eq!(cleaned.len(), MAX_MEMO_LEN);
    assert_eq!(clean_memo(Some("\n\t".into())), None);
}
