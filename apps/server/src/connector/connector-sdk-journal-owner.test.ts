import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Worker } from 'node:worker_threads';
import { ConnectorUserStore } from './connector-user-store.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { SDK_JOURNAL_SNAPSHOT_BYTES, type SdkAgentId } from './sdk-execution-journal.js';
import { connectorSdkJournalSteps, executeConnectorSdkJournal, validConnectorSdkJournalInput,
  validConnectorSdkJournalOutput, validSdkJournalSnapshot } from './connector-sdk-journal-domain.js';
import { connectorOwnerCommandBytes, createConnectorOwnerCommands, encodeConnectorOwnerJson } from './connector-owner-domain.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const silent = new PerformanceDiagnostics(() => {});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const empty = { session: null, execution: null, deletion: null, canStart: false, unresolved: false };
function fixture(runtime: SdkAgentId) {
  const store = new ConnectorUserStore(':memory:', undefined, { runtimeOwner: true });
  const journal = runtime === 'claude-code' ? store.claudeJournal : store.copilotJournal;
  const key = `${runtime}:session`, ref = { key, id: 'execution', epoch: 'epoch', nativeSessionId: 'native' };
  journal.create({ key, nativeSessionId: 'native', title: 'Original session', createdAt: 0 });
  const begin = () => {
    store.turns.enqueue(runtime, { id: 'original-command', sessionKey: key, createdAt: 0, payload: { text: 'private', images: [] } });
    assert.ok(journal.begin(ref, ['original-command'], store.turns));
  };
  const scope = { runtime, ref };
  const db = (store as unknown as { db: DatabaseSync }).db;
  return { store, journal, key, ref, scope, db, begin };
}

test('SDK protocol is append-only and has no unreceipted creation/settings/deletion/admission commands', () => {
  assert.deepEqual(Object.values(connectorSdkJournalSteps), Array.from({ length: 12 }, (_, i) => i + 64));
  for (const kind of Object.keys(connectorSdkJournalSteps)) assert.doesNotMatch(kind, /Begin|Create|Delete|Model|Recover/);
  for (const runtime of ['codex', 'hermes', '']) assert.equal(validConnectorSdkJournalInput('sdkPendingCount', { runtime }), false);
  for (const extra of ['sql', 'authorized', 'callback', 'dispatch', 'replay']) {
    assert.equal(validConnectorSdkJournalInput('sdkPendingCount', { runtime: 'ghcp', [extra]: true }), false);
  }
  for (const limit of [0, 65, 1.2, Infinity]) assert.equal(validConnectorSdkJournalInput('sdkSessionPage', { runtime: 'ghcp', after: '', limit }), false);
  for (const after of ['claude-code:other', 'ghcp:', 'ghcp:bad\nkey']) assert.equal(validConnectorSdkJournalInput('sdkSessionPage', { runtime: 'ghcp', after, limit: 1 }), false);
  assert.equal(validConnectorSdkJournalInput('sdkSnapshotRead', { runtime: 'ghcp', key: 'ghcp: untrimmed ' }), true);
  assert.equal(validConnectorSdkJournalOutput('sdkSnapshotRead', empty), true);
  assert.equal(validConnectorSdkJournalOutput('sdkSnapshotRead', { ...empty, repair: true }), false);
});

