import { z } from "zod";

/**
 * RECORD FORMAT (v1) — published as ENS text records on Sepolia.
 *
 * Each specialist agent owns exactly one ENS name and publishes
 * four text records under that name:
 *
 *   ai.agent.description : human-readable specialty, e.g.
 *     "Answers questions about invoices, billing, overdue payments and receipts."
 *   ai.agent.endpoint    : public HTTPS(S) URL that accepts POST { question: string }
 *     and returns JSON { answer: string }. Example: "https://invoice.example.com/answer"
 *   ai.agent.input       : JSON string describing accepted input, e.g.
 *     '{"type":"object","properties":{"question":{"type":"string","maxLength":2000}},"required":["question"]}'
 *   ai.agent.version     : record-format version, currently "1".
 *
 * A registry name (the studio front door) optionally publishes:
 *
 *   ai.agent.registry    : comma-separated list of member ENS names, e.g.
 *     "<contract-name>,<brand-name>,<invoice-name>"
 *
 * Adding a new helper = publish the four records on its own name and append
 * it to the registry list (or to AGENT_ENS_NAMES). No router code change.
 */

export const TEXT_RECORD_KEYS = {
  description: "ai.agent.description",
  endpoint: "ai.agent.endpoint",
  input: "ai.agent.input",
  version: "ai.agent.version",
  registry: "ai.agent.registry",
} as const;

export const RECORD_FORMAT_VERSION = "1";

export const AgentInputSpecSchema = z.object({
  type: z.literal("object"),
  properties: z.object({
    question: z.object({
      type: z.literal("string"),
      maxLength: z.number().int().positive().max(8000).optional(),
    }),
  }),
  required: z.array(z.string()).optional(),
});
export type AgentInputSpec = z.infer<typeof AgentInputSpecSchema>;

/** Validated view of one agent's public ENS advertisement. Untrusted until validated. */
export const AgentAdvertisementSchema = z.object({
  ensName: z.string().min(3).max(255),
  description: z.string().min(10).max(1000),
  endpoint: z.string().url(),
  input: AgentInputSpecSchema,
  version: z.string(),
});
export type AgentAdvertisement = z.infer<typeof AgentAdvertisementSchema>;

export const AgentAnswerSchema = z.object({
  answer: z.string().min(1).max(20000),
});
export type AgentAnswer = z.infer<typeof AgentAnswerSchema>;

export const AskRequestSchema = z.object({
  question: z.string().min(1).max(2000),
});
export type AskRequest = z.infer<typeof AskRequestSchema>;

/**
 * Enforce https on agent endpoints. Plain http is rejected except for
 * loopback hosts (localhost / 127.0.0.1 / ::1) so local development works.
 * Throws when the endpoint is not an acceptable URL.
 */
export function assertHttpsEndpoint(endpoint: string, ensName: string): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`endpoint is not a valid URL for ${ensName}`);
  }
  const loopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (url.protocol === "https:") return;
  if (url.protocol === "http:" && loopback) return;
  throw new Error(`endpoint must use https (http is allowed only for localhost) for ${ensName}`);
}

/** Parse the raw `ai.agent.input` text record (a JSON string). Throws on invalid. */
export function parseInputSpec(raw: string): AgentInputSpec {
  const parsed: unknown = JSON.parse(raw);
  return AgentInputSpecSchema.parse(parsed);
}

/** Build the four text records for an agent (used by ensPublish script + /describe). */
export function buildTextRecords(args: {
  description: string;
  endpoint: string;
  maxQuestionChars?: number;
}): Record<string, string> {
  const input = JSON.stringify({
    type: "object",
    properties: { question: { type: "string", maxLength: args.maxQuestionChars ?? 2000 } },
    required: ["question"],
  });
  return {
    [TEXT_RECORD_KEYS.description]: args.description,
    [TEXT_RECORD_KEYS.endpoint]: args.endpoint,
    [TEXT_RECORD_KEYS.input]: input,
    [TEXT_RECORD_KEYS.version]: RECORD_FORMAT_VERSION,
  };
}

/** Validate raw text-record values fetched from ENS into an advertisement, or throw. */
export function validateAdvertisement(args: {
  ensName: string;
  description: string | null;
  endpoint: string | null;
  input: string | null;
  version: string | null;
}): AgentAdvertisement {
  if (!args.description || !args.endpoint || !args.input || !args.version) {
    throw new Error(`incomplete records for ${args.ensName}`);
  }
  if (args.version !== RECORD_FORMAT_VERSION) {
    throw new Error(`unsupported record version for ${args.ensName}: ${args.version}`);
  }
  assertHttpsEndpoint(args.endpoint, args.ensName);
  return AgentAdvertisementSchema.parse({
    ensName: args.ensName,
    description: args.description,
    endpoint: args.endpoint,
    input: parseInputSpec(args.input),
    version: args.version,
  });
}
