import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { createService, type AttestorService } from "../src/server.js";
import { REFUSAL_EXTENSION_KEY } from "../src/extension.js";
import {
  TEST_FEE_PAYER,
  TEST_PAY_TO,
  payingFetch,
  sellerConfig,
  startStubFacilitator,
  type StubFacilitator,
} from "./helpers.js";

const DATA_DIR = `data/test/${randomBytes(4).toString("hex")}`;

let facilitator: StubFacilitator;
let service: AttestorService;
let baseUrl: string;

before(async () => {
  facilitator = await startStubFacilitator();
  service = createService({
    config: sellerConfig({ facilitatorUrl: facilitator.url, dataDir: DATA_DIR }),
  });
  const { port } = await service.listen(0);
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await service.close();
  await facilitator.close();
  rmSync(DATA_DIR, { recursive: true, force: true });
});

function decodeChallenge(response: Response): Record<string, any> {
  const header = response.headers.get("PAYMENT-REQUIRED");
  assert.ok(header, "the 402 challenge must ride in the PAYMENT-REQUIRED header");
  return JSON.parse(Buffer.from(header, "base64").toString("utf8"));
}

describe("the 402 challenge", () => {
  it("puts the challenge in a header and leaves the body empty", async () => {
    const response = await fetch(`${baseUrl}/attest?noteId=NOTE-ALPHA`);
    assert.equal(response.status, 402);

    const header = response.headers.get("PAYMENT-REQUIRED");
    assert.ok(header, "PAYMENT-REQUIRED must be present");
    assert.doesNotThrow(
      () => Buffer.from(header, "base64").toString("utf8"),
      "the header must be base64",
    );
    assert.deepEqual(await response.json(), {}, "x402 v2 carries nothing in the 402 body");
  });

  it("advertises exact on hedera:testnet in native HBAR", async () => {
    const challenge = decodeChallenge(await fetch(`${baseUrl}/attest?noteId=NOTE-ALPHA`));
    assert.equal(challenge.x402Version, 2);

    const accepts = challenge.accepts[0];
    assert.equal(accepts.scheme, "exact");
    assert.equal(accepts.network, "hedera:testnet");
    assert.equal(accepts.payTo, TEST_PAY_TO);
    assert.equal(accepts.asset, "0.0.0", "native HBAR needs no token association");
    assert.equal(accepts.amount, "100000");
    assert.equal(accepts.maxTimeoutSeconds, 300);
  });

  it("carries the fee payer the facilitator supplied, which we never write ourselves", async () => {
    const challenge = decodeChallenge(await fetch(`${baseUrl}/attest?noteId=NOTE-ALPHA`));
    assert.equal(challenge.accepts[0].extra.feePayer, TEST_FEE_PAYER);
    assert.ok(facilitator.calls.supported > 0, "the middleware syncs /supported on start");
  });

  it("states the refusal terms in the challenge, before the buyer signs anything", async () => {
    const challenge = decodeChallenge(await fetch(`${baseUrl}/attest?noteId=NOTE-ALPHA`));
    const declaration = challenge.extensions?.[REFUSAL_EXTENSION_KEY];
    assert.ok(declaration, "the refusal extension must be declared on the challenge");
    assert.equal(declaration.paymentFlow, "authorization");
    assert.deepEqual(declaration.chargedStatuses, [200]);
    assert.ok(declaration.freeStatuses.includes(422));
    assert.ok(declaration.freeStatuses.includes(424));
    assert.equal(declaration.families.asset.httpStatus, 422);
    assert.equal(declaration.families.evidence.httpStatus, 424);
    assert.equal(declaration.reasons.length, 8);
    assert.ok(declaration.challenge, "a fresh challenge nonce is issued per 402");
  });

  it("issues a different challenge nonce each time", async () => {
    const first = decodeChallenge(await fetch(`${baseUrl}/attest?noteId=NOTE-ALPHA`));
    const second = decodeChallenge(await fetch(`${baseUrl}/attest?noteId=NOTE-ALPHA`));
    assert.notEqual(
      first.extensions[REFUSAL_EXTENSION_KEY].challenge,
      second.extensions[REFUSAL_EXTENSION_KEY].challenge,
    );
  });
});

