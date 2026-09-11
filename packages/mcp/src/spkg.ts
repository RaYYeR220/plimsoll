import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { applyParams, createModuleHashHex, createRegistry, createSubstream } from "@substreams/core";
import type { Package } from "@substreams/core/proto";

export interface LoadedPackage {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly name: string;
  readonly version: string;
  readonly defaultNetwork: string;
  readonly networks: readonly string[];
}

export function loadPackage(path: string): LoadedPackage {
  const bytes = new Uint8Array(readFileSync(path));
  const pkg = createSubstream(bytes);
  const meta = pkg.packageMeta[0];
  return {
    path,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    name: meta?.name ?? "unknown",
    version: meta?.version ?? "unknown",
    defaultNetwork: pkg.network,
    networks: Object.keys(pkg.networks ?? {}),
  };
}

export interface ConfiguredPackage {
  readonly pkg: Package;
  readonly registry: ReturnType<typeof createRegistry>;
  readonly outputModule: string;
  readonly moduleHash: string;
}

/**
 * The CLI applies a manifest's `networks:` section through `--network`;
 * @substreams/core's createRequest does not. Without this step a Base stream
 * would run with mainnet's initial blocks and mainnet's pricing table, and
 * every USD field would be silently wrong. So the chosen network's
 * initialBlocks and params are written onto the modules here, before the
 * request is built and before the module hash is taken, and that hash is then
 * the one the provider actually executes.
 *
 * Each call re-parses the bytes, so no two configured copies share mutable
 * module objects.
 */
export async function configure(
  loaded: LoadedPackage,
  network: string,
  outputModule: string,
  extraParams: Readonly<Record<string, string>> = {},
): Promise<ConfiguredPackage> {
  const pkg = createSubstream(loaded.bytes);
  const overrides = pkg.networks?.[network];
  if (!overrides && network !== pkg.network) {
    throw new Error(
      `package ${loaded.name}@${loaded.version} has no settings for network "${network}" (has: ${[pkg.network, ...Object.keys(pkg.networks ?? {})].join(", ")})`,
    );
  }
  const modules = pkg.modules?.modules ?? [];
  if (overrides) {
    for (const m of modules) {
      const ib = overrides.initialBlocks[m.name];
      if (ib !== undefined) m.initialBlock = BigInt(ib);
    }
  }
  const params: Record<string, string> = { ...(overrides?.params ?? {}), ...extraParams };
  const present = new Set(modules.map((m) => m.name));
  const applicable = Object.entries(params).filter(([k]) => present.has(k));
  if (applicable.length) applyParams(applicable.map(([k, v]) => `${k}=${v}`), modules);
  if (!present.has(outputModule)) throw new Error(`module ${outputModule} not in package`);
  const moduleHash = await createModuleHashHex(pkg.modules!, outputModule);
  return { pkg, registry: createRegistry(pkg), outputModule, moduleHash };
}

/** The params string a network's manifest gives a module, so it can be extended rather than replaced. */
export function networkParam(loaded: LoadedPackage, network: string, module: string): string {
  const pkg = createSubstream(loaded.bytes);
  return pkg.networks?.[network]?.params[module] ?? "";
}
