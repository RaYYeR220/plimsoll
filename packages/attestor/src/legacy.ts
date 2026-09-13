import { recoverTypedDataAddress, type Address, type Hex, type TypedDataDomain } from "viem";
import type { RefusalReason } from "./reasons.js";

/**
 * Retired signing formats, kept only so history stays checkable.
 *
 * Nothing signs with any of these any more. The HCS topic has no admin key, so
 * the records written under them cannot be withdrawn and a verifier that
 * forgot their types would report every historical verdict as forged. They live
 * here, apart from the current format, so there is no chance of reaching for
 * one by accident.
 *
 * v1 and v2 both signed under a domain of this service's own invention. That
 * was the bug: the domain named no contract, so a signature was not bound to
 * the oracle that would have to accept it, and the field types disagreed with
 * the oracle's struct in five places. v3 adopts the contract's format.
 */
export const RETIRED_DOMAIN: TypedDataDomain = {
  name: "Plimsoll Attestor",
  version: "1",
  chainId: 296,
};

/** v1: one refusal struct for both families, with the family as a number. */
export const V1_REFUSAL_TYPES = {
  Refusal: [
    { name: "noteId", type: "string" },
    { name: "family", type: "uint8" },
    { name: "reason", type: "string" },
    { name: "coverageKnown", type: "bool" },
    { name: "coverageBps", type: "uint32" },
    { name: "asOfBlock", type: "uint64" },
    { name: "vaultSetHash", type: "bytes32" },
    { name: "sourceHash", type: "bytes32" },
    { name: "expiry", type: "uint64" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/** v1 and v2 shared this attestation struct: a string id and a random nonce. */
export const RETIRED_ATTESTATION_TYPES = {
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

/** v2 split the refusal in two, which v3 keeps. */
export const V2_ASSET_REFUSAL_TYPES = {
  AssetRefusal: [
    { name: "noteId", type: "string" },
    { name: "reason", type: "string" },
    { name: "coverageKnown", type: "bool" },
    { name: "coverageBps", type: "uint32" },
    { name: "asOfBlock", type: "uint64" },
    { name: "vaultSetHash", type: "bytes32" },
    { name: "sourceHash", type: "bytes32" },
    { name: "expiry", type: "uint64" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export const V2_EVIDENCE_REFUSAL_TYPES = {
  EvidenceRefusal: [
    { name: "noteId", type: "string" },
    { name: "reason", type: "string" },
    { name: "expiry", type: "uint64" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export interface RetiredAttestationMessage {
  noteId: string;
  coverageBps: number;
  asOfBlock: bigint;
  vaultSetHash: Hex;
  sourceHash: Hex;
  expiry: bigint;
  nonce: Hex;
}

export interface V1RefusalMessage {
  noteId: string;
  family: number;
  reason: RefusalReason;
  coverageKnown: boolean;
  coverageBps: number;
  asOfBlock: bigint;
  vaultSetHash: Hex;
  sourceHash: Hex;
  expiry: bigint;
  nonce: Hex;
}

export interface V2AssetRefusalMessage {
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

export interface V2EvidenceRefusalMessage {
  noteId: string;
  reason: RefusalReason;
  expiry: bigint;
  nonce: Hex;
}

/** The v1 payload is the only one carrying a numeric `family` field. */
export function isV1RefusalWire(wire: Record<string, unknown>): boolean {
  return "family" in wire;
}

export function retiredAttestationFromWire(wire: Record<string, unknown>): RetiredAttestationMessage {
  return {
    noteId: String(wire.noteId),
    coverageBps: Number(wire.coverageBps),
    asOfBlock: BigInt(String(wire.asOfBlock)),
    vaultSetHash: wire.vaultSetHash as Hex,
    sourceHash: wire.sourceHash as Hex,
    expiry: BigInt(String(wire.expiry)),
    nonce: wire.nonce as Hex,
  };
}

export function v1RefusalFromWire(wire: Record<string, unknown>): V1RefusalMessage {
  return {
    noteId: String(wire.noteId),
    family: Number(wire.family),
    reason: String(wire.reason) as RefusalReason,
    coverageKnown: Boolean(wire.coverageKnown),
    coverageBps: Number(wire.coverageBps),
    asOfBlock: BigInt(String(wire.asOfBlock)),
    vaultSetHash: wire.vaultSetHash as Hex,
    sourceHash: wire.sourceHash as Hex,
    expiry: BigInt(String(wire.expiry)),
    nonce: wire.nonce as Hex,
  };
}

export function v2RefusalFromWire(
  wire: Record<string, unknown>,
): V2AssetRefusalMessage | V2EvidenceRefusalMessage {
  if (!("coverageKnown" in wire)) {
    return {
      noteId: String(wire.noteId),
      reason: String(wire.reason) as RefusalReason,
      expiry: BigInt(String(wire.expiry)),
      nonce: wire.nonce as Hex,
    };
  }
  return {
    noteId: String(wire.noteId),
    reason: String(wire.reason) as RefusalReason,
    coverageKnown: Boolean(wire.coverageKnown),
    coverageBps: Number(wire.coverageBps),
    asOfBlock: BigInt(String(wire.asOfBlock)),
    vaultSetHash: wire.vaultSetHash as Hex,
    sourceHash: wire.sourceHash as Hex,
    expiry: BigInt(String(wire.expiry)),
    nonce: wire.nonce as Hex,
  };
}

export function recoverRetiredAttestationSigner(
  message: RetiredAttestationMessage,
  signature: Hex,
): Promise<Address> {
  return recoverTypedDataAddress({
    domain: RETIRED_DOMAIN,
    types: RETIRED_ATTESTATION_TYPES,
    primaryType: "Attestation",
    message,
    signature,
  });
}

export function recoverV1RefusalSigner(message: V1RefusalMessage, signature: Hex): Promise<Address> {
  return recoverTypedDataAddress({
    domain: RETIRED_DOMAIN,
    types: V1_REFUSAL_TYPES,
    primaryType: "Refusal",
    message,
    signature,
  });
}

export function recoverV2RefusalSigner(
  message: V2AssetRefusalMessage | V2EvidenceRefusalMessage,
  signature: Hex,
): Promise<Address> {
  const typed =
    "coverageKnown" in message
      ? { domain: RETIRED_DOMAIN, types: V2_ASSET_REFUSAL_TYPES, primaryType: "AssetRefusal" as const, message }
      : { domain: RETIRED_DOMAIN, types: V2_EVIDENCE_REFUSAL_TYPES, primaryType: "EvidenceRefusal" as const, message };
  return recoverTypedDataAddress({ ...typed, signature } as never);
}
