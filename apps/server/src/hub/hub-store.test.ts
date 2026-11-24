import { createDecipheriv, createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { HubStore } from './hub-store.js';
import { encodeHubSessionId } from './session-id.js';
import { startupDatabaseOwners } from '../storage/startup-owner.js';

function createHubStoreFixture(t?: TestContext) {
  const roots: string[] = [];
  const stores = new Set<HubStore>();
  let cleaned = false;
  const createRoot = (prefix: string) => {
    const root = mkdtempSync(join(tmpdir(), prefix));
    roots.push(root);
    return root;
  };
  const openStore = (...args: ConstructorParameters<typeof HubStore>) => {
    const store = new HubStore(...args);
    stores.add(store);
    return store;
  };
  const closeStore = async (store: HubStore) => {
    stores.delete(store);
    await store.close();
    assert.equal(store.storageRecovery().state, 'closed');
  };
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    for (const store of [...stores].reverse()) {
      await closeStore(store);
    }
    for (const root of [...roots].reverse()) {
      rmSync(root, { recursive: true, force: true });
      assert.equal(existsSync(root), false);
    }
  };
  t?.after(cleanup);
  return { roots, stores, createRoot, openStore, closeStore, cleanup };
}

for (const operation of ['delivery', 'migration'] as const) {
  for (const failure of ['automatic-rollback', 'rollback', 'commit-ack'] as const) {
    test(`Hub ${operation} preserves original ${failure} failure without cursor replay`, async (t) => {
      const fx = createHubStoreFixture(t);
      const store = fx.openStore(':memory:', 'synthetic'), db = (store as any).db;
      const exec = db.exec.bind(db), original = Error('synthetic original');
      let commits = 0, rollbacks = 0;
      db.exec = (sql: string) => {
        if (sql === 'ROLLBACK') { rollbacks++; if (failure === 'rollback') throw Error('secondary rollback'); }
        if (sql === 'COMMIT') {
          commits++;
          if (failure === 'automatic-rollback') exec('ROLLBACK');
          if (failure === 'commit-ack') exec('COMMIT');
          throw original;
        }
        return exec(sql);
      };
      try {
        assert.throws(() => operation === 'delivery'
          ? store.appendDelivery({ envConnectionId: 'node', type: 'message.created', ts: 1, payload: {} }, 'domain', 'original')
          : store.importLegacySessionPreferences({ hidden: join(tmpdir(), 'agentopsdeck-no-such-hidden-'+process.pid),
            archived: join(tmpdir(), 'agentopsdeck-no-such-archived-'+process.pid), pinned: join(tmpdir(), 'agentopsdeck-no-such-pinned-'+process.pid) }),
        e => e === original);
        assert.equal(commits, 1); assert.equal(rollbacks, failure === 'rollback' ? 1 : 0);
        if (failure === 'commit-ack') {
          db.exec = exec;
          if (operation === 'delivery') {
            assert.equal(store.upstreamCursor('node', 'domain'), 'original');
            assert.equal(store.appendDelivery({ envConnectionId: 'node', type: 'message.created', ts: 1, payload: {} }, 'domain', 'original'), false);
            assert.equal(store.deliveryPage(undefined, new Map([['node', 'domain']])).events.length, 1);
          } else assert.ok(db.prepare("SELECT name FROM hub_migrations WHERE name = 'hub-session-preferences-v1'").get());
        } else if (failure === 'automatic-rollback') {
          assert.equal(store.upstreamCursor('node', 'domain'), undefined);
          assert.equal(db.prepare("SELECT name FROM hub_migrations WHERE name = 'hub-session-preferences-v1'").get(), undefined);
        }
      } finally { db.exec = exec; if (db.isTransaction) exec('ROLLBACK'); await fx.cleanup(); }
    });
  }
}

