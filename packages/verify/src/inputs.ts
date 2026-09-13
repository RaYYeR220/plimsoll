import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Everything the verifier believes before it asks the network anything.
 *
 * Addresses and ids come only from the deployment record, which is the single
 * source of truth and is being rewritten by redeploys; nothing here copies an
 * address out of it. The package's own manifest holds only what the record does
 * not: the event window, the canonical HCS sequence numbers and the payment
 * they cite, and where the two external claims live.
 */

export interface ContractEntry {
  address: string;
  hederaId: string;
  deployTx?: string;
  sourcify?: string;
  hashscan?: string;
}

export interface CashLeg {
  evmAddress: string;
  hederaId: string;
  freezeKeyHolder?: string;
  treasury?: string;
}

export interface LifecycleStep {
  step: string;
  tx: string;
  result?: string;
}

/** One replaced stack, kept in the record as history. */
export interface SupersededGeneration {
  reason?: string;
  contracts?: Record<string, ContractEntry>;
  cash_leg?: CashLeg;
}

export interface DeploymentRecord {
  network: { name?: string; chainId: number; mirror: string; explorer: string };
  deployedAt?: string;
  deployer: string;
  roles: { owner?: string; mandateAuthoritySigner?: string; attestor?: string };
  contracts: Record<string, ContractEntry>;
  ats?: {
    businessLogicResolver?: string;
    factory?: string;
    issuedNote?: {
      name?: string;
      symbol: string;
      decimals: number;
      address: string;
      hederaId: string;
      deployBondTx?: string;
    };
    lifecycle?: LifecycleStep[];
  };
  denial_artifact?: {
    blockedCounterparty: string;
    tx: string;
    status?: string;
    revertData?: string;
  };
  cash_leg?: CashLeg;
  device_proof?: string;
  superseded?: SupersededGeneration | SupersededGeneration[];
}

export interface ManifestRecord {
  sequence: number;
  expect: "attested" | "asset-refusal" | "evidence-refusal";
  noteId?: string;
  reason?: string;
  payment?: string;
  /**
   * Anchor format this record is expected to declare. Defaults to the current
   * one. Older records stay on the topic forever and are held to the format
   * they were written in, so the expectation has to be per record.
   */
  format?: number;
}

export interface Manifest {
  eventWindow: { start: string; label?: string };
  hcs: {
    topicId: string;
    records: ManifestRecord[];
    refusalWindowSeconds?: { before: number; after: number };
  };
  github?: { repository: string; pullRequest: number };
  substreams?: {
    manifest: string;
    /**
     * The release we claim is on the registry, and what it must contain. It is
     * fetched from the registry by name and its contents read from the package
     * itself, the way a stranger would, never from the local `substreams.yaml`.
     */
    published?: {
      name: string;
      version: string;
      /** Module count, imported modules included. */
      modules?: number;
      /** Modules the release must carry. */
      requires?: string[];
    };
  };
}

export interface DeviceStep {
  label: string;
  action?: string;
  mandateText?: string;
  decision?: string;
  signature?: string | null;
  nonce?: number;
  loadLineBps?: number;
  coverageBps?: number;
  /** `Contract.method`, naming which deployed contract the transaction targets. */
  call?: string;
  tx?: string;
  mirror?: string;
  revertData?: string | null;
  /** Error name the proof expects, when it records one. */
  error?: string;
}

export interface DeviceProof {
  device: { address: string };
  verifier: string;
  loadLine: string;
  steps: DeviceStep[];
}

export interface Inputs {
  repoRoot: string;
  record: DeploymentRecord;
  recordPath: string;
  manifest: Manifest;
  manifestPath: string;
  deviceProof: DeviceProof | null;
  deviceProofPath: string | null;
  /** Solidity sources the custom-error ABI is read from. */
  contractsSource: string;
  substreams: { name: string; version: string; manifestPath: string } | null;
  /** The substreams.yaml the manifest names, whether or not this checkout has it. */
  substreamsManifest: string | null;
  /** Unix seconds at which the event window opened. */
  windowStart: number;
}

