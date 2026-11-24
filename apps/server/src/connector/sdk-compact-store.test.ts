import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { ConnectorUserStore } from './connector-user-store.js';
import type { SdkAgentId } from './sdk-execution-journal.js';

function ready(store: ConnectorUserStore, runtime: SdkAgentId) {
  const key = `${runtime}:fixture`;
  store.turns.enqueue(runtime, { id: 'first', sessionKey: key, createdAt: 0, payload: {} });
  return finishReady(store, runtime);
}

async function readyAsync(store: ConnectorUserStore, runtime: SdkAgentId) {
  const key = `${runtime}:fixture`;
  await store.turns.enqueueAsync(runtime, { id: 'first', sessionKey: key, createdAt: 0, payload: {} });
  return finishReady(store, runtime);
}

function finishReady(store: ConnectorUserStore, runtime: SdkAgentId) {
  const journal = runtime === 'ghcp' ? store.copilotJournal : store.claudeJournal;
  const key = `${runtime}:fixture`, first = { key, id: 'first', epoch: 'old' };
  journal.create({ key, nativeSessionId: 'native', title: 'Fixture', createdAt: 0 });
  assert.ok(journal.begin(first, ['first'], store.turns));
  assert.ok(journal.observeTerminal(first, 'completed', store.turns));
  assert.ok(journal.confirmSettled(first));
  return journal;
}

for (const runtime of ['claude-code', 'ghcp'] as const) {
  test(`${runtime}: owned compact obeys maintenance and settings/delete receipts in both directions`, () => {
    const store = new ConnectorUserStore(':memory:', undefined, { runtimeOwner: true });
    try {
      const journal = ready(store, runtime), key = `${runtime}:fixture`, ref = { key, id: 'compact', epoch: 'epoch' };
      const begin = () => journal.beginCompact(ref, 'owner', store.turns, () => {});
      const resume = store.pauseTurnStarts();
      assert.equal(begin(), undefined);
      assert.ok(resume());
      for (const operation of ['settings', 'delete']) {
        const scope = JSON.stringify([operation, JSON.stringify(['owner', key])]);
        store.commands.claim(scope, operation, {});
        assert.equal(begin(), undefined, operation);
        store.commands.settle(scope, operation, { status: 409, body: {} });
      }
      assert.ok(begin());
      assert.equal(store.canChangeSettings(key), false);
      assert.equal(store.canDeleteSession(key), false);
      store.pauseTurnStarts();
      const nativeRef = { ...ref, nativeSessionId: 'native' };
      assert.ok(journal.observeCompactTerminal(nativeRef, { nativeRequestId: 'rpc', completionEventId: 'boundary', outcome: 'completed' }));
      assert.ok(journal.confirmCompactSettled({ ...nativeRef, completionEventId: 'boundary', historyPersisted: true, nativeQuiescent: true }),
        'maintenance blocks admission but allows in-flight settlement');
      assert.equal(journal.pendingCount(), 0);
      store.stopTurnStarts();
      assert.equal(begin(), undefined);
    } finally { store.close(); }
  });

  for (const phase of ['dispatching', 'settling', 'stop-requested'] as const) {
    test(`${runtime}: reopening ${phase} compact preserves exact identity and fences without queue replay`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-compact-store-')), file = join(root, 'store.sqlite');
      let store = new ConnectorUserStore(file, undefined, { runtimeOwner: true });
      const journal = () => runtime === 'ghcp' ? store.copilotJournal : store.claudeJournal;
      const key = `${runtime}:fixture`, ref = { key, id: 'compact', epoch: 'epoch', nativeSessionId: 'native' };
      try {
        await readyAsync(store, runtime);
        assert.ok(journal().beginCompact(ref, 'owner', store.turns, () => {}));
        if (phase === 'settling') assert.ok(journal().observeCompactTerminal(ref,
          { nativeRequestId: 'rpc', completionEventId: 'boundary', outcome: 'completed' }));
        if (phase === 'stop-requested') assert.ok(journal().requestCompactStop(ref));
        await store.turns.enqueueAsync(runtime, { id: 'next', sessionKey: key, createdAt: 0, payload: { text: 'do not replay' } });
        const before = journal().current(key)!;
        store.close(); store = new ConnectorUserStore(file);
        assert.deepEqual(journal().current(key), before, 'management open must not perform recovery');
        assert.equal(journal().beginCompact({ ...ref, id: 'management' }, 'owner', store.turns, () => {}), undefined);
        store.close(); store = new ConnectorUserStore(file, undefined, { runtimeOwner: true });
        const current = journal().current(key)!;
        assert.equal(current.phase, 'unknown');
        assert.equal(current.kind, 'compact');
        assert.equal(current.id, before.id); assert.equal(current.epoch, before.epoch);
        assert.equal(current.nativeSessionId, before.nativeSessionId);
        assert.deepEqual(current.control, before.control);
        assert.equal(current.stopRequested, before.stopRequested);
        assert.equal(journal().pendingCount(), 1);
        assert.equal(store.turns.head(runtime, key)?.id, 'next');
        assert.equal(store.turns.head(runtime, key)?.state, 'queued');
        assert.equal(store.canChangeSettings(key), false);
        assert.equal(store.canDeleteSession(key), false);
      } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
    });
  }
}