test('startup reconciliation preserves unchanged authority but fences target and credential changes', async (t) => {
  const fx = createHubStoreFixture(t);
  const file = join(fx.createRoot('agentopsdeck-startup-authority-'), 'hub.sqlite');
  let store = fx.openStore(file, 'synthetic');
  const input = { id: 'remote', label: 'Synthetic', connectorUrl: 'http://synthetic.invalid', credentialToken: 'synthetic-first' };
  const options = { preserveCredential: true, audit: false, skipUnchanged: true };
  try {
    store.upsertConnection(input, options);
    const original = store.connectionAuthority(input.id)!;
    await fx.closeStore(store); store = fx.openStore(file, 'synthetic');
    store.upsertConnection(input, options);
    assert.equal(store.connectionAuthority(input.id), original);
    store.upsertConnection({ ...input, credentialToken: 'synthetic-second' }, options);
    assert.equal(store.connectionAuthority(input.id), original + 1);
    assert.equal(store.getCredentialToken(input.id), 'synthetic-second');
    store.upsertConnection({ ...input, connectorUrl: 'http://changed.invalid', credentialToken: 'synthetic-second' }, options);
    assert.equal(store.connectionAuthority(input.id), original + 2);
    store.upsertConnection(input);
    const explicit = store.connectionAuthority(input.id)!;
    store.upsertConnection(input);
    assert.equal(store.connectionAuthority(input.id), explicit + 1, 'explicit edits retain the authority fence');
    store.deleteConnection(input.id);
    const deleted = explicit + 2;
    store.upsertConnection(input, options);
    assert.equal(store.connectionAuthority(input.id), deleted + 1, 'recreated aliases cannot reuse deleted authority');
  } finally { await fx.cleanup(); }
});

test('display-only renaming preserves identity, credentials and execution authority across restart', async (t) => {
  const fx = createHubStoreFixture(t);
  const file = join(fx.createRoot('agentopsdeck-labels-'), 'hub.sqlite');
  let store = fx.openStore(file, 'synthetic');
  try {
    store.upsertConnection({ id: 'stable-id', label: 'Old Agent name', environmentId: 'stable-env', connectorUrl: 'http://fixture.invalid', credentialToken: 'synthetic-secret' });
    const authority = store.connectionAuthority('stable-id');
    assert.equal(store.renameConnection('stable-id', { label: 'Foreign' }, 'other'), undefined);
    store.renameConnection('stable-id', { label: ' Workstation ', environmentLabel: ' Workstation ' });
    assert.equal(store.connectionAuthority('stable-id'), authority);
    assert.equal(store.getCredentialToken('stable-id'), 'synthetic-secret');
    await fx.closeStore(store); store = fx.openStore(file, 'synthetic');
    assert.equal(store.getConnection('stable-id')?.label, 'Workstation');
    assert.equal(store.getConnection('stable-id')?.environmentLabel, 'Workstation');
    assert.equal(store.getConnection('stable-id')?.environmentId, 'stable-env');
    assert.equal(store.connectionAuthority('stable-id'), authority);
    store.deleteConnection('stable-id');
    assert.equal(store.renameConnection('stable-id', { label: 'Resurrect' }), undefined);
  } finally { await fx.cleanup(); }
});

test('local bootstrap preserves a disabled connection and its durable authority across restart', async (t) => {
  const fx = createHubStoreFixture(t);
  const file = join(fx.createRoot('agentopsdeck-local-authority-'), 'hub.sqlite');
  let store = fx.openStore(file, 'synthetic');
  const input = { id: 'local', label: 'Local', connectorUrl: 'local://aod-connector', environmentId: 'local', environmentLabel: 'Local', status: 'enabled' as const };
  try {
    store.ensureLocalConnection(input);
    const original = store.connectionAuthority(input.id)!;
    store.ensureLocalConnection(input);
    assert.equal(store.connectionAuthority(input.id), original);
    store.upsertConnection({ ...input, status: 'disabled' });
    const disabled = store.connectionAuthority(input.id)!;
    await fx.closeStore(store); store = fx.openStore(file, 'synthetic');
    store.ensureLocalConnection(input);
    assert.equal(store.getConnection(input.id)?.status, 'disabled');
    assert.equal(store.connectionAuthority(input.id), disabled);
  } finally { await fx.cleanup(); }
});

