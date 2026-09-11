import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { verifyCharge, type Args } from "../bin/verify-charge.js";
import { buildAnchorRecord, type AnchorRecord } from "../src/anchor.js";
import { attest } from "../src/attest.js";
import { FixtureCoverageSource } from "../src/coverage/index.js";
import { attestationToWire, createAttestorSigner, refusalToWire } from "../src/eip712.js";
import { ReceiptStore, type StoredReceipt } from "../src/receipts.js";
import {
  TEST_ATTESTOR_KEY,
  TEST_PAY_TO,
  startStubMirror,
  stubMirrorTransaction,
  type StubMirror,
} from "./helpers.js";

const signer = createAttestorSigner(TEST_ATTESTOR_KEY);
const source = new FixtureCoverageSource();
const DATA_DIR = `data/test/${randomBytes(4).toString("hex")}`;
const PAYER = "0.0.999002";
const SETTLEMENT_TX = "0.0.7162784@1788800815.386309402";

let mirror: StubMirror;
let receipts: ReceiptStore;

before(async () => {
  mirror = await startStubMirror();
  receipts = new ReceiptStore(DATA_DIR);
});

after(async () => {
  await mirror.close();
  rmSync(DATA_DIR, { recursive: true, force: true });
});

function args(overrides: Partial<Args>): Args {
  return { dataDir: DATA_DIR, json: true, explain: false, mirrorUrl: mirror.url, ...overrides };
}

/** Write a receipt and its anchored record, exactly as the server would. */
async function record(
  requestId: string,
  noteId: string,
  charged: boolean,
): Promise<{ receipt: StoredReceipt; anchor: AnchorRecord }> {
  const verdict = await attest(noteId, { source, signer });
  const charge = charged ? { transactionId: SETTLEMENT_TX } : null;
  const anchor = buildAnchorRecord({ requestId, verdict, charge });
  const receipt: StoredReceipt = {
    requestId,
    noteId: verdict.noteId,
    decision: verdict.decision,
    family: verdict.decision === "refused" ? verdict.family : null,
    reason: verdict.decision === "refused" ? verdict.reason : null,
    coverageBps: verdict.coverageBps,
    coverageKnown: verdict.decision === "attested" ? true : verdict.coverageKnown,
    message:
      verdict.decision === "attested"
        ? attestationToWire(verdict.message)
        : refusalToWire(verdict.message),
    signature: verdict.signature,
    attestor: verdict.attestor,
    sourceHash: verdict.sourceHash,
    evidence: verdict.evidence,
    chargeTransactionId: charge?.transactionId ?? null,
    payTo: TEST_PAY_TO,
    amountTinybar: "100000",
    payer: PAYER,
    requestedAt: 1788800800,
    respondedAt: 1788800801,
    httpStatus: verdict.httpStatus,
    anchor: { topicId: "0.0.10451091", sequenceNumber: 1, transactionId: SETTLEMENT_TX },
    anchorRecord: anchor,
  };
  receipts.write(receipt);
  return { receipt, anchor };
}

function publishToTopic(sequence: number, anchor: AnchorRecord): void {
  mirror.topicMessages.set(`0.0.10451091:${sequence}`, {
    sequence_number: sequence,
    consensus_timestamp: "1788800817.123456789",
    topic_id: "0.0.10451091",
    message: Buffer.from(JSON.stringify(anchor), "utf8").toString("base64"),
    chunk_info: null,
  });
}

