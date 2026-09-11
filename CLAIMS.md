# Claims

Every public statement this project makes, tagged by what backs it. Four tiers, and the fourth is
the list of things we deliberately do **not** claim.

The rule we held ourselves to: under-claiming precisely beats over-claiming vaguely. If a line
below reads as weaker than you expected, that is the point.

- **Proven on chain.** A stranger can check it with no keys and no account, today.
- **Proven by test.** It runs on your machine from a clean clone.
- **Demonstrated with stated fixtures.** The logic is real and exercised; the data it chewed on
  was not read from a live source.
- **Not claimed.** Stated so nobody has to discover it.

Dates matter here. **Everything marked "re-checked 2026-09-12" was run or fetched on that date**
for this document, not copied from an earlier note.

---

## Proven on chain

Public, keyless, and all of it re-checked 2026-09-12 against the Hedera mirror node and Sourcify.
Links for every line are in [PROOF.md](PROOF.md).

| Claim | Evidence |
|---|---|
| Seven contracts are deployed on Hedera testnet, each an `exact_match` on Sourcify for chain 296, each created by the transaction the deployment record names | Sourcify v2 API, mirror node `contracts/results` |
| The adapter created the verifier inside its own constructor, so the verifier's sole caller was fixed at construction with no setter | one shared deploy transaction, plus the contracts' own read-back state |
| PLIM-A is a real ATS bond: 10,000.00 issued, 1,000.00 transferred to a second KYC'd holder, and those two holders are the entire supply | keyless `eth_call` through the mirror node |
| PLIM-B's obligation is $10.00, read from `totalSupply` and `getNominalValue` rather than configured | keyless `eth_call` through the mirror node |
| A transfer to a blacklisted counterparty is refused by the note itself, and the revert names the blocked address as a declared ABI parameter | `CONTRACT_REVERT_EXECUTED`, revert data `0x796c1f0d` + address |
| A device-approved mandate applied at the wrong contract reverts, twice, without spending its nonce, and the same approval then succeeds through the one permitted door | `NotGatekeeper`, then `NotLoadLine`, then SUCCESS |
| A mandate approved for 95.00% and submitted as 90.00% reverts before anything is written | `MandateValueMismatch(noteId, 9000, 9500)` |
| A resume signed by any key other than the device reverts | `WrongAuthority(0xd8ee…3563, 0x69fC…F3e2)` |
| The market stayed halted after the device declined, and resumed only after it approved | the halt, the reverted resume, and the successful resume, in order |
| Every device signature recovers to the mandate authority, offline, from the exact text the device displayed | recovery performed locally by `packages/verify` |
| The cash token's freeze and supply keys are contract-ID keys naming `CashLegController`, and it has no admin key, so the freeze key can never be rotated away | mirror node token record, `ProtobufEncoded` key bytes decoded |
| Three canonical records are anchored on an immutable HCS topic, at 843, 832 and 365 bytes, all single-chunk | mirror node topic messages |
| The evidence refusal contains no numeric field anywhere in it | read record 19 and count |
| The attestation's settlement really happened: buyer debited 100,000 tinybar, seller credited 100,000, and the facilitator paid the entire 268,582 tinybar network fee | mirror node transaction record |
| No transfer exists for either refusal, and no unclaimed credit reached the seller inside x402's maximum authorisation window | mirror node account credits, cross-referenced against anchored records |
| ERC-8004 identity registration and the buyer's `giveFeedback` both succeeded | mirror node |
| `hedera-dev/hedera-harness#55` is open, +330/−51 across 18 files, into `dev` | GitHub API |
| `plimsoll-erc4626@v0.1.1` is published on substreams.dev and streamable by anyone | the registry |

## Proven by test

| Claim | How to run it | Status |
|---|---|---|
| 201 contract tests pass across 10 suites, with `forge-std` vendored so a clean clone needs no setup step | `cd packages/contracts && forge test` | **re-run 2026-09-12: 201 passed, 0 failed** |
| Four invariants hold over 128 runs and 8,192 calls each: nothing settles past the load line, no coupon pays past it, notes are conserved, the venue holds nothing | `forge test --match-contract Invariant` | re-run 2026-09-12 |
| The invariant rig is not inert: a scripted happy path through the same handler really does settle trades and pay coupons, and the violation counter really does detect a violation | `test_HandlerRigActuallyExercisesTheProtocol`, `test_TheViolationCounterActuallyDetectsAViolation` | re-run 2026-09-12 |
| A frozen payer cannot pay a coupon even when the load line is rigged to wrongly report clear | `test_AFrozenPayerCannotPayACouponEvenWithCoverageRestored` | re-run 2026-09-12 |
| No caller except `LoadLine` can move a halt or a threshold, under fuzzing, with no nonce spent and both halt states still agreeing | `test_Fuzz_NoCallerButLoadLineCanMoveHaltOrThreshold` | re-run 2026-09-12 |
| Every contract is far inside EIP-170; the largest is 8,697 bytes of 24,576, and the check fails the build rather than the deploy | `forge build --sizes`, `Bytecode.t.sol` | re-run 2026-09-12 |
| The coverage feed refuses rather than serving a stale number, and no evidence refusal contains a figure anywhere in the object, proved by a deep scan that is itself tested against a planted figure | `npm --prefix packages/mcp run test:offline` | **re-run 2026-09-12: 45 passed, 0 failed** |
| A frozen feed's cached value is never served as fresh: the clock is advanced past the threshold and the value does not appear anywhere in the refusal | same suite, "negative control" | re-run 2026-09-12 |
| The vault-set hash the feed computes matches the attestor's own `canonicalHash`, called live | same suite | re-run 2026-09-12 |
| Two distinct mandates cannot render as the same text on the device: each field's rendering is injective, the tuple has fixed arity and order, and no value may contain a newline, whitespace or `: ` | `npm --prefix packages/authority run test:unit` | not re-run for this document |
| The Solidity suite verifies a signature a real device produced, and rejects every way of presenting one it did not | `packages/authority` Foundry suite | not re-run for this document |
| The device returns `6985` on rejection and the result object carries no signature field, asserted rather than described | `packages/authority` device suite, needs the emulator running | not re-run for this document |

