import { join } from "node:path";
import type { Context } from "../context.js";
import { PACKAGE_ROOT, type ManifestRecord } from "../inputs.js";
import { type Json, type TopicMessage, netFor, toMirrorTransactionId } from "../mirror.js";
import { type CheckResult, consensusSeconds, fail, guarded, pass, sameAddress, short, skip } from "../result.js";

/**
 * Check 5: the canonical x402 records on HCS.
 *
 * Each record is held to the shape its kind promises, then handed to the
 * attestor's own verify-charge, from the public topic alone. Two things are
 * then checked on the ledger directly:
 *
 *   - the paid attestation's transfer exists and moved value from one account
 *     to another, which also names the seller;
 *   - each refusal has no transfer. verify-charge, given only the public record,
 *     cannot do this itself: the record does not carry the seller's account.
 *     With the seller known from the paid attestation, every credit to it in the
 *     window around the refusal must be claimed by some anchored attestation. A
 *     credit nobody signed for is a charge for a refusal.
 */

/** A path that never holds receipts, so verify-charge sees only public data. */
const NO_RECEIPTS = join(PACKAGE_ROOT, ".no-receipts");

const FIGURELESS = ["bps", "floor", "blk", "obs", "ud", "out", "par", "obl", "val", "ss", "vsh", "srch", "pos"];

interface Loaded {
  message: TopicMessage | null;
  record: Json | null;
  bytes: number;
  error?: string;
}

export async function checkHcs(ctx: Context): Promise<CheckResult[]> {
  const { topicId, records } = ctx.manifest.hcs;
  const window = ctx.manifest.hcs.refusalWindowSeconds ?? { before: 120, after: 300 };
  const attestor = ctx.record.roles.attestor;

  const loaded = new Map<number, Loaded>();
  for (const expected of records) loaded.set(expected.sequence, await load(ctx, topicId, expected.sequence));

  const money = new Map<number, CheckResult[]>();
  let seller: string | null = null;
  for (const expected of records.filter((r) => r.expect === "attested")) {
    const rows = await guarded(`#${expected.sequence} payment settled on the ledger`, async () => {
      const { row, credited } = await paymentRow(ctx, expected);
      seller ??= credited;
      return row;
    });
    money.set(expected.sequence, rows);
  }

  const claimed = await claimedSettlements(ctx, topicId);
  for (const expected of records.filter((r) => r.expect !== "attested")) {
    money.set(
      expected.sequence,
      await guarded(`#${expected.sequence} no transfer was made for it`, () =>
        absenceRow(ctx, expected, loaded.get(expected.sequence)!, seller, claimed, window),
      ),
    );
  }

  const rows: CheckResult[] = [];
  for (const expected of records) {
    const record = loaded.get(expected.sequence)!;
    rows.push(shapeRow(ctx, topicId, expected, record, attestor));
    rows.push(...(await guarded(`#${expected.sequence} verify-charge`, () => verdictRow(ctx, topicId, expected))));
    rows.push(...(money.get(expected.sequence) ?? []));
  }
  return rows;
}

async function load(ctx: Context, topicId: string, sequence: number): Promise<Loaded> {
  const message = await ctx.mirror.topicMessage(topicId, sequence);
  if (!message) return { message: null, record: null, bytes: 0, error: `no message #${sequence} on topic ${topicId}` };
  const raw = Buffer.from(message.message, "base64");
  try {
    return { message, record: JSON.parse(raw.toString("utf8")), bytes: raw.length };
  } catch {
    return { message, record: null, bytes: raw.length, error: `message #${sequence} is not JSON` };
  }
}

function kindTitle(expected: ManifestRecord): string {
  const kind =
    expected.expect === "attested" ? "attestation" : expected.expect === "asset-refusal" ? "asset refusal" : "evidence refusal";
  return `#${expected.sequence} ${kind}`;
}

