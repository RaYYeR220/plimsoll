import type { Context } from "../context.js";
import { type CashLeg, type ContractEntry, supersededGenerations } from "../inputs.js";
import { describeMirrorKey } from "../protobufKey.js";
import { type CheckResult, fail, guarded, pass, skip } from "../result.js";

/**
 * Check 4: the HTS cash token's freeze key is a contract key naming our
 * controller, and there is no admin key that could ever rotate it away.
 *
 * That combination is what makes the circuit breaker hold with our server off:
 * only the controller's code can freeze, and nobody, including us, can change
 * who that is.
 */
export async function checkCashLeg(ctx: Context): Promise<CheckResult[]> {
  const leg = ctx.record.cash_leg;
  const controller = ctx.record.contracts.CashLegController;
  if (!leg || !controller) return [skip("HTS cash leg", "the deployment record lists no cash leg or controller")];

  const rows: CheckResult[] = [];
  const derived = longZeroId(leg.evmAddress);
  rows.push(
    derived === leg.hederaId
      ? pass("token id and EVM address agree", `${leg.evmAddress} is ${leg.hederaId}`)
      : fail("token id and EVM address agree", `${leg.evmAddress} is ${derived}, the record says ${leg.hederaId}`),
  );

  rows.push(...(await guarded("freeze key is the controller's contract key", () => keyRows(ctx, leg, controller))));

  for (const generation of supersededGenerations(ctx.record)) {
    const retired = generation.cash_leg;
    if (!retired || retired.hederaId === leg.hederaId) continue;
    rows.push(
      skip(
        `superseded cash token ${retired.hederaId}`,
        `replaced by ${leg.hederaId} and kept in the record as history, not as a current claim`,
      ),
    );
  }
  return rows;
}

async function keyRows(ctx: Context, leg: CashLeg, controller: ContractEntry): Promise<CheckResult[]> {
  const evidence = `${ctx.explorer}/token/${leg.hederaId}`;
  const freezeTitle = "freeze key is the controller's contract key";
  const token = await ctx.mirror.token(leg.hederaId);
  if (!token) return [fail(freezeTitle, `${leg.hederaId} is not on the mirror node`, evidence)];
  if (token.deleted) return [fail(freezeTitle, `${leg.hederaId} is deleted`, evidence)];

  const rows: CheckResult[] = [];
  const freeze = describeMirrorKey(token.freeze_key);
  const holder = leg.freezeKeyHolder ?? controller.hederaId;
  if (!freeze.present) {
    rows.push(fail(freezeTitle, "the token has no freeze key: the circuit breaker would be inert", evidence));
  } else if (!freeze.contract) {
    rows.push(fail(freezeTitle, `the freeze key is a ${freeze.type} key, not a contract key`, evidence));
  } else if (freeze.contract.id !== controller.hederaId || freeze.contract.id !== holder) {
    rows.push(
      fail(freezeTitle, `the freeze key names ${freeze.contract.id}; CashLegController is ${controller.hederaId}`, evidence),
    );
  } else {
    rows.push(
      pass(
        freezeTitle,
        `${token.symbol ?? "token"} ${leg.hederaId} · ${freeze.contract.kind} key naming ${freeze.contract.id}`,
        evidence,
      ),
    );
  }

  rows.push(
    token.admin_key === null || token.admin_key === undefined
      ? pass("no admin key", "the freeze key can never be rotated away", evidence)
      : fail("no admin key", "an admin key exists, so the freeze key could be replaced", evidence),
  );

  const supply = describeMirrorKey(token.supply_key);
  const treasuryOk = !leg.treasury || token.treasury_account_id === leg.treasury;
  const supplyOk = supply.contract?.id === controller.hederaId;
  rows.push(
    supplyOk && treasuryOk
      ? pass(
          "supply key and treasury are the controller too",
          `supply key names ${supply.contract!.id} · treasury ${token.treasury_account_id}`,
        )
      : fail(
          "supply key and treasury are the controller too",
          `supply key ${supply.contract?.id ?? supply.type ?? "absent"}, treasury ${token.treasury_account_id}; ` +
            `controller is ${controller.hederaId}`,
        ),
  );
  return rows;
}

/** A long-zero EVM address is the entity number in hex. */
export function longZeroId(evmAddress: string): string {
  return `0.0.${BigInt(evmAddress)}`;
}
