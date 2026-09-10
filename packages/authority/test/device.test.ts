/**
 * Live device tests. These talk to a running Speculos and press its buttons; they are the proof
 * that the refusal path and the approval path are real and that they differ by one button.
 *
 * Requires the emulator from README.md to be up. They do not mock it, and they are not supposed
 * to pass without it.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import {
  DeviceAuthority,
  SPECULOS_TEST_ADDRESS,
  SW_CONDITIONS_NOT_SATISFIED,
  configFromEnv,
} from "../src/device";
import { formatMandate, recoverMandateSigner } from "../src/mandate";
import { SpeculosScreen } from "../src/screen";
import { ensureIdle, requireSpeculos, settle, show, squash } from "./harness";
import { GOLDEN_MANDATE, GOLDEN_TEXT } from "./vectors";

const screen = new SpeculosScreen();

function authorityWith(overrides: Parameters<typeof configFromEnv>[1] = {}): DeviceAuthority {
  return DeviceAuthority.fromEnv(process.env, overrides);
}

describe("device authority against live Speculos", () => {
  before(async () => {
    await requireSpeculos(screen);
    await ensureIdle(screen);
  });

  after(async () => {
    await ensureIdle(screen).catch(() => undefined);
  });

  it("derives the golden address from the emulator seed", async () => {
    const device = authorityWith();
    try {
      const result = await device.getAddress();
      assert.equal(result.ok, true, show(result));
      assert.ok(result.ok);
      assert.equal(result.address, SPECULOS_TEST_ADDRESS);
    } finally {
      await device.close();
    }
  });

  it("refuses before display when the device holds a different key", async () => {
    const device = authorityWith({ expectedAddress: "0x000000000000000000000000000000000000dead" });
    try {
      const result = await device.signMandate(GOLDEN_MANDATE);
      assert.equal(result.ok, false);
      assert.ok(!result.ok);
      assert.equal(result.reason, "address-mismatch");
      assert.match(result.detail, /0xdad77910dbdfde764fc21fcd4e74d71bbaca6d8d/i);
      assert.equal("attestation" in result, false);
      // Nothing was ever put in front of a human.
      assert.match(await screen.readScreenText(), /app is ready/i);
    } finally {
      await device.close();
    }
  });

  it("turns a rejection on the device into a typed refusal with no signature", async () => {
    await ensureIdle(screen);
    const device = authorityWith();
    try {
      const pending = device.signMandate(GOLDEN_MANDATE);
      await settle(1_500);
      const walk = await screen.reject();
      assert.equal(walk.found, true, `never reached the reject screen: ${show(walk.transcript)}`);

      const result = await pending;
      assert.equal(result.ok, false, show(result));
      assert.ok(!result.ok);
      assert.equal(result.reason, "refused");
      assert.match(result.detail, new RegExp(SW_CONDITIONS_NOT_SATISFIED));
      // The union has no signature branch on refusal, and the value carries none at runtime.
      assert.equal("attestation" in result, false);
      assert.equal(Object.keys(result).sort().join(","), "detail,ok,reason");
    } finally {
      await device.close();
    }
  });

  it("turns an approval on the device into a signature that recovers to the authority", async () => {
    await ensureIdle(screen);
    const device = authorityWith();
    try {
      const pending = device.signMandate(GOLDEN_MANDATE);
      await settle(1_500);
      const walk = await screen.approve();
      assert.equal(walk.found, true, `never reached the sign screen: ${show(walk.transcript)}`);

      const result = await pending;
      assert.equal(result.ok, true, show(result));
      assert.ok(result.ok);

      const { attestation } = result;
      assert.equal(attestation.message, GOLDEN_TEXT);
      assert.equal(attestation.message, formatMandate(GOLDEN_MANDATE));
      assert.equal((attestation.signature.length - 2) / 2, 65);
      assert.equal(recoverMandateSigner(GOLDEN_MANDATE, attestation.signature), SPECULOS_TEST_ADDRESS);

      // The device rendered our semantics, not an opaque hash: every byte of the mandate the
      // contract will reconstruct appeared on screen, in order.
      const shown = squash(walk.transcript);
      assert.ok(
        shown.includes(GOLDEN_TEXT.replace(/\s+/g, "")),
        `device did not render the mandate. screens: ${show(walk.transcript)}`,
      );
      assert.match(shown, /ACTION:SET-THRESHOLD/);
      assert.match(shown, /COVERAGE:98\.60%/);
      assert.match(shown, /VERIFIER:0x71c7656ec7ab88b098defb751b7401b5f6d8976f/);
    } finally {
      await device.close();
    }
  });

  it("cancels the in-flight operation and reports a timeout when nobody decides", async () => {
    await ensureIdle(screen);
    const device = authorityWith({ signTimeoutMs: 2_500 });
    try {
      const started = Date.now();
      const result = await device.signMandate(GOLDEN_MANDATE);
      const elapsed = Date.now() - started;

      assert.equal(result.ok, false);
      assert.ok(!result.ok);
      assert.equal(result.reason, "timeout");
      assert.equal("attestation" in result, false);
      assert.ok(elapsed < 30_000, `timeout took ${elapsed}ms`);
    } finally {
      await device.close();
      // A cancelled review stays on screen; put the emulator back for whatever runs next.
      await ensureIdle(screen);
    }
  });
});
