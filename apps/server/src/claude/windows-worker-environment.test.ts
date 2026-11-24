import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ClaudeConfig } from './config.js';
import { assertClaudeWorkerEnvironment, claudeWorkerEnvironment } from './worker-environment.js';
import { assertCopilotWorkerEnvironment, copilotWorkerEnvironment } from '../copilot/worker-environment.js';

const config: ClaudeConfig = {
  sdkDirectory: 'C:\\private-sdk', homeDirectory: 'D:\\Private Home\\\u7528\u6237',
  workspace: 'F:\\workspace', apiKeyFile: 'C:\\private-key',
  baseUrl: 'https://fixture.invalid', model: 'fixture', startupTimeoutMs: 1_000,
};
const host: { execPath: string; env: NodeJS.ProcessEnv } = { execPath: 'C:\\runtime\\node.exe', env: {
  SystemRoot: 'C:\\Windows', USERNAME: 'fixture-user', USERDOMAIN: 'fixture-domain',
  LOGONSERVER: '\\\\fixture-server', HOMEDRIVE: 'C:', HOMEPATH: '\\Users\\personal',
  NODE_OPTIONS: '--require=untrusted', ANTHROPIC_API_KEY: 'must-not-inherit', HTTPS_PROXY: 'https://fixture.invalid',
} };

test('Copilot Windows validation shares private drive binding and rejects ambiguous or injected environment', () => {
  const copilot = { ...config, auth: { mode: 'github' as const, credentialFile: config.apiKeyFile } };
  const env = copilotWorkerEnvironment(copilot, 'win32', host);
  assert.equal(env.HOMEDRIVE! + env.HOMEPATH!, config.homeDirectory);
  const lower = Object.fromEntries(Object.entries(env).map(([name, value]) => [name.toLowerCase(), value]));
  assert.doesNotThrow(() => assertCopilotWorkerEnvironment(copilot, lower, 'win32', host));
  for (const changes of [{ home: config.homeDirectory }, { HOMEDRIVE: 'C:' },
    { NODE_OPTIONS: '--require=untrusted' }, { GITHUB_TOKEN: 'must-not-inherit' }]) {
    assert.throws(() => assertCopilotWorkerEnvironment(copilot, { ...env, ...changes }, 'win32', host));
  }
  assert.throws(() => copilotWorkerEnvironment(copilot, 'win32', {
    ...host, env: { ...host.env, systemroot: 'D:\\Windows' },
  }));
});

test('Windows worker pins system and private HOME drives separately and inherits only identity metadata', () => {
  const env = claudeWorkerEnvironment(config, 'win32', host);
  assert.equal(env.SYSTEMDRIVE, 'C:');
  assert.equal(env.HOMEDRIVE, 'D:');
  assert.equal(env.HOMEPATH, '\\Private Home\\\u7528\u6237');
  assert.equal(env.HOMEDRIVE! + env.HOMEPATH!, config.homeDirectory);
  for (const name of ['HOME', 'USERPROFILE']) assert.equal(env[name], config.homeDirectory);
  for (const name of ['USERNAME', 'USERDOMAIN', 'LOGONSERVER']) assert.equal(env[name], host.env[name]);
  for (const name of ['NODE_OPTIONS', 'ANTHROPIC_API_KEY', 'HTTPS_PROXY']) assert.equal(Object.hasOwn(env, name), false);
  assert.doesNotThrow(() => assertClaudeWorkerEnvironment(config, env, 'win32', host));
  const sameDrive = { ...config, homeDirectory: 'C:\\Private Home' };
  assert.equal(claudeWorkerEnvironment(sameDrive, 'win32', host).HOMEDRIVE, 'C:');
});

test('Windows worker treats environment names case-insensitively but rejects ambiguous duplicates', () => {
  const lowerHost = { execPath: host.execPath,
    env: { systemroot: 'C:\\Windows', username: 'fixture-user', userdomain: 'fixture-domain', logonserver: '\\\\fixture-server' } };
  const env = claudeWorkerEnvironment(config, 'win32', lowerHost);
  const lower = Object.fromEntries(Object.entries(env).map(([name, value]) => [name.toLowerCase(), value]));
  assert.doesNotThrow(() => assertClaudeWorkerEnvironment(config, lower, 'win32', lowerHost));
  assert.throws(() => assertClaudeWorkerEnvironment(config, { ...env, home: config.homeDirectory }, 'win32', lowerHost));
  assert.throws(() => claudeWorkerEnvironment(config, 'win32', {
    ...host, env: { ...host.env, systemroot: 'D:\\Windows' },
  }));
});

