import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Hono } from 'hono';
import { loadConfig } from '../config.js';
import { registerHubRoutes } from '../routes/hub.js';
import { ConnectorClient, ConnectorClientError } from './connector-client.js';
import { HubStore } from './hub-store.js';
import { encodeHubSessionId } from './session-id.js';

const cursor = 'ce1_00000000-0000-4000-8000-000000000001:7';
function fixture(read: (id: string) => Promise<any>, principal?: () => { userId: string; admin: boolean } | undefined) {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-snapshot-'));
  const config = loadConfig({ HOME: directory, AOD_SERVER_ROLE: 'hub',
    AOD_HUB_DATABASE_FILE: join(directory, 'hub.sqlite'), AOD_HUB_VAULT_SECRET: 'synthetic-vault',
    AOD_SESSION_TITLES_FILE: join(directory, 'titles.json') });
  const hubStore = new HubStore(config.hub.databaseFile, config.hub.vaultSecret);
  const app = new Hono();
  const routes = registerHubRoutes(app, { config, hubStore, ...(principal ? { principal } : {}), normalizeError: () => 'error', connectorClient: (id) => {
    const client = new ConnectorClient('http://unused.invalid', 'synthetic', async () => { throw new Error('No network allowed'); });
    client.sessions = () => read(id);
    return client;
  } });
  const add = (id: string) => hubStore.upsertConnection({ id, kind: 'remote', label: id,
    connectorUrl: 'http://unused.invalid', status: 'enabled', capabilities: ['sessions'], credentialToken: 'synthetic' });
  return { app, hubStore, add, close: async () => { await routes?.close(); await hubStore.close(); rmSync(directory, { recursive: true, force: true }); } };
}
const snapshot = (id: string) => ({ sourceCursor: cursor, groups: [{ agentId: 'fake', sessions: [
  { sessionKey: id, agentId: 'fake', title: id, status: 'idle', lastActiveAt: 1 },
] }] });

for (const mutation of ['disable', 'rotate', 'revoke', 'abort', 'failure', 'hide'] as const) {
  test(`async visibility window fences ${mutation} before publishing sessions`, async () => {
    let authorized = true;
    const f = fixture(async id => snapshot(id), () => authorized ? { userId: 'default', admin: true } : undefined);
    let started!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const original = f.hubStore.sessionPreferencesAsync.bind(f.hubStore);
    f.hubStore.sessionPreferencesAsync = async owner => {
      const snapshot = await original(owner);
      started(); await held;
      if (mutation === 'failure') throw Error('private-sql-marker');
      return snapshot;
    };
    const controller = new AbortController();
    try {
      f.add('node');
      const pending = f.app.request('/api/hub/v1/sessions/state', { signal: controller.signal });
      await ready;
      if (mutation === 'disable') f.hubStore.upsertConnection({ ...f.hubStore.getConnection('node')!, status: 'disabled' });
      if (mutation === 'rotate') f.hubStore.upsertConnection({ ...f.hubStore.getConnection('node')!, credentialToken: 'new-synthetic' });
      if (mutation === 'revoke') authorized = false;
      if (mutation === 'abort') controller.abort();
      if (mutation === 'hide') f.hubStore.setSessionPreference(encodeHubSessionId('node', 'node'), 'hidden', true);
      release();
      const response = await pending, body = await response.json() as any;
      assert.equal(response.status, mutation === 'revoke' ? 401 : ['abort', 'failure', 'hide'].includes(mutation) ? 503 : 200);
      assert.equal(JSON.stringify(body).includes('private-sql-marker'), false);
      if (response.status === 200) { assert.deepEqual(body.groups, []); assert.deepEqual(body.sources, []); }
      else { assert.equal(body.groups, undefined); assert.equal(body.sources, undefined); }
    } finally { release(); await f.close(); }
  });
}

test('Hub snapshot revision delivers runtime-only recovery without a new source cursor or flat status', async () => {
  let runtime = { phase: 'completed', sync: 'syncing', connection: 'connected', lastEventAt: 100,
    executionProtection: { state: 'blocked', nativeTurnId: 'native-1', reason: 'unconfirmed' } };
  const f = fixture(async id => ({ sourceCursor: cursor, groups: [{ agentId: 'fake', sessions: [
    { ...snapshot(id).groups[0]!.sessions[0], runtime: structuredClone(runtime) },
  ] }] }));
  const read = async () => {
    const response = await f.app.request('/api/hub/v1/sessions/state');
    assert.equal(response.status, 200);
    return await response.json() as any;
  };
  try {
    f.add('a');
    const before = await read();
    assert.equal((await read()).revision, before.revision, 'unchanged refresh must remain stable');
    runtime = { ...runtime, sync: 'current' };
    const synced = await read();
    assert.notEqual(synced.revision, before.revision);
    runtime = { ...runtime, executionProtection: { ...runtime.executionProtection, state: 'verified', reason: 'settled' } };
    const recovered = await read();
    assert.notEqual(recovered.revision, synced.revision);
    assert.deepEqual(recovered.sources, before.sources);
    assert.equal(recovered.viewKey, before.viewKey);
    assert.equal(recovered.groups[0].sessions[0].status, before.groups[0].sessions[0].status);
    assert.equal(recovered.groups[0].sessions[0].runtime.executionProtection.state, 'verified');
    assert.equal((await read()).revision, recovered.revision);
  } finally { await f.close(); }
});

