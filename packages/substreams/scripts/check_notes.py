#!/usr/bin/env python3
"""Validate notes.json against the attestor's hashing and against the chain.

notes.json holds only what the chain cannot say: the network, the vault list,
the negative-control flag and the registry pointers. This script checks the
file's side of that contract, and prints the on-chain facts that stand in for
every number that might otherwise have been configured:

  1. canonicalHash reproduces vectors pinned from packages/attestor's own
     compiled canonical.js. If this fails, every hash below is meaningless,
     so it runs first.
  2. Each key is keccak256(market).
  3. Vaults are lowercase addresses.
  4. The holder is the single member of the note's ROLE_ISSUER, read on-chain.
     Zero or several members FAILs, because an ambiguous holder is never
     guessed.
  5. canonicalHash(sorted vaults) must equal
     CoverageOracle.noteOf(noteId).vaultSetHash. A mismatch FAILs whatever
     the status, since an attestor reading this file must never value a set
     the chain did not register.
  6. Two notes with the same holder share no vault, so no collateral can be
     pledged twice.
  7. The obligation as read now is printed: totalSupply and decimals, times
     getNominalValue and getNominalValueDecimals (from ATS's
     NominalValueFacet), plus the LoadLine threshold. These are informational
     here; consumers read them at call time.

Exits 1 on any FAIL. Needs the stdlib plus `cast` for ABI plumbing.
--offline runs steps 1 to 3 only.
"""

import hashlib
import json
import pathlib
import re
import shutil
import subprocess
import sys
from decimal import Decimal

ADDRESS = re.compile(r"^0x[0-9a-f]{40}$")
# keccak256("ISSUER_ROLE") as used by the ATS deployment in packages/contracts/script/IssueNote.s.sol.
ROLE_ISSUER = "0x5eeaf5602c75bf26e73b5206d0bd6ee82f621166255e5fd73cc06bc7bd84a95f"

# Pinned by running packages/attestor/dist/src/canonical.js on 2026-09-11.
VECTORS = [
    (
        ["0x2222222222222222222222222222222222222222", "0x1111111111111111111111111111111111111111"],
        "0x6b1424f15091427569834af02fc76da685fd016c97b58eee5a51ad244c437b7e",
    ),
    ([], "0x4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"),
    (
        ["0x4626aa11c0ffee0000000000000000000000a001", "0x4626bb22d1a5e10000000000000000000000b002"],
        "0x8cb16b9aa2a77c153459f3c453a4eb4bab65ee25fc09bceebf85fd63add9843a",
    ),
]


def placeholder(h):
    """Registered hashes that are not a vault-set hash at all. Naming them
    keeps a deliberate bootstrap value from reading like a real mismatch."""
    raw = bytes.fromhex(h[2:]).rstrip(bytes(1))
    if raw and all(32 <= b < 127 for b in raw):
        return f' (ASCII "{raw.decode()}")'
    if h == "0x" + hashlib.sha256(b"plimsoll/vaults/v1").hexdigest():
        return ' (sha256 "plimsoll/vaults/v1")'
    return ""


def canonical_hash(vaults):
    """sha256 over JSON.stringify(sorted array). JSON.stringify emits no
    whitespace, and for ASCII strings Python's compact dumps is byte-identical."""
    body = json.dumps(sorted(vaults), separators=(",", ":"), ensure_ascii=False)
    return "0x" + hashlib.sha256(body.encode("utf-8")).hexdigest()


def cast(*args):
    out = subprocess.run(["cast", *args], capture_output=True, text=True, timeout=60)
    if out.returncode != 0:
        lines = out.stderr.strip().splitlines()
        raise RuntimeError(lines[-1] if lines else "cast failed")
    return out.stdout.strip()


def call(rpc, to, sig, *args):
    return cast("call", to, sig, *args, "--rpc-url", rpc)


def first_int(s):
    return int(s.split()[0])