Where a line says "not re-run for this document", the suite exists and the package README
describes it; we simply did not execute it in this pass, and we would rather say so than quote a
number we did not watch appear.

## Demonstrated with stated fixtures

Real logic, stated inputs. [MOCKS.md](MOCKS.md) is the full accounting; this is the summary.

| Claim | The fixture, named |
|---|---|
| The coverage decision, the two refusal families, EIP-712 signing, the x402 flow, HCS anchoring and keyless re-verification all work end to end | the attestor's coverage source is `src/coverage/fixtures/*.json`. The vault addresses in them are syntactically valid and **not deployed contracts** |
| The ratio is recomputed from published inputs by an independent verifier, proving the arithmetic, the record, the signature and the payment biconditional | proven against fixture readings. It cannot yet re-read the vaults, because those vaults do not exist |
| The coverage feed's tools answer with provenance and refuse correctly on staleness, unknown vaults and self-contradictory vaults | replayed from **recorded real stream output** captured once from The Graph Market, `test/fixtures/recorded-{mainnet,base}.json`, each labelled with its package sha256, module hash, endpoint and recording time |
| Note coverage produces the right verdict for an under-backed note, a right-sized note, an empty position and a drifted vault set | placeholder notes, synthetic position readings and a stand-in registry. The test headers say so |
| Escrow, settlement, coupons and the circuit breaker behave as described | the contract suites drive `MockNote`, `MockHts`, `MockCash`, `MockScheduleService` and `MockMandateAuthority`, because ATS and the Hedera system contracts are not available inside `forge test`. The live behaviour was then probed on a fork of real Hedera state (`script/ProbeEscrow.s.sol`) and the two disagreed, which is how we learned an ask needs an allowance and not just operator rights |
| Coverage can drive a coupon rate through ATS's own KPI facets | built and tested against a mock of the Kpis facet. On the deployed notes the write is refused, because this bond configuration registers no such facet |
| The landing page and market screens show a coverage figure moving across the load line | a demonstration state (`apps/web/lib/coverage.ts`, `components/app/DemoState.tsx`), with a typed seam (`CoverageFeed`) where a live feed plugs in. The landing passes no feed, and says so |

## Not claimed

Listed because a judge should not have to find these.

**The Ledger Key Ring is not used.** It is hardware-mandatory, the CLI cannot run against an
emulator, and we have no physical device. Nothing here is a Key Ring integration and nothing here
claims to be one.

**The device is emulated, with a private seed.** Speculos runs the real `app-ethereum` 1.22.3 ELF
and returns real firmware status words, and the seed is freshly generated and not the public test
mnemonic, so no one else can sign for that address. But an emulator's seed is a string on the
machine running it. **We do not claim the signing key never exists in software**, and we do not
claim non-extractability, which is a property of hardware rather than of anything demonstrated
here. The DMK path was cross-checked against a raw APDU and returned a byte-identical address,
which is as far as an emulator can take the claim.

**The owner can repoint the mandate authority.** `LoadLine.setMandateAuthority` is owner-gated, so
an owner who swaps the authority governs the load line too. The accurate sentence is "the device
approves load-line changes", not "nobody can bypass the device". Everything else administrative,
including wiring the oracle, registering notes, rotating the attestor and moving a vault set, is
owner-gated and is **not** covered by a device mandate: a mandate is only worth something if a
person can read what they are approving, and raw hex on a four-line screen is a rubber stamp with
extra steps.

**Coverage below 0.005% floors to zero basis points on chain.** `coverageBps` cannot tell a tiny
real position from none at all. PLIM-A's roughly $15 against a $1,000,000 obligation is 0.15 bps
and reads as `0`. The refusal is correct either way, since both are far below any load line, but a
display quoting basis points alone would make the negative control and an empty wallet look
identical. So a refusal here never quotes basis points alone: the reason code distinguishes
`coverage_below_floor` from `no_attributable_positions`, and the detail carries obligation and
attributable in full.

**No live coverage figure has been produced.** The Base vault list is not final, the issuer's
positions are not funded, and both notes are registered with placeholder vault sets. Both
therefore refuse for an evidence reason. Nothing in this repository has ever computed a coverage
ratio from a funded position.

