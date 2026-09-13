# What is real and what is not

One rule governs this package: **the service never fabricates a coverage number.** If the
data is not there it refuses and says so. This file states exactly where the line falls,
because a coverage attestation whose provenance is fuzzy is worth less than no
attestation at all.

## Simulated

### The coverage data

**Fixtures are for tests and the offline demo, and they only ever describe synthetic
notes (`NOTE-ALPHA` … `NOTE-JULIET`).** Nothing built from a fixture is submitted to
`CoverageOracle`, and no fixture describes a real note.

`LiveCoverageSource` (`src/coverage/live.ts`) reads real ERC-4626 positions on Base and
real note liabilities on Hedera — supply, par, issuer, the note's own load line from
`LoadLine`, and the vault set it is registered with on `CoverageOracle` — behind the
same `CoverageSource` contract. It is selected with `COVERAGE_SOURCE=live` and
`LIVE_NOTES_FILE`; unconfigured, it refuses with `source_unavailable` rather than
guessing. `bin/submit-oracle.ts` accepts only its readings.

Point `BASE_RPC_URL` at a dependable endpoint. The default, `mainnet.base.org`,
throttles hard enough that an unfunded note comes back as `source_unavailable` — an
honest refusal, but about our evidence, where the true answer is an asset finding.

Whether a figure was measured is the distinction most easily lost, so it is not left to
this document:

### Every record says where its numbers came from

A format v3 record carries `feed`, naming the source that produced its readings.
`fixture` means the figures came from checked-in JSON, not from a chain.

This is in the record rather than only here because an HCS sequence outlives every
document that explains it. The topic has no admin key; sequence 22 will still be
readable long after this file has been rewritten, and without `feed` a reader finding
it would have no way to tell a demonstration from a measurement — the signature, the
arithmetic, the payment and the anchoring are all equally real either way.
`verify-charge` prints it on every verdict and flags a simulated feed as a note, and
`packages/verify` prints it on every line of section 5.

### A fixture-derived attestation that reached the oracle

This happened, it is permanent, and it is exactly the failure this file exists to
prevent, so it is stated here rather than left for someone to find.

On 2026-09-12, while the attestation format was being moved onto `CoverageOracle`'s
struct, `bin/submit-oracle.ts` built an attestation for **PLIM-B** from
`src/coverage/fixtures/plim-b.json` — two invented positions totalling 15.00 against a
10.00 obligation — and submitted it:

| transaction | EVM hash | outcome |
| --- | --- | --- |
| `0.0.10448897@1789170002.090019887` | `0xc0370dfaea84d47ac6783df5d55f35f579af218951eeee2a0c470e542e422439` | accepted, stored at **15000 bps** |
| `0.0.10448897@1789169999.900969762` | `0x4b414352cb6d0aa671a81966692877528d7d90db191133dc3899e7934ae36c04` | the same bytes replayed, reverted `StaleAttestation(1789170005, 1789170005)` |

PLIM-B's holder on Base had never been funded. Its real coverage at that moment was
zero, so the first transaction records a real note as 150% covered when it held
nothing. It signed over `PLACEHOLDER-NOT-A-VAULT-SET`, which `setVaultSet` has since
replaced, so it can never count toward the line again, and it expired five minutes
after it was issued. It remains readable, and it is not evidence of anything.

What changed as a result:

- `plim-a.json` and `plim-b.json` are deleted. No fixture describes a real note.
- `bin/submit-oracle.ts` refuses any simulated source and any verdict whose `feed` is
  simulated, never submits a refusal, and sends nothing without `--submit`. Its
  canonical use is `--receipt`, which submits the exact attestation a buyer paid for
  and the service anchored, rather than signing a second copy.
- The attestation cited as accepted on chain is a live reading, not this one.

### Sequences 22–24

Anchor records 22, 23 and 24 are v3 records produced from fixtures, and each says
`"feed": "fixture"`. Records 22 and 23 carry the market codes PLIM-B and PLIM-A with
invented figures — 15000 and 0 bps — for the same reason as above. They are kept on
the topic, which has no admin key, and they are not cited: the canonical records are
live readings.

### What the fixtures stand in for

