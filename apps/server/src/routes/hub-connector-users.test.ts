import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { ConnectorClientError, type ConnectorClientResolver } from '../hub/connector-client.js';
import type { HubConnection, HubUser } from '../hub/hub-store.js';
import type { HubPrincipal } from '../hub/identity.js';
import { registerHubConnectorUserDisplay } from './hub-connector-users.js';
import type { ConnectorResponseCollector } from '../hub/response-budget.js';

function fixture(count = 1, responseLimits?: { requestBytes: number; retainedBytes: number }) {
  let actor: HubPrincipal | undefined = { userId: 'default', admin: true };
  const signal = new AbortController(), rows: Record<string, any>[] = [];
  const connections: HubConnection[] = Array.from({ length: count }, (_, index) => ({
    id: `node-${index}`, ownerUserId: 'default', kind: 'remote', label: 'PRIVATE connection',
    connectorUrl: 'https://synthetic.invalid', status: 'enabled', capabilities: [],
    hasCredential: true, createdAt: 1, updatedAt: 1,
  }));
  const versions = new Map(connections.map(row => [row.id, 1]));
  let requestSignal: AbortSignal;
  const calls: string[] = [], scopes: [string, boolean][] = [];
  const waiting = new Map<string, { resolve: (value: any) => void; reject: (error: unknown) => void }>();
  let active = 0, maxActive = 0, directoryReads = 0, presentations = 0;
  let beforePresent = () => {};
  let directoryVersion = 0, directoryState = '';
  let readConnections = async () => connections.map(row => ({ ...row }));
  let readUsers: () => Promise<HubUser[]> = async () => [{ id: 'default', label: 'PRIVATE owner', createdAt: 1, updatedAt: 1 }];
  const app = new Hono();
  registerHubConnectorUserDisplay(app, {
    store: {
      listUsersAsync: async (owner, admin) => { scopes.push([owner, admin]); return readUsers(); },
      listConnectionsAsync: async owner => { assert.equal(owner, 'default'); directoryReads++; return readConnections(); },
      connectionDirectoryVersion: owner => {
        assert.equal(owner, 'default');
        const next = JSON.stringify(connections);
        if (next !== directoryState) { directoryVersion++; directoryState = next; }
        return directoryVersion;
      },
      connectionAuthority: (id, owner) => { assert.equal(owner, 'default'); return versions.get(id); },
    },
    principal: () => { if (!actor) throw new HTTPException(401); return actor; },
    client: ((id: string, _maintenance: boolean, owner: string) => ({ json: async (path: string, init: RequestInit, collector?: ConnectorResponseCollector) => {
      assert.equal(path, '/users'); assert.equal(owner, 'default'); assert.equal(init.signal, requestSignal);
      calls.push(id); active++; maxActive = Math.max(maxActive, active);
      try {
        const value = await new Promise((resolve, reject) => waiting.set(id, { resolve, reject }));
        collector?.consume(Buffer.byteLength(JSON.stringify(value)));
        return value;
      }
      finally { active--; }
    } })) as unknown as ConnectorClientResolver,
    present: (connection, users, supported, remoteUsers, error) => {
      presentations++;
      beforePresent();
      return { id: connection.id, ownerUserLabel: users.find(row => row.id === connection.ownerUserId)?.label,
        supported, users: remoteUsers, userCount: remoteUsers.length, ...(error ? { error } : {}) };
    },
    diagnostics: new PerformanceDiagnostics(line => rows.push(JSON.parse(line)), () => 0),
    ...(responseLimits ? { responseLimits } : {}),
  });
  const request = (controller = signal) => {
    const raw = new Request('http://hub/api/hub/v1/connector-users', { signal: controller.signal });
    requestSignal = raw.signal;
    return Promise.resolve(app.fetch(raw));
  };
  const release = (id: string, value: any = { users: [{ id: 'remote', label: 'PRIVATE remote' }] }) => {
    const original = waiting.get(id); assert.ok(original); waiting.delete(id); original.resolve(value);
  };
  const reject = (id: string, error: unknown) => {
    const original = waiting.get(id); assert.ok(original); waiting.delete(id); original.reject(error);
  };
  return { request, signal, rows, connections, versions, calls, scopes, waiting, release, reject,
    actor: () => actor, setActor: (next: HubPrincipal | undefined) => { actor = next; },
    users: (next: typeof readUsers) => { readUsers = next; },
    directory: (next: typeof readConnections) => { readConnections = next; },
    beforePresent: (next: typeof beforePresent) => { beforePresent = next; },
    state: () => ({ active, maxActive, directoryReads, presentations }) };
}

