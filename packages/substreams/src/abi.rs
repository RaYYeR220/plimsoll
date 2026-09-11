//! Hand-rolled ABI for the eight view calls this package makes. Generated
//! bindings would drag in ethabi for a handful of fixed selectors.

use num_bigint::{BigInt, Sign};
use substreams_ethereum::pb::eth::rpc::{RpcCall, RpcCalls, RpcResponse};

pub const ASSET: [u8; 4] = [0x38, 0xd5, 0x2e, 0x0f];
pub const DECIMALS: [u8; 4] = [0x31, 0x3c, 0xe5, 0x67];
pub const NAME: [u8; 4] = [0x06, 0xfd, 0xde, 0x03];
pub const SYMBOL: [u8; 4] = [0x95, 0xd8, 0x9b, 0x41];
pub const TOTAL_ASSETS: [u8; 4] = [0x01, 0xe1, 0xd1, 0x14];
pub const TOTAL_SUPPLY: [u8; 4] = [0x18, 0x16, 0x0d, 0xdd];
pub const MAX_DEPOSIT: [u8; 4] = [0x40, 0x2d, 0x26, 0x7d];
pub const LATEST_ROUND_DATA: [u8; 4] = [0xfe, 0xaf, 0x96, 0x8c];
pub const BALANCE_OF: [u8; 4] = [0x70, 0xa0, 0x82, 0x31];
pub const CONVERT_TO_ASSETS: [u8; 4] = [0x07, 0xa2, 0xd1, 0x3a];

pub fn call(to: &[u8], selector: [u8; 4]) -> RpcCall {
    RpcCall { to_addr: to.to_vec(), data: selector.to_vec() }
}

/// A call with one static 32-byte argument.
pub fn call_with(to: &[u8], selector: [u8; 4], arg: [u8; 32]) -> RpcCall {
    let mut data = selector.to_vec();
    data.extend_from_slice(&arg);
    RpcCall { to_addr: to.to_vec(), data }
}

pub fn address_word(a: &[u8]) -> [u8; 32] {
    let mut w = [0u8; 32];
    let n = a.len().min(20);
    w[32 - n..].copy_from_slice(&a[a.len() - n..]);
    w
}

/// Left-padded big-endian uint256. None when the value does not fit, which a
/// balance returned by balanceOf never does.
pub fn uint_word(v: &BigInt) -> Option<[u8; 32]> {
    let (sign, bytes) = v.to_bytes_be();
    if sign == Sign::Minus || bytes.len() > 32 {
        return None;
    }
    let mut w = [0u8; 32];
    w[32 - bytes.len()..].copy_from_slice(&bytes);
    Some(w)
}

/// maxDeposit(address(0)).
pub fn max_deposit_zero(to: &[u8]) -> RpcCall {
    let mut data = MAX_DEPOSIT.to_vec();
    data.extend_from_slice(&[0u8; 32]);
    RpcCall { to_addr: to.to_vec(), data }
}

/// One round trip for the whole batch. The host pins every call to the hash
/// of the block being processed, so replays return identical bytes.
pub fn execute(calls: Vec<RpcCall>) -> Vec<RpcResponse> {
    if calls.is_empty() {
        return Vec::new();
    }
    substreams_ethereum::rpc::eth_call(&RpcCalls { calls }).responses
}

fn word(r: &RpcResponse, i: usize) -> Option<&[u8]> {
    if r.failed {
        return None;
    }
    r.raw.get(i * 32..(i + 1) * 32)
}

pub fn decode_uint(r: &RpcResponse) -> Option<BigInt> {
    word(r, 0).map(|w| BigInt::from_bytes_be(Sign::Plus, w))
}

pub fn decode_int(r: &RpcResponse, i: usize) -> Option<BigInt> {
    word(r, i).map(BigInt::from_signed_bytes_be)
}

/// A clean left-padded non-zero address. A contract that happens to answer
/// the asset() selector with some other 32-byte value fails here, which is
/// half of how non-4626 emitters get rejected.
pub fn decode_address(r: &RpcResponse) -> Option<Vec<u8>> {
    let w = word(r, 0)?;
    if w[..12].iter().any(|b| *b != 0) || w[12..].iter().all(|b| *b == 0) {
        return None;
    }
    Some(w[12..].to_vec())
}

/// decimals() is uint8 in the standard; anything that does not fit is junk.
pub fn decode_decimals(r: &RpcResponse) -> Option<u32> {
    let w = word(r, 0)?;
    if w[..31].iter().any(|b| *b != 0) || w[31] > 77 {
        return None;
    }
    Some(w[31] as u32)
}

/// ABI `string`, falling back to the `bytes32` that pre-standard tokens
/// (MKR, SAI) return. Control characters are dropped so the value is safe to
/// drop into a SQL row or a log line.
pub fn decode_string(r: &RpcResponse) -> String {
    if r.failed {
        return String::new();
    }
    let raw = &r.raw;
    let bytes: &[u8] = if raw.len() >= 64 {
        let offset = small_usize(&raw[0..32]);
        let len = offset.and_then(|o| raw.get(o..o + 32)).and_then(small_usize);
        match (offset, len) {
            (Some(o), Some(l)) => raw.get(o + 32..o + 32 + l).unwrap_or(&[]),
            _ => &[],
        }
    } else if raw.len() == 32 {
        let end = raw.iter().position(|b| *b == 0).unwrap_or(32);
        &raw[..end]
    } else {
        &[]
    };
    String::from_utf8_lossy(bytes).chars().filter(|c| !c.is_control()).collect()
}

fn small_usize(w: &[u8]) -> Option<usize> {
    if w.len() != 32 || w[..24].iter().any(|b| *b != 0) {
        return None;
    }
    let mut v: usize = 0;
    for b in &w[24..] {
        v = v.checked_mul(256)?.checked_add(*b as usize)?;
    }
    Some(v)
}
