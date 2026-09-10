import express, { type Express, type Request, type Response } from "express";
import type { Server } from "node:http";
import { pathToFileURL } from "node:url";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import type { RoutesConfig } from "@x402/core/server";
import { paymentMiddleware } from "@x402/express";
import { ExactHederaScheme } from "@x402/hedera/exact/server";
import { MalformedSnapshot, attest, type Verdict } from "./attest.js";
import { type Anchor, HcsAnchor, NullAnchor, buildAnchorRecord } from "./anchor.js";
import { createCoverageSource, UnknownNote, type CoverageSource } from "./coverage/index.js";
import { createAttestorSigner } from "./eip712.js";
import { attestationToWire, refusalToWire } from "./eip712.js";
import { REFUSAL_EXTENSION_KEY, createRefusalExtension, refusalDeclaration } from "./extension.js";
import { DEFAULT_POLICY, type CoveragePolicy } from "./policy.js";
import { NonceStore, ReceiptStore, type StoredReceipt } from "./receipts.js";
import { REGISTRATION_PATH, buildRegistration } from "./registration.js";
import { currentContext, newRequestId, runWithContext, type RequestContext } from "./context.js";
import { hashscanTopic } from "./mirror.js";
import type { SellerConfig } from "./config.js";

export interface AttestorService {
  app: Express;
  listen(port?: number): Promise<{ server: Server; port: number }>;
  close(): Promise<void>;
  receipts: ReceiptStore;
  attestorAddress: string;
}

export interface CreateServiceOptions {
  config: SellerConfig;
  policy?: CoveragePolicy;
  source?: CoverageSource;
  anchor?: Anchor;
}