function finished(f: ReturnType<typeof fixture>, success: boolean, step?: number) {
  const events = f.rows.filter(row => row.operation === 'hub-connector-users-read' && row.phase === 'finished');
  assert.equal(events.length, 1);
  if (step !== undefined) assert.equal(events[0]!.step, step);
  assert.equal(events[0]!.deferred, success ? undefined : 1);
  assert.equal(events[0]!.settled, undefined); assert.equal(events[0]!.unknown, undefined);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE|synthetic|node-|version-|default/);
}

for (const change of ['revoked', 'member', 'other', 'mutated-object', 'aborted', 'sql-failed', 'revoked-sql-failed'] as const)
  test(`connector user display fences ${change} after awaited users before any fan-in`, async () => {
    const f = fixture();
    let release!: () => void;
    f.users(async () => { await new Promise<void>(resolve => { release = resolve; });
      if (change.endsWith('sql-failed')) throw Error('PRIVATE SQL');
      return [{ id: 'default', label: 'PRIVATE owner', createdAt: 1, updatedAt: 1 }]; });
    const pending = f.request(); await turn();
    if (change === 'revoked' || change === 'revoked-sql-failed') f.setActor(undefined);
    if (change === 'member') f.setActor({ userId: 'default', admin: false });
    if (change === 'other') f.setActor({ userId: 'other', admin: true });
    if (change === 'mutated-object') f.actor()!.admin = false;
    if (change === 'aborted') f.signal.abort();
    release(); const response = await pending;
    assert.equal(response.status, ['aborted', 'sql-failed'].includes(change) ? 503 : 401);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.doesNotMatch(await response.text(), /PRIVATE|connections/);
    assert.deepEqual(f.calls, []); assert.equal(f.state().directoryReads, 0);
    assert.deepEqual(f.scopes, [['default', true]]); finished(f, false, 1);
  });

for (const change of ['revoked', 'member', 'other', 'mutated-object', 'aborted', 'credential', 'removed', 'disabled', 'added'] as const)
  test(`connector users ${change} during original fan-in never publishes stale rows or retries`, async () => {
    const f = fixture(6), pending = f.request(); await turn();
    assert.equal(f.calls.length, 4);
    if (change === 'revoked') f.setActor(undefined);
    if (change === 'member') f.setActor({ userId: 'default', admin: false });
    if (change === 'other') f.setActor({ userId: 'other', admin: true });
    if (change === 'mutated-object') f.actor()!.admin = false;
    if (change === 'aborted') f.signal.abort();
    if (change === 'credential') f.versions.set('node-0', 2);
    if (change === 'removed') { f.connections.splice(0, 1); f.versions.delete('node-0'); }
    if (change === 'disabled') { f.connections[0]!.status = 'disabled'; f.versions.set('node-0', 2); }
    if (change === 'added') { f.connections.push({ ...f.connections[0]!, id: 'added' }); f.versions.set('added', 1); }
    // Let the first lane observe the refusal before releasing other originals.
    f.release('node-0'); await turn();
    while (f.waiting.size) { for (const id of [...f.waiting.keys()]) f.release(id); await turn(); }
    const response = await pending;
    assert.equal(response.status, ['revoked', 'member', 'other', 'mutated-object'].includes(change) ? 401 : 503);
    assert.doesNotMatch(await response.text(), /PRIVATE|connections/);
    assert.equal(f.state().presentations, 0); assert.equal(f.state().active, 0);
    assert.equal(new Set(f.calls).size, f.calls.length, 'each original read occurs once');
    if (change !== 'added') assert.equal(f.calls.length, 4, 'no new dispatch after a refusal');
    finished(f, false);
  });

