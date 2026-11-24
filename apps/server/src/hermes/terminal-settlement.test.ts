import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TurnQueue } from '../commands/turn-queue.js';
import { HermesJournal, type HermesExecution } from './journal.js';
import type { HermesHistoryRow } from './history.js';
import { settleHermesTerminal, type HermesTerminalNative, type HermesTerminalPhase, type HermesTerminalPort } from './terminal-settlement.js';
import type { HermesHistoryPort } from './session-history.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { AsyncConnectorOwner } from '../connector/async-connector-owner.js';
import { AsyncHermesExecution } from '../connector/async-hermes-execution.js';
import { ConnectorUserStore } from '../connector/connector-user-store.js';

const rows: HermesHistoryRow[] = [{ row_id: 1, role: 'user', text: 'private prompt', timestamp: 1 },
  { row_id: 2, role: 'assistant', text: 'private answer', timestamp: 2 }];
const original = (): HermesExecution => ({ key: 'hermes:original', id: 'original-run', live: 'original-live', epoch: 'original-epoch',
  phase: 'running', row: 1, members: ['original-message'], at: 1, updated: 2 });
const idle = () => ({ session_id: original().live, session_key: 'rotated', status: 'idle', running: false });
const silence = new PerformanceDiagnostics(() => {});
function seed(journal: HermesJournal, turns: TurnQueue) {
  const e = original();
  journal.save({ key: e.key, stored: 'stored', title: 'Original', started: false, messages: [] });
  turns.enqueue('hermes', { id: e.members[0]!, sessionKey: e.key, createdAt: 1, payload: { text: 'private prompt', actorId: 'owner' } });
  assert.equal(journal.begin({ ...e, phase: 'starting' }, turns), true);
  assert.equal(journal.admitted(e, turns), true);
  return e;
}
function fixture() {
  const db = new DatabaseSync(':memory:'), journal = new HermesJournal(db), turns = new TurnQueue(db);
  const execution = seed(journal, turns), counts = { native: 0, history: 0, commit: 0, read: 0, snapshot: 0, projection: 0, pause: 0 };
  let available = true;
  const port: HermesTerminalPort = {
    terminal(e, phase, stored, history) { counts.commit++; return journal.settleTerminal(e, phase, stored, history); },
    read(key) { counts.read++; return journal.current(key) ?? null; },
  };
  const history: Pick<HermesHistoryPort, 'snapshot' | 'projection'> = {
    snapshot(key) { counts.snapshot++; return journal.historySnapshot(key); },
    projection(snapshot) { counts.projection++; return journal.historyMessages(snapshot.key, snapshot.digest); },
  };
  const native: HermesTerminalNative = {
    current: () => available,
    async snapshot(live) { counts.native++; assert.equal(live, execution.live); return idle(); },
    async history(live) { counts.history++; assert.equal(live, execution.live); return rows; },
  };
  return { execution, journal, turns, port, history, native, counts,
    disconnect() { available = false; }, close() { db.close(); },
    settle(phase: HermesTerminalPhase = 'completed', diagnostics = silence) {
      return settleHermesTerminal(execution, phase, port, history, native, diagnostics, async () => { counts.pause++; });
    } };
}

for (const phase of ['completed', 'failed', 'interrupted'] as const) test(`terminal ${phase} projects only original committed history and rotated stored identity`, async () => {
  const f = fixture();
  try {
    const result = await f.settle(phase);
    assert.equal(result.execution.phase, phase); assert.equal(result.execution.id, f.execution.id);
    assert.equal(f.execution.phase, 'running', 'consumer cannot publish or mutate caller state');
    assert.deepEqual(result.messages.map(m => m.text), rows.map(row => row.text));
    assert.equal(result.messages[0]?.id, 'original-message');
    assert.equal(f.journal.session(f.execution.key)?.stored, 'rotated');
    assert.deepEqual(f.counts, { native: 1, history: 1, commit: 1, read: 2, snapshot: 2, projection: 1, pause: 0 });
  } finally { f.close(); }
});

