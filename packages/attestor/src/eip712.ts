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
 * The refusal commits to `coverageKnown`. That single bit is the difference
 * between the two families made cryptographic: when we say the asset is short
 * we have signed a ratio we stand behind, and when we say we could not tell we
 * have signed that we had no ratio at all. A verifier can hold us to it.
 */
export const REFUSAL_TYPES = {
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

export interface AttestationMessage {
  noteId: string;
  coverageBps: number;
  asOfBlock: bigint;
  vaultSetHash: Hex;
  sourceHash: Hex;
  expiry: bigint;
  nonce: Hex;
}

export interface RefusalMessage {
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

export function familyCode(family: RefusalFamily): number {
  return REFUSAL_FAMILY_CODE[family];
}

export interface AttestorSigner {
  readonly address: Address;
  signAttestation(message: AttestationMessage): Promise<Hex>;
  signRefusal(message: RefusalMessage): Promise<Hex>;
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
    signRefusal: (message) =>
      account.signTypedData({
        domain: ATTESTOR_DOMAIN,
        types: REFUSAL_TYPES,
        primaryType: "Refusal",
        message,
      }),
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
  return hashTypedData({
    domain: ATTESTOR_DOMAIN,
    types: REFUSAL_TYPES,
    primaryType: "Refusal",
    message,
  });
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
  return recoverTypedDataAddress({
    domain: ATTESTOR_DOMAIN,
    types: REFUSAL_TYPES,
    primaryType: "Refusal",
    message,
    signature,
  });
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
  return { ...m, asOfBlock: m.asOfBlock.toString(), expiry: m.expiry.toString() };
}

export function refusalFromWire(w: Record<string, unknown>): RefusalMessage {
  return {
    noteId: String(w.noteId),
    family: Number(w.family),
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
