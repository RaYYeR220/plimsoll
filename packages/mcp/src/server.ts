import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { pathToFileURL } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express, { type Express, type Request, type Response } from "express";
import { agentCard, handleA2a } from "./a2a.js";
import { ATTESTOR_POLICY, coverageBpsOf, normalise } from "./attestor.js";
import { EvmChainReader } from "./chain.js";
import type { NetworkName } from "./config.js";
import { loadConfig, readToken } from "./config.js";
import { NetworkFeed, StreamSlots } from "./feed.js";
import { buildMcpServer, SERVER_NAME, SERVER_VERSION } from "./mcp.js";
import type { NotesFile } from "./notes.js";
import { loadNotes, positionsParams, withEvery } from "./notes.js";
import { LiveRangeRunner } from "./range.js";
import { configure, loadPackage, networkParam } from "./spkg.js";
import type { ToolDeps } from "./tools.js";

const MAX_SESSIONS = 200;

export function createApp(deps: ToolDeps): { app: Express; closeSessions: () => Promise<void> } {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, name: SERVER_NAME, version: SERVER_VERSION, package: `${deps.loaded.name}@${deps.loaded.version}`, sha256: deps.loaded.sha256 });
  });

  const card = (_req: Request, res: Response) => {
    res.type("application/a2a+json").set("Cache-Control", "public, max-age=300").send(JSON.stringify(agentCard(deps.config), null, 2));
  };
  app.get("/.well-known/agent-card.json", card);
  // v0.x clients look here; same document.
  app.get("/.well-known/agent.json", card);

  app.post("/a2a/v1", async (req, res) => {
    res.type("application/a2a+json").send(JSON.stringify(await handleA2a(deps, req.body)));
  });

  // Streamable HTTP, stateful: POST carries requests, GET opens the server-to-
  // client event stream, DELETE ends the session.
  const transports = new Map<string, StreamableHTTPServerTransport>();
  app.post("/mcp", async (req, res) => {
    const sid = req.header("mcp-session-id");
    let transport = sid ? transports.get(sid) : undefined;
    if (!transport) {
      if (sid || !isInitializeRequest(req.body)) {
        res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "no valid session; send initialize first" }, id: null });
        return;
      }
      if (transports.size >= MAX_SESSIONS) {
        res.status(503).json({ jsonrpc: "2.0", error: { code: -32000, message: "too many sessions" }, id: null });
        return;
      }
      const created = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports.set(id, created);
        },
      });
      created.onclose = () => {
        if (created.sessionId) transports.delete(created.sessionId);
      };
      await buildMcpServer(deps).connect(created);
      transport = created;
    }
    await transport.handleRequest(req, res, req.body);
  });
  const bySession = async (req: Request, res: Response) => {
    const t = transports.get(req.header("mcp-session-id") ?? "");
    if (!t) {
      res.status(400).send("invalid or missing mcp-session-id");
      return;
    }
    await t.handleRequest(req, res);
  };
  app.get("/mcp", bySession);
  app.delete("/mcp", bySession);

  app.get("/", (_req, res) => {
    res.json({
      name: SERVER_NAME,
      mcp: `${deps.config.publicBaseUrl}/mcp`,
      a2a: { card: `${deps.config.publicBaseUrl}/.well-known/agent-card.json`, rpc: `${deps.config.publicBaseUrl}/a2a/v1` },
      streaming: [...deps.feeds.keys()],
      package: { name: deps.loaded.name, version: deps.loaded.version, sha256: deps.loaded.sha256 },
    });
  });

  return {
    app,
    closeSessions: async () => {
      await Promise.all([...transports.values()].map((t) => t.close().catch(() => undefined)));
    },
  };
}

function log(line: string): void {
  process.stderr.write(`${new Date().toISOString()} ${line}\n`);
}

