//! APIX fixed-supply fungible token (NEP-141, NEP-145, NEP-148).
//!
//! The whole supply goes to the owner at initialisation and there is no mint
//! method. `apix near token create` deploys it with no access key on the
//! token account, so the supply can never change and the code can never be
//! replaced: holders can check that on-chain (`apix verify` does).
//!
//! Built on near-contract-standards, NEAR's reference implementation.

use near_contract_standards::fungible_token::events::{FtBurn, FtMint};
use near_contract_standards::fungible_token::metadata::{
    FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC,
};
use near_contract_standards::fungible_token::{
    FungibleToken, FungibleTokenCore, FungibleTokenResolver,
};
use near_contract_standards::storage_management::{
    StorageBalance, StorageBalanceBounds, StorageManagement,
};
use near_sdk::collections::LazyOption;
use near_sdk::json_types::U128;
use near_sdk::{
    env, log, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault, PromiseOrValue,
};

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    FungibleToken,
    Metadata,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    token: FungibleToken,
    metadata: LazyOption<FungibleTokenMetadata>,
}

#[near]
impl Contract {
    /// Gives `total_supply` to `owner_id`. Called once, by the deploying transaction.
    #[init]
    pub fn new(owner_id: AccountId, total_supply: U128, name: String, symbol: String, decimals: u8, icon: Option<String>) -> Self {
        require!(!env::state_exists(), "Already initialized");
        require!(total_supply.0 > 0, "total_supply must be greater than 0");
        require!(!name.is_empty() && name.len() <= 64, "name must be 1-64 characters");
        require!(
            !symbol.is_empty() && symbol.len() <= 16 && symbol.chars().all(|c| c.is_ascii_alphanumeric()),
            "symbol must be 1-16 letters or digits"
        );
        require!(decimals <= 24, "decimals must be at most 24");
        if let Some(icon) = &icon {
            require!(icon.starts_with("data:image/") && icon.len() <= 16_384, "icon must be a data:image/ URL under 16 kB");
        }
        let metadata = FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name,
            symbol,
            icon,
            reference: None,
            reference_hash: None,
            decimals,
        };
        metadata.assert_valid();
        let mut this = Self {
            token: FungibleToken::new(StorageKey::FungibleToken),
            metadata: LazyOption::new(StorageKey::Metadata, Some(&metadata)),
        };
        this.token.internal_register_account(&owner_id);
        this.token.internal_deposit(&owner_id, total_supply.into());
        FtMint { owner_id: &owner_id, amount: total_supply, memo: Some("fixed supply, minted once") }.emit();
        this
    }
}

#[near]
impl FungibleTokenCore for Contract {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.token.ft_transfer(receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for Contract {
    #[private]
    fn ft_resolve_transfer(&mut self, sender_id: AccountId, receiver_id: AccountId, amount: U128) -> U128 {
        let (used_amount, burned_amount) =
            self.token.internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        if burned_amount > 0 {
            log!("Account @{} burned {}", sender_id, burned_amount);
            FtBurn { owner_id: &sender_id, amount: U128(burned_amount), memo: None }.emit();
        }
        used_amount.into()
    }
}

#[near]
impl StorageManagement for Contract {
    #[payable]
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        if let Some((account_id, balance)) = self.token.internal_storage_unregister(force) {
            if balance > 0 {
                FtBurn { owner_id: &account_id, amount: U128(balance), memo: Some("account unregistered") }.emit();
            }
            true
        } else {
            false
        }
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for Contract {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        self.metadata.get().unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn owner() -> AccountId { "owner.testnet".parse().unwrap() }
    fn alice() -> AccountId { "alice.testnet".parse().unwrap() }

    fn ctx(predecessor: AccountId, deposit: NearToken) {
        testing_env!(VMContextBuilder::new()
            .current_account_id("token.owner.testnet".parse().unwrap())
            .predecessor_account_id(predecessor.clone())
            .signer_account_id(predecessor)
            .attached_deposit(deposit)
            .build());
    }

    fn token() -> Contract {
        ctx(owner(), NearToken::from_yoctonear(0));
        Contract::new(owner(), U128(1_000_000), "Coffee Points".into(), "COFFEE".into(), 2, None)
    }

    #[test]
    fn owner_gets_the_whole_supply() {
        let t = token();
        assert_eq!(t.ft_total_supply().0, 1_000_000);
        assert_eq!(t.ft_balance_of(owner()).0, 1_000_000);
        assert_eq!(t.ft_metadata().symbol, "COFFEE");
        assert_eq!(t.ft_metadata().decimals, 2);
    }

    #[test]
    fn transfer_needs_registration_then_works() {
        let mut t = token();
        let min = t.storage_balance_bounds().min;
        ctx(alice(), min);
        t.storage_deposit(None, Some(true));
        ctx(owner(), NearToken::from_yoctonear(1));
        t.ft_transfer(alice(), U128(2_500), Some("welcome".into()));
        assert_eq!(t.ft_balance_of(alice()).0, 2_500);
        assert_eq!(t.ft_balance_of(owner()).0, 997_500);
        assert_eq!(t.ft_total_supply().0, 1_000_000);
    }

    #[test]
    #[should_panic(expected = "is not registered")]
    fn transfer_to_unregistered_account_fails() {
        let mut t = token();
        ctx(owner(), NearToken::from_yoctonear(1));
        t.ft_transfer(alice(), U128(1), None);
    }

    #[test]
    #[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
    fn transfer_requires_one_yocto() {
        let mut t = token();
        ctx(owner(), NearToken::from_yoctonear(0));
        t.ft_transfer(alice(), U128(1), None);
    }

    #[test]
    #[should_panic(expected = "symbol must be 1-16 letters or digits")]
    fn symbol_is_validated() {
        ctx(owner(), NearToken::from_yoctonear(0));
        Contract::new(owner(), U128(1), "x".into(), "BAD SYMBOL".into(), 0, None);
    }
}
