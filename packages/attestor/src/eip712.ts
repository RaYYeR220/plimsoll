import {
  hashTypedData,
  keccak256,
  recoverTypedDataAddress,
  toHex,
  type Address,
  type Hex,
  type TypedDataDomain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { RefusalReason } from "./reasons.js";

/**
 * The attestation format is not ours to choose.
 *
 * `CoverageOracle` recovers the signer from this exact struct, so a service
 * that signs anything else produces attestations that can never be accepted on
 * chain. An earlier version of this file chose its own domain, a `string`
 * note id, a `uint32` coverage and a random `bytes32` nonce; every one of those
 * differences was enough on its own to make the digest disagree, and nothing
 * caught it because both sides were written by hand and never compared.
 *
 * So the type string below is copied verbatim from
 * `packages/contracts/src/CoverageOracle.sol`, and `test/typed-data.test.ts`
 * holds it to that: it fails if the string is no longer in that file, and it
 * asks the deployed contract's own `hashAttestation` whether our digest matches
 * for a spread of values. A typehash nobody cross-checks is how this broke.
 */
export const ATTESTATION_TYPE_STRING =
  "Attestation(bytes32 noteId,uint64 coverageBps,uint64 asOfBlock,bytes32 vaultSetHash,bytes32 sourceHash,uint64 expiry,uint64 nonce)";

export const ATTESTATION_TYPEHASH = keccak256(toHex(ATTESTATION_TYPE_STRING));

export const ATTESTATION_TYPES = {
  Attestation: [
    { name: "noteId", type: "bytes32" },
    { name: "coverageBps", type: "uint64" },
    { name: "asOfBlock", type: "uint64" },
    { name: "vaultSetHash", type: "bytes32" },
    { name: "sourceHash", type: "bytes32" },
    { name: "expiry", type: "uint64" },
    { name: "nonce", type: "uint64" },
  ],
} as const;

/**
 * Refusals keep the two separate types, because the distinction between a
 * finding about the asset and an admission about our own evidence is the
 * product. They are not consumed on chain, but they carry the same widths and
 * the same note id type, so there is only ever one shape of attestation data in
 * this service rather than two that could drift apart again.
 */
export const ASSET_REFUSAL_TYPES = {
  AssetRefusal: [
    { name: "noteId", type: "bytes32" },
    { name: "reason", type: "string" },
    // An asset finding may still decline to quote a ratio: an issuer who
    // overstated their holdings gets a finding, not a coverage figure.
    { name: "coverageKnown", type: "bool" },
    { name: "coverageBps", type: "uint64" },
    { name: "asOfBlock", type: "uint64" },
    { name: "vaultSetHash", type: "bytes32" },
    { name: "sourceHash", type: "bytes32" },
    { name: "expiry", type: "uint64" },
    { name: "nonce", type: "uint64" },
  ],
} as const;

/** No ratio, no block, no hashes. There is nothing here to misread as coverage. */
export const EVIDENCE_REFUSAL_TYPES = {
  EvidenceRefusal: [
    { name: "noteId", type: "bytes32" },
    { name: "reason", type: "string" },
    { name: "expiry", type: "uint64" },
    { name: "nonce", type: "uint64" },
  ],
} as const;

/**
 * The domain binds a signature to one oracle on one chain. That is the replay
 * protection that matters across redeploys: an attestation signed for a
 * previous oracle cannot be presented to its replacement.
 */
export interface OracleDomain {
  chainId: number;
  verifyingContract: Address;
}

export const DOMAIN_NAME = "Plimsoll CoverageOracle";
export const DOMAIN_VERSION = "1";

export function attestorDomain(oracle: OracleDomain): TypedDataDomain {
  return {
    name: DOMAIN_NAME,
    version: DOMAIN_VERSION,
    chainId: oracle.chainId,
    verifyingContract: oracle.verifyingContract,
  };
}

/** A note id is the keccak of its market code, the same string a human reads. */
export function noteIdOf(label: string): Hex {
  return keccak256(toHex(label));
}

export interface AttestationMessage {
  noteId: Hex;
  coverageBps: bigint;
  asOfBlock: bigint;
  vaultSetHash: Hex;
  sourceHash: Hex;
  expiry: bigint;
  nonce: bigint;
}

export interface AssetRefusalMessage {
  noteId: Hex;
  reason: RefusalReason;
  coverageKnown: boolean;
  coverageBps: bigint;
  asOfBlock: bigint;
  vaultSetHash: Hex;
  sourceHash: Hex;
  expiry: bigint;
  nonce: bigint;
}

export interface EvidenceRefusalMessage {
  noteId: Hex;
  reason: RefusalReason;
  expiry: bigint;
  nonce: bigint;
}

export type RefusalMessage = AssetRefusalMessage | EvidenceRefusalMessage;

/** True when a signed refusal is the ratio-bearing kind. */
export function isAssetRefusalMessage(message: RefusalMessage): message is AssetRefusalMessage {
  return "coverageKnown" in message;
}

export interface AttestorSigner {
  readonly address: Address;
  readonly domain: TypedDataDomain;
  signAttestation(message: AttestationMessage): Promise<Hex>;
  signRefusal(message: RefusalMessage): Promise<Hex>;
}

function refusalTypedData(domain: TypedDataDomain, message: RefusalMessage) {
  return isAssetRefusalMessage(message)
    ? { domain, types: ASSET_REFUSAL_TYPES, primaryType: "AssetRefusal" as const, message }
    : { domain, types: EVIDENCE_REFUSAL_TYPES, primaryType: "EvidenceRefusal" as const, message };
}

export function createAttestorSigner(privateKey: Hex, oracle: OracleDomain): AttestorSigner {
  const account = privateKeyToAccount(privateKey);
  const domain = attestorDomain(oracle);
  return {
    address: account.address,
    domain,
    signAttestation: (message) =>
      account.signTypedData({ domain, types: ATTESTATION_TYPES, primaryType: "Attestation", message }),
    signRefusal: (message) => account.signTypedData(refusalTypedData(domain, message) as never),
  };
}

/** The digest `CoverageOracle.hashAttestation` returns for the same values. */
export function attestationDigest(domain: TypedDataDomain, message: AttestationMessage): Hex {
  return hashTypedData({ domain, types: ATTESTATION_TYPES, primaryType: "Attestation", message });
}

export function refusalDigest(domain: TypedDataDomain, message: RefusalMessage): Hex {
  return hashTypedData(refusalTypedData(domain, message) as never);
}

export function recoverAttestationSigner(
  domain: TypedDataDomain,
  message: AttestationMessage,
  signature: Hex,
): Promise<Address> {
  return recoverTypedDataAddress({
    domain,
    types: ATTESTATION_TYPES,
    primaryType: "Attestation",
    message,
    signature,
  });
}

export function recoverRefusalSigner(
  domain: TypedDataDomain,
  message: RefusalMessage,
  signature: Hex,
): Promise<Address> {
  return recoverTypedDataAddress({ ...refusalTypedData(domain, message), signature } as never);
}

/** Wire form: every uint64 becomes a decimal string so JSON keeps it exactly. */
export function attestationToWire(message: AttestationMessage): Record<string, unknown> {
  return {
    noteId: message.noteId,
    coverageBps: message.coverageBps.toString(),
    asOfBlock: message.asOfBlock.toString(),
    vaultSetHash: message.vaultSetHash,
    sourceHash: message.sourceHash,
    expiry: message.expiry.toString(),
    nonce: message.nonce.toString(),
  };
}

export function attestationFromWire(wire: Record<string, unknown>): AttestationMessage {
  return {
    noteId: wire.noteId as Hex,
    coverageBps: BigInt(String(wire.coverageBps)),
    asOfBlock: BigInt(String(wire.asOfBlock)),
    vaultSetHash: wire.vaultSetHash as Hex,
    sourceHash: wire.sourceHash as Hex,
    expiry: BigInt(String(wire.expiry)),
    nonce: BigInt(String(wire.nonce)),
  };
}

export function refusalToWire(message: RefusalMessage): Record<string, unknown> {
  if (isAssetRefusalMessage(message)) {
    return {
      noteId: message.noteId,
      reason: message.reason,
      coverageKnown: message.coverageKnown,
      coverageBps: message.coverageBps.toString(),
      asOfBlock: message.asOfBlock.toString(),
      vaultSetHash: message.vaultSetHash,
      sourceHash: message.sourceHash,
      expiry: message.expiry.toString(),
      nonce: message.nonce.toString(),
    };
  }
  // Note what is absent: no coverage, no block, no hashes. The wire form
  // mirrors the signed struct exactly, so nothing can be reintroduced here
  // that the signature does not cover.
  return {
    noteId: message.noteId,
    reason: message.reason,
    expiry: message.expiry.toString(),
    nonce: message.nonce.toString(),
  };
}

/**
 * Rebuild a signed refusal from its wire form. The shape decides the type: a
 * payload carrying `coverageKnown` is an asset finding, anything else is an
 * evidence statement. Reconstructing an evidence refusal as an `AssetRefusal`
 * changes the typehash and fails recovery, which is what makes the two
 * families non-interchangeable.
 */
export function refusalFromWire(wire: Record<string, unknown>): RefusalMessage {
  if (!("coverageKnown" in wire)) {
    return {
      noteId: wire.noteId as Hex,
      reason: String(wire.reason) as RefusalReason,
      expiry: BigInt(String(wire.expiry)),
      nonce: BigInt(String(wire.nonce)),
    };
  }
  return {
    noteId: wire.noteId as Hex,
    reason: String(wire.reason) as RefusalReason,
    coverageKnown: Boolean(wire.coverageKnown),
    coverageBps: BigInt(String(wire.coverageBps)),
    asOfBlock: BigInt(String(wire.asOfBlock)),
    vaultSetHash: wire.vaultSetHash as Hex,
    sourceHash: wire.sourceHash as Hex,
    expiry: BigInt(String(wire.expiry)),
    nonce: BigInt(String(wire.nonce)),
  };
}
