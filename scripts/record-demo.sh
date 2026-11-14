#!/usr/bin/env bash
# Plays the demo for the video: shows each command, runs it, waits for Enter.
# Start your screen recording, run this, talk over each step, press Enter to go on.
#
#   scripts/record-demo.sh [path-to-an-agent-built-app]
#
# The testnet part creates fresh faucet accounts (free) and takes a few minutes;
# cut the waiting in editing.
set -u
ROOT="$(cd "$(dirname "$0")/.." && (pwd -W 2>/dev/null || pwd))"
APIX="node $ROOT/dist/cli/index.js"
AGENT_APP="${1:-}"

bold=$'\033[1m'; cyan=$'\033[1;36m'; dim=$'\033[2m'; reset=$'\033[0m'

title() { clear; printf '\n%s%s%s\n%s%s%s\n\n' "$cyan" "$1" "$reset" "$dim" "$2" "$reset"; }
show() {  # types the command so it reads on video, then runs it
  printf '%s$ ' "$bold"
  local text="$1" i
  for (( i=0; i<${#text}; i++ )); do printf '%s' "${text:$i:1}"; sleep 0.02; done
  printf '%s\n' "$reset"
  eval "$2"
}
next() { printf '\n%s[Enter]%s ' "$dim" "$reset"; read -r _; }

title "APIX for NEAR" "Build it. Verify it. Prove it.  ·  github.com/tdeu/apix-near"
next

if [ -n "$AGENT_APP" ] && [ -d "$AGENT_APP" ]; then
  title "1. A real agent build" "A coding agent built NEAR's Agent Economy prompt. Does it hold up?"
  show "apix verify agent-economy-app" "(cd \"$AGENT_APP\" && $APIX verify . --out \"$ROOT/.demo-agent-report.json\")"
  next
fi

title "2. Verify: an app written the way agents often write them" "Twelve rules on the code and the chain. Each finding has a fix."
show "apix verify examples/unsafe-tip-agent" "(cd \"$ROOT\" && $APIX verify examples/unsafe-tip-agent --offline --out .demo-unsafe.json)"
next

title "3. Build: the same kind of app, built with APIX" "apix add wallet · apix add token · apix add agent-wallet  (--chain near)"
show "ls examples/agent-shop/lib/near examples/agent-shop/components/near" "(cd \"$ROOT\" && ls examples/agent-shop/lib/near examples/agent-shop/components/near)"
echo
show "apix verify examples/agent-shop" "(cd \"$ROOT\" && $APIX verify examples/agent-shop --offline --out .demo-shop.json)"
next

title "4. Live on NEAR testnet" "Token, Agent Vault (no full-access key), refusals, owner approval, attestation."
show "scripts/near-testnet-demo.sh" "(cd \"$ROOT\" && scripts/near-testnet-demo.sh)"
next

title "APIX for NEAR" "Live page: apix-near-site.vercel.app  ·  Code: github.com/tdeu/apix-near  ·  Built at NEAR HACKATHON"
next
rm -f "$ROOT"/.demo-*.json
