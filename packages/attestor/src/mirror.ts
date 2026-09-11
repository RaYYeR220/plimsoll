/**
 * Public mirror node access. No keys, no SDK, no account.
 *
 * Everything here is deliberately plain `fetch` against documented REST paths,
 * because the verifier has to be runnable by a stranger who has none of our
 * credentials and should be able to read what it does at a glance.
 */

export const TESTNET_MIRROR = "https://testnet.mirrornode.hedera.com";
export const HASHSCAN_TESTNET = "https://hashscan.io/testnet";

/**
 * Hedera reports a transaction id as `0.0.X@seconds.nanos`, and the mirror node
 * addresses the same transaction as `0.0.X-seconds-nanos`. Getting this wrong
 * produces a 404 that reads exactly like "no such transaction", which in this
 * codebase would be a false proof of non-payment. Hence one conversion, used
 * everywhere.
 */
export function toMirrorTxId(transactionId: string): string {
  return transactionId.replace("@", "-").replace(/\.(\d+)$/, "-$1");
}

export function hashscanTx(transactionId: string): string {
  return `${HASHSCAN_TESTNET}/transaction/${toMirrorTxId(transactionId)}`;
}

export function hashscanTopic(topicId: string): string {
  return `${HASHSCAN_TESTNET}/topic/${topicId}`;
}

export interface MirrorTransfer {
  account: string;
  amount: number;
}

export interface MirrorTransaction {
  transaction_id: string;
  name: string;
  result: string;
  consensus_timestamp: string;
  charged_tx_fee: number;
  transfers: MirrorTransfer[];
}

export interface MirrorTopicMessage {
  sequence_number: number;
  consensus_timestamp: string;
  message: string;
  topic_id: string;
  chunk_info?: { number: number; total: number } | null;
}

export interface MirrorClientOptions {
  baseUrl?: string;
  /** Attempts for a transaction that may not be indexed yet. */
  attempts?: number;
  delayMs?: number;
  fetchImpl?: typeof globalThis.fetch;
}

/**
 * Node's global fetch pool holds sockets open for several seconds after the
 * last request. A long-running server wants that; a CLI that has finished
 * reading and wants to exit with a specific code does not.
 */
export async function releaseHttpPool(): Promise<void> {
  const dispatcher = (globalThis as Record<symbol, unknown>)[
    Symbol.for("undici.globalDispatcher.1")
  ] as { close?: () => Promise<void> } | undefined;
  await dispatcher?.close?.().catch(() => {});
}

export class MirrorClient {
  private readonly baseUrl: string;
  private readonly attempts: number;
  private readonly delayMs: number;
  private readonly doFetch: typeof globalThis.fetch;

  constructor(options: MirrorClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? TESTNET_MIRROR).replace(/\/$/, "");
    this.attempts = options.attempts ?? 8;
    // The public mirror node runs around 50 rps and lags consensus by a second
    // or two. Polling politely is both neighbourly and necessary.
    this.delayMs = options.delayMs ?? 1500;
    this.doFetch = options.fetchImpl ?? globalThis.fetch;
  }

  /**
   * Look up one transaction.
   *
   * @returns the transaction, or `null` when the mirror node has no record of
   *   it after every attempt. `null` is a load-bearing answer here: it is what
   *   proves a refusal moved no money.
   */
  async transaction(transactionId: string): Promise<MirrorTransaction | null> {
    const id = toMirrorTxId(transactionId);
    for (let attempt = 0; attempt < this.attempts; attempt++) {
      const res = await this.doFetch(`${this.baseUrl}/api/v1/transactions/${id}`);
      if (res.status === 200) {
        const body = (await res.json()) as { transactions?: MirrorTransaction[] };
        const found = body.transactions?.[0];
        if (found) return found;
      } else if (res.status !== 404) {
        throw new Error(`mirror node returned ${res.status} for ${id}`);
      }
      if (attempt < this.attempts - 1) await sleep(this.delayMs);
    }
    return null;
  }

  /**
   * Single-shot existence check with no retry, for asserting an absence.
   *
   * Retrying a lookup that is expected to fail would only make an absence take
   * longer to establish; callers that need to rule out indexing lag wait first
   * and then call this.
   */
  async transactionExists(transactionId: string): Promise<boolean> {
    const res = await this.doFetch(`${this.baseUrl}/api/v1/transactions/${toMirrorTxId(transactionId)}`);
    if (res.status === 404) return false;
    if (res.status === 200) {
      const body = (await res.json()) as { transactions?: MirrorTransaction[] };
      return (body.transactions?.length ?? 0) > 0;
    }
    throw new Error(`mirror node returned ${res.status}`);
  }

  /**
   * Every CRYPTOTRANSFER that credited an account in a time window.
   *
   * This is how a refusal is proven negative without knowing a transaction id:
   * if nothing credited the seller in the window around the request, nothing
   * was captured.
   */
  async transfersTo(
    accountId: string,
    fromSeconds: number,
    toSeconds: number,
  ): Promise<MirrorTransaction[]> {
    const url =
      `${this.baseUrl}/api/v1/transactions?account.id=${accountId}` +
      `&transactiontype=CRYPTOTRANSFER&result=success&order=asc&limit=100` +
      `&timestamp=gte:${fromSeconds}&timestamp=lte:${toSeconds}`;
    const res = await this.doFetch(url);
    if (!res.ok) throw new Error(`mirror node returned ${res.status} listing transfers`);
    const body = (await res.json()) as { transactions?: MirrorTransaction[] };
    return body.transactions ?? [];
  }

  async topicMessage(topicId: string, sequenceNumber: number): Promise<MirrorTopicMessage | null> {
    for (let attempt = 0; attempt < this.attempts; attempt++) {
      const res = await this.doFetch(
        `${this.baseUrl}/api/v1/topics/${topicId}/messages/${sequenceNumber}`,
      );
      if (res.status === 200) return (await res.json()) as MirrorTopicMessage;
      if (res.status !== 404) throw new Error(`mirror node returned ${res.status}`);
      if (attempt < this.attempts - 1) await sleep(this.delayMs);
    }
    return null;
  }

  async topicMessages(topicId: string, limit = 25): Promise<MirrorTopicMessage[]> {
    const res = await this.doFetch(
      `${this.baseUrl}/api/v1/topics/${topicId}/messages?order=desc&limit=${limit}`,
    );
    if (!res.ok) throw new Error(`mirror node returned ${res.status}`);
    const body = (await res.json()) as { messages?: MirrorTopicMessage[] };
    return body.messages ?? [];
  }
}

/** Net movement for one account in a transaction, in tinybar. */
export function netForAccount(tx: MirrorTransaction, accountId: string): number {
  return tx.transfers
    .filter((t) => t.account === accountId)
    .reduce((sum, t) => sum + t.amount, 0);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
