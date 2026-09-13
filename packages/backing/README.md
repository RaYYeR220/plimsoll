# @plimsoll/backing

The issuer's backing, as positions rather than a number in a config file.

A Plimsoll note is covered by real ERC-4626 positions on Base held at the
issuer's own address. This package is the operator's side of that: it reads the
positions and what they are worth, puts money into them, and takes money out.
Everything it can say about coverage it reads from a chain — the positions from
Base, the note's outstanding supply, par, issuer and load line from Hedera.

Nothing here signs an attestation. The attestor does that, from the same reads.

## Commands

```bash
npm run build

node dist/src/cli.js status                      # positions, their value, coverage per note
node dist/src/cli.js deposit                     # approve and deposit the planned split
node dist/src/cli.js deposit --vault morpho --all-balance
node dist/src/cli.js withdraw --vault morpho --all
```

**Every command is a dry run until `--send`.** A dry run simulates each
transaction with `eth_call` and `eth_estimateGas` against Base and prints what
each would cost. Where a step depends on one before it — a deposit needs its
approval — the simulation applies that effect as a state override and says so,
so an unfunded wallet still gets a meaningful answer:

```
  2. deposit 8.000000 USDC into morpho (Gauntlet USDC Prime)  [ok, ~448177 gas]
       simulated assuming a USDC balance of 8.000000 (the wallet holds 0.000000); the approval before it has landed
```

Sending needs `HOLDER_PRIVATE_KEY` (or `HEDERA_PRIVATE_KEY`) in the
environment, and the key must derive to the holder address or nothing is sent:

```bash
node --env-file=/path/to/.env dist/src/cli.js deposit --send
```

Against a local fork, `--impersonate` sends as the holder with no key at all,
and refuses to do so anywhere that is not anvil.

## What it reads, and from where

| Figure | Source |
| --- | --- |
| positions, share price | `balanceOf` + `convertToAssets` on Base, pinned to one block hash |
| WETH in USD | Chainlink ETH/USD at that same block |
| notes outstanding | the note's `totalSupply` on Hedera |
| par | its `getNominalValue` / `getNominalValueDecimals` |
| holder | its sole `ROLE_ISSUER` member |
| the line | `LoadLine.lineOf(noteId)` |

Reads are pinned: one block is chosen, and every call is made against that
block's hash with `requireCanonical`, so a status line is never a mix of two
blocks. On a live chain it pins two blocks behind the head.

The vault-set hash is **not** computed here. It is imported from
`@plimsoll/attestor`, because that is the package that signs over it, and a
second definition of a hash is how a payload gets signed that the chain cannot
verify.

## The split

`src/config.ts` holds the vault list and the plan. The negative control's
dollar is allocated first, then the live note's legs are sized from what is
left: two fixed legs and a last leg that takes the remainder, capped so that
redeeming the named position stays decisive whatever the wallet holds.

## Tests

```bash
npm test
```

`test/plan.test.ts` checks the split arithmetic, including that the demo holds
for any funding amount in range. `test/fork.test.ts` runs the whole cycle —
fund, deposit, redeem the named position, deposit it back — on an anvil fork of
Base mainnet, through the same code path a real run uses. It skips loudly if
`anvil` is not on PATH.
