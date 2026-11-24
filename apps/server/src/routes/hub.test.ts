import { PerformanceDiagnostics, performanceDiagnostics } from '../diagnostics/performance.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Hono } from 'hono';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { loadConfig } from '../config.js';
import { HubStore } from '../hub/hub-store.js';
import { DeckStore } from '../projection/deck-store.js';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { createConnectorClientResolver } from '../hub/connector-client.js';
import { registerConnectorRoutes } from './connector.js';
import { OpenClawTurnQueue } from '../openclaw/turn-queue.js';
import { createOpenClawDispatch } from '../openclaw/dispatch.js';
import { decodeHubSessionId, encodeHubSessionId, registerHubRoutes } from './hub.js';
import { mediaResourceId } from '../messages/media-resource.js';
import { NODE_ID_HEADER } from '../connector/node-identity.js';
import { HermesRuntime, type HermesTransport } from '../hermes/runtime.js';
import type { HermesEvent } from '../hermes/protocol.js';
import { InteractionRuntime } from '../commands/interaction-runtime.js';
import { interactionCapabilitiesFor } from '../connector/sdk-interaction.js';
import type { HubPrincipal } from '../hub/identity.js';
import { ClaudeStreamDelivery } from '../claude/stream-delivery.js';

for (const invalid of ['promise', 'async', 'accessor', 'proxy'] as const)
  test(`Hub HTTP rejects ${invalid} synchronous identity without executing authority accessors`, async t => {
    let invoked = 0;
    const valid = { userId: 'default', admin: true };
    const lookup = invalid === 'async' ? async () => { invoked++; return valid; }
      : invalid === 'promise' ? () => Object.assign(Promise.resolve(valid), valid)
      : invalid === 'accessor' ? () => ({ get userId() { invoked++; return 'default'; }, admin: true })
      : () => new Proxy(valid, { get() { invoked++; return 'default'; } });
    const rows: any[] = [], diagnostics = new PerformanceDiagnostics(line => rows.push(JSON.parse(line)));
    const f = createHubFixture({}, undefined, false, false, lookup as () => HubPrincipal);
    t.mock.method(performanceDiagnostics, 'start', (...args: Parameters<typeof performanceDiagnostics.start>) => diagnostics.start(...args));
    try {
      const response = await f.app.request('/api/hub/v1/me');
      assert.equal(response.status, 401); assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await response.json(), { error: 'unauthorized' }); assert.equal(invoked, 0);
      const refusals = rows.filter(row => row.operation === 'auth-compatibility-check');
      assert.equal(refusals.length, 1); assert.equal(refusals[0].step, 6);
      assert.doesNotMatch(JSON.stringify(refusals), /default|userId|admin|token/);
    } finally { await f.cleanup(); }
  });

for (const endpoint of ['read', 'checkpoint'] as const)
  test(`Hub request identity cannot drift in-place during awaited ${endpoint}`, async t => {
    const rows: any[] = [], diagnostics = new PerformanceDiagnostics(line => rows.push(JSON.parse(line)));
    const actor: HubPrincipal = { userId: 'default', admin: true };
    const f = createHubFixture({}, undefined, false, false, () => actor);
    t.mock.method(performanceDiagnostics, 'start', (...args: Parameters<typeof performanceDiagnostics.start>) => diagnostics.start(...args));
    let release!: () => void, entered!: () => void, committed = 0;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const hold = () => new Promise<void>(resolve => { release = resolve; entered(); });
    t.mock.method(f.hubStore, 'storageStats', async () => {
      await hold();
      return { databaseBytes: 1, walBytes: 0, availableBytes: 1000, lowSpace: false, walPressure: false };
    });
    t.mock.method(f.hubStore, 'checkpointStorage', async (check: () => void) => {
      await hold(); check(); committed++; return { deferred: true };
    });
    const path = '/api/hub/v1/maintenance/storage';
    const pending = endpoint === 'read' ? f.app.request(path)
      : f.app.request(path + '/checkpoint', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    try {
      await waiting; actor.userId = 'other'; release();
      const response = await pending;
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: 'unauthorized' });
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      assert.equal(committed, 0);
      const refusals = rows.filter(row => row.operation === 'hub-request-authority');
      assert.equal(refusals.length, 1); assert.equal(refusals[0].step, 2);
      assert.equal(refusals[0].settled, undefined); assert.equal(refusals[0].unknown, undefined);
      assert.doesNotMatch(JSON.stringify(refusals), /default|other|checkpoint|SELECT|token/);
    } finally { release?.(); await pending; await f.cleanup(); }
  });

for (const change of ['revoked', 'member', 'other', 'mutated-object', 'aborted', 'sql-failed', 'revoked-sql-failed'] as const)
  test(`Hub sessions fan-in refuses ${change} before connector reads after awaited display`, async t => {
    const rows: any[] = [], diagnostics = new PerformanceDiagnostics(line => rows.push(JSON.parse(line)));
    t.mock.method(performanceDiagnostics, 'start', (...args: Parameters<typeof performanceDiagnostics.start>) => diagnostics.start(...args));
    let actor: HubPrincipal | undefined = { userId: 'default', admin: true };
    const f = createHubFixture({}, undefined, false, false, () => actor);
    let release!: () => void, entered!: () => void, connectionReads = 0, preferenceReads = 0;
    const waiting = new Promise<void>(resolve => { entered = resolve; }), signal = new AbortController();
    t.mock.method(f.hubStore, 'listUsers', () => { throw Error('sync user scan must not run'); });
    t.mock.method(f.hubStore, 'listConnections', () => { connectionReads++; throw Error('must not dispatch revoked fan-in'); });
    t.mock.method(f.hubStore, 'sessionPreferencesAsync', async () => { preferenceReads++; return new Map(); });
    t.mock.method(f.hubStore, 'listUsersAsync', async (userId: string, admin: boolean) => {
      assert.equal(userId, 'default'); assert.equal(admin, true); entered();
      await new Promise<void>(resolve => { release = resolve; });
      if (change.endsWith('sql-failed')) throw Error('PRIVATE SELECT credential');
      return [{ id: 'default', label: 'PRIVATE old account', createdAt: 1, updatedAt: 2 }];
    });
    const pending = f.app.fetch(new Request('http://hub/api/hub/v1/sessions/state', { signal: signal.signal }));
    try {
      await waiting;
      if (change === 'revoked' || change === 'revoked-sql-failed') actor = undefined;
      if (change === 'member') actor = { userId: 'default', admin: false };
      if (change === 'other') actor = { userId: 'other', admin: true };
      if (change === 'mutated-object') actor!.admin = false;
      if (change === 'aborted') signal.abort();
      release(); const response = await pending;
      assert.equal(response.status, ['aborted', 'sql-failed'].includes(change) ? 503 : 401);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      assert.doesNotMatch(await response.text(), /PRIVATE|SELECT|credential/);
      assert.equal(connectionReads, 0); assert.equal(preferenceReads, 0);
      const events = rows.filter(row => row.operation === 'hub-session-state-read' && row.phase === 'finished');
      assert.equal(events.length, 1, 'every refused aggregation finishes its own observation');
      assert.equal(events[0].step, 1); assert.equal(events[0].deferred, 1);
      assert.equal(events[0].cancelled, change === 'aborted' ? 1 : undefined);
      assert.equal(events[0].settled, undefined); assert.equal(events[0].unknown, undefined);
      assert.doesNotMatch(JSON.stringify(events), /PRIVATE|SELECT|credential|default/);
    } finally { release?.(); await pending; await f.cleanup(); }
  });

for (const admin of [true, false]) test(`Hub sessions fan-in uses scoped asynchronous display (admin=${admin}) with unchanged wire shape`, async t => {
  const rows: any[] = [], diagnostics = new PerformanceDiagnostics(line => rows.push(JSON.parse(line)));
  t.mock.method(performanceDiagnostics, 'start', (...args: Parameters<typeof performanceDiagnostics.start>) => diagnostics.start(...args));
  const actor: HubPrincipal = { userId: 'default', admin };
  const f = createHubFixture({}, undefined, false, false, () => actor);
  let reads = 0;
  t.mock.method(f.hubStore, 'listUsers', () => { throw Error('sync user scan must not run'); });
  t.mock.method(f.hubStore.identities, 'userUsage', () => { throw Error('N+1 usage must not run'); });
  t.mock.method(f.hubStore, 'listUsersAsync', async (userId: string, isAdmin: boolean) => {
    reads++; assert.equal(userId, actor.userId); assert.equal(isAdmin, admin);
    return [{ id: 'default', label: 'Own user', createdAt: 1, updatedAt: 2 }];
  });
  try {
    f.hubStore.upsertConnection({ id: 'other-owner-node', ownerUserId: 'other', kind: 'remote', label: 'Other private connection',
      connectorUrl: 'https://other.invalid', status: 'enabled', capabilities: [] });
    f.store.upsertSession({ sessionKey: 'agent:local-dev:dashboard:async-display', agentId: 'local-dev', title: 'Retained session', status: 'idle', lastActiveAt: 1_800_000_000_000 });
    const response = await f.app.request('/api/hub/v1/sessions/state');
    assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const body = await response.json() as any;
    assert.equal(reads, 1);
    assert.ok(body.connections.length);
    assert.ok(body.connections.every((row: any) => row.ownerUserId === 'default' && row.ownerUserLabel === 'Own user'));
    assert.equal(body.groups[0].sessions[0].sessionKey, encodeHubSessionId('local', 'agent:local-dev:dashboard:async-display'));
    assert.ok(Array.isArray(body.sources)); assert.ok(Array.isArray(body.sourceStates)); assert.equal(typeof body.revision, 'string');
    assert.doesNotMatch(JSON.stringify(body), /other-owner-node|Other private/);
    const events = rows.filter(row => row.operation === 'hub-session-state-read' && row.phase === 'finished');
    assert.equal(events.length, 1); assert.equal(events[0].step, 5); assert.equal(events[0].records, 1);
    assert.equal(events[0].deferred, undefined); assert.equal(events[0].settled, undefined);
    assert.doesNotMatch(JSON.stringify(events), /Own user|private|Retained session|async-display/);
  } finally { await f.cleanup(); }
});

test('Hub sessions fan-in reads the current disabled directory only after display IO settles', async t => {
  const f = createHubFixture(); let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  t.mock.method(f.hubStore, 'listUsersAsync', async () => {
    entered(); await new Promise<void>(resolve => { release = resolve; });
    return [{ id: 'default', label: 'Default', createdAt: 1, updatedAt: 2 }];
  });
  t.mock.method(f.store, 'getSessionsState', () => { throw Error('disabled connector must not be queried'); });
  const pending = f.app.request('/api/hub/v1/sessions/state');
  try {
    await waiting;
    f.hubStore.upsertConnection({ id: 'local', kind: 'local', label: 'local', connectorUrl: 'local://aod-connector', status: 'disabled' });
    release(); const response = await pending;
    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.deepEqual(body.groups, []); assert.deepEqual(body.sources, []);
    assert.equal(body.sourceStates[0].state, 'disabled');
  } finally { release?.(); await pending; await f.cleanup(); }
});

for (const change of ['mutated-object', 'revoked-failure', 'preference-version'] as const)
  test(`Hub sessions fan-in fences ${change} after original preferences wait`, async t => {
    let actor: HubPrincipal | undefined = { userId: 'default', admin: true };
    const f = createHubFixture({}, undefined, false, false, () => actor);
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    t.mock.method(f.hubStore, 'sessionPreferencesAsync', async (userId: string) => {
      assert.equal(userId, 'default'); entered(); await new Promise<void>(resolve => { release = resolve; });
      if (change === 'revoked-failure') throw Error('PRIVATE preference SQL');
      return new Map();
    });
    const pending = f.app.request('/api/hub/v1/sessions/state');
    try {
      await waiting;
      if (change === 'mutated-object') actor!.admin = false;
      if (change === 'revoked-failure') actor = undefined;
      if (change === 'preference-version') f.hubStore.setSessionPreference(encodeHubSessionId('local', 'kept-session'), 'hidden', true, 'default');
      release(); const response = await pending;
      assert.equal(response.status, change === 'preference-version' ? 503 : 401);
      assert.doesNotMatch(await response.text(), /PRIVATE|kept-session/);
    } finally { release?.(); await pending; await f.cleanup(); }
  });

for (const change of ['revoked', 'member', 'other', 'mutated-object', 'aborted', 'sql-failed', 'revoked-sql-failed'] as const)
  test(`Hub async connection display refuses ${change} after original readonly wait`, async t => {
    let actor: HubPrincipal | undefined = { userId: 'default', admin: true };
    const f = createHubFixture({}, undefined, false, false, () => actor);
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const signal = new AbortController(); let connectionReads = 0;
    t.mock.method(f.hubStore, 'listConnectionsAsync', async () => { connectionReads++; throw Error('must not read revoked connections'); });
    t.mock.method(f.hubStore, 'listUsersAsync', async (userId: string, admin: boolean) => {
      assert.equal(userId, 'default'); assert.equal(admin, true); entered();
      await new Promise<void>(resolve => { release = resolve; });
      if (change.endsWith('sql-failed')) throw Error('private SQL display failure');
      return [{ id: 'default', label: 'private old account', createdAt: 1, updatedAt: 2 }];
    });
    const pending = f.app.fetch(new Request('http://hub/api/hub/v1/connections', { signal: signal.signal }));
    try {
      await waiting;
      if (change === 'revoked' || change === 'revoked-sql-failed') actor = undefined;
      if (change === 'member') actor = { userId: 'default', admin: false };
      if (change === 'other') actor = { userId: 'other', admin: true };
      if (change === 'mutated-object') actor!.admin = false;
      if (change === 'aborted') signal.abort();
      release(); const response = await pending;
      assert.equal(response.status, ['aborted', 'sql-failed'].includes(change) ? 503 : 401);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      assert.doesNotMatch(await response.text(), /private|"connections"\s*:|"credential"\s*:/);
      assert.equal(connectionReads, 0);
    } finally { release?.(); await pending; await f.cleanup(); }
  });

for (const admin of [true, false]) test(`Hub connection display keeps original account scope (admin=${admin}) without sync user scans`, async t => {
  const actor: HubPrincipal = { userId: 'default', admin };
  const f = createHubFixture({}, undefined, false, false, () => actor);
  t.mock.method(f.hubStore, 'listUsers', () => { throw Error('sync user list must not run'); });
  t.mock.method(f.hubStore.identities, 'userUsage', () => { throw Error('N+1 usage must not run'); });
  t.mock.method(f.hubStore, 'listUsersAsync', async (owner: string, isAdmin: boolean) => {
    assert.equal(owner, actor.userId); assert.equal(isAdmin, admin);
    return [{ id: 'default', label: 'Own user', createdAt: 1, updatedAt: 2 }];
  });
  try {
    f.hubStore.upsertConnection({ id: 'other-owner-node', ownerUserId: 'other', kind: 'remote', label: 'Other private connection',
      connectorUrl: 'https://other.invalid', status: 'enabled', capabilities: [] });
    const response = await f.app.request('/api/hub/v1/connections');
    assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const rows = (await response.json()).connections;
    assert.ok(rows.length); assert.ok(rows.every((row: any) => row.ownerUserId === 'default' && row.ownerUserLabel === 'Own user'));
    assert.doesNotMatch(JSON.stringify(rows), /other-owner-node|Other private/);
  } finally { await f.cleanup(); }
});

for (const change of ['deleted', 'disabled'] as const) test(`Hub connection display rereads ${change} node after awaited labels`, async t => {
  const f = createHubFixture(); let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  t.mock.method(f.hubStore, 'listUsersAsync', async () => {
    entered(); await new Promise<void>(resolve => { release = resolve; });
    return [{ id: 'default', label: 'Own user', createdAt: 1, updatedAt: 2 }];
  });
  f.hubStore.upsertConnection({ id: 'changed-node', kind: 'remote', label: 'Changed node',
    connectorUrl: 'https://node.invalid', status: 'enabled', capabilities: [] });
  const pending = f.app.request('/api/hub/v1/connections');
  try {
    await waiting;
    if (change === 'deleted') f.hubStore.deleteConnection('changed-node');
    else f.hubStore.upsertConnection({ id: 'changed-node', kind: 'remote', label: 'Changed node',
      connectorUrl: 'https://node.invalid', status: 'disabled', capabilities: [] });
    release(); const response = await pending; assert.equal(response.status, 200);
    const row = (await response.json()).connections.find((row: any) => row.id === 'changed-node');
    if (change === 'deleted') assert.equal(row, undefined); else assert.equal(row.status, 'disabled');
  } finally { release?.(); await pending; await f.cleanup(); }
});

for (const outcome of ['plain', 'sink-failed', 'revoked'] as const)
  test(`Hub connection SQL failure retains numeric evidence (${outcome}) without replay or private error payload`, async t => {
    let actor: HubPrincipal | undefined = { userId: 'default', admin: true };
    const f = createHubFixture({}, undefined, false, false, () => actor);
    const rows: any[] = [];
    const diagnostics = new PerformanceDiagnostics(line => {
      rows.push(JSON.parse(line)); if (outcome === 'sink-failed') throw Error('PRIVATE sink');
    }, () => 0);
    const originalStart = performanceDiagnostics.start.bind(performanceDiagnostics);
    t.mock.method(performanceDiagnostics, 'start', (operation: Parameters<typeof performanceDiagnostics.start>[0]) =>
      operation === 'hub-connections-read' ? diagnostics.start(operation) : originalStart(operation));
    const db = (f.hubStore as any).db;
    let original: unknown, reads = 0;
    try { db.prepare('SELECT * FROM PRIVATE_missing_connection_table'); } catch (error) { original = error; }
    assert.ok(original);
    t.mock.method(f.hubStore, 'listUsersAsync', async () => [{ id: 'default', label: 'PRIVATE label', createdAt: 1, updatedAt: 2 }]);
    t.mock.method(db, 'prepare', function(this: DatabaseSync, query: string) {
      if (!query.includes('hub_connection_display_versions')) return DatabaseSync.prototype.prepare.call(this, query);
      reads++; if (outcome === 'revoked') actor = undefined; throw original;
    });
    try {
      const response = await f.app.request('/api/hub/v1/connections');
      assert.equal(response.status, outcome === 'revoked' ? 401 : 503);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      assert.doesNotMatch(await response.text(), /PRIVATE|SQL|SELECT|sqlite|credential/);
      assert.equal(reads, 1, 'failed original SQL is not retried');
      assert.equal(rows.length, 1);
      assert.equal(rows[0].step, 2); assert.equal(rows[0].sqlErrorCode, 1);
      const snapshot = diagnostics.snapshot();
      assert.equal(snapshot.events[0]!.delivery, outcome === 'sink-failed' ? 'failed' : 'delivered');
      assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE|SQL|SELECT|sqlite|credential/);
    } finally { t.mock.restoreAll(); await f.cleanup(); }
  });

