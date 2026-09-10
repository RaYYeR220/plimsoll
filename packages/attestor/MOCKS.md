# What is real and what is not

One rule governs this package: **the service never fabricates a coverage number.** If the
data is not there it refuses and says so. This file states exactly where the line falls,
because a coverage attestation whose provenance is fuzzy is worth less than no
attestation at all.

## Simulated

### The coverage data

**`src/coverage/fixtures/*.json` is the only working data source today.**

The production source is a Substreams pipeline over ERC-4626 vault flows, built
separately and not ready. `LiveCoverageSource` (`src/coverage/live.ts`) is its typed
placeholder and throws `SourceUnavailable` on every call. It is not a partial
implementation and deliberately so: a source that returned a plausible number from an
incomplete index would produce a signed attestation nobody can reproduce, which is the
exact failure this product exists to prevent.

Setting `COVERAGE_SOURCE=live` today yields a service that refuses every request with
`source_unavailable`. That is the honest behaviour, not a broken one, and it is covered
by a test.

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
| EIP-712 signing | real. Attestations and refusals are signed and recovered with `viem`. |
| HCS anchoring | real. Consensus messages on a topic with a submit key and no admin key, each under 1024 bytes, single-chunk. |
| Mirror node | real. Public REST API, no credentials. |
| ERC-8004 identity | real. `register()` on the deployed registry at `0x8004A818…`, chain 296. |
| ERC-8004 reputation | real. `giveFeedback()` on `0x8004B663…` with `proofOfPayment` carrying the settlement id. |
| HCS-14 UAID | real, with a caveat. Pure offline SHA-384, no dependencies. See the field-ordering note in README limits. |
| `verify-charge` | real. Zero credentials, public data only. |

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
