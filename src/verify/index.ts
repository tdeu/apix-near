// src/verify/index.ts
import { collectFiles } from './files';
import { runNearStaticRules } from './near-rules';
import { runNearLedgerRules, jsonRpc } from './near-ledger';
import { summarize } from './report';
import { VerifyReport } from './types';

export interface VerifyOptions {
  directory: string;
  appId?: string;
  network: string;
  /** Skip the checks that read the ledger */
  offline?: boolean;
  apixVersion: string;
  rpc?: typeof jsonRpc;
}

export async function verifyNearProject(options: VerifyOptions): Promise<VerifyReport> {
  const project = await collectFiles(options.directory);
  if (project.files.length === 0) {
    throw new Error(`No source files found in ${options.directory}. Run apix verify in the app's folder.`);
  }
  const staticResult = runNearStaticRules(project);
  const checks = [...staticResult.checks];
  const findings = [...staticResult.findings];

  if (options.offline) {
    for (const title of ['Configured contracts exist and have code', 'Who can replace the contracts is known',
      'The app\'s own keys are valid and narrowly scoped', 'Transactions the project links really happened']) {
      checks.push({ rule: 'NEAR-LEDGER', title, status: 'skipped', note: '--offline' });
    }
  } else {
    try {
      const ledger = await runNearLedgerRules(project, options.rpc ?? jsonRpc);
      checks.push(...ledger.checks);
      findings.push(...ledger.findings);
    } catch (error) {
      throw new Error(`Could not reach the NEAR RPC for the on-chain checks (${error instanceof Error ? error.message : error}). Re-run with --offline to run the code checks only.`);
    }
  }

  return {
    format: 'apix-verify/1',
    apixVersion: options.apixVersion,
    chain: 'near',
    network: options.network,
    appId: options.appId ?? project.packageJson?.name ?? 'unnamed-app',
    commit: project.commit,
    treeHash: project.treeHash,
    filesScanned: project.files.length,
    checks,
    findings,
    summary: summarize(checks, findings),
  };
}
