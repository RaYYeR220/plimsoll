#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  Client,
  ContractExecuteTransaction,
  ContractId,
  PrivateKey,
} from "@hiero-ledger/sdk";
import { decodeErrorResult, encodeFunctionData, parseAbi, type Hex } from "viem";
import { attest } from "../src/attest.js";
import { DEPLOYMENT_RECORD, resolveOracle } from "../src/config.js";
import { LiveCoverageSource, type CoverageSource } from "../src/coverage/index.js";
import {
  attestationFromWire,
  attestationToWire,
  attestorDomain,
  createAttestorSigner,
  recoverAttestationSigner,
  type AttestationMessage,
} from "../src/eip712.js";
import { TESTNET_MIRROR, hashscanTx, releaseHttpPool, toMirrorTxId } from "../src/mirror.js";
import type { StoredReceipt } from "../src/receipts.js";
import { SIMULATED_FEEDS } from "../src/verify.js";

/**
 * Submit a live attestation to the deployed `CoverageOracle`.
 *
 * Only a reading from `LiveCoverageSource` may reach the chain. An attestation
 * built from fixtures once did: PLIM-B at 15000 bps, read out of a checked-in
 * JSON file, was accepted as `0xc0370dfa…` while the note's holder on Base had
 * never been funded. That record is permanent and public, and it says a real
 * note was covered when it held nothing — the one claim this project exists to
 * refuse. So every path below checks the feed and refuses anything simulated
 * before a byte is sent.
 *
 * Two ways in:
 *
 *   submit-oracle --receipt <file> [--submit]
 *     The attestation a buyer paid for, exactly as the service signed and
 *     anchored it. This is the one worth citing: the bytes sold, the bytes on
 *     HCS and the bytes the oracle accepts are the same bytes. It needs no
 *     attestor key, only an account to pay the transaction fee.
 *
 *   submit-oracle <market> [--submit]
 *     A fresh live reading, adjudicated and signed here.
 *
 * A refusal is never submitted: it is the honest answer for an unfunded note,
 * and the oracle only ever receives attestations. Nothing is sent without
 * `--submit`; without it the script prints exactly what it would send. With it
 * the attestation is sent, then sent again unchanged, and the oracle must reject
 * the second as stale — which shows it checks more than the signature.
 */

const ORACLE_ABI = parseAbi([
  "function submitAttestation((bytes32 noteId,uint64 coverageBps,uint64 asOfBlock,bytes32 vaultSetHash,bytes32 sourceHash,uint64 expiry,uint64 nonce) attestation, bytes signature)",
  "error UnknownNote(bytes32 noteId)",
  "error AttestationExpired(uint64 expiry, uint64 nowTs)",
  "error StaleAttestation(uint64 provided, uint64 floor)",
  "error VaultSetChanged(bytes32 expected, bytes32 provided)",
  "error BadSigner(address recovered, address expected)",
  "error ImplausibleCoverage(uint64 coverageBps)",
]);

/** `dist/bin/submit-oracle.js` → `packages/substreams/notes.json`, the shared notes file. */
const SHARED_NOTES = fileURLToPath(new URL("../../../substreams/notes.json", import.meta.url));

/** An attestation this close to expiry would likely expire in the mempool. */
const MIN_REMAINING_SECONDS = 30;

const args = process.argv.slice(2);
const SUBMIT = args.includes("--submit");
const RECEIPT = valueOf("--receipt");
const NOTE = args.find((arg, i) => !arg.startsWith("--") && args[i - 1] !== "--receipt");

interface Ready {
  message: AttestationMessage;
  signature: Hex;
}

interface Submission {
  label: string;
  transactionId: string;
  status: string;
  revert: string | null;
}

