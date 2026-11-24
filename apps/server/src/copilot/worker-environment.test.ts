import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { CopilotConfig } from './config.js';
import { COPILOT_CLI_VERSION, COPILOT_SDK_VERSION } from './dispatch-adapter.js';
import { copilotWorkerEnvironment, copilotWorkerOptions, verifyCopilotWorker } from './worker-environment.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-copilot-config-'));
  const config: CopilotConfig = { sdkDirectory: join(root, 'sdk'), homeDirectory: join(root, 'home'),
    workspace: join(root, 'workspace'), model: 'fixture-model', startupTimeoutMs: 1000,
    auth: { mode: 'github', credentialFile: join(root, 'key') } };
  for (const dir of [config.sdkDirectory, config.homeDirectory, config.workspace]) await mkdir(dir, { mode: 0o700 });
  await mkdir(join(config.sdkDirectory, 'dist'));
  const manifest = { name: '@github/copilot-sdk', version: COPILOT_SDK_VERSION, copilotCliVersion: COPILOT_CLI_VERSION };
  await writeFile(join(config.sdkDirectory, 'package.json'), JSON.stringify(manifest));
  await writeFile(join(config.sdkDirectory, 'dist', 'index.js'), 'throw new Error("must not import in verification")');
  await writeFile(config.auth.credentialFile, 'synthetic-worker-test-key\n', { mode: 0o600 });
  return { root, config, manifest, close: () => rm(root, { recursive: true, force: true }) };
}

test('Copilot pins SDK and bundled CLI before import, without reading credential contents', async () => {
  const f = await fixture();
  try {
    await rm(f.config.auth.credentialFile);
    assert.ok((await verifyCopilotWorker(f.config, copilotWorkerEnvironment(f.config))).endsWith('/dist/index.js'));
    for (const patch of [{ version: 'wrong' }, { copilotCliVersion: 'wrong' }, { name: 'wrong' }]) {
      await writeFile(join(f.config.sdkDirectory, 'package.json'), JSON.stringify({ ...f.manifest, ...patch }));
      await assert.rejects(verifyCopilotWorker(f.config, copilotWorkerEnvironment(f.config)));
    }
  } finally { await f.close(); }
});

test('Copilot child independently refuses SDK/workspace overlap before SDK import', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.config.sdkDirectory, 'nested'));
    for (const workspace of [f.config.sdkDirectory, join(f.config.sdkDirectory, 'nested')]) {
      const config = { ...f.config, workspace };
      await assert.rejects(verifyCopilotWorker(config, copilotWorkerEnvironment(config)));
    }
    const config = { ...f.config, workspace: f.config.sdkDirectory, sdkDirectory: join(f.config.sdkDirectory, 'nested') };
    await mkdir(join(config.sdkDirectory, 'dist'));
    await writeFile(join(config.sdkDirectory, 'package.json'), JSON.stringify(f.manifest));
    await writeFile(join(config.sdkDirectory, 'dist', 'index.js'), 'export {};');
    await assert.rejects(verifyCopilotWorker(config, copilotWorkerEnvironment(config)));
  } finally { await f.close(); }
});

test('Copilot worker refuses credential, proxy, preload and login environment inheritance', async () => {
  const f = await fixture();
  try {
    const env = copilotWorkerEnvironment(f.config);
    for (const patch of [{ GITHUB_TOKEN: 'secret' }, { GH_TOKEN: 'secret' }, { COPILOT_SDK_AUTH_TOKEN: 'secret' },
      { NODE_OPTIONS: '--require=evil' }, { HTTPS_PROXY: 'https://secret@proxy.invalid' }, { HOME: '/wrong' }, { COPILOT_HOME: '/wrong' }]) {
      await assert.rejects(verifyCopilotWorker(f.config, { ...env, ...patch }));
    }
    assert.equal(env.COPILOT_DISABLE_KEYTAR, '1');
  } finally { await f.close(); }
});

