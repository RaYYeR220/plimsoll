import { readFileSync } from "node:fs";
import type { NoteRegistry } from "./hedera.js";
import { noteIdOf } from "./hedera.js";

/**
 * Reads the shared notes file (`packages/substreams/notes.json`, format 2).
 *
 * The file holds only what the chain cannot say: which network holds the
 * backing, which vaults are nominated, and where the note's own facts live.
 * Liabilities, the threshold and the holder are deliberately absent and are
 * read from the chain at valuation time.
 */
export interface LiveNoteDefinition {
  /** keccak256(market), lowercase. */
  readonly noteId: string;
  readonly market: string;
  readonly network: string;
  /** Chain holding the backing positions. */
  readonly chainId: number;
  /** Nominated vaults, lowercase and sorted. */
  readonly vaults: readonly string[];
  /** The file's own record of the set hash, when it carries one. */
  readonly vaultSetHash: string | null;
  readonly negativeControl: boolean;
  readonly status: string;
  readonly registry: NoteRegistry | null;
}

export class NotesFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotesFileError";
  }
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

function fail(message: string): never {
  throw new NotesFileError(message);
}

function str(value: unknown, where: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(`${where} must be a non-empty string`);
  return value;
}

function address(value: unknown, where: string): string {
  const s = str(value, where);
  if (!ADDRESS.test(s)) fail(`${where} is not an address: ${s}`);
  return s.toLowerCase();
}

/**
 * A malformed file is a configuration error and throws at load time. It is not
 * a refusal: nothing has been valued yet, so there is no verdict to sign.
 */
export function parseNotesFile(input: unknown): LiveNoteDefinition[] {
  if (!input || typeof input !== "object") fail("notes file must be a JSON object");
  const file = input as { version?: unknown; notes?: unknown };
  if (file.version !== 2) fail(`unsupported notes file version ${JSON.stringify(file.version)}; expected 2`);
  if (!file.notes || typeof file.notes !== "object") fail("notes file has no notes object");

  const out: LiveNoteDefinition[] = [];
  for (const [key, raw] of Object.entries(file.notes as Record<string, unknown>)) {
    if (!BYTES32.test(key)) fail(`note key ${key} is not a bytes32 note id`);
    if (!raw || typeof raw !== "object") fail(`note ${key} is not an object`);
    const n = raw as Record<string, unknown>;
    const market = str(n.market, `${key}.market`);
    if (noteIdOf(market) !== key.toLowerCase()) fail(`note key ${key} is not keccak256(${JSON.stringify(market)})`);

    if (typeof n.chainId !== "number") fail(`${market}.chainId must be a number`);
    if (!Array.isArray(n.vaults)) fail(`${market}.vaults must be an array`);
    const vaults = (n.vaults as unknown[]).map((v, i) => address(v, `${market}.vaults[${i}]`)).sort();
    if (new Set(vaults).size !== vaults.length) fail(`${market}.vaults lists a vault twice`);

    let registry: NoteRegistry | null = null;
    if (n.registry !== undefined && n.registry !== null) {
      const r = n.registry as Record<string, unknown>;
      if (typeof r.chainId !== "number") fail(`${market}.registry.chainId must be a number`);
      registry = {
        chain: str(r.chain, `${market}.registry.chain`),
        chainId: r.chainId,
        mirror: str(r.mirror, `${market}.registry.mirror`),
        note: address(r.note, `${market}.registry.note`),
        loadLine: address(r.loadLine, `${market}.registry.loadLine`),
        ...(r.coverageOracle ? { coverageOracle: address(r.coverageOracle, `${market}.registry.coverageOracle`) } : {}),
      };
    }

    out.push({
      noteId: key.toLowerCase(),
      market,
      network: typeof n.network === "string" ? n.network : "",
      chainId: n.chainId,
      vaults,
      vaultSetHash: typeof n.vaultSetHash === "string" ? n.vaultSetHash.toLowerCase() : null,
      negativeControl: n.negativeControl === true,
      status: typeof n.status === "string" ? n.status : "",
      registry,
    });
  }
  return out.sort((a, b) => (a.market < b.market ? -1 : a.market > b.market ? 1 : 0));
}

export function loadNotesFile(path: string): LiveNoteDefinition[] {
  return parseNotesFile(JSON.parse(readFileSync(path, "utf8")));
}
