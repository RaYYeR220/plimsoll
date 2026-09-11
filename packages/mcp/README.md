# @plimsoll/mcp

An MCP server that gives agents **live ERC-4626 vault evidence** from The Graph:

- what a vault holds;
- how its share price moves;
- whether a Plimsoll note is covered by its issuer's vault positions.

The data is streamed continuously from **The Graph Market** through the
`plimsoll_erc4626` Substreams package in `packages/substreams`. The Graph is
the only source of vault data here. The note registry chain (Hedera) is read
only for a note's liabilities and identity.

Two properties make it safe infrastructure for an agent that acts on what it
reads:

1. **Every answer carries provenance.** That means the exact package bytes
   (sha256), the module that produced the data (its content hash, which is also
   the provider's cache key), the endpoint, the block the answer rests on, its
   finality, and how far the stream is behind. For notes, it also covers every
   registry-chain read, with contract, method, block and value.
2. **It fails closed.** A stale stream, a vault it cannot resolve, a vault whose
   events contradict its own accounting, or a note whose committed vault set
   has drifted each produces a typed refusal, never the last good number. An
   interface can live with a stale number; an agent that acts on one cannot.

It is not an app. The tools are generic over any ERC-4626 vault on Ethereum
mainnet and Base, and the note tool is generic over any note registered in the
Plimsoll CoverageOracle.

## Run it

```bash
cd packages/mcp
npm install
SUBSTREAMS_API_TOKEN=<The Graph Market JWT> npm run serve      # http://localhost:4030
```

It needs `packages/attestor` built (`npm run build` there), because the
coverage arithmetic is imported from it. It also needs
`packages/substreams/plimsoll-erc4626-v0.2.0.spkg`.

- MCP (Streamable HTTP): `http://localhost:4030/mcp`. POST for requests, GET for the server stream, DELETE to end a session.
- A2A card: `http://localhost:4030/.well-known/agent-card.json`. JSON-RPC at `/a2a/v1`.
- Try it from a real MCP client: `npm run call -- vault_backing '{"network":"base","vault":"0x…"}' feed_status`.

## Tools

| tool | input | answers with |
|---|---|---|
| `vault_backing` | `network`, `vault` | totalAssets and totalSupply (raw and normalised), share price, the **last entry rate and last exit rate, kept separate**, TVL in USD where priced, verification, rates consistency |
| `vault_share_price_series` | `network`, `vault`, `fromBlock?`, `toBlock?` | per-block points plus derived stats: change in bps, simple and compounded annualised growth, the entry-vs-exit spread, and the EIP-4626 ordering check (`entry ≥ price ≥ exit`) |
| `note_coverage` | `noteId` | `covered`, an asset refusal with the figure, or an evidence refusal with none. Always includes the link to the paid, signed attestation |
| `feed_status` | none | per-network connection state, head, lag, finality, last typed error, stream slots |

Series inside the live buffer are served from memory. An older
`[fromBlock, toBlock]` range (at most `RANGE_MAX_BLOCKS`) runs a bounded,
final-only Substreams request against The Graph Market for exactly those blocks.
That request goes live too, not to a cache and not to an RPC.

### note_coverage, precisely

1. **The note file holds only what the chain cannot say.**
   `packages/substreams/notes.json` gives the network carrying the backing, the
   vault list, and where the registry lives.
2. **Liabilities and identity are read from Hedera at the moment of the call,**
   pinned to one block. Each read is reported in `provenance.reads`:
   - outstanding: the note's `totalSupply()` and `decimals()`;
   - par: `getNominalValue()`, `getNominalValueDecimals()` and `getNominalValueCurrency()`;
   - the load line: `LoadLine.lineOf(noteId)`;
   - the committed vault set: `CoverageOracle.noteOf(noteId).vaultSetHash`;
   - **the holder: the single member of the note's `ISSUER_ROLE`.**

   The holder is derived and never configured, so nobody can point the service
   at somebody else's position and call it backing. The holder
   `0xa9f24d9633bf74d4893c6687cd2c9f4ecd6f413a` is the issuer's Hedera operator
   key (`0.0.10448897`) as an EVM address: the issuer's Hedera identity and its
   Base holder address are the same address.
3. **The stream provides the positions.** `map_positions` runs `balanceOf(holder)`
   and `convertToAssets(shares)` as eth_calls inside Substreams, pinned to the
   block. It reads on a cadence and whenever a nominated vault moves.
4. **The arithmetic is the attestor's own.** `normalise()` and `coverageBpsOf()`
   are imported from `packages/attestor/dist`, so this server and the signed
   attestation cannot disagree about a ratio.
5. **The staleness policy is the attestor's too:** `maxStalenessSeconds = 900`,
   read from its `DEFAULT_POLICY`.

For a figure another party must rely on, the answer links to the x402
attestor:

- `GET ${ATTESTOR_URL}/attest?noteId=…`
- 402 challenge in `PAYMENT-REQUIRED`, `exact` scheme, 0.001 HBAR on Hedera testnet
- refusals are HTTP 422/424, and nothing settles

This server does not reimplement any of that.

## Provenance

```jsonc
"provenance": {
  "provider": "The Graph Market", "transport": "substreams",
  "endpoint": "https://base-mainnet.streamingfast.io", "network": "base",
  "package": { "name": "plimsoll_erc4626", "version": "v0.2.0", "sha256": "…" },
  "module":  { "name": "map_positions", "hash": "…" },     // the network's params applied
  "finalBlocksOnly": true,
  "block": { "number": "…", "hash": "0x…", "timestamp": "…", "final": true },  // what the answer rests on
  "head":  { "number": "…", "hash": "0x…", "timestamp": "…", "lagSeconds": 12, "finalBlockHeight": "…" },
  "builtAt": "…",
  "reads": [ { "chain": "hedera-testnet", "contract": "0x…", "method": "totalSupply()", "block": "…", "kind": "quantity", "value": "…" } ]
}
```

## Refusals

These mirror `packages/attestor/src/reasons.ts`. The family is a field so an
agent can branch without parsing prose.

| reason | family | carries a figure | meaning |
|---|---|---|---|
| `coverage_below_floor` | asset | yes | positions are worth less than the load line |
| `no_attributable_positions` | asset | yes (0) | the holder has no shares in the vault set |
| `source_unavailable` | evidence | never | not connected, warming up, out of stream slots, or a registry read failed |
| `data_stale` | evidence | never | the stream head, the vault's observation or the note's reading is past policy |
| `vault_unresolved` | evidence | never | unknown vault, reverted state reads, or events that contradict the vault's accounting |
| `vault_set_drift` | evidence | never | the vault list does not hash to the on-chain commitment, or overlaps another note's |

"Never" is enforced by construction and by a test. The evidence-refusal detail
type admits no numbers. Registry reads of quantities have their values stripped
from an evidence refusal's provenance. A deep scan over every evidence refusal
the test suite produces finds no figure anywhere in the object. A `"bps": 0`
would read as zero coverage; an absent field cannot be misread.

## A2A: what it is and is not

The Graph's roadmap promised an "x402-compliant Subgraph gateway with MCP and
A2A support". x402 shipped. A2A did not: `/.well-known/agent-card.json` returns
404 on The Graph's gateway and on its Subgraph MCP. The Subgraph MCP also speaks
only the legacy HTTP+SSE transport; a `POST /mcp` there returns 404.

This server serves:

- **A spec-valid A2A v1.0 Agent Card** at `/.well-known/agent-card.json`, also at
  `/.well-known/agent.json` for v0.x clients. It has `supportedInterfaces`
  (JSONRPC, protocolVersion 1.0), `capabilities`, input and output modes, and
  one skill per tool.
- **A minimal, synchronous JSON-RPC surface** at `/a2a/v1`. `SendMessage` takes
  one DataPart `{"skill": "...", "args": {...}}`, runs the same function the MCP
  tool runs, and answers with a Message holding one DataPart. `message/send`
  (v0.3) is accepted too.

It is **not** a full A2A agent. There is no task lifecycle (`GetTask`,
`CancelTask`), no streaming, no push notifications, and no extended card. The
card declares all of that in `capabilities`, and unsupported methods return
JSON-RPC `-32601`.

## Environment

| variable | default | purpose |
|---|---|---|
| `SUBSTREAMS_API_TOKEN` | none | The Graph Market JWT. Without it, every answer refuses `source_unavailable`. |
| `SUBSTREAMS_ENV_FILE` | none | Alternatively, a dotenv file outside the repo holding the token. |
| `FEED_NETWORKS` | `base` | Networks with a long-lived stream. |
| `STREAM_SLOTS` / `STREAM_SLOT_WAIT_MS` | `2` / `3000` | The token's concurrent-stream cap, shared by feeds and range requests. |
| `SUBSTREAMS_PACKAGE` / `SUBSTREAMS_MODULE` | `../substreams/plimsoll-erc4626-v0.2.0.spkg` / `map_positions` | Package and output module. |
| `NOTES_FILE` | `../substreams/notes.json` | Note definitions. |
| `MAX_STALENESS_SECONDS` | attestor policy (900) | The oldest observation served as current. |
| `BASE_FINAL_BLOCKS_ONLY` / `MAINNET_FINAL_BLOCKS_ONLY` | `true` / `false` | Finality mode per network (see below). |
| `BASE_HEAD_MAX_LAG_SECONDS` / `MAINNET_HEAD_MAX_LAG_SECONDS` | `600` / `180` | Head-lag threshold. |
| `RANGE_MAX_BLOCKS` / `RANGE_TIMEOUT_MS` | `5000` / `120000` | Bounds on one-off range requests. |
| `ATTESTOR_URL` | `http://localhost:4021` | Where the paid, signed attestation lives. |
| `ATTESTOR_DIST` | `../attestor/dist/src` | The attestor build to import the arithmetic from. |
| `PORT` / `PUBLIC_BASE_URL` | `4030` / `http://localhost:4030` | Listen port and the URL the A2A card advertises. |

## Finality and freshness: measured, then chosen

Measured on 2026-09-11 against The Graph Market with `plimsoll_erc4626@v0.2.0`
(sha256 `a6e44729…`):

| | mainnet | base |
|---|---|---|
| head lag (stream head vs wall clock) at head | 4–18 s (12 samples, median ≈ 9 s) | not sampled at head |
| head − `finalBlockHeight` | 64–95 blocks ≈ 13–19 min | ≈ 168 blocks ≈ 5.6 min |
| warm-up from cold module hashes | 95–141 s | 95 s; 6 min 40 s after a WASM change |
| `map_positions` read cadence | 50 blocks ≈ 10 min | 150 blocks ≈ 5 min |

Choices that follow from these numbers:

- **Base runs final-only.** It carries the note backing. Worst-case position age
  is about 5.6 min of finality lag plus 5 min of cadence, which stays under the
  attestor's 15 min `maxStalenessSeconds`. So an attestation-grade answer never
  rests on a block that can reorg away. The head-lag threshold is 600 s.
- **Mainnet serves the head, and says so.** Final-only would put 13–19 min of
  lag in front of every mainnet vault answer before the vault's own
  observation age even counts. So mainnet answers come from the head, with
  `provenance.block.final` stating whether the block is final. The undo
  journal rolls back reorged blocks, and the head-lag threshold is 180 s.
- **Reconnects are routine and cheap.** During the live run the provider twice
  sent `Unavailable: endpoint is shutting down, please reconnect`. The feed
  resumed from its cursor within 2–4 s both times, with no gap and no replay.

Live transcript: a real MCP client over Streamable HTTP, mainnet feed, the
final package. Abridged; `provenance` shown once.

```text
# vault_backing {"network":"mainnet","vault":"0x9d39…3497"}   (Ethena sUSDe)
result: backing   sharePrice 1.247606883151384361
entryRate 1.247604098574102334 @25956046   exitRate 1.247606883151384361 @25956165
tvlUsd 1313370342.87
provenance.module  map_positions@093c1ef71f7cdba2a77a8c458173f3514ca38d65
provenance.block   25956165 0x5af4ef5e…a61e 19:10:47Z final=false   head lag 11 s

# vault_backing {"network":"mainnet","vault":"0x56a7…581d"}   (Spark Blue Chip USDC)
result: backing   sharePrice 1.03720340139362962   tvlUsd 10556791.50

# vault_backing {"network":"mainnet","vault":"0x4f95…d87c"}   (non-conforming "vault")
result: refused  family evidence  reason vault_unresolved
detail.cause event_rates_inconsistent_with_vault_price   (no figure anywhere)

# vault_share_price_series {"network":"mainnet","vault":"0x56a7…581d"}
source stream_buffer  points 11  changeBps 0.0425  annualisedCompoundPct 4.29
eip4626Ordering entry 5/5  exit 6/6  held=true

# vault_share_price_series {… "fromBlock":25955000,"toBlock":25955199}   (older than the buffer)
source range_request (live, 1.2 s)  module map_vault_blocks@537467021e5345c0fd3358f52d2e472f1e6503cb
points 4  final=true  eip4626Ordering exit 4/4 held=true

# note_coverage {"noteId":"0x3760…253c"}   (PLIM-A)
result: refused  family evidence  reason vault_set_drift
notesFileVaultSetHash 0x4f53…b945 (empty list)  onchainVaultSetHash 0x2627c1d5…9d57
provenance.reads: 10 Hedera reads at block 40394350. Quantities carry no value
(evidence refusal); identity reads do, e.g. issuer 0xa9f2…413a and currency USD.
```

## Tests

`npm test` builds and runs `node --test` on `dist/test/*.test.js`. Last run:
**46 tests, 45 pass, 0 fail, 1 skipped.** The skipped one is the live test,
which runs only with a token.

| file | what it proves |
|---|---|
| `tools.test.ts` (18) | Vault tools against recorded mainnet output. It covers these cases:<br>• provenance on every answer;<br>• entry and exit rates are carried separately;<br>• `data_stale` on head lag and on vault-observation age;<br>• **negative control:** a frozen feed with a cached value, clock advanced past the threshold. The value is refused and does not appear anywhere in the refusal;<br>• `vault_unresolved` on an unseen address and on the recorded non-conforming vault `0x4f95…`;<br>• `source_unavailable`: network not streamed, still warming up, and the typed `concurrent_stream_limit` cause;<br>• series from the buffer, and "up to now" refused when the head is stale;<br>• range requests fail closed (`range_requests_disabled`, `stream_capacity`);<br>• a **deep scan** of every evidence refusal for figures, and a check that the scanner does catch one. |
| `coverage.test.ts` (13) | `note_coverage` on placeholder notes. It covers these cases:<br>• **the under-backed twin refuses `coverage_below_floor` with the figure** ($15 against $1,000,000);<br>• a right-sized note is `covered`;<br>• a negative control that clears is flagged `controlViolated`;<br>• `no_attributable_positions` with ratio 0;<br>• `vault_set_drift`, both on-chain mismatch and a vault overlapping another note;<br>• an ambiguous issuer, a failed registry read, a stale reading, a reverted position, and no reading yet;<br>• the registry's quantity reads are stripped from evidence refusals. |
| `canonical.test.ts` (3) | `vaultSetHash` matches the attestor's pinned vectors, and agrees with the attestor's own `canonicalHash` called live. |
| `a2a.test.ts` (4) | The card carries every A2A v1.0 required field and no v0.x top-level `url`. `SendMessage` works with a DataPart, the v0.3 `message/send` alias works, and JSON-RPC errors come back for unsupported calls. |
| `state.test.ts` (6) | A reorg rolls back vault state, series and readings. The journal never reaches below finality. The slot cap is enforced, and ResourceExhausted is typed. `map_positions` params keep the manifest cadence, and malformed notes are rejected at load. |
| `http.test.ts` (1) | End to end over real transports: an MCP client speaks Streamable HTTP to the Express app. Every tool answers with provenance, and the A2A card is served. |
| `live.test.ts` (1, gated) | A live Base feed reaches the head and `vault_backing` answers with the provider's module hash. The stream slot is released on stop. |

The offline suite replays **recorded real stream output** captured once from
The Graph Market by `bin/record.ts`. The files are
`test/fixtures/recorded-{mainnet,base}.json`, and each says so in its `about`
field, with package sha256, module hash, endpoint and recording time. Notes
whose vault list is not final use placeholder notes, **synthetic** position
readings and a stand-in registry. Those tests say so in their headers. The live
test is skipped unless a token is present.

## Honest limits

- **The token allows 2 concurrent streams.** One long-lived feed takes one, and
  range requests and a second network compete for the other. When no slot frees
  up within `STREAM_SLOT_WAIT_MS`, the answer is `source_unavailable`
  (`stream_capacity`). A provider-side `ResourceExhausted` is surfaced as
  `concurrent_stream_limit`.
- **Streams must be cancelled, not dropped.** Leaving a `for await` over the
  stream does not close connect-node's HTTP/2 session. The process then stays
  alive, and the provider keeps counting the session against the cap. Every
  stream here owns its session manager and abort controller and tears both
  down. Measured live, with the server holding one of the
  two slots so the probe competed for exactly one:
  - after a **clean cancel**, the next stream got the slot immediately (first
    block after 4.3 s);
  - after a **hard kill** (`TerminateProcess` mid-stream), the slot still
    counted at +1 s (`concurrent_stream_limit`) and was free by +15 s.

  A process that is merely *left running* after its loop ends is worse: it
  holds the slot for as long as it lives. On Windows, where a detached process
  cannot receive SIGINT, `ENABLE_LOCAL_SHUTDOWN=1` enables a loopback-only
  `POST /__shutdown` that takes the same graceful path.
- **Mainnet serves unfinalised blocks.** Each answer's `provenance.block.final`
  says whether it rests on a block that could still be reorganised. Reorgs roll
  the state back through an undo journal before the next answer.
- **A vault is known only once it has had a flow** since the stream (or
  package) start. A quiet vault refuses `vault_unresolved` or `data_stale`
  rather than report a state nobody has looked at recently.
- **Positions are read on a cadence:** every 150 blocks on Base and every 50 on
  mainnet, plus any block where a nominated vault moves. Their age is bounded
  by that cadence plus finality lag, which is why Base runs final-only.
- **Coverage assumes USD par and USD-pegged underlyings.** A non-USD note
  currency, or an underlying not priced at peg, refuses `vault_unresolved`.
- **The note vault lists are not final yet.** `notes.json` carries PLIM-A (the
  negative control, a $1,000,000 obligation that must always refuse) and PLIM-B
  (about $10 against roughly $15 of Base backing, the one that should clear),
  both with an empty vault list. Their registered `vaultSetHash` is currently
  `0x2627c1d5…`, which is sha256("plimsoll/vaults/v1"), a bootstrap placeholder
  rather than any vault list. So both notes refuse `vault_set_drift` until
  `setVaultSet` commits the real lists. That is the intended behaviour, and it
  is what the live transcript below shows.
- **Defence in depth against the package.** The package's `rates_consistent`
  flag had a division-by-zero hole: a vault reporting `totalAssets = 0` against
  outstanding shares passed as consistent. Replaying recorded live data caught
  it on `0x4f95c5ba…`, and this server treats a zero price next to any event
  rate as inconsistent regardless of the flag.
