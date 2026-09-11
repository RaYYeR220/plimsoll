# What is real and what is simulated

One rule governs this repository: **nothing here ever fabricates a coverage number.** When the
data is not there, the answer is a typed refusal that says which kind of not-there it is. This
file states exactly where the line falls, component by component, because a coverage attestation
whose provenance is fuzzy is worth less than no attestation at all.

Unflattering by design. If you are looking for the weak seam, it is section 2.

## The short version

| Component | Real | Simulated |
|---|---|---|
| Contracts, deployed | everything. Seven contracts on Hedera testnet, verified, driving a real ATS bond | nothing |
| Contracts, tested | the contracts themselves | ATS, HTS and the schedule service are mocked inside `forge test`, then probed against live state on a fork |
| Cash leg | the HTS token, its contract-ID freeze key, the absent admin key | no breach has been tripped on the live token |
| Device authority | the app, the firmware status words, the signatures, the on-chain sequence | the device is Ledger's emulator, not hardware |
| Attestation service | decision logic, signing, x402 payment, HCS anchoring, keyless verification | **the coverage readings themselves are fixtures** |
| Truth layer (mainnet) | live streams, live `eth_call`s, cross-checked against independent archive nodes | nothing |
| Truth layer (Base positions) | live streams and readings, cross-checked wei-exact | the issuer's own position is unfunded, so there is nothing to read |
| Coverage feed | replayed **recorded real** stream output | note coverage uses placeholder notes and synthetic readings |
| Web surface | the links and the deployment records it reads | the coverage figure on screen is a demonstration state |

---

## 1. The contracts

**Real.** All seven are deployed on Hedera testnet and verified on Sourcify, and they trade a bond
that ATS actually issued. We deploy none of ATS: it was already on testnet and we are a client of
it. Every transaction in [PROOF.md](PROOF.md) happened.

**Simulated, and only inside the test suite.** `forge test` cannot reach ATS or the Hedera system
contracts, so the suites drive `MockNote`, `MockHts`, `MockCash`, `MockScheduleService` and
`MockMandateAuthority` (`packages/contracts/test/mocks/`). That is a real limitation and it bit us
in a useful way: `BerthMarket.placeAsk` was written believing operator rights were enough to fund
an ATS hold. A dry run against a **fork of live Hedera state** (`script/ProbeEscrow.s.sol`,
impersonating the market, nothing sent) showed operator rights alone reverting with
`InsufficientAllowance`, and the hold succeeding only after an `approve`. The mock agreed with the
code; the chain did not. The allowance is now approved on chain, and the stale comment is
documented rather than silently edited, because the deployed bytecode is verified against the
source as written.

`forge script` also cannot drive HTS at all: it executes the script body locally, where `0x167`
has no bytecode, so the call dies with `InvalidFEOpcode`. Every HTS call in this deployment was
made with `cast send` instead.

**Never tripped on the live token.** The circuit breaker's consensus-level enforcement is proved
in the suite, including the hard version where the payer is frozen and the load line is then
rigged to wrongly report clear. On the deployed token, no breach has been triggered, because no
note has a coverage reading yet.

## 2. The attestation service, which is the weak seam

**`packages/attestor/src/coverage/fixtures/*.json` is the only working coverage source today.**

The production source is the Substreams pipeline. `LiveCoverageSource` is its typed placeholder
and throws `SourceUnavailable` on every call. That is deliberate rather than unfinished: a source
returning a plausible number from an incomplete index would produce a signed attestation nobody
can reproduce, which is the exact failure this product exists to prevent. Setting
`COVERAGE_SOURCE=live` today yields a service that refuses every request with
`source_unavailable`, and that behaviour is covered by a test.

**The vault addresses in the fixtures are not deployed contracts.** They are syntactically valid
addresses over invented balances. Nothing in that package has ever called `convertToAssets` on a
real vault.

