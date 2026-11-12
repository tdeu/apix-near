# Experiment: a coding agent builds NEAR's Agent Economy prompt, APIX checks it

**Date:** 12 Nov 2026 · **Agent:** Claude Code (default settings), in an empty folder, no access to APIX or its reports
**Prompt:** NEAR's official Agent Economy hackathon prompt, verbatim: [07-agents-prompt.md](07-agents-prompt.md)
**Our answers to the agent's questions:** "Option B (direct payments). NEAR as the default currency. Your suggested limits are fine. Next.js, TypeScript, testnet only. Build a working first version in about an hour." No security hints.

A first attempt was discarded: the folder still held an `apix-report.json` from an earlier run, the agent read it, and it designed its plan around APIX's checks. The run below started from a folder containing only the prompt.

## What the agent planned

Before writing code, as the prompt asks, it explained how it would hold keys. The key decision, in its words:

> "The key needs full access, not a limited one. USDC transfers have to carry a 1 yoctoNEAR deposit, and NEAR's limited (function-call) keys can't attach deposits. Keeping only the budget in the account is what limits the damage."

Spending limits would live in "a spending ledger in the code", and payments over a limit would "pause until you click Approve".

The reasoning about function-call keys is correct (they can't attach deposits). The consequence is that every limit is enforced by the app itself, in the same process that holds a full-access key.

## What it built

A Next.js app in about 20 minutes: plan a task, get quotes from (demo) sellers, counter once, pay with `account.sendMoney`, check the work, write receipts. It had a mainnet guard, input validation, simulated payments when no key is set, and a `.gitignore` that kept its demo seller keys out of git. A careful first version.

## What APIX reported, and whether it was right

**First run (APIX as of 11 Nov): 4 failures. 2 were wrong, and 2 real problems were missed.**

| APIX said | Right? | Why |
|---|---|---|
| Private keys in `data/demo-seller-keys.json` (×3) | ✗ False positive | The file is gitignored. APIX checked git-ignored status for `.env` files but not for other files. |
| `GET /api/status` can make the app spend | ✗ False positive | Read-only. APIX treated the call `paymentMode()` as a payment because it starts with "pay". |
| (nothing on `POST /api/runs`) | ✗ Missed | Starts a run that pays sellers from the agent's account, with no check on the caller. The payment is two imports away (route → `lib/contractor.ts` → `lib/near.ts`); APIX followed one. |
| (nothing on `POST /api/runs/[id]/approvals/[aid]`) | ✗ Missed | The "you click Approve" safeguard has no authentication. Once deployed, anyone (or a prompt-injected agent) can approve over-limit payments. Same cause. |

**Fixes, each with a regression test built from this app's shape:**

1. Gitignored files are no longer reported as published keys; untracked files that `git add -A` would include still are.
2. Imports are followed up to four levels deep.
3. Only payment-like calls count (`pay(`, `payFromVault(`, `sendTip(`), not `paymentMode(` or `getPayer(`.
4. `req.json()` is recognised as reading the request (only `request.json()` was).
5. An unprotected approval route gets its own finding: "Anyone can approve payments that were meant to wait for you".

**Second run (after the fixes): 2 failures, both real, no false positives.**

```
FAIL Anyone can approve payments that were meant to wait for you  app/api/runs/[id]/approvals/[aid]/route.ts
FAIL Anyone on the internet can make this route spend             app/api/runs/route.ts
7 checks · 2 failures · 0 warnings
```

Still to confirm on-chain: the agent's server key is full-access by design. `apix verify` reports that (`NEAR-SERVER-KEY-SCOPE`) once the agent's testnet account exists and its key is in `.env.local`; it wasn't created in this run.

## What we take from it

- The agent got the visible things right (no keys in the browser, nothing committed, testnet by default). The gaps were in **who can call the money paths**, and in a **human approval step that any caller can trigger**. Neither shows up when you run the app locally, which is how its builder tests it.
- The agent's own plan explains why an on-chain vault matters: with a full-access key, limits in code are only as strong as the server. The Agent Vault enforces them in the contract, and over-limit payments wait for the owner's account, not for an HTTP call. Its current limit is that it pays NEAR only; paying fungible tokens such as USDC from the vault is the next step.
- APIX was wrong four times on the first real app it saw. Each case is now a test. That loop (run on real agent output, fix, add the case) is how the rules get better, and this report is its first entry.
