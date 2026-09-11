#!/usr/bin/env python3
"""Check map_positions readings against an independent archive RPC.

Input is the JSONL that `substreams run ... map_positions -o jsonl` prints.
For every block where positions were read and every position with ok=true,
this asks an archive node, which is not the Substreams provider, for the same
two calls at the same block:

  balanceOf(holder)        must equal `shares` to the wei
  convertToAssets(shares)  must equal `assets` to the wei

Both are exact-equality checks, not tolerances: the in-stream calls are pinned
to the block hash, so any difference is a bug. Rows with ok=false are counted
separately. By design they carry no amounts, and this script confirms that
too.

stdlib only. Usage:
  python scripts/crosscheck_positions.py run.jsonl --network base [--rpc URL]...
"""

import argparse
import json
import sys
import time
import urllib.request

BALANCE_OF = "0x70a08231"
CONVERT_TO_ASSETS = "0x07a2d13a"

# Public endpoints checked to answer eth_call at historical blocks.
ARCHIVE = {
    "mainnet": [
        "https://eth.drpc.org",
        "https://mainnet.gateway.tenderly.co",
        "https://rpc.mevblocker.io",
        "https://eth-mainnet.public.blastapi.io",
    ],
    "base": [
        "https://base.drpc.org",
        "https://base.gateway.tenderly.co",
        "https://base-mainnet.public.blastapi.io",
    ],
}


def eth_call(urls, to, data, block, retries=6):
    body = json.dumps(
        {"jsonrpc": "2.0", "id": 1, "method": "eth_call", "params": [{"to": to, "data": data}, hex(block)]}
    ).encode()
    last = None
    for attempt in range(retries):
        url = urls[attempt % len(urls)]
        try:
            req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json", "User-Agent": "crosscheck"})
            with urllib.request.urlopen(req, timeout=30) as r:
                out = json.loads(r.read())
            if "result" in out:
                return int(out["result"], 16) if out["result"] not in ("0x", "") else None
            last = out.get("error")
        except Exception as e:  # noqa: BLE001 - transport errors rotate provider
            last = e
        time.sleep(0.4 * (attempt + 1))
    raise RuntimeError(f"no archive provider answered for {to} at {block}: {last}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("jsonl")
    ap.add_argument("--network", choices=sorted(ARCHIVE), required=True)
    ap.add_argument("--rpc", action="append", help="archive JSON-RPC URL, repeatable")
    a = ap.parse_args()
    urls = a.rpc or ARCHIVE[a.network]

    matched = checked = not_ok = leaked = 0
    for line in open(a.jsonl, encoding="utf-8"):
        if not line.startswith("{"):
            continue
        msg = json.loads(line)
        data = msg.get("@data", {})
        if not data.get("positionsRead"):
            continue
        block = int(msg["@block"])
        for p in data.get("positions", []):
            if not p.get("ok"):
                not_ok += 1
                # A failed read must not carry a figure that could be mistaken for a finding.
                leaked += any(p.get(k) for k in ("shares", "assets", "assetsNorm", "valueUsd"))
                continue
            holder_word = "0" * 24 + p["holder"][2:]
            bal = eth_call(urls, p["vault"], BALANCE_OF + holder_word, block)
            c2a = eth_call(urls, p["vault"], CONVERT_TO_ASSETS + format(int(p["shares"]), "064x"), block)
            checked += 1
            ok = str(bal) == p["shares"] and str(c2a) == p["assets"]
            matched += ok
            if not ok or checked <= 3:
                print(
                    f"{block} {p['note'][:16]:16} shares {p['shares']} ext {bal} | assets {p['assets']} ext {c2a}"
                    f" | {'MATCH' if ok else 'MISMATCH'}"
                )

    print()
    print(f"positions equal to independent archive reads at the same block: {matched}/{checked}")
    print(f"ok=false rows: {not_ok}, of which carrying any amount: {leaked}")
    sys.exit(0 if matched == checked and leaked == 0 and checked > 0 else 1)


if __name__ == "__main__":
    main()