test('large connector directory has four original reads at most, ordered rows, one scoped user query and no changed wire fields', async () => {
  const f = fixture(11), pending = f.request(); await turn();
  assert.equal(f.state().maxActive, 4);
  while (f.waiting.size) {
    for (const id of [...f.waiting.keys()].reverse()) f.release(id);
    await turn();
  }
  const response = await pending, body = await response.json() as any;
  assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(Object.keys(body).sort(), ['connections', 'updatedAt']);
  assert.deepEqual(body.connections.map((row: any) => row.id), f.connections.map(row => row.id));
  assert.ok(body.connections.every((row: any) => row.supported && row.userCount === 1 && row.ownerUserLabel === 'PRIVATE owner'));
  assert.equal(f.state().maxActive, 4); assert.equal(f.calls.length, 11);
  assert.deepEqual(f.scopes, [['default', true]]); finished(f, true, 5);
  assert.equal(f.state().directoryReads, 1, 'one awaited snapshot, no synchronous rescan at delivery');
});

test('disabled connectors are skipped after users settle, without remote dispatch', async () => {
  const f = fixture(2); let release!: () => void;
  f.users(async () => { await new Promise<void>(resolve => { release = resolve; }); return []; });
  const pending = f.request(); await turn();
  f.connections.forEach(row => { row.status = 'disabled'; }); release();
  const response = await pending, body = await response.json() as any;
  assert.equal(response.status, 200); assert.deepEqual(body.connections, []); assert.deepEqual(f.calls, []);
  finished(f, true, 5);
});

for (const mode of ['private-failure', 'invalid-response', 'known-failure'] as const)
  test(`remote ${mode} preserves supported=false compatibility without replay or private exception`, async () => {
    const f = fixture(), pending = f.request(); await turn();
    if (mode === 'invalid-response') f.release('node-0', { users: 'PRIVATE invalid' });
    else f.reject('node-0', mode === 'known-failure' ? new ConnectorClientError(403, 'Connector request failed: HTTP 403') : Error('PRIVATE remote failure'));
    const response = await pending, body = await response.json() as any;
    assert.equal(response.status, 200); assert.equal(body.connections[0].supported, false);
    assert.deepEqual(body.connections[0].users, []); assert.equal(body.connections[0].userCount, 0);
    assert.doesNotMatch(body.connections[0].error, /PRIVATE/); assert.equal(f.calls.length, 1);
    finished(f, true, 5);
  });

for (const change of ['actor', 'directory', 'aborted', 'throwing'] as const)
  test(`connector users ${change} during serialization cannot publish an obsolete successful response`, async () => {
    const f = fixture(), pending = f.request(); await turn();
    f.beforePresent(() => {
      if (change === 'actor') f.actor()!.admin = false;
      if (change === 'directory') f.versions.set('node-0', 2);
      if (change === 'aborted') f.signal.abort();
      if (change === 'throwing') throw Error('PRIVATE serialization');
    });
    f.release('node-0'); const response = await pending;
    assert.equal(response.status, change === 'actor' ? 401 : 503);
    assert.doesNotMatch(await response.text(), /PRIVATE|connections/);
    assert.equal(f.calls.length, 1); finished(f, false, 4);
  });

test('connector without an authority version is refused before original remote dispatch', async () => {
  const f = fixture(); f.versions.delete('node-0');
  const response = await f.request();
  assert.equal(response.status, 503); assert.deepEqual(f.calls, []);
  assert.equal(f.state().presentations, 0); finished(f, false, 2);
});

test('refused lane waits for the remaining original reads instead of pretending to settle them', async () => {
  const f = fixture(6), pending = f.request(); let completed = false;
  void pending.then(() => { completed = true; }); await turn();
  f.versions.set('node-0', 2); f.release('node-0'); await turn();
  assert.equal(completed, false); assert.equal(f.state().active, 3);
  assert.equal(f.rows.filter(row => row.phase === 'finished').length, 0);
  assert.equal(f.calls.length, 4);
  for (const id of [...f.waiting.keys()]) f.release(id);
  assert.equal((await pending).status, 503); finished(f, false, 2);
});