for (const change of ['revoked', 'member', 'other', 'mutated-object', 'aborted', 'revoked-failure'] as const)
  test(`Hub connection delivery rechecks ${change} after the connection snapshot wait`, async t => {
    let actor: HubPrincipal | undefined = { userId: 'default', admin: true };
    const f = createHubFixture({}, undefined, false, false, () => actor);
    const abort = new AbortController(); let release!: () => void, entered!: () => void, reads = 0;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    t.mock.method(f.hubStore, 'listUsersAsync', async () => [{ id: 'default', label: 'Private display', createdAt: 1, updatedAt: 2 }]);
    const connections = f.hubStore.listConnections();
    t.mock.method(f.hubStore, 'listConnectionsAsync', async (owner: string) => {
      assert.equal(owner, 'default'); reads++; entered();
      await new Promise<void>(resolve => { release = resolve; });
      if (change === 'revoked-failure') throw Error('Private worker failure');
      return connections;
    });
    const pending = f.app.fetch(new Request('http://hub/api/hub/v1/connections', { signal: abort.signal }));
    try {
      await waiting;
      if (change === 'revoked' || change === 'revoked-failure') actor = undefined;
      else if (change === 'member') actor = { userId: 'default', admin: false };
      else if (change === 'other') actor = { userId: 'other', admin: true };
      else if (change === 'mutated-object') actor!.admin = false;
      else abort.abort();
      release(); const response = await pending;
      assert.equal(response.status, change === 'aborted' ? 503 : 401);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      assert.doesNotMatch(await response.text(), /Private|"connections"|credential/);
      assert.equal(reads, 1, 'never replay a display read or any command');
    } finally { release?.(); await pending; await f.cleanup(); }
  });

test('Hub recovery observations bypass blocked disk statistics and recheck current admin', async t => {
  let actor: HubPrincipal | undefined = { userId: 'default', admin: true };
  const f = createHubFixture({}, undefined, false, false, () => actor);
  let reads = 0, writes = 0, release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  t.mock.method(f.hubStore, 'storageStats', async () => {
    reads++; entered(); await new Promise<void>(resolve => { release = resolve; }); throw Error('private disk failure');
  });
  t.mock.method(f.hubStore, 'checkpointStorage', () => { writes++; return { deferred: true }; });
  const path = '/api/hub/v1/maintenance/storage', blocked = f.app.request(path);
  try {
    await waiting;
    const response = await f.app.request(path + '/recovery'), body = await response.json();
    assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(body.connection, { state: 'ready', attempts: 0 });
    assert.equal(body.performance.scope, 'process'); assert.equal(body.performance.retention, 'volatile');
    assert.equal(reads, 1); assert.equal(writes, 0);
    actor = { userId: 'default', admin: false };
    assert.equal((await f.app.request(path + '/recovery')).status, 403);
    actor = undefined; assert.equal((await f.app.request(path + '/recovery')).status, 401);
    // The outer delivery gate must retain the current revocation, even when
    // the original statistics request ends with an ordinary storage failure.
    release(); const revoked = await blocked;
    assert.equal(revoked.status, 401);
    assert.deepEqual(await revoked.json(), { error: 'unauthorized' });
    actor = { userId: 'default', admin: true };
    t.mock.method(f.hubStore, 'storageStats', async () => { reads++; throw Error('private disk failure'); });
    const failed = await f.app.request(path);
    assert.equal(failed.status, 503); assert.doesNotMatch(await failed.text(), /private/);
    assert.equal(reads, 2); assert.equal(writes, 0);
  } finally { release?.(); await blocked; await f.cleanup(); }
});

test('Hub storage diagnostics require current admin and do not checkpoint on GET', async t => {
  let actor: HubPrincipal | undefined = { userId: 'default', admin: false };
  const f = createHubFixture({}, undefined, false, false, () => actor);
  let reads = 0, writes = 0, revoke = false;
  t.mock.method(f.hubStore, 'storageStats', async () => {
    reads++; if (revoke) actor = undefined;
    return { databaseBytes: 1, walBytes: 0, availableBytes: 1000, lowSpace: true, walPressure: false };
  });
  t.mock.method(f.hubStore, 'checkpointStorage', () => { writes++; return { deferred: true }; });
  const path = '/api/hub/v1/maintenance/storage';
  try {
    assert.equal((await f.app.request(path)).status, 403); assert.equal(reads, 0);
    actor = { userId: 'default', admin: true };
    assert.equal((await f.app.request(path)).status, 200); assert.equal(reads, 1); assert.equal(writes, 0);
    const post = () => f.app.request(path + '/checkpoint', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal((await post()).status, 200); assert.equal((await post()).status, 429); assert.equal(writes, 1);
    revoke = true; assert.equal((await f.app.request(path)).status, 401);
    assert.equal((await post()).status, 401); assert.equal(writes, 1);
  } finally { await f.cleanup(); }
});

for (const agent of ['codex', 'claude-code', 'ghcp'] as const) test(`${agent}: Hub interaction mode, native request and one-shot answer traverse Connector`, async () => {
  const f = createHubFixture({}, undefined, true, true);
  try {
    f.hubStore.pinConnectionNode('local', 'default', f.hubStore.connectionAuthority('local', 'default')!, f.connectorUsers.nodeId);
    const key = `${agent}:interactive`;
    if (agent === 'codex') f.store.upsertSession({ sessionKey: key, agentId: agent, title: 'Interactive', status: 'running' });
    else (agent === 'claude-code' ? f.connectorUsers.claudeJournal : f.connectorUsers.copilotJournal)
      .create({ key, nativeSessionId: 'interactive', title: 'Interactive', createdAt: 1 });
    const path = `/api/hub/v1/sessions/${encodeURIComponent(encodeHubSessionId('local', key))}`;
    const call = (suffix: string, method = 'GET', body?: unknown) => f.app.request(`${path}${suffix}`,
      { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal((await call('/interaction-mode', 'PATCH', { mode: 'interactive' })).status, 200);
    let deliveries = 0;
    const view = await f.interactions!.open({ kind: 'text', prompt: 'How should we proceed?' }, interactionCapabilitiesFor(agent), {
      scope: { ownerId: 'interaction-owner', nodeId: f.connectorUsers.nodeId, sessionKey: key, runId: 'original-run' },
      active: () => true, permitted: async () => true,
      continuation: async () => ({ connectionId: 'original-connection', goal: { status: 'absent', version: 'absent' } }),
      deliver: async () => { deliveries++; return 'confirmed'; }, cancel: () => {},
    });
    const snapshot = await call('/interactions');
    assert.equal(snapshot.status, 200);
    assert.equal(snapshot.headers.get('cache-control'), 'no-store');
    const body = await snapshot.json();
    assert.equal(body.mode, 'interactive');
    assert.equal(body.requests[0].request.requestId, view.request.requestId);
    assert.equal(body.capabilities.kinds.includes('multi-select'), agent === 'claude-code');
    f.transformInteractionResponse(async response => {
      const value = await response.json();
      value.requests[0].request.nodeId = 'wrong-node';
      return new Response(JSON.stringify(value), { status: response.status, headers: response.headers });
    });
    assert.equal((await call('/interactions')).status, 502, 'body identity must match pinned transport identity');
    f.transformInteractionResponse(undefined);
    const answer = { runId: 'original-run', expectedRevision: view.revision, responseId: 'browser-answer', answer: { kind: 'text', text: 'Continue' } };
    const suffix = `/interactions/${view.request.requestId}/answer`;
    assert.equal((await call(suffix, 'POST', { ...answer, runId: 'foreign' })).status, 409);
    for (let i = 0; i < 2; i++) {
      const result = await call(suffix, 'POST', answer);
      assert.equal(result.status, 200, await result.clone().text());
      assert.equal((await result.json()).delivery, 'confirmed');
    }
    assert.equal((await call(suffix, 'POST', { ...answer, responseId: 'other' })).status, 409);
    assert.equal((await call('/interaction-mode', 'PATCH', { mode: 'allow-all' })).status, 400);
    assert.equal(deliveries, 1);
    f.transformInteractionResponse(async response => {
      const value = await response.json(); value.request.nodeId = 'wrong-node';
      return new Response(JSON.stringify(value), { status: response.status, headers: response.headers });
    });
    assert.equal((await call(suffix, 'POST', answer)).status, 502);
    assert.equal(deliveries, 1, 'uncertain transport response must not replay native delivery');
  } finally { await f.cleanup(); }
});

test('Hub creates and queries immutable token snapshots for all native runtimes', async () => {
  const f = createHubFixture({}, undefined, true);
  try {
    for (const runtime of ['codex', 'claude-code', 'ghcp'] as const) {
      const key = `${runtime}:snapshot`, requestId = 'd2b1634a-016a-4a16-8022-0d5ca3dd4568', to = Date.now() + 1000;
      if (runtime === 'codex') f.store.upsertSession({ sessionKey: key, agentId: runtime, title: 'Usage', status: 'idle' });
      else (runtime === 'claude-code' ? f.connectorUsers.claudeJournal : f.connectorUsers.copilotJournal).create({ key, nativeSessionId: `${runtime}-snapshot`, title: 'Usage', createdAt: 1 });
      f.connectorUsers.tokenUsage.record(runtime, key, 'event', { inputTokens: 12, outputTokens: 3 });
      const path = `/api/hub/v1/sessions/${encodeHubSessionId('local', key)}/token-usage/snapshots`;
      assert.equal((await f.app.request(`${path}/${requestId}`)).status, 404);
      const response = await f.app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId, from: to - 3600000, to, bucketMs: 60000 }) });
      assert.equal(response.status, 200, await response.clone().text());
      const snapshot = await response.json(); assert.equal(snapshot.data.usage.runtime, runtime);
      assert.deepEqual(await (await f.app.request(`${path}/${requestId}`)).json(), snapshot);
    }
    f.transformTokenResponse(async response => {
      const body = await response.json(); body.memberDigest = '0'.repeat(64);
      return new Response(JSON.stringify(body), { status: response.status, headers: response.headers });
    });
    const bad = await f.app.request(`/api/hub/v1/sessions/${encodeHubSessionId('local', 'codex:snapshot')}/token-usage/snapshots/d2b1634a-016a-4a16-8022-0d5ca3dd4568`);
    assert.equal(bad.status, 502);
  } finally { await f.cleanup(); }
});

test('owned Hub token usage traverses Connector for all native runtimes without reading transcripts', async () => {
  const f = createHubFixture({}, undefined, true);
  try {
    const end = Date.now() + 1000, query = `?from=${end - 86_400_000}&to=${end}&bucketMs=3600000`;
    for (const runtime of ['codex', 'claude-code', 'ghcp'] as const) {
      const key = `${runtime}:usage`;
      if (runtime === 'codex') f.store.upsertSession({ sessionKey: key, agentId: runtime, title: 'Usage', status: 'idle' });
      else (runtime === 'claude-code' ? f.connectorUsers.claudeJournal : f.connectorUsers.copilotJournal).create({ key, nativeSessionId: `${runtime}-native`, title: 'Usage', createdAt: 1 });
      f.connectorUsers.tokenUsage.record(runtime, key, 'event', { inputTokens: 12, outputTokens: 3 });
      if (runtime === 'codex') {
        f.connectorUsers.tokenUsage.cumulative(key, 'first', { inputTokens: 1000, outputTokens: 200 });
        f.connectorUsers.tokenUsage.cumulative(key, 'late', { inputTokens: 900, outputTokens: 100 });
      }
      const response = await f.app.request(`/api/hub/v1/sessions/${encodeHubSessionId('local', key)}/token-usage${query}`);
      assert.equal(response.status, 200, await response.clone().text());
      const result = await response.json(); assert.equal(result.runtime, runtime); assert.equal(result.buckets[0].inputTokens, 12);
      assert.equal(result.coverage, 'partial'); assert.equal(result.buckets[0].cacheReadTokens, null);
      if (runtime === 'codex') {
        assert.equal(result.cumulativeCoverage.initialBaseline.inputTokens, 1000);
        assert.equal(typeof result.cumulativeCoverage.lastRegressionAt, 'number');
      } else assert.equal(result.cumulativeCoverage, undefined);
      const exported = await f.app.request(`/api/hub/v1/sessions/${encodeHubSessionId('local', key)}/token-usage/export${query}`);
      assert.equal(exported.status, 200, await exported.clone().text());
      const document = await exported.json();
      assert.deepEqual(document.usage, result);
      assert.equal(document.observations.length, 1);
      assert.equal(document.observations[0].inputTokens, 12);
    }
    assert.equal((await f.app.request(`/api/hub/v1/sessions/${encodeHubSessionId('missing', 'codex:usage')}/token-usage${query}`)).status, 404);
    assert.equal((await f.app.request(`/api/hub/v1/sessions/${encodeHubSessionId('missing', 'codex:usage')}/token-usage/export${query}`)).status, 404);
    // Actual 4096/4097 ledger boundary is covered by native-token-export.test.
    // Here exercise the typed Connector failure through the Hub transport.
    const { NativeTokenExportTooLarge } = await import('../connector/native-token-usage.js');
    f.connectorUsers.tokenUsage.export = () => { throw new NativeTokenExportTooLarge(); };
    const overflow = await f.app.request(`/api/hub/v1/sessions/${encodeHubSessionId('local', 'codex:usage')}/token-usage/export${query}`);
    assert.equal(overflow.status, 413, await overflow.clone().text());
    for (const status of [404, 403, 503]) {
      f.transformTokenResponse(async () => new Response(JSON.stringify({ error: 'Synthetic unavailable' }), { status }));
      assert.equal((await f.app.request(`/api/hub/v1/sessions/${encodeHubSessionId('local', 'codex:usage')}/token-usage/export${query}`)).status, status);
    }
    for (const payload of [{ version: 1, usage: {}, observations: [] }, { version: 1, runtime: 'codex', buckets: [] }]) {
      f.transformTokenResponse(async () => new Response(JSON.stringify(payload)));
      assert.equal((await f.app.request(`/api/hub/v1/sessions/${encodeHubSessionId('local', 'codex:usage')}/token-usage/export${query}`)).status, 502);
    }
  } finally { await f.cleanup(); }
});

test('Claude numeric delivery -> fenced journal -> SQLite -> Connector -> Hub preserves reconciled model totals', async () => {
  const f = createHubFixture({}, undefined, true);
  const key = 'claude-code:reconciled-usage', native = 'reconciled-native';
  let delivery: ClaudeStreamDelivery | undefined;
  try {
    const journal = f.connectorUsers.claudeJournal;
    journal.create({ key, nativeSessionId: native, title: 'Usage', createdAt: 1 });
    await f.connectorUsers.turns.enqueueAsync('claude-code', { id: 'usage-turn', sessionKey: key, createdAt: Date.now(), payload: { text: 'fixture', actorId: 'owner' } });
    const ref = journal.begin({ key, id: 'usage-execution', epoch: 'epoch' }, ['usage-turn'], f.connectorUsers.turns)!;
    let accepted = 0;
    delivery = new ClaudeStreamDelivery(native, async event => {
      if (event.kind === 'metrics' && journal.recordMetrics(ref, event.sample)) accepted++;
    }, () => assert.fail('delivery failed'));
    for (const [id, model, input] of [['a', 'native-a', 10], ['b', 'native-b', 20]] as const) {
      await delivery.send({ type: 'assistant', session_id: native, parent_tool_use_id: null, uuid: `block-${id}`,
        message: { id, model, role: 'assistant', content: [{ type: 'text', text: 'fixture' }],
          usage: { input_tokens: input, output_tokens: 2 } } });
    }
    const result = { type: 'result', session_id: native, uuid: 'result', usage: { input_tokens: 30, output_tokens: 4 } };
    await delivery.send(result);
    await delivery.send(result); // repeated result lacks call snapshots; event fence must still reject it.
    assert.equal(accepted, 1);
    const end = Date.now() + 1000;
    const response = await f.app.request(`/api/hub/v1/sessions/${encodeHubSessionId('local', key)}/token-usage?from=${end - 3_600_000}&to=${end}&bucketMs=60000`);
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json();
    assert.equal(body.coverage, 'partial'); assert.equal(body.timeBasis, 'observed-at');
    assert.equal(body.inputAccounting, 'excludes-cache');
    assert.equal(body.buckets.reduce((total: number, bucket: { inputTokens: number }) => total + bucket.inputTokens, 0), 30);
    assert.deepEqual(body.buckets.flatMap((bucket: { models: unknown[] }) => bucket.models)
      .map((model: { model: string; inputTokens: number; outputTokens: number; cacheReadTokens: unknown }) =>
        [model.model, model.inputTokens, model.outputTokens, model.cacheReadTokens]), [['native-a', 10, 2, null], ['native-b', 20, 2, null]]);
  } finally { await delivery?.finish(); await f.cleanup(); }
});

