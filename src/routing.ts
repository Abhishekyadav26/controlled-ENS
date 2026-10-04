import "dotenv/config";
import type { AgentAdvertisement } from "./recordFormat.js";
import { assertHttpsEndpoint } from "./recordFormat.js";

export interface RoutingDecision {
  /** ENS name of the chosen agent, or "none" when nothing fits. Constrained to discovered agents. */
  agent: string;
  confidence: number;
  reason: string;
  /** true when an LLM made the call, false when the deterministic fallback did. */
  viaLLM: boolean;
}

const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? process.env.LLM_API_KEY ?? "";
const LLM_MODEL = process.env.LLM_MODEL ?? "gpt-4o-mini";

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

/** Deterministic keyword/overlap router. Used when no LLM key is set or the LLM fails. */
export function keywordFallback(question: string, agents: AgentAdvertisement[]): RoutingDecision {
  const q = new Set(tokenize(question));
  let best: AgentAdvertisement | null = null;
  let bestScore = 0;
  for (const a of agents) {
    const desc = new Set(tokenize(a.description));
    let score = 0;
    for (const t of q) if (desc.has(t)) score += 2;
    // Small domain boosts for common phrasings (still derived per-agent, generic).
    const ql = question.toLowerCase();
    const dl = a.description.toLowerCase();
    if (/(invoice|billing|overdue|payment|receipt|refund|vat)/.test(ql) && /invoice|billing/.test(dl)) score += 4;
    if (/(contract|clause|liability|nda|termination|renewal|indemn)/.test(ql) && /contract/.test(dl)) score += 4;
    if (/(brand|tagline|copy|slogan|tone|voice|logo|marketing)/.test(ql) && /brand|copy/.test(dl)) score += 4;
    if (score > bestScore) {
      bestScore = score;
      best = a;
    }
  }
  if (!best || bestScore === 0) {
    return { agent: "none", confidence: 0.1, reason: "no agent description overlaps the question", viaLLM: false };
  }
  return {
    agent: best.ensName,
    confidence: Math.min(0.95, 0.4 + bestScore * 0.1),
    reason: `keyword/description overlap (score ${bestScore})`,
    viaLLM: false,
  };
}

/**
 * Model-driven routing CONSTRAINED in code to choices that really exist.
 * The LLM only ever sees the discovered agent list and must return one of
 * those ENS names or "none". Its output is validated; anything else falls
 * back to the deterministic router. The model can never invent an agent.
 */
export async function routeQuestion(
  question: string,
  agents: AgentAdvertisement[],
): Promise<RoutingDecision> {
  if (agents.length === 0) {
    return { agent: "none", confidence: 1, reason: "no agents discovered", viaLLM: false };
  }
  if (!OPENAI_API_KEY) return keywordFallback(question, agents);

  const allowed = [...agents.map((a) => a.ensName), "none"];
  const catalog = agents.map((a) => `- ${a.ensName}: ${a.description}`).join("\n");
  const system = [
    "You route client questions to specialist support agents.",
    "Reply with ONLY a JSON object: {\"agent\": <ens-name-or-\"none\">, \"confidence\": <0-1>, \"reason\": <short>}.",
    "Choose exactly one of the allowed values. If none fits, choose \"none\".",
    `Allowed agents:\n${catalog}\n- none: no specialist fits`,
  ].join("\n");

  try {
    const res = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: LLM_MODEL,
        temperature: 0,
        max_tokens: 200,
        messages: [
          { role: "system", content: system },
          { role: "user", content: question.slice(0, 2000) },
        ],
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return keywordFallback(question, agents);
    const json = (await res.json()) as any;
    const text: string = json.choices?.[0]?.message?.content ?? "";
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return keywordFallback(question, agents);
    const parsed = JSON.parse(match[0]) as { agent?: unknown; confidence?: unknown; reason?: unknown };
    // HARD CONSTRAINT: the answer must be a discovered name or "none".
    if (typeof parsed.agent !== "string" || !allowed.includes(parsed.agent)) {
      return keywordFallback(question, agents);
    }
    return {
      agent: parsed.agent,
      confidence: typeof parsed.confidence === "number" ? Math.min(1, Math.max(0, parsed.confidence)) : 0.7,
      reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 300) : "llm routing",
      viaLLM: true,
    };
  } catch {
    return keywordFallback(question, agents);
  }
}

/** Sanitize untrusted downstream text: strip control chars, cap length. */
export function sanitizeAnswer(raw: unknown, maxChars = 2000): string {
  const s = typeof raw === "string" ? raw : JSON.stringify(raw ?? "");
  return (
    s
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
      .slice(0, maxChars)
      .trim() || "(empty answer from agent)"
  );
}

const FORWARD_TIMEOUT_MS = Number(process.env.FORWARD_TIMEOUT_MS ?? "10000");

/**
 * Forward the question to the chosen agent. The endpoint + payload shape come
 * from the agent's validated ENS records; the RESPONSE is untrusted and is
 * schema-validated, size-limited and sanitized before being returned.
 */
export async function forwardToAgent(
  agent: AgentAdvertisement,
  question: string,
): Promise<{ answer: string; endpoint: string }> {
  // Defense in depth: re-check the ENS endpoint protocol right before calling.
  assertHttpsEndpoint(agent.endpoint, agent.ensName);
  const maxLen = agent.input.properties.question.maxLength ?? 2000;
  const res = await fetch(agent.endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question: question.slice(0, maxLen) }),
    signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`agent ${agent.ensName} returned HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > 100_000) throw new Error(`agent ${agent.ensName} response too large`);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`agent ${agent.ensName} returned non-JSON`);
  }
  const answer = (json as any)?.answer ?? (json as any)?.reply ?? (json as any)?.text;
  if (typeof answer !== "string" || answer.length === 0) {
    throw new Error(`agent ${agent.ensName} returned an invalid answer shape`);
  }
  return { answer: sanitizeAnswer(answer), endpoint: agent.endpoint };
}
