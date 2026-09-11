#!/usr/bin/env python3
"""Diff the package's derived share price against an independent eth_call.

Input is the JSONL that `substreams run ... map_vault_blocks -o jsonl`
prints. For every block in which a named vault had flows, this asks an
archive RPC, which is not the Substreams provider, for:

  totalAssets() at N              must equal the in-stream value to the wei
  convertToAssets(10^sd) at N-1   the canonical one-share price before the block
  convertToAssets(10^sd) at N     and after it
  convertToAssets(10^(sd+12)) at N  the same price with 12 more digits of resolution

It then reports how far each derived rate sits from the reference in basis
points. It also checks the EIP-4626 bracket: entry_rate should be at or above
the price and exit_rate at or below it, separated by any fee.

stdlib only. Usage:
  python scripts/crosscheck.py run.jsonl --rpc $ETH_RPC_URL [--vault 0x..]...
"""

import argparse
import csv
import json
import os
import statistics
import sys
import time
import urllib.request
from decimal import Decimal, getcontext

getcontext().prec = 80

TOTAL_ASSETS = "0x01e1d114"
CONVERT_TO_ASSETS = "0x07a2d13a"
HIRES = 12

# Checked to answer eth_call at blocks years old with identical results.
PUBLIC_ARCHIVE_RPCS = [
    "https://eth.drpc.org",
    "https://mainnet.gateway.tenderly.co",
    "https://rpc.mevblocker.io",
    "https://eth-mainnet.public.blastapi.io",
    "https://ethereum-public.nodies.app",
]

DEFAULT_VAULTS = {
    "0xbeef01735c132ada46aa9aa4c54623caa92a64cb": "Morpho Steakhouse USDC",
    "0xdd0f28e19c1780eb6396170735d45153d261490d": "Morpho Gauntlet USDC Prime",
    "0x2371e134e3455e0593363cbf89d3b6cf53740618": "Morpho Gauntlet WETH Prime",
    "0x56a76b428244a50513ec81e225a293d128fd581d": "Morpho Spark Blue Chip USDC",
    "0xbe53a109b494e5c9f97b9cd39fe969be68bf6204": "Yearn v3 USDC-1",
    "0x797dd80692c3b2dadabce8e30c07fde5307d48a9": "Euler v2 eUSDC-2",
    "0xd4fa2d31b7968e448877f69a96de69f5de8cd23e": "Aave waEthUSDC",
    "0x0bfc9d54fc184518a81162f8fb99c2eaca081202": "Aave waEthWETH",
    "0x9d39a5de30e57443bff2a8307a4256c8797a3497": "Ethena sUSDe",
}


def post(url, payload):
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json", "User-Agent": "crosscheck"}
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def rpc_batch(urls, calls, chunk=8, retries=8):
    """Small JSON-RPC batches, rotating across archive providers. Free public
    endpoints rate-limit (429) or reject large batches (500), so a failed
    chunk moves to the next URL with backoff. An error *inside* a response is
    kept as None, because it is data (a revert), not transport failure."""
    out = []
    k = 0
    for i in range(0, len(calls), chunk):
        part = calls[i : i + chunk]
        payload = [{"jsonrpc": "2.0", "id": j, "method": m, "params": p} for j, (m, p) in enumerate(part)]
        for attempt in range(retries):
            url = urls[k % len(urls)]
            try:
                resp = post(url, payload)
                if isinstance(resp, dict):
                    raise RuntimeError(resp.get("error"))
                by_id = {x.get("id"): x for x in resp}
                out.extend(by_id.get(j, {}).get("result") for j in range(len(part)))
                break
            except Exception as e:  # noqa: BLE001 - transport errors rotate provider, then surface
                k += 1
                if attempt == retries - 1:
                    raise RuntimeError(f"all providers failed for chunk {i}: {e}") from e
                time.sleep(0.5 * (attempt + 1))
    return out


def eth_call(to, data, block):
    return ("eth_call", [{"to": to, "data": data}, hex(block)])


def uint_arg(n):
    return format(n, "064x")


def as_int(h):
    return int(h, 16) if h and h != "0x" else None


