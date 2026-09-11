//! Derived ERC-4626 layer on top of Pinax's topic0-matched extractor. The
//! module graph and the reasoning behind each store are in README.md.

mod abi;
mod math;
mod pb;
mod pricing;

use std::collections::{BTreeMap, BTreeSet};

use num_bigint::BigInt;
use num_traits::{Signed, Zero};
use substreams::errors::Error;
use substreams::pb::substreams::store_delta::Operation;
use substreams::pb::substreams::Clock;
use substreams::store::{
    DeltaInt64, DeltaProto, DeltaString, Deltas, StoreAdd, StoreAddBigInt, StoreGet,
    StoreGetBigInt, StoreGetProto, StoreGetString, StoreNew, StoreSet, StoreSetIfNotExists,
    StoreSetIfNotExistsInt64, StoreSetIfNotExistsString, StoreSetProto, StoreSetString,
};

use math::{fixed, parse_fixed, parse_uint, pow10, rate, ratio, usd, RATE_SCALE};
use pb::erc4626::v1 as upstream;
use pb::messari::yield_aggregator::v1 as messari;
use pb::plimsoll::erc4626::v1::{
    Flow, FlowKind, Flows, Position, Positions, Token, VaultBlock, VaultBlocks, VaultInfo,
    VaultInfos, Verification,
};

const SCHEMA_VERSION: &str = "1.3.1";
const METHODOLOGY_VERSION: &str = "1.0.0";
const USD_SCALE: u32 = 18;

fn hex0x(b: &[u8]) -> String {
    format!("0x{}", hex::encode(b))
}

fn unhex(s: &str) -> Vec<u8> {
    hex::decode(s.trim_start_matches("0x")).unwrap_or_default()
}

fn block_hash(clock: &Clock) -> String {
    if clock.id.starts_with("0x") {
        clock.id.clone()
    } else {
        format!("0x{}", clock.id)
    }
}

fn block_time(clock: &Clock) -> i64 {
    clock.timestamp.as_ref().map(|t| t.seconds).unwrap_or_default()
}

fn to_store(v: &BigInt) -> substreams::scalar::BigInt {
    substreams::scalar::BigInt::from_signed_bytes_be(&v.to_signed_bytes_be())
}

fn from_store(v: Option<substreams::scalar::BigInt>) -> BigInt {
    v.map(|v| BigInt::from_signed_bytes_be(&v.to_signed_bytes_be())).unwrap_or_default()
}

fn opt_fixed(v: &Option<BigInt>, scale: u32) -> String {
    v.as_ref().map(|v| fixed(v, scale)).unwrap_or_default()
}

/// Optional comma- or whitespace-separated vault allowlist. Empty means every
/// vault on the chain.
fn allowlist(params: &str) -> Option<BTreeSet<String>> {
    let set: BTreeSet<String> = params
        .split(|c: char| c == ',' || c.is_whitespace())
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
        .collect();
    (!set.is_empty()).then_some(set)
}

fn registry_key(vault: &str) -> String {
    format!("vault:{vault}")
}

// ---------------------------------------------------------------------------
// map_flows: Pinax's per-transaction events -> one flat, block-stamped list.

#[substreams::handlers::map]
fn map_flows(params: String, clock: Clock, events: upstream::Events) -> Result<Flows, Error> {
    let allow = allowlist(&params);
    let mut flows = Vec::new();
    for tx in events.transactions {
        let tx_hash = hex0x(&tx.hash);
        let tx_from = hex0x(&tx.from);
        for log in tx.logs {
            let vault = hex0x(&log.address);
            if allow.as_ref().is_some_and(|a| !a.contains(&vault)) {
                continue;
            }
            let body = match log.log {
                Some(upstream::log::Log::Deposit(d)) => Flow {
                    kind: FlowKind::Deposit as i32,
                    sender: hex0x(&d.sender),
                    owner: hex0x(&d.owner),
                    assets: d.assets,
                    shares: d.shares,
                    ..Default::default()
                },
                Some(upstream::log::Log::Withdraw(w)) => Flow {
                    kind: FlowKind::Withdraw as i32,
                    sender: hex0x(&w.sender),
                    owner: hex0x(&w.owner),
                    receiver: hex0x(&w.receiver),
                    assets: w.assets,
                    shares: w.shares,
                    ..Default::default()
                },
                None => continue,
            };
            flows.push(Flow {
                vault,
                tx_hash: tx_hash.clone(),
                tx_from: tx_from.clone(),
                log_index: log.block_index,
                ordinal: log.ordinal,
                ..body
            });
        }
    }
    Ok(Flows {
        block_number: clock.number,
        block_hash: block_hash(&clock),
        timestamp: block_time(&clock),
        flows,
    })
}

// ---------------------------------------------------------------------------
// store_vault_seen: first sighting of each address, and of each event side.
// set_if_not_exists only emits a delta on the first write, so its deltas are
// exactly the "new vault this block" signal that gates the one-shot probe.

