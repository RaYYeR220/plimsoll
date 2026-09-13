# Five minutes

Everything below is public. No keys, no wallet, no account, nothing to install except Node.

## 1. One command (about a minute, most of it the first build)

```bash
npm --prefix packages/verify run verify
```

It reads the deployment records in this repository and checks them against the public Hedera
mirror node, Sourcify, GitHub and substreams.dev. Every line is a pass, a fail, or a skip with its
reason. Nothing that could not be checked is reported as a pass, and a superseded deployment is
listed as history rather than quietly verified as live.

**What it printed on 2026-09-13: 43 passed, 0 failed, 4 skipped.** Add `-- --links` for a public
URL beside each line, or `-- --json` for machine-readable output.

Read section 5 with one fact in mind. It proves the x402 records are signed, paid or not paid, and
anchored exactly as they claim, and it recomputes every ratio. It does not prove the readings are
real, because they are not: every canonical record was computed from fixture figures, and each
says so in its own `feed` field, which the verifier prints on every line.

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

**A refusal that was signed and not charged.** HCS sequence 24 on topic `0.0.10451091` is an
evidence refusal of 539 bytes that carries no figure: its only numbers are its format version and
the chain id its signature is bound to.
[Read it on the mirror node](https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10451091/messages/24).
Sequence 22, the attestation, cites its settlement, and
[that transfer exists](https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.7162784-1789172046-246807405).
For 23 and 24 there is no transfer to find, which is the point: the refusal is free by
construction, not by refund. All three were computed from fixture figures and say so.

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

The attestation it sells is the struct `CoverageOracle` recovers. `CoverageOracle` accepted one on
chain and refused a replay of its nonce ([PROOF.md](PROOF.md#7-the-oracle-accepts-what-the-attestor-signs)).
That attestation was signed over test figures, so it proves signature compatibility and nothing
about backing.

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
[`plimsoll-erc4626@v0.2.0`](https://substreams.dev/packages/plimsoll-erc4626/v0.2.0), streamable
with `substreams gui plimsoll-erc4626@v0.2.0`. Ethereum mainnet and Base, twelve modules (eleven
of ours plus Pinax's imported `erc4626:map_events`): the vault registry, the share-price series,
the Messari entities, and `map_positions`, which reads a nominated holder's positions for coverage.

**Open v0.2.0.** The version history is short and worth one paragraph. v0.1.1 shipped carrying the
wrong README: the CLI embeds whichever `README.md` sits beside the manifest, so a correct
mainnet-only manifest went out describing Base and positions it did not contain. We found it by
grepping the packed artifact rather than trusting the source. A registry version can only be
superseded, never replaced, so v0.1.2 was cut as a mainnet-only release with a description scoped
to its contents, and `packages/substreams/scripts/check_package.py` was written to catch the
defect: it reads the module list out of the packed artifact and fails when the embedded
documentation names a module that is not there, which v0.1.1's does. v0.2.0 is the full release.

It imports Pinax's ERC-4626 extractor by pinned commit and runs it unchanged, so their server-side
cache is reused, then builds the derived layer they deliberately left out and fixes the three
correctness holes their README documents. The one to read is the first: topic0-only matching lets
any same-signature contract through, and one such contract, reporting 170 USDC of assets against
96.9M shares, produced 95% of the whole chain's apparent fee revenue until the consistency flag
caught it.

The numbers are cross-checked against archive nodes that are not the stream provider. On mainnet:
`totalAssets` exact to the wei 348/348, EIP-4626 rate ordering 226/226 and 247/247, and every one
of 473 rate deviations inside a per-row bound derived from rounding. The one visible residual is
explained by Euler's virtual deposit rather than waved at. Positions were cross-checked wei-exact,
90/90 on Base and 10/10 on mainnet, on public holders' positions; the issuer's own address read
exactly zero.

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

The backing is named on chain but not yet deposited. Both notes carry their real Base vault sets
in `CoverageOracle`, each hash equal to the attestor's canonical hash of the listed vaults: three
native-USDC vaults for PLIM-B, and Fluid USDC alone for PLIM-A, so no position can back both. At
Base block 51,234,844 the issuer held zero shares in all four. With nothing to read and no
attestation over the real sets, both notes refuse for an **evidence** reason: PLIM-A reads
`NoAttestation`, PLIM-B `AttestationExpired`. That is a system refusing to guess, and it is also
the honest statement that **no live coverage figure has been produced yet.**
[MOCKS.md](MOCKS.md) is the exact line between what runs against live data and what runs against
fixtures, per component.
