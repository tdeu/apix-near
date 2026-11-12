// src/verify/near-rules.ts
// Static checks for NEAR apps: what an agent (or a person) most often gets
// wrong in code that holds keys or moves funds. No network needed.
import path from 'path';
import { CheckResult, Finding } from './types';
import { ProjectFiles, SourceFile, isEnvFile, lineOf, resolveImport, importsOf } from './files';

export interface RuleOutput {
  checks: CheckResult[];
  findings: Finding[];
}

// A NEAR ed25519 secret key is 64 bytes: ~87-88 base58 characters. Public keys are ~44.
const PRIVATE_KEY_RE = /ed25519:[1-9A-HJ-NP-Za-km-z]{80,90}\b/g;
const SECP_PRIVATE_KEY_RE = /secp256k1:[1-9A-HJ-NP-Za-km-z]{40,50}\b(?![1-9A-HJ-NP-Za-km-z])/g;
const SEED_PHRASE_CALL_RE = /parseSeedPhrase\s*\(\s*['"`]([a-z]+(?:\s+[a-z]+){11,23})['"`]/g;

/** Code that signs or sends something on NEAR */
const SIGNING_RE = /\b(signAndSendTransactions?|sendMoney|sendTransaction(?:Async|Until)?|callFunction(?:Raw)?|functionCall|createSubAccount|createAccount|deleteAccount|addFullAccessKey|addFunctionCallAccessKey|deployContract|transfer)\s*\(/;
/** Evidence the code is using NEAR's JS stack */
const NEAR_IMPORT_RE = /from\s+['"](near-api-js|@near-js\/[a-z-]+|@near-wallet-selector\/[a-z-]+|near-kit|@neardefi\/[a-z-]+)['"]|require\(\s*['"]near-api-js['"]\s*\)/;
/** A key-holding signer built from a secret */
const SERVER_SIGNER_RE = /KeyPair\.fromString|KeyPairSigner\.fromSecretKey|InMemoryKeyStore|new\s+Account\s*\([^)]*,\s*[^)]*,\s*[^)]+\)|parseSeedPhrase|PRIVATE_KEY|SECRET_KEY/;
const SECRET_ENV_NAME_RE = /[A-Z0-9_]*(PRIVATE_KEY|SECRET_KEY|SEED_PHRASE|MNEMONIC)[A-Z0-9_]*/;
const PUBLIC_ENV_PREFIX_RE = /\b(NEXT_PUBLIC_|VITE_|REACT_APP_|PUBLIC_|EXPO_PUBLIC_)[A-Z0-9_]*(PRIVATE_KEY|SECRET_KEY|SEED_PHRASE|MNEMONIC)[A-Z0-9_]*/g;
const AUTH_RE = /getServerSession|\bauth\s*\(\s*\)|currentUser\s*\(|@clerk\/|next-auth|verifyToken|jwt\.verify|jwtVerify|authorization|x-api-key|requireAuth|withAuth|getSession|supabase\.auth|verifySignature|verifyMessage|NEP-?413|signMessage|timingSafeEqual|ratelimit|rateLimit/i;
const LLM_IMPORT_RE = /from\s+['"](openai|@anthropic-ai\/sdk|ai|@ai-sdk\/[a-z-]+|langchain|@langchain\/[a-z-]+|@openai\/agents|@mastra\/[a-z-]+)['"]/;
const VAULT_RE = /NEAR_VAULT_ID|check_payment|request_approval|agent-vault|AgentVault/;
const AMOUNT_GUARD_RE = /MAX_[A-Z_]*(AMOUNT|SPEND|PAYMENT|TRANSFER)|LIMIT|Math\.min\s*\(|amount\s*[<>]=?|[<>]=?\s*amount|allowlist|allowList|ALLOWED_/;

function isClientFile(file: SourceFile, project: ProjectFiles): boolean {
  if (/^\s*['"]use client['"]/m.test(file.content.slice(0, 400))) return true;
  const deps = { ...(project.packageJson?.dependencies ?? {}), ...(project.packageJson?.devDependencies ?? {}) };
  const isNext = 'next' in deps;
  const browserOnly = !isNext && ('vite' in deps || 'react-scripts' in deps) && !('express' in deps);
  if (browserOnly && /^(src\/)?/.test(file.path) && /\.(tsx?|jsx?)$/.test(file.path) && !/(^|\/)(server|api|scripts?)\//.test(file.path) && !/vite\.config|\.config\./.test(file.path)) {
    return true;
  }
  return /(^|\/)(components|hooks)\//.test(file.path) && /\.(tsx|jsx)$/.test(file.path);
}

function isServerRoute(file: SourceFile): boolean {
  return /(^|\/)app\/(.+\/)?route\.(ts|js|mjs)$/.test(file.path)
    || /(^|\/)pages\/api\//.test(file.path)
    || /(^|\/)(api|server|functions)\/.+\.(ts|js|mjs)$/.test(file.path)
    || /\b(app|router)\.(post|put|patch|delete|all)\s*\(/.test(file.content);
}

function isCode(file: SourceFile): boolean {
  return /\.(tsx?|jsx?|mjs|cjs)$/.test(file.path) && !/(^|\/)(__tests__|tests?)\/|\.(test|spec)\./.test(file.path);
}

/** File plus the local modules it imports, one level deep */
function withImports(file: SourceFile, files: SourceFile[]): SourceFile[] {
  const out = [file];
  for (const spec of importsOf(file)) {
    const target = resolveImport(files, file.path, spec);
    if (target && !out.includes(target)) out.push(target);
  }
  return out;
}

const signs = (f: SourceFile) => NEAR_IMPORT_RE.test(f.content) && SIGNING_RE.test(f.content) && SERVER_SIGNER_RE.test(f.content);

export function runNearStaticRules(project: ProjectFiles): RuleOutput {
  const checks: CheckResult[] = [];
  const findings: Finding[] = [];
  const code = project.files.filter(isCode);
  const usesNear = project.files.some(f => NEAR_IMPORT_RE.test(f.content))
    || /near-api-js|@near-js\/|near-sdk|@near-wallet-selector/.test(JSON.stringify(project.packageJson ?? {}));

  const record = (rule: string, title: string, found: Finding[], skipped?: string) => {
    if (skipped) {
      checks.push({ rule, title, status: 'skipped', note: skipped });
      return;
    }
    findings.push(...found);
    const status = found.some(f => f.severity === 'fail') ? 'failed' : found.some(f => f.severity === 'warn') ? 'warned' : 'passed';
    checks.push({ rule, title, status });
  };

  // 0. Nothing to verify must never read as a pass
  if (!usesNear) {
    findings.push({
      rule: 'NEAR-NOTHING-TO-CHECK', severity: 'warn',
      title: 'No NEAR code found',
      detail: 'This project has no NEAR dependency or NEAR code, so most checks could not run. A pass here would mean nothing.',
      fix: 'Run apix verify in the folder of the NEAR app (where its package.json is).',
    });
    checks.push({ rule: 'NEAR-NOTHING-TO-CHECK', title: 'The project contains NEAR code to check', status: 'warned' });
  }

  // 1. Private keys and seed phrases written into files git would publish
  {
    const found: Finding[] = [];
    for (const file of project.files) {
      const env = isEnvFile(path.basename(file.path));
      // Local secrets git will never publish (gitignored files, or untracked env files) are where keys belong.
      // Found in a real run: a gitignored data/*.json key file was reported as "in the repo".
      if (file.ignored && !file.tracked) continue;
      if (env && !file.tracked) continue;
      for (const re of [PRIVATE_KEY_RE, SECP_PRIVATE_KEY_RE]) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(file.content)) !== null) {
          found.push({
            rule: 'NEAR-KEY-IN-REPO', severity: 'fail',
            title: 'Private key written in the code',
            detail: `${file.path} contains a NEAR private key (${m[0].slice(0, 14)}…). Anyone who can read the repository can take every fund and permission of that account.`,
            fix: 'Move the account\'s funds to a new account now and delete this key from it (the old key stays in git history). Load keys from an untracked .env.local instead.',
            file: file.path, line: lineOf(file.content, m.index),
          });
        }
      }
      SEED_PHRASE_CALL_RE.lastIndex = 0;
      let s: RegExpExecArray | null;
      while ((s = SEED_PHRASE_CALL_RE.exec(file.content)) !== null) {
        found.push({
          rule: 'NEAR-KEY-IN-REPO', severity: 'fail',
          title: 'Seed phrase written in the code',
          detail: `${file.path} contains a seed phrase. It recovers every key derived from it.`,
          fix: 'Treat the wallet as compromised: move funds to a new wallet, then remove the phrase from the code.',
          file: file.path, line: lineOf(file.content, s.index),
        });
      }
    }
    record('NEAR-KEY-IN-REPO', 'No private keys or seed phrases in committed files', found);
  }

  // 2. Env files with secrets that git would commit
  {
    const found: Finding[] = [];
    if (!project.isGitRepo) {
      record('NEAR-ENV-COMMITTED', 'Env files with secrets are not committed', [], 'not a git repository');
    } else {
      for (const file of project.files.filter(f => isEnvFile(path.basename(f.path)) && f.tracked)) {
        const secretLine = file.content.split('\n').findIndex(l => SECRET_ENV_NAME_RE.test(l.split('=')[0] ?? '') && /=\s*\S{8,}/.test(l) && !/=\s*(<|your|xxx|changeme|ed25519:\.\.\.)/i.test(l));
        if (secretLine >= 0) {
          found.push({
            rule: 'NEAR-ENV-COMMITTED', severity: 'fail',
            title: 'Secret committed in an env file',
            detail: `${file.path} is tracked by git and sets ${file.content.split('\n')[secretLine].split('=')[0].trim()}.`,
            fix: `Rotate that key, run "git rm --cached ${file.path}", and add ${path.basename(file.path)} to .gitignore. Commit a .env.example with placeholders instead.`,
            file: file.path, line: secretLine + 1,
          });
        }
      }
      record('NEAR-ENV-COMMITTED', 'Env files with secrets are not committed', found);
    }
  }

  // 3. Secrets exposed to the browser through public env prefixes
  {
    const found: Finding[] = [];
    for (const file of project.files) {
      PUBLIC_ENV_PREFIX_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = PUBLIC_ENV_PREFIX_RE.exec(file.content)) !== null) {
        found.push({
          rule: 'NEAR-KEY-PUBLIC-ENV', severity: 'fail',
          title: 'Secret exposed to the browser',
          detail: `${m[0]} in ${file.path}: variables starting with ${m[1]} are copied into the JavaScript every visitor downloads.`,
          fix: 'Rename it without the public prefix and only read it in server code (API routes, server actions). Rotate the key if this was ever deployed.',
          file: file.path, line: lineOf(file.content, m.index),
        });
      }
    }
    record('NEAR-KEY-PUBLIC-ENV', 'No secret behind a public (browser) env prefix', found);
  }

  // 4. Client code that holds a key
  {
    const found: Finding[] = [];
    for (const file of code.filter(f => isClientFile(f, project))) {
      const m = /KeyPair\.fromString|KeyPairSigner\.fromSecretKey|InMemoryKeyStore|parseSeedPhrase|process\.env\.[A-Z0-9_]*(PRIVATE_KEY|SECRET_KEY|SEED_PHRASE|MNEMONIC)|import\.meta\.env\.[A-Z0-9_]*(PRIVATE_KEY|SECRET_KEY)/.exec(file.content);
      if (m) {
        found.push({
          rule: 'NEAR-KEY-IN-CLIENT', severity: 'fail',
          title: 'Browser code handles a private key',
          detail: `${file.path} runs in the browser and uses ${m[0]}. Any key it touches is visible to every user.`,
          fix: 'In the browser, let users sign with their own wallet (apix add wallet --chain near sets that up). Keep app keys in server-only code, ideally behind an Agent Vault: apix add agent-wallet --chain near.',
          file: file.path, line: lineOf(file.content, m.index),
        });
      }
    }
    record('NEAR-KEY-IN-CLIENT', 'Browser code never handles private keys', found, usesNear ? undefined : 'no NEAR code found');
  }

  // 5. Server routes that spend without checking who is asking
  const spendingRoutes: SourceFile[] = [];
  {
    const found: Finding[] = [];
    for (const route of code.filter(isServerRoute)) {
      const scope = withImports(route, project.files);
      const signer = scope.find(signs);
      if (!signer) continue;
      // A route only counts when it can trigger the signing: it signs itself,
      // handles a mutating method, or calls something that pays/sends
      const mutating = /export\s+(async\s+)?(function|const)\s+(POST|PUT|PATCH|DELETE)\b/.test(route.content)
        || /\b(app|router)\.(post|put|patch|delete|all)\s*\(/.test(route.content)
        || /req\.method\s*===?\s*['"](POST|PUT|PATCH|DELETE)['"]/.test(route.content);
      const triggers = SIGNING_RE.test(route.content)
        || /\b(pay|send|transfer|tip|withdraw|mint|swap|bridge)\w*\s*\(/i.test(route.content.replace(/\bimport[^;]+;/g, ''));
      if (!mutating && !triggers) continue;
      spendingRoutes.push(route);
      const guarded = scope.some(f => AUTH_RE.test(f.content));
      if (!guarded) {
        found.push({
          rule: 'NEAR-UNPROTECTED-SPEND-ROUTE', severity: 'fail',
          title: 'Anyone on the internet can make this route spend',
          detail: `${route.path} signs NEAR transactions with the app's key${signer !== route ? ` (through ${signer.path})` : ''} and has no authentication. Anyone who finds the URL can call it in a loop.`,
          fix: 'Require a signed-in user or a server-to-server secret before signing, and rate-limit the route. Better: sign through an Agent Vault so the chain itself caps what the key can spend.',
          file: route.path,
        });
      }
      const readsBody = /request\.json\(\)|req\.body|formData\(\)|searchParams/.test(route.content);
      const capped = scope.some(f => AMOUNT_GUARD_RE.test(f.content) || VAULT_RE.test(f.content));
      if (readsBody && !capped) {
        found.push({
          rule: 'NEAR-UNPROTECTED-SPEND-ROUTE', severity: 'warn',
          title: 'Amount comes from the request with no cap',
          detail: `${route.path} takes input from the request and signs a transaction, with no maximum amount or allowlist in sight.`,
          fix: 'Validate the amount and receiver against fixed limits on the server, or enforce them on-chain with an Agent Vault.',
          file: route.path,
        });
      }
    }
    record('NEAR-UNPROTECTED-SPEND-ROUTE', 'Routes that spend check who is calling and how much', found, usesNear ? undefined : 'no NEAR code found');
  }

  // 6. AI tools that can move funds with no limit
  {
    const found: Finding[] = [];
    for (const file of code.filter(f => LLM_IMPORT_RE.test(f.content))) {
      const scope = withImports(file, project.files);
      const signer = scope.find(signs);
      if (!signer) continue;
      if (scope.some(f => VAULT_RE.test(f.content))) continue;
      found.push({
        rule: 'NEAR-AGENT-UNBOUNDED-SPEND', severity: 'fail',
        title: 'An AI model can spend with no on-chain limit',
        detail: `${file.path} gives a language model tools that sign NEAR transactions${signer !== file ? ` (via ${signer.path})` : ''}. A prompt injection or a bad loop can send everything the key controls.`,
        fix: 'Give the agent a vault instead of a key: apix near vault create, then apix add agent-wallet --chain near. Limits, allowlist and pause are then enforced by the contract.',
        file: file.path,
      });
    }
    record('NEAR-AGENT-UNBOUNDED-SPEND', 'AI tools that move funds are bounded on-chain', found, usesNear ? undefined : 'no NEAR code found');
  }

  // 7. Mainnet hardcoded in code that spends
  {
    const found: Finding[] = [];
    for (const file of code.filter(f => signs(f))) {
      // Flags a mainnet endpoint used directly, not a lookup table keyed by network
      const m = /networkId\s*:\s*['"]mainnet['"]|url\s*:\s*['"]https:\/\/(rpc\.mainnet\.near\.org|[a-z.]*mainnet[a-z.]*fastnear\.com)|JsonRpcProvider\(\s*\{?\s*(url\s*:\s*)?['"]https:\/\/[^'"]*mainnet/.exec(file.content);
      if (m) {
        found.push({
          rule: 'NEAR-MAINNET-HARDCODED', severity: 'warn',
          title: 'Mainnet is hardcoded in code that spends',
          detail: `${file.path} signs transactions and points at mainnet directly, so every test run spends real NEAR.`,
          fix: 'Read the network from configuration (NEAR_NETWORK), default to testnet, and switch to mainnet deliberately.',
          file: file.path, line: lineOf(file.content, m.index),
        });
      }
    }
    record('NEAR-MAINNET-HARDCODED', 'Network is configuration, not hardcoded', found, usesNear ? undefined : 'no NEAR code found');
  }

  return { checks, findings };
}

/** Accounts and contracts the project points at, for the on-chain checks */
export function referencedAccounts(project: ProjectFiles): { contracts: string[]; signers: string[] } {
  const contracts = new Set<string>();
  const signers = new Set<string>();
  const accountRe = /\b([a-z0-9_-]+(?:\.[a-z0-9_-]+)*\.(?:testnet|near))\b/g;
  for (const file of project.files) {
    const isEnv = isEnvFile(path.basename(file.path));
    for (const line of file.content.split('\n')) {
      const key = line.split('=')[0]?.trim() ?? '';
      accountRe.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = accountRe.exec(line)) !== null) {
        if (/CONTRACT|contractId|contract_id/i.test(isEnv ? key : line)) contracts.add(m[1]);
        else if (/ACCOUNT_ID|accountId|SIGNER|OPERATOR/i.test(isEnv ? key : line)) signers.add(m[1]);
      }
    }
  }
  return { contracts: [...contracts].sort(), signers: [...signers].sort() };
}
