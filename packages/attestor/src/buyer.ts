import { PrivateKey } from "@hiero-ledger/sdk";
import { pathToFileURL } from "node:url";
import { x402Client } from "@x402/core/client";
import { decodePaymentResponseHeader, wrapFetchWithPayment } from "@x402/fetch";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { createClientHederaSigner } from "@x402/hedera";
import type { Hex } from "viem";
import { loadBuyerConfig, type BuyerConfig } from "./config.js";
import {
  createErc8004Client,
  giveFeedbackViaHapi,
  type FeedbackFile,
} from "./erc8004.js";
import { hashscanTx } from "./mirror.js";
import { familyOf, type RefusalFamily, type RefusalReason } from "./reasons.js";

/**
 * The consuming agent.
 *
 * It is not a test harness with a wallet attached: it has to decide what to do
 * with an answer it did not want. A refusal is free, so the naive behaviour is
 * to retry immediately and forever, which is exactly what the service's pricing
 * makes cheap and what its taxonomy makes unnecessary. The two families get
 * genuinely different handling below.
 */

export interface AttestationSuccess {
  outcome: "attested";
  requestId: string;
  noteId: string;
  coverageBps: number;
  attestation: Record<string, unknown>;
  signature: string;
  attestor: string;
  /** Hedera transaction id from the PAYMENT-RESPONSE header. */
  settlementTxId: string;
  hashscan: string;
  payer: string | null;
}

export interface AttestationRefusal {
  outcome: "refused";
  requestId: string;
  noteId: string;
  family: RefusalFamily;
  reason: RefusalReason;
  description: string;
  coverageBps: number | null;
  httpStatus: number;
  signature: string;
  /** Always null. Kept so callers cannot forget to check it. */
  settlementTxId: null;
  retry: RetryAdvice;
}

export type AttestationOutcome = AttestationSuccess | AttestationRefusal;

export interface RetryAdvice {
  shouldRetry: boolean;
  afterSeconds: number;
  because: string;
}

/**
 * What to do next, by family.
 *
 * An asset finding is a fact about somebody else's balance sheet: asking again
 * in ten seconds cannot change it, and treating it as a transient error would
 * turn a correct answer into a retry storm. An evidence refusal is about us,
 * and is worth retrying with a backoff, because it genuinely may resolve.
 */
export function adviseRetry(reason: RefusalReason, attempt: number): RetryAdvice {
  const family = familyOf(reason);
  if (family === "asset") {
    return {
      shouldRetry: false,
      afterSeconds: 0,
      because:
        "The service reached a verdict about the note. Retrying cannot change it; " +
        "the position has to change first.",
    };
  }
  // Exponential, capped. The refusal cost nothing, which is precisely why the
  // client rather than the price has to be the thing that shows restraint.
  const afterSeconds = Math.min(2 ** attempt * 5, 300);
  return {
    shouldRetry: attempt < 5,
    afterSeconds,
    because:
      reason === "source_unavailable"
        ? "The coverage source was unreachable. This is a condition of theirs, not of the note."
        : "The service could not establish evidence it trusts. It may resolve; back off and retry.",
  };
}

export interface RequestAttestationOptions {
  config: BuyerConfig;
  noteId: string;
  attempt?: number;
  fetchImpl?: typeof globalThis.fetch;
}

export async function requestAttestation(
  options: RequestAttestationOptions,
): Promise<AttestationOutcome> {
  const { config, noteId } = options;
  const signer = createClientHederaSigner(
    config.accountId,
    PrivateKey.fromStringECDSA(stripHexPrefix(config.privateKey)),
    { network: config.network },
  );
  const client = new x402Client().register(config.network, new ExactHederaScheme(signer));

  // Native HBAR is not in the x402 Hedera default-asset table — only USDC is —
  // so the client's spend controls reject "0.0.0" out of the box with
  // "All payment requirements were rejected by spendControls". Allowlisting the
  // asset with an explicit atomic cap is the right fix; disabling spend
  // controls entirely would remove the ceiling along with the complaint.
  client.setSpendControls({
    allowedAssets: [
      {
        network: config.network,
        asset: "0.0.0",
        maxAmountPerPayment: config.maxTinybarPerCall,
      },
    ],
  });

  const paidFetch = wrapFetchWithPayment(options.fetchImpl ?? globalThis.fetch, client);

  const url = `${config.attestorUrl}/attest?noteId=${encodeURIComponent(noteId)}`;
  const response = await paidFetch(url);
  const body = (await response.json()) as Record<string, any>;

  if (response.status === 200 && body.result === "attested") {
    const settlement = decodePaymentResponseHeader(
      response.headers.get("PAYMENT-RESPONSE") ??
        response.headers.get("X-PAYMENT-RESPONSE") ??
        "",
    );
    const settlementTxId = String(settlement?.transaction ?? "");
    return {
      outcome: "attested",
      requestId: String(body.requestId ?? ""),
      noteId: String(body.noteId),
      coverageBps: Number(body.coverageBps),
      attestation: body.attestation,
      signature: String(body.signature),
      attestor: String(body.attestor),
      settlementTxId,
      hashscan: settlementTxId ? hashscanTx(settlementTxId) : "",
      payer: settlement?.payer ?? null,
    };
  }

  if (body.result === "refused") {
    const reason = String(body.reason) as RefusalReason;
    return {
      outcome: "refused",
      requestId: String(body.requestId ?? ""),
      noteId: String(body.noteId),
      family: String(body.family) as RefusalFamily,
      reason,
      description: String(body.description ?? ""),
      coverageBps: body.coverageBps === null ? null : Number(body.coverageBps),
      httpStatus: response.status,
      signature: String(body.signature),
      settlementTxId: null,
      retry: adviseRetry(reason, options.attempt ?? 0),
    };
  }

  throw new Error(
    `attestor returned ${response.status}: ${body.error ?? JSON.stringify(body).slice(0, 200)}`,
  );
}

