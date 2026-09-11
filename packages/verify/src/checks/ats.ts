import {
  decodeFunctionData,
  decodeFunctionResult,
  encodeFunctionData,
  formatUnits,
  parseAbi,
  parseUnits,
  type Hex,
} from "viem";
import type { Context } from "../context.js";
import { type CheckResult, fail, guarded, pass, sameAddress, short, skip } from "../result.js";

/**
 * Check 3: the ATS note exists and its on-chain balances are what the record
 * says they are.
 *
 * The buyer's address appears nowhere in the record, so it is read out of the
 * record's own `transferByPartition` transaction on the mirror node, and the
 * issuer out of its `issueByPartition`. The expected figures are the record's
 * own statement of the result.
 */
export const ATS_ABI = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function transferByPartition(bytes32 partition, (address to, uint256 value) info, bytes data) returns (bytes32)",
  "function issueByPartition((bytes32 partition, address tokenHolder, uint256 value, bytes data) issueData)",
]);

/** Fixed decimals, so a balance reads as the record writes it: 9000.00, not 9000. */
function amount(value: bigint, decimals: number): string {
  const [whole, fraction = ""] = formatUnits(value, decimals).split(".");
  return decimals > 0 ? `${whole}.${fraction.padEnd(decimals, "0")}` : whole!;
}

export async function checkAts(ctx: Context): Promise<CheckResult[]> {
  const ats = ctx.record.ats;
  const note = ats?.issuedNote;
  if (!note) return [skip("ATS note", "the deployment record lists no issued ATS note")];

  const read = async <N extends "symbol" | "decimals" | "totalSupply" | "balanceOf">(
    functionName: N,
    args: readonly unknown[] = [],
  ) => {
    const data = encodeFunctionData({ abi: ATS_ABI, functionName, args } as never);
    const raw = await ctx.mirror.call(note.address, data);
    if (raw === null) throw new Error(`${functionName}() reverted on ${note.address}`);
    return decodeFunctionResult({ abi: ATS_ABI, functionName, data: raw as Hex } as never) as unknown;
  };

  const rows: CheckResult[] = [];
  const evidence = `${ctx.explorer}/contract/${note.address}`;

  rows.push(
    ...(await guarded("note answers as the record describes it", async () => {
      const symbol = (await read("symbol")) as string;
      const decimals = Number(await read("decimals"));
      const problems: string[] = [];
      if (symbol !== note.symbol) problems.push(`symbol ${JSON.stringify(symbol)}, record says ${note.symbol}`);
      if (decimals !== note.decimals) problems.push(`${decimals} decimals, record says ${note.decimals}`);
      return problems.length
        ? fail("note answers as the record describes it", problems.join("; "), evidence)
        : pass("note answers as the record describes it", `${symbol} · ${decimals} decimals · ${note.hederaId}`, evidence);
    })),
  );

  const lifecycle = ats?.lifecycle ?? [];
  const transferStep = lifecycle.find((step) => step.step.startsWith("transferByPartition"));
  const issueStep = lifecycle.find((step) => step.step.startsWith("issueByPartition"));
  const stated = parseStatedBalances(lifecycle.map((step) => step.result).find(Boolean));

  if (!transferStep || !issueStep || !stated) {
    rows.push(
      skip(
        "balances match the record",
        "the record states no issue, transfer or resulting balances to compare against",
      ),
    );
    return rows;
  }

  const holders = await guarded("holders read from the record's transactions", async () => {
    const issue = await decodeCall(ctx, issueStep.tx, "issueByPartition");
    const transfer = await decodeCall(ctx, transferStep.tx, "transferByPartition");
    const issued = (issue.args[0] as { tokenHolder: string }).tokenHolder;
    const buyer = (transfer.args[1] as { to: string }).to;
    return pass("holders read from the record's transactions", `issuer ${issued} · buyer ${buyer}`, JSON.stringify({ issued, buyer }));
  });
  const holderRow = holders[0]!;
  if (holderRow.status !== "pass") return [...rows, holderRow];
  const { issued, buyer } = JSON.parse(holderRow.evidence!) as { issued: string; buyer: string };

  const balanceRow = async (title: string, holder: string, expected: string) =>
    guarded(title, async () => {
      const actual = (await read("balanceOf", [holder])) as bigint;
      const want = parseUnits(expected, note.decimals);
      return actual === want
        ? pass(title, `${amount(actual, note.decimals)} · ${holder}`)
        : fail(title, `holds ${amount(actual, note.decimals)}, the record says ${expected} · ${holder}`);
    });

  const issuerNote = sameAddress(issued, ctx.record.deployer) ? "" : " (not the record's deployer)";
  rows.push(...(await balanceRow(`issuer holds ${stated.issuer}${issuerNote}`, issued, stated.issuer)));
  rows.push(...(await balanceRow(`buyer holds ${stated.buyer}`, buyer, stated.buyer)));

  const total = (parseUnits(stated.issuer, note.decimals) + parseUnits(stated.buyer, note.decimals)).toString();
  rows.push(
    ...(await guarded("nobody else holds any", async () => {
      const supply = (await read("totalSupply")) as bigint;
      return supply === BigInt(total)
        ? pass("nobody else holds any", `total supply ${amount(supply, note.decimals)} = issuer + buyer`)
        : fail(
            "nobody else holds any",
            `total supply ${amount(supply, note.decimals)}, but issuer + buyer is ${amount(BigInt(total), note.decimals)}`,
          );
    })),
  );

  const blocked = ctx.record.denial_artifact?.blockedCounterparty;
  if (blocked) {
    rows.push(...(await balanceRow("the blocked counterparty received nothing", blocked, "0")));
  }
  return rows;
}

async function decodeCall(ctx: Context, tx: string, functionName: "issueByPartition" | "transferByPartition") {
  const result = await ctx.mirror.contractResult(tx);
  if (!result) throw new Error(`${short(tx)} is not on the mirror node`);
  if (result.result !== "SUCCESS") throw new Error(`${short(tx)} ended ${result.result}`);
  const decoded = decodeFunctionData({ abi: ATS_ABI, data: result.function_parameters as Hex });
  if (decoded.functionName !== functionName) {
    throw new Error(`${short(tx)} called ${decoded.functionName}, not ${functionName}`);
  }
  return decoded;
}

/** The record states the outcome in prose: "issuer 9000.00, buyer 1000.00". */
export function parseStatedBalances(text: string | undefined): { issuer: string; buyer: string } | null {
  const match = text?.match(/issuer\s+([\d.]+)\s*,\s*buyer\s+([\d.]+)/i);
  return match ? { issuer: match[1]!, buyer: match[2]! } : null;
}
