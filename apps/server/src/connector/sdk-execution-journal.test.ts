import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TurnQueue } from '../commands/turn-queue.js';
import { SdkExecutionJournal, type SdkAgentId } from './sdk-execution-journal.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { recoverableConnection, connectionRecoverySnapshot, StorageConnectionUnavailable } from '../storage/connection-recovery.js';

for (const operation of ['create', 'create-hook', 'model', 'deletion', 'compact', 'compact-hook'] as const)
  test(`SDK ${operation} async participant cannot outlive its original savepoint`, async () => {
    const raw = new DatabaseSync(':memory:'), db = recoverableConnection(raw);
    db.exec('CREATE TABLE late_effect(value INTEGER)'); const insert = db.prepare('INSERT INTO late_effect VALUES(1)');
    let release!: () => void, late: Promise<void> | undefined, enabled = false, calls = 0;
    const held = new Promise<void>(resolve => { release = resolve; });
    const callback = () => { if (!enabled) return; calls++; return late = (async () => { await held; insert.run(); })(); };
    const journal = new SdkExecutionJournal(db, 'claude-code', undefined, operation === 'create-hook' ? callback : undefined,
      { available: () => true, beforeBegin: operation === 'compact-hook' ? callback : () => {} });
    const session = { key: 'claude-code:original', nativeSessionId: 'native', title: 'session', createdAt: 1 };
    const turns = new TurnQueue(db);
    try {
      journal.create(session);
      db.prepare('UPDATE sdk_agent_sessions SET data = ?').run(JSON.stringify({ ...session, nativeState: 'ready' }));
      const deletion = operation === 'deletion' ? journal.beginDeletion(session.key, 'deletion-command') : undefined;
      const tables = ['sdk_agent_sessions', 'sdk_agent_executions', 'sdk_agent_deletions'];
      const before = tables.map(table => raw.prepare(`SELECT * FROM ${table}`).all()); enabled = true;
      assert.throws(() => operation.startsWith('create') ? journal.create({ ...session, key: 'claude-code:new', nativeSessionId: 'other' },
        operation === 'create' ? callback : undefined)
        : operation === 'model' ? journal.updateModel(session.key, 'model', callback)
          : operation === 'deletion' ? journal.settleDeletion(deletion!, true, callback)
            : journal.beginCompact({ key: session.key, id: 'execution', epoch: 'epoch' }, 'actor', turns,
              operation === 'compact' ? callback : () => {}), /must be synchronous/);
      assert.equal(calls, 1); assert.equal(raw.isTransaction, false);
      assert.deepEqual(tables.map(table => raw.prepare(`SELECT * FROM ${table}`).all()), before);
      assert.equal(connectionRecoverySnapshot(db).state, 'close-required');
      const rejected = assert.rejects(late!, StorageConnectionUnavailable); release(); await rejected;
      assert.deepEqual(raw.prepare('SELECT * FROM late_effect').all(), []);
    } finally { release(); if (late) await late.catch(() => {}); db.close(); }
  });

test('SDK transaction logs distinguish outer commit, nested release and rollback without identities', () => {
  const db = new DatabaseSync(':memory:'), rows: any[] = [];
  const journal = new SdkExecutionJournal(db, 'claude-code', () => 1000, undefined, undefined, undefined, undefined,
    new PerformanceDiagnostics(line => rows.push(JSON.parse(line))));
  const session = { key: 'claude-code:private', nativeSessionId: 'secret-native', title: 'private title', createdAt: 1 };
  try {
    journal.create(session);
    assert.equal(rows.at(-1).settled, 1); assert.equal(rows.at(-1).nested, 0);
    db.exec('BEGIN'); journal.updateModel(session.key, 'model', () => {});
    assert.equal(rows.at(-1).settled, 0); assert.equal(rows.at(-1).nested, 1);
    db.exec('ROLLBACK'); assert.equal(journal.session(session.key)?.model, undefined);
    const original = Error('secret receipt error');
    assert.throws(() => journal.updateModel(session.key, 'other', () => { throw original; }), error => error === original);
    assert.equal(rows.at(-1).category, 'failed'); assert.ok(rows.at(-1).rollbackMs >= 0);
    assert.equal(journal.session(session.key)?.model, undefined);
    assert.doesNotMatch(JSON.stringify(rows), /private|secret|native|title/);
    for (const key of ['beginMs', 'bodyMs', 'commitMs']) assert.ok(rows[0][key] >= 0);
  } finally { db.close(); }
});

