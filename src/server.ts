import "dotenv/config";
import { createAgentsApp } from "./agents.js";
import { createRouterApp } from "./router.js";

// Single-process demo: agents on AGENTS_PORT, router (front door) on ROUTER_PORT.
// In production each agent is its own service behind the URL in its ENS record.
const agentsPort = Number(process.env.AGENTS_PORT ?? "3001");
const routerPort = Number(process.env.ROUTER_PORT ?? "3000");

createAgentsApp().listen(agentsPort, () => console.log(`[agents] listening on :${agentsPort}`));
createRouterApp().listen(routerPort, () => console.log(`[router] front door on :${routerPort}`));
