import { test } from "node:test";
import assert from "node:assert/strict";
import { withEvery } from "../src/notes.js";

test("a runtime cadence replaces the package default and nothing else", () => {
  assert.equal(withEvery("every=150", undefined), "every=150");
  assert.equal(withEvery("every=150", "  "), "every=150");
  assert.equal(withEvery("every=150", "50"), "every=50");
  assert.equal(withEvery("", "50"), "every=50");
});

test("a malformed cadence fails loudly instead of using the default", () => {
  assert.throws(() => withEvery("every=150", "0"));
  assert.throws(() => withEvery("every=150", "-5"));
  assert.throws(() => withEvery("every=150", "fifty"));
  assert.throws(() => withEvery("every=150", "12.5"));
});
