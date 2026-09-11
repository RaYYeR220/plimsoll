import { performance } from "node:perf_hooks";
import { loadVerifyCharge, type VerifyChargeFn } from "./attestor.js";
import type { Context } from "./context.js";
import { PUBLIC_INTERVALS_MS, createThrottledFetch, publicEndpoints, releaseHttpPool } from "./http.js";
import { loadInputs } from "./inputs.js";
import { HttpMirror } from "./mirror.js";
import { renderHeader, renderSection, renderSummary, type RenderOptions } from "./report.js";
import { type SectionResult, describe, tally } from "./result.js";
import { SECTIONS, runSections } from "./run.js";

const USAGE = `plimsoll-verify — check every Plimsoll claim against public endpoints only

  npm run verify                  run every check
  npm run verify -- --links       also print a public link for each line
  npm run verify -- --only 1,5,8  run some sections
  npm run verify -- --json        machine-readable output

  --record <path>     deployment record (default: packages/contracts/deployments/hedera-testnet.json)
  --manifest <path>   verifier manifest (default: packages/verify/manifest.json)
  --ascii             plain markers, for terminals without Unicode
  --no-color          no ANSI colour

  Exit 0 when nothing failed, 1 when any check failed, 2 when the inputs could not be read.
  Needs no keys, no wallet and no account.`;

interface Options {
  recordPath?: string;
  manifestPath?: string;
  json: boolean;
  links: boolean;
  ascii: boolean;
  color: boolean;
  only: number[] | null;
}

function parse(argv: string[]): Options {
  const options: Options = {
    json: false,
    links: false,
    ascii: false,
    color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
    only: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} needs a value`);
      return value;
    };
    if (arg === "--record") options.recordPath = next();
    else if (arg === "--manifest") options.manifestPath = next();
    else if (arg === "--json") options.json = true;
    else if (arg === "--links") options.links = true;
    else if (arg === "--ascii") options.ascii = true;
    else if (arg === "--no-color") options.color = false;
    else if (arg === "--only") options.only = next().split(",").map(Number);
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    } else throw new Error(`unknown argument ${arg}`);
  }
  return options;
}

async function main(): Promise<void> {
  const started = performance.now();
  let options: Options;
  let inputs;
  try {
    options = parse(process.argv.slice(2));
    inputs = loadInputs({ recordPath: options.recordPath, manifestPath: options.manifestPath });
  } catch (error) {
    process.stderr.write(`plimsoll-verify: ${describe(error)}\n\n${USAGE}\n`);
    process.exitCode = 2;
    return;
  }

  // Replacing the global fetch puts the attestor's verify-charge behind the
  // same per-host limits as everything else.
  const http = createThrottledFetch({ intervalsMs: PUBLIC_INTERVALS_MS });
  globalThis.fetch = http;
  const endpoints = publicEndpoints(inputs.record.network.mirror);

  let verifyCharge: VerifyChargeFn | null = null;
  let verifyChargeError: string | undefined;
  try {
    verifyCharge = await loadVerifyCharge();
  } catch (error) {
    verifyChargeError = describe(error);
  }

  const ctx: Context = {
    inputs,
    record: inputs.record,
    manifest: inputs.manifest,
    mirror: new HttpMirror(endpoints.mirror, http),
    http,
    endpoints,
    verifyCharge,
    verifyChargeError,
    windowStart: inputs.windowStart,
    explorer: inputs.record.network.explorer.replace(/\/+$/, ""),
  };

  const render: RenderOptions = {
    color: options.color && !options.json,
    ascii: options.ascii,
    links: options.links,
    width: Math.max(80, Math.min(process.stdout.columns || 120, 140)),
  };
  const sections = options.only ? SECTIONS.filter((s) => options.only!.includes(s.number)) : SECTIONS;
  const done: SectionResult[] = [];

  if (!options.json) process.stdout.write(`${renderHeader(inputs, render)}\n`);
  for await (const section of runSections(ctx, sections)) {
    done.push(section);
    if (!options.json) process.stdout.write(`${renderSection(section, render)}\n`);
  }

  const elapsedMs = performance.now() - started;
  const summary = tally(done);
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({ record: inputs.recordPath, elapsedMs: Math.round(elapsedMs), requests: http.requests(), summary, sections: done }, null, 2)}\n`,
    );
  } else {
    process.stdout.write(`${renderSummary(done, elapsedMs, http.requests(), render)}\n`);
  }

  // exitCode rather than exit(): exiting while pooled sockets close trips a
  // libuv assertion on Windows and reports a crash instead of the verdict.
  process.exitCode = summary.failed > 0 ? 1 : 0;
  await releaseHttpPool();
}

main().catch((error) => {
  process.stderr.write(`plimsoll-verify: ${describe(error)}\n`);
  process.exitCode = 2;
});
