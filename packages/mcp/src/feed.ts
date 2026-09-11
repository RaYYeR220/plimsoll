import { Code, ConnectError, type Interceptor } from "@connectrpc/connect";
import { createGrpcTransport, Http2SessionManager } from "@connectrpc/connect-node";
import { createAuthInterceptor, createRequest, isEmptyMessage, streamBlocks, unpackMapOutput } from "@substreams/core";
import type { NetworkSpec } from "./config.js";
import type { ConfiguredPackage } from "./spkg.js";
import { FeedState, observedOf } from "./state.js";
import type { BlockOutputJson, ObservedBlock } from "./types.js";

/**
 * The Graph Market caps a token at a small number of concurrent streams (two,
 * measured). Long-lived feeds and one-off range requests draw from this one
 * pool. Without it the third request would fail upstream with
 * ResourceExhausted after a retry storm; with it, the request fails fast and
 * says why.
 */
export class StreamSlots {
  private used = 0;
  private waiters: (() => void)[] = [];

  constructor(readonly capacity: number) {}

  get inUse(): number {
    return this.used;
  }

  /** Resolves to a release function, or null if no slot frees up within `waitMs`. */
  async tryAcquire(waitMs: number): Promise<(() => void) | null> {
    if (this.used < this.capacity) return this.take();
    if (waitMs <= 0) return null;
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        resolve(this.take());
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== wake);
        resolve(null);
      }, waitMs);
      this.waiters.push(wake);
    });
  }

  async acquire(signal?: AbortSignal): Promise<(() => void) | null> {
    while (!signal?.aborted) {
      const release = await this.tryAcquire(2_000);
      if (release) return release;
    }
    return null;
  }

  private take(): () => void {
    this.used++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.used--;
      const next = this.waiters.shift();
      if (next) next();
    };
  }
}

export type FeedStatus = "idle" | "waiting_for_slot" | "connecting" | "warming" | "live" | "backoff" | "stopped";

export type FeedErrorKind = "concurrent_stream_limit" | "auth" | "no_token" | "transport" | "fatal";

export interface FeedError {
  readonly kind: FeedErrorKind;
  readonly message: string;
  readonly at: string;
}

/** What a tool needs from a feed. A live NetworkFeed and a replayed recording both satisfy it. */
export interface FeedHandle {
  readonly spec: NetworkSpec;
  readonly state: FeedState;
  readonly status: FeedStatus;
  readonly lastError: FeedError | null;
  readonly outputModule: string;
  readonly moduleHash: string;
}

export function classify(error: unknown): FeedError {
  const at = new Date().toISOString();
  if (error instanceof ConnectError) {
    if (error.code === Code.ResourceExhausted) return { kind: "concurrent_stream_limit", message: error.rawMessage, at };
    if (error.code === Code.Unauthenticated || error.code === Code.PermissionDenied) {
      return { kind: "auth", message: error.rawMessage, at };
    }
    return { kind: "transport", message: `${Code[error.code]}: ${error.rawMessage}`, at };
  }
  return { kind: "fatal", message: (error as Error)?.message ?? String(error), at };
}

export interface StreamOptions {
  readonly spec: NetworkSpec;
  readonly configured: ConfiguredPackage;
  readonly token: string;
  readonly finalBlocksOnly: boolean;
  readonly startBlock?: bigint;
  readonly stopBlock?: bigint;
  readonly cursor?: string | null;
  readonly signal: AbortSignal;
  readonly onSession?: () => void;
  readonly onProgress?: () => void;
  readonly onBlock: (block: ObservedBlock, finalBlockHeight: bigint, cursor: string, out: BlockOutputJson | undefined) => void;
  readonly onUndo?: (lastValid: bigint, cursor: string) => void;
}

/**
 * One gRPC stream with a session manager and abort controller that it owns
 * outright. When the stream ends for any reason, both are torn down. Leaving
 * the loop is not enough on its own: connect-node keeps the HTTP/2 session
 * open, and the provider keeps counting it against the concurrency cap
 * (observed: two probes that had "finished" held both slots until their
 * processes were killed).
 */
