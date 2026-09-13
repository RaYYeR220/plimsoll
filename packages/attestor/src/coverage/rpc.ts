import { decodeFunctionResult, encodeFunctionData, type Abi, type Hex } from "viem";

/**
 * The smallest JSON-RPC surface the live source needs, so a test can stand in
 * for a node with a plain function and nothing has to be mocked at the HTTP
 * layer.
 */
export interface JsonRpc {
  /**
   * How this endpoint is named in evidence. It is published, so it must never
   * carry a credential: the default is the bare host.
   */
  readonly label: string;
  request<T = unknown>(method: string, params: readonly unknown[]): Promise<T>;
}

/**
 * Why a call failed matters downstream. Only a node that executed the call and
 * reported a revert, or returned nothing, has told us something about the
 * vault. Everything else, including a node that refused us for rate, is about
 * our access to the chain.
 */
export type JsonRpcFailure = "transport" | "rpc" | "empty";

export class JsonRpcError extends Error {
  readonly kind: JsonRpcFailure;
  readonly code: number | undefined;
  readonly endpoint: string;
  readonly retryable: boolean;
  constructor(endpoint: string, kind: JsonRpcFailure, message: string, code?: number, retryable = false) {
    super(`${endpoint}: ${message}`);
    this.name = "JsonRpcError";
    this.endpoint = endpoint;
    this.kind = kind;
    this.code = code;
    this.retryable = retryable;
  }
}

export interface HttpJsonRpcOptions {
  /** Published name of the endpoint. Defaults to the host, never the full URL. */
  label?: string;
  timeoutMs?: number;
  /** Retries after a rate-limit answer, with doubling delay. */
  retries?: number;
  retryDelayMs?: number;
  fetch?: typeof globalThis.fetch;
}

const RATE_LIMITED = /rate limit|too many requests|limit exceeded|throttl/i;
const EXECUTION_FAILED = /revert|out of gas|invalid opcode|stack underflow/i;

export function httpJsonRpc(url: string, options: HttpJsonRpcOptions = {}): JsonRpc {
  const label = options.label ?? new URL(url).host;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const retries = options.retries ?? 4;
  const retryDelayMs = options.retryDelayMs ?? 400;
  const doFetch = options.fetch ?? globalThis.fetch;
  let id = 0;

  async function once<T>(method: string, params: readonly unknown[]): Promise<T> {
    let response: Response;
    try {
      response = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new JsonRpcError(label, "transport", `${method} did not complete: ${(error as Error).message}`);
    }
    if (!response.ok) {
      throw new JsonRpcError(label, "transport", `${method} returned HTTP ${response.status}`, undefined, response.status === 429);
    }
    let body: { result?: T; error?: { code?: number; message?: string } };
    try {
      body = (await response.json()) as typeof body;
    } catch {
      throw new JsonRpcError(label, "transport", `${method} returned a body that is not JSON`);
    }
    if (body.error) {
      const message = body.error.message ?? "error";
      const executed = body.error.code === 3 || EXECUTION_FAILED.test(message);
      throw new JsonRpcError(
        label,
        executed ? "rpc" : "transport",
        `${method}: ${message}`,
        body.error.code,
        !executed && RATE_LIMITED.test(message),
      );
    }
    if (!("result" in body)) throw new JsonRpcError(label, "transport", `${method}: response had no result`);
    return body.result as T;
  }

  return {
    label,
    async request<T>(method: string, params: readonly unknown[]): Promise<T> {
      for (let attempt = 0; ; attempt++) {
        try {
          return await once<T>(method, params);
        } catch (error) {
          if (!(error instanceof JsonRpcError) || !error.retryable || attempt >= retries) throw error;
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs * 2 ** attempt));
        }
      }
    },
  };
}

/** One block, identified by hash so a reorg cannot silently change what was read. */
export interface PinnedBlock {
  readonly number: bigint;
  readonly hash: Hex;
  /** Unix seconds from the block header. */
  readonly timestamp: number;
}

interface RpcBlock {
  number: Hex;
  hash: Hex;
  timestamp: Hex;
}

function toPinned(block: RpcBlock | null, what: string, label: string): PinnedBlock {
  if (!block || !/^0x[0-9a-fA-F]{64}$/.test(block.hash ?? "")) {
    throw new JsonRpcError(label, "empty", `${what}: no such block`);
  }
  return {
    number: BigInt(block.number),
    hash: block.hash.toLowerCase() as Hex,
    timestamp: Number(BigInt(block.timestamp)),
  };
}

/**
 * Resolves the block every later read is pinned to.
 *
 * The number is turned into a hash here, once. Nothing after this point is
 * allowed to say "latest", so a verdict can never mix two blocks.
 */
export async function pinBlock(rpc: JsonRpc, number: bigint): Promise<PinnedBlock> {
  const block = await rpc.request<RpcBlock | null>("eth_getBlockByNumber", [`0x${number.toString(16)}`, false]);
  return toPinned(block, `block ${number}`, rpc.label);
}

export async function headNumber(rpc: JsonRpc): Promise<bigint> {
  return BigInt(await rpc.request<Hex>("eth_blockNumber", []));
}

/** The same block as seen by another endpoint, or null if it does not know it. */
export async function blockByHash(rpc: JsonRpc, hash: Hex): Promise<PinnedBlock | null> {
  const block = await rpc.request<RpcBlock | null>("eth_getBlockByHash", [hash, false]);
  return block ? toPinned(block, `block ${hash}`, rpc.label) : null;
}

export interface ContractRead {
  address: string;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
}

/**
 * `eth_call` pinned by EIP-1898 block hash with `requireCanonical`, so the node
 * refuses rather than answering from a block that is no longer on its chain.
 *
 * An empty return is an error, not a zero. A call to an address with no code
 * returns `0x`, and decoding that as a balance would be a fabricated reading.
 */
export async function callAt<T = unknown>(rpc: JsonRpc, block: PinnedBlock, read: ContractRead): Promise<T> {
  const data = encodeFunctionData({
    abi: read.abi,
    functionName: read.functionName,
    args: read.args ?? [],
  } as never);
  const raw = await rpc.request<Hex>("eth_call", [
    { to: read.address, data },
    { blockHash: block.hash, requireCanonical: true },
  ]);
  if (typeof raw !== "string" || raw === "0x") {
    throw new JsonRpcError(rpc.label, "empty", `${read.functionName} on ${read.address} returned no data`);
  }
  return decodeFunctionResult({ abi: read.abi, functionName: read.functionName, data: raw } as never) as T;
}
