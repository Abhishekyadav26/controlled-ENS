import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AgentAdvertisementSchema } from "./recordFormat.js";
import { routeQuestion } from "./routing.js";

/**
 * Replays the recorded routing cases against the current router logic.
 * Run after any routing change: `npm run evaluate`.
 * A drop in accuracy means the change made routing worse.
 */
async function main() {
  process.env.ENS_OFFLINE ??= "1";
  const cases = JSON.parse(readFileSync(resolve(process.cwd(), "data/routingCases.json"), "utf8")) as {
    id: string;
    question: string;
    expected: string;
  }[];
  const fixtures = JSON.parse(readFileSync(resolve(process.cwd(), "config/agentFixtures.json"), "utf8"));
  const agents = Object.entries(fixtures).map(([ensName, raw]: [string, any]) =>
    AgentAdvertisementSchema.parse({ ensName, ...raw }),
  );
  let correct = 0;
  for (const c of cases) {
    const d = await routeQuestion(c.question, agents);
    const ok = d.agent === c.expected;
    if (ok) correct++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${c.id}: expected=${c.expected} got=${d.agent} (${d.reason})`);
  }
  console.log(`\naccuracy: ${correct}/${cases.length} = ${(100 * (correct / cases.length)).toFixed(1)}%`);
  if (correct < cases.length) {
    console.log("Routing regressed on at least one recorded case.");
    process.exitCode = 1;
  }
}

main();
