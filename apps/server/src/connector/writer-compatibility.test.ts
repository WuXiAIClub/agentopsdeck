import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { ConnectorUserStore } from './connector-user-store.js';

function fixture(context: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-writer-compatibility-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'connector.sqlite');
}

function legacyBootstrap(db: DatabaseSync) {
  db.prepare(`INSERT INTO connector_users (id, label, created_at, updated_at)
    VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`)
    .run('default', 'Default connector account', 1, 1);
}

test('upgraded Connector rejects the legacy mandatory bootstrap even when its default user already exists', context => {
  const file = fixture(context);
  const current = new ConnectorUserStore(file);
  const nodeId = current.nodeId;
  current.close();
  const legacy = new DatabaseSync(file);
  try {
    assert.throws(() => legacyBootstrap(legacy), /agentopsdeck_connector_writer_epoch/);
    assert.equal(legacy.prepare('SELECT node_id FROM connector_identity').get()?.node_id, nodeId);
    assert.equal(legacy.prepare('SELECT count(*) AS count FROM connector_users').get()?.count, 1);
  } finally { legacy.close(); }
});

for (const epoch of [0, 2, null]) {
  test(`Connector writer fence rejects incompatible epoch ${epoch}`, context => {
    const file = fixture(context);
    const current = new ConnectorUserStore(file);
    current.close();
    const incompatible = new DatabaseSync(file);
    try {
      incompatible.function('agentopsdeck_connector_writer_epoch', () => epoch);
      assert.throws(() => legacyBootstrap(incompatible), /Incompatible Connector writer/);
    } finally { incompatible.close(); }
  });
}

test('upgrading an unfenced legacy database preserves the default user and installation identity', context => {
  const file = fixture(context);
  const legacy = new DatabaseSync(file);
  legacy.exec(`CREATE TABLE connector_users (id TEXT PRIMARY KEY, label TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE connector_identity (singleton INTEGER PRIMARY KEY, node_id TEXT NOT NULL);
    INSERT INTO connector_identity VALUES (1, 'node_11111111-1111-4111-8111-111111111111');`);
  legacyBootstrap(legacy);
  legacy.close();
  const current = new ConnectorUserStore(file);
  assert.equal(current.nodeId, 'node_11111111-1111-4111-8111-111111111111');
  current.close();
  const reader = new DatabaseSync(file);
  try {
    assert.equal(reader.prepare('SELECT created_at FROM connector_users WHERE id = ?').get('default')?.created_at, 1);
    assert.throws(() => legacyBootstrap(reader), /agentopsdeck_connector_writer_epoch/);
  } finally { reader.close(); }
});

test('current writer reopens original receipts and queue after an incompatible bootstrap is refused', async context => {
  const file = fixture(context);
  const current = new ConnectorUserStore(file);
  const scope = JSON.stringify(['original-actor', 'agent:main:synthetic']);
  const receipt = (await current.commands.claimAsync(scope, 'original-command', { message: 'synthetic' })).receipt;
  await current.turns.enqueueAsync('openclaw', { id: 'original-native', sessionKey: 'agent:main:synthetic', createdAt: 1,
    payload: { actorId: 'original-actor', message: 'synthetic', media: [], deliveryMode: 'web-only' } });
  const original = current.turns.list('openclaw');
  current.close();
  const legacy = new DatabaseSync(file);
  try { assert.throws(() => legacyBootstrap(legacy), /agentopsdeck_connector_writer_epoch/); }
  finally { legacy.close(); }
  const reopened = new ConnectorUserStore(file);
  try {
    assert.deepEqual(reopened.commands.get(scope, 'original-command'), receipt);
    assert.deepEqual(reopened.turns.list('openclaw'), original);
    assert.equal((await reopened.commands.claimAsync(scope, 'original-command', { message: 'synthetic' })).fresh, false);
  } finally { reopened.close(); }
});

test('a later initialization failure leaves the compatibility fence installed and releases the database', context => {
  const file = fixture(context);
  const damaged = new DatabaseSync(file);
  damaged.exec(`CREATE TABLE connector_identity (singleton INTEGER PRIMARY KEY, node_id TEXT NOT NULL);
    INSERT INTO connector_identity VALUES (1, 'invalid-identity');`);
  damaged.close();
  assert.throws(() => new ConnectorUserStore(file, undefined, { runtimeOwner: true }), /Invalid persisted Connector identity/);
  const legacy = new DatabaseSync(file);
  try {
    assert.throws(() => legacyBootstrap(legacy), /agentopsdeck_connector_writer_epoch/);
    assert.equal(legacy.prepare('SELECT node_id FROM connector_identity').get()?.node_id, 'invalid-identity');
  } finally { legacy.close(); }
});

test('current writer refuses a conflicting persisted compatibility fence without replacing it', context => {
  const file = fixture(context);
  const current = new ConnectorUserStore(file);
  current.close();
  const damaged = new DatabaseSync(file);
  damaged.exec(`DROP TRIGGER connector_writer_compatibility;
    CREATE TRIGGER connector_writer_compatibility BEFORE INSERT ON connector_users
    WHEN 0 BEGIN SELECT RAISE(ABORT, 'invalid guard'); END;`);
  const original = damaged.prepare(`SELECT sql FROM sqlite_master WHERE name = 'connector_writer_compatibility'`).get();
  damaged.close();
  assert.throws(() => new ConnectorUserStore(file, undefined, { runtimeOwner: true }), /Invalid Connector writer compatibility fence/);
  const reader = new DatabaseSync(file);
  try {
    assert.deepEqual(reader.prepare(`SELECT sql FROM sqlite_master WHERE name = 'connector_writer_compatibility'`).get(), original);
  } finally { reader.close(); }
});

test('failed runtime construction fences old startup before any credential access', async context => {
  const { createConnectorRuntime } = await import('./runtime.js');
  const { loadConfig } = await import('../config.js');
  const { startupApplicationCleanup } = await import('../lifecycle/startup-cleanup.js');
  const file = fixture(context);
  const config = loadConfig({ AOD_CONNECTOR_USERS_DATABASE_FILE: file,
    AOD_CODEX_ENABLED: 'false', AOD_LOCAL_OPENCLAW_CLI: 'false' });
  Object.defineProperty(config.connector, 'tokenFile', { get() { throw new Error('synthetic credential failure'); } });
  assert.throws(() => createConnectorRuntime(config, () => false), /synthetic credential failure/);
  // Partial construction retains its exact database owner until asynchronous
  // cleanup ACK. A lock before that ACK is protection, not a lost writer fence.
  await startupApplicationCleanup.waitForCurrentCleanup();
  const legacy = new DatabaseSync(file);
  try { assert.throws(() => legacyBootstrap(legacy), /agentopsdeck_connector_writer_epoch/); }
  finally { legacy.close(); }
  const reopened = new ConnectorUserStore(file, undefined, { runtimeOwner: true });
  reopened.close();
});
