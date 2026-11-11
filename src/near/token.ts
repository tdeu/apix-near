// src/near/token.ts
// apix near token create / send: a fixed-supply NEP-141 token on a locked account.
import { Account, actions, teraToGas } from 'near-api-js';
import { loadWasm, view } from './vault';
import { NearNetwork, isValidAccountId } from './network';

const STORAGE_PRICE_PER_BYTE = 10_000_000_000_000_000_000n;

export interface CreateTokenInput {
  name: string;
  symbol: string;
  decimals: number;
  /** Whole tokens, e.g. "1000000" */
  supply: string;
  /** Sub-account name: <accountName>.<owner> */
  accountName: string;
}

export function toUnits(amount: string, decimals: number): bigint {
  const text = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error(`"${amount}" is not an amount.`);
  const [whole, frac = ''] = text.split('.');
  if (frac.length > decimals) throw new Error(`"${amount}" has more than ${decimals} decimals.`);
  return BigInt(whole + frac.padEnd(decimals, '0'));
}

/**
 * One transaction: CreateAccount, Transfer (storage), DeployContract,
 * FunctionCall(new). No AddKey: the token account has no access key, so its
 * code and supply can never change.
 */
export async function createToken(owner: Account, input: CreateTokenInput): Promise<{ tokenId: string; txHash: string; funded: bigint; units: bigint }> {
  const tokenId = `${input.accountName}.${owner.accountId}`;
  if (!isValidAccountId(tokenId)) throw new Error(`"${tokenId}" is not a valid account id.`);
  if (!/^[A-Za-z0-9]{1,16}$/.test(input.symbol)) throw new Error('--symbol must be 1-16 letters or digits.');
  if (!input.name || input.name.length > 64) throw new Error('--name must be 1-64 characters.');
  if (!Number.isInteger(input.decimals) || input.decimals < 0 || input.decimals > 24) throw new Error('--decimals must be 0-24.');
  const units = toUnits(input.supply, input.decimals);
  if (units <= 0n) throw new Error('--supply must be more than 0.');

  const wasm = await loadWasm('apix_fungible_token');
  // Code + metadata + the owner's balance entry, plus headroom for registrations paid by holders
  const funded = (BigInt(wasm.length) + 3_000n) * STORAGE_PRICE_PER_BYTE + 50_000_000_000_000_000_000_000n;
  const result = await owner.signAndSendTransaction({
    receiverId: tokenId,
    actions: [
      actions.createAccount(),
      actions.transfer(funded),
      actions.deployContract(wasm),
      actions.functionCall('new', {
        owner_id: owner.accountId,
        total_supply: units.toString(),
        name: input.name,
        symbol: input.symbol,
        decimals: input.decimals,
        icon: null,
      }, teraToGas('50'), 0n),
    ],
    waitUntil: 'FINAL',
  });
  return { tokenId, txHash: result.transaction.hash, funded, units };
}

export interface TokenInfo { name: string; symbol: string; decimals: number }

export async function tokenInfo(network: NearNetwork, tokenId: string): Promise<TokenInfo> {
  return view<TokenInfo>(network, tokenId, 'ft_metadata');
}

/** ft_transfer from the signer, registering the receiver first when needed (one transaction) */
export async function sendToken(
  network: NearNetwork,
  sender: Account,
  tokenId: string,
  receiverId: string,
  amount: string,
  memo?: string
): Promise<{ txHash: string; registered: boolean; units: bigint }> {
  if (!isValidAccountId(receiverId)) throw new Error(`"${receiverId}" is not a valid account id.`);
  const info = await tokenInfo(network, tokenId);
  const units = toUnits(amount, info.decimals);
  if (units <= 0n) throw new Error('Amount must be more than 0.');
  const balance = BigInt(await view<string>(network, tokenId, 'ft_balance_of', { account_id: sender.accountId }) ?? '0');
  if (units > balance) throw new Error(`${sender.accountId} holds only ${balance} units of ${info.symbol}.`);

  const registration = await view<unknown>(network, tokenId, 'storage_balance_of', { account_id: receiverId });
  const steps = [];
  if (registration === null || registration === undefined) {
    const bounds = await view<{ min: string }>(network, tokenId, 'storage_balance_bounds');
    steps.push(actions.functionCall('storage_deposit', { account_id: receiverId, registration_only: true }, teraToGas('10'), BigInt(bounds.min)));
  }
  steps.push(actions.functionCall('ft_transfer', { receiver_id: receiverId, amount: units.toString(), memo: memo ?? null }, teraToGas('20'), 1n));
  const result = await sender.signAndSendTransaction({ receiverId: tokenId, actions: steps, waitUntil: 'FINAL' });
  return { txHash: result.transaction.hash, registered: steps.length === 2, units };
}
