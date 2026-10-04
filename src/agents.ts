import "dotenv/config";
import express from "express";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { buildTextRecords } from "./recordFormat.js";
import { sanitizeAnswer } from "./routing.js";

const QuestionSchema = z.object({ question: z.string().min(1).max(2000) });

interface AgentDef {
  id: string;
  ensName: string;
  description: string;
  specialty: string;
}

/**
 * Agent identities (ENS names) are loaded at runtime from the same ENS
 * member list the router discovers (AGENT_ENS_NAMES env or
 * config/ens.names.json), matched by subdomain prefix. No agent name is
 * hardcoded here, so the studio can rename/replace helpers via ENS data.
 */
function loadAgentDefs(): AgentDef[] {
  let names: string[] = [];
  try {
    const json = JSON.parse(readFileSync(resolve(process.cwd(), "config/ens.names.json"), "utf8")) as {
      agents?: unknown;
    };
    if (Array.isArray(json.agents)) names = json.agents.map((s) => String(s).toLowerCase());
  } catch {
    // fall through to env
  }
  if (names.length === 0) {
    names = (process.env.AGENT_ENS_NAMES ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  }
  const pick = (id: string): string => {
    const hit = names.find((n) => n === id || n.startsWith(`${id}.`));
    if (!hit) throw new Error(`no ENS name found for agent "${id}" (AGENT_ENS_NAMES / config/ens.names.json)`);
    return hit;
  };
  return [
    {
      id: "contract",
      ensName: pick("contract"),
      description:
        "Answers questions about contracts: clauses, liability, termination, renewal, NDAs and indemnification. Send contract questions here.",
      specialty: "contract law help",
    },
    {
      id: "brand",
      ensName: pick("brand"),
      description:
        "Writes brand copy: taglines, slogans, tone of voice, product descriptions and marketing copy. Send brand and copywriting requests here.",
      specialty: "brand copywriting",
    },
    {
      id: "invoice",
      ensName: pick("invoice"),
      description:
        "Sorts out invoices and billing: overdue invoices, payments, receipts, refunds and VAT. Send invoice and billing questions here.",
      specialty: "invoicing and billing",
    },
  ];
}

export const AGENT_DEFS: AgentDef[] = loadAgentDefs();

function snippet(q: string): string {
  return sanitizeAnswer(q, 200);
}

function templateAnswer(specialty: string, id: string, q: string): string {
  const ql = q.toLowerCase();
  if (id === "invoice") {
    if (/overdue/.test(ql))
      return `Invoice helper: I can see you asked about an overdue invoice ("${snippet(q)}"). Please share the invoice number and due date and I will check the payment status, the reminder schedule, and next steps to collect it.`;
    return `Invoice helper (${specialty}): regarding "${snippet(q)}" — tell me the invoice number and I can help with payment status, receipts, refunds or VAT.`;
  }
  if (id === "contract") {
    return `Contract helper (${specialty}): regarding "${snippet(q)}" — this is general information, not legal advice. Share the clause or question (termination, liability, renewal, NDA) and I will explain it in plain language.`;
  }
  return `Brand helper (${specialty}): regarding "${snippet(q)}" — tell me your audience and tone (playful, premium, bold) and I will draft copy options for you.`;
}

/** Each specialist is behind its own HTTP endpoint (path). They can also run as separate services. */
export function createAgentsApp() {
  const app = express();
  app.use(express.json({ limit: "64kb" }));
  app.get("/health", (_req, res) => res.json({ ok: true, agents: AGENT_DEFS.map((a) => a.id) }));

  for (const def of AGENT_DEFS) {
    // Public self-description — mirrors exactly what is published in ENS text records.
    app.get(`/agents/${def.id}/describe`, (_req, res) => {
      const base = process.env.PUBLIC_AGENT_BASE_URL ?? `http://localhost:${process.env.AGENTS_PORT ?? "3001"}`;
      res.json({
        ensName: def.ensName,
        records: buildTextRecords({ description: def.description, endpoint: `${base}/agents/${def.id}/answer` }),
      });
    });

    app.post(`/agents/${def.id}/answer`, (req, res) => {
      const parsed = QuestionSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "expected JSON { question: string (1..2000 chars) }" });
      const answer = templateAnswer(def.specialty, def.id, parsed.data.question);
      res.json({ answer, agent: { id: def.id, ensName: def.ensName, description: def.description } });
    });
  }
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.AGENTS_PORT ?? "3001");
  createAgentsApp().listen(port, () => console.log(`[agents] listening on :${port}`));
}
