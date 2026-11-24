import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { Hono } from 'hono';
import { loadConfig } from '../config.js';
import { createApplication } from '../application.js';
import { HubStore } from './hub-store.js';
import { encodeHubSessionId } from './session-id.js';
import { startupApplicationCleanup } from '../lifecycle/startup-cleanup.js';

function fixture(t: TestContext, multiuser = true) {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-preference-migration-'));
  const file = join(dir, 'hub.sqlite');
  const old = new DatabaseSync(file);
  // Relevant legacy table shapes from d321394; deliberately no authority/node columns.
  old.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, label TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE env_connections (
      id TEXT NOT NULL, owner_user_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('local', 'remote')),
      label TEXT NOT NULL, connector_url TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('enabled', 'disabled', 'degraded')),
      environment_id TEXT, environment_label TEXT, capabilities_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER, PRIMARY KEY(id, owner_user_id)
    );
    INSERT INTO users VALUES ('default', 'Original user', 1, 1);
  `);
  if (multiuser) old.exec("INSERT INTO users VALUES ('alice', 'Alice', 2, 2)");
  const insert = old.prepare("INSERT INTO env_connections (id, owner_user_id, kind, label, connector_url, status, created_at, updated_at) VALUES (?, ?, 'remote', ?, 'http://synthetic.invalid', 'enabled', 1, 1)");
  for (const owner of multiuser ? ['default', 'alice'] : ['default']) {
    for (const node of ['a', 'b']) insert.run(node, owner, node);
  }
  old.close();
  let store = new HubStore(file, 'synthetic-only');
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const files = { hidden: join(dir, 'hidden.json'), archived: join(dir, 'archived.json'), pinned: join(dir, 'pinned.json') };
  const ids = [encodeHubSessionId('a', 'codex:same'), encodeHubSessionId('b', 'codex:same')];
  writeFileSync(files.hidden, JSON.stringify(ids));
  writeFileSync(files.archived, '{}');
  writeFileSync(files.pinned, JSON.stringify([ids[1]]));
  return { dir, files, ids, get store() { return store; }, restart() { store.close(); store = new HubStore(file, 'synthetic-only'); } };
}

test('ambiguous legacy preferences fail atomically; explicit ownership survives restart and cannot be reassigned', t => {
  const f = fixture(t);
  const source = readFileSync(f.files.hidden, 'utf8');
  assert.throws(() => f.store.importLegacySessionPreferences(f.files), /legacy.*owner/i);
  for (const owner of ['default', 'alice']) assert.equal(f.store.sessionPreferences(owner).size, 0);
  f.restart();
  assert.throws(() => f.store.importLegacySessionPreferences(f.files, 'missing'), /legacy.*owner/i);
  f.store.setSessionPreference(f.ids[0]!, 'hidden', false, 'alice');
  f.store.importLegacySessionPreferences(f.files, 'alice');
  assert.equal(f.store.sessionPreferences().size, 0);
  assert.deepEqual([...f.store.sessionPreferences('alice')], [
    [f.ids[0], { hidden: false }], [f.ids[1], { hidden: true, pinned: true }],
  ]);
  const node = 'node_00000000-0000-4000-8000-000000000001';
  f.store.pinConnectionNode('a', 'alice', f.store.connectionAuthority('a', 'alice')!, node);
  f.store.upsertConnection({ id: 'a', ownerUserId: 'alice', label: 'Moved', connectorUrl: 'http://moved.invalid' });
  f.restart();
  f.store.importLegacySessionPreferences(f.files, 'default');
  assert.equal(f.store.sessionPreferences().size, 0, 'a consumed source cannot be copied to another user');
  assert.deepEqual(f.store.sessionReference(f.ids[0]!, 'alice'), { nodeId: node, runtimeId: 'codex', nativeSessionKey: 'same' });
  assert.equal(f.store.sessionReference(f.ids[0]!, 'default'), undefined);
  assert.equal(f.store.sessionPreferences('alice').size, 2);
  assert.equal(readFileSync(f.files.hidden, 'utf8'), source);
});

for (const owner of [undefined, 'default']) test(`single-user legacy preferences retain compatibility (${owner ?? 'implicit'})`, t => {
  const f = fixture(t, false);
  f.store.importLegacySessionPreferences(f.files, owner);
  f.restart();
  assert.equal(f.store.sessionPreferences().size, 2);
});

test('empty multiuser migration does not require ownership or grant any access', t => {
  const f = fixture(t);
  for (const file of Object.values(f.files)) writeFileSync(file, '[]');
  f.store.importLegacySessionPreferences(f.files);
  f.restart();
  for (const owner of ['default', 'alice']) assert.equal(f.store.sessionPreferences(owner).size, 0);
});

for (const role of ['hub', 'all'] as const) for (const owner of [undefined, 'alice', 'missing']) test(`${role} validates legacy ownership (${owner ?? 'absent'}) before constructing a runtime`, async t => {
  const f = fixture(t);
  const config = loadConfig({
    AOD_SERVER_ROLE: role, AOD_SESSION_TITLES_FILE: join(f.dir, 'titles.json'),
    AOD_HUB_DATABASE_FILE: join(f.dir, 'hub.sqlite'), AOD_HUB_VAULT_SECRET: 'synthetic-only',
    AOD_PASSKEYS_FILE: join(f.dir, 'passkeys.json'), AOD_AUTH_SESSIONS_FILE: join(f.dir, 'auth.json'),
    AOD_HIDDEN_SESSIONS_FILE: f.files.hidden, AOD_ARCHIVED_SESSIONS_FILE: f.files.archived,
    AOD_PINNED_SESSIONS_FILE: f.files.pinned, AOD_HUB_LEGACY_PREFERENCES_OWNER: owner && ` ${owner} `,
  });
  let constructed = 0, closed = 0;
  const close = t.mock.method(HubStore.prototype, 'close');
  const start = () => createApplication(config, () => {
    constructed++;
    assert.equal(f.store.sessionPreferences('alice').size, 2, 'migration must commit before runtime construction');
    return { app: new Hono(), stopAdmissions: async () => {}, localToken: 'synthetic-only', localMaintenanceToken: 'synthetic-only',
      mediaLibrary: { isSignedStreamRequest: () => false }, registerLegacyRoutes: () => {},
      close: async () => { closed++; },
    } as any;
  });
  if (owner === 'alice') {
    const application = start();
    await application.close();
    assert.equal(f.store.sessionPreferences('alice').size, 2);
    assert.equal(constructed, role === 'all' ? 1 : 0);
    assert.equal(closed, constructed);
  } else {
    assert.throws(start, /legacy.*owner/i);
    assert.equal(constructed, 0, 'invalid migration must never start Connector workers');
    // Construction failure has no application handle. Wait for the original
    // retained cleanup ACK, not a timer or a second database owner, before
    // checking closure or allowing the fixture teardown to remove its files.
    await startupApplicationCleanup.waitForCurrentCleanup();
    assert.deepEqual(startupApplicationCleanup.snapshot(), { pending: 0, retryable: 0 });
  }
  assert.equal(close.mock.callCount(), 1, 'startup failure and normal shutdown release the Hub store');
  assert.equal(f.store.sessionPreferences().size, 0);
});
