import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { EXPECTED_NODE_HEADER, NODE_ID_HEADER } from '../connector/node-identity.js';
import type { MaintenanceAdapter } from './connector-maintenance.js';
import { createMaintenanceApp, MAINTENANCE_API, MAINTENANCE_PROTOCOL_HEADER } from './maintenance-http.js';
import { SqliteMaintenanceJournal } from './maintenance-journal.js';
import { MaintenanceSupervisor } from './maintenance-supervisor.js';
import type { MaintenanceRecoveryObservation } from './maintenance-recovery.js';

const recoveryObservation = (): MaintenanceRecoveryObservation => ({ scope: 'maintenance-journal',
  transport: { scope: 'process', pending: 2, accepted: 3, unavailable: false, closing: false, ownerExitConfirmed: false },
  connection: { state: 'owner-rollback-required', attempts: 1 } });

function fixture(t: { after(fn: () => void): void }) {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-maintenance-http-'));
  const file = join(directory, 'tokens.json');
  const tokens = new ConnectorTokenStore(file, 'synthetic-bootstrap');
  const owner = tokens.create({ label: 'owner', scopes: ['connector:lifecycle'] });
  const other = tokens.create({ label: 'other', scopes: ['connector:lifecycle'] });
  const update = tokens.create({ label: 'updater', scopes: ['connector:update'] });
  const db = new DatabaseSync(join(directory, 'journal.sqlite'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  const journal = new SqliteMaintenanceJournal(db), effects: string[] = [];
  const effect = async () => { effects.push('unexpected effect'); throw new Error('private path or secret'); };
  const adapter: MaintenanceAdapter = { authorize: async () => true, prepare: effect, inspect: effect,
    fence: effect, releaseFence: effect, stop: effect, stopped: effect, backup: effect, activate: effect, start: effect, ready: effect };
  let tokenReads = 0;
  const currentTokens = () => { tokenReads++; return new ConnectorTokenStore(file); };
  const supervisor = new MaintenanceSupervisor(journal, adapter,
    async actor => currentTokens().hasScope(actor, 'connector:lifecycle'),
    { nodeId: 'node:1', operations: ['restart', 'upgrade'] });
  const app = createMaintenanceApp({ supervisor, tokens: currentTokens });
  const headers = (token = owner.token) => new Headers({ authorization: `Bearer ${token}`,
    [EXPECTED_NODE_HEADER]: supervisor.nodeId, [MAINTENANCE_PROTOCOL_HEADER]: '1', 'Content-Type': 'application/json' });
  const send = (input: unknown = { commandKey: 'request:1', operation: 'restart' }, token = owner.token) => app.request(`${MAINTENANCE_API}/commands`, {
    method: 'POST', headers: headers(token), body: JSON.stringify(input),
  });
  const read = (suffix = '/status', token = owner.token) => app.request(`${MAINTENANCE_API}${suffix}`, { headers: headers(token) });
  return { app, supervisor, journal, db, tokens, owner, other, update, effects, headers, send, read, currentTokens,
    tokenReads: () => tokenReads };
}

test('recovery reads require protocol, node, nonbrowser and lifecycle authority before observing original owner', async t => {
  const f = fixture(t); let reads = 0;
  const app = createMaintenanceApp({ supervisor: f.supervisor, tokens: f.currentTokens,
    recovery: async () => { reads++; return recoveryObservation(); }, workerState: () => 'halted' });
  for (const [name, value, expected] of [[EXPECTED_NODE_HEADER, 'node:2', 409], [MAINTENANCE_PROTOCOL_HEADER, '2', 426],
    ['Origin', 'https://example.test', 403], ['authorization', `Bearer ${f.update.token}`, 403]] as const) {
    const headers = f.headers(); headers.set(name, value);
    assert.equal((await app.request(`${MAINTENANCE_API}/recovery`, { headers })).status, expected);
  }
  assert.equal(reads, 0);
  const response = await app.request(`${MAINTENANCE_API}/recovery`, { headers: f.headers() });
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.deepEqual(await response.json(), { ...recoveryObservation(), workerState: 'halted' });
  assert.equal(reads, 1); assert.deepEqual(f.effects, []); assert.equal(f.journal.unresolved('node:1'), undefined);
});

test('recovery observation cannot leak through revoked or aborted original requests', async t => {
  for (const mode of ['revoke', 'abort-before', 'abort-after'] as const) {
    const f = fixture(t), controller = new AbortController(); let reads = 0;
    const app = createMaintenanceApp({ supervisor: f.supervisor, tokens: f.currentTokens,
      recovery: async () => {
        reads++;
        if (mode === 'revoke') f.tokens.revoke(f.owner.record.id);
        if (mode === 'abort-after') controller.abort();
        return recoveryObservation();
      } });
    if (mode === 'abort-before') controller.abort();
    const response = await app.fetch(new Request(`http://localhost${MAINTENANCE_API}/recovery`, { headers: f.headers(), signal: controller.signal }));
    assert.equal(response.status, mode === 'revoke' ? 403 : 408);
    assert.equal(reads, mode === 'abort-before' ? 0 : 1); assert.deepEqual(f.effects, []);
    assert.doesNotMatch(await response.text(), /owner-rollback-required/);
  }
});

test('unavailable recovery stays read-only and invalid/error responses cannot serialize private data', async t => {
  const f = fixture(t);
  const unavailable: MaintenanceRecoveryObservation = { ...recoveryObservation(), transport: { ...recoveryObservation().transport,
    unavailable: true, ownerExitConfirmed: true }, connection: { state: 'unavailable' } };
  const cases: [(() => Promise<MaintenanceRecoveryObservation>) | undefined, number][] = [
    [async () => unavailable, 200], [undefined, 503], [async () => { throw Error('private SQL/path/token'); }, 503],
    [async () => ({ ...recoveryObservation(), private: 'private SQL/path/token' }), 503],
  ];
  for (const [recovery, expected] of cases) {
    const app = createMaintenanceApp({ supervisor: f.supervisor, tokens: f.currentTokens, ...(recovery ? { recovery } : {}) });
    const response = await app.request(`${MAINTENANCE_API}/recovery`, { headers: f.headers() });
    assert.equal(response.status, expected);
    assert.doesNotMatch(await response.text(), /private SQL\/path\/token/);
  }
  assert.deepEqual(f.effects, []);
});

test('HTTP admission persists only; lost-response lookup and duplicates retain identity without effects', async t => {
  const f = fixture(t), response = await f.send();
  assert.equal(response.status, 202);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get(NODE_ID_HEADER), 'node:1');
  assert.equal(response.headers.get(MAINTENANCE_PROTOCOL_HEADER), '1');
  const body = await response.json();
  assert.equal(body.command.stage, 'prepare');
  assert.equal(body.command.actorId, f.owner.record.id);
  assert.deepEqual(await (await f.read('/commands/request:1')).json(), body);
  assert.deepEqual(await (await f.send()).json(), body);
  assert.equal((await f.send({ commandKey: 'request:1', operation: 'upgrade' })).status, 409);
  assert.equal((await f.send({ commandKey: 'request:2', operation: 'restart' })).status, 409);
  assert.deepEqual(f.effects, []);
});

test('node/protocol/Origin gates precede credential reads and do not publish CORS headers', async t => {
  const f = fixture(t);
  for (const [name, value, expected] of [[EXPECTED_NODE_HEADER, undefined, 409], [EXPECTED_NODE_HEADER, 'node:2', 409],
    [MAINTENANCE_PROTOCOL_HEADER, undefined, 426], [MAINTENANCE_PROTOCOL_HEADER, '2', 426], ['Origin', 'https://example.test', 403]] as const) {
    const headers = f.headers();
    if (value === undefined) headers.delete(name); else headers.set(name, value);
    const response = await f.app.request(`${MAINTENANCE_API}/status`, { headers });
    assert.equal(response.status, expected);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  }
  assert.equal(f.tokenReads(), 0);
  assert.equal(f.journal.unresolved('node:1'), undefined);
});

test('dedicated privilege, fresh revocation and actor-scoped receipts apply to every read/write', async t => {
  const f = fixture(t);
  for (const token of ['synthetic-bootstrap', f.update.token, 'invalid']) {
    assert.equal((await f.read('/status', token)).status, 403);
    assert.equal((await f.send(undefined, token)).status, 403);
  }
  await f.send();
  assert.equal((await f.read('/commands/request:1', f.other.token)).status, 404);
  const status = await (await f.read('/status', f.other.token)).json();
  assert.equal(status.blocked, true);
  assert.equal('job' in status, false);
  assert.equal(JSON.stringify(status).includes(f.owner.record.id), false);
  f.tokens.revoke(f.owner.record.id);
  for (const suffix of ['/status', '/commands/request:1']) assert.equal((await f.read(suffix)).status, 403);
  assert.equal((await f.send()).status, 403);
  assert.deepEqual(f.effects, []);
});

test('strict bounded body rejects shell/path/branch/actor fields and unsupported content types', async t => {
  const f = fixture(t), valid = { commandKey: 'request:1', operation: 'restart' };
  for (const field of ['actorId', 'nodeId', 'command', 'shell', 'path', 'branch', 'deadline']) {
    assert.equal((await f.send({ ...valid, [field]: 'untrusted' })).status, 400);
  }
  for (const input of [null, [], {}, { ...valid, operation: 'delete' }, { ...valid, commandKey: '../escape' }]) {
    assert.equal((await f.send(input)).status, 400);
  }
  assert.equal((await f.send({ ...valid, commandKey: 'x'.repeat(2048) })).status, 413);
  const headers = f.headers(); headers.set('Content-Type', 'text/plain');
  assert.equal((await f.app.request(`${MAINTENANCE_API}/commands`, { method: 'POST', headers, body: JSON.stringify(valid) })).status, 415);
  headers.set('Content-Type', 'application/json');
  assert.equal((await f.app.request(`${MAINTENANCE_API}/commands`, { method: 'POST', headers, body: '{' })).status, 400);
  assert.equal(f.journal.unresolved('node:1'), undefined);
  assert.deepEqual(f.effects, []);
});

test('revocation while receiving body rejects admission even with an earlier authenticated request', async t => {
  const f = fixture(t);
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  const request = new Request(`http://localhost${MAINTENANCE_API}/commands`, {
    method: 'POST', headers: f.headers(), body, duplex: 'half',
  } as RequestInit);
  const pending = f.app.fetch(request);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.ok(f.tokenReads() > 0);
  f.tokens.revoke(f.owner.record.id);
  controller.enqueue(new TextEncoder().encode(JSON.stringify({ commandKey: 'request:1', operation: 'restart' })));
  controller.close();
  assert.equal((await pending).status, 403);
  assert.equal(f.journal.unresolved('node:1'), undefined);
});

test('revocation after durable admission suppresses receipt; never deletes or replays admitted work', async t => {
  const f = fixture(t), submit = f.supervisor.submit.bind(f.supervisor);
  f.supervisor.submit = async (...args) => {
    const job = await submit(...args);
    f.tokens.revoke(f.owner.record.id);
    return job;
  };
  assert.equal((await f.send()).status, 403);
  assert.equal(f.journal.unresolved('node:1')?.stage, 'prepare');
  assert.equal((await f.supervisor.tick())?.reason, 'authorization_changed');
  assert.deepEqual(f.effects, []);
});

test('late status/receipt responses recheck authority and infrastructure errors are redacted', async t => {
  for (const suffix of ['/status', '/commands/request:1']) {
    const f = fixture(t);
    await f.send();
    if (suffix === '/status') {
      const original = f.supervisor.status.bind(f.supervisor);
      f.supervisor.status = async actor => { const value = await original(actor); f.tokens.revoke(f.owner.record.id); return value; };
    } else {
      const original = f.supervisor.command.bind(f.supervisor);
      f.supervisor.command = async (...args) => { const value = await original(...args); f.tokens.revoke(f.owner.record.id); return value; };
    }
    assert.equal((await f.read(suffix)).status, 403);
  }
  const f = fixture(t);
  const app = createMaintenanceApp({ supervisor: f.supervisor, tokens: () => { throw new Error('secret/private/path'); } });
  const response = await app.request(`${MAINTENANCE_API}/status`, { headers: f.headers() });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { error: 'Maintenance supervisor unavailable' });
});
