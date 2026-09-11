---
name: plimsoll-vault-evidence
description: Live ERC-4626 vault evidence from The Graph Market (Substreams). Use it to check what a vault on Ethereum mainnet or Base holds right now, how its share price has moved, or whether a Plimsoll note is covered by its issuer's vault positions. Answers carry provenance (package sha256, module hash, block, endpoint), and uncertainty comes back as a typed refusal, never a number.
---

# Plimsoll vault evidence

An MCP server (Streamable HTTP, `POST/GET/DELETE /mcp`) with an A2A card at
`/.well-known/agent-card.json`. Its data comes from the `plimsoll_erc4626`
Substreams package, streamed live from The Graph Market.

## When to use it

- Before acting on a vault's value: `vault_backing`.
- To judge a vault's yield, or whether its events behave like ERC-4626: `vault_share_price_series`.
- Before relying on a Plimsoll note: `note_coverage`. If another party has to rely on the figure too, buy the signed attestation it links to.
- Before anything else, when answers look odd: `feed_status`.

## Tools

| tool | args | returns |
|---|---|---|
| `vault_backing` | `network` (`mainnet`\|`base`), `vault` | totalAssets and totalSupply (raw and normalised), sharePrice, the last `entryRate` and `exitRate` (separate), tvlUsd, verification |
| `vault_share_price_series` | `network`, `vault`, optional `fromBlock`, `toBlock` | per-block points plus `stats`: changeBps, annualised growth, entry-vs-exit spread, and the EIP-4626 ordering check |
| `note_coverage` | `noteId` (bytes32) | `covered` with coverageBps, or a refusal; always includes the x402 attestation link |
| `feed_status` | none | head, lag, finality mode, last error and stream slots, per network |

## Reading an answer

Every answer has `provenance`:

- `package.sha256` and `module.hash` identify the exact bytes and the module that were read.
- `block` is the block the answer rests on. `block.final` says whether that block can still be reorganised.
- `head.lagSeconds` is how far the stream is behind the wall clock.
- For notes, `reads[]` lists every registry-chain call: contract, method, block and value.

## Reading a refusal

`result: "refused"` always comes with a `family`. Branch on the family, not on the message.

- **`family: "evidence"`** means *we could not tell*. There is no figure in it anywhere, by construction. Treat it as unknown, never as zero. Retry with a backoff.
  - `source_unavailable`: the stream is not connected, still warming up, out of stream slots (`detail.cause: stream_capacity` or `concurrent_stream_limit`), or a registry read failed.
  - `data_stale`: the stream head, the vault's last observation or the note's last position reading is older than the policy (`detail.stale` says which).
  - `vault_unresolved`: the vault is unknown, its `totalAssets` reverted, or its Deposit/Withdraw events contradict its own accounting.
  - `vault_set_drift`: the note's vault list does not match the set committed on-chain, or it overlaps another note's.
- **`family: "asset"`** means *we could tell, and the answer is no*. It carries `coverageBps` and `floorBps`. Do not retry; the underlying fact has to change first.
  - `coverage_below_floor`: the positions are worth less than the load line.
  - `no_attributable_positions`: the holder has no shares in the vault set.

`entryRate` and `exitRate` are deliberately never blended. Deposits are measured gross of entry fees and withdrawals net of exit fees, so on a conforming vault `entryRate ≥ sharePrice ≥ exitRate`. The gap between them is the fee.
