import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import type { Verdict } from "./attest.js";

/**
 * Per-request state shared with the x402 hooks.
 *
 * The settle and cancel hooks fire inside the payment middleware, after our
 * handler has already produced a verdict, and they are handed protocol objects
 * rather than the HTTP request. Async-local storage is what lets a hook find
 * the verdict its settlement belongs to without a global map keyed on something
 * that could collide between concurrent buyers.
 */
export interface RequestContext {
  requestId: string;
  requestedAt: number;
  verdict: Verdict | null;
  payer: string | null;
  /** Settlement id, filled in by the after-settle hook. */
  chargeTransactionId: string | null;
  /** Set when the middleware cancels settlement, with the reason it gave. */
  cancellation: { reason: string; responseStatus?: number } | null;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function newRequestId(): string {
  return randomBytes(8).toString("hex");
}

export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}
