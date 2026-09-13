# @plimsoll/attestor

A paid coverage-attestation service for Plimsoll notes, gated with x402 on Hedera.

Ask it whether a tokenised note is backed by the ERC-4626 vault positions its issuer
claims. It answers with one of exactly two things, both signed:

- **an attestation** — the coverage ratio, the block it was read at, and a hash of every
  input that produced it. This costs 0.001 HBAR.
- **a refusal** — a machine-readable reason why it will not attest. This costs nothing.

Not "nothing, after a refund". Nothing at all: no transfer is submitted, so there is no
transaction to void, no gas, and nothing to reconcile. The proof of a refusal is a
transaction that does not exist, and the mirror node is what lets a stranger check that
an absence is really an absence.

## Why this is different from metered x402

The x402 services that already exist answer *"how much did you consume?"* — they meter,
charge proportionally, and refund what was not used. This one answers a different
question: **was this charge warranted at all?** That is binary and adjudicated, not
metered, so it needs no refund path and no custody window. Either the service can prove
coverage and bills once, or it cannot and bills nothing.

The mechanism is deliberately boring underneath. Settlement is the plain `exact` scheme
through the hosted Blocky402 facilitator, because inventing a scheme would mean
self-hosting a facilitator and losing the thing that makes settlement credible. The
novelty is in the *flow*: an x402 extension that publishes the refusal terms in the 402
challenge, and a decision layer that never reaches settlement unless it has something to
sell.

## How the free refusal actually works

Not a special case in our code — the protocol already does this:

1. The Hedera `exact` server scheme declares `paymentFlows.default = "authorization"`.
2. In `authorization`, `settleBeforeHandler` is false, so nothing settles before the
   handler runs.
3. `@x402/express` calls `cancellationDispatcher.cancel(...)` whenever the handler
   answers with a status `>= 400`.
4. `@x402/core/server` finds no `settleOnCancel` on the Hedera scheme and no completed
   settle phases, so it returns immediately. **`/settle` is never called.**
5. The buyer's signed `TransferTransaction` was never submitted to a node. It expires.

So a refusal is any response `>= 400`. That is the whole trick, and it is verified two
ways in the test suite: against a stub facilitator that counts `/settle` calls, and
against the public mirror node, which is asked to produce the transfer and cannot.

## The refusal taxonomy

Two families, and they never blur. A judge has to be able to see that we do not confuse
"this note is under-backed" with "we could not tell".

| reason | family | HTTP | charged | quotes a ratio |
| --- | --- | --- | --- | --- |
| `coverage_below_floor` | asset | 422 | no | yes |
| `declared_exceeds_real` | asset | 422 | no | no |
| `no_attributable_positions` | asset | 422 | no | yes (0) |
| `source_unavailable` | evidence | 424 | no | never |
| `data_stale` | evidence | 424 | no | never |
| `sources_disagree` | evidence | 424 | no | never |
| `vault_unresolved` | evidence | 424 | no | never |
| `vault_set_drift` | evidence | 424 | no | never |

**422** means: the request was fine, the entity it describes does not clear. A verdict
was reached about somebody else's asset.

**424 Failed Dependency** means: this failed on a dependency of ours. No ratio was
computed and none is implied.

The distinction is not just a label. It is committed to inside the EIP-712 signature as
`coverageKnown`, so we can be held to it: an evidence refusal that carried a ratio would
be a signed contradiction. `verify-charge` checks this on every receipt, and the buyer
branches on it — an asset finding is never retried, an evidence refusal is retried with
a backoff.

`declared_exceeds_real` is an asset finding that deliberately quotes nothing. When an
issuer has overstated what they hold, printing a coverage figure beside that invites
someone to rely on it.

## Blocky402 configuration

Hosted facilitator, no SDK and no auth on testnet.

```
FACILITATOR_URL   https://api.testnet.blocky402.com
network           hedera:testnet
scheme            exact          (the only scheme it settles)
x402Version       2              (v2 only)
asset             0.0.0          (native HBAR)
price             100000 tinybar
feePayer          0.0.7162784    injected by the middleware from /supported; never write it yourself
rate limits       100 req/min per IP, burst 10
```

