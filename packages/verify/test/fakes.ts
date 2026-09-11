import { encodeFunctionData, encodeFunctionResult, pad } from "viem";
import type { VerifyChargeFn } from "../src/attestor.js";
import { ATS_ABI } from "../src/checks/ats.js";
import type { Context } from "../src/context.js";
import type { Endpoints } from "../src/http.js";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Inputs, REPO_ROOT, loadInputs } from "../src/inputs.js";
import {
  type Json,
  type MirrorApi,
  type MirrorTransaction,
  type TopicMessage,
  toMirrorTransactionId,
} from "../src/mirror.js";
import { encodeContractKey } from "../src/protobufKey.js";
import { consensusSeconds } from "../src/result.js";

/**
 * An offline stand-in for every public endpoint, populated from the real
 * deployment record, manifest and device proof. The shapes mirror what the
 * public services actually return, captured while building this package.
 */

export const ENDPOINTS: Endpoints = {
  mirror: "http://mirror.test",
  sourcify: "http://sourcify.test/server",
  github: "http://github.test",
  substreams: "http://substreams.test",
};

/** `function_parameters` of the record's transferByPartition, as the mirror node returns it. */
export const REAL_TRANSFER_PARAMETERS =
  "0x3bc9bcd8000000000000000000000000000000000000000000000000000000000000000100000000000000000000000" +
  "03f65df74deb47ec8519d76da54f201dab655f0c300000000000000000000000000000000000000000000000000000000" +
  "000186a000000000000000000000000000000000000000000000000000000000000000800000000000000000000000000" +
  "000000000000000000000000000000000000000";

/** Decoded from the transaction above; the verifier itself never hardcodes it. */
export const BUYER = "0x3f65df74deb47ec8519d76da54f201dab655f0c3";

export const IN_WINDOW = "1789122031.608614105";
export const BEFORE_WINDOW = "1781261489.302579001";

/**
 * A frozen, mutually consistent record and device proof, taken from git. The
 * live files are rewritten whenever the stack is redeployed or the Ledger
 * sequence re-run, and a unit test that broke on that would be testing the
 * calendar rather than the verifier. The live suite checks the current files.
 */
export const FIXTURE_RECORD = fileURLToPath(
  new URL("../../test/fixtures/contracts/deployments/hedera-testnet.json", import.meta.url),
);

export const FIXTURE_MANIFEST = fileURLToPath(new URL("../../test/fixtures/manifest.json", import.meta.url));

export function realInputs(): Inputs {
  return structuredClone(
    loadInputs({ recordPath: FIXTURE_RECORD, manifestPath: FIXTURE_MANIFEST, contractsSource: join(REPO_ROOT, "packages", "contracts", "src") }),
  );
}

export class FakeMirror implements MirrorApi {
  contracts = new Map<string, Json>();
  results = new Map<string, Json>();
  tokens = new Map<string, Json>();
  calls = new Map<string, string>();
  transactions = new Map<string, MirrorTransaction>();
  transfers: MirrorTransaction[] = [];
  topic = new Map<number, TopicMessage>();
  asked: string[] = [];

  addContract(address: string, id: string, created: string): Json {
    const contract = { contract_id: id, evm_address: address.toLowerCase(), created_timestamp: created, deleted: false };
    this.contracts.set(address.toLowerCase(), contract);
    this.contracts.set(id, contract);
    return contract;
  }

  async contract(idOrAddress: string) {
    this.asked.push(idOrAddress.toLowerCase());
    return this.contracts.get(idOrAddress.toLowerCase()) ?? this.contracts.get(idOrAddress) ?? null;
  }
  async contractResult(hash: string) {
    return this.results.get(hash.toLowerCase()) ?? null;
  }
  async token(id: string) {
    return this.tokens.get(id) ?? null;
  }
  async call(to: string, data: string) {
    return this.calls.get(`${to.toLowerCase()}|${data.toLowerCase()}`) ?? null;
  }
  async transaction(id: string) {
    return this.transactions.get(toMirrorTransactionId(id)) ?? null;
  }
  async transfersInvolving(account: string, from: number, to: number) {
    return this.transfers.filter((tx) => {
      const at = consensusSeconds(tx.consensus_timestamp);
      return at >= from && at <= to && tx.transfers.some((transfer) => transfer.account === account);
    });
  }
  async topicMessage(_topic: string, sequence: number) {
    return this.topic.get(sequence) ?? null;
  }
  async topicMessages(_topic: string, limit: number) {
    return [...this.topic.values()].sort((a, b) => b.sequence_number - a.sequence_number).slice(0, limit);
  }
}

export interface World {
  mirror: FakeMirror;
  /** Addresses Sourcify reports as exact matches. */
  verified: Set<string>;
  github: { status: number; body: Json; headers?: Record<string, string> } | "unreachable";
  substreams: number | "unreachable";
}