for (const runtime of ['claude-code', 'ghcp'] as const) {
  test(`${runtime}: bounded original snapshot keeps legacy native state unknown without rewriting`, () => {
    const f = fixture(runtime);
    try {
      assert.equal(f.journal.readSnapshot(f.key).canStart, true);
      assert.deepEqual(f.journal.readSnapshot(`${runtime}:missing`), empty);
      f.db.prepare("UPDATE sdk_agent_sessions SET data = json_remove(data, '$.nativeState') WHERE runtime = ?").run(runtime);
      const before = f.db.prepare('SELECT data FROM sdk_agent_sessions WHERE runtime = ?').get(runtime);
      const snapshot = executeConnectorSdkJournal('sdkSnapshotRead', { runtime, key: f.key }, f.store);
      assert.equal(snapshot.session?.nativeState, 'unknown'); assert.equal(snapshot.canStart, false); assert.equal(snapshot.unresolved, true);
      assert.deepEqual(f.db.prepare('SELECT data FROM sdk_agent_sessions WHERE runtime = ?').get(runtime), before);
      assert.equal(validSdkJournalSnapshot(snapshot), true);
      assert.throws(() => f.journal.readSnapshot('codex:other'), /unavailable/);
    } finally { f.store.close(); }
  });
  test(`${runtime}: ordinary ACK/terminal/independent settlement preserve the original queue`, async () => {
    const f = fixture(runtime);
    try {
      f.begin(); const command = createConnectorOwnerCommands(f.store);
      assert.equal(await command('sdkExecutionAcknowledge', { ...f.scope, nativeRequestId: 'request' }), true);
      assert.equal(f.store.turns.hasPending(runtime, f.key), false);
      assert.equal(await command('sdkExecutionAcknowledge', { ...f.scope, nativeRequestId: 'request' }), true);
      assert.equal(await command('sdkExecutionAcknowledge', { ...f.scope, nativeRequestId: 'other-request' }), false);
      assert.equal(await command('sdkExecutionTerminal', { ...f.scope, outcome: 'completed' }), true);
      for (const [historyPersisted, nativeQuiescent] of [[false, false], [false, true], [true, false]]) {
        assert.equal(await command('sdkExecutionSettle', { ...f.scope, historyPersisted: historyPersisted!, nativeQuiescent: nativeQuiescent! }), false);
        assert.equal(f.journal.current(f.key)?.phase, 'settling'); assert.equal(f.journal.readSnapshot(f.key).canStart, false);
      }
      assert.equal(await command('sdkExecutionSettle', { ...f.scope, historyPersisted: true, nativeQuiescent: true }), true);
      assert.equal(f.journal.current(f.key)?.phase, 'completed'); assert.equal(f.journal.readSnapshot(f.key).canStart, true);
    } finally { f.store.close(); }
  });
  test(`${runtime}: stale execution/native/epoch observation cannot acknowledge or settle another execution`, () => {
    const f = fixture(runtime);
    try {
      f.begin(); const before = f.journal.readSnapshot(f.key);
      for (const patch of [{ id: 'old' }, { epoch: 'old' }, { nativeSessionId: 'other-native' }, { key: `${runtime}:missing` }]) {
        assert.equal(executeConnectorSdkJournal('sdkExecutionAcknowledge', { ...f.scope, ref: { ...f.ref, ...patch }, nativeRequestId: 'request' }, f.store), false);
        assert.equal(executeConnectorSdkJournal('sdkExecutionUnknown', { ...f.scope, ref: { ...f.ref, ...patch } }, f.store), false);
      }
      assert.deepEqual(f.journal.readSnapshot(f.key), before);
      assert.equal(f.store.turns.head(runtime, f.key)?.state, 'dispatching');
    } finally { f.store.close(); }
  });
  test(`${runtime}: original queue participant failure rolls back ACK and journal together`, () => {
    const f = fixture(runtime);
    try {
      f.begin(); const before = f.journal.readSnapshot(f.key);
      f.store.turns.settleClaimedBatchInTransaction = () => { throw Error('fixture participant failed'); };
      assert.throws(() => executeConnectorSdkJournal('sdkExecutionAcknowledge', { ...f.scope, nativeRequestId: 'request' }, f.store), /participant failed/);
      assert.deepEqual(f.journal.readSnapshot(f.key), before); assert.equal(f.db.isTransaction, false);
      assert.equal(f.store.turns.head(runtime, f.key)?.state, 'dispatching');
    } finally { f.store.close(); }
  });
  test(`${runtime}: stop is not terminal; interrupted execution still needs independent settlement`, () => {
    const f = fixture(runtime);
    try {
      f.begin();
      assert.equal(executeConnectorSdkJournal('sdkExecutionTerminal', { ...f.scope, outcome: 'interrupted' }, f.store), false);
      assert.equal(executeConnectorSdkJournal('sdkExecutionAcknowledge', { ...f.scope, nativeRequestId: 'request' }, f.store), true);
      assert.equal(executeConnectorSdkJournal('sdkExecutionStop', f.scope, f.store), true);
      assert.equal(f.journal.current(f.key)?.phase, 'running'); assert.equal(f.journal.readSnapshot(f.key).unresolved, true);
      assert.equal(executeConnectorSdkJournal('sdkExecutionTerminal', { ...f.scope, outcome: 'interrupted' }, f.store), true);
      assert.equal(f.journal.current(f.key)?.phase, 'settling');
    } finally { f.store.close(); }
  });
  test(`${runtime}: unknown retains original queue outcome and cannot create resume authority`, () => {
    const f = fixture(runtime);
    try {
      f.begin(); assert.equal(executeConnectorSdkJournal('sdkExecutionUnknown', f.scope, f.store), true);
      assert.equal(f.store.turns.head(runtime, f.key)?.state, 'outcome_unknown');
      assert.equal(f.journal.readSnapshot(f.key).canStart, false);
      assert.equal(executeConnectorSdkJournal('sdkExecutionSettle', { ...f.scope, historyPersisted: true, nativeQuiescent: true }, f.store), false);
      assert.equal(executeConnectorSdkJournal('sdkPendingCount', { runtime }, f.store), 1);
    } finally { f.store.close(); }
  });
  test(`${runtime}: compact boundary and numeric metrics remain atomic and separately settled`, () => {
    const f = fixture(runtime);
    try {
      f.begin(); f.journal.observeTerminal(f.ref, 'completed', f.store.turns); f.journal.confirmSettled(f.ref);
      const ref = { ...f.ref, id: 'compact' }, scope = { runtime, ref };
      assert.ok(f.journal.beginCompact(ref, 'owner', f.store.turns, () => {}));
      assert.equal(executeConnectorSdkJournal('sdkCompactStop', { ...scope, ref: { ...ref, nativeSessionId: 'other' } }, f.store), false);
      const result = { nativeRequestId: 'compact-request', completionEventId: 'boundary', outcome: 'completed' as const };
      assert.equal(executeConnectorSdkJournal('sdkCompactTerminal', { ...scope, result }, f.store), true);
      assert.equal(f.journal.session(f.key)?.metrics?.compactionCount, 1);
      assert.equal(executeConnectorSdkJournal('sdkCompactTerminal', { ...scope, result }, f.store), false);
      for (const patch of [{ completionEventId: 'wrong' }, { historyPersisted: false }, { nativeQuiescent: false }]) {
        assert.equal(executeConnectorSdkJournal('sdkCompactSettle', { ...scope, completionEventId: 'boundary', historyPersisted: true, nativeQuiescent: true, ...patch }, f.store), false);
      }
      assert.equal(executeConnectorSdkJournal('sdkCompactSettle', { ...scope, completionEventId: 'boundary', historyPersisted: true, nativeQuiescent: true }, f.store), true);
      assert.equal(f.journal.session(f.key)?.metrics?.compactionCount, 1);
    } finally { f.store.close(); }
  });
  test(`${runtime}: metrics cannot acknowledge a command and duplicates/stale epochs do not change counts`, () => {
    const f = fixture(runtime);
    try {
      f.begin(); const sample = { eventId: 'metric', sequence: 1, usage: { scope: 'last-turn' as const, inputTokens: 12, outputTokens: 3 } };
      assert.equal(executeConnectorSdkJournal('sdkMetricsObserve', { ...f.scope, sample }, f.store), true);
      const before = f.journal.readSnapshot(f.key);
      assert.equal(executeConnectorSdkJournal('sdkMetricsObserve', { ...f.scope, sample }, f.store), false);
      assert.equal(executeConnectorSdkJournal('sdkMetricsObserve', { ...f.scope, ref: { ...f.ref, epoch: 'old' }, sample: { ...sample, sequence: 2 } }, f.store), false);
      assert.deepEqual(f.journal.readSnapshot(f.key), before); assert.equal(f.store.turns.head(runtime, f.key)?.state, 'dispatching');
    } finally { f.store.close(); }
  });
  test(`${runtime}: legacy message kind and exact saved batch metadata are retained`, () => {
    const f = fixture(runtime);
    try {
      const members = ['one', 'two'];
      for (const id of members) f.store.turns.enqueue(runtime, { id, sessionKey: f.key, createdAt: 0, payload: {} });
      // Keep the original accepted separator contract, not a stricter new UUID
      // parser that would reject a previously valid saved session.
      const batch = { separator: `\n\n[Queued message boundary ${'a'.repeat(36)}]\n\n`,
        members: members.map(id => ({ id, createdAt: 0, imageCount: 0 })) };
      f.journal.begin(f.ref, members, f.store.turns, batch);
      f.db.prepare("UPDATE sdk_agent_executions SET data = json_remove(data, '$.kind') WHERE runtime = ?").run(runtime);
      const snapshot = executeConnectorSdkJournal('sdkSnapshotRead', { runtime, key: f.key }, f.store);
      assert.equal(snapshot.execution?.kind, undefined); assert.deepEqual(snapshot.execution?.batch, batch);
      assert.equal(executeConnectorSdkJournal('sdkExecutionAcknowledge', { ...f.scope, nativeRequestId: 'request' }, f.store), true);
      assert.equal(f.store.turns.hasPending(runtime, f.key), false);
    } finally { f.store.close(); }
  });
  test(`${runtime}: aggregate snapshot limit and stored identity corruption do not become missing sessions`, () => {
    const f = fixture(runtime);
    try {
      f.begin();
      const rows = ['sdk_agent_sessions', 'sdk_agent_executions'].map(table => ({ table,
        data: (f.db.prepare(`SELECT data FROM ${table} WHERE runtime = ?`).get(runtime) as { data: string }).data }));
      for (const row of rows) f.db.prepare(`UPDATE ${row.table} SET data = ? WHERE runtime = ?`).run(row.data.padEnd(70_000, ' '), runtime);
      assert.throws(() => f.journal.readSnapshot(f.key), /unavailable/);
      for (const row of rows) f.db.prepare(`UPDATE ${row.table} SET data = ? WHERE runtime = ?`).run(row.data, runtime);
      f.db.prepare("UPDATE sdk_agent_sessions SET data = json_set(data, '$.key', ?) WHERE runtime = ?").run(`${runtime}:other`, runtime);
      assert.throws(() => executeConnectorSdkJournal('sdkSnapshotRead', { runtime, key: f.key }, f.store), /unavailable/);
      assert.throws(() => executeConnectorSdkJournal('sdkExecutionAcknowledge', { ...f.scope, nativeRequestId: 'request' }, f.store), /unavailable/);
      assert.equal(f.store.turns.head(runtime, f.key)?.state, 'dispatching');
    } finally { f.store.close(); }
  });
  for (const table of ['sdk_agent_sessions', 'sdk_agent_executions', 'sdk_agent_deletions']) {
    test(`${runtime}: ${table} invalid/oversized JSON fails closed, preserving the original bytes`, () => {
      const f = fixture(runtime);
      try {
        if (table === 'sdk_agent_executions') f.begin();
        if (table === 'sdk_agent_deletions') f.journal.beginDeletion(f.key, 'deletion');
        for (const body of ['{bad json', ' '.repeat(SDK_JOURNAL_SNAPSHOT_BYTES + 1), Buffer.from('blob')]) {
          f.db.prepare(`UPDATE ${table} SET data = ? WHERE runtime = ?`).run(body, runtime);
          assert.throws(() => executeConnectorSdkJournal('sdkSnapshotRead', { runtime, key: f.key }, f.store));
          assert.deepEqual((f.db.prepare(`SELECT data FROM ${table} WHERE runtime = ?`).get(runtime) as { data: unknown }).data,
            typeof body === 'string' ? body : new Uint8Array(body));
          assert.equal(f.db.isTransaction, false);
        }
      } finally { f.store.close(); }
    });
  }
  test(`${runtime}: actual sole worker reopen freezes unresolved work and pages only its original SDK sessions`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-sdk-owner-')), file = join(root, 'original.sqlite');
    let owner: AsyncConnectorOwner | undefined;
    try {
      const store = new ConnectorUserStore(file), key = `${runtime}:saved`;
      const journal = runtime === 'claude-code' ? store.claudeJournal : store.copilotJournal;
      journal.create({ key, nativeSessionId: 'saved-native', title: 'Saved', createdAt: 0 });
      await store.turns.enqueueAsync(runtime, { id: 'saved-command', sessionKey: key, createdAt: 0, payload: {} });
      journal.begin({ key, id: 'saved-execution', epoch: 'saved-epoch' }, ['saved-command'], store.turns);
      store.close();
      owner = new AsyncConnectorOwner({ file }, silent);
      assert.deepEqual(await owner.command('sdkSessionPage', { runtime, after: '', limit: 1 }), [key]);
      assert.deepEqual(await owner.command('sdkSessionPage', { runtime, after: key, limit: 1 }), []);
      const snapshot = await owner.command('sdkSnapshotRead', { runtime, key });
      assert.equal(snapshot.execution?.phase, 'unknown'); assert.equal(snapshot.session?.nativeState, 'unknown');
      assert.equal(snapshot.canStart, false); assert.equal(await owner.command('sdkPendingCount', { runtime }), 1);
      await owner.close(); owner = undefined;
      const reopened = new ConnectorUserStore(file);
      try { assert.equal(reopened.turns.head(runtime, key)?.state, 'outcome_unknown'); } finally { reopened.close(); }
    } finally { await owner?.close(); rmSync(root, { recursive: true, force: true }); }
  });
}

