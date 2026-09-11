//! Exact fixed-point arithmetic on integers. Every derived number is computed
//! from raw uint256 values with truncating integer division and only turned
//! into a decimal string at the edge, so output is bit-for-bit reproducible
//! and never carries float error into a price comparison.

use num_bigint::BigInt;
use num_traits::{Signed, Zero};

/// Fractional digits kept for rates and prices. 18 leaves headroom below one
/// wei of an 18-decimal asset per share.
pub const RATE_SCALE: u32 = 18;

pub fn pow10(n: u32) -> BigInt {
    BigInt::from(10u8).pow(n)
}

pub fn parse_uint(s: &str) -> BigInt {
    s.trim().parse::<BigInt>().unwrap_or_default()
}

/// Renders `v / 10^scale` as a decimal string without trailing zeros.
pub fn fixed(v: &BigInt, scale: u32) -> String {
    let digits = v.abs().to_string();
    let scale = scale as usize;
    let (int, frac) = if digits.len() > scale {
        let (i, f) = digits.split_at(digits.len() - scale);
        (i.to_string(), f.to_string())
    } else {
        ("0".to_string(), format!("{}{}", "0".repeat(scale - digits.len()), digits))
    };
    let frac = frac.trim_end_matches('0');
    let mut out = String::with_capacity(int.len() + frac.len() + 2);
    if v.is_negative() {
        out.push('-');
    }
    out.push_str(&int);
    if !frac.is_empty() {
        out.push('.');
        out.push_str(frac);
    }
    out
}

/// Parses a decimal string into an integer scaled by `10^scale`, truncating
/// any extra fractional digits. Empty or malformed input yields None.
pub fn parse_fixed(s: &str, scale: u32) -> Option<BigInt> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    let (neg, body) = match s.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, s),
    };
    let (int, frac) = body.split_once('.').unwrap_or((body, ""));
    let mut frac: String = frac.chars().take(scale as usize).collect();
    while frac.len() < scale as usize {
        frac.push('0');
    }
    let v = format!("{}{}", if int.is_empty() { "0" } else { int }, frac).parse::<BigInt>().ok()?;
    Some(if neg { -v } else { v })
}

/// `num / den` at `scale` fractional digits, or None on a zero denominator.
pub fn ratio(num: &BigInt, den: &BigInt, scale: u32) -> Option<BigInt> {
    if den.is_zero() {
        return None;
    }
    Some(num * pow10(scale) / den)
}

/// Normalised assets per normalised share at RATE_SCALE:
/// `(assets / 10^asset_dec) / (shares / 10^share_dec)`. Handles vaults whose
/// share decimals exceed the asset's (OpenZeppelin's virtual offset), where a
/// raw assets/shares ratio would be off by 10^offset.
pub fn rate(assets: &BigInt, shares: &BigInt, asset_dec: u32, share_dec: u32) -> Option<BigInt> {
    ratio(&(assets * pow10(share_dec)), &(shares * pow10(asset_dec)), RATE_SCALE)
}

/// Value in USD at `usd_scale` of `amount` raw units of a token with
/// `decimals`, given its price at `usd_scale`.
pub fn usd(amount: &BigInt, decimals: u32, price: &BigInt) -> BigInt {
    amount * price / pow10(decimals)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_renders() {
        assert_eq!(fixed(&BigInt::from(1_500_000), 6), "1.5");
        assert_eq!(fixed(&BigInt::from(5), 6), "0.000005");
        assert_eq!(fixed(&BigInt::from(-5), 6), "-0.000005");
        assert_eq!(fixed(&BigInt::from(7_000_000), 6), "7");
        assert_eq!(fixed(&BigInt::zero(), 18), "0");
    }

    #[test]
    fn parse_fixed_roundtrips() {
        assert_eq!(parse_fixed("1.5", 6), Some(BigInt::from(1_500_000)));
        assert_eq!(parse_fixed("-0.000005", 6), Some(BigInt::from(-5)));
        assert_eq!(parse_fixed("2", 2), Some(BigInt::from(200)));
        assert_eq!(parse_fixed("1.23456789", 4), Some(BigInt::from(12345)));
        assert_eq!(parse_fixed("", 4), None);
    }

    #[test]
    fn rate_normalises_virtual_offset() {
        // MetaMorpho USDC: 6-decimal asset, 18-decimal shares.
        let assets = BigInt::from(1_000_000_000u64); // 1000 USDC
        let shares = parse_uint("950000000000000000000"); // 950 shares
        let r = rate(&assets, &shares, 6, 18).unwrap();
        assert_eq!(fixed(&r, RATE_SCALE), "1.052631578947368421");
    }
}
