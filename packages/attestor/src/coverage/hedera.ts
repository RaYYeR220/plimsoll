import {
  decodeFunctionResult,
  encodeFunctionData,
  hexToString,
  keccak256,
  parseAbi,
  stringToBytes,
  type Abi,
  type Hex,
} from "viem";
import { LiabilityUnresolved } from "./live-errors.js";

/**
 * The note's side of the ratio, read from the note's own chain at one block.
 * Amounts are decimal strings so the reading can be published verbatim.
 */
export interface LiabilityReading {
  readonly chain: string;
  readonly chainId: number;
  /** Published name of the endpoint read, never a credential. */
  readonly endpoint: string;
  readonly block: string;
  readonly blockHash: string;
  /** Unix seconds of that block. */
  readonly observedAt: number;
  readonly market: string;
  /** keccak256(market): the id the note's contracts key on. */
  readonly noteId: string;
  readonly note: string;
  readonly totalSupply: string;
  readonly noteDecimals: number;
  readonly nominalValue: string;
  readonly nominalValueDecimals: number;
  readonly currency: string;
  /** Sole holder of the note's issuer role: the address whose positions are valued. */
  readonly issuer: string;
  readonly loadLine: string;
  readonly thresholdBps: number;
  readonly coverageOracle: string | null;
  /** The vault set hash CoverageOracle holds for this note, when an oracle is named. */
  readonly registeredVaultSetHash: string | null;
}

/**
 * The liability side of coverage, read from the note's own chain.
 *
 * Nothing here is configured. Outstanding supply, par, the holder and the load
 * line all come from contracts at one pinned Hedera block, and each read is
 * recorded so a stranger can repeat it. A read that fails, or that returns
 * something unusable, is a refusal: the denominator is never defaulted.
 */

/** ATS v8 issuer role, as granted at issuance (`ROLE_ISSUER` in IssueNote.s.sol). */
export const ROLE_ISSUER = "0x5eeaf5602c75bf26e73b5206d0bd6ee82f621166255e5fd73cc06bc7bd84a95f" as const;

export const NOTE_ABI = parseAbi([
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function getNominalValue() view returns (uint256)",
  "function getNominalValueDecimals() view returns (uint8)",
  "function getNominalValueCurrency() view returns (bytes3)",
  "function getRoleMemberCount(bytes32 role) view returns (uint256)",
  "function getRoleMembers(bytes32 role, uint256 pageIndex, uint256 pageLength) view returns (address[])",
]);

export const LOAD_LINE_ABI = parseAbi([
  "function lineOf(bytes32 noteId) view returns (uint64 thresholdBps, bool configured)",
]);

export const COVERAGE_ORACLE_ABI = parseAbi([
  "function noteOf(bytes32 noteId) view returns ((address attestor, bytes32 vaultSetHash, uint64 maxAgeSeconds, bool registered))",
]);

/** Where a note's on-chain facts live. Mirrors the `registry` block of the notes file. */
export interface NoteRegistry {
  readonly chain: string;
  readonly chainId: number;
  /** Mirror node REST base, e.g. `https://testnet.mirrornode.hedera.com/api/v1`. */
  readonly mirror: string;
  /** The ATS note contract. */
  readonly note: string;
  readonly loadLine: string;
  /** When present, the registered vault set is read and must match. */
  readonly coverageOracle?: string;
}

export interface LiabilityReader {
  /** Everything the denominator depends on, read at one block of the note's chain. */
  read(market: string, registry: NoteRegistry): Promise<LiabilityReading>;
}

/** The on-chain note id: the hash of the exact market string a human reads on the device. */
export function noteIdOf(market: string): Hex {
  return keccak256(stringToBytes(market));
}

export interface MirrorReaderOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

interface MirrorBlock {
  number: number;
  hash: string;
  timestamp: { from: string; to: string };
}

/**
 * Reads through the Hedera mirror node's `contracts/call`, pinned to one block
 * number for every call, so supply, par, issuer and threshold are one snapshot.
 */