describe("verdict: CHARGED AND WARRANTED", () => {
  it("confirms a charge the evidence supports", async () => {
    const { anchor } = await record("aaaa000000000001", "NOTE-ALPHA", true);
    publishToTopic(1, anchor);
    mirror.transactions.set(
      "0.0.7162784-1788800815-386309402",
      stubMirrorTransaction({
        transactionId: SETTLEMENT_TX,
        payer: PAYER,
        payTo: TEST_PAY_TO,
        amount: 100000,
      }),
    );

    const result = await verifyCharge(args({ hcs: { topicId: "0.0.10451091", sequenceNumber: 1 } }));
    assert.equal(result.verdict, "CHARGED AND WARRANTED");
    assert.equal(result.charged, true);
    assert.equal(result.recomputedBps, 13000, "recomputed independently from the raw readings");
    assert.equal(result.anchoredBps, 13000);
    assert.ok(result.floorBps !== null, "an attestation always publishes the floor it cleared");
    assert.ok(result.recomputedBps! >= result.floorBps);
    assert.ok(result.checks.every((c) => c.passed), JSON.stringify(result.checks.filter((c) => !c.passed)));
    assert.match(result.links.settlement ?? "", /hashscan.io/);
  });
});

describe("verdict: REFUSED AND NOT CHARGED", () => {
  it("confirms an asset refusal moved no money", async () => {
    const { anchor } = await record("aaaa000000000002", "NOTE-BRAVO", false);
    publishToTopic(2, anchor);

    const result = await verifyCharge(args({ hcs: { topicId: "0.0.10451091", sequenceNumber: 2 } }));
    assert.equal(result.verdict, "REFUSED AND NOT CHARGED");
    assert.equal(result.charged, false);
    assert.equal(result.family, "asset");
    assert.equal(result.reason, "coverage_below_floor");
    assert.equal(result.recomputedBps, 8700);
    assert.equal(result.settlementTxId, null);
    assert.ok(result.checks.every((c) => c.passed));

    const absence = result.checks.find((c) => c.id === "no-settlement")!;
    assert.equal(absence.passed, true);
    assert.match(absence.detail, /never submitted|absent|credit/);
  });

  it("confirms an evidence refusal without inventing a ratio to check", async () => {
    const { anchor } = await record("aaaa000000000003", "NOTE-INDIA", false);
    publishToTopic(3, anchor);

    const result = await verifyCharge(args({ hcs: { topicId: "0.0.10451091", sequenceNumber: 3 } }));
    assert.equal(result.verdict, "REFUSED AND NOT CHARGED");
    assert.equal(result.family, "evidence");
    const recompute = result.checks.find((c) => c.id === "recompute")!;
    assert.equal(recompute.passed, true);
    assert.match(recompute.detail, /no ratio was established/);
  });

  it("works from a local receipt with no anchored record at all", async () => {
    await record("aaaa000000000004", "NOTE-GOLF", false);
    const result = await verifyCharge(args({ requestId: "aaaa000000000004" }));
    assert.equal(result.verdict, "REFUSED AND NOT CHARGED");
  });

  it("does not blame a refusal for another request's legitimate charge", async () => {
    // A seller with real traffic: a paid call lands inside the same window as
    // an unrelated refusal. The refusal must not be convicted for it.
    const paid = await record("aaaa000000000005", "NOTE-ALPHA", true);
    publishToTopic(5, paid.anchor);
    mirror.transactions.set(
      "0.0.7162784-1788800815-386309402",
      stubMirrorTransaction({
        transactionId: SETTLEMENT_TX,
        payer: PAYER,
        payTo: TEST_PAY_TO,
        amount: 100000,
      }),
    );
    mirror.accountTransfers.length = 0;
    mirror.accountTransfers.push(
      stubMirrorTransaction({
        transactionId: SETTLEMENT_TX,
        payer: PAYER,
        payTo: TEST_PAY_TO,
        amount: 100000,
      }),
    );

    const { anchor } = await record("aaaa000000000006", "NOTE-BRAVO", false);
    publishToTopic(6, anchor);

    const result = await verifyCharge(args({ hcs: { topicId: "0.0.10451091", sequenceNumber: 6 } }));
    assert.equal(result.verdict, "REFUSED AND NOT CHARGED");
    const absence = result.checks.find((c) => c.id === "no-settlement")!;
    assert.equal(absence.passed, true);
    assert.match(absence.detail, /all of them claimed by anchored attestations/);
  });

  it("convicts when a credit exists that no anchored attestation claims", async () => {
    const { anchor } = await record("aaaa000000000007", "NOTE-BRAVO", false);
    publishToTopic(7, anchor);
    mirror.accountTransfers.length = 0;
    mirror.accountTransfers.push(
      stubMirrorTransaction({
        transactionId: "0.0.7162784@1788800900.000000001",
        payer: PAYER,
        payTo: TEST_PAY_TO,
        amount: 100000,
      }),
    );

    const result = await verifyCharge(args({ hcs: { topicId: "0.0.10451091", sequenceNumber: 7 } }));
    assert.equal(result.verdict, "DISCREPANCY");
    const absence = result.checks.find((c) => c.id === "no-settlement")!;
    assert.equal(absence.passed, false);
    assert.match(absence.detail, /no anchored attestation claims/);
  });
});

