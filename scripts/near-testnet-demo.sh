#!/usr/bin/env bash
# End-to-end Agent Vault + verify + attest run on NEAR testnet.
#
#   scripts/near-testnet-demo.sh <owner>.testnet <receiver>.testnet
#
# Needs: npm run build done, and the owner's key either in
# ~/.near-credentials/testnet/<owner>.testnet.json (near-cli) or in
# NEAR_ACCOUNT_ID + NEAR_PRIVATE_KEY. Spends about 5.3 testnet NEAR
# (1.5 spendable + 2.2 storage into the vault, 1.5 for the attestation contract, gas).
set -uo pipefail

OWNER="${1:?usage: $0 <owner>.testnet <receiver>.testnet}"
RECEIVER="${2:?usage: $0 <owner>.testnet <receiver>.testnet}"
ROOT="$(cd "$(dirname "$0")/.." && (pwd -W 2>/dev/null || pwd))"  # pwd -W: C:/... paths on Git Bash, so node can require them
APIX="node $ROOT/dist/cli/index.js"
SUFFIX="$(date +%H%M%S)"
VAULT_NAME="vault-$SUFFIX"
WORK="$(mktemp -d)"
export NEAR_NETWORK=testnet

step() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
expect_code() { # expect_code <code> <command...>
  local want="$1"; shift
  "$@"; local got=$?
  if [ "$got" != "$want" ]; then printf '\033[31mexpected exit %s, got %s\033[0m\n' "$want" "$got"; exit 1; fi
}

cd "$WORK"
printf '.env.local\n' > .gitignore

step "1. Create a vault: 0.5 NEAR per payment, 1 NEAR per day, only $RECEIVER"
expect_code 0 $APIX near vault create --account "$OWNER" --name "$VAULT_NAME" \
  --per-tx 0.5 --daily 1 --allow "$RECEIVER" --fund 1.5
VAULT="$VAULT_NAME.$OWNER"

step "2. Status: note there is no full-access key on the vault"
expect_code 0 $APIX near vault status

step "3. Agent pays 0.2 NEAR to $RECEIVER (allowed)"
expect_code 0 $APIX near vault pay --to "$RECEIVER" --amount 0.2 --memo "api credits"

step "4. Agent tries to pay someone else (refused: not allowlisted)"
expect_code 2 $APIX near vault pay --to "attacker.testnet" --amount 0.1

step "5. Agent tries 0.8 NEAR (refused: over the per-payment limit)"
expect_code 2 $APIX near vault pay --to "$RECEIVER" --amount 0.8

step "6. Same payment with --escalate: filed for the owner"
expect_code 0 $APIX near vault pay --to "$RECEIVER" --amount 0.8 --memo "annual plan" --escalate

step "7. Owner approves request #0"
expect_code 0 $APIX near vault approve "$VAULT" 0 --account "$OWNER"

step "8. Owner pauses; agent payment refused; owner unpauses"
expect_code 0 $APIX near vault pause "$VAULT" --account "$OWNER"
expect_code 2 $APIX near vault pay --to "$RECEIVER" --amount 0.1
expect_code 0 $APIX near vault unpause "$VAULT" --account "$OWNER"

step "9. The agent key itself cannot touch the policy (direct contract call, expect failure)"
node -e "
const { Account, JsonRpcProvider } = require('$ROOT/node_modules/near-api-js');
const env = Object.fromEntries(require('fs').readFileSync('.env.local','utf8').split('\n').filter(Boolean).map(l => l.split(/=(.*)/s)));
const agent = new Account(env.NEAR_VAULT_ID, new JsonRpcProvider({ url: 'https://rpc.testnet.near.org' }), env.NEAR_AGENT_PRIVATE_KEY);
agent.callFunction({ contractId: env.NEAR_VAULT_ID, methodName: 'set_limits', args: { per_tx_limit: '1', daily_limit: '1' } })
  .then(() => { console.log('UNEXPECTED: agent changed the limits'); process.exit(1); })
  .catch(e => { console.log('Refused as expected:', String(e.message || e).split('\n')[0].slice(0, 160)); });
" || exit 1

step "10. Final vault status"
expect_code 0 $APIX near vault status

step "11. Deploy a locked attestation contract"
$APIX near deploy-attestations --account "$OWNER" --name "attest-$SUFFIX" || true
ATTEST="attest-$SUFFIX.$OWNER"

step "12. Verify the unsafe example app and attest the result"
cp -r "$ROOT/examples/unsafe-tip-agent" "$WORK/unsafe" && cd "$WORK/unsafe" && git init -q
node -e "const {KeyPair}=require('$ROOT/node_modules/near-api-js'); require('fs').writeFileSync('.env', 'NEAR_ACCOUNT_ID=tipbot.testnet\nNEAR_PRIVATE_KEY='+KeyPair.fromRandom('ed25519').toString()+'\n')"
git add -A && git -c user.name=demo -c user.email=demo@example.com commit -qm "agent-built app"
expect_code 1 $APIX verify . --app-id "examples/unsafe-tip-agent" --out "$WORK/unsafe-report.json"
expect_code 0 $APIX attest "$WORK/unsafe-report.json" --account "$OWNER" --contract "$ATTEST"
expect_code 0 $APIX attestation "$OWNER" "examples/unsafe-tip-agent" --contract "$ATTEST" --report "$WORK/unsafe-report.json"

printf '\n\033[1;32mAll steps behaved as expected.\033[0m Vault: %s  Attestations: %s\n' "$VAULT" "$ATTEST"
printf 'Work dir (agent key in .env.local): %s\n' "$WORK"
