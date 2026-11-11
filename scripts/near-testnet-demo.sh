#!/usr/bin/env bash
# End-to-end APIX run on NEAR testnet: token, Agent Vault, verify, attest.
#
#   scripts/near-testnet-demo.sh                                  # creates fresh faucet accounts
#   scripts/near-testnet-demo.sh <owner>.testnet <receiver>.testnet
#
# Needs: npm run build done. With accounts given, the owner's key must be in
# ~/.near-credentials/testnet/<owner>.testnet.json or NEAR_ACCOUNT_ID +
# NEAR_PRIVATE_KEY, and the owner needs about 7.5 testnet NEAR (token ~2,
# vault 3.7 of which 1.5 spendable, attestation contract 1.5, gas).
set -uo pipefail

OWNER="${1:-}"
RECEIVER="${2:-}"
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

if [ -z "$OWNER" ]; then
  step "0. Create two fresh testnet accounts with the faucet (10 NEAR each)"
  OWNER="apix-demo-$SUFFIX-$RANDOM.testnet"
  RECEIVER="apix-shop-$SUFFIX-$RANDOM.testnet"
  expect_code 0 $APIX near account-create "$OWNER" "$RECEIVER"
fi

TOKEN_NAME="pts$SUFFIX"
step "T1. Create a fixed-supply token: 1,000,000 PTS, 2 decimals, locked contract"
expect_code 0 $APIX near token create --account "$OWNER" --name "Demo Points" --symbol PTS --supply 1000000 --decimals 2 --account-name "$TOKEN_NAME"
TOKEN="$TOKEN_NAME.$OWNER"

step "T2. Send 25.5 PTS to $RECEIVER (registers it with the token in the same transaction)"
expect_code 0 $APIX near token send "$TOKEN" --account "$OWNER" --to "$RECEIVER" --amount 25.5 --memo "welcome"

step "T3. Send 4.5 more: already registered, so just the transfer"
expect_code 0 $APIX near token send "$TOKEN" --account "$OWNER" --to "$RECEIVER" --amount 4.5
node -e "
fetch('https://rpc.testnet.near.org',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'query',params:{request_type:'call_function',finality:'final',account_id:'$TOKEN',method_name:'ft_balance_of',args_base64:Buffer.from(JSON.stringify({account_id:'$RECEIVER'})).toString('base64')}})})
.then(r=>r.json()).then(j=>{const v=JSON.parse(Buffer.from(j.result.result).toString()); console.log('Receiver balance on-chain:', v, 'units (expected 3000 = 30.00 PTS)'); if(v!=='3000') process.exit(1);})
" || exit 1

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

printf '\n\033[1;32mAll steps behaved as expected.\033[0m Token: %s  Vault: %s  Attestations: %s\n' "$TOKEN" "$VAULT" "$ATTEST"
printf 'Work dir (agent key in .env.local): %s\n' "$WORK"