test('owned Hub skills discovery traverses Connector and allowlists metadata', async () => {
  const f = createHubFixture();
  let calls = 0;
  const metadata = { skills: [{ name: 'fixture', description: 'description', enabled: true, scope: 'repo', path: '/private/SKILL.md' }],
    usage: 'unknown', limited: false, observedAt: 1, discoveryErrors: 0, secret: 'not public' };
  Object.assign(f.codex, { enabled: true, listSessionSkills: async () => { calls++; return metadata; } });
  try {
    f.store.upsertSession({ sessionKey: 'codex:skills', agentId: 'codex', title: 'Skills', status: 'idle' });
    const id = encodeHubSessionId('local', 'codex:skills');
    const response = await f.app.request(`/api/hub/v1/sessions/${id}/skills`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json();
    assert.equal(body.usage, 'unknown');
    assert.equal(JSON.stringify(body).includes('private'), false);
    assert.equal(body.secret, undefined);
    assert.equal(calls, 1);
    metadata.usage = 'loaded';
    assert.equal((await f.app.request(`/api/hub/v1/sessions/${id}/skills`)).status, 502);
    Object.assign(f.codex, { enabled: false });
    assert.equal((await f.app.request(`/api/hub/v1/sessions/${id}/skills`)).status, 409);
    assert.equal((await f.app.request(`/api/hub/v1/sessions/${encodeHubSessionId('missing', 'codex:skills')}/skills`)).status, 404);
    assert.equal(calls, 2, 'unknown connections and disabled runtime do not make native reads');
  } finally { await f.cleanup(); }
});

test('owned Hub file rebuild traverses the Connector and returns only bounded progress', async () => {
  const f = createHubFixture({}, undefined, true);
  try {
    for (const runtime of ['claude-code', 'ghcp'] as const) {
      const key = `${runtime}:backfill`;
      const journal = runtime === 'claude-code' ? f.connectorUsers.claudeJournal : f.connectorUsers.copilotJournal;
      journal.create({ key, nativeSessionId: 'native', title: 'Backfill', createdAt: 1 });
      const path = `/api/hub/v1/sessions/${encodeURIComponent(encodeHubSessionId('local', key))}/files`;
      assert.equal((await (await f.app.request(path)).json() as any).rebuildAvailable, true);
      const start = await f.app.request(`${path}/rebuild`, { method: 'POST' });
      assert.equal(start.status, 200, await start.clone().text());
      const job = await start.json() as any;
      assert.deepEqual(Object.keys(job).sort(), ['id', 'step', 'state', 'scanned', 'bytes', 'found', 'limited'].sort());
      const resume = await f.app.request(`${path}/rebuild`, { method: 'POST' });
      assert.equal(resume.status, 200, await resume.clone().text());
      assert.deepEqual(await resume.json(), job, 'explicit owned restart returns the existing scan through both routes');
      assert.equal((await f.app.request(`${path}/rebuild/not-an-id`, { method: 'POST', body: '{"step":0}' })).status, 400);
      assert.equal((await f.app.request(`${path}/rebuild/${job.id}`, { method: 'POST', body: '{"step":-1}' })).status, 400);
      const result = await f.app.request(`${path}/rebuild/${job.id}`, { method: 'POST', body: JSON.stringify({ step: 0 }) });
      assert.equal(result.status, 200, await result.clone().text());
      assert.equal((await result.json() as any).state, 'completed');
      assert.equal((await (await f.app.request(path)).json() as any).coverage, 'partial');
      const again = await (await f.app.request(`${path}/rebuild`, { method: 'POST' })).json() as any;
      assert.equal((await (await f.app.request(`${path}/rebuild/${again.id}`, { method: 'DELETE' })).json() as any).state, 'cancelled');
    }
  } finally { await f.cleanup(); }
});

test('owned file index routes bound evidence through Hub with scoped cursors and no tool bodies', async () => {
  const f = createHubFixture({});
  try {
    const key = 'codex:file-index';
    f.store.upsertSession({ sessionKey: key, agentId: 'codex', title: 'Index', status: 'idle' });
    f.connectorUsers.fileIndex.replaceProjection(key, Array.from({ length: 55 }, (_, i) => ({
      id: `file-${i}`, sessionKey: key, role: 'tool' as const, toolPhase: 'result' as const, status: 'sent' as const,
      createdAt: i, text: 'PRIVATE_TOOL_BODY', sourceFiles: [{ path: `/project/file-${i}.ts`, kind: 'modified' as const }],
    })));
    const base = `/api/hub/v1/sessions/${encodeURIComponent(encodeHubSessionId('local', key))}/files`;
    const response = await f.app.request(base);
    assert.equal(response.status, 200, await response.clone().text());
    const page = await response.json() as any;
    assert.equal(page.entries.length, 50);
    assert.equal(page.coverage, 'partial');
    assert.ok(!JSON.stringify(page).includes('PRIVATE_TOOL_BODY'));
    assert.match(page.entries[0].media.url, /^\/api\/hub\/v1\/sessions\//);
    const next = await f.app.request(`${base}?cursor=${page.nextCursor}`);
    assert.equal(next.status, 200);
    assert.equal((await next.json() as any).entries.length, 5);
    assert.equal((await f.app.request(`${base}?cursor=`)).status, 400);
    f.connectorUsers.fileIndex.replaceProjection(key, []);
    assert.equal((await f.app.request(`${base}?cursor=${page.nextCursor}`)).status, 409);
    assert.equal((await f.app.request(`/api/hub/v1/sessions/${encodeURIComponent(encodeHubSessionId('local', 'codex:missing'))}/files`)).status, 404);
  } finally { f.cleanup(); }
});

test('Hermes owner Hub → Connector → runtime creation/send/history/receipt are wired without OpenClaw fallback', async () => {
  const rows: Array<{row_id:number;role:string;text:string;timestamp:number}> = [];
  let notify!: (event: HermesEvent) => void, sends = 0;
  const native: HermesTransport = { ready: false, epoch: 'fixture', async start() { this.ready = true; }, async close() { this.ready = false; },
    async request(method, params) {
      if (method === 'session.create') return { session_id: 'live', stored_session_id: 'stored' };
      if (method === 'session.activate') return { session_id: 'live', session_key: 'stored', running: false, status: 'idle' };
      if (method === 'session.history') return { messages: rows.map(row => ({ ...row })) };
      if (method === 'prompt.submit') { sends++; rows.push({ row_id: 1, role: 'user', text: (params as {text:string}).text, timestamp: 1 }); return { status: 'streaming' }; }
      throw new Error('Unexpected Hermes RPC');
    } };
  const f = createHubFixture({}, event => { notify = event; return native; });
  try {
    f.gateway.request = async () => assert.fail('Hermes must never fall back to OpenClaw');
    f.hubStore.pinConnectionNode('local', 'default', f.hubStore.connectionAuthority('local', 'default')!, f.connectorUsers.nodeId);
    await f.hermes!.start();
    const create = await f.app.request('/api/hub/v1/connections/local/agents/hermes/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Hermes integration', idempotencyKey: 'hermes-create' }) });
    assert.equal(create.status, 201, JSON.stringify(await create.clone().json()));
    const created = await create.json() as any;
    const id = created.key;
    const decoded = decodeHubSessionId(id)!;
    assert.match(decoded.remoteSessionKey, /^hermes:/);
    assert.ok(f.store.getSession(decoded.remoteSessionKey), 'created Hermes session must remain projected');
    const base = `/api/hub/v1/sessions/${encodeURIComponent(id)}`;
    const send = (message = 'hello Hermes', idempotencyKey = 'hermes-send') => f.app.request(`${base}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message, idempotencyKey }) });
    const response = await send(); assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    assert.equal((await response.json() as any).command.state, 'accepted');
    for (let i = 0; i < 100 && f.connectorUsers.hermesJournal.current(decoded.remoteSessionKey)?.phase !== 'running'; i++) await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal(sends, 1);
    assert.equal((await send('pending', 'hermes-pending')).status, 200);
    const queuedResponse = await f.app.request(`${base}/queue`);
    assert.equal(queuedResponse.status, 200);
    const queued = (await queuedResponse.json() as any).items[0];
    assert.equal(queued.state, 'queued');
    const edit = await f.app.request(`${base}/queue/${queued.id}`, { method: 'PATCH', headers: {
      'content-type': 'application/json', 'if-match': `"${queued.version}"`, 'idempotency-key': 'hermes-edit',
    }, body: JSON.stringify({ message: 'edited pending' }) });
    assert.equal(edit.status, 200, JSON.stringify(await edit.clone().json()));
    assert.ok(f.store.getMessages(decoded.remoteSessionKey).some(m => m.text === 'edited pending'));
    const updated = (await (await f.app.request(`${base}/queue`)).json() as any).items[0];
    assert.notEqual(updated.version, queued.version);
    const cancel = await f.app.request(`${base}/queue/${queued.id}`, { method: 'DELETE', headers: {
      'if-match': `"${updated.version}"`, 'idempotency-key': 'hermes-cancel',
    } });
    assert.equal(cancel.status, 200, JSON.stringify(await cancel.clone().json()));
    assert.equal((await (await f.app.request(`${base}/queue`)).json() as any).items.length, 0);
    assert.equal((await send('/compact', 'hermes-compact')).status, 409);
    assert.equal(sends, 1, 'canceled and unsupported inputs must never reach native');
    rows.push({ row_id: 2, role: 'assistant', text: 'reply from Hermes', timestamp: 2 });
    notify({ type: 'message.complete', sessionId: 'live', seq: 1, payload: { status: 'complete' } });
    for (let i = 0; i < 100 && f.connectorUsers.hermesJournal.current(decoded.remoteSessionKey)?.phase !== 'completed'; i++) await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal(f.connectorUsers.hermesJournal.current(decoded.remoteSessionKey)?.phase, 'completed');
    const history = await f.app.request(`/api/hub/v1/sessions/${encodeURIComponent(id)}/messages`);
    assert.equal(history.status, 200);
    assert.match(JSON.stringify(await history.json()), /reply from Hermes/);
    assert.equal((await send()).status, 200); assert.equal(sends, 1, 'receipt replay must not resubmit');
  } finally { await f.cleanup(); }
});

test('hub session id wraps arbitrary remote session keys as opaque base64url ids', () => {
  const remote = 'agent:agentopsdeck-pm:dashboard:01901ed1-b997-470b-a76f-87ba65700deb';
  const encoded = encodeHubSessionId('local', remote);
  assert.match(encoded, /^local:[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeHubSessionId(encoded), { connectionId: 'local', remoteSessionKey: remote });
});

test('hub session id decoder rejects malformed values', () => {
  assert.equal(decodeHubSessionId('missing-separator'), undefined);
  assert.equal(decodeHubSessionId(':empty-connection'), undefined);
});

test('Hub preserves session preferences and the 202 status when Connector deletion is uncertain', async () => {
  const fixture = createHubFixture();
  try {
    const remoteKey = 'agent:main:dashboard:synthetic-unknown-delete';
    const id = encodeHubSessionId('local', remoteKey);
    fixture.store.upsertSession({ sessionKey: remoteKey, agentId: 'main', title: 'Synthetic', status: 'idle' });
    fixture.hubStore.setSessionPreference(id, 'pinned', true);
    fixture.hubStore.pinConnectionNode('local', 'default', fixture.hubStore.connectionAuthority('local', 'default')!, fixture.connectorUsers.nodeId);
    fixture.gateway.request = async () => { throw new Error('synthetic ACK loss'); };
    const response = await fixture.app.request(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
    assert.equal(response.status, 202);
    const body = await response.json() as any;
    assert.equal(body.ok, false);
    assert.equal(body.command.state, 'outcome_unknown');
    assert.equal(fixture.hubStore.sessionPreferences().get(id)?.pinned, true);
    assert.ok(fixture.store.getSession(remoteKey));
  } finally { await fixture.cleanup(); }
});

test('hub info advertises users and hub users can be listed created and renamed', async () => {
  const fixture = createHubFixture();
  try {
    const infoRes = await fixture.app.request('/api/hub/v1/info');
    const info = await infoRes.json() as any;
    assert.equal(info.features.users, true);

    const initialRes = await fixture.app.request('/api/hub/v1/users');
    const initial = await initialRes.json() as any;
    assert.equal(initialRes.status, 200);
    assert.deepEqual(initial.users.map((user: any) => ({ id: user.id, label: user.label })), [
      { id: 'default', label: 'Default local user' },
    ]);

    const createRes = await fixture.app.request('/api/hub/v1/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: '  PigClaw Operator  ' }),
    });
    const created = await createRes.json() as any;
    assert.equal(createRes.status, 201);
    assert.match(created.user.id, /^user_/);
    assert.equal(created.user.label, 'PigClaw Operator');

    const patchRes = await fixture.app.request(`/api/hub/v1/users/${created.user.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'PigClaw Admin' }),
    });
    const patched = await patchRes.json() as any;
    assert.equal(patchRes.status, 200);
    assert.equal(patched.user.label, 'PigClaw Admin');

    const finalRes = await fixture.app.request('/api/hub/v1/users');
    const final = await finalRes.json() as any;
    assert.deepEqual(final.users.map((user: any) => user.label), ['Default local user', 'PigClaw Admin']);
  } finally {
    await fixture.cleanup();
  }
});

for (const change of ['revoked', 'member', 'other', 'mutated-object', 'aborted', 'sql-failed'] as const)
  test(`Hub async user display refuses ${change} after original readonly wait`, async t => {
    let actor: HubPrincipal | undefined = { userId: 'default', admin: true };
    const f = createHubFixture({}, undefined, false, false, () => actor);
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const signal = new AbortController();
    t.mock.method(f.hubStore, 'listUsersAsync', async (userId: string, admin: boolean) => {
      assert.equal(userId, 'default'); assert.equal(admin, true); entered();
      await new Promise<void>(resolve => { release = resolve; });
      if (change === 'sql-failed') throw Error('private SQL display failure');
      return [{ id: 'default', label: 'private old account', createdAt: 1, updatedAt: 2,
        usage: { lastLoginAt: null, lastActiveAt: null } }];
    });
    const pending = f.app.fetch(new Request('http://hub/api/hub/v1/users', { signal: signal.signal }));
    try {
      await waiting;
      if (change === 'revoked') actor = undefined;
      if (change === 'member') actor = { userId: 'default', admin: false };
      if (change === 'other') actor = { userId: 'other', admin: true };
      if (change === 'mutated-object') actor!.admin = false;
      if (change === 'aborted') signal.abort();
      release(); const response = await pending;
      assert.equal(response.status, ['aborted', 'sql-failed'].includes(change) ? 503 : 401);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      assert.doesNotMatch(await response.text(), /private|"users"\s*:|"usage"\s*:/);
    } finally { release?.(); await pending; await f.cleanup(); }
  });

test('Hub member user display delegates only its owned account without admin metadata', async t => {
  const actor: HubPrincipal = { userId: 'default', admin: false };
  const f = createHubFixture({}, undefined, false, false, () => actor);
  t.mock.method(f.hubStore, 'listUsers', () => { throw Error('sync user list must not run'); });
  t.mock.method(f.hubStore.identities, 'userUsage', () => { throw Error('N+1 usage must not run'); });
  t.mock.method(f.hubStore, 'listUsersAsync', async (owner: string, admin: boolean) => {
    assert.equal(owner, actor.userId); assert.equal(admin, false);
    return [{ id: 'default', label: 'Own user', createdAt: 1, updatedAt: 2 }];
  });
  try {
    const response = await f.app.request('/api/hub/v1/users');
    assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual((await response.json()).users, [{ id: 'default', label: 'Own user', createdAt: 1, updatedAt: 2 }]);
  } finally { await f.cleanup(); }
});

for (const phase of ['remote-return', 'display-return', 'remote-failure'] as const)
  test(`Connector user mutation refuses revoked delivery at ${phase} without replay`, async t => {
    const rows: any[] = [];
    const diagnostics = new PerformanceDiagnostics(line => rows.push(JSON.parse(line)));
    t.mock.method(performanceDiagnostics, 'start', (...args: Parameters<typeof performanceDiagnostics.start>) => diagnostics.start(...args));
    let actor: HubPrincipal | undefined = { userId: 'default', admin: true };
    const f = createHubFixture({}, undefined, false, false, () => actor);
    let requests = 0;
    f.hubStore.upsertConnection({ id: 'remote-fence', kind: 'remote', label: 'PRIVATE connection',
      connectorUrl: 'https://remote-fence.invalid', status: 'enabled', credentialToken: 'PRIVATE credential' });
    t.mock.method(globalThis, 'fetch', async () => {
      requests++;
      if (phase !== 'display-return') actor = undefined;
      if (phase === 'remote-failure') throw Error('PRIVATE transport');
      return Response.json({ user: { id: 'PRIVATE user', label: 'PRIVATE label', createdAt: 1, updatedAt: 2 }, updatedAt: 2 }, { status: 201 });
    });
    if (phase === 'display-return') t.mock.method(f.hubStore, 'listUsersAsync', async () => { actor = undefined; return []; });
    try {
      const response = await f.app.request('/api/hub/v1/connections/remote-fence/connector-users', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'PRIVATE label' }),
      });
      assert.equal(response.status, 401); assert.equal(requests, 1);
      assert.doesNotMatch(await response.text(), /PRIVATE/);
      const events = rows.filter(row => row.operation === 'hub-connector-user-change' && row.phase === 'finished');
      assert.equal(events.length, 1); assert.equal(events[0].category, 'failed');
      if (phase === 'remote-failure') assert.equal(events[0].unknown, 1);
      else assert.equal(events[0].settled, 1);
      assert.doesNotMatch(JSON.stringify(events), /PRIVATE|remote-fence/);
    } finally { await f.cleanup(); }
  });

test('Connector user mutation pins its original connection across streamed body consumption', async t => {
  const rows: any[] = [];
  const diagnostics = new PerformanceDiagnostics(line => rows.push(JSON.parse(line)));
  t.mock.method(performanceDiagnostics, 'start', (...args: Parameters<typeof performanceDiagnostics.start>) => diagnostics.start(...args));
  const f = createHubFixture(); let requests = 0, finish!: () => void, closed = false;
  f.hubStore.upsertConnection({ id: 'remote-fence', kind: 'remote', label: 'Original',
    connectorUrl: 'https://remote-fence.invalid', status: 'enabled', credentialToken: 'PRIVATE original' });
  t.mock.method(globalThis, 'fetch', async () => {
    requests++; return Response.json({ user: { id: 'new', label: 'New', createdAt: 1, updatedAt: 2 }, updatedAt: 2 }, { status: 201 });
  });
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new TextEncoder().encode('{"label":'));
    finish = () => { if (closed) return; closed = true; controller.enqueue(new TextEncoder().encode('"New"}')); controller.close(); };
  } });
  const pending = f.app.fetch(new Request('http://fixture.invalid/api/hub/v1/connections/remote-fence/connector-users', {
    method: 'POST', body, duplex: 'half',
  } as RequestInit));
  try {
    await new Promise(resolve => setImmediate(resolve));
    f.hubStore.upsertConnection({ id: 'remote-fence', kind: 'remote', label: 'Replacement',
      connectorUrl: 'https://replacement.invalid', status: 'enabled', credentialToken: 'PRIVATE replacement' });
    finish(); const response = await pending;
    assert.equal(response.status, 503); assert.equal(requests, 0);
    assert.doesNotMatch(await response.text(), /PRIVATE|replacement.invalid/);
    const events = rows.filter(row => row.operation === 'hub-connector-user-change' && row.phase === 'finished');
    assert.equal(events.length, 1); assert.equal(events[0].step, 2);
    assert.equal(events[0].admitted, undefined); assert.equal(events[0].unknown, undefined);
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE|remote-fence|replacement/);
  } finally { finish?.(); await pending; await f.cleanup(); }
});

