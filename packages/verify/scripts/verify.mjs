#!/usr/bin/env node
/**
 * The one command.
 *
 * A fresh clone has no dependencies installed and nothing built. Rather than
 * ask a judge to run four setup steps first, this builds what the verifier
 * needs from the repository itself on first run: its own dependencies, and the
 * attestor package whose verify-charge it reuses for the x402 claims. Later runs
 * skip straight to checking.
 *
 * Setup chatter goes to stderr so that stdout is the report and nothing else.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const VERIFY = join(dirname(fileURLToPath(import.meta.url)), "..");
const ATTESTOR = join(VERIFY, "..", "attestor");
const onWindows = process.platform === "win32";

function note(message) {
  process.stderr.write(`  · ${message}\n`);
}

function run(command, args, cwd) {
  // npm is npm.cmd on Windows, which only resolves through a shell.
  const result = spawnSync(command, args, { cwd, stdio: ["ignore", 2, 2], shell: onWindows });
  if (result.status !== 0) {
    process.stderr.write(`\n  setup failed: ${command} ${args.join(" ")} (in ${cwd})\n`);
    process.exit(2);
  }
}

function newestSource(paths) {
  let newest = 0;
  const visit = (path) => {
    if (!existsSync(path)) return;
    const stat = statSync(path);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path)) {
        if (entry === "node_modules" || entry === "dist" || entry === "data") continue;
        visit(join(path, entry));
      }
    } else if (stat.mtimeMs > newest) {
      newest = stat.mtimeMs;
    }
  };
  paths.forEach(visit);
  return newest;
}

function isStale(output, sources) {
  return !existsSync(output) || newestSource(sources) > statSync(output).mtimeMs;
}

function ensureDependencies(dir, label) {
  if (existsSync(join(dir, "node_modules"))) return;
  note(`installing ${label} dependencies (first run only)`);
  const lock = existsSync(join(dir, "package-lock.json"));
  run("npm", [lock ? "ci" : "install", "--no-audit", "--no-fund", "--loglevel=error"], dir);
}

ensureDependencies(ATTESTOR, "attestor");
if (isStale(join(ATTESTOR, "dist", "bin", "verify-charge.js"), [join(ATTESTOR, "src"), join(ATTESTOR, "bin")])) {
  note("building the attestor's verify-charge");
  run("npm", ["run", "build", "--silent"], ATTESTOR);
}

ensureDependencies(VERIFY, "verifier");
if (isStale(join(VERIFY, "dist", "src", "cli.js"), [join(VERIFY, "src"), join(VERIFY, "test"), join(VERIFY, "tsconfig.json")])) {
  note("building the verifier");
  run("npm", ["run", "build", "--silent"], VERIFY);
}

const args = process.argv.slice(2);
if (args.includes("--setup-only")) process.exit(0);

const result = spawnSync(process.execPath, [join(VERIFY, "dist", "src", "cli.js"), ...args], {
  stdio: "inherit",
});
process.exit(result.status ?? 2);
