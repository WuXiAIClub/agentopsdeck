import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ClaudeConfig } from './config.js';
import { CLAUDE_CLI_VERSION, CLAUDE_SDK_VERSION } from './dispatch-adapter.js';
import { claudeWorkerEnvironment, readClaudeWorkerKey, verifyClaudeWorker } from './worker-environment.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-claude-config-'));
  const config: ClaudeConfig = { sdkDirectory: join(root, 'sdk'), homeDirectory: join(root, 'home'),
    workspace: join(root, 'workspace'), apiKeyFile: join(root, 'key'), model: 'fixture-model',
    baseUrl: 'https://fixture.invalid', startupTimeoutMs: 1000 };
  for (const dir of [config.sdkDirectory, config.homeDirectory, config.workspace]) await mkdir(dir, { mode: 0o700 });
  const manifest = { name: '@anthropic-ai/claude-agent-sdk', version: CLAUDE_SDK_VERSION, claudeCodeVersion: CLAUDE_CLI_VERSION };
  await writeFile(join(config.sdkDirectory, 'package.json'), JSON.stringify(manifest));
  await writeFile(join(config.sdkDirectory, 'sdk.mjs'), 'throw new Error("must not import in verification")');
  await writeFile(config.apiKeyFile, 'fixture-not-a-real-key\n', { mode: 0o600 });
  return { config, manifest, env: claudeWorkerEnvironment(config), close: () => rm(root, { recursive: true, force: true }) };
}

test('Claude worker verification pins both versions without importing SDK or reading a key', async () => {
  const f = await fixture();
  try {
    await rm(f.config.apiKeyFile);
    assert.ok((await verifyClaudeWorker(f.config, f.env)).endsWith('/sdk.mjs'));
    await writeFile(join(f.config.sdkDirectory, 'package.json'), JSON.stringify({ ...f.manifest, claudeCodeVersion: 'wrong' }));
    await assert.rejects(verifyClaudeWorker(f.config, f.env));
  } finally { await f.close(); }
});

test('Claude child independently refuses SDK/workspace overlap before SDK import', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.config.sdkDirectory, 'nested'));
    for (const workspace of [f.config.sdkDirectory, join(f.config.sdkDirectory, 'nested')]) {
      const config = { ...f.config, workspace };
      await assert.rejects(verifyClaudeWorker(config, claudeWorkerEnvironment(config)));
    }
    // Place SDK below the workspace with all other protected paths outside it.
    const config = { ...f.config, workspace: f.config.sdkDirectory, sdkDirectory: join(f.config.sdkDirectory, 'nested') };
    await writeFile(join(config.sdkDirectory, 'package.json'), JSON.stringify(f.manifest));
    await writeFile(join(config.sdkDirectory, 'sdk.mjs'), 'export {};');
    await assert.rejects(verifyClaudeWorker(config, claudeWorkerEnvironment(config)));
  } finally { await f.close(); }
});

test('Claude worker rejects inherited secrets, Node preloads, proxy and wrong HOME', async () => {
  const f = await fixture();
  try {
    for (const patch of [{ ANTHROPIC_API_KEY: 'secret' }, { NODE_OPTIONS: '--require=evil' },
      { HTTPS_PROXY: 'https://secret@proxy.invalid' }, { HOME: '/wrong' }]) {
      await assert.rejects(verifyClaudeWorker(f.config, { ...f.env, ...patch }), /could not be verified/);
    }
    assert.equal('ANTHROPIC_API_KEY' in f.env, false);
  } finally { await f.close(); }
});

test('Claude worker independently rejects a task grant directory inside protected paths', async () => {
  const f = await fixture();
  try {
    for (const boardToolsDirectory of [f.config.workspace, join(f.config.workspace, 'grants'),
      f.config.sdkDirectory, f.config.homeDirectory, f.config.apiKeyFile]) {
      const config = { ...f.config, boardToolsDirectory };
      await assert.rejects(verifyClaudeWorker(config, claudeWorkerEnvironment(config)));
    }
  } finally { await f.close(); }
});

test('Claude worker rejects public or aliased private home and writable nested config permissions', async () => {
  const f = await fixture();
  try {
    await chmod(f.config.homeDirectory, 0o755);
    await assert.rejects(verifyClaudeWorker(f.config, f.env));
    await chmod(f.config.homeDirectory, 0o700);
    const alias = f.config.homeDirectory + '-alias';
    await symlink(f.config.homeDirectory, alias);
    const aliased = { ...f.config, homeDirectory: alias };
    await assert.rejects(verifyClaudeWorker(aliased, claudeWorkerEnvironment(aliased)));
    await verifyClaudeWorker(f.config, f.env);
    await chmod(join(f.config.homeDirectory, 'claude'), 0o755);
    await assert.rejects(verifyClaudeWorker(f.config, f.env));
  } finally { await f.close(); }
});

test('Claude worker credential reader requires a bounded private regular file, no symlinks or multiline values', async () => {
  const f = await fixture();
  try {
    assert.equal(await readClaudeWorkerKey(f.config.apiKeyFile), 'fixture-not-a-real-key');
    await chmod(f.config.apiKeyFile, 0o644);
    await assert.rejects(readClaudeWorkerKey(f.config.apiKeyFile));
    await chmod(f.config.apiKeyFile, 0o600);
    await symlink(f.config.apiKeyFile, f.config.apiKeyFile + '-alias');
    await assert.rejects(readClaudeWorkerKey(f.config.apiKeyFile + '-alias'));
    for (const value of ['', 'one\ntwo', 'x'.repeat(16385)]) {
      await writeFile(f.config.apiKeyFile, value);
      await assert.rejects(readClaudeWorkerKey(f.config.apiKeyFile), error => !String(error).includes(value || 'fixture-not-a-real-key'));
    }
    await assert.rejects(readClaudeWorkerKey(f.config.homeDirectory));
  } finally { await f.close(); }
});
