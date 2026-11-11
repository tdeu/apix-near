// src/near/env-file.ts
// Writes secrets to a gitignored env file, never to the terminal.
import fs from 'fs-extra';
import path from 'path';

/** Sets KEY=value lines in an env file, replacing existing ones, keeping the rest */
export async function upsertEnv(file: string, values: Record<string, string>): Promise<void> {
  const existing = await fs.pathExists(file) ? await fs.readFile(file, 'utf8') : '';
  const lines = existing.split(/\r?\n/);
  const pending = new Map(Object.entries(values));
  const updated = lines.map(line => {
    const match = /^\s*([A-Z0-9_]+)\s*=/.exec(line);
    if (match && pending.has(match[1])) {
      const value = pending.get(match[1])!;
      pending.delete(match[1]);
      return `${match[1]}=${value}`;
    }
    return line;
  });
  while (updated.length > 0 && updated[updated.length - 1] === '') updated.pop();
  for (const [key, value] of pending) updated.push(`${key}=${value}`);
  await fs.ensureDir(path.dirname(file));
  await fs.writeFile(file, updated.join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
}

/** Reads KEY=value pairs (no expansion, quotes stripped) */
export async function readEnv(file: string): Promise<Record<string, string>> {
  if (!await fs.pathExists(file)) return {};
  const out: Record<string, string> = {};
  for (const line of (await fs.readFile(file, 'utf8')).split(/\r?\n/)) {
    const match = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match) out[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

/**
 * True when git would ignore the file, judged from the .gitignore files between
 * the file and the project root (simple patterns only: exact names and *.ext / prefix*).
 */
export async function isGitIgnored(file: string, root: string): Promise<boolean> {
  const name = path.basename(file);
  let dir = path.dirname(path.resolve(file));
  const stop = path.resolve(root);
  for (;;) {
    const ignore = path.join(dir, '.gitignore');
    if (await fs.pathExists(ignore)) {
      const patterns = (await fs.readFile(ignore, 'utf8')).split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#') && !l.startsWith('!'));
      if (patterns.some(p => matchesName(p.replace(/^\//, ''), name))) return true;
    }
    if (dir === stop || path.dirname(dir) === dir) return false;
    dir = path.dirname(dir);
  }
}

function matchesName(pattern: string, name: string): boolean {
  if (pattern === name) return true;
  if (!pattern.includes('*')) return false;
  const regex = new RegExp('^' + pattern.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  return regex.test(name);
}
