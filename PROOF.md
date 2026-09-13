# Proof

Every claim below is a link you can open. Grouped by claim, not by package.

> **Hedera testnet resets wipe both state and Sourcify verifications.** If a link stops resolving,
> that is what happened, and the deployment has to be re-run and re-verified. Nothing on Hedera
> here is on mainnet.
>
> **Everything on this page was last checked on 2026-09-13.** Each transaction was fetched from
> the public mirror node at `testnet.mirrornode.hedera.com/api/v1/contracts/results/<hash>`, each
> contract from `sourcify.dev/server/v2/contract/296/<address>`, and contract state by keyless
> `eth_call`. HashScan is the same records rendered for a human; it is a browser application, so
> the mirror node link beside each one is the machine-checkable form. Anything that did not resolve
> is said so, at the bottom.

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
notes at a par of 100.00 is a $1,000,000 obligation against a planned backing of roughly $15, so it
must refuse forever. PLIM-B is the one that should clear.

## 3. Only a human with a device can move the load line

The verifier trusts exactly one key, `0x69fC09FA24102a5C02B227072Bee5b71d7AeF3e2`, a Ledger Nano S
Plus emulated by Speculos on a freshly created private seed that is not in this repository and
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
nothing written to it can be withdrawn, including our mistakes. Three canonical records in the
current encoding, `v: 3`, all single-chunk under the 1024-byte limit:

| Case | Record | Bytes | Settlement |
|---|---|---|---|
| attested, PLIM-B, 15000 bps against a 10000 floor | [seq 22](https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10451091/messages/22) | 963 | [`0.0.7162784@1789172046.246807405`](https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.7162784-1789172046-246807405) |
| asset refusal, PLIM-A, `coverage_below_floor`, 0 bps | [seq 23](https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10451091/messages/23) | 985 | none exists |
| evidence refusal, `source_unavailable` | [seq 24](https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10451091/messages/24) | 539 | none exists |

**All three were computed from fixture figures, and each says so in its own `feed` field.** What
they prove is the machinery: the signature, the arithmetic, the payment and its absence, and the
anchoring. They are not coverage readings. Each also names the note id, oracle and chain its
signature is bound to, and the account a charge would have credited, so a record can be checked on
its own.

Open seq 24. It carries **no figure**: no ratio, floor, block or reading. Its only numbers are the
format version and the chain id. Not a zero, an absence: a `"bps": 0` would read as zero-percent
coverage and be indistinguishable from a genuine finding that the issuer holds nothing. Seq 23 is
that genuine finding, `known: true` with a zero, which is exactly the pair worth comparing. The
distinction is inside the signature too: refusals are signed as either `AssetRefusal` or
`EvidenceRefusal`, and the primary type is hashed into the digest, so an evidence refusal
re-presented as an asset refusal reporting zero coverage recovers to a different address.

The paid one settled for real. On
[`0.0.7162784@1789172046.246807405`](https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.7162784-1789172046-246807405):
`CRYPTOTRANSFER`, `SUCCESS`, buyer `0.0.10451088` debited 100,000 tinybar, seller `0.0.10448897`
credited 100,000, and the whole 270,175 tinybar network fee paid by the facilitator `0.0.7162784`.