test('Connector user mutation retains remote settlement on failed display IO without sync scans or replay', async t => {
  const f = createHubFixture(); let requests = 0;
  const rows: any[] = [], diagnostics = new PerformanceDiagnostics(line => rows.push(JSON.parse(line)));
  t.mock.method(performanceDiagnostics, 'start', (...args: Parameters<typeof performanceDiagnostics.start>) => diagnostics.start(...args));
  f.hubStore.upsertConnection({ id: 'remote-fence', kind: 'remote', label: 'Original',
    connectorUrl: 'https://remote-fence.invalid', status: 'enabled', credentialToken: 'PRIVATE credential' });
  t.mock.method(globalThis, 'fetch', async () => {
    requests++; return Response.json({ user: { id: 'new', label: 'PRIVATE label', createdAt: 1, updatedAt: 2 }, updatedAt: 2 }, { status: 201 });
  });
  t.mock.method(f.hubStore, 'listUsers', () => { throw Error('PRIVATE sync scan'); });
  t.mock.method(f.hubStore, 'listUsersAsync', async (userId: string, admin: boolean) => {
    assert.equal(userId, 'default'); assert.equal(admin, true); throw Error('PRIVATE display SQL');
  });
  try {
    const response = await f.app.request('/api/hub/v1/connections/remote-fence/connector-users', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'PRIVATE label' }),
    });
    assert.equal(response.status, 503); assert.equal(requests, 1);
    assert.deepEqual(await response.json(), { error: 'hub_connector_users_unavailable' });
    const events = rows.filter(row => row.operation === 'hub-connector-user-change' && row.phase === 'finished');
    assert.equal(events.length, 1); assert.equal(events[0].step, 4); assert.equal(events[0].settled, 1);
    assert.equal(events[0].unknown, undefined); assert.doesNotMatch(JSON.stringify(events), /PRIVATE|remote-fence/);
  } finally { await f.cleanup(); }
});

test('hub connector-users aggregates local connector users and proxies remote connector user mutations', async () => {
  const fixture = createHubFixture();
  const originalFetch = globalThis.fetch;
  const remoteSecret = 'remote-users-secret';
  const remoteUser = { id: 'remote-account-1', label: 'Remote Account', createdAt: 10, updatedAt: 10 };
  try {
    fixture.hubStore.upsertConnection({
      id: 'remote-users',
      kind: 'remote',
      label: 'Remote Users',
      connectorUrl: 'https://remote-users.example',
      status: 'enabled',
      capabilities: ['users'],
      credentialToken: remoteSecret,
    });
    const localUser = fixture.connectorUsers.createUser('Local Connector Operator');
    const seen: Array<{ url: string; method: string | undefined; authorization: string | undefined; body?: any }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input instanceof Request) { init = { headers: input.headers, signal: input.signal, ...(input.method !== "GET" ? { method: input.method, body: await input.text() } : {}) }; input = input.url; }
      const headers = new Headers(init?.headers);
      const row = { url: String(input), method: init?.method, authorization: headers.get('authorization') ?? undefined, body: init?.body ? JSON.parse(String(init.body)) : undefined };
      seen.push(row);
      assert.equal(row.authorization, `Bearer ${remoteSecret}`);
      if (row.url === 'https://remote-users.example/api/connector/v1/users' && !row.method) {
        return Response.json({ users: [remoteUser], updatedAt: 11 });
      }
      if (row.url === 'https://remote-users.example/api/connector/v1/users' && row.method === 'POST') {
        return Response.json({ user: { id: 'remote-created', label: row.body.label, createdAt: 12, updatedAt: 12 }, updatedAt: 12 }, { status: 201 });
      }
      if (row.url === 'https://remote-users.example/api/connector/v1/users/remote-account-1' && row.method === 'PATCH') {
        return Response.json({ user: { ...remoteUser, label: row.body.label, updatedAt: 13 }, updatedAt: 13 });
      }
      return Response.json({ error: `unexpected ${row.url}` }, { status: 500 });
    }) as typeof fetch;

    const listRes = await fixture.app.request('/api/hub/v1/connector-users');
    const list = await listRes.json() as any;
    assert.equal(listRes.status, 200);
    const local = list.connections.find((connection: any) => connection.id === 'local');
    const remote = list.connections.find((connection: any) => connection.id === 'remote-users');
    assert.equal(local.supported, true);
    assert.equal(local.users.some((user: any) => user.id === localUser.id && user.label === 'Local Connector Operator'), true);
    assert.equal(remote.supported, true);
    assert.deepEqual(remote.users, [remoteUser]);
    assert.equal(JSON.stringify(list).includes(remoteSecret), false);

    const createLocal = await fixture.app.request('/api/hub/v1/connections/local/connector-users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'Second Local Connector' }),
    });
    const createdLocal = await createLocal.json() as any;
    assert.equal(createLocal.status, 201);
    assert.equal(createdLocal.user.label, 'Second Local Connector');

    const createRemote = await fixture.app.request('/api/hub/v1/connections/remote-users/connector-users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'Created Remote' }),
    });
    const createdRemote = await createRemote.json() as any;
    assert.equal(createRemote.status, 201);
    assert.equal(createdRemote.user.label, 'Created Remote');

    const patchRemote = await fixture.app.request('/api/hub/v1/connections/remote-users/connector-users/remote-account-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'Renamed Remote' }),
    });
    const patchedRemote = await patchRemote.json() as any;
    assert.equal(patchRemote.status, 200);
    assert.equal(patchedRemote.user.label, 'Renamed Remote');
    assert.deepEqual(seen.map((request) => [request.url, request.method]), [
      ['https://remote-users.example/api/connector/v1/users', undefined],
      ['https://remote-users.example/api/connector/v1/users', 'POST'],
      ['https://remote-users.example/api/connector/v1/users/remote-account-1', 'PATCH'],
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    await fixture.cleanup();
  }
});

test('privileged remote connector controls require maintenance token without daily-token fallback', async () => {
  const fixture = createHubFixture();
  const originalFetch = globalThis.fetch;
  const seen: Array<{ url: string; authorization: string | null; body?: any }> = [];
  try {
    fixture.hubStore.upsertConnection({ id: 'remote-sec', kind: 'remote', label: 'Remote Sec', connectorUrl: 'https://remote-sec.example', credentialToken: 'daily-secret' });

    const missing = await fixture.app.request('/api/hub/v1/connections/remote-sec/gateway/model-set/reconcile', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ setId: 'agentopsdeck-model-set-v1' }) });
    assert.equal(missing.status, 401);
    assert.equal(JSON.stringify(await missing.json()).includes('daily-secret'), false);

    fixture.hubStore.updateMaintenanceCredential('remote-sec', 'maintenance-secret');
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input instanceof Request) { init = { headers: input.headers, signal: input.signal, ...(input.method !== "GET" ? { method: input.method, body: await input.text() } : {}) }; input = input.url; }
      seen.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization'), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return Response.json({ ok: true, state: 'succeeded' });
    }) as typeof fetch;

    const reconcile = await fixture.app.request('/api/hub/v1/connections/remote-sec/gateway/model-set/reconcile', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ setId: 'agentopsdeck-model-set-v1', idempotencyKey: 'idem' }) });
    assert.equal(reconcile.status, 200);
    const check = await fixture.app.request('/api/hub/v1/connections/remote-sec/update/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: 'stable' }) });
    assert.equal(check.status, 200);
    const rollback = await fixture.app.request('/api/hub/v1/connections/remote-sec/update/rollback', { method: 'POST' });
    assert.equal(rollback.status, 410);

    assert.deepEqual(seen.map((request) => request.authorization), ['Bearer maintenance-secret', 'Bearer maintenance-secret']);
    assert.equal(JSON.stringify(seen).includes('daily-secret'), false);

    const status = await fixture.app.request('/api/hub/v1/connections/remote-sec/gateway/model-set');
    assert.equal(status.status, 200);
    assert.equal(seen.at(-1)?.authorization, 'Bearer maintenance-secret');
  } finally {
    globalThis.fetch = originalFetch;
    await fixture.cleanup();
  }
});

test('disabled local node rejects user writes and maintenance without touching Connector state', async () => {
  const fixture = createHubFixture();
  try {
    const before = fixture.connectorUsers.listUsers();
    fixture.hubStore.upsertConnection({ id: 'local', kind: 'local', label: 'local', connectorUrl: 'local://aod-connector', status: 'disabled' });
    const user = await fixture.app.request('/api/hub/v1/connections/local/connector-users', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'must not exist' }),
    });
    assert.equal(user.status, 404);
    assert.deepEqual(fixture.connectorUsers.listUsers(), before);
    const control = await fixture.app.request('/api/hub/v1/connections/local/update/status');
    assert.equal(control.status, 404);
  } finally { await fixture.cleanup(); }
});

test('hub rejects arbitrary model sets and unsafe update control fields before proxying', async () => {
  const fixture = createHubFixture();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    fixture.hubStore.upsertConnection({ id: 'remote-guard', kind: 'remote', label: 'Remote Guard', connectorUrl: 'https://remote-guard.example', credentialToken: 'daily' });
    fixture.hubStore.updateMaintenanceCredential('remote-guard', 'maint');
    globalThis.fetch = (async () => { calls += 1; return Response.json({ ok: true }); }) as typeof fetch;

    const badSet = await fixture.app.request('/api/hub/v1/connections/remote-guard/gateway/model-set/reconcile', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ setId: 'evil-set' }) });
    assert.equal(badSet.status, 400);
    const badChannel = await fixture.app.request('/api/hub/v1/connections/remote-guard/update/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: 'nightly' }) });
    assert.equal(badChannel.status, 400);
    const badApply = await fixture.app.request('/api/hub/v1/connections/remote-guard/update/apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: '2.0.0', artifactUrl: 'https://evil.example/a.tar', command: 'sh' }) });
    assert.equal(badApply.status, 410);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    await fixture.cleanup();
  }
});

test('hub user update validates label and missing ids', async () => {
  const fixture = createHubFixture();
  try {
    const emptyCreate = await fixture.app.request('/api/hub/v1/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: '   ' }),
    });
    assert.equal(emptyCreate.status, 400);

    const missing = await fixture.app.request('/api/hub/v1/users/nope', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'Missing' }),
    });
    assert.equal(missing.status, 404);
  } finally {
    await fixture.cleanup();
  }
});

test('hub sessions state preserves local-only behavior with wrapped local sessions', async () => {
  const fixture = createHubFixture();
  try {
    fixture.store.upsertSession({
      sessionKey: 'agent:local-dev:dashboard:local-1',
      agentId: 'local-dev',
      title: 'Local session',
      status: 'idle',
      lastActiveAt: 1_800_000_000_000,
    });

    const res = await fixture.app.request('/api/hub/v1/sessions/state');
    assert.equal(res.status, 200);
    const body = await res.json() as any;

    assert.deepEqual(body.connections.map((connection: any) => connection.id), ['local']);
    assert.equal(body.groups.length, 1);
    const session = body.groups[0].sessions[0];
    assert.equal(session.envConnectionId, 'local');
    assert.equal(session.remoteSessionKey, 'agent:local-dev:dashboard:local-1');
    assert.equal(session.hubSessionId, encodeHubSessionId('local', 'agent:local-dev:dashboard:local-1'));
    assert.equal(session.sessionKey, session.hubSessionId);
  } finally {
    await fixture.cleanup();
  }
});

test('hub sessions state fans in enabled remote connectors with bearer token and no token leak', async () => {
  const fixture = createHubFixture();
  const originalFetch = globalThis.fetch;
  const seenRequests: Array<{ url: string; authorization: string | undefined }> = [];
  try {
    fixture.store.upsertSession({
      sessionKey: 'agent:local-dev:dashboard:local-1',
      agentId: 'shared-agent',
      title: 'Local session',
      status: 'idle',
      lastActiveAt: 10,
    });
    fixture.hubStore.upsertConnection({
      id: 'remote-one',
      kind: 'remote',
      label: 'Remote One',
      connectorUrl: 'https://remote-one.example',
      status: 'enabled',
      environmentId: 'remote-env',
      environmentLabel: 'Remote Env',
      capabilities: ['sessions'],
      credentialToken: 'remote-secret-token',
    });

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input instanceof Request) { init = { headers: input.headers, signal: input.signal, ...(input.method !== "GET" ? { method: input.method, body: await input.text() } : {}) }; input = input.url; }
      const url = String(input);
      const authorization = new Headers(init?.headers).get('authorization') ?? undefined;
      seenRequests.push({ url, authorization });
      assert.equal(url, 'https://remote-one.example/api/connector/v1/sessions/state?includeHidden=1&includeArchived=1');
      assert.equal(authorization, 'Bearer remote-secret-token');
      return Response.json({
        groups: [{
          agentId: 'shared-agent',
          sessions: [{
            sessionKey: 'agent:remote-dev:dashboard:remote-1',
            agentId: 'shared-agent',
            title: 'Remote session',
            status: 'running',
            lastActiveAt: 20,
          }],
        }],
        updatedAt: 20,
        revision: 'remote-revision',
      });
    }) as typeof fetch;

    const first = await fixture.app.request('/api/hub/v1/sessions/state');
    const second = await fixture.app.request('/api/hub/v1/sessions/state');
    const body = await first.json() as any;
    const bodyAgain = await second.json() as any;

    assert.equal(seenRequests.length, 2);
    assert.equal(body.revision, bodyAgain.revision);
    assert.deepEqual(body.connections.map((connection: any) => connection.id), ['local', 'remote-one']);
    assert.equal(JSON.stringify(body).includes('remote-secret-token'), false);
    assert.equal(body.groups.length, 1);
    assert.deepEqual(body.groups[0].sessions.map((session: any) => session.hubSessionId), [
      encodeHubSessionId('remote-one', 'agent:remote-dev:dashboard:remote-1'),
      encodeHubSessionId('local', 'agent:local-dev:dashboard:local-1'),
    ]);
    const remote = body.groups[0].sessions[0];
    assert.equal(remote.envConnectionId, 'remote-one');
    assert.equal(remote.envConnectionLabel, 'Remote One');
    assert.equal(remote.remoteSessionKey, 'agent:remote-dev:dashboard:remote-1');
    assert.equal(remote.sessionKey, remote.hubSessionId);
  } finally {
    globalThis.fetch = originalFetch;
    await fixture.cleanup();
  }
});

test('hub session pin API stores hub-local pin state and sorts pinned remote sessions first', async () => {
  const fixture = createHubFixture();
  const originalFetch = globalThis.fetch;
  const remoteSessionKey = 'agent:remote-dev:dashboard:pin-remote';
  const hubSessionId = encodeHubSessionId('remote-pin', remoteSessionKey);
  try {
    fixture.store.upsertSession({
      sessionKey: 'agent:local-dev:dashboard:pin-local',
      agentId: 'shared-agent',
      title: 'Newer local',
      status: 'idle',
      lastActiveAt: 50,
    });
    fixture.hubStore.upsertConnection({
      id: 'remote-pin',
      kind: 'remote',
      label: 'Remote Pin',
      connectorUrl: 'https://remote-pin.example',
      status: 'enabled',
      environmentId: 'remote-pin-env',
      environmentLabel: 'Remote Pin Env',
      capabilities: ['sessions'],
      credentialToken: 'remote-pin-secret',
    });
    globalThis.fetch = (async () => Response.json({
      groups: [{
        agentId: 'shared-agent',
        sessions: [{ sessionKey: remoteSessionKey, agentId: 'shared-agent', title: 'Older remote', status: 'idle', lastActiveAt: 10 }],
      }],
    })) as typeof fetch;

    const pinRes = await fixture.app.request(`/api/sessions/${encodeURIComponent(hubSessionId)}/pin`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pinned: true }),
    });
    assert.equal(pinRes.status, 200);

    const stateRes = await fixture.app.request('/api/hub/v1/sessions/state');
    const body = await stateRes.json() as any;
    assert.equal(body.pinnedCount, 1);
    assert.deepEqual(body.groups[0].sessions.map((session: any) => [session.sessionKey, Boolean(session.pinned)]), [
      [hubSessionId, true],
      [encodeHubSessionId('local', 'agent:local-dev:dashboard:pin-local'), false],
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    await fixture.cleanup();
  }
});

test('hub sessions state skips disabled remotes and reports failed remotes as degraded without sessions', async () => {
  const fixture = createHubFixture();
  const originalFetch = globalThis.fetch;
  const seenUrls: string[] = [];
  try {
    fixture.hubStore.upsertConnection({
      id: 'disabled-remote',
      kind: 'remote',
      label: 'Disabled Remote',
      connectorUrl: 'https://disabled.example',
      status: 'disabled',
      capabilities: ['sessions'],
      credentialToken: 'disabled-secret',
    });
    fixture.hubStore.upsertConnection({
      id: 'broken-remote',
      kind: 'remote',
      label: 'Broken Remote',
      connectorUrl: 'https://broken.example',
      status: 'enabled',
      capabilities: ['sessions'],
      credentialToken: 'broken-secret',
    });

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      seenUrls.push(url);
      assert.equal(url, 'https://broken.example/api/connector/v1/sessions/state?includeHidden=1&includeArchived=1');
      return new Response(JSON.stringify({ error: 'missing sessions:read scope' }), { status: 403 });
    }) as typeof fetch;

    const res = await fixture.app.request('/api/hub/v1/sessions/state');
    const body = await res.json() as any;

    assert.deepEqual(seenUrls, ['https://broken.example/api/connector/v1/sessions/state?includeHidden=1&includeArchived=1']);
    assert.deepEqual(body.groups, []);
    const disabled = body.connections.find((connection: any) => connection.id === 'disabled-remote');
    const broken = body.connections.find((connection: any) => connection.id === 'broken-remote');
    assert.equal(disabled.status, 'disabled');
    assert.equal(broken.status, 'degraded');
    assert.match(broken.error, /HTTP 403/);
    assert.equal(JSON.stringify(body).includes('disabled-secret'), false);
    assert.equal(JSON.stringify(body).includes('broken-secret'), false);
  } finally {
    globalThis.fetch = originalFetch;
    await fixture.cleanup();
  }
});

