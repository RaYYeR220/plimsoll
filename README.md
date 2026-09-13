# Plimsoll

**A market for tokenised notes whose backing is checked, not asserted.**

A Plimsoll line is the mark on a ship's hull showing how deep she may be loaded. It was made
compulsory in law in 1876, after ships had been deliberately overloaded and sunk for the
insurance. The mark is painted on the outside of the hull, where anyone on the dock can read it.

This repository is that idea for a tokenised note. Notes are issued through Hedera's Asset
Tokenization Studio, traded on an order book that enforces the note's own compliance rules, and
paid from a cash leg the network itself can stop. Coverage, the ratio of the issuer's real vault
positions to what the note owes, is computed from indexed ERC-4626 vault flows and balances read
on chain at a named block. When coverage falls below the note's load line, nothing settles.

## The thesis

Every tokenised-asset demo prices its asset with a number somebody typed into a config file.
Plimsoll has no such number.

- **Outstanding** is the note's `totalSupply()`.
- **Par** is its on-chain nominal value.
- **The threshold** is `LoadLine.lineOf(noteId)`.
- **The holder** is derived from the note's own issuer role, so the service cannot be pointed at
  somebody else's position and told to call it backing.
- **The vault list** is the one thing a chain cannot state, so it is committed on chain as a hash
  and the off-chain list must reproduce it exactly.

And when the evidence is not there, the answer is a typed refusal with a reason, never a number.
"This issuer is short" and "we could not see this issuer" are different claims, and a venue that
blurs them is lying to one side or the other. They are separated in the contract
(`Coverage.Verdict`), in the signed attestation (two distinct EIP-712 types), and in every
interface. An evidence refusal carries no figure anywhere in it, by construction and by test,
because a `0` reads as zero coverage.

## Verify it in one command

```bash
npm --prefix packages/verify run verify
```

No keys, no wallet, no account. It reads the deployment records in this repository and checks
them against the public Hedera mirror node, Sourcify, GitHub and substreams.dev: every contract live
and an exact source match, every transaction with the result the record claims, the reverts
decoded from the contracts' own error ABI, each device signature recovered offline from the exact
text the device displayed, and the paid attestation's transfer present while the refusals'
transfers are absent.

The first run installs and builds what it needs and takes a few minutes. After that it takes
seconds. Three outcomes, and no fourth: a line passes, fails, or is skipped with its reason.
Nothing that could not be checked is reported as a pass.

**Last full run, 2026-09-13: 43 passed, 0 failed, 4 skipped.** One thing that run cannot tell you
on its own, so it is said here: the anchored attestation records it checks were computed from
fixture readings, and each record says so in its own `feed` field. No live coverage figure exists
yet; [MOCKS.md](MOCKS.md) says exactly why.

## How the pieces fit

```
  THE GRAPH                    HEDERA (x402)                 LEDGER
  truth layer                  attestation                   authority
  ───────────                  ───────────                   ─────────
  packages/substreams          packages/attestor             packages/authority
  ERC-4626 flows, share        coverage ratio, signed        a mandate a human reads
  prices, holder positions     EIP-712, sold per call,       and approves on a device
  from The Graph Market        refusals free and signed      refusal = no signature
        │                            │                             │
        │  positions, pinned         │  attestation                │  signature
        │  to a block hash           │  or refusal                 │
        ▼                            ▼                             ▼
  packages/mcp  ──────────►  CoverageOracle  ◄── lineOf ──►  LoadLine ◄── MandateVerifier
  MCP + A2A surface,              fail-closed                  the gate       (adapter-gated)
  provenance on every                  │                          │
  answer, fails closed                 └──── requireClear ────────┤
                                                                  ├─► BerthMarket  (settlement)
                                                                  └─► CouponScheduler
                                                                          │
                                                                  CashLegController
                                                                  HTS freeze key, so a
                                                                  breach stops payment
                                                                  at consensus
```