export async function openStream(o: StreamOptions): Promise<void> {
  const session = new Http2SessionManager(o.spec.endpoint);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  o.signal.addEventListener("abort", onAbort, { once: true });
  try {
    // @substreams/core's declarations resolve connect and protobuf through
    // their CommonJS typings while this package resolves the ESM ones. The
    // runtime objects are identical, so the two casts below bridge typings,
    // not behaviour.
    const transport = createGrpcTransport({
      baseUrl: o.spec.endpoint,
      httpVersion: "2",
      sessionManager: session,
      interceptors: [createAuthInterceptor(o.token) as unknown as Interceptor],
      jsonOptions: { typeRegistry: o.configured.registry as never },
    }) as unknown as Parameters<typeof streamBlocks>[0];
    const request = createRequest({
      substreamPackage: o.configured.pkg,
      outputModule: o.configured.outputModule,
      productionMode: true,
      finalBlocksOnly: o.finalBlocksOnly,
      ...(o.cursor ? { startCursor: o.cursor } : { startBlockNum: o.startBlock ?? -300n }),
      ...(o.stopBlock !== undefined ? { stopBlockNum: o.stopBlock } : {}),
    });
    for await (const response of streamBlocks(transport, request, { signal: controller.signal })) {
      const msg = response.message;
      switch (msg.case) {
        case "session":
          o.onSession?.();
          break;
        case "progress":
          o.onProgress?.();
          break;
        case "blockScopedData": {
          const d = msg.value;
          const clock = d.clock;
          if (!clock) break;
          const out = unpackMapOutput(response, o.configured.registry);
          const json =
            out && !isEmptyMessage(out) ? (out.toJson({ typeRegistry: o.configured.registry }) as BlockOutputJson) : undefined;
          o.onBlock(observedOf(clock.number, clock.id, Number(clock.timestamp?.seconds ?? 0n)), d.finalBlockHeight, d.cursor, json);
          break;
        }
        case "blockUndoSignal":
          o.onUndo?.(msg.value.lastValidBlock?.number ?? 0n, msg.value.lastValidCursor);
          break;
        case "fatalError":
          throw new Error(`fatal: ${msg.value.reason}`);
        default:
          break;
      }
    }
  } finally {
    o.signal.removeEventListener("abort", onAbort);
    controller.abort();
    session.abort();
  }
}

export interface NetworkFeedOptions {
  readonly spec: NetworkSpec;
  readonly configured: ConfiguredPackage;
  readonly token: string | undefined;
  readonly slots: StreamSlots;
  readonly startBlocksBack: number;
  readonly maxPoints: number;
  readonly log?: (line: string) => void;
}

/** The long-lived stream for one network: holds a slot, reconnects from its cursor, types its failures. */
export class NetworkFeed implements FeedHandle {
  readonly state: FeedState;
  status: FeedStatus = "idle";
  lastError: FeedError | null = null;
  private readonly abort = new AbortController();
  private loop: Promise<void> | null = null;

  constructor(private readonly opts: NetworkFeedOptions) {
    this.state = new FeedState(opts.maxPoints);
  }

  get spec(): NetworkSpec {
    return this.opts.spec;
  }
  get outputModule(): string {
    return this.opts.configured.outputModule;
  }
  get moduleHash(): string {
    return this.opts.configured.moduleHash;
  }

  start(): void {
    if (!this.loop) this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.abort.abort();
    await this.loop?.catch(() => undefined);
    this.status = "stopped";
  }

  private log(line: string): void {
    this.opts.log?.(`[feed:${this.opts.spec.name}] ${line}`);
  }

  private async run(): Promise<void> {
    let backoffMs = 2_000;
    while (!this.abort.signal.aborted) {
      const token = this.opts.token;
      if (!token) {
        this.lastError = { kind: "no_token", message: "SUBSTREAMS_API_TOKEN is not set", at: new Date().toISOString() };
        this.status = "stopped";
        return;
      }
      this.status = "waiting_for_slot";
      const release = await this.opts.slots.acquire(this.abort.signal);
      if (!release) break;
      try {
        this.status = "connecting";
        const { spec, configured } = this.opts;
        this.log(
          `connecting ${spec.endpoint} ${configured.outputModule}@${configured.moduleHash.slice(0, 12)} final=${spec.finalBlocksOnly} ${this.state.cursor ? "from cursor" : `from head-${this.opts.startBlocksBack}`}`,
        );
        await openStream({
          spec,
          configured,
          token,
          finalBlocksOnly: spec.finalBlocksOnly,
          startBlock: -BigInt(this.opts.startBlocksBack),
          cursor: this.state.cursor,
          signal: this.abort.signal,
          onSession: () => (this.status = "warming"),
          onProgress: () => {
            if (this.status !== "live") this.status = "warming";
          },
          onBlock: (block, finalHeight, cursor, out) => {
            this.state.applyBlock(block, finalHeight, cursor, out);
            this.status = "live";
            this.lastError = null;
          },
          onUndo: (lastValid, cursor) => {
            const n = this.state.undoTo(lastValid, cursor);
            this.log(`reorg: rolled back ${n} block(s) to ${lastValid}`);
          },
        });
        backoffMs = 2_000;
      } catch (error) {
        if (this.abort.signal.aborted) break;
        this.lastError = classify(error);
        this.log(`stream ended: ${this.lastError.kind}: ${this.lastError.message}`);
        // A concurrency refusal clears when someone else's stream ends, not on
        // our retry cadence, so it waits longer.
        if (this.lastError.kind === "concurrent_stream_limit") backoffMs = Math.max(backoffMs, 15_000);
      } finally {
        release();
      }
      if (this.abort.signal.aborted) break;
      this.status = "backoff";
      await sleep(backoffMs, this.abort.signal);
      backoffMs = Math.min(backoffMs * 2, 60_000);
    }
    this.status = "stopped";
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}