test('hub connection patch renames environment without exposing credentials', async () => {
  const fixture = createHubFixture();
  try {
    fixture.hubStore.upsertConnection({
      id: 'remote-rename',
      kind: 'remote',
      label: 'Old Remote',
      connectorUrl: 'https://rename.example',
      status: 'enabled',
      environmentLabel: 'Old Env',
      capabilities: ['sessions'],
      credentialToken: 'rename-secret',
    });
    const authority = fixture.hubStore.connectionAuthority('remote-rename');
    const res = await fixture.app.request('/api/hub/v1/connections/remote-rename', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'New Remote', environmentLabel: 'New Env' }),
    });
    const body = await res.json() as any;

    assert.equal(res.status, 200);
    assert.equal(body.connection.label, 'New Remote');
    assert.equal(body.connection.environmentLabel, 'New Env');
    assert.equal(body.connection.hasCredential, true);
    assert.equal(JSON.stringify(body).includes('rename-secret'), false);
    assert.equal(fixture.hubStore.connectionAuthority('remote-rename'), authority, 'a display-only edit must not invalidate active clients');
    const disable = await fixture.app.request('/api/hub/v1/connections/remote-rename', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'Renamed disabled', enabled: false }),
    });
    assert.equal(disable.status, 200);
    assert.equal(fixture.hubStore.connectionAuthority('remote-rename'), authority! + 1, 'actual authority edits retain their fence');
  } finally {
    await fixture.cleanup();
  }
});

for (const method of ['POST', 'DELETE']) test(`source preview approval ${method} is owner-only and fences remote identity/revocation`, async () => {
  const fixture = createHubFixture(), originalFetch = globalThis.fetch;
  const nodeId = 'node_00000000-0000-4000-8000-000000000001';
  const resource = 'a'.repeat(64), remoteKey = 'codex:source-test';
  const path = (connection: string) => `/api/hub/v1/sessions/${encodeURIComponent(encodeHubSessionId(connection, remoteKey))}/messages/m1/media/${resource}/approval`;
  let behavior = 'ok', requests = 0;
  try {
    fixture.hubStore.upsertConnection({ id: 'source-owner', label: 'Owner', connectorUrl: 'https://source.example', credentialToken: 'synthetic' });
    fixture.hubStore.upsertConnection({ id: 'source-other', ownerUserId: 'other', label: 'Other', connectorUrl: 'https://other.example', credentialToken: 'synthetic' });
    fixture.hubStore.pinConnectionNode('source-owner', 'default', fixture.hubStore.connectionAuthority('source-owner', 'default')!, nodeId);
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const request = input as Request; requests++;
      assert.equal(request.url, `https://source.example/api/connector/v1/sessions/${encodeURIComponent(remoteKey)}/messages/m1/media/${resource}/approval`);
      assert.equal(request.method, method);
      if (behavior === 'revoke') fixture.hubStore.deleteConnection('source-owner');
      return Response.json({ ok: behavior !== 'unconfirmed' }, { headers: { [NODE_ID_HEADER]: behavior === 'identity' ? 'wrong-node' : nodeId } });
    }) as typeof fetch;
    assert.equal((await fixture.app.request(path('source-other'), { method })).status, 404);
    assert.equal((await fixture.app.request(`/api/hub/v1/shared/fake/sessions/${encodeURIComponent(remoteKey)}/messages/m1/media/${resource}/approval`, { method })).status, 404);
    assert.equal(requests, 0, 'other owners and shared readers cannot dispatch approvals');
    const response = await fixture.app.request(path('source-owner'), { method });
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { ok: true });
    behavior = 'unconfirmed'; assert.equal((await fixture.app.request(path('source-owner'), { method })).status, 409);
    behavior = 'identity'; assert.equal((await fixture.app.request(path('source-owner'), { method })).status, 502);
    behavior = 'revoke'; assert.equal((await fixture.app.request(path('source-owner'), { method })).status, 403);
    assert.equal((await fixture.app.request(path('source-owner'), { method })).status, 404);
    assert.equal(requests, 4);
  } finally { globalThis.fetch = originalFetch; await fixture.cleanup(); }
});

for (const resource of ['agents', 'models/codex']) test(`owner discovers remote ${resource}, with identity and revocation fencing`, async () => {
  const fixture = createHubFixture();
  const originalFetch = globalThis.fetch;
  const nodeId = 'node_00000000-0000-4000-8000-000000000001';
  let behavior = 'ok', requests = 0;
  try {
    fixture.hubStore.upsertConnection({ id: 'empty-remote', label: 'Remote', connectorUrl: 'https://agents.example', credentialToken: 'synthetic' });
    fixture.hubStore.upsertConnection({ id: 'foreign', ownerUserId: 'other', label: 'Other', connectorUrl: 'https://other.example', credentialToken: 'synthetic' });
    fixture.hubStore.pinConnectionNode('empty-remote', 'default', fixture.hubStore.connectionAuthority('empty-remote', 'default')!, nodeId);
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requests++;
      const request = input as Request;
      assert.equal(request.url, `https://agents.example/api/connector/v1/${resource}`);
      assert.equal(request.method, 'GET');
      assert.equal(request.headers.get('authorization'), 'Bearer synthetic');
      if (behavior === 'revoke') fixture.hubStore.deleteConnection('empty-remote');
      return Response.json({ agents: [{ id: 'codex', label: 'Codex' }, { id: 'hermes', label: 'Hermes' }] }, {
        status: behavior === 'unavailable' ? 503 : 200,
        headers: { [NODE_ID_HEADER]: behavior === 'identity' ? 'wrong-node' : nodeId },
      });
    }) as typeof fetch;
    const path = `/api/hub/v1/connections/empty-remote/${resource}`;
    const response = await fixture.app.request(path);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual((await response.json() as any).agents.map((agent: any) => agent.id), ['codex', 'hermes']);
    assert.equal((await fixture.app.request(`/api/hub/v1/connections/foreign/${resource}`)).status, 404);
    assert.equal(requests, 1, 'a foreign connection must never dispatch using owner credentials');
    behavior = 'identity'; assert.equal((await fixture.app.request(path)).status, 502);
    behavior = 'unavailable'; assert.equal((await fixture.app.request(path)).status, 503);
    behavior = 'revoke'; assert.equal((await fixture.app.request(path)).status, 403);
    assert.equal((await fixture.app.request(path)).status, 404);
    assert.equal(requests, 4);
  } finally { globalThis.fetch = originalFetch; await fixture.cleanup(); }
});

test('hub creates remote connector sessions through selected environment and wraps returned key', async () => {
  const fixture = createHubFixture();
  const originalFetch = globalThis.fetch;
  try {
    fixture.hubStore.upsertConnection({
      id: 'remote-create',
      kind: 'remote',
      label: 'Remote Create',
      connectorUrl: 'https://create.example',
      status: 'enabled',
      capabilities: ['sessions'],
      credentialToken: 'create-secret',
    });
    const nodeId = 'node_00000000-0000-4000-8000-000000000001';
    fixture.hubStore.pinConnectionNode('remote-create', 'default', fixture.hubStore.connectionAuthority('remote-create', 'default')!, nodeId);
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input instanceof Request) { init = { headers: input.headers, signal: input.signal, ...(input.method !== "GET" ? { method: input.method, body: await input.text() } : {}) }; input = input.url; }
      assert.equal(String(input), 'https://create.example/api/connector/v1/agents/remote-pm/sessions');
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('authorization'), 'Bearer create-secret');
      assert.equal(init?.method, 'POST');
      assert.deepEqual(JSON.parse(String(init?.body)), { label: 'Remote title' });
      return Response.json({ key: 'agent:remote-pm:dashboard:created', command: {
        id: 'synthetic-create', key: headers.get('idempotency-key'), state: 'accepted', createdAt: 1, updatedAt: 1,
      } }, { status: 201, headers: { [NODE_ID_HEADER]: nodeId } });
    }) as typeof fetch;

    const res = await fixture.app.request('/api/hub/v1/connections/remote-create/agents/remote-pm/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'Remote title' }),
    });
    const body = await res.json() as any;

    assert.equal(res.status, 201);
    assert.equal(body.key, encodeHubSessionId('remote-create', 'agent:remote-pm:dashboard:created'));
    assert.equal(body.remoteSessionKey, 'agent:remote-pm:dashboard:created');
    assert.equal(JSON.stringify(body).includes('create-secret'), false);
  } finally {
    globalThis.fetch = originalFetch;
    await fixture.cleanup();
  }
});

test('hub creates in-process local sessions through selected local environment', async () => {
  const fixture = createHubFixture();
  fixture.hubStore.pinConnectionNode('local', 'default', fixture.hubStore.connectionAuthority('local', 'default')!, fixture.connectorUsers.nodeId);
  const calls: any[] = [];
  fixture.gateway.request = async (method: string, params: any) => {
    calls.push({ method, params });
    return { key: 'agent:local-pm:dashboard:created' };
  };
  try {
    const res = await fixture.app.request('/api/hub/v1/connections/local/agents/local-pm/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'Local title' }),
    });
    const body = await res.json() as any;

    assert.equal(res.status, 201);
    assert.deepEqual(calls, [{ method: 'sessions.create', params: { agentId: 'local-pm', label: 'Local title' } }]);
    assert.equal(body.key, encodeHubSessionId('local', 'agent:local-pm:dashboard:created'));
    assert.equal(fixture.store.getSession('agent:local-pm:dashboard:created')?.title, 'Local title');
  } finally {
    await fixture.cleanup();
  }
});

test('idle hub stream immediately flushes a heartbeat without advancing the event cursor', async () => {
  const fixture = createHubFixture();
  const controller = new AbortController();
  try {
    const response = await fixture.app.request('/api/hub/v1/events/stream', { signal: controller.signal });
    assert.equal(response.headers.get('x-accel-buffering'), 'no');
    const reader = response.body!.getReader();
    const { value } = await reader.read();
    const frame = new TextDecoder().decode(value);
    assert.match(frame, /event: heartbeat/);
    assert.doesNotMatch(frame, /(?:^|\n)id:/);
    controller.abort(); await reader.cancel();
  } finally { controller.abort(); await fixture.cleanup(); }
});

test('hub events stream preserves local SSE wrapping behavior', async () => {
  const fixture = createHubFixture();
  try {
    const cursor = fixture.store.append('session.updated', {});
    const hubCursor = fixture.seedCursor(cursor.id);
    const localEvent = fixture.store.append('session.updated', { title: 'Local session' }, {
      sessionKey: 'agent:local-dev:dashboard:local-events',
      agentId: 'local-dev',
    });

    const events = await readHubSseEvents(fixture.app, `/api/hub/v1/events/stream?lastEventId=${hubCursor}`, 1, (event) => event.type === 'session.updated');
    const hubEvent = events[0]!;

    assert.match(hubEvent.id, /^hub:/);
    assert.notEqual(hubEvent.id, localEvent.id);
    assert.equal(hubEvent.type, 'session.updated');
    assert.equal(hubEvent.envConnectionId, 'local');
    assert.equal(hubEvent.remoteEventId, localEvent.id);
    assert.equal(hubEvent.remoteSessionKey, 'agent:local-dev:dashboard:local-events');
    assert.equal(hubEvent.hubSessionId, encodeHubSessionId('local', 'agent:local-dev:dashboard:local-events'));
    assert.equal(hubEvent.sessionKey, hubEvent.hubSessionId);
    assert.deepEqual(hubEvent.payload, { title: 'Local session' });
  } finally {
    await fixture.cleanup();
  }
});

test('hub local wrapped cursor replays all 80 missed events, not a tail of 50', async () => {
  const fixture = createHubFixture();
  try {
    const cursor = fixture.store.append('session.updated', {});
    const hubCursor = fixture.seedCursor(cursor.id);
    const expected = Array.from({ length: 80 }, (_, i) => fixture.store.append('message.created', { index: i }));
    const events = await readHubSseEvents(fixture.app, `/api/hub/v1/events/stream?lastEventId=${hubCursor}`, 80, (event) => event.type === 'message.created');
    assert.deepEqual(events.map((event) => event.remoteEventId), expected.map((event) => event.id));
  } finally { await fixture.cleanup(); }
});

test('hub expired cursor explicitly requests snapshot catch-up', async () => {
  const fixture = createHubFixture();
  try {
    fixture.store.append('session.updated', {});
    const events = await readHubSseEvents(fixture.app, '/api/hub/v1/events/stream?lastEventId=hub_expired', 1);
    assert.equal(events[0].type, 'stream.reset');
    assert.equal(events[0].payload.reason, 'cursor_expired');
  } finally { await fixture.cleanup(); }
});

test('hub reconnects a closed upstream connector with its last acknowledged cursor', async () => {
  const fixture = createHubFixture();
  const originalFetch = globalThis.fetch;
  const cursors: Array<string | null> = [];
  try {
    fixture.hubStore.upsertConnection({ id: 'reconnecting', kind: 'remote', label: 'Remote', connectorUrl: 'https://reconnect.example', status: 'enabled', capabilities: ['events'], credentialToken: 'test-secret' });
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (_input instanceof Request) init = { headers: _input.headers, signal: _input.signal };
      cursors.push(new Headers(init?.headers).get('last-event-id'));
      const id = `event-${cursors.length}`;
      return new Response(`event: heartbeat\ndata: \n\nid: ${id}\nevent: message.created\ndata: ${JSON.stringify({ id, type: 'message.created', payload: {} })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;
    const events = await readHubSseEvents(fixture.app, '/api/hub/v1/events/stream', 2, (event) => event.type === 'message.created');
    assert.deepEqual(cursors, [null, 'event-1']);
    assert.deepEqual(events.map((event) => event.remoteEventId), ['event-1', 'event-2']);
  } finally { globalThis.fetch = originalFetch; await fixture.cleanup(); }
});

test('hub events stream fans in remote connector SSE with bearer auth and wrapped hub session id without token leak', async () => {
  const fixture = createHubFixture();
  const originalFetch = globalThis.fetch;
  const secret = 'remote-events-secret';
  const remoteSessionKey = 'agent:remote-dev:dashboard:remote-events';
  const seenRequests: Array<{ url: string; authorization: string | undefined; lastEventId: string | undefined }> = [];
  try {
    fixture.hubStore.upsertConnection({
      id: 'remote-events',
      kind: 'remote',
      label: 'Remote Events',
      connectorUrl: 'https://remote-events.example',
      status: 'enabled',
      capabilities: ['events'],
      credentialToken: secret,
    });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input instanceof Request) { init = { headers: input.headers, signal: input.signal, ...(input.method !== "GET" ? { method: input.method, body: await input.text() } : {}) }; input = input.url; }
      const headers = new Headers(init?.headers);
      seenRequests.push({
        url: String(input),
        authorization: headers.get('authorization') ?? undefined,
        lastEventId: headers.get('last-event-id') ?? undefined,
      });
      assert.equal(String(input), 'https://remote-events.example/api/connector/v1/events/stream');
      assert.equal(headers.get('authorization'), `Bearer ${secret}`);
      return sseResponse({
        id: 'remote-event-1',
        event: 'message.created',
        data: {
          id: 'remote-event-1',
          type: 'message.created',
          ts: 123,
          sessionKey: remoteSessionKey,
          agentId: 'remote-dev',
          payload: { text: 'hello from remote event' },
          connector: { environmentId: 'remote-env' },
        },
      });
    }) as typeof fetch;

    const events = await readHubSseEvents(fixture.app, '/api/hub/v1/events/stream', 2, (event) => event.envConnectionId === 'remote-events');
    assert.equal(events[0]!.type, 'stream.reset');
    const hubEvent = events[1]!;

    assert.equal(seenRequests.length, 1);
    assert.equal(seenRequests[0]!.lastEventId, undefined);
    assert.equal(hubEvent.type, 'message.created');
    assert.equal(hubEvent.envConnectionId, 'remote-events');
    assert.equal(hubEvent.envConnectionLabel, 'Remote Events');
    assert.equal(hubEvent.remoteEventId, 'remote-event-1');
    assert.equal(hubEvent.remoteSessionKey, remoteSessionKey);
    assert.equal(hubEvent.hubSessionId, encodeHubSessionId('remote-events', remoteSessionKey));
    assert.equal(hubEvent.sessionKey, hubEvent.hubSessionId);
    assert.deepEqual(hubEvent.payload, { text: 'hello from remote event' });
    assert.equal(JSON.stringify(hubEvent).includes(secret), false);
  } finally {
    globalThis.fetch = originalFetch;
    await fixture.cleanup();
  }
});

test('hub events stream skips disabled and credential-less remotes and tolerates failed remote streams', async () => {
  const fixture = createHubFixture();
  const originalFetch = globalThis.fetch;
  const seenRequests: Array<{ url: string; authorization: string | undefined }> = [];
  let entered!: () => void;
  const upstreamStarted = new Promise<void>(resolve => { entered = resolve; });
  try {
    fixture.hubStore.upsertConnection({
      id: 'disabled-events',
      kind: 'remote',
      label: 'Disabled Events',
      connectorUrl: 'https://disabled-events.example',
      status: 'disabled',
      capabilities: ['events'],
      credentialToken: 'disabled-events-secret',
    });
    fixture.hubStore.upsertConnection({
      id: 'no-credential-events',
      kind: 'remote',
      label: 'No Credential Events',
      connectorUrl: 'https://no-credential-events.example',
      status: 'enabled',
      capabilities: ['events'],
    });
    fixture.hubStore.upsertConnection({
      id: 'broken-events',
      kind: 'remote',
      label: 'Broken Events',
      connectorUrl: 'https://broken-events.example',
      status: 'enabled',
      capabilities: ['events'],
      credentialToken: 'broken-events-secret',
    });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input instanceof Request) { init = { headers: input.headers, signal: input.signal, ...(input.method !== "GET" ? { method: input.method, body: await input.text() } : {}) }; input = input.url; }
      seenRequests.push({
        url: String(input),
        authorization: new Headers(init?.headers).get('authorization') ?? undefined,
      });
      entered();
      return Response.json({ error: 'missing events:read scope' }, { status: 403 });
    }) as typeof fetch;

    await openHubSseBriefly(fixture.app, '/api/hub/v1/events/stream', upstreamStarted);

    assert.deepEqual(seenRequests, [{
      url: 'https://broken-events.example/api/connector/v1/events/stream',
      authorization: 'Bearer broken-events-secret',
    }]);
  } finally {
    globalThis.fetch = originalFetch;
    await fixture.cleanup();
  }
});

test('hub local message routes preserve wrapped GET and Connector-owned durable admission', async () => {
  const fixture = createHubFixture();
  try {
    const sessionKey = 'agent:local-dev:dashboard:local-messages';
    const hubSessionId = encodeHubSessionId('local', sessionKey);
    fixture.store.upsertSession({
      sessionKey,
      agentId: 'local-dev',
      title: 'Local messages',
      status: 'idle',
      lastActiveAt: 1,
    });
    fixture.store.addMessage({
      id: 'local-message-1',
      sessionKey,
      role: 'assistant',
      text: 'hello from local',
      createdAt: 2,
      media: [{ type: 'image', url: '/api/media/inbound/local.png', name: 'local.png', mimeType: 'image/png' }],
    });
    const gatewayRequests: any[] = [];
    fixture.gateway.request = async (_method: string, payload: any) => {
      gatewayRequests.push(payload);
      return { runId: 'local-run-1', status: 'started' };
    };

    const getRes = await fixture.app.request(`/api/hub/v1/sessions/${hubSessionId}/messages`);
    const getBody = await getRes.json() as any;
    assert.equal(getRes.status, 200);
    const validated = await fixture.app.request(`/api/hub/v1/sessions/${hubSessionId}/messages`, {
      headers: { 'if-none-match': getRes.headers.get('etag')! },
    });
    assert.equal(validated.status, 304);
    assert.equal(await validated.text(), '');
    assert.equal(getBody.messages[0].sessionKey, hubSessionId);
    assert.equal(getBody.messages[0].hubSessionId, hubSessionId);
    assert.equal(getBody.messages[0].remoteSessionKey, sessionKey);
    assert.equal(getBody.messages[0].media[0].url, `/api/hub/v1/sessions/${encodeURIComponent(hubSessionId)}/messages/local-message-1/media/${mediaResourceId('/api/media/inbound/local.png')}`);

    const postRes = await fixture.app.request(`/api/hub/v1/sessions/${hubSessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'send locally', idempotencyKey: 'local-key-1' }),
    });
    const postBody = await postRes.json() as any;
    assert.equal(postRes.status, 200);
    assert.equal(postBody.status, 'queued');
    assert.equal(postBody.command.state, 'accepted');
    assert.notEqual(postBody.idempotencyKey, 'local-key-1');
    assert.equal(gatewayRequests.length, 0);
    await (fixture.queue as any).reconcile(sessionKey);
    assert.equal(gatewayRequests.length, 1);
    assert.equal(gatewayRequests[0].sessionKey, sessionKey);
    assert.equal(gatewayRequests[0].message, 'send locally');
  } finally {
    await fixture.cleanup();
  }
});

