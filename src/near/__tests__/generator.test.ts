import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { addNear, planNear } from '../generator';
import { verifyNearProject } from '../../verify';

async function nextApp(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'apix-gen-'));
  await fs.writeJson(path.join(dir, 'package.json'), { name: 'near-app', dependencies: { next: '15.0.0', react: '19.0.0' } });
  await fs.outputFile(path.join(dir, 'app/page.tsx'), 'export default function Page() { return null; }\n');
  await fs.writeFile(path.join(dir, '.gitignore'), '.env*.local\nnode_modules\n');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

describe('apix add --chain near (wallet, token)', () => {
  it('wallet: provider, connect button and config, no keys anywhere', async () => {
    const dir = await nextApp();
    const result = await addNear(dir, 'wallet', { install: false });
    expect(result.written.sort()).toEqual([
      'components/near/ConnectWallet.tsx',
      'components/near/NearProvider.tsx',
      'lib/near/config.ts',
    ]);
    const provider = await fs.readFile(path.join(dir, 'components/near/NearProvider.tsx'), 'utf8');
    expect(provider).toContain("from '../../lib/near/config'");
    expect(provider).toContain('@hot-labs/near-connect');
    expect(provider).not.toMatch(/PRIVATE_KEY|KeyPair/);
  });

  it('token: adds token helpers, a read-only route and a panel that registers receivers', async () => {
    const dir = await nextApp();
    const result = await addNear(dir, 'token', { install: false });
    expect(result.written).toEqual(expect.arrayContaining(['lib/near/token.ts', 'app/api/token/route.ts', 'components/near/TokenPanel.tsx']));
    const panel = await fs.readFile(path.join(dir, 'components/near/TokenPanel.tsx'), 'utf8');
    expect(panel).toContain('storage_deposit');
    expect(panel).toContain("deposit: '1'");
  });

  it('wallet then token: shared files are left unchanged, not duplicated', async () => {
    const dir = await nextApp();
    await addNear(dir, 'wallet', { install: false });
    const second = await addNear(dir, 'token', { install: false });
    expect(second.unchanged.sort()).toEqual(['components/near/ConnectWallet.tsx', 'components/near/NearProvider.tsx', 'lib/near/config.ts']);
    expect(second.written).toHaveLength(3);
  });

  it('everything APIX generates for NEAR passes apix verify', async () => {
    const dir = await nextApp();
    for (const kind of ['wallet', 'token', 'agent-wallet'] as const) await addNear(dir, kind, { install: false });
    await fs.writeJson(path.join(dir, 'package.json'), {
      name: 'near-app',
      dependencies: { next: '15', react: '19', 'near-api-js': '^7.5.3', '@hot-labs/near-connect': '^0.12.0', 'server-only': '^0.0.1' },
    });
    execFileSync('git', ['add', '-A'], { cwd: dir });
    const report = await verifyNearProject({ directory: dir, network: 'testnet', offline: true, apixVersion: 'test' });
    expect(report.findings).toEqual([]);
  });

  it('plans under src/ when the app lives there', async () => {
    const dir = await nextApp();
    await fs.move(path.join(dir, 'app'), path.join(dir, 'src/app'));
    const files = (await planNear(dir, 'token')).files.map(f => f.path);
    expect(files).toContain('src/app/api/token/route.ts');
    expect(files).toContain('src/components/near/NearProvider.tsx');
  });
});