test('node pin is durable, owner scoped and CAS bound; alias/config changes cannot replace it', async (t) => {
  const fx = createHubStoreFixture(t);
  const file = join(fx.createRoot('agentopsdeck-node-pin-'), 'hub.sqlite');
  let store = fx.openStore(file, 'synthetic');
  const node = 'node_00000000-0000-4000-8000-000000000001', other = 'node_00000000-0000-4000-8000-000000000002';
  const input = { id: 'alias', label: 'node', connectorUrl: 'http://synthetic.invalid' };
  try {
    store.upsertConnection(input);
    const user = store.createUser('member');
    store.upsertConnection({ ...input, ownerUserId: user.id });
    const version = store.connectionAuthority('alias')!;
    assert.throws(() => store.pinConnectionNode('alias', 'missing', version, node));
    assert.throws(() => store.pinConnectionNode('alias', 'default', version, 'invalid'));
    assert.equal(store.pinConnectionNode('alias', 'default', version, node).nodeId, node);
    assert.equal(store.connectionAuthority('alias'), version + 1);
    assert.throws(() => store.pinConnectionNode('alias', 'default', version, node));
    store.pinConnectionNode('alias', 'default', version + 1, node);
    assert.equal(store.connectionAuthority('alias'), version + 1, 'same pin does not invalidate active clients');
    assert.equal(store.getConnection('alias', user.id)?.nodeId, undefined);
    store.pinConnectionNode('alias', user.id, store.connectionAuthority('alias', user.id)!, other);
    store.upsertConnection({ ...input, connectorUrl: 'http://moved.invalid', credentialToken: 'synthetic' });
    assert.equal(store.getConnection('alias')?.nodeId, node);
    assert.throws(() => store.pinConnectionNode('alias', 'default', store.connectionAuthority('alias')!, other));
    store.deleteConnection('alias');
    store.upsertConnection(input);
    assert.equal(store.getConnection('alias')?.nodeId, node);
    await fx.closeStore(store); store = fx.openStore(file, 'synthetic');
    assert.equal(store.getConnection('alias')?.nodeId, node);
    store.upsertConnection({ ...input, status: 'disabled' });
    assert.throws(() => store.pinConnectionNode('alias', 'default', store.connectionAuthority('alias')!, node));
  } finally { await fx.cleanup(); }
});

test('Hub preferences are durable and isolated by user and node, including explicit false', async (t) => {
  const fx = createHubStoreFixture(t);
  const file = join(fx.createRoot('agentopsdeck-prefs-'), 'hub.sqlite');
  const store = fx.openStore(file, 'synthetic');
  try {
    const user = store.createUser('Second user');
    const a = encodeHubSessionId('a', 'same-session');
    const b = encodeHubSessionId('b', 'same-session');
    store.setSessionPreference(a, 'pinned', true);
    store.setSessionPreference(a, 'pinned', false, user.id);
    store.setSessionPreference(b, 'hidden', true, user.id);
    await fx.closeStore(store);
    const restored = fx.openStore(file, 'synthetic');
    assert.deepEqual([...restored.sessionPreferences()], [[a, { pinned: true }]]);
    assert.deepEqual(restored.sessionPreferences(user.id).get(a), { pinned: false });
    assert.deepEqual(restored.sessionPreferences(user.id).get(b), { hidden: true });
    restored.removeSessionPreferences(a);
    assert.equal(restored.sessionPreferences().size, 0);
    assert.equal(restored.sessionPreferences(user.id).size, 2);
  } finally { await fx.cleanup(); }
});

test('legacy preferences import only canonical Hub IDs, once, without overwriting explicit choices or source files', async (t) => {
  const fx = createHubStoreFixture(t);
  const dir = fx.createRoot('agentopsdeck-prefs-import-');
  const store = fx.openStore(join(dir, 'hub.sqlite'), 'synthetic');
  const id = encodeHubSessionId('node', 'agent:dev:session');
  const files = { hidden: join(dir, 'hidden.json'), archived: join(dir, 'archived.json'), pinned: join(dir, 'pinned.json') };
  const source = JSON.stringify([id, 'agent:dev:session']);
  writeFileSync(files.hidden, source);
  writeFileSync(files.archived, JSON.stringify({ [id]: true }));
  writeFileSync(files.pinned, 'invalid JSON');
  try {
    assert.throws(() => store.importLegacySessionPreferences(files), /Invalid legacy pinned/);
    assert.equal(store.sessionPreferences().size, 0);
    store.setSessionPreference(id, 'hidden', false);
    writeFileSync(files.pinned, JSON.stringify([id]));
    store.importLegacySessionPreferences(files);
    assert.deepEqual([...store.sessionPreferences()], [[id, { hidden: false, archived: true, pinned: true }]]);
    assert.equal(readFileSync(files.hidden, 'utf8'), source);
    store.setSessionPreference(id, 'pinned', false);
    store.importLegacySessionPreferences(files);
    assert.equal(store.sessionPreferences().get(id)?.pinned, false);
  } finally { await fx.cleanup(); }
});

test('hub store creates sqlite schema and persists the default local connection', async (t) => {
  const fx = createHubStoreFixture(t);
  const root = fx.createRoot('agentopsdeck-hub-');
  const db = join(root, 'hub.sqlite');
  const store = fx.openStore(db, 'vault-secret');
  try {
    store.ensureLocalConnection({
      id: 'local',
      label: 'Local Connector',
      connectorUrl: 'local://aod-connector',
      environmentId: 'local-env',
      environmentLabel: 'Local OpenClaw',
      status: 'enabled',
    });

    assert.equal(existsSync(db), true);
    const connections = store.listConnections();
    assert.equal(connections.length, 1);
    assert.equal(connections[0]?.kind, 'local');
    assert.equal(connections[0]?.environmentId, 'local-env');
    assert.equal(connections[0]?.hasCredential, false);
  } finally {
    await fx.cleanup();
  }
  assert.equal(existsSync(root), false);
});