Proving the absence is the subtle half, because a refusal has no transaction to look up. The
verifier takes the seller's account from the record, lists every credit to it from two minutes
before the refusal to five minutes after (x402's maximum authorisation window), and requires each
credit to be claimed by some anchored attestation. A credit nobody signed for would be a charge for
a refusal. In both refusals' windows the only credit is the one record 22 claims.

This is not special-case code. The Hedera `exact` scheme settles after the handler returns, any
status at or above 400 cancels it, `/settle` is never called, and the buyer's signed transfer
expires unsubmitted. Nothing captured, nothing to refund, nothing to reconcile.

Earlier encodings stay where they are, on an immutable topic, checkable under the rules of the
version they declare: `v: 1` at sequences 1 to 16 and `v: 2` at 17 to 21
([seq 17](https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10451091/messages/17), for
example, is the v2 attestation, paid by
[`0.0.7162784@1789121899.540907773`](https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.7162784-1789121899-540907773)).

[ERC-8004 registration](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0x281a248e72f3f58a21bfc8b7ba868268f5b9ffadf166e6f91081cb07d384646c)
on the identity registry, and the buyer's
[`giveFeedback`](https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.10451088-1789004923-275921226),
both `SUCCESS`.

## 7. The oracle accepts what the attestor signs

Until format v3, the attestor signed a payload `CoverageOracle` could not verify: a different
domain, a `string` note id, `uint32` coverage and a random nonce. The contract was not redeployed;
the attestor adopted the struct the contract recovers. That was then tested on chain:

| What | Result on chain |
|---|---|
| a PLIM-B attestation submitted to `CoverageOracle` | SUCCESS, `AttestationAccepted`, stored at 15000 bps · [`0xc0370dfa…`](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0xc0370dfaea84d47ac6783df5d55f35f579af218951eeee2a0c470e542e422439) |
| the same attestation submitted again | REVERTED `0x348ad525` `StaleAttestation(1789170005, 1789170005)` · [`0x4b414352…`](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0x4b414352cb6d0aa671a81966692877528d7d90db191133dc3899e7934ae36c04) |

Acceptance requires the signature to recover to the attestor registered for the note, so this
proves the two implementations of the digest agree, and that a replayed nonce is refused.

**It proves nothing about backing.** That attestation was signed over test figures from the
attestor's checked-in fixture, not over any vault, and it must never be read as a coverage
reading. It was also built to expire: it lapsed five minutes after it was stored, and it commits to
the placeholder vault set retired since (section 8), so it can never count again. Read today,
`CoverageOracle.coverageOf` for PLIM-B returns `Unproven` with reason `AttestationExpired`.

## 8. The backing is named on chain

Both notes now carry their real vault sets. `CoverageOracle` never computes the hash, it only
compares, so there is one definition: the attestor's `canonicalHash` over the lowercase, sorted
vault list. Each hash below was recomputed with that code
(`packages/contracts/script/vault-set-hash.mjs`) and matched against `CoverageOracle.noteOf` read
on chain.

| Note | `setVaultSet` | Moved from | To |
|---|---|---|---|
| PLIM-B | SUCCESS · [`0x407cda62…`](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0x407cda62faf600ddb822cf83d31d32856e128a2def12d010273e29af9f48bc48) | `PLACEHOLDER-NOT-A-VAULT-SET` as bytes32 ASCII | `0xb1e9d3e61ec546b9efbea1d67b18058f2e9563e19c0a46491a86a05bc004f81e` |
| PLIM-A | SUCCESS · [`0xa85d21d5…`](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0xa85d21d57d864a55208a18774b30066fe412097aec6dd5130520bbebc21d0fa3) | `0x2627c1d5…9d57`, `sha256("plimsoll/vaults/v1")` from a one-off bootstrap | `0xbaf33c99aa83d554b782e7dc98ad3e0f5e8838abfdd64c125f0a2e9627d8fa5c` |

Both transactions emitted `VaultSetMoved` with exactly those previous and current values.

The vaults are four protocols on Base. Every one was read on chain: `asset()` is native USDC,
[`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`](https://basescan.org/address/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913),
in all four.

| Note | Vault | Address |
|---|---|---|
| PLIM-B | Gauntlet USDC Prime (Morpho), `gtUSDCp` | [`0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61`](https://basescan.org/address/0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61) |
| PLIM-B | Wrapped Aave Base USDC, `waBasUSDC` | [`0xC768c589647798a6EE01A91FdE98EF2ed046DBD6`](https://basescan.org/address/0xC768c589647798a6EE01A91FdE98EF2ed046DBD6) |
| PLIM-B | Spark USDC Vault, `sUSDC` | [`0x3128a0F7f0ea68E7B7c9B00AFa7E41045828e858`](https://basescan.org/address/0x3128a0F7f0ea68E7B7c9B00AFa7E41045828e858) |
| PLIM-A | Fluid USD Coin, `fUSDC` | [`0xf42f5795D9ac7e9D757dB633D693cD548Cfd9169`](https://basescan.org/address/0xf42f5795D9ac7e9D757dB633D693cD548Cfd9169) |

The two sets are disjoint on purpose: one position backs one note. The same lists are in
[`packages/substreams/notes.json`](packages/substreams/notes.json) and in the deployment record.

**Not yet deposited.** At Base block 51,234,844 the issuer,
`0xa9f24d9633bf74d4893c6687cd2c9f4ecd6f413a`, held zero shares in all four vaults. See Pending.

## 9. The truth layer is published and cross-checked

[**`plimsoll-erc4626@v0.2.0` on substreams.dev**](https://substreams.dev/packages/plimsoll-erc4626/v0.2.0).
Stream it with `substreams gui plimsoll-erc4626@v0.2.0`.

It covers **Ethereum mainnet and Base** with twelve modules, eleven of ours plus Pinax's imported
`erc4626:map_events`: the vault registry, the normalised share-price series with entry and exit
rates kept apart, TVL, Messari Yield Aggregator v1.3.1 entities, `store_asset_prices`, and
`map_positions`, which reads a nominated holder's `balanceOf` and `convertToAssets` for coverage.
Checked by fetching the artifact from the registry by name rather than reading the page: 1,004,192
bytes, sha256 `3be7c4634e741f3bc720791594f92c743c7848d55bcdf63acc740befcaef52a7`, with the eleven
module declarations above and Base's network parameters inside it.

**Version history, briefly.** [v0.1.1](https://substreams.dev/packages/plimsoll-erc4626/v0.1.1)
was a mainnet-only package that shipped carrying the wrong README: the CLI embeds whichever
`README.md` sits beside the manifest, so its embedded documentation names `map_positions` nine
times and `store_asset_prices` three, neither of which it contains. We found it by grepping the
packed artifact rather than trusting the source. A registry version can only be superseded, so
[v0.1.2](https://substreams.dev/packages/plimsoll-erc4626/v0.1.2) was cut as a mainnet-only
release whose documentation names neither, and `packages/substreams/scripts/check_package.py` was
written to catch the defect: it reads the module list out of the packed artifact and fails when the
embedded documentation names a module that is not there. v0.2.0 is the full release.

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
- **Positions are wei-exact, 90/90 on Base and 10/10 on mainnet**, read on public holders'
  positions. The issuer's own address, nominated in the same Base run, read exactly zero shares:
  a successful call returning zero, not a failed one.

The correctness argument is not theoretical. Topic0-only matching admits any contract with a
same-signature event: 5 of 126 emitters failed the `asset()` probe in the first 300 blocks, and
one that passed it reported 170 USDC of assets against 96.9M shares and produced 95% of the whole
chain's apparent fee revenue until `rates_consistent` caught it.

## 10. The upstream contribution

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

**No live coverage figure exists yet.** The vault sets are real and on chain, but the issuer's Base
positions are not funded: zero shares in all four vaults at Base block 51,234,844. So no attestation
has been made over the real sets, and both notes refuse for an **evidence** reason: PLIM-A reads
`NoAttestation` on chain, PLIM-B `AttestationExpired`. Every anchored record so far was computed
from fixture figures, and the one attestation `CoverageOracle` has stored was signed over test
figures. That is the correct behaviour of a system that refuses to guess, and it is also the honest
statement that the end-to-end coverage number has not been produced.

**PLIM-B is ready to list but not listed, and its coupon schedule is created but not armed.**
Both wait on a clear load line, which waits on funded positions and a fresh attestation over the
real vault set. The escrow allowance is
[already approved on chain](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0x3c21e6fd338b4d24f540469f2e7d85577d804604961aba95d3e9848f00587fba)
and the [schedule is created](https://testnet.mirrornode.hedera.com/api/v1/contracts/results/0x254ab7165b0db20bcc153ba4b7dc68117555bd923c285a052eae395246562eb4).

**Coverage does not drive the coupon rate on these notes.** The integration is built and tested,
but ATS bond configuration `0x…02` version 1 registers neither the Kpis nor the KpiLinkedRate
facet, so `addKpiData` returns `FunctionNotFound`. The scheduler catches it and emits
`CoveragePushFailed`; the coupon is unaffected.

## Links that did not resolve

None of the links on this page failed when checked on 2026-09-13. One thing is named here rather
than linked, because it does not exist yet: an attestation over real, funded positions.
