// src/verify/near-ledger.ts
// On-chain checks: do the accounts, keys and transactions the project relies
// on look on the ledger the way the code assumes?
import path from 'path';
import type { KeyPairString } from 'near-api-js';
import { CheckResult, Finding } from './types';
import { ProjectFiles, isEnvFile } from './files';
import { referencedAccounts, RuleOutput } from './near-rules';
import { rpcUrl, NearNetwork } from '../near/network';

type Rpc = (network: NearNetwork, method: string, params: unknown) => Promise<any>;

export const jsonRpc: Rpc = async (network, method, params) => {
  const response = await fetch(rpcUrl(network), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'apix', method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`RPC ${method} failed: HTTP ${response.status}`);
  const body = await response.json() as { result?: any; error?: { cause?: { name?: string }; data?: string; message?: string } };
  if (body.error) {
    const name = body.error.cause?.name ?? body.error.message ?? 'RPC error';
    const err = new Error(`${name}: ${body.error.data ?? ''}`) as Error & { rpcName?: string };
    err.rpcName = name;
    throw err;
  }
  // Some query kinds (view_access_key, older nodes) report failure as a
  // string inside a successful result: {"result": {"error": "... does not exist ..."}}
  if (body.result && typeof body.result.error === 'string') {
    const text: string = body.result.error;
    const err = new Error(text) as Error & { rpcName?: string };
    err.rpcName = /access key .* does not exist/i.test(text) ? 'UNKNOWN_ACCESS_KEY'
      : /account .* does not exist/i.test(text) ? 'UNKNOWN_ACCOUNT' : 'QUERY_ERROR';
    throw err;
  }
  return body.result;
};

export function networkOf(accountId: string): NearNetwork {
  return accountId.endsWith('.testnet') ? 'testnet' : 'mainnet';
}

const EMPTY_CODE_HASH = '11111111111111111111111111111111';

