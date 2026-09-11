import { createPublicClient, hexToString, http, parseAbi, type PublicClient } from "viem";
import type { Registry } from "./notes.js";
import type { ChainRead } from "./provenance.js";

/**
 * Everything about a note's liabilities and identity is read from its
 * registry chain at the moment of use and never taken from configuration:
 * outstanding supply, par, the load line, the committed vault set and the
 * holder, who is derived as the note's sole issuer. Every read is pinned to
 * one block and reported back, so the figures in an answer can be re-fetched
 * by anyone.
 */

/** keccak256("ISSUER_ROLE") as used by the ATS deployment in packages/contracts. */
export const ROLE_ISSUER = "0x5eeaf5602c75bf26e73b5206d0bd6ee82f621166255e5fd73cc06bc7bd84a95f" as const;

const NOTE_ABI = parseAbi([
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function getNominalValue() view returns (uint256)",
  "function getNominalValueDecimals() view returns (uint8)",
  "function getNominalValueCurrency() view returns (bytes3)",
  "function getRoleMembers(bytes32 role, uint256 start, uint256 end) view returns (address[])",
]);
const ORACLE_ABI = parseAbi([
  "struct Note { address attestor; bytes32 vaultSetHash; uint64 maxAgeSeconds; bool registered; }",
  "function noteOf(bytes32 noteId) view returns (Note)",
]);
const LOADLINE_ABI = parseAbi(["function lineOf(bytes32 noteId) view returns (uint64 thresholdBps, bool configured)"]);

export interface NoteFacts {
  readonly block: bigint;
  readonly registered: boolean;
  readonly onchainVaultSetHash: string;
  /** Null unless the issuer role has exactly one member. */
  readonly holder: string | null;
  readonly issuerCount: number;
  readonly totalSupply: bigint;
  readonly noteDecimals: number;
  readonly nominal: bigint;
  readonly nominalDecimals: number;
  readonly currency: string;
  readonly thresholdBps: number;
  readonly lineConfigured: boolean;
  readonly reads: readonly ChainRead[];
}

export class ChainReadError extends Error {
  constructor(
    readonly contract: string,
    readonly method: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ChainReader {
  noteFacts(noteId: string, registry: Registry): Promise<NoteFacts>;
  issuerOf(noteId: string, registry: Registry): Promise<string | null>;
}

export class EvmChainReader implements ChainReader {
  private clients = new Map<string, PublicClient>();

  private client(rpc: string): PublicClient {
    let c = this.clients.get(rpc);
    if (!c) {
      c = createPublicClient({ transport: http(rpc, { timeout: 20_000, retryCount: 1 }) }) as PublicClient;
      this.clients.set(rpc, c);
    }
    return c;
  }

  async issuerOf(_noteId: string, registry: Registry): Promise<string | null> {
    const members = await this.read(registry, registry.note, "getRoleMembers(ISSUER_ROLE,0,10)", () =>
      this.client(registry.rpc).readContract({
        address: registry.note as `0x${string}`,
        abi: NOTE_ABI,
        functionName: "getRoleMembers",
        args: [ROLE_ISSUER, 0n, 10n],
      }),
    );
    return members.length === 1 ? members[0]!.toLowerCase() : null;
  }

  async noteFacts(noteId: string, registry: Registry): Promise<NoteFacts> {
    const c = this.client(registry.rpc);
    const block = await this.read(registry, "-", "eth_blockNumber", () => c.getBlockNumber());
    const reads: ChainRead[] = [];
    const at = { blockNumber: block } as const;
    const record = (contract: string, method: string, kind: ChainRead["kind"], value: string) =>
      reads.push({ chain: registry.chain, chainId: registry.chainId, rpc: registry.rpc, contract, method, block: block.toString(), kind, value });
    const id = noteId as `0x${string}`;

    const note = await this.read(registry, registry.coverageOracle, "noteOf(bytes32)", () =>
      c.readContract({ address: registry.coverageOracle as `0x${string}`, abi: ORACLE_ABI, functionName: "noteOf", args: [id], ...at }),
    );
    record(registry.coverageOracle, "CoverageOracle.noteOf(noteId).vaultSetHash", "identity", note.vaultSetHash);
    record(registry.coverageOracle, "CoverageOracle.noteOf(noteId).registered", "identity", String(note.registered));

    const [line, members, supply, decimals, nominal, nominalDecimals, currency] = await Promise.all([
      this.read(registry, registry.loadLine, "lineOf(bytes32)", () =>
        c.readContract({ address: registry.loadLine as `0x${string}`, abi: LOADLINE_ABI, functionName: "lineOf", args: [id], ...at }),
      ),
      this.read(registry, registry.note, "getRoleMembers(ISSUER_ROLE,0,10)", () =>
        c.readContract({ address: registry.note as `0x${string}`, abi: NOTE_ABI, functionName: "getRoleMembers", args: [ROLE_ISSUER, 0n, 10n], ...at }),
      ),
      this.read(registry, registry.note, "totalSupply()", () =>
        c.readContract({ address: registry.note as `0x${string}`, abi: NOTE_ABI, functionName: "totalSupply", ...at }),
      ),
      this.read(registry, registry.note, "decimals()", () =>
        c.readContract({ address: registry.note as `0x${string}`, abi: NOTE_ABI, functionName: "decimals", ...at }),
      ),
      this.read(registry, registry.note, "getNominalValue()", () =>
        c.readContract({ address: registry.note as `0x${string}`, abi: NOTE_ABI, functionName: "getNominalValue", ...at }),
      ),
      this.read(registry, registry.note, "getNominalValueDecimals()", () =>
        c.readContract({ address: registry.note as `0x${string}`, abi: NOTE_ABI, functionName: "getNominalValueDecimals", ...at }),
      ),
      this.read(registry, registry.note, "getNominalValueCurrency()", () =>
        c.readContract({ address: registry.note as `0x${string}`, abi: NOTE_ABI, functionName: "getNominalValueCurrency", ...at }),
      ),
    ]);
    const [thresholdBps, configured] = line;
    const issuers = members.map((m) => m.toLowerCase());
    const currencyText = hexToString(currency).replace(/\0+$/, "");
    record(registry.loadLine, "LoadLine.lineOf(noteId).thresholdBps", "quantity", thresholdBps.toString());
    record(registry.loadLine, "LoadLine.lineOf(noteId).configured", "identity", String(configured));
    record(registry.note, "getRoleMembers(ISSUER_ROLE,0,10)", "identity", issuers.join(","));
    record(registry.note, "totalSupply()", "quantity", supply.toString());
    record(registry.note, "decimals()", "quantity", decimals.toString());
    record(registry.note, "getNominalValue()", "quantity", nominal.toString());
    record(registry.note, "getNominalValueDecimals()", "quantity", nominalDecimals.toString());
    record(registry.note, "getNominalValueCurrency()", "identity", currencyText);

    return {
      block,
      registered: note.registered,
      onchainVaultSetHash: note.vaultSetHash.toLowerCase(),
      holder: issuers.length === 1 ? issuers[0]! : null,
      issuerCount: issuers.length,
      totalSupply: supply,
      noteDecimals: Number(decimals),
      nominal,
      nominalDecimals: Number(nominalDecimals),
      currency: currencyText,
      thresholdBps: Number(thresholdBps),
      lineConfigured: configured,
      reads,
    };
  }

  private async read<T>(registry: Registry, contract: string, method: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      const short = (error as { shortMessage?: string }).shortMessage ?? (error as Error).message;
      throw new ChainReadError(contract, method, `${registry.chain} ${method} failed: ${short}`);
    }
  }
}
