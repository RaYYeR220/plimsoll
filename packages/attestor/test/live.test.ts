import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { verifyCharge } from "../bin/verify-charge.js";
import { HcsAnchor, HCS_MESSAGE_LIMIT } from "../src/anchor.js";
import { requestAttestation } from "../src/buyer.js";
import { hasAnchorCredentials, hasLiveCredentials, loadBuyerConfig } from "../src/config.js";
import { MirrorClient, netForAccount, toMirrorTxId } from "../src/mirror.js";
import { createService, type AttestorService } from "../src/server.js";
import type { AttestationRefusal, AttestationSuccess } from "../src/buyer.js";
import { sellerConfig, skipMessage } from "./helpers.js";

/**
 * The live suite: one real paid call and one real refusal, against the hosted
 * Blocky402 facilitator and the public Hedera mirror node.
 *
 * It is deliberately frugal. Blocky402 testnet allows 100 requests per minute
 * per IP with a burst of 10, and the public mirror node about 50 rps, so this
 * makes two paid requests in total and polls politely.
 */

const LIVE_VARS = ["PAY_TO", "BUYER_ACCOUNT_ID", "BUYER_PRIVATE_KEY", "ATTESTOR_PRIVATE_KEY"];
const missing = LIVE_VARS.filter((v) => !(process.env[v] ?? "").trim());
const live = hasLiveCredentials();
const anchoring = hasAnchorCredentials();

const DATA_DIR = `data/live/${randomBytes(4).toString("hex")}`;

let service: AttestorService;
let baseUrl: string;
let mirror: MirrorClient;
let attested: AttestationSuccess | null = null;
let refused: AttestationRefusal | null = null;

before(async () => {
  if (!live) return;
  mirror = new MirrorClient();
  service = createService({
    config: sellerConfig({
      payTo: process.env.PAY_TO!,
      facilitatorUrl: process.env.FACILITATOR_URL ?? "https://api.testnet.blocky402.com",
      amountTinybar: process.env.AMOUNT_TINYBAR ?? "100000",
      attestorPrivateKey: (process.env.ATTESTOR_PRIVATE_KEY!.startsWith("0x")
        ? process.env.ATTESTOR_PRIVATE_KEY!
        : `0x${process.env.ATTESTOR_PRIVATE_KEY}`) as `0x${string}`,
      dataDir: DATA_DIR,
      anchor: anchoring
        ? {
            operatorId: process.env.HEDERA_ACCOUNT_ID!,
            operatorKey: process.env.HEDERA_PRIVATE_KEY!,
            topicId: process.env.HCS_TOPIC_ID!,
            network: "testnet",
          }
        : null,
    }),
  });
  const { port } = await service.listen(0);
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  if (!live) return;
  await service.close();
  // Receipts from a live run are evidence. Keep them unless asked otherwise.
  if ((process.env.KEEP_LIVE_RECEIPTS ?? "").trim() === "") {
    rmSync(DATA_DIR, { recursive: true, force: true });
  }
});

function buyer() {
  return loadBuyerConfig({ ...process.env, ATTESTOR_URL: baseUrl } as NodeJS.ProcessEnv);
}

describe("live: a real paid round trip through the hosted Blocky402 facilitator", () => {
  it(
    "settles a coverage attestation on Hedera testnet",
    { skip: live ? false : skipMessage("paid round trip", missing) },
    async () => {
      const outcome = await requestAttestation({ config: buyer(), noteId: "NOTE-ALPHA" });
      assert.equal(outcome.outcome, "attested");
      attested = outcome;

      assert.equal(outcome.coverageBps, 13000);
      assert.match(
        outcome.settlementTxId,
        /^\d+\.\d+\.\d+@\d+\.\d+$/,
        "settlement must return a Hedera transaction id",
      );
      assert.ok(outcome.hashscan.includes("hashscan.io/testnet/transaction/"));
    },
  );

  it(
    "is confirmed by the public mirror node, with the facilitator paying the network fee",
    { skip: live ? false : skipMessage("mirror confirmation", missing) },
    async () => {
      assert.ok(attested, "the paid call must have run first");
      const tx = await mirror.transaction(attested.settlementTxId);
      assert.ok(tx, `${attested.settlementTxId} should be on the mirror node`);

      assert.equal(tx.name, "CRYPTOTRANSFER");
      assert.equal(tx.result, "SUCCESS");

      const amount = Number(process.env.AMOUNT_TINYBAR ?? "100000");
      assert.equal(
        netForAccount(tx, process.env.PAY_TO!),
        amount,
        "the seller must be credited exactly the advertised price",
      );
      assert.equal(
        netForAccount(tx, process.env.BUYER_ACCOUNT_ID!),
        -amount,
        "the buyer must be debited exactly the advertised price and no gas",
      );
    },
  );
});

