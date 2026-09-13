import { existsSync, readFileSync } from "node:fs";
// The one definition of this hash lives in the attestor, which is what signs
// over it. A second copy here would be a second definition, and two definitions
// of a hash are how a payload gets signed that the chain cannot verify.
import { canonicalHash } from "@plimsoll/attestor/dist/src/canonical.js";
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
import { PLANNED_LIABILITIES, type Market } from "./config.js";

/** ATS v8 issuer role. The note's holder is its sole member. */
const ROLE_ISSUER = "0x5eeaf5602c75bf26e73b5206d0bd6ee82f621166255e5fd73cc06bc7bd84a95f";

const NOTE_ABI = parseAbi([
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function getNominalValue() view returns (uint256)",
  "function getNominalValueDecimals() view returns (uint8)",
  "function getNominalValueCurrency() view returns (bytes3)",
  "function getRoleMembers(bytes32 role, uint256 pageIndex, uint256 pageLength) view returns (address[])",
]);
const LOAD_LINE_ABI = parseAbi(["function lineOf(bytes32 noteId) view returns (uint64, bool)"]);

export interface NotesEntry {
  market: string;
  vaults: string[];
  vaultSetHash?: string;
  registry?: { mirror: string; note: string; loadLine: string };
}

/** The shared notes file, keyed by market. A missing file is an empty map. */
export function loadNotes(path: string): Map<string, NotesEntry> {
  if (!existsSync(path)) return new Map();
  const file = JSON.parse(readFileSync(path, "utf8")) as { notes?: Record<string, NotesEntry> };
  return new Map(Object.values(file.notes ?? {}).map((n) => [n.market, n]));
}

/**
 * The vault-set hash, as the attestor computes it: `canonicalHash` over the
 * lowercased, sorted vault list (`attest.ts`, where the attestation commits to
 * it). Only the preimage convention lives here; the hashing does not.
 */
export function vaultSetHash(vaults: readonly string[]): Hex {
  return canonicalHash(vaults.map((v) => v.toLowerCase()).sort());
}

export function noteIdOf(market: string): Hex {
  return keccak256(stringToBytes(market));
}

export interface Liabilities {
  readonly source: "hedera" | "planned";
  readonly market: string;
  readonly notes: string;
  readonly parUsd: string;
  /** notes x par, in micro-USD, rounded up. */
  readonly obligationMicro: bigint;
  readonly thresholdBps: number;
  readonly issuer: string | null;
  /** Hedera block the figures were read at, when they were read. */
  readonly block: number | null;
}

export function plannedLiabilities(market: Market): Liabilities | null {
  const planned = PLANNED_LIABILITIES[market];
  if (!planned) return null;
  const obligationMicro = decimalToUnits(planned.notes, 6) * decimalToUnits(planned.parUsd, 6) / 1_000_000n;
  return {
    source: "planned",
    market,
    notes: planned.notes,
    parUsd: planned.parUsd,
    obligationMicro,
    thresholdBps: planned.thresholdBps,
    issuer: null,
    block: null,
  };
}

/** Supply, par, issuer and load line from Hedera, all at one mirror-node block. */
export async function readLiabilities(
  market: string,
  registry: NonNullable<NotesEntry["registry"]>,
  fetchImpl: typeof fetch = fetch,
): Promise<Liabilities> {
  const mirror = registry.mirror.replace(/\/+$/, "");
  const blocks = (await (await fetchImpl(`${mirror}/blocks?limit=1&order=desc`)).json()) as {
    blocks: Array<{ number: number }>;
  };
  const block = blocks.blocks[0]!.number;
  const call = async <T>(to: string, abi: Abi, functionName: string, args: readonly unknown[] = []): Promise<T> => {
    const response = await fetchImpl(`${mirror}/contracts/call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to, data: encodeFunctionData({ abi, functionName, args } as never), block: String(block), estimate: false }),
    });
    if (!response.ok) throw new Error(`${functionName} on ${to} failed with HTTP ${response.status} at Hedera block ${block}`);
    const { result } = (await response.json()) as { result: Hex };
    return decodeFunctionResult({ abi, functionName, data: result } as never) as T;
  };

  const [supply, noteDecimals, nominal, nominalDecimals, currency, issuers, line] = await Promise.all([
    call<bigint>(registry.note, NOTE_ABI, "totalSupply"),
    call<number>(registry.note, NOTE_ABI, "decimals"),
    call<bigint>(registry.note, NOTE_ABI, "getNominalValue"),
    call<number>(registry.note, NOTE_ABI, "getNominalValueDecimals"),
    call<Hex>(registry.note, NOTE_ABI, "getNominalValueCurrency"),
    call<readonly string[]>(registry.note, NOTE_ABI, "getRoleMembers", [ROLE_ISSUER, 0n, 2n]),
    call<readonly [bigint, boolean]>(registry.loadLine, LOAD_LINE_ABI, "lineOf", [noteIdOf(market)]),
  ]);
  if (hexToString(currency).replace(/\0+$/, "") !== "USD") throw new Error(`${market}: par is not in USD`);
  if (issuers.length !== 1) throw new Error(`${market}: ${issuers.length} issuers, holder is ambiguous`);
  if (!line[1]) throw new Error(`${market}: no load line configured`);

  const scale = 10n ** BigInt(Number(noteDecimals) + Number(nominalDecimals));
  const product = supply * nominal * 1_000_000n;
  return {
    source: "hedera",
    market,
    notes: formatDecimal(supply, Number(noteDecimals)),
    parUsd: formatDecimal(nominal, Number(nominalDecimals)),
    obligationMicro: (product + scale - 1n) / scale,
    thresholdBps: Number(line[0]),
    issuer: issuers[0]!.toLowerCase(),
    block,
  };
}

export function decimalToUnits(value: string, decimals: number): bigint {
  const [whole, fraction = ""] = value.split(".");
  if (!/^\d+$/.test(whole ?? "") || !/^\d*$/.test(fraction) || fraction.length > decimals) {
    throw new Error(`"${value}" is not a decimal amount with at most ${decimals} places`);
  }
  return BigInt(whole!) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
}

export function formatDecimal(units: bigint, decimals: number): string {
  if (decimals === 0) return units.toString();
  const s = units.toString().padStart(decimals + 1, "0");
  return `${s.slice(0, -decimals)}.${s.slice(-decimals)}`;
}