test('hub store encrypts remote connector tokens and returns redacted connections', async (t) => {
  const fx = createHubStoreFixture(t);
  const root = fx.createRoot('agentopsdeck-hub-');
  const db = join(root, 'hub.sqlite');
  const token = 'aod_conn_super_secret_token';
  const store = fx.openStore(db, 'vault-secret');
  try {
    const connection = store.upsertConnection({
      id: 'remote-one',
      label: 'Remote One',
      connectorUrl: 'https://remote.example.com/',
      environmentId: 'remote-env',
      environmentLabel: 'Remote Env',
      capabilities: ['sessions', 'messages'],
      credentialToken: token,
    });

    assert.equal(connection.connectorUrl, 'https://remote.example.com');
    assert.equal(connection.hasCredential, true);
    assert.equal(JSON.stringify(connection).includes(token), false);
    assert.equal(readFileSync(db, 'utf8').includes(token), false);
    assert.equal(store.getCredentialToken('remote-one'), token);

    await fx.closeStore(store);
    const reloaded = fx.openStore(db, 'vault-secret');
    assert.equal(reloaded.getConnection('remote-one')?.hasCredential, true);
    assert.equal(reloaded.getCredentialToken('remote-one'), token);
  } finally {
    await fx.cleanup();
  }
  assert.equal(existsSync(root), false);
});

test('hub store encrypts maintenance credential separately and never exposes plaintext in public rows', async (t) => {
  const fx = createHubStoreFixture(t);
  const root = fx.createRoot('agentopsdeck-hub-');
  const db = join(root, 'hub.sqlite');
  const dailyToken = 'daily-token-secret';
  const maintenanceToken = 'maintenance-token-secret';
  const store = fx.openStore(db, 'vault-secret');
  try {
    const connection = store.upsertConnection({
      id: 'remote-maintenance',
      label: 'Remote Maintenance',
      connectorUrl: 'https://remote.example.com',
      credentialToken: dailyToken,
    });

    store.updateMaintenanceCredential(connection.id, maintenanceToken);

    assert.equal(store.getCredentialToken(connection.id), dailyToken);
    assert.equal(store.getMaintenanceCredentialToken(connection.id), maintenanceToken);
    assert.equal(JSON.stringify(store.getConnection(connection.id)).includes(maintenanceToken), false);
    const rawDb = readFileSync(db, 'utf8');
    assert.equal(rawDb.includes(dailyToken), false);
    assert.equal(rawDb.includes(maintenanceToken), false);
  } finally {
    await fx.cleanup();
  }
  assert.equal(existsSync(root), false);
});

test('hub store refuses to delete the local connection but soft-deletes remote ones', async (t) => {
  const fx = createHubStoreFixture(t);
  const root = fx.createRoot('agentopsdeck-hub-');
  const db = join(root, 'hub.sqlite');
  const store = fx.openStore(db, 'vault-secret');
  try {
    store.ensureLocalConnection({ id: 'local', label: 'Local', connectorUrl: 'local://aod-connector', environmentId: 'local', environmentLabel: 'Local', status: 'enabled' });
    store.upsertConnection({ id: 'remote-one', label: 'Remote', connectorUrl: 'https://remote.example.com' });

    assert.equal(store.deleteConnection('local'), false);
    assert.equal(store.deleteConnection('remote-one'), true);
    assert.equal(store.getConnection('local')?.kind, 'local');
    assert.equal(store.getConnection('remote-one'), undefined);
    assert.equal(store.getCredentialToken('remote-one'), undefined);
  } finally {
    await fx.cleanup();
  }
  assert.equal(existsSync(root), false);
});

