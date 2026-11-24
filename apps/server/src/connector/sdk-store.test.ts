import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { ConnectorUserStore } from './connector-user-store.js';

for (const runtime of ['claude-code', 'ghcp'] as const) {
  test(`${runtime}: shared store deletion/settings fences include queued, accepted and unknown SDK work`, () => {
    const store = new ConnectorUserStore(':memory:');
    try {
      const journal = runtime === 'ghcp' ? store.copilotJournal : store.claudeJournal;
      const key = `${runtime}:session`, ref = { key, id: 'run', epoch: 'epoch' };
      journal.create({ key, nativeSessionId: 'native', title: 'Fixture', createdAt: 0 });
      assert.equal(store.canDeleteSession(key), true);
      assert.equal(store.canChangeSettings(key), true);
      store.turns.enqueue(runtime, { id: 'one', sessionKey: key, createdAt: 0, payload: {} });
      assert.equal(store.canDeleteSession(key), false);
      // A model change must not silently retarget already queued input.
      assert.equal(store.canChangeSettings(key), false);
      journal.begin(ref, ['one'], store.turns);
      assert.equal(store.canChangeSettings(key), false);
      journal.acknowledge(ref, 'native-request', store.turns);
      assert.equal(store.turns.hasPending(runtime, key), false);
      assert.equal(store.canDeleteSession(key), false);
      assert.equal(store.canChangeSettings(key), false);
      journal.observeTerminal(ref, 'completed', store.turns);
      assert.equal(store.canChangeSettings(key), false);
      journal.confirmSettled(ref);
      assert.equal(store.canDeleteSession(key), true);
      assert.equal(store.canChangeSettings(key), true);
      assert.equal(store.canDeleteSession('codex:unrelated'), true);
    } finally { store.close(); }
  });

  test(`${runtime}: management store opens preserve state; exclusive runtime restart freezes without resending`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-sdk-store-')), file = join(root, 'store.sqlite');
    let store = new ConnectorUserStore(file);
    const journal = () => runtime === 'ghcp' ? store.copilotJournal : store.claudeJournal;
    const key = `${runtime}:session`, ref = { key, id: 'run', epoch: 'epoch' };
    try {
      journal().create({ key, nativeSessionId: 'native', title: 'Fixture', createdAt: 0 });
      await store.turns.enqueueAsync(runtime, { id: 'one', sessionKey: key, createdAt: 0, payload: {} });
      journal().begin(ref, ['one'], store.turns);
      store.close(); store = new ConnectorUserStore(file);
      assert.equal(journal().current(key)?.phase, 'dispatching');
      store.close(); store = new ConnectorUserStore(file, undefined, { runtimeOwner: true });
      assert.equal(journal().current(key)?.phase, 'unknown');
      assert.equal(store.turns.head(runtime, key)?.state, 'outcome_unknown');
      assert.equal(store.canDeleteSession(key), false);
      assert.equal(store.canChangeSettings(key), false);
      assert.equal(journal().pendingCount(), 1);
    } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  });
}

test('SDK first-session migration prevents old startup writers without fencing disabled installations', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-sdk-migration-')), file = join(root, 'store.sqlite');
  let store = new ConnectorUserStore(file);
  // Equivalent old-release startup connection: knows only the existing writer
  // function and always INSERTs the default user, even if it already exists.
  const oldOpen = () => {
    const db = new DatabaseSync(file);
    db.function('agentopsdeck_connector_writer_epoch', { deterministic: true }, () => 1);
    return db;
  };
  const startupInsert = (db: DatabaseSync) => db.prepare(`INSERT INTO connector_users(id, label, created_at, updated_at)
    VALUES ('default', 'Default connector account', 0, 0) ON CONFLICT(id) DO NOTHING`).run();
  try {
    store.close();
    let old = oldOpen();
    try { assert.doesNotThrow(() => startupInsert(old)); } finally { old.close(); }
    store = new ConnectorUserStore(file);
    assert.throws(() => store.claudeJournal.create({ key: 'codex:wrong', nativeSessionId: 'native', title: 'Wrong', createdAt: 0 }));
    store.close(); old = oldOpen();
    try { assert.doesNotThrow(() => startupInsert(old)); } finally { old.close(); }
    store = new ConnectorUserStore(file);
    store.claudeJournal.create({ key: 'claude-code:new', nativeSessionId: 'native', title: 'New', createdAt: 0 });
    store.close(); old = oldOpen();
    try {
      assert.throws(() => startupInsert(old), /agentopsdeck_connector_sdk_writer_epoch/);
      old.function('agentopsdeck_connector_sdk_writer_epoch', { deterministic: true }, () => 0);
      assert.throws(() => startupInsert(old), /Incompatible SDK-runtime writer/);
    } finally { old.close(); }
    store = new ConnectorUserStore(file, undefined, { runtimeOwner: true });
    assert.equal(store.claudeJournal.session('claude-code:new')?.nativeSessionId, 'native');
    assert.ok(store.getUser('default'));
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('SDK session creation rolls its writer migration back on persistence failure', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-sdk-migration-')), file = join(root, 'store.sqlite');
  let store = new ConnectorUserStore(file);
  store.close();
  const db = new DatabaseSync(file);
  try {
    db.exec("CREATE TRIGGER reject_sdk_insert BEFORE INSERT ON sdk_agent_sessions BEGIN SELECT RAISE(ABORT, 'fixture disk failure'); END");
    store = new ConnectorUserStore(file);
    assert.throws(() => store.copilotJournal.create({ key: 'ghcp:new', nativeSessionId: 'native', title: 'New', createdAt: 0 }), /fixture disk failure/);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'connector_sdk_writer_compatibility'").get(), undefined);
    assert.equal(store.copilotJournal.session('ghcp:new'), undefined);
  } finally { store.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});
