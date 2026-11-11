// src/near/agent-wallet.ts
// Kept for callers and tests from before the generic NEAR generator.
import { addNear, planNear, NearAddResult, PlannedFile } from './generator';

export type AgentWalletResult = NearAddResult;

export async function planAgentWallet(rootPath: string): Promise<PlannedFile[]> {
  return (await planNear(rootPath, 'agent-wallet')).files;
}

export async function addAgentWallet(rootPath: string, options: { force?: boolean; install?: boolean } = {}): Promise<NearAddResult> {
  return addNear(rootPath, 'agent-wallet', options);
}
