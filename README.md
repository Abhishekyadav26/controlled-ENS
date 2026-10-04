# Priya's Design Studio — Single Front Door (controlled-ENS)

One front door. A client asks a question, the right specialist helper answers,
and the response says **which helper answered**. Helpers are discovered from
**live ENS text records on Sepolia** — adding a new helper is an ENS-only
operation, never a router code change.

## Architecture

```
client --POST /ask--> router (front door, :3000)
                          | 1. discoverAgents(): viem getEnsText on Sepolia
                          | 2. routeQuestion(): LLM constrained to discovered names (fallback: keyword overlap)
                          | 3. forwardToAgent(): POST { question } to the agent endpoint
                          v
        contract.priyasstudio.eth   brand.priyasstudio.eth   invoice.priyasstudio.eth
        :3001/agents/contract/...   :3001/agents/brand/...    :3001/agents/invoice/...
```

## Sepolia names (published text records)

| Helper | ENS name (Sepolia) | Endpoint in record |
|---|---|---|
| Contract Q&A | `contract.priyasstudio.eth` | `…/agents/contract/answer` |
| Brand copywriter | `brand.priyasstudio.eth` | `…/agents/brand/answer` |
| Invoice & billing | `invoice.priyasstudio.eth` | `…/agents/invoice/answer` |
| Registry (studio) | `priyasstudio.eth` (`ai.agent.registry` = member list) | — |

Publish/verify: `npm run ens:publish` (needs `DEPLOYER_PRIVATE_KEY` + Sepolia ETH),
then `curl localhost:3000/agents`.

## Record format

See [`RECORD_FORMAT.md`](./RECORD_FORMAT.md). Summary per agent name:

- `ai.agent.description` — specialty in plain words (this is what routing reads)
- `ai.agent.endpoint` — `https://…` URL accepting `POST { question }` → `{ answer }`
- `ai.agent.input` — JSON string: `{"type":"object","properties":{"question":{"type":"string","maxLength":2000}},"required":["question"]}`
- `ai.agent.version` — `"1"`

Registry name `priyasstudio.eth` publishes `ai.agent.registry` =
comma-separated member names.

## Run

```bash
npm install
cp .env.example .env   # optional: OPENAI_API_KEY for LLM routing; works without it
npm run dev:agents &   # :3001  (or run each agent as its own service)
npm run dev:router     # :3000  front door
```

Try it:

```bash
curl -s localhost:3000/agents | head -c 500
curl -s -X POST localhost:3000/ask -H 'content-type: application/json' \
  -d '{"question":"My invoice #1042 is two weeks overdue, when will I get paid?"}'
# -> { decision:"answered", answer:"Invoice helper: ...", agent:{ ensName:"invoice.priyasstudio.eth", ... } }
```

## Adding a fourth agent (no deploy)

1. Deploy a service accepting `POST { question }` → `{ answer }`.
2. Publish the four `ai.agent.*` records on its ENS name (e.g. `support.priyasstudio.eth`).
3. Append it to `ai.agent.registry` on `priyasstudio.eth` (or to `AGENT_ENS_NAMES`).
4. Done — the router picks it up on the next discovery refresh (`DISCOVERY_TTL_MS`, default 60s).

## Routing cases & regressions

- Cases: [`data/routingCases.json`](./data/routingCases.json) — each has the expected agent.
- Replay: `npm run evaluate` — exits non-zero if any case fails, so you can tell when a change makes routing worse.
- Tests: `npm test`.

## Trust model

- Every ENS record is **untrusted**: validated with Zod, incomplete/unsupported entries skipped.
- The LLM is constrained in code to discovered names + `"none"`; anything else falls back to deterministic routing.
- Every downstream answer is **untrusted**: JSON-shape checked, 100KB cap, 2000-char sanitized excerpt returned, control chars stripped.
