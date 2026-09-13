#!/usr/bin/env node
/**
 * The vault-set hash has one definition, in the attestor, and this package
 * imports it rather than keeping a second copy. That makes the attestor's
 * compiled `canonical.js` a build input here, and a fresh clone has no `dist`
 * anywhere, so this builds it if it is missing.
 *
 * It never silently continues: if the file is still absent afterwards, the
 * build stops and says what to run, because the alternative is compiling
 * against a stale copy of a hash everything else is checked against.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const attestor = join(here, "..", "..", "attestor");
const canonical = join(attestor, "dist", "src", "canonical.js");

if (!existsSync(canonical)) {
  // One fixed command string through the shell: npm is a .cmd shim on Windows,
  // which cannot be spawned directly, and nothing here is user input.
  const run = (command) => spawnSync(command, { cwd: attestor, stdio: "inherit", shell: true });

  if (!existsSync(join(attestor, "node_modules"))) {
    console.log("[backing] installing @plimsoll/attestor's dependencies, to build the hash it defines");
    run("npm install --no-audit --no-fund");
  }
  console.log("[backing] building @plimsoll/attestor for its canonical hash");
  run("npm run build");
}

if (!existsSync(canonical)) {
  console.error(
    [
      "",
      "[backing] cannot build: @plimsoll/attestor has not produced dist/src/canonical.js.",
      "",
      "This package imports canonicalHash from the attestor so the vault-set hash has",
      "exactly one definition. Build the attestor first:",
      "",
      "    cd ../attestor && npm install && npm run build",
      "",
    ].join("\n"),
  );
  process.exit(1);
}
