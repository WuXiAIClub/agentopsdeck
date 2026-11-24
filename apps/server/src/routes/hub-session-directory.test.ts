import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { HubStore } from '../hub/hub-store.js';
import { loadConfig } from '../config.js';
import { encodeHubSessionId, registerHubRoutes } from './hub.js';
import { PerformanceDiagnostics, performanceDiagnostics } from '../diagnostics/performance.js';

function fixture(principal?: () => { userId: string; admin: boolean } | undefined) {
  const config = loadConfig({ AOD_HUB_DATABASE_FILE: ':memory:', AOD_HUB_VAULT_SECRET: 'fixture-secret' });
  const hubStore = new HubStore(':memory:', 'fixture-secret');
  const app = new Hono();
  let connectorReads = 0;
  const hub = registerHubRoutes(app, { config, hubStore, ...(principal ? { principal } : {}), normalizeError: () => 'unavailable',
    connectorClient: (() => ({ sessions: async () => { connectorReads++; return { groups: [{ agentId: 'codex', sessions: [
      { sessionKey: 'retained', label: 'Retained fixture', updatedAt: 1, agentId: 'codex' },
    ] }], sourceCursor: 'fixture-cursor' }; } })) as any });
  return { app, hubStore, connectorReads: () => connectorReads, cleanup: async () => { await hub?.close(); await hubStore.close(); } };
}

test('session aggregation dispatches both directory scans asynchronously, never the legacy scan', async t => {
  const f = fixture(); let reads = 0;
  const original = f.hubStore.listConnectionsAsync.bind(f.hubStore);
  t.mock.method(f.hubStore, 'listConnections', () => { throw Error('legacy directory scan'); });
  t.mock.method(f.hubStore, 'listConnectionsAsync', async (owner: string) => {
    assert.equal(owner, 'default'); reads++; return original(owner);
  });
  try {
    const response = await f.app.request('/api/hub/v1/sessions/state');
    assert.equal(response.status, 200); assert.equal(reads, 2);
  } finally { await f.cleanup(); }
});

for (const stage of [1, 2]) for (const change of ['revoked', 'member', 'other', 'mutated-object', 'aborted', 'sql-failed', 'revoked-sql-failed'])
test(`directory wait ${stage} refuses ${change}, logs scope, and allows a later fresh read`, async t => {
  const rows: any[] = [], diagnostics = new PerformanceDiagnostics(line => rows.push(JSON.parse(line)));
  t.mock.method(performanceDiagnostics, 'start', (...args: Parameters<typeof performanceDiagnostics.start>) => diagnostics.start(...args));
  let actor: { userId: string; admin: boolean } | undefined = { userId: 'default', admin: true };
  const f = fixture(() => actor);
  let reads = 0, release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const signal = new AbortController(), original = f.hubStore.listConnectionsAsync.bind(f.hubStore);
  t.mock.method(f.hubStore, 'listConnections', () => { throw Error('legacy directory scan'); });
  t.mock.method(f.hubStore, 'listConnectionsAsync', async (owner: string) => {
    if (++reads === stage) {
      entered(); await new Promise<void>(resolve => { release = resolve; });
      if (change.endsWith('sql-failed')) throw Error('PRIVATE SELECT credential');
    }
    return original(owner);
  });
  const pending = Promise.resolve(f.app.fetch(new Request('http://hub/api/hub/v1/sessions/state', { signal: signal.signal })));
  try {
    assert.equal(await Promise.race([waiting.then(() => true), pending.then(() => false)]), true);
    if (change.startsWith('revoked')) actor = undefined;
    if (change === 'member') actor = { userId: 'default', admin: false };
    if (change === 'other') actor = { userId: 'other', admin: true };
    if (change === 'mutated-object') actor!.admin = false;
    if (change === 'aborted') signal.abort();
    release(); const response = await pending;
    assert.equal(response.status, ['aborted', 'sql-failed'].includes(change) ? 503 : 401);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.doesNotMatch(await response.text(), /PRIVATE|SELECT|credential|fixture-cursor|Retained fixture/);
    assert.equal(f.connectorReads(), stage === 1 ? 0 : 1);
    const events = rows.filter(row => row.operation === 'hub-session-state-read' && row.phase === 'finished');
    assert.equal(events.length, 1); assert.equal(events[0].step, stage === 1 ? 2 : 4);
    assert.equal(events[0].deferred, 1); assert.equal(events[0].settled, undefined); assert.equal(events[0].unknown, undefined);
    assert.equal(events[0].cancelled, change === 'aborted' ? 1 : undefined);
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE|SELECT|credential|default|retained/);
    actor = { userId: 'default', admin: true };
    const recovered = await f.app.request('/api/hub/v1/sessions/state');
    assert.equal(recovered.status, 200); const body = await recovered.json();
    assert.equal(body.groups[0].sessions[0].remoteSessionKey, 'retained');
    assert.equal(body.sources[0].cursor, 'fixture-cursor');
    assert.equal(body.sourceStates[0].state, 'ready');
    assert.equal(body.connections.length, 1); assert.equal(typeof body.revision, 'string');
    assert.equal(typeof body.viewKey, 'string');
    const recoveryEvents = rows.filter(row => row.operation === 'hub-session-state-read' && row.phase === 'finished');
    assert.equal(recoveryEvents.length, 2); assert.equal(recoveryEvents[1].step, 5);
    assert.equal(recoveryEvents[1].records, 1); assert.equal(recoveryEvents[1].deferred, undefined);
    assert.equal(recoveryEvents[1].settled, undefined); assert.equal(recoveryEvents[1].unknown, undefined);
  } finally { release?.(); await pending; await f.cleanup(); }
});