export const SELLER = "0.0.10448897";
export const PAYER = "0.0.10451088";
export const FACILITATOR = "0.0.7162784";

function atsCall(mirror: FakeMirror, note: string, functionName: string, args: readonly unknown[], result: unknown) {
  const data = encodeFunctionData({ abi: ATS_ABI, functionName, args } as never);
  mirror.calls.set(`${note.toLowerCase()}|${data.toLowerCase()}`, encodeFunctionResult({ abi: ATS_ABI, functionName, result } as never));
}

export function encodeTopicMessage(sequence: number, consensus: string, record: Json): TopicMessage {
  return {
    sequence_number: sequence,
    consensus_timestamp: consensus,
    message: Buffer.from(JSON.stringify(record), "utf8").toString("base64"),
    chunk_info: null,
  };
}

export function paymentTransaction(id: string, consensus: string, amount = 100_000): MirrorTransaction {
  return {
    transaction_id: toMirrorTransactionId(id),
    name: "CRYPTOTRANSFER",
    result: "SUCCESS",
    consensus_timestamp: consensus,
    transfers: [
      { account: "0.0.802", amount: 261_483 },
      { account: FACILITATOR, amount: -261_483 },
      { account: SELLER, amount },
      { account: PAYER, amount: -amount },
    ],
  };
}

export function buildWorld(inputs: Inputs): World {
  const mirror = new FakeMirror();
  const verified = new Set<string>();
  const record = inputs.record;

  for (const entry of Object.values(record.contracts)) {
    mirror.addContract(entry.address, entry.hederaId, IN_WINDOW);
    if (entry.deployTx) mirror.results.set(entry.deployTx.toLowerCase(), { result: "SUCCESS", created_contract_ids: [entry.hederaId] });
    verified.add(entry.address.toLowerCase());
  }

  const ats = record.ats!;
  const note = ats.issuedNote!;
  mirror.addContract(note.address, note.hederaId, "1789005777.060651105");
  if (note.deployBondTx) {
    mirror.results.set(note.deployBondTx.toLowerCase(), { result: "SUCCESS", created_contract_ids: [note.hederaId] });
  }
  mirror.addContract(ats.businessLogicResolver!, "0.0.9212226", BEFORE_WINDOW);
  mirror.addContract(ats.factory!, "0.0.9213391", BEFORE_WINDOW);

  const denial = record.denial_artifact!;
  mirror.results.set(denial.tx.toLowerCase(), {
    result: "CONTRACT_REVERT_EXECUTED",
    error_message: denial.revertData,
    to: note.address.toLowerCase(),
    gas_used: 74737,
  });

  atsCall(mirror, note.address, "symbol", [], note.symbol);
  atsCall(mirror, note.address, "decimals", [], note.decimals);
  atsCall(mirror, note.address, "totalSupply", [], 1_000_000n);
  atsCall(mirror, note.address, "balanceOf", [record.deployer], 900_000n);
  atsCall(mirror, note.address, "balanceOf", [BUYER], 100_000n);
  atsCall(mirror, note.address, "balanceOf", [denial.blockedCounterparty], 0n);

  const transfer = ats.lifecycle!.find((step) => step.step.startsWith("transferByPartition"))!;
  const issue = ats.lifecycle!.find((step) => step.step.startsWith("issueByPartition"))!;
  mirror.results.set(transfer.tx.toLowerCase(), {
    result: "SUCCESS",
    to: note.address.toLowerCase(),
    function_parameters: REAL_TRANSFER_PARAMETERS,
  });
  mirror.results.set(issue.tx.toLowerCase(), {
    result: "SUCCESS",
    to: note.address.toLowerCase(),
    function_parameters: encodeFunctionData({
      abi: ATS_ABI,
      functionName: "issueByPartition",
      args: [{ partition: pad("0x01"), tokenHolder: record.deployer as `0x${string}`, value: 1_000_000n, data: "0x" }],
    }),
  });

  const leg = record.cash_leg!;
  const controller = record.contracts.CashLegController!;
  const controllerKey = { _type: "ProtobufEncoded", key: encodeContractKey(BigInt(controller.hederaId.split(".")[2]!)) };
  mirror.tokens.set(leg.hederaId, {
    token_id: leg.hederaId,
    symbol: "PCASH",
    deleted: false,
    admin_key: null,
    freeze_key: controllerKey,
    supply_key: controllerKey,
    treasury_account_id: controller.hederaId,
  });

  const attestor = record.roles.attestor!;
  const common = { p: "plimsoll/coverage", v: 2, att: attestor, sig: `0x${"ab".repeat(65)}` };
  const evidenceBlock = {
    floor: 10000,
    blk: "21480311",
    obs: 1789121880,
    ud: 6,
    out: "250000",
    par: "1000000",
    obl: "250000000000",
    ss: "fixture:plimsoll-vault-flows-v0.3.1",
    vsh: "8cb16b9aa2a77c15",
    srch: `0x${"11".repeat(32)}`,
    full: 1,
  };
  for (const expected of inputs.manifest.hcs.records) {
    if (expected.expect === "attested") {
      const consensus = "1789121905.100000000";
      mirror.topic.set(
        expected.sequence,
        encodeTopicMessage(expected.sequence, consensus, {
          ...common, rid: "72f6867901036332", n: expected.noteId, d: "attested", pol: "plimsoll-coverage-1.0.0",
          chg: true, tx: expected.payment, bps: 13000, val: "325000000000", ...evidenceBlock,
        }),
      );
      const payment = paymentTransaction(expected.payment!, "1789121904.500000000");
      mirror.transactions.set(payment.transaction_id, payment);
      mirror.transfers.push(payment);
    } else if (expected.expect === "asset-refusal") {
      mirror.topic.set(
        expected.sequence,
        encodeTopicMessage(expected.sequence, "1789121912.100000000", {
          ...common, rid: "d318e8197294ba06", n: expected.noteId, d: "refused", pol: "plimsoll-coverage-1.0.0",
          chg: false, fam: "asset", rsn: expected.reason, known: true, bps: 8700, val: "217500000000", ...evidenceBlock,
        }),
      );
    } else {
      mirror.topic.set(
        expected.sequence,
        encodeTopicMessage(expected.sequence, "1789121918.100000000", {
          ...common, rid: "211870a75dac6d91", n: expected.noteId, d: "refused", pol: "unknown",
          chg: false, fam: "evidence", rsn: expected.reason, known: false,
        }),
      );
    }
  }

  for (const step of inputs.deviceProof?.steps ?? []) {
    if (!step.tx) continue;
    const target = record.contracts[step.call!.split(".")[0]!]!;
    mirror.results.set(step.tx.toLowerCase(), {
      result: step.mirror,
      to: target.address.toLowerCase(),
      error_message: step.revertData ?? "0x",
    });
  }

  return {
    mirror,
    verified,
    github: {
      status: 200,
      body: {
        state: "open",
        merged_at: null,
        title: "fix: run the harness on Windows",
        html_url: "https://github.com/hedera-dev/hedera-harness/pull/55",
        user: { login: "RaYYeR220" },
        base: { ref: "dev" },
        additions: 330,
        deletions: 51,
        changed_files: 18,
      },
    },
    substreams: 404,
  };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export function fakeHttp(world: World): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.host === "sourcify.test") {
      const address = url.pathname.split("/").pop()!.toLowerCase();
      return world.verified.has(address) ? json(200, { match: "exact_match" }) : json(404, { match: null });
    }
    if (url.host === "github.test") {
      if (world.github === "unreachable") throw new TypeError("fetch failed");
      return json(world.github.status, world.github.body, world.github.headers);
    }
    if (url.host === "substreams.test") {
      if (world.substreams === "unreachable") throw new TypeError("fetch failed");
      return new Response("", { status: world.substreams });
    }
    throw new Error(`unexpected request to ${url}`);
  }) as typeof fetch;
}

