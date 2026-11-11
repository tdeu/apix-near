// src/near/agent-wallet.ts
// apix add agent-wallet --chain near
import fs from 'fs-extra';
import path from 'path';
import crypto from 'crypto';
import { detectProjectLayout } from '../analysis/project-layout';
import { PackageManager } from '../utils/package-manager';
import { FileConflictError } from '../generation/integration-generator';
import { upsertEnv, readEnv, isGitIgnored } from './env-file';
import {
  AgentWalletPaths, vaultModule, toolsModule, statusRoute, payRoute, statusComponent,
} from './agent-wallet-templates';

export const NEAR_DEPENDENCIES = [
  { name: 'near-api-js', version: '^7.5.3', type: 'dependencies' as const },
  { name: 'server-only', version: '^0.0.1', type: 'dependencies' as const },
];

export interface AgentWalletResult {
  written: string[];
  unchanged: string[];
  overwritten: string[];
  installed: string[];
  envUpdated: boolean;
}

/** Import specifier from one generated file to another, without extension */
function importPath(from: string, to: string): string {
  let rel = path.posix.relative(path.posix.dirname(from), to).replace(/\.tsx?$/, '');
  if (!rel.startsWith('.')) rel = `./${rel}`;
  return rel;
}

export async function planAgentWallet(rootPath: string): Promise<Array<{ path: string; content: string }>> {
  const pkg = await fs.readJson(path.join(rootPath, 'package.json')).catch(() => null);
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  if (!pkg || !('next' in deps)) {
    throw new Error('apix add agent-wallet --chain near needs a Next.js project (the agent key must stay on the server).');
  }
  const layout = await detectProjectLayout(rootPath, 'next.js');
  if (layout.router !== 'app' || !layout.routesDir) {
    throw new Error('agent-wallet is generated for the Next.js App Router (app/ or src/app/).');
  }
  const join = (...p: string[]) => path.posix.join(...p.filter(Boolean));
  const paths: AgentWalletPaths = {
    vault: join(layout.sourceRoot, 'lib/near/agent-vault.ts'),
    tools: join(layout.sourceRoot, 'lib/near/agent-tools.ts'),
    statusRoute: join(layout.routesDir, 'api/agent/vault/route.ts'),
    payRoute: join(layout.routesDir, 'api/agent/pay/route.ts'),
    component: join(layout.sourceRoot, 'components/near/AgentVaultStatus.tsx'),
  };
  return [
    { path: paths.vault, content: vaultModule() },
    { path: paths.tools, content: toolsModule(importPath(paths.tools, paths.vault)) },
    { path: paths.statusRoute, content: statusRoute(importPath(paths.statusRoute, paths.vault)) },
    { path: paths.payRoute, content: payRoute(importPath(paths.payRoute, paths.vault)) },
    { path: paths.component, content: statusComponent() },
  ];
}

export async function addAgentWallet(
  rootPath: string,
  options: { force?: boolean; install?: boolean } = {}
): Promise<AgentWalletResult> {
  const files = await planAgentWallet(rootPath);
  const result: AgentWalletResult = { written: [], unchanged: [], overwritten: [], installed: [], envUpdated: false };

  const conflicts: string[] = [];
  const toWrite: typeof files = [];
  for (const file of files) {
    const full = path.join(rootPath, file.path);
    if (!await fs.pathExists(full)) toWrite.push(file);
    else if ((await fs.readFile(full, 'utf8')) === file.content) result.unchanged.push(file.path);
    else { conflicts.push(file.path); toWrite.push(file); }
  }
  if (conflicts.length > 0 && !options.force) throw new FileConflictError(conflicts);
  result.overwritten = conflicts;

  if (options.install !== false) {
    await new PackageManager(rootPath).addDependencies(NEAR_DEPENDENCIES);
    result.installed = NEAR_DEPENDENCIES.map(d => d.name);
  }

  for (const file of toWrite) {
    const full = path.join(rootPath, file.path);
    await fs.ensureDir(path.dirname(full));
    await fs.writeFile(full, file.content, 'utf8');
    result.written.push(file.path);
  }

  // The pay route's shared secret: generated once, only in a gitignored file
  const envFile = path.join(rootPath, '.env.local');
  if (await isGitIgnored(envFile, rootPath)) {
    const env = await readEnv(envFile);
    if (!env.APIX_AGENT_API_SECRET) {
      await upsertEnv(envFile, { APIX_AGENT_API_SECRET: crypto.randomBytes(32).toString('hex') });
      result.envUpdated = true;
    }
  }
  return result;
}
