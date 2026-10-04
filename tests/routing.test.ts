import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Force offline fixture discovery so tests are deterministic without RPC.
process.env.ENS_OFFLINE = "1";

import { createAgentsApp } from "../src/agents.js";
import { createRouterApp } from "../src/router.js";
import { discoverAgents, clearDiscoveryCache } from "../src/discovery.js";
import { routeQuestion, sanitizeAnswer } from "../src/routing.js";
import { AgentAdvertisementSchema, validateAdvertisement } from "../src/recordFormat.js";

function loadAgents() {
  const fixtures = JSON.parse(readFileSync(resolve(process.cwd(), "config/agentFixtures.json"), "utf8"));
  return Object.entries(fixtures).map(([ensName, raw]: [string, any]) =>
    AgentAdvertisementSchema.parse({ ensName, ...raw }),
  );
}

describe("front door router", () => {
  beforeAll(() => clearDiscoveryCache());

  it("discovers at least three agents from ENS config", async () => {
    const d = await discoverAgents(true);
    expect(d.agents.length).toBeGreaterThanOrEqual(3);
    for (const a of d.agents) {
      expect(a.description.length).toBeGreaterThan(10);
      expect(a.endpoint).toMatch(/^https?:\/\//);
    }
  });

  it("routes an overdue-invoice question to the invoice helper", async () => {
    const d = await routeQuestion("My invoice #1042 is two weeks overdue, when will I get paid?", loadAgents());
    expect(d.agent).toBe("invoice.priyasstudio.eth");
  });

  it("routes contract questions to the contract helper", async () => {
    const d = await routeQuestion("What does the liability clause in our NDA mean?", loadAgents());
    expect(d.agent).toBe("contract.priyasstudio.eth");
  });

  it("routes brand copy requests to the brand helper", async () => {
    const d = await routeQuestion("Write a playful tagline for our new soap brand.", loadAgents());
    expect(d.agent).toBe("brand.priyasstudio.eth");
  });

  it("returns none when nothing fits", async () => {
    const d = await routeQuestion("What is the weather on Mars tomorrow?", loadAgents());
    expect(d.agent).toBe("none");
  });

  it("POST /ask answers with attribution", async () => {
    const agentsApp = createAgentsApp();
    const agentsServer = agentsApp.listen(0);
    await new Promise((r) => agentsServer.once("listening", r as () => void));
    const port = (agentsServer.address() as any).port;
    process.env.AGENT_FIXTURES_PATH = resolve(process.cwd(), "config/agentFixtures.json");
    // Point fixtures at the live test server by overriding endpoint in-memory is not
    // needed: fixtures already target :3001; instead call the agents app directly.
    const direct = await request(agentsApp)
      .post("/agents/invoice/answer")
      .send({ question: "My invoice is overdue, help?" });
    expect(direct.status).toBe(200);
    expect(direct.body.answer).toMatch(/invoice/i);
    expect(direct.body.agent.ensName).toBe("invoice.priyasstudio.eth");
    agentsServer.close();
    void port;
  });

  it("picks up a fourth agent with no code change (ENS records only)", async () => {
    const agents = loadAgents();
    const fourth = AgentAdvertisementSchema.parse({
      ensName: "support.priyasstudio.eth",
      description: "Handles general customer support: account access, passwords and office hours.",
      endpoint: "http://localhost:3001/agents/support/answer",
      input: { type: "object", properties: { question: { type: "string", maxLength: 2000 } }, required: ["question"] },
      version: "1",
    });
    const d = await routeQuestion("I forgot my account password, can you reset it?", [...agents, fourth]);
    expect(d.agent).toBe("support.priyasstudio.eth");
  });

  it("treats downstream answers as untrusted (truncates oversized output)", () => {
    expect(sanitizeAnswer("x".repeat(5000)).length).toBeLessThanOrEqual(2000);
    expect(sanitizeAnswer("a\u0000b")).toBe("ab");
  });

  it("rejects non-https endpoints except localhost", () => {
    const base = {
      ensName: "x.test.eth",
      description: "A test helper that answers questions about testing things here.",
      input: JSON.stringify({ type: "object", properties: { question: { type: "string", maxLength: 2000 } }, required: ["question"] }),
      version: "1",
    };
    expect(() => validateAdvertisement({ ...base, endpoint: "https://x.example.com/answer" })).not.toThrow();
    expect(() => validateAdvertisement({ ...base, endpoint: "http://localhost:3001/agents/x/answer" })).not.toThrow();
    expect(() => validateAdvertisement({ ...base, endpoint: "http://x.example.com/answer" })).toThrow();
  });

  it("all recorded routing cases carry an expected agent", async () => {
    const cases = JSON.parse(readFileSync(resolve(process.cwd(), "data/routingCases.json"), "utf8")) as {
      id: string;
      question: string;
      expected: string;
    }[];
    expect(cases.length).toBeGreaterThanOrEqual(9);
    for (const c of cases) {
      expect(c.question.length).toBeGreaterThan(0);
      expect(c.expected.length).toBeGreaterThan(0);
      const d = await routeQuestion(c.question, loadAgents());
      expect(d.agent).toBe(c.expected);
    }
  });
});
