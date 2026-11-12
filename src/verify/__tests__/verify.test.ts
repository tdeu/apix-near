import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { verifyNearProject } from '..';
import { canonicalJson, reportHash } from '../report';
import { claimedTransactions } from '../near-ledger';
import { collectFiles } from '../files';

// A random, never-funded key, only used as fixture data
const FAKE_KEY = 'ed25519:3D4YudUahN1nawWogh8pAKSj92sUNMdbZGjn7kERKzYoTy8tnFQuwoGUC51DowKqorvkr2pytJSnwuSbsNVfqygr';

async function project(files: Record<string, string>, commit: string[] = []): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'apix-verify-'));
  for (const [file, content] of Object.entries(files)) {
    await fs.outputFile(path.join(dir, file), content);
  }
  execFileSync('git', ['init', '-q'], { cwd: dir });
  if (commit.length > 0) {
    execFileSync('git', ['add', ...commit], { cwd: dir });
  }
  return dir;
}

const pkg = JSON.stringify({ name: 'demo', dependencies: { next: '15', 'near-api-js': '7', openai: '5' } });

const NEAR_LIB = `import { Account, JsonRpcProvider } from 'near-api-js';
const provider = new JsonRpcProvider({ url: process.env.NEAR_RPC! });
const account = new Account(process.env.NEAR_ACCOUNT_ID!, provider, process.env.NEAR_PRIVATE_KEY as any);
export async function send(to: string, amount: bigint) { return account.transfer({ receiverId: to, amount }); }
`;

const rules = (report: Awaited<ReturnType<typeof verifyNearProject>>) =>
  report.findings.map(f => `${f.rule}:${f.severity}`).sort();

