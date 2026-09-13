# @plimsoll/verify

One command that checks every claim this submission makes, against public
endpoints only. No keys, no wallet, no account.

```
npm --prefix packages/verify run verify
```

The first run installs and builds what it needs from this repository, including
the attestor package whose `verify-charge` it reuses. After that a full run takes
seconds.

## What it checks

| # | claim | how |
| --- | --- | --- |
| 1 | Every current contract is live, was created inside the event window, was created by the transaction the record names, and is an exact match on Sourcify | mirror node `contracts/{address}` and `contracts/results/{deployTx}`, Sourcify v2 |
| 2 | The hero denial reverted on-chain, naming the blocked counterparty | the revert is decoded by selector: `0x796c1f0d` is `AccountIsBlocked(address)` |
| 3 | The ATS note exists and holds the balances the record states | keyless `eth_call` through the mirror node. The buyer's address is read out of the record's own `transferByPartition` transaction, not typed in |
| 4 | The HTS cash token's freeze key is a contract key naming `CashLegController`, and there is no admin key | the mirror node renders contract keys as `ProtobufEncoded`, so the key bytes are decoded |
| 5 | The canonical HCS records have the shape their kind promises. The paid attestation's transfer exists. The two refusals have no transfer | each record goes through the attestor's own `verify-charge`, from the public topic alone. The absence of a charge is then checked on the ledger (see below) |
| 6 | hedera-harness pull request #55 is open | public GitHub API, one request |
| 7 | `plimsoll-erc4626` v0.2.0 is published, with its 12 modules and `map_positions` | the package is downloaded from the registry by name and version, the way the Substreams CLI resolves it, and its module list is read out of the package bytes. The local `substreams.yaml` is never consulted: v0.1.1 shipped without `map_positions` although the sources had it, and only the published bytes show that |
| 8 | The live Ledger sequence: device approvals, the value binding, the wrong-key and wrong-door reverts | each device signature is recovered offline from its exact mandate text. Each transaction is compared with the proof on the mirror node, and reverts are decoded with the error ABI read from the contracts' own Solidity |

### Proving a refusal was not charged

A refusal has no transaction, so there is nothing to look up. From anchor format
v3 the record names the seller's account in `pay`, which is what makes the claim
falsifiable from the public topic alone, and `verify-charge` checks it there.

This package checks it a second time without taking the record's word for which
account to watch: the seller is read from the paid attestation's own transfer on
the ledger. It then lists every credit to that account from two minutes before
the refusal to five minutes after, which is x402's maximum authorisation window.
Each credit must be claimed by some anchored attestation. A credit nobody signed
for is a charge for a refusal, and fails.

## Read, never hardcode

Every address and id comes from `packages/contracts/deployments/hedera-testnet.json`
at run time, and every device transaction from the proof that file points at. A
redeploy is checked as it is now, not as it was when this was written. The only
facts this package owns are in `manifest.json`: the event window, the canonical
HCS sequence numbers and the payment they cite, and where the two external claims
live. A test fails if the manifest ever repeats a value that belongs to the record.

Custom errors are decoded with an ABI parsed from `packages/contracts/src` at run
time, so a renamed error decodes under its new name.

## Three outcomes, and no fourth

Every line is ✓, ✗, or skipped with its reason. Nothing that could not be checked
is reported as a pass:

- If the mirror node or Sourcify cannot answer, the claim was not verified, and it fails.
- GitHub and substreams.dev are third parties with their own limits and release schedules. When they cannot answer, the line is skipped and says why. When they answer and contradict the claim, it fails.
- Superseded contracts and tokens are kept in the record as history. They are listed as skipped history, never verified as live and never reported as failures.

Exit code 0 means nothing failed, 1 means something failed, and 2 means the
inputs could not be read.

## Being a polite client

Every request, including the ones `verify-charge` makes, goes through a per-host
gate. That is 8 requests a second to the mirror node, well inside its public limit
of about 50, and one a second to GitHub. It backs off on 429 and 5xx and honours
`Retry-After`. A full run makes a few dozen requests and one to GitHub, far inside
the unauthenticated limit of 60 an hour.

## Options

```
npm --prefix packages/verify run verify -- --links        also print a public link for each line
npm --prefix packages/verify run verify -- --only 1,5,8   run some sections
npm --prefix packages/verify run verify -- --json         machine-readable output
npm --prefix packages/verify run verify -- --ascii        plain markers for terminals without Unicode
```

## Tests

```
npm --prefix packages/verify test
```

The offline suite runs against a frozen, mutually consistent copy of the record
and the device proof in `test/fixtures`. The live files are rewritten by every
redeploy, and a unit test that broke on that would be testing the calendar
rather than the verifier. The device signatures in that copy are real and are
recovered offline.

The live suite runs against the public endpoints, and includes negative
controls: a deliberately wrong contract address, a planted denial transaction
that actually succeeded, and a planted payment id. Each must come back ✗.

## What this does not check

- **The coverage figures themselves.** The canonical anchored records are produced from fixtures (see `packages/attestor/MOCKS.md`). This recomputes each ratio from the anchored readings and checks the payment biconditional, but does not re-read the vaults. Each record says which source produced it in `feed`, and that value is printed on every line of section 5, so a simulated reading cannot be read as a measurement.
- **Sourcify for ATS contracts.** The note is deployed by the ATS factory from ATS's source, and the record does not claim it is verified.
- **Anything beyond what the public mirror node reports.** That is the trust root for everything here, as it would be for any stranger.
- **Charges older than the latest hundred anchored records.** The absence check reads those to see which credits are claimed. A refusal whose window held a charge from further back would be misreported, which would take more than a hundred anchors inside seven minutes.