What the fixtures stand in for, field by field, is tabulated in
[`packages/attestor/MOCKS.md`](packages/attestor/MOCKS.md): share balances, `convertToAssets`
readings, a second independent endpoint's reading of the same thing, the note's supply and par,
the observation block and time, and the source set.

**What this does and does not prove.** Against fixtures, `verify-charge` fully proves that the
arithmetic is correct and reproducible from the published inputs, that the anchored record matches
the evidence and the signature, that the ledger agrees about what moved, and that a charge exists
if and only if an attestation was warranted. It does **not** prove that the readings match chain
state, because there is no chain state to compare against. When the live source lands, the same
verifier gains exactly one more check, re-reading the vaults at `asOfBlock`, and nothing else
about it changes. That is the point of putting the seam there.

The question worth asking is whether the fixture source hides a problem real data would expose.
The parts that would change are the readings. The parts that would not are the decision rules, the
two refusal families, the signing, the payment flow, the anchoring format and the verification.
Every refusal reason, including all five evidence-family ones, is reachable and tested, because
the fixture source implements the same failure contract the live one will.

**The offline demo signs with a well-known throwaway key**, checked in and clearly labelled. It
holds nothing and signs only fixture verdicts. The deployed service uses a key from its
environment.

**Everything else in that package is real:** the x402 v2 flow through the unmodified libraries,
settlement through the hosted Blocky402 facilitator, real HBAR movement, EIP-712 signing and
recovery, HCS anchoring on a topic with no admin key, the public mirror node, and ERC-8004
identity and reputation.

## 3. The device

**Real:** the Ethereum app (`app-ethereum` 1.22.3, the published release ELF), the screens it
renders, the firmware status words it returns, the signatures it produces, and every transaction
those signatures authorised on chain.

**Simulated:** the hardware. This is Ledger's own Speculos emulator, because we have no physical
device. The seed is freshly generated and private, deliberately not the public Speculos test
mnemonic whose address anyone can sign for, so the deployed verifier trusts a key nobody else
holds. What emulation does not give you is a secure element: an emulator's seed exists as a string
on the machine running it. The DMK path was cross-checked against a raw APDU and returned a
byte-identical address, so the SDK is not inventing what the app computed, and that is as far as
an emulator can take the claim.

**Test-only, and kept off the trust path on purpose.** `src/screen.ts` presses the emulator's
buttons. Nothing in `src/device.ts` imports it and it is not re-exported from the package's public
surface. If a button-presser is ever on a production call path, the human has been replaced by a
loop, which is the exact thing the package exists to prevent.

## 4. The truth layer

