import { toFunctionSelector } from "viem";
import type { Context } from "../context.js";
import { type CheckResult, fail, pass, sameAddress, short, skip } from "../result.js";

/**
 * Check 2: the hero denial.
 *
 * A transfer to a blacklisted counterparty must have been refused by the ATS
 * note on-chain, and the revert bytes must name exactly the counterparty the
 * record says was blocked. The error is identified by its selector, not by the
 * record's description of it: `0x796c1f0d` is `AccountIsBlocked(address)`, the
 * one-argument form.
 */
export const ACCOUNT_IS_BLOCKED = "AccountIsBlocked(address)";

export async function checkDenial(ctx: Context): Promise<CheckResult[]> {
  const denial = ctx.record.denial_artifact;
  if (!denial) return [skip("hero denial", "the deployment record has no denial_artifact")];

  const evidence = `${ctx.explorer}/transaction/${denial.tx}`;
  const result = await ctx.mirror.contractResult(denial.tx);
  if (!result) {
    return [fail("denial transaction", `${short(denial.tx)} is not on the mirror node`, evidence)];
  }

  const rows: CheckResult[] = [];

  rows.push(
    result.result === "CONTRACT_REVERT_EXECUTED"
      ? pass("refused on-chain", `${short(denial.tx)} · CONTRACT_REVERT_EXECUTED · gas ${result.gas_used}`, evidence)
      : fail("refused on-chain", `${short(denial.tx)} ended ${result.result}, not CONTRACT_REVERT_EXECUTED`, evidence),
  );

  const decoded = decodeAccountIsBlocked(result.error_message);
  if (!decoded.ok) {
    rows.push(fail("revert names the blocked counterparty", decoded.reason));
  } else if (!sameAddress(decoded.account, denial.blockedCounterparty)) {
    rows.push(
      fail(
        "revert names the blocked counterparty",
        `revert names ${decoded.account}, the record's blocked counterparty is ${denial.blockedCounterparty}`,
      ),
    );
  } else {
    rows.push(pass("revert names the blocked counterparty", `AccountIsBlocked(${decoded.account})`));
  }

  const note = ctx.record.ats?.issuedNote;
  rows.push(
    note && sameAddress(result.to, note.address)
      ? pass("refused by the PLIM-A note itself", `sent to ${note.address} (${note.hederaId})`)
      : fail(
          "refused by the PLIM-A note itself",
          `sent to ${result.to}, not the issued note ${note?.address ?? "(none in the record)"}`,
        ),
  );

  return rows;
}

export function decodeAccountIsBlocked(
  errorMessage: string | null | undefined,
): { ok: true; account: string } | { ok: false; reason: string } {
  const hex = (errorMessage ?? "").toLowerCase();
  if (!hex.startsWith("0x") || hex.length < 10) return { ok: false, reason: "the transaction carries no revert data" };
  const selector = hex.slice(0, 10);
  const expected = toFunctionSelector(ACCOUNT_IS_BLOCKED);
  if (selector !== expected) {
    return { ok: false, reason: `revert selector ${selector} is not ${ACCOUNT_IS_BLOCKED} (${expected})` };
  }
  if (hex.length !== 10 + 64) return { ok: false, reason: "revert data is not one ABI-encoded address" };
  const word = hex.slice(10);
  if (!/^0{24}/.test(word)) return { ok: false, reason: "revert argument is not a left-padded address" };
  return { ok: true, account: `0x${word.slice(24)}` };
}
