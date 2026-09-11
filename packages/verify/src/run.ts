import { checkAts } from "./checks/ats.js";
import { checkContracts } from "./checks/contracts.js";
import { checkDenial } from "./checks/denial.js";
import { checkGithub, checkSubstreams } from "./checks/external.js";
import { checkHcs } from "./checks/hcs.js";
import { checkLedger } from "./checks/ledger.js";
import { checkCashLeg } from "./checks/token.js";
import type { Context } from "./context.js";
import { type CheckResult, type SectionResult, describe, fail } from "./result.js";

export interface SectionDefinition {
  number: number;
  title: string;
  run: (ctx: Context) => Promise<CheckResult[]>;
}

export const SECTIONS: SectionDefinition[] = [
  { number: 1, title: "Contracts: live, inside the event window, exact match on Sourcify", run: checkContracts },
  { number: 2, title: "The hero denial", run: checkDenial },
  { number: 3, title: "The ATS note", run: checkAts },
  { number: 4, title: "The HTS cash leg", run: checkCashLeg },
  { number: 5, title: "x402 attestations and refusals on HCS", run: checkHcs },
  { number: 6, title: "hedera-harness pull request", run: checkGithub },
  { number: 7, title: "Substreams package", run: checkSubstreams },
  { number: 8, title: "Ledger: halt, reject, resume", run: checkLedger },
];

/**
 * Start every section at once — the per-host throttle keeps that polite — and
 * hand them back in order, so the report reads top to bottom while it runs.
 */
export async function* runSections(
  ctx: Context,
  sections: SectionDefinition[] = SECTIONS,
): AsyncGenerator<SectionResult> {
  const started = sections.map((section) => ({
    section,
    results: section.run(ctx).catch((error: unknown) => [fail(section.title, `could not be checked: ${describe(error)}`)]),
  }));
  for (const { section, results } of started) {
    yield { number: section.number, title: section.title, results: await results };
  }
}
