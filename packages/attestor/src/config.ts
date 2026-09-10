import type { Hex } from "viem";
import type { CoverageSourceKind } from "./coverage/index.js";

/** Missing configuration is always fatal here; nothing has a silent default. */
export class ConfigError extends Error {
  constructor(variable: string, why: string) {
    super(`${variable}: ${why}`);
    this.name = "ConfigError";
  }
}

export interface SellerConfig {
  payTo: string;
  facilitatorUrl: string;
  amountTinybar: string;
  network: "hedera:testnet";
  port: number;
  publicBaseUrl: string;
  attestorPrivateKey: Hex;
  coverageSource: CoverageSourceKind;
  substreamsEndpoint: string | undefined;
  anchor: AnchorConfig | null;
  dataDir: string;
}

export interface AnchorConfig {
  operatorId: string;
  operatorKey: string;
  topicId: string;
  network: "testnet" | "mainnet";
}

const HEDERA_ID = /^\d+\.\d+\.\d+$/;

function required(name: string, value: string | undefined): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) throw new ConfigError(name, "is required but was not set");
  return trimmed;
}

function hederaId(name: string, value: string | undefined): string {
  const id = required(name, value);
  if (!HEDERA_ID.test(id)) throw new ConfigError(name, `expected a Hedera id like 0.0.1234, got ${id}`);
  return id;
}

/**
 * secp256k1 only.
 *
 * An ED25519 key is accepted by the Hedera SDK but produces no EVM address, so
 * every EVM-adjacent thing downstream (EIP-712 recovery, ERC-8004 calls) fails
 * later and further away. Rejecting the wrong curve at load time is worth the
 * strictness.
 */
function ecdsaKey(name: string, value: string | undefined): Hex {
  const raw = required(name, value);
  const hex = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
    throw new ConfigError(name, "expected a 32-byte secp256k1 key in hex (ED25519 is not usable here)");
  }
  return hex as Hex;
}

export function loadSellerConfig(env: NodeJS.ProcessEnv = process.env): SellerConfig {
  const anchorVars = [env.HEDERA_ACCOUNT_ID, env.HEDERA_PRIVATE_KEY, env.HCS_TOPIC_ID];
  const anchorRequested = anchorVars.some((v) => (v ?? "").trim().length > 0);

  return {
    payTo: hederaId("PAY_TO", env.PAY_TO),
    facilitatorUrl: (env.FACILITATOR_URL ?? "https://api.testnet.blocky402.com").trim(),
    amountTinybar: (env.AMOUNT_TINYBAR ?? "100000").trim(),
    network: "hedera:testnet",
    port: Number(env.PORT ?? 4021),
    publicBaseUrl: (env.PUBLIC_BASE_URL ?? `http://localhost:${env.PORT ?? 4021}`).replace(/\/$/, ""),
    attestorPrivateKey: ecdsaKey("ATTESTOR_PRIVATE_KEY", env.ATTESTOR_PRIVATE_KEY),
    coverageSource: (env.COVERAGE_SOURCE ?? "fixture") as CoverageSourceKind,
    substreamsEndpoint: env.SUBSTREAMS_ENDPOINT?.trim() || undefined,
    // Anchoring is optional, but half-configured anchoring is not: partial
    // credentials mean a receipt silently never reaches the topic.
    anchor: anchorRequested
      ? {
          operatorId: hederaId("HEDERA_ACCOUNT_ID", env.HEDERA_ACCOUNT_ID),
          operatorKey: required("HEDERA_PRIVATE_KEY", env.HEDERA_PRIVATE_KEY),
          topicId: hederaId("HCS_TOPIC_ID", env.HCS_TOPIC_ID),
          network: (env.HEDERA_NETWORK ?? "testnet") as "testnet" | "mainnet",
        }
      : null,
    dataDir: (env.DATA_DIR ?? "data").trim(),
  };
}

export interface BuyerConfig {
  accountId: string;
  privateKey: string;
  attestorUrl: string;
  network: "hedera:testnet";
  agentId: bigint | null;
  skipFeedback: boolean;
  evmRpcUrl: string;
  /** Atomic per-payment ceiling handed to the client's spend controls. */
  maxTinybarPerCall: string;
  /** Public identity of the service, recorded in ERC-8004 feedback. */
  canonicalUrl: string;
}

export function loadBuyerConfig(env: NodeJS.ProcessEnv = process.env): BuyerConfig {
  const agentId = (env.ATTESTOR_AGENT_ID ?? "").trim();
  return {
    accountId: hederaId("BUYER_ACCOUNT_ID", env.BUYER_ACCOUNT_ID),
    privateKey: required("BUYER_PRIVATE_KEY", env.BUYER_PRIVATE_KEY),
    attestorUrl: (env.ATTESTOR_URL ?? "http://localhost:4021").replace(/\/$/, ""),
    network: "hedera:testnet",
    agentId: agentId ? BigInt(agentId) : null,
    skipFeedback: (env.BUYER_SKIP_FEEDBACK ?? "").trim().length > 0,
    evmRpcUrl: (env.EVM_RPC_URL ?? "https://testnet.hashio.io/api").trim(),
    maxTinybarPerCall: (env.BUYER_MAX_TINYBAR ?? "1000000").trim(),
    // Feedback should name the service, not whichever host the buyer happened to
    // reach it on, so a localhost demo does not publish a localhost endpoint.
    canonicalUrl: (env.PUBLIC_BASE_URL ?? env.ATTESTOR_URL ?? "http://localhost:4021").replace(
      /\/$/,
      "",
    ),
  };
}

/** True when a live-network test has everything it needs. */
export function hasLiveCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    (env.PAY_TO ?? "").trim() &&
      (env.BUYER_ACCOUNT_ID ?? "").trim() &&
      (env.BUYER_PRIVATE_KEY ?? "").trim() &&
      (env.ATTESTOR_PRIVATE_KEY ?? "").trim(),
  );
}

export function hasAnchorCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    (env.HEDERA_ACCOUNT_ID ?? "").trim() &&
      (env.HEDERA_PRIVATE_KEY ?? "").trim() &&
      (env.HCS_TOPIC_ID ?? "").trim(),
  );
}
