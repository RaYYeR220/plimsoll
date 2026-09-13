import { encodeFunctionData, type Address, type PublicClient } from "viem";
import { ERC20_ABI, VAULT_ABI, WETH_ABI, l1FeeUpperBound, pin, readAt } from "./chain.js";
import {
  CONTROL_FIRST,
  ETH_GAS_RESERVE,
  PLAN,
  PLANNED_FUNDING_USDC,
  REGISTRY,
  TOKENS,
  VAULTS,
  vaultByKey,
  type Market,
  type RegistryRef,
} from "./config.js";
import {
  decimalToUnits,
  formatDecimal,
  loadNotes,
  plannedLiabilities,
  readLiabilities,
  vaultSetHash,
  type Liabilities,
} from "./liabilities.js";
import { PlanError, plannedTotal, resolveLegs, type Leg } from "./plan.js";
import { coverageBps, readHoldings, usdMicro, type Holdings, type Position } from "./positions.js";
import { simulate, type Simulation, type Step } from "./tx.js";

export interface Context {
  readonly client: PublicClient;
  /** Published name of the endpoint, for output. */
  readonly rpcLabel: string;
  readonly holder: Address;
  readonly notesPath: string;
  /**
   * Where to read each note's own figures. Defaults to the deployment in
   * `config.ts`; pass `{}` to stay off the note's chain and use the plan.
   */
  readonly registries?: Partial<Record<Market, RegistryRef>>;
  /**
   * How far behind the head to read. Two blocks on a live chain, so a block
   * about to be reorganised is never reported; zero on a fork, which only has
   * as many blocks as transactions sent.
   */
  readonly confirmations?: bigint;
  readonly fetch?: typeof fetch;
}

const MARKETS: readonly Market[] = ["PLIM-B", "PLIM-A"];

// ---------------------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------------------

export interface NoteStatus {
  readonly market: Market;
  readonly positions: readonly Position[];
  readonly backingMicro: bigint;
  readonly liabilities: Liabilities | null;
  readonly liabilitiesError: string | null;
  readonly coverageBps: number | null;
  readonly vaults: readonly string[];
  readonly vaultSetHash: string;
  /** The notes file's vault list for this market, when it has one. */
  readonly notesFileVaults: readonly string[] | null;
}

export interface StatusReport {
  readonly holdings: Holdings;
  readonly rpcLabel: string;
  readonly notes: readonly NoteStatus[];
}

export async function status(ctx: Context): Promise<StatusReport> {
  const holdings = await readHoldings(ctx.client, ctx.holder, await pin(ctx.client, ctx.confirmations ?? 2n));
  const notesFile = loadNotes(ctx.notesPath);
  const notes = await Promise.all(
    MARKETS.map(async (market): Promise<NoteStatus> => {
      const positions = holdings.positions.filter((p) => p.vault.market === market);
      const backingMicro = positions.reduce((sum, p) => sum + p.usdMicro, 0n);
      const entry = notesFile.get(market);
      const registry = entry?.registry ?? (ctx.registries ?? REGISTRY)[market];
      let liabilities: Liabilities | null = null;
      let liabilitiesError: string | null = null;
      if (registry) {
        try {
          liabilities = await readLiabilities(market, registry, ctx.fetch);
        } catch (error) {
          // The plan is a fallback for a status line, never for a verdict.
          liabilitiesError = (error as Error).message;
          liabilities = plannedLiabilities(market);
        }
      } else {
        liabilities = plannedLiabilities(market);
      }
      const vaults = VAULTS.filter((v) => v.market === market).map((v) => v.address.toLowerCase()).sort();
      return {
        market,
        positions,
        backingMicro,
        liabilities,
        liabilitiesError,
        coverageBps: liabilities ? coverageBps(backingMicro, liabilities.obligationMicro) : null,
        vaults,
        vaultSetHash: vaultSetHash(vaults),
        notesFileVaults: entry ? [...entry.vaults].map((v) => v.toLowerCase()).sort() : null,
      };
    }),
  );
  return { holdings, rpcLabel: ctx.rpcLabel, notes };
}

const usd = (micro: bigint) => `$${formatDecimal(micro, 6)}`;
const pct = (bps: number) => `${(bps / 100).toFixed(2)}%`;