async function main(): Promise<void> {
  const oracle = resolveOracle();
  const domain = attestorDomain({ chainId: oracle.chainId, verifyingContract: oracle.address as Hex });
  console.log(`oracle      ${oracle.address} on chain ${oracle.chainId}`);

  const ready = RECEIPT ? await fromReceipt(RECEIPT, domain) : NOTE ? await fromLiveReading(NOTE, oracle) : usage();
  if (!ready) return;

  const remaining = Number(ready.message.expiry) - Math.floor(Date.now() / 1000);
  if (remaining < MIN_REMAINING_SECONDS) {
    throw new Error(`the attestation expires in ${remaining}s; the oracle would reject it as expired`);
  }

  console.log(`\nattestation`);
  console.log(JSON.stringify(attestationToWire(ready.message), null, 2));
  console.log(`expires in ${remaining}s`);

  if (!SUBMIT) {
    console.log(`\nDry run: nothing sent. Re-run with --submit to send it, followed by a replay the oracle must refuse.`);
    return;
  }

  const client = Client.forTestnet().setOperator(
    required("HEDERA_ACCOUNT_ID"),
    PrivateKey.fromStringECDSA(strip(requiredKey("HEDERA_PRIVATE_KEY"))),
  );
  const contractId = oracleContractId(oracle.address);

  const submissions: Submission[] = [];
  try {
    submissions.push(await submit(client, contractId, "accepted attestation", ready));
    // The same bytes again. The nonce now equals the one the oracle recorded
    // and the rule is strictly greater, so this must be refused.
    submissions.push(await submit(client, contractId, "replayed attestation (must be refused)", ready));
  } finally {
    client.close();
  }

  console.log("");
  for (const s of submissions) {
    console.log(s.label);
    console.log(`  tx       ${s.transactionId}`);
    console.log(`  status   ${s.status}${s.revert ? `  ${s.revert}` : ""}`);
    console.log(`  hashscan ${hashscanTx(s.transactionId)}`);
  }
}

/** The stored receipt of a paid call, checked before anything is sent. */
async function fromReceipt(path: string, domain: ReturnType<typeof attestorDomain>): Promise<Ready | null> {
  const receipt = JSON.parse(readFileSync(path, "utf8")) as StoredReceipt;
  const feed = receipt.feed ?? receipt.anchorRecord?.feed;
  console.log(`receipt     ${receipt.requestId}  ${receipt.noteId}  feed ${feed ?? "unstated"}`);
  if (receipt.anchor) console.log(`anchored    ${receipt.anchor.topicId} #${receipt.anchor.sequenceNumber}`);
  if (receipt.chargeTransactionId) console.log(`paid        ${receipt.chargeTransactionId}`);

  if (!feed || SIMULATED_FEEDS.includes(feed)) {
    throw new Error(`receipt ${receipt.requestId} is ${feed ? `a ${feed} reading` : "of unstated provenance"}; only a live reading is submitted`);
  }
  if (receipt.decision !== "attested") {
    console.log(`\n${receipt.noteId} was refused (${receipt.reason}). Not submitted: the oracle is only ever sent attestations.`);
    return null;
  }

  const message = attestationFromWire(receipt.message);
  const signature = receipt.signature as Hex;
  // Checked here rather than left to the contract, so a receipt signed for a
  // different oracle fails loudly before it costs a transaction.
  const recovered = await recoverAttestationSigner(domain, message, signature);
  if (recovered.toLowerCase() !== receipt.attestor.toLowerCase()) {
    throw new Error(`the receipt's signature recovers to ${recovered} under this oracle's domain, not ${receipt.attestor}`);
  }
  return { message, signature };
}

