/**
 * Decoding a Hedera `Key` well enough to see whose key it is.
 *
 * The mirror node renders a contract-ID key as `ProtobufEncoded` hex rather than
 * naming the contract, because it is not an ed25519 or ECDSA key it knows how to
 * print. Whether the cash token's freeze key belongs to our controller is the
 * whole point of check 4, so the bytes have to be read. The subset of the
 * `Key` message needed here is two fields:
 *
 *   Key        { ContractID contractID = 1; ContractID delegatable_contract_id = 8; ... }
 *   ContractID { int64 shardNum = 1; int64 realmNum = 2; int64 contractNum = 3; bytes evm_address = 4; }
 */

export interface ContractKey {
  kind: "contract" | "delegatable-contract";
  id: string;
}

export function decodeContractKey(hex: string): ContractKey | null {
  const bytes = Buffer.from(hex.replace(/^0x/, ""), "hex");
  if (bytes.length === 0) return null;
  let offset = 0;

  const varint = (): bigint => {
    let value = 0n;
    let shift = 0n;
    while (offset < bytes.length) {
      const byte = bytes[offset++]!;
      value |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return value;
      shift += 7n;
    }
    throw new Error("truncated varint");
  };

  try {
    const tag = Number(varint());
    const field = tag >> 3;
    const wire = tag & 7;
    // Anything other than a length-delimited contractID or delegatable id is
    // some other kind of key, and not what the record claims.
    if (wire !== 2 || (field !== 1 && field !== 8)) return null;
    const length = Number(varint());
    const end = offset + length;
    if (end !== bytes.length) return null;

    let shard = 0n;
    let realm = 0n;
    let num: bigint | null = null;
    while (offset < end) {
      const innerTag = Number(varint());
      const innerField = innerTag >> 3;
      const innerWire = innerTag & 7;
      if (innerWire === 0) {
        const value = varint();
        if (innerField === 1) shard = value;
        else if (innerField === 2) realm = value;
        else if (innerField === 3) num = value;
      } else if (innerWire === 2) {
        // An evm_address-form contract id: real, but not a numbered contract
        // we can compare against the record.
        offset += Number(varint());
      } else {
        return null;
      }
    }
    if (offset !== end || num === null) return null;
    return { kind: field === 1 ? "contract" : "delegatable-contract", id: `${shard}.${realm}.${num}` };
  } catch {
    return null;
  }
}

/** The inverse, used by the tests to build keys that name other contracts. */
export function encodeContractKey(contractNum: bigint, field: 1 | 8 = 1): string {
  const varint = (value: bigint): number[] => {
    const out: number[] = [];
    let rest = value;
    do {
      let byte = Number(rest & 0x7fn);
      rest >>= 7n;
      if (rest > 0n) byte |= 0x80;
      out.push(byte);
    } while (rest > 0n);
    return out;
  };
  const inner = [0x18, ...varint(contractNum)];
  return Buffer.from([(field << 3) | 2, inner.length, ...inner]).toString("hex");
}

/** The mirror node's rendering of a key: `{ _type, key }` or null. */
export function describeMirrorKey(key: { _type?: string; key?: string } | null | undefined): {
  present: boolean;
  contract: ContractKey | null;
  type: string | null;
} {
  if (!key) return { present: false, contract: null, type: null };
  const contract = key._type === "ProtobufEncoded" && key.key ? decodeContractKey(key.key) : null;
  return { present: true, contract, type: key._type ?? null };
}