for (const stage of ['begin', 'rollback'] as const) {
  test(`SDK ${stage} failure preserves original error and never rolls back an unowned savepoint`, () => {
    const db = new DatabaseSync(':memory:'), rows: any[] = [], original = Error('original private error');
    let failAt: string | undefined, rollbackCalls = 0;
    const wrapped = new Proxy(db, {
      get(target, property) {
        if (property === 'exec') return (sql: string) => {
          if (sql.startsWith('ROLLBACK')) rollbackCalls++;
          if (sql === failAt) throw (stage === 'begin' ? original : Error('secondary rollback error'));
          return target.exec(sql);
        };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const journal = new SdkExecutionJournal(wrapped, 'claude-code', undefined, undefined, undefined, undefined, undefined,
      new PerformanceDiagnostics(line => rows.push(JSON.parse(line))));
    try {
      journal.create({ key: 'claude-code:private', nativeSessionId: 'native', title: '', createdAt: 1 });
      db.exec('BEGIN');
      failAt = stage === 'begin' ? 'SAVEPOINT sdk_execution_journal' : 'ROLLBACK TO sdk_execution_journal; RELEASE sdk_execution_journal';
      assert.throws(() => journal.updateModel('claude-code:private', 'model', () => { throw original; }), error => error === original);
      assert.equal(db.isTransaction, true);
      assert.equal(rollbackCalls, stage === 'begin' ? 0 : 1);
      assert.equal(rows.at(-1).category, 'failed');
      assert.equal(rows.at(-1).rollbackFailed, stage === 'rollback' ? 1 : undefined);
    } finally { if (db.isTransaction) db.exec('ROLLBACK'); db.close(); }
  });
}

function fixture(runtime: SdkAgentId = 'claude-code', file = ':memory:') {
  const db = new DatabaseSync(file), turns = new TurnQueue(db), journal = new SdkExecutionJournal(db, runtime, () => 1000);
  const key = `${runtime}:session`, ref = { key, id: 'execution', epoch: 'process-epoch' };
  if (!journal.session(key)) journal.create({ key, nativeSessionId: 'allocated-native-id', title: 'Fixture', createdAt: 1000 });
  const enqueue = (id: string, target = key) => turns.enqueue(runtime, { id, sessionKey: target, createdAt: 1000, payload: { text: 'private prompt', actorId: 'owner' } });
  return { db, turns, journal, key, ref, enqueue };
}

test('SDK session directory uses bounded stable cursors and excludes other runtimes', () => {
  const f = fixture(), other = new SdkExecutionJournal(f.db, 'ghcp');
  try {
    other.create({ key: 'ghcp:other', nativeSessionId: 'other', title: 'Other', createdAt: 0 });
    for (let i = 0; i < 205; i++) f.journal.create({ key: `claude-code:${String(i).padStart(3, '0')}`,
      nativeSessionId: `native-${i}`, title: 'Fixture', createdAt: 0 });
    const first = f.journal.sessionKeys(), second = f.journal.sessionKeys(first.at(-1));
    assert.equal(first.length, 200); assert.equal(second.length, 6);
    assert.equal(new Set([...first, ...second]).size, 206);
    assert.equal(f.journal.sessionKeys(second.at(-1)).length, 0);
    assert.equal([...first, ...second].every(key => key.startsWith('claude-code:')), true);
    for (const limit of [0, 201, 1.5, NaN]) assert.throws(() => f.journal.sessionKeys(undefined, limit));
    for (const cursor of ['ghcp:other', 'claude-code:bad\n', '']) assert.throws(() => f.journal.sessionKeys(cursor));
  } finally { f.db.close(); }
});

for (const runtime of ['claude-code', 'ghcp'] as const) {
  test(`${runtime}: deletion commit rolls back with receipt and uncertain intent survives database reopen`, () => {
    const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-deletion-journal-')), file = join(root, 'journal.sqlite');
    let f = fixture(runtime, file);
    try {
      const intent = f.journal.beginDeletion(f.key, 'delete-command');
      assert.throws(() => f.journal.settleDeletion({ ...intent, nativeSessionId: 'wrong' }, true));
      assert.throws(() => f.journal.settleDeletion(intent, true, () => { throw new Error('receipt failed'); }));
      assert.equal(f.journal.deletion(f.key)?.phase, 'pending');
      assert.ok(f.journal.session(f.key)); assert.equal(f.journal.canStart(f.key), false);
      f.db.close(); f = fixture(runtime, file); f.journal.recover(f.turns);
      assert.equal(f.journal.deletion(f.key)?.phase, 'unknown');
      assert.equal(f.journal.pendingCount(), 1);
      assert.throws(() => f.journal.beginDeletion(f.key, 'retry'));
      assert.throws(() => f.journal.settleDeletion(intent, true), /identity changed/);
    } finally { f.db.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test(`${runtime}: deletion tombstone survives database reopen with audit identity retained`, () => {
    const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-deletion-tombstone-')), file = join(root, 'journal.sqlite');
    const f = fixture(runtime, file);
    try {
      f.journal.settleDeletion(f.journal.beginDeletion(f.key, 'delete-command'), true);
    } finally { f.db.close(); }
    const db = new DatabaseSync(file);
    try {
      const journal = new SdkExecutionJournal(db, runtime);
      journal.recover(new TurnQueue(db));
      assert.equal(journal.session(f.key), undefined);
      assert.equal(journal.deletion(f.key)?.nativeSessionId, 'allocated-native-id');
      assert.equal(journal.canStart(f.key), false); assert.equal(journal.pendingCount(), 0);
      assert.ok(journal.sessionKeys().includes(f.key), 'Internal reconciliation still finds tombstones');
    } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test(`${runtime}: model override and receipt rollback atomically; dispatch snapshots and reset preserves identity`, () => {
    const f = fixture(runtime);
    try {
      const original = f.journal.session(f.key);
      assert.throws(() => f.journal.updateModel(f.key, 'other', () => { throw new Error('Lost receipt'); }));
      assert.deepEqual(f.journal.session(f.key), original);
      let ack = false;
      f.journal.updateModel(f.key, 'other', () => { ack = true; });
      assert.equal(ack, true);
      assert.equal(f.journal.session(f.key)?.model, 'other');
      f.enqueue('first');
      assert.equal(f.journal.begin(f.ref, ['first'], f.turns)?.model, 'other');
      assert.throws(() => f.journal.updateModel(f.key, null, () => {}), /not idle/);
      f.journal.observeTerminal(f.ref, 'completed', f.turns); f.journal.confirmSettled(f.ref);
      f.journal.updateModel(f.key, null, () => {});
      assert.equal(f.journal.session(f.key)?.model, undefined);
      assert.equal(f.journal.session(f.key)?.nativeSessionId, original?.nativeSessionId);
      assert.equal(f.journal.current(f.key)?.model, 'other', 'Reset must not rewrite past execution facts');
      assert.throws(() => f.journal.updateModel(f.key, 'bad model', () => {}));
    } finally { f.db.close(); }
  });

  test(`${runtime}: native identity and FIFO batch intent commit before dispatch; terminal waits for history`, () => {
    const f = fixture(runtime);
    try {
      f.enqueue('one'); f.enqueue('two'); f.enqueue('three');
      assert.equal(f.journal.begin(f.ref, ['two'], f.turns), undefined);
      assert.equal(f.journal.current(f.key), undefined);
      const execution = f.journal.begin(f.ref, ['one', 'two'], f.turns)!;
      assert.equal(execution.nativeMode, 'create');
      assert.equal(f.journal.session(f.key)?.nativeState, 'starting');
      assert.equal(execution.nativeSessionId, 'allocated-native-id');
      assert.deepEqual(execution.members, ['one', 'two']);
      assert.equal(f.turns.head(runtime, f.key)?.state, 'dispatching');
      assert.equal(f.journal.begin({ ...f.ref, id: 'overlap' }, ['three'], f.turns), undefined);
      assert.equal(JSON.stringify(execution).includes('private prompt'), false);
      assert.equal(f.journal.acknowledge(f.ref, 'native-request', f.turns), true);
      assert.equal(f.journal.session(f.key)?.nativeState, 'starting', 'ACK is not durable native history');
      assert.equal(f.turns.head(runtime, f.key)?.id, 'three');
      assert.equal(f.journal.acknowledge(f.ref, 'different-request', f.turns), false);
      assert.equal(f.journal.observeTerminal(f.ref, 'completed', f.turns), true);
      assert.equal(f.journal.canStart(f.key), false);
      assert.equal(f.journal.pendingCount(), 1);
      assert.equal(f.journal.confirmSettled(f.ref), true);
      assert.equal(f.journal.session(f.key)?.nativeState, 'ready');
      assert.equal(f.journal.pendingCount(), 0);
      assert.equal(f.journal.begin({ ...f.ref, id: 'next' }, ['three'], f.turns)?.nativeMode, 'resume');
      assert.equal(f.journal.observeTerminal(f.ref, 'failed', f.turns), false, 'old terminal cannot finish successor');
    } finally { f.db.close(); }
  });

  test(`${runtime}: restart freezes dispatching, acknowledged and awaiting-history work without replay`, () => {
    for (const phase of ['dispatching', 'running', 'settling', 'completed']) {
      const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-sdk-journal-')), file = join(root, 'journal.sqlite');
      let f = fixture(runtime, file);
      try {
        f.enqueue('one'); f.enqueue('two');
        f.journal.begin(f.ref, ['one'], f.turns);
        if (phase !== 'dispatching') f.journal.acknowledge(f.ref, 'native-request', f.turns);
        if (phase === 'settling' || phase === 'completed') f.journal.observeTerminal(f.ref, 'completed', f.turns);
        if (phase === 'completed') f.journal.confirmSettled(f.ref);
        f.db.close(); f = fixture(runtime, file);
        f.journal.recover(f.turns); f.journal.recover(f.turns);
        const completed = phase === 'completed';
        assert.equal(f.journal.current(f.key)?.phase, completed ? 'completed' : 'unknown');
        assert.equal(f.journal.session(f.key)?.nativeState, completed ? 'ready' : 'unknown');
        assert.equal(f.journal.canStart(f.key), completed);
        assert.equal(f.journal.acknowledge(f.ref, 'late-ack', f.turns), false);
        assert.equal(f.journal.confirmSettled(f.ref), false);
        if (phase === 'dispatching') assert.equal(f.turns.head(runtime, f.key)?.state, 'outcome_unknown');
        else assert.equal(f.turns.head(runtime, f.key)?.id, 'two');
      } finally { f.db.close(); rmSync(root, { recursive: true, force: true }); }
    }
  });
}

test('SDK events and stops are execution/epoch scoped; stop acknowledgement alone does not finish a run', () => {
  const f = fixture();
  try {
    f.enqueue('one'); f.journal.begin(f.ref, ['one'], f.turns);
    assert.equal(f.journal.requestStop(f.ref), false, 'unknown native admission is not stoppable by guessed ID');
    assert.equal(f.journal.acknowledge({ ...f.ref, epoch: 'old' }, 'native', f.turns), false);
    f.journal.acknowledge(f.ref, 'native', f.turns);
    assert.equal(f.journal.observeTerminal(f.ref, 'interrupted', f.turns), false);
    assert.equal(f.journal.requestStop({ ...f.ref, id: 'other' }), false);
    assert.equal(f.journal.requestStop(f.ref), true);
    assert.equal(f.journal.requestStop(f.ref), false);
    assert.equal(f.journal.current(f.key)?.phase, 'running');
    assert.equal(f.journal.observeTerminal(f.ref, 'interrupted', f.turns), true);
    assert.equal(f.journal.canStart(f.key), false);
    assert.equal(f.journal.confirmSettled(f.ref), true);
    assert.equal(f.journal.current(f.key)?.phase, 'interrupted');
  } finally { f.db.close(); }
});

test('SDK terminal can precede send ACK, but unknown outcome cannot be reopened by late events', () => {
  const f = fixture();
  try {
    f.enqueue('one'); f.journal.begin(f.ref, ['one'], f.turns);
    assert.equal(f.journal.observeTerminal(f.ref, 'completed', f.turns), true);
    assert.equal(f.turns.hasPending('claude-code', f.key), false);
    assert.equal(f.journal.acknowledge(f.ref, 'late', f.turns), false);
    f.journal.markUnknown(f.ref, f.turns);
    assert.equal(f.journal.observeTerminal(f.ref, 'completed', f.turns), false);
    assert.equal(f.journal.confirmSettled(f.ref), false);
    assert.equal(f.journal.canStart(f.key), false);
  } finally { f.db.close(); }
});

test('queue and journal must share a transaction; failed insert rolls back the entire batch claim', () => {
  const f = fixture(), other = fixture();
  try {
    f.enqueue('one'); other.enqueue('one');
    assert.throws(() => f.journal.begin(f.ref, ['one'], other.turns), /owning transaction/);
    assert.equal(other.turns.head('claude-code', other.key)?.state, 'queued');
    f.journal.begin(f.ref, ['one'], f.turns);
    assert.throws(() => f.journal.acknowledge(f.ref, 'native', other.turns), /owning transaction/);
    assert.equal(f.journal.current(f.key)?.phase, 'dispatching');
    assert.throws(() => f.journal.markUnknown(f.ref, other.turns), /owning transaction/);
    assert.equal(f.journal.current(f.key)?.phase, 'dispatching');
    f.journal.observeTerminal(f.ref, 'completed', f.turns); f.journal.confirmSettled(f.ref);
    f.enqueue('two');
    assert.throws(() => f.journal.begin(f.ref, ['two'], f.turns), /UNIQUE/);
    assert.equal(f.turns.head('claude-code', f.key)?.state, 'queued');
    assert.equal(f.journal.current(f.key)?.phase, 'completed');
    assert.equal(f.journal.session(f.key)?.nativeState, 'ready', 'failed begin rolls back materialization state');
  } finally { f.db.close(); other.db.close(); }
});

test('SDK allocation survives restart without pretending native history exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-sdk-allocation-')), file = join(root, 'journal.sqlite');
  let f = fixture('claude-code', file);
  try {
    assert.equal(f.journal.session(f.key)?.nativeState, 'allocated');
    f.db.close(); f = fixture('claude-code', file);
    f.journal.recover(f.turns);
    f.enqueue('first');
    assert.equal(f.journal.begin(f.ref, ['first'], f.turns)?.nativeMode, 'create');
    f.journal.markUnknown(f.ref, f.turns);
    f.db.close(); f = fixture('claude-code', file);
    f.journal.recover(f.turns);
    assert.equal(f.journal.session(f.key)?.nativeState, 'unknown');
    assert.equal(f.journal.canStart(f.key), false, 'neither re-create nor resume an uncertain first query');
  } finally { f.db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('SDK native readiness and terminal commit atomically; stale proof cannot ready an unknown session', () => {
  const f = fixture();
  try {
    f.enqueue('one'); f.journal.begin(f.ref, ['one'], f.turns);
    f.journal.observeTerminal(f.ref, 'completed', f.turns);
    f.db.exec(`CREATE TEMP TRIGGER refuse_ready BEFORE UPDATE ON sdk_agent_sessions
      WHEN json_extract(NEW.data, '$.nativeState') = 'ready'
      BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`);
    assert.throws(() => f.journal.confirmSettled(f.ref), /fixture failure/);
    assert.equal(f.journal.current(f.key)?.phase, 'settling');
    assert.equal(f.journal.session(f.key)?.nativeState, 'starting');
    f.db.exec('DROP TRIGGER refuse_ready');
    f.journal.markUnknown(f.ref, f.turns);
    assert.equal(f.journal.confirmSettled(f.ref), false);
    assert.equal(f.journal.session(f.key)?.nativeState, 'unknown');
  } finally { f.db.close(); }
});

test('SDK old or unrecognized materialization records never infer a safe create or resume', () => {
  const f = fixture();
  try {
    for (const state of [undefined, 'future-state']) {
      f.db.prepare('UPDATE sdk_agent_sessions SET data = ? WHERE session_key = ?').run(JSON.stringify({
        key: f.key, nativeSessionId: 'allocated-native-id', title: 'Fixture', createdAt: 1000,
        ...(state ? { nativeState: state } : {}),
      }), f.key);
      assert.equal(f.journal.session(f.key)?.nativeState, 'unknown');
      assert.equal(f.journal.canStart(f.key), false);
      assert.equal(f.journal.hasUnresolved(f.key), true);
      assert.equal(f.journal.pendingCount(), 1, 'unproven legacy sessions block maintenance even without an execution');
    }
  } finally { f.db.close(); }
});

test('SDK runtimes isolate identical native and execution IDs and refuse malformed session identities', () => {
  const f = fixture(), copilot = new SdkExecutionJournal(f.db, 'ghcp');
  try {
    const key = 'ghcp:session';
    copilot.create({ key, nativeSessionId: 'allocated-native-id', title: 'Copilot', createdAt: 1000 });
    f.enqueue('one'); f.turns.enqueue('ghcp', { id: 'one', sessionKey: key, createdAt: 1000, payload: {} });
    f.journal.begin(f.ref, ['one'], f.turns);
    copilot.begin({ ...f.ref, key }, ['one'], f.turns);
    f.journal.markUnknown(f.ref, f.turns);
    assert.equal(copilot.current(key)?.phase, 'dispatching');
    assert.equal(f.turns.head('ghcp', key)?.state, 'dispatching');
    for (const invalid of ['codex:native', 'claude-code:', 'claude-code:x\n']) {
      assert.throws(() => f.journal.create({ key: invalid, nativeSessionId: 'new', title: '', createdAt: 1 }), /Invalid/);
    }
    assert.throws(() => f.journal.create({ key: 'claude-code:duplicate', nativeSessionId: 'allocated-native-id', title: '', createdAt: 1 }), /UNIQUE/);
  } finally { f.db.close(); }
});

for (const runtime of ['claude-code', 'ghcp', 'antigravity'] as const) {
  test(`SDK ${runtime} recoverUnknownSession explicitly resolves unknown execution and settles claimed turns`, () => {
    const f = fixture(runtime);
    try {
      f.enqueue('one');
      assert.equal(f.journal.begin(f.ref, ['one'], f.turns)?.nativeMode, 'create');
      f.journal.markUnknown(f.ref, f.turns);
      assert.equal(f.journal.canStart(f.key), false);
      assert.equal(f.journal.recoverUnknownSession(f.key, 'wrong-run', f.turns, false), false);
      assert.equal(f.journal.recoverUnknownSession(f.key, f.ref.id, f.turns, false), true);
      assert.equal(f.journal.current(f.key)?.phase, 'failed');
      assert.equal(f.journal.session(f.key)?.nativeState, 'allocated');
      assert.equal(f.turns.head(runtime, f.key), undefined);
      assert.equal(f.journal.canStart(f.key), true);

      const second = { ...f.ref, id: 'execution-2' };
      f.enqueue('two');
      assert.equal(f.journal.begin(second, ['two'], f.turns)?.nativeMode, 'create');
      assert.equal(f.journal.acknowledge(second, 'native-req-2', f.turns), true);
      assert.equal(f.journal.requestStop(second), true);
      f.journal.markUnknown(second, f.turns);
      assert.equal(f.journal.recoverUnknownSession(f.key, second.id, f.turns, true), true);
      assert.equal(f.journal.current(f.key)?.phase, 'interrupted');
      assert.equal(f.journal.session(f.key)?.nativeState, 'ready');
      assert.equal(f.journal.canStart(f.key), true);
    } finally { f.db.close(); }
  });
}
