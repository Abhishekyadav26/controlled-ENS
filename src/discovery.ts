import "dotenv/config";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";
import {
  TEXT_RECORD_KEYS,
  validateAdvertisement,
  type AgentAdvertisement,
} from "./recordFormat.js";

const SEPOLIA_RPC_URL =
  process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";

function publicClient() {
  return createPublicClient({ chain: sepolia, transport: http(SEPOLIA_RPC_URL) });
}

function configuredEnsNames(): string[] {
  const fromEnv = (process.env.AGENT_ENS_NAMES ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (fromEnv.length > 0) return [...new Set(fromEnv)];
  const file = resolve(process.cwd(), "config/ens.names.json");
  try {
    const json = JSON.parse(readFileSync(file, "utf8")) as { agents?: string[] };
    return (json.agents ?? []).map((s) => s.toLowerCase());
  } catch {
    return [];
  }
}

function registryName(): string | null {
  if (process.env.REGISTRY_ENS_NAME) return process.env.REGISTRY_ENS_NAME.toLowerCase();
  try {
    const file = resolve(process.cwd(), "config/ens.names.json");
    const json = JSON.parse(readFileSync(file, "utf8")) as { registry?: string };
    return json.registry?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

function fixturesPath(): string {
  return process.env.AGENT_FIXTURES_PATH ?? resolve(process.cwd(), "config/agentFixtures.json");
}

/** Offline fixture copy of ENS records (used when RPC/records unavailable, e.g. tests). */
function loadFixtures(): Map<string, AgentAdvertisement> {
  const out = new Map<string, AgentAdvertisement>();
  const p = fixturesPath();
  if (!existsSync(p)) return out;
  try {
    const json = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    for (const [name, raw] of Object.entries(json)) {
      try {
        out.set(name.toLowerCase(), {
          ensName: name.toLowerCase(),
          description: (raw as any).description,
          endpoint: (raw as any).endpoint,
          input: (raw as any).input,
          version: (raw as any).version ?? "1",
        } as AgentAdvertisement);
      } catch {
        // skip malformed fixture entries — records are untrusted
      }
    }
  } catch {
    // ignore unreadable fixtures
  }
  return out;
}

async function getTextSafe(
  client: ReturnType<typeof publicClient>,
  name: string,
  key: string,
): Promise<string | null> {
  try {
    const v = await client.getEnsText({ name: name as `${string}.eth`, key });
    return v ?? null;
  } catch {
    return null;
  }
}

export interface DiscoveryResult {
  agents: AgentAdvertisement[];
  source: "ens-live" | "ens-live+fixtures" | "fixtures-offline";
  registry: string | null;
}

// Simple TTL cache so every /ask does not hammer the RPC.
let cache: { at: number; value: DiscoveryResult } | null = null;
export function clearDiscoveryCache(): void {
  cache = null;
}
function ttlMs(): number {
  const v = Number(process.env.DISCOVERY_TTL_MS ?? "60000");
  return Number.isFinite(v) && v >= 0 ? v : 60000;
}

/**
 * Discover specialist agents from live ENS data on Sepolia.
 *
 * 1. Resolve the member list: AGENT_ENS_NAMES env, plus the registry name's
 *    `ai.agent.registry` text record (comma-separated). Union, deduped.
 * 2. For each member, fetch the four `ai.agent.*` text records via viem
 *    `getEnsText` on Sepolia and validate with Zod. Invalid/incomplete
 *    entries are skipped (records are untrusted input).
 * 3. If live resolution yields nothing (offline CI, no RPC), fall back to
 *    the local fixture copy so routing stays testable. Live ENS always wins
 *    when reachable — adding a 4th agent to ENS/registry is picked up after
 *    the TTL with no code change and no redeploy.
 */
export async function discoverAgents(forceRefresh = false): Promise<DiscoveryResult> {
  if (cache && !forceRefresh && Date.now() - cache.at < ttlMs()) return cache.value;

  const offline = process.env.ENS_OFFLINE === "1";
  const fixtures = loadFixtures();
  const reg = registryName();
  const configured = configuredEnsNames();

  if (offline) {
    const agents = configured
      .map((n) => fixtures.get(n))
      .filter((a): a is AgentAdvertisement => Boolean(a));
    const value: DiscoveryResult = { agents, source: "fixtures-offline", registry: reg };
    cache = { at: Date.now(), value };
    return value;
  }

  const client = publicClient();

  // Registry may add names beyond the static config — that is how a 4th
  // agent is picked up without touching code.
  let names = [...configured];
  if (reg) {
    const raw = await getTextSafe(client, reg, TEXT_RECORD_KEYS.registry);
    if (raw) {
      const fromRegistry = raw
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 3);
      for (const n of fromRegistry) if (!names.includes(n)) names.push(n);
    }
  }
  names = [...new Set(names)];

  const agents: AgentAdvertisement[] = [];
  let liveOk = false;
  for (const name of names) {
    const [description, endpoint, input, version] = await Promise.all([
      getTextSafe(client, name, TEXT_RECORD_KEYS.description),
      getTextSafe(client, name, TEXT_RECORD_KEYS.endpoint),
      getTextSafe(client, name, TEXT_RECORD_KEYS.input),
      getTextSafe(client, name, TEXT_RECORD_KEYS.version),
    ]);
    if (description !== null || endpoint !== null) liveOk = true;
    try {
      agents.push(validateAdvertisement({ ensName: name, description, endpoint, input, version }));
    } catch (err) {
      console.warn(`[discovery] skipping ${name}: ${(err as Error).message}`);
      const fb = fixtures.get(name);
      if (fb) {
        try {
          // Fixture entries are re-validated, never trusted blindly.
          const { AgentAdvertisementSchema } = await import("./recordFormat.js");
          agents.push(AgentAdvertisementSchema.parse(fb));
          console.warn(`[discovery] using fixture fallback for ${name}`);
        } catch {
          // skip
        }
      }
    }
  }

  // Full fallback: RPC unreachable and no live records at all.
  if (agents.length === 0 && fixtures.size > 0) {
    const value: DiscoveryResult = {
      agents: names.length
        ? names
            .map((n) => fixtures.get(n))
            .filter((a): a is AgentAdvertisement => Boolean(a))
        : [...fixtures.values()],
      source: "fixtures-offline",
      registry: reg,
    };
    cache = { at: Date.now(), value };
    return value;
  }

  const value: DiscoveryResult = {
    agents,
    source: liveOk ? "ens-live" : "ens-live+fixtures",
    registry: reg,
  };
  cache = { at: Date.now(), value };
  return value;
}
