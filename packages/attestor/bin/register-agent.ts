#!/usr/bin/env node
import type { Hex } from "viem";
import { IDENTITY_REGISTRY, createErc8004Client, registerAgent } from "../src/erc8004.js";
import { buildOnChainRegistration } from "../src/registration.js";

/**
 * Register this service on the ERC-8004 Identity registry. Run once.
 *
 * Registration mints an NFT whose token id is the agent id buyers reference
 * when they leave feedback, so re-running it creates a second identity for the
 * same service and splits its reputation. There is no idempotency guard in the
 * registry, which is why this is a deliberate command rather than something the
 * server does at boot.
 */
async function main(): Promise<void> {
  const key = (process.env.HEDERA_PRIVATE_KEY ?? "").trim();
  if (!key) throw new Error("HEDERA_PRIVATE_KEY is required to send the registration transaction");

  const baseUrl = (process.env.PUBLIC_BASE_URL ?? "http://localhost:4021").replace(/\/$/, "");
  const document = buildOnChainRegistration({
    baseUrl,
    payTo: process.env.PAY_TO ?? "0.0.0",
    amountTinybar: process.env.AMOUNT_TINYBAR ?? "100000",
    attestorAddress: process.env.ATTESTOR_ADDRESS ?? "0x",
    facilitatorUrl: process.env.FACILITATOR_URL ?? "https://api.testnet.blocky402.com",
    topicId: process.env.HCS_TOPIC_ID ?? null,
  });
  const json = JSON.stringify(document);

  // An explicit URL can be passed once the service has a public host. With no
  // argument the registration document is embedded directly, so the identity
  // does not depend on a deployment that does not exist yet and never needs
  // re-registering to fix a link.
  const agentURI =
    process.argv[2] ?? `data:application/json;base64,${Buffer.from(json, "utf8").toString("base64")}`;

  const client = createErc8004Client({
    privateKey: (key.startsWith("0x") ? key : `0x${key}`) as Hex,
    rpcUrl: process.env.EVM_RPC_URL,
  });

  console.log(`registering a ${agentURI.length} byte agentURI`);
  if (agentURI.startsWith("data:")) console.log(`  document: ${json}`);
  else console.log(`  url:      ${agentURI}`);
  console.log(`  registry: ${IDENTITY_REGISTRY} on chain 296`);
  console.log(`  from:     ${client.address}`);

  const result = await registerAgent(client, agentURI);
  console.log(`\nregistered`);
  console.log(`  tx:       ${result.transactionHash}`);
  console.log(`  agentId:  ${result.agentId ?? "could not read the minted token id from the logs"}`);
  console.log(`  gas used: ${result.gasUsed}`);
  console.log(`  hashscan: https://hashscan.io/testnet/transaction/${result.transactionHash}`);
  console.log(`\nSet ATTESTOR_AGENT_ID=${result.agentId ?? "<agentId>"} so the buyer can leave feedback.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
