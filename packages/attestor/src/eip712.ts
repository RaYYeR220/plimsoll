import {
  hashTypedData,
  recoverTypedDataAddress,
  type Address,
  type Hex,
  type TypedDataDomain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { REFUSAL_FAMILY_CODE, type RefusalFamily, type RefusalReason } from "./reasons.js";

/**
 * Hedera testnet. The domain is bound to a chain even though nothing is
 * verified on-chain today, so that a future settlement contract on 296 can
 * accept these signatures unchanged. There is no `verifyingContract`: naming a
 * zero address would imply a deployment that does not exist.
 */
export const ATTESTOR_DOMAIN: TypedDataDomain = {
  name: "Plimsoll Attestor",
  version: "1",
  chainId: 296,
};

/**
 * `noteId` is an EIP-712 `string`, not a bytes32. Note identifiers are
 * human-readable and a judge reading a receipt should see `NOTE-ALPHA`, not a
 * digest they cannot invert. EIP-712 hashes strings itself, so nothing is lost.
 */
export const ATTESTATION_TYPES = {
  Attestation: [
    { name: "noteId", type: "string" },
    { name: "coverageBps", type: "uint32" },
    { name: "asOfBlock", type: "uint64" },
    { name: "vaultSetHash", type: "bytes32" },
    { name: "sourceHash", type: "bytes32" },
    { name: "expiry", type: "uint64" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/**
 * Refusals are two separate EIP-712 types, not one type with a flag.
 *
 * The earlier design signed a single `Refusal` struct and set `coverageBps` to
 * zero when no ratio was known. A struct field cannot be absent, so "we could
 * not tell" was encoded as the number 0 — which reads as zero percent coverage,
 * i.e. maximally under-backed, and is byte-identical to a genuine
 * `no_attributable_positions` finding. A consumer reading the figure without
 * also reading the flag drew the worst possible conclusion, and the failure was
 * unsafe in that direction.
 *
 * Splitting the type removes the field rather than zeroing it.
 * `EvidenceRefusal` has nowhere to put a ratio, so there is no value to
 * misread, and because the primary type name is hashed into the EIP-712
 * typeHash, a signature over an evidence refusal cannot be re-encoded as a
 * ratio-bearing one: recovery would yield a different address. The distinction
 * between the two families is therefore cryptographic, not advisory.
 */
export const ASSET_REFUSAL_TYPES = {
  AssetRefusal: [
    { name: "noteId", type: "string" },
    { name: "reason", type: "string" },
    // Asset findings may still decline to quote a ratio: an issuer who
    // overstated their holdings gets a finding, not a coverage figure.
    { name: "coverageKnown", type: "bool" },
    { name: "coverageBps", type: "uint32" },
    { name: "asOfBlock", type: "uint64" },
    { name: "vaultSetHash", type: "bytes32" },
    { name: "sourceHash", type: "bytes32" },
    { name: "expiry", type: "uint64" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/** No ratio, no block, no hashes. There is nothing here to misread as coverage. */
export const EVIDENCE_REFUSAL_TYPES = {
  EvidenceRefusal: [
    { name: "noteId", type: "string" },
    { name: "reason", type: "string" },
    { name: "expiry", type: "uint64" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export interface AttestationMessage {
  noteId: string;
  coverageBps: number;
  asOfBlock: bigint;
  vaultSetHash: Hex;
  sourceHash: Hex;
  expiry: bigint;
  nonce: Hex;
}

export interface AssetRefusalMessage {
  noteId: string;
  reason: RefusalReason;
  coverageKnown: boolean;
  coverageBps: number;
  asOfBlock: bigint;
  vaultSetHash: Hex;
  sourceHash: Hex;
  expiry: bigint;
  nonce: Hex;
}

export interface EvidenceRefusalMessage {
  noteId: string;
  reason: RefusalReason;
  expiry: bigint;
  nonce: Hex;
}

export type RefusalMessage = AssetRefusalMessage | EvidenceRefusalMessage;

/** True when a signed refusal is the ratio-bearing kind. */
export function isAssetRefusalMessage(m: RefusalMessage): m is AssetRefusalMessage {
  return "coverageKnown" in m;
}

export function familyCode(family: RefusalFamily): number {
  return REFUSAL_FAMILY_CODE[family];
}

export interface AttestorSigner {
  readonly address: Address;
  signAttestation(message: AttestationMessage): Promise<Hex>;
  signRefusal(message: RefusalMessage): Promise<Hex>;
}

/**
 * Dispatch on the message shape rather than on a caller-supplied family, so the
 * type that gets signed is always the one the payload can actually populate.
 */
function refusalTypedData(message: RefusalMessage) {
  return isAssetRefusalMessage(message)
    ? { domain: ATTESTOR_DOMAIN, types: ASSET_REFUSAL_TYPES, primaryType: "AssetRefusal" as const, message }
    : {
        domain: ATTESTOR_DOMAIN,
        types: EVIDENCE_REFUSAL_TYPES,
        primaryType: "EvidenceRefusal" as const,
        message,
      };
}

export function createAttestorSigner(privateKey: Hex): AttestorSigner {
  const account = privateKeyToAccount(privateKey);
  return {
    address: account.address,
    signAttestation: (message) =>
      account.signTypedData({
        domain: ATTESTOR_DOMAIN,
        types: ATTESTATION_TYPES,
        primaryType: "Attestation",
        message,
      }),
    signRefusal: (message) => account.signTypedData(refusalTypedData(message) as never),
  };
}

export function attestationDigest(message: AttestationMessage): Hex {
  return hashTypedData({
    domain: ATTESTOR_DOMAIN,
    types: ATTESTATION_TYPES,
    primaryType: "Attestation",
    message,
  });
}

export function refusalDigest(message: RefusalMessage): Hex {
  return hashTypedData(refusalTypedData(message) as never);
}

export function recoverAttestationSigner(
  message: AttestationMessage,
  signature: Hex,
): Promise<Address> {
  return recoverTypedDataAddress({
    domain: ATTESTOR_DOMAIN,
    types: ATTESTATION_TYPES,
    primaryType: "Attestation",
    message,
    signature,
  });
}

export function recoverRefusalSigner(message: RefusalMessage, signature: Hex): Promise<Address> {
  return recoverTypedDataAddress({ ...refusalTypedData(message), signature } as never);
}

/** Wire form: bigints become decimal strings so a verdict survives JSON intact. */
export function attestationToWire(m: AttestationMessage): Record<string, unknown> {
  return { ...m, asOfBlock: m.asOfBlock.toString(), expiry: m.expiry.toString() };
}

export function attestationFromWire(w: Record<string, unknown>): AttestationMessage {
  return {
    noteId: String(w.noteId),
    coverageBps: Number(w.coverageBps),
    asOfBlock: BigInt(String(w.asOfBlock)),
    vaultSetHash: w.vaultSetHash as Hex,
    sourceHash: w.sourceHash as Hex,
    expiry: BigInt(String(w.expiry)),
    nonce: w.nonce as Hex,
  };
}

export function refusalToWire(m: RefusalMessage): Record<string, unknown> {
  if (isAssetRefusalMessage(m)) {
    return { ...m, asOfBlock: m.asOfBlock.toString(), expiry: m.expiry.toString() };
  }
  // Note what is absent: no coverageBps, no asOfBlock, no hashes. The wire form
  // mirrors the signed struct exactly, so nothing can be reintroduced here that
  // the signature does not cover.
  return { noteId: m.noteId, reason: m.reason, expiry: m.expiry.toString(), nonce: m.nonce };
}

/**
 * Rebuild a signed refusal from its wire form.
 *
 * The shape decides the type: a payload carrying `coverageKnown` is an asset
 * finding, anything else is an evidence statement. Reconstructing an evidence
 * refusal as an `AssetRefusal` would change the typeHash and fail recovery,
 * which is the property that makes the two families non-interchangeable.
 */
export function refusalFromWire(w: Record<string, unknown>): RefusalMessage {
  if (!("coverageKnown" in w)) {
    return {
      noteId: String(w.noteId),
      reason: String(w.reason) as RefusalReason,
      expiry: BigInt(String(w.expiry)),
      nonce: w.nonce as Hex,
    };
  }
  return {
    noteId: String(w.noteId),
    reason: String(w.reason) as RefusalReason,
    coverageKnown: Boolean(w.coverageKnown),
    coverageBps: Number(w.coverageBps),
    asOfBlock: BigInt(String(w.asOfBlock)),
    vaultSetHash: w.vaultSetHash as Hex,
    sourceHash: w.sourceHash as Hex,
    expiry: BigInt(String(w.expiry)),
    nonce: w.nonce as Hex,
  };
}
