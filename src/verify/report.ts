// src/verify/report.ts
import crypto from 'crypto';
import chalk from 'chalk';
import { CheckResult, Finding, Verdict, VerifyReport } from './types';

/** JSON with sorted keys and no whitespace: the bytes that get hashed and attested */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function reportHash(report: VerifyReport): string {
  return crypto.createHash('sha256').update(canonicalJson(report)).digest('hex');
}

export function summarize(checks: CheckResult[], findings: Finding[]): VerifyReport['summary'] {
  const failures = findings.filter(f => f.severity === 'fail').length;
  const warnings = findings.filter(f => f.severity === 'warn').length;
  const verdict: Verdict = failures > 0 ? 'fail' : warnings > 0 ? 'warn' : 'pass';
  return { checksRun: checks.filter(c => c.status !== 'skipped').length, failures, warnings, verdict };
}

export function printReport(report: VerifyReport, hash: string): void {
  const { summary } = report;
  const badge = summary.verdict === 'pass' ? chalk.bgGreen.black(' PASS ')
    : summary.verdict === 'warn' ? chalk.bgYellow.black(' WARN ') : chalk.bgRed.white(' FAIL ');
  console.log('');
  console.log(`${badge} ${chalk.bold(report.appId)}  ${chalk.gray(`(${report.chain} ${report.network}, ${report.filesScanned} files)`)}`);
  console.log('');
  for (const check of report.checks) {
    const icon = { passed: chalk.green('✓'), failed: chalk.red('✗'), warned: chalk.yellow('!'), skipped: chalk.gray('-') }[check.status];
    console.log(`  ${icon} ${check.title}${check.note ? chalk.gray(`  (${check.note})`) : ''}`);
  }
  const ordered = [...report.findings].sort((a, b) => rank(a) - rank(b));
  if (ordered.length > 0) console.log('');
  for (const f of ordered) {
    const tag = f.severity === 'fail' ? chalk.red('FAIL') : f.severity === 'warn' ? chalk.yellow('WARN') : chalk.gray('INFO');
    const where = f.file ? chalk.gray(` ${f.file}${f.line ? `:${f.line}` : ''}`) : '';
    console.log(`${tag} ${chalk.bold(f.title)}${where}`);
    console.log(`     ${f.detail}`);
    console.log(chalk.cyan(`     Fix: ${f.fix}`));
  }
  console.log('');
  console.log(`${summary.checksRun} checks · ${summary.failures} failures · ${summary.warnings} warnings`);
  console.log(chalk.gray(`Report hash: ${hash}`));
}

function rank(f: Finding): number {
  return f.severity === 'fail' ? 0 : f.severity === 'warn' ? 1 : 2;
}
