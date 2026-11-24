import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WebSocketServer } from 'ws';
import { loadConfig } from './config.js';
import { createProcessApplication } from './application-process.js';
import { applicationConnectorOwnerConfig } from './application-connector-async.js';
import { connectorOwnerConfig } from './connector/connector-owner-domain.js';
import { WeixinService } from './hub/weixin-service.js';
import { startupApplicationCleanup } from './lifecycle/startup-cleanup.js';
import { startupDatabaseOwners } from './storage/startup-owner.js';

const accessKey = 'isolated-owned-root-key', key = 'agent:main:web:direct:owned-root';
async function fixture(t: TestContext, role: 'all' | 'connector', mode: 'json' | 'sqlite', withKey: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'owned-connector-root-'));
  const gateway = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(gateway, 'listening');
  const calls: string[] = [];
  gateway.on('connection', socket => {
    socket.send('{"type":"event","event":"connect.challenge"}');
    socket.on('message', raw => {
      const request = JSON.parse(raw.toString()); calls.push(request.method);
      const payload = request.method === 'sessions.list' ? { sessions: [{ key, label: 'Original owned session', status: 'idle' }] } : {};
      socket.send(JSON.stringify({ type: 'res', id: request.id, ok: true, payload }));
    });
  });
  t.mock.method(WeixinService.prototype, 'startWorker', () => {});
  t.mock.method(globalThis, 'fetch', async () => { throw Error('Unexpected external effect'); });
  const config = loadConfig({ HOME: root, AOD_SERVER_ROLE: role,
    AOD_OPENCLAW_GATEWAY_WS_URL: `ws://127.0.0.1:${(gateway.address() as { port: number }).port}`,
    AOD_LOCAL_OPENCLAW_CLI: 'false', AOD_CODEX_ENABLED: 'false',
    AOD_CONNECTOR_USERS_DATABASE_FILE: join(root, 'connector.sqlite'),
    AOD_CONNECTOR_TOKENS_FILE: join(root, 'tokens.json'),
    AOD_CONNECTOR_UPDATE_STATE_FILE: join(root, 'update.json'),
    AOD_HUB_DATABASE_FILE: join(root, 'hub.sqlite'), AOD_HUB_VAULT_SECRET: 'isolated-root-vault',
    AOD_PASSKEYS_FILE: join(root, 'passkeys.json'), AOD_AUTH_SESSIONS_FILE: join(root, 'sessions.json'),
    AOD_SESSION_TITLES_FILE: join(root, 'titles.json'), AOD_QUEUE_FILE: join(root, 'queue.json'),
    AOD_MIRROR_OUTBOX_FILE: join(root, 'mirror.json'), AOD_ARTIFACT_INDEX_FILE: join(root, 'artifacts.json'),
    ...(mode === 'sqlite' ? { AOD_AUTH_SQLITE_FILE: join(root, 'auth.sqlite') } : {}),
    ...(withKey ? { AOD_ACCESS_KEY: accessKey } : {}),
  });
  const queue = JSON.stringify({ queues: { [key]: [{ id: 'original-unknown-turn', sessionKey: key,
    message: 'Legacy send with uncertain outcome', createdAt: 1234, deliveryMode: 'web-only', media: [], inFlight: false }] } });
  const mirror = JSON.stringify({ jobs: [] });
  await writeFile(config.queueFile, queue); await writeFile(config.mirrorOutboxFile, mirror);
  const applications: Awaited<ReturnType<typeof createProcessApplication>>[] = [];
  t.after(async () => {
    try { for (const application of applications) await application.close(); }
    finally {
      for (const socket of gateway.clients) socket.terminate();
      await new Promise<void>(resolve => gateway.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
  const open = async () => { const app = await createProcessApplication(config); applications.push(app); return app; };
  const headers = withKey ? { 'x-agentopsdeck-key': accessKey } : {};
  return { root, config, queue, mirror, calls, open, headers };
}

for (const role of ['all', 'connector'] as const) for (const mode of ['json', 'sqlite'] as const) for (const withKey of [false, true]) {
  test(`owned production root ${role}/${mode}/${withKey ? 'key' : 'no-key'} preserves history, recovers once and reopens`, { timeout: 90_000 }, async t => {
    const f = await fixture(t, role, mode, withKey), application = await f.open();
    assert.equal((await application.app.request('/api/health', { headers: f.headers })).status, 200);
    assert.throws(() => startupDatabaseOwners.reserveExclusive(f.config.connector.usersDatabaseFile),
      /Storage connection recovery required/, 'Production must retain its sole physical database owner');
    assert.equal(application.websiteGateway, undefined, 'Disabled WebsiteGateway must not create an extra gateway');
    const response = await application.app.request('/api/sessions/state', { headers: f.headers });
    assert.equal(response.status, 200); assert.match(JSON.stringify(await response.json()), /Original owned session/);
    if (withKey) assert.equal((await application.app.request('/api/sessions/state')).status, 401);
    assert.equal((await application.app.request('/api/definitely-not-a-route', { headers: f.headers })).status, 404);
    assert.equal(f.calls.includes('agent'), false, 'Recovery must not replay the legacy send');
    await application.close(); assert.equal(application.close.snapshot().state, 'closed');
    const database = new DatabaseSync(f.config.connector.usersDatabaseFile, { readOnly: true });
    try {
      const row = database.prepare('SELECT state FROM connector_turns WHERE runtime = ? AND id = ?').get('openclaw', 'original-unknown-turn');
      assert.equal(row?.state, 'outcome_unknown');
      assert.equal(database.prepare('SELECT count(*) AS n FROM connector_turn_imports WHERE runtime = ?').get('openclaw')?.n, 1);
      assert.equal(database.prepare('SELECT source FROM connector_mirror_import WHERE singleton = 1').get()?.source, f.config.mirrorOutboxFile);
    } finally { database.close(); }
    assert.equal(await readFile(f.config.queueFile, 'utf8'), f.queue);
    assert.equal(await readFile(f.config.mirrorOutboxFile, 'utf8'), f.mirror);
    const reopened = await f.open();
    assert.equal((await reopened.app.request('/api/sessions/state', { headers: f.headers })).status, 200);
    await reopened.close(); assert.equal(startupApplicationCleanup.snapshot().pending, 0);
    assert.equal(f.calls.includes('agent'), false);
  });
}

for (const source of ['queue', 'mirror'] as const) test(`malformed original ${source} fails startup without sync fallback or leaked owner`, { timeout: 90_000 }, async t => {
  const f = await fixture(t, 'all', 'sqlite', true), file = source === 'queue' ? f.config.queueFile : f.config.mirrorOutboxFile;
  await writeFile(file, '{malformed');
  await assert.rejects(f.open());
  assert.equal(await readFile(file, 'utf8'), '{malformed'); assert.equal(f.calls.length, 0);
  await startupApplicationCleanup.closeRetainedOwners();
  assert.equal(startupApplicationCleanup.snapshot().pending, 0);
  await writeFile(file, source === 'queue' ? f.queue : f.mirror);
  const application = await f.open(); assert.equal((await application.app.request('/api/health', { headers: f.headers })).status, 200);
});

test('trusted bootstrap copies the exact original queue paths and validates recovery configuration', async t => {
  const f = await fixture(t, 'connector', 'json', false), mapped = applicationConnectorOwnerConfig(f.config);
  assert.equal(mapped.file, f.config.connector.usersDatabaseFile);
  assert.equal(mapped.tokenFile, f.config.connector.tokenFile);
  assert.equal(mapped.codexQueueFile, f.config.codex.queueFile);
  assert.equal(mapped.openClawQueueFile, f.config.queueFile);
  assert.equal(mapped.mirrorOutboxFile, f.config.mirrorOutboxFile);
  assert.notEqual(mapped.codexQueueFile, mapped.openClawQueueFile);
  assert.deepEqual(connectorOwnerConfig(mapped), mapped);
  for (const field of ['openClawQueueFile', 'mirrorOutboxFile']) {
    for (const invalid of ['', null, {}, 3]) assert.throws(() => connectorOwnerConfig({ ...mapped, [field]: invalid }));
  }
});