describe("verdict: DISCREPANCY", () => {
  it("catches a charge for a note that does not clear the floor", async () => {
    // The planted fault: a note that is 8700 bps was charged for anyway.
    const { receipt, anchor } = await record("bbbb000000000001", "NOTE-BRAVO", false);
    anchor.chg = true;
    anchor.tx = SETTLEMENT_TX;
    publishToTopic(11, anchor);
    mirror.transactions.set(
      "0.0.7162784-1788800815-386309402",
      stubMirrorTransaction({
        transactionId: SETTLEMENT_TX,
        payer: PAYER,
        payTo: TEST_PAY_TO,
        amount: 100000,
      }),
    );

    const result = await verifyCharge(args({ hcs: { topicId: "0.0.10451091", sequenceNumber: 11 } }));
    assert.equal(result.verdict, "DISCREPANCY");
    const biconditional = result.checks.find((c) => c.id === "biconditional")!;
    assert.equal(biconditional.passed, false);
    assert.equal(receipt.chargeTransactionId, null, "the receipt still says what really happened");
  });

  it("catches an anchored ratio that the raw readings do not produce", async () => {
    const { anchor } = await record("bbbb000000000002", "NOTE-ALPHA", true);
    anchor.bps = 19999;
    publishToTopic(12, anchor);

    const result = await verifyCharge(args({ hcs: { topicId: "0.0.10451091", sequenceNumber: 12 } }));
    assert.equal(result.verdict, "DISCREPANCY");
    const recompute = result.checks.find((c) => c.id === "recompute")!;
    assert.equal(recompute.passed, false);
    assert.match(recompute.detail, /19999 bps but the readings give 13000/);
  });

  it("catches a claimed charge with no transaction on the mirror node", async () => {
    const { anchor } = await record("bbbb000000000003", "NOTE-ALPHA", true);
    anchor.tx = "0.0.7162784@1700000000.000000001";
    publishToTopic(13, anchor);

    const result = await verifyCharge(args({ hcs: { topicId: "0.0.10451091", sequenceNumber: 13 } }));
    assert.equal(result.verdict, "DISCREPANCY");
    const settlement = result.checks.find((c) => c.id === "settlement")!;
    assert.equal(settlement.passed, false);
    assert.match(settlement.detail, /not on the mirror node/);
  });

  it("catches a refusal that nonetheless moved money", async () => {
    const { anchor } = await record("bbbb000000000004", "NOTE-BRAVO", false);
    // Claims no charge, but names a transaction that does exist.
    anchor.tx = SETTLEMENT_TX;
    publishToTopic(14, anchor);
    mirror.transactions.set(
      "0.0.7162784-1788800815-386309402",
      stubMirrorTransaction({
        transactionId: SETTLEMENT_TX,
        payer: PAYER,
        payTo: TEST_PAY_TO,
        amount: 100000,
      }),
    );

    const result = await verifyCharge(args({ hcs: { topicId: "0.0.10451091", sequenceNumber: 14 } }));
    assert.equal(result.verdict, "DISCREPANCY");
    const absence = result.checks.find((c) => c.id === "no-settlement")!;
    assert.equal(absence.passed, false);
    assert.match(absence.detail, /EXISTS on the mirror node/);
  });

  it("catches an anchored record that disagrees with its receipt", async () => {
    const { anchor } = await record("bbbb000000000005", "NOTE-ALPHA", true);
    anchor.att = "0x000000000000000000000000000000000000dead";
    publishToTopic(15, anchor);
    mirror.transactions.set(
      "0.0.7162784-1788800815-386309402",
      stubMirrorTransaction({
        transactionId: SETTLEMENT_TX,
        payer: PAYER,
        payTo: TEST_PAY_TO,
        amount: 100000,
      }),
    );

    const result = await verifyCharge(args({ hcs: { topicId: "0.0.10451091", sequenceNumber: 15 } }));
    assert.equal(result.verdict, "DISCREPANCY");
    assert.equal(result.checks.find((c) => c.id === "anchor-binding")!.passed, false);
  });

  it("catches the wrong amount being credited", async () => {
    const { anchor } = await record("bbbb000000000006", "NOTE-JULIET", true);
    publishToTopic(16, anchor);
    mirror.transactions.set(
      "0.0.7162784-1788800815-386309402",
      stubMirrorTransaction({
        transactionId: SETTLEMENT_TX,
        payer: PAYER,
        payTo: TEST_PAY_TO,
        amount: 250000,
      }),
    );

    const result = await verifyCharge(args({ hcs: { topicId: "0.0.10451091", sequenceNumber: 16 } }));
    assert.equal(result.verdict, "DISCREPANCY");
    const amount = result.checks.find((c) => c.id === "amount")!;
    assert.equal(amount.passed, false);
    assert.match(amount.detail, /250000 tinybar, advertised 100000/);
  });
});