| fixture field | stands in for |
| --- | --- |
| `positions[].vault` | an ERC-4626 vault address |
| `positions[].shares` | `balanceOf(holder)` on that vault at `blockNumber` |
| `positions[].assets` | `convertToAssets(shares)` at `blockNumber` |
| `positions[].secondaryAssets` | the same reading from a second independent endpoint |
| `notesOutstanding`, `parPerNote` | note supply and par from the note contract |
| `asOfBlock`, `observedAt` | the block and wall-clock time of the observation |
| `sourceSet` | the Substreams package and endpoints that produced the snapshot |

**The vault addresses are not deployed contracts.** They are syntactically valid
addresses over invented balances. Nothing in this package has ever called
`convertToAssets` on a real vault.

### Consequence for `verify-charge`

`verify-charge` recomputes the ratio from the readings anchored on HCS, independently of
the service's own arithmetic. Against fixtures this fully proves:

- the arithmetic is correct and reproducible from the published inputs,
- the anchored record matches the off-chain evidence and the signature,
- the ledger agrees about what did and did not move,
- charge present if and only if attestation warranted.

It does **not** yet prove that the readings match chain state, because there is no chain
state to compare against. When the Substreams source lands, the same verifier gains one
more check — re-reading the vaults at `asOfBlock` — and nothing else about it changes.
That is the point of the seam.

### The offline demo signing key

`demo/offline.ts` uses a well-known throwaway secp256k1 key, checked in and clearly
labelled. It holds nothing and signs only fixture verdicts. The deployed service uses
`ATTESTOR_PRIVATE_KEY` from the environment.

## Real

Everything below runs against live infrastructure and is exercised by the test suite.

| component | status |
| --- | --- |
| x402 v2 payment flow | real. `@x402/express` + `@x402/core` + `@x402/hedera`, unmodified. |
| Settlement | real. Hosted Blocky402 facilitator at `api.testnet.blocky402.com`, `exact` scheme, `hedera:testnet`. |
| The free refusal | real. Any status `>= 400` cancels settlement before `/settle` is called. Verified against a stub facilitator that counts calls, **and** against the public mirror node. |
| HBAR movement | real. Buyer debited, seller credited, facilitator pays the network fee. |
| EIP-712 signing | real, and now the contract's own format. Attestations are signed as the struct `CoverageOracle` recovers, under a domain bound to that oracle; `test/typed-data.test.ts` checks our digest against the deployed contract's `hashAttestation`. |
| The load line | real. Read per note from `LoadLine.lineOf` alongside the note's other figures; a line that cannot be read is an evidence refusal, never a default. PLIM-A's is 9500 bps and PLIM-B's 10000. |
| On-chain acceptance | real, live. The paid PLIM-B attestation of HCS seq 25 was accepted as `0.0.10448897@1789277312.991739326` and its replay refused `StaleAttestation` as `0.0.10448897@1789277314.412442067`; `LoadLine.status` then read Covered at 14000 bps. The earlier fixture-derived submission is disclosed above and is not cited. |
| HCS anchoring | real. Consensus messages on a topic with a submit key and no admin key, each under 1024 bytes, single-chunk. |
| Mirror node | real. Public REST API, no credentials. |
| ERC-8004 identity | real. `register()` on the deployed registry at `0x8004A818…`, chain 296. |
| ERC-8004 reputation | real. `giveFeedback()` on `0x8004B663…` with `proofOfPayment` carrying the settlement id. |
| HCS-14 UAID | real, with a caveat. Pure offline SHA-384, no dependencies. See the field-ordering note in README limits. |
| `verify-charge` | real. Zero credentials, public data only. |

## Encoding history on the topic

HCS topic `0.0.10451091` has no admin key, so nothing written to it can be
withdrawn, including our mistakes. Every record carries a format version in
`v`, and `verify-charge` applies the rules of the version a record declares.

