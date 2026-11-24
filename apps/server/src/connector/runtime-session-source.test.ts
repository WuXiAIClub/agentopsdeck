import assert from 'node:assert/strict';
import fsPromises, { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadConfig } from '../config.js';
import { createConnectorRuntime } from './runtime.js';

for (const mode of ['connection-change', 'shutdown', 'maintenance'] as const)
  test(`original production directory refresh owns async disk reads during ${mode}`, { timeout: 15_000 }, async context => {
    const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-runtime-session-source-')), previousHome = process.env.HOME;
    process.env.HOME = root;
    const sessions = join(root, '.openclaw/agents/main/sessions'), key = 'agent:main:dashboard:original', index = join(sessions, 'sessions.json');
    await mkdir(sessions, { recursive: true });
    await writeFile(index, JSON.stringify({ [key]: { status: 'running', updatedAt: Date.now() } }));
    const config = loadConfig({ AOD_SERVER_ROLE: 'connector', AOD_CODEX_ENABLED: 'false', AOD_LOCAL_OPENCLAW_CLI: 'false',
      AOD_CONNECTOR_USERS_DATABASE_FILE: join(root, 'connector.sqlite'), AOD_CONNECTOR_TOKENS_FILE: join(root, 'tokens.json'),
      AOD_SESSION_TITLES_FILE: join(root, 'titles.json'), AOD_QUEUE_FILE: join(root, 'queue.json'),
      AOD_MIRROR_OUTBOX_FILE: join(root, 'mirror.json'), AOD_ARTIFACT_INDEX_FILE: join(root, 'artifacts.json'),
      AOD_CONNECTOR_UPDATE_STATE_FILE: join(root, 'updates.json') });
    config.gatewayWsUrl = 'ws://synthetic.invalid';
    const runtime = createConnectorRuntime(config, () => false, { deferActivation: true });
    let connection = 'original-connection';
    runtime.gateway.connectionId = () => connection;
    runtime.gateway.requestWithConnection = async <T>() => ({ connectionId: connection, payload: { sessions: [{ key, status: 'running' }] } as T });
    runtime.store.replaceSessions([{ key: 'agent:main:dashboard:before-refresh' }]);
    assert.ok(runtime.store.getSession('agent:main:dashboard:before-refresh'));
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
    const nativeRead = fsPromises.readFile;
    context.mock.method(fsPromises, 'readFile', async (...args: Parameters<typeof nativeRead>) => {
      if (args[0] === index) { enter(); await held; }
      return nativeRead(...args);
    }); syncBuiltinESMExports();
    const refresh = runtime.refreshSessions().then(() => undefined, error => error as Error);
    let stopping: Promise<unknown> | undefined;
    context.after(async () => {
      release(); await refresh; await stopping; await runtime.close();
      context.mock.restoreAll(); syncBuiltinESMExports();
      if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
      await rm(root, { recursive: true, force: true });
    });
    await entered;
    assert.equal(runtime.store.getSession(key), undefined, 'disk refresh must finish before publishing this directory');
    let stopped = false;
    if (mode === 'connection-change') connection = 'new-connection';
    else if (mode === 'shutdown') stopping = runtime.close().then(() => { stopped = true; });
    else stopping = Promise.resolve(runtime.app.request('/api/connector/v1/maintenance/commands/pause', {
      method: 'POST', headers: { authorization: `Bearer ${runtime.localMaintenanceToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ idempotencyKey: 'original-disk-pause' }),
    })).then(response => { assert.equal(response.status, 200); stopped = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(stopped, false); release();
    const result = await refresh;
    if (mode === 'connection-change') {
      assert.match(String(result), /connection changed/i);
      assert.equal(runtime.store.getSession(key), undefined);
      assert.ok(runtime.store.getSession('agent:main:dashboard:before-refresh'));
    } else { assert.equal(result, undefined); await stopping; assert.equal(stopped, true); }
  });