The 402 challenge rides in the **`PAYMENT-REQUIRED`** header as base64, with `{}` as the
body. Inbound payment arrives on **`PAYMENT-SIGNATURE`** (v2), with `X-PAYMENT` accepted
as a v1 fallback. Settlement comes back on **`PAYMENT-RESPONSE`**.

## Environment

| variable | required | what it is |
| --- | --- | --- |
| `PAY_TO` | yes | Hedera account credited on settlement. The payment path needs **no private key**. |
| `ATTESTOR_PRIVATE_KEY` | yes | secp256k1 key that signs EIP-712 attestations and refusals. Not a Hedera account. |
| `FACILITATOR_URL` | no | Defaults to the hosted testnet facilitator. |
| `AMOUNT_TINYBAR` | no | Price in tinybar. Default `100000`. |
| `PORT` / `PUBLIC_BASE_URL` | no | Listen port and the URL the service calls itself. |
| `COVERAGE_SOURCE` | no | `fixture` (default, synthetic `NOTE-*` notes only) or `live`. See MOCKS.md. |
| `LIVE_NOTES_FILE` | for `live` | The shared notes file, `packages/substreams/notes.json`. |
| `BASE_RPC_URL` / `BASE_WITNESS_RPC_URLS` | for `live` | Primary Base endpoint and independent witnesses. Set the primary: the default `mainnet.base.org` throttles into `source_unavailable`. |
| `COVERAGE_ORACLE_ADDRESS` | no | Oracle the signature is bound to. Read from `packages/contracts/deployments/hedera-testnet.json` at run time; set this only to override it. |
| `ORACLE_CHAIN_ID` | no | The other half of the domain, likewise read from the deployment record. |
| `HEDERA_ACCOUNT_ID` | for anchoring | Operator that submits HCS receipts. |
| `HEDERA_PRIVATE_KEY` | for anchoring | **ECDSA secp256k1 only.** ED25519 fails silently in EVM-adjacent tooling. |
| `HCS_TOPIC_ID` | for anchoring | Topic with a submit key and no admin key. |
| `BUYER_ACCOUNT_ID` / `BUYER_PRIVATE_KEY` | buyer only | The consuming agent's Hedera account. |
| `ATTESTOR_AGENT_ID` | buyer only | ERC-8004 agent id, needed to leave feedback. |
| `BUYER_MAX_TINYBAR` | no | Per-payment ceiling for the buyer's spend controls. Default `1000000`. |

Anchoring is all-or-nothing: set all three `HEDERA_*` variables or none. Half-configured
anchoring would mean receipts silently never reaching the topic.

Copy `.env.example` to `.env`; `.env` is gitignored and never committed.

## Running it

Everything offline, with no credentials at all:

```
npm install
npm run demo
```

That adjudicates every fixture note, signs each verdict, builds each HCS record against
the real 1024-byte limit, and verifies all of them back.

The service and a real paid call:

```
npm run serve                      # terminal 1
npm run buyer NOTE-ALPHA           # terminal 2 — pays, gets an attestation
npm run buyer NOTE-BRAVO           # refused, asset family, nothing charged
npm run buyer NOTE-INDIA           # refused, evidence family, nothing charged
```

Register once on ERC-8004 (mints an agent id — running it twice creates a second
identity and splits the reputation):

```
npm run register
```

## Verifying a charge

This is the artifact worth your time. `verify-charge` needs **no keys, no account, and no
access to our infrastructure**. It re-reads the anchored evidence from the public mirror
node, recomputes the coverage ratio with its own arithmetic, asks the ledger what moved,
and prints a verdict.

```
node dist/bin/verify-charge.js --hcs 0.0.10451091:17 --explain
node dist/bin/verify-charge.js --request <requestId> --from https://<host> --explain
```

