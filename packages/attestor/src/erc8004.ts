import {
  createPublicClient,
  encodeFunctionData,
  createWalletClient,
  defineChain,
  http,
  keccak256,
  parseAbi,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * ERC-8004 on Hedera testnet.
 *
 * These registries are already deployed; nothing here deploys anything. The
 * addresses are ERC-1967 proxies, which is why the ABI below was taken from the
 * implementation behind each proxy rather than from any published interface:
 * forks of this standard disagree about `giveFeedback`, and only the deployed
 * bytecode settles it. Selector 0x3c036a7e is what is actually callable at
 * REPUTATION_REGISTRY.
 */
export const HEDERA_TESTNET_CHAIN_ID = 296;
export const IDENTITY_REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e" as const;
export const REPUTATION_REGISTRY = "0x8004B663056A597Dffe9eCcC1965A193B7388713" as const;
export const VALIDATION_REGISTRY = "0x8004Cb1BF31DAf7788923b405b754f57acEB4272" as const;

export const IDENTITY_ABI = parseAbi([
  "function register(string agentURI) returns (uint256)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
]);

export const REPUTATION_ABI = parseAbi([
  "function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)",
  "function getClients(uint256 agentId) view returns (address[])",
]);

export const hederaTestnet = defineChain({
  id: HEDERA_TESTNET_CHAIN_ID,
  name: "Hedera Testnet",
  nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
  rpcUrls: { default: { http: ["https://testnet.hashio.io/api"] } },
  blockExplorers: { default: { name: "HashScan", url: "https://hashscan.io/testnet" } },
});

export interface Erc8004ClientOptions {
  privateKey: Hex;
  rpcUrl?: string;
}

export interface Erc8004Client {
  address: Address;
  publicClient: PublicClient;
  walletClient: WalletClient;
}

export function createErc8004Client(options: Erc8004ClientOptions): Erc8004Client {
  const chain = options.rpcUrl
    ? defineChain({ ...hederaTestnet, rpcUrls: { default: { http: [options.rpcUrl] } } })
    : hederaTestnet;
  const account = privateKeyToAccount(normaliseKey(options.privateKey));
  const transport = http(options.rpcUrl ?? hederaTestnet.rpcUrls.default.http[0]);
  return {
    address: account.address,
    publicClient: createPublicClient({ chain, transport }) as PublicClient,
    walletClient: createWalletClient({ account, chain, transport }),
  };
}

/**
 * Hedera's JSON-RPC relay prices gas differently from mainnet Ethereum and its
 * estimator is conservative. Explicit gas limits and a padded legacy gas price
 * avoid the two failure modes that look identical from the outside: a silent
 * revert on out-of-gas, and a relay rejection for underpriced transactions.
 */
async function gasPriceWithHeadroom(client: PublicClient): Promise<bigint> {
  const price = await client.getGasPrice();
  return (price * 12n) / 10n;
}

export interface RegisterResult {
  transactionHash: Hex;
  agentId: bigint | null;
  gasUsed: bigint;
}

/** Register the service once. `agentURI` should resolve to our registration file. */
export async function registerAgent(
  client: Erc8004Client,
  agentURI: string,
): Promise<RegisterResult> {
  const gasPrice = await gasPriceWithHeadroom(client.publicClient);
  const hash = await client.walletClient.writeContract({
    account: client.walletClient.account!,
    chain: client.walletClient.chain,
    address: IDENTITY_REGISTRY,
    abi: IDENTITY_ABI,
    functionName: "register",
    args: [agentURI],
    gas: 4_000_000n,
    gasPrice,
  });
  const receipt = await client.publicClient.waitForTransactionReceipt({ hash });

  // The agent id is the minted token id. Reading it from the ERC-721 Transfer
  // log rather than the return value works whether or not the proxy surfaces
  // return data.
  const transferTopic = keccak256(toHex("Transfer(address,address,uint256)"));
  const minted = receipt.logs.find(
    (log) =>
      log.address.toLowerCase() === IDENTITY_REGISTRY.toLowerCase() &&
      log.topics[0] === transferTopic &&
      log.topics.length === 4,
  );
  const agentId = minted?.topics[3] ? BigInt(minted.topics[3]) : null;

  return { transactionHash: hash, agentId, gasUsed: receipt.gasUsed };
}

/** The off-chain feedback file ERC-8004 references from `feedbackURI`. */
export interface FeedbackFile {
  type: string;
  agentURI: string;
  endpoint: string;
  outcome: string;
  noteId: string;
  coverageBps: number | null;
  requestId: string;
  attestationSignature: string;
  sourceHash: string;
  proofOfPayment: {
    fromAddress: string;
    toAddress: string;
    chainId: string;
    txHash: string;
  };
}

export interface GiveFeedbackParams {
  agentId: bigint;
  /** Signed fixed-point score. With `valueDecimals` 0 this is a plain integer. */
  value: bigint;
  valueDecimals: number;
  tag1: string;
  tag2: string;
  endpoint: string;
  feedback: FeedbackFile;
}

export interface FeedbackResult {
  transactionHash: Hex;
  feedbackURI: string;
  feedbackHash: Hex;
  gasUsed: bigint;
}

/**
 * Post feedback with the proof of payment inline.
 *
 * `feedbackURI` is a `data:` URI rather than a hosted URL on purpose. The whole
 * point of the artifact is that a stranger can audit it later; a link to a
 * server we control is a link we could change or take down, whereas calldata is
 * permanent and the `feedbackHash` over it is checkable without fetching
 * anything.
 */
export async function giveFeedback(
  client: Erc8004Client,
  params: GiveFeedbackParams,
): Promise<FeedbackResult> {
  const json = JSON.stringify(params.feedback);
  const feedbackURI = `data:application/json;base64,${Buffer.from(json, "utf8").toString("base64")}`;
  const feedbackHash = keccak256(toHex(json));

  const gasPrice = await gasPriceWithHeadroom(client.publicClient);
  const hash = await client.walletClient.writeContract({
    account: client.walletClient.account!,
    chain: client.walletClient.chain,
    address: REPUTATION_REGISTRY,
    abi: REPUTATION_ABI,
    functionName: "giveFeedback",
    args: [
      params.agentId,
      params.value,
      params.valueDecimals,
      params.tag1,
      params.tag2,
      params.endpoint,
      feedbackURI,
      feedbackHash,
    ],
    gas: 1_200_000n,
    gasPrice,
  });
  const receipt = await client.publicClient.waitForTransactionReceipt({ hash });
  return { transactionHash: hash, feedbackURI, feedbackHash, gasUsed: receipt.gasUsed };
}

/**
 * Post the same feedback natively over HAPI instead of the JSON-RPC relay.
 *
 * A Hedera account only gets a key-derived EVM address if it was created with
 * an alias. An account created from an ECDSA key *without* one keeps the
 * long-zero address `0x...<account num>`, and the relay then rejects any
 * transaction claiming the key-derived address with "Sender account not found"
 * — the account is real, it simply has no EVM identity to send from. That is
 * not something the sender can fix afterwards: an alias cannot be added to an
 * existing account.
 *
 * A native `ContractExecuteTransaction` is signed with the Hedera key and
 * needs no alias at all, so it works for either kind of account. `msg.sender`
 * inside the contract is then the account's long-zero address, which is its
 * canonical EVM identity on Hedera.
 */
export async function giveFeedbackViaHapi(params: {
  accountId: string;
  privateKey: string;
  network: "testnet" | "mainnet";
  feedback: GiveFeedbackParams;
  gas?: number;
}): Promise<{ transactionId: string; feedbackURI: string; feedbackHash: Hex; status: string }> {
  const { ContractExecuteTransaction, ContractId, Client, PrivateKey } = await import(
    "@hiero-ledger/sdk"
  );

  const json = JSON.stringify(params.feedback.feedback);
  const feedbackURI = `data:application/json;base64,${Buffer.from(json, "utf8").toString("base64")}`;
  const feedbackHash = keccak256(toHex(json));

  const calldata = encodeFunctionData({
    abi: REPUTATION_ABI,
    functionName: "giveFeedback",
    args: [
      params.feedback.agentId,
      params.feedback.value,
      params.feedback.valueDecimals,
      params.feedback.tag1,
      params.feedback.tag2,
      params.feedback.endpoint,
      feedbackURI,
      feedbackHash,
    ],
  });

  const client = params.network === "mainnet" ? Client.forMainnet() : Client.forTestnet();
  client.setOperator(
    params.accountId,
    PrivateKey.fromStringECDSA(
      params.privateKey.startsWith("0x") ? params.privateKey.slice(2) : params.privateKey,
    ),
  );

  try {
    const response = await new ContractExecuteTransaction()
      .setContractId(ContractId.fromEvmAddress(0, 0, REPUTATION_REGISTRY))
      .setGas(params.gas ?? 1_500_000)
      // Raw ABI calldata, selector included. Without a preceding setFunction()
      // the SDK sends these bytes verbatim, which is what lets viem do the
      // encoding while Hedera does the signing.
      .setFunctionParameters(Buffer.from(calldata.slice(2), "hex"))
      .execute(client);
    const receipt = await response.getReceipt(client);
    return {
      transactionId: response.transactionId.toString(),
      feedbackURI,
      feedbackHash,
      status: receipt.status.toString(),
    };
  } finally {
    client.close();
  }
}

/** Decode a `data:` feedback URI back to its JSON, for verification. */
export function decodeFeedbackURI(uri: string): FeedbackFile {
  const marker = "base64,";
  const index = uri.indexOf(marker);
  if (index < 0) throw new Error("not a base64 data URI");
  return JSON.parse(Buffer.from(uri.slice(index + marker.length), "base64").toString("utf8"));
}

function normaliseKey(key: string): Hex {
  return (key.startsWith("0x") ? key : `0x${key}`) as Hex;
}