describe("unpaid endpoints", () => {
  it("serves health without a challenge", async () => {
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, any>;
    assert.equal(body.status, "ok");
    assert.equal(body.payTo, TEST_PAY_TO);
    assert.equal(body.coverageSource, "fixture");
  });

  it("serves the ERC-8004 registration file with a UAID and the taxonomy", async () => {
    const response = await fetch(`${baseUrl}/.well-known/agent-registration.json`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, any>;
    assert.match(body.uaid, /^uaid:aid:[1-9A-HJ-NP-Za-km-z]+;uid=0;registry=plimsoll;proto=x402;nativeId=hedera:testnet:/);
    assert.equal(body.x402Support, true);
    assert.equal(body.refusalTaxonomy.length, 8);
    assert.equal(body.settlementPolicy.paymentFlow, "authorization");
    assert.deepEqual(body.settlementPolicy.chargedOn, ["200"]);
    assert.ok(body.refusalTaxonomy.every((r: any) => r.charged === false));
  });
});

describe("the paid round trip, against a stubbed facilitator", () => {
  it("settles exactly once for an attestation", async () => {
    const before = facilitator.calls.settle;
    const { fetch: paidFetch } = payingFetch();
    const response = await paidFetch(`${baseUrl}/attest?noteId=NOTE-ALPHA`);

    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, any>;
    assert.equal(body.result, "attested");
    assert.equal(body.coverageBps, 13000);
    assert.equal(body.charged, true);
    assert.ok(body.signature.startsWith("0x"));
    assert.ok(response.headers.get("PAYMENT-RESPONSE"), "settlement rides on PAYMENT-RESPONSE");
    assert.equal(facilitator.calls.settle, before + 1);
  });

  it("never calls settle for an asset refusal", async () => {
    const before = facilitator.calls.settle;
    const { fetch: paidFetch } = payingFetch();
    const response = await paidFetch(`${baseUrl}/attest?noteId=NOTE-BRAVO`);

    assert.equal(response.status, 422);
    const body = (await response.json()) as Record<string, any>;
    assert.equal(body.result, "refused");
    assert.equal(body.family, "asset");
    assert.equal(body.reason, "coverage_below_floor");
    assert.equal(body.charged, false);
    assert.equal(
      facilitator.calls.settle,
      before,
      "a 4xx cancels settlement before the facilitator is ever asked",
    );
  });

  it("never calls settle for an evidence refusal either", async () => {
    const before = facilitator.calls.settle;
    const { fetch: paidFetch } = payingFetch();
    const response = await paidFetch(`${baseUrl}/attest?noteId=NOTE-INDIA`);

    assert.equal(response.status, 424);
    const body = (await response.json()) as Record<string, any>;
    assert.equal(body.family, "evidence");
    assert.equal(body.reason, "source_unavailable");
    assert.equal(body.coverageBps, null, "an evidence refusal reports no ratio at all");
    assert.equal(facilitator.calls.settle, before);
  });

  it("verifies the payment even when it then refuses, so the refusal is not a bypass", async () => {
    const verifiesBefore = facilitator.calls.verify;
    const { fetch: paidFetch } = payingFetch();
    await paidFetch(`${baseUrl}/attest?noteId=NOTE-BRAVO`);
    assert.equal(
      facilitator.calls.verify,
      verifiesBefore + 1,
      "the buyer's authorization is still verified; it is simply never captured",
    );
  });

  it("returns 404 for an unknown note without signing anything", async () => {
    const before = facilitator.calls.settle;
    const { fetch: paidFetch } = payingFetch();
    const response = await paidFetch(`${baseUrl}/attest?noteId=NOTE-NOPE`);
    assert.equal(response.status, 404);
    const body = (await response.json()) as Record<string, any>;
    assert.equal(body.error, "unknown_note");
    assert.equal(body.signature, undefined, "there is nothing to attest or refuse about");
    assert.equal(facilitator.calls.settle, before);
  });

  it("records a receipt for every verdict, charged or not", async () => {
    const { fetch: paidFetch } = payingFetch();
    const refused = await paidFetch(`${baseUrl}/attest?noteId=NOTE-GOLF`);
    const body = (await refused.json()) as Record<string, any>;

    const receipt = service.receipts.read(body.requestId);
    assert.ok(receipt, "a refusal must leave a receipt too");
    assert.equal(receipt.decision, "refused");
    assert.equal(receipt.chargeTransactionId, null, "no charge means no transaction id, ever");
    assert.ok(receipt.anchorRecord, "the cancel hook writes the non-capture record");
    assert.equal(receipt.anchorRecord.chg, false);
  });
});
