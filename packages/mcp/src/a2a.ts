import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import { SERVER_VERSION } from "./mcp.js";
import type { ToolDeps } from "./tools.js";
import { feedStatus, InputError, noteCoverage, vaultBacking, vaultSharePriceSeries } from "./tools.js";

/**
 * A2A v1.0 discovery card for this server, plus a deliberately small
 * JSON-RPC surface behind it. `SendMessage` takes one DataPart
 * {skill, args}, runs the same function the MCP tool runs, and answers with
 * a Message holding one DataPart. There is no task lifecycle, streaming or
 * push, and the card says so through `capabilities`, so a client never has
 * to discover it by failing.
 */
export const A2A_PROTOCOL_VERSION = "1.0";

const SKILLS = [
  {
    id: "vault-backing",
    name: "Vault backing",
    description:
      "Current totalAssets, totalSupply, share price, separate entry and exit rates and TVL of an ERC-4626 vault on Ethereum mainnet or Base, from a live Substreams stream on The Graph Market, with provenance. It refuses instead of serving stale or unresolved data.",
    tags: ["erc4626", "vault", "backing", "tvl", "substreams", "the-graph"],
    examples: ['{"skill":"vault-backing","args":{"network":"mainnet","vault":"0x9d39a5de30e57443bff2a8307a4256c8797a3497"}}'],
  },
  {
    id: "vault-share-price-series",
    name: "Vault share-price series",
    description:
      "Per-block share-price series of an ERC-4626 vault with derived growth, the entry-vs-exit spread and an EIP-4626 ordering check. Older ranges are fetched by a bounded live Substreams request.",
    tags: ["erc4626", "share-price", "timeseries", "yield", "substreams"],
    examples: ['{"skill":"vault-share-price-series","args":{"network":"mainnet","vault":"0x56a76b428244a50513ec81e225a293d128fd581d"}}'],
  },
  {
    id: "note-coverage",
    name: "Note coverage",
    description:
      "Coverage of a Plimsoll note by its issuer's ERC-4626 positions, using on-chain liabilities and the attestor's arithmetic. It returns covered, an asset refusal with the figure, or an evidence refusal with none, and links to the paid, signed x402 attestation.",
    tags: ["coverage", "attestation", "rwa", "solvency", "x402"],
    examples: ['{"skill":"note-coverage","args":{"noteId":"0x376011be372685b3e6d566a7ba172f8b8968ac7a6d56d23e67046e2fd24d253c"}}'],
  },
  {
    id: "feed-status",
    name: "Feed status",
    description: "Stream connection state, head, lag, finality mode and stream-slot use per network.",
    tags: ["status", "provenance", "substreams"],
    examples: ['{"skill":"feed-status","args":{}}'],
  },
] as const;

export function agentCard(config: Config): Record<string, unknown> {
  return {
    name: "Plimsoll Vault Evidence",
    description:
      "Live ERC-4626 vault evidence for agents, streamed from The Graph Market via the plimsoll_erc4626 Substreams package. Every answer carries provenance (package sha256, module hash, block, endpoint), and every uncertainty is a typed refusal rather than a number. The same functions are served over MCP (Streamable HTTP) at /mcp.",
    version: SERVER_VERSION,
    supportedInterfaces: [{ url: `${config.publicBaseUrl}/a2a/v1`, protocolBinding: "JSONRPC", protocolVersion: A2A_PROTOCOL_VERSION }],
    provider: { organization: "Plimsoll", url: config.publicBaseUrl },
    documentationUrl: `${config.publicBaseUrl}/`,
    capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills: SKILLS,
  };
}

type Json = Record<string, unknown>;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: { message?: { messageId?: string; contextId?: string; parts?: Json[] } };
}

function rpcError(id: JsonRpcRequest["id"], code: number, message: string): Json {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function extractCall(parts: Json[] | undefined): { skill: string; args: Json } | null {
  for (const part of parts ?? []) {
    // v1.0 puts the value in `data`; v0.3 adds `kind: "data"`. Both are accepted.
    const data = (part.data ?? null) as Json | null;
    if (data && typeof data === "object" && typeof data.skill === "string") {
      return { skill: data.skill, args: (data.args ?? {}) as Json };
    }
    if (typeof part.text === "string") {
      try {
        const parsed = JSON.parse(part.text) as Json;
        if (typeof parsed.skill === "string") return { skill: parsed.skill, args: (parsed.args ?? {}) as Json };
      } catch {
        // prose is not a call
      }
    }
  }
  return null;
}

async function run(deps: ToolDeps, skill: string, args: Json): Promise<unknown> {
  switch (skill.replace(/_/g, "-")) {
    case "vault-backing":
      return vaultBacking(deps, args as never);
    case "vault-share-price-series":
      return vaultSharePriceSeries(deps, args as never);
    case "note-coverage":
      return noteCoverage(deps, args as never);
    case "feed-status":
      return feedStatus(deps);
    default:
      throw new InputError(`unknown skill "${skill}"; see /.well-known/agent-card.json`);
  }
}

export async function handleA2a(deps: ToolDeps, body: unknown): Promise<Json> {
  const req = (body ?? {}) as JsonRpcRequest;
  if (req.jsonrpc !== "2.0" || typeof req.method !== "string") return rpcError(req.id, -32600, "invalid JSON-RPC request");
  const legacy = req.method === "message/send";
  if (req.method !== "SendMessage" && !legacy) {
    return rpcError(req.id, -32601, `method ${req.method} not supported; this agent implements SendMessage only (no tasks, streaming or push)`);
  }
  const call = extractCall(req.params?.message?.parts);
  if (!call) return rpcError(req.id, -32602, 'expected a DataPart {"skill": "...", "args": {...}}');
  let result: unknown;
  try {
    result = await run(deps, call.skill, call.args);
  } catch (error) {
    if (error instanceof InputError) return rpcError(req.id, -32602, error.message);
    throw error;
  }
  const contextId = req.params?.message?.contextId ?? randomUUID();
  const message = legacy
    ? { kind: "message", messageId: randomUUID(), contextId, role: "agent", parts: [{ kind: "data", data: result }] }
    : { messageId: randomUUID(), contextId, role: "ROLE_AGENT", parts: [{ data: result, mediaType: "application/json" }] };
  return { jsonrpc: "2.0", id: req.id ?? null, result: legacy ? message : { message } };
}