test('SDK control fence is lazy, transactionally rolled back, and rejects message-only writers after first control', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-compact-writer-')), file = join(root, 'store.sqlite');
  let store = new ConnectorUserStore(file, undefined, { runtimeOwner: true });
  let storeOpen = true;
  const close = () => { if (storeOpen) { store.close(); storeOpen = false; } };
  const reopen = (runtimeOwner = false) => { close(); store = new ConnectorUserStore(file, undefined, { runtimeOwner }); storeOpen = true; };
  const ref = { key: 'claude-code:fixture', id: 'compact', epoch: 'epoch' };
  const oldOpen = () => {
    const db = new DatabaseSync(file);
    db.function('agentopsdeck_connector_writer_epoch', { deterministic: true }, () => 1);
    db.function('agentopsdeck_connector_sdk_writer_epoch', { deterministic: true }, () => 1);
    return db;
  };
  const startup = (db: DatabaseSync) => db.prepare(`INSERT INTO connector_users VALUES ('default', 'Default', 0, 0)
    ON CONFLICT(id) DO NOTHING`).run();
  try {
    await readyAsync(store, 'claude-code');
    const scope = JSON.stringify(['compact', JSON.stringify(['owner', ref.key])]);
    await store.commands.claimAsync(scope, 'command', {});
    assert.throws(() => store.claudeJournal.beginCompact(ref, 'owner', store.turns, () => {
      store.commands.settle(scope, 'command', { status: 202, body: { id: ref.id } });
      throw new Error('fresh owner check failed');
    }), /fresh owner check failed/);
    close();
    let old = oldOpen();
    try {
      assert.equal(old.prepare("SELECT 1 FROM sqlite_master WHERE name = 'connector_sdk_control_writer_compatibility'").get(), undefined);
      assert.equal((old.prepare("SELECT state FROM command_receipts WHERE command_key = 'command'").get() as { state: string }).state, 'outcome_unknown');
      assert.doesNotThrow(() => startup(old));
    } finally { old.close(); }
    reopen();
    assert.equal(store.claudeJournal.beginCompact(ref, 'owner', store.turns, () => {}), undefined, 'management store cannot launch controls even when idle');
    reopen(true);
    assert.ok(store.claudeJournal.beginCompact(ref, 'owner', store.turns, () => {
      store.commands.settle(scope, 'command', { status: 202, body: { id: ref.id } });
    }));
    close(); old = oldOpen();
    try {
      assert.throws(() => startup(old), /agentopsdeck_connector_sdk_control_writer_epoch/);
      old.function('agentopsdeck_connector_sdk_control_writer_epoch', { deterministic: true }, () => 0);
      assert.throws(() => startup(old), /Incompatible SDK-control writer/);
      assert.equal((old.prepare("SELECT state FROM command_receipts WHERE command_key = 'command'").get() as { state: string }).state, 'accepted');
    } finally { old.close(); }
    reopen(true);
    assert.equal(store.claudeJournal.current(ref.key)?.phase, 'unknown');
  } finally { close(); rmSync(root, { recursive: true, force: true }); }
});

test('tampered SDK-control writer fence fails closed on store open', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-compact-fence-')), file = join(root, 'store.sqlite');
  const store = new ConnectorUserStore(file); store.close();
  const db = new DatabaseSync(file);
  try { db.exec('CREATE TRIGGER connector_sdk_control_writer_compatibility BEFORE INSERT ON connector_users BEGIN SELECT 1; END'); }
  finally { db.close(); }
  try { assert.throws(() => new ConnectorUserStore(file), /Invalid SDK-control writer compatibility fence/); }
  finally { rmSync(root, { recursive: true, force: true }); }
});