| format | sequences | encoding | refusals signed as |
| --- | --- | --- | --- |
| v1 | 1–11 | full numeric block always written, zeroed where unknown | single `Refusal` struct |
| v1 label, v2 content | 12–16 | figures omitted where not established | `AssetRefusal` / `EvidenceRefusal` |
| v2 | 17–21 | figures omitted where not established | `AssetRefusal` / `EvidenceRefusal` |
| v3 | 22 onward | as v2, plus `nid`, `orc`, `cid`, `pay` and `feed` | as v2; attestations move to `CoverageOracle`'s own struct |

v3 is where the attestation stopped being ours to shape. v1 and v2 signed a
`string` note id, a `uint32` coverage and a random `bytes32` nonce under a domain
naming no contract — a digest the deployed oracle does not recover, so those
signatures could never have been accepted on chain. From v3 the signed struct is
the contract's, the domain names the contract, and the record carries the oracle
and chain (`orc`, `cid`) so a reader can rebuild that domain from the record
alone.

Sequences 12–16 are why the version exists. They were written after the
encoding changed and before the label did, so nothing in the record told a
reader which rules to apply. Under the current verifier a v1-labelled record
must look like the v1 encoder wrote it; where it does not, that is a failure,
not a variant.

### Which v1 records pass the current checks

Measured, not assumed. "Record alone" is what a stranger sees. "With receipt"
adds our stored off-chain receipts, which exist only in our local, gitignored
data directory.

| seq | record | record alone | with receipt |
| --- | --- | --- | --- |
| 1, 3, 5, 6, 7, 10 | attestation | CHARGED AND WARRANTED | CHARGED AND WARRANTED (10: receipt not kept) |
| 2, 4, 8, 11 | asset refusal | REFUSED AND NOT CHARGED | REFUSED AND NOT CHARGED (11: receipt not kept) |
| 9 | evidence refusal, zeroed | REFUSED AND NOT CHARGED, with a note | REFUSED AND NOT CHARGED, with notes |
| 12, 15 | attestation, v1 label | CHARGED AND WARRANTED | CHARGED AND WARRANTED |
| 13, 16 | asset refusal, v1 label | REFUSED AND NOT CHARGED | DISCREPANCY: signed over a v2 type |
| 14 | evidence refusal, v1 label | DISCREPANCY: v2 encoding under a v1 label | DISCREPANCY |

Three of these deserve a sentence each.

- **Seq 9** carries `"bps": 0` on a refusal that established no ratio. That is
  how v1 said "unknown", and it is the defect v2 exists to fix. Under v1 rules
  the record says what it meant, so it passes, but the zero is reported as a
  note, `not a coverage reading`, and never passed silently. An earlier version
  of the verifier convicted it outright; applying the rules of the declared
  format is the more accurate reading, and under v2 the same bytes are a
  fabrication.
- **Seq 14** is the one record whose label is contradicted by its own contents:
  it declares v1 but lacks the numeric block the v1 encoder always wrote. A
  stranger can see that from the record alone.
- **Seqs 13 and 16** pass from the record alone because an asset refusal with a
  known ratio is encoded identically in both formats. Only the signed payload
  reveals the newer type, so the mislabel shows up only with the receipt.

What v1 recorded about money is accurate throughout: every charged record
matches a real transfer on the mirror node, and no refusal moved anything. What
it got wrong was how it wrote down the absence of a number and, for 12–16, what
it called itself.

## The seam, in code

Marked in three places so it cannot be missed:

- `src/coverage/types.ts` — the `SEAM` banner over the `CoverageSource` contract, and the
  rule that a source may return a reading or fail and may never do anything in between.
- `src/coverage/live.ts` — the `SEAM` banner explaining why it refuses rather than
  approximating.
- Here.

## If you are reviewing this

The question worth asking is: *does the fixture source hide a problem that real data would
expose?*

The parts that would change with real data are the readings themselves. The parts that
would not are the decision rules, the two refusal families, the signing, the payment
flow, the anchoring format, and the verification. Every refusal reason including all five
evidence-family ones is reachable and tested, because the fixture source implements the
same failure contract the live one will — it can be unreachable, stale, self-contradictory,
unresolved, or drifted, and each is a distinct fixture.

What real data would add is the possibility that the readings are wrong in ways nobody
anticipated. That is precisely why the ratio is recomputed by an independent verifier
from published inputs rather than trusted from the service's own output.
