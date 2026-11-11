// src/near/vault.ts
// Agent Vault: create a vault account with no full-access key, and talk to it.
import fs from 'fs-extra';
import path from 'path';
import { Account, KeyPair, actions, teraToGas } from 'near-api-js';
import type { KeyPairString } from 'near-api-js';
import { NearNetwork, provider, isValidAccountId, formatNear } from './config';

export const AGENT_METHODS = ['pay', 'request_approval'];
/** Gas allowance of the agent key, matches AGENT_KEY_ALLOWANCE in the contract */
export const AGENT_KEY_ALLOWANCE = 250_000_000_000_000_000_000_000n; // 0.25 NEAR

export type ContractName = 'agent_vault' | 'apix_attestations' | 'apix_fungible_token';

export function contractWasmPath(name: ContractName): string {
  // dist/near/vault.js and src/near/vault.ts both sit two levels below the package root
  return path.join(__dirname, '..', '..', 'contracts', 'res', `${name}.wasm`);
}

export async function loadWasm(name: ContractName): Promise<Uint8Array> {
  const file = contractWasmPath(name);
  if (!await fs.pathExists(file)) {
    throw new Error(
      `${name}.wasm not found at ${file}.\n` +
      'Build it with: cd contracts/' + ({ agent_vault: 'agent-vault', apix_attestations: 'attestations', apix_fungible_token: 'fungible-token' })[name] +
      ' && cargo near build non-reproducible-wasm, then copy target/near/*.wasm to contracts/res/.'
    );
  }
  return new Uint8Array(await fs.readFile(file));
}

export interface VaultPolicyInput {
  perTxLimit: bigint;
  dailyLimit: bigint;
  allowlist: string[];
}

/** NEAR charges 1e19 yocto per byte of account storage (1 NEAR per 100 kB) */
export const STORAGE_PRICE_PER_BYTE = 10_000_000_000_000_000_000n;
/** Keys, state and account record on top of the code, with headroom */
const STATE_HEADROOM_BYTES = 5_000n;
/** Matches GAS_RESERVE in the contract, plus room for the agent key's gas */
const OPERATING_RESERVE = 150_000_000_000_000_000_000_000n; // 0.15 NEAR

/** What must be sent on top of the spendable amount: storage for the code and state, and a gas reserve */
export function vaultOverhead(wasmBytes: number): bigint {
  return (BigInt(wasmBytes) + STATE_HEADROOM_BYTES) * STORAGE_PRICE_PER_BYTE + OPERATING_RESERVE;
}

export interface CreateVaultResult {
  vaultId: string;
  /** Total NEAR moved into the vault (spendable + overhead) */
  transferred: bigint;
  overhead: bigint;
  txHash: string;
  agentPublicKey: string;
  agentPrivateKey: KeyPairString;
}

/**
 * One transaction, signed by the owner, sent to a new sub-account:
 *   CreateAccount, Transfer, DeployContract, FunctionCall(new),
 *   AddKey(agent key, function-call only: pay + request_approval on the vault)
 * No full-access key is ever added to the vault account.
 */
export async function createVault(
  owner: Account,
  options: VaultPolicyInput & { name: string; fund: bigint }
): Promise<CreateVaultResult> {
  const vaultId = `${options.name}.${owner.accountId}`;
  if (!isValidAccountId(vaultId)) {
    throw new Error(`"${vaultId}" is not a valid NEAR account id. Use lowercase letters, digits, - and _ for --name.`);
  }
  for (const receiver of options.allowlist) {
    if (!isValidAccountId(receiver)) throw new Error(`Allowlist entry "${receiver}" is not a valid NEAR account id.`);
  }
  if (options.perTxLimit <= 0n || options.perTxLimit > options.dailyLimit) {
    throw new Error('--per-tx must be greater than 0 and not higher than --daily.');
  }

  const wasm = await loadWasm('agent_vault');
  // --fund is what the agent can spend; storage and gas reserve come on top
  const overhead = vaultOverhead(wasm.length);
  const transferred = options.fund + overhead;
  const agentKey = KeyPair.fromRandom('ed25519');
  const agentPublicKey = agentKey.getPublicKey();

  const result = await owner.signAndSendTransaction({
    receiverId: vaultId,
    actions: [
      actions.createAccount(),
      actions.transfer(transferred),
      actions.deployContract(wasm),
      actions.functionCall(
        'new',
        {
          owner_id: owner.accountId,
          per_tx_limit: options.perTxLimit.toString(),
          daily_limit: options.dailyLimit.toString(),
          allowlist: options.allowlist,
          agent_key: agentPublicKey.toString(),
        },
        teraToGas('30'),
        0n
      ),
      actions.addFunctionCallAccessKey(agentPublicKey, vaultId, AGENT_METHODS, AGENT_KEY_ALLOWANCE),
    ],
    waitUntil: 'FINAL',
  });

  return {
    vaultId,
    transferred,
    overhead,
    txHash: result.transaction.hash,
    agentPublicKey: agentPublicKey.toString(),
    agentPrivateKey: agentKey.toString() as KeyPairString,
  };
}

export interface VaultStatus {
  paused: boolean;
  policy: { per_tx_limit: string; daily_limit: string };
  spent_in_window: string;
  remaining_today: string;
  window_resets_at_ns: number;
  available_balance: string;
  payments_made: number;
  pending_requests: number;
}

export interface PaymentRequest {
  id: number;
  receiver_id: string;
  amount: string;
  memo: string | null;
  reason: string;
  requested_at_ns: number;
}

