# @plimsoll/authority

Two things in Plimsoll are irreversible and privileged:

1. **halting or resuming a market**, which stops coupons settling and stops secondary transfers clearing, and
2. **moving the load line**, the coverage threshold that decides when the first thing happens.

This package makes both of them impossible without a human pressing a button on a Ledger.

The mechanism is deliberately small. A privileged action needs a signature. The only thing that
produces that signature is the Ethereum app on a Ledger device, over a plain-English mandate the
device paginates and displays in full. If the human declines, the firmware answers `6985`
(`SW_CONDITIONS_NOT_SATISFIED`) and **no signature is created at all** — there is nothing to
retry with, nothing to leak, and nothing on chain that will accept the call. Same binary, same
command, opposite outcome; the only variable is a thumb.

```
CASE A -- the human refuses to lower the load line
  screens  : Review message >> Message (1/4) PLIMSOLL MANDATE v1 ACTION: SET- THRESHOLD
             >> Message (2/4) MARKET: SEA-2026-A COVERAGE: 98.60% LOAD LINE: 95.00%
             >> Message (3/4) NONCE: 101 EXPIRES: 2026-09-10T02:19:59Z CHAIN: 296 VERIFIER:
             >> Message (4/4) 0x71c7656ec7ab88b09 8defb751b7401b5f6d 8976f
             >> Sign message >> Reject message
  outcome  : NO SIGNATURE (refused)
  detail   : _tag=EthAppCommandError errorCode=6985 message=Condition not satisfied

CASE B -- the human approves restarting the market
  outcome  : APPROVED on device
  signature: 0xd653b7eb...cf74abfd1c
  recovers to: 0xDad77910DbDFdE764fC21FCD4E74D71bBACA6D8D
```

## The mandate

`signMessage` is EIP-191 personal-sign over a raw string. There is no schema and no on-device
parser: **the string the device displays and the string the contract hashes must be the same
bytes**. That is the highest-risk bug available here, so the format is defined once in
[`src/mandate.ts`](src/mandate.ts) and mirrored by exactly one other implementation,
`mandateText()` in [`../../contracts/MandateVerifier.sol`](../../contracts/MandateVerifier.sol).

```
PLIMSOLL MANDATE v1
ACTION: SET-THRESHOLD
MARKET: SEA-2026-A
COVERAGE: 98.60%
LOAD LINE: 95.00%
NONCE: 7
EXPIRES: 2026-09-13T16:00:00Z
CHAIN: 296
VERIFIER: 0x71c7656ec7ab88b098defb751b7401b5f6d8976f
```

198 bytes, four screens on a Nano S+.

**Why two different mandates cannot render as the same text.** Each field's rendering is an
injective function of its value, the field set has fixed arity and fixed order, and no value may
contain a newline, whitespace or a `: `. The concatenation of injective functions over a fixed
tuple shape is itself injective, so distinct mandates have distinct text and distinct digests.
The constraint that does the work is the charset:

| field | canonical form | why |
| --- | --- | --- |
| `ACTION` | one of `HALT`, `RESUME`, `SET-THRESHOLD` | closed set |
| `MARKET` | `^[A-Z0-9]+(-[A-Z0-9]+)*$`, 1–24 chars | no space and no colon, so a market code cannot impersonate more fields |
| `COVERAGE`, `LOAD LINE` | `98.60%` — always two decimals, never a leading zero | bijective with basis points; `9.86%` and `98.60%` can never be confused |
| `NONCE`, `CHAIN` | decimal, no leading zeros | one string per value |
| `EXPIRES` | `YYYY-MM-DDTHH:MM:SSZ`, always UTC | the human can read it; the contract derives it from a `uint64` |
| `VERIFIER` | `0x` + 40 lowercase hex | full address, no truncation |

That last constraint matters more than it looks. **The device reflows the message**: newlines are
rendered as spaces and the text is wrapped greedily to the screen width, so the human never sees
the line structure. Field boundaries survive only because the `KEY: ` tokens are distinctive and
because no value can contain one. A market code of `SEA-2026-A NONCE: 9` would otherwise render as
a mandate with two nonces, and the human would have no way to tell.

`LOAD LINE` always means *the load line in force once this mandate executes*. For `SET-THRESHOLD`
it is the new value. For `HALT` and `RESUME` the contract requires it to equal the value already
in force, so a halt approved against a 102.00% line cannot execute after somebody moved the line
underneath it.

### Design decisions with a downstream cost

Three of these are real trade-offs rather than free wins, so they are stated rather than buried.

**The contract formats, it never parses.** `MandateVerifier` takes typed arguments and rebuilds
the string from them plus `block.chainid` and `address(this)`. The cost is ~230 lines of Solidity
that would not exist otherwise — a decimal formatter, a two-digit padder, a hex-address writer and
a civil-from-days date formatter — and about 6.9 KB of the 24,576-byte EIP-170 budget. What it
buys is that there is no parser on the trust path. A caller cannot show the device one string and
hand the chain another, because the only string that verifies is the one the contract would have
written itself. Given that byte-identity is the single failure this module exists to prevent,
paying in bytecode to delete an entire class of it is the right side of the trade.

