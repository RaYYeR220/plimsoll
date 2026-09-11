/**
 * A polite fetch.
 *
 * Every request the verifier makes — including the ones the attestor's
 * verify-charge makes, because this replaces the global fetch — goes through a
 * per-host spacing gate and backs off on 429 and 5xx rather than retrying into
 * a wall. The public mirror node allows about 50 requests a second and the
 * unauthenticated GitHub API 60 an hour; a verifier that got a judge
 * rate-limited would be worse than no verifier.
 */

export interface ThrottleOptions {
  /** Minimum milliseconds between request starts, per host. */
  intervalsMs?: Record<string, number>;
  defaultIntervalMs?: number;
  retries?: number;
  timeoutMs?: number;
  baseFetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Clock, injectable so the schedule can be tested without wall time. */
  now?: () => number;
}

export type ThrottledFetch = typeof fetch & {
  /** Requests actually sent, retries included. */
  requests(): number;
};

/** Well inside each service's public limit. */
export const PUBLIC_INTERVALS_MS: Record<string, number> = {
  "testnet.mirrornode.hedera.com": 125,
  "mainnet-public.mirrornode.hedera.com": 125,
  "sourcify.dev": 250,
  "api.github.com": 1000,
  "substreams.dev": 500,
};

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createThrottledFetch(options: ThrottleOptions = {}): ThrottledFetch {
  const base = options.baseFetch ?? globalThis.fetch.bind(globalThis);
  const sleep = options.sleep ?? realSleep;
  const clock = options.now ?? Date.now;
  const retries = options.retries ?? 4;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const defaultInterval = options.defaultIntervalMs ?? 250;
  const nextSlot = new Map<string, number>();
  let sent = 0;

  // Reserve the next slot synchronously, so concurrent callers queue behind
  // each other instead of all seeing the same free slot.
  const acquire = async (host: string): Promise<void> => {
    const interval = options.intervalsMs?.[host] ?? defaultInterval;
    const now = clock();
    const slot = Math.max(now, nextSlot.get(host) ?? 0);
    nextSlot.set(host, slot + interval);
    if (slot > now) await sleep(slot - now);
  };

  const backoff = (attempt: number) => Math.min(500 * 2 ** attempt, 8_000);

  const throttled = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const host = new URL(url).host;
    for (let attempt = 0; ; attempt++) {
      await acquire(host);
      sent++;
      let response: Response;
      try {
        response = await base(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(timeoutMs) });
      } catch (error) {
        if (attempt >= retries) throw error;
        await sleep(backoff(attempt));
        continue;
      }
      if (!RETRYABLE.has(response.status) || attempt >= retries) return response;
      // Honour the server's own estimate when it gives one, within reason.
      const retryAfter = Number(response.headers.get("retry-after"));
      await response.body?.cancel().catch(() => {});
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 10_000) : backoff(attempt));
    }
  };

  return Object.assign(throttled, { requests: () => sent }) as ThrottledFetch;
}

export interface Endpoints {
  /** Mirror node root, without /api/v1. */
  mirror: string;
  sourcify: string;
  github: string;
  substreams: string;
}

/**
 * The mirror node comes from the deployment record; the other three are the
 * public services themselves, not deployment data.
 */
export function publicEndpoints(mirrorFromRecord: string): Endpoints {
  return {
    mirror: mirrorFromRecord.replace(/\/+$/, "").replace(/\/api\/v1$/, ""),
    sourcify: "https://sourcify.dev/server",
    github: "https://api.github.com",
    substreams: "https://substreams.dev",
  };
}

/**
 * Node's fetch pool keeps sockets alive for seconds after the last request. A
 * command that is finished and wants to exit with a specific code should not
 * wait on them.
 */
export async function releaseHttpPool(): Promise<void> {
  const dispatcher = (globalThis as Record<symbol, unknown>)[Symbol.for("undici.globalDispatcher.1")] as
    | { close?: () => Promise<void> }
    | undefined;
  await dispatcher?.close?.().catch(() => {});
}