**Real, on Ethereum mainnet.** Live streams from The Graph Market, live `eth_call`s pinned by the
host to the hash of the block being processed, and cross-checks against archive RPCs that are not
the stream provider: `totalAssets` exact to the wei 348/348, EIP-4626 rate ordering 226/226 and
247/247, and all 473 rate deviations inside a per-row rounding bound. This is the layer that is
[published](https://substreams.dev/packages/plimsoll-erc4626/v0.1.1).

**Real, on Base, but unpublished and unfunded.** Per-holder positions run live: 300 blocks from
51,180,961 on The Graph Market, backfilling 48,919 blocks of stores, with every reading
cross-checked wei-exact against drpc, Tenderly and Blast, 90/90. One of the two nominated holders
in that run was the issuer address, and it returned exactly `0` shares. That is a successful call
returning zero, which is not the same as a failed call, and the distinction is carried through the
whole pipeline: if any call reverts, the position is `ok = false` and its amounts are **empty,
never zero**, because a zero reads as a finding.

The module that does this is v0.2.0, built in this repository and deliberately not published while
the vault list is unsettled.

**Not simulated anywhere, including the failures.** The correctness holes this package fixes were
found in live data, not imagined: 5 of 126 emitters failing the `asset()` probe in 300 blocks, and
a contract reporting 170 USDC of assets against 96.9M shares producing 95% of the chain's apparent
fee revenue. One of its own flags had a hole too, found by replaying recorded live output through
the coverage feed, which is why v0.1.0 was never published.

## 5. The coverage feed

**Real:** the transports, the provenance, the reorg journal, the stream-slot accounting, and the
arithmetic, which is imported from the attestor's build so the feed and the signed attestation
cannot disagree about a ratio.

**Recorded rather than live, in the offline suite:** the vault tools replay real stream output
captured once from The Graph Market by `bin/record.ts`. The files say so in their own `about`
field, with package sha256, module hash, endpoint and recording time. The single live test is
skipped unless a token is present.

**Synthetic, and labelled:** note coverage is tested against placeholder notes, synthetic position
readings and a stand-in registry, because no note has a final vault list. The test headers say so.

## 6. The web surface

The links, the addresses and the transaction hashes are read from the deployment records at build
time, so a redeploy usually needs no edit. The coverage figure that moves across the load line on
screen is a **demonstration state**, not a reading: `lib/coverage.ts` defines a typed
`CoverageFeed` seam, and the landing passes none, so everything it shows is a demonstration and
says so. Contract addresses are deliberately not printed on the page; they are in
[PROOF.md](PROOF.md).

---

## The negative control

A green check is worthless if nothing could have turned it red. So there is a note that must
always fail.

**PLIM-A** is a real ATS bond with a real on-chain obligation of **$1,000,000**: 10,000.00 notes
outstanding at a par of 100.00, both read from the chain. The backing behind it is roughly $15 on
Base. It must refuse, forever, on real numbers, and any run in which PLIM-A clears is a bug in us,
not good news. The coverage feed's test suite treats a clearing control as a failure of its own
(`controlViolated`), rather than trusting anyone to notice.

**PLIM-B** is the same machinery sized honestly: a $10.00 obligation against the same roughly $15
of backing. It is the note that should clear, once there is something to read.

The pair is deliberate. One note that passes proves the happy path works. One note that must fail
proves the check is load-bearing. Together they prove the difference between the two is coming
from the data rather than from us.

Two honest wrinkles about the control:

- At 0.15 bps, PLIM-A's coverage floors to `0` on chain, so the chain alone cannot tell the
  control from a note with no position at all. The reason code and the detail carry the
  distinction, which is why a refusal here never quotes basis points alone.
- Until `setVaultSet` lands, PLIM-A refuses for an **evidence** reason (`VaultSetChanged`) rather
  than as a short note. It still refuses, and it refuses for a defensible reason, but the reason
  is about our evidence rather than about its backing. That is not the refusal we want from it,
  and we would rather say so than let a red mark stand in for the red mark we meant.

## What has not yet run against live data

Stated plainly, in one place.

1. **No coverage attestation has ever been produced from a live reading.** The attestor's source
   is fixtures. The live source refuses by design until the pipeline is wired to it.
2. **No note has a real vault set.** Both are registered with placeholders, the vault lists in
   `notes.json` are empty, and `scripts/check_notes.py` fails on that mismatch deliberately until
   `setVaultSet` is called with the final lists.
3. **The issuer's Base positions are not funded**, so even with the vault list settled there is
   currently nothing behind either note to read.
4. **No attestation can be verified on chain**, because the attestor's EIP-712 payload does not
   yet match the oracle's. That work is in flight, the contract is not being redeployed, and it is
   the sole reason three checks in the one command fail.
5. **Nothing has been listed or matched on the live venue.** `placeAsk` calls
   `LoadLine.requireClear`, which reads `NoAttestation`. The escrow allowance is approved on chain
   and the fork probe shows the hold being created and executed, but no live match has happened.
6. **No coupon has been paid, and no schedule is armed.** Arming requires a clear line.
7. **The coverage-linked coupon rate is not active on these notes.** The ATS bond configuration
   used here registers neither the Kpis nor the KpiLinkedRate facet, so the write is refused and
   the scheduler emits `CoveragePushFailed`.
8. **Nothing is on mainnet.**

Every one of those is a consequence of the same two dependencies: the final Base vault list, and
the signature-format migration. Neither is hidden, and neither is described as done.