function shapeRow(ctx: Context, topicId: string, expected: ManifestRecord, loaded: Loaded, attestor?: string): CheckResult {
  const title = kindTitle(expected);
  const evidence = `${ctx.explorer}/topic/${topicId}`;
  if (loaded.error || !loaded.record) return fail(title, loaded.error ?? "unreadable", evidence);
  if (loaded.message?.chunk_info && loaded.message.chunk_info.total > 1) {
    return fail(title, `split across ${loaded.message.chunk_info.total} chunks; a receipt is always one message`, evidence);
  }
  const problems = shapeProblems(loaded.record, expected, attestor);
  if (loaded.bytes > 1024) problems.push(`${loaded.bytes} bytes, over the 1024-byte message limit`);
  if (problems.length) return fail(title, problems.join("; "), evidence);

  const r = loaded.record;
  // The feed is reported on every line rather than only where it is unusual: a
  // reader should not have to know that its absence would have meant anything.
  const feed = r.feed ? ` · feed ${r.feed}` : "";
  const detail =
    expected.expect === "attested"
      ? `v${r.v} · ${r.n} · ${r.bps} bps ≥ ${r.floor} · ${loaded.bytes} B · attestor ${short(r.att)}${feed}`
      : expected.expect === "asset-refusal"
        ? `v${r.v} · ${r.rsn} · ${r.bps} bps · ${loaded.bytes} B${feed}`
        : `v${r.v} · ${r.rsn} · no figure published · ${loaded.bytes} B${feed}`;
  return pass(title, detail, evidence);
}

export function shapeProblems(record: Json, expected: ManifestRecord, attestor?: string): string[] {
  const problems: string[] = [];
  const format = expected.format ?? 3;
  if (record.p !== "plimsoll/coverage") problems.push(`format ${JSON.stringify(record.p)}`);
  if (record.v !== format) problems.push(`declares v${record.v}, expected v${format}`);

  // From v3 a record has to carry what makes it checkable on its own: the note
  // id the oracle knows, the oracle and chain its signature is bound to, the
  // account a charge would have credited, and where the readings came from.
  // `feed` is the one that stops a fixture-derived record being read as a
  // measurement once the document explaining it is gone.
  if (format >= 3) {
    for (const key of ["nid", "orc", "cid", "pay", "feed"]) {
      if (!(key in record)) problems.push(`declares v${format} but omits ${key}`);
    }
  }
  if (expected.noteId && record.n !== expected.noteId) problems.push(`note ${record.n}, expected ${expected.noteId}`);
  if (attestor && !sameAddress(record.att, attestor)) {
    problems.push(`signed by ${record.att}, the record's attestor is ${attestor}`);
  }

  const claimsCharge = record.chg !== false || "tx" in record;
  switch (expected.expect) {
    case "attested":
      if (record.d !== "attested") problems.push(`decision ${record.d}`);
      if (record.chg !== true) problems.push("does not claim the charge");
      if (expected.payment && record.tx !== expected.payment) {
        problems.push(`names payment ${record.tx}, the manifest names ${expected.payment}`);
      }
      if (typeof record.bps !== "number" || typeof record.floor !== "number") problems.push("carries no ratio");
      else if (record.bps < record.floor) problems.push(`${record.bps} bps is below its own ${record.floor} bps floor`);
      break;
    case "asset-refusal":
      if (record.d !== "refused" || record.fam !== "asset") problems.push(`is ${record.d}/${record.fam}, not an asset refusal`);
      if (expected.reason && record.rsn !== expected.reason) problems.push(`reason ${record.rsn}`);
      if (record.known === true && typeof record.bps !== "number") problems.push("claims a ratio but publishes none");
      if (claimsCharge) problems.push("claims a charge");
      break;
    case "evidence-refusal": {
      if (record.d !== "refused" || record.fam !== "evidence") {
        problems.push(`is ${record.d}/${record.fam}, not an evidence refusal`);
      }
      if (expected.reason && record.rsn !== expected.reason) problems.push(`reason ${record.rsn}`);
      if (record.known !== false) problems.push("claims to know a ratio");
      const present = FIGURELESS.filter((key) => key in record);
      if (present.length) problems.push(`publishes ${present.join(", ")} although it established no figure`);
      if (claimsCharge) problems.push("claims a charge");
      break;
    }
  }
  return problems;
}

async function verdictRow(ctx: Context, topicId: string, expected: ManifestRecord): Promise<CheckResult> {
  const title = `#${expected.sequence} verify-charge`;
  if (!ctx.verifyCharge) return fail(title, ctx.verifyChargeError ?? "the attestor's verify-charge is unavailable");
  const result = await ctx.verifyCharge({
    hcs: { topicId, sequenceNumber: expected.sequence },
    dataDir: NO_RECEIPTS,
    json: true,
    explain: false,
    mirrorUrl: ctx.endpoints.mirror,
  });
  const want = expected.expect === "attested" ? "CHARGED AND WARRANTED" : "REFUSED AND NOT CHARGED";
  const failed = result.checks.filter((check) => !check.passed);
  if (result.verdict === want && failed.length === 0) {
    const ratio = result.recomputedBps === null ? "no ratio to recompute" : `recomputed ${result.recomputedBps} bps`;
    return pass(title, `${result.verdict} · ${result.checks.length} checks · ${ratio}`);
  }
  return fail(title, `${result.verdict}${failed.length ? `: ${failed.map((check) => check.label).join("; ")}` : ""}, expected ${want}`);
}

