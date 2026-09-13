#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { getAddress, type Address } from "viem";
import { publicClientFor } from "./chain.js";
import { DEFAULT_RPC, HOLDER, type Market } from "./config.js";
import {
  dryRun,
  planDeposit,
  planWithdraw,
  renderPlan,
  renderStatus,
  status,
  type Context,
  type Plan,
} from "./commands.js";
import { formatDecimal } from "./liabilities.js";
import { impersonatedSender, run, RunAborted, signerFromEnv, type Sent } from "./tx.js";

const USAGE = `usage: plimsoll-backing <command> [options]

commands
  status                         positions, their USD value, and each note's coverage
  deposit                        approve and deposit the planned split (both notes)
    --market PLIM-B|PLIM-A       only this note's legs
    --vault <key>                one vault only (morpho, aave, spark, moonwell-eth)
    --amount <decimal>           with --vault: this amount instead of the planned one
    --all-balance                with --vault: everything the wallet holds of that asset
  withdraw --vault <key>         redeem from one vault
    --all | --shares <n> | --amount <decimal>

options
  --send                         actually send; without it everything is simulated
  --impersonate                  with --send: act as the holder on a local anvil fork, no key
  --rpc <url>                    Base endpoint (default $BASE_RPC_URL or ${DEFAULT_RPC})
  --holder <address>             default ${HOLDER}
  --notes <path>                 notes file (default ../substreams/notes.json)
  --json                         machine-readable output

Sending signs with HOLDER_PRIVATE_KEY, or HEDERA_PRIVATE_KEY, from the environment.
The key must derive to the holder address or nothing is sent.`;

function defaultNotesPath(): string {
  return fileURLToPath(new URL("../../../substreams/notes.json", import.meta.url));
}

function json(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
}

export async function main(argv = process.argv.slice(2), env = process.env): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      market: { type: "string" },
      vault: { type: "string" },
      amount: { type: "string" },
      shares: { type: "string" },
      all: { type: "boolean" },
      "all-balance": { type: "boolean" },
      send: { type: "boolean" },
      impersonate: { type: "boolean" },
      rpc: { type: "string" },
      holder: { type: "string" },
      notes: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const command = positionals[0];
  if (values.help || !command) {
    console.log(USAGE);
    return command ? 0 : 1;
  }

  const rpc = values.rpc ?? env.BASE_RPC_URL ?? DEFAULT_RPC;
  const ctx: Context = {
    client: publicClientFor(rpc),
    rpcLabel: new URL(rpc).host,
    holder: getAddress(values.holder ?? HOLDER) as Address,
    notesPath: values.notes ?? defaultNotesPath(),
  };

  if (command === "status") {
    const report = await status(ctx);
    console.log(values.json ? json(report) : renderStatus(report));
    return 0;
  }

  let plan: Plan;
  if (command === "deposit") {
    const market = values.market as Market | undefined;
    if (market && market !== "PLIM-B" && market !== "PLIM-A") throw new Error(`unknown market ${market}`);
    plan = await planDeposit(ctx, {
      market,
      vault: values.vault,
      amount: values.amount,
      allBalance: values["all-balance"],
      forSend: values.send,
    });
  } else if (command === "withdraw") {
    if (!values.vault) throw new Error("withdraw needs --vault");
    plan = await planWithdraw(ctx, {
      vault: values.vault,
      all: values.all,
      shares: values.shares,
      amount: values.amount,
      forSend: values.send,
    });
  } else {
    console.error(USAGE);
    return 1;
  }

  if (!values.send) {
    const simulated = plan.steps.length > 0 ? await dryRun(ctx, plan) : null;
    console.log(values.json ? json({ plan, simulated }) : renderPlan(plan, simulated));
    if (!values.json) console.log("\nDRY RUN: nothing was sent. Add --send to send.");
    return simulated && simulated.simulations.some((s) => !s.ok) ? 2 : 0;
  }

  if (plan.steps.length === 0) {
    console.log(renderPlan(plan, null));
    return 0;
  }
  const sender = values.impersonate
    ? await impersonatedSender(ctx.client, ctx.holder, rpc)
    : signerFromEnv(env, ctx.holder, rpc);
  console.log(renderPlan(plan, null));
  console.log(`\nsending ${plan.steps.length} transaction(s) as ${sender.address}, ${sender.how}`);
  let sent: Sent[];
  try {
    sent = await run(ctx.client, sender, plan.steps);
  } catch (error) {
    if (error instanceof RunAborted) {
      for (const s of error.sent) console.log(`  ${s.status}  ${s.label}\n           ${s.link}`);
    }
    throw error;
  }
  for (const s of sent) console.log(`  ${s.status}  ${s.label}  (gas ${s.gasUsed})\n           ${s.link}`);
  if (values.json) console.log(json(sent));
  const total = sent.reduce((sum, s) => sum + s.gasUsed, 0n);
  console.log(`done: ${sent.length} transaction(s), ${total} gas; wallet ETH before ${formatDecimal(plan.holdings.wallet.eth, 18)}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (error: Error) => {
      console.error(`error: ${error.message}`);
      process.exit(1);
    },
  );
}
