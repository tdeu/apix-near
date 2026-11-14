#!/usr/bin/env bash
# Plays the demo for the video. Each screen shows its narration as on-screen
# text, types the command, runs it, and moves on by itself at reading pace.
# Start your screen recording, run this, and let it play.
#
#   scripts/record-demo.sh [path-to-an-agent-built-app]
#   MANUAL=1 scripts/record-demo.sh ...   # wait for Enter instead of timing
#
# The testnet part creates fresh faucet accounts (free) and takes a few minutes;
# cut the waiting in editing.
set -u
ROOT="$(cd "$(dirname "$0")/.." && (pwd -W 2>/dev/null || pwd))"
APIX="node $ROOT/dist/cli/index.js"
AGENT_APP="${1:-}"

bold=$'\033[1m'; cyan=$'\033[1;36m'; dim=$'\033[2m'; reset=$'\033[0m'
cap=$'\033[30;43m'  # black on yellow, like the inspection tag

title() { clear; printf '\n%s%s%s\n%s%s%s\n\n' "$cyan" "$1" "$reset" "$dim" "$2" "$reset"; }
show() {  # types the command so it reads on video, then runs it
  printf '%s$ ' "$bold"
  local text="$1" i
  for (( i=0; i<${#text}; i++ )); do printf '%s' "${text:$i:1}"; sleep 0.02; done
  printf '%s\n' "$reset"
  eval "$2"
}
# On-screen narration: one yellow line per sentence, held long enough to read
say() {
  local line words=0
  for line in "$@"; do
    printf ' %s %s %s\n' "$cap" "$line" "$reset"
    words=$(( words + $(echo "$line" | wc -w) ))
  done
  echo
  pause $(( words * 60 / 170 + 2 ))   # ~170 words per minute, plus a beat
}
pause() { if [ -n "${MANUAL:-}" ]; then printf '%s[Enter]%s ' "$dim" "$reset"; read -r _; else sleep "$1"; fi; }
next() { pause "${1:-6}"; }

title "APIX for NEAR" "Build it. Verify it. Prove it.  ·  github.com/tdeu/apix-near"
say "Coding agents can now build a whole NEAR app from one prompt." \
    "But the people using them usually can't tell if that code is safe." \
    "On a blockchain, those mistakes are irreversible."

if [ -n "$AGENT_APP" ] && [ -d "$AGENT_APP" ]; then
  title "1. A real agent build" "A coding agent built NEAR's Agent Economy prompt. Does it hold up?"
  say "We gave a coding agent NEAR's official Agent Economy prompt, with no hints." \
      "In 20 minutes it built a careful-looking app: payments over a limit wait for a human to approve."
  show "apix verify agent-economy-app" "(cd \"$AGENT_APP\" && $APIX verify . --out \"$ROOT/.demo-agent-report.json\")"
  echo
  say "APIX found two real problems: anyone could start a paid run," \
      "and anyone could approve the payments that were meant to wait for a human."
  next 4
fi

title "2. Verify: an app written the way agents often write them" "Twelve rules on the code and the chain. Each finding has a fix."
say "apix verify checks any NEAR app, whoever wrote it, against 12 rules on the code and the chain."
show "apix verify examples/unsafe-tip-agent" "(cd \"$ROOT\" && $APIX verify examples/unsafe-tip-agent --offline --out .demo-unsafe.json)"
echo
say "A key shipped to the browser, a payment route anyone can call, an AI that can spend everything." \
    "Each finding says what's wrong in plain words, and how to fix it."
next 4

title "3. Build: the same kind of app, built with APIX" "apix add wallet · apix add token · apix add agent-wallet  (--chain near)"
say "APIX also builds: wallet login, a NEP-141 token on a locked account," \
    "and an Agent Vault so the AI pays within on-chain limits, never with a raw key."
show "ls examples/agent-shop/lib/near examples/agent-shop/components/near" "(cd \"$ROOT\" && ls examples/agent-shop/lib/near examples/agent-shop/components/near)"
echo
show "apix verify examples/agent-shop" "(cd \"$ROOT\" && $APIX verify examples/agent-shop --offline --out .demo-shop.json)"
echo
say "Every apix add ends with the same checks. This app passes."
next 3

title "4. Live on NEAR testnet" "Token, Agent Vault (no full-access key), refusals, owner approval, attestation."
say "Now on NEAR testnet, for real." \
    "Watch for: the vault has no full-access key, the agent is refused above its limits," \
    "bigger payments go to the owner, and the agent's key cannot change its own rules."
show "scripts/near-testnet-demo.sh" "(cd \"$ROOT\" && scripts/near-testnet-demo.sh)"
echo
say "Finally, the report's hash is attested on NEAR, in a contract nobody can change," \
    "and anyone can check a report against it."
next 4

title "APIX for NEAR" "Live page: apix-near-site.vercel.app  ·  Code: github.com/tdeu/apix-near  ·  Built at NEAR HACKATHON"
say "APIX for NEAR: build it, verify it, prove it." \
    "Live data: apix-near-site.vercel.app   Code: github.com/tdeu/apix-near"
next 5
rm -f "$ROOT"/.demo-*.json
