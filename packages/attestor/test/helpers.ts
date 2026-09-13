import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PrivateKey } from "@hiero-ledger/sdk";
import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { createClientHederaSigner } from "@x402/hedera";
import type { SellerConfig } from "../src/config.js";
import type { MirrorTopicMessage, MirrorTransaction } from "../src/mirror.js";

/** Well-known throwaway key. Signs fixture verdicts in tests and nothing else. */
export const TEST_ATTESTOR_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
export const TEST_ATTESTOR_ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

export const TEST_FEE_PAYER = "0.0.7162784";
export const TEST_PAY_TO = "0.0.999001";

/**
 * The oracle the suite signs for.
 *
 * Deliberately a fixed, obviously-fake address rather than the deployed one:
 * these tests assert properties of the encoding, and they must not change
 * meaning when the stack is redeployed. `test/typed-data.test.ts` is where the
 * real contract gets the last word on whether the digest is right.
 */
export const TEST_ORACLE_ADDRESS = "0x0000000000000000000000000000000000c0ffee" as const;
export const TEST_CHAIN_ID = 296;

/** Signing-domain shape, for `createAttestorSigner` and `attestorDomain`. */
export const TEST_ORACLE = {
  chainId: TEST_CHAIN_ID,
  verifyingContract: TEST_ORACLE_ADDRESS,
} as const;

/** Anchor-record shape, for `buildAnchorRecord`. */
export const TEST_ANCHOR_ORACLE = {
  address: TEST_ORACLE_ADDRESS,
  chainId: TEST_CHAIN_ID,
} as const;

/**
 * A stand-in for the hosted facilitator, so the protocol-shape tests run with
 * no network and no funded account.
 *
 * It records whether `/settle` was ever called, which is the assertion the free
 * refusal rests on. The live suite makes the same assertion against the public
 * mirror node instead; both are needed, because this one proves we never asked
 * and that one proves nothing moved.
 */
export interface StubFacilitator {
  url: string;
  calls: { verify: number; settle: number; supported: number };
  settleRequests: unknown[];
  close(): Promise<void>;
}

export async function startStubFacilitator(
  options: { payer?: string; transactionId?: string } = {},
): Promise<StubFacilitator> {
  const payer = options.payer ?? "0.0.999002";
  const transactionId = options.transactionId ?? `${TEST_FEE_PAYER}@1788800815.386309402`;
  const calls = { verify: 0, settle: 0, supported: 0 };
  const settleRequests: unknown[] = [];

  const server = createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      const payload = JSON.stringify(body);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(payload);
    };

    if (req.method === "GET" && req.url?.startsWith("/supported")) {
      calls.supported++;
      return send(200, {
        kinds: [
          {
            x402Version: 2,
            scheme: "exact",
            network: "hedera:testnet",
            extra: { feePayer: TEST_FEE_PAYER },
          },
        ],
        extensions: [],
        signers: { "hedera:*": [TEST_FEE_PAYER] },
      });
    }
    if (req.method === "GET" && req.url?.startsWith("/health")) return send(200, { status: "ok" });

    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      if (req.url?.startsWith("/verify")) {
        calls.verify++;
        return send(200, { isValid: true, payer });
      }
      if (req.url?.startsWith("/settle")) {
        calls.settle++;
        settleRequests.push(body);
        return send(200, {
          success: true,
          transaction: transactionId,
          network: "hedera:testnet",
          payer,
        });
      }
      send(404, { error: "not found" });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    settleRequests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A mirror node whose entire contents are whatever a test hands it. */
export interface StubMirror {
  url: string;
  transactions: Map<string, MirrorTransaction>;
  topicMessages: Map<string, MirrorTopicMessage>;
  accountTransfers: MirrorTransaction[];
  close(): Promise<void>;
}