Read left to right, it is one sentence: **The Graph says what the vaults hold, the attestor turns
that into a signed ratio or a signed refusal, the contracts refuse to move value when the ratio is
short or missing, and only a human with a device can move the line that decides.**

The last link is the one worth dwelling on. Freezing the coupon payer's cash token is a native
Hedera action, not a contract call. Once the freeze is set, the ledger rejects every transfer of
that token by that account at consensus. With the attestation service offline, the scheduler dead
and `CashLegController` never called again, a frozen payer still cannot pay a coupon.

## What is in here

| Package | What it is |
|---|---|
| [`packages/substreams`](packages/substreams) | `plimsoll_erc4626`, a Substreams package over Pinax's ERC-4626 event extractor: vault registry, entry and exit rates kept apart, TVL, per-holder positions, and Messari Yield Aggregator v1.3.1 entities. [v0.2.0 is published](https://substreams.dev/packages/plimsoll-erc4626/v0.2.0): Ethereum mainnet and Base, twelve modules including `map_positions`. |
| [`packages/attestor`](packages/attestor) | The coverage attestation service. x402 on Hedera through the hosted Blocky402 facilitator: an attestation costs 0.001 HBAR, a refusal costs nothing and is signed anyway. Every verdict is anchored to an immutable HCS topic, and the signed attestation is the struct `CoverageOracle` recovers. |
| [`packages/authority`](packages/authority) | The device half. A privileged action needs a signature that only exists if a human approved a plain-English mandate on a Ledger device. A rejection returns `6985` and produces no signature at all. |
| [`packages/contracts`](packages/contracts) | `CoverageOracle`, `LoadLine`, `BerthMarket`, `CouponScheduler`, `CashLegController`, `MandateVerifier` and its adapter. Deployed and Sourcify-verified on Hedera testnet. 201 Foundry tests. |
| [`packages/mcp`](packages/mcp) | The coverage feed as reusable infrastructure over MCP (Streamable HTTP) with an A2A card. Every answer carries provenance: package sha256, module hash, endpoint, block, finality and stream lag. Stale or unresolved data is refused, never guessed. |
| [`packages/backing`](packages/backing) | The issuer's own ERC-4626 positions on Base: status, deposit and withdraw. Everything simulates unless told to send. |
| [`packages/verify`](packages/verify) | The one command above. |
| [`apps/web`](apps/web) | The landing page and the market screens. |

## Running it

Each package's README has the detail. The short version:

```bash
# the contracts
cd packages/contracts && forge test          # 201 tests, forge-std is vendored, no setup step
forge build --sizes                          # EIP-170 margins
python deployments/verify-ids.py             # every deployed id, against the mirror node

# the truth layer (needs a The Graph Market JWT in SUBSTREAMS_API_TOKEN)
cd packages/substreams
substreams run substreams.yaml map_vault_blocks \
  -e mainnet.eth.streamingfast.io:443 -s 25940000 -t +300 -o jsonl
# or take the published package and build nothing:
substreams gui plimsoll-erc4626@v0.2.0

# the attestation service, entirely offline, no credentials
cd packages/attestor && npm install && npm run demo

# the coverage feed over MCP
cd packages/mcp && SUBSTREAMS_API_TOKEN=<jwt> npm run serve     # http://localhost:4030

# the device, against Ledger's emulator (Docker); bring-up is in the package README
cd packages/authority && npm test
```

## Read next

- **[JUDGES.md](JUDGES.md)** is the five-minute path: one command, three links, then where to look
  per sponsor.
- **[PROOF.md](PROOF.md)** is every claim as a link a stranger can open, grouped by claim.
- **[CLAIMS.md](CLAIMS.md)** tags every public statement by what backs it, and lists what is
  explicitly **not** claimed.
- **[MOCKS.md](MOCKS.md)** draws the line between real and simulated, per component, including the
  negative control that must always refuse.

Built for ETHOnline 2026 against Hedera, The Graph and Ledger. MIT licensed. Hedera testnet only,
and not audited.