/** Nodes, the fee account and the staking accounts all sit below 0.0.1000. */
function isSystemAccount(account: string): boolean {
  return Number(account.split(".")[2]) < 1000;
}

async function paymentRow(ctx: Context, expected: ManifestRecord): Promise<{ row: CheckResult; credited: string | null }> {
  const title = `#${expected.sequence} payment settled on the ledger`;
  if (!expected.payment) return { row: fail(title, "the manifest names no payment for this attestation"), credited: null };
  const evidence = `${ctx.explorer}/transaction/${toMirrorTransactionId(expected.payment)}`;
  const tx = await ctx.mirror.transaction(expected.payment);
  if (!tx) return { row: fail(title, `${expected.payment} is not on the mirror node`, evidence), credited: null };
  if (tx.name !== "CRYPTOTRANSFER" || tx.result !== "SUCCESS") {
    return { row: fail(title, `${expected.payment} is ${tx.name} ${tx.result}, not a successful transfer`, evidence), credited: null };
  }

  // The transaction's own payer is the facilitator, which pays the network fee.
  const feePayer = tx.transaction_id.split("-")[0]!;
  const legs = (tx.transfers ?? []).filter((t) => t.account !== feePayer && !isSystemAccount(t.account));
  const credits = legs.filter((t) => t.amount > 0);
  const debits = legs.filter((t) => t.amount < 0);
  if (credits.length !== 1 || debits.length !== 1 || credits[0]!.amount !== -debits[0]!.amount) {
    return {
      row: fail(title, `not a single transfer from one account to another: ${JSON.stringify(legs)}`, evidence),
      credited: null,
    };
  }
  const seller = credits[0]!.account;
  return {
    row: pass(
      title,
      `${debits[0]!.account} → ${seller} · ${credits[0]!.amount} tinybar · fee paid by ${feePayer}`,
      evidence,
    ),
    credited: seller,
  };
}

async function claimedSettlements(ctx: Context, topicId: string): Promise<Map<string, number>> {
  const claimed = new Map<string, number>();
  for (const message of await ctx.mirror.topicMessages(topicId, 100)) {
    try {
      const record = JSON.parse(Buffer.from(message.message, "base64").toString("utf8"));
      if (record?.p === "plimsoll/coverage" && record.chg === true && record.tx) {
        claimed.set(toMirrorTransactionId(String(record.tx)), message.sequence_number);
      }
    } catch {
      // Not written by the attestor. It cannot excuse a transfer, so leaving it
      // out of the claimed set fails closed.
    }
  }
  return claimed;
}

async function absenceRow(
  ctx: Context,
  expected: ManifestRecord,
  loaded: Loaded,
  seller: string | null,
  claimed: Map<string, number>,
  window: { before: number; after: number },
): Promise<CheckResult> {
  const title = `#${expected.sequence} no transfer was made for it`;
  if (!seller) {
    return skip(title, "no paid attestation in the manifest names the seller account to watch");
  }
  if (!loaded.message) return fail(title, loaded.error ?? "the refusal record is missing");

  const at = consensusSeconds(loaded.message.consensus_timestamp);
  const credits = (await ctx.mirror.transfersInvolving(seller, at - window.before, at + window.after)).filter(
    (tx) => netFor(tx, seller) > 0,
  );
  const unclaimed = credits.filter((tx) => !claimed.has(tx.transaction_id));
  const span = `${Math.round(window.before / 60)} min before to ${Math.round(window.after / 60)} min after`;
  if (unclaimed.length > 0) {
    return fail(
      title,
      `${unclaimed.length} credit(s) to ${seller} that no anchored attestation claims: ` +
        unclaimed.map((tx) => tx.transaction_id).join(", "),
    );
  }
  const explained = credits.map((tx) => `#${claimed.get(tx.transaction_id)}`).join(", ");
  return pass(
    title,
    `nothing credited ${seller} from ${span} that an attestation does not claim` +
      (credits.length ? ` · in the window: ${explained}` : " · no credits at all"),
  );
}