for (const change of ['revoked', 'member', 'owner', 'aborted', 'sql', 'renamed', 'added', 'removed', 'recreated'] as const)
  test(`awaited connector directory fences ${change} before dispatch without synchronous fallback`, async () => {
    const f = fixture(); let release!: () => void;
    f.directory(async () => {
      const snapshot = f.connections.map(row => ({ ...row }));
      await new Promise<void>(resolve => { release = resolve; });
      if (change === 'sql') throw Error('PRIVATE SQL directory');
      return snapshot;
    });
    const pending = f.request(); await turn();
    if (change === 'revoked') f.setActor(undefined);
    if (change === 'member') f.actor()!.admin = false;
    if (change === 'owner') f.setActor({ userId: 'other', admin: true });
    if (change === 'aborted') f.signal.abort();
    if (change === 'renamed') f.connections[0]!.label = 'PRIVATE new';
    if (change === 'added') f.connections.push({ ...f.connections[0]!, id: 'new' });
    if (change === 'removed') f.connections.length = 0;
    if (change === 'recreated') f.connections[0]!.createdAt++;
    release(); const response = await pending;
    assert.equal(response.status, ['revoked', 'member', 'owner'].includes(change) ? 401 : 503);
    assert.doesNotMatch(await response.text(), /PRIVATE|connections/);
    assert.deepEqual(f.calls, []); assert.equal(f.state().directoryReads, 1);
    finished(f, false, 1);
  });

test('directory display-only mutation during fan-in is refused even when original node authority stays unchanged', async () => {
  const f = fixture(), pending = f.request(); await turn();
  f.connections[0]!.label = 'PRIVATE renamed'; f.release('node-0');
  assert.equal((await pending).status, 503); assert.equal(f.versions.get('node-0'), 1);
  finished(f, false, 2);
});

test('eight original reads retain admission after abort until settlement, then a fresh GET can recover', async () => {
  const f = fixture(); const releases: (() => void)[] = [];
  f.users(async () => { await new Promise<void>(resolve => releases.push(resolve)); return []; });
  const pending = Array.from({ length: 8 }, () => f.request()); await turn();
  f.signal.abort();
  assert.equal((await f.request(new AbortController())).status, 503);
  assert.equal(f.scopes.length, 8, 'refused ninth request starts no SQL read');
  assert.equal(f.rows.filter(row => row.phase === 'finished').length, 1, 'aborted originals still pending');
  releases.forEach(release => release());
  assert.ok((await Promise.all(pending)).every(response => response.status === 503));
  f.connections.forEach(row => { row.status = 'disabled'; }); f.users(async () => []);
  assert.equal((await f.request(new AbortController())).status, 200);
  assert.deepEqual(f.calls, []);
});

test('response budget refusal stops fresh lanes, waits originals and never turns into partial supported=false success', async () => {
  const f = fixture(9, { requestBytes: 100, retainedBytes: 200 }), pending = f.request();
  let settled = false; void pending.then(() => { settled = true; }); await turn();
  assert.equal(f.calls.length, 4);
  f.release('node-0', { users: ['PRIVATE'.repeat(100)] }); await turn();
  assert.equal(settled, false); assert.equal(f.calls.length, 4);
  assert.equal(f.state().active, 3);
  for (const id of [...f.waiting.keys()]) f.release(id, { users: [] });
  const response = await pending;
  assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /PRIVATE|connections/);
  finished(f, false, 2);
  f.connections.forEach(row => { row.status = 'disabled'; });
  assert.equal((await f.request()).status, 200, 'fresh GET recovers after original settlement');
});

test('aggregate transport-byte limit covers all lane responses, not just each individual response', async () => {
  const f = fixture(4, { requestBytes: 85, retainedBytes: 100 }), pending = f.request(); await turn();
  for (const id of [...f.waiting.keys()]) f.release(id, { users: ['中'.repeat(8)] });
  const response = await pending;
  assert.equal(response.status, 503); assert.equal(f.calls.length, 4); assert.equal(f.state().active, 0);
  finished(f, false, 2);
  const budget = f.rows.find(row => row.phase === 'finished' && row.busy === 1 && typeof row.snapshotBytes === 'number');
  assert.ok(budget, 'content-free budget diagnostic is emitted');
  assert.doesNotMatch(JSON.stringify(f.rows), /PRIVATE|中|synthetic|node-/);
});
