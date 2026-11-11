// src/verify/files.ts
// Collects the project's source files once, so every rule reads the same set.
import fs from 'fs-extra';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';

export interface SourceFile {
  /** Path relative to the project root, with forward slashes */
  path: string;
  content: string;
  /** Tracked by git (false when untracked, or when the project isn't a git repo) */
  tracked: boolean;
}

export interface ProjectFiles {
  root: string;
  files: SourceFile[];
  isGitRepo: boolean;
  commit?: string;
  packageJson?: Record<string, any>;
  treeHash: string;
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', 'out', 'coverage', 'target', '.turbo', '.vercel', '.cache', 'vendor',
]);
const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.rs', '.toml', '.yml', '.yaml']);
const MAX_BYTES = 512 * 1024;

export function isEnvFile(name: string): boolean {
  return /^\.env(\..+)?$/.test(name);
}

export async function collectFiles(root: string): Promise<ProjectFiles> {
  const absoluteRoot = path.resolve(root);
  if (!await fs.pathExists(absoluteRoot)) throw new Error(`No such directory: ${root}`);

  const { isGitRepo, tracked, commit } = gitInfo(absoluteRoot);
  const files: SourceFile[] = [];

  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(path.join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const full = path.join(dir, entry.name);
      const ext = path.extname(entry.name);
      if (!EXTENSIONS.has(ext) && !isEnvFile(entry.name)) continue;
      if (entry.name === 'package-lock.json' || entry.name === 'pnpm-lock.yaml' || entry.name === 'yarn.lock') continue;
      const stat = await fs.stat(full);
      if (stat.size > MAX_BYTES) continue;
      const rel = path.relative(absoluteRoot, full).split(path.sep).join('/');
      files.push({ path: rel, content: await fs.readFile(full, 'utf8'), tracked: tracked.has(rel) });
    }
  };
  await walk(absoluteRoot);
  files.sort((a, b) => a.path.localeCompare(b.path));

  // Env files hold secrets: hash their names only, never their content
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    hash.update(file.path + '\0');
    if (!isEnvFile(path.basename(file.path))) hash.update(file.content + '\0');
  }

  const pkgFile = files.find(f => f.path === 'package.json');
  let packageJson: Record<string, any> | undefined;
  try {
    packageJson = pkgFile ? JSON.parse(pkgFile.content) : undefined;
  } catch {
    packageJson = undefined;
  }

  return { root: absoluteRoot, files, isGitRepo, commit, packageJson, treeHash: hash.digest('hex') };
}

function gitInfo(root: string): { isGitRepo: boolean; tracked: Set<string>; commit?: string } {
  try {
    const out = execFileSync('git', ['ls-files', '-z'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    let commit: string | undefined;
    try {
      commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    } catch {
      commit = undefined;
    }
    return { isGitRepo: true, tracked: new Set(out.split('\0').filter(Boolean)), commit };
  } catch {
    return { isGitRepo: false, tracked: new Set() };
  }
}

/** 1-based line number of a character offset */
export function lineOf(content: string, index: number): number {
  return content.slice(0, index).split('\n').length;
}

/** Resolves a relative import from one source file to another in the set */
export function resolveImport(files: SourceFile[], from: string, specifier: string): SourceFile | undefined {
  let base: string;
  if (specifier.startsWith('.')) {
    base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  } else if (specifier.startsWith('@/') || specifier.startsWith('~/')) {
    const rest = specifier.slice(2);
    const candidates = [rest, `src/${rest}`];
    for (const candidate of candidates) {
      const found = matchModule(files, candidate);
      if (found) return found;
    }
    return undefined;
  } else {
    return undefined;
  }
  return matchModule(files, base);
}

function matchModule(files: SourceFile[], base: string): SourceFile | undefined {
  const options = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '/index.ts', '/index.tsx', '/index.js'].map(s => base + s);
  return files.find(f => options.includes(f.path));
}

export function importsOf(file: SourceFile): string[] {
  const specs: string[] = [];
  const re = /(?:import\s[^'"]*?from\s*|import\s*\(\s*|require\s*\(\s*|export\s[^'"]*?from\s*)['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(file.content)) !== null) specs.push(match[1]);
  return specs;
}