/** A fresh reading from the live source, signed here. */
async function fromLiveReading(note: string, oracle: { address: string; chainId: number }): Promise<Ready | null> {
  const env = { ...process.env };
  if (!env.LIVE_NOTES_FILE && existsSync(SHARED_NOTES)) env.LIVE_NOTES_FILE = SHARED_NOTES;
  const source: CoverageSource = LiveCoverageSource.fromEnv(env);
  if (SIMULATED_FEEDS.includes(source.id)) {
    throw new Error(`refusing to put a ${source.id} reading on chain; only a live source may attest a real note`);
  }

  const signer = createAttestorSigner(requiredKey("ATTESTOR_PRIVATE_KEY"), {
    chainId: oracle.chainId,
    verifyingContract: oracle.address as Hex,
  });
  const verdict = await attest(note, { source, signer });
  if (SIMULATED_FEEDS.includes(verdict.feed)) {
    throw new Error(`the verdict for ${note} reports feed ${verdict.feed}; nothing simulated is submitted`);
  }

  console.log(`note        ${note}  (${verdict.noteIdHash})  feed ${verdict.feed}`);
  if (verdict.decision === "refused") {
    console.log(`\nREFUSED  ${verdict.family} / ${verdict.reason}`);
    console.log(`  ${verdict.description}`);
    console.log(`  coverage  ${verdict.coverageBps === null ? "not computed" : `${verdict.coverageBps} bps`}`);
    if (verdict.evidence) {
      console.log(`  line      ${verdict.evidence.floorBps} bps, read from LoadLine`);
      console.log(`  backing   ${verdict.evidence.attributableValue} against ${verdict.evidence.obligation} at block ${verdict.evidence.asOfBlock}`);
    }
    if (Object.keys(verdict.detail).length > 0) console.log(`  detail    ${JSON.stringify(verdict.detail)}`);
    console.log(`\nNot submitted. A refusal is not an attestation, and the oracle is only ever sent attestations.`);
    return null;
  }

  console.log(`ATTESTED  ${verdict.coverageBps} bps against a ${verdict.evidence.floorBps} bps line, block ${verdict.message.asOfBlock}`);
  return { message: verdict.message, signature: await signer.signAttestation(verdict.message) };
}

async function submit(client: Client, contractId: ContractId, label: string, ready: Ready): Promise<Submission> {
  const calldata = encodeFunctionData({
    abi: ORACLE_ABI,
    functionName: "submitAttestation",
    args: [ready.message, ready.signature],
  });

  const response = await new ContractExecuteTransaction()
    .setContractId(contractId)
    .setGas(400_000)
    .setFunctionParameters(Buffer.from(calldata.slice(2), "hex"))
    .execute(client);
  const transactionId = response.transactionId.toString();

  try {
    const receipt = await response.getReceipt(client);
    return { label, transactionId, status: receipt.status.toString(), revert: null };
  } catch (error) {
    // The replay is expected to revert, so its reason is decoded from the
    // mirror node, where a stranger would read it too.
    const status = (error as { status?: unknown }).status?.toString() ?? String(error);
    return { label, transactionId, status, revert: await revertReason(transactionId) };
  }
}

/** The contract id the deployment record names, which every other tool here targets. */
function oracleContractId(address: string): ContractId {
  try {
    const record = JSON.parse(readFileSync(DEPLOYMENT_RECORD, "utf8"));
    const hederaId = record?.contracts?.CoverageOracle?.hederaId;
    if (typeof hederaId === "string") return ContractId.fromString(hederaId);
  } catch {
    // Fall through to the address form.
  }
  return ContractId.fromEvmAddress(0, 0, address);
}

async function revertReason(transactionId: string): Promise<string | null> {
  const url = `${TESTNET_MIRROR}/api/v1/contracts/results/${toMirrorTxId(transactionId)}`;
  for (let attempt = 0; attempt < 6; attempt++) {
    const response = await fetch(url);
    if (response.ok) {
      const body = (await response.json()) as { error_message?: string };
      const data = body.error_message;
      if (data && data !== "0x") {
        try {
          const decoded = decodeErrorResult({ abi: ORACLE_ABI, data: data as Hex });
          return `${decoded.errorName}(${(decoded.args ?? []).map(String).join(", ")})`;
        } catch {
          return `undecodable revert data ${data}`;
        }
      }
    } else {
      await response.body?.cancel().catch(() => {});
    }
    // The mirror node lags consensus by a second or two.
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return null;
}

function usage(): never {
  throw new Error(
    "usage: submit-oracle --receipt <file> [--submit]  |  submit-oracle <market> [--submit]\n" +
      "       without --submit nothing is sent",
  );
}

function valueOf(flag: string): string | undefined {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
}

function required(name: string): string {
  const value = (process.env[name] ?? "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredKey(name: string): Hex {
  const raw = required(name);
  return (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
}

function strip(key: string): string {
  return key.startsWith("0x") ? key.slice(2) : key;
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => void releaseHttpPool());
