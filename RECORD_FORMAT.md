# Agent record format v1 (ENS text records, Sepolia)

Each specialist helper owns **one ENS name** and publishes **four text records**:

| Key | Value | Example |
|---|---|---|
| `ai.agent.description` | 10–1000 chars, plain-words specialty. Routing reads this. | `Sorts out invoices and billing: overdue invoices, payments, receipts, refunds and VAT. Send invoice and billing questions here.` |
| `ai.agent.endpoint` | `http(s)` URL. Accepts `POST {"question": string}` → `{"answer": string}`. | `https://invoice.example.com/answer` |
| `ai.agent.input` | JSON string of the accepted input schema. | `{"type":"object","properties":{"question":{"type":"string","maxLength":2000}},"required":["question"]}` |
| `ai.agent.version` | Format version. | `1` |

The studio registry name publishes one record:

| Key | Value |
|---|---|
| `ai.agent.registry` | Comma-separated member ENS names: `contract.priyasstudio.eth,brand.priyasstudio.eth,invoice.priyasstudio.eth` |

Rules:

- Readers MUST validate every record with the Zod schemas in `src/recordFormat.ts`
  and skip names with missing/invalid records (records are untrusted input).
- Readers MUST re-resolve on a TTL (default 60s), never bake the member list into code.
- Writers (new helpers) MUST keep `description` specific — it is the retrieval index.
- `endpoint` MUST be `https` in production (`http://localhost` is accepted for local dev).
