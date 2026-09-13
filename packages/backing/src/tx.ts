import {
  createWalletClient,
  encodeAbiParameters,
  http,
  keccak256,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { ERC20_ABI } from "./chain.js";
import { BASE_CHAIN_ID, BASESCAN, type TokenSpec } from "./config.js";
import { formatDecimal } from "./liabilities.js";

/** What an earlier step in the same run will have established by the time this one runs. */
export interface Needs {
  readonly token?: TokenSpec;
  readonly balance?: bigint;
  readonly spender?: Address;
  readonly allowance?: bigint;
}

export interface Step {
  readonly label: string;
  readonly to: Address;
  readonly data: Hex;
  readonly value: bigint;
  readonly needs: Needs;
}

export interface Simulation {
  readonly step: Step;
  readonly ok: boolean;
  readonly gas: bigint | null;
  readonly error: string | null;
  /** Everything the simulation had to assume. Empty means it ran on real state alone. */
  readonly assumed: readonly string[];
}

export function mappingSlot(key: Address, slot: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [key, slot]));
}

/** `mapping(owner => mapping(spender => amount))` at `slot`. */
export function nestedMappingSlot(owner: Address, spender: Address, slot: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [spender, mappingSlot(owner, slot)]));
}

type Overrides = Record<string, { balance?: Hex; stateDiff?: Record<string, Hex> }>;

function setSlot(overrides: Overrides, address: Address, slot: Hex, value: bigint): void {
  const entry = (overrides[address] ??= {});
  entry.stateDiff = { ...(entry.stateDiff ?? {}), [slot]: toHex(value, { size: 32 }) };
}

/**
 * Runs a step with `eth_call` and `eth_estimateGas` against the chain, without
 * sending it.
 *
 * A step that depends on an earlier one (a deposit needs its approval, a WETH
 * deposit needs its wrap) is simulated with that earlier effect written into a
 * state override, and the override is reported. Nothing is assumed silently.
 */
export async function simulate(client: PublicClient, from: Address, step: Step): Promise<Simulation> {
  const assumed: string[] = [];
  const overrides: Overrides = {};
  const { token, balance, spender, allowance } = step.needs;

  if (token && balance !== undefined) {
    const held = await client.readContract({ address: token.address, abi: ERC20_ABI, functionName: "balanceOf", args: [from] });
    if (held < balance) {
      setSlot(overrides, token.address, mappingSlot(from, token.balanceSlot), balance);
      assumed.push(
        `a ${token.symbol} balance of ${formatDecimal(balance, token.decimals)} (the wallet holds ${formatDecimal(held, token.decimals)})`,
      );
    }
  }
  if (token && spender && allowance !== undefined) {
    const current = await client.readContract({
      address: token.address,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [from, spender],
    });
    if (current < allowance) {
      setSlot(overrides, token.address, nestedMappingSlot(from, spender, token.allowanceSlot), allowance);
      assumed.push("the approval before it has landed");
    }
  }
  if (step.value > 0n) {
    const held = await client.getBalance({ address: from });
    if (held < step.value) {
      const funded = step.value + 10n ** 16n;
      (overrides[from] ??= {}).balance = toHex(funded);
      assumed.push(`an ETH balance of ${formatDecimal(funded, 18)} (the wallet holds ${formatDecimal(held, 18)})`);
    }
  }

  const tx = { from, to: step.to, data: step.data, value: toHex(step.value) };
  const params = Object.keys(overrides).length > 0 ? [tx, "latest", overrides] : [tx, "latest"];
  try {
    await client.request({ method: "eth_call", params } as never);
    const gas = BigInt((await client.request({ method: "eth_estimateGas", params } as never)) as Hex);
    return { step, ok: true, gas, error: null, assumed };
  } catch (error) {
    return { step, ok: false, gas: null, error: shortError(error), assumed };
  }
}

export interface Sender {
  readonly address: Address;
  readonly how: string;
  /**
   * @param gas - Gas limit to send with, already buffered. A bare estimate is
   *   not enough: a vault's routing can cost more by the time the transaction
   *   executes than it did when the estimate was taken, and the difference
   *   comes back as an out-of-gas revert that has already paid its fee.
   */
  send(step: Step, nonce: number, gas: bigint): Promise<Hex>;
}

/**
 * How much room to leave above the estimate: the limit is twice it.
 *
 * A quarter was not enough. A MetaMorpho vault walks its market queue on every
 * deposit and redeem, and each market not yet accrued in the block the
 * transaction lands in costs storage writes that an estimate taken one block
 * earlier never paid. Redeems failed right at a 25% limit on a fork of Base, in
 * two cycles out of five. Only gas used is charged, so the extra headroom costs
 * nothing unless it is needed, and at Base's fees a doubled limit is still a
 * fraction of a cent to hold.
 */
export const GAS_BUFFER_PERCENT = 100n;

/**
 * The real signer. The key is read from the environment at the moment of
 * sending and is never printed, logged or echoed, even in an error; a key that
 * derives to anything other than the holder is refused before any call.
 */