test('hub local Codex stop preserves the decoded session and observed run without claiming completion', async () => {
  const fixture = createHubFixture();
  try {
    const sessionKey = 'codex:thread-to-stop';
    const hubSessionId = encodeHubSessionId('local', sessionKey);
    const interrupted: Array<{ key: string; expected: string; actor: string }> = [];
    fixture.codex.owns = (key: string) => key.startsWith('codex:');
    fixture.codex.interrupt = async (key: string, expected: string, actor: string) => { interrupted.push({ key, expected, actor }); };

    const response = await fixture.app.request(`/api/hub/v1/sessions/${hubSessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '/stop', deliveryMode: 'web-only', media: [], expectedRunId: 'observed-turn' }),
    });

    assert.equal(response.status, 200);
    assert.equal((await response.json() as any).status, 'interrupt_requested');
    assert.equal(interrupted.length, 1);
    assert.equal(interrupted[0]!.key, sessionKey);
    assert.equal(interrupted[0]!.expected, 'observed-turn');
    assert.ok(interrupted[0]!.actor);
  } finally {
    await fixture.cleanup();
  }
});

test('hub local Codex session accepts a supported model override', async () => {
  const fixture = createHubFixture();
  fixture.hubStore.pinConnectionNode('local', 'default', fixture.hubStore.connectionAuthority('local', 'default')!, fixture.connectorUsers.nodeId);
  try {
    const sessionKey = 'codex:thread-model';
    const hubSessionId = encodeHubSessionId('local', sessionKey);
    fixture.store.upsertSession({ sessionKey, agentId: 'codex', title: 'Codex', status: 'idle', source: 'codex', model: 'gpt-5.6-sol' });
    fixture.codex.owns = (key: string) => key === sessionKey;
    (fixture.codex as any).updateSessionRuntime = (key: string, params: { model: string; thinking: null }, ack: (session: any) => void) => {
      assert.equal(key, sessionKey);
      assert.deepEqual(params, { model: 'gpt-6-astra', thinking: null });
      const session = { ...fixture.store.getSession(key)!, model: params.model }; ack(session); return session;
    };

    const response = await fixture.app.request(`/api/sessions/${hubSessionId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-6-astra', thinking: null }),
    });

    assert.equal(response.status, 200);
    assert.equal((await response.json() as any).settings.model, 'gpt-6-astra');
  } finally {
    await fixture.cleanup();
  }
});

test('hub local Codex messages persist and forward image attachments', async () => {
  const fixture = createHubFixture();
  let persistedPath = '';
  try {
    const sessionKey = 'codex:thread-with-image';
    fixture.store.upsertSession({ sessionKey, agentId: 'codex', title: 'Image test', status: 'idle' });
    const hubSessionId = encodeHubSessionId('local', sessionKey);
    const sends: any[][] = [];
    fixture.codex.owns = (key: string) => key.startsWith('codex:');
    (fixture.codex as any).send = async (...args: any[]) => {
      sends.push(args);
      persistedPath = args[2][0].filePath;
      return { runId: 'codex-image-run', status: 'started', media: args[2].map((item: any) => item.media) };
    };

    const response = await fixture.app.request(`/api/hub/v1/sessions/${hubSessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: 'What is shown here?',
        media: [{ name: 'screen.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,aW1hZ2U=' }],
      }),
    });
    const body = await response.json() as any;

    assert.equal(response.status, 200);
    assert.equal(sends[0]?.[0], sessionKey);
    assert.equal(sends[0]?.[1], 'What is shown here?');
    assert.equal(sends[0]?.[2]?.[0]?.media.name, 'screen.png');
    assert.match(persistedPath, /agentopsdeck-.*-screen\.png$/);
    assert.equal(body.media[0].type, 'image');
  } finally {
    if (persistedPath) rmSync(persistedPath, { force: true });
    await fixture.cleanup();
  }
});

test('hub local Codex messages reject non-image attachments', async () => {
  const fixture = createHubFixture();
  try {
    const sessionKey = 'codex:thread-with-file';
    const hubSessionId = encodeHubSessionId('local', sessionKey);
    fixture.codex.owns = (key: string) => key.startsWith('codex:');

    const response = await fixture.app.request(`/api/hub/v1/sessions/${hubSessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: 'Read this',
        media: [{ name: 'notes.pdf', mimeType: 'application/pdf', dataUrl: 'data:application/pdf;base64,cGRm' }],
      }),
    });

    assert.equal(response.status, 400);
    const rejected = await response.json() as any;
    assert.equal(rejected.error, 'Command rejected');
    assert.equal(rejected.command.state, 'rejected');
  } finally {
    await fixture.cleanup();
  }
});

test('hub local wrapped session model patch sends schema-valid Gateway params', async () => {
  const fixture = createHubFixture();
  fixture.hubStore.pinConnectionNode('local', 'default', fixture.hubStore.connectionAuthority('local', 'default')!, fixture.connectorUsers.nodeId);
  try {
    const sessionKey = 'agent:local-dev:dashboard:local-model';
    const hubSessionId = encodeHubSessionId('local', sessionKey);
    fixture.store.upsertSession({ sessionKey, agentId: 'local-dev', title: 'Local model', status: 'idle', model: 'old-model', lastActiveAt: 1 });
    const gatewayRequests: Array<{ method: string; params: any }> = [];
    fixture.gateway.request = async (method: string, params: any) => {
      gatewayRequests.push({ method, params });
      return { resolved: { model: 'new-model', modelProvider: 'test-provider' } };
    };

    const response = await fixture.app.request(`/api/sessions/${encodeURIComponent(hubSessionId)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'new-model', thinking: 'medium' }),
    });

    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.equal(body.sessionKey, hubSessionId);
    assert.equal(body.settings.model, 'new-model');
    assert.equal(body.settings.thinkingLevel, 'medium');
    const stateResponse = await fixture.app.request('/api/hub/v1/sessions/state');
    const state = await stateResponse.json() as any;
    const listed = state.groups.flatMap((group: any) => group.sessions).find((session: any) => session.sessionKey === hubSessionId);
    assert.equal(listed?.thinkingLevel, 'medium');
    assert.deepEqual(gatewayRequests, [{ method: 'sessions.patch', params: { key: sessionKey, model: 'new-model', agentId: 'local-dev', thinkingLevel: 'medium' } }]);
  } finally {
    await fixture.cleanup();
  }
});

test('hub local wrapped session model reset sends null Gateway params', async () => {
  const fixture = createHubFixture();
  fixture.hubStore.pinConnectionNode('local', 'default', fixture.hubStore.connectionAuthority('local', 'default')!, fixture.connectorUsers.nodeId);
  try {
    const sessionKey = 'agent:local-dev:dashboard:local-model-reset';
    const hubSessionId = encodeHubSessionId('local', sessionKey);
    fixture.store.upsertSession({ sessionKey, agentId: 'local-dev', title: 'Local model reset', status: 'idle', model: 'old-model', modelProvider: 'old-provider', lastActiveAt: 1 });
    const gatewayRequests: Array<{ method: string; params: any }> = [];
    fixture.gateway.request = async (method: string, params: any) => {
      gatewayRequests.push({ method, params });
      return { resolved: {} };
    };

    const response = await fixture.app.request(`/api/sessions/${encodeURIComponent(hubSessionId)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: null }),
    });

    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.equal(body.sessionKey, hubSessionId);
    assert.equal(body.settings.model, null);
    assert.equal(body.settings.modelProvider, null);
    assert.deepEqual(gatewayRequests, [{ method: 'sessions.patch', params: { key: sessionKey, model: null, agentId: 'local-dev' } }]);
  } finally {
    await fixture.cleanup();
  }
});

test('hub remote wrapped session model reset proxies null to connector without token leak', async () => {
  const fixture = createHubFixture();
  const originalFetch = globalThis.fetch;
  const secret = 'remote-model-reset-secret';
  const remoteSessionKey = 'agent:remote-dev:dashboard:remote-model-reset';
  const hubSessionId = encodeHubSessionId('remote-model-reset', remoteSessionKey);
  const seen: Array<{ url: string; method: string | undefined; authorization: string | null; body: any }> = [];
  try {
    fixture.hubStore.upsertConnection({
      id: 'remote-model-reset',
      kind: 'remote',
      label: 'Remote Model Reset',
      connectorUrl: 'https://remote-model-reset.example',
      status: 'enabled',
      capabilities: ['sessions'],
      credentialToken: secret,
    });
    const nodeId = 'node_00000000-0000-4000-8000-000000000001';
    fixture.hubStore.pinConnectionNode('remote-model-reset', 'default', fixture.hubStore.connectionAuthority('remote-model-reset', 'default')!, nodeId);
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input instanceof Request) { init = { headers: input.headers, signal: input.signal, ...(input.method !== "GET" ? { method: input.method, body: await input.text() } : {}) }; input = input.url; }
      const headers = new Headers(init?.headers);
      const row = { url: String(input), method: init?.method, authorization: headers.get('authorization'), body: init?.body ? JSON.parse(String(init.body)) : undefined };
      seen.push(row);
      return Response.json({ sessionKey: remoteSessionKey, settings: { model: null, modelProvider: null },
        command: { key: headers.get('idempotency-key'), state: 'accepted', createdAt: 1, updatedAt: 2 },
      }, { headers: { [NODE_ID_HEADER]: nodeId } });
    }) as typeof fetch;

    const response = await fixture.app.request(`/api/sessions/${encodeURIComponent(hubSessionId)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: null }),
    });

    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.equal(body.sessionKey, hubSessionId);
    assert.equal(body.settings.model, null);
    assert.equal(body.settings.modelProvider, null);
    assert.equal(JSON.stringify(body).includes(secret), false);
    assert.deepEqual(seen, [{
      url: `https://remote-model-reset.example/api/connector/v1/sessions/${encodeURIComponent(remoteSessionKey)}`,
      method: 'PATCH',
      authorization: `Bearer ${secret}`,
      body: { model: null },
    }]);
  } finally {
    globalThis.fetch = originalFetch;
    await fixture.cleanup();
  }
});

test('hub remote messages GET proxies to connector with bearer token and wraps sessions without leaking token', async () => {
  const fixture = createHubFixture();
  const originalFetch = globalThis.fetch;
  const secret = 'remote-message-secret';
  const remoteSessionKey = 'agent:remote-dev:dashboard:remote-messages';
  const hubSessionId = encodeHubSessionId('remote-one', remoteSessionKey);
  try {
    fixture.hubStore.upsertConnection({
      id: 'remote-one',
      kind: 'remote',
      label: 'Remote One',
      connectorUrl: 'https://remote-one.example',
      status: 'enabled',
      capabilities: ['messages'],
      credentialToken: secret,
    });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input instanceof Request) { init = { headers: input.headers, signal: input.signal, ...(input.method !== "GET" ? { method: input.method, body: await input.text() } : {}) }; input = input.url; }
      assert.equal(String(input), `https://remote-one.example/api/connector/v1/sessions/${encodeURIComponent(remoteSessionKey)}/messages`);
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${secret}`);
      return Response.json({
        messages: [{
          id: 'remote-message-1',
          sessionKey: remoteSessionKey,
          role: 'assistant',
          text: 'hello from remote',
          createdAt: 3,
          media: [
            { type: 'image', url: '/api/media/inbound/remote.png', name: 'remote.png', mimeType: 'image/png' },
            { type: 'file', url: 'https://cdn.example/public.txt', name: 'public.txt', mimeType: 'text/plain' },
            { type: 'file', url: '/api/media/inbound/%2E%2E%2Fsecret.txt', name: 'secret.txt', mimeType: 'text/plain' },
          ],
        }],
        totalCount: 1,
        hiddenCount: 0,
        updatedAt: 4,
        revision: 'remote-message-revision',
      });
    }) as typeof fetch;

    const res = await fixture.app.request(`/api/hub/v1/sessions/${hubSessionId}/messages`);
    const body = await res.json() as any;

    assert.equal(res.status, 200);
    const timingNames = res.headers.get('server-timing')!.split(',').map(value => value.trim().split(';')[0]);
    assert.equal(timingNames.length, new Set(timingNames).size);
    for (const stage of ['app', 'connectorWait', 'wrap', 'encode']) assert.ok(timingNames.includes(stage));
    assert.equal(body.revision, 'remote-message-revision');
    assert.equal(body.messages[0].sessionKey, hubSessionId);
    assert.equal(body.messages[0].hubSessionId, hubSessionId);
    assert.equal(body.messages[0].remoteSessionKey, remoteSessionKey);
    assert.equal(body.messages[0].media[0].url, `/api/hub/v1/sessions/${encodeURIComponent(hubSessionId)}/messages/remote-message-1/media/${mediaResourceId('/api/media/inbound/remote.png')}`);
    assert.equal(body.messages[0].media[1].url, 'https://cdn.example/public.txt');
    assert.equal(body.messages[0].media[2].url, `/api/hub/v1/sessions/${encodeURIComponent(hubSessionId)}/messages/remote-message-1/media/${mediaResourceId('/api/media/inbound/%2E%2E%2Fsecret.txt')}`);
    assert.equal(JSON.stringify(body).includes(secret), false);
  } finally {
    globalThis.fetch = originalFetch;
    await fixture.cleanup();
  }
});

test('hub remote messages GET preserves distinct identities with identical content', async () => {
  const fixture = createHubFixture();
  const originalFetch = globalThis.fetch;
  const remoteSessionKey = 'agent:remote-dev:dashboard:duplicate-messages';
  const hubSessionId = encodeHubSessionId('remote-dedupe', remoteSessionKey);
  try {
    fixture.hubStore.upsertConnection({
      id: 'remote-dedupe',
      kind: 'remote',
      label: 'Remote Dedupe',
      connectorUrl: 'https://remote-dedupe.example',
      status: 'enabled',
      capabilities: ['messages'],
      credentialToken: 'remote-dedupe-secret',
    });
    globalThis.fetch = (async () => Response.json({
      messages: [
        { id: 'assistant-a', sessionKey: remoteSessionKey, role: 'assistant', text: 'same answer', createdAt: 10 },
        { id: 'assistant-b', sessionKey: remoteSessionKey, role: 'assistant', text: 'same answer', createdAt: 11 },
        { id: 'tool-a', sessionKey: remoteSessionKey, role: 'tool', toolPhase: 'call', toolCallId: 'call-1', toolName: 'exec', text: 'run it', createdAt: 12 },
        { id: 'tool-b', sessionKey: remoteSessionKey, role: 'tool', toolPhase: 'call', toolCallId: 'call-1', toolName: 'exec', text: 'run it', createdAt: 13 },
      ],
      totalCount: 4,
    })) as typeof fetch;

    const res = await fixture.app.request(`/api/hub/v1/sessions/${hubSessionId}/messages`);
    const body = await res.json() as any;

    assert.equal(res.status, 200);
    assert.deepEqual(body.messages.map((message: any) => message.id), ['assistant-a', 'assistant-b', 'tool-a', 'tool-b']);
    assert.equal(body.totalCount, 4);
  } finally {
    globalThis.fetch = originalFetch;
    await fixture.cleanup();
  }
});

test('hub remote media proxy fetches connector media with bearer token and streams safe headers without token leak', async () => {
  const fixture = createHubFixture();
  const originalFetch = globalThis.fetch;
  const secret = 'remote-media-secret';
  const bytes = Buffer.from('remote image bytes');
  try {
    fixture.hubStore.upsertConnection({
      id: 'remote-media',
      kind: 'remote',
      label: 'Remote Media',
      connectorUrl: 'https://remote-media.example',
      status: 'enabled',
      capabilities: ['media'],
      credentialToken: secret,
    });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input instanceof Request) { init = { headers: input.headers, signal: input.signal, ...(input.method !== "GET" ? { method: input.method, body: await input.text() } : {}) }; input = input.url; }
      assert.equal(String(input), 'https://remote-media.example/api/connector/v1/media/inbound/photo.png');
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${secret}`);
      return new Response(bytes, {
        status: 200,
        headers: {
          'content-type': 'image/png',
          'content-length': String(bytes.length),
          'cache-control': 'private, max-age=3600',
          'content-disposition': 'inline; filename="photo.png"',
          'x-connector-secret': secret,
        },
      });
    }) as typeof fetch;

    const res = await fixture.app.request('/api/hub/v1/connections/remote-media/media/inbound/photo.png');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal(res.headers.get('content-length'), String(bytes.length));
    assert.equal(res.headers.get('content-disposition'), 'inline; filename="photo.png"');
    assert.equal(res.headers.get('x-connector-secret'), null);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes);
    assert.equal(JSON.stringify([...res.headers]).includes(secret), false);
  } finally {
    globalThis.fetch = originalFetch;
    await fixture.cleanup();
  }
});

