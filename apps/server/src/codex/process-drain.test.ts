import assert from 'node:assert/strict';
import childProcess, { type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadConfig } from '../config.js';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { createConnectorRuntime } from '../connector/runtime.js';
import { linuxProcessGroupRunning } from './process-group.js';

// Real process lifetime, inert protocol only: no Agent binary, network, tools,
// credentials or persistent runtime. TERM acknowledges but deliberately waits.
const script = `
  process.on('SIGTERM', () => process.stderr.write('synthetic-stop\\n'));
  require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
    const request = JSON.parse(line);
    if (request.method === 'synthetic/exit') process.exit(0);
    if (request.id != null) process.stdout.write(JSON.stringify({ id: request.id,
      result: request.method === 'thread/list' ? { data: [], nextCursor: null } : {} }) + '\\n');
  });

`;

test('Connector retains SQLite after launcher exit until its own Linux descendants drain',
  { skip: process.platform !== 'linux', timeout: 15_000 }, async context => {
    const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-codex-descendant-drain-'));
    const file = join(directory, 'connector.sqlite');
    const ready = join(directory, 'ready'), released = join(directory, 'release'), stopped = join(directory, 'stopped');
    const nativeSpawn = childProcess.spawn;
    const descendant = `const fs = require('node:fs');
      process.on('SIGTERM', () => fs.writeFileSync(${JSON.stringify(stopped)}, 'stopped'));
      fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
      setInterval(() => { if (fs.existsSync(${JSON.stringify(released)})) process.exit(0); }, 25);`;
    const launcher = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore' });
      require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
        const request = JSON.parse(line);
        if (request.id != null) process.stdout.write(JSON.stringify({ id: request.id,
          result: request.method === 'thread/list' ? { data: [], nextCursor: null } : {} }) + '\\n');
      });`;
    let child: ChildProcessWithoutNullStreams | undefined;
    let exited: Promise<unknown> | undefined;
    context.mock.method(childProcess, 'spawn', (command: string, _args: string[], options: childProcess.SpawnOptions) => {
      assert.equal(command, 'synthetic-descendant-only');
      assert.equal(options.detached, true);
      child = nativeSpawn(process.execPath, ['-e', launcher], { cwd: directory, stdio: ['pipe', 'pipe', 'pipe'], detached: true,
        env: { PATH: '/usr/bin:/bin', HOME: directory, NODE_ENV: 'test' } });
      exited = once(child, 'close');
      return child;
    });
    syncBuiltinESMExports();
    const runtime = createConnectorRuntime(loadConfig({ AOD_SERVER_ROLE: 'connector', AOD_CODEX_ENABLED: 'true',
      AOD_LOCAL_OPENCLAW_CLI: 'false', AOD_CODEX_COMMAND: 'synthetic-descendant-only', AOD_CODEX_DEFAULT_CWD: directory,
      AOD_CONNECTOR_USERS_DATABASE_FILE: file, AOD_CONNECTOR_TOKENS_FILE: `${file}.tokens`,
      AOD_SESSION_TITLES_FILE: `${file}.titles`, AOD_QUEUE_FILE: `${file}.queue`,
      AOD_MIRROR_OUTBOX_FILE: `${file}.mirror`, AOD_ARTIFACT_INDEX_FILE: `${file}.artifacts`,
      AOD_CONNECTOR_UPDATE_STATE_FILE: `${file}.updates`,
    }), () => false);
    const foreign = nativeSpawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });
    const foreignExited = once(foreign, 'close');
    context.after(async () => {
      writeFileSync(released, 'release');
      if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
      foreign.kill('SIGTERM'); await foreignExited;
      await exited; await runtime.close();
      context.mock.restoreAll(); syncBuiltinESMExports();
      rmSync(directory, { recursive: true, force: true });
    });
    await runtime.codex.refreshSessions();
    for (let attempt = 0; attempt < 200 && !existsSync(ready); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(existsSync(ready));
    let closed = false;
    const closing = runtime.close().then(() => { closed = true; });
    await exited;
    for (let attempt = 0; attempt < 200 && !existsSync(stopped); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(existsSync(stopped));
    assert.equal(await linuxProcessGroupRunning(child!.pid!), true);
    assert.equal(closed, false);
    assert.throws(() => new ConnectorUserStore(file, undefined, { runtimeOwner: true }), /locked|busy/i);
    assert.equal(foreign.exitCode, null);
    assert.equal(foreign.signalCode, null);
    writeFileSync(released, 'release');
    await closing;
    assert.equal(await linuxProcessGroupRunning(child!.pid!), false);
    const next = new ConnectorUserStore(file, undefined, { runtimeOwner: true });
    next.close();
  });

for (const retire of [false, true]) test(`Connector retains SQLite owner until real child close, retired=${retire}`,
  { skip: process.platform === 'win32', timeout: 15_000 }, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-codex-process-drain-'));
    const file = join(directory, 'connector.sqlite');
    const nativeSpawn = childProcess.spawn;
    let child: ChildProcessWithoutNullStreams | undefined;
    let exited: Promise<unknown> | undefined;
    t.mock.method(childProcess, 'spawn', (command: string) => {
      assert.equal(command, 'synthetic-codex-process-only');
      assert.equal(child, undefined, 'no overlapping replacement is permitted');
      child = nativeSpawn(process.execPath, ['-e', script], { cwd: directory, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform === 'linux',
        env: { PATH: '/usr/bin:/bin', HOME: directory, NODE_ENV: 'test' } });
      exited = once(child, 'close');
      return child;
    });
    syncBuiltinESMExports();
    const runtime = createConnectorRuntime(loadConfig({
      AOD_SERVER_ROLE: 'connector', AOD_CODEX_ENABLED: 'true', AOD_LOCAL_OPENCLAW_CLI: 'false',
      AOD_CODEX_COMMAND: 'synthetic-codex-process-only', AOD_CODEX_DEFAULT_CWD: directory,
      AOD_CONNECTOR_USERS_DATABASE_FILE: file, AOD_CONNECTOR_TOKENS_FILE: `${file}.tokens`,
      AOD_SESSION_TITLES_FILE: `${file}.titles`, AOD_QUEUE_FILE: `${file}.queue`,
      AOD_MIRROR_OUTBOX_FILE: `${file}.mirror`, AOD_ARTIFACT_INDEX_FILE: `${file}.artifacts`,
      AOD_CONNECTOR_UPDATE_STATE_FILE: `${file}.updates`,
    }), () => false);
    t.after(async () => {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited; await runtime.close();
      t.mock.restoreAll(); syncBuiltinESMExports();
      rmSync(directory, { recursive: true, force: true });
    });
    await runtime.codex.refreshSessions();
    assert.ok(child);
    const stopped = once(child.stderr, 'data');
    if (retire) (runtime.codex as any).recycleChild(child, new Error('synthetic retirement'));
    let closed = false;
    const closing = runtime.close().then(() => { closed = true; });
    await stopped;
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(child.killed, process.platform !== 'linux');
    assert.equal(child.exitCode, null);
    assert.equal(closed, false, 'shutdown must not release storage while child is alive');
    assert.throws(() => new ConnectorUserStore(file, undefined, { runtimeOwner: true }), /locked|busy/i);
    const probe = childProcess.spawnSync(process.execPath,
      [...(import.meta.url.endsWith('.ts') ? ['--import', import.meta.resolve('tsx')] : []), '--input-type=module', '-e', `
        import assert from 'node:assert/strict';
        import { ConnectorUserStore } from ${JSON.stringify(new URL('../connector/connector-user-store.js', import.meta.url).href)};
        assert.throws(() => new ConnectorUserStore(${JSON.stringify(file)}, undefined, { runtimeOwner: true }), /locked|busy/i);
      `], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(probe.status, 0, probe.stderr);
    child.stdin.write(`${JSON.stringify({ method: 'synthetic/exit' })}\n`);
    await exited; await closing;
    assert.equal(closed, true);
    const next = new ConnectorUserStore(file, undefined, { runtimeOwner: true });
    try { assert.equal(next.nodeId, runtime.connectorUsers.nodeId); } finally { next.close(); }
  });

test('CodexAppServer handles EPIPE on child.stdin without uncaught error during shutdown',
  { skip: process.platform === 'win32', timeout: 15_000 }, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-codex-stdin-epipe-'));
    const file = join(directory, 'connector.sqlite');
    const nativeSpawn = childProcess.spawn;
    let child: ChildProcessWithoutNullStreams | undefined;
    let exited: Promise<unknown> | undefined;
    t.mock.method(childProcess, 'spawn', (command: string) => {
      assert.equal(command, 'synthetic-codex-epipe-only');
      child = nativeSpawn(process.execPath, ['-e', script], { cwd: directory, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform === 'linux',
        env: { PATH: '/usr/bin:/bin', HOME: directory, NODE_ENV: 'test' } });
      exited = once(child, 'close');
      return child;
    });
    syncBuiltinESMExports();
    const runtime = createConnectorRuntime(loadConfig({
      AOD_SERVER_ROLE: 'connector', AOD_CODEX_ENABLED: 'true', AOD_LOCAL_OPENCLAW_CLI: 'false',
      AOD_CODEX_COMMAND: 'synthetic-codex-epipe-only', AOD_CODEX_DEFAULT_CWD: directory,
      AOD_CONNECTOR_USERS_DATABASE_FILE: file, AOD_CONNECTOR_TOKENS_FILE: `${file}.tokens`,
      AOD_SESSION_TITLES_FILE: `${file}.titles`, AOD_QUEUE_FILE: `${file}.queue`,
      AOD_MIRROR_OUTBOX_FILE: `${file}.mirror`, AOD_ARTIFACT_INDEX_FILE: `${file}.artifacts`,
      AOD_CONNECTOR_UPDATE_STATE_FILE: `${file}.updates`,
    }), () => false);
    t.after(async () => {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited; await runtime.close();
      t.mock.restoreAll(); syncBuiltinESMExports();
      rmSync(directory, { recursive: true, force: true });
    });
    await runtime.codex.refreshSessions();
    assert.ok(child);
    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE', errno: -32, syscall: 'write' });
    assert.doesNotThrow(() => { child!.stdin.emit('error', epipe); });
    child.stdin.write(`${JSON.stringify({ method: 'synthetic/exit' })}\n`);
    await exited;
    await runtime.close();
  });