#[substreams::handlers::store]
fn store_vault_seen(flows: Flows, store: StoreSetIfNotExistsString) {
    let stamp = format!("{}:{}", flows.block_number, flows.timestamp);
    for f in &flows.flows {
        store.set_if_not_exists(f.ordinal, format!("first:{}", f.vault), &stamp);
        let side = if f.kind == FlowKind::Deposit as i32 { "d" } else { "w" };
        store.set_if_not_exists(f.ordinal, format!("{side}:{}", f.vault), &stamp);
    }
}

// ---------------------------------------------------------------------------
// map_vault_probes: resolve asset() and ERC-20 metadata once per new address.

#[substreams::handlers::map]
fn map_vault_probes(seen: Deltas<DeltaString>) -> Result<VaultInfos, Error> {
    let mut fresh: BTreeMap<String, String> = BTreeMap::new();
    for d in seen.deltas {
        if d.operation != Operation::Create {
            continue;
        }
        if let Some(v) = d.key.strip_prefix("first:") {
            fresh.entry(v.to_string()).or_insert(d.new_value);
        }
    }
    if fresh.is_empty() {
        return Ok(VaultInfos::default());
    }
    let vaults: Vec<(String, Vec<u8>, String)> =
        fresh.into_iter().map(|(v, stamp)| (v.clone(), unhex(&v), stamp)).collect();

    let mut calls = Vec::with_capacity(vaults.len() * 4);
    for (_, a, _) in &vaults {
        calls.push(abi::call(a, abi::ASSET));
        calls.push(abi::call(a, abi::DECIMALS));
        calls.push(abi::call(a, abi::NAME));
        calls.push(abi::call(a, abi::SYMBOL));
    }
    let r1 = abi::execute(calls);
    let assets: Vec<Option<Vec<u8>>> =
        (0..vaults.len()).map(|i| r1.get(i * 4).and_then(abi::decode_address)).collect();

    // The underlying's metadata needs round one's answer, so it is a second
    // batch rather than part of the first.
    let resolved: Vec<(usize, &Vec<u8>)> =
        assets.iter().enumerate().filter_map(|(i, a)| a.as_ref().map(|a| (i, a))).collect();
    let mut calls = Vec::with_capacity(resolved.len() * 3);
    for (_, a) in &resolved {
        calls.push(abi::call(a, abi::DECIMALS));
        calls.push(abi::call(a, abi::NAME));
        calls.push(abi::call(a, abi::SYMBOL));
    }
    let r2 = abi::execute(calls);
    let mut asset_tokens: BTreeMap<usize, Token> = BTreeMap::new();
    for (j, (i, a)) in resolved.iter().enumerate() {
        let dec = r2.get(j * 3).and_then(abi::decode_decimals);
        asset_tokens.insert(
            *i,
            Token {
                address: hex0x(a),
                decimals: dec.unwrap_or(18),
                decimals_ok: dec.is_some(),
                name: r2.get(j * 3 + 1).map(abi::decode_string).unwrap_or_default(),
                symbol: r2.get(j * 3 + 2).map(abi::decode_string).unwrap_or_default(),
            },
        );
    }

    let out = vaults
        .into_iter()
        .enumerate()
        .map(|(i, (vault, _, stamp))| {
            let dec = r1.get(i * 4 + 1).and_then(abi::decode_decimals);
            let asset = asset_tokens.remove(&i);
            // A real vault's asset() is an ERC-20 with decimals(). Requiring
            // both catches contracts that merely share the event signatures.
            let asset_probe_ok = asset.as_ref().is_some_and(|t| t.decimals_ok);
            let (block, ts) = stamp.split_once(':').unwrap_or(("0", "0"));
            VaultInfo {
                address: vault.clone(),
                share: Some(Token {
                    address: vault,
                    decimals: dec.unwrap_or(18),
                    decimals_ok: dec.is_some(),
                    name: r1.get(i * 4 + 2).map(abi::decode_string).unwrap_or_default(),
                    symbol: r1.get(i * 4 + 3).map(abi::decode_string).unwrap_or_default(),
                }),
                asset,
                asset_probe_ok,
                first_seen_block: block.parse().unwrap_or_default(),
                first_seen_timestamp: ts.parse().unwrap_or_default(),
            }
        })
        .collect();
    Ok(VaultInfos { vaults: out })
}

#[substreams::handlers::store]
fn store_vault_registry(probes: VaultInfos, store: StoreSetProto<VaultInfo>) {
    for v in probes.vaults {
        store.set(0, registry_key(&v.address), &v);
    }
}

// ---------------------------------------------------------------------------
// map_vault_blocks: the per-vault, per-block series.

struct Sums {
    deposit_assets: BigInt,
    deposit_shares: BigInt,
    withdraw_assets: BigInt,
    withdraw_shares: BigInt,
    deposit_count: u32,
    withdraw_count: u32,
}

