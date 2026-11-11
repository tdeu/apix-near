// src/cli/near-commands.ts
// `apix near ...`: Agent Vault commands.
import { Command } from 'commander';
import chalk from 'chalk';
import path from 'path';
import inquirer from 'inquirer';
import type { KeyPairString } from 'near-api-js';
import {
  resolveNetwork, loadCredentials, accountFor, txUrl, accountUrl, parseNear, formatNear, maskKey, NearNetwork,
} from '../near/config';
import {
  createVault, vaultSnapshot, agentPay, ownerCall, describeStatus,
} from '../near/vault';
import { upsertEnv, readEnv, isGitIgnored } from '../near/env-file';
import { maskSecrets } from '../utils/secrets';
import fs from 'fs-extra';
import { verifyNearProject } from '../verify';
import { printReport, reportHash } from '../verify/report';
import { VerifyReport } from '../verify/types';
import { attestReport, readAttestation, deployAttestations } from '../near/attest';
import { ATTESTATION_CONTRACT } from '../near/config';
import { addAgentWallet } from '../near/agent-wallet';

async function confirmNearMainnet(network: NearNetwork, yes?: boolean): Promise<void> {
  if (network !== 'mainnet' || yes) return;
  if (!process.stdin.isTTY) {
    throw new Error('This command spends real NEAR on MAINNET and there is no terminal to confirm on: re-run with --yes.');
  }
  const { ok } = await inquirer.prompt([{ type: 'confirm', name: 'ok', message: 'This will spend real NEAR on MAINNET. Continue?', default: false }]);
  if (!ok) throw new Error('Cancelled: nothing was sent to mainnet.');
}

