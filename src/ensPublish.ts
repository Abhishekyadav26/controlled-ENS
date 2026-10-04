import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createWalletClient, createPublicClient, http, type Hex } from "viem";
import { normalize, namehash } from "viem/ens";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { TEXT_RECORD_KEYS, buildTextRecords } from "./recordFormat.js";

/**
 * Publishes each agent's text records to its ENS name on Sepolia.
 *
 *   DEPLOYER_PRIVATE_KEY=<your-sepolia-key> SEPOLIA_RPC_URL=... PUBLIC_AGENT_BASE_URL=https://... npm run ens:publish
 *
 * Writes the four `ai.agent.*` records per agent plus the registry's
 * `ai.agent.registry` member list. Requires Sepolia ETH for gas.
 * Safe to re-run: setText overwrites.
 */
async function main() {
  const key = process.env.DEPLOYER_PRIVATE_KEY as Hex | undefined;
  if (!key) throw new Error("Set DEPLOYER_PRIVATE_KEY (0x...) to publish ENS records.");
  const rpc = process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
  // No localhost fallback here on purpose: the published endpoint is what the
  // router will call in production, so it must be an explicit, public URL.
  const base = process.env.PUBLIC_AGENT_BASE_URL;
  if (!base) throw new Error("Set PUBLIC_AGENT_BASE_URL to the agents' public base URL (e.g. https://agents.example.com).");
  const names = JSON.parse(readFileSync(resolve(process.cwd(), "config/ens.names.json"), "utf8")) as {
    registry: string;
    agents: string[];
  };
  const fixtures = JSON.parse(readFileSync(resolve(process.cwd(), "config/agentFixtures.json"), "utf8")) as Record<
    string,
    { description: string }
  >;

  const account = privateKeyToAccount(key);
  const wallet = createWalletClient({ account, chain: sepolia, transport: http(rpc) });
  const publicClient = createPublicClient({ chain: sepolia, transport: http(rpc) });

  for (const ensName of names.agents) {
    const id = ensName.split(".")[0]; // contract|brand|invoice
    const description = fixtures[ensName]?.description ?? `Priya's studio ${id} helper.`;
    const records = buildTextRecords({ description, endpoint: `${base}/agents/${id}/answer` });
    for (const [recordKey, value] of Object.entries(records)) {
      const hash = await wallet.writeContract({
        address: "0x231b0Ee7994EB9f29Bf1eCEd8f632AF94714d0D2" as `0x${string}`, // Sepolia public resolver
        abi: [
          {
            name: "setText",
            type: "function",
            stateMutability: "nonpayable",
            inputs: [
              { name: "node", type: "bytes32" },
              { name: "key", type: "string" },
              { name: "value", type: "string" },
            ],
            outputs: [],
          },
        ] as const,
        functionName: "setText",
        args: [namehash(normalize(ensName)), recordKey, value],
      });
      console.log(`setText ${ensName} ${recordKey} -> ${hash}`);
      await publicClient.waitForTransactionReceipt({ hash });
    }
  }
  console.log(`\nRegistry ${names.registry}: set ai.agent.registry = "${names.agents.join(",")}" (via ENS app or setText).`);
  console.log("Done. Verify with: GET /agents on the router.");
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});

export { TEXT_RECORD_KEYS };