test('metrics256 root calls use their bounded command allowance without enlarging other SDK commands', () => {
  const input = { runtime: 'claude-code', ref: { id: 'execution', key: 'claude-code:session', epoch: 'epoch', nativeSessionId: 'native' },
    sample: { eventId: 'metric', sequence: 1, usage: { scope: 'last-turn', inputTokens: 256, outputTokens: 256 },
      reconciledCalls: Array.from({ length: 256 }, (_, i) => ({ id: String(i).padEnd(512, 'x'), model: 'claude', inputTokens: 1, outputTokens: 1 })) } };
  assert.equal(validConnectorSdkJournalInput('sdkMetricsObserve', input), true);
  assert.equal(validConnectorSdkJournalInput('sdkMetricsObserve', { ...input, runtime: 'ghcp', ref: { ...input.ref, key: 'ghcp:session' } }), false);
  assert.throws(() => encodeConnectorOwnerJson(input));
  assert.ok(encodeConnectorOwnerJson(input, connectorOwnerCommandBytes('sdkMetricsObserve')).length > 16_384);
  assert.equal(connectorOwnerCommandBytes('sdkSnapshotRead'), 16_384);
});

class FakeWorker extends EventEmitter {
  sent: Array<{ id: number; kind: string; body: string }> = [];
  postMessage(message: { id: number; kind: string; body: string }) {
    this.sent.push(message);
    if (message.kind === 'close') queueMicrotask(() => {
      this.emit('message', { id: message.id, kind: 'close', ok: true, body: 'null' }); this.emit('exit', 0);
    });
  }
  terminate() { queueMicrotask(() => this.emit('exit', 0)); return Promise.resolve(0); }
}
for (const scenario of ['wrong-key', 'wrong-runtime', 'page-runtime', 'page-order', 'page-limit', 'page-cursor']) {
  test(`SDK valid-looking ${scenario} reply retires original worker, never retries/replays`, async () => {
    const worker = new FakeWorker(), root = mkdtempSync(join(tmpdir(), 'agentopsdeck-sdk-reply-'));
    const owner = new AsyncConnectorOwner({ file: join(root, 'store.sqlite') }, silent, () => worker as unknown as Worker);
    worker.emit('message', { kind: 'ready' });
    try {
      const page = scenario.startsWith('page');
      const promise = page ? owner.command('sdkSessionPage', { runtime: 'ghcp', after: 'ghcp:a', limit: 1 })
        : owner.command('sdkSnapshotRead', { runtime: 'ghcp', key: 'ghcp:original' });
      const rejected = assert.rejects(promise, /unavailable/); await tick();
      const sent = worker.sent[0]!;
      const value = page ? scenario === 'page-runtime' ? ['claude-code:z'] : scenario === 'page-cursor' ? ['ghcp:a']
        : scenario === 'page-order' ? ['ghcp:z', 'ghcp:b'] : ['ghcp:b', 'ghcp:c']
        : { ...empty, session: { key: scenario === 'wrong-runtime' ? 'claude-code:original' : 'ghcp:other',
          nativeSessionId: 'native', title: 'Saved', createdAt: 0, nativeState: 'allocated' } };
      worker.emit('message', { id: sent.id, kind: sent.kind, ok: true, body: JSON.stringify(value) });
      await rejected; await owner.closeForShutdown();
      assert.equal(worker.sent.filter(item => item.kind === sent.kind).length, 1);
    } finally { await owner.closeForShutdown(); rmSync(root, { recursive: true, force: true }); }
  });
}
