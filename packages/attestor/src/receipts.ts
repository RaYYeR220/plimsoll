import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { AnchorRecord } from "./anchor.js";
import type { Evidence } from "./attest.js";

/**
 * The off-chain half of the audit trail.
 *
 * The HCS record is the tamper-evident summary; this is the full evidence it
 * commits to, kept locally so `verify-charge` can run with no network at all.
 * The two are bound by `sourceHash`: if a receipt here is edited, its hash
 * stops matching the anchored `srch` and the verifier reports a DISCREPANCY.
 */
export interface StoredReceipt {
  requestId: string;
  noteId: string;
  decision: "attested" | "refused";
  family: "asset" | "evidence" | null;
  reason: string | null;
  coverageBps: number;
  coverageKnown: boolean;
  /** Signed EIP-712 message in wire form. */
  message: Record<string, unknown>;
  signature: string;
  attestor: string;
  sourceHash: string;
  evidence: Evidence | null;
  /** Settlement id when a charge happened; null is the claim that none did. */
  chargeTransactionId: string | null;
  /** Seller account that would have been credited. */
  payTo: string;
  amountTinybar: string;
  /** Payer account, when the payment was verified. */
  payer: string | null;
  requestedAt: number;
  respondedAt: number;
  httpStatus: number;
  anchor: { topicId: string; sequenceNumber: number; transactionId: string } | null;
  anchorRecord: AnchorRecord | null;
}

export class ReceiptStore {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, "receipts");
    mkdirSync(this.dir, { recursive: true });
  }

  private pathFor(requestId: string): string {
    return join(this.dir, `${requestId}.json`);
  }

  write(receipt: StoredReceipt): void {
    writeFileSync(this.pathFor(receipt.requestId), JSON.stringify(receipt, null, 2) + "\n");
  }

  /** Merge fields into an existing receipt, for facts learned after the response. */
  patch(requestId: string, patch: Partial<StoredReceipt>): void {
    const existing = this.read(requestId);
    if (!existing) return;
    this.write({ ...existing, ...patch });
  }

  read(requestId: string): StoredReceipt | null {
    const path = this.pathFor(requestId);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as StoredReceipt;
  }

  list(): StoredReceipt[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(this.dir, f), "utf8")) as StoredReceipt)
      .sort((a, b) => a.requestedAt - b.requestedAt);
  }
}

/**
 * Nonces already used by a signed verdict.
 *
 * A nonce is what stops a buyer replaying yesterday's attestation as today's.
 * The store is deliberately small and append-only: it exists to make replay
 * detectable, not to be a database.
 */
export class NonceStore {
  private readonly path: string;
  private readonly seen = new Set<string>();

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.path = join(dataDir, "nonces.json");
    if (existsSync(this.path)) {
      for (const n of JSON.parse(readFileSync(this.path, "utf8")) as string[]) this.seen.add(n);
    }
  }

  /** @returns false when the nonce has been issued before. */
  claim(nonce: string): boolean {
    if (this.seen.has(nonce)) return false;
    this.seen.add(nonce);
    writeFileSync(this.path, JSON.stringify([...this.seen]));
    return true;
  }

  has(nonce: string): boolean {
    return this.seen.has(nonce);
  }
}