def bps(x, ref):
    return (x - ref) / ref * Decimal(10_000)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("jsonl")
    ap.add_argument(
        "--rpc",
        action="append",
        help="archive JSON-RPC URL, repeatable (default: $ETH_RPC_URL, then a set of public archive endpoints)",
    )
    ap.add_argument("--vault", action="append", help="restrict to these vaults (default: the named set)")
    ap.add_argument("--csv", default="crosscheck.csv")
    a = ap.parse_args()

    wanted = {v.lower(): DEFAULT_VAULTS.get(v.lower(), v) for v in a.vault} if a.vault else DEFAULT_VAULTS
    rows = []
    with open(a.jsonl, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line.startswith("{"):
                continue
            msg = json.loads(line)
            if msg.get("@module") != "map_vault_blocks":
                continue
            for v in msg.get("@data", {}).get("vaults", []):
                if v["vault"] in wanted and v.get("stateOk"):
                    rows.append(v)
    if not rows:
        sys.exit("no VaultBlock rows for the named vaults in " + a.jsonl)

    calls = []
    for v in rows:
        n, sd = int(v["blockNumber"]), int(v.get("shareDecimals", 0))
        one = uint_arg(10**sd)
        calls += [
            eth_call(v["vault"], TOTAL_ASSETS, n),
            eth_call(v["vault"], CONVERT_TO_ASSETS + one, n - 1),
            eth_call(v["vault"], CONVERT_TO_ASSETS + one, n),
            eth_call(v["vault"], CONVERT_TO_ASSETS + uint_arg(10 ** (sd + HIRES)), n),
        ]
    urls = a.rpc or [u for u in [os.environ.get("ETH_RPC_URL")] if u] or PUBLIC_ARCHIVE_RPCS
    print(f"{len(rows)} vault-blocks, {len(calls)} eth_calls across {[u.split('/')[2] for u in urls]}", file=sys.stderr)
    res = rpc_batch(urls, calls)

    per_vault = {}
    detail = []
    for i, v in enumerate(rows):
        ta_ext, c_pre, c_post, c_hi = (as_int(x) for x in res[i * 4 : i * 4 + 4])
        ad, sd = int(v.get("assetDecimals", 0)), int(v.get("shareDecimals", 0))
        if c_hi is None or c_post is None:
            continue
        ref = Decimal(c_hi) / Decimal(10 ** (ad + HIRES))
        ref_pre = Decimal(c_pre) / Decimal(10**ad) if c_pre is not None else None
        canon = Decimal(c_post) / Decimal(10**ad)
        state = Decimal(v["statePrice"]) if v.get("statePrice") else None
        entry = Decimal(v["entryRate"]) if v.get("entryRate") else None
        exit_ = Decimal(v["exitRate"]) if v.get("exitRate") else None
        one_wei = Decimal(1) / Decimal(10**ad) / ref * Decimal(10_000)
        # What rounding alone can explain for a side: EIP-4626 floors each
        # event by at most one asset-wei and one share-wei, the package prints
        # rates at 18 fractional digits, and the reference carries 12 extra
        # digits of the asset.
        floor_bps = (Decimal(10) ** -18 + Decimal(10) ** -(ad + HIRES)) / ref * Decimal(10_000)

        def bound(assets, shares, count):
            aw, sw, n = int(v.get(assets, "0")), int(v.get(shares, "0")), int(v.get(count, 0))
            if aw == 0 or sw == 0:
                return None
            return Decimal(n) * (Decimal(1) / Decimal(aw) + Decimal(1) / Decimal(sw)) * Decimal(10_000) + floor_bps

        entry_bound = bound("depositAssets", "depositShares", "depositCount")
        exit_bound = bound("withdrawAssets", "withdrawShares", "withdrawCount")
        d = {
            "vault": v["vault"],
            "name": wanted[v["vault"]],
            "block": int(v["blockNumber"]),
            "timestamp": int(v.get("timestamp", 0)),
            "deposits": int(v.get("depositCount", 0)),
            "withdraws": int(v.get("withdrawCount", 0)),
            "total_assets_match": str(ta_ext) == v.get("totalAssets"),
            "convert_to_assets_1share": canon,
            "convert_to_assets_hires": ref,
            "state_price": state,
            "entry_rate": entry,
            "exit_rate": exit_,
            "state_bps": bps(state, ref) if state is not None else None,
            "entry_bps": bps(entry, ref) if entry is not None else None,
            "exit_bps": bps(exit_, ref) if exit_ is not None else None,
            "canon_resolution_bps": one_wei,
            "entry_within_rounding": (abs(bps(entry, ref)) <= entry_bound) if entry is not None and entry_bound is not None else None,
            "exit_within_rounding": (abs(bps(exit_, ref)) <= exit_bound) if exit_ is not None and exit_bound is not None else None,
            "entry_ge_pre": (entry >= ref_pre - Decimal(1) / Decimal(10**ad)) if entry is not None and ref_pre else None,
        }
        detail.append(d)
        per_vault.setdefault(v["vault"], []).append(d)

    if not detail:
        sys.exit("no vault-block had a usable convertToAssets reference (reverts or missing archive state)")

    with open(a.csv, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(detail[0].keys()))
        w.writeheader()
        for d in detail:
            w.writerow({k: (format(x, "f") if isinstance(x, Decimal) else x) for k, x in d.items()})

    def stat(xs):
        xs = [abs(x) for x in xs if x is not None]
        if not xs:
            return "        -         -"
        return f"{float(statistics.median(xs)):9.1e} {float(max(xs)):9.1e}"

    print()
    print(f"{'vault':32} {'blocks':>6} {'TA=':>5} {'state bps med/max':>19} {'entry bps med/max':>19} {'exit bps med/max':>19} {'1-share res bps':>15}")
    for vault, ds in per_vault.items():
        ta_ok = sum(d["total_assets_match"] for d in ds)
        print(
            f"{wanted[vault][:32]:32} {len(ds):6d} {ta_ok:>2}/{len(ds):<2} "
            f"{stat([d['state_bps'] for d in ds]):>19} {stat([d['entry_bps'] for d in ds]):>19} "
            f"{stat([d['exit_bps'] for d in ds]):>19} {float(ds[0]['canon_resolution_bps']):15.1e}"
        )
    n = len(detail)
    ta = sum(d["total_assets_match"] for d in detail)
    entries = [d for d in detail if d["entry_bps"] is not None]
    exits = [d for d in detail if d["exit_bps"] is not None]
    print()
    print(f"totalAssets in-stream == external at the same block: {ta}/{n}")
    print(f"entry_rate >= convertToAssets (EIP-4626 rounds deposits against the user): "
          f"{sum(d['entry_bps'] >= Decimal('-0.01') for d in entries)}/{len(entries)}")
    print(f"exit_rate <= convertToAssets (withdrawals likewise): "
          f"{sum(d['exit_bps'] <= Decimal('0.01') for d in exits)}/{len(exits)}")
    rounded = [d[k] for d in detail for k in ("entry_within_rounding", "exit_within_rounding") if d[k] is not None]
    print(f"rate deviations explained by one-wei rounding plus print resolution: {sum(rounded)}/{len(rounded)}")
    print(f"per-row detail: {a.csv}")


if __name__ == "__main__":
    main()
