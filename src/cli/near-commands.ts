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

export function registerNearCommands(program: Command): void {
  const near = program
    .command('near')
    .description('NEAR: give an AI agent a spending-limited vault (Agent Vault)');

  const vault = near.command('vault').description('Create and manage Agent Vaults');

  vault
    .command('create')
    .description('Create a vault account with no full-access key, and an agent key limited to pay/request_approval')
    .requiredOption('--account <owner>', 'Owner account that pays for and controls the vault (e.g. alice.testnet)')
    .option('--name <name>', 'Vault sub-account name: <name>.<owner>', 'agent-vault')
    .option('--per-tx <near>', 'Largest single payment the agent can make, in NEAR', '0.5')
    .option('--daily <near>', 'Most the agent can spend per 24h, in NEAR', '2')
    .option('--allow <accounts>', 'Comma-separated receivers the agent may pay', '')
    .option('--fund <near>', 'NEAR to move from the owner into the vault', '3')
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
      console.log(`   Per transaction ${formatNear(perTxLimit)} NEAR · daily ${formatNear(dailyLimit)} NEAR · funded ${formatNear(fund)} NEAR`);
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
