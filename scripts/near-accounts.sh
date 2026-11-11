#!/usr/bin/env bash
# Creates free testnet accounts with the faucet and saves their keys to
# ~/.near-credentials/testnet (where apix looks for them).
#   scripts/near-accounts.sh tomapix tomshop
set -e
for name in "$@"; do
  id="${name%.testnet}.testnet"
  echo "== Creating $id"
  npx --yes near-cli-rs account create-account sponsor-by-faucet-service "$id" \
    autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
done