export function createService(options: CreateServiceOptions): AttestorService {
  const { config } = options;
  const policy = options.policy ?? DEFAULT_POLICY;
  const source =
    options.source ?? createCoverageSource(config.coverageSource, config.substreamsEndpoint);
  const signer = createAttestorSigner(config.attestorPrivateKey);
  const receipts = new ReceiptStore(config.dataDir);
  const nonces = new NonceStore(config.dataDir);
  const anchor = options.anchor ?? (config.anchor ? new HcsAnchor(config.anchor) : new NullAnchor());
  const anchoringEnabled = !(anchor instanceof NullAnchor);

  const facilitator = new HTTPFacilitatorClient({ url: config.facilitatorUrl });

  const routes: RoutesConfig = {
    "GET /attest": {
      accepts: {
        scheme: "exact",
        network: config.network,
        payTo: config.payTo,
        // Atomic units as strings. "0.0.0" is native HBAR; an HTS token would
        // need the seller associated first or settlement fails
        // TOKEN_NOT_ASSOCIATED, which is a worse demo than it is a feature.
        price: { amount: config.amountTinybar, asset: "0.0.0" },
        maxTimeoutSeconds: 300,
      },
      description: "Signed coverage attestation, or a signed refusal at no charge",
      mimeType: "application/json",
      extensions: { [REFUSAL_EXTENSION_KEY]: refusalDeclaration(policy) },
    },
  };

  // We build the resource server by hand rather than using
  // paymentMiddlewareFromConfig, because the extension and the settle hooks
  // need a handle on the instance. `extra.feePayer` is never set here: the
  // middleware syncs /supported and injects the facilitator's fee payer itself.
  const resourceServer = new x402ResourceServer(facilitator)
    .register(config.network, new ExactHederaScheme())
    .registerExtension(createRefusalExtension(policy));

  resourceServer.onAfterVerify(async (context) => {
    const request = currentContext();
    if (request) request.payer = context.result.payer ?? null;
  });

  // The only place a charge is recorded. If this never fires, no money moved.
  resourceServer.onAfterSettle(async (context) => {
    const request = currentContext();
    if (!request || !context.result.success) return;
    request.chargeTransactionId = context.result.transaction;
    await finaliseReceipt(request, { transactionId: context.result.transaction });
  });

  resourceServer.onVerifiedPaymentCanceled(async () => {
    const request = currentContext();
    if (!request) return;
    await finaliseReceipt(request, null);
  });

  async function finaliseReceipt(
    request: RequestContext,
    charge: { transactionId: string } | null,
  ): Promise<void> {
    if (!request.verdict) return;
    const record = buildAnchorRecord({
      requestId: request.requestId,
      verdict: request.verdict,
      charge,
      maxPositions: policy.maxAnchoredPositions,
    });

    let anchorReceipt: StoredReceipt["anchor"] = null;
    if (anchoringEnabled) {
      try {
        const submitted = await anchor.submit(record);
        anchorReceipt = {
          topicId: submitted.topicId,
          sequenceNumber: submitted.sequenceNumber,
          transactionId: submitted.transactionId,
        };
      } catch (error) {
        // Anchoring failing must not rewrite history: the receipt still says
        // exactly what happened, and the missing anchor is visible as a null.
        console.error(`[attestor] anchoring failed for ${request.requestId}:`, error);
      }
    }

    receipts.patch(request.requestId, {
      chargeTransactionId: charge?.transactionId ?? null,
      payer: request.payer,
      anchor: anchorReceipt,
      anchorRecord: record,
    });
  }

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json());

  // Enter the async context before the payment middleware, so the settle and
  // cancel hooks it invokes later can still see which request they belong to.
  app.use((req, _res, next) => {
    const context: RequestContext = {
      requestId: newRequestId(),
      requestedAt: Math.floor(Date.now() / 1000),
      verdict: null,
      payer: null,
      chargeTransactionId: null,
      cancellation: null,
    };
    runWithContext(context, next);
  });

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      service: "plimsoll-attestor",
      network: config.network,
      facilitator: config.facilitatorUrl,
      payTo: config.payTo,
      priceTinybar: config.amountTinybar,
      attestor: signer.address,
      coverageSource: source.id,
      policy: { id: policy.id, floorBps: policy.floorBps },
      anchoring: anchoringEnabled
        ? { topicId: config.anchor?.topicId, hashscan: hashscanTopic(config.anchor?.topicId ?? "") }
        : null,
    });
  });

  app.get(REGISTRATION_PATH, (_req, res) => {
    res.json(
      buildRegistration({
        baseUrl: config.publicBaseUrl,
        payTo: config.payTo,
        amountTinybar: config.amountTinybar,
        attestorAddress: signer.address,
        facilitatorUrl: config.facilitatorUrl,
        topicId: config.anchor?.topicId ?? null,
        policy,
      }),
    );
  });

  /** Unpaid evidence retrieval, so a verifier never needs our credentials. */
  app.get("/receipts/:requestId", (req, res) => {
    const receipt = receipts.read(String(req.params.requestId));
    if (!receipt) {
      res.status(404).json({ error: "unknown_request" });
      return;
    }
    res.json(receipt);
  });

  app.use(paymentMiddleware(routes, resourceServer));

  app.get("/attest", async (req: Request, res: Response) => {
    const request = currentContext();
    const noteId = typeof req.query.noteId === "string" ? req.query.noteId.trim() : "";

    if (!noteId) {
      // Not a refusal: there is no note to make a finding about. Still free,
      // because it is a 4xx like everything else that is not an attestation.
      res.status(400).json({ error: "missing_note_id", message: "noteId query parameter required" });
      return;
    }

    let verdict: Verdict;
    try {
      verdict = await attest(noteId, { source, signer, policy });
    } catch (error) {
      if (error instanceof UnknownNote) {
        res.status(404).json({ error: "unknown_note", noteId });
        return;
      }
      if (error instanceof MalformedSnapshot) {
        res.status(502).json({ error: "malformed_snapshot", message: error.message, detail: error.detail });
        return;
      }
      throw error;
    }

    if (request) {
      request.verdict = verdict;
      // Claiming the nonce at issue time is what makes a later replay
      // detectable: the same nonce can never be signed twice.
      nonces.claim(verdict.message.nonce);
      receipts.write(toStoredReceipt(request, verdict, config));
    }

    const body =
      verdict.decision === "attested"
        ? {
            result: "attested",
            requestId: request?.requestId ?? null,
            noteId: verdict.noteId,
            coverageBps: verdict.coverageBps,
            floorBps: policy.floorBps,
            attestation: attestationToWire(verdict.message),
            signature: verdict.signature,
            attestor: verdict.attestor,
            evidence: verdict.evidence,
            charged: true,
          }
        : {
            result: "refused",
            requestId: request?.requestId ?? null,
            noteId: verdict.noteId,
            family: verdict.family,
            reason: verdict.reason,
            description: verdict.description,
            coverageKnown: verdict.coverageKnown,
            coverageBps: verdict.coverageKnown ? verdict.coverageBps : null,
            refusal: refusalToWire(verdict.message),
            signature: verdict.signature,
            attestor: verdict.attestor,
            evidence: verdict.evidence,
            detail: verdict.detail,
            charged: false,
            note:
              "This response is >= 400, which cancels x402 settlement. Your signed transfer was " +
              "never submitted and will expire. Nothing was charged and nothing needs refunding.",
          };

    res.status(verdict.httpStatus).json(body);
  });

  let server: Server | null = null;

  return {
    app,
    attestorAddress: signer.address,
    receipts,
    listen(port = config.port) {
      return new Promise((resolve, reject) => {
        const created = app.listen(port, () => {
          server = created;
          const address = created.address();
          const bound = typeof address === "object" && address ? address.port : port;
          resolve({ server: created, port: bound });
        });
        created.on("error", reject);
      });
    },
    async close() {
      await anchor.close();
      if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    },
  };
}

function toStoredReceipt(
  request: RequestContext,
  verdict: Verdict,
  config: SellerConfig,
): StoredReceipt {
  return {
    requestId: request.requestId,
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
    chargeTransactionId: null,
    payTo: config.payTo,
    amountTinybar: config.amountTinybar,
    payer: request.payer,
    requestedAt: request.requestedAt,
    respondedAt: Math.floor(Date.now() / 1000),
    httpStatus: verdict.httpStatus,
    anchor: null,
    anchorRecord: null,
  };
}

/** Entry point for `npm run serve`. */
async function main(): Promise<void> {
  const { loadSellerConfig } = await import("./config.js");
  const config = loadSellerConfig();
  const service = createService({ config });
  const { port } = await service.listen();
  console.log(`plimsoll attestor listening on :${port}`);
  console.log(`  attestor  ${service.attestorAddress}`);
  console.log(`  payTo     ${config.payTo} (${config.amountTinybar} tinybar)`);
  console.log(`  facilitator ${config.facilitatorUrl}`);
  console.log(`  registration ${config.publicBaseUrl}${REGISTRATION_PATH}`);
}

/**
 * Windows-safe main-module check. `import.meta.url` renders a drive path as
 * `file:///C:/...`, while `file://` concatenated with argv[1] gives
 * `file://C:/...`. The two never compare equal, so the naive form leaves the
 * entry point silently doing nothing. `pathToFileURL` is right on both platforms.
 */
export function isMainModule(): boolean {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]!).href;
}

if (isMainModule()) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