**Expiry is carried as a human-readable ISO-8601 instant, not a Unix integer.** A Unix second
would have cost roughly forty lines less Solidity, but `EXPIRES: 1789315200` is not something a
human can check, and the human is the security control. Carrying *both* would be worse than
either: two representations of the same fact is two things that can disagree, and a compromised
caller would show a friendly date next to a machine-read number that says something else. So the
mandate carries one representation, the contract derives it from the `uint64` it enforces, and
what the human reads is exactly what expires. The expiry window is bounded to
`[2024-01-01, 2100-12-31]` so the date formatter stays inside a range that is tested — including
2100, which is divisible by four and still not a leap year.

**The verifier address is lowercase, not EIP-55 checksummed.** A checksum exists to catch a human
retyping an address. Here the string is generated on both sides and compared byte for byte, so the
checksum would catch nothing and would cost an extra keccak plus roughly forty lines in a contract
deploying to a chain that enforces EIP-170. The downstream cost is that anyone re-implementing
`formatMandate` in a third language must remember to lowercase; that is written down here and
asserted by `formatMandate`, which refuses a mixed-case address outright rather than silently
normalising it.

**Coverage is basis points, capped at 999.99%.** A coverage ratio above ten times par is not a
number this product produces, and the cap keeps the rendered field at most seven characters, which
keeps the whole mandate inside four screens. If a market ever needs more, it needs a `v2` header,
not a wider field — the version string is the first thing on the first screen for exactly that
reason.

## Layout

```
packages/authority/
  src/mandate.ts       the canonical string, its digest, and a strict round-tripping parser
  src/device.ts        DeviceAuthority: connect, bind the expected signer, sign, fail closed
  src/screen.ts        Speculos driver -- TEST AND DEMO ONLY, not exported from src/index.ts
  src/index.ts         public surface
  test/mandate.test.ts unit tests for the format (no device)
  test/tamper.test.ts  negative controls against a software key (no device)
  test/device.test.ts  live tests against a running Speculos
  test/harness.ts      emulator plumbing for the tests
  test/vectors.ts      the golden mandate, shared with the Solidity suite
  test-sol/            Foundry suite for the on-chain half
  demo/run.ts          the two-run walkthrough
  demo/fixture.ts      regenerates the device-signed fixture baked into the Solidity suite
../../contracts/MandateVerifier.sol
```

The split between the real signer and the emulator harness is deliberate and load-bearing.
`src/screen.ts` presses the device's buttons; nothing in `src/device.ts` imports it and it is not
re-exported from `src/index.ts`. If it is ever on a production call path, the human has been
replaced by a loop, which is the exact thing this package exists to prevent.

## Running it from a cold machine

### 1. Speculos

We have no physical device, so everything runs against Ledger's emulator. This is the exact
bring-up, verified on Windows 11 + Docker 29.5.2 + Node 24.13.0.

```bash
docker pull ghcr.io/ledgerhq/speculos:latest

mkdir -p apps
curl -sL -o apps/eth-nanosp.elf \
  https://github.com/LedgerHQ/app-ethereum/releases/download/1.22.3/app-1.22.3-nanos2.elf

export MSYS_NO_PATHCONV=1      # Git Bash only; without it /apps is mangled into a Windows path

docker run -d --name spec -p 5000:5000 -p 40000:40000 \
  -v "$(pwd -W)/apps:/apps" ghcr.io/ledgerhq/speculos:latest \
  --model nanosp --display headless --api-port 5000 --apdu-port 40000 \
  --seed "glory promote mansion idle axis finger extra february uncover one trip resource lawn turtle enact monster seven myth punch hobby comfort wild raise skin" \
  /apps/eth-nanosp.elf
```

On Linux or macOS use `$(pwd)` instead of `$(pwd -W)` and drop the `MSYS_NO_PATHCONV` line.

Port 5000 is the HTTP API the Device Management Kit talks to; 40000 is raw APDU for legacy
clients. Check it is up:

```bash
curl -s 'http://127.0.0.1:5000/events?currentscreenonly=true'
# {"events": [{"text": "Ethereum", ...}, {"text": "app is ready", ...}]}
```

That seed is Speculos's published test mnemonic. It deterministically yields
**`0xDad77910DbDFdE764fC21FCD4E74D71bBACA6D8D`** at `m/44'/60'/0'/0/0`, and the test suite asserts
it, so a mis-seeded emulator fails loudly instead of quietly signing with the wrong key.

### 2. The package

```bash
cd packages/authority
npm install
npm test            # builds, then runs every TypeScript test including the live device ones
```

For the Solidity half, Foundry needs `forge-std`. The repo does not vendor it, and it cannot be a
submodule of this package alone, so fetch it once:

```bash
git clone --depth 1 --branch v1.9.7 https://github.com/foundry-rs/forge-std lib/forge-std
npm run test:sol
```

