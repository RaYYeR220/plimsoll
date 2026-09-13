import { rmSync } from "node:fs";
import { attest } from "../src/attest.js";
import { buildAnchorRecord, byteLength, HCS_MESSAGE_LIMIT } from "../src/anchor.js";
import { FixtureCoverageSource, UnknownNote } from "../src/coverage/index.js";
import { resolveOracle } from "../src/config.js";
import { createAttestorSigner } from "../src/eip712.js";
import { DEFAULT_POLICY } from "../src/policy.js";
import { ReceiptStore } from "../src/receipts.js";
import { checkReceipt } from "../src/verify.js";

/**
 * The whole product, with no credentials and no network.
 *
 * Every note below runs through the real decision engine, gets a real EIP-712
 * signature, produces a real anchor record measured against the real 1024-byte
 * consensus limit, and is verified by the same code a stranger would run. Only
 * the coverage data and the ledger are absent, which is the line MOCKS.md draws.
 */

// Throwaway signing key for the offline demo. It is deliberately checked in and
// deliberately worthless: it holds nothing and signs only fixture verdicts. The
// deployed service uses ATTESTOR_PRIVATE_KEY from the environment.
const DEMO_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;

const DEMO_DATA_DIR = "data/demo";
const DEMO_PAY_TO = "0.0.0";

async function main(): Promise<void> {
  rmSync(DEMO_DATA_DIR, { recursive: true, force: true });
  const source = new FixtureCoverageSource();
  // No network, but not an invented domain either: the oracle comes from the
  // deployment record, so these signatures are the shape the chain accepts.
  const oracle = resolveOracle({});
  const signer = createAttestorSigner(DEMO_KEY, {
    chainId: oracle.chainId,
    verifyingContract: oracle.address as `0x${string}`,
  });
  const receipts = new ReceiptStore(DEMO_DATA_DIR);

  console.log(`\nPlimsoll coverage attestor — offline demo`);
  console.log(`policy ${DEFAULT_POLICY.id}; each note is measured against its own load line`);
  console.log(`attestor ${signer.address}\n`);

  const header = ["note", "outcome", "family", "reason", "bps", "charge", "anchor"];
  const rows: string[][] = [];

  for (const noteId of [...source.knownNotes(), "NOTE-NOT-A-THING"]) {
    let verdict;
    try {
      verdict = await attest(noteId, { source, signer });
    } catch (error) {
      if (error instanceof UnknownNote) {
        rows.push([noteId, "404", "-", "unknown_note", "-", "no", "-"]);
        continue;
      }
      throw error;
    }

    // A charge is only ever recorded for an attestation. This is the same rule
    // the payment middleware enforces, restated here so the demo shows it.
    const charge = verdict.decision === "attested" ? { transactionId: "0.0.0@0.0" } : null;
    const record = buildAnchorRecord({
      requestId: noteId.toLowerCase().replace(/[^a-z0-9]/g, ""),
      verdict,
      charge,
      maxPositions: DEFAULT_POLICY.maxAnchoredPositions,
      payTo: DEMO_PAY_TO,
      oracle,
    });
    const size = byteLength(record);

    rows.push([
      noteId,
      verdict.decision === "attested" ? "ATTESTED" : `REFUSED ${verdict.httpStatus}`,
      verdict.decision === "refused" ? verdict.family : "-",
      verdict.decision === "refused" ? verdict.reason : "-",
      verdict.decision === "attested"
        ? String(verdict.coverageBps)
        : verdict.coverageKnown
          ? String(verdict.coverageBps)
          : "not computed",
      charge ? "yes" : "no",
      `${size}B ${size <= HCS_MESSAGE_LIMIT ? "ok" : "OVER"}${record.full === 0 ? " digest" : ""}`,
    ]);

    receipts.write({
      requestId: noteId.toLowerCase().replace(/[^a-z0-9]/g, ""),
      noteId: verdict.noteId,
      decision: verdict.decision,
      family: verdict.decision === "refused" ? verdict.family : null,
      reason: verdict.decision === "refused" ? verdict.reason : null,
      coverageBps: verdict.coverageBps,
      coverageKnown: verdict.decision === "attested" ? true : verdict.coverageKnown,
      message: JSON.parse(
        JSON.stringify(verdict.message, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
      ),
      signature: verdict.signature,
      attestor: verdict.attestor,
      feed: verdict.feed,
      sourceHash: verdict.sourceHash,
      evidence: verdict.evidence,
      chargeTransactionId: charge?.transactionId ?? null,
      payTo: DEMO_PAY_TO,
      amountTinybar: "100000",
      payer: null,
      requestedAt: Math.floor(Date.now() / 1000),
      respondedAt: Math.floor(Date.now() / 1000),
      httpStatus: verdict.httpStatus,
      anchor: null,
      anchorRecord: record,
    });
  }

  printTable(header, rows);

  console.log(`\nverifying every receipt with no keys and no network:`);
  let failures = 0;
  for (const receipt of receipts.list()) {
    const checks = await checkReceipt(receipt);
    const bad = checks.filter((c) => !c.passed);
    failures += bad.length;
    console.log(
      `  ${bad.length === 0 ? "ok  " : "FAIL"}  ${receipt.noteId.padEnd(14)} ${checks.length} checks` +
        (bad.length ? `  ${bad.map((c) => c.label).join(", ")}` : ""),
    );
  }

  console.log(
    `\n${failures === 0 ? "all receipts verify" : `${failures} check(s) failed`}. ` +
      `Receipts written to ${DEMO_DATA_DIR}/receipts.`,
  );
  console.log(
    `Try:  node dist/bin/verify-charge.js --request notealpha --data-dir ${DEMO_DATA_DIR} --explain\n`,
  );
  if (failures > 0) process.exit(1);
}

function printTable(header: string[], rows: string[][]): void {
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const line = (cells: string[]) =>
    "  " + cells.map((c, i) => (c ?? "").padEnd(widths[i] ?? 0)).join("  ");
  console.log(line(header));
  console.log("  " + widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of rows) console.log(line(row));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