export function signerFromEnv(env: NodeJS.ProcessEnv, holder: Address, rpc: string): Sender {
  const name = (env.HOLDER_PRIVATE_KEY ?? "").trim() ? "HOLDER_PRIVATE_KEY" : "HEDERA_PRIVATE_KEY";
  const raw = (env[name] ?? "").trim();
  if (!raw) {
    throw new Error("--send needs HOLDER_PRIVATE_KEY (or HEDERA_PRIVATE_KEY) in the environment; load it with node --env-file");
  }
  const hex = (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) throw new Error(`${name} is not a 32-byte secp256k1 key in hex`);
  const account = privateKeyToAccount(hex);
  if (account.address.toLowerCase() !== holder.toLowerCase()) {
    throw new Error(`${name} derives to ${account.address}, not the holder ${holder}; refusing to send`);
  }
  const wallet = createWalletClient({ account, chain: base, transport: http(rpc) });
  return {
    address: account.address,
    how: `signed locally with ${name}`,
    send: (step, nonce, gas) =>
      wallet.sendTransaction({ account, chain: base, to: step.to, data: step.data, value: step.value, nonce, gas }),
  };
}

/** Sends as the holder on a local anvil fork, with no key at all. Refuses anything that is not anvil. */
export async function impersonatedSender(client: PublicClient, holder: Address, rpc: string): Promise<Sender> {
  const version = String(await client.request({ method: "web3_clientVersion" } as never));
  if (!/anvil/i.test(version)) {
    throw new Error(`--impersonate only works against a local anvil fork; ${rpc} reports "${version}"`);
  }
  await client.request({ method: "anvil_impersonateAccount", params: [holder] } as never);
  const wallet = createWalletClient({ account: holder, chain: base, transport: http(rpc) });
  return {
    address: holder,
    how: "impersonated on a local anvil fork",
    send: (step, nonce, gas) =>
      wallet.sendTransaction({
        account: holder,
        chain: base,
        to: step.to,
        data: step.data,
        value: step.value,
        nonce,
        gas,
      }),
  };
}

export interface Sent {
  readonly label: string;
  readonly hash: Hex;
  readonly link: string;
  readonly gasUsed: bigint;
  readonly status: "success" | "reverted";
}

export class RunAborted extends Error {
  readonly sent: readonly Sent[];
  constructor(label: string, why: string, sent: readonly Sent[]) {
    super(`stopped before "${label}": ${why}`);
    this.name = "RunAborted";
    this.sent = sent;
  }
}

/**
 * Sends steps one at a time. Each is simulated against real state first, with
 * no assumptions, and only sent if that passes; each must be mined successfully
 * before the next is considered. Public endpoints can lag a block behind a
 * receipt, so a failing pre-check is retried briefly before the run stops.
 */
export async function run(client: PublicClient, sender: Sender, steps: readonly Step[]): Promise<Sent[]> {
  const chainId = await client.getChainId();
  if (chainId !== BASE_CHAIN_ID) throw new Error(`refusing to send on chain ${chainId}; expected Base (${BASE_CHAIN_ID})`);

  let nonce = await client.getTransactionCount({ address: sender.address, blockTag: "pending" });
  const sent: Sent[] = [];
  for (const step of steps) {
    let check = await simulate(client, sender.address, { ...step, needs: {} });
    for (let attempt = 0; !check.ok && attempt < 5; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      check = await simulate(client, sender.address, { ...step, needs: {} });
    }
    if (!check.ok) throw new RunAborted(step.label, check.error ?? "simulation failed", sent);

    const estimate = await client.estimateGas({
      account: sender.address,
      to: step.to,
      data: step.data,
      value: step.value,
    });
    const hash = await sender.send(step, nonce, (estimate * (100n + GAS_BUFFER_PERCENT)) / 100n);
    nonce += 1;
    const receipt = await client.waitForTransactionReceipt({ hash, pollingInterval: 1_000, timeout: 180_000 });
    const record: Sent = {
      label: step.label,
      hash,
      link: `${BASESCAN}/tx/${hash}`,
      gasUsed: receipt.gasUsed,
      status: receipt.status,
    };
    sent.push(record);
    if (receipt.status !== "success") {
      // "It reverted" is not an answer an operator can act on. Replay the same
      // call against the state it ran on and report what the contract said.
      throw new RunAborted(step.label, `mined but reverted (${hash}): ${await revertReason(client, sender.address, step, receipt.blockNumber)}`, sent);
    }
  }
  return sent;
}

/** Replays a transaction one block before it was mined, to recover its revert reason. */
async function revertReason(
  client: PublicClient,
  from: Address,
  step: Step,
  minedIn: bigint,
): Promise<string> {
  try {
    await client.request({
      method: "eth_call",
      params: [
        { from, to: step.to, data: step.data, value: toHex(step.value) },
        toHex(minedIn - 1n),
      ],
    } as never);
    return "the same call succeeds against the block before it, so the state moved under it";
  } catch (error) {
    return shortError(error);
  }
}

export function shortError(error: unknown): string {
  const e = error as { shortMessage?: string; details?: string; message?: string };
  return [e.shortMessage, e.details].filter(Boolean).join(": ") || e.message || String(error);
}
