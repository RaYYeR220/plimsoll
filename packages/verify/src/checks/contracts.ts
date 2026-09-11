import type { Context } from "../context.js";
import { type ContractEntry, supersededGenerations } from "../inputs.js";
import { type CheckResult, consensusSeconds, fail, guarded, pass, short, skip, utcMinute } from "../result.js";

/**
 * Check 1: every contract the record says is current exists, is live, was
 * created inside the event window, was created by the transaction the record
 * names, and is an exact match on Sourcify.
 *
 * Replaced stacks are listed as history and never verified as live: the record
 * keeps them to explain what changed, not to claim they are in use. The ATS
 * infrastructure is checked for existence only. It was deployed by the ATS
 * team before the event, and the record says plainly that Plimsoll deploys
 * none of it.
 */
export async function checkContracts(ctx: Context): Promise<CheckResult[]> {
  const tasks: Array<Promise<CheckResult[]>> = [];

  const add = (label: string, entry: ContractEntry, requireSourcify: boolean) =>
    tasks.push(guarded(label, () => checkDeployed(ctx, label, entry, requireSourcify)));

  for (const [name, entry] of Object.entries(ctx.record.contracts)) add(name, entry, true);

  const note = ctx.record.ats?.issuedNote;
  if (note) {
    add(
      `ATS note ${note.symbol}`,
      { address: note.address, hederaId: note.hederaId, deployTx: note.deployBondTx },
      false,
    );
    tasks.push(
      Promise.resolve([
        skip(
          `ATS note ${note.symbol} on Sourcify`,
          "the record does not claim it is verified: it is deployed by the ATS factory from ATS's source",
        ),
      ]),
    );
  }

  for (const [label, address] of [
    ["ATS BusinessLogicResolver", ctx.record.ats?.businessLogicResolver],
    ["ATS Factory", ctx.record.ats?.factory],
  ] as const) {
    if (address) tasks.push(guarded(label, () => checkExisting(ctx, label, address)));
  }

  // Every replaced stack stays in the record as history. None of it is a
  // current claim, so it is listed, never verified as live and never reported
  // as a failure.
  const generations = supersededGenerations(ctx.record);
  const retired = generations.flatMap((generation) => Object.values(generation.contracts ?? {}));
  if (retired.length > 0) {
    const dates = [
      ...new Set(
        generations
          .map((generation) => generation.reason?.match(/Superseded on (\d{4}-\d{2}-\d{2})/)?.[1])
          .filter((date): date is string => Boolean(date)),
      ),
    ];
    const redeploys = `${generations.length} redeploy${generations.length === 1 ? "" : "s"}`;
    tasks.push(
      Promise.resolve([
        skip(
          `${retired.length} superseded contracts`,
          `replaced in ${redeploys}${dates.length ? ` (${dates.join(", ")})` : ""} and kept in the record as history, ` +
            `not as current claims: ${retired.map((entry) => entry.hederaId).join(", ")}`,
        ),
      ]),
    );
  }

  return (await Promise.all(tasks)).flat();
}

async function checkDeployed(
  ctx: Context,
  title: string,
  entry: ContractEntry,
  requireSourcify: boolean,
): Promise<CheckResult> {
  const evidence = `${ctx.explorer}/contract/${entry.address}`;
  const contract = await ctx.mirror.contract(entry.address);
  if (!contract) return fail(title, `${entry.address} is not on the mirror node`, evidence);

  const problems: string[] = [];
  const facts: string[] = [];

  if (contract.contract_id !== entry.hederaId) {
    problems.push(`the mirror node calls it ${contract.contract_id}, the record says ${entry.hederaId}`);
  } else {
    facts.push(entry.hederaId);
  }
  if (contract.deleted) problems.push("deleted");

  const created = consensusSeconds(contract.created_timestamp);
  if (!(created >= ctx.windowStart)) {
    problems.push(`created ${utcMinute(created)}, before the event window opened ${utcMinute(ctx.windowStart)}`);
  } else {
    facts.push(`created ${utcMinute(created)}`);
  }

  if (entry.deployTx) {
    const deploy = await ctx.mirror.contractResult(entry.deployTx);
    if (!deploy) problems.push(`deploy tx ${short(entry.deployTx)} is not on the mirror node`);
    else if (!(deploy.created_contract_ids ?? []).includes(entry.hederaId)) {
      problems.push(`deploy tx ${short(entry.deployTx)} did not create ${entry.hederaId}`);
    } else {
      facts.push("created by the recorded tx");
    }
  }

  if (requireSourcify) {
    const match = await sourcifyMatch(ctx, entry.address);
    if (match !== "exact_match") problems.push(`Sourcify: ${match ?? "not verified"}`);
    else facts.push("Sourcify exact_match");
  }

  return problems.length > 0 ? fail(title, problems.join("; "), evidence) : pass(title, facts.join(" · "), evidence);
}

async function checkExisting(ctx: Context, title: string, address: string): Promise<CheckResult> {
  const contract = await ctx.mirror.contract(address);
  if (!contract) return fail(title, `${address} is not on the mirror node`);
  if (contract.deleted) return fail(title, `${contract.contract_id} is deleted`);
  return pass(
    title,
    `${contract.contract_id} · live, deployed by ATS ${utcMinute(consensusSeconds(contract.created_timestamp))}; not ours`,
    `${ctx.explorer}/contract/${address}`,
  );
}

export async function sourcifyMatch(ctx: Context, address: string): Promise<string | null> {
  const url = `${ctx.endpoints.sourcify}/v2/contract/${ctx.record.network.chainId}/${address}`;
  const response = await ctx.http(url);
  if (response.status === 404) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  if (!response.ok) throw new Error(`Sourcify returned HTTP ${response.status}`);
  const body = (await response.json()) as { match?: string | null };
  return body.match ?? null;
}
