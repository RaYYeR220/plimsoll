import { ALL_REFUSAL_REASONS, REFUSAL_DESCRIPTIONS, familyOf, httpStatusFor } from "./reasons.js";
import { DEFAULT_POLICY, type CoveragePolicy } from "./policy.js";
import { createUaid, type AgentIdentity } from "./hcs14.js";

export const REGISTRATION_PATH = "/.well-known/agent-registration.json";

export interface RegistrationInput {
  baseUrl: string;
  payTo: string;
  amountTinybar: string;
  attestorAddress: string;
  facilitatorUrl: string;
  topicId: string | null;
  policy?: CoveragePolicy;
}

/**
 * The ERC-8004 registration file, served unpaid.
 *
 * It publishes the refusal taxonomy on purpose. A buyer that knows in advance
 * which outcomes are free, and which of those mean "your asset is short" rather
 * than "our data is down", can back off intelligently instead of retrying into
 * a wall. Advertising the terms is what makes the free refusal a protocol
 * feature rather than a quirk of our error handling.
 */
/**
 * The document that goes on-chain as the ERC-8004 `agentURI`.
 *
 * It is a strict subset of the served registration, small enough to embed in a
 * `data:` URI. Registering a data URI rather than an HTTPS URL is a deliberate
 * trade: `register()` mints an agent id, and re-registering to fix a URL would
 * mint a second identity and split the service's reputation, so the identifier
 * has to be right the first time and stay right. A link to a host we have not
 * deployed yet cannot promise that; a self-contained document can. `canonical`
 * records where the fuller, human-readable version is served once it is hosted.
 */
export function buildOnChainRegistration(input: RegistrationInput): Record<string, unknown> {
  const policy = input.policy ?? DEFAULT_POLICY;
  const full = buildRegistration(input);
  return {
    type: full.type,
    name: full.name,
    description:
      "Signed ERC-4626 coverage attestation for tokenised notes, or a signed refusal at no charge.",
    uaid: full.uaid,
    active: true,
    x402Support: true,
    canonical: `${input.baseUrl}${REGISTRATION_PATH}`,
    services: [
      {
        name: "coverage-attestation",
        endpoint: `${input.baseUrl}/attest`,
        x402: {
          scheme: "exact",
          network: "hedera:testnet",
          asset: "0.0.0",
          amount: input.amountTinybar,
          payTo: input.payTo,
        },
      },
    ],
    attestationSigner: { scheme: "eip712", address: input.attestorAddress, chainId: 296 },
    auditTrail: input.topicId ? { protocol: "hcs", topicId: input.topicId } : null,
    settlement: { chargedOn: [200], freeOn: [422, 424], flow: "authorization" },
    policy: { id: policy.id, floorBps: policy.floorBps },
    // Compact taxonomy: [reason, family, httpStatus]. Never charged, all of them.
    refusals: ALL_REFUSAL_REASONS.map((reason) => [
      reason,
      familyOf(reason),
      httpStatusFor(familyOf(reason)),
    ]),
  };
}

export function buildRegistration(input: RegistrationInput): Record<string, unknown> {
  const policy = input.policy ?? DEFAULT_POLICY;
  const identity: AgentIdentity = {
    registry: "plimsoll",
    name: "Plimsoll Coverage Attestor",
    version: "0.1.0",
    protocol: "x402",
    nativeId: `hedera:testnet:${input.payTo}`,
    skills: [0],
  };

  return {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: identity.name,
    description:
      "Returns a signed attestation of a tokenised note's coverage against its ERC-4626 vault backing, " +
      "or a signed refusal at no charge when coverage cannot be proven.",
    uaid: createUaid(identity),
    active: true,
    x402Support: true,
    services: [
      {
        name: "coverage-attestation",
        endpoint: `${input.baseUrl}/attest`,
        version: "0.1.0",
        method: "GET",
        pricing: {
          protocol: "x402",
          x402Version: 2,
          scheme: "exact",
          network: "hedera:testnet",
          asset: "0.0.0",
          amount: input.amountTinybar,
          payTo: input.payTo,
          facilitator: input.facilitatorUrl,
        },
      },
      { name: "health", endpoint: `${input.baseUrl}/health`, version: "0.1.0", method: "GET" },
    ],
    registrations: [
      {
        agentRegistry: "eip155:296:0x8004A818BFB912233c491871b3d84c89A494BD9e",
        agentAddress: input.attestorAddress,
      },
    ],
    supportedTrust: ["reputation", "crypto-economic"],
    trustModels: {
      attestationSigner: {
        scheme: "eip712",
        address: input.attestorAddress,
        domain: { name: "Plimsoll Attestor", version: "1", chainId: 296 },
      },
      auditTrail: input.topicId
        ? { protocol: "hcs", topicId: input.topicId, format: "plimsoll/coverage@1" }
        : null,
    },
    /**
     * The commitment the whole service rests on, stated where a buyer and a
     * judge can both read it before any money moves.
     */
    settlementPolicy: {
      paymentFlow: "authorization",
      chargedOn: ["200"],
      freeOn: ["4xx", "5xx"],
      statement:
        "Settlement is only requested when an attestation is issued. Any refusal returns a 4xx, " +
        "which cancels settlement before the facilitator is called: the buyer's signed transfer is " +
        "never submitted to a node and simply expires. No charge, no void, no refund, no gas.",
    },
    coveragePolicy: {
      id: policy.id,
      floorBps: policy.floorBps,
      maxStalenessSeconds: policy.maxStalenessSeconds,
      crossSourceToleranceBps: policy.crossSourceToleranceBps,
      attestationTtlSeconds: policy.attestationTtlSeconds,
    },
    refusalTaxonomy: ALL_REFUSAL_REASONS.map((reason) => {
      const family = familyOf(reason);
      return {
        reason,
        family,
        httpStatus: httpStatusFor(family),
        charged: false,
        meaning: REFUSAL_DESCRIPTIONS[reason],
        familyMeaning:
          family === "asset"
            ? "A finding about the asset: coverage was computed and it does not clear."
            : "A statement about our own evidence: no ratio was computed and none is implied.",
      };
    }),
  };
}
