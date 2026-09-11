# Plimsoll — contracts

A Plimsoll line is the mark on a hull showing maximum safe loading. Past it, the authorities do
not let the ship sail.

This package is the on-chain half of a marketplace for tokenised notes backed by real ERC-4626
vault positions. **Coverage** is the value of the issuer's attributable vault positions divided by
notes outstanding times par. When coverage falls below the load line, the market refuses to
settle — and refuses in a way that survives our servers being switched off.

Everything here is deployed and verified on Hedera testnet, trading a note issued through the
already-deployed **Asset Tokenization Studio v8.0.0**. We deploy none of ATS; we are a client of it.

---

## What is actually built

Hedera's ATS issues compliance-enforced securities and has **no secondary market** — no orderbook,
no marketplace, no DEX, no swap anywhere in its 544 Solidity files. That gap is the product.

| Contract | What it is |
|---|---|
| `CoverageOracle` | Holds the current EIP-712 coverage attestation per note. Fails closed on every branch. |
| `LoadLine` | The authority gate: per-note threshold and halt state, moved only by a human-approved mandate that names the exact value written. |
| `BerthMarket` | An order book over ATS notes. Escrows with ATS holds, pre-flights both legs, consults the load line on every path. |
| `CouponScheduler` | Coupons that fire from the ledger's own scheduler (HIP-1215), re-arm themselves, and terminate at maturity. |
| `CashLegController` | Creates the HTS cash token and holds its freeze key, so a breach stops payment at consensus. |
| `MandateVerifier` | Recovers an EIP-191 mandate a person approved on a hardware device. |
| `MandateVerifierAdapter` | Carries that decision into `LoadLine` through a minimal `IMandateAuthority`. |

### The idea worth arguing about

**"This issuer is short" and "we cannot see this issuer" are different claims, and a venue that
conflates them is lying to one side or the other.**

`Coverage.Verdict` splits them on-chain:

- `Short` — a finding about the asset. Evidence is good and says the issuer is under-collateralised.
- `Unproven` — a statement about our own evidence. The attestation expired, the source data aged
  out, the backing set moved, nobody ever attested.

Both refuse to settle. They are not the same thing, and `Coverage.isEvidenceFailure` lets the UI
and the revert share one vocabulary instead of each inventing its own. `LoadLine.status` checks
them in a deliberate order: a human halt outranks any number, and evidence quality is checked
before the number, so we never call an issuer short on evidence we no longer trust.

---

## Architecture

```
                          a human, holding a device
                                    │  EIP-191 signature over a readable mandate
                                    ▼
   attestor service                MandateVerifier ──── MandateVerifierAdapter
        │ EIP-712                                              │ IMandateAuthority
        ▼                                                      ▼
   CoverageOracle  ◄──────── coverageOf / lineOf ────────►  LoadLine
        │                                                      │
        │  evidenceOf                        requireClear ─────┼──────────────┐
        ▼                                                      ▼              ▼
   (vault evidence)                                      BerthMarket   CouponScheduler
                                                               │              │
                                        ATS holds + operator ───┤              ├─── HIP-1215 0x16b
                                        transfers on the note   │              │    self-rescheduling
                                                                ▼              ▼
                                                          ATS note        CashLegController
                                                        (PLIM-A bond)      HTS 0x167 freeze key
```

### `BerthMarket`, concretely

- **Asks escrow.** `createHoldFromByPartition` puts the maker's notes in an ATS hold with
  `to == address(0)`, which ATS reads as "destination not fixed at creation". That is what lets a
  resting order be escrowed before any taker exists, and it means settlement is one hop from maker
  to taker. **The venue is the hold's escrow but never its destination, so it never custodies a
  note and never has to pass the note's own KYC.**
- **Bids are allowance-backed.** Cash is HTS; holding it would require the venue to be associated
  with every cash token it ever quotes. Instead the pre-flight reads the maker's balance, allowance
  and freeze state, so an unfundable bid is refused at match time with a reason code. The asymmetry
  is real: an ask cannot fail for want of notes, a bid can go stale.