for (const field of ['session_id', 'session_key', 'info', 'queued', 'hydrating', 'auto_continue',
  'pending_approval', 'pending_connection', 'open_requests'] as const) test(`terminal refuses foreign or unmanaged native ${field} without commit`, async () => {
  const f = fixture();
  try {
    const values = { session_id: 'foreign', session_key: '', info: { stored_session_id: 'foreign' }, queued: 1, hydrating: true,
      auto_continue: true, pending_approval: true, pending_connection: true, open_requests: [{}] };
    f.native.snapshot = async () => ({ ...idle(), [field]: values[field] });
    await assert.rejects(f.settle()); assert.equal(f.counts.commit, 0); assert.equal(f.counts.history, 0);
    assert.equal(f.journal.current(f.execution.key)?.phase, 'running');
  } finally { f.close(); }
});

test('terminal native cleanup polling is bounded and only retries reads, not effects', async () => {
  const f = fixture();
  try {
    let snapshots = 0;
    f.native.snapshot = async () => { snapshots++; return { ...idle(), running: true, status: 'running' }; };
    await assert.rejects(f.settle(), /did not settle/);
    assert.equal(snapshots, 50); assert.equal(f.counts.pause, 49); assert.equal(f.counts.commit, 0);
    snapshots = 0;
    f.native.snapshot = async () => ++snapshots < 3 ? { ...idle(), running: true } : idle();
    assert.equal((await f.settle()).execution.phase, 'completed');
    assert.equal(snapshots, 3); assert.equal(f.counts.commit, 1);
  } finally { f.close(); }
});

for (const phase of ['completed', 'failed', 'interrupted'] as const) test(`retained native error proof: phase=${phase}`, async () => {
  const f = fixture();
  try {
    f.native.snapshot = async () => ({ ...idle(), inflight: { status: 'error', streaming: false } });
    if (phase === 'failed') assert.equal((await f.settle(phase)).execution.phase, phase);
    else { await assert.rejects(f.settle(phase)); assert.equal(f.counts.commit, 0); }
  } finally { f.close(); }
});

for (const stage of ['native', 'history', 'commit', 'read', 'snapshot', 'projection', 'readAgain', 'snapshotAgain'] as const)
test(`terminal disconnect across ${stage} never publishes a stale result or repeats commit`, async () => {
  const f = fixture();
  try {
    if (stage === 'native') { const base = f.native.snapshot; f.native.snapshot = async live => { const v = await base(live); f.disconnect(); return v; }; }
    if (stage === 'history') { const base = f.native.history; f.native.history = async live => { const v = await base(live); f.disconnect(); return v; }; }
    if (stage === 'commit') { const base = f.port.terminal; f.port.terminal = async (...args) => { const v = await base(...args); f.disconnect(); return v; }; }
    if (stage === 'read' || stage === 'readAgain') { const base = f.port.read; f.port.read = async key => {
      const v = await base(key); if (f.counts.read === (stage === 'read' ? 1 : 2)) f.disconnect(); return v;
    }; }
    if (stage === 'snapshot' || stage === 'snapshotAgain') { const base = f.history.snapshot; f.history.snapshot = async key => {
      const v = await base(key); if (f.counts.snapshot === (stage === 'snapshot' ? 1 : 2)) f.disconnect(); return v;
    }; }
    if (stage === 'projection') { const base = f.history.projection; f.history.projection = async snapshot => { const v = await base(snapshot); f.disconnect(); return v; }; }
    await assert.rejects(f.settle(), /execution changed/);
    assert.equal(f.counts.commit, ['native', 'history'].includes(stage) ? 0 : 1);
    assert.equal(f.execution.phase, 'running');
  } finally { f.close(); }
});

for (const stage of ['first', 'last'] as const) for (const field of ['key', 'id', 'live', 'epoch', 'row', 'at', 'members', 'phase', 'updated'] as const)
test(`terminal rejects ${stage} persisted receipt with foreign ${field}`, async () => {
  const f = fixture();
  try {
    const base = f.port.read;
    f.port.read = async key => {
      const e = await base(key);
      return f.counts.read === (stage === 'first' ? 1 : 2) ? { ...e!, [field]: field === 'members' ? ['foreign']
        : ['row', 'at'].includes(field) ? 999 : field === 'updated' ? 0 : 'foreign' } : e;
    };
    await assert.rejects(f.settle()); assert.equal(f.counts.commit, 1);
    assert.equal(f.execution.phase, 'running');
  } finally { f.close(); }
});