function run(fn: (...args: any[]) => Promise<void>) {
  return async (...args: any[]) => {
    try {
      await fn(...args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(chalk.red(`❌ ${maskSecrets(cleanRpcError(message))}`));
      process.exitCode = 1;
    }
  };
}

/** Pulls the contract's own panic message out of a long RPC error */
export function cleanRpcError(message: string): string {
  const panic = /Smart contract panicked: ([^"\n}]+)/.exec(message);
  if (panic) return panic[1].trim();
  if (/AccountAlreadyExists|already exists/i.test(message)) return 'That vault account already exists. Pick another --name.';
  if (/NotEnoughBalance|LackBalanceForState/i.test(message)) return `Not enough NEAR on the account for this transaction.\n${message}`;
  return message;
}

async function agentKeyFrom(options: { envFile?: string }): Promise<{ key: KeyPairString; vault?: string }> {
  const env = options.envFile ? await readEnv(path.resolve(options.envFile)) : {};
  const key = process.env.NEAR_AGENT_PRIVATE_KEY ?? env.NEAR_AGENT_PRIVATE_KEY;
  if (!key) {
    throw new Error('No agent key. Set NEAR_AGENT_PRIVATE_KEY, or pass --env-file pointing at the file `apix near vault create` wrote.');
  }
  return { key: key as KeyPairString, vault: process.env.NEAR_VAULT_ID ?? env.NEAR_VAULT_ID };
}

export async function runAddNear(integration: string, options: { force?: boolean; install?: boolean }): Promise<void> {
  try {
    if (integration !== 'agent-wallet') {
      throw new Error(`On NEAR, apix add supports: agent-wallet (got "${integration}").`);
    }
    const root = process.cwd();
    const result = await addAgentWallet(root, { force: options.force, install: options.install });
    console.log(chalk.green(`✅ Agent wallet added (${result.written.length} files written, ${result.unchanged.length} unchanged)`));
    for (const file of result.written) console.log(`   + ${file}`);
    for (const file of result.overwritten) console.log(chalk.yellow(`   ~ ${file} (overwritten)`));
    if (result.installed.length) console.log(`   Installed ${result.installed.join(', ')}`);
    if (result.envUpdated) console.log('   Generated APIX_AGENT_API_SECRET in .env.local (protects POST /api/agent/pay)');
    const env = await readEnv(path.join(root, '.env.local'));
    console.log('');
    console.log(chalk.bold('Next steps'));
    if (!env.NEAR_VAULT_ID) {
      console.log('  1. Create the vault (writes NEAR_VAULT_ID and the agent key to .env.local):');
      console.log('     apix near vault create --account <you>.testnet --allow <receiver>.testnet --per-tx 0.5 --daily 2');
    } else {
      console.log(`  1. Vault already configured: ${env.NEAR_VAULT_ID}`);
    }
    console.log('  2. Give your model the tools: import { openAiTools, anthropicTools, runVaultTool } from lib/near/agent-tools');
    console.log('  3. Show limits in your UI: <AgentVaultStatus /> from components/near/AgentVaultStatus');
    console.log('  4. Check the result: apix verify');
    process.exit(0);
  } catch (error) {
    console.error(chalk.red(`❌ ${maskSecrets(error instanceof Error ? error.message : String(error))}`));
    process.exit(1);
  }
}

export function registerNearCommands(program: Command, apixVersion: string): void {
  program
    .command('verify [directory]')
    .description('Check an app built by APIX, an agent or a person: keys, spending routes, contracts, claimed transactions')
    .option('--chain <chain>', 'Chain to check', 'near')
    .option('--app-id <id>', 'Name for the report and attestation (default: package.json name)')
    .option('--network <network>', 'testnet or mainnet, recorded in the report (default NEAR_NETWORK or testnet)')
    .option('--offline', 'Code checks only, no ledger reads')
    .option('--out <file>', 'Where to write the JSON report', 'apix-report.json')
    .option('--json', 'Print the report as JSON instead of text')
    .action(run(async (directory: string | undefined, options) => {
      if (options.chain !== 'near') {
        throw new Error(`apix verify supports --chain near in this build. (${options.chain} verification is on the roadmap.)`);
      }
      const network = resolveNetwork(options.network);
      const report = await verifyNearProject({
        directory: directory ?? '.', appId: options.appId, network, offline: options.offline, apixVersion,
      });
      const hash = reportHash(report);
      await fs.writeFile(path.resolve(options.out), JSON.stringify(report, null, 2) + '\n');
      if (options.json) {
        console.log(JSON.stringify({ ...report, reportHash: hash }, null, 2));
      } else {
        printReport(report, hash);
        console.log(chalk.gray(`Report written to ${options.out}. Publish it on-chain with: apix attest ${options.out} --account <you>.testnet`));
      }
      if (report.summary.verdict === 'fail') process.exitCode = 1;
    }));

  program
    .command('attest [report]')
    .description('Publish the hash and summary of an apix verify report on NEAR (public, timestamped)')
    .requiredOption('--account <account>', 'Account that signs the attestation')
    .option('--network <network>', 'testnet or mainnet')
    .option('--contract <id>', 'Attestation contract (default: the APIX one for the network)')
    .option('--source <url>', 'Where the code and report live, e.g. a commit URL')
    .option('-y, --yes', 'Skip the mainnet confirmation')
    .action(run(async (reportFile: string | undefined, options) => {
      const network = resolveNetwork(options.network);
      const contractId = options.contract ?? ATTESTATION_CONTRACT[network];
      if (!contractId) throw new Error(`No attestation contract configured for ${network}. Pass --contract.`);
      const report = await fs.readJson(path.resolve(reportFile ?? 'apix-report.json')) as VerifyReport;
      if (report.format !== 'apix-verify/1') throw new Error('That file is not an apix verify report.');
      const credentials = await loadCredentials(network, options.account);
      await confirmNearMainnet(network, options.yes);
      const { txHash, hash } = await attestReport(accountFor(network, credentials), contractId, report, options.source);
      console.log(chalk.green(`✅ Attested ${report.appId}: ${report.summary.verdict.toUpperCase()} (${report.summary.failures} failures, ${report.summary.warnings} warnings)`));
      console.log(`   Report hash ${hash}`);
      console.log(chalk.gray(`   ${txUrl(network, txHash)}`));
      console.log(chalk.gray(`   Anyone can check it: apix attestation ${credentials.accountId} "${report.appId}" --report ${reportFile ?? 'apix-report.json'}`));
    }));

  program
    .command('attestation <attester> <appId>')
    .description('Read an attestation from NEAR, and check a report file against it')
    .option('--report <file>', 'Report file to compare with the on-chain hash')
    .option('--network <network>', 'testnet or mainnet')
    .option('--contract <id>', 'Attestation contract')
    .action(run(async (attester: string, appId: string, options) => {
      const network = resolveNetwork(options.network);
      const contractId = options.contract ?? ATTESTATION_CONTRACT[network];
      if (!contractId) throw new Error(`No attestation contract configured for ${network}. Pass --contract.`);
      const record = await readAttestation(network, contractId, attester, appId);
      if (!record) {
        console.log(chalk.yellow(`No attestation by ${attester} for "${appId}" on ${network}.`));
        process.exitCode = 1;
        return;
      }
      const when = new Date(Number(BigInt(record.timestamp_ns) / 1_000_000n)).toISOString();
      console.log(chalk.bold(`${record.app_id}: ${record.verdict.toUpperCase()}`) + chalk.gray(` (revision ${record.revision}, ${when})`));
      console.log(`  ${record.checks_run} checks · ${record.failures} failures · ${record.warnings} warnings · apix ${record.apix_version}`);
      console.log(`  Attested by ${record.attester}${record.source ? ` · ${record.source}` : ''}`);
      console.log(chalk.gray(`  Report hash ${record.report_hash}`));
      if (options.report) {
        const local = reportHash(await fs.readJson(path.resolve(options.report)));
        if (local === record.report_hash) {
          console.log(chalk.green(`✓ ${options.report} matches the on-chain attestation.`));
        } else {
          console.log(chalk.red(`✗ ${options.report} does NOT match (local hash ${local}).`));
          process.exitCode = 1;
        }
      }
    }));

  const near = program
    .command('near')
    .description('NEAR: give an AI agent a spending-limited vault (Agent Vault)');

  near
    .command('account-create <names...>')
    .description('Testnet: create free accounts through the NEAR faucet and save their keys to ~/.near-credentials/testnet')
    .action(run(async (names: string[]) => {
      const { KeyPair } = await import('near-api-js');
      const os = await import('os');
      for (const name of names) {
        const accountId = name.endsWith('.testnet') ? name : `${name}.testnet`;
        if (!/^[a-z0-9_-]{2,}\.testnet$/.test(accountId)) {
          throw new Error(`"${accountId}": use lowercase letters, digits, - or _ (top-level testnet names only).`);
        }
        const file = path.join(os.homedir(), '.near-credentials', 'testnet', `${accountId}.json`);
        if (await fs.pathExists(file)) {
          console.log(chalk.yellow(`= ${accountId}: key already saved in ${file}, skipping`));
          continue;
        }
        const key = KeyPair.fromRandom('ed25519');
        const response = await fetch('https://helper.nearprotocol.com/account', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: key.getPublicKey().toString() }),
          signal: AbortSignal.timeout(60_000),
        });
        if (!response.ok) {
          const text = (await response.text()).slice(0, 300);
          throw new Error(`Faucet refused ${accountId} (HTTP ${response.status}): ${text || 'no details'}. If the name is taken, try another.`);
        }
        await fs.outputJson(file, {
          account_id: accountId,
          public_key: key.getPublicKey().toString(),
          private_key: key.toString(),
        }, { spaces: 2, mode: 0o600 });
        console.log(chalk.green(`✅ ${accountId} created (key saved to ${file})`));
        console.log(chalk.gray(`   ${accountUrl('testnet', accountId)}`));
      }
    }));

  near
    .command('deploy-attestations')
    .description('Deploy your own attestation contract, locked (no access keys: nobody can change it)')
    .requiredOption('--account <owner>', 'Account that pays for the deployment')
    .option('--name <name>', 'Sub-account name: <name>.<owner>', 'attest')
    .option('--network <network>', 'testnet or mainnet')
    .option('-y, --yes', 'Skip the mainnet confirmation')
    .action(run(async (options) => {
      const network = resolveNetwork(options.network);
      const credentials = await loadCredentials(network, options.account);
      await confirmNearMainnet(network, options.yes);
      const { contractId, txHash, fund } = await deployAttestations(accountFor(network, credentials), options.name);
      console.log(chalk.green(`✅ Attestation contract deployed and locked: ${contractId}`));
      console.log(chalk.gray(`   ${formatNear(fund)} NEAR moved in for its storage. No access keys: nobody can change the code or the records.`));
      console.log(`   Use it with --contract ${contractId}, or set APIX_ATTESTATION_CONTRACT_${network.toUpperCase()}=${contractId}`);
      console.log(chalk.gray(`   ${txUrl(network, txHash)}`));
    }));

  const vault = near.command('vault').description('Create and manage Agent Vaults');

  vault
    .command('create')
    .description('Create a vault account with no full-access key, and an agent key limited to pay/request_approval')
    .requiredOption('--account <owner>', 'Owner account that pays for and controls the vault (e.g. alice.testnet)')
    .option('--name <name>', 'Vault sub-account name: <name>.<owner>', 'agent-vault')
    .option('--per-tx <near>', 'Largest single payment the agent can make, in NEAR', '0.5')
    .option('--daily <near>', 'Most the agent can spend per 24h, in NEAR', '2')
    .option('--allow <accounts>', 'Comma-separated receivers the agent may pay', '')
    .option('--fund <near>', 'NEAR the agent can spend (storage and gas reserve, ~2.2 NEAR, are added on top)', '3')
    .option('--env-file <file>', 'Where to write the agent key (must be gitignored)', '.env.local')
    .option('--network <network>', 'testnet or mainnet (default NEAR_NETWORK or testnet)')
    .option('-y, --yes', 'Skip the mainnet confirmation')
    .action(run(async (options) => {
      const network = resolveNetwork(options.network);
      const allowlist = String(options.allow).split(',').map((s: string) => s.trim()).filter(Boolean);
      if (allowlist.length === 0) {
        throw new Error('Give at least one receiver with --allow (the agent can only pay allowlisted accounts).');
      }
      const envFile = path.resolve(options.envFile);
      if (!await isGitIgnored(envFile, process.cwd())) {
        throw new Error(`${options.envFile} is not gitignored here. Add it to .gitignore first: the agent key goes in it.`);
      }
      const perTxLimit = parseNear(options.perTx, '--per-tx');
      const dailyLimit = parseNear(options.daily, '--daily');
      const fund = parseNear(options.fund, '--fund');

      const credentials = await loadCredentials(network, options.account);
      await confirmNearMainnet(network, options.yes);
      console.log(chalk.cyan(`Creating ${options.name}.${credentials.accountId} on ${network}…`));

      const result = await createVault(accountFor(network, credentials), {
        name: options.name, perTxLimit, dailyLimit, allowlist, fund,
      });
      await upsertEnv(envFile, {
        NEAR_NETWORK: network,
        NEAR_VAULT_ID: result.vaultId,
        NEAR_AGENT_PRIVATE_KEY: result.agentPrivateKey,
      });

      console.log(chalk.green(`✅ Vault created: ${result.vaultId}`));
      console.log(`   Per transaction ${formatNear(perTxLimit)} NEAR · daily ${formatNear(dailyLimit)} NEAR · spendable ${formatNear(fund)} NEAR`);
      console.log(chalk.gray(`   Moved ${formatNear(result.transferred)} NEAR: ${formatNear(fund)} to spend + ${formatNear(result.overhead)} for contract storage and gas reserve (stays locked in the vault)`));
      console.log(`   Allowlist: ${allowlist.join(', ')}`);
      console.log(`   Agent key: ${result.agentPublicKey} (function-call only: pay, request_approval)`);
      console.log(`   Agent private key written to ${options.envFile} (${maskKey(result.agentPrivateKey)})`);
      console.log(`   No full-access key exists on the vault: only the contract's rules move funds.`);
      console.log(chalk.gray(`   Transaction: ${txUrl(network, result.txHash)}`));
      console.log(chalk.gray(`   Account:     ${accountUrl(network, result.vaultId)}`));
    }));

  vault
    .command('status [vault]')
    .description('Show the policy, spending, keys and pending requests of a vault')
    .option('--env-file <file>', 'Read NEAR_VAULT_ID from this file', '.env.local')
    .option('--network <network>', 'testnet or mainnet')
    .option('--json', 'Print JSON')
    .action(run(async (vaultArg, options) => {
      const env = await readEnv(path.resolve(options.envFile));
      const network = resolveNetwork(options.network ?? env.NEAR_NETWORK);
      const vaultId = vaultArg ?? process.env.NEAR_VAULT_ID ?? env.NEAR_VAULT_ID;
      if (!vaultId) throw new Error('Which vault? Pass it as an argument or set NEAR_VAULT_ID.');
      const snap = await vaultSnapshot(network, vaultId);
      if (options.json) {
        console.log(JSON.stringify(snap, null, 2));
        return;
      }
      console.log(chalk.cyan.bold(`Agent Vault ${vaultId} (${network})`));
      console.log(`Owner:           ${snap.owner}`);
      describeStatus(snap.status).forEach(line => console.log(line));
      console.log(`Allowlist:       ${snap.allowlist.join(', ') || '(empty)'}`);
      console.log('Access keys on the account:');
      for (const key of snap.accessKeys) {
        const label = key.fullAccess
          ? chalk.red('FULL ACCESS')
          : `function-call → ${key.receiver} [${(key.methods ?? []).join(', ') || 'any method'}]`;
        console.log(`  ${key.publicKey.slice(0, 20)}…  ${label}`);
      }
      if (snap.accessKeys.some(k => k.fullAccess)) {
        console.log(chalk.red('⚠️  This vault has a full-access key: whoever holds it can bypass every limit.'));
      }
      for (const req of snap.pending) {
        console.log(chalk.yellow(`  pending #${req.id}: ${formatNear(req.amount)} NEAR → ${req.receiver_id} (${req.reason})${req.memo ? ` "${req.memo}"` : ''}`));
      }
      console.log(chalk.gray(accountUrl(network, vaultId)));
    }));

  vault
    .command('pay')
    .description('Pay from the vault with the agent key (what your agent does); refused payments explain why')
    .requiredOption('--to <account>', 'Receiver (must be on the allowlist)')
    .requiredOption('--amount <near>', 'Amount in NEAR')
    .option('--memo <memo>', 'Note stored in the payment event')
    .option('--escalate', 'If over a limit, file an approval request for the owner instead of failing')
    .option('--vault <vault>', 'Vault account (default NEAR_VAULT_ID)')
    .option('--env-file <file>', 'File with NEAR_AGENT_PRIVATE_KEY', '.env.local')
    .option('--network <network>', 'testnet or mainnet')
    .option('-y, --yes', 'Skip the mainnet confirmation')
    .action(run(async (options) => {
      const env = await readEnv(path.resolve(options.envFile));
      const network = resolveNetwork(options.network ?? env.NEAR_NETWORK);
      const { key, vault: vaultFromEnv } = await agentKeyFrom(options);
      const vaultId = options.vault ?? vaultFromEnv;
      if (!vaultId) throw new Error('Which vault? Pass --vault or set NEAR_VAULT_ID.');
      await confirmNearMainnet(network, options.yes);

      const outcome = await agentPay(network, vaultId, key, {
        receiverId: options.to,
        amount: parseNear(options.amount, '--amount'),
        memo: options.memo,
        escalate: options.escalate,
      });
      if (outcome.status === 'paid') {
        console.log(chalk.green(`✅ Paid ${options.amount} NEAR to ${options.to}`));
        console.log(chalk.gray(`   ${txUrl(network, outcome.txHash)}`));
      } else if (outcome.status === 'pending_approval') {
        console.log(chalk.yellow(`⏸️  Over the limit (${outcome.reason}).`));
        console.log(chalk.yellow(`   Filed approval request #${outcome.requestId}; the owner approves it with:`));
        console.log(`   apix near vault approve ${vaultId} ${outcome.requestId} --account <owner>`);
        console.log(chalk.gray(`   ${txUrl(network, outcome.txHash)}`));
      } else {
        console.log(chalk.red(`🛑 Refused by the vault policy: ${outcome.reason}`));
        console.log(chalk.gray('   Nothing was sent. (Checked with the contract\'s check_payment view before signing.)'));
        process.exitCode = 2;
      }
    }));

  const ownerAction = (
    name: string,
    description: string,
    method: Parameters<typeof ownerCall>[2],
    argsFrom: (rest: string[]) => Record<string, unknown>,
    usage: string,
  ) => {
    vault
      .command(`${name} <vault> ${usage}`.trim())
      .description(description)
      .requiredOption('--account <owner>', 'Vault owner account')
      .option('--network <network>', 'testnet or mainnet')
      .option('-y, --yes', 'Skip the mainnet confirmation')
      .action(run(async (vaultId: string, ...rest: any[]) => {
        const options = rest[rest.length - 2] && typeof rest[rest.length - 2] === 'object' ? rest[rest.length - 2] : {};
        const positional = rest.filter(r => typeof r === 'string') as string[];
        const network = resolveNetwork(options.network);
        const credentials = await loadCredentials(network, options.account);
        await confirmNearMainnet(network, options.yes);
        const hash = await ownerCall(accountFor(network, credentials), vaultId, method, argsFrom(positional));
        console.log(chalk.green(`✅ ${name} done on ${vaultId}`));
        console.log(chalk.gray(`   ${txUrl(network, hash)}`));
      }));
  };

  ownerAction('approve', 'Approve a pending over-limit payment (sends it)', 'approve', ([id]) => ({ id: Number(id) }), '<id>');
  ownerAction('reject', 'Reject a pending payment request', 'reject', ([id]) => ({ id: Number(id) }), '<id>');
  ownerAction('pause', 'Stop all agent payments immediately', 'pause', () => ({}), '');
  ownerAction('unpause', 'Allow agent payments again', 'unpause', () => ({}), '');
  ownerAction('allow', 'Add a receiver to the allowlist', 'allow_receiver', ([account]) => ({ account_id: account }), '<receiver>');
  ownerAction('disallow', 'Remove a receiver from the allowlist', 'remove_receiver', ([account]) => ({ account_id: account }), '<receiver>');
  ownerAction('revoke-key', 'Delete an agent key from the vault account', 'revoke_agent_key', ([key]) => ({ public_key: key }), '<publicKey>');
  ownerAction('set-limits', 'Change limits: <perTxNear> <dailyNear>', 'set_limits',
    ([perTx, daily]) => ({ per_tx_limit: parseNear(perTx, 'perTx').toString(), daily_limit: parseNear(daily, 'daily').toString() }),
    '<perTx> <daily>');
  ownerAction('withdraw', 'Send <near> from the vault back to the owner', 'withdraw',
    ([amount]) => ({ amount: parseNear(amount, 'amount').toString() }), '<near>');
}