- **Nothing is booked before both legs are asked.** `Preflight.noteLeg` probes ATS's non-reverting
  eligibility check and surfaces its reason code verbatim — an ATS error selector, so the UI decodes
  `AccountIsBlocked` / `InvalidKycStatus` / `ComplianceNotAllowed` / `IsPaused` with no translation
  table on our side. If neither shape of the check answers, we report a refusal rather than a pass.
- **Cash moves in one hop.** `transferFrom(payer, payee, cost)` with the venue only as approved
  spender. It never rests on a balance, so on Hedera it never needs to associate with the cash token.
- **Cancel is not gated on the load line.** A halt stops trading; stopping a maker from withdrawing
  their own notes would make it a seizure.

### `CouponScheduler`, concretely

Hedera's scheduled transactions are one-shot with a 62-day ceiling, so a recurring coupon must
re-arm itself from inside its own execution. That is the interesting part and the dangerous part.

- **Three independent stops.** Maturity, a hard `maxPeriods` cap, and a strictly advancing
  `nextPaymentAt`. All three would have to be wrong at once for the loop to run on.
- **Hopping.** Anything past the 55-day horizon books a wake-up instead. `executeCoupon` notices it
  is early, pays nothing, and books the next leg. Quarterly and annual coupons work.
- **Response codes are checked.** Calls into `0x16b` never revert; they return an `int64`, and 22 is
  the only value that means success. A rejected schedule leaves `armed` false, emits
  `ScheduleRejected` and waits for a permissionless `rearm`. It does not pretend to have succeeded.
- **Payment failures are swallowed on purpose.** If the KPI write or the cash transfer reverted,
  that revert would roll back the re-arm and the schedule would die silently at the first missed
  coupon. So they are caught, counted and evented. The safety property is preserved *before* the
  attempt: coverage is checked first, so a swallowed failure can never become a payment.

Coverage is fed into ATS through `KpisFacet.addKpiData`, which is what `KpiLinkedRateFacet` reads at
coupon fixing — so the coupon rate is a function of coverage inside ATS's own architecture rather
than a number bolted on beside it. A low reading is written just like a high one; suppressing it
would flatter the issuer. What is never written is a number we cannot prove.

---

## The cash leg: exactly which part is EVM and which is native

This is the one place where the rule holds with our server off, so it is worth being precise.

**EVM — this contract, our logic, able to be wrong or unavailable:** creating the token, choosing
its keys, deciding *when* to freeze, and calling `0x167` to do it.

**Native — the network, no contract consulted:** the freeze flag itself. Once an account is frozen
for this token, Hedera rejects every transfer of it by that account at consensus — a CryptoTransfer
signed by the account's own key, an ERC-20 `transferFrom` through the token's facade, a HIP-1215
scheduled call, a contract with an allowance. With our attestor offline, our scheduler dead and
`CashLegController` never called again, **a frozen payer still cannot pay a coupon.**

`test_AFrozenPayerCannotPayACouponEvenWithCoverageRestored` proves this the hard way: it freezes the
payer, then rigs the load line to wrongly report clear, and the coupon still does not pay.

**Which key controls the freeze, exactly.** Token `0.0.10474297`'s freeze key is a **contract-ID
key naming `0.0.10474287`**, which is `CashLegController` at
`0xccedcc53902b925c72e3c45d4cc176806326b30b`. The mirror node renders it as `ProtobufEncoded`
because a contract-ID key is not a plain ed25519 or ECDSA key — the bytes `0a0518afa6ff04` decode as
`Key.contractID.contractNum = 10474287`. The supply key is the same. **There is no admin key**, so
the freeze key can never be rotated away and this controller can never be replaced for this token.
That is deliberate, and permanent. `deployments/verify-ids.py` asserts all of it against the mirror
node rather than asking you to take it on trust.

`tripBreaker` and `resetBreaker` are **permissionless**, because they do not decide anything: they
read `LoadLine` and make the ledger agree with it. Anyone may push the button; nobody may choose the
answer.

