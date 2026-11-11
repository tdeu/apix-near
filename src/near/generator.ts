// src/near/generator.ts
// apix add <wallet|token|agent-wallet> --chain near
import fs from 'fs-extra';
import path from 'path';
import crypto from 'crypto';
import { detectProjectLayout, ProjectLayout } from '../analysis/project-layout';
import { PackageManager, Dependency } from '../utils/package-manager';
import { FileConflictError } from '../generation/integration-generator';
import { upsertEnv, readEnv, isGitIgnored } from './env-file';
import { vaultModule, toolsModule, statusRoute, payRoute, statusComponent } from './agent-wallet-templates';
import { configModule, providerModule, connectButton, tokenModule, tokenRoute, tokenPanel } from './app-templates';

export const NEAR_INTEGRATIONS = ['wallet', 'token', 'agent-wallet'] as const;
export type NearIntegration = (typeof NEAR_INTEGRATIONS)[number];

const DEPS: Record<string, Dependency> = {
  'near-api-js': { name: 'near-api-js', version: '^7.5.3', type: 'dependencies' },
  'server-only': { name: 'server-only', version: '^0.0.1', type: 'dependencies' },
  '@hot-labs/near-connect': { name: '@hot-labs/near-connect', version: '^0.12.0', type: 'dependencies' },
};

export interface PlannedFile { path: string; content: string }
export interface NearPlan { files: PlannedFile[]; dependencies: Dependency[]; nextSteps: string[] }

/** Import specifier from one generated file to another, without extension */
export function importPath(from: string, to: string): string {
  let rel = path.posix.relative(path.posix.dirname(from), to).replace(/\.tsx?$/, '');
  if (!rel.startsWith('.')) rel = `./${rel}`;
  return rel;
}

async function nextLayout(rootPath: string): Promise<ProjectLayout> {
  const pkg = await fs.readJson(path.join(rootPath, 'package.json')).catch(() => null);
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  if (!pkg || !('next' in deps)) {
    throw new Error('apix add --chain near needs a Next.js project (App Router, TypeScript).');
  }
  const layout = await detectProjectLayout(rootPath, 'next.js');
  if (layout.router !== 'app' || !layout.routesDir) {
    throw new Error('NEAR integrations are generated for the Next.js App Router (app/ or src/app/).');
  }
  return layout;
}

