#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AnchorRecord } from "../src/anchor.js";
import { MirrorClient, hashscanTopic, hashscanTx, netForAccount, toMirrorTxId } from "../src/mirror.js";
import type { StoredReceipt } from "../src/receipts.js";
import {
  type Check,
  check,
  checkAnchorBinding,
  checkReceipt,
  recomputeCoverageBps,
} from "../src/verify.js";

/**
 * verify-charge — the judge-runnable proof.
 *
 * Answers one question, with no credentials of any kind: was this charge
 * warranted? It re-reads the anchored evidence, recomputes the coverage ratio
 * from the raw vault readings using its own arithmetic, asks the public mirror
 * node what actually moved, and reports whether the two agree.
 *
 * The interesting case is the one where nothing moved. A refusal leaves no
 * transaction, so the artifact being audited is an absence, and the mirror node
 * is what makes an absence checkable by a stranger.
 */

const VERDICTS = {
  warranted: "CHARGED AND WARRANTED",
  refused: "REFUSED AND NOT CHARGED",
  discrepancy: "DISCREPANCY",
} as const;

type Verdict = (typeof VERDICTS)[keyof typeof VERDICTS];

export interface Args {
  requestId?: string;
  hcs?: { topicId: string; sequenceNumber: number };
  from?: string;
  dataDir: string;
  mirrorUrl?: string;
  json: boolean;
  explain: boolean;
}

function usage(): string {
  return `verify-charge — recompute a Plimsoll coverage charge from public evidence

  Usage:
    verify-charge --request <requestId> [--from <attestorUrl>] [--data-dir <dir>]
    verify-charge --hcs <topicId>:<sequenceNumber> [--from <attestorUrl>]

  Options:
    --request <id>     Request id printed by the attestor or the buyer.
    --hcs <t>:<n>      Topic id and sequence number of the anchored receipt.
    --from <url>       Fetch the receipt over HTTP instead of reading it locally.
    --data-dir <dir>   Local receipt directory (default: data).
    --mirror <url>     Mirror node base URL (default: public testnet).
    --json             Machine-readable output.
    --explain          Print the evidence the verdict was computed from.

  Exit codes: 0 verdict reached, 2 DISCREPANCY, 3 not enough evidence to judge.

  Needs no keys, no account and no access to the attestor's infrastructure.`;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dataDir: "data", json: false, explain: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i] ?? "";
    if (arg === "--request") args.requestId = next();
    else if (arg === "--hcs") {
      const [topicId, sequence] = next().split(":");
      if (!topicId || !sequence) throw new Error("--hcs expects <topicId>:<sequenceNumber>");
      args.hcs = { topicId, sequenceNumber: Number(sequence) };
    } else if (arg === "--from") args.from = next().replace(/\/$/, "");
    else if (arg === "--data-dir") args.dataDir = next();
    else if (arg === "--mirror") args.mirrorUrl = next();
    else if (arg === "--json") args.json = true;
    else if (arg === "--explain") args.explain = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.requestId && !args.hcs) throw new Error("one of --request or --hcs is required");
  return args;
}

export interface VerificationResult {
  verdict: Verdict;
  requestId: string;
  noteId: string;
  decision: string;
  reason: string | null;
  family: string | null;
  anchoredBps: number;
  recomputedBps: number | null;
  floorBps: number;
  charged: boolean;
  settlementTxId: string | null;
  checks: Check[];
  links: Record<string, string>;
}

async function loadRecord(args: Args, mirror: MirrorClient): Promise<AnchorRecord | null> {
  if (!args.hcs) return null;
  const message = await mirror.topicMessage(args.hcs.topicId, args.hcs.sequenceNumber);
  if (!message) throw new Error(`no message ${args.hcs.sequenceNumber} on topic ${args.hcs.topicId}`);
  if (message.chunk_info && message.chunk_info.total > 1) {
    // Anchoring is designed to stay inside one 1024-byte message precisely so
    // this branch stays unreachable. If it fires, the receipt was written by
    // something that is not this service.
    throw new Error(
      `message ${args.hcs.sequenceNumber} is chunked (${message.chunk_info.total} parts); ` +
        `Plimsoll receipts are always a single message`,
    );
  }
  return JSON.parse(Buffer.from(message.message, "base64").toString("utf8")) as AnchorRecord;
}

