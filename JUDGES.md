# Five minutes

Everything below is public. No keys, no wallet, no account, nothing to install except Node.

## 1. One command (about a minute, most of it the first build)

```bash
npm --prefix packages/verify run verify
```

It reads the deployment records in this repository and checks them against the public Hedera
mirror node, Sourcify and GitHub. Every line is a pass, a fail, or a skip with its reason.
Nothing that could not be checked is reported as a pass, and a superseded deployment is listed as
history rather than quietly verified as live.

**What it printed on 2026-09-12: 42 passed, 3 failed, 5 skipped.** Add `-- --links` for a public
URL beside each line, or `-- --json` for machine-readable output.

The three failures are one problem, and the honest statement of it is this: the attestation
service signs EIP-712 over a payload that does not match the one `CoverageOracle` verifies, so no
attestation it has produced could be checked on chain. It is being migrated onto the contract's
format, the contract is not being redeployed, and until that lands the x402 signature checks
fail. Everything else passes: `-- --only 1,2,3,4,6,7,8` gives 36 passed, 0 failed, 5 skipped.
[CLAIMS.md](CLAIMS.md) says what that does and does not invalidate.

## 2. Three links that carry the whole claim

HashScan is a browser application, so each link below is followed by the same record on the public
mirror node, which is what a script can read.

