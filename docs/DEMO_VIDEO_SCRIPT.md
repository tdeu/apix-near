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

## 0:00 – 0:15 · Hook

[GitHub repo page, then the terminal]

> "Coding agents can now build a whole NEAR app from one prompt. We gave one NEAR's official Agent Economy hackathon prompt. Here's what it built, and here's what APIX found."

*(If the agent experiment found nothing serious, use instead: "…The app works. But would you know if it was safe?")*

## 0:15 – 0:35 · The problem

[Terminal, still]

> "The people using these agents usually can't check whether the code is safe. A key visible in the browser, a payment route open to anyone, an AI tool that can send everything. On a blockchain, those mistakes are irreversible. APIX builds NEAR features into your app, verifies they're safe, and proves it on-chain."

## 0:35 – 1:05 · Verify

[Type:]

```
node dist/cli/index.js verify examples/unsafe-tip-agent --offline
```

*(Or, better if the experiment found issues: `cd` into the agent's app and run `verify` there.)*

[Scroll slowly over the FAIL lines]

> "apix verify checks any NEAR app, whoever wrote it: twelve rules on the code and on the chain. Here: a private key shipped to the browser, a payment route anyone on the internet can call, and an AI tool that can spend with no limit. Every finding says what's wrong in plain words, and how to fix it."

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