fn sum_flows(flows: &[&Flow]) -> Sums {
    let mut s = Sums {
        deposit_assets: BigInt::zero(),
        deposit_shares: BigInt::zero(),
        withdraw_assets: BigInt::zero(),
        withdraw_shares: BigInt::zero(),
        deposit_count: 0,
        withdraw_count: 0,
    };
    for f in flows {
        let (a, sh) = (parse_uint(&f.assets), parse_uint(&f.shares));
        if f.kind == FlowKind::Deposit as i32 {
            s.deposit_assets += a;
            s.deposit_shares += sh;
            s.deposit_count += 1;
        } else {
            s.withdraw_assets += a;
            s.withdraw_shares += sh;
            s.withdraw_count += 1;
        }
    }
    s
}

/// Params: the network's pricing table, see `pricing.rs`.
/// Whether a block's event rates agree with the vault's own end-of-block price.
/// A side that traded must have a computable deviation inside
/// [-0.01%, +10%]. A side whose deviation cannot be computed does not pass:
/// that happens exactly when the price is zero, and a vault priced at zero
/// while flows move through it is the case this flag exists to catch.
fn consistent(
    state_price: &Option<BigInt>,
    entry: &Option<BigInt>,
    premium: &Option<BigInt>,
    exit: &Option<BigInt>,
    discount: &Option<BigInt>,
) -> bool {
    let side = |rate: &Option<BigInt>, pct: &Option<BigInt>| match (rate, pct) {
        (None, _) => true,
        (Some(_), None) => false,
        (Some(_), Some(v)) => *v >= -pow10(RATE_SCALE - 2) && *v <= BigInt::from(10) * pow10(RATE_SCALE),
    };
    state_price.as_ref().is_some_and(|p| p.is_positive()) && side(entry, premium) && side(exit, discount)
}

