# Demo video script (target 2:30, max 3:00)

**Format:** screen recording of the terminal (and the browser for NEAR Blocks), with your voice over it. Record on Windows with **Win+Alt+R** (Xbox Game Bar) or Loom/OBS. Large terminal font (Ctrl+= a few times). Talk calmly; it's fine to record the voice separately and cut waiting time.

**Before recording**, in Git Bash:

```
cd /c/Users/thoma/apix-near
git pull
npm run build
clear
```

Have one browser tab open on https://github.com/tdeu/apix-near.

`[brackets]` = what's on screen. Quoted text = what you say.

---

## 0:00 – 0:20 · Hook: a real agent build

[GitHub: open `experiments/2026-11-12-agent-economy.md`, scroll to "What the agent planned"]

> "We gave a coding agent NEAR's official Agent Economy hackathon prompt, with no hints. In twenty minutes it built a careful-looking app: no keys in the browser, nothing committed, testnet by default. It even had a rule: payments over a limit wait for a human to click Approve."

## 0:20 – 0:50 · Verify finds what matters

[Terminal, in the agent's app folder:]

```
cd /c/Users/thoma/Bureau/agent-test-2
node /c/Users/thoma/apix-near/dist/cli/index.js verify . --out report.json
```

[Show the two FAIL lines]

> "apix verify found two things. Anyone on the internet could start a paid run. And anyone could approve the payments that were supposed to wait for a human. Each finding says what's wrong in plain words, and how to fix it. Honest note: on its first pass APIX got this app wrong too; we fixed the rules, and the write-up is in the repo."

## 0:50 – 1:05 · The problem in one sentence

> "That's the gap: agents now build whole NEAR apps, but the people using them can't check whether that code is safe. APIX builds NEAR features into your app, verifies them, and proves it on-chain."

## 1:05 – 1:40 · Build

[Type:]

```
node dist/cli/index.js verify examples/agent-shop --offline
```

> "This is the same kind of app, built with APIX. apix add wallet gives users NEAR wallet login. apix add token adds a NEP-141 token, deployed on a locked account so nobody can ever mint more. apix add agent-wallet lets the AI agent pay through a vault instead of holding a key. And every apix add finishes by running the checks: this one passes."

[Optional, 5 seconds: open `examples/agent-shop/lib/agent.ts` on GitHub and show `runVaultTool`]

## 1:40 – 2:20 · The vault, live on testnet

[Type:]

```
scripts/near-testnet-demo.sh
```

[Let it run; in editing, keep these moments and cut the waiting:]

- **Token sent** (T2, "registered it with the token first") → "Tokens, with receiver registration handled in the same transaction."
- **Vault created** ("No full-access key exists on the vault") → "The vault is created in one transaction, with no full-access key at all. Only a key that can call pay."
- **Paid 0.2** → "The agent pays an allowed shop."
- **Refused: not on the allowlist** and **Refused: exceeds the per-transaction limit** → "It can't pay anyone else, and it can't go over its limits. The contract refuses, not our server."
- **Filed approval request #0 → approve done** → "Bigger payments go to the owner for approval."
- **Access key does not allow method set_limits** → "And even with the agent's key, you can't change the rules. NEAR itself blocks it."

## 2:20 – 2:40 · Prove

[The end of the script: "Attested … FAIL" and "✓ … matches the on-chain attestation". Then click the attest transaction link to show NEAR Blocks.]

> "Finally, apix attest publishes the report's hash on NEAR, in a contract nobody can change. Anyone can check that a report is the one that was attested."

## 2:40 – 2:50 · Close

[GitHub repo page]

> "APIX for NEAR: build it, verify it, prove it. Built at NEAR HACKATHON. Everything is in the repo, and the README runs end to end."

---

## After recording

- Export as MP4, under 3 minutes.
- Upload it to the X post directly (best reach), and to YouTube as unlisted if the form wants a link.
- The X post text will be added here on Friday.
