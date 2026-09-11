/**
 * One line of the report.
 *
 * There are exactly three outcomes and no fourth. A check that could not run is
 * never quietly promoted to a pass: it either fails, or it is skipped with a
 * reason a reader can judge for themselves.
 */
export type Status = "pass" | "fail" | "skip";

export interface CheckResult {
  title: string;
  status: Status;
  detail: string;
  /** A public URL where a reader can see the same thing without us. */
  evidence?: string;
}

export interface SectionResult {
  number: number;
  title: string;
  results: CheckResult[];
}

export function pass(title: string, detail: string, evidence?: string): CheckResult {
  return evidence ? { title, status: "pass", detail, evidence } : { title, status: "pass", detail };
}

export function fail(title: string, detail: string, evidence?: string): CheckResult {
  return evidence ? { title, status: "fail", detail, evidence } : { title, status: "fail", detail };
}

export function skip(title: string, reason: string): CheckResult {
  return { title, status: "skip", detail: reason };
}

/**
 * Run one check and turn anything it throws into a failure.
 *
 * An exception here means an endpoint misbehaved or a claim was malformed. In
 * both cases the claim was not verified, and saying so is the only honest
 * report.
 */
export async function guarded(
  title: string,
  work: () => Promise<CheckResult | CheckResult[]>,
): Promise<CheckResult[]> {
  try {
    const result = await work();
    return Array.isArray(result) ? result : [result];
  } catch (error) {
    return [fail(title, `could not be checked: ${describe(error)}`)];
  }
}

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function short(value: string): string {
  return value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

export function utcMinute(seconds: number): string {
  return `${new Date(seconds * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function sameAddress(a?: string | null, b?: string | null): boolean {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase());
}

/** Mirror-node timestamps are `seconds.nanos` strings. */
export function consensusSeconds(timestamp: string | number): number {
  return Number(String(timestamp).split(".")[0]);
}

export function tally(sections: SectionResult[]): { passed: number; failed: number; skipped: number } {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const section of sections) {
    for (const result of section.results) {
      if (result.status === "pass") passed++;
      else if (result.status === "fail") failed++;
      else skipped++;
    }
  }
  return { passed, failed, skipped };
}
