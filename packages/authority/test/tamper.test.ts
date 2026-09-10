/**
 * Negative controls that must fail.
 *
 * These run against a software key so they exercise the *format* rather than the device: what
 * happens when the bytes a signer approved and the bytes a verifier reconstructs are not the
 * same bytes. The on-chain half of each of these lives in `test-sol/MandateVerifier.t.sol`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Wallet, verifyMessage } from "ethers";

import {
  formatMandate,
  hashMandateText,
  hashMandate,
  isExpired,
  recoverMandateSigner,
  type Hex,
  type Mandate,
} from "../src/mandate";
import { GOLDEN_MANDATE, GOLDEN_TEXT } from "./vectors";

const AUTHORITY_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const IMPOSTOR_KEY = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba";

const authority = new Wallet(AUTHORITY_KEY);
const impostor = new Wallet(IMPOSTOR_KEY);

async function signAs(wallet: Wallet, text: string): Promise<Hex> {
  return (await wallet.signMessage(text)) as Hex;
}

describe("tampered mandates", () => {
  it("a signature over the golden text recovers to its signer", async () => {
    const signature = await signAs(authority, GOLDEN_TEXT);
    assert.equal(recoverMandateSigner(GOLDEN_MANDATE, signature), authority.address);
    assert.equal(verifyMessage(GOLDEN_TEXT, signature), authority.address);
  });

  it("one byte of difference between displayed and hashed text breaks recovery", async () => {
    // The human reads 98.60%; the verifier reconstructs 98.61%. This is the single failure this
    // module is built around, so it gets its own control.
    const displayed = GOLDEN_TEXT;
    const reconstructed = formatMandate({ ...GOLDEN_MANDATE, coverageBps: 9861 });
    assert.equal(displayed.length, reconstructed.length);
    assert.equal([...displayed].filter((c, i) => c !== reconstructed[i]).length, 1);

    const signature = await signAs(authority, displayed);
    assert.notEqual(hashMandateText(displayed), hashMandateText(reconstructed));
    assert.notEqual(verifyMessage(reconstructed, signature), authority.address);
  });

  it("a signature from the wrong key does not recover to the authority", async () => {
    const signature = await signAs(impostor, GOLDEN_TEXT);
    const recovered = recoverMandateSigner(GOLDEN_MANDATE, signature);
    assert.equal(recovered, impostor.address);
    assert.notEqual(recovered, authority.address);
  });

  it("a mandate signed for another chain does not verify here", async () => {
    const elsewhere: Mandate = { ...GOLDEN_MANDATE, chainId: 1 };
    const signature = await signAs(authority, formatMandate(elsewhere));
    assert.notEqual(hashMandate(elsewhere), hashMandate(GOLDEN_MANDATE));
    assert.notEqual(recoverMandateSigner(GOLDEN_MANDATE, signature), authority.address);
  });

  it("a mandate signed for another deployment does not verify here", async () => {
    const elsewhere: Mandate = {
      ...GOLDEN_MANDATE,
      verifyingContract: "0x000000000000000000000000000000000000dead",
    };
    const signature = await signAs(authority, formatMandate(elsewhere));
    assert.notEqual(hashMandate(elsewhere), hashMandate(GOLDEN_MANDATE));
    assert.notEqual(recoverMandateSigner(GOLDEN_MANDATE, signature), authority.address);
  });

  it("a mandate for a different market or action is a different digest", () => {
    const digests = new Set([
      hashMandate(GOLDEN_MANDATE),
      hashMandate({ ...GOLDEN_MANDATE, market: "SEA-2026-B" }),
      hashMandate({ ...GOLDEN_MANDATE, action: "HALT" }),
      hashMandate({ ...GOLDEN_MANDATE, action: "RESUME" }),
    ]);
    assert.equal(digests.size, 4);
  });

  it("reports an expired mandate as expired", () => {
    assert.equal(isExpired(GOLDEN_MANDATE, GOLDEN_MANDATE.expiry), false);
    assert.equal(isExpired(GOLDEN_MANDATE, GOLDEN_MANDATE.expiry + 1n), true);
  });

  it("a replayed nonce is identical bytes, which is why replay is a chain-side rule", async () => {
    // Worth stating explicitly: nothing off-chain can distinguish a replay from the original,
    // because it *is* the original. Single-use nonces are enforced in MandateVerifier.
    const first = await signAs(authority, GOLDEN_TEXT);
    const second = await signAs(authority, GOLDEN_TEXT);
    assert.equal(first, second);
  });
});