describe("the verifier needs no credentials", () => {
  it("verifies a figureless evidence refusal from the anchored record alone", async () => {
    // The stranger's path: no receipt, only the public record. An evidence
    // refusal carries no floor and no ratio, and this once crashed on a null
    // receipt because it assumed one of the two sources would supply a floor.
    const verdict = await attest("NOTE-INDIA", { source, signer });
    const anchor = buildAnchorRecord({ requestId: "cccc000000000001", verdict, charge: null });
    assert.equal("floor" in anchor, false);
    publishToTopic(21, anchor);

    const result = await verifyCharge(args({ hcs: { topicId: "0.0.10451091", sequenceNumber: 21 } }));
    assert.equal(result.verdict, "REFUSED AND NOT CHARGED");
    assert.equal(result.floorBps, null, "no floor is reported where none was published");
    assert.equal(result.anchoredBps, null);
    assert.ok(result.checks.every((c) => c.passed), JSON.stringify(result.checks.filter((c) => !c.passed)));
  });

  it("convicts a v1-labelled record in the v2 encoding from the record alone", async () => {
    const verdict = await attest("NOTE-INDIA", { source, signer });
    const anchor = { ...buildAnchorRecord({ requestId: "cccc000000000002", verdict, charge: null }), v: 1 };
    publishToTopic(22, anchor as AnchorRecord);

    const result = await verifyCharge(args({ hcs: { topicId: "0.0.10451091", sequenceNumber: 22 } }));
    assert.equal(result.verdict, "DISCREPANCY");
    const encoding = result.checks.find((c) => c.id === "encoding-v1")!;
    assert.equal(encoding.passed, false);
    assert.match(encoding.detail, /v2 encoding under a v1 label/);
  });

  it("refuses to guess when there is nothing to check", async () => {
    await assert.rejects(
      () => verifyCharge(args({ requestId: "ffffffffffffffff" })),
      /no anchored record and no receipt/,
    );
  });
});
