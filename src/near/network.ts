// src/near/network.ts
// Network names, RPC and explorer URLs. No near-api-js import, so it loads anywhere.

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