#[substreams::handlers::map]
fn map_vault_blocks(
    params: String,
    clock: Clock,
    flows: Flows,
    registry: StoreGetProto<VaultInfo>,
    seen: StoreGetString,
) -> Result<VaultBlocks, Error> {
    let pricing = pricing::Pricing::parse(&params);
    let mut by_vault: BTreeMap<&str, Vec<&Flow>> = BTreeMap::new();
    for f in &flows.flows {
        by_vault.entry(f.vault.as_str()).or_default().push(f);
    }
    let touched: Vec<(VaultInfo, Vec<&Flow>)> = by_vault
        .into_iter()
        .filter_map(|(v, fs)| registry.get_last(registry_key(v)).map(|info| (info, fs)))
        .filter(|(info, _)| info.asset_probe_ok)
        .collect();

    let mut out = VaultBlocks {
        block_number: clock.number,
        block_hash: block_hash(&clock),
        timestamp: block_time(&clock),
        vaults: Vec::with_capacity(touched.len()),
    };
    if touched.is_empty() {
        return Ok(out);
    }

    let asset_addr = |i: &VaultInfo| i.asset.as_ref().map(|t| t.address.clone()).unwrap_or_default();
    let needs_eth = touched
        .iter()
        .any(|(i, _)| matches!(pricing.source(&asset_addr(i)), Some(pricing::Source::EthUsd)));

    let mut calls = Vec::with_capacity(touched.len() * 3 + 1);
    for (info, _) in &touched {
        let a = unhex(&info.address);
        calls.push(abi::call(&a, abi::TOTAL_ASSETS));
        calls.push(abi::call(&a, abi::TOTAL_SUPPLY));
        calls.push(abi::max_deposit_zero(&a));
    }
    if let (true, Some(feed)) = (needs_eth, &pricing.eth_usd_feed) {
        calls.push(abi::call(feed, abi::LATEST_ROUND_DATA));
    }
    let r = abi::execute(calls);
    let eth_usd: Option<BigInt> = if needs_eth {
        r.get(touched.len() * 3)
            .and_then(|x| abi::decode_int(x, 1))
            .filter(|v| v.is_positive())
            .map(|v| v * pow10(USD_SCALE - pricing::FEED_DECIMALS))
    } else {
        None
    };

    for (i, (info, fs)) in touched.iter().enumerate() {
        let share = info.share.clone().unwrap_or_default();
        let asset = info.asset.clone().unwrap_or_default();
        let (adec, sdec) = (asset.decimals, share.decimals);
        let s = sum_flows(fs);

        let entry = rate(&s.deposit_assets, &s.deposit_shares, adec, sdec);
        let exit = rate(&s.withdraw_assets, &s.withdraw_shares, adec, sdec);
        let spread_bps = match (&entry, &exit) {
            (Some(e), Some(x)) => ratio(&((e - x) * 10_000), x, RATE_SCALE),
            _ => None,
        };

        let total_assets = r.get(i * 3).and_then(abi::decode_uint);
        let total_supply = r.get(i * 3 + 1).and_then(abi::decode_uint);
        let max_deposit = r.get(i * 3 + 2).and_then(abi::decode_uint);
        let state_price = match (&total_assets, &total_supply) {
            (Some(a), Some(sup)) => rate(a, sup, adec, sdec),
            _ => None,
        };
        let premium = match (&entry, &state_price) {
            (Some(e), Some(p)) => ratio(&((e - p) * 100), p, RATE_SCALE),
            _ => None,
        };
        let discount = match (&exit, &state_price) {
            (Some(x), Some(p)) => ratio(&((p - x) * 100), p, RATE_SCALE),
            _ => None,
        };
        let rates_consistent = consistent(&state_price, &entry, &premium, &exit, &discount);

        let price_usd = match pricing.source(&asset.address) {
            Some(pricing::Source::Peg) => Some(pow10(USD_SCALE)),
            Some(pricing::Source::EthUsd) => eth_usd.clone(),
            None => None,
        };
        let tvl_usd = match (&total_assets, &price_usd) {
            (Some(a), Some(p)) => Some(usd(a, adec, p)),
            _ => None,
        };

        let both_sides =
            seen.has_last(format!("d:{}", info.address)) && seen.has_last(format!("w:{}", info.address));
        let verification =
            if both_sides { Verification::Confirmed } else { Verification::AssetProbe };

        let net_assets = &s.deposit_assets - &s.withdraw_assets;
        let net_shares = &s.deposit_shares - &s.withdraw_shares;
        out.vaults.push(VaultBlock {
            vault: info.address.clone(),
            asset: asset.address.clone(),
            asset_symbol: asset.symbol.clone(),
            share_symbol: share.symbol.clone(),
            verification: verification as i32,
            share_decimals: sdec,
            asset_decimals: adec,
            block_number: out.block_number,
            block_hash: out.block_hash.clone(),
            timestamp: out.timestamp,
            deposit_assets: s.deposit_assets.to_string(),
            deposit_shares: s.deposit_shares.to_string(),
            withdraw_assets: s.withdraw_assets.to_string(),
            withdraw_shares: s.withdraw_shares.to_string(),
            deposit_count: s.deposit_count,
            withdraw_count: s.withdraw_count,
            deposit_assets_norm: fixed(&s.deposit_assets, adec),
            deposit_shares_norm: fixed(&s.deposit_shares, sdec),
            withdraw_assets_norm: fixed(&s.withdraw_assets, adec),
            withdraw_shares_norm: fixed(&s.withdraw_shares, sdec),
            net_assets_norm: fixed(&net_assets, adec),
            net_shares_norm: fixed(&net_shares, sdec),
            entry_rate: opt_fixed(&entry, RATE_SCALE),
            exit_rate: opt_fixed(&exit, RATE_SCALE),
            fee_spread_bps: opt_fixed(&spread_bps, RATE_SCALE),
            entry_premium_pct: opt_fixed(&premium, RATE_SCALE),
            exit_discount_pct: opt_fixed(&discount, RATE_SCALE),
            rates_consistent,
            state_ok: state_price.is_some(),
            total_assets: total_assets.as_ref().map(|v| v.to_string()).unwrap_or_default(),
            total_supply: total_supply.as_ref().map(|v| v.to_string()).unwrap_or_default(),
            total_assets_norm: total_assets.as_ref().map(|v| fixed(v, adec)).unwrap_or_default(),
            total_supply_norm: total_supply.as_ref().map(|v| fixed(v, sdec)).unwrap_or_default(),
            state_price: opt_fixed(&state_price, RATE_SCALE),
            max_deposit: max_deposit.as_ref().map(|v| v.to_string()).unwrap_or_default(),
            asset_price_usd: opt_fixed(&price_usd, USD_SCALE),
            tvl_usd: opt_fixed(&tvl_usd, USD_SCALE),
        });
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Stores feeding the Messari view.

#[substreams::handlers::store]
fn store_vault_state(blocks: VaultBlocks, store: StoreSetProto<VaultBlock>) {
    for vb in blocks.vaults.iter().filter(|v| v.state_ok) {
        store.set(0, registry_key(&vb.vault), vb);
    }
}

#[substreams::handlers::store]
fn store_accounts(flows: Flows, registry: StoreGetProto<VaultInfo>, store: StoreSetIfNotExistsInt64) {
    for f in &flows.flows {
        let known = registry.get_last(registry_key(&f.vault)).is_some_and(|i| i.asset_probe_ok);
        if known {
            store.set_if_not_exists(f.ordinal, format!("acct:{}", f.owner), &(flows.block_number as i64));
        }
    }
}

fn add(store: &StoreAddBigInt, key: String, v: &BigInt) {
    if !v.is_zero() {
        store.add(0, key, to_store(v));
    }
}

/// Protocol-side revenue observable from flows alone: what depositors paid
/// above, and withdrawers received below, the end-of-block share price.
fn spread_fee(vb: &VaultBlock) -> BigInt {
    let a = parse_uint(&vb.total_assets);
    let s = parse_uint(&vb.total_supply);
    if s.is_zero() {
        return BigInt::zero();
    }
    let dep = &parse_uint(&vb.deposit_assets) - parse_uint(&vb.deposit_shares) * &a / &s;
    let wd = parse_uint(&vb.withdraw_shares) * &a / &s - parse_uint(&vb.withdraw_assets);
    dep.max(BigInt::zero()) + wd.max(BigInt::zero())
}

#[substreams::handlers::store]
fn store_totals(
    blocks: VaultBlocks,
    probes: VaultInfos,
    accounts: Deltas<DeltaInt64>,
    state: Deltas<DeltaProto<VaultBlock>>,
    store: StoreAddBigInt,
) {
    for vb in &blocks.vaults {
        let k = |f: &str| format!("vault:{}:{f}", vb.vault);
        add(&store, k("deposit_assets"), &parse_uint(&vb.deposit_assets));
        add(&store, k("deposit_shares"), &parse_uint(&vb.deposit_shares));
        add(&store, k("withdraw_assets"), &parse_uint(&vb.withdraw_assets));
        add(&store, k("withdraw_shares"), &parse_uint(&vb.withdraw_shares));
        add(&store, k("deposit_count"), &BigInt::from(vb.deposit_count));
        add(&store, k("withdraw_count"), &BigInt::from(vb.withdraw_count));
        if vb.state_ok && vb.rates_consistent {
            let fee = spread_fee(vb);
            add(&store, k("protocol_rev"), &fee);
            if let Some(p) = parse_fixed(&vb.asset_price_usd, USD_SCALE) {
                let fee_usd = usd(&fee, vb.asset_decimals, &p);
                add(&store, k("protocol_rev_usd"), &fee_usd);
                add(&store, "protocol:protocol_rev_usd".into(), &fee_usd);
            }
        }
    }
    let pools = probes.vaults.iter().filter(|v| v.asset_probe_ok).count();
    add(&store, "protocol:pool_count".into(), &BigInt::from(pools));
    let users = accounts.deltas.iter().filter(|d| d.operation == Operation::Create).count();
    add(&store, "protocol:unique_users".into(), &BigInt::from(users));

    for d in &state.deltas {
        let new = &d.new_value;
        let fresh = d.operation == Operation::Create;
        // Protocol TVL is the sum of each vault's TVL as of its last touch.
        let new_tvl = parse_fixed(&new.tvl_usd, USD_SCALE).unwrap_or_default();
        let old_tvl =
            if fresh { BigInt::zero() } else { parse_fixed(&d.old_value.tvl_usd, USD_SCALE).unwrap_or_default() };
        add(&store, "protocol:tvl_usd".into(), &(new_tvl - old_tvl));

        // Supply-side revenue: the change in value of the shares that existed
        // at the previous touch, S0 * A1 / S1 - A0. Flows in between move A and
        // S together and cancel out; only the price move remains.
        if fresh {
            continue;
        }
        let old = &d.old_value;
        let (a0, s0) = (parse_uint(&old.total_assets), parse_uint(&old.total_supply));
        let (a1, s1) = (parse_uint(&new.total_assets), parse_uint(&new.total_supply));
        if s1.is_zero() {
            continue;
        }
        let rev = &s0 * &a1 / &s1 - &a0;
        add(&store, format!("vault:{}:supply_rev", new.vault), &rev);
        if let Some(p) = parse_fixed(&new.asset_price_usd, USD_SCALE) {
            let rev_usd = usd(&rev, new.asset_decimals, &p);
            add(&store, format!("vault:{}:supply_rev_usd", new.vault), &rev_usd);
            add(&store, "protocol:supply_rev_usd".into(), &rev_usd);
        }
    }
}

// ---------------------------------------------------------------------------
// map_messari: Messari Yield Aggregator v1.3.1 entities for this block.

fn usd_str(v: &BigInt) -> String {
    fixed(v, USD_SCALE)
}

fn amount_usd(amount: &str, decimals: u32, price_usd: &str) -> String {
    parse_fixed(price_usd, USD_SCALE)
        .map(|p| usd_str(&usd(&parse_uint(amount), decimals, &p)))
        .unwrap_or_else(|| "0".into())
}

fn messari_token(t: &Token, price: Option<String>, block: u64) -> messari::Token {
    messari::Token {
        id: t.address.clone(),
        name: t.name.clone(),
        symbol: t.symbol.clone(),
        decimals: t.decimals as i32,
        last_price_block_number: price.as_ref().map(|_| block.to_string()),
        last_price_usd: price,
    }
}

/// map_messari params: `network=<Messari Network literal>`, default MAINNET.
/// A chain-wide ERC-4626 index has no single "protocol contract" to use as
/// Messari's protocol id, so each network gets a stable synthetic one.
fn messari_network(params: &str) -> String {
    params
        .split([';', '\n'])
        .filter_map(|kv| kv.trim().strip_prefix("network="))
        .map(|v| v.trim().to_uppercase())
        .find(|v| !v.is_empty())
        .unwrap_or_else(|| "MAINNET".into())
}

#[substreams::handlers::map]
fn map_messari(
    params: String,
    clock: Clock,
    flows: Flows,
    blocks: VaultBlocks,
    registry: StoreGetProto<VaultInfo>,
    totals: StoreGetBigInt,
) -> Result<messari::Entities, Error> {
    let network = messari_network(&params);
    let protocol_id = format!("erc4626-{}", network.to_lowercase());
    let mut out = messari::Entities {
        block_number: clock.number,
        block_hash: block_hash(&clock),
        timestamp: block_time(&clock),
        ..Default::default()
    };
    if blocks.vaults.is_empty() {
        return Ok(out);
    }
    let total = |k: String| from_store(totals.get_last(k));

    let supply = total("protocol:supply_rev_usd".into());
    let protocol_side = total("protocol:protocol_rev_usd".into());
    out.protocol = Some(messari::YieldAggregator {
        id: protocol_id.clone(),
        name: "ERC-4626 Tokenized Vaults".into(),
        slug: "erc4626".into(),
        schema_version: SCHEMA_VERSION.into(),
        subgraph_version: env!("CARGO_PKG_VERSION").into(),
        methodology_version: METHODOLOGY_VERSION.into(),
        network: network.clone(),
        r#type: "YIELD".into(),
        total_value_locked_usd: usd_str(&total("protocol:tvl_usd".into())),
        protocol_controlled_value_usd: None,
        cumulative_supply_side_revenue_usd: usd_str(&supply),
        cumulative_protocol_side_revenue_usd: usd_str(&protocol_side),
        cumulative_total_revenue_usd: usd_str(&(&supply + &protocol_side)),
        cumulative_unique_users: total("protocol:unique_users".into()).to_string().parse().unwrap_or(i32::MAX),
        total_pool_count: total("protocol:pool_count".into()).to_string().parse().unwrap_or(i32::MAX),
    });

    let mut priced: BTreeMap<&str, (&VaultBlock, u32)> = BTreeMap::new();
    for vb in &blocks.vaults {
        let Some(info) = registry.get_last(registry_key(&vb.vault)) else { continue };
        let share = info.share.clone().unwrap_or_default();
        let asset = info.asset.clone().unwrap_or_default();
        let k = |f: &str| format!("vault:{}:{f}", vb.vault);
        let sup = total(k("supply_rev_usd"));
        let prot = total(k("protocol_rev_usd"));
        let share_price_usd = match (parse_fixed(&vb.state_price, RATE_SCALE), parse_fixed(&vb.asset_price_usd, USD_SCALE)) {
            (Some(pps), Some(p)) => Some(usd_str(&(pps * p / pow10(RATE_SCALE)))),
            _ => None,
        };
        let price = (!vb.asset_price_usd.is_empty()).then(|| vb.asset_price_usd.clone());

        let deposit_fee_id = format!("DEPOSIT_FEE-{}", vb.vault);
        let withdrawal_fee_id = format!("WITHDRAWAL_FEE-{}", vb.vault);
        // An observed fee is only reported when the rates are consistent with
        // the vault's own price; otherwise the "fee" is a semantics mismatch.
        let observed = |pct: &str| (vb.rates_consistent && !pct.is_empty()).then(|| pct.to_string());
        out.vault_fees.push(messari::VaultFee {
            id: deposit_fee_id.clone(),
            fee_percentage: observed(&vb.entry_premium_pct),
            fee_type: "DEPOSIT_FEE".into(),
        });
        out.vault_fees.push(messari::VaultFee {
            id: withdrawal_fee_id.clone(),
            fee_percentage: observed(&vb.exit_discount_pct),
            fee_type: "WITHDRAWAL_FEE".into(),
        });

        out.vaults.push(messari::Vault {
            id: vb.vault.clone(),
            protocol: protocol_id.clone(),
            name: Some(share.name.clone()),
            symbol: Some(share.symbol.clone()),
            input_token: asset.address.clone(),
            output_token: Some(share.address.clone()),
            reward_tokens: vec![],
            deposit_limit: if vb.max_deposit.is_empty() { "0".into() } else { vb.max_deposit.clone() },
            fees: vec![deposit_fee_id, withdrawal_fee_id],
            created_timestamp: info.first_seen_timestamp.to_string(),
            created_block_number: info.first_seen_block.to_string(),
            total_value_locked_usd: if vb.tvl_usd.is_empty() { "0".into() } else { vb.tvl_usd.clone() },
            cumulative_supply_side_revenue_usd: usd_str(&sup),
            cumulative_protocol_side_revenue_usd: usd_str(&prot),
            cumulative_total_revenue_usd: usd_str(&(&sup + &prot)),
            input_token_balance: if vb.total_assets.is_empty() { "0".into() } else { vb.total_assets.clone() },
            output_token_supply: (!vb.total_supply.is_empty()).then(|| vb.total_supply.clone()),
            output_token_price_usd: share_price_usd.clone(),
            price_per_share: (!vb.state_price.is_empty()).then(|| vb.state_price.clone()),
            staked_output_token_amount: None,
            reward_token_emissions_amount: vec![],
            reward_token_emissions_usd: vec![],
        });
        out.tokens.push(messari_token(&asset, price, clock.number));
        out.tokens.push(messari_token(&share, share_price_usd, clock.number));
        priced.insert(vb.vault.as_str(), (vb, asset.decimals));
    }

    for f in &flows.flows {
        let Some((vb, adec)) = priced.get(f.vault.as_str()) else { continue };
        let id = format!("{}-{}", f.tx_hash, f.log_index);
        let amount_usd = amount_usd(&f.assets, *adec, &vb.asset_price_usd);
        if f.kind == FlowKind::Deposit as i32 {
            out.deposits.push(messari::Deposit {
                id,
                hash: f.tx_hash.clone(),
                log_index: f.log_index as i32,
                protocol: protocol_id.clone(),
                to: f.vault.clone(),
                from: f.sender.clone(),
                block_number: clock.number.to_string(),
                timestamp: out.timestamp.to_string(),
                asset: vb.asset.clone(),
                amount: f.assets.clone(),
                amount_usd,
                vault: f.vault.clone(),
            });
        } else {
            out.withdraws.push(messari::Withdraw {
                id,
                hash: f.tx_hash.clone(),
                log_index: f.log_index as i32,
                protocol: protocol_id.clone(),
                to: f.receiver.clone(),
                from: f.vault.clone(),
                block_number: clock.number.to_string(),
                timestamp: out.timestamp.to_string(),
                asset: vb.asset.clone(),
                amount: f.assets.clone(),
                amount_usd,
                vault: f.vault.clone(),
            });
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// store_asset_prices + map_positions: nominated holder positions at a block.

/// Last USD price seen per underlying, as "<price>@<block>", so a position can
/// be valued without re-reading the feed and can say how old its price is.
#[substreams::handlers::store]
fn store_asset_prices(blocks: VaultBlocks, store: StoreSetString) {
    for vb in blocks.vaults.iter().filter(|v| !v.asset_price_usd.is_empty()) {
        store.set(0, format!("price:{}", vb.asset), &format!("{}@{}", vb.asset_price_usd, blocks.block_number));
    }
}

/// Upper bound on nominated positions per stream, so a mistyped params string
/// cannot turn every block into hundreds of eth_calls.
const MAX_POSITIONS: usize = 64;

struct Nominated {
    note: String,
    holder: String,
    vault: String,
}

fn is_address(s: &str) -> bool {
    s.len() == 42 && s.starts_with("0x") && hex::decode(&s[2..]).is_ok()
}

/// map_positions params, `;`-separated:
///   every=<blocks>                          read cadence, default 50
///   <note>=<holder>:<vault>[,<vault>...]    one entry per note
/// Entries with a malformed address are dropped rather than guessed at.
fn parse_positions(params: &str) -> (u64, Vec<Nominated>) {
    let mut every = 50;
    let mut out = Vec::new();
    for entry in params.split([';', '\n']).map(str::trim).filter(|e| !e.is_empty()) {
        let Some((key, value)) = entry.split_once('=') else { continue };
        let key = key.trim().to_lowercase();
        if key == "every" {
            every = value.trim().parse().unwrap_or(every);
            continue;
        }
        let Some((holder, vaults)) = value.split_once(':') else { continue };
        let holder = holder.trim().to_lowercase();
        if !is_address(&holder) {
            continue;
        }
        for vault in vaults.split(',').map(|v| v.trim().to_lowercase()).filter(|v| is_address(v)) {
            if out.len() < MAX_POSITIONS {
                out.push(Nominated { note: key.clone(), holder: holder.clone(), vault });
            }
        }
    }
    (every, out)
}

/// Reads every nominated position on a cadence tick, and also in any block
/// where one of the nominated vaults had flows, so a moving vault is never
/// valued from a reading older than its last move.
#[substreams::handlers::map]
fn map_positions(
    params: String,
    clock: Clock,
    blocks: VaultBlocks,
    registry: StoreGetProto<VaultInfo>,
    seen: StoreGetString,
    state: StoreGetProto<VaultBlock>,
    prices: StoreGetString,
) -> Result<Positions, Error> {
    let (every, nominated) = parse_positions(&params);
    let mut out = Positions {
        block_number: clock.number,
        block_hash: block_hash(&clock),
        timestamp: block_time(&clock),
        positions_read: false,
        positions: Vec::new(),
        vaults: blocks.vaults.clone(),
    };
    let touched: BTreeSet<&str> = blocks.vaults.iter().map(|v| v.vault.as_str()).collect();
    let tick = every > 0 && clock.number % every == 0;
    if nominated.is_empty() || !(tick || nominated.iter().any(|n| touched.contains(n.vault.as_str()))) {
        return Ok(out);
    }
    out.positions_read = true;

    let mut calls = Vec::with_capacity(nominated.len() * 3);
    for n in &nominated {
        let v = unhex(&n.vault);
        calls.push(abi::call_with(&v, abi::BALANCE_OF, abi::address_word(&unhex(&n.holder))));
        calls.push(abi::call(&v, abi::ASSET));
        calls.push(abi::call(&v, abi::DECIMALS));
    }
    let r1 = abi::execute(calls);

    // Round two needs the balance and the asset address from round one.
    let mut calls = Vec::new();
    let mut idx = Vec::new();
    for (i, n) in nominated.iter().enumerate() {
        let shares = r1.get(i * 3).and_then(abi::decode_uint);
        let asset = r1.get(i * 3 + 1).and_then(abi::decode_address);
        if let (Some(s), Some(a)) = (shares, asset) {
            if let Some(w) = abi::uint_word(&s) {
                idx.push(i);
                calls.push(abi::call_with(&unhex(&n.vault), abi::CONVERT_TO_ASSETS, w));
                calls.push(abi::call(&a, abi::DECIMALS));
            }
        }
    }
    let r2 = abi::execute(calls);
    let mut second: BTreeMap<usize, (Option<BigInt>, Option<u32>)> = BTreeMap::new();
    for (j, i) in idx.iter().enumerate() {
        second.insert(
            *i,
            (r2.get(j * 2).and_then(abi::decode_uint), r2.get(j * 2 + 1).and_then(abi::decode_decimals)),
        );
    }

    for (i, n) in nominated.iter().enumerate() {
        let shares = r1.get(i * 3).and_then(abi::decode_uint);
        let asset = r1.get(i * 3 + 1).and_then(abi::decode_address).map(|a| hex0x(&a));
        let share_decimals = r1.get(i * 3 + 2).and_then(abi::decode_decimals);
        let (assets, asset_decimals) = second.remove(&i).unwrap_or((None, None));
        let info = registry.get_last(registry_key(&n.vault));
        let verification = match &info {
            None => Verification::Unspecified,
            Some(v) if !v.asset_probe_ok => Verification::Rejected,
            Some(_) if seen.has_last(format!("d:{}", n.vault)) && seen.has_last(format!("w:{}", n.vault)) => {
                Verification::Confirmed
            }
            Some(_) => Verification::AssetProbe,
        };
        let last = state.get_last(registry_key(&n.vault));
        let mut p = Position {
            note: n.note.clone(),
            holder: n.holder.clone(),
            vault: n.vault.clone(),
            asset: asset.clone().unwrap_or_default(),
            verification: verification as i32,
            rates_consistent: last.as_ref().is_some_and(|l| l.rates_consistent),
            last_flow_block: last.as_ref().map(|l| l.block_number).unwrap_or_default(),
            ..Default::default()
        };
        if let (Some(shares), Some(asset), Some(sdec), Some(assets), Some(adec)) =
            (shares, asset, share_decimals, assets, asset_decimals)
        {
            p.ok = true;
            p.share_decimals = sdec;
            p.asset_decimals = adec;
            p.shares = shares.to_string();
            p.assets = assets.to_string();
            p.assets_norm = fixed(&assets, adec);
            let priced = prices
                .get_last(format!("price:{asset}"))
                .and_then(|v| v.split_once('@').map(|(p, b)| (p.to_string(), b.parse::<u64>().unwrap_or_default())));
            if let Some((price, at)) = priced {
                if let Some(pe) = parse_fixed(&price, USD_SCALE) {
                    p.value_usd = usd_str(&usd(&assets, adec, &pe));
                    p.asset_price_usd = price;
                    p.price_block = at;
                }
            }
        }
        out.positions.push(p);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn positions_params_parse() {
        let h = "0xa9f24d9633bf74d4893c6687cd2c9f4ecd6f413a";
        let (every, n) = parse_positions(&format!(
            "every=150; 0xNOTE={h}:0x1111111111111111111111111111111111111111, 0x2222222222222222222222222222222222222222;bad=0x12:0x33;x={h}:nope"
        ));
        assert_eq!(every, 150);
        assert_eq!(n.len(), 2);
        assert_eq!(n[0].note, "0xnote");
        assert_eq!(n[1].vault, "0x2222222222222222222222222222222222222222");
    }

    #[test]
    fn zero_price_is_never_consistent() {
        let one = Some(pow10(RATE_SCALE));
        // The live case: a withdrawal at rate 1 from a vault whose totalAssets is 0.
        assert!(!consistent(&Some(BigInt::zero()), &None, &None, &one, &None));
        // A price that is present and positive, with a rounding-sized premium, passes.
        let tiny = Some(BigInt::from(5));
        assert!(consistent(&one, &one, &tiny, &None, &None));
        // A rate without a computable deviation fails even if the price exists.
        assert!(!consistent(&one, &one, &None, &None, &None));
        // No price at all fails.
        assert!(!consistent(&None, &None, &None, &None, &None));
        // Premium above +10% or below -0.01% fails.
        assert!(!consistent(&one, &one, &Some(BigInt::from(11) * pow10(RATE_SCALE)), &None, &None));
        assert!(!consistent(&one, &one, &Some(-pow10(RATE_SCALE - 1)), &None, &None));
    }

    #[test]
    fn messari_network_defaults() {
        assert_eq!(messari_network(""), "MAINNET");
        assert_eq!(messari_network("network=base"), "BASE");
    }
}
