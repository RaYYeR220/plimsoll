/**
 * Shared fixtures. The golden mandate below is the same one asserted in
 * `test-sol/MandateVerifier.t.sol`; if the two ever disagree, the format has drifted between
 * TypeScript and Solidity and every mandate produced by one side stops verifying on the other.
 */

import type { Mandate } from "../src/mandate";

/** A published example address, used so the golden vector has a fixed verifying contract. */
export const GOLDEN_VERIFIER = "0x71c7656ec7ab88b098defb751b7401b5f6d8976f" as const;

export const HEDERA_TESTNET_CHAIN_ID = 296;

export const GOLDEN_MANDATE: Mandate = {
  action: "SET-THRESHOLD",
  market: "SEA-2026-A",
  coverageBps: 9860,
  loadLineBps: 9500,
  nonce: 7n,
  expiry: 1_789_315_200n, // 2026-09-13T16:00:00Z
  chainId: HEDERA_TESTNET_CHAIN_ID,
  verifyingContract: GOLDEN_VERIFIER,
};

export const GOLDEN_TEXT = [
  "PLIMSOLL MANDATE v1",
  "ACTION: SET-THRESHOLD",
  "MARKET: SEA-2026-A",
  "COVERAGE: 98.60%",
  "LOAD LINE: 95.00%",
  "NONCE: 7",
  "EXPIRES: 2026-09-13T16:00:00Z",
  "CHAIN: 296",
  "VERIFIER: 0x71c7656ec7ab88b098defb751b7401b5f6d8976f",
].join("\n");

export const GOLDEN_DIGEST = "0x195cff43efc99c7b78124a2037a9546e716ef5454a43c2233e0170befbd337de" as const;
