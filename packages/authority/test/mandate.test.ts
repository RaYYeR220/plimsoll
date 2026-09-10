import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hashMessage } from "ethers";

import {
  MANDATE_HEADER,
  MANDATE_KEYS,
  MAX_EXPIRY,
  MIN_EXPIRY,
  MandateFormatError,
  formatBasisPoints,
  formatExpiry,
  formatMandate,
  hashMandate,
  normalizeAddress,
  packSignature,
  parseBasisPoints,
  parseExpiry,
  parseMandate,
  type Mandate,
} from "../src/mandate";
import { GOLDEN_DIGEST, GOLDEN_MANDATE, GOLDEN_TEXT } from "./vectors";

function withField<K extends keyof Mandate>(key: K, value: Mandate[K]): Mandate {
  return { ...GOLDEN_MANDATE, [key]: value };
}

describe("mandate rendering", () => {
  it("renders the golden vector byte for byte", () => {
    assert.equal(formatMandate(GOLDEN_MANDATE), GOLDEN_TEXT);
  });

  it("stays inside printable ASCII so EIP-191 byte length equals character length", () => {
    const text = formatMandate(GOLDEN_MANDATE);
    assert.equal(Buffer.byteLength(text, "utf8"), text.length);
    assert.match(text, /^[\x20-\x7e\n]+$/);
  });

  it("renders exactly one line per field, in the declared order", () => {
    const lines = formatMandate(GOLDEN_MANDATE).split("\n");
    assert.equal(lines.length, MANDATE_KEYS.length + 1);
    assert.equal(lines[0], MANDATE_HEADER);
    MANDATE_KEYS.forEach((key, i) => assert.ok(lines[i + 1]!.startsWith(`${key}: `)));
  });

  it("never emits a value containing whitespace or a key separator", () => {
    // The device reflows newlines into spaces, so these are the only things keeping a value
    // from rendering as if it were two more fields.
    const lines = formatMandate({ ...GOLDEN_MANDATE, market: "SEA-2026-A" }).split("\n").slice(1);
    for (const [i, line] of lines.entries()) {
      const value = line.slice(`${MANDATE_KEYS[i]}: `.length);
      assert.ok(!/\s/.test(value), `${MANDATE_KEYS[i]} contains whitespace: ${value}`);
      assert.ok(!value.includes(": "), `${MANDATE_KEYS[i]} contains a key separator: ${value}`);
    }
  });

  it("fits within the size a Nano S+ will page rather than blind-sign", () => {
    const longest = formatMandate({
      ...GOLDEN_MANDATE,
      market: "A".repeat(24),
      coverageBps: 99999,
      loadLineBps: 99999,
      nonce: (1n << 64n) - 1n,
      expiry: MAX_EXPIRY,
      chainId: Number.MAX_SAFE_INTEGER,
    });
    assert.ok(longest.length <= 256, `worst case is ${longest.length} bytes`);
  });

  it("produces a distinct string for every single-field perturbation", () => {
    const variants: Mandate[] = [
      GOLDEN_MANDATE,
      withField("action", "HALT"),
      withField("action", "RESUME"),
      withField("market", "SEA-2026-B"),
      withField("coverageBps", 9861),
      withField("loadLineBps", 9501),
      withField("nonce", 8n),
      withField("expiry", GOLDEN_MANDATE.expiry + 1n),
      withField("chainId", 295),
      withField("verifyingContract", normalizeAddress("0x71c7656ec7ab88b098defb751b7401b5f6d89760")),
    ];
    const rendered = variants.map(formatMandate);
    assert.equal(new Set(rendered).size, variants.length);
    assert.equal(new Set(variants.map(hashMandate)).size, variants.length);
  });

  it("cannot render a coverage figure that reads as the load line figure", () => {
    // 986 bps and 9860 bps are a plausible unit slip; they must never render the same.
    assert.notEqual(formatBasisPoints(986), formatBasisPoints(9860));
    assert.equal(formatBasisPoints(986), "9.86%");
    assert.equal(formatBasisPoints(9860), "98.60%");
  });
});

