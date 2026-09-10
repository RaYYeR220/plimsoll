# Developer experience notes — Ledger stack

Everything below was hit while building `@plimsoll/authority`, a human-in-the-loop authority for
ETHOnline 2026 Track 01. Versions, exact error text and a reproduction for each, ordered by how
much time it cost.

**Environment for every item:** Windows 11 (26200), Docker 29.5.2, Node v24.13.0, npm 11.6.2,
TypeScript 5.9, Speculos `ghcr.io/ledgerhq/speculos:latest`, `app-ethereum` 1.22.3 (`nanos2`),
model `nanosp`, API level 26, display `headless`.

| package | version |
| --- | --- |
| `@ledgerhq/device-management-kit` | 1.9.0 |
| `@ledgerhq/device-signer-kit-ethereum` | 1.18.0 |
| `@ledgerhq/device-transport-kit-speculos` | 1.2.1 |
| `@ledgerhq/context-module` | 2.5.0 |

---

## 1. DMK 1.9.0's ESM build does not load under plain Node

**Cost: ~1 hour, and it is the first thing anyone starting from the docs will hit.**

```js
// esm.mjs
import { DeviceManagementKitBuilder } from "@ledgerhq/device-management-kit";
```

```
Error [ERR_UNSUPPORTED_DIR_IMPORT]: Directory import
'.../node_modules/@ledgerhq/device-management-kit/lib/esm/src' is not supported resolving ES
modules imported from '.../node_modules/@ledgerhq/device-management-kit/lib/esm/index.js'
    at finalizeResolution (node:internal/modules/esm/resolve:262:11)
```

`lib/esm/index.js` re-exports a *directory*, which is legal in a bundler and illegal in Node's ESM
resolver. `require()` of the same package works. Nothing in the documentation mentions that the
published ESM entry cannot be loaded by Node, and the getting-started samples are written as ESM.

**Suggested fix:** either append `/index.js` to the internal re-export, or state plainly in the
docs that DMK targets bundlers and that Node consumers should use CommonJS.

## 2. The types are only reachable under `moduleResolution: node16`, but the ESM build is what that mode prefers

**Cost: ~30 minutes, and it is item 1 wearing a different hat.**

Take the obvious fix for item 1 — a CommonJS TypeScript project, `"module": "CommonJS"`,
`"moduleResolution": "Node"` — and the types vanish:

```
src/device.ts(20,8): error TS2307: Cannot find module '@ledgerhq/device-management-kit' or its
corresponding type declarations.
  There are types at '.../device-management-kit/lib/types/index.d.ts', but this result could not
  be resolved under your current 'moduleResolution' setting. Consider updating to 'node16',
  'nodenext', or 'bundler'.
```

The types are behind an `exports` map, so classic resolution cannot see them. The working
combination is not obvious and is not written down anywhere: **`"module": "Node16"` with
`"moduleResolution": "Node16"` and `"type": "commonjs"` in `package.json`** — Node16 module
resolution, CommonJS emit. `"bundler"` resolution would force ESM emit, which walks straight back
into item 1.

**Suggested fix:** a four-line `tsconfig.json` block in the DMK quickstart showing the CommonJS +
Node16 combination, with one sentence on why `bundler` is the wrong answer for Node.

## 3. `EthAppCommandError` — the one error a human-in-the-loop integration must branch on — is not exported

**Cost: ~20 minutes and a permanently uglier `catch`.**

`6985` (`SW_CONDITIONS_NOT_SATISFIED`) is how the firmware says "the human pressed Reject". It
arrives as a typed error, which is excellent. But:

```js
const signer = require("@ledgerhq/device-signer-kit-ethereum");
Object.keys(signer);
// [ 'GetAddressDeviceActionFactory', 'SignPersonalMessageDeviceActionFactory',
//   'SignTransactionDAStep', 'SignTransactionDeviceActionFactory', 'SignTypedDataDAStateStep',
//   'SignTypedDataDeviceActionFactory', 'EMPTY_EVM_ADDRESS_BOOK', 'TransactionType',
//   'SignerEthBuilder' ]
```