### What Solidity cannot do here

Stated plainly rather than faked:

- **It cannot associate a third party with the token.** Every counterparty must associate itself
  (HIP-719 `associate()` on the token address, or an SDK `TokenAssociate`). A contract can only
  associate *itself* — that is what `associateSelf` is for.
- **It cannot create the token for free.** HTS charges an HBAR fee, so `createCashToken` is payable
  and the controller must be funded first.
- **It cannot freeze an account that never associated.** There is nothing to freeze. Such a payer
  already cannot receive or send the token, which fails in the same direction, but `tripBreaker`
  reports a Hedera response code rather than succeeding.
- **`forge script` cannot drive HTS at all.** It executes the script body locally and `0x167` has no
  EVM bytecode there, so the call dies with `InvalidFEOpcode`. Every HTS call in this deployment was
  made with `cast send` instead. This is a Foundry/Hedera limitation, not a contract problem.

---

## Deployed on Hedera testnet (chain 296)

All seven verified on Sourcify, `exact_match`. Full record with every transaction hash:
[`deployments/hedera-testnet.json`](deployments/hedera-testnet.json). The first stack, deployed 2026-09-10 against a software mandate key, is kept there under `superseded` rather than deleted; `CoverageOracle` carried over and was rewired, so the registered note and its attestor are unchanged.

| Contract | EVM address | Hedera |
|---|---|---|
| `MandateVerifier` | `0xe7e95d63f903e36c7a34ee2adf9fc7dcff49515a` | `0.0.10474281` |
| `MandateVerifierAdapter` | `0xb8a94643111ba230459f1d7ecf3bdbc348b83e63` | `0.0.10474283` |
| `CoverageOracle` | `0xCE13De224ed918D7b8B2717492849e0A82648ca3` | `0.0.10451752` |
| `LoadLine` | `0xf867b6f41b21e9d72f327f867ae898620d022c80` | `0.0.10474285` |
| `CashLegController` | `0xccedcc53902b925c72e3c45d4cc176806326b30b` | `0.0.10474287` |
| `BerthMarket` | `0xd7d2d82444d7fda06f32628b454bfb3c78c87d5e` | `0.0.10474313` |
| `CouponScheduler` | `0x48d9169f50f1b07076860ea7a3743257aa933d07` | `0.0.10474314` |

**The note being traded** — a real bond issued through ATS, not a mock:
`PLIM-A` / ISIN `US0000PLIMA6`, `0xe2Bf359650fbacc7D4801336F8C1FE7061aD6387` (`0.0.10451856`).
10,000.00 issued, 1,000.00 transferred to a second KYC'd holder.

**The cash leg** — HTS native token `PCASH`, `0.0.10474297`, 6 decimals, freeze key as above.

### Asset Tokenization Studio v8.0.0 (already deployed; we deploy none of it)

| | |
|---|---|
| BusinessLogicResolver | `0xBA2D5FC2083A0b8f164c50e65d782087fBA18E0a` (`0.0.9212226`) |
| Factory | `0xd1F118A40f3b02883D35909eF2517e7EDd78379d` (`0.0.9213391`) |
| Bond config | `0x…02`, version 1 |

### The denial, on-chain

`0x5da97170646574339edc856f5c04b99668e27f38` was added to the note's control list (blacklist mode),
then a transfer to it was attempted:

