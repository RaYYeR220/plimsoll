import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderRow, renderSection, renderSummary, type RenderOptions } from "../src/report.js";
import { fail, pass, skip, type SectionResult } from "../src/result.js";

const plain: RenderOptions = { color: false, ascii: false, links: false, width: 120 };

describe("the report", () => {
  it("leads every line with its verdict", () => {
    assert.match(renderRow(pass("LoadLine", "0.0.1 · Sourcify exact_match"), plain), /^\s+✓ {2}LoadLine\s+0\.0\.1/);
    assert.match(renderRow(fail("LoadLine", "not on the mirror node"), plain), /^\s+✗ {2}LoadLine/);
    assert.match(renderRow(skip("Substreams", "not yet published"), plain), /^\s+– {2}Substreams\s+skipped: not yet published/);
  });

  it("falls back to plain words for terminals without Unicode", () => {
    const ascii = { ...plain, ascii: true };
    assert.match(renderRow(pass("a", "b"), ascii), /ok {2}/);
    assert.match(renderRow(fail("a", "b"), ascii), /FAIL/);
    assert.match(renderRow(skip("a", "b"), ascii), /skip/);
  });

  it("wraps a long reason under its title instead of running off the screen", () => {
    const lines = renderRow(fail("x", "word ".repeat(60).trim()), { ...plain, width: 80 }).split("\n");
    assert.ok(lines.length > 2);
    assert.ok(lines.every((line) => line.length <= 80), lines.map((l) => l.length).join(","));
  });

  it("writes no escape codes when colour is off", () => {
    const section: SectionResult = { number: 1, title: "t", results: [pass("a", "b"), fail("c", "d"), skip("e", "f")] };
    assert.ok(!renderSection(section, plain).includes("\x1b["));
  });

  it("says VERIFIED only when nothing failed, and counts every outcome", () => {
    const clean: SectionResult[] = [{ number: 1, title: "t", results: [pass("a", "b"), skip("c", "d")] }];
    const summary = renderSummary(clean, 1500, 12, plain);
    assert.match(summary, /1 passed · 0 failed · 1 skipped/);
    assert.match(summary, /VERIFIED\. Nothing failed/);
    assert.match(summary, /12 requests, every one to a public endpoint/);

    const broken: SectionResult[] = [{ number: 1, title: "t", results: [pass("a", "b"), fail("c", "d")] }];
    assert.match(renderSummary(broken, 1500, 12, plain), /NOT VERIFIED\. 1 check failed/);
  });
});
