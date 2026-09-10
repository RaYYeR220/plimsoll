/**
 * The two-run walkthrough: the same binary, the same command, opposite outcomes, and the only
 * variable is which button a human pressed.
 *
 *   node dist/demo/run.js            both runs, refusal first
 *   node dist/demo/run.js refuse     just the refusal
 *   node dist/demo/run.js approve    just the approval
 *
 * Screenshots land in demo/screens/ for the recorded version.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { DeviceAuthority, type SignResult } from "../src/device";
import { formatMandate, hashMandate, type Mandate } from "../src/mandate";
import { SpeculosScreen } from "../src/screen";
import { ensureIdle } from "../test/harness";

const VERIFIER = "0x71c7656ec7ab88b098defb751b7401b5f6d8976f" as const;
const HEDERA_TESTNET = 296;
const SCREENS = join(__dirname, "..", "..", "demo", "screens");

function inOneHour(): bigint {
  return BigInt(Math.floor(Date.now() / 1000) + 3_600);
}

/**
 * Coverage has fallen through the line. The agent proposes lowering the line rather than halting
 * the market -- exactly the kind of "keep trading" decision that should never be automatic.
 */
const LOWER_THE_LINE: Mandate = {
  action: "SET-THRESHOLD",
  market: "SEA-2026-A",
  coverageBps: 9_860,
  loadLineBps: 9_500,
  nonce: 101n,
  expiry: inOneHour(),
  chainId: HEDERA_TESTNET,
  verifyingContract: VERIFIER,
};

/** Coverage genuinely recovered above the line. Restarting the market is defensible. */
const RESTART_THE_MARKET: Mandate = {
  action: "RESUME",
  market: "SEA-2026-A",
  coverageBps: 10_340,
  loadLineBps: 10_200,
  nonce: 102n,
  expiry: inOneHour(),
  chainId: HEDERA_TESTNET,
  verifyingContract: VERIFIER,
};

function banner(title: string): void {
  process.stdout.write(`\n${"=".repeat(72)}\n${title}\n${"=".repeat(72)}\n`);
}

function report(result: SignResult): void {
  if (result.ok) {
    process.stdout.write(`  outcome    : APPROVED on device\n`);
    process.stdout.write(`  signature  : ${result.attestation.signature}\n`);
    process.stdout.write(`  recovers to: ${result.attestation.authority}\n`);
    return;
  }
  process.stdout.write(`  outcome    : NO SIGNATURE (${result.reason})\n`);
  process.stdout.write(`  detail     : ${result.detail}\n`);
  process.stdout.write(`  signature  : none exists\n`);
}

async function runCase(
  title: string,
  mandate: Mandate,
  decision: "approve" | "reject",
): Promise<void> {
  banner(title);
  const screen = new SpeculosScreen();
  await ensureIdle(screen);

  process.stdout.write(`${formatMandate(mandate)}\n\n  digest     : ${hashMandate(mandate)}\n`);

  const device = DeviceAuthority.fromEnv();
  try {
    const pending = device.signMandate(mandate);
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    await mkdir(SCREENS, { recursive: true });
    await screen.saveScreenshot(join(SCREENS, `${decision}-review.png`));

    const walk = decision === "approve" ? await screen.approve() : await screen.reject();
    process.stdout.write(`  screens    : ${walk.transcript.join(" >> ")}\n`);

    report(await pending);
  } finally {
    await device.close();
    await ensureIdle(screen).catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const only = process.argv[2];
  if (only !== "approve") {
    await runCase("CASE A -- the human refuses to lower the load line", LOWER_THE_LINE, "reject");
  }
  if (only !== "refuse") {
    await runCase("CASE B -- the human approves restarting the market", RESTART_THE_MARKET, "approve");
  }
  process.stdout.write("\n");
}

main().catch((error) => {
  process.exitCode = 1;
  process.stderr.write(`${(error as Error).message}\n`);
});