`EthAppCommandError`, `EthErrorCodes` and `ETH_APP_ERRORS` are declared in
`lib/types/internal/app-binder/command/utils/ethAppErrors.d.ts` and are not re-exported from
`api/index.d.ts`. So a consumer cannot write `error instanceof EthAppCommandError`, cannot import
the `EthErrorCodes` union to exhaustively switch on status words, and is left comparing
`error._tag` and `error.errorCode` as strings — which is what this package does, with a comment
explaining why. (`DeviceExchangeError`, the base class, *is* exported from DMK, so the narrowing
that is missing is precisely the Ethereum-specific half.)

**Suggested fix:** re-export `EthAppCommandError`, `EthErrorCodes` and `ETH_APP_ERRORS` from
`api/index`. Branching on a rejection is the central use case of the entire human-in-the-loop
track; it should not require reaching into `internal/`.

## 4. `@ledgerhq/context-module` is a hard, undocumented peer dependency of the Ethereum signer

**Cost: ~15 minutes.**

Installing DMK + the Ethereum signer + the Speculos transport, per the docs, and building gives
`Module not found: @ledgerhq/context-module`. It is imported internally by the signer, not only
by the clear-signing paths, so it is required even for a project that deliberately does no clear
signing. It is not listed as a dependency to install anywhere in the getting-started flow.

**Suggested fix:** either make it a real dependency of `device-signer-kit-ethereum` or list it in
the install command in the docs.

## 5. The Ethereum app reflows `\n` in a personal-sign message into spaces — and this is a security property

**Cost: ~30 minutes, and it changed the design of our message format.**

Signing this 190-byte message:

```
PLIMSOLL MANDATE v1
ACTION: HALT
MARKET: SEA-2026-A
COVERAGE: 98.60%
...
```

produces these screens on a Nano S+:

```
 0 "Review message"
 1 "Message (1/4) PLIMSOLL MANDATE  v1 ACTION: HALT  MARKET: SEA-2026-A "
 2 "Message (2/4) COVERAGE: 98.60%  LOAD LINE: 102.00%  NONCE: 7 EXPIRES: "
 3 "Message (3/4) 2026-09-11T14:32:00Z  CHAIN: 296 VERIFIER:  0xdad77910dbdfde76"
 4 "Message (4/4) 4fc21fcd4e74d71bba ca6d8d"
 5 "Sign message"
 6 "Reject message"
```

Newlines are not line breaks on screen. The text is reflowed and greedily wrapped at ~19
characters, three lines per screen, so **any structure the developer puts into the message is
invisible to the human who is being asked to approve it.** That is not a cosmetic detail: it
means a field value containing a space and a colon renders as if it were additional fields. A
market identifier of `SEA-2026-A NONCE: 9` would display as a mandate with two nonces and the
human could not tell. We ended up enforcing a charset on every field so no value can contain
whitespace or `: `, which is the correct fix, but we found it by screenshotting the emulator
rather than by reading anything.

**Suggested fix:** document the rendering behaviour of `signMessage` on each device family
(wrap width, lines per page, how whitespace is treated) and add one sentence of guidance:
*if you put structured data in a personal-sign message, the delimiters are not visible to the
user; constrain your field charset accordingly.* This is a one-paragraph addition that prevents a
whole class of real vulnerabilities in exactly the integrations this track is asking for.

## 6. Speculos interleaves the pager label into the screen payload

**Cost: ~15 minutes of confused test assertions.**

`GET /events?currentscreenonly=true` returns the pagination indicator as ordinary screen text,
positioned in the middle of the payload:

```
"... CHAIN: 296 VERIFIER:"   then   "Message (4/4) 0x71c7656ec7ab88b09 8defb751b7401b5f6d 8976f"
```

Any harness that reconstructs the displayed message by concatenating screens has to filter
`/Message \(\d+\/\d+\)/` out first, or the reconstruction contains the chrome. Reasonable
behaviour, but it is not mentioned in the API description, and the failure mode is an assertion
that looks like a rendering bug in your own code.

**Suggested fix:** one line in the `/events` documentation, or a `?text-only=true` variant that
omits chrome.

## 7. "The emulator does not reset between signing attempts" is half true, and the half that matters is undocumented

**Cost: ~20 minutes and one unnecessary `docker restart` per test.**

The received wisdom is to `docker restart` between runs. Measured behaviour is more specific:

- After a **rejection** (`6985`) the app returns to `app is ready` on its own. No restart needed.
- After a **completed signature** it also returns on its own. No restart needed.
- After the **client cancels an in-flight action** — a timeout, `deviceAction.cancel()`, a killed
  process — the review screen stays up forever. Speculos has no notion of a client going away, so
  the next signature request queues behind a screen nobody will ever press. `docker restart` is
  the only reliable way out.

The test harness here checks for the idle screen first and only restarts when that fails, which
cuts the device suite from about 60 seconds to about 26.

**Suggested fix:** document the cancellation case specifically, and consider an
`POST /automation`-adjacent endpoint or a `DELETE /apdu` that abandons a pending flow, so
automated suites do not need container restarts at all.

## 8. `speculosTransportFactory`'s second parameter is undocumented

**Cost: 5 minutes, but it is the kind of thing that erodes confidence.**

```ts
speculosTransportFactory: (
  speculosUrl?: string,
  isE2E?: boolean,
  deviceModelId?: DeviceModelId,
) => TransportFactory
```

Every published snippet passes `false` for `isE2E`. Nothing says what it changes, what happens if
you pass `true`, or why an end-to-end flag belongs in a transport constructor. Positional booleans
in a public API are hard to read at the call site even when they are documented.

**Suggested fix:** document it, or take an options object.

## 9. Collapsing a `DeviceAction` to a single result is an unwritten idiom

**Cost: ~20 minutes.**

Every DMK operation returns `{ observable, cancel }` and the observable emits a state per step of
the flow, never completing on its own. The idiom that is actually needed —

```ts
firstValueFrom(
  deviceAction.observable.pipe(
    filter((s) => TERMINAL_STATES.has(s.status)),
  ),
);
```

— does not appear in the getting-started material, which shows `subscribe` with a `next` handler
and leaves "how do I await one result" as an exercise. Worth noting that `DeviceActionStatus` *is*
properly exported (`NotStarted | Pending | Stopped | Completed | Error`), which is good; the gap
is only that `Stopped` is easy to forget, and forgetting it means a cancelled action hangs forever
instead of settling.

**Suggested fix:** a five-line "await a single result" snippet in the DMK quickstart, listing all
three terminal states.

## 10. The ERC-7730 reference page contradicts the registry it documents

**Cost: no build time, but it sent the ERC-7730 evaluation down the wrong path for a while.**

`developers.ledger.com/docs/clear-signing/reference/erc7730-reference` still states that "tools
and the registry currently target ERC-7730 v1. Version 2 is in draft." The registry it points at
ships `specs/erc7730-v2.schema.json`, keeps tests in `testsv2/`, and treats v1 as legacy. v2 also
removed the `excluded` keyword — a selector with no `display.formats` entry simply has no coverage
and falls back to blind signing — which is exactly the kind of thing a developer needs the
reference page to be current about.

**Suggested fix:** update the page, and add a version banner. A stale sentence on a reference page
is more expensive than a missing one, because it is believed.

## 11. Bonus: the good parts, so the feedback is calibrated

- **Prebuilt app ELFs are published as GitHub release assets.** `app-1.22.3-nanos2.elf` downloads
  in seconds; no `ledger-app-builder` toolchain, no cross-compilation. This saved hours and
  deserves to be advertised more loudly than it is — the docs lead with building from source.
- **Speculos's REST API is genuinely good for CI.** `/events?currentscreenonly=true`,
  `POST /button/{left,right,both}` and `/screenshot` are enough to drive an entire approval flow
  headlessly and to assert on what the device actually rendered. The whole test suite in this
  package depends on that and it never flaked.
- **`6985` arriving as a structured error rather than a generic throw** is the right design. It is
  what makes a clean `refused` vs `device-error` distinction possible at all. It just needs to be
  exported (item 3).
- **Plain `signMessage` renders full semantic text on-device.** For a human-in-the-loop use case
  this turned out to be sufficient without any ERC-7730 work, which is a much lower barrier to
  entry than the clear-signing documentation implies. Saying so explicitly — *"if your payload is
  a message rather than a transaction, you may not need a descriptor at all"* — would help a lot
  of hackathon teams.