export async function runNearLedgerRules(project: ProjectFiles, rpc: Rpc = jsonRpc): Promise<RuleOutput> {
  const checks: CheckResult[] = [];
  const findings: Finding[] = [];
  const { contracts, signers } = referencedAccounts(project);

  const record = (rule: string, title: string, found: Finding[], skipped?: string) => {
    if (skipped) {
      checks.push({ rule, title, status: 'skipped', note: skipped });
      return;
    }
    findings.push(...found);
    const status = found.some(f => f.severity === 'fail') ? 'failed' : found.some(f => f.severity === 'warn') ? 'warned' : 'passed';
    checks.push({ rule, title, status });
  };

  // A + B. Contracts exist, have code, and who can replace them
  {
    const deployed: Finding[] = [];
    const keys: Finding[] = [];
    for (const contract of contracts) {
      const network = networkOf(contract);
      try {
        const account = await rpc(network, 'query', { request_type: 'view_account', finality: 'final', account_id: contract });
        if (account.code_hash === EMPTY_CODE_HASH) {
          deployed.push({
            rule: 'NEAR-CONTRACT-DEPLOYED', severity: 'fail',
            title: 'Contract account has no code',
            detail: `The app calls ${contract} on ${network}, but no contract is deployed there. Every call to it fails.`,
            fix: `Deploy the contract to ${contract}, or fix the contract id in the configuration.`,
          });
          continue;
        }
        const list = await rpc(network, 'query', { request_type: 'view_access_key_list', finality: 'final', account_id: contract });
        const full = (list.keys ?? []).filter((k: any) => k.access_key?.permission === 'FullAccess');
        if (full.length > 0) {
          keys.push({
            rule: 'NEAR-CONTRACT-UPGRADE-KEYS', severity: 'warn',
            title: 'Contract can be replaced by a key holder',
            detail: `${contract} has ${full.length} full-access key(s). Whoever holds one can redeploy the code or move its funds, whatever the contract says.`,
            fix: 'If users trust this contract with funds, remove full-access keys (or move them to a multisig/DAO) and say so publicly. If it is a dev contract, this is expected.',
          });
        }
      } catch (error) {
        const name = (error as { rpcName?: string }).rpcName ?? '';
        if (/UNKNOWN_ACCOUNT|does not exist/i.test(name + String(error))) {
          deployed.push({
            rule: 'NEAR-CONTRACT-DEPLOYED', severity: 'fail',
            title: 'Contract account does not exist',
            detail: `The app is configured to call ${contract} on ${network}, which does not exist.`,
            fix: 'Create and deploy the contract, or fix the contract id.',
          });
        } else {
          throw error;
        }
      }
    }
    const none = contracts.length === 0 ? 'no contract ids found in the configuration' : undefined;
    record('NEAR-CONTRACT-DEPLOYED', 'Configured contracts exist and have code', deployed, none);
    record('NEAR-CONTRACT-UPGRADE-KEYS', 'Who can replace the contracts is known', keys, none);
  }

  // C. The server's key: does it belong to the account, and how much can it do?
  {
    const found: Finding[] = [];
    let checked = 0;
    for (const file of project.files.filter(f => isEnvFile(path.basename(f.path)))) {
      const env = parseEnv(file.content);
      for (const [name, value] of Object.entries(env)) {
        if (!/PRIVATE_KEY|SECRET_KEY/.test(name) || !/^(ed25519|secp256k1):/.test(value)) continue;
        const accountId = matchingAccount(env, name);
        if (!accountId) continue;
        let publicKey: string;
        try {
          publicKey = derivePublicKey(value as KeyPairString);
        } catch {
          continue;
        }
        checked++;
        const network = networkOf(accountId);
        try {
          const key = await rpc(network, 'query', { request_type: 'view_access_key', finality: 'final', account_id: accountId, public_key: publicKey });
          if (key.permission === 'FullAccess') {
            const isVault = /VAULT/.test(name) || Object.keys(env).some(k => k === 'NEAR_VAULT_ID' && env[k] === accountId);
            found.push({
              rule: 'NEAR-SERVER-KEY-SCOPE', severity: 'warn',
              title: 'The app signs with a full-access key',
              detail: `${name} (in ${file.path}) is a full-access key for ${accountId}${isVault ? '' : ''}. If the server is breached, the attacker owns the account: all funds, all keys, all contracts.`,
              fix: 'Give the server a function-call key limited to the methods it needs, or an Agent Vault for anything that moves funds: apix near vault create.',
              file: file.path,
            });
          }
        } catch (error) {
          const rpcName = (error as { rpcName?: string }).rpcName ?? String(error);
          if (/UNKNOWN_ACCESS_KEY|access key .* does not exist/i.test(rpcName + String(error))) {
            found.push({
              rule: 'NEAR-SERVER-KEY-SCOPE', severity: 'fail',
              title: 'Configured key does not belong to the account',
              detail: `${name} in ${file.path} is not a key of ${accountId} on ${network}. Every transaction the app signs with it will be rejected.`,
              fix: 'Use a key that was added to that account (near-cli: near account list-keys), or fix the account id.',
              file: file.path,
            });
          } else if (/UNKNOWN_ACCOUNT/i.test(rpcName)) {
            found.push({
              rule: 'NEAR-SERVER-KEY-SCOPE', severity: 'fail',
              title: 'Configured account does not exist',
              detail: `${accountId} (from ${file.path}) does not exist on ${network}.`,
              fix: 'Create the account or fix the account id.',
              file: file.path,
            });
          } else {
            throw error;
          }
        }
      }
    }
    record('NEAR-SERVER-KEY-SCOPE', 'The app\'s own keys are valid and narrowly scoped', found,
      checked === 0 ? 'no account + private key pair found in local env files' : undefined);
  }

  // D. Transactions the project says happened
  {
    const found: Finding[] = [];
    const claims = claimedTransactions(project);
    const senders = [...new Set([...signers, ...contracts])];
    let verified = 0;
    for (const claim of claims) {
      let ok = false;
      let succeeded = false;
      for (const sender of senders.filter(s => networkOf(s) === claim.network)) {
        try {
          const tx = await rpc(claim.network, 'tx', { tx_hash: claim.hash, sender_account_id: sender, wait_until: 'NONE' });
          ok = true;
          succeeded = tx?.status?.SuccessValue !== undefined || tx?.status?.SuccessReceiptId !== undefined;
          break;
        } catch {
          // try the next sender
        }
      }
      if (!ok) {
        found.push({
          rule: 'NEAR-LEDGER-CLAIMS', severity: 'warn',
          title: 'Claimed transaction not found on the ledger',
          detail: `${claim.file} links transaction ${claim.hash.slice(0, 10)}… on ${claim.network}, which APIX could not find from any account the project uses.`,
          fix: 'Check the link. If the transaction was signed by another account, add that account to the configuration so it can be checked.',
          file: claim.file,
        });
      } else if (!succeeded) {
        found.push({
          rule: 'NEAR-LEDGER-CLAIMS', severity: 'fail',
          title: 'Claimed transaction failed on-chain',
          detail: `${claim.file} presents transaction ${claim.hash.slice(0, 10)}… as done, but it failed on ${claim.network}.`,
          fix: 'Fix the code path and replace the link with a successful transaction.',
          file: claim.file,
        });
      } else {
        verified++;
      }
    }
    record('NEAR-LEDGER-CLAIMS', 'Transactions the project links really happened', found,
      claims.length === 0 ? 'no explorer links to transactions found' : undefined);
    if (claims.length > 0) checks[checks.length - 1].note = `${verified}/${claims.length} confirmed on-chain`;
  }

  return { checks, findings };
}

function parseEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

/** NEAR_PRIVATE_KEY → NEAR_ACCOUNT_ID, ORACLE_PRIVATE_KEY → ORACLE_ACCOUNT_ID, agent key → vault */
function matchingAccount(env: Record<string, string>, keyName: string): string | undefined {
  const prefix = keyName.replace(/_?(PRIVATE_KEY|SECRET_KEY)$/, '');
  const candidates = [`${prefix}_ACCOUNT_ID`, `${prefix}_ACCOUNT`, `${prefix}_ID`];
  if (/AGENT/.test(keyName)) candidates.push('NEAR_VAULT_ID');
  candidates.push('NEAR_ACCOUNT_ID', 'ACCOUNT_ID');
  const hit = candidates.find(c => env[c] && /\.(testnet|near)$/.test(env[c]));
  return hit ? env[hit] : undefined;
}

export interface TxClaim { hash: string; network: NearNetwork; file: string }

export function claimedTransactions(project: ProjectFiles): TxClaim[] {
  const out = new Map<string, TxClaim>();
  const re = /https?:\/\/(testnet\.)?(?:nearblocks\.io\/txns|explorer(?:\.testnet)?\.near\.org\/transactions|(?:testnet\.)?nearblocks\.io\/(?:[a-z]{2}\/)?txns)\/([1-9A-HJ-NP-Za-km-z]{43,44})/g;
  for (const file of project.files.filter(f => !isEnvFile(path.basename(f.path)))) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(file.content)) !== null) {
      const network: NearNetwork = m[1] || /explorer\.testnet/.test(m[0]) ? 'testnet' : 'mainnet';
      out.set(m[2], { hash: m[2], network, file: file.path });
    }
  }
  return [...out.values()];
}

/** Loaded on first use: near-api-js pulls in ESM-only crypto that only some runtimes can require */
function derivePublicKey(secret: KeyPairString): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { KeyPair } = require('near-api-js') as typeof import('near-api-js');
  return KeyPair.fromString(secret).getPublicKey().toString();
}