def main():
    offline = "--offline" in sys.argv
    have_cast = shutil.which("cast") is not None
    path = pathlib.Path(__file__).resolve().parent.parent / "notes.json"
    notes = json.loads(path.read_text(encoding="utf-8"))["notes"]
    fails = flags = 0

    def report(kind, msg):
        nonlocal fails, flags
        fails += kind == "FAIL"
        flags += kind == "FLAG"
        print(f"{kind:5} {msg}")

    for vaults, want in VECTORS:
        got = canonical_hash(vaults)
        report("PASS" if got == want else "FAIL", f"canonicalHash vector, {len(vaults)} vaults -> {got[:18]}...")

    holders = {}
    for note_id, n in notes.items():
        label = n["market"]
        if have_cast:
            k = cast("keccak", n["market"])
            report("PASS" if k == note_id else "FAIL", f"{label}: noteId == keccak256({n['market']!r})")
        else:
            report("FLAG", f"{label}: cast not on PATH, noteId not recomputed")
        bad = [v for v in n["vaults"] if not ADDRESS.match(v)]
        report("FAIL" if bad else "PASS", f"{label}: {len(n['vaults'])} vaults are lowercase addresses{' ' + str(bad) if bad else ''}")
        if n.get("status") != "final":
            report("FLAG", f"{label}: status {n.get('status')!r}, vault list not final")

        reg = n.get("registry")
        if offline or not have_cast:
            continue
        if not reg:
            report("FAIL", f"{label}: no registry pointers, so nothing can be read from the chain")
            continue
        rpc, note = reg["rpc"], reg["note"]
        try:
            members = call(rpc, note, "getRoleMembers(bytes32,uint256,uint256)(address[])", ROLE_ISSUER, "0", "10")
            found = [m.lower() for m in re.findall(r"0x[0-9a-fA-F]{40}", members)]
            if len(found) == 1:
                holders[note_id] = found[0]
                report("PASS", f"{label}: holder derived on-chain = {found[0]} (sole ROLE_ISSUER member)")
            else:
                report("FAIL", f"{label}: ROLE_ISSUER has {len(found)} members, holder ambiguous")

            supply = first_int(call(rpc, note, "totalSupply()(uint256)"))
            decimals = first_int(call(rpc, note, "decimals()(uint8)"))
            nominal = first_int(call(rpc, note, "getNominalValue()(uint256)"))
            nominal_dec = first_int(call(rpc, note, "getNominalValueDecimals()(uint8)"))
            notes_out = Decimal(supply) / Decimal(10**decimals)
            par = Decimal(nominal) / Decimal(10**nominal_dec)
            print(f"INFO  {label}: outstanding {notes_out} notes x nominal {par} = obligation {notes_out * par}")
            line = call(rpc, reg["loadLine"], "lineOf(bytes32)(uint64,bool)", note_id).split()
            print(f"INFO  {label}: LoadLine threshold {line[0]} bps, configured {line[-1]}")

            raw = call(rpc, reg["coverageOracle"], "noteOf(bytes32)((address,bytes32,uint64,bool))", note_id)
            fields = [f.strip() for f in raw.strip("()").split(",")]
            registered, onchain = fields[3] == "true", fields[1].lower()
            want = canonical_hash(n["vaults"])
            if not registered:
                report("FAIL", f"{label}: noteId not registered in CoverageOracle on {reg['chain']}")
            elif onchain == want:
                report("PASS", f"{label}: CoverageOracle vaultSetHash matches canonicalHash(vaults) ({want[:18]}...)")
            else:
                report("FAIL", f"{label}: CoverageOracle has {onchain}{placeholder(onchain)}, canonicalHash(vaults) is {want} (setVaultSet pending)")
        except Exception as e:  # noqa: BLE001 - an unreadable chain is a failure to prove, reported as such
            report("FAIL", f"{label}: chain read failed ({e})")

    by_holder = {}
    for note_id, holder in holders.items():
        by_holder.setdefault(holder, []).append(note_id)
    for holder, ids in by_holder.items():
        owner = {}
        clash = False
        for note_id in ids:
            for v in notes[note_id]["vaults"]:
                if v in owner:
                    clash = True
                    report("FAIL", f"vault {v} backs both {notes[owner[v]]['market']} and {notes[note_id]['market']} (holder {holder})")
                owner[v] = note_id
        if not clash:
            report("PASS", f"holder {holder}: vault sets of {len(ids)} note(s) are disjoint")

    print(f"\n{fails} fail, {flags} flag")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