test('hub remote media proxy short-circuits disabled, missing, credential-less, and unsafe requests without connector fetch', async () => {
  const fixture = createHubFixture();
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  try {
    fixture.hubStore.upsertConnection({
      id: 'disabled-media',
      kind: 'remote',
      label: 'Disabled Media',
      connectorUrl: 'https://disabled-media.example',
      status: 'disabled',
      capabilities: ['media'],
      credentialToken: 'disabled-media-secret',
    });
    fixture.hubStore.upsertConnection({
      id: 'no-credential-media',
      kind: 'remote',
      label: 'No Credential Media',
      connectorUrl: 'https://no-credential-media.example',
      status: 'enabled',
      capabilities: ['media'],
    });
    fixture.hubStore.upsertConnection({
      id: 'unsafe-media',
      kind: 'remote',
      label: 'Unsafe Media',
      connectorUrl: 'https://unsafe-media.example',
      status: 'enabled',
      capabilities: ['media'],
      credentialToken: 'unsafe-media-secret',
    });
    globalThis.fetch = (async () => {
      fetchCount += 1;
      return Response.json({ error: 'should not be called' }, { status: 500 });
    }) as typeof fetch;

    const missing = await fixture.app.request('/api/hub/v1/connections/missing-media/media/inbound/photo.png');
    const disabled = await fixture.app.request('/api/hub/v1/connections/disabled-media/media/inbound/photo.png');
    const noCredential = await fixture.app.request('/api/hub/v1/connections/no-credential-media/media/inbound/photo.png');
    const unsafe = await fixture.app.request('/api/hub/v1/connections/unsafe-media/media/inbound/%2E%2E%2Fsecret.txt');

    assert.equal(missing.status, 404);
    assert.equal(disabled.status, 404);
    assert.equal(noCredential.status, 401);
    assert.equal(unsafe.status, 400);
    assert.equal(fetchCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
    await fixture.cleanup();
  }
});

test('hub remote media proxy propagates connector errors safely without bearer token leak', async () => {
  const fixture = createHubFixture();
  const originalFetch = globalThis.fetch;
  const secret = 'remote-media-error-secret';
  try {
    fixture.hubStore.upsertConnection({
      id: 'remote-media-error',
      kind: 'remote',
      label: 'Remote Media Error',
      connectorUrl: 'https://remote-media-error.example',
      status: 'enabled',
      capabilities: ['media'],
      credentialToken: secret,
    });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(new Headers(input instanceof Request ? input.headers : init?.headers).get('authorization'), `Bearer ${secret}`);
      return Response.json({ error: `missing media:read scope; private ${secret}` }, { status: 403 });
    }) as typeof fetch;

    const res = await fixture.app.request('/api/hub/v1/connections/remote-media-error/media/inbound/photo.png');
    const body = await res.json() as any;

    assert.equal(res.status, 403);
    assert.equal(body.error, 'Connector request failed: HTTP 403');
    assert.equal(body.status, 403);
    assert.equal(JSON.stringify(body).includes(secret), false);
  } finally {
    globalThis.fetch = originalFetch;
    await fixture.cleanup();
  }
});

test('hub remote messages POST proxies validated body to connector with bearer token and no token leak', async () => {
  const fixture = createHubFixture();
  const originalFetch = globalThis.fetch;
  const secret = 'remote-send-secret';
  const userMessage = 'Keep api_key=fake-key-123 password=fake-password-456 and token=fake-token-789 exactly.';
  const remoteSessionKey = 'agent:remote-dev:dashboard:remote-send';
  const hubSessionId = encodeHubSessionId('remote-send', remoteSessionKey);
  try {
    fixture.hubStore.upsertConnection({
      id: 'remote-send',
      kind: 'remote',
      label: 'Remote Send',
      connectorUrl: 'https://remote-send.example',
      status: 'enabled',
      capabilities: ['messages'],
      credentialToken: secret,
    });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input instanceof Request) { init = { headers: input.headers, signal: input.signal, ...(input.method !== "GET" ? { method: input.method, body: await input.text() } : {}) }; input = input.url; }
      assert.equal(String(input), `https://remote-send.example/api/connector/v1/sessions/${encodeURIComponent(remoteSessionKey)}/messages`);
      assert.equal(init?.method, 'POST');
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${secret}`);
      const payload = JSON.parse(String(init?.body));
      assert.equal(payload.message, userMessage);
      assert.match(payload.idempotencyKey, /^cmd_[0-9a-f-]{36}$/);
      assert.equal(payload.idempotencyKey, new Headers(init?.headers).get('idempotency-key'));
      return Response.json({ ok: true, runId: 'remote-run-1', status: 'started', idempotencyKey: 'remote-key-1', media: [] });
    }) as typeof fetch;

    const res = await fixture.app.request(`/api/hub/v1/sessions/${hubSessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: userMessage, idempotencyKey: 'remote-key-1' }),
    });
    const body = await res.json() as any;

    assert.equal(res.status, 200);
    assert.equal(body.command.state, 'accepted');
    assert.equal(body.command.key, 'remote-key-1');
    const { command: _, ...result } = body;
    assert.deepEqual(result, { ok: true, runId: 'remote-run-1', status: 'started', idempotencyKey: 'remote-key-1', media: [] });
    assert.equal(JSON.stringify(body).includes(secret), false);
  } finally {
    globalThis.fetch = originalFetch;
    await fixture.cleanup();
  }
});

for (const mode of ['startup', 'offline', 'lost-ack', '503'] as const) test(`Hub message receipt survives ${mode} without duplicate dispatch`, async () => {
  const fixture = createHubFixture();
  const originalFetch = globalThis.fetch;
  let posts = 0, received = 0;
  const bodies: string[] = [];
  const id = encodeHubSessionId('startup-node', 'codex:startup');
  const route = `/api/hub/v1/sessions/${id}`;
  try {
    fixture.hubStore.upsertConnection({ id: 'startup-node', kind: 'remote', label: 'Startup',
      connectorUrl: 'http://startup.example', credentialToken: 'synthetic', capabilities: ['messages'] });
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const request = input as Request;
      if (request.method !== 'POST') return Response.json({ error: 'not found' }, { status: 404 });
      posts++;
      bodies.push(await request.text());
      if (mode === 'offline' || (mode === 'startup' && posts < 2)) {
        throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED', syscall: 'connect' } });
      }
      received++;
      if (mode === 'lost-ack') throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET', syscall: 'read' } });
      if (mode === '503') return Response.json({}, { status: 503 });
      return Response.json({ ok: true, runId: 'startup-run', idempotencyKey: JSON.parse(bodies.at(-1)!).idempotencyKey });
    }) as typeof fetch;
    const send = () => fixture.app.request(`${route}/messages`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'startup', idempotencyKey: 'startup-key' }) });
    const expected = mode === 'startup' ? 'accepted' : mode === 'offline' ? 'rejected' : 'outcome_unknown';
    const response = await send();
    assert.equal(response.status, mode === 'startup' ? 200 : mode === 'offline' ? 409 : 202);
    assert.equal((await response.json() as any).command.state, expected);
    assert.equal(received, mode === 'offline' ? 0 : 1);
    assert.equal(posts, mode === 'startup' ? 2 : mode === 'offline' ? 6 : 1);
    assert.equal(new Set(bodies).size, 1);
    const count = posts;
    // A page reload and a repeated POST only inspect the original receipt.
    assert.equal((await (await fixture.app.request(`${route}/commands/startup-key`)).json() as any).command.state, expected);
    assert.equal((await (await send()).json() as any).command.state, expected);
    assert.equal(posts, count);
  } finally { globalThis.fetch = originalFetch; await fixture.cleanup(); }
});

test('hub remote message routes handle missing, disabled, and credential-less connections without connector fetch', async () => {
  const fixture = createHubFixture();
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  try {
    fixture.hubStore.upsertConnection({
      id: 'disabled-remote',
      kind: 'remote',
      label: 'Disabled Remote',
      connectorUrl: 'https://disabled.example',
      status: 'disabled',
      capabilities: ['messages'],
      credentialToken: 'disabled-message-secret',
    });
    fixture.hubStore.upsertConnection({
      id: 'no-credential',
      kind: 'remote',
      label: 'No Credential',
      connectorUrl: 'https://nocred.example',
      status: 'enabled',
      capabilities: ['messages'],
    });
    globalThis.fetch = (async () => {
      fetchCount += 1;
      return Response.json({ error: 'should not be called' }, { status: 500 });
    }) as typeof fetch;

    const missing = await fixture.app.request(`/api/hub/v1/sessions/${encodeHubSessionId('missing-remote', 'agent:x:dashboard:y')}/messages`);
    const disabled = await fixture.app.request(`/api/hub/v1/sessions/${encodeHubSessionId('disabled-remote', 'agent:x:dashboard:y')}/messages`);
    const noCredential = await fixture.app.request(`/api/hub/v1/sessions/${encodeHubSessionId('no-credential', 'agent:x:dashboard:y')}/messages`);
    const noCredentialBody = await noCredential.json() as any;

    assert.equal(missing.status, 404);
    assert.equal(disabled.status, 404);
    assert.equal(noCredential.status, 401);
    assert.equal(noCredentialBody.error, 'Connector credential is missing');
    assert.equal(fetchCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
    await fixture.cleanup();
  }
});

test('hub-only split local connector URL seeds default connection and proxies sessions/messages/media with vaulted token', async () => {
  const fixture = createHubFixture({
    AOD_SERVER_ROLE: 'hub',
    AOD_HUB_LOCAL_CONNECTOR_URL: 'https://split-connector.example/',
    AOD_HUB_LOCAL_CONNECTOR_TOKEN: 'split-secret-token',
  });
  const originalFetch = globalThis.fetch;
  const remoteSessionKey = 'agent:split-dev:dashboard:split-session';
  const hubSessionId = encodeHubSessionId('local', remoteSessionKey);
  const seen: Array<{ url: string; method: string | undefined; authorization: string | undefined }> = [];
  try {
    fixture.store.upsertSession({
      sessionKey: 'agent:local-dev:dashboard:should-not-appear',
      agentId: 'local-dev',
      title: 'In-process local session should not be used by hub-only split mode',
      status: 'idle',
      lastActiveAt: 99,
    });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (input instanceof Request) { init = { headers: input.headers, signal: input.signal, ...(input.method !== "GET" ? { method: input.method, body: await input.text() } : {}) }; input = input.url; }
      const url = String(input);
      const headers = new Headers(init?.headers);
      seen.push({ url, method: init?.method, authorization: headers.get('authorization') ?? undefined });
      assert.equal(headers.get('authorization'), 'Bearer split-secret-token');
      if (url === 'https://split-connector.example/api/connector/v1/sessions/state?includeHidden=1&includeArchived=1') {
        return Response.json({ groups: [{ agentId: 'split-dev', sessions: [{ sessionKey: remoteSessionKey, agentId: 'split-dev', title: 'Split remote', status: 'idle', lastActiveAt: 100 }] }] });
      }
      if (url === `https://split-connector.example/api/connector/v1/sessions/${encodeURIComponent(remoteSessionKey)}/messages` && init?.method !== 'POST') {
        return Response.json({ messages: [{ id: 'split-message-1', sessionKey: remoteSessionKey, role: 'assistant', text: 'split hello', createdAt: 101, media: [{ type: 'image', url: '/api/media/inbound/split.png', name: 'split.png', mimeType: 'image/png' }] }] });
      }
      if (url === `https://split-connector.example/api/connector/v1/sessions/${encodeURIComponent(remoteSessionKey)}/messages` && init?.method === 'POST') {
        const payload = JSON.parse(String(init.body));
        assert.equal(payload.message, 'send in split');
        assert.match(payload.idempotencyKey, /^cmd_[0-9a-f-]{36}$/);
        assert.equal(payload.idempotencyKey, headers.get('idempotency-key'));
        return Response.json({ ok: true, runId: 'split-run-1', status: 'started', idempotencyKey: 'split-key-1', media: [] });
      }
      if (url === 'https://split-connector.example/api/connector/v1/media/inbound/split.png') {
        return new Response(Buffer.from('split-media'), { headers: { 'content-type': 'image/png', 'x-secret': 'split-secret-token' } });
      }
      return Response.json({ error: `unexpected ${url}` }, { status: 500 });
    }) as typeof fetch;

    const info = await fixture.app.request('/api/hub/v1/info');
    assert.equal((await info.json() as any).mode, 'split-hub-http-connector');

    const state = await fixture.app.request('/api/hub/v1/sessions/state');
    const stateBody = await state.json() as any;
    assert.equal(state.status, 200);
    assert.deepEqual(stateBody.connections.map((connection: any) => [connection.id, connection.kind, connection.connectorUrl, connection.hasCredential]), [[
      'local',
      'remote',
      'https://split-connector.example',
      true,
    ]]);
    assert.deepEqual(stateBody.groups[0].sessions.map((session: any) => session.sessionKey), [hubSessionId]);
    assert.equal(JSON.stringify(stateBody).includes('split-secret-token'), false);
    assert.equal(JSON.stringify(stateBody).includes('should-not-appear'), false);

    const messages = await fixture.app.request(`/api/hub/v1/sessions/${hubSessionId}/messages`);
    const messagesBody = await messages.json() as any;
    assert.equal(messages.status, 200);
    assert.equal(messagesBody.messages[0].sessionKey, hubSessionId);
    assert.equal(messagesBody.messages[0].media[0].url, `/api/hub/v1/sessions/${encodeURIComponent(hubSessionId)}/messages/split-message-1/media/${mediaResourceId('/api/media/inbound/split.png')}`);

    const send = await fixture.app.request(`/api/hub/v1/sessions/${hubSessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'send in split', idempotencyKey: 'split-key-1' }),
    });
    const sent = await send.json() as any;
    assert.equal(sent.command.state, 'accepted');
    const { command: _, ...result } = sent;
    assert.deepEqual(result, { ok: true, runId: 'split-run-1', status: 'started', idempotencyKey: 'split-key-1', media: [] });

    const media = await fixture.app.request('/api/hub/v1/connections/local/media/inbound/split.png');
    assert.equal(media.status, 200);
    assert.equal(media.headers.get('content-type'), 'image/png');
    assert.equal(media.headers.get('x-secret'), null);
    assert.deepEqual(Buffer.from(await media.arrayBuffer()), Buffer.from('split-media'));

    assert.deepEqual(seen.map((request) => request.url), [
      'https://split-connector.example/api/connector/v1/sessions/state?includeHidden=1&includeArchived=1',
      `https://split-connector.example/api/connector/v1/sessions/${encodeURIComponent(remoteSessionKey)}/messages`,
      `https://split-connector.example/api/connector/v1/sessions/${encodeURIComponent(remoteSessionKey)}/messages`,
      'https://split-connector.example/api/connector/v1/media/inbound/split.png',
    ]);
    assert.equal(seen.every((request) => request.authorization === 'Bearer split-secret-token'), true);
  } finally {
    globalThis.fetch = originalFetch;
    await fixture.cleanup();
  }
});

test('hub remote message routes propagate connector errors without leaking bearer token', async () => {
  const fixture = createHubFixture();
  const originalFetch = globalThis.fetch;
  const secret = 'remote-error-secret';
  const remoteSessionKey = 'agent:remote-dev:dashboard:remote-error';
  const hubSessionId = encodeHubSessionId('remote-error', remoteSessionKey);
  try {
    fixture.hubStore.upsertConnection({
      id: 'remote-error',
      kind: 'remote',
      label: 'Remote Error',
      connectorUrl: 'https://remote-error.example',
      status: 'enabled',
      capabilities: ['messages'],
      credentialToken: secret,
    });
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(new Headers(_input instanceof Request ? _input.headers : init?.headers).get('authorization'), `Bearer ${secret}`);
      return Response.json({ error: 'missing messages:read scope' }, { status: 403 });
    }) as typeof fetch;

    const res = await fixture.app.request(`/api/hub/v1/sessions/${hubSessionId}/messages`);
    const body = await res.json() as any;

    assert.equal(res.status, 403);
    assert.equal(body.error, 'Connector request failed: HTTP 403');
    assert.equal(body.status, 403);
    assert.equal(JSON.stringify(body).includes(secret), false);
  } finally {
    globalThis.fetch = originalFetch;
    await fixture.cleanup();
  }
});

async function readHubSseEvents(app: Hono, path: string, count: number, accept: (event: any) => boolean = () => true) {
  const controller = new AbortController();
  const response = await app.request(path, { signal: controller.signal } as RequestInit);
  assert.equal(response.status, 200);
  assert.ok(response.body);
  const reader = response.body.getReader();
  const events: any[] = [];
  let buffer = '';
  // Include a cold readonly worker's startup under the concurrent matrix.
  // This is a bounded functional replay assertion, not a one-second benchmark.
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    while (events.length < count) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += new TextDecoder().decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const parsed = parseHubSseFrame(raw);
        if (parsed && accept(parsed)) events.push(parsed);
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    clearTimeout(timeout);
    controller.abort();
    await reader.cancel().catch(() => undefined);
  }
  assert.equal(events.length, count);
  return events;
}