**Nothing the attestation service has signed can be verified on chain yet.** Its EIP-712 payload
does not match `CoverageOracle`'s. The service is being migrated onto the contract's format and
the contract is not being redeployed. This is the only reason three checks in the one command
fail, and the x402 records will be re-run to encoding `v: 3` once it lands.

**The published Substreams package is Ethereum mainnet only.** Base and the per-holder positions
module that note coverage depends on are v0.2.0, built here and not published. The published
v0.1.1 also carries v0.2.0's README inside it by mistake, so its registry page describes things
the package does not contain; a corrected v0.1.2 is being cut, and the manifest is the authority.

**The attestor is trusted to tell the truth.** The oracle verifies who signed, and that the
evidence is fresh and about the right vaults. It cannot verify the vault positions themselves. A
dishonest attestor holding a live key can report any coverage under the plausibility cap.

**"How old is this data" is answered in wall-clock seconds, not source-chain blocks.** There is no
light client for the source chain, so we cannot know its true head. An earlier draft measured lag
against the highest block we had been shown; that check was dead code, because the head and the
record always advanced together, and it was replaced rather than left in to look good.

**A halt or resume mandate's coverage figure is not compared to the oracle.** It is what the human
was told. A resume approved on a stale figure lifts the halt, and trading then still requires the
oracle to read clear, so it cannot open settlement on its own.

**Halt state is held in two places.** `LoadLine` and the verifier each hold it, and they are
asserted to agree rather than being one variable.

**A single authority key, with no rotation path and no m-of-n.** `MandateVerifier.authority` is
immutable. A real limitation for production, and a deliberate one for a verifier that has to stay
small enough to read.

**An authority that goes away freezes every threshold** at its current value. Notes keep trading
under the last approved line rather than falling open, which is the right direction to fail, but
it is a liveness dependency.

**Bids can go stale.** An ask is escrow-backed and cannot fail for want of notes. A bid is
allowance-backed, so a maker can spend the cash out from under it. The pre-flight catches it at
match time with a reason code instead of a revert, but the two guarantees are not equivalent.

**Unfunded coupons look like successful transactions.** The self-rescheduling loop swallows
payment failures on purpose, so a missed coupon cannot kill the schedule. Everything is evented
and counted, but anything monitoring this must watch `CouponUnfunded`, `CouponWithheld` and
`ScheduleRejected`, never transaction receipts.

**The cash token is permanently tied to this controller.** No admin key means the freeze key can
never be rotated, which is what makes the breaker credible and also means the controller can never
be replaced for this token. It cannot be fixed afterwards.

**The circuit breaker freezes an account, not a note.** HTS freeze is per token and account, so a
payer shared by two notes is frozen for both when either breaches. No payer is registered for
either note yet, and PLIM-B's must never be PLIM-A's.

**`BerthMarket.placeAsk`'s own comment says operator rights suffice, and they do not.** Real ATS
requires an allowance. The deployed bytecode is verified against the source as written, so the
comment is left in place rather than edited out of step with the chain. The package README is the
correct statement, and the next deployment should carry the fix.

**A retired market still holds operator rights on PLIM-B.** A connect step first ran against the
superseded venue. The KPI role and the stray schedule were undone; the operator grant was not,
because ATS refuses to revoke an operator that holds no KYC. It is inert, since that market can
only escrow once a retired load line clears PLIM-B, which never happens. Every step is in the
deployment record, including the revert.

**PLIM-A's registered vault-set hash was never a vault set.** It is `sha256("plimsoll/vaults/v1")`
from a one-off environment bootstrap. Until `setVaultSet` lands, PLIM-A refuses for an evidence
reason rather than as a short note.

**Coverage assumes USD par and USD-pegged underlyings.** A non-USD note currency, or an underlying
not priced at peg, refuses rather than being guessed at. USD pricing covers each network's dollar
stablecoins at peg and WETH through that chain's Chainlink feed; everything else gets empty USD
fields rather than an invented price.

**Cumulative figures mean since the package's `initialBlock`, not since inception**, and
protocol-side revenue is only what the flows reveal. Performance and management fees taken by
minting shares never appear in `Deposit` / `Withdraw`, so protocol side is understated.

**Messari fidelity is partial and stated.** The protocol id is a synthetic `erc4626-<network>`,
snapshot entities are not emitted because they belong in the sink, and `feePercentage` is observed
per block rather than read from vault configuration.

**Not a subgraph.** This is standalone Substreams.

**No ERC-7730 descriptors.** Real ones are signed by Ledger's backend and verified on-device
through a PKI chain; a self-made one is likely to fail that check and silently fall back to blind
signing, which looks like it works and does not. Plain `signMessage` already renders the full
mandate on screen.

**The HCS-14 identifier follows the reference implementation rather than the spec prose**, since
the two disagree about key ordering. We pin the exact bytes we hash in a test so anyone can
compare, but we have not cross-validated against another implementation.

**Testnet only, and not audited.** Nothing here has been exercised on mainnet, and this is three
days of hackathon work.