export async function view<T>(network: NearNetwork, contractId: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
  const value = await provider(network).callFunction<T & object>({ contractId, method, args });
  return value as T;
}

export interface VaultSnapshot {
  owner: string;
  status: VaultStatus;
  allowlist: string[];
  agentKeys: string[];
  pending: PaymentRequest[];
  /** Keys on the vault account as the chain reports them */
  accessKeys: Array<{ publicKey: string; fullAccess: boolean; receiver?: string; methods?: string[] }>;
}

export async function vaultSnapshot(network: NearNetwork, vaultId: string): Promise<VaultSnapshot> {
  const [owner, status, allowlist, agentKeys, pending, keys] = await Promise.all([
    view<string>(network, vaultId, 'get_owner'),
    view<VaultStatus>(network, vaultId, 'get_status'),
    view<string[]>(network, vaultId, 'get_allowlist'),
    view<string[]>(network, vaultId, 'get_agent_keys'),
    view<PaymentRequest[]>(network, vaultId, 'get_pending'),
    provider(network).viewAccessKeyList({ accountId: vaultId }),
  ]);
  return { owner, status, allowlist, agentKeys, pending, accessKeys: describeAccessKeys(keys) };
}

/** Normalises the RPC access key list into something printable */
export function describeAccessKeys(list: unknown): VaultSnapshot['accessKeys'] {
  const keys = (list as { keys?: Array<{ public_key: string; access_key: { permission: unknown } }> }).keys ?? [];
  return keys.map(({ public_key, access_key }) => {
    const permission = access_key.permission as
      | 'FullAccess'
      | { FunctionCall?: { receiver_id: string; method_names: string[] } }
      | Record<string, unknown>;
    if (permission === 'FullAccess') return { publicKey: public_key, fullAccess: true };
    const fc = (permission as { FunctionCall?: { receiver_id: string; method_names: string[] } }).FunctionCall;
    return { publicKey: public_key, fullAccess: false, receiver: fc?.receiver_id, methods: fc?.method_names };
  });
}

export type PayOutcome =
  | { status: 'paid'; txHash: string }
  | { status: 'refused'; reason: string }
  | { status: 'pending_approval'; requestId: number; txHash: string; reason: string };

/**
 * Pays from the vault with the agent key. If the contract refuses on a policy
 * rule and escalate is on, files an approval request instead.
 */
export async function agentPay(
  network: NearNetwork,
  vaultId: string,
  agentPrivateKey: KeyPairString,
  payment: { receiverId: string; amount: bigint; memo?: string; escalate?: boolean }
): Promise<PayOutcome> {
  const reason = await view<string | null>(network, vaultId, 'check_payment', {
    receiver_id: payment.receiverId,
    amount: payment.amount.toString(),
  });

  const agent = new Account(vaultId, provider(network), agentPrivateKey);

  if (reason === null) {
    const result = await agent.callFunctionRaw({
      contractId: vaultId,
      methodName: 'pay',
      args: { receiver_id: payment.receiverId, amount: payment.amount.toString(), memo: payment.memo ?? null },
      gas: teraToGas('30'),
      waitUntil: 'FINAL',
    });
    return { status: 'paid', txHash: result.transaction.hash };
  }

  // Limits are about amounts: an approval can't add a new receiver or unpause the vault
  const escalatable = /per-transaction limit|daily limit/.test(reason);
  if (!payment.escalate || !escalatable) {
    return { status: 'refused', reason };
  }

  const result = await agent.callFunctionRaw({
    contractId: vaultId,
    methodName: 'request_approval',
    args: {
      receiver_id: payment.receiverId,
      amount: payment.amount.toString(),
      memo: payment.memo ?? null,
      reason,
    },
    gas: teraToGas('30'),
    waitUntil: 'FINAL',
  });
  const requestId = Number(lastResult(result));
  return { status: 'pending_approval', requestId, txHash: result.transaction.hash, reason };
}

/** Owner-side calls */
export async function ownerCall(
  owner: Account,
  vaultId: string,
  method: 'approve' | 'reject' | 'pause' | 'unpause' | 'allow_receiver' | 'remove_receiver' | 'set_limits' | 'revoke_agent_key' | 'add_agent_key' | 'withdraw',
  args: Record<string, unknown> = {}
): Promise<string> {
  const result = await owner.callFunctionRaw({
    contractId: vaultId,
    methodName: method,
    args,
    gas: teraToGas('50'),
    waitUntil: 'FINAL',
  });
  return result.transaction.hash;
}

function lastResult(result: unknown): unknown {
  const status = (result as { status?: { SuccessValue?: string } }).status;
  if (status?.SuccessValue === undefined) return undefined;
  const text = Buffer.from(status.SuccessValue, 'base64').toString();
  return text ? JSON.parse(text) : undefined;
}

export function describeStatus(status: VaultStatus): string[] {
  return [
    `State:           ${status.paused ? 'PAUSED' : 'active'}`,
    `Per transaction: ${formatNear(status.policy.per_tx_limit)} NEAR`,
    `Daily limit:     ${formatNear(status.policy.daily_limit)} NEAR`,
    `Spent today:     ${formatNear(status.spent_in_window)} NEAR (remaining ${formatNear(status.remaining_today)})`,
    `Available:       ${formatNear(status.available_balance)} NEAR`,
    `Payments made:   ${status.payments_made}`,
    `Pending:         ${status.pending_requests}`,
  ];
}