**A compliance refusal, on chain, naming the party.** A transfer of the note to a blacklisted
counterparty, refused by the note itself:
[`0x61e008b4…0002`](https://hashscan.io/testnet/transaction/0x61e008b403d41541333144b06e69fbea84959f7f95f9800d0624a0196f710002)
([mirror node](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0x61e008b403d41541333144b06e69fbea84959f7f95f9800d0624a0196f710002)).
`CONTRACT_REVERT_EXECUTED`, revert data `0x796c1f0d` + the address, which is
`AccountIsBlocked(0x5da9…7f38)` with the blocked address as a declared parameter, not trailing
detail. The market never reaches that revert, because it pre-flights both legs first.

**A human refusing, and the market staying halted because of it.** The device declined a
`RESUME`, returning `6985` with no signature. A resume signed by any other key then reverted:
[`0xa9fd42a2…f5f2`](https://hashscan.io/testnet/transaction/0xa9fd42a2e061efded9d2fb80378f58ae748b9d4a34bf28a74932b9a0d5c6f5f2)
([mirror node](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0xa9fd42a2e061efded9d2fb80378f58ae748b9d4a34bf28a74932b9a0d5c6f5f2)),
`WrongAuthority`. The market resumed only after the device approved:
[`0xc77864c9…7d8c`](https://hashscan.io/testnet/transaction/0xc77864c93ff5dfab65b93881f26785979a3c9a85713e01f41b72ad73182a7d8c)
([mirror node](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0xc77864c93ff5dfab65b93881f26785979a3c9a85713e01f41b72ad73182a7d8c)).

**A refusal that was signed and not charged.** HCS sequence 19 on topic `0.0.10451091` is an
evidence refusal of 365 bytes with twelve keys and no numbers anywhere in it:
[read it on the mirror node](https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10451091/messages/19).
Sequence 17, the attestation, cites its settlement, and
[that transfer exists](https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.7162784-1789121899-540907773).
For 18 and 19 there is no transfer to find, which is the point: the refusal is free by
construction, not by refund.

[PROOF.md](PROOF.md) has the rest, grouped by claim, every line a link.

## 3. Where to look, per sponsor

### Hedera

**Tokenisation and the secondary market.** [`packages/contracts/README.md`](packages/contracts/README.md).
ATS v8.0.0 is already on testnet and issues compliance-enforced securities with no secondary
market anywhere in its 544 Solidity files. That gap is the product. `BerthMarket` escrows with
ATS's own holds (the venue is the hold's escrow but never its destination, so it never custodies
a note and never has to pass the note's KYC), pre-flights both legs with the non-reverting
eligibility check and surfaces ATS's own error selectors verbatim. `CouponScheduler` re-arms
itself through HIP-1215 with three independent stops. Seven contracts, all Sourcify `exact_match`,
201 Foundry tests including four invariants and a test that proves the invariant rig is not inert.

**x402 payments.** [`packages/attestor/README.md`](packages/attestor/README.md). Metering is
table stakes; this answers a different question, whether a charge was warranted at all, which is
binary and needs no refund path. A refusal is any response `>= 400`, the Hedera `exact` scheme
never reaches settle, and the buyer's signed transfer simply expires. Every verdict, charged or
not, is anchored to an immutable HCS topic under the 1024-byte single-chunk limit. The artifact
worth your time is `verify-charge`, which needs no access to our infrastructure and proves the
biconditional: charge present if and only if attestation warranted.

**The cash leg at consensus.** [`packages/contracts/README.md`](packages/contracts/README.md),
"The cash leg". Token `0.0.10474297`'s freeze key is a contract-ID key naming
`CashLegController`, and there is **no admin key**, so it can never be rotated away.
`test_AFrozenPayerCannotPayACouponEvenWithCoverageRestored` freezes the payer, then rigs the load
line to wrongly report clear, and the coupon still does not pay.

**Open source.** [hedera-dev/hedera-harness#55](https://github.com/hedera-dev/hedera-harness/pull/55),
open, +330/−51 across 18 files. The substantive find was not in the brief:
`devServer.ts` spawns `detached: true` on every platform, which on Windows severs the child's
stdout pipe, so the dev server's `Local:` line never arrives and URL detection aborts. SMOKE and
EVALUATE could never start on Windows. Windows tests went from 179 pass / 16 fail to 197 / 197,
with Linux verified unchanged in a container.

### The Graph

[`packages/substreams/README.md`](packages/substreams/README.md), and the package on the registry:
[`plimsoll-erc4626@v0.1.1`](https://substreams.dev/packages/plimsoll-erc4626/v0.1.1), streamable
with `substreams gui plimsoll-erc4626@v0.1.1`.

**Be precise about what is published.** v0.1.1 is the **Ethereum mainnet** layer: nine modules of
ours plus Pinax's imported `erc4626:map_events`, giving the vault registry, the share-price series
and the Messari entities. Base support and per-holder positions are v0.2.0, built in this
repository and deliberately not published while the backing vault list is unsettled. Note
coverage depends on that unpublished module. One caveat we would rather state than have found:
v0.1.1 carries v0.2.0's README inside it by mistake, so the registry page describes Base and
positions the published modules do not contain. The manifest is the authority (`network: mainnet`,
no `map_positions`), and a corrected v0.1.2 is being cut.

It imports Pinax's ERC-4626 extractor by pinned commit and runs it unchanged, so their server-side
cache is reused, then builds the derived layer they deliberately left out and fixes the three
correctness holes their README documents. The one to read is the first: topic0-only matching lets
any same-signature contract through, and one such contract, reporting 170 USDC of assets against
96.9M shares, produced 95% of the whole chain's apparent fee revenue until the consistency flag
caught it.

The numbers are cross-checked against archive nodes that are not the stream provider. On mainnet,
with the published layer: `totalAssets` exact to the wei 348/348, EIP-4626 rate ordering 226/226
and 247/247, and every one of 473 rate deviations inside a per-row bound derived from rounding.
The one visible residual is explained by Euler's virtual deposit rather than waved at. Positions
were cross-checked wei-exact 90/90 on Base and 10/10 on mainnet, with the unpublished v0.2.0.

[`packages/mcp/README.md`](packages/mcp/README.md) is the same data as infrastructure another
system can consume: provenance on every answer, and a typed refusal rather than the last good
number. Its A2A card is at `/.well-known/agent-card.json`, which The Graph's own gateway still
returns 404 for.

### Ledger

[`packages/authority/README.md`](packages/authority/README.md) and
[`DX-NOTES.md`](packages/authority/DX-NOTES.md).

The claim is deliberately narrow: **a signature authorising a halt, a resume or a load-line change
only comes into existence if a human approved it on the device, and a refusal produces no
signature at all.** The Key Ring is hardware-mandatory and is not used. See
[CLAIMS.md](CLAIMS.md) for the full not-claimed list.

Two things worth a judge's attention. First, the on-chain sequence in
[PROOF.md](PROOF.md#3-only-a-human-with-a-device-can-move-the-load-line): a valid device approval
applied through the wrong door reverts twice without spending its nonce, then succeeds through
the one door that is allowed. Second, `DX-NOTES.md` item 5, which is a security finding rather
than a papercut: the Ethereum app reflows newlines into spaces and wraps greedily at about 19
characters, so the structure a developer puts into a personal-sign message is invisible to the
human approving it. A market code containing `NONCE: 9` would render as a mandate with two
nonces. The defence is a charset rule enforced identically in TypeScript and Solidity, and it is
documented nowhere.

## Worth knowing before you judge

Both notes are registered with placeholder vault sets, so both currently refuse for an
**evidence** reason rather than as short notes. That is the intended behaviour of a system that
refuses to guess, and it is also the honest statement that no live coverage figure has been
produced yet. [MOCKS.md](MOCKS.md) is the exact line between what runs against live data and what
runs against fixtures, per component.