test('Copilot worker independently rejects a task grant directory inside protected paths', async () => {
  const f = await fixture();
  try {
    for (const boardToolsDirectory of [f.config.workspace, join(f.config.workspace, 'grants'),
      f.config.sdkDirectory, f.config.homeDirectory, f.config.auth.credentialFile]) {
      const config = { ...f.config, boardToolsDirectory };
      await assert.rejects(verifyCopilotWorker(config, copilotWorkerEnvironment(config)));
    }
  } finally { await f.close(); }
});

test('Copilot private directories cannot be public, aliased, overlapping or injected through existing config paths', async () => {
  const f = await fixture();
  try {
    await chmod(f.config.homeDirectory, 0o755);
    await assert.rejects(verifyCopilotWorker(f.config, copilotWorkerEnvironment(f.config)));
    await chmod(f.config.homeDirectory, 0o700);
    await symlink(f.config.homeDirectory, join(f.root, 'alias'));
    const aliased = { ...f.config, homeDirectory: join(f.root, 'alias') };
    await assert.rejects(verifyCopilotWorker(aliased, copilotWorkerEnvironment(aliased)));
    await symlink(f.config.workspace, join(f.config.homeDirectory, 'copilot'));
    await assert.rejects(verifyCopilotWorker(f.config, copilotWorkerEnvironment(f.config)));
  } finally { await f.close(); }
});

test('Copilot worker options keep GitHub token and custom provider key disjoint and deny ambient execution', async () => {
  const f = await fixture();
  try {
    const github = await copilotWorkerOptions(f.config);
    assert.equal(github.client.gitHubToken, 'synthetic-worker-test-key');
    assert.equal(github.session.provider, undefined);
    assert.equal(github.client.useLoggedInUser, false);
    assert.equal(github.client.mode, 'empty');
    for (const [key, value] of Object.entries(github.session)) {
      if (key.startsWith('enable')) assert.equal(value, false, key);
    }
    assert.deepEqual(github.session.availableTools, []);
    assert.deepEqual(github.session.excludedTools, ['builtin:*', 'mcp:*', 'custom:*']);
    assert.deepEqual(await github.session.onPermissionRequest(undefined), { kind: 'reject' });
    assert.equal(github.session.remoteSession, 'off');
    const custom = await copilotWorkerOptions({ ...f.config, auth: { mode: 'provider', credentialFile: f.config.auth.credentialFile,
      providerType: 'openai', baseUrl: 'https://provider.invalid/v1', wireApi: 'responses' } });
    assert.equal('gitHubToken' in custom.client, false);
    assert.deepEqual(custom.session.provider, { type: 'openai', baseUrl: 'https://provider.invalid/v1', wireApi: 'responses',
      transport: 'http', apiKey: 'synthetic-worker-test-key' });
    assert.equal(JSON.stringify(custom.client.env).includes('synthetic-worker-test-key'), false);
    assert.equal(JSON.stringify(f.config).includes('synthetic-worker-test-key'), false);
  } finally { await f.close(); }
});

test('Copilot child credential access rejects broad permissions, aliases, non-files and invalid contents', async () => {
  const f = await fixture();
  try {
    await chmod(f.config.auth.credentialFile, 0o644);
    await assert.rejects(copilotWorkerOptions(f.config));
    await chmod(f.config.auth.credentialFile, 0o600);
    await symlink(f.config.auth.credentialFile, join(f.root, 'key-alias'));
    await assert.rejects(copilotWorkerOptions({ ...f.config, auth: { mode: 'github', credentialFile: join(f.root, 'key-alias') } }));
    await assert.rejects(copilotWorkerOptions({ ...f.config, auth: { mode: 'github', credentialFile: f.config.homeDirectory } }));
    for (const value of ['', 'one\ntwo', 'x'.repeat(16385), '\ufffd']) {
      await writeFile(f.config.auth.credentialFile, value);
      await assert.rejects(copilotWorkerOptions(f.config), error => !String(error).includes('synthetic-worker-test-key'));
    }
  } finally { await f.close(); }
});
