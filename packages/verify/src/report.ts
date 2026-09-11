import { relative } from "node:path";
import type { Inputs } from "./inputs.js";
import { type CheckResult, type SectionResult, type Status, tally } from "./result.js";

/**
 * Terminal output meant to be read by a person, possibly in a screen
 * recording: one line per claim, the verdict first, and the reason for every
 * skip in plain words.
 */
export interface RenderOptions {
  color: boolean;
  ascii: boolean;
  links: boolean;
  width: number;
}

const ESC = "\x1b[";
const STYLE = { reset: `${ESC}0m`, bold: `${ESC}1m`, dim: `${ESC}2m`, green: `${ESC}32m`, red: `${ESC}31m`, yellow: `${ESC}33m` };
const TITLE_WIDTH = 44;
const INDENT = "     ";

function paint(options: RenderOptions, style: string, text: string): string {
  return options.color ? `${style}${text}${STYLE.reset}` : text;
}

export function marker(status: Status, options: RenderOptions): string {
  if (options.ascii) return status === "pass" ? "ok  " : status === "fail" ? "FAIL" : "skip";
  return status === "pass" ? "✓" : status === "fail" ? "✗" : "–";
}

function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export function renderRow(result: CheckResult, options: RenderOptions): string {
  const color = result.status === "pass" ? STYLE.green : result.status === "fail" ? STYLE.red : STYLE.yellow;
  const mark = paint(options, color, marker(result.status, options));
  const markWidth = options.ascii ? 4 : 1;
  const title = result.title.length > TITLE_WIDTH ? result.title : result.title.padEnd(TITLE_WIDTH);
  const detail = result.status === "skip" ? `skipped: ${result.detail}` : result.detail;
  const paintedTitle = result.status === "fail" ? paint(options, STYLE.red, title) : title;
  const paintedDetail =
    result.status === "pass" ? paint(options, STYLE.dim, detail) : paint(options, color, detail);

  const prefix = `${INDENT}${mark}  `;
  const prefixWidth = INDENT.length + markWidth + 2;
  const lines: string[] = [];
  if (prefixWidth + title.length + 2 + detail.length <= options.width) {
    lines.push(`${prefix}${paintedTitle}  ${paintedDetail}`);
  } else {
    lines.push(`${prefix}${result.status === "fail" ? paint(options, STYLE.red, result.title) : result.title}`);
    const hang = " ".repeat(prefixWidth + 2);
    for (const part of wrap(detail, Math.max(40, options.width - hang.length))) {
      lines.push(`${hang}${result.status === "pass" ? paint(options, STYLE.dim, part) : paint(options, color, part)}`);
    }
  }
  if (options.links && result.evidence && /^https?:/.test(result.evidence)) {
    lines.push(`${" ".repeat(prefixWidth + 2)}${paint(options, STYLE.dim, result.evidence)}`);
  }
  return lines.join("\n");
}

export function renderHeader(inputs: Inputs, options: RenderOptions): string {
  const record = relative(inputs.repoRoot, inputs.recordPath).replace(/\\/g, "/");
  return [
    "",
    `  ${paint(options, STYLE.bold, "Plimsoll")} — every claim, checked against public endpoints only`,
    `  ${paint(options, STYLE.dim, `no keys · no wallet · no account · chain ${inputs.record.network.chainId} · ${record}`)}`,
    "",
  ].join("\n");
}

export function renderSection(section: SectionResult, options: RenderOptions): string {
  const heading = `  ${paint(options, STYLE.bold, `${section.number}  ${section.title}`)}`;
  return [heading, ...section.results.map((result) => renderRow(result, options)), ""].join("\n");
}

export function renderSummary(
  sections: SectionResult[],
  elapsedMs: number,
  requests: number,
  options: RenderOptions,
): string {
  const { passed, failed, skipped } = tally(sections);
  const rule = (options.ascii ? "-" : "─").repeat(Math.min(options.width - 4, 88));
  const counts =
    `${paint(options, STYLE.green, `${passed} passed`)} · ` +
    `${paint(options, failed ? STYLE.red : STYLE.dim, `${failed} failed`)} · ` +
    `${paint(options, skipped ? STYLE.yellow : STYLE.dim, `${skipped} skipped`)}`;
  const timing = paint(
    options,
    STYLE.dim,
    `${(elapsedMs / 1000).toFixed(1)} s · ${requests} requests, every one to a public endpoint`,
  );
  const verdict =
    failed === 0
      ? paint(options, `${STYLE.bold}${STYLE.green}`, "VERIFIED.") +
        (skipped ? " Nothing failed; each skip above says why it was not checked." : " Every claim holds.")
      : paint(options, `${STYLE.bold}${STYLE.red}`, "NOT VERIFIED.") +
        ` ${failed} check${failed === 1 ? "" : "s"} failed; the ✗ lines above say which and why.`;
  return ["", `  ${rule}`, `  ${counts}    ${timing}`, `  ${verdict}`, ""].join("\n");
}
