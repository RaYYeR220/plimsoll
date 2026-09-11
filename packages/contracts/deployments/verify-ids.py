#!/usr/bin/env python3
"""Cross-checks every Hedera id in hedera-testnet.json against the mirror node.

A Hedera entity id and its EVM address are the same number written two ways, which makes them
very easy to transcribe wrongly and impossible to spot by eye. A submission whose proof document
contains one dead link casts doubt on the links that work, so nothing in the deployment record is
typed by hand: this derives `0.0.N` from the EVM address, then asks the mirror node whether that
entity actually exists and is what we claim.

    python deployments/verify-ids.py

Exits non-zero on any mismatch.
"""

import json
import pathlib
import sys
import urllib.error
import urllib.request

MIRROR = "https://testnet.mirrornode.hedera.com/api/v1"
HERE = pathlib.Path(__file__).parent


def hedera_id(evm_address: str) -> str:
    """A long-zero EVM address is the entity number in hex. Anything else is a real address and
    only the mirror node can map it."""
    return "0.0.%d" % int(evm_address, 16)


def get(path: str):
    try:
        with urllib.request.urlopen(f"{MIRROR}/{path}", timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        return {"_error": f"HTTP {e.code}"}
    except Exception as e:  # noqa: BLE001 - a network failure is a check failure, not a crash
        return {"_error": str(e)}


def main() -> int:
    record = json.loads((HERE / "hedera-testnet.json").read_text(encoding="utf-8"))
    failures = []

    cash = record["cash_leg"]
    derived = hedera_id(cash["evmAddress"])
    if derived != cash["hederaId"]:
        failures.append(f"cash_leg: EVM {cash['evmAddress']} derives {derived}, record says {cash['hederaId']}")

    token = get(f"tokens/{derived}")
    if "_error" in token:
        failures.append(f"cash_leg: mirror node has no token {derived} ({token['_error']})")
    else:
        print(f"  token {derived}  {token['symbol']}  decimals={token['decimals']}  "
              f"freeze_default={token['freeze_default']}  admin_key={token['admin_key']}")
        if token.get("freeze_key") is None:
            failures.append("cash_leg: no freeze key - the circuit breaker would be inert")
        if token.get("admin_key") is not None:
            failures.append("cash_leg: an admin key exists, so the freeze key could be rotated away")

        holder = decode_contract_key(token["freeze_key"])
        if holder is None:
            failures.append("cash_leg: freeze key is not a contract-ID key")
        else:
            print(f"  freeze key is a contractID key naming {holder}")
            controller = record["contracts"]["CashLegController"]["address"]
            actual = get(f"contracts/{controller}").get("contract_id")
            if actual != holder:
                failures.append(
                    f"cash_leg: freeze key names {holder} but CashLegController is {actual}"
                )
            else:
                print(f"  and {holder} is CashLegController ({controller})")

    for name, c in record["contracts"].items():
        info = get(f"contracts/{c['address']}")
        if "_error" in info or not info.get("contract_id"):
            failures.append(f"{name}: mirror node does not resolve {c['address']}")
        else:
            print(f"  {name:<24} {c['address']}  {info['contract_id']}")

    note = record["ats"]["issuedNote"]
    info = get(f"contracts/{note['address']}")
    if "_error" in info or not info.get("contract_id"):
        failures.append(f"ATS note: mirror node does not resolve {note['address']}")
    else:
        print(f"  {'ATS note (PLIM-A)':<24} {note['address']}  {info['contract_id']}")

    if failures:
        print("\nFAILED:")
        for f in failures:
            print("  -", f)
        return 1
    print("\nEvery id in the deployment record resolves and matches.")
    return 0


def decode_contract_key(key: dict):
    """Hedera renders a contract-ID key as ProtobufEncoded, because it is not a plain ed25519 or
    ECDSA key. Field 1 of Key is contractID; field 3 of ContractID is the contract number."""
    if not key or key.get("_type") != "ProtobufEncoded":
        return None
    raw = bytes.fromhex(key["key"])
    if len(raw) < 3 or raw[0] != 0x0A:
        return None
    body = raw[2 : 2 + raw[1]]
    if not body or body[0] != 0x18:
        return None
    value, shift = 0, 0
    for byte in body[1:]:
        value |= (byte & 0x7F) << shift
        shift += 7
        if not byte & 0x80:
            break
    return "0.0.%d" % value


if __name__ == "__main__":
    sys.exit(main())
