# unsafe-tip-agent (deliberately insecure)

A small Next.js "AI tip agent" written the way coding agents often write
NEAR apps on a first pass. **Do not deploy it.** It exists so `apix verify`
has something real to find:

- the server key sits in a committed `.env` (the demo script generates a
  throwaway key at run time; no key is stored in this repository)
- a client component reads a key through `NEXT_PUBLIC_`
- `POST /api/pay` signs transfers for anyone, for any amount
- an LLM tool can call that transfer with no limit
- mainnet is hardcoded in the code that spends

Run `apix verify examples/unsafe-tip-agent --offline` to see the findings,
then compare with what `apix add agent-wallet --chain near` generates.