export async function startStubMirror(): Promise<StubMirror> {
  const transactions = new Map<string, MirrorTransaction>();
  const topicMessages = new Map<string, MirrorTopicMessage>();
  const accountTransfers: MirrorTransaction[] = [];

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    const txMatch = url.pathname.match(/^\/api\/v1\/transactions\/(.+)$/);
    if (txMatch) {
      const found = transactions.get(decodeURIComponent(txMatch[1]!));
      return found ? send(200, { transactions: [found] }) : send(404, { _status: { messages: [] } });
    }
    if (url.pathname === "/api/v1/transactions") {
      // The real mirror node honours timestamp=gte:/lte:, and the verifier now
      // relies on that: an absence is only meaningful inside a stated window. A
      // stub that returned everything regardless would let a test pass for a
      // transfer that happened at a completely different time.
      const bounds = url.searchParams.getAll("timestamp");
      const lower = seconds(bounds.find((b) => b.startsWith("gte:")));
      const upper = seconds(bounds.find((b) => b.startsWith("lte:")));
      const within = accountTransfers.filter((tx) => {
        const at = Number(tx.consensus_timestamp);
        return (lower === null || at >= lower) && (upper === null || at <= upper);
      });
      return send(200, { transactions: within });
    }
    const topicMatch = url.pathname.match(/^\/api\/v1\/topics\/([^/]+)\/messages\/(\d+)$/);
    if (topicMatch) {
      const found = topicMessages.get(`${topicMatch[1]}:${topicMatch[2]}`);
      return found ? send(200, found) : send(404, {});
    }
    const listMatch = url.pathname.match(/^\/api\/v1\/topics\/([^/]+)\/messages$/);
    if (listMatch) {
      const prefix = `${listMatch[1]}:`;
      const messages = [...topicMessages.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([, value]) => value)
        .sort((a, b) => b.sequence_number - a.sequence_number);
      return send(200, { messages });
    }
    send(404, {});
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    transactions,
    topicMessages,
    accountTransfers,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function seconds(bound: string | undefined): number | null {
  if (!bound) return null;
  const value = Number(bound.slice(bound.indexOf(":") + 1));
  return Number.isFinite(value) ? value : null;
}

export function stubMirrorTransaction(args: {
  transactionId: string;
  payer: string;
  payTo: string;
  amount: number;
  result?: string;
  name?: string;
}): MirrorTransaction {
  // Consensus is taken from the id's valid-start rather than being a constant,
  // so two stub transactions with different ids land at different times. With a
  // fixed timestamp every transfer sits in every window, and a test asserting
  // that one is out of range would pass for the wrong reason.
  const validStart = args.transactionId.split("@")[1];
  return {
    transaction_id: args.transactionId.replace("@", "-").replace(/\.(\d+)$/, "-$1"),
    name: args.name ?? "CRYPTOTRANSFER",
    result: args.result ?? "SUCCESS",
    consensus_timestamp: validStart ?? "1788800817.123456789",
    charged_tx_fee: 51000,
    transfers: [
      { account: args.payer, amount: -args.amount },
      { account: args.payTo, amount: args.amount },
      { account: TEST_FEE_PAYER, amount: -51000 },
    ],
  };
}

export function sellerConfig(overrides: Partial<SellerConfig> = {}): SellerConfig {
  return {
    payTo: TEST_PAY_TO,
    facilitatorUrl: "http://127.0.0.1:1",
    amountTinybar: "100000",
    network: "hedera:testnet",
    port: 0,
    publicBaseUrl: "http://localhost:0",
    attestorPrivateKey: TEST_ATTESTOR_KEY,
    oracle: { address: TEST_ORACLE_ADDRESS, chainId: TEST_CHAIN_ID },
    coverageSource: "fixture",
    substreamsEndpoint: undefined,
    anchor: null,
    dataDir: "data/test",
    ...overrides,
  };
}

/**
 * A payment-capable fetch backed by a freshly generated key.
 *
 * The account behind it does not exist and holds nothing, which is fine: the
 * `exact` client scheme builds and signs a TransferTransaction entirely
 * offline, and the stub facilitator is what would otherwise object.
 */
export function payingFetch(accountId = "0.0.999002"): {
  fetch: typeof globalThis.fetch;
  accountId: string;
} {
  const signer = createClientHederaSigner(accountId, PrivateKey.generateECDSA(), {
    network: "hedera:testnet",
  });
  const client = new x402Client().register("hedera:testnet", new ExactHederaScheme(signer));
  // Native HBAR is not a default asset, so it has to be allowlisted explicitly.
  client.setSpendControls({
    allowedAssets: [{ network: "hedera:testnet", asset: "0.0.0", maxAmountPerPayment: "1000000" }],
  });
  return { fetch: wrapFetchWithPayment(globalThis.fetch, client), accountId };
}

export async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** Announce a skip loudly, so a missing credential is never mistaken for a pass. */
export function skipMessage(what: string, missing: string[]): string {
  return `SKIPPED (${what}): set ${missing.join(", ")} to run this against the live network`;
}
