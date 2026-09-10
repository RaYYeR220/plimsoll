/**
 * The device authority.
 *
 * Everything privileged in Plimsoll -- halting a market, resuming it, moving the load line --
 * funnels through `signMandate`. There is exactly one way to obtain the signature those actions
 * need, and it runs through a physical approval on a Ledger.
 *
 * The class fails closed. Every path out of `signMandate` is a value, not an exception, and the
 * only value that carries a signature is the one where the device produced one *and* that
 * signature was recovered back to the address we expected before it was handed to the caller.
 * A device that is unplugged, a human who walks away, a firmware refusal and a transport error
 * are all the same thing to a caller: no signature.
 */

import {
  DeviceActionStatus,
  DeviceManagementKitBuilder,
  DeviceModelId,
  type DeviceActionState,
  type DeviceManagementKit,
  type DeviceSessionId,
} from "@ledgerhq/device-management-kit";
import {
  speculosIdentifier,
  speculosTransportFactory,
} from "@ledgerhq/device-transport-kit-speculos";
import { SignerEthBuilder } from "@ledgerhq/device-signer-kit-ethereum";
import { filter, firstValueFrom, type Observable } from "rxjs";

import {
  formatMandate,
  hashMandate,
  MandateFormatError,
  packSignature,
  recoverMandateSigner,
  type Hex,
  type Mandate,
} from "./mandate";

/** Firmware status word for "the human pressed Reject". */
export const SW_CONDITIONS_NOT_SATISFIED = "6985";

export const DEFAULT_DERIVATION_PATH = "44'/60'/0'/0/0";
export const DEFAULT_TRANSPORT_URL = "http://127.0.0.1:5000";

/**
 * Address at m/44'/60'/0'/0/0 for the Speculos test mnemonic that ships with the emulator.
 * It is a published test vector, not a secret, and it is the default only because this package
 * is wired to Speculos out of the box. Point PLIMSOLL_LEDGER_ADDRESS at a real device before
 * this authority guards anything that matters.
 */
export const SPECULOS_TEST_ADDRESS = "0xDad77910DbDFdE764fC21FCD4E74D71bBACA6D8D" as Hex;

export type LedgerModel = "nanosp" | "nanox" | "nanos" | "stax" | "flex";

const MODEL_IDS: Record<LedgerModel, DeviceModelId> = {
  nanos: DeviceModelId.NANO_S,
  nanosp: DeviceModelId.NANO_SP,
  nanox: DeviceModelId.NANO_X,
  stax: DeviceModelId.STAX,
  flex: DeviceModelId.FLEX,
};

export interface DeviceAuthorityConfig {
  /** Speculos REST endpoint, or a DMK transport URL for a real device bridge. */
  transportUrl: string;
  derivationPath: string;
  /** The only key allowed to authorise. Checked before signing and again after. */
  expectedAddress: Hex;
  model: LedgerModel;
  connectTimeoutMs: number;
  /** How long a human gets to decide. Generous by default; the operation is cancelled after. */
  signTimeoutMs: number;
}

export type RefusalReason = "refused" | "timeout" | "device-error" | "address-mismatch";

export interface MandateAttestation {
  readonly mandate: Mandate;
  /** The exact bytes shown on the device. Keep it: it is the audit record. */
  readonly message: string;
  readonly digest: Hex;
  /** 65 packed bytes, ready for MandateVerifier. */
  readonly signature: Hex;
  readonly rsv: { r: Hex; s: Hex; v: number };
  readonly authority: Hex;
}

export type SignResult =
  | { readonly ok: true; readonly attestation: MandateAttestation }
  | { readonly ok: false; readonly reason: RefusalReason; readonly detail: string };

export type AddressResult =
  | { readonly ok: true; readonly address: Hex }
  | { readonly ok: false; readonly reason: RefusalReason; readonly detail: string };

function envInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer, got ${raw}`);
  return n;
}

function envModel(raw: string | undefined): LedgerModel {
  if (raw === undefined || raw === "") return "nanosp";
  const key = raw.toLowerCase();
  if (!(key in MODEL_IDS)) {
    throw new Error(`PLIMSOLL_LEDGER_MODEL must be one of ${Object.keys(MODEL_IDS).join(", ")}, got ${raw}`);
  }
  return key as LedgerModel;
}

export function configFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<DeviceAuthorityConfig> = {},
): DeviceAuthorityConfig {
  return {
    transportUrl: env.PLIMSOLL_LEDGER_URL || DEFAULT_TRANSPORT_URL,
    derivationPath: env.PLIMSOLL_LEDGER_PATH || DEFAULT_DERIVATION_PATH,
    expectedAddress: ((env.PLIMSOLL_LEDGER_ADDRESS || SPECULOS_TEST_ADDRESS) as Hex),
    model: envModel(env.PLIMSOLL_LEDGER_MODEL),
    connectTimeoutMs: envInt(env.PLIMSOLL_LEDGER_CONNECT_TIMEOUT_MS, 20_000, "PLIMSOLL_LEDGER_CONNECT_TIMEOUT_MS"),
    signTimeoutMs: envInt(env.PLIMSOLL_LEDGER_SIGN_TIMEOUT_MS, 120_000, "PLIMSOLL_LEDGER_SIGN_TIMEOUT_MS"),
    ...overrides,
  };
}

/** DMK operations are `{ observable, cancel }`; this collapses one to a settled value. */
type ActionOutcome<T> =
  | { kind: "completed"; output: T }
  | { kind: "error"; error: unknown }
  | { kind: "stopped" }
  | { kind: "timeout" };

const TERMINAL_STATES: ReadonlySet<DeviceActionStatus> = new Set([
  DeviceActionStatus.Completed,
  DeviceActionStatus.Error,
  DeviceActionStatus.Stopped,
]);

/** Shape of every DMK operation, narrowed to the two members this module uses. */
interface PendingDeviceAction<Output> {
  readonly observable: Observable<DeviceActionState<Output, unknown, unknown>>;
  cancel(): void;
}

/**
 * The observable emits a state per step of the flow and never completes on its own, so it has to
 * be cut at the first terminal state. `Stopped` is in that set as well as the obvious two: if the
 * action is cancelled by anything other than our own timer, this settles instead of hanging.
 */
async function settle<T>(action: PendingDeviceAction<T>, timeoutMs: number): Promise<ActionOutcome<T>> {
  const finished = firstValueFrom(
    action.observable.pipe(filter((state) => TERMINAL_STATES.has(state.status))),
  ).then((state): ActionOutcome<T> => {
    if (state.status === DeviceActionStatus.Completed) return { kind: "completed", output: state.output };
    if (state.status === DeviceActionStatus.Stopped) return { kind: "stopped" };
    if (state.status === DeviceActionStatus.Error) return { kind: "error", error: state.error };
    return { kind: "error", error: new Error(`device action settled in an unexpected state: ${state.status}`) };
  });
  // The race below can leave this promise unobserved; without a sink a late rejection would
  // surface as an unhandled rejection long after the caller already got its refusal.
  const guarded = finished.catch((error: unknown): ActionOutcome<T> => ({ kind: "error", error }));

  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<ActionOutcome<T>>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
  });

  try {
    const outcome = await Promise.race([guarded, expiry]);
    if (outcome.kind === "timeout") {
      try {
        action.cancel();
      } catch {
        // Cancelling a device action that already settled is not interesting; the caller is
        // getting a timeout either way.
      }
    }
    return outcome;
  } finally {
    clearTimeout(timer);
  }
}

/** Pull whatever identifying detail an unknown DMK error carries, without assuming its class. */
function describeError(error: unknown): string {
  if (error === null || error === undefined) return "unknown device error";
  if (typeof error === "string") return error;
  const bag = error as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ["_tag", "errorCode", "message"]) {
    const value = bag[key];
    if (typeof value === "string" || typeof value === "number") parts.push(`${key}=${value}`);
  }
  if (parts.length > 0) return parts.join(" ");
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function statusWord(error: unknown): string | undefined {
  const bag = error as Record<string, unknown> | null;
  const code = bag?.errorCode;
  if (typeof code === "string") return code.toLowerCase();
  const nested = (bag?.error ?? bag?.originalError) as Record<string, unknown> | undefined;
  const nestedCode = nested?.errorCode;
  return typeof nestedCode === "string" ? nestedCode.toLowerCase() : undefined;
}

/**
 * 6985 is the firmware saying a human declined. Everything else is a device fault.
 *
 * This branches on the error's shape rather than `instanceof EthAppCommandError`, because that
 * class and the `EthErrorCodes` union are not part of the Ethereum signer's public exports --
 * they live under `lib/types/internal/app-binder/command/utils/ethAppErrors`. Reaching into a
 * dependency's internals to identify the one status word a human-in-the-loop integration must
 * branch on is worse than reading two string fields.
 */
export function classifyDeviceError(error: unknown): { reason: RefusalReason; detail: string } {
  const detail = describeError(error);
  const sw = statusWord(error);
  if (sw === SW_CONDITIONS_NOT_SATISFIED || detail.includes(`errorCode=${SW_CONDITIONS_NOT_SATISFIED}`)) {
    return { reason: "refused", detail };
  }
  return { reason: "device-error", detail };
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

type SignerEth = ReturnType<SignerEthBuilder["build"]>;

type Refusal = { ok: false; reason: RefusalReason; detail: string };

export class DeviceAuthority {
  readonly config: DeviceAuthorityConfig;

  private dmk: DeviceManagementKit | undefined;
  private sessionId: DeviceSessionId | undefined;
  private signer: SignerEth | undefined;

  constructor(config: DeviceAuthorityConfig) {
    this.config = config;
  }

  static fromEnv(
    env: NodeJS.ProcessEnv = process.env,
    overrides: Partial<DeviceAuthorityConfig> = {},
  ): DeviceAuthority {
    return new DeviceAuthority(configFromEnv(env, overrides));
  }

  get expectedAddress(): Hex {
    return this.config.expectedAddress;
  }

  /** Establish the session up front, so a UI can show connection state before it needs to sign. */
  async connect(): Promise<{ ok: true } | Refusal> {
    const ready = await this.ensureSigner();
    return ready.ok ? { ok: true } : ready;
  }

  /** Idempotent. Returns a refusal rather than throwing so callers have one shape to handle. */
  private async ensureSigner(): Promise<{ ok: true; signer: SignerEth } | Refusal> {
    if (this.signer) return { ok: true, signer: this.signer };
    try {
      const dmk = new DeviceManagementKitBuilder()
        .addTransport(
          speculosTransportFactory(this.config.transportUrl, false, MODEL_IDS[this.config.model]),
        )
        .build();
      this.dmk = dmk;

      const discovery = firstValueFrom(dmk.startDiscovering({ transport: speculosIdentifier }));
      const device = await withTimeout(discovery, this.config.connectTimeoutMs, "discovery");
      const sessionId = await withTimeout(
        dmk.connect({ device }),
        this.config.connectTimeoutMs,
        "connect",
      );

      const signer = new SignerEthBuilder({ dmk, sessionId }).build();
      this.sessionId = sessionId;
      this.signer = signer;
      return { ok: true, signer };
    } catch (error) {
      await this.close();
      const detail = describeError(error);
      return { ok: false, reason: detail.includes("timed out") ? "timeout" : "device-error", detail };
    }
  }

  /**
   * Read the address at the configured path. `checkOnDevice` asks the human to confirm it;
   * the pre-sign binding check below deliberately does not, because a confirmation prompt there
   * would train the operator to click through the screen that precedes the one that matters.
   */
  async getAddress(options: { checkOnDevice?: boolean } = {}): Promise<AddressResult> {
    const ready = await this.ensureSigner();
    if (!ready.ok) return ready;

    const outcome = await settle<{ address: string }>(
      ready.signer.getAddress(this.config.derivationPath, {
        checkOnDevice: options.checkOnDevice ?? false,
      }),
      this.config.connectTimeoutMs,
    );

    if (outcome.kind === "timeout") {
      return { ok: false, reason: "timeout", detail: "device did not return an address in time" };
    }
    if (outcome.kind === "stopped") {
      return { ok: false, reason: "device-error", detail: "device action was stopped before it returned an address" };
    }
    if (outcome.kind === "error") return { ok: false, ...classifyDeviceError(outcome.error) };

    const address = outcome.output?.address;
    if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
      return { ok: false, reason: "device-error", detail: `device returned no usable address: ${String(address)}` };
    }
    return { ok: true, address: address as Hex };
  }

  /**
   * Put a mandate in front of a human and return what they decided.
   *
   * Order matters: the signer is bound *before* anything is displayed, so a device holding the
   * wrong key never gets shown a mandate at all, and the recovered address is checked *after*,
   * so a signature that does not belong to the expected authority never leaves this method.
   */
  async signMandate(mandate: Mandate): Promise<SignResult> {
    let message: string;
    try {
      message = formatMandate(mandate);
    } catch (error) {
      if (!(error instanceof MandateFormatError)) throw error;
      return {
        ok: false,
        reason: "device-error",
        detail: `mandate rejected before reaching the device: ${error.message}`,
      };
    }

    const ready = await this.ensureSigner();
    if (!ready.ok) return ready;

    const bound = await this.getAddress();
    if (!bound.ok) return bound;
    if (!sameAddress(bound.address, this.config.expectedAddress)) {
      return {
        ok: false,
        reason: "address-mismatch",
        detail: `device holds ${bound.address}, authority is ${this.config.expectedAddress}`,
      };
    }

    const outcome = await settle<{ r: string; s: string; v: number }>(
      ready.signer.signMessage(this.config.derivationPath, message),
      this.config.signTimeoutMs,
    );

    if (outcome.kind === "timeout") {
      return {
        ok: false,
        reason: "timeout",
        detail: `no decision within ${this.config.signTimeoutMs}ms; device action cancelled`,
      };
    }
    if (outcome.kind === "stopped") {
      return { ok: false, reason: "device-error", detail: "device action was stopped before a decision was made" };
    }
    if (outcome.kind === "error") return { ok: false, ...classifyDeviceError(outcome.error) };

    const raw = outcome.output;
    if (!raw || typeof raw.r !== "string" || typeof raw.s !== "string" || typeof raw.v !== "number") {
      return { ok: false, reason: "device-error", detail: `malformed signature from device: ${JSON.stringify(raw)}` };
    }

    let signature: Hex;
    try {
      signature = packSignature(raw);
    } catch (error) {
      return { ok: false, reason: "device-error", detail: describeError(error) };
    }

    const recovered = recoverMandateSigner(mandate, signature);
    if (!sameAddress(recovered, this.config.expectedAddress)) {
      return {
        ok: false,
        reason: "address-mismatch",
        detail: `signature recovers to ${recovered}, authority is ${this.config.expectedAddress}`,
      };
    }

    return {
      ok: true,
      attestation: {
        mandate,
        message,
        digest: hashMandate(mandate),
        signature,
        rsv: { r: raw.r as Hex, s: raw.s as Hex, v: raw.v },
        authority: this.config.expectedAddress,
      },
    };
  }

  async close(): Promise<void> {
    const { dmk, sessionId } = this;
    this.signer = undefined;
    this.sessionId = undefined;
    this.dmk = undefined;
    if (!dmk) return;
    try {
      dmk.stopDiscovering();
    } catch {
      // Discovery may already have been stopped by a successful connect.
    }
    if (sessionId) await dmk.disconnect({ sessionId }).catch(() => undefined);
    try {
      dmk.close();
    } catch {
      // Closing an already-closed kit is not an error worth propagating from a teardown path.
    }
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
