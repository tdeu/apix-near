// src/verify/types.ts
// Chain-agnostic report format. The same shape is hashed and attested on any
// ledger; only the rules that fill it are chain-specific.

export type Severity = 'fail' | 'warn' | 'info';
export type Verdict = 'pass' | 'warn' | 'fail';

export interface Finding {
  /** Stable rule id, e.g. NEAR-KEY-IN-CLIENT */
  rule: string;
  severity: Severity;
  title: string;
  /** What is wrong, in plain words, for someone who didn't write the code */
  detail: string;
  /** What to do about it */
  fix: string;
  file?: string;
  line?: number;
}

export interface CheckResult {
  rule: string;
  title: string;
  /** passed: ran, found nothing; skipped: couldn't run (reason in note) */
  status: 'passed' | 'failed' | 'warned' | 'skipped';
  note?: string;
}

export interface VerifyReport {
  format: 'apix-verify/1';
  apixVersion: string;
  chain: 'near' | 'hedera';
  network: string;
  /** Free text from the user (repo URL, app name); goes into the attestation */
  appId: string;
  /** git commit of the checked tree, when available */
  commit?: string;
  /** sha256 over the checked files (path + content), so the report pins the code */
  treeHash: string;
  filesScanned: number;
  checks: CheckResult[];
  findings: Finding[];
  summary: { checksRun: number; failures: number; warnings: number; verdict: Verdict };
}