describe('apix verify --chain near (code checks)', () => {
  it('flags a committed key and a committed .env', async () => {
    const dir = await project({ 'package.json': pkg, '.env': `NEAR_PRIVATE_KEY=${FAKE_KEY}\n` }, ['.env', 'package.json']);
    const report = await verifyNearProject({ directory: dir, network: 'testnet', offline: true, apixVersion: 'test' });
    expect(rules(report)).toEqual(['NEAR-ENV-COMMITTED:fail', 'NEAR-KEY-IN-REPO:fail']);
    expect(report.summary.verdict).toBe('fail');
  });

  it('accepts a key in an untracked env file', async () => {
    const dir = await project({ 'package.json': pkg, '.env.local': `NEAR_PRIVATE_KEY=${FAKE_KEY}\n`, '.gitignore': '.env.local\n' }, ['package.json', '.gitignore']);
    const report = await verifyNearProject({ directory: dir, network: 'testnet', offline: true, apixVersion: 'test' });
    expect(report.findings).toEqual([]);
    expect(report.summary.verdict).toBe('pass');
  });

  it('ignores key files git will never publish, but flags them once they would be', async () => {
    const files = { 'package.json': pkg, '.gitignore': 'data/\n', 'data/keys.json': `{"key":"${FAKE_KEY}"}\n` };
    const ignoredDir = await project(files, ['package.json', '.gitignore']);
    expect(rules(await verifyNearProject({ directory: ignoredDir, network: 'testnet', offline: true, apixVersion: 'test' }))).toEqual([]);

    const exposed = await project({ ...files, '.gitignore': 'node_modules\n' }, ['package.json', '.gitignore']);
    expect(rules(await verifyNearProject({ directory: exposed, network: 'testnet', offline: true, apixVersion: 'test' }))).toEqual(['NEAR-KEY-IN-REPO:fail']);
  });

  it('flags secrets behind a public prefix and keys in browser code', async () => {
    const dir = await project({
      'package.json': pkg,
      'components/Wallet.tsx': `'use client';\nimport { KeyPair } from 'near-api-js';\nconst k = KeyPair.fromString(process.env.NEXT_PUBLIC_NEAR_PRIVATE_KEY as any);\n`,
    });
    const report = await verifyNearProject({ directory: dir, network: 'testnet', offline: true, apixVersion: 'test' });
    expect(rules(report)).toEqual(['NEAR-KEY-IN-CLIENT:fail', 'NEAR-KEY-PUBLIC-ENV:fail']);
  });

  it('flags a spending route with no auth, through an imported helper', async () => {
    const dir = await project({
      'package.json': pkg,
      'lib/near.ts': NEAR_LIB,
      'app/api/pay/route.ts': `import { send } from '../../../lib/near';\nexport async function POST(request: Request) { const { to, amount } = await request.json(); return Response.json(await send(to, BigInt(amount))); }\n`,
    });
    const report = await verifyNearProject({ directory: dir, network: 'testnet', offline: true, apixVersion: 'test' });
    expect(rules(report)).toEqual(['NEAR-UNPROTECTED-SPEND-ROUTE:fail', 'NEAR-UNPROTECTED-SPEND-ROUTE:warn']);
  });

  it('accepts a spending route with auth and an amount cap', async () => {
    const dir = await project({
      'package.json': pkg,
      'lib/near.ts': NEAR_LIB,
      'app/api/pay/route.ts': `import { auth } from '@/auth';\nimport { send } from '../../../lib/near';\nconst MAX_AMOUNT = 10n;\nexport async function POST(request: Request) { const session = await auth(); if (!session) return new Response(null, { status: 401 }); const { to, amount } = await request.json(); if (BigInt(amount) > MAX_AMOUNT) throw new Error('too much'); return Response.json(await send(to, BigInt(amount))); }\n`,
    });
    const report = await verifyNearProject({ directory: dir, network: 'testnet', offline: true, apixVersion: 'test' });
    expect(report.findings).toEqual([]);
  });

  it('flags an LLM tool that can spend, and accepts one behind a vault', async () => {
    const bad = await project({
      'package.json': pkg,
      'lib/near.ts': NEAR_LIB,
      'lib/agent.ts': `import OpenAI from 'openai';\nimport { send } from './near';\nexport const run = (a: any) => send(a.to, a.amount);\n`,
    });
    expect(rules(await verifyNearProject({ directory: bad, network: 'testnet', offline: true, apixVersion: 'test' })))
      .toEqual(['NEAR-AGENT-UNBOUNDED-SPEND:fail']);

    const good = await project({
      'package.json': pkg,
      'lib/near.ts': NEAR_LIB.replace('account.transfer(', "account.callFunction({ contractId: process.env.NEAR_VAULT_ID!, methodName: 'pay', args: { receiver_id: to, amount: amount.toString() } }) || account.transfer("),
      'lib/agent.ts': `import OpenAI from 'openai';\nimport { send } from './near';\nexport const run = (a: any) => send(a.to, a.amount);\n`,
    });
    expect(rules(await verifyNearProject({ directory: good, network: 'testnet', offline: true, apixVersion: 'test' }))).toEqual([]);
  });

  it('warns when code that spends hardcodes mainnet', async () => {
    const dir = await project({ 'package.json': pkg, 'lib/near.ts': NEAR_LIB.replace('process.env.NEAR_RPC!', "'https://rpc.mainnet.near.org'") });
    expect(rules(await verifyNearProject({ directory: dir, network: 'testnet', offline: true, apixVersion: 'test' })))
      .toEqual(['NEAR-MAINNET-HARDCODED:warn']);
  });

  it('does not treat a read-only GET route as a spender', async () => {
    const dir = await project({
      'package.json': pkg,
      'lib/near.ts': NEAR_LIB + 'export async function getBalance() { return 1; }\n',
      'app/api/balance/route.ts': `import { getBalance } from '../../../lib/near';\nexport async function GET() { return Response.json(await getBalance()); }\n`,
    });
    expect(rules(await verifyNearProject({ directory: dir, network: 'testnet', offline: true, apixVersion: 'test' }))).toEqual([]);
  });

  it('does not flag a network lookup table as hardcoded mainnet', async () => {
    const lib = NEAR_LIB.replace("process.env.NEAR_RPC!", "RPC[process.env.NEAR_NETWORK ?? 'testnet']")
      .replace('const provider', "const RPC: Record<string, string> = { testnet: 'https://rpc.testnet.near.org', mainnet: 'https://rpc.mainnet.near.org' };\nconst provider");
    const dir = await project({ 'package.json': pkg, 'lib/near.ts': lib });
    expect(rules(await verifyNearProject({ directory: dir, network: 'testnet', offline: true, apixVersion: 'test' }))).toEqual([]);
  });

  it('skips NEAR-only checks for projects without NEAR code', async () => {
    const dir = await project({ 'package.json': JSON.stringify({ name: 'plain' }), 'index.ts': 'export const a = 1;\n' });
    const report = await verifyNearProject({ directory: dir, network: 'testnet', offline: true, apixVersion: 'test' });
    expect(report.checks.find(c => c.rule === 'NEAR-KEY-IN-CLIENT')?.status).toBe('skipped');
    // Found in a real run: an empty or non-NEAR folder used to come out as PASS
    expect(report.summary.verdict).toBe('warn');
    expect(rules(report)).toEqual(['NEAR-NOTHING-TO-CHECK:warn']);
  });

  it('refuses an empty folder', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'apix-empty-'));
    await expect(verifyNearProject({ directory: dir, network: 'testnet', offline: true, apixVersion: 'test' }))
      .rejects.toThrow(/No source files/);
  });
});

