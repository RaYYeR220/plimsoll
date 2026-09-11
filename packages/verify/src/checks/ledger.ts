import { recoverMessageAddress, type Abi, type Hex } from "viem";
import type { Context } from "../context.js";
import {
  decodeRevert,
  formatRevert,
  loadErrorAbi,
  normaliseRevertData,
} from "../errors.js";
import type { DeviceProof, DeviceStep } from "../inputs.js";
import type { Json } from "../mirror.js";
import { type CheckResult, fail, guarded, pass, sameAddress, short, skip } from "../result.js";

/**
 * Check 8: the live Ledger sequence.
 *
 * Every transaction hash comes from the device proof the record points at, so
 * a re-run of the sequence against a redeployed verifier is checked as it is,
 * never as it was. Three kinds of evidence are checked, each keylessly:
 *
 *   - the device's approvals: each signature is recovered from the exact
 *     mandate text and must come from the device, for the deployed verifier;
 *   - the transactions: each must have ended on the mirror node as the proof
 *     says, against the contract the proof names, with the same revert bytes;
 *   - the value binding: a write that differs from the approved number reverts
 *     `MandateValueMismatch`, and the approved number itself goes through.
 */
export async function checkLedger(ctx: Context): Promise<CheckResult[]> {
  if (!ctx.record.device_proof) {
    return [skip("Ledger device proof", "the deployment record lists no device proof")];
  }
  const proof = ctx.inputs.deviceProof;
  if (!proof) {
    return [fail("Ledger device proof", `the record points at ${ctx.record.device_proof}, which is missing`)];
  }

  const contracts = ctx.record.contracts;
  const verifier = contracts.MandateVerifier?.address;
  const loadLine = contracts.LoadLine?.address;
  const rows: CheckResult[] = [];

  // The adapter joined the proof with the redeploy that closed the direct-spend
  // path. Older proofs do not name one and are not faulted for that.
  const adapter = contracts.MandateVerifierAdapter?.address;
  const proofAdapter = (proof as DeviceProof & { adapter?: string }).adapter;
  const adapterBound = !proofAdapter || sameAddress(proofAdapter, adapter);
  rows.push(
    sameAddress(proof.verifier, verifier) && sameAddress(proof.loadLine, loadLine) && adapterBound
      ? pass(
          "proof is for the deployed verifier and load line",
          `MandateVerifier ${short(verifier!)} · LoadLine ${short(loadLine!)}` +
            (proofAdapter ? ` · adapter ${short(adapter!)}` : ""),
        )
      : fail(
          "proof is for the deployed verifier and load line",
          `the proof names verifier ${proof.verifier}, load line ${proof.loadLine}` +
            (proofAdapter ? `, adapter ${proofAdapter}` : "") +
            `; the record's are ${verifier}, ${loadLine}${proofAdapter ? `, ${adapter}` : ""}, ` +
            "so the proof predates the current deployment",
        ),
  );

  const authority = ctx.record.roles.mandateAuthoritySigner;
  rows.push(
    sameAddress(proof.device.address, authority)
      ? pass("device key is the mandate authority", proof.device.address)
      : fail("device key is the mandate authority", `device ${proof.device.address}, record's authority ${authority}`),
  );

  const abi = loadErrorAbi(ctx.inputs.contractsSource);

  // Fetch each transaction once; the value-binding row reuses the results.
  const results = new Map<string, Json | null>();
  for (const step of proof.steps) {
    if (step.tx && !results.has(step.tx)) {
      results.set(step.tx, await ctx.mirror.contractResult(step.tx).catch((error: unknown) => {
        throw error;
      }));
    }
  }

  for (const step of proof.steps) {
    if (step.tx) {
      rows.push(...(await guarded(transactionTitle(step), async () => transactionRow(ctx, proof, step, results.get(step.tx!) ?? null, abi))));
    } else if (step.action) {
      rows.push(...(await guarded(deviceTitle(step), () => deviceRow(step, proof, verifier))));
    }
  }

  rows.push(valueBindingRow(ctx, proof, results, abi));
  rows.push(...directSpendRows(proof));
  return rows;
}

function deviceTitle(step: DeviceStep): string {
  const threshold =
    step.action === "SET-THRESHOLD" && typeof step.loadLineBps === "number"
      ? ` ${(step.loadLineBps / 100).toFixed(2)}%`
      : "";
  return step.signature ? `${step.action}${threshold} approved on the device` : `${step.action} refused on the device`;
}

async function deviceRow(step: DeviceStep, proof: DeviceProof, verifier: string | undefined): Promise<CheckResult> {
  const title = deviceTitle(step);
  if (!step.signature) {
    return skip(title, "a refusal leaves no signature to check; what the chain did without one is checked below");
  }
  if (!step.mandateText) return fail(title, "the proof records a signature but no mandate text to check it against");

  const named = step.mandateText.match(/VERIFIER:\s*(0x[0-9a-fA-F]{40})/)?.[1];
  const recovered = await recoverMessageAddress({ message: step.mandateText, signature: step.signature as Hex });
  const problems: string[] = [];
  if (!sameAddress(recovered, proof.device.address)) {
    problems.push(`signature recovers to ${recovered}, not the device ${proof.device.address}`);
  }
  if (named && verifier && !sameAddress(named, verifier)) {
    problems.push(`the mandate names verifier ${named}, not the deployed ${verifier}`);
  }
  return problems.length
    ? fail(title, problems.join("; "))
    : pass(title, `nonce ${step.nonce ?? "?"} · signature recovers to the device ${short(recovered)}`);
}