describe("live: a real refusal, proven to have moved nothing", () => {
  it(
    "returns a signed refusal with no settlement id",
    { skip: live ? false : skipMessage("live refusal", missing) },
    async () => {
      const outcome = await requestAttestation({ config: buyer(), noteId: "NOTE-BRAVO" });
      assert.equal(outcome.outcome, "refused");
      refused = outcome;

      assert.equal(outcome.httpStatus, 422);
      assert.equal(outcome.family, "asset");
      assert.equal(outcome.reason, "coverage_below_floor");
      assert.equal(outcome.settlementTxId, null);
      assert.equal(outcome.retry.shouldRetry, false, "an asset finding is not worth retrying");
    },
  );

  it(
    "has no transfer on the mirror node: the absence is the artifact",
    { skip: live ? false : skipMessage("absence proof", missing) },
    async () => {
      assert.ok(refused, "the refusal must have run first");
      const receipt = service.receipts.read(refused.requestId);
      assert.ok(receipt, "the refusal must have left a receipt");
      assert.equal(receipt.chargeTransactionId, null);

      // Give consensus and the mirror node room to have indexed anything that
      // did happen, so this absence is not merely lag.
      await new Promise((resolve) => setTimeout(resolve, 8000));

      const credits = await mirror.transfersTo(
        receipt.payTo,
        receipt.requestedAt - 120,
        receipt.respondedAt + 300,
      );
      const fromBuyer = credits.filter(
        (tx) => netForAccount(tx, process.env.BUYER_ACCOUNT_ID!) < 0,
      );
      const paidTransactionIds = new Set(
        attested ? [toMirrorTxId(attested.settlementTxId)] : [],
      );
      const unexplained = fromBuyer.filter((tx) => !paidTransactionIds.has(tx.transaction_id));

      assert.equal(
        unexplained.length,
        0,
        `the refusal must have moved nothing, but found: ${unexplained.map((t) => t.transaction_id).join(", ")}`,
      );
    },
  );
});

describe("live: HCS anchoring", () => {
  it(
    "anchors both verdicts in a single sub-1KB consensus message each",
    { skip: anchoring ? false : skipMessage("HCS anchoring", ["HEDERA_ACCOUNT_ID", "HEDERA_PRIVATE_KEY", "HCS_TOPIC_ID"]) },
    async () => {
      assert.ok(attested && refused, "both live calls must have run first");
      const topicId = process.env.HCS_TOPIC_ID!;

      for (const requestId of [attested.requestId, refused.requestId]) {
        const receipt = service.receipts.read(requestId);
        assert.ok(receipt?.anchor, `${requestId} should have been anchored`);
        assert.ok(receipt.anchor.sequenceNumber > 0);

        const message = await mirror.topicMessage(topicId, receipt.anchor.sequenceNumber);
        assert.ok(message, "the anchored record must be readable from the mirror node");
        assert.ok(
          !message.chunk_info || message.chunk_info.total === 1,
          "a Plimsoll receipt is always one message, never chunked",
        );

        const decoded = Buffer.from(message.message, "base64");
        assert.ok(decoded.length <= HCS_MESSAGE_LIMIT, `${decoded.length} bytes exceeds the limit`);
        const record = JSON.parse(decoded.toString("utf8"));
        assert.equal(record.p, "plimsoll/coverage");
        assert.equal(record.rid, requestId);
        assert.equal(record.chg, requestId === attested.requestId);
      }
    },
  );
});

describe("live: verify-charge over real evidence", () => {
  it(
    "reports CHARGED AND WARRANTED for the paid call",
    { skip: live ? false : skipMessage("verify-charge", missing) },
    async () => {
      assert.ok(attested);
      const result = await verifyCharge({
        requestId: attested.requestId,
        dataDir: DATA_DIR,
        json: true,
        explain: false,
      });
      assert.equal(result.verdict, "CHARGED AND WARRANTED");
      assert.equal(result.recomputedBps, 13000);
      assert.ok(result.checks.every((c) => c.passed), JSON.stringify(result.checks.filter((c) => !c.passed)));
    },
  );

  it(
    "reports REFUSED AND NOT CHARGED for the refusal",
    { skip: live ? false : skipMessage("verify-charge", missing) },
    async () => {
      assert.ok(refused);
      const result = await verifyCharge({
        requestId: refused.requestId,
        dataDir: DATA_DIR,
        json: true,
        explain: false,
      });
      assert.equal(result.verdict, "REFUSED AND NOT CHARGED");
      assert.equal(result.charged, false);
      assert.ok(result.checks.every((c) => c.passed), JSON.stringify(result.checks.filter((c) => !c.passed)));
    },
  );
});

describe("live: the hosted facilitator itself", () => {
  it(
    "advertises hedera:testnet exact with a fee payer",
    { skip: live ? false : skipMessage("facilitator probe", missing) },
    async () => {
      const url = process.env.FACILITATOR_URL ?? "https://api.testnet.blocky402.com";
      const response = await fetch(`${url}/supported`);
      assert.equal(response.status, 200);
      const body = (await response.json()) as Record<string, any>;
      const hedera = body.kinds.find((k: any) => k.network === "hedera:testnet");
      assert.ok(hedera, "the facilitator must support hedera:testnet");
      assert.equal(hedera.scheme, "exact");
      assert.equal(hedera.x402Version, 2);
      assert.match(hedera.extra.feePayer, /^\d+\.\d+\.\d+$/);
    },
  );
});