test('terminal refuses missing input lineage, failed ACK and superseded history without replay', async () => {
  for (const scenario of ['row', 'ack', 'projection', 'revision'] as const) {
    const f = fixture();
    try {
      if (scenario === 'row') f.native.history = async () => rows.slice(1);
      if (scenario === 'ack') f.port.terminal = () => { f.counts.commit++; return false; };
      if (scenario === 'projection') f.history.projection = () => null;
      if (scenario === 'revision') {
        const base = f.history.projection;
        f.history.projection = async snapshot => { const messages = await base(snapshot);
          const s = f.journal.session(snapshot.key)!; f.journal.save({ ...s, title: 'new original title' }); return messages; };
      }
      await assert.rejects(f.settle());
      assert.equal(f.counts.commit, scenario === 'row' ? 0 : 1); assert.equal(f.execution.phase, 'running');
    } finally { f.close(); }
  }
});

test('terminal fixed-step diagnostics redact content and failures even when log delivery throws', async () => {
  for (const sinkFails of [false, true]) {
    const f = fixture(), diagnostics = new PerformanceDiagnostics(() => { if (sinkFails) throw Error('private sink'); }, () => 0);
    try {
      f.native.history = async () => { throw Error('private native failure'); };
      await assert.rejects(f.settle('completed', diagnostics));
      const snapshot = diagnostics.snapshot();
      assert.ok(snapshot.events.some(e => e.operation === 'hermes-terminal-settlement'));
      assert.doesNotMatch(JSON.stringify(snapshot), /private|original-live|original-run|original-message|rotated/);
    } finally { f.close(); }
  }
});

for (const field of ['key', 'id', 'live', 'epoch', 'row', 'members', 'phase'] as const)
test(`terminal captures original identity before caller mutates ${field} during native await`, async () => {
  const f = fixture();
  try {
    f.native.snapshot = async () => {
      Object.assign(f.execution, { [field]: field === 'row' ? 99 : field === 'members' ? ['foreign'] : 'foreign' });
      return idle();
    };
    await assert.rejects(f.settle(), /execution changed/); assert.equal(f.counts.commit, 0);
  } finally { f.close(); }
});

test('sole worker terminal consumer commits original rows, projects and reopens without another writer', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-hermes-terminal-')), file = join(directory, 'connector.sqlite');
  const source = new ConnectorUserStore(file);
  try {
    const e = original();
    source.hermesJournal.save({ key: e.key, stored: 'stored', title: 'Original', started: false, messages: [] });
    await source.turns.enqueueAsync('hermes', { id: e.members[0]!, sessionKey: e.key, createdAt: 1,
      payload: { text: 'private prompt', actorId: 'owner' } });
    assert.equal(source.hermesJournal.begin({ ...e, phase: 'starting' }, source.turns), true);
    assert.equal(source.hermesJournal.admitted(e, source.turns), true);
  } finally { source.close(); }
  const owner = new AsyncConnectorOwner({ file }, silence), facade = new AsyncHermesExecution(owner);
  try {
    await owner.open();
    const result = await facade.settle(original(), 'completed', { current: () => true, snapshot: async () => idle(), history: async () => rows });
    assert.equal(result.execution.phase, 'completed'); assert.equal(result.messages[0]?.id, 'original-message');
    assert.equal(result.messages[1]?.text, 'private answer');
    await assert.rejects(facade.settle(original(), 'completed', { current: () => true, snapshot: async () => idle(), history: async () => rows }));
    assert.equal((await facade.read(original().key))?.phase, 'completed');
  } finally { await owner.close(); }
  try {
    const reopened = new ConnectorUserStore(file);
    try { assert.equal(reopened.hermesJournal.current(original().key)?.phase, 'completed');
      assert.equal(reopened.hermesJournal.session(original().key)?.stored, 'rotated');
      assert.deepEqual(reopened.turns.list('hermes'), []);
    } finally { reopened.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
