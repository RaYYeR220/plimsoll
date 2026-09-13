import { readFileSync } from "node:fs";
import type { NetworkName } from "./config.js";
import { NETWORKS } from "./config.js";

/**
 * The note file holds only what the chain cannot say: which network carries
 * the backing and which vaults it is in. Outstanding supply, par, the load
 * line and the holder are read from the chain at the moment of use and are
 * deliberately absent. If the holder could be configured, anyone could point
 * this service at a whale's position and call it backing.
 */
export interface Registry {
  readonly chain: string;
  readonly chainId: number;
  readonly rpc: string;
  readonly mirror?: string;
  readonly coverageOracle: string;
  readonly loadLine: string;
  readonly note: string;
}

export interface NoteEntry {
  readonly noteId: string;
  readonly market: string;
  readonly network: NetworkName;
  readonly chainId: number;
  readonly vaults: readonly string[];
  readonly negativeControl: boolean;
  readonly status: "placeholder" | "final";
  readonly registry: Registry | null;
}

export interface NotesFile {
  readonly path: string;
  readonly notes: ReadonlyMap<string, NoteEntry>;
}

const BYTES32 = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;

export class NotesFileError extends Error {}

export function parseNotes(raw: unknown, path = "<inline>"): NotesFile {
  const doc = raw as { notes?: Record<string, Record<string, unknown>> };
  if (!doc || typeof doc !== "object" || !doc.notes || typeof doc.notes !== "object") {
    throw new NotesFileError(`${path}: missing "notes" object`);
  }
  const notes = new Map<string, NoteEntry>();
  for (const [key, e] of Object.entries(doc.notes)) {
    const noteId = key.toLowerCase();
    if (!BYTES32.test(noteId)) throw new NotesFileError(`${path}: note key ${key} is not a bytes32 noteId`);
    const network = String(e.network) as NetworkName;
    if (!NETWORKS.includes(network)) throw new NotesFileError(`${path}: ${key} has unknown network ${String(e.network)}`);
    const vaults = (Array.isArray(e.vaults) ? e.vaults : []).map((v) => String(v).toLowerCase());
    for (const v of vaults) if (!ADDRESS.test(v)) throw new NotesFileError(`${path}: ${key} has a malformed vault ${v}`);
    if (new Set(vaults).size !== vaults.length) throw new NotesFileError(`${path}: ${key} lists a vault twice`);
    const reg = e.registry as Record<string, unknown> | null | undefined;
    notes.set(noteId, {
      noteId,
      market: String(e.market ?? ""),
      network,
      chainId: Number(e.chainId),
      vaults,
      negativeControl: e.negativeControl === true,
      status: e.status === "final" ? "final" : "placeholder",
      registry: reg
        ? {
            chain: String(reg.chain),
            chainId: Number(reg.chainId),
            rpc: String(reg.rpc),
            mirror: reg.mirror === undefined ? undefined : String(reg.mirror),
            coverageOracle: String(reg.coverageOracle).toLowerCase(),
            loadLine: String(reg.loadLine).toLowerCase(),
            note: String(reg.note).toLowerCase(),
          }
        : null,
    });
  }
  return { path, notes };
}

export function loadNotes(path: string): NotesFile {
  return parseNotes(JSON.parse(readFileSync(path, "utf8")), path);
}

/**
 * Each vault position may back at most one note. Two notes issued by the same
 * holder on the same network with overlapping vault sets would let one set of
 * shares be counted twice, so the overlap is returned for the caller to refuse.
 */
export function overlappingVaults(
  file: NotesFile,
  noteId: string,
  holderOf: (noteId: string) => string | undefined,
): { readonly otherNote: string; readonly vaults: string[] }[] {
  const me = file.notes.get(noteId);
  const myHolder = holderOf(noteId);
  if (!me || !myHolder) return [];
  const out: { otherNote: string; vaults: string[] }[] = [];
  for (const other of file.notes.values()) {
    if (other.noteId === noteId || other.network !== me.network) continue;
    if (holderOf(other.noteId) !== myHolder) continue;
    const shared = other.vaults.filter((v) => me.vaults.includes(v));
    if (shared.length) out.push({ otherNote: other.noteId, vaults: shared });
  }
  return out;
}

/**
 * map_positions params for one network: the manifest's own settings (the
 * cadence) followed by one `<noteId>=<holder>:<vault>,...` entry per note
 * whose holder has been read from chain and whose vault list is non-empty.
 */
/**
 * The manifest's map_positions settings with the cadence replaced by a runtime
 * value. The cadence is an ordinary module param, so a consumer can read more
 * often than the published package's default without a new package version;
 * only the map_positions module hash changes, as it already does for the
 * holder and vault list. A malformed value throws rather than falling back to
 * the default, because a silently wrong cadence is a silently wrong freshness.
 */
export function withEvery(manifestDefault: string, override: string | undefined): string {
  if (override === undefined || override.trim() === "") return manifestDefault;
  const every = Number(override.trim());
  if (!Number.isInteger(every) || every <= 0) {
    throw new Error(`positions cadence must be a positive integer, got ${JSON.stringify(override)}`);
  }
  const kept = manifestDefault
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part !== "" && !part.startsWith("every="));
  return [`every=${every}`, ...kept].join(";");
}

export function positionsParams(
  file: NotesFile,
  network: NetworkName,
  holders: ReadonlyMap<string, string>,
  manifestDefault: string,
): string {
  const entries: string[] = [];
  for (const n of file.notes.values()) {
    const holder = holders.get(n.noteId);
    if (n.network !== network || !holder || n.vaults.length === 0) continue;
    entries.push(`${n.noteId}=${holder}:${n.vaults.join(",")}`);
  }
  return [manifestDefault, ...entries].filter(Boolean).join(";");
}