export async function main(): Promise<void> {
  const config = loadConfig();
  const token = readToken();
  const loaded = loadPackage(config.packagePath);
  log(`package ${loaded.name}@${loaded.version} sha256=${loaded.sha256.slice(0, 16)}… networks=${loaded.networks.join(",") || loaded.defaultNetwork}`);
  if (!token) log("SUBSTREAMS_API_TOKEN not set: every answer will refuse with source_unavailable");

  let notes: NotesFile;
  try {
    notes = loadNotes(config.notesFile);
  } catch (error) {
    log(`notes file unreadable (${(error as Error).message}); note_coverage will not know any notes`);
    notes = { path: config.notesFile, notes: new Map() };
  }

  // Holders are derived on-chain, never configured, and fixed into the
  // map_positions params when the stream starts.
  const chain = new EvmChainReader();
  const holders = new Map<string, string>();
  for (const n of notes.notes.values()) {
    if (!n.registry || n.vaults.length === 0 || !config.feedNetworks.includes(n.network)) continue;
    try {
      const h = await chain.issuerOf(n.noteId, n.registry);
      if (h) holders.set(n.noteId, h);
      else log(`note ${n.market}: issuer role is not a single address; its positions will not be streamed`);
    } catch (error) {
      log(`note ${n.market}: issuer read failed (${(error as Error).message})`);
    }
  }

  const slots = new StreamSlots(config.streamSlots);
  const feeds = new Map<NetworkName, NetworkFeed>();
  for (const network of config.feedNetworks) {
    const extra: Record<string, string> =
      config.outputModule === "map_positions"
        ? { map_positions: positionsParams(notes, network, holders, withEvery(networkParam(loaded, network, "map_positions"), process.env[`${network.toUpperCase()}_POSITIONS_EVERY`])) }
        : {};
    const configured = await configure(loaded, network, config.outputModule, extra);
    log(`feed ${network}: ${configured.outputModule}@${configured.moduleHash} final=${config.networks[network].finalBlocksOnly}`);
    const feed = new NetworkFeed({
      spec: config.networks[network],
      configured,
      token,
      slots,
      startBlocksBack: config.startBlocksBack,
      maxPoints: config.seriesBufferPoints,
      log,
    });
    feed.start();
    feeds.set(network, feed);
  }

  const deps: ToolDeps = {
    config: { ...config, maxStalenessSeconds: Number(process.env.MAX_STALENESS_SECONDS ?? ATTESTOR_POLICY.maxStalenessSeconds) },
    loaded,
    feeds,
    notes: () => notes,
    chain,
    streamedHolders: holders,
    coverage: { normalise, coverageBpsOf },
    range: new LiveRangeRunner({ config, loaded, token, slots, log }),
    now: () => Date.now(),
    slots,
  };
  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    log(`${signal}: closing streams`);
    // Streams are cancelled, not dropped, so the provider releases the slot
    // promptly instead of counting a dead connection against the cap.
    await Promise.all([...feeds.values()].map((f) => f.stop()));
    await closeSessions();
    server?.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3_000).unref();
  };
  const { app, closeSessions } = createApp(deps);
  let server: Server | undefined;
  // Windows cannot deliver SIGINT/SIGTERM to a detached process: `kill` there
  // is TerminateProcess, which drops the streams without cancelling them, and
  // the provider then counts them against the cap. This loopback-only route
  // gives such hosts the same graceful path. It is off unless asked for.
  if (process.env.ENABLE_LOCAL_SHUTDOWN === "1") {
    app.post("/__shutdown", (req, res) => {
      const ip = req.socket.remoteAddress ?? "";
      if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(ip)) {
        res.status(403).end();
        return;
      }
      res.json({ closing: true });
      void shutdown("http");
    });
  }
  server = app.listen(config.port, () => log(`listening on ${config.publicBaseUrl} (MCP at /mcp, A2A card at /.well-known/agent-card.json)`));

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    log(`fatal: ${(error as Error).stack ?? error}`);
    process.exit(1);
  });
}