export async function planNear(rootPath: string, kind: NearIntegration): Promise<NearPlan> {
  const layout = await nextLayout(rootPath);
  const j = (...p: string[]) => path.posix.join(...p.filter(Boolean));
  const src = layout.sourceRoot;
  const p = {
    config: j(src, 'lib/near/config.ts'),
    provider: j(src, 'components/near/NearProvider.tsx'),
    connect: j(src, 'components/near/ConnectWallet.tsx'),
    token: j(src, 'lib/near/token.ts'),
    tokenRoute: j(layout.routesDir!, 'api/token/route.ts'),
    tokenPanel: j(src, 'components/near/TokenPanel.tsx'),
    vault: j(src, 'lib/near/agent-vault.ts'),
    tools: j(src, 'lib/near/agent-tools.ts'),
    statusRoute: j(layout.routesDir!, 'api/agent/vault/route.ts'),
    payRoute: j(layout.routesDir!, 'api/agent/pay/route.ts'),
    vaultStatus: j(src, 'components/near/AgentVaultStatus.tsx'),
  };

  const walletFiles: PlannedFile[] = [
    { path: p.config, content: configModule() },
    { path: p.provider, content: providerModule(importPath(p.provider, p.config)) },
    { path: p.connect, content: connectButton(importPath(p.connect, p.provider)) },
  ];
  const wrapStep = `Wrap your root layout's children in <NearProvider> (from ${importPath(j(layout.routesDir!, 'layout.tsx'), p.provider)}) and add <ConnectWallet /> where users should sign in.`;

  if (kind === 'wallet') {
    return {
      files: walletFiles,
      dependencies: [DEPS['near-api-js'], DEPS['@hot-labs/near-connect']],
      nextSteps: [
        wrapStep,
        'Read with useNearWallet().view(contractId, method, args); write with useNearWallet().call(contractId, [{ methodName, args, deposit }]) — the user signs in their wallet.',
        'Set NEXT_PUBLIC_NEAR_NETWORK (testnet by default) and NEXT_PUBLIC_NEAR_CONTRACT_ID in .env.local.',
      ],
    };
  }

  if (kind === 'token') {
    return {
      files: [
        ...walletFiles,
        { path: p.token, content: tokenModule(importPath(p.token, p.config)) },
        { path: p.tokenRoute, content: tokenRoute(importPath(p.tokenRoute, p.token)) },
        { path: p.tokenPanel, content: tokenPanel(importPath(p.tokenPanel, p.provider), importPath(p.tokenPanel, p.token), importPath(p.tokenPanel, p.config)) },
      ],
      dependencies: [DEPS['near-api-js'], DEPS['@hot-labs/near-connect']],
      nextSteps: [
        'Create the token (fixed supply, locked contract): apix near token create --account <you>.testnet --name "My Points" --symbol PTS --supply 1000000 --decimals 2 --env-file .env.local',
        wrapStep,
        'Show it: <TokenPanel /> from components/near/TokenPanel (balance + send, with NEP-145 registration handled).',
      ],
    };
  }

  return {
    files: [
      { path: p.vault, content: vaultModule() },
      { path: p.tools, content: toolsModule(importPath(p.tools, p.vault)) },
      { path: p.statusRoute, content: statusRoute(importPath(p.statusRoute, p.vault)) },
      { path: p.payRoute, content: payRoute(importPath(p.payRoute, p.vault)) },
      { path: p.vaultStatus, content: statusComponent() },
    ],
    dependencies: [DEPS['near-api-js'], DEPS['server-only']],
    nextSteps: [
      'Create the vault (writes NEAR_VAULT_ID and the agent key to .env.local): apix near vault create --account <you>.testnet --allow <receiver>.testnet --per-tx 0.5 --daily 2',
      'Give your model the tools: import { openAiTools, anthropicTools, runVaultTool } from lib/near/agent-tools',
      'Show limits in your UI: <AgentVaultStatus /> from components/near/AgentVaultStatus',
    ],
  };
}

export interface NearAddResult {
  written: string[];
  unchanged: string[];
  overwritten: string[];
  installed: string[];
  envUpdated: boolean;
  nextSteps: string[];
}

export async function addNear(
  rootPath: string,
  kind: NearIntegration,
  options: { force?: boolean; install?: boolean } = {}
): Promise<NearAddResult> {
  const plan = await planNear(rootPath, kind);
  const result: NearAddResult = { written: [], unchanged: [], overwritten: [], installed: [], envUpdated: false, nextSteps: plan.nextSteps };

  const conflicts: string[] = [];
  const toWrite: PlannedFile[] = [];
  for (const file of plan.files) {
    const full = path.join(rootPath, file.path);
    if (!await fs.pathExists(full)) toWrite.push(file);
    else if ((await fs.readFile(full, 'utf8')) === file.content) result.unchanged.push(file.path);
    else { conflicts.push(file.path); toWrite.push(file); }
  }
  if (conflicts.length > 0 && !options.force) throw new FileConflictError(conflicts);
  result.overwritten = conflicts;

  if (options.install !== false) {
    await new PackageManager(rootPath).addDependencies(plan.dependencies);
    result.installed = plan.dependencies.map(d => d.name);
  }

  for (const file of toWrite) {
    const full = path.join(rootPath, file.path);
    await fs.ensureDir(path.dirname(full));
    await fs.writeFile(full, file.content, 'utf8');
    result.written.push(file.path);
  }

  if (kind === 'agent-wallet') {
    // The pay route's shared secret: generated once, only in a gitignored file
    const envFile = path.join(rootPath, '.env.local');
    if (await isGitIgnored(envFile, rootPath)) {
      const env = await readEnv(envFile);
      if (!env.APIX_AGENT_API_SECRET) {
        await upsertEnv(envFile, { APIX_AGENT_API_SECRET: crypto.randomBytes(32).toString('hex') });
        result.envUpdated = true;
      }
    }
  }
  return result;
}