Three verdicts: `CHARGED AND WARRANTED` (exit 0), `REFUSED AND NOT CHARGED` (exit 0),
`DISCREPANCY` (exit 2). Not being able to evaluate is exit 3 and is never reported as a
verdict.

Proving the negative is the subtle part. A seller with real traffic will have other
transfers in the same window, so "the buyer paid the seller around then" is not evidence
that *this* request was charged. Instead every credit in the window is matched against
the attestations anchored on the topic. A credit some anchored record claims is another
request's legitimate charge; a credit nobody is willing to sign for is the discrepancy.

## What is anchored

Each verdict, charged or not, is one HCS message under 1024 bytes so it never chunks.
It carries the full recomputable input set: vault addresses, raw `convertToAssets`
readings, share balances, block, source set, floor, ratio, policy id, the full source
hash, the full signature, and whether a charge occurred. A stranger re-reads the vaults
at that block, redoes the division, checks the mirror node, and confirms the biconditional:
**charge present if and only if attestation warranted.**

A note with more legs than fit degrades to a digest-only record that says so
(`full: 0`) rather than chunking into messages nobody will reassemble.

### No figure where none was established

Keys are omitted, never zeroed. An evidence refusal carries only who, what and
why — `p v rid n nid d pol att sig chg pay orc cid feed fam rsn known` — and
nothing numeric: no
`bps`, `floor`, `blk`, `obs`, `val`, `obl`, `ud`, `out`, `par`, `ss`, `vsh`,
`srch` or `pos`. A `"bps": 0` would read as zero percent coverage and be
indistinguishable from a genuine `no_attributable_positions` finding; absence
cannot be misread. An asset finding that declines to quote a ratio
(`declared_exceeds_real`) keeps its readings, which are the finding, but omits
`bps` and `floor`.

The same holds in the signature. Refusals are two EIP-712 types: `AssetRefusal`,
which signs `coverageKnown` and the ratio fields, and `EvidenceRefusal`, which
signs only `noteId, reason, expiry, nonce`. The primary type is hashed into the
digest, so an evidence refusal's signature re-presented as an asset refusal
reporting zero coverage recovers to a different address.

### Format versions, and the records before them

Every record declares its format in `v`, and the verifier applies the rules of
the version the record declares: which payload type its signature must be over,
and which keys it may or must carry. A record whose declared version and actual
encoding disagree fails.

- **v1, sequences 1–16.** The v1 encoder always wrote the full numeric block,
  zeroing what it did not know, and signed refusals as a single `Refusal`
  struct. Sequences 12–16 were written after the omission encoding and the split
  signature types landed but before the version changed, so they are v2 content
  under a v1 label.
- **v2, sequences 17–21.** Figures are omitted, never zeroed, and refusals are
  signed as `AssetRefusal` or `EvidenceRefusal`.
- **v3, from sequence 22.** The signed attestation is the struct `CoverageOracle`
  recovers, under a domain bound to that oracle, so an attestation this service
  sells is one the chain can accept. The record also gained the fields that make
  it checkable on its own: `nid` (the note id the oracle knows), `orc` and `cid`
  (the oracle and chain the signature is bound to), `pay` (the account a charge
  would have credited) and `feed` (which source produced the readings).

v1 and v2 signatures could never have been accepted on chain: they signed a
`string` note id, a `uint32` coverage and a random `bytes32` nonce under a domain
naming no contract, and the two implementations of that digest were written by
hand and never compared. `test/typed-data.test.ts` is the check that should have
existed from the start — it asserts the type string is still verbatim in
`CoverageOracle.sol`, recomputes the typehash with `cast` rather than the library
that signs, and asks the deployed contract's own `hashAttestation` whether our
digest matches across the full range of every field.

The topic is immutable, so the v1 records stay where they are and remain
checkable under v1 rules. Checked from the public record alone, every v1 record
passes except seq 14, the one whose v1 label is contradicted by the record
itself. Seq 9, the zeroed evidence refusal, passes under the rules it was
written to, with the zero reported as not a coverage reading. MOCKS.md has the
per-record results, including the mislabels that only our stored receipts
expose.

### Canonical records