async function loadReceipt(args: Args, requestId: string): Promise<StoredReceipt | null> {
  if (args.from) {
    const res = await fetch(`${args.from}/receipts/${requestId}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`attestor returned ${res.status} fetching receipt ${requestId}`);
    return (await res.json()) as StoredReceipt;
  }
  const path = join(args.dataDir, "receipts", `${requestId}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as StoredReceipt;
}

export async function verifyCharge(args: Args): Promise<VerificationResult> {
  const mirror = new MirrorClient(args.mirrorUrl ? { baseUrl: args.mirrorUrl } : {});
  const record = await loadRecord(args, mirror);
  const requestId = args.requestId ?? record?.rid ?? "";
  if (!requestId) throw new Error("could not determine a request id from the given evidence");

  const receipt = await loadReceipt(args, requestId);
  if (!record && !receipt) {
    throw new NotEnoughEvidence(
      `no anchored record and no receipt for ${requestId}. Pass --hcs <topic>:<seq>, ` +
        `or --from <attestorUrl> to fetch the receipt over HTTP.`,
    );
  }

  const checks: Check[] = [];

  // Everything below prefers the anchored record, because that is the copy the
  // service cannot quietly rewrite.
  const decision = record?.d ?? receipt!.decision;
  const noteId = record?.n ?? receipt!.noteId;
  const floorBps = record?.floor ?? receipt!.evidence?.floorBps ?? 0;
  const anchoredBps = record?.bps ?? receipt!.coverageBps;
  const claimedCharge = record ? record.chg : receipt!.chargeTransactionId !== null;
  const settlementTxId = record?.tx ?? receipt?.chargeTransactionId ?? null;
  const family = record?.fam ?? receipt?.family ?? null;

  if (receipt) checks.push(...(await checkReceipt(receipt)));
  if (record && receipt) checks.push(...checkAnchorBinding(record, receipt));
  if (record && !receipt) {
    checks.push(
      check(
        "receipt",
        "off-chain evidence available",
        true,
        "verifying from the anchored record alone; pass --from to also bind the full evidence",
      ),
    );
  }

  // --- independent recomputation -------------------------------------------
  let recomputedBps: number | null = null;
  const inlinePositions = record?.pos?.map(([, assets, , assetDecimals]) => ({
    assets,
    assetDecimals,
  }));
  const positions =
    inlinePositions ??
    receipt?.evidence?.positions.map((p) => ({ assets: p.assets, assetDecimals: p.assetDecimals }));

  const unitDecimals = record?.ud ?? receipt?.evidence?.unitDecimals;
  const notesOutstanding = record?.out ?? receipt?.evidence?.notesOutstanding;
  const parPerNote = record?.par ?? receipt?.evidence?.parPerNote;

  if (positions && unitDecimals !== undefined && notesOutstanding && parPerNote) {
    if (positions.length === 0) {
      recomputedBps = 0;
      checks.push(
        check("recompute", "coverage ratio recomputed from raw readings", anchoredBps === 0,
          "no positions; coverage is 0 bps"),
      );
    } else {
      const recomputed = recomputeCoverageBps({
        positions,
        unitDecimals,
        notesOutstanding,
        parPerNote,
      });
      recomputedBps = recomputed.bps;
      const matches = recomputed.bps === anchoredBps;
      checks.push(
        check(
          "recompute",
          "coverage ratio recomputed from raw readings",
          matches,
          matches
            ? `${recomputed.attributableValue} / ${recomputed.obligation} = ${recomputed.bps} bps` +
              (inlinePositions ? " (from the anchored readings)" : " (from hash-bound off-chain evidence)")
            : `anchored ${anchoredBps} bps but the readings give ${recomputed.bps} bps`,
        ),
      );
    }
  } else if (decision === "refused" && family === "evidence") {
    // Correct and expected: an evidence refusal has no ratio to recompute.
    checks.push(
      check("recompute", "coverage ratio recomputed from raw readings", true,
        "not applicable: this refusal states that no ratio was established"),
    );
  } else {
    checks.push(
      check("recompute", "coverage ratio recomputed from raw readings", false,
        "the inputs needed to recompute the ratio are not present in the evidence"),
    );
  }

  // --- what actually moved --------------------------------------------------
  if (claimedCharge) {
    if (!settlementTxId) {
      checks.push(check("settlement", "settlement exists on the mirror node", false,
        "the record claims a charge but names no transaction"));
    } else {
      const tx = await mirror.transaction(settlementTxId);
      if (!tx) {
        checks.push(check("settlement", "settlement exists on the mirror node", false,
          `${settlementTxId} is not on the mirror node, yet a charge was claimed`));
      } else {
        const succeeded = tx.result === "SUCCESS" && tx.name === "CRYPTOTRANSFER";
        checks.push(check("settlement", "settlement exists on the mirror node", succeeded,
          `${tx.name} ${tx.result} at ${tx.consensus_timestamp}`));

        if (receipt) {
          const credited = netForAccount(tx, receipt.payTo);
          const expected = Number(receipt.amountTinybar);
          checks.push(check("amount", "the seller was credited the advertised price",
            credited === expected,
            `${receipt.payTo} net ${credited} tinybar, advertised ${expected}`));
          if (receipt.payer) {
            const debited = netForAccount(tx, receipt.payer);
            checks.push(check("payer", "the payer was debited", debited < 0,
              `${receipt.payer} net ${debited} tinybar`));
          }
        }
      }
    }
  } else {
    // Proving a negative. The claim is that no transfer was ever submitted, so
    // the check is that the mirror node has no record of one.
    if (settlementTxId) {
      const exists = await mirror.transactionExists(settlementTxId);
      checks.push(check("no-settlement", "no settlement exists for this request", !exists,
        exists
          ? `${settlementTxId} EXISTS on the mirror node despite a no-charge claim`
          : `${settlementTxId} is absent from the mirror node`));
    } else if (receipt) {
      // No transaction id was ever produced, because settle was never called.
      //
      // Corroborating that against the ledger is subtler than it looks. A
      // seller normally has other traffic, so "the buyer credited the seller
      // during this window" is not by itself evidence that THIS request was
      // charged — a legitimate paid call moments earlier looks identical. The
      // question is not whether money moved, but whether any movement is
      // unaccounted for.
      //
      // So every credit in the window is matched against the attestations
      // anchored on the topic. A credit explained by an anchored `chg:true`
      // record is someone else's paid call; one that no record claims is a
      // charge nobody is willing to sign for, and that is the discrepancy.
      const from = receipt.requestedAt - 10;
      const to = receipt.respondedAt + 300;
      const credits = await mirror.transfersTo(receipt.payTo, from, to);
      const fromThisPayer = receipt.payer
        ? credits.filter((tx) => netForAccount(tx, receipt.payer!) < 0)
        : [];

      const topicId = args.hcs?.topicId ?? receipt.anchor?.topicId ?? null;
      const accountedFor = topicId ? await claimedSettlements(mirror, topicId) : null;
      const unexplained = accountedFor
        ? fromThisPayer.filter((tx) => !accountedFor.has(tx.transaction_id))
        : fromThisPayer;

      if (accountedFor) {
        checks.push(check("no-settlement", "no unaccounted settlement exists for this request",
          unexplained.length === 0,
          unexplained.length === 0
            ? `${fromThisPayer.length} credit(s) to ${receipt.payTo} in [${from}, ${to}], all of them ` +
              `claimed by anchored attestations; none is attributable to this request, whose signed ` +
              `transfer was never submitted and expired`
            : `${unexplained.length} credit(s) to ${receipt.payTo} that no anchored attestation claims: ` +
              unexplained.map((t) => t.transaction_id).join(", ")));
      } else {
        // Without the topic we cannot attribute other traffic, so we report
        // exactly what was and was not established rather than implying more.
        checks.push(check("no-settlement", "no settlement id was ever produced for this request", true,
          `settle was never called, so there is no transaction to look up. ` +
            `${fromThisPayer.length} credit(s) to ${receipt.payTo} in [${from}, ${to}] could not be ` +
            `attributed without the anchoring topic; pass --hcs <topic>:<seq> to corroborate against it`));
      }
    } else {
      checks.push(check("no-settlement", "no settlement exists for this request", true,
        "the anchored record names no transaction, which is the claim itself"));
    }
  }

  // --- the biconditional ----------------------------------------------------
  const warranted = decision === "attested" && recomputedBps !== null && recomputedBps >= floorBps;
  const chargeMatchesWarrant = claimedCharge === (decision === "attested");
  checks.push(check("biconditional", "charge present if and only if an attestation was warranted",
    chargeMatchesWarrant && (!claimedCharge || warranted),
    claimedCharge
      ? warranted
        ? `charged, and ${recomputedBps} bps clears the ${floorBps} bps floor`
        : `charged, but the evidence does not support an attestation`
      : decision === "attested"
        ? "an attestation was issued but no charge was recorded"
        : "refused, and nothing was charged"));

  const failed = checks.filter((c) => !c.passed);
  const verdict: Verdict =
    failed.length > 0 ? VERDICTS.discrepancy : claimedCharge ? VERDICTS.warranted : VERDICTS.refused;

  const links: Record<string, string> = {};
  if (settlementTxId) links.settlement = hashscanTx(settlementTxId);
  if (args.hcs) links.topic = hashscanTopic(args.hcs.topicId);
  if (receipt?.anchor?.topicId) links.topic = hashscanTopic(receipt.anchor.topicId);

  return {
    verdict,
    requestId,
    noteId,
    decision,
    reason: record?.rsn ?? receipt?.reason ?? null,
    family,
    anchoredBps,
    recomputedBps,
    floorBps,
    charged: claimedCharge,
    settlementTxId,
    checks,
    links,
  };
}

/**
 * Mirror-node transaction ids that some anchored attestation claims as its own
 * charge. Reading the topic needs no credentials, which is what keeps this
 * corroboration available to a stranger.
 */
async function claimedSettlements(mirror: MirrorClient, topicId: string): Promise<Set<string>> {
  const claimed = new Set<string>();
  for (const message of await mirror.topicMessages(topicId, 100)) {
    if (message.chunk_info && message.chunk_info.total > 1) continue;
    try {
      const record = JSON.parse(Buffer.from(message.message, "base64").toString("utf8"));
      if (record?.p === "plimsoll/coverage" && record.chg === true && record.tx) {
        claimed.add(toMirrorTxId(String(record.tx)));
      }
    } catch {
      // Anything unparseable was not written by this service. It cannot excuse
      // a transfer, so leaving it out of the accounted set fails closed.
    }
  }
  return claimed;
}

export class NotEnoughEvidence extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotEnoughEvidence";
  }
}

