/**
 * End to end over the real transports, offline: a real MCP client speaks
 * Streamable HTTP to the Express app, whose feed replays RECORDED stream
 * output. It also checks the A2A card route.
 */
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { NetworkName } from "../src/config.js";
import type { FeedHandle } from "../src/feed.js";
import { createApp } from "../src/server.js";
import { assertProvenance, deps, loadedFrom, loadRecording, replay, testConfig } from "./helpers.js";

test("MCP over Streamable HTTP: list tools, call them, every answer has provenance", async () => {
  const rec = loadRecording("mainnet");
  const config = testConfig({ maxStalenessSeconds: 86_400 });
  const feed = replay(rec, config);
  const vault = [...feed.state.vaults.entries()].find(([, o]) => o.vb.stateOk && o.vb.ratesConsistent)![0];
  const d = deps({ feeds: new Map<NetworkName, FeedHandle>([["mainnet", feed]]), now: (rec.head!.timestamp + 5) * 1000, loaded: loadedFrom(rec), config });
  const { app, closeSessions } = createApp(d);
  const server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = new Client({ name: "test", version: "0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, ["feed_status", "note_coverage", "vault_backing", "vault_share_price_series"]);

    for (const [name, args] of [
      ["vault_backing", { network: "mainnet", vault }],
      ["vault_backing", { network: "base", vault }],
      ["vault_share_price_series", { network: "mainnet", vault }],
      ["note_coverage", { noteId: "0x" + "ee".repeat(32) }],
    ] as const) {
      const res = await client.callTool({ name, arguments: args });
      const body = res.structuredContent as Record<string, any>;
      assertProvenance(body.provenance);
    }
    const status = (await client.callTool({ name: "feed_status", arguments: {} })).structuredContent as Record<string, any>;
    assertProvenance(status.networks.mainnet.provenance);

    const bad = await client.callTool({ name: "vault_backing", arguments: { network: "mainnet", vault: "0x1" } });
    assert.equal(bad.isError, true);

    const card = await (await fetch(`${base}/.well-known/agent-card.json`)).json();
    assert.equal((card as any).supportedInterfaces[0].protocolBinding, "JSONRPC");
  } finally {
    await transport.terminateSession().catch(() => undefined);
    await client.close();
    await closeSessions();
    await new Promise((r) => server.close(r));
  }
});