| script | what it does |
| --- | --- |
| `npm run build` | `tsc` to CommonJS in `dist/` |
| `npm test` | build, then every `node:test` suite (needs Speculos) |
| `npm run test:unit` | format and tamper suites only, no device needed |
| `npm run test:device` | live device suite only |
| `npm run test:sol` | `forge test` |
| `npm run test:all` | both halves |
| `npm run demo` | the two-run walkthrough, screenshots into `demo/screens/` |

### 3. Environment

Everything has a working default against the emulator; nothing here is a secret.

| variable | default | meaning |
| --- | --- | --- |
| `PLIMSOLL_LEDGER_URL` | `http://127.0.0.1:5000` | Speculos HTTP API, or a device bridge |
| `PLIMSOLL_LEDGER_PATH` | `44'/60'/0'/0/0` | derivation path |
| `PLIMSOLL_LEDGER_ADDRESS` | the Speculos test address | the only key allowed to authorise |
| `PLIMSOLL_LEDGER_MODEL` | `nanosp` | `nanos`, `nanosp`, `nanox`, `stax`, `flex` |
| `PLIMSOLL_LEDGER_CONNECT_TIMEOUT_MS` | `20000` | discovery and connect budget |
| `PLIMSOLL_LEDGER_SIGN_TIMEOUT_MS` | `120000` | how long a human gets to decide |
| `PLIMSOLL_SPECULOS_CONTAINER` | `spec` | container the test harness restarts when the emulator is wedged |

`PLIMSOLL_LEDGER_ADDRESS` defaults to the emulator's test address only because this package is
wired to Speculos out of the box. Point it at a real device before it guards anything real.

## Failing closed

`signMandate` returns a value, never an exception:

```ts
type SignResult =
  | { ok: true;  attestation: MandateAttestation }
  | { ok: false; reason: "refused" | "timeout" | "device-error" | "address-mismatch"; detail: string };
```

- A human declining, a disconnected device, a transport fault and a timeout all produce the same
  thing as far as the caller is concerned: no signature.
- The expected signer is bound **before** anything is displayed — a device holding the wrong key
  never gets shown a mandate — and the recovered address is checked **after**, so a signature that
  does not belong to the expected authority never leaves the method.
- On timeout the in-flight DMK operation is cancelled through its `cancel` handle.
- The refusal branch of the union has no signature field, and at runtime the value carries none;
  the device suite asserts both.

On chain, `MandateVerifier` re-derives the same string and enforces the authority address, a
single-use nonce, the expiry, `block.chainid` and `address(this)`, and reverts with named errors —
`InvalidAttestation`, `MandateExpired`, `NonceUsed`, `WrongAuthority`, `WrongAction`,
`BadMarketCode`, `UnknownMarket`, `LoadLineMoved`, `CoverageBelowLine`, `MarketAlreadyHalted`,
`MarketNotHalted`, `ValueOutOfRange`, `NoAuthority`. It is 6,892 bytes of runtime code, 17,684
under the EIP-170 limit Hedera enforces.

## Honest limits

Being precise about what this does and does not prove is worth more than a stronger-sounding
claim, so:

- **The Ledger Key Ring is hardware-mandatory and is not used here.** We have no physical device
  and the Key Ring CLI cannot run against Speculos. Nothing in this package is a Key Ring
  integration and it does not claim to be one.
- **We do not claim the signing key never exists in software.** It exists in the emulator, and on
  a real Nano it would exist in the secure element — but that is a property of the hardware, not
  of anything demonstrated here.
- **What we do claim** is narrower and fully demonstrated: *a signature authorising a privileged
  action only comes into existence if a human approved it on the device, and a refusal produces no
  signature at all.* The device suite runs both branches against a live emulator; the Solidity
  suite verifies a signature the device actually produced, and reverts on every way of presenting
  one it did not.
- **Speculos is an emulator, not a device.** It faithfully runs the real `app-ethereum` 1.22.3 ELF
  and returns real firmware status words, but it has no secure element and its seed is public. The
  DMK path was cross-checked against a raw APDU (`E002000015` + the serialised path posted to
  `/apdu`) and returned a byte-identical address, so the SDK is not inventing what the app
  computed; that is as far as an emulator can take the claim.
- **No ERC-7730 descriptors.** Real ones are signed by Ledger's CAL backend and verified on-device
  through a PKI chain; a self-made descriptor is likely to fail that check and silently fall back
  to blind signing, which looks like it works and does not. The sanctioned route needs a Ledger
  employee to merge a registry PR. Deliberately out of scope — and unnecessary, because plain
  `signMessage` already renders the full semantic mandate on screen.
- **The mandate binds the authority, not the market data.** Coverage and the load line are numbers
  the operator is asked to confirm; this package proves a human saw and approved them. Whether the
  coverage figure itself is honest is the job of the attestation service that computes it from
  real ERC-4626 vault state, not of this module.
- **A single authority key.** `MandateVerifier.authority` is immutable and there is no rotation
  path or m-of-n. That is a real limitation for production and a deliberate one for a verifier
  that has to stay small and readable.

## Tooling feedback

Every papercut hit while building this, with versions and exact error text, is in
[`DX-NOTES.md`](DX-NOTES.md).