export function stubVerifyCharge(inputs: Inputs, override: Record<number, string> = {}): VerifyChargeFn {
  const expected = new Map(inputs.manifest.hcs.records.map((r) => [r.sequence, r.expect]));
  return (async (args) => {
    const sequence = args.hcs?.sequenceNumber ?? 0;
    const verdict =
      override[sequence] ?? (expected.get(sequence) === "attested" ? "CHARGED AND WARRANTED" : "REFUSED AND NOT CHARGED");
    const passed = !override[sequence];
    return {
      verdict,
      checks: [{ id: "stub", label: "stubbed check", passed, detail: "" }],
      recomputedBps: expected.get(sequence) === "evidence-refusal" ? null : 13000,
    } as never;
  }) as VerifyChargeFn;
}

export function makeContext(inputs: Inputs, world: World, overrides: Partial<Context> = {}): Context {
  return {
    inputs,
    record: inputs.record,
    manifest: inputs.manifest,
    mirror: world.mirror,
    http: fakeHttp(world),
    endpoints: ENDPOINTS,
    verifyCharge: stubVerifyCharge(inputs),
    windowStart: inputs.windowStart,
    explorer: "https://hashscan.io/testnet",
    ...overrides,
  };
}

export function find<T extends { title: string }>(rows: T[], title: string | RegExp): T {
  const row = rows.find((r) => (typeof title === "string" ? r.title === title : title.test(r.title)));
  if (!row) throw new Error(`no row titled ${String(title)} in: ${rows.map((r) => r.title).join(" | ")}`);
  return row;
}
