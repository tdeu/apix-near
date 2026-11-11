# NEAR testnet run — 11 Nov 2026

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