test('Windows worker refuses unknown variables and altered HOME paths', () => {
  const env = claudeWorkerEnvironment(config, 'win32', host);
  for (const changes of [
    { NODE_OPTIONS: '--require=untrusted' }, { ANTHROPIC_API_KEY: 'must-not-inherit' },
    { HTTPS_PROXY: 'https://fixture.invalid' }, { constructor: 'not-an-environment-control' },
    { HOME: 'C:\\Users\\personal' }, { USERPROFILE: 'C:\\Users\\personal' },
    { HOMEDRIVE: 'C:' }, { HOMEPATH: '\\Users\\personal' }, { SYSTEMDRIVE: 'D:' },
  ]) {
    assert.throws(() => assertClaudeWorkerEnvironment(config, { ...env, ...changes }, 'win32', host));
  }
});

test('Windows worker permits absent logon metadata but refuses malformed metadata or non-drive HOME', () => {
  const minimalHost = { execPath: host.execPath, env: { SystemRoot: 'C:\\Windows' } };
  const env = claudeWorkerEnvironment(config, 'win32', minimalHost);
  for (const name of ['USERNAME', 'USERDOMAIN', 'LOGONSERVER']) assert.equal(Object.hasOwn(env, name), false);
  assert.doesNotThrow(() => assertClaudeWorkerEnvironment(config, env, 'win32', minimalHost));
  assert.throws(() => claudeWorkerEnvironment(config, 'win32', { ...host, env: { SystemRoot: 'C:\\Windows', USERNAME: 'invalid\nname' } }));
  assert.throws(() => claudeWorkerEnvironment({ ...config, homeDirectory: '\\\\server\\share\\home' }, 'win32', host));
});

test('Linux environment validation retains case-sensitive names and rejects Windows-only variables', () => {
  const env = claudeWorkerEnvironment(config, 'linux', host);
  assert.doesNotThrow(() => assertClaudeWorkerEnvironment(config, env, 'linux', host));
  const { HOME, ...withoutHome } = env;
  assert.throws(() => assertClaudeWorkerEnvironment(config, { ...withoutHome, home: HOME }, 'linux', host));
  assert.throws(() => assertClaudeWorkerEnvironment(config, { ...env, USERNAME: 'fixture-user' }, 'linux', host));
});

for (const runtime of ['claude-code', 'ghcp'] as const) test(`${runtime} native Windows fork receives exactly the controlled environment and private HOME paths`,
  { skip: process.platform !== 'win32', timeout: 10_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentopsdeck-win-env-'));
    try {
      const entry = join(directory, 'environment.cjs');
      await writeFile(entry, `process.once('message', expected => {
        const normalize = name => name.toUpperCase();
        const wanted = new Map(Object.entries(expected).map(([name, value]) => [normalize(name), value]));
        const actual = new Map(Object.entries(process.env).map(([name, value]) => [normalize(name), value]));
        const controls = new Set(['NODE_CHANNEL_FD', 'NODE_CHANNEL_SERIALIZATION_MODE']);
        process.send({
          unexpected: [...actual.keys()].filter(name => !wanted.has(name) && !controls.has(name)),
          mismatched: [...wanted.keys()].filter(name => actual.get(name) !== wanted.get(name)),
          privateHome: actual.get('HOMEDRIVE') + actual.get('HOMEPATH') === wanted.get('HOME')
        }, error => { if (error) process.exitCode = 1; process.disconnect(); });
      });`);
      const env = runtime === 'claude-code' ? claudeWorkerEnvironment(config) : copilotWorkerEnvironment({
        ...config, auth: { mode: 'github', credentialFile: config.apiKeyFile },
      });
      const child = fork(entry, [], { env, execArgv: [], ...{ windowsHide: true },
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      const report = once(child, 'message');
      const exited = once(child, 'exit');
      child.send(env);
      assert.deepEqual((await report)[0], { unexpected: [], mismatched: [], privateHome: true });
      const [code, signal] = await exited;
      assert.equal(code, 0);
      assert.equal(signal, null);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