function transactionTitle(step: DeviceStep): string {
  const verb = step.mirror === "SUCCESS" ? "accepted" : "reverted";
  return `${step.call ?? "transaction"} ${verb}`;
}

function transactionRow(
  ctx: Context,
  proof: DeviceProof,
  step: DeviceStep,
  result: Json | null,
  abi: Abi,
): CheckResult {
  const title = transactionTitle(step);
  const evidence = `${ctx.explorer}/transaction/${step.tx}`;
  if (!result) return fail(title, `${short(step.tx!)} is not on the mirror node`, evidence);

  const problems: string[] = [];
  if (step.mirror && result.result !== step.mirror) {
    problems.push(`ended ${result.result}, the proof says ${step.mirror}`);
  }

  const contractName = step.call?.split(".")[0];
  const target = contractName ? ctx.record.contracts[contractName]?.address : undefined;
  if (target && !sameAddress(result.to, target)) {
    problems.push(`sent to ${result.to}, not the deployed ${contractName} ${target}`);
  }
  const recordedTo = (step as DeviceStep & { to?: string }).to;
  if (recordedTo && target && !sameAddress(recordedTo, target)) {
    problems.push(`the proof says it went to ${recordedTo}, but the deployed ${contractName} is ${target}`);
  }

  const onChain = normaliseRevertData(result.error_message);
  if (step.revertData !== undefined && onChain !== normaliseRevertData(step.revertData)) {
    problems.push("revert bytes differ from the proof");
  }

  const decoded = decodeRevert(abi, result.error_message);
  if (step.error && decoded?.name !== step.error) {
    problems.push(`reverted ${decoded?.name ?? "with undecodable data"}, the proof expects ${step.error}`);
  }
  if (decoded?.name === "WrongAuthority" && !sameAddress(decoded.args[1] as string, proof.device.address)) {
    problems.push(`WrongAuthority expected ${String(decoded.args[1])}, not the device`);
  }
  // A mandate spent anywhere but through LoadLine must be refused.
  if (/^MandateVerifier(Adapter)?\./.test(step.call ?? "") && result.result !== "CONTRACT_REVERT_EXECUTED") {
    problems.push(`a mandate spent directly at ${contractName} must revert, and this one ended ${result.result}`);
  }

  if (problems.length) return fail(title, problems.join("; "), evidence);
  const what =
    result.result === "SUCCESS" ? "SUCCESS" : decoded ? formatRevert(decoded) : `${result.result}, revert bytes match`;
  return pass(title, `${what} · ${short(step.tx!)}`, evidence);
}

/**
 * The approved number is the number written: a threshold write that differs
 * from the one the device approved reverts `MandateValueMismatch`, naming the
 * note, the value written and the value mandated; the approved value succeeds.
 */
function valueBindingRow(ctx: Context, proof: DeviceProof, results: Map<string, Json | null>, abi: Abi): CheckResult {
  const title = "only the approved threshold can be written";
  const approved = proof.steps.find((step) => step.action === "SET-THRESHOLD" && step.signature)?.loadLineBps;
  const writes = proof.steps.filter((step) => step.tx && /\.setThreshold$/.test(step.call ?? ""));
  const noteId = (ctx.record as { note_under_management?: { noteId?: string } }).note_under_management?.noteId;
  if (approved === undefined || writes.length === 0) {
    return skip(title, "the device proof records no approved threshold and write to test it against");
  }

  let mismatch: string | null = null;
  let accepted = false;
  for (const step of writes) {
    const result = results.get(step.tx!);
    if (!result) continue;
    if (result.result === "SUCCESS") {
      accepted = true;
      continue;
    }
    const decoded = decodeRevert(abi, result.error_message);
    if (decoded?.name !== "MandateValueMismatch") continue;
    const [subject, written, mandated] = decoded.args as [string, bigint | number, bigint | number];
    if (noteId && !sameAddress(subject, noteId)) continue;
    if (Number(mandated) !== approved || Number(written) === approved) continue;
    mismatch = `${(Number(written) / 100).toFixed(2)}% written against a ${(approved / 100).toFixed(2)}% mandate reverted MandateValueMismatch`;
  }

  if (mismatch && accepted) {
    return pass(title, `${mismatch}; the approved ${(approved / 100).toFixed(2)}% went through`);
  }
  return fail(
    title,
    mismatch
      ? "no write of the approved threshold succeeded"
      : "no write of a different threshold reverted MandateValueMismatch for this note and mandate",
  );
}

function directSpendRows(proof: DeviceProof): CheckResult[] {
  const rows: CheckResult[] = [];
  const pending = "not in the device proof yet; it is added when the Ledger sequence is re-run against the redeployed verifier";
  if (!proof.steps.some((step) => step.tx && /^MandateVerifier\./.test(step.call ?? ""))) {
    rows.push(skip("a mandate spent directly at the verifier reverts", pending));
  }
  if (!proof.steps.some((step) => step.tx && /^MandateVerifierAdapter\./.test(step.call ?? ""))) {
    rows.push(skip("a mandate spent directly at the adapter reverts", pending));
  }
  return rows;
}