export function renderStatus(r: StatusReport): string {
  const h = r.holdings;
  const lines = [
    `Base block ${h.block.number} ${h.block.hash} (${new Date(h.block.timestamp * 1000).toISOString()}) via ${r.rpcLabel}`,
    `holder ${h.holder}`,
    `  wallet  ${formatDecimal(h.wallet.eth, 18)} ETH   ${formatDecimal(h.wallet.usdc, 6)} USDC   ${formatDecimal(h.wallet.weth, 18)} WETH`,
    `  ETH/USD ${formatDecimal(h.ethUsd.answer, h.ethUsd.decimals)} (Chainlink, updated ${h.block.timestamp - h.ethUsd.updatedAt}s before this block)`,
  ];
  for (const n of r.notes) {
    lines.push("", `${n.market}   vault set ${n.vaultSetHash}`);
    if (n.notesFileVaults === null) lines.push("  notes file: no entry for this market yet");
    else if (n.notesFileVaults.join() !== n.vaults.join()) {
      lines.push(`  notes file: DIFFERENT vault list (${n.notesFileVaults.length} vaults, hash ${vaultSetHash(n.notesFileVaults)})`);
    } else lines.push("  notes file: same vault list");
    for (const p of n.positions) {
      const t = TOKENS[p.vault.asset];
      lines.push(
        `  ${p.vault.key.padEnd(13)} ${p.vault.name.padEnd(26)} ${formatDecimal(p.assets, t.decimals).padStart(24)} ${t.symbol.padEnd(4)} ${usd(p.usdMicro).padStart(12)}   ${p.vault.address}`,
      );
    }
    lines.push(`  backing     ${usd(n.backingMicro)}`);
    if (n.liabilitiesError) {
      lines.push(`  liabilities UNREADABLE: ${n.liabilitiesError}`);
    } else if (n.liabilities) {
      const l = n.liabilities;
      const where = l.source === "hedera" ? `Hedera block ${l.block}, issuer ${l.issuer}` : "PLANNED, not read from any chain";
      lines.push(`  obligation  ${usd(l.obligationMicro)} = ${l.notes} notes x ${l.parUsd} USD (${where})`);
      lines.push(
        `  coverage    ${pct(n.coverageBps!)} against a ${pct(l.thresholdBps)} line: ${n.coverageBps! >= l.thresholdBps ? "CLEAR" : "BELOW THE LINE"}`,
      );
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------
// deposit / withdraw planning
// ---------------------------------------------------------------------------------------

export interface Plan {
  readonly holdings: Holdings;
  readonly steps: readonly Step[];
  /** Anything the operator should read before sending. */
  readonly notes: readonly string[];
}

export interface DepositOptions {
  market?: Market;
  vault?: string;
  amount?: string;
  allBalance?: boolean;
  /** Planning for a real send: shortfalls are errors, not simulation assumptions. */
  forSend?: boolean;
}

export async function planDeposit(ctx: Context, options: DepositOptions): Promise<Plan> {
  // A decision to send is made against the newest state, so a deposit that
  // landed a moment ago cannot look unfunded and be paid for twice.
  const confirmations = options.forSend ? 0n : (ctx.confirmations ?? 2n);
  const holdings = await readHoldings(ctx.client, ctx.holder, await pin(ctx.client, confirmations));
  const notes: string[] = [];
  const legs: Leg[] = [];

  if (options.vault) {
    const vault = vaultByKey(options.vault);
    const token = TOKENS[vault.asset];
    const held = vault.asset === "USDC" ? holdings.wallet.usdc : holdings.wallet.weth;
    let amount: bigint;
    if (options.amount) amount = decimalToUnits(options.amount, token.decimals);
    else if (options.allBalance) amount = held;
    else {
      const leg = PLAN[vault.market].find((l) => l.vault === vault.key);
      if (!leg || leg.amount === "rest") throw new PlanError(`give --amount or --all-balance for ${vault.key}`);
      amount = decimalToUnits(leg.amount, token.decimals);
    }
    if (amount <= 0n) throw new PlanError(`nothing to deposit into ${vault.key}: the wallet holds 0 ${token.symbol}`);
    legs.push({ vault, amount });
  } else {
    // The control's dollar is taken off the top, so the note that has to clear
    // a line is never sized out of money the control needs.
    const markets = options.market ? [options.market] : CONTROL_FIRST;
    const fundedIn = (market: Market) =>
      new Set(holdings.positions.filter((p) => p.vault.market === market && p.shares > 0n).map((p) => p.vault.key));
    const remaining = markets.filter((m) => fundedIn(m).size < PLAN[m].length);
    if (remaining.length === 0) {
      throw new PlanError(
        `every leg of ${markets.join(" and ")} already has a position; use --vault to add to one of them`,
      );
    }
    const resuming = markets.some((m) => fundedIn(m).size > 0);

    let budget = holdings.wallet.usdc;
    const assumed = decimalToUnits(PLANNED_FUNDING_USDC, TOKENS.USDC.decimals);
    // Only a plan that has not started is simulated against money not yet in
    // the wallet; a resumed plan is sized against what is actually there.
    if (!resuming && budget < assumed && !options.forSend) {
      notes.push(
        `the wallet holds ${formatDecimal(budget, 6)} USDC; simulating against the planned ${PLANNED_FUNDING_USDC} USDC instead`,
      );
      budget = assumed;
    }
    for (const market of remaining) {
      const funded = fundedIn(market);
      if (funded.size > 0) {
        notes.push(`${market}: resuming; ${[...funded].join(", ")} already funded and left as they are`);
      }
      const resolved = resolveLegs(market, budget, funded);
      const spent = resolved.legs.reduce((sum, l) => sum + l.amount, 0n);
      budget -= spent;
      if (resolved.idle > 0n && PLAN[market].some((l) => l.amount === "rest")) {
        notes.push(
          `${market}: ${formatDecimal(resolved.idle, 6)} USDC stays in the wallet so the named position stays decisive`,
        );
      }
      legs.push(...resolved.legs);
    }
  }

  const steps: Step[] = [];
  let wethHeld = holdings.wallet.weth;
  for (const { vault, amount } of legs) {
    const token = TOKENS[vault.asset];
    if (vault.asset === "WETH" && wethHeld < amount) {
      const wrap = amount - wethHeld;
      const reserve = decimalToUnits(ETH_GAS_RESERVE, 18);
      if (options.forSend && holdings.wallet.eth < wrap + reserve) {
        throw new PlanError(
          `wrapping ${formatDecimal(wrap, 18)} ETH would leave less than the ${ETH_GAS_RESERVE} ETH gas reserve (wallet holds ${formatDecimal(holdings.wallet.eth, 18)})`,
        );
      }
      steps.push({
        label: `wrap ${formatDecimal(wrap, 18)} ETH into WETH`,
        to: TOKENS.WETH.address,
        data: encodeFunctionData({ abi: WETH_ABI, functionName: "deposit" }),
        value: wrap,
        needs: {},
      });
      wethHeld += wrap;
    }
    const allowance = await readAt<bigint>(ctx.client, holdings.block, token.address, ERC20_ABI, "allowance", [
      ctx.holder,
      vault.address,
    ]);
    if (allowance < amount) {
      steps.push({
        label: `approve ${vault.key} for exactly ${formatDecimal(amount, token.decimals)} ${token.symbol}`,
        to: token.address,
        data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [vault.address, amount] }),
        value: 0n,
        needs: {},
      });
    }
    steps.push({
      label: `deposit ${formatDecimal(amount, token.decimals)} ${token.symbol} into ${vault.key} (${vault.name})`,
      to: vault.address,
      data: encodeFunctionData({ abi: VAULT_ABI, functionName: "deposit", args: [amount, ctx.holder] }),
      value: 0n,
      needs: { token, balance: amount, spender: vault.address, allowance: amount },
    });
  }
  return { holdings, steps, notes };
}

export interface WithdrawOptions {
  vault: string;
  all?: boolean;
  shares?: string;
  amount?: string;
  /** Planning for a real send: read the newest block, so `--all` really is all. */
  forSend?: boolean;
}

export async function planWithdraw(ctx: Context, options: WithdrawOptions): Promise<Plan> {
  const confirmations = options.forSend ? 0n : (ctx.confirmations ?? 2n);
  const holdings = await readHoldings(ctx.client, ctx.holder, await pin(ctx.client, confirmations));
  const vault = vaultByKey(options.vault);
  const token = TOKENS[vault.asset];
  const position = holdings.positions.find((p) => p.vault.key === vault.key)!;
  const chosen = [options.all, options.shares !== undefined, options.amount !== undefined].filter(Boolean).length;
  if (chosen !== 1) throw new PlanError("withdraw needs exactly one of --all, --shares or --amount");
  if (position.shares === 0n) {
    return { holdings, steps: [], notes: [`the holder has no shares in ${vault.key}; there is nothing to redeem`] };
  }

  if (options.amount !== undefined) {
    const assets = decimalToUnits(options.amount, token.decimals);
    return {
      holdings,
      notes: [],
      steps: [
        {
          label: `withdraw ${options.amount} ${token.symbol} from ${vault.key} (${vault.name})`,
          to: vault.address,
          data: encodeFunctionData({ abi: VAULT_ABI, functionName: "withdraw", args: [assets, ctx.holder, ctx.holder] }),
          value: 0n,
          needs: {},
        },
      ],
    };
  }

  // Redeeming the exact share balance, not maxRedeem: MetaMorpho reports a
  // maxRedeem a few wei of shares under the balance, and redeeming the balance
  // itself succeeds. The simulation below is what decides.
  const shares = options.all ? position.shares : BigInt(options.shares!);
  if (shares > position.shares) throw new PlanError(`${vault.key}: holder has ${position.shares} shares, not ${shares}`);
  const preview = await readAt<bigint>(ctx.client, holdings.block, vault.address, VAULT_ABI, "previewRedeem", [shares]);
  return {
    holdings,
    notes: [],
    steps: [
      {
        label: `redeem ${shares === position.shares ? "all " : ""}${shares} shares of ${vault.key} (${vault.name}) for about ${formatDecimal(preview, token.decimals)} ${token.symbol}`,
        to: vault.address,
        data: encodeFunctionData({ abi: VAULT_ABI, functionName: "redeem", args: [shares, ctx.holder, ctx.holder] }),
        value: 0n,
        needs: {},
      },
    ],
  };
}

// ---------------------------------------------------------------------------------------
// dry run
// ---------------------------------------------------------------------------------------

export interface DryRun {
  readonly simulations: readonly Simulation[];
  readonly gasPrice: bigint;
  readonly l1FeeWei: bigint;
  readonly feeWei: bigint;
  readonly feeUsdMicro: bigint;
}

export async function dryRun(ctx: Context, plan: Plan): Promise<DryRun> {
  const simulations: Simulation[] = [];
  for (const step of plan.steps) simulations.push(await simulate(ctx.client, ctx.holder, step));
  const gasPrice = await ctx.client.getGasPrice();
  let l1FeeWei = 0n;
  for (const step of plan.steps) l1FeeWei += await l1FeeUpperBound(ctx.client, 120 + (step.data.length - 2) / 2);
  const l2 = simulations.reduce((sum, s) => sum + (s.gas ?? 0n), 0n) * gasPrice;
  const feeWei = l2 + l1FeeWei;
  return { simulations, gasPrice, l1FeeWei, feeWei, feeUsdMicro: usdMicro("WETH", feeWei, plan.holdings.ethUsd) };
}

export function renderPlan(plan: Plan, run: DryRun | null): string {
  const lines = [`planned at Base block ${plan.holdings.block.number} for ${plan.holdings.holder}`];
  for (const note of plan.notes) lines.push(`  note: ${note}`);
  plan.steps.forEach((step, i) => {
    const sim = run?.simulations[i];
    const verdict = !sim ? "" : sim.ok ? `ok, ~${sim.gas} gas` : `WOULD FAIL: ${sim.error}`;
    lines.push(`  ${i + 1}. ${step.label}${verdict ? `  [${verdict}]` : ""}`);
    if (sim && sim.assumed.length > 0) lines.push(`       simulated assuming ${sim.assumed.join("; ")}`);
  });
  if (run) {
    lines.push(
      `  estimated cost: ${formatDecimal(run.feeWei, 18)} ETH (~$${formatDecimal(run.feeUsdMicro, 6)}) at ${run.gasPrice} wei/gas, L1 data fee bound included`,
    );
  }
  return lines.join("\n");
}
