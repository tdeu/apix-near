//! APIX Attestations
//!
//! A public record of what `apix verify` checked. Anyone can attest; each
//! record is keyed by (attester, app_id), so an app's own team and independent
//! reviewers can each publish theirs, and readers decide whom to trust.
//!
//! What is stored is a SHA-256 hash of the full JSON report plus a short
//! summary. The report itself stays with the app (in its repo, for example),
//! and anyone can recompute its hash with `apix verify --check-attestation`.
//! The format is chain-agnostic: the same report and hash can be attested on
//! another ledger.

use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, Promise};

pub const MAX_FIELD: usize = 200;

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Latest,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Attestation {
    pub attester: AccountId,
    pub app_id: String,
    /// sha256 of the canonical JSON report, 64 lowercase hex characters
    pub report_hash: String,
    /// "pass", "warn" or "fail"
    pub verdict: String,
    pub checks_run: u32,
    pub failures: u32,
    pub warnings: u32,
    pub apix_version: String,
    /// Where the report and the code live, e.g. a commit URL (optional)
    pub source: Option<String>,
    pub timestamp_ns: u64,
    /// How many times this attester has attested this app, this one included
    pub revision: u32,
}

#[near(serializers = [json])]
pub struct AttestInput {
    pub app_id: String,
    pub report_hash: String,
    pub verdict: String,
    pub checks_run: u32,
    pub failures: u32,
    pub warnings: u32,
    pub apix_version: String,
    pub source: Option<String>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Attestations {
    latest: LookupMap<(AccountId, String), Attestation>,
    total: u64,
}

#[near]
impl Attestations {
    #[init]
    pub fn new() -> Self {
        Self { latest: LookupMap::new(StorageKey::Latest), total: 0 }
    }

    /// Record an attestation. Attach a deposit to cover storage (0.01 NEAR is
    /// plenty); anything unused is refunded.
    #[payable]
    pub fn attest(&mut self, input: AttestInput) -> Attestation {
        validate(&input);
        let attester = env::predecessor_account_id();
        let key = (attester.clone(), input.app_id.clone());
        let revision = self.latest.get(&key).map(|a| a.revision + 1).unwrap_or(1);
        let attestation = Attestation {
            attester: attester.clone(),
            app_id: input.app_id,
            report_hash: input.report_hash,
            verdict: input.verdict,
            checks_run: input.checks_run,
            failures: input.failures,
            warnings: input.warnings,
            apix_version: input.apix_version,
            source: input.source,
            timestamp_ns: env::block_timestamp(),
            revision,
        };

        let before = env::storage_usage();
        self.latest.insert(key, attestation.clone());
        self.latest.flush();
        self.total += 1;
        let used = env::storage_usage().saturating_sub(before);
        let cost = env::storage_byte_cost().saturating_mul(used as u128);
        let deposit = env::attached_deposit();
        require!(
            deposit >= cost,
            format!("attach at least {} to cover storage", cost.exact_amount_display())
        );
        let refund = deposit.saturating_sub(cost);
        if refund > NearToken::from_yoctonear(0) {
            Promise::new(attester).transfer(refund).detach();
        }

        env::log_str(&format!(
            "EVENT_JSON:{}",
            near_sdk::serde_json::json!({
                "standard": "apix-attestation",
                "version": "1.0.0",
                "event": "attested",
                "data": [attestation]
            })
        ));
        attestation
    }

    pub fn get_attestation(&self, attester: AccountId, app_id: String) -> Option<Attestation> {
        self.latest.get(&(attester, app_id)).cloned()
    }

    pub fn get_total(&self) -> u64 {
        self.total
    }
}

fn validate(input: &AttestInput) {
    require!(
        !input.app_id.is_empty() && input.app_id.len() <= MAX_FIELD,
        "app_id must be 1-200 characters"
    );
    require!(
        input.report_hash.len() == 64
            && input.report_hash.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)),
        "report_hash must be a lowercase hex sha256 (64 characters)"
    );
    require!(
        ["pass", "warn", "fail"].contains(&input.verdict.as_str()),
        "verdict must be pass, warn or fail"
    );
    require!(input.failures <= input.checks_run, "failures can't exceed checks_run");
    require!(
        !input.apix_version.is_empty() && input.apix_version.len() <= 32,
        "apix_version must be 1-32 characters"
    );
    if let Some(source) = &input.source {
        require!(source.len() <= MAX_FIELD, "source must be at most 200 characters");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{get_logs, VMContextBuilder};
    use near_sdk::testing_env;

    fn input(verdict: &str) -> AttestInput {
        AttestInput {
            app_id: "github.com/acme/shop".into(),
            report_hash: "a".repeat(64),
            verdict: verdict.into(),
            checks_run: 12,
            failures: 0,
            warnings: 1,
            apix_version: "2.3.0-near".into(),
            source: Some("https://github.com/acme/shop/commit/abc".into()),
        }
    }

    fn ctx(who: &str, deposit: NearToken) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(who.parse().unwrap())
            .attached_deposit(deposit)
            .build());
    }

    #[test]
    fn attest_and_read_back() {
        ctx("alice.testnet", NearToken::from_millinear(10));
        let mut c = Attestations::new();
        let a = c.attest(input("pass"));
        assert_eq!(a.revision, 1);
        let read = c.get_attestation("alice.testnet".parse().unwrap(), "github.com/acme/shop".into()).unwrap();
        assert_eq!(read, a);
        assert!(get_logs()[0].starts_with("EVENT_JSON:"));
    }

    #[test]
    fn revisions_are_per_attester() {
        ctx("alice.testnet", NearToken::from_millinear(10));
        let mut c = Attestations::new();
        c.attest(input("fail"));
        assert_eq!(c.attest(input("pass")).revision, 2);
        ctx("bob.testnet", NearToken::from_millinear(10));
        assert_eq!(c.attest(input("warn")).revision, 1);
        assert_eq!(c.get_total(), 3);
    }

    #[test]
    #[should_panic(expected = "to cover storage")]
    fn storage_must_be_paid() {
        ctx("alice.testnet", NearToken::from_yoctonear(0));
        Attestations::new().attest(input("pass"));
    }

    #[test]
    #[should_panic(expected = "report_hash must be a lowercase hex sha256")]
    fn hash_is_validated() {
        ctx("alice.testnet", NearToken::from_millinear(10));
        let mut bad = input("pass");
        bad.report_hash = "XYZ".into();
        Attestations::new().attest(bad);
    }

    #[test]
    #[should_panic(expected = "verdict must be pass, warn or fail")]
    fn verdict_is_validated() {
        ctx("alice.testnet", NearToken::from_millinear(10));
        Attestations::new().attest(input("great"));
    }
}
