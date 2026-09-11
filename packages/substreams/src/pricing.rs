//! USD pricing for underlyings, configured per network through module params
//! so that no chain's addresses are compiled in. Assets listed under `peg` are
//! dollar stablecoins marked at 1. The asset named by `weth` is priced from
//! the Chainlink ETH/USD aggregator named by `eth_usd_feed`, read at the
//! processed block. Anything else stays unpriced rather than guessed.
//!
//! Params grammar, `;`-separated:
//!   peg=0x..,0x..;weth=0x..;eth_usd_feed=0x..
//! The per-network values live in substreams.yaml under `networks:`, and each
//! was checked on-chain for symbol and decimals, or description() and
//! decimals() for the feed.

use std::collections::BTreeSet;

/// Every Chainlink USD aggregator this package is configured with reports 8
/// decimals (checked on mainnet and Base).
pub const FEED_DECIMALS: u32 = 8;

pub enum Source {
    Peg,
    EthUsd,
}

#[derive(Default)]
pub struct Pricing {
    peg: BTreeSet<String>,
    weth: Option<String>,
    pub eth_usd_feed: Option<Vec<u8>>,
}

fn addr(s: &str) -> Option<String> {
    let s = s.trim().to_lowercase();
    (s.len() == 42 && s.starts_with("0x") && hex::decode(&s[2..]).is_ok()).then_some(s)
}

impl Pricing {
    pub fn parse(params: &str) -> Pricing {
        let mut p = Pricing::default();
        for kv in params.split([';', '\n']) {
            let Some((k, v)) = kv.split_once('=') else { continue };
            match k.trim() {
                "peg" => p.peg.extend(v.split(',').filter_map(addr)),
                "weth" => p.weth = addr(v),
                "eth_usd_feed" => p.eth_usd_feed = addr(v).and_then(|a| hex::decode(&a[2..]).ok()),
                _ => {}
            }
        }
        p
    }

    pub fn source(&self, asset: &str) -> Option<Source> {
        if self.peg.contains(asset) {
            Some(Source::Peg)
        } else if self.eth_usd_feed.is_some() && self.weth.as_deref() == Some(asset) {
            Some(Source::EthUsd)
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_ignores_junk() {
        let p = Pricing::parse(
            "peg=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48, 0xnotanaddress;weth=0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;eth_usd_feed=0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419;bogus=1",
        );
        assert!(matches!(p.source("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"), Some(Source::Peg)));
        assert!(matches!(p.source("0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"), Some(Source::EthUsd)));
        assert!(p.source("0x0000000000000000000000000000000000000001").is_none());
        assert_eq!(p.peg.len(), 1);
    }

    #[test]
    fn weth_without_feed_is_unpriced() {
        let p = Pricing::parse("weth=0x4200000000000000000000000000000000000006");
        assert!(p.source("0x4200000000000000000000000000000000000006").is_none());
    }
}
