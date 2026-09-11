/**
 * The public mirror-node REST API, reduced to the reads the checks need.
 *
 * A 404 is an answer, returned as `null`, because "this does not exist" is
 * exactly what several checks are asking. Any other failure throws: the claim
 * could not be checked, which the caller reports as a failure, never a pass.
 */

// Mirror-node responses are wide, loosely typed JSON; the checks read the few
// fields they need and treat anything missing as a failed expectation.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

export interface MirrorTransfer {
  account: string;
  amount: number;
}

export interface MirrorTransaction {
  transaction_id: string;
  name: string;
  result: string;
  consensus_timestamp: string;
  transfers: MirrorTransfer[];
}

export interface TopicMessage {
  sequence_number: number;
  consensus_timestamp: string;
  message: string;
  topic_id?: string;
  chunk_info?: { number: number; total: number } | null;
}

export interface MirrorApi {
  contract(idOrAddress: string): Promise<Json | null>;
  contractResult(hashOrId: string): Promise<Json | null>;
  token(id: string): Promise<Json | null>;
  /** eth_call against current state; null when the call reverts. */
  call(to: string, data: string): Promise<string | null>;
  transaction(transactionId: string): Promise<MirrorTransaction | null>;
  transfersInvolving(account: string, fromSeconds: number, toSeconds: number): Promise<MirrorTransaction[]>;
  topicMessage(topicId: string, sequence: number): Promise<TopicMessage | null>;
  topicMessages(topicId: string, limit: number): Promise<TopicMessage[]>;
}

export class MirrorError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
  ) {
    super(`mirror node returned HTTP ${status} for ${path}`);
    this.name = "MirrorError";
  }
}

/** `0.0.X@seconds.nanos` → `0.0.X-seconds-nanos`, the form the REST API addresses. */
export function toMirrorTransactionId(id: string): string {
  return id.replace("@", "-").replace(/\.(\d+)$/, "-$1");
}

export function netFor(transaction: MirrorTransaction, account: string): number {
  return (transaction.transfers ?? [])
    .filter((transfer) => transfer.account === account)
    .reduce((sum, transfer) => sum + Number(transfer.amount), 0);
}

export class HttpMirror implements MirrorApi {
  constructor(
    private readonly root: string,
    private readonly fetchImpl: typeof fetch,
  ) {}

  private async get(path: string): Promise<Json | null> {
    const response = await this.fetchImpl(`${this.root}/api/v1/${path}`);
    if (response.status === 404) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    if (!response.ok) throw new MirrorError(response.status, path);
    return response.json();
  }

  contract(idOrAddress: string) {
    return this.get(`contracts/${idOrAddress}`);
  }

  contractResult(hashOrId: string) {
    return this.get(`contracts/results/${hashOrId}`);
  }

  token(id: string) {
    return this.get(`tokens/${id}`);
  }

  async call(to: string, data: string): Promise<string | null> {
    const response = await this.fetchImpl(`${this.root}/api/v1/contracts/call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data, to, estimate: false, block: "latest" }),
    });
    // The mirror node answers a reverted call with 400; that is a result, not an outage.
    if (response.status === 400) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    if (!response.ok) throw new MirrorError(response.status, "contracts/call");
    const body = (await response.json()) as { result?: string };
    return body.result ?? null;
  }

  async transaction(transactionId: string): Promise<MirrorTransaction | null> {
    const body = await this.get(`transactions/${toMirrorTransactionId(transactionId)}`);
    return (body?.transactions?.[0] as MirrorTransaction | undefined) ?? null;
  }

  async transfersInvolving(account: string, fromSeconds: number, toSeconds: number): Promise<MirrorTransaction[]> {
    const body = await this.get(
      `transactions?account.id=${account}&transactiontype=CRYPTOTRANSFER&result=success&order=asc&limit=100` +
        `&timestamp=gte:${fromSeconds}&timestamp=lte:${toSeconds}`,
    );
    return (body?.transactions as MirrorTransaction[] | undefined) ?? [];
  }

  topicMessage(topicId: string, sequence: number) {
    return this.get(`topics/${topicId}/messages/${sequence}`) as Promise<TopicMessage | null>;
  }

  async topicMessages(topicId: string, limit: number): Promise<TopicMessage[]> {
    const body = await this.get(`topics/${topicId}/messages?order=desc&limit=${limit}`);
    return (body?.messages as TopicMessage[] | undefined) ?? [];
  }
}