export class MirrorLiabilityReader implements LiabilityReader {
  private readonly fetch: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(options: MirrorReaderOptions = {}) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async read(market: string, registry: NoteRegistry): Promise<LiabilityReading> {
    const base = registry.mirror.replace(/\/+$/, "");
    const endpoint = new URL(base).host;
    const block = await this.latestBlock(base, market);
    const noteId = noteIdOf(market);
    const call = <T>(to: string, abi: Abi, functionName: string, args: readonly unknown[] = []) =>
      this.call<T>(base, block.number, market, to, abi, functionName, args);

    const [totalSupply, noteDecimals, nominalValue, nominalValueDecimals, currencyRaw, issuerCount, line, oracleNote] =
      await Promise.all([
        call<bigint>(registry.note, NOTE_ABI, "totalSupply"),
        call<number>(registry.note, NOTE_ABI, "decimals"),
        call<bigint>(registry.note, NOTE_ABI, "getNominalValue"),
        call<number>(registry.note, NOTE_ABI, "getNominalValueDecimals"),
        call<Hex>(registry.note, NOTE_ABI, "getNominalValueCurrency"),
        call<bigint>(registry.note, NOTE_ABI, "getRoleMemberCount", [ROLE_ISSUER]),
        call<readonly [bigint, boolean]>(registry.loadLine, LOAD_LINE_ABI, "lineOf", [noteId]),
        registry.coverageOracle
          ? call<{ vaultSetHash: Hex; registered: boolean }>(registry.coverageOracle, COVERAGE_ORACLE_ABI, "noteOf", [
              noteId,
            ])
          : Promise.resolve(null),
      ]);

    // The holder is whoever the note says issued it. None, or more than one,
    // leaves nobody whose positions we could honestly attribute to the note.
    if (issuerCount !== 1n) {
      throw new LiabilityUnresolved(`${market} has ${issuerCount} issuers, so its holder is ambiguous`, {
        market,
        issuerCount: issuerCount.toString(),
        block: block.number,
      });
    }
    const members = await call<readonly string[]>(registry.note, NOTE_ABI, "getRoleMembers", [ROLE_ISSUER, 0n, 1n]);
    const issuer = members[0];
    if (members.length !== 1 || !issuer) {
      throw new LiabilityUnresolved(`${market}: issuer role reports one member but lists ${members.length}`, {
        market,
        block: block.number,
      });
    }

    const [thresholdBps, configured] = line;
    if (!configured) {
      throw new LiabilityUnresolved(`${market} has no load line configured`, { market, loadLine: registry.loadLine });
    }

    const currency = hexToString(currencyRaw).replace(/\0+$/, "");
    if (currency !== "USD") {
      throw new LiabilityUnresolved(`${market}'s par is denominated in ${JSON.stringify(currency)}, not USD`, {
        market,
        currency: currencyRaw,
      });
    }

    if (oracleNote && !oracleNote.registered) {
      throw new LiabilityUnresolved(`${market} is not registered in CoverageOracle`, {
        market,
        coverageOracle: registry.coverageOracle,
      });
    }

    return {
      chain: registry.chain,
      chainId: registry.chainId,
      endpoint,
      block: String(block.number),
      blockHash: block.hash,
      observedAt: Number(block.timestamp.to.split(".")[0]),
      market,
      noteId,
      note: registry.note.toLowerCase(),
      totalSupply: totalSupply.toString(),
      noteDecimals: Number(noteDecimals),
      nominalValue: nominalValue.toString(),
      nominalValueDecimals: Number(nominalValueDecimals),
      currency,
      issuer: issuer.toLowerCase(),
      loadLine: registry.loadLine.toLowerCase(),
      thresholdBps: Number(thresholdBps),
      coverageOracle: registry.coverageOracle ? registry.coverageOracle.toLowerCase() : null,
      registeredVaultSetHash: oracleNote ? oracleNote.vaultSetHash.toLowerCase() : null,
    };
  }

  private async latestBlock(base: string, market: string): Promise<MirrorBlock> {
    const body = await this.getJson<{ blocks?: MirrorBlock[] }>(`${base}/blocks?limit=1&order=desc`, undefined, market);
    const block = body.blocks?.[0];
    if (!block || typeof block.number !== "number") {
      throw new LiabilityUnresolved("the mirror node returned no latest block", { market, mirror: base });
    }
    return block;
  }

  private async call<T>(
    base: string,
    blockNumber: number,
    market: string,
    to: string,
    abi: Abi,
    functionName: string,
    args: readonly unknown[],
  ): Promise<T> {
    const data = encodeFunctionData({ abi, functionName, args } as never);
    const body = await this.getJson<{ result?: Hex }>(
      `${base}/contracts/call`,
      { data, to, block: String(blockNumber), estimate: false },
      market,
      `${functionName} on ${to}`,
    );
    if (!body.result || body.result === "0x") {
      throw new LiabilityUnresolved(`${functionName} on ${to} returned no data`, { market, block: blockNumber });
    }
    return decodeFunctionResult({ abi, functionName, data: body.result } as never) as T;
  }

  private async getJson<T>(url: string, post: unknown, market: string, what = url): Promise<T> {
    let response: Response;
    try {
      response = await this.fetch(url, {
        method: post === undefined ? "GET" : "POST",
        headers: post === undefined ? {} : { "content-type": "application/json" },
        body: post === undefined ? undefined : JSON.stringify(post),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new LiabilityUnresolved(`${what} could not be read: ${(error as Error).message}`, { market });
    }
    if (!response.ok) {
      let detail: unknown = null;
      try {
        detail = await response.json();
      } catch {
        // The status is the finding; an unreadable body adds nothing.
      }
      throw new LiabilityUnresolved(`${what} failed with HTTP ${response.status}`, { market, status: response.status, detail });
    }
    return (await response.json()) as T;
  }
}
