import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import type { Worker } from 'node:worker_threads';
import { PerformanceDiagnostics, performanceDiagnostics } from '../diagnostics/performance.js';
import { AsyncHubDeliveryReader } from './async-delivery-reader.js';
import { readConnections } from './connection-read.js';
import { CONNECTION_BYTE_LIMIT, CONNECTION_ROW_LIMIT, validConnectionRows } from './connection-read-protocol.js';
import { DeliverySnapshotReadRejected } from './delivery-reader-protocol.js';
import { HubStore, type HubConnection } from './hub-store.js';
import { migrateConnectionDisplayVersions, ConnectionDirectoryChanged, isConnectionDirectoryChanged } from './connection-display-version.js';

const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const connection: HubConnection = { id: 'node', ownerUserId: 'default', kind: 'remote', label: 'Original',
  connectorUrl: 'https://fixture.invalid', status: 'enabled', capabilities: [], hasCredential: false,
  createdAt: 1, updatedAt: 2, nodeId: undefined, environmentId: undefined, environmentLabel: undefined };
function dbFixture(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE env_connections(id TEXT PRIMARY KEY,owner_user_id TEXT,kind TEXT,label TEXT,connector_url TEXT,
    status TEXT,node_id TEXT,environment_id TEXT,environment_label TEXT,capabilities_json TEXT,created_at INTEGER,updated_at INTEGER,deleted_at INTEGER);
    CREATE TABLE env_credentials(id TEXT,connection_id TEXT,owner_user_id TEXT,encrypted_token TEXT)`);
  db.prepare('INSERT INTO env_connections VALUES(?,?,?,?,?,?,NULL,NULL,NULL,?,1,2,NULL)')
    .run('node','default','remote','Original','https://fixture.invalid','enabled','[]');
  t.after(() => db.close()); return db;
}
class FakeWorker extends EventEmitter {
  messages: { id: number; kind: string; read?: unknown }[] = [];
  autoExit = true;
  postMessage(message: { id: number; kind: string; read?: unknown }) {
    this.messages.push(message);
    if (message.kind === 'close') queueMicrotask(() => {
      this.emit('message', { id: message.id, kind: 'close', ok: true }); this.emit('exit', 0);
    });
  }
  terminate() { if (this.autoExit) queueMicrotask(() => this.emit('exit', 1)); return Promise.resolve(1); }
  reply(index: number, value: unknown, ok = true) {
    const sent = this.messages[index]!;
    this.emit('message', { id: sent.id, kind: sent.kind, ok, ...(ok ? { value } : {}) });
  }
}
function fake(t: TestContext, ready = true) {
  const worker = new FakeWorker(), logs: any[] = [];
  const reader = new AsyncHubDeliveryReader({ file: '/unused', dev: 1, ino: 1 },
    new PerformanceDiagnostics(line => logs.push(JSON.parse(line))), () => worker as unknown as Worker);
  if (ready) queueMicrotask(() => worker.emit('message', { kind: 'ready' }));
  t.after(async () => { worker.emit('exit', 1); await reader.close(); });
  return { worker, reader, logs };
}
function fileFixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-connection-read-')), file = join(dir, 'hub.sqlite');
  const store = new HubStore(file, 'synthetic');
  store.upsertConnection({ id: 'node', label: 'Original', connectorUrl: 'https://fixture.invalid' });
  const db = (store as unknown as { db: DatabaseSync }).db;
  t.after(async () => { await store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, db, file };
}

test('bounded readonly directory preserves original ordering, long Unicode labels and credential presence only', t => {
  const db = dbFixture(t);
  db.exec("INSERT INTO env_connections SELECT 'local','default','local','Zulu',connector_url,status,node_id,environment_id,environment_label,capabilities_json,created_at,updated_at,NULL FROM env_connections WHERE id='node'");
  db.exec("INSERT INTO env_connections SELECT 'other','other','remote',CAST(x'ff' AS TEXT),connector_url,status,node_id,environment_id,environment_label,capabilities_json,created_at,updated_at,NULL FROM env_connections WHERE id='node'");
  db.prepare('UPDATE env_connections SET label=?,capabilities_json=?,environment_label=? WHERE id=?')
    .run('中'.repeat(16_385), '["a",1,"b"]', '', 'node');
  db.prepare('INSERT INTO env_credentials VALUES(?,?,?,?)').run('credential','node','default','PRIVATE ciphertext');
  const rows = readConnections(db, 'default');
  assert.deepEqual(rows.map(row => row.id), ['local','node']);
  assert.equal(rows[1]!.label, '中'.repeat(16_385)); assert.equal(rows[1]!.environmentLabel, '');
  assert.deepEqual(rows[1]!.capabilities, ['a','b']); assert.equal(rows[1]!.hasCredential, true);
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE|encrypted_token|credential_id/);
  assert.deepEqual(readConnections(db, 'absent'), []);
});

for (const source of ['broken', '{}', 'null', 'false']) test(`connection capability legacy fallback remains intact (${source})`, t => {
  const db = dbFixture(t); db.prepare('UPDATE env_connections SET capabilities_json=?').run(source);
  assert.deepEqual(readConnections(db, 'default'), [connection]);
});

for (const [column, value] of [['id', "CAST(x'ff' AS TEXT)"], ['id', "'a'||char(0)||'b'"],
  ['label', "CAST(x'ff' AS TEXT)"], ['label', "x'6162'"], ['label', "'a'||char(0)||'b'"],
  ['created_at','-1'], ['updated_at','1.5'], ['kind',"'bad'"], ['status',"'bad'"], ['node_id',"x'ff'"]] as const)
  test(`corrupt connection ${column} refuses without modifying facts or leaking partial rows`, t => {
    const db = dbFixture(t); db.exec(`UPDATE env_connections SET ${column}=${value}`);
    const before = db.prepare('SELECT hex(id),hex(label),created_at,updated_at FROM env_connections').all();
    assert.throws(() => readConnections(db, 'default'), DeliverySnapshotReadRejected);
    assert.deepEqual(db.prepare('SELECT hex(id),hex(label),created_at,updated_at FROM env_connections').all(), before);
    assert.equal(db.isTransaction, false);
  });

for (const overflow of ['rows', 'raw-bytes', 'escaped-wire-bytes'] as const)
  test(`connection ${overflow} overflow refuses complete snapshot and releases original statement`, t => {
    const db = dbFixture(t);
    if (overflow === 'rows') {
      const insert = db.prepare("INSERT INTO env_connections SELECT ?,'default',kind,label,connector_url,status,node_id,environment_id,environment_label,capabilities_json,created_at,updated_at,NULL FROM env_connections WHERE id='node'");
      db.exec('BEGIN'); for (let i = 0; i < CONNECTION_ROW_LIMIT; i++) insert.run('n'+i); db.exec('COMMIT');
    } else if (overflow === 'raw-bytes') db.prepare('UPDATE env_connections SET label=?').run('x'.repeat(CONNECTION_BYTE_LIMIT + 1));
    else {
      db.prepare('UPDATE env_connections SET label=?').run('\n'.repeat(1_500_000));
      db.exec("INSERT INTO env_connections SELECT 'n2',owner_user_id,kind,label,connector_url,status,node_id,environment_id,environment_label,capabilities_json,created_at,updated_at,NULL FROM env_connections WHERE id='node'; INSERT INTO env_connections SELECT 'n3',owner_user_id,kind,label,connector_url,status,node_id,environment_id,environment_label,capabilities_json,created_at,updated_at,NULL FROM env_connections WHERE id='node'");
    }
    assert.throws(() => readConnections(db, 'default'), DeliverySnapshotReadRejected);
    assert.equal(db.isTransaction, false); assert.deepEqual(readConnections(db, 'absent'), []);
  });

test('connection reply validation rejects widened owners, secrets, duplicates and invalid bounds', () => {
  assert.equal(validConnectionRows([connection], 'default'), true);
  for (const rows of [[{ ...connection, ownerUserId: 'other' }], [{ ...connection, encryptedToken: 'PRIVATE' }],
    [connection,connection], [{ ...connection, updatedAt: NaN }], [{ ...connection, hasCredential: 1 }],
    [{ ...connection, nodeId: null }], [{ ...connection, label: 'x'.repeat(CONNECTION_BYTE_LIMIT) }]])
    assert.equal(validConnectionRows(rows, 'default'), false);
});

test('connection reads share original four snapshot slots while chat replay remains admitted', async t => {
  const { worker, reader } = fake(t, false);
  const pending = [reader.connections('default'), reader.preferences('default'), reader.users({ owner: 'default', admin: true }), reader.connections('default')];
  await assert.rejects(reader.connections('default'));
  const page = reader.read({ owner: 'default', domains: [] });
  worker.emit('message', { kind: 'ready' }); await turn();
  assert.deepEqual(worker.messages[0]!.read, { owner: 'default' });
  for (let i = 0; i < 4; i++) worker.reply(i, []);
  worker.reply(4, { reset: false, cursor: undefined, events: [] }); await Promise.all([...pending,page]);
  assert.equal(reader.recoveryState.unavailable, false);
});

test('completed connection snapshot refusal preserves physical reader and releases display capacity', async t => {
  const { worker, reader, logs } = fake(t);
  const rejected = reader.connections('default'); await turn(); worker.reply(0, undefined, false);
  await assert.rejects(rejected, DeliverySnapshotReadRejected);
  assert.equal(reader.recoveryState.unavailable, false);
  const next = reader.connections('default'); await turn(); worker.reply(1, [connection]);
  assert.deepEqual(await next, [connection]);
  const refusal = logs.find(row => row.operation === 'hub-connections-read' && row.deferred);
  assert.equal(refusal.settled, 1); assert.equal(refusal.unknown, undefined);
  assert.doesNotMatch(JSON.stringify(logs), /fixture|Original|ownerUserId|token/);
});

test('widened connection worker reply fails original observer, never widens display scope', async t => {
  const { worker, reader } = fake(t);
  const pending = reader.connections('default'); await turn(); worker.reply(0, [{ ...connection, ownerUserId: 'other' }]);
  await assert.rejects(pending); assert.equal(reader.recoveryState.unavailable, true);
});

test('file-backed connection display uses only constant-size writer fences, not a main-thread directory scan', async t => {
  const { store, db } = fileFixture(t), expected = store.listConnections();
  const statements: string[] = [];
  t.mock.method(store, 'listConnections', () => { throw Error('main-thread directory forbidden'); });
  t.mock.method(db, 'prepare', function(this: DatabaseSync, query: string) {
    statements.push(query); assert.equal(query, 'SELECT version FROM hub_connection_display_versions WHERE user_id = ?');
    return DatabaseSync.prototype.prepare.call(this, query);
  });
  assert.deepEqual(await store.listConnectionsAsync(), expected); assert.equal(statements.length, 2);
  t.mock.restoreAll(); await store.close(); await assert.rejects(store.listConnectionsAsync());
});

test('public directory fence observes other handles and rollback, refuses uncommitted/closed owners and survives reopen', async t => {
  const { store, db, file } = fileFixture(t), initial = store.connectionDirectoryVersion();
  assert.equal(store.connectionDirectoryVersion('unrelated'), 0);
  const other = new DatabaseSync(file);
  try {
    other.exec("UPDATE env_connections SET label='Elsewhere' WHERE id='node'");
    const changed = store.connectionDirectoryVersion(); assert.ok(changed > initial);
    db.exec('BEGIN');
    db.exec("UPDATE env_connections SET label='Rolled back' WHERE id='node'");
    assert.throws(() => store.connectionDirectoryVersion(), DeliverySnapshotReadRejected);
    db.exec('ROLLBACK'); assert.equal(store.connectionDirectoryVersion(), changed);
    other.exec("UPDATE env_connections SET authority_version=authority_version+1 WHERE id='node'");
    assert.equal(store.connectionDirectoryVersion(), changed, 'display version is not an authority grant');
    other.exec("DELETE FROM env_connections WHERE id='node'");
    const removed = store.connectionDirectoryVersion(); assert.ok(removed > changed);
    store.upsertConnection({ id: 'node', label: 'Original', connectorUrl: 'https://fixture.invalid' });
    assert.ok(store.connectionDirectoryVersion() > removed, 'same ID recreation cannot resurrect prior generation');
    const latest = store.connectionDirectoryVersion();
    await store.close(); assert.throws(() => store.connectionDirectoryVersion(), DeliverySnapshotReadRejected);
    const reopened = new HubStore(file, 'synthetic');
    try { assert.equal(reopened.connectionDirectoryVersion(), latest); } finally { await reopened.close(); }
  } finally { other.close(); }
});

for (const change of ['deleted','disabled','transferred','credential','other-handle','recreated'] as const)
  test(`original-writer connection fence refuses ${change}, preserves owner and permits a later fresh read`, async t => {
    const { store, db, file } = fileFixture(t), h = fake(t);
    const internals = store as unknown as { deliveryReader?: AsyncHubDeliveryReader };
    internals.deliveryReader = h.reader;
    const before = store.listConnections(), logs: any[] = [];
    const diagnostics = new PerformanceDiagnostics(line => logs.push(JSON.parse(line)));
    const start = performanceDiagnostics.start.bind(performanceDiagnostics);
    t.mock.method(performanceDiagnostics, 'start', (operation: Parameters<typeof performanceDiagnostics.start>[0]) => operation === 'hub-connections-read' ? diagnostics.start(operation) : start(operation));
    const pending = store.listConnectionsAsync(); await turn();
    if (change === 'deleted') store.deleteConnection('node');
    else if (change === 'disabled') store.upsertConnection({ id: 'node', label: 'Changed', connectorUrl: 'https://fixture.invalid', status: 'disabled' });
    else if (change === 'transferred') db.exec("UPDATE env_connections SET owner_user_id='other' WHERE id='node'");
    else if (change === 'credential') store.upsertConnection({ id: 'node', label: 'Original', connectorUrl: 'https://fixture.invalid', credentialToken: 'synthetic' });
    else if (change === 'recreated') db.exec("BEGIN; DELETE FROM env_connections WHERE id='node'; INSERT INTO env_connections(id,owner_user_id,kind,label,connector_url,status,created_at,updated_at) VALUES('node','default','remote','Original','https://fixture.invalid','enabled',1,1); COMMIT");
    else { const external = new DatabaseSync(file); try { external.exec("UPDATE env_connections SET label='Changed elsewhere' WHERE id='node'"); } finally { external.close(); } }
    h.worker.reply(0, before); await assert.rejects(pending, error => isConnectionDirectoryChanged(error));
    assert.equal(h.reader.recoveryState.unavailable, false, 'changed display is not original-owner failure');
    const row = logs.find(row => row.changed === 1); assert.equal(row.settled, 1); assert.equal(row.deferred, 1);
    assert.doesNotMatch(JSON.stringify(logs), /node|Original|synthetic|ownerUserId/);
    const expected = store.listConnections(), next = store.listConnectionsAsync(); await turn(); h.worker.reply(1, expected);
    assert.deepEqual(await next, expected);
  });

test('directory generation recovery evidence rejects lookalike errors and hostile proxies', () => {
  assert.equal(isConnectionDirectoryChanged(new ConnectionDirectoryChanged()), true);
  assert.equal(isConnectionDirectoryChanged(Error('hub_delivery_read_unavailable')), false);
  assert.equal(isConnectionDirectoryChanged(new DeliverySnapshotReadRejected()), false);
  assert.equal(isConnectionDirectoryChanged(Object.create(ConnectionDirectoryChanged.prototype)), false);
  const hostile = new Proxy({}, { get() { throw Error('private-get'); }, getPrototypeOf() { throw Error('private-prototype'); } });
  assert.equal(isConnectionDirectoryChanged(hostile), false);
  assert.equal(isConnectionDirectoryChanged(null), false);
});

test('connection display refuses an open original transaction without dispatching or rolling it back', async t => {
  const { store, db } = fileFixture(t), h = fake(t);
  (store as unknown as { deliveryReader?: AsyncHubDeliveryReader }).deliveryReader = h.reader;
  db.exec("BEGIN; UPDATE env_connections SET label='Uncommitted' WHERE id='node'");
  try {
    await assert.rejects(store.listConnectionsAsync(), DeliverySnapshotReadRejected);
    assert.equal(db.isTransaction, true); assert.equal(h.worker.messages.length, 0);
    assert.equal(store.listConnections()[0]!.label, 'Uncommitted');
  } finally { db.exec('ROLLBACK'); }
});

for (const change of ['rolled-back', 'goal-journal', 'other-owner', 'authority-only', 'maintenance-credential'] as const)
  test(`connection display remains available during unrelated ${change} writes`, async t => {
    const { store, db } = fileFixture(t), h = fake(t);
    (store as unknown as { deliveryReader?: AsyncHubDeliveryReader }).deliveryReader = h.reader;
    const before = store.listConnections(), pending = store.listConnectionsAsync(); await turn();
    if (change === 'rolled-back') db.exec("BEGIN; UPDATE env_connections SET label='Never committed' WHERE id='node'; ROLLBACK");
    else if (change === 'goal-journal') db.exec("INSERT INTO hub_events(id,owner_user_id,connection_id,event_type,payload_json,created_at) VALUES('progress','default','node','goal-progress','{}',1)");
    else if (change === 'other-owner') store.upsertConnection({ id: 'other', ownerUserId: 'different', label: 'Other', connectorUrl: 'https://fixture.invalid' });
    else if (change === 'authority-only') db.exec("UPDATE env_connections SET authority_version=authority_version+1 WHERE id='node'");
    else store.updateMaintenanceCredential('node', 'synthetic');
    h.worker.reply(0, before); assert.deepEqual(await pending, before);
    assert.equal(h.reader.recoveryState.unavailable, false);
  });

test('display generation migration is idempotent, transactional and covers credential moves without reading contents', t => {
  const db = dbFixture(t), version = (owner: string) =>
    (db.prepare('SELECT version FROM hub_connection_display_versions WHERE user_id=?').get(owner) as {version: number} | undefined)?.version ?? 0;
  migrateConnectionDisplayVersions(db); migrateConnectionDisplayVersions(db);
  assert.equal(version('default'), 0, 'existing rows need no copy');
  db.exec("INSERT INTO env_credentials VALUES('c','node','default','synthetic');");
  assert.equal(version('default'), 1);
  db.exec("UPDATE env_credentials SET encrypted_token='replacement'"); assert.equal(version('default'), 1);
  db.exec("BEGIN; UPDATE env_connections SET owner_user_id='other'; ROLLBACK");
  assert.equal(version('default'), 1); assert.equal(version('other'), 0);
  db.exec("UPDATE env_connections SET owner_user_id='other'");
  assert.equal(version('default'), 2); assert.equal(version('other'), 1);
  db.exec("UPDATE env_credentials SET owner_user_id='other'"); assert.equal(version('other'), 2);
  db.exec('DELETE FROM env_credentials'); assert.equal(version('other'), 3);
  db.exec("INSERT INTO env_credentials VALUES('sentinel','maintenance-key','other','synthetic')"); assert.equal(version('other'), 3);
  db.exec("UPDATE hub_connection_display_versions SET version=9007199254740991 WHERE user_id='other'");
  assert.throws(() => db.exec("UPDATE env_connections SET label='Overflow'"));
  assert.equal(db.prepare('SELECT label FROM env_connections').get()!.label, 'Original');
  assert.equal(version('other'), Number.MAX_SAFE_INTEGER, 'overflow aborts original mutation, never wraps generation');
});

test('display generation persists on reopen and reflects an older writer without trigger installation', async t => {
  const { store, file } = fileFixture(t);
  await store.close();
  const legacy = new DatabaseSync(file);
  const initial = legacy.prepare('SELECT version FROM hub_connection_display_versions WHERE user_id=?').get('default')!.version;
  legacy.exec("UPDATE env_connections SET label='Legacy changed' WHERE id='node'");
  assert.equal(legacy.prepare('SELECT version FROM hub_connection_display_versions WHERE user_id=?').get('default')!.version, Number(initial) + 1);
  legacy.close();
  const reopened = new HubStore(file, 'synthetic'); t.after(() => reopened.close());
  assert.equal((await reopened.listConnectionsAsync())[0]!.label, 'Legacy changed');
});

test('display migration failure logs SQL classification and rolls back all schema work', t => {
  const db = dbFixture(t), logs: any[] = [];
  const diagnostics = new PerformanceDiagnostics(line => logs.push(JSON.parse(line)));
  const start = performanceDiagnostics.start.bind(performanceDiagnostics);
  t.mock.method(performanceDiagnostics, 'start', (operation: Parameters<typeof performanceDiagnostics.start>[0]) =>
    operation === 'hub-connection-display-migration' ? diagnostics.start(operation) : start(operation));
  db.exec('DROP TABLE env_credentials');
  assert.throws(() => migrateConnectionDisplayVersions(db));
  assert.equal(db.isTransaction, false);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'hub_connection%'").get()!.n, 0);
  assert.equal(db.prepare('SELECT label FROM env_connections').get()!.label, 'Original');
  assert.equal(logs.length, 1); assert.equal(logs[0].category, 'failed'); assert.equal(logs[0].step, 2);
  assert.equal(typeof logs[0].rollbackMs, 'number'); assert.equal(logs[0].unknown, undefined);
  assert.equal(typeof logs[0].sqlErrorCode, 'number');
  assert.doesNotMatch(JSON.stringify(logs), /env_credentials|Original|node|synthetic/);
});

test('nested display migration remains inside the original transaction and follows its rollback', t => {
  const db = dbFixture(t); db.exec('BEGIN');
  migrateConnectionDisplayVersions(db); assert.equal(db.isTransaction, true);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='hub_connection_display_versions'").get()!.n, 1);
  db.exec('ROLLBACK'); assert.equal(db.isTransaction, false);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'hub_connection%'").get()!.n, 0);
});