function render(result: VerificationResult, explain: boolean): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(`  request ${result.requestId}   note ${result.noteId}`);
  lines.push(
    `  decision: ${result.decision}${result.reason ? `  (${result.family} / ${result.reason})` : ""}`,
  );
  lines.push("");
  for (const c of result.checks) {
    lines.push(`  ${c.passed ? "ok  " : "FAIL"}  ${c.label}`);
    lines.push(`        ${c.detail}`);
  }
  lines.push("");
  if (explain) {
    lines.push(`  anchored ratio    ${result.anchoredBps} bps`);
    lines.push(`  recomputed ratio  ${result.recomputedBps ?? "not applicable"} bps`);
    lines.push(`  load line         ${result.floorBps} bps`);
    lines.push(`  charged           ${result.charged ? "yes" : "no"}`);
    lines.push("");
  }
  for (const [name, url] of Object.entries(result.links)) lines.push(`  ${name}: ${url}`);
  if (Object.keys(result.links).length > 0) lines.push("");
  lines.push(`  VERDICT: ${result.verdict}`);
  lines.push("");
  return lines.join("\n");
}

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${(error as Error).message}\n`);
    console.error(usage());
    process.exit(3);
  }

  try {
    const result = await verifyCharge(args);
    console.log(args.json ? JSON.stringify(result, null, 2) : render(result, args.explain));
    process.exit(result.verdict === VERDICTS.discrepancy ? 2 : 0);
  } catch (error) {
    if (error instanceof NotEnoughEvidence) {
      console.error(`cannot evaluate: ${error.message}`);
      process.exit(3);
    }
    console.error(error);
    process.exit(3);
  }
}

// See isMainModule() in src/server.ts for why pathToFileURL is required here.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