export interface FeedbackOutcome {
  /** Hedera transaction id: the feedback is submitted natively, not via the relay. */
  transactionId: string;
  feedbackHash: string;
  status: string;
  hashscan: string;
}

/**
 * Post ERC-8004 feedback for a call that was actually paid for.
 *
 * Deliberately gated on a settlement id: feedback whose `proofOfPayment` points
 * at no transaction is noise, and a reputation registry full of unpaid opinions
 * is worse than an empty one.
 */
export async function postFeedback(
  config: BuyerConfig,
  success: AttestationSuccess,
): Promise<FeedbackOutcome> {
  if (!config.agentId) throw new Error("ATTESTOR_AGENT_ID is required to post feedback");
  if (!success.settlementTxId) throw new Error("refusing to post feedback without a settlement id");

  // Only used to derive the buyer's key address for the feedback file. The
  // transaction itself goes over HAPI, because this account may have no EVM
  // alias for the JSON-RPC relay to recognise.
  const client = createErc8004Client({
    privateKey: stripHexPrefix(config.privateKey) as Hex,
    rpcUrl: config.evmRpcUrl,
  });

  const feedback: FeedbackFile = {
    type: "https://eips.ethereum.org/EIPS/eip-8004#feedback-v1",
    agentURI: `${config.canonicalUrl}/.well-known/agent-registration.json`,
    endpoint: `${config.canonicalUrl}/attest`,
    outcome: "attested",
    noteId: success.noteId,
    coverageBps: success.coverageBps,
    requestId: success.requestId,
    attestationSignature: success.signature,
    sourceHash: String(success.attestation.sourceHash ?? ""),
    proofOfPayment: {
      fromAddress: client.address,
      toAddress: String(success.attestor),
      chainId: "296",
      txHash: success.settlementTxId,
    },
  };

  const result = await giveFeedbackViaHapi({
    accountId: config.accountId,
    privateKey: config.privateKey,
    network: "testnet",
    feedback: {
      agentId: config.agentId,
      // 100 with zero decimals: the call was paid for and the answer verified.
      value: 100n,
      valueDecimals: 0,
      tag1: "coverage-attestation",
      tag2: "settled",
      endpoint: feedback.endpoint,
      feedback,
    },
  });

  return {
    transactionId: result.transactionId,
    feedbackHash: result.feedbackHash,
    status: result.status,
    hashscan: hashscanTx(result.transactionId),
  };
}

function stripHexPrefix(key: string): string {
  return key.startsWith("0x") ? key.slice(2) : key;
}

async function main(): Promise<void> {
  const config = loadBuyerConfig();
  const noteId = process.argv[2] ?? "NOTE-ALPHA";
  console.log(`buyer ${config.accountId} requesting coverage for ${noteId}`);

  const outcome = await requestAttestation({ config, noteId });

  if (outcome.outcome === "refused") {
    console.log(`\nREFUSED  ${outcome.reason}  (family: ${outcome.family}, HTTP ${outcome.httpStatus})`);
    console.log(`  ${outcome.description}`);
    console.log(
      `  coverage: ${outcome.coverageBps === null ? "not computed" : `${outcome.coverageBps} bps`}`,
    );
    console.log(`  charged: no. No settlement was requested, so there is no transaction.`);
    console.log(`  next: ${outcome.retry.shouldRetry ? `retry in ${outcome.retry.afterSeconds}s` : "do not retry"}`);
    console.log(`  because: ${outcome.retry.because}`);
    console.log(`  requestId: ${outcome.requestId}`);
    return;
  }

  console.log(`\nATTESTED  coverage ${outcome.coverageBps} bps`);
  console.log(`  requestId:  ${outcome.requestId}`);
  console.log(`  settlement: ${outcome.settlementTxId}`);
  console.log(`  hashscan:   ${outcome.hashscan}`);

  if (config.skipFeedback || !config.agentId) {
    console.log(
      `\nskipping ERC-8004 feedback (${config.agentId ? "BUYER_SKIP_FEEDBACK set" : "ATTESTOR_AGENT_ID not set"})`,
    );
    return;
  }

  const feedback = await postFeedback(config, outcome);
  console.log(`\nERC-8004 feedback posted`);
  console.log(`  tx:       ${feedback.transactionId}  (${feedback.status})`);
  console.log(`  hashscan: ${feedback.hashscan}`);
  console.log(`  hash:     ${feedback.feedbackHash}`);
}

// See isMainModule() in src/server.ts for why pathToFileURL is required here.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
