import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { addAgentWallet, planAgentWallet } from '../agent-wallet';
import { verifyNearProject } from '../../verify';
import { FileConflictError } from '../../generation/integration-generator';

async function nextApp(srcDir: boolean): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'apix-aw-'));
  await fs.writeJson(path.join(dir, 'package.json'), { name: 'agent-shop', dependencies: { next: '15.0.0', react: '19.0.0' } });
  await fs.outputFile(path.join(dir, srcDir ? 'src/app/page.tsx' : 'app/page.tsx'), 'export default function Page() { return null; }\n');
  await fs.writeFile(path.join(dir, '.gitignore'), '.env*.local\nnode_modules\n');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

describe('apix add agent-wallet --chain near', () => {
  it('generates server-only vault code, tools, routes and a component', async () => {
    const dir = await nextApp(false);
    const result = await addAgentWallet(dir, { install: false });
    expect(result.written.sort()).toEqual([
      'app/api/agent/pay/route.ts',
      'app/api/agent/vault/route.ts',
      'components/near/AgentVaultStatus.tsx',
      'lib/near/agent-tools.ts',
      'lib/near/agent-vault.ts',
    ]);
    const tools = await fs.readFile(path.join(dir, 'lib/near/agent-tools.ts'), 'utf8');
    expect(tools).toContain("from './agent-vault'");
    const route = await fs.readFile(path.join(dir, 'app/api/agent/pay/route.ts'), 'utf8');
    expect(route).toContain("from '../../../../lib/near/agent-vault'");
    expect(await fs.readFile(path.join(dir, '.env.local'), 'utf8')).toMatch(/^APIX_AGENT_API_SECRET=[0-9a-f]{64}$/m);
    expect(result.envUpdated).toBe(true);
  });

  it('uses src/ when the app lives there', async () => {
    const dir = await nextApp(true);
    const files = (await planAgentWallet(dir)).map(f => f.path).sort();
    expect(files).toContain('src/app/api/agent/pay/route.ts');
    expect(files).toContain('src/lib/near/agent-vault.ts');
  });

  it('passes apix verify: what APIX generates meets its own checks', async () => {
    const dir = await nextApp(false);
    await addAgentWallet(dir, { install: false });
    await fs.writeJson(path.join(dir, 'package.json'), {
      name: 'agent-shop', dependencies: { next: '15.0.0', react: '19.0.0', 'near-api-js': '^7.5.3', 'server-only': '^0.0.1', openai: '^5' },
    });
    // An agent that uses the generated tools
    await fs.outputFile(path.join(dir, 'lib/agent.ts'),
      "import OpenAI from 'openai';\nimport { openAiTools, runVaultTool } from './near/agent-tools';\nexport { openAiTools, runVaultTool, OpenAI };\n");
    execFileSync('git', ['add', '-A'], { cwd: dir });
    const report = await verifyNearProject({ directory: dir, network: 'testnet', offline: true, apixVersion: 'test' });
    expect(report.findings).toEqual([]);
    expect(report.summary.verdict).toBe('pass');
  });

  it('refuses to overwrite edited files without --force', async () => {
    const dir = await nextApp(false);
    await addAgentWallet(dir, { install: false });
    await fs.appendFile(path.join(dir, 'lib/near/agent-vault.ts'), '// my change\n');
    await expect(addAgentWallet(dir, { install: false })).rejects.toBeInstanceOf(FileConflictError);
    const again = await addAgentWallet(dir, { install: false, force: true });
    expect(again.overwritten).toEqual(['lib/near/agent-vault.ts']);
  });

  it('refuses projects that are not Next.js', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'apix-aw-'));
    await fs.writeJson(path.join(dir, 'package.json'), { name: 'vite-app', dependencies: { vite: '6' } });
    await expect(addAgentWallet(dir, { install: false })).rejects.toThrow(/needs a Next.js project/);
  });
});