The records worth citing are live readings, anchored as format v3 with
`"feed": "live"`: a paid attestation for PLIM-B, and a free refusal for PLIM-A,
whose $1.00 of real backing against a $1,000,000.00 obligation floors to 0 bps
against its own 9500 bps line. That zero is a finding about the asset, refused as
`coverage_below_floor`; an unreachable source would have refused as an evidence
failure with no figure at all. A real zero and an absence are different answers.

Sequences 22–24 are v3 records produced from fixtures, and two of them carry real
market codes with invented figures. They are not cited; MOCKS.md says why.

### On `CoverageOracle`

An attestation is submitted exactly as it was sold. `submit-oracle --receipt` takes
the stored receipt of a paid call, checks that its feed is live and that its
signature recovers under the oracle's domain, and sends those bytes — then sends
them again, which the oracle must reject as stale, because an oracle that accepted
anything carrying a valid signature would be checking the signature and nothing
else. It refuses a simulated feed, never submits a refusal, and sends nothing
without `--submit`.

```
npm run submit-oracle -- --receipt data/receipts/<requestId>.json            # dry run
npm run submit-oracle -- --receipt data/receipts/<requestId>.json --submit
```

## Honest limits

- **Two sources, and every record names which.** `LiveCoverageSource` reads real
  positions on Base and the note's figures on Hedera; the fixture source serves the
  synthetic `NOTE-*` notes for tests and the offline demo. Each anchored record says
  which produced it in `feed`. Nothing built from a fixture is submitted on chain — see
  MOCKS.md for the one time it was, and what changed.
- **The fixture vault addresses are not deployed contracts.** They are syntactically
  valid addresses over invented balances, used only by synthetic notes.
- **The load line is the note's, not ours.** It is read from `LoadLine.lineOf` with the
  note's other figures, so PLIM-A is measured against 9500 bps and PLIM-B against
  10000. The service has no floor setting to get wrong.
- **`verify-charge` does not re-read the vaults.** It recomputes the ratio from the
  anchored readings and checks the payment biconditional; re-reading Base at the
  anchored block is left to the reader.
- **Single-writer nonce and receipt stores.** Files on disk, adequate for one process.
  Horizontal scaling needs shared storage.
- **The HCS-14 UAID follows the reference implementation, not the spec prose.** The
  standard says to sort keys lexicographically; the reference code emits `skills` first.
  We follow the code and pin the exact bytes we hash in a test, so anyone can check ours
  against theirs. We have not cross-validated against another implementation.
- **The on-chain ERC-8004 `agentURI` is a self-contained `data:` URI**, not an HTTPS link,
  because the service has no public host yet and re-registering to fix a URL would mint a
  second agent id. It carries a `canonical` field naming where the fuller document will
  be served. Once deployed, that URL should serve
  `/.well-known/agent-registration.json`.
- **Settlement is all-or-nothing.** `SettlementOverrides { amount }` only works in schemes
  that support partial settlement such as `upto`, which does not exist on Hedera. For an
  attestation, full price or nothing is the correct semantics anyway.
- **Testnet only.** Nothing here has been exercised on mainnet.

## Layout

```
src/
  attest.ts          the decision: attested or refused, never anything else
  server.ts          the x402 seller
  buyer.ts           the consuming agent, including ERC-8004 feedback
  anchor.ts          HCS receipts, kept under the 1024-byte limit
  verify.ts          keyless verification primitives
  extension.ts       the x402 extension that publishes the refusal terms
  eip712.ts          typed-data signing and recovery
  erc8004.ts         identity and reputation registries on chain 296
  hcs14.ts           offline UAID, no dependencies
  mirror.ts          public mirror node access
  coverage/          THE SEAM: CoverageSource, fixtures, and the live stub
bin/
  verify-charge.ts   the judge-runnable proof
  submit-oracle.ts   puts a live, paid-for attestation on CoverageOracle; refuses anything simulated
  register-agent.ts  one-time ERC-8004 registration
demo/offline.ts      the whole product with no credentials
test/                node:test
```