async function openHubSseBriefly(app: Hono, path: string, upstreamStarted: Promise<void>) {
  const controller = new AbortController();
  const response = await app.request(path, { signal: controller.signal } as RequestInit);
  assert.equal(response.status, 200);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Admission no longer synchronously starts the transport. Wait for the
    // actual original fetch, not an arbitrary 25ms worker-startup guess.
    await Promise.race([upstreamStarted, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Error('Original upstream did not start')), 5_000);
    })]);
  } finally {
    clearTimeout(timer); controller.abort();
    await response.body?.cancel().catch(() => undefined);
  }
}

function parseHubSseFrame(raw: string) {
  const data = raw.split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''))
    .join('\n');
  return data ? JSON.parse(data) : undefined;
}

function sseResponse(event: { id: string; event: string; data: unknown }) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`id: ${event.id}\nevent: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`));
      controller.close();
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
}

test('Codex-only custom local connection is enabled without an OpenClaw gateway', async () => {
  const fixture = createHubFixture({ AOD_CODEX_ENABLED: 'true', AOD_LOCAL_OPENCLAW_CLI: 'false', AOD_HUB_LOCAL_CONNECTION_ID: 'parallel-codex' });
  try {
    const response = await fixture.app.request('/api/hub/v1/connections');
    const body = await response.json();
    const connection = body.connections.find((item: { id: string }) => item.id === 'parallel-codex');
    assert.equal(connection.kind, 'local');
    assert.equal(connection.status, 'enabled');
    assert.equal(connection.identityStatus, 'unverified');
  } finally { await fixture.cleanup(); }
});

test('SDK interaction advertisement requires both the installed bridge and current native readiness', async () => {
  for (const installed of [false, true]) for (const enabled of [false, true]) {
    const f = createHubFixture({}, undefined, enabled, installed);
    try {
      for (const ready of [true, false, true]) {
        f.sdkReadiness.claude.ready = ready;
        f.sdkReadiness.copilot.ready = ready;
        const response = await f.connectorCapabilities();
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.features.interactions, installed, 'route availability is independent of SDK readiness');
        for (const agent of ['claude-code', 'ghcp']) {
          assert.equal(body.runtimes[agent].features.interactions, installed && enabled && ready, agent);
        }
        assert.equal(body.runtimes.hermes.features.interactions, false);
      }
    } finally { await f.cleanup(); }
  }
});

for (const action of ['patch-replaced', 'maintenance-replaced', 'patch-renamed', 'post-revoked', 'patch-display'] as const)
  test(`Connection mutation R86 preserves original authority and current labels: ${action}`, async t => {
    let actor: HubPrincipal | undefined = { userId: 'default', admin: false };
    const f = createHubFixture({}, undefined, false, false, () => actor);
    const rows: any[] = [], diagnostics = new PerformanceDiagnostics(line => rows.push(JSON.parse(line)));
    t.mock.method(performanceDiagnostics, 'start', (...args: Parameters<typeof performanceDiagnostics.start>) => diagnostics.start(...args));
    f.hubStore.upsertConnection({ id: 'r86', kind: 'remote', label: 'Original', connectorUrl: 'https://original.invalid', status: 'enabled' });
    let effects = 0, finish!: () => void, closed = false;
    const update = f.hubStore.upsertConnection.bind(f.hubStore), rename = f.hubStore.renameConnection.bind(f.hubStore);
    const maintenance = f.hubStore.updateMaintenanceCredential.bind(f.hubStore);
    t.mock.method(f.hubStore, 'upsertConnection', (...args: Parameters<HubStore['upsertConnection']>) => { effects++; return update(...args); });
    t.mock.method(f.hubStore, 'renameConnection', (...args: Parameters<HubStore['renameConnection']>) => { effects++; return rename(...args); });
    t.mock.method(f.hubStore, 'updateMaintenanceCredential', (...args: Parameters<HubStore['updateMaintenanceCredential']>) => { effects++; return maintenance(...args); });
    const json = action.startsWith('maintenance') ? { token: 'PRIVATE token' }
      : action.startsWith('post') ? { label: 'PRIVATE label', connectorUrl: 'https://new.invalid' }
      : { enabled: false };
    const text = JSON.stringify(json), body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(text.slice(0, 1)));
      finish = () => { if (closed) return; closed = true; controller.enqueue(new TextEncoder().encode(text.slice(1))); controller.close(); };
    } });
    const path = action.startsWith('post') ? '/api/hub/v1/connections'
      : '/api/hub/v1/connections/r86' + (action.startsWith('maintenance') ? '/maintenance-credential' : '');
    const pending = f.app.fetch(new Request('http://fixture.invalid' + path, {
      method: action.startsWith('post') ? 'POST' : action.startsWith('maintenance') ? 'PUT' : 'PATCH', body, duplex: 'half',
    } as RequestInit));
    try {
      await new Promise(resolve => setImmediate(resolve));
      if (action.endsWith('replaced')) update({ id: 'r86', kind: 'remote', label: 'Replacement', connectorUrl: 'https://replacement.invalid', status: 'enabled' });
      if (action === 'patch-renamed') rename('r86', { label: 'Latest label', environmentLabel: 'Latest environment' });
      if (action === 'post-revoked') actor = undefined;
      if (action === 'patch-display') {
        t.mock.method(f.hubStore, 'listUsers', () => { throw Error('PRIVATE synchronous directory must not run'); });
        t.mock.method(f.hubStore, 'listUsersAsync', async (owner: string, admin: boolean) => {
          assert.equal(owner, 'default'); assert.equal(admin, false); return [{ id: 'default', label: 'Default', createdAt: 1, updatedAt: 2 }];
        });
      }
      finish(); const response = await pending;
      assert.equal(response.status, action.endsWith('replaced') ? 409 : action === 'post-revoked' ? 401 : 200);
      assert.equal(effects, action.endsWith('replaced') || action === 'post-revoked' ? 0 : 1);
      const current = f.hubStore.getConnection('r86')!;
      if (action.endsWith('replaced')) {
        assert.equal(current.connectorUrl, 'https://replacement.invalid'); assert.equal(current.status, 'enabled');
        assert.equal(f.hubStore.getMaintenanceCredentialToken('r86'), undefined);
      }
      if (action === 'patch-renamed') { assert.equal(current.label, 'Latest label'); assert.equal(current.environmentLabel, 'Latest environment'); }
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      assert.doesNotMatch(await response.text(), /PRIVATE/);
      const events = rows.filter(row => row.operation === 'hub-connection-mutation' && row.phase === 'finished');
      assert.equal(events.length, 1);
      if (action.endsWith('replaced') || action === 'post-revoked') {
        assert.equal(events[0].admitted, undefined); assert.equal(events[0].unknown, undefined);
      } else { assert.equal(events[0].settled, 1); assert.equal(events[0].step, 6); }
      assert.doesNotMatch(JSON.stringify(events), /PRIVATE|replacement.invalid|Latest label/);
    } finally { finish?.(); await pending; await f.cleanup(); }
  });

function createHubFixture(env: NodeJS.ProcessEnv = {}, hermesFactory?: (event: (event: HermesEvent) => void, lost: () => void) => HermesTransport, fileRuntimes = false, withInteractions = false, principal?: () => HubPrincipal | undefined) {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-hub-test-'));
  const config = loadConfig({
    ...env,
    AOD_HUB_DATABASE_FILE: join(dir, 'hub.sqlite'),
    AOD_HUB_VAULT_SECRET: 'test-vault-secret',
    AOD_SESSION_TITLES_FILE: join(dir, 'titles.json'),
    AOD_CONNECTOR_USERS_DATABASE_FILE: join(dir, 'connector-users.sqlite'),
    AOD_CONNECTOR_ENV_ID: 'local-env',
    AOD_CONNECTOR_ENV_LABEL: 'Local Env',
  } as NodeJS.ProcessEnv);
  const app = new Hono();
  const hubStore = new HubStore(config.hub.databaseFile, config.hub.vaultSecret);
  const connectorUsers = new ConnectorUserStore(config.connector.usersDatabaseFile, undefined, { runtimeOwner: withInteractions });
  const interactions = withInteractions ? new InteractionRuntime(connectorUsers.interactions, () => true) : undefined;
  const store = new DeckStore({ sessionTitlesFile: config.sessionTitlesFile, sessionThinkingOverridesFile: config.sessionThinkingOverridesFile });
  const gateway: { request: (...args: any[]) => Promise<any>; requestBound: (...args: any[]) => Promise<any> } = {
    request: async () => ({ runId: 'test-run', status: 'started' }),
    requestBound: async (...args) => { args[3]?.(); return { payload: await gateway.request(...args), connectionId: 'synthetic-connection' }; },
  };
  const codex = {
    interactionReady: withInteractions,
    owns: (_sessionKey: string) => false,
    refreshSessions: async () => undefined,
    interrupt: async (_sessionKey: string, _expectedRunId: string, _actorId: string): Promise<void> => undefined,
    send: async (_sessionKey: string, _message: string) => ({ runId: 'codex-run', status: 'started' }),
  };
  const connectorApp = new Hono();
  const tokens = new ConnectorTokenStore(join(dir, 'tokens.json'));
  const credential = tokens.createTransient(undefined, 'interaction-owner');
  const hermes = hermesFactory ? new HermesRuntime({ config: { enabled: true, executable: '/fixture/python', sourceDirectory: '/fixture/source',
    homeDirectory: '/fixture/home', workspace: '/fixture/workspace', startupTimeoutMs: 1000 },
    journal: connectorUsers.hermesJournal, turns: connectorUsers.turns, store, authorize: () => true }, hermesFactory) : undefined;
  const queue = new OpenClawTurnQueue({ authorizeTurn: () => true, turns: connectorUsers.turns, executions: connectorUsers.openClawExecutions, store,
    refreshSessions: async () => undefined, refreshMessages: async () => undefined, mirror: async () => undefined,
    send: createOpenClawDispatch({ authorizeTurn: () => true, executions: connectorUsers.openClawExecutions, gateway: gateway as any, store, allowCliFallback: false, message: (text) => text }) });
  const sdkReadiness = { claude: { ready: true }, copilot: { ready: true } };
  const connectorRoutes = registerConnectorRoutes(connectorApp, {
    sessionSnapshotReady: () => true, historySnapshotReady: () => true,
    config, tokens, connectorUsers, store, gateway: gateway as any, codex: codex as any, openclawQueue: queue, ...(hermes ? { hermes } : {}),
    ...(interactions ? { interactions } : {}),
    // File-index reads/rebuilds must not touch a native runtime method.
    ...(fileRuntimes ? { claude: sdkReadiness.claude as any, copilot: sdkReadiness.copilot as any } : {}),
    refreshSessions: async () => undefined, refreshMessages: async () => undefined,
    fallbackAgents: () => [], isAuthorizedRequest: () => false,
    normalizeError: (error) => error instanceof Error ? error.message : String(error),
  });
  let interactionResponseTransform: ((response: Response) => Promise<Response>) | undefined;
  let tokenResponseTransform: ((response: Response) => Promise<Response>) | undefined;
  let capabilityResponseTransform: ((response: Response) => Promise<Response>) | undefined;
  const connectorClient = createConnectorClientResolver(hubStore, { connectionId: config.hub.defaultConnectionId, token: credential.token, dispatch: async request => {
    const response = await connectorApp.fetch(request);
    if (capabilityResponseTransform && new URL(request.url).pathname.endsWith('/capabilities')) return capabilityResponseTransform(response);
    if (tokenResponseTransform && new URL(request.url).pathname.includes('/token-usage')) return tokenResponseTransform(response);
    return interactionResponseTransform && new URL(request.url).pathname.includes('/interactions')
      ? interactionResponseTransform(response) : response;
  } });
  const hub = registerHubRoutes(app, {
    ...(principal ? { principal } : {}),
    connectorClient,
    config,
    hubStore,
    normalizeError: (error) => error instanceof Error ? error.message : String(error),
  });
  return {
    app,
    hubStore,
    connectorUsers,
    interactions,
    sdkReadiness,
    connectorCapabilities: () => connectorApp.request('/api/connector/v1/capabilities', { headers: { authorization: `Bearer ${credential.token}` } }),
    transformInteractionResponse: (transform: typeof interactionResponseTransform) => { interactionResponseTransform = transform; },
    transformTokenResponse: (transform: typeof tokenResponseTransform) => { tokenResponseTransform = transform; },
    transformCapabilityResponse: (transform: typeof capabilityResponseTransform) => { capabilityResponseTransform = transform; },
    store,
    gateway,
    codex,
    hermes,
    queue,
    seedCursor: (cursor: string) => {
      hubStore.appendDelivery({ envConnectionId: config.hub.defaultConnectionId, remoteEventId: cursor, type: 'session.updated', ts: Date.now(), payload: {} }, connectorClient(config.hub.defaultConnectionId).eventDomain, cursor);
      return hubStore.latestDeliveryCursor()!;
    },
    cleanup: async () => {
      await hub?.close();
      connectorRoutes.close();
      interactions?.close();
      await hermes?.close();
      await queue.close();
      await hubStore.close();
      await connectorUsers.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('local connection probe uses scoped async users, preserves wire shape and never scans synchronous users', async t => {
  const f = createHubFixture(); t.after(() => f.cleanup());
  const original = f.hubStore.listUsersAsync.bind(f.hubStore); const scopes: unknown[] = [];
  t.mock.method(f.hubStore, 'listUsers', () => { throw Error('synchronous full scan forbidden'); });
  t.mock.method(f.hubStore, 'listUsersAsync', async (owner: string, admin: boolean) => {
    scopes.push([owner, admin]); return original(owner, admin);
  });
  const response = await f.app.request('/api/hub/v1/connections/test', { method: 'POST', body: '{}' });
  assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const body = await response.json() as any;
  assert.deepEqual(Object.keys(body).sort(), ['connection', 'connector', 'ok', 'updatedAt']);
  assert.equal(body.ok, true); assert.ok(body.connector); assert.ok(body.connection);
  assert.deepEqual(scopes, [['default', true]]);
});

for (const change of ['revoked', 'member', 'owner', 'revoked-sql', 'sql', 'renamed', 'deleted', 'rotated', 'aborted'] as const)
  test(`local connection probe ${change} during async metadata read cannot dispatch capabilities or publish stale success`, async t => {
    let actor: HubPrincipal | undefined = { userId: 'default', admin: true };
    const f = createHubFixture({}, undefined, false, false, () => actor); t.after(() => f.cleanup());
    const original = f.hubStore.listUsersAsync.bind(f.hubStore), connections = f.hubStore.listConnections();
    let release!: () => void, dispatches = 0;
    t.mock.method(f.hubStore, 'listUsers', () => { throw Error('synchronous full scan forbidden'); });
    t.mock.method(f.hubStore, 'listUsersAsync', async (owner: string, admin: boolean) => {
      const rows = await original(owner, admin);
      await new Promise<void>(resolve => { release = resolve; });
      if (change.endsWith('sql')) throw Error('PRIVATE SQL');
      return rows;
    });
    f.transformCapabilityResponse(async response => { dispatches++; return response; });
    const abort = new AbortController();
    const pending = Promise.resolve(f.app.fetch(new Request('http://hub/api/hub/v1/connections/test', {
      method: 'POST', body: '{}', signal: abort.signal,
    })));
    while (!release) await new Promise(resolve => setImmediate(resolve));
    const id = connections[0]!.id;
    if (change === 'revoked' || change === 'revoked-sql') actor = undefined;
    if (change === 'member') actor!.admin = false;
    if (change === 'owner') actor = { userId: 'other', admin: true };
    if (change === 'renamed') (f.hubStore as unknown as { db: DatabaseSync }).db.prepare('UPDATE env_connections SET label=? WHERE id=?').run('PRIVATE new label', id);
    if (change === 'deleted') {
      // The public API deliberately refuses deletion of the local connection.
      // Simulate an out-of-band directory mutation in this isolated fixture.
      assert.equal(f.hubStore.deleteConnection(id), false);
      (f.hubStore as unknown as { db: DatabaseSync }).db.prepare('UPDATE env_connections SET deleted_at=? WHERE id=?').run(Date.now(), id);
    }
    if (change === 'rotated') f.hubStore.upsertConnection({ id, label: connections[0]!.label, connectorUrl: connections[0]!.connectorUrl, credentialToken: 'synthetic-new' });
    if (change === 'aborted') abort.abort();
    release(); const response = await pending;
    assert.equal(response.status, ['revoked', 'revoked-sql', 'member', 'owner'].includes(change) ? 401 : change === 'sql' ? 502 : change === 'aborted' ? 499 : 503);
    assert.doesNotMatch(await response.text(), /PRIVATE|"ok":true/); assert.equal(dispatches, 0);
  });

for (const change of ['revoked', 'member', 'renamed', 'rotated', 'aborted'] as const)
  test(`local connection probe fences ${change} after original capability response without redispatch`, async t => {
    let actor: HubPrincipal | undefined = { userId: 'default', admin: true };
    const f = createHubFixture({}, undefined, false, false, () => actor); t.after(() => f.cleanup());
    let release!: () => void, dispatches = 0;
    f.transformCapabilityResponse(async response => {
      dispatches++; await new Promise<void>(resolve => { release = resolve; }); return response;
    });
    const abort = new AbortController(), pending = Promise.resolve(f.app.fetch(new Request('http://hub/api/hub/v1/connections/test', {
      method: 'POST', body: '{}', signal: abort.signal,
    })));
    while (!release) await new Promise(resolve => setImmediate(resolve));
    const connection = f.hubStore.listConnections()[0]!;
    if (change === 'revoked') actor = undefined;
    if (change === 'member') actor!.admin = false;
    if (change === 'renamed') (f.hubStore as unknown as { db: DatabaseSync }).db.prepare('UPDATE env_connections SET label=? WHERE id=?').run('PRIVATE new', connection.id);
    if (change === 'rotated') f.hubStore.upsertConnection({ id: connection.id, label: connection.label, connectorUrl: connection.connectorUrl, credentialToken: 'synthetic-new' });
    if (change === 'aborted') abort.abort();
    release(); const response = await pending;
    assert.equal(response.status, ['revoked', 'member'].includes(change) ? 401 : change === 'rotated' ? 403 : change === 'aborted' ? 502 : 503);
    assert.doesNotMatch(await response.text(), /PRIVATE|"ok":true/); assert.equal(dispatches, 1);
  });
