import "dotenv/config";
import express from "express";
import { AskRequestSchema, TEXT_RECORD_KEYS, RECORD_FORMAT_VERSION } from "./recordFormat.js";
import { discoverAgents } from "./discovery.js";
import { routeQuestion, forwardToAgent, sanitizeAnswer } from "./routing.js";

/**
 * The single front door. Discovers helpers from ENS on every request window
 * (TTL-cached), routes with a model constrained to discovered names, forwards,
 * and returns the answer WITH attribution. New ENS-published helpers are
 * picked up with no code change and no redeploy.
 */
export function createRouterApp() {
  const app = express();
  app.use(express.json({ limit: "64kb" }));

  app.get("/health", async (_req, res) => {
    const d = await discoverAgents();
    res.json({ ok: true, registry: d.registry, agents: d.agents.map((a) => a.ensName), source: d.source });
  });

  /** Public retrieval index built from live ENS data. */
  app.get("/agents", async (_req, res) => {
    const d = await discoverAgents();
    res.json({
      registry: d.registry,
      source: d.source,
      agents: d.agents.map((a) => ({ ensName: a.ensName, description: a.description, endpoint: a.endpoint, version: a.version })),
    });
  });

  app.get("/record-format", (_req, res) => {
    res.json({
      version: RECORD_FORMAT_VERSION,
      textRecords: TEXT_RECORD_KEYS,
      note: "Each agent publishes ai.agent.description / endpoint / input / version on its own ENS name; the registry publishes ai.agent.registry with the member list.",
    });
  });

  app.post("/ask", async (req, res) => {
    const parsed = AskRequestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "expected JSON { question: string (1..2000 chars) }" });
    const question = parsed.data.question;

    const { agents } = await discoverAgents();
    const decision = await routeQuestion(question, agents);

    if (decision.agent === "none") {
      return res.json({
        decision: "none",
        answer: sanitizeAnswer(
          `Sorry — none of our current specialists covers that. We have: ${agents.map((a) => a.ensName).join(", ") || "no agents online"}. Try asking about contracts, brand copy, or invoices.`,
        ),
        agent: null,
        candidates: agents.map((a) => a.ensName),
        reason: decision.reason,
      });
    }

    const chosen = agents.find((a) => a.ensName === decision.agent);
    if (!chosen) {
      // Should never happen: routing is constrained, but defend anyway.
      return res.status(500).json({ error: "router chose an unknown agent" });
    }
    try {
      const { answer, endpoint } = await forwardToAgent(chosen, question);
      return res.json({
        decision: "answered",
        answer,
        agent: { ensName: chosen.ensName, description: chosen.description, endpoint },
        confidence: decision.confidence,
        reason: decision.reason,
        viaLLM: decision.viaLLM,
      });
    } catch (err) {
      return res.status(502).json({
        decision: "agent-error",
        answer: `The ${chosen.ensName} helper is unreachable right now. Please try again later.`,
        agent: { ensName: chosen.ensName, description: chosen.description, endpoint: chosen.endpoint },
        error: (err as Error).message.slice(0, 300),
      });
    }
  });

  return app;
}