test('absent vault secret provisions an owner-private key file, preserves reopen decryption and rejects public fallback decryption', async (t) => {
  const fx = createHubStoreFixture(t);
  const root = fx.createRoot('agentopsdeck-private-vault-');
  const db = join(root, 'hub.sqlite');
  const vaultKeyPath = `${db}.vault-key`;
  const publicLegacyKey = createHash('sha256').update('agentopsdeck-local-development-vault-key', 'utf8').digest();
  let store = fx.openStore(db, undefined);
  try {
    assert.equal(existsSync(vaultKeyPath), true);
    const keyStat = statSync(vaultKeyPath);
    assert.equal(keyStat.size, 32);
    if (process.platform !== 'win32') assert.equal(keyStat.mode & 0o077, 0);

    store.upsertConnection({
      id: 'remote-private',
      label: 'Remote Private',
      connectorUrl: 'https://remote.example.com',
      credentialToken: 'synthetic-private-token',
    });
    assert.equal(store.getCredentialToken('remote-private'), 'synthetic-private-token');

    const row = (store as any).db.prepare(`
      SELECT encrypted_token, nonce, auth_tag FROM env_credentials WHERE connection_id = 'remote-private'
    `).get() as { encrypted_token: string; nonce: string; auth_tag: string };
    assert.throws(() => {
      const decipher = createDecipheriv('aes-256-gcm', publicLegacyKey, Buffer.from(row.nonce, 'base64url'));
      decipher.setAuthTag(Buffer.from(row.auth_tag, 'base64url'));
      Buffer.concat([decipher.update(Buffer.from(row.encrypted_token, 'base64url')), decipher.final()]);
    });

    await fx.closeStore(store);
    store = fx.openStore(db, undefined);
    assert.equal(store.getCredentialToken('remote-private'), 'synthetic-private-token');
  } finally {
    await fx.cleanup();
  }
  assert.equal(existsSync(root), false);
});

test('absent vault secret migrates legacy default-key rows once and fails closed on undecryptable secrets or unsafe key files', async (t) => {
  const fx = createHubStoreFixture(t);
  const legacyRoot = fx.createRoot('agentopsdeck-legacy-vault-');
  const legacyDb = join(legacyRoot, 'hub.sqlite');
  const legacyVaultKey = `${legacyDb}.vault-key`;
  try {
    let seeded = fx.openStore(legacyDb, 'agentopsdeck-local-development-vault-key');
    seeded.upsertConnection({
      id: 'legacy-conn',
      label: 'Legacy Conn',
      connectorUrl: 'https://legacy.example.com',
      credentialToken: 'synthetic-legacy-token',
    });
    await fx.closeStore(seeded);
    assert.equal(existsSync(legacyVaultKey), false);

    const migrated = fx.openStore(legacyDb, undefined);
    assert.equal(existsSync(legacyVaultKey), true);
    assert.equal(migrated.getCredentialToken('legacy-conn'), 'synthetic-legacy-token');
    await fx.closeStore(migrated);

    if (process.platform !== 'win32') {
      chmodSync(legacyVaultKey, 0o644);
      assert.throws(() => fx.openStore(legacyDb, undefined), /owner-private safety checks/);
      const release = startupDatabaseOwners.reserveExclusive(legacyDb);
      release();
      chmodSync(legacyVaultKey, 0o600);
    }

    unlinkSync(legacyVaultKey);
    const decoy = join(legacyRoot, 'decoy.key');
    writeFileSync(decoy, Buffer.alloc(32, 7), { mode: 0o600 });
    symlinkSync(decoy, legacyVaultKey);
    assert.throws(() => fx.openStore(legacyDb, undefined));
    unlinkSync(legacyVaultKey);

    // Without the provisioned .vault-key, rows encrypted under a different secret fail closed and release db ownership.
    assert.throws(() => fx.openStore(legacyDb, undefined), /require the original AOD_HUB_VAULT_SECRET/);
    const releaseAfterFailClosed = startupDatabaseOwners.reserveExclusive(legacyDb);
    releaseAfterFailClosed();

    // In-memory absent-secret instances use ephemeral non-public random keys.
    const memoryStore = fx.openStore(':memory:', undefined);
    memoryStore.upsertConnection({
      id: 'mem-conn',
      label: 'Memory Conn',
      connectorUrl: 'https://memory.example.com',
      credentialToken: 'synthetic-memory-token',
    });
    const memRow = (memoryStore as any).db.prepare(`
      SELECT encrypted_token, nonce, auth_tag FROM env_credentials WHERE connection_id = 'mem-conn'
    `).get() as { encrypted_token: string; nonce: string; auth_tag: string };
    const publicLegacyKey = createHash('sha256').update('agentopsdeck-local-development-vault-key', 'utf8').digest();
    assert.throws(() => {
      const decipher = createDecipheriv('aes-256-gcm', publicLegacyKey, Buffer.from(memRow.nonce, 'base64url'));
      decipher.setAuthTag(Buffer.from(memRow.auth_tag, 'base64url'));
      Buffer.concat([decipher.update(Buffer.from(memRow.encrypted_token, 'base64url')), decipher.final()]);
    });
  } finally {
    await fx.cleanup();
  }
  assert.equal(existsSync(legacyRoot), false);
});