for (const field of ['hidden', 'archived', 'pinned'] as const)
test(`final directory wait rejects changed ${field} preference and recovers on a new snapshot`, async t => {
  const f = fixture(); let reads = 0, entered!: () => void, release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const original = f.hubStore.listConnectionsAsync.bind(f.hubStore);
  t.mock.method(f.hubStore, 'listConnectionsAsync', async (owner: string) => {
    if (++reads === 2) { entered(); await new Promise<void>(resolve => { release = resolve; }); }
    return original(owner);
  });
  const pending = Promise.resolve(f.app.request('/api/hub/v1/sessions/state'));
  try {
    assert.equal(await Promise.race([waiting.then(() => true), pending.then(() => false)]), true);
    f.hubStore.setSessionPreference(encodeHubSessionId('local', 'retained'), field, true, 'default');
    release(); const response = await pending;
    assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: 'hub_session_preferences_changed' });
    const recovered = await f.app.request('/api/hub/v1/sessions/state'); assert.equal(recovered.status, 200);
    const body = await recovered.json();
    assert.equal(body.groups.length, field === 'pinned' ? 1 : 0);
    assert.equal(body[field === 'hidden' ? 'hiddenCount' : field === 'archived' ? 'archivedCount' : 'pinnedCount'], 1);
  } finally { release?.(); await pending; await f.cleanup(); }
});

for (const change of ['deleted', 'disabled', 'credential']) for (const stale of [false, true])
test(`final directory ${stale ? 'stale' : 'fresh'} snapshot cannot revive ${change} connector rows or cursor`, async t => {
  const f = fixture(); let reads = 0, entered!: () => void, release!: () => void;
  // Local in-process connections are intentionally nondeletable. Exercise a
  // real remote configuration rather than mistaking that no-op for revocation.
  f.hubStore.upsertConnection({ id: 'local', ownerUserId: 'default', kind: 'remote',
    label: 'Remote fixture', connectorUrl: 'https://fixture.invalid', status: 'enabled' });
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const original = f.hubStore.listConnectionsAsync.bind(f.hubStore);
  t.mock.method(f.hubStore, 'listConnectionsAsync', async (owner: string) => {
    if (++reads !== 2) return original(owner);
    const before = await original(owner);
    entered(); await new Promise<void>(resolve => { release = resolve; });
    return stale ? before : original(owner);
  });
  const pending = Promise.resolve(f.app.request('/api/hub/v1/sessions/state'));
  try {
    assert.equal(await Promise.race([waiting.then(() => true), pending.then(() => false)]), true);
    const connection = f.hubStore.getConnection('local', 'default')!;
    if (change === 'deleted') assert.equal(f.hubStore.deleteConnection('local', 'default'), true);
    else f.hubStore.upsertConnection({ id: connection.id, ownerUserId: 'default', kind: connection.kind,
      label: connection.label, connectorUrl: connection.connectorUrl,
      status: change === 'disabled' ? 'disabled' : 'enabled',
      ...(change === 'credential' ? { credentialToken: 'synthetic-test-only' } : {}) });
    release(); const response = await pending; assert.equal(response.status, 200);
    const body = await response.json(); assert.deepEqual(body.groups, []); assert.deepEqual(body.sources, []);
    assert.ok(body.sourceStates.every((state: any) => state.state !== 'ready' && state.cursor === undefined));
    assert.doesNotMatch(JSON.stringify(body), /Retained fixture|fixture-cursor|synthetic-test-only/);
    assert.equal(f.connectorReads(), 1, 'read aggregation must not replay Connector work');
  } finally { release?.(); await pending; await f.cleanup(); }
});

test('final asynchronous directory wait cannot disclose a newly hidden session', async t => {
  const f = fixture(); let reads = 0, release: () => void = () => {};
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const original = f.hubStore.listConnectionsAsync.bind(f.hubStore);
  t.mock.method(f.hubStore, 'listConnectionsAsync', async (owner: string) => {
    if (++reads === 2) { entered(); await new Promise<void>(resolve => { release = resolve; }); }
    return original(owner);
  });
  const pending = Promise.resolve(f.app.request('/api/hub/v1/sessions/state'));
  try {
    assert.equal(await Promise.race([waiting.then(() => true), pending.then(() => false)]), true,
      'route must await its final directory read');
    f.hubStore.setSessionPreference(encodeHubSessionId('local', 'retained'), 'hidden', true, 'default');
    release();
    const response = await pending;
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'hub_session_preferences_changed' });
  } finally { release(); await pending; await f.cleanup(); }
});