describe('apix verify --chain near (ledger checks, mocked RPC)', () => {
  const files = {
    'package.json': pkg,
    '.env.example': 'NEAR_ACCOUNT_ID=app.testnet\nNEAR_CONTRACT_ID=game.testnet\n',
    'README.md': 'Proof: https://testnet.nearblocks.io/txns/6zgh2u9DqHHiXzdy9ouTP7oGky2T4nugqzqt9wJZwnFm\n',
  };

  it('reports a missing contract, upgrade keys and a failed claimed transaction', async () => {
    const dir = await project(files);
    const rpc = jest.fn(async (_network: string, method: string, params: any) => {
      if (method === 'query' && params.request_type === 'view_account') return { code_hash: 'Abc123' };
      if (method === 'query' && params.request_type === 'view_access_key_list') {
        return { keys: [{ public_key: 'ed25519:x', access_key: { permission: 'FullAccess' } }] };
      }
      if (method === 'tx') return { status: { Failure: { ActionError: {} } } };
      throw new Error('unexpected');
    });
    const report = await verifyNearProject({ directory: dir, network: 'testnet', apixVersion: 'test', rpc: rpc as any });
    expect(rules(report)).toEqual(['NEAR-CONTRACT-UPGRADE-KEYS:warn', 'NEAR-LEDGER-CLAIMS:fail']);
  });

  it('passes when the contract is locked and the claimed transaction succeeded', async () => {
    const dir = await project(files);
    const rpc = jest.fn(async (_network: string, method: string, params: any) => {
      if (method === 'query' && params.request_type === 'view_account') return { code_hash: 'Abc123' };
      if (method === 'query' && params.request_type === 'view_access_key_list') return { keys: [] };
      if (method === 'tx') return { status: { SuccessValue: '' } };
      throw new Error('unexpected');
    });
    const report = await verifyNearProject({ directory: dir, network: 'testnet', apixVersion: 'test', rpc: rpc as any });
    expect(report.findings).toEqual([]);
    expect(report.checks.find(c => c.rule === 'NEAR-LEDGER-CLAIMS')?.note).toBe('1/1 confirmed on-chain');
  });

  it('flags a contract id with no account behind it', async () => {
    const dir = await project(files);
    const rpc = jest.fn(async (_network: string, method: string) => {
      if (method === 'query') {
        const err = new Error('UNKNOWN_ACCOUNT') as Error & { rpcName?: string };
        err.rpcName = 'UNKNOWN_ACCOUNT';
        throw err;
      }
      return { status: { SuccessValue: '' } };
    });
    const report = await verifyNearProject({ directory: dir, network: 'testnet', apixVersion: 'test', rpc: rpc as any });
    expect(rules(report)).toEqual(['NEAR-CONTRACT-DEPLOYED:fail']);
  });
});

describe('jsonRpc', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  it('turns an error hidden inside a successful query result into an error', async () => {
    // Found on testnet: view_access_key answers 200 with {result: {error: "..."}}
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ result: { error: 'access key ed25519:abc does not exist while viewing', block_height: 1 } }),
    })) as any;
    const { jsonRpc } = await import('../near-ledger');
    await expect(jsonRpc('testnet', 'query', {})).rejects.toMatchObject({ rpcName: 'UNKNOWN_ACCESS_KEY' });
  });
});

describe('report hashing', () => {
  it('is independent of key order', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: null } })).toBe('{"a":{"c":null,"d":[2,1]},"b":1}');
  });

  it('changes when the report changes', async () => {
    const dir = await project({ 'package.json': pkg });
    const report = await verifyNearProject({ directory: dir, network: 'testnet', offline: true, apixVersion: 'test' });
    const changed = { ...report, summary: { ...report.summary, failures: 1 } };
    expect(reportHash(report)).toMatch(/^[0-9a-f]{64}$/);
    expect(reportHash(changed)).not.toBe(reportHash(report));
  });

  it('never hashes env file content', async () => {
    const a = await collectFiles(await project({ 'package.json': pkg, '.env.local': 'A=1\n' }));
    const b = await collectFiles(await project({ 'package.json': pkg, '.env.local': 'A=2\n' }));
    expect(a.treeHash).toBe(b.treeHash);
  });

  it('finds explorer links to transactions', async () => {
    const files = await collectFiles(await project({
      'README.md': 'https://nearblocks.io/txns/6zgh2u9DqHHiXzdy9ouTP7oGky2T4nugqzqt9wJZwnFm https://testnet.nearblocks.io/txns/6zgh2u9DqHHiXzdy9ouTP7oGky2T4nugqzqt9wJZwnFa',
    }));
    expect(claimedTransactions(files).map(c => c.network)).toEqual(['mainnet', 'testnet']);
  });
});
