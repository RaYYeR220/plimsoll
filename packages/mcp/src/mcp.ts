import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ToolDeps } from "./tools.js";
import { feedStatus, InputError, noteCoverage, vaultBacking, vaultSharePriceSeries } from "./tools.js";

export const SERVER_NAME = "plimsoll-vault-evidence";
export const SERVER_VERSION = "0.1.0";

const INSTRUCTIONS = `Live ERC-4626 vault evidence, streamed from The Graph Market (Substreams package plimsoll_erc4626).
Every answer carries provenance: package sha256, module hash, network, endpoint, the block it rests on and the stream head.
Answers are either a figure or a refusal. result:"refused" has family "evidence" (we could not tell; it carries no figure, so retry later)
or family "asset" (we could tell and the answer is no; it carries the figure, so do not retry). Never treat a refusal as zero.`;

const network = z.enum(["mainnet", "base"]).describe("chain the vault lives on");
const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .describe("0x-prefixed vault address");
const block = z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)]);

async function answer(fn: () => unknown | Promise<unknown>): Promise<CallToolResult> {
  try {
    const result = (await fn()) as Record<string, unknown>;
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
  } catch (error) {
    if (error instanceof InputError) return { isError: true, content: [{ type: "text", text: `invalid input: ${error.message}` }] };
    throw error;
  }
}

export function buildMcpServer(deps: ToolDeps): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "vault_backing",
    {
      title: "Vault backing",
      description:
        "What an ERC-4626 vault holds right now: totalAssets and totalSupply (raw and decimals-normalised), share price, the last entry and exit rates kept separate, TVL in USD where priced, and whether the vault's events are consistent with its own accounting. Refuses with data_stale, vault_unresolved or source_unavailable rather than serve a number it cannot stand behind.",
      inputSchema: { network, vault: address },
      annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: false },
    },
    (args) => answer(() => vaultBacking(deps, args)),
  );

  server.registerTool(
    "vault_share_price_series",
    {
      title: "Vault share-price series",
      description:
        "Per-block share price, entry rate, exit rate, TVL and net flows for a vault, with derived statistics: change in bps, annualised growth, the entry-vs-exit spread, and whether EIP-4626 ordering (entry >= price >= exit) held. Recent blocks come from the live stream buffer. An older range [fromBlock, toBlock] runs a bounded live Substreams request against The Graph Market.",
      inputSchema: { network, vault: address, fromBlock: block.optional(), toBlock: block.optional() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => answer(() => vaultSharePriceSeries(deps, args)),
  );

  server.registerTool(
    "note_coverage",
    {
      title: "Note coverage",
      description:
        "Coverage of a Plimsoll note by its nominated vault positions. It reads outstanding supply, par, the load line, the committed vault set and the holder (the note's sole issuer) from the note registry chain, and the holder's vault positions (balanceOf, convertToAssets) from the live stream, then applies the attestor's own coverage arithmetic. It returns covered, an asset refusal (coverage_below_floor or no_attributable_positions, with the figure), or an evidence refusal (no figure). It also points to the paid, signed x402 attestation.",
      inputSchema: { noteId: z.string().regex(/^0x[0-9a-fA-F]{64}$/).describe("bytes32 note id, keccak256 of the market code") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => answer(() => noteCoverage(deps, args)),
  );

  server.registerTool(
    "feed_status",
    {
      title: "Feed status",
      description: "Connection state, head block, lag, finality mode, last typed error and stream-slot use for each network, with provenance.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => answer(() => feedStatus(deps)),
  );

  return server;
}
