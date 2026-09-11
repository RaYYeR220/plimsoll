# Proof

Every claim below is a link you can open. Grouped by claim, not by package.

> **Hedera testnet resets wipe both state and Sourcify verifications.** If a link stops resolving,
> that is what happened, and the deployment has to be re-run and re-verified. Nothing here is on
> mainnet.
>
> **Everything on this page was last checked on 2026-09-12.** Each transaction was fetched from
> the public mirror node at `testnet.mirrornode.hedera.com/api/v1/contracts/results/<hash>` and
> each contract from `sourcify.dev/server/v2/contract/296/<address>`. HashScan is the same records
> rendered for a human; it is a browser application, so the mirror node link beside each one is
> the machine-checkable form. Anything that did not resolve is said so, at the bottom.

To check the whole page at once instead of link by link:

```bash
npm --prefix packages/verify run verify -- --links
```

---

## 1. The contracts are live, and the source matches the bytecode

All seven are `exact_match` on Sourcify for chain 296, and each was created by the transaction the
deployment record names. The record is
[`packages/contracts/deployments/hedera-testnet.json`](packages/contracts/deployments/hedera-testnet.json);
the verifier reads addresses from it at run time rather than hardcoding them, so a redeploy is
checked as it is now.

| Contract | Hedera | EVM address | Sourcify | Explorer |
|---|---|---|---|---|
| `MandateVerifier` | `0.0.10477161` | `0x835408327a72307e79826aa3A9b038c6d73429c1` | [exact_match](https://sourcify.dev/server/v2/contract/296/0x835408327a72307e79826aa3A9b038c6d73429c1) | [HashScan](https://hashscan.io/testnet/contract/0x835408327a72307e79826aa3A9b038c6d73429c1) |
| `MandateVerifierAdapter` | `0.0.10477160` | `0xda71f48eb26579a94aaef03a87f0866d089e6d48` | [exact_match](https://sourcify.dev/server/v2/contract/296/0xda71f48eb26579a94aaef03a87f0866d089e6d48) | [HashScan](https://hashscan.io/testnet/contract/0xda71f48eb26579a94aaef03a87f0866d089e6d48) |
| `CoverageOracle` | `0.0.10451752` | `0xCE13De224ed918D7b8B2717492849e0A82648ca3` | [exact_match](https://sourcify.dev/server/v2/contract/296/0xCE13De224ed918D7b8B2717492849e0A82648ca3) | [HashScan](https://hashscan.io/testnet/contract/0xCE13De224ed918D7b8B2717492849e0A82648ca3) |
| `LoadLine` | `0.0.10474285` | `0xf867b6f41b21e9d72f327f867ae898620d022c80` | [exact_match](https://sourcify.dev/server/v2/contract/296/0xf867b6f41b21e9d72f327f867ae898620d022c80) | [HashScan](https://hashscan.io/testnet/contract/0xf867b6f41b21e9d72f327f867ae898620d022c80) |
| `CashLegController` | `0.0.10474287` | `0xccedcc53902b925c72e3c45d4cc176806326b30b` | [exact_match](https://sourcify.dev/server/v2/contract/296/0xccedcc53902b925c72e3c45d4cc176806326b30b) | [HashScan](https://hashscan.io/testnet/contract/0xccedcc53902b925c72e3c45d4cc176806326b30b) |
| `BerthMarket` | `0.0.10474313` | `0xd7d2d82444d7fda06f32628b454bfb3c78c87d5e` | [exact_match](https://sourcify.dev/server/v2/contract/296/0xd7d2d82444d7fda06f32628b454bfb3c78c87d5e) | [HashScan](https://hashscan.io/testnet/contract/0xd7d2d82444d7fda06f32628b454bfb3c78c87d5e) |
| `CouponScheduler` | `0.0.10474314` | `0x48d9169f50f1b07076860ea7a3743257aa933d07` | [exact_match](https://sourcify.dev/server/v2/contract/296/0x48d9169f50f1b07076860ea7a3743257aa933d07) | [HashScan](https://hashscan.io/testnet/contract/0x48d9169f50f1b07076860ea7a3743257aa933d07) |

The verifier and the adapter share one deploy transaction,
[`0xe71a93e3…993a`](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0xe71a93e309335adaef8fa599993022aea89a5a477e80615714739627b69c993a),
because the adapter creates the verifier inside its own constructor and the verifier records
`msg.sender` as its only permitted caller. There was never a window, and there is no setter.

Two earlier generations are kept in the record under `superseded` rather than deleted: the first
stack, which trusted a software key, and the unlocked verifier and adapter that followed it. The
verifier lists them as skipped history and never as current claims.

Asset Tokenization Studio v8.0.0 was already on testnet and none of it is ours:
[BusinessLogicResolver `0.0.9212226`](https://hashscan.io/testnet/contract/0xBA2D5FC2083A0b8f164c50e65d782087fBA18E0a),
[Factory `0.0.9213391`](https://hashscan.io/testnet/contract/0xd1F118A40f3b02883D35909eF2517e7EDd78379d).

## 2. The notes are real bonds with real balances

**PLIM-A**, ISIN `US0000PLIMA6`,
[`0.0.10451856`](https://hashscan.io/testnet/contract/0xe2Bf359650fbacc7D4801336F8C1FE7061aD6387),
issued through the ATS factory:
[`deployBond`](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0x170dc7139dafafe930e848ea96777962d8dd15835148d506a0a401e80bb3f150) ·
[`issueByPartition` 10,000.00](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0x0edbab04e6c56277c6d173c3d705d321ef286a076b07d3ac55eac38cf896ab68) ·
[`transferByPartition` 1,000.00 to a second KYC'd holder](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0x334a243a7a02dd4a90431fb799f0f18be3551d12c7a68be2b2921a86b7e4c937).
Read back keylessly through the mirror node: issuer 9,000.00, buyer 1,000.00, blocked address
0.00, and those two are the entire supply. The verifier takes the buyer's address out of the
record's own transfer transaction rather than being told it.

**PLIM-B**, ISIN `US0000PLIMB4`,
[`0.0.10482316`](https://hashscan.io/testnet/contract/0xCf759C717E805413aaa7D067dB7BD7A93969Def2),
the note sized to real backing:
[`deployBond`](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0x7cd5398c344749b1a47d8bfaf6bd3407c7e4ded731a4eae01bb377f448adcc32) ·
[`issueByPartition`](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0xfd746178a7b83a5c7f31e880ea795064fb8c15e26dec1bb9bcda6140e1d37ad8) ·
[registered with the oracle](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0x1db522a5769aef1628e45b706f274e34faa3b012e7db97369ad93fe08d34455f) ·
[registered with the adapter](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0xd9d37a93a2e0cd1b05b348704326dc608665e740e1c3b70bb74419dd0a497d88) ·
[its load line set to 100.00% by a device-signed mandate](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0xe0a175b24a0ab93880d2059827814f62aeb34c4eaa65afb9f896b77e2b1f2e4d).
Its obligation is **$10.00**, read from the chain rather than configured: `totalSupply` 1,000 base
units at 2 decimals is 10.00 notes, and `getNominalValue` 100 at 2 decimals is $1.00 par. ATS v8
has no `getBondDetails`, so par comes from `NominalValueFacet`.

The obligations are the whole point of the pair. **PLIM-A is the negative control**: 10,000.00
notes at a par of 100.00 is a $1,000,000 obligation against roughly $15 of backing, so it must
refuse forever. PLIM-B is the one that should clear.

## 3. Only a human with a device can move the load line

The verifier trusts exactly one key, `0x69fC09FA24102a5C02B227072Bee5b71d7AeF3e2`, a Ledger Nano S
Plus emulated by Speculos on a freshly generated private seed that is not in this repository and
is not the public test seed. Every mandate below was rendered on the device screen, decided there,
and then submitted. The full transcript, including the text the device actually displayed page by
page, is [`deployments/device-proof.json`](packages/contracts/deployments/device-proof.json).

| What | Result on chain |
|---|---|
| `SET-THRESHOLD` approved at 95.00%, submitted as 90.00% | REVERTED `0x20e11789` `MandateValueMismatch(noteId, 9000, 9500)` · [`0x1146556a…`](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0x1146556a955e1a199477d6e2b6a469b5287a50bda2c9346195b2345afb1872a2) |
| the same approval submitted as the 95.00% it named | SUCCESS · [`0x55a11367…`](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0x55a11367f4526de5b656a8fb86f79b2903d2d6d85b36d1920ab7a67d9c0da6c2) |
| device-approved `HALT` sent straight to the verifier | REVERTED `0xa29963d7` `NotGatekeeper(0xa9f2…413a)` · [`0x96de631c…`](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0x96de631c3a8f8b93a479df103dfc5bc1c47454b305730d2b7ae6c342d0644b32) |
| the same `HALT` sent straight to the adapter | REVERTED `0x59d2759c` `NotLoadLine(0xa9f2…413a)` · [`0x61625e13…`](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0x61625e137f227d9748d63ebc815a608838443342be00aab0219f23cb02a9e96d) |
| the same `HALT` through `LoadLine`, nonce still unspent | SUCCESS, market halted · [`0x559bd71f…`](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0x559bd71fee818041a9ce30285e1a7e3588b6ffb14b6ed8067fbaf91aaf07781f) |
| device **rejects** `RESUME`: `6985`, no signature exists | nothing to submit |
| a `RESUME` signed by another key | REVERTED `0x5f7e60e8` `WrongAuthority(0xd8ee…3563, 0x69fC…F3e2)` · [`0xa9fd42a2…`](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0xa9fd42a2e061efded9d2fb80378f58ae748b9d4a34bf28a74932b9a0d5c6f5f2) |
| device **approves** `RESUME` | SUCCESS, market resumed · [`0xc77864c9…`](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0xc77864c93ff5dfab65b93881f26785979a3c9a85713e01f41b72ad73182a7d8c) |

Three things are proved there, and they are worth separating.

**A valid human approval, applied through the wrong door, is refused and costs nothing.** Both
wrong-door reverts happen before the nonce is touched, which is why the very same approval then
worked through `LoadLine`. Before this lock, either door would have burned the nonce while
`LoadLine`'s own halt state stayed put: the human halts the market, and the market keeps trading.

**The value the human saw is the value that executes.** A mandate approved for 95.00% and
submitted as 90.00% reverts before anything is consumed or written.

**The market stayed halted because the hardware refused.** The rejection is not a caught
exception. The device returns `6985` and the result object carries no signature field at all, so
there is nothing to submit, nothing to retry with, and nothing on chain that would accept it.

The mandate the device displays and the string the contract hashes must be the same bytes, so the
contract formats and never parses: `MandateVerifier` rebuilds the string from typed arguments plus
`block.chainid` and `address(this)`. The only string that verifies is the one the contract would
have written itself.

## 4. The cash leg can stop payment at consensus

[`PCASH`, `0.0.10474297`](https://hashscan.io/testnet/token/0.0.10474297)
([mirror node](https://testnet.mirrornode.hedera.com/api/v1/tokens/0.0.10474297)), created by
[`0x5d48796d…`](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0x5d48796d4b4119476cba7b2aaf90a776f21b288bd5f23e9eb90578286d4286ab).

The mirror node reports its freeze key and supply key as `ProtobufEncoded` bytes `0a0518afa6ff04`,
which decode as `Key.contractID.contractNum = 10474287`: that is `CashLegController`. Treasury is
the same contract. **`admin_key` is `null`**, so the freeze key can never be rotated away and this
controller can never be replaced for this token. That is deliberate and permanent.

The freeze flag is enforced by the network, not by a contract. With the attestation service
offline, the scheduler dead and `CashLegController` never called again, a frozen payer still
cannot pay a coupon. `tripBreaker` and `resetBreaker` are permissionless on purpose: they do not
decide anything, they read `LoadLine` and make the ledger agree with it. Anyone may push the
button, nobody may choose the answer.

## 5. A compliance refusal, on chain, naming the party

`0x5da97170646574339edc856f5c04b99668e27f38` was added to PLIM-A's control list
([blacklist mode](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0xafdfd60e128f082e713d740f74e76724d258bfde87a7d19bb46c10ca20800cb8)),
then a transfer to it was attempted:

> [`0x61e008b403d41541333144b06e69fbea84959f7f95f9800d0624a0196f710002`](https://hashscan.io/testnet/transaction/0x61e008b403d41541333144b06e69fbea84959f7f95f9800d0624a0196f710002)
> ([mirror node](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0x61e008b403d41541333144b06e69fbea84959f7f95f9800d0624a0196f710002))
> `CONTRACT_REVERT_EXECUTED`, gas used 74,737, revert data
> `0x796c1f0d` + `0000…5da97170646574339edc856f5c04b99668e27f38`
> = **`AccountIsBlocked(0x5da9…7f38)`**

`0x796c1f0d` is the selector of the one-argument form, so the blocked address is a declared
parameter ABI-encoded in the revert, not trailing bytes. ATS does use the other shape elsewhere,
which is how we know the difference is real: refusing to revoke an operator that holds no KYC
reverts with the zero-argument `InvalidKycStatus()` (`0xfc855b1b`) followed by the address as
extra data, [as happened here](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0xea713eb20e94b89b2203a3d4a894c1a2c29d8f7e7de9a59b2d51fb18f7565717).

A compliant venue never reaches that revert. `BerthMarket` asks first, through ATS's own
non-reverting check, and books nothing if either leg would fail:

| `canTransferByPartition` to | status | EIP-1066 | reason |
|---|---|---|---|
| the blocked counterparty | `false` | `0x10` | `0x796c1f0d` `AccountIsBlocked` |
| an allowed counterparty | `true` | `0x01` | `0x00` |

## 6. A refusal is signed, and not charged

Topic [`0.0.10451091`](https://hashscan.io/testnet/topic/0.0.10451091) has no admin key, so
nothing written to it can be withdrawn, including our mistakes. Three canonical records, encoding
`v: 2`, all single-chunk under the 1024-byte limit:

| Case | Record | Bytes | Settlement |
|---|---|---|---|
| attested, 13000 bps against a 10000 floor | [seq 17](https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10451091/messages/17) | 843 | [`0.0.7162784@1789121899.540907773`](https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.7162784-1789121899-540907773) |
| asset refusal, `coverage_below_floor`, 8700 bps | [seq 18](https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10451091/messages/18) | 832 | none exists |
| evidence refusal, `source_unavailable` | [seq 19](https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10451091/messages/19) | 365 | none exists |

Open seq 19. It has twelve keys and **no numbers at all**. Not a zero, an absence: a `"bps": 0`
would read as zero-percent coverage and be indistinguishable from a genuine finding that the
issuer holds nothing. Omission cannot be misread. The same distinction is inside the signature,
which is why it cannot be re-labelled: refusals are signed as either `AssetRefusal` or
`EvidenceRefusal`, and the primary type is hashed into the digest, so an evidence refusal
re-presented as an asset refusal reporting zero coverage recovers to a different address.

The paid one settled for real. On
[`0.0.7162784@1789121899.540907773`](https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.7162784-1789121899-540907773):
`CRYPTOTRANSFER`, `SUCCESS`, buyer `0.0.10451088` debited 100,000 tinybar, seller `0.0.10448897`
credited 100,000, and the whole 268,582 tinybar network fee paid by the facilitator `0.0.7162784`.

Proving the absence is the subtle half, because a refusal has no transaction to look up. The
verifier takes the seller's account from the paid attestation's own transfer, lists every credit
to it from two minutes before the refusal to five minutes after (x402's maximum authorisation
window), and requires each credit to be claimed by some anchored attestation. A credit nobody
signed for would be a charge for a refusal. In the canonical window the only claimed credits are
records 17 and 20, and nothing else moved.

This is not special-case code. The Hedera `exact` scheme settles after the handler returns, any
status at or above 400 cancels it, `/settle` is never called, and the buyer's signed transfer
expires unsubmitted. Nothing captured, nothing to refund, nothing to reconcile.

[ERC-8004 registration](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0x281a248e72f3f58a21bfc8b7ba868268f5b9ffadf166e6f91081cb07d384646c)
on the identity registry, and the buyer's
[`giveFeedback`](https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.10451088-1789004923-275921226),
both `SUCCESS`.

## 7. The truth layer is published and cross-checked

[**`plimsoll-erc4626@v0.1.1` on substreams.dev**](https://substreams.dev/packages/plimsoll-erc4626/v0.1.1).
Stream it with `substreams gui plimsoll-erc4626@v0.1.1`.

What is published is the **Ethereum mainnet** layer: nine modules of ours plus Pinax's imported
`erc4626:map_events`, giving the vault registry, the normalised share-price series with entry and
exit rates kept apart, TVL, and Messari Yield Aggregator v1.3.1 entities. Its manifest declares
`network: mainnet` and contains no `map_positions`. Base and per-holder positions are v0.2.0,
built in this repository and not published (see Pending, below). The published package's embedded
README is v0.2.0's by mistake, so the registry page describes Base and positions that are not in
it; a corrected v0.1.2 is being cut, and the manifest is the authority in the meantime.

It builds on Pinax's extractor, imported by
[pinned commit](https://raw.githubusercontent.com/pinax-network/substreams-evm/1535a557975fb79d1e78517bf3e5bd6d18a1635a/spkg/erc4626-v0.1.0.spkg)
from [pinax-network/substreams-evm#259](https://github.com/pinax-network/substreams-evm/pull/259)
and run unchanged, so its module hash is unchanged and their server-side cache is reused rather
than recomputed. Their module is deliberately events-only; this package is the downstream layer
their README leaves to the reader.

Cross-checked against archive RPCs that are not the stream provider, over 5,000 mainnet blocks:

- **`totalAssets` read inside Substreams equals the independent archive read to the wei, 348/348.**
  That is what confirms in-stream `eth_call`s really are pinned to the processed block.
- **EIP-4626 ordering holds on every row**: `entry_rate >= convertToAssets` on 226/226 deposit
  blocks, `exit_rate <= convertToAssets` on 247/247 withdrawal blocks.
- **Every rate deviation is accounted for, 473/473**, against a per-row bound built from one
  asset-wei and one share-wei per event plus print resolution. The one visible `state_price`
  residual, 5.7e-4 bp on Euler, is explained by the EVK's 1e6-wei virtual deposit rather than
  waved at.
- Positions were cross-checked wei-exact **90/90 on Base and 10/10 on mainnet**, with the
  unpublished v0.2.0.

The correctness argument is not theoretical. Topic0-only matching admits any contract with a
same-signature event: 5 of 126 emitters failed the `asset()` probe in the first 300 blocks, and
one that passed it reported 170 USDC of assets against 96.9M shares and produced 95% of the whole
chain's apparent fee revenue until `rates_consistent` caught it.

## 8. The upstream contribution

[hedera-dev/hedera-harness#55](https://github.com/hedera-dev/hedera-harness/pull/55), open,
+330/−51 across 18 files, into `dev`.

Windows tests went from 179 pass / 16 fail to 197 / 197, with Linux verified unchanged in a
`node:20` container. The substantive find was not in the brief: `src/validation/devServer.ts`
spawns `detached: true` on every platform, which on Windows means `DETACHED_PROCESS` and severs
the child's stdout pipe, so the dev server's `Local:` line never arrives, URL detection burns its
full 30 s and aborts. SMOKE and EVALUATE could never start on Windows. Two further bugs were found
and fixed, one of them a latent cross-platform failure invisible on a networked runner.

The PR also states what was **not** done: the cache root was not relocated on Windows, because
`SKILL_CACHE_DIRNAME` is consumed by three other modules relative to the project root and moving
it would silently orphan the cache from all three.

---

## Pending

Nothing in this section is claimed as done. It is here so that nothing above has to be read
generously.

**The Substreams registry entry covers mainnet only.** v0.2.0, which adds Base and the
per-holder `map_positions` module that note coverage actually depends on, is built in this
repository and deliberately not published while the backing vault list is unsettled.
`https://substreams.dev/packages/plimsoll-erc4626/v0.2.0` returns 404 today, correctly.

**No live coverage figure exists yet.** Both notes are registered with placeholder vault sets
(PLIM-A's is `sha256("plimsoll/vaults/v1")` from a one-off bootstrap, PLIM-B's is the readable
ASCII `PLACEHOLDER-NOT-A-VAULT-SET`), the vault lists in `notes.json` are empty, and the issuer's
Base positions are not funded. So both notes refuse for an **evidence** reason, `VaultSetChanged`
on chain and `vault_set_drift` in the services. That is the correct behaviour of a system that
refuses to guess, and it is also the honest statement that the end-to-end coverage number has not
been produced.

**Nothing the attestation service has signed can be verified on chain yet.** Its EIP-712 payload
does not match `CoverageOracle`'s: different domain, no `verifyingContract`, `noteId` as `string`
rather than `bytes32`, coverage `uint32` rather than `uint64`, and a random `bytes32` nonce rather
than a monotonic `uint64`. The contract is not being redeployed; the service is adopting the
contract's format, which keeps `LoadLine`, the cash token and the whole verified record intact.
Until that lands, three checks in the one command fail, and this is the only reason they fail.

**The x402 records will be re-run to encoding `v: 3`** once that change is in, producing a fresh
canonical set of HCS sequence numbers. The `v: 2` records above stay exactly where they are, on an
immutable topic, verifiable under the rules of the version they declare.

**PLIM-B is ready to list but not listed, and its coupon schedule is created but not armed.**
Both wait on a clear load line, which waits on the two items above. The escrow allowance is
[already approved on chain](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0x3c21e6fd338b4d24f540469f2e7d85577d804604961aba95d3e9848f00587fba)
and the [schedule is created](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0x254ab7165b0db20bcc153ba4b7dc68117555bd923c285a052eae395246562eb4).

**Coverage does not drive the coupon rate on these notes.** The integration is built and tested,
but ATS bond configuration `0x…02` version 1 registers neither the Kpis nor the KpiLinkedRate
facet, so `addKpiData` returns `FunctionNotFound`. The scheduler catches it and emits
`CoveragePushFailed`; the coupon is unaffected.

## Links that did not resolve

None of the links on this page failed when checked on 2026-09-12. Two things are named here rather
than linked, because they do not exist yet: the v0.2.0 registry entry, and any on-chain-verifiable
attestation. Both are in Pending above.
