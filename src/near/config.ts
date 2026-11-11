// src/near/config.ts
// Network settings and credentials for the NEAR commands.
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { Account, JsonRpcProvider, KeyPair } from 'near-api-js';
import type { KeyPairString } from 'near-api-js';

export type NearNetwork = 'testnet' | 'mainnet';

const RPC: Record<NearNetwork, string> = {
  testnet: 'https://rpc.testnet.near.org',
  mainnet: 'https://rpc.mainnet.near.org',
};

const EXPLORER: Record<NearNetwork, string> = {
  testnet: 'https://testnet.nearblocks.io',
  mainnet: 'https://nearblocks.io',
};

/** Contracts APIX deploys or calls, by network */
export const ATTESTATION_CONTRACT: Record<NearNetwork, string | undefined> = {
  testnet: process.env.APIX_ATTESTATION_CONTRACT_TESTNET ?? 'attest.apix-near.testnet',
  mainnet: process.env.APIX_ATTESTATION_CONTRACT_MAINNET,
};

export function resolveNetwork(value?: string): NearNetwork {
  const network = (value ?? process.env.NEAR_NETWORK ?? 'testnet').toLowerCase();
  if (network !== 'testnet' && network !== 'mainnet') {
    throw new Error(`Unknown NEAR network "${network}". Use testnet or mainnet.`);
  }
  return network;
}

export function rpcUrl(network: NearNetwork): string {
  return process.env.NEAR_RPC_URL ?? RPC[network];
}

export function provider(network: NearNetwork): JsonRpcProvider {
  return new JsonRpcProvider({ url: rpcUrl(network) });
}

export function txUrl(network: NearNetwork, hash: string): string {
  return `${EXPLORER[network]}/txns/${hash}`;
}

export function accountUrl(network: NearNetwork, accountId: string): string {
  return `${EXPLORER[network]}/address/${accountId}`;
}

/** Same check as NEAR's account id rules, enough to catch typos early */
export function isValidAccountId(id: string): boolean {
  return id.length >= 2 && id.length <= 64 && /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(id);
}

export interface NearCredentials {
  accountId: string;
  privateKey: KeyPairString;
  /** Where the key came from, for messages (never the key itself) */
  source: string;
}

/**
 * Owner credentials, in this order:
 *  1. NEAR_ACCOUNT_ID + NEAR_PRIVATE_KEY
 *  2. ~/.near-credentials/<network>/<account>.json, as written by near-cli
 *     (account from --account or NEAR_ACCOUNT_ID)
 */
export async function loadCredentials(network: NearNetwork, accountId?: string): Promise<NearCredentials> {
  const id = accountId ?? process.env.NEAR_ACCOUNT_ID;
  const envKey = process.env.NEAR_PRIVATE_KEY;
  if (id && envKey && (!accountId || accountId === process.env.NEAR_ACCOUNT_ID)) {
    return { accountId: id, privateKey: checkKey(envKey, 'NEAR_PRIVATE_KEY'), source: 'NEAR_PRIVATE_KEY' };
  }
  if (!id) {
    throw new Error(
      'No NEAR account given. Pass --account <id>, or set NEAR_ACCOUNT_ID and NEAR_PRIVATE_KEY.\n' +
      'No account yet? Create a free testnet one: npx near-cli-rs account create-account sponsor-by-faucet-service'
    );
  }
  const file = path.join(os.homedir(), '.near-credentials', network, `${id}.json`);
  if (await fs.pathExists(file)) {
    const json = await fs.readJson(file);
    const key = json.private_key ?? json.secret_key;
    if (typeof key === 'string') {
      return { accountId: id, privateKey: checkKey(key, file), source: file };
    }
  }
  throw new Error(
    `No key found for ${id} on ${network}. Set NEAR_PRIVATE_KEY, or save the account with near-cli ` +
    `(it writes ${file}).`
  );
}

function checkKey(value: string, where: string): KeyPairString {
  try {
    KeyPair.fromString(value as KeyPairString);
    return value as KeyPairString;
  } catch {
    throw new Error(`${where} is not a valid NEAR private key (expected "ed25519:...").`);
  }
}

export function accountFor(network: NearNetwork, credentials: NearCredentials): Account {
  return new Account(credentials.accountId, provider(network), credentials.privateKey);
}

/** First 6 characters of a secret, never more */
export function maskKey(key: string): string {
  return `${key.slice(0, 6)}…`;
}

/** Converts "1.5" NEAR to yocto, refusing junk */
export function parseNear(value: string, label: string): bigint {
  if (!/^\d+(\.\d{1,24})?$/.test(value.trim())) {
    throw new Error(`${label} must be an amount of NEAR such as 0.5 (got "${value}").`);
  }
  const [whole, frac = ''] = value.trim().split('.');
  return BigInt(whole) * 10n ** 24n + BigInt(frac.padEnd(24, '0'));
}

/** Formats yocto as NEAR, trimmed: 1500000000000000000000000n -> "1.5" */
export function formatNear(yocto: bigint | string): string {
  const value = BigInt(yocto);
  const whole = value / 10n ** 24n;
  const frac = (value % 10n ** 24n).toString().padStart(24, '0').replace(/0+$/, '').slice(0, 5);
  return frac ? `${whole}.${frac}` : whole.toString();
}
