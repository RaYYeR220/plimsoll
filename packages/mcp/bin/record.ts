/**
 * Records real stream output once, so that the tests can replay it offline.
 *   node dist/bin/record.js <network> <blocks> <out.json> [vault,vault,...]
 * The first N blocks from head-<blocks> are kept, filtered to the listed
 * vaults to keep the fixture small. The file says where and when it was
 * recorded, which package bytes and which module hash produced it, and that
 * it is a recording.
 */
import { writeFileSync } from "node:fs";
import type { NetworkName } from "../src/config.js";
import { loadConfig, readToken } from "../src/config.js";
import { openStream } from "../src/feed.js";
import { configure, loadPackage } from "../src/spkg.js";
import type { BlockOutputJson, ObservedBlock } from "../src/types.js";

const [network, blocksArg, out, vaultsArg] = process.argv.slice(2) as [NetworkName, string, string, string | undefined];
const config = loadConfig();
const token = readToken();
if (!token) throw new Error("set SUBSTREAMS_API_TOKEN or SUBSTREAMS_ENV_FILE");
const loaded = loadPackage(config.packagePath);
const configured = await configure(loaded, network, config.outputModule);
const spec = config.networks[network];
const keep = vaultsArg ? new Set(vaultsArg.toLowerCase().split(",")) : null;
const blocks = Number(blocksArg);

const recorded: { block: { number: string; hash: string; timestamp: number }; finalBlockHeight: string; output?: BlockOutputJson }[] = [];
let last: ObservedBlock | null = null;
let finalHeight = 0n;
const ctl = new AbortController();
let seen = 0;
await openStream({
  spec,
  configured,
  token,
  finalBlocksOnly: spec.finalBlocksOnly,
  startBlock: -BigInt(blocks),
  signal: ctl.signal,
  onBlock: (block, fh, _cursor, output) => {
    last = block;
    finalHeight = fh;
    const vaults = output?.vaults?.filter((v) => !keep || keep.has(v.vault.toLowerCase()));
    if (vaults?.length || output?.positionsRead) {
      recorded.push({
        block: { number: block.number.toString(), hash: block.hash, timestamp: block.timestamp },
        finalBlockHeight: fh.toString(),
        output: { ...output, vaults: vaults ?? [] },
      });
    }
    if (++seen >= blocks) ctl.abort();
  },
}).catch((e) => {
  if (!ctl.signal.aborted) throw e;
});

const lastBlock = last as ObservedBlock | null;
writeFileSync(
  out,
  JSON.stringify(
    {
      about: "RECORDED real output of a live Graph Market Substreams stream, replayed offline by the tests. Not synthetic.",
      recordedAt: new Date().toISOString(),
      network,
      endpoint: spec.endpoint,
      finalBlocksOnly: spec.finalBlocksOnly,
      package: { name: loaded.name, version: loaded.version, sha256: loaded.sha256 },
      module: { name: configured.outputModule, hash: configured.moduleHash },
      filter: keep ? [...keep] : "all vaults",
      head: lastBlock ? { number: lastBlock.number.toString(), hash: lastBlock.hash, timestamp: lastBlock.timestamp, finalBlockHeight: finalHeight.toString() } : null,
      blocks: recorded,
    },
    null,
    1,
  ),
);
console.log(`recorded ${recorded.length} blocks with data out of ${seen} streamed -> ${out}`);