> [`0x61e008b403d41541333144b06e69fbea84959f7f95f9800d0624a0196f710002`](https://hashscan.io/testnet/transaction/0x61e008b403d41541333144b06e69fbea84959f7f95f9800d0624a0196f710002)
> — `CONTRACT_REVERT_EXECUTED`, revert data
> `0x796c1f0d` + `0000…5da97170646574339edc856f5c04b99668e27f38`
> = `AccountIsBlocked(0x5da9…7f38)`

The error is declared zero-arg in the ATS interface, but the revert appends the ABI-encoded address.

And the same refusal seen through the **non-reverting pre-flight** that `BerthMarket` calls before
it books anything — the whole point being that a compliant venue never *reaches* the revert above:

| `canTransferByPartition` to | status | EIP-1066 | reason |
|---|---|---|---|
| blocked counterparty | `false` | `0x10` | `0x796c1f0d` `AccountIsBlocked` |
| allowed counterparty | `true` | `0x01` | `0x00` |

> **Read it as the token holder.** The answer depends on `msg.sender`: read as some other contract
> it returns `InsufficientAllowance` (`0xf180d8f9`, EIP-1066 `0x54`), because ATS assumes an
> operator-style transfer when the caller holds no allowance. `BerthMarket` reads it as itself and
> *is* an authorised operator for the leg it moves, so the assumption ATS makes is the correct one
> for us.

### The device path, live on-chain

`MandateVerifier` `0xe7e95d63f903e36c7a34ee2adf9fc7dcff49515a` trusts exactly one key, `0x69fC09FA24102a5C02B227072Bee5b71d7AeF3e2` — a Ledger Nano S Plus emulated by Speculos (app-ethereum 1.22.3) and seeded with a freshly generated **private** mnemonic that lives outside this repository. It is deliberately not the public Speculos test seed, whose address anyone can sign for. Every mandate below was rendered on the device screen, decided there, and then submitted to `LoadLine`:

| Where | What | Result |
|---|---|---|
| device | `SET-THRESHOLD` at line 95.00%, coverage 120.00% | approved |
| chain | same mandate submitted with 90.00% - must revert | REVERTED `0x20e11789` — [`0x5daded84…`](https://hashscan.io/testnet/transaction/0x5daded84a201077440491157d92d1301c03db8405443f9a7d384f4e734f4f98c) |
| chain | same mandate submitted with the 95.00% it approved | SUCCESS — [`0x5edc25a9…`](https://hashscan.io/testnet/transaction/0x5edc25a9b1a6163b481069809bb33aa31cd6ec65deca9ffa66b229e5604a1f19) |
| state | after threshold | halted **false**, line 95.00% |
| device | `HALT` at line 95.00%, coverage 91.00% | approved |
| chain | device-approved HALT accepted | SUCCESS — [`0xe14eb037…`](https://hashscan.io/testnet/transaction/0xe14eb03715dba824a06de55bc0aea6753e790f6f6073f21ac8ff06bc492bbee3) |
| state | after halt | halted **true**, line 95.00% |
| device | `RESUME` at line 95.00%, coverage 98.00% | **rejected** — `6985`, no signature exists |
| chain | RESUME signed by a non-device key - must revert | REVERTED `0x5f7e60e8` — [`0x764611a2…`](https://hashscan.io/testnet/transaction/0x764611a2e0c8f848202595d31177085d0bd9e618715b8f0aea6cc71cf9cd088c) |
| state | after rejected resume | halted **true**, line 95.00% |
| device | `RESUME` at line 95.00%, coverage 98.00% | approved |
| chain | device-approved RESUME accepted | SUCCESS — [`0x29465ed2…`](https://hashscan.io/testnet/transaction/0x29465ed228b7d7173dc91a0e07b146a1ca8c3203d6a8f5d5323dc071f33843bc) |
| state | after approved resume | halted **false**, line 95.00% |

Two refusals worth reading. A mandate the device signed for **95.00%** was first submitted with **90.00%** as the value to write, and reverted with `MandateValueMismatch` before the verifier consumed it — the same approval then succeeded for the 95.00% it named. And after the device rejected a `RESUME` there was no signature to submit at all; a resume signed by any other key reverts with `WrongAuthority`, so the market stayed halted until a human approved it.

Full transcript and every signature: [`deployments/device-proof.json`](deployments/device-proof.json). Its `screens` field is the text the device actually rendered, page by page - `LOAD LINE: 95.00%` included - read back from the emulator rather than reconstructed. The PNGs in [`deployments/device/`](deployments/device/) only capture the first page of each review, which reads "Review message" for every mandate; the transcripts are the evidence of what was shown.

---

## Tests

**194 passing, 0 failing, 10 suites.** `forge test`

| Suite | Tests | Covers |
|---|---|---|
| `CoverageOracle.t.sol` | 39 | Every fail-closed branch; replay, expiry, vault-set swap, wrong key, malleable signature, cross-deployment replay |
| `BerthMarket.t.sol` | 36 | Escrow, settlement, partial fills, cancel/reap, every pre-flight refusal, coverage gate |
| `CouponScheduler.t.sol` | 30 | Arming, withholding, hopping, termination, runaway caps, rejected reschedules |
| `MandateVerifier.t.sol` | 26 | The device mandate, against a signature a real Ledger produced |
| `LoadLine.t.sol` | 24 | Refusal ordering, mandate gating, owner gating, fail-closed wiring |
| `MandateVerifierAdapter.t.sol` | 16 | Action mapping, market-code charset, the written value bound to the mandate |
| `CashLeg.t.sol` | 13 | Token creation, response codes, the circuit breaker, consensus-level enforcement |
| `Invariant.t.sol` | 6 | The product invariant, plus proof the rig is not inert |
| `EndToEnd.t.sol` | 2 | Issue → place → match → settle → coupon, and the same note failing the line |
| `Bytecode.t.sol` | 2 | EIP-170 |

### The invariant is the product

```
invariant_NothingSettlesPastTheLoadLine   128 runs, 8192 calls
invariant_NoCouponPaysPastTheLoadLine     128 runs, 8192 calls
invariant_NotesAreConserved               128 runs, 8192 calls
invariant_VenueHoldsNothing               128 runs, 8192 calls
```

A handler drives arbitrary interleavings of attestations, time, authority actions and trading.
Before every value-moving call it records what the load line said; if value moved anyway, it counts
a violation. **No path settles a trade or pays a coupon while coverage is below the line, halted, or
stale.**

Green invariants prove nothing if every fuzzed action reverts into a `catch`, so
`test_HandlerRigActuallyExercisesTheProtocol` walks the same handler through a scripted happy path
and asserts it really does settle trades and pay coupons. Two bugs in the rig were caught this way
and fixed: an irreversible vault-set move that bricked the note for the rest of every run, and fill
sizes drawn independently of what was left on the order.

### EIP-170

Asserted in `Bytecode.t.sol`, which fails the build rather than the deploy. Hedera enforces the
24,576-byte limit and ATS already sits at 97% of it in places, so there is a comfort ceiling at
20,000 as well — passing at 24,500 bytes is not passing.

| Contract | Runtime | Margin |
|---|---|---|
| `BerthMarket` | 8,697 | 15,879 |
| `CouponScheduler` | 8,195 | 16,381 |
| `MandateVerifier` | 6,767 | 17,809 |
| `CoverageOracle` | 6,375 | 18,201 |
| `CashLegController` | 5,455 | 19,121 |
| `MandateVerifierAdapter` | 3,970 | 20,606 |
| `LoadLine` | 3,642 | 20,934 |

Largest is 35% of the limit. Logic lives in libraries (`Coverage`, `Preflight`, `Ecdsa`,
`HederaResponse`) from the start rather than as a day-three refactor.

---

## Running it

```bash
forge build
forge test                       # 194 tests
forge test --profile ci          # 4096 fuzz runs, 512 invariant runs
forge build --sizes              # EIP-170 margins
python deployments/verify-ids.py # every deployed id, checked against the mirror node
```

`forge-std` is vendored under `lib/` rather than installed as a submodule, so a fresh clone runs the
suite with no setup step.

### Deploying

Copy `.env.example` to `.env` and fill it in. `.env` is gitignored and must stay that way.

```bash
forge script script/Deploy.s.sol:DeployCore    --rpc-url $HEDERA_RPC_URL --broadcast --legacy --slow --skip-simulation
# HTS cannot be driven from forge script (see above) - use cast send:
cast send $CASH_CONTROLLER --value 40000000000000000000 --rpc-url $HEDERA_RPC_URL --private-key $PRIVATE_KEY --legacy
cast send $CASH_CONTROLLER "createCashToken(string,string,string,int32,int64,int64)" \
  "Plimsoll Cash" "PCASH" "Plimsoll cash leg" 6 0 1000000000000000 \
  --value 30000000000000000000 --rpc-url $HEDERA_RPC_URL --private-key $PRIVATE_KEY --legacy --gas-limit 3000000

forge script script/Deploy.s.sol:DeployVenue   --rpc-url $HEDERA_RPC_URL --broadcast --legacy --slow --skip-simulation
forge script script/Deploy.s.sol:ConfigureNote --rpc-url $HEDERA_RPC_URL --broadcast --legacy --slow --skip-simulation
forge script script/IssueNote.s.sol:IssueNote  --rpc-url $HEDERA_RPC_URL --broadcast --legacy --slow --skip-simulation
```

`--skip-simulation` is required: Hedera's relay does not support the simulation forge wants.
`--legacy` because Hedera does not take EIP-1559 transactions from this path. Hashio rate-limits
aggressively; `--slow` and backing off beats tight retries.

### Verifying

```bash
forge verify-contract <address> src/LoadLine.sol:LoadLine \
  --chain-id 296 --verifier sourcify --verifier-url https://sourcify.dev/server \
  --constructor-args $(cast abi-encode "constructor(address,address)" $ADAPTER $OWNER)
```

> `https://server-verify.hashscan.io` now 308-redirects to `https://sourcify.dev/server` **and drops
> the path**, which makes `forge verify-contract` fail with a response-decoding error. Point it at
> `https://sourcify.dev/server` directly. Chain 296 is supported there.

Metadata must stay in the bytecode for Sourcify to match, so `bytecode_hash = "ipfs"` — do not set
it to `none`.

### Environment

| Variable | What it is |
|---|---|
| `HEDERA_RPC_URL` | JSON-RPC relay. `https://testnet.hashio.io/api` |
| `PRIVATE_KEY` | Deployer, ECDSA secp256k1, `0x`-prefixed |
| `OWNER` | Deployment administrator. Defaults to the deployer |
| `MANDATE_AUTHORITY_SIGNER` | The key whose signature `MandateVerifier` accepts — a device in production |
| `ATTESTOR` | The service key that signs EIP-712 coverage attestations |
| `NOTE_MARKET` | The market code a human reads on the device. `noteId` is `keccak256` of it |
| `VAULT_SET_HASH` | Commits to the exact set of backing vaults |
| `MAX_AGE_SECONDS` | Protocol-side freshness bound; 0 leaves expiry as the only backstop |
| `CASH_TOKEN` | EVM address of the HTS cash token |
| `CASH_CREATE_FEE_WEI` | HBAR to forward for the HTS create fee |
| `ATS_FACTORY`, `ATS_RESOLVER`, `ATS_BOND_CONFIG_ID` | The deployed ATS |

> `forge` does not reliably read `.env` for every variable in a file this size. Source it into the
> shell first: `set -a && . ./.env && set +a`.

---

## Honest limits

Things that are less than they might look. Under-claiming precisely beats over-claiming vaguely.

**The device governs the load line, and nothing else.** Halting, resuming and moving a threshold
require a mandate a human approved on a hardware device. **Everything else is owner-gated** —
wiring the oracle, registering notes, rotating an attestor, moving a vault set, creating schedules,
creating the cash token. Those take an address or a hash as their argument, and a mandate is only
worth something if a person can read what they are approving; raw hex on a four-line device screen
is a rubber stamp with extra steps. Deployment-time administration is owner-controlled and is *not*
covered by the device mandate.

**The owner can repoint the authority.** `LoadLine.setMandateAuthority` is owner-gated, so an owner
who swaps the authority governs the load line too. The honest description of this system is "the
device approves load-line changes", not "nobody can bypass the device".

**A halt or resume mandate's coverage figure is what the human was told, not what the oracle says.**
The threshold a mandate names is now bound to the value written — a mismatch reverts before any
write. But the coverage number printed on a `HALT` or `RESUME` mandate is only checked for internal
consistency (`MandateVerifier` refuses a resume whose own numbers are under the line); `LoadLine`
does not compare it to the oracle. A resume approved on a stale figure lifts the halt, and trading
then still requires the oracle to read clear, so it cannot open settlement on its own.

**`MandateVerifier`'s entrypoints are public.** Someone who obtains a signed mandate before it lands
could apply it to the verifier directly, leaving `LoadLine` out of step with it until the owner
repoints the authority. Hedera has no public mempool, which makes that interception impractical
rather than impossible. The complete fix is for `LoadLine` to read halt state from the verifier
instead of keeping its own copy.

**"How old is this data" is answered in wall-clock seconds, not source-chain blocks.** There is no
light client for the source chain, so we cannot know its true head. `asOfBlock` is still load-bearing
— it is checked for regression at intake, which catches an attestor replaying old vault data under a
fresh nonce — but staleness itself is measured against a protocol-set `maxAgeSeconds`. An earlier
draft measured lag against the highest block we had been shown; that check was dead code, because
the head and the record always advanced together. It was replaced rather than left in to look good.

**The attestor is trusted to tell the truth.** The oracle verifies *who signed* and *that the
evidence is fresh and about the right vaults*. It cannot verify the vault positions themselves;
`sourceHash` commits to an evidence bundle that is checked off-chain. A dishonest attestor with a
live key can report any coverage under the plausibility cap.

**A mandate authority that goes away freezes every threshold** at its current value. Notes keep
trading under the last approved line rather than falling open — the right direction to fail, but a
liveness dependency.

**Bids can go stale.** An ask is escrow-backed and cannot fail for want of notes. A bid is
allowance-backed, so a maker can spend the cash out from under it; the pre-flight catches it at match
time with a reason code instead of a revert, but it is a weaker guarantee and the two are not
equivalent.

**Unfunded coupons look like successful transactions.** The self-rescheduling loop deliberately
swallows payment failures so a missed coupon cannot kill the schedule. Every failure is evented and
counted, but anything monitoring this contract must watch `CouponUnfunded` / `CouponWithheld` /
`ScheduleRejected`, not transaction receipts.

**The cash token is permanently tied to this controller.** No admin key means the freeze key can
never be rotated. That is what makes the breaker credible; it also means the controller can never be
replaced for this token. If that trade is wrong for a deployment, the token has to be created
differently — it cannot be fixed afterwards.

**The device is emulated, with a private seed.** The deployed verifier trusts a Speculos-emulated
Nano S Plus seeded with a freshly generated mnemonic held outside this repository — not the public
test seed, and not the deployer's key. That makes every load-line change require a signature from a
key nobody else holds, produced through the device's own review screens. What emulation does not
give you is hardware: on a physical Ledger the key would additionally be non-extractable, whereas
an emulator's seed exists as a string on the machine running it.

**Testnet resets wipe both state and Sourcify verifications.** These addresses were deployed
2026-09-10 and may need redeploying and re-verifying.

**Not audited.** Three days of work for a hackathon.

---

## Layout

```
packages/contracts/
├── src/
│   ├── CoverageOracle.sol          coverage evidence, fail-closed
│   ├── LoadLine.sol                the authority gate
│   ├── BerthMarket.sol             the compliance-enforced order book
│   ├── CouponScheduler.sol         HIP-1215 self-rescheduling coupons
│   ├── CashLegController.sol       HTS cash token + circuit breaker
│   ├── access/Owned.sol            two-step ownership for deployment admin
│   ├── authority/
│   │   ├── MandateVerifier.sol         device-approved mandates
│   │   └── MandateVerifierAdapter.sol  IMandateAuthority over the verifier
│   ├── interfaces/                 IAts, IHederaTokenService, IHederaScheduleService, …
│   └── libraries/                  Coverage, Preflight, Ecdsa, HederaResponse
├── test/                           194 tests, 10 suites
├── script/                         Deploy, Redeploy, IssueNote
├── deployments/                    on-chain record, live device proof, mirror-node verifier
└── lib/forge-std/                  vendored
```