for (const fault of ['nul-id', 'invalid-utf8'] as const) test(`HTTP session state refuses ${fault} preferences instead of publishing an aliased visibility snapshot`, async () => {
  const f = fixture(async id => snapshot(id));
  try {
    f.add('node');
    const bytes = fault === 'nul-id' ? Buffer.from('node:a2V5\0private-corruption-marker') : Buffer.from([255]);
    const db = (f.hubStore as unknown as { db: import('node:sqlite').DatabaseSync }).db;
    db.prepare('INSERT INTO session_preferences(user_id,session_id,hidden) VALUES(?,CAST(? AS TEXT),1)').run('default', bytes);
    const before = db.prepare('SELECT CAST(session_id AS BLOB) AS id,hidden FROM session_preferences').all();
    assert.throws(() => f.hubStore.sessionPreferences(), /^Error: hub_delivery_read_unavailable$/);
    const response = await f.app.request('/api/hub/v1/sessions/state'), body = await response.json() as any;
    assert.equal(response.status, 503); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(body.groups, undefined); assert.equal(body.sources, undefined);
    assert.equal(JSON.stringify(body).includes('private-corruption-marker'), false);
    assert.deepEqual(db.prepare('SELECT CAST(session_id AS BLOB) AS id,hidden FROM session_preferences').all(), before);
  } finally { await f.close(); }
});

for (const mutation of ['disable', 'delete', 'recreate', 'rotate', 'add'] as const) {
  test(`aggregation fences an already resolved node after ${mutation} while another node waits`, async () => {
    let fastRead!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => { fastRead = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const f = fixture(async (id) => {
      if (id === 'fast') { fastRead(); return snapshot(id); }
      await held;
      return snapshot(id);
    });
    try {
      f.add('fast'); f.add('slow');
      const pending = f.app.request('/api/hub/v1/sessions/state');
      await ready;
      // Let the fast node's async continuation finish before mutating authority.
      await Promise.resolve();
      const previous = f.hubStore.getConnection('fast')!;
      if (mutation === 'disable') f.hubStore.upsertConnection({ ...previous, status: 'disabled' });
      if (mutation === 'delete' || mutation === 'recreate') f.hubStore.deleteConnection('fast');
      if (mutation === 'recreate') f.add('fast');
      if (mutation === 'rotate') f.hubStore.upsertConnection({ ...previous, credentialToken: 'new-synthetic' });
      if (mutation === 'add') f.add('new');
      release();
      const response = await pending;
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const body = await response.json() as any;
      assert.deepEqual(body.groups.flatMap((g: any) => g.sessions.map((s: any) => s.title)).sort(), mutation === 'add' ? ['fast', 'slow'] : ['slow']);
      assert.equal(body.sourceStates.find((s: any) => s.connectionId === 'slow').state, 'ready');
      const affected = body.sourceStates.find((s: any) => s.connectionId === (mutation === 'add' ? 'new' : 'fast'));
      assert.equal(affected?.state, mutation === 'delete' ? undefined : mutation === 'disable' ? 'disabled' : 'changed');
      assert.equal(affected?.cursor, undefined);
      if (mutation !== 'add') assert.equal(body.sources.some((s: any) => s.connectionId === 'fast'), false);
      if (mutation === 'delete') assert.equal(body.connections.some((s: any) => s.id === 'fast'), false);
    } finally { release(); await f.close(); }
  });
}

test('partial snapshot failures distinguish denied from unavailable without retaining rows or cursors', async () => {
  const f = fixture(async (id) => {
    if (id === 'good') return snapshot(id);
    throw new ConnectorClientError(id === 'denied' ? 403 : 503, 'synthetic failure');
  });
  try {
    for (const id of ['good', 'denied', 'unavailable', 'disabled']) f.add(id);
    f.hubStore.upsertConnection({ ...f.hubStore.getConnection('disabled')!, status: 'disabled' });
    const body = await (await f.app.request('/api/hub/v1/sessions/state')).json() as any;
    assert.deepEqual(body.sources, [{ connectionId: 'good', cursor }]);
    assert.deepEqual(Object.fromEntries(body.sourceStates.map((s: any) => [s.connectionId, s.state])), {
      good: 'ready', denied: 'denied', unavailable: 'unavailable', disabled: 'disabled',
    });
    assert.equal(body.groups.flatMap((g: any) => g.sessions).length, 1);
    for (const source of body.sourceStates) assert.equal(Number.isSafeInteger(source.authority), true);
  } finally { await f.close(); }
});

test('source counts and view identity change with Hub preferences and filters, not node cursor or read time', async () => {
  const f = fixture(async (id) => snapshot(id));
  const read = async (query = '') => (await (await f.app.request(`/api/hub/v1/sessions/state${query}`)).json()) as any;
  try {
    f.add('a'); f.add('b');
    const before = await read();
    assert.equal((await read()).viewKey, before.viewKey);
    f.hubStore.setSessionPreference(encodeHubSessionId('a', 'a'), 'hidden', true);
    f.hubStore.setSessionPreference(encodeHubSessionId('b', 'b'), 'pinned', true);
    const after = await read();
    assert.notEqual(after.viewKey, before.viewKey);
    assert.notEqual(after.revision, before.revision);
    assert.deepEqual(after.sources, before.sources);
    assert.equal(after.hiddenCount, 1);
    assert.equal(after.pinnedCount, 1);
    assert.equal(after.sourceStates.find((s: any) => s.connectionId === 'a').hiddenCount, 1);
    assert.equal(after.sourceStates.find((s: any) => s.connectionId === 'b').pinnedCount, 1);
    assert.deepEqual(after.groups.flatMap((g: any) => g.sessions.map((s: any) => s.title)), ['b']);
    const inclusive = await read('?includeHidden=1');
    assert.notEqual(inclusive.viewKey, after.viewKey);
    assert.equal(inclusive.groups.flatMap((g: any) => g.sessions).length, 2);
    assert.equal(inclusive.hiddenCount, 1);
  } finally { await f.close(); }
});
