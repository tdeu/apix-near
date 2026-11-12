<!-- Official prompt, copied verbatim from github.com/nearai/near-hackathon-prompt-examples tracks/07-agents.md -->
Track: Agent Economy (id: agents).

Build [a general contractor agent]. I give it a task and a budget. It breaks the task into parts, decides which parts to do itself and which to buy, hires other agents or pays for data to get them done, checks the work, and pays out. Everything it spends stays inside my budget.

Requirements:
- Look at the NEAR AI Agent Market (market.near.ai) and find out how jobs get posted and paid programmatically. If there's no public way to do it, tell me before building around it.
- Negotiation: when a quote comes in above what the agent planned to spend, it counters once with its reasoning, then accepts or walks away.
- Payments in USDC or NEAR, directly or through NEAR Intents.
- A receipt for every task: what was bought, from whom, at what price, and whether the work passed the agent's check.

Start by explaining how the agent will hold its keys and what it can't do without me. Then propose the task loop and wait.