describe("mandate field encodings", () => {
  it("renders basis points with exactly two decimals", () => {
    assert.equal(formatBasisPoints(0), "0.00%");
    assert.equal(formatBasisPoints(5), "0.05%");
    assert.equal(formatBasisPoints(10_000), "100.00%");
    assert.equal(formatBasisPoints(10_340), "103.40%");
    assert.equal(formatBasisPoints(99_999), "999.99%");
  });

  it("round-trips every basis-point value in the supported range", () => {
    for (let bps = 0; bps <= 99_999; bps += 7) {
      assert.equal(parseBasisPoints(formatBasisPoints(bps)), bps);
    }
  });

  it("rejects non-canonical percentages", () => {
    for (const bad of ["98.6%", "098.60%", "98.600%", "98.60", "+98.60%", "98,60%", "1000.00%"]) {
      assert.throws(() => parseBasisPoints(bad), MandateFormatError, bad);
    }
  });

  it("rejects out-of-range basis points", () => {
    for (const bad of [-1, 100_000, 1.5, Number.NaN]) {
      assert.throws(() => formatBasisPoints(bad), MandateFormatError, String(bad));
    }
  });

  it("renders and re-reads UTC instants, including a leap day", () => {
    for (const iso of [
      "2024-01-01T00:00:00Z",
      "2026-09-13T16:00:00Z",
      "2028-02-29T23:59:59Z",
      "2100-12-31T23:59:59Z",
    ]) {
      assert.equal(formatExpiry(parseExpiry(iso)), iso);
    }
  });

  it("rejects timestamps that are well shaped but not real instants", () => {
    for (const bad of [
      "2026-02-30T00:00:00Z",
      "2026-13-01T00:00:00Z",
      "2026-09-13T25:00:00Z",
      "2026-09-13T16:00:00+00:00",
      "2026-09-13T16:00:00.000Z",
      "2026-9-13T16:00:00Z",
      "2026-09-13 16:00:00Z",
    ]) {
      assert.throws(() => parseExpiry(bad), MandateFormatError, bad);
    }
  });

  it("bounds the expiry window", () => {
    assert.throws(() => formatExpiry(MIN_EXPIRY - 1n), MandateFormatError);
    assert.throws(() => formatExpiry(MAX_EXPIRY + 1n), MandateFormatError);
    assert.doesNotThrow(() => formatExpiry(MIN_EXPIRY));
    assert.doesNotThrow(() => formatExpiry(MAX_EXPIRY));
  });

  it("accepts only canonical market codes", () => {
    for (const good of ["A", "SEA-2026-A", "PLIM1", "A1-B2-C3", "X".repeat(24)]) {
      assert.doesNotThrow(() => formatMandate(withField("market", good)), good);
    }
    for (const bad of [
      "",
      "sea-2026-a",
      "SEA 2026 A",
      "SEA-2026-",
      "-SEA",
      "SEA--2026",
      "SEA:2026",
      "SEA\n2026",
      "SEA_2026",
      "X".repeat(25),
    ]) {
      assert.throws(() => formatMandate(withField("market", bad)), MandateFormatError, JSON.stringify(bad));
    }
  });

  it("requires a lowercase verifying contract so the Solidity mirror can reproduce it", () => {
    assert.throws(
      () => formatMandate(withField("verifyingContract", "0x71C7656EC7ab88b098defB751B7401B5f6d8976F" as never)),
      MandateFormatError,
    );
    assert.equal(
      normalizeAddress("0x71C7656EC7ab88b098defB751B7401B5f6d8976F"),
      "0x71c7656ec7ab88b098defb751b7401b5f6d8976f",
    );
    assert.throws(() => normalizeAddress("0x1234"), MandateFormatError);
  });

  it("rejects a chain id that is not a positive integer", () => {
    for (const bad of [0, -1, 1.5]) {
      assert.throws(() => formatMandate(withField("chainId", bad)), MandateFormatError, String(bad));
    }
  });

  it("rejects a nonce outside uint64", () => {
    assert.throws(() => formatMandate(withField("nonce", -1n)), MandateFormatError);
    assert.throws(() => formatMandate(withField("nonce", 1n << 64n)), MandateFormatError);
    assert.doesNotThrow(() => formatMandate(withField("nonce", (1n << 64n) - 1n)));
  });
});

describe("mandate parsing", () => {
  it("round-trips the golden vector", () => {
    assert.deepEqual(parseMandate(GOLDEN_TEXT), GOLDEN_MANDATE);
    assert.equal(formatMandate(parseMandate(GOLDEN_TEXT)), GOLDEN_TEXT);
  });

  it("round-trips every action", () => {
    for (const action of ["HALT", "RESUME", "SET-THRESHOLD"] as const) {
      const m = withField("action", action);
      assert.deepEqual(parseMandate(formatMandate(m)), m);
    }
  });

  it("rejects a reordered, truncated or padded mandate", () => {
    const lines = GOLDEN_TEXT.split("\n");
    const swapped = [...lines];
    [swapped[2], swapped[3]] = [swapped[3]!, swapped[2]!];
    for (const bad of [
      swapped.join("\n"),
      lines.slice(0, -1).join("\n"),
      `${GOLDEN_TEXT}\nEXTRA: 1`,
      `${GOLDEN_TEXT}\n`,
      GOLDEN_TEXT.replace("PLIMSOLL MANDATE v1", "PLIMSOLL MANDATE v2"),
      GOLDEN_TEXT.replace("ACTION: ", "ACTION:"),
      GOLDEN_TEXT.replace("NONCE: 7", "NONCE: 07"),
      GOLDEN_TEXT.replace("CHAIN: 296", "CHAIN: 0296"),
      GOLDEN_TEXT.replace("\n", "\r\n"),
    ]) {
      assert.throws(() => parseMandate(bad), MandateFormatError, JSON.stringify(bad.slice(0, 60)));
    }
  });
});

describe("mandate digest", () => {
  it("matches the recorded golden digest", () => {
    assert.equal(hashMandate(GOLDEN_MANDATE), GOLDEN_DIGEST);
  });

  it("agrees with an independent EIP-191 implementation", () => {
    assert.equal(hashMandate(GOLDEN_MANDATE), hashMessage(GOLDEN_TEXT));
  });

  it("packs a device signature into the 65 bytes the contract expects", () => {
    const packed = packSignature({ r: `0x${"11".repeat(32)}`, s: `0x${"22".repeat(32)}`, v: 27 });
    assert.equal(packed, `0x${"11".repeat(32)}${"22".repeat(32)}1b`);
    assert.equal((packed.length - 2) / 2, 65);
    assert.throws(() => packSignature({ r: "0x11", s: "0x22", v: 0 }), MandateFormatError);
  });
});
