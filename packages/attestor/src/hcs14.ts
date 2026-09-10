import { createHash } from "node:crypto";

/**
 * HCS-14 universal agent identifier, `aid` method.
 *
 * Pure offline SHA-384 over a canonical object. No Hedera account, no network
 * call and no dependency: the whole standard fits here, and pulling a registry
 * SDK for it would drag in a second copy of the Hedera SDK and break
 * `instanceof` across the two.
 *
 * One deliberate divergence from the prose: the specification text says to sort
 * keys lexicographically, but the reference implementation emits `skills`
 * first. We follow the implementation, because a hash that disagrees with every
 * other implementation is worse than one that disagrees with the paragraph. The
 * exact bytes hashed are exposed by `canonicalAgentJson` so anyone can check
 * ours against theirs rather than taking it on trust.
 */
export interface AgentIdentity {
  registry: string;
  name: string;
  version: string;
  protocol: string;
  nativeId: string;
  /** Numeric skill ids, sorted ascending before hashing. */
  skills: number[];
}

export function canonicalAgentJson(agent: AgentIdentity): string {
  const canonical = {
    skills: [...(agent.skills ?? [])].sort((a, b) => a - b),
    name: agent.name.trim(),
    nativeId: agent.nativeId.trim(),
    protocol: agent.protocol.toLowerCase().trim(),
    registry: agent.registry.toLowerCase().trim(),
    version: agent.version.trim(),
  };
  return JSON.stringify(canonical);
}

/** The full 48-byte SHA-384 digest, Base58 encoded. No truncation. */
export function agentIdHash(agent: AgentIdentity): string {
  const digest = createHash("sha384").update(canonicalAgentJson(agent), "utf8").digest();
  return base58Encode(digest);
}

export interface UaidOptions {
  /** Disambiguates two otherwise identical agents. */
  uid?: string;
}

export function createUaid(agent: AgentIdentity, options: UaidOptions = {}): string {
  const params = [
    `uid=${options.uid ?? "0"}`,
    `registry=${agent.registry.toLowerCase().trim()}`,
    `proto=${agent.protocol.toLowerCase().trim()}`,
    `nativeId=${agent.nativeId.trim()}`,
  ];
  return `uaid:aid:${agentIdHash(agent)};${params.join(";")}`;
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Base58btc, the Bitcoin alphabet, with leading zero bytes preserved as "1". */
export function base58Encode(bytes: Uint8Array): string {
  let leadingZeros = 0;
  while (leadingZeros < bytes.length && bytes[leadingZeros] === 0) leadingZeros++;

  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);

  let out = "";
  while (value > 0n) {
    const remainder = Number(value % 58n);
    out = BASE58_ALPHABET[remainder] + out;
    value /= 58n;
  }
  return "1".repeat(leadingZeros) + (out || (bytes.length > 0 ? "" : ""));
}