/** `dist/src/inputs.js` → the package root, two levels up. */
export const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const REPO_ROOT = resolve(PACKAGE_ROOT, "..", "..");
export const DEFAULT_RECORD = join(REPO_ROOT, "packages", "contracts", "deployments", "hedera-testnet.json");
export const DEFAULT_MANIFEST = join(PACKAGE_ROOT, "manifest.json");

/**
 * Replaced stacks, oldest first. The record began with a single `superseded`
 * object and became a list when the stack was replaced a second time. Both
 * shapes are history, and both are read the same way.
 */
export function supersededGenerations(record: DeploymentRecord): SupersededGeneration[] {
  const superseded = record.superseded;
  return Array.isArray(superseded) ? superseded : superseded ? [superseded] : [];
}

export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

function readJson<T>(path: string, what: string): T {
  if (!existsSync(path)) throw new InputError(`${what} not found at ${path}`);
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    throw new InputError(`${what} at ${path} is not valid JSON: ${(error as Error).message}`);
  }
}

/**
 * Reads the `package:` block of a substreams.yaml without a YAML dependency.
 * Only two scalar keys are needed, and pulling in a parser for them would be
 * more code than this.
 */
export function parseSubstreamsPackage(text: string): { name: string; version: string } | null {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^package:\s*$/.test(line));
  if (start < 0) return null;
  let name: string | null = null;
  let version: string | null = null;
  for (const line of lines.slice(start + 1)) {
    if (!/^\s+/.test(line) && line.trim() !== "") break;
    const match = line.match(/^\s+(name|version):\s*["']?([^"'\s#]+)/);
    if (match?.[1] === "name") name = match[2]!;
    if (match?.[1] === "version") version = match[2]!;
  }
  return name && version ? { name, version } : null;
}

export function loadInputs(
  options: { recordPath?: string; manifestPath?: string; contractsSource?: string } = {},
): Inputs {
  const recordPath = resolve(options.recordPath ?? DEFAULT_RECORD);
  const manifestPath = resolve(options.manifestPath ?? DEFAULT_MANIFEST);
  const record = readJson<DeploymentRecord>(recordPath, "deployment record");
  const manifest = readJson<Manifest>(manifestPath, "verifier manifest");

  if (!record.network?.mirror || !record.contracts) {
    throw new InputError(`${recordPath} has no network.mirror or contracts section`);
  }
  const windowStart = Date.parse(manifest.eventWindow?.start ?? "");
  if (Number.isNaN(windowStart)) throw new InputError(`manifest eventWindow.start is not a date`);

  // The record names its device proof relative to the contracts package, one
  // level above the deployments directory it lives in.
  let deviceProof: DeviceProof | null = null;
  let deviceProofPath: string | null = null;
  if (record.device_proof) {
    deviceProofPath = join(dirname(dirname(recordPath)), record.device_proof);
    deviceProof = existsSync(deviceProofPath) ? readJson<DeviceProof>(deviceProofPath, "device proof") : null;
  }

  let substreams: Inputs["substreams"] = null;
  let substreamsManifest: string | null = null;
  if (manifest.substreams?.manifest) {
    const path = resolve(dirname(manifestPath), manifest.substreams.manifest);
    substreamsManifest = path;
    const parsed = existsSync(path) ? parseSubstreamsPackage(readFileSync(path, "utf8")) : null;
    if (parsed) substreams = { ...parsed, manifestPath: path };
  }

  return {
    repoRoot: REPO_ROOT,
    record,
    recordPath,
    manifest,
    manifestPath,
    deviceProof,
    deviceProofPath,
    contractsSource: resolve(options.contractsSource ?? join(dirname(dirname(recordPath)), "src")),
    substreams,
    substreamsManifest,
    windowStart: Math.floor(windowStart / 1000),
  };
}
