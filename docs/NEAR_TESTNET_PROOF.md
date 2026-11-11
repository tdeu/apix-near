# NEAR testnet runs — 11 Nov 2026

## Run 2: build, vault, verify, attest (17:46, fresh faucet accounts)

`scripts/near-testnet-demo.sh` with no arguments, on Windows (Git Bash). Every step behaved as expected.

| Step | What happened | Transaction |
|---|---|---|
| T1 | Token `pts174601.apix-demo-174601-29061.testnet` deployed: 1,000,000 PTS, 2 decimals, whole supply to the owner, **no access key** on the token account | [6NNaKtFJ…](https://testnet.nearblocks.io/txns/6NNaKtFJJBCxGeumscYH41qXmQQx8UM5qz4kuEk5FKAv) |
| T2 | 25.5 PTS sent; the receiver was registered (`storage_deposit`) in the same transaction | [5Pp33dfU…](https://testnet.nearblocks.io/txns/5Pp33dfU2NuXmBep59jXLrzYEWRUn6UFJKcz8igQPMfF) |
| T3 | 4.5 PTS sent, transfer only; receiver balance read on-chain: 3000 units = 30.00 PTS | [7uK77bKS…](https://testnet.nearblocks.io/txns/7uK77bKSfccBFkxs899F3bsBEnYHbDr45qMRhfV5wCVE) |
| 1 | Vault created, 1.5 NEAR spendable + 2.16 NEAR storage and reserve, one function-call key | [4huQe3py…](https://testnet.nearblocks.io/txns/4huQe3pyjZBFyDPpo6eEFPevcE4kXSwHU3JKxnG8FpLf) |
| 3 | Agent pays 0.2 NEAR | [45iovyYw…](https://testnet.nearblocks.io/txns/45iovyYwy2ktETVYqgG5xdxUCLkmU7nT2puFHYLuMYfb) |
| 4–5 | Refused: receiver not allowlisted; 0.8 NEAR over the per-payment limit (nothing signed) | — |
| 6–7 | Escalated as request #0, approved by the owner | [3WhfmHBR…](https://testnet.nearblocks.io/txns/3WhfmHBRo4wqX1jVihm8RvDH9WpYekTf6dfnCiLKwGCw) · [BeUAq9bH…](https://testnet.nearblocks.io/txns/BeUAq9bHsm6kUGkaeegDj7fF3x8PCj4nvT21dfXbt5Ux) |
| 8 | Pause, refused payment, unpause | [pause](https://testnet.nearblocks.io/txns/AEQFFXYYM14fkxUR5Bc8oFKjAcJDf3Ge46JATD5UrArS) · [unpause](https://testnet.nearblocks.io/txns/2kyUKnTiFUgKQUQ9Cg9q4faVSqDPvHoFDDdzeGL3MA7N) |
| 9 | Agent key calling `set_limits`: "Access key does not allow method set_limits" | — |
| 11 | Locked attestation contract deployed | [9FknMQdQ…](https://testnet.nearblocks.io/txns/9FknMQdQ3H2vHrBdfYeL4T4WW7iovjLbgyYwL19CFZEy) |
| 12 | `apix verify` on the unsafe example: FAIL, 7 failures, 3 warnings (now including "configured key does not belong to the account", the check fixed after run 1). Attested and re-checked against the report | [FKnKHcL3…](https://testnet.nearblocks.io/txns/FKnKHcL34KuxD39JyDTAExYcMbiWcm9CivfT2q1ueWK7) |

## Run 1: vault, verify, attest (16:37)

Output of `scripts/near-testnet-demo.sh tomapix.testnet tomshop.testnet`,
run on Windows (Git Bash, Node 22.14). Every step behaved as expected.
Anyone can re-check these on the explorer, or with `apix verify` (it confirms
the transactions linked below exist and succeeded).

| Step | What happened | Transaction |
|---|---|---|
| 1 | Vault `vault-163736.tomapix.testnet` created in one transaction: account, funds, contract, init, one function-call agent key. No full-access key. | [44ebDt7m…](https://testnet.nearblocks.io/txns/44ebDt7mtvVh5MrUuLPJXxbb9NQs6pq444rY3TxiSJfP) |
| 3 | Agent pays 0.2 NEAR to the allowlisted `tomshop.testnet` | [GDRTRouA…](https://testnet.nearblocks.io/txns/GDRTRouANHokNbR5tAG4t7oescmCNHB9i82oMVakoqUK) |
| 4 | Agent tries `attacker.testnet`: refused, receiver not on the allowlist (nothing signed) | — |
| 5 | Agent tries 0.8 NEAR: refused, over the 0.5 NEAR per-payment limit (nothing signed) | — |
| 6 | Same payment with `--escalate`: filed as approval request #0 | [95fKT17B…](https://testnet.nearblocks.io/txns/95fKT17BdEbMEuAULuXTF1u29oQVVjXjH25HumCrBKNW) |
| 7 | Owner approves #0: 0.8 NEAR sent | [DLXoHWpo…](https://testnet.nearblocks.io/txns/DLXoHWpobnFLzs1L2QRxBjJSUtxjH9WJHEqPMMtkHVfc) |
| 8 | Owner pauses; agent payment refused ("vault is paused"); owner unpauses | [pause](https://testnet.nearblocks.io/txns/87QRjj23vVcbryFFEEnukUGpzBHJpDFo1veVQy9sC2NQ) · [unpause](https://testnet.nearblocks.io/txns/EypBWwAdX5D1Ur6LCoGdU6MWNpkUJGKm1JmArfx2Ribx) |
| 9 | Agent key calls `set_limits` directly: rejected by the protocol, "Access key does not allow method set_limits" | — |
| 11 | Attestation contract `attest-163736.tomapix.testnet` deployed with no access keys | [CEDVZz7U…](https://testnet.nearblocks.io/txns/CEDVZz7U799gCmvhpEexerMQuP6Z4Gum9QPs91w2qZ3Z) |
| 12 | `apix verify` on `examples/unsafe-tip-agent`: FAIL, 6 failures, 3 warnings. Report hash `10183122…a8ef` attested on-chain and re-checked against the local report | [FFjbJHxP…](https://testnet.nearblocks.io/txns/FFjbJHxPu7zVvcr27AN7yKEN3Untpq6HpQYdcjRHHYdb) |

## What the run found in APIX itself

Running on a real network surfaced two problems, both fixed since:

1. **Funding.** `--fund 3` left only 0.93 NEAR spendable: the 196 kB contract
   locks about 2 NEAR as storage. `--fund` now means "spendable", and APIX adds
   storage and a gas reserve on top (commit `d823f62`).
2. **A check that passed when it shouldn't.** NEAR's RPC reports a missing
   access key as an error *inside* a successful response. The server-key check
   missed it and passed a key that doesn't belong to its account. Fixed, with a
   regression test.
