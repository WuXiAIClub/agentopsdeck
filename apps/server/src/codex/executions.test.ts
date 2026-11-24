import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ConnectorEventLog } from '../connector/event-log.js';
import { TurnQueue } from '../commands/turn-queue.js';
import { CodexExecutions } from './executions.js';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { randomUUID } from 'node:crypto';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { recoverableConnection, connectionRecoverySnapshot, StorageConnectionUnavailable } from '../storage/connection-recovery.js';

for (const source of ['admission', 'ack', 'evidence', 'journal', 'recovery-evidence', 'recovery-journal'] as const) for (const hidden of [false, true])
  test(`execution ${source} rejects ${hidden ? 'hidden-then ' : ''}async work and retires its original SQL owner`, async () => {
    const raw = new DatabaseSync(':memory:'), rows: any[] = [];
    const diagnostics = new PerformanceDiagnostics(line => rows.push(JSON.parse(line)));
    const db = recoverableConnection(raw, diagnostics);
    db.exec('CREATE TABLE late_effect(value INTEGER)');
    const insert = db.prepare('INSERT INTO late_effect VALUES(1)');
    let release!: () => void, late: Promise<void> | undefined, enabled = false, calls = 0, notifications = 0;
    const held = new Promise<void>(resolve => { release = resolve; });
    const callback = () => {
      if (!enabled) return;
      calls++;
      late = (async () => { await held; insert.run(); })();
      if (hidden) Object.defineProperty(late, 'then', { value: undefined });
      return late;
    };
    const journal = { appendInTransaction: source.endsWith('journal') ? callback : () => {},
      changes: { notify: () => { notifications++; } } } as any;
    const facts = new CodexExecutions(db, journal, undefined, undefined, undefined,
      { recordExecutionInTransaction: source.endsWith('evidence') ? callback : () => {} }, undefined, diagnostics);
    try {
      facts.begin('private-session', 'command', 'connection');
      enabled = true; notifications = 0; rows.length = 0;
      assert.throws(() => source === 'admission' ? facts.begin('admitted-session', 'next-command', 'connection', false, undefined, false, undefined, callback)
        : source.startsWith('recovery-') ? facts.recoverInterrupted()
        : facts.acknowledge('private-session', 'command', 'connection', 'run',
          source === 'ack' ? callback : () => {}), /must be synchronous/);
      assert.equal(calls, 1); assert.equal(notifications, 0); assert.equal(raw.isTransaction, false);
      const original = JSON.parse((raw.prepare('SELECT fact FROM connector_codex_executions').get() as any).fact);
      assert.equal(original.phase, 'starting'); assert.equal(original.runId, undefined);
      if (source === 'admission') assert.equal(raw.prepare('SELECT fact FROM connector_codex_executions WHERE session_key = ?').get('admitted-session'), undefined);
      assert.equal(connectionRecoverySnapshot(db).state, 'close-required');
      assert.throws(() => facts.get('private-session'), StorageConnectionUnavailable);
      const observed = new Promise<void>((resolve, reject) => Promise.prototype.then.call(late, resolve, reject));
      const rejected = assert.rejects(observed, StorageConnectionUnavailable); release(); await rejected;
      assert.deepEqual(raw.prepare('SELECT * FROM late_effect').all(), []);
      assert.equal(connectionRecoverySnapshot(db).state, 'close-required');
      const failure = rows.find(row => row.operation === (source.startsWith('recovery-') ? 'codex-execution-recovery' : 'codex-execution-change'));
      assert.equal(failure.unknown, 1); assert.equal(failure.settled, undefined); assert.equal(failure.step, 2);
      assert.doesNotMatch(JSON.stringify(rows), /private-session|late_effect/);
    } finally { release(); if (late) await new Promise<void>(resolve => Promise.prototype.then.call(late, resolve, resolve)); db.close(); }
  });

for (const source of ['ack', 'recovery'] as const) for (const getterThrows of [false, true])
  test(`${source} thenable inspection preserves original error, rollback and close fence`, () => {
    const raw = new DatabaseSync(':memory:'), db = recoverableConnection(raw), original = Error('private inspection');
    let enabled = false, getterCalls = 0, thenCalls = 0, calls = 0;
    const callback = () => {
      if (!enabled) return;
      calls++;
      return { get then() { getterCalls++; if (getterThrows) throw original; return () => { thenCalls++; }; } };
    };
    const facts = new CodexExecutions(db, undefined, undefined, undefined, undefined,
      { recordExecutionInTransaction: source === 'recovery' ? callback : () => {} });
    try {
      facts.begin('s', 'command', 'connection'); enabled = true;
      assert.throws(() => source === 'recovery' ? facts.recoverInterrupted()
        : facts.acknowledge('s', 'command', 'connection', 'run', callback),
      error => getterThrows ? error === original : /must be synchronous/.test(String(error)));
      assert.equal(calls, 1); assert.equal(getterCalls, 1); assert.equal(thenCalls, 0);
      assert.equal(raw.isTransaction, false); assert.equal(connectionRecoverySnapshot(db).state, 'close-required');
      assert.equal(JSON.parse((raw.prepare('SELECT fact FROM connector_codex_executions').get() as any).fact).phase, 'starting');
    } finally { db.close(); }
  });

for (const recovery of [false, true]) for (const phase of ['begin', 'body', 'commit'] as const)
  test(`execution ${recovery ? 'recovery' : 'change'} reports numeric ${phase} and rollback failure without replacing the original`, () => {
    const raw = new DatabaseSync(':memory:'), logs: any[] = [];
    const diagnostics = new PerformanceDiagnostics(line => logs.push(JSON.parse(line)));
    const db = recoverableConnection(raw, diagnostics);
    const original = Object.assign(Error('private SQL'), { code: 'ERR_SQLITE_ERROR', errcode: 5 });
    const rollbackError = Object.assign(Error('private rollback'), { code: 'ERR_SQLITE_ERROR', errcode: 10 });
    let enabled = false;
    const facts = new CodexExecutions(db, undefined, undefined, undefined, undefined,
      { recordExecutionInTransaction: () => { if (enabled && phase === 'body') throw original; } }, undefined, diagnostics);
    const exec = db.exec;
    try {
      facts.begin('s', 'command', 'connection'); enabled = true; logs.length = 0;
      db.exec = sql => {
        if (sql === 'ROLLBACK') throw rollbackError;
        if (phase === 'begin' && sql === 'BEGIN IMMEDIATE') { exec(sql); throw original; }
        if (phase === 'commit' && sql === 'COMMIT') throw original;
        exec(sql);
      };
      assert.throws(() => recovery ? facts.recoverInterrupted()
        : facts.acknowledge('s', 'command', 'connection', 'run', () => {}), error => error === original);
      const failure = logs.find(row => row.operation === (recovery ? 'codex-execution-recovery' : 'codex-execution-change'));
      assert.equal(failure.step, { begin: 1, body: 2, commit: 3 }[phase]);
      assert.equal(failure.sqlErrorCode, 5); assert.equal(failure.rollbackErrorCode, 10);
      assert.equal(failure.unknown, 1); assert.equal(failure.rollbackFailed, 1); assert.equal(failure.settled, undefined);
      assert.doesNotMatch(JSON.stringify(logs), /private|command|connection/);
      assert.equal(connectionRecoverySnapshot(db).state, 'owner-rollback-required');
    } finally { db.exec = exec; db.close(); }
  });

for (const operation of ['change', 'recovery'] as const) test(`${operation}: lost BEGIN acknowledgment releases only its own transaction and cannot run work`, () => {
  const raw = new DatabaseSync(':memory:'), logs: string[] = [];
  const diagnostics = new PerformanceDiagnostics(line => logs.push(line));
  const db = recoverableConnection(raw, diagnostics), original = Error('private-begin');
  const facts = new CodexExecutions(db, undefined, undefined, undefined, undefined, undefined, undefined, diagnostics);
  const exec = db.exec;
  const run = () => operation === 'change' ? facts.begin('s', 'command', 'connection') : facts.recoverInterrupted();
  try {
    db.exec = sql => { exec(sql); if (sql === 'BEGIN IMMEDIATE') throw original; };
    assert.throws(run, error => error === original);
    assert.equal(raw.isTransaction, false); assert.equal(facts.get('s'), undefined);
    db.exec = exec; db.exec('BEGIN; CREATE TABLE parent_write(value INTEGER)');
    assert.throws(run, /owning transaction/);
    assert.equal(raw.isTransaction, true); db.exec('ROLLBACK');
    assert.ok(logs.some(line => JSON.parse(line).unknown === 1));
    assert.doesNotMatch(logs.join('\n'), /private-begin|parent_write/);
  } finally { raw.close(); }
});

test('execution failed cleanup quarantines cached facts until later rollback, without stale continuation', () => {
  const raw = new DatabaseSync(':memory:'), diagnostics = new PerformanceDiagnostics(() => {});
  let clock = 0;
  const db = recoverableConnection(raw, diagnostics, () => clock);
  const facts = new CodexExecutions(db, undefined, undefined, undefined, undefined, undefined, undefined, diagnostics);
  facts.begin('s', 'command', 'connection');
  const original = Error('private-body'), exec = db.exec;
  try {
    db.exec = sql => { if (sql === 'ROLLBACK') throw Error('private-cleanup'); exec(sql); };
    assert.throws(() => facts.acknowledge('s', 'command', 'connection', 'run', () => { throw original; }), error => error === original);
    assert.equal(connectionRecoverySnapshot(db).state, 'owner-rollback-required');
    assert.throws(() => facts.get('s'), StorageConnectionUnavailable);
    db.exec = exec; clock += 1000;
    assert.throws(() => facts.get('s'), StorageConnectionUnavailable);
    assert.equal(facts.get('s')?.phase, 'starting');
    assert.equal(facts.get('s')?.runId, undefined);
  } finally { raw.close(); }
});

test('execution commit acknowledgment loss keeps the persisted fact but never returns accepted or retries', () => {
  const db = new DatabaseSync(':memory:'), rows: any[] = [], original = Error('private-commit');
  const facts = new CodexExecutions(db, undefined, undefined, undefined, undefined, undefined, undefined,
    new PerformanceDiagnostics(line => rows.push(JSON.parse(line))));
  const exec = db.exec.bind(db); let commits = 0;
  db.exec = sql => { exec(sql); if (sql === 'COMMIT') { commits++; throw original; } };
  try {
    assert.throws(() => facts.begin('s', 'command', 'connection'), error => error === original);
    assert.equal(commits, 1); assert.equal(db.isTransaction, false); assert.equal(facts.get('s')?.phase, 'starting');
    assert.equal(rows[0].category, 'failed'); assert.equal(typeof rows[0].commitMs, 'number');
    assert.equal(rows[0].unknown, 1); assert.equal(rows[0].settled, undefined);
    assert.equal(rows[0].rollbackMs, undefined); assert.doesNotMatch(JSON.stringify(rows), /private-commit/);
  } finally { db.close(); }
});

test('hot statements are reused without caching facts or losing rollback visibility', () => {
  const db = new DatabaseSync(':memory:'), counts = new Map<string, number>();
  const rows: any[] = []; let clock = 0;
  const prepare = db.prepare.bind(db);
  db.prepare = sql => { counts.set(sql, (counts.get(sql) ?? 0) + 1); return prepare(sql); };
  const facts = new CodexExecutions(db, undefined, undefined, undefined, undefined, undefined, undefined,
    new PerformanceDiagnostics(line => rows.push(JSON.parse(line)), () => clock));
  try {
    for (let i = 0; i < 130; i++) assert.equal(facts.begin(`s-${i}`, `c-${i}`, 'connection'), true);
    const original = Error('callback failed');
    assert.throws(() => facts.acknowledge('s-0', 'c-0', 'connection', 'run', () => { throw original; }), e => e === original);
    assert.equal(facts.get('s-0')?.phase, 'starting');
    const edit = prepare("UPDATE connector_codex_executions SET fact = json_set(fact, '$.phase', 'unknown') WHERE session_key = ?");
    edit.run('s-0'); assert.equal(facts.get('s-0')?.phase, 'unknown');
    clock = 60_000; rows.length = 0;
    facts.recoverInterrupted();
    const recovered = facts.get('s-0'); facts.recoverInterrupted();
    assert.deepEqual(facts.get('s-0'), recovered);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map(row => [row.records, row.changed, row.settled]), [[130, 1, 1], [130, 0, 1]]);
    for (const [sql, count] of counts) {
      if (sql.startsWith('SELECT fact FROM connector_codex_executions WHERE session_key = ?')
        || sql.startsWith('INSERT INTO connector_codex_executions VALUES')
        || sql.startsWith('SELECT session_key, fact FROM connector_codex_executions WHERE session_key > ?')) assert.equal(count, 1, sql);
    }
  } finally { db.close(); }
});

test('execution failures distinguish unknown commits and broken rollback, without replay or notify', () => {
  for (const recovery of [false, true]) for (const mode of ['body', 'commit-before', 'commit-after', 'rollback'] as const) {
    const db = new DatabaseSync(':memory:'), rows: any[] = [], original = Error('private failure');
    let failEvidence = false, notifications = 0, callbacks = 0;
    const facts = new CodexExecutions(db, { appendInTransaction: () => {}, changes: { notify: () => { notifications++; } } } as any,
      undefined, undefined, undefined, { recordExecutionInTransaction: () => { callbacks++; if (failEvidence) throw original; } },
      undefined, new PerformanceDiagnostics(line => rows.push(JSON.parse(line))));
    facts.begin('private-session', 'command', 'connection');
    rows.length = 0; notifications = 0; callbacks = 0;
    failEvidence = mode === 'body' || mode === 'rollback';
    const exec = db.exec.bind(db); let commits = 0, rollbacks = 0;
    db.exec = sql => {
      if (sql === 'COMMIT') { commits++; if (mode === 'commit-before') throw original; }
      if (sql === 'ROLLBACK') { rollbacks++; if (mode === 'rollback') throw Error('private rollback'); }
      exec(sql); if (sql === 'COMMIT' && mode === 'commit-after') throw original;
    };
    try {
      assert.throws(() => recovery ? facts.recoverInterrupted()
        : facts.acknowledge('private-session', 'command', 'connection', 'run', () => {}), e => e === original);
      assert.equal(callbacks, 1); assert.equal(notifications, 0);
      assert.equal(commits, failEvidence ? 0 : 1); assert.equal(rollbacks, mode === 'commit-after' ? 0 : 1);
      assert.equal(rows[0].unknown, mode === 'body' ? undefined : 1);
      assert.equal(rows[0].rollbackFailed, mode === 'rollback' ? 1 : undefined);
      assert.equal(rows[0].settled, undefined); assert.equal(rows[0].category, 'failed');
      if (recovery) assert.equal(rows[0].records, 1);
      if (db.isTransaction) exec('ROLLBACK');
      assert.equal(facts.get('private-session')?.phase, mode === 'commit-after' ? recovery ? 'unknown' : 'running' : 'starting');
      assert.doesNotMatch(JSON.stringify(rows), /private|command|connection/);
    } finally { db.close(); }
  }
});

test('failed BEGIN never rolls back a caller transaction; commit and failed body timings are content-free', () => {
  const db = new DatabaseSync(':memory:'), rows: any[] = [];
  const facts = new CodexExecutions(db, undefined, undefined, undefined, undefined, undefined, undefined,
    new PerformanceDiagnostics(line => rows.push(JSON.parse(line))));
  try {
    db.exec('BEGIN');
    assert.throws(() => facts.begin('private-session', 'secret-command', 'private-connection'));
    assert.equal(db.isTransaction, true);
    assert.throws(() => facts.recoverInterrupted()); assert.equal(db.isTransaction, true);
    assert.equal(rows[0].bodyMs, undefined); assert.equal(rows[0].rollbackMs, undefined);
    db.exec('ROLLBACK');
    assert.equal(facts.begin('private-session', 'secret-command', 'private-connection'), true);
    const success = rows.at(-1); assert.equal(success.category, 'routine'); assert.equal(success.changed, 1);
    for (const key of ['beginMs', 'bodyMs', 'commitMs']) assert.equal(typeof success[key], 'number');
    const original = Error('private-error');
    assert.throws(() => facts.acknowledge('private-session', 'secret-command', 'private-connection', 'private-run', () => { throw original; }), error => error === original);
    assert.equal(db.isTransaction, false); assert.equal(facts.get('private-session')?.phase, 'starting');
    assert.equal(rows.at(-1).category, 'failed'); assert.equal(typeof rows.at(-1).rollbackMs, 'number');
    assert.doesNotMatch(JSON.stringify(rows), /private-|secret-command/);
  } finally { db.close(); }
});

test('task tool enrollment is explicit, durable, UUID-only and capacity bounded', () => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-tool-enrollment-')), path = join(directory, 'state.sqlite');
  let db = new DatabaseSync(path), facts = new CodexExecutions(db, undefined, 1);
  const id = randomUUID(), other = randomUUID();
  try {
    assert.equal(facts.hasBoardTools(id), false); assert.equal(facts.canEnrollBoardTools(), true);
    assert.throws(() => facts.enrollBoardTools('../invalid'));
    facts.enrollBoardTools(id); facts.enrollBoardTools(id);
    assert.equal(facts.canEnrollBoardTools(), false); assert.throws(() => facts.enrollBoardTools(other), /capacity/);
    db.close(); db = new DatabaseSync(path); facts = new CodexExecutions(db, undefined, 1);
    assert.equal(facts.hasBoardTools(id), true); assert.equal(facts.hasBoardTools(other), false);
    assert.equal(facts.maintenancePending(), 0, 'enrollment alone is not a running task');
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('accepted archive retires only terminal history recovery, retaining facts and blocking future dispatch', () => {
  const db = new DatabaseSync(':memory:');
  const deleted = new Set<string>();
  const facts = new CodexExecutions(db, undefined, undefined, undefined, undefined, undefined, key => deleted.has(key));
  try {
    for (const key of ['a-archived', 'b-archived', 'c-live']) {
      facts.begin(key, key, 'connection');
      facts.acknowledge(key, key, 'connection', `run:${key}`, () => {});
      facts.observe(key, 'connection', `run:${key}`, 'completed');
    }
    const original = facts.get('a-archived');
    deleted.add('a-archived'); deleted.add('b-archived');
    assert.equal(facts.maintenancePending(), 1);
    assert.deepEqual(facts.maintenanceHistorySessions(), ['c-live']);
    assert.deepEqual(facts.recoveryPage('', 1), ['c-live'], 'filter before pagination');
    facts.recoverInterrupted();
    assert.deepEqual(facts.get('a-archived'), original, 'archive must not rewrite sync or execution truth');
    assert.equal(facts.canStart('a-archived'), false);
    assert.equal(facts.canChangeSettings('a-archived'), false);
    assert.equal(facts.begin('a-archived', 'successor', 'new-connection'), false);
    for (const patch of [{ phase: 'running' }, { phase: 'unknown' }, { phase: 'starting' },
      { fenced: true }, { preparation: 'ready' }, { runId: null }, { reason: 'identity_conflict' }]) {
      db.prepare('UPDATE connector_codex_executions SET fact = ? WHERE session_key = ?')
        .run(JSON.stringify({ ...original, pending: [], ...patch }), 'a-archived');
      assert.equal(facts.isDeletedTerminal('a-archived'), false, JSON.stringify(patch));
      assert.equal(facts.maintenancePending(), 2, JSON.stringify(patch));
    }
  } finally { db.close(); }
});

test('real persisted deletion ACK, not unknown/rejected or missing projection, retires archived recovery across reopen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-archived-maintenance-'));
  const file = join(dir, 'state.db');
  let store = new ConnectorUserStore(file);
  const key = 'codex:archived', scope = JSON.stringify(['delete', JSON.stringify(['actor', key])]);
  try {
    const facts = store.codexExecutions;
    facts.begin(key, 'send', 'connection');
    facts.acknowledge(key, 'send', 'connection', 'run', () => {});
    facts.observe(key, 'connection', 'run', 'completed');
    facts.settleHistory(facts.get(key)!, 'current');
    (await store.commands.claimAsync(scope, 'delete', {}));
    facts.recoverInterrupted();
    assert.equal(store.commands.sessionDeletion(key), 'outcome_unknown');
    assert.equal(facts.maintenancePending(), 1);
    assert.deepEqual(facts.maintenanceHistorySessions(), [key]);
    store.commands.settle(scope, 'delete', { status: 200, body: { ok: true, status: 'delete_accepted' } });
    const before = facts.get(key);
    store.close(); store = new ConnectorUserStore(file);
    store.codexExecutions.recoverInterrupted();
    assert.equal(store.codexExecutions.maintenancePending(), 0);
    assert.deepEqual(store.codexExecutions.maintenanceHistorySessions(), []);
    assert.deepEqual(store.codexExecutions.recoveryPage('', 64), []);
    assert.deepEqual(store.codexExecutions.get(key), before);
    assert.equal(store.codexExecutions.canStart(key), false);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('maintenance history recovery exempts only known syncing terminals; ordinary idle proof stays strict', () => {
  const db = new DatabaseSync(':memory:'), facts = new CodexExecutions(db);
  try {
    for (const phase of ['completed', 'failed', 'interrupted'] as const) {
      facts.begin(phase, `command:${phase}`, 'old');
      facts.acknowledge(phase, `command:${phase}`, 'old', `run:${phase}`, () => {});
      facts.observe(phase, 'old', `run:${phase}`, phase);
      facts.settleHistory({ sessionKey: phase, commandId: `command:${phase}`, runId: `run:${phase}` }, 'current');
    }
    assert.equal(facts.maintenancePending(), 0);
    facts.recoverInterrupted();
    assert.equal(facts.maintenancePending(), 3);
    assert.equal(facts.maintenancePending({ historyRecovery: true }), 0);
    assert.deepEqual(facts.maintenanceHistorySessions(), ['completed', 'failed', 'interrupted']);
    assert.equal(facts.canStart('completed'), false);
    const original = facts.get('completed')!;
    for (const patch of [{ phase: 'unknown' }, { phase: 'starting' }, { phase: 'running' },
      { fenced: true }, { preparation: 'active' }, { runId: null }]) {
      db.prepare('UPDATE connector_codex_executions SET fact = ? WHERE session_key = ?')
        .run(JSON.stringify({ ...original, pending: [], ...patch }), 'completed');
      assert.equal(facts.maintenancePending({ historyRecovery: true }), 1, JSON.stringify(patch));
      assert.deepEqual(facts.maintenanceHistorySessions(), ['failed', 'interrupted']);
    }
    db.prepare('UPDATE connector_codex_executions SET fact = ? WHERE session_key = ?')
      .run(JSON.stringify({ ...original, pending: [], sync: 'error' }), 'completed');
    assert.equal(facts.maintenancePending({ historyRecovery: true }), 0);
    assert.deepEqual(facts.maintenanceHistorySessions(), ['completed', 'failed', 'interrupted']);
    db.prepare('DELETE FROM connector_codex_executions WHERE session_key = ?').run('interrupted');
    const interruptedKey = 'codex:interrupted-cleanup';
    facts.begin(interruptedKey, 'command:cleanup', 'old');
    facts.acknowledge(interruptedKey, 'command:cleanup', 'old', 'run:cleanup', () => {});
    facts.observe(interruptedKey, 'old', 'run:cleanup', 'interrupted');
    facts.settleNativeHistory(facts.get(interruptedKey)!, {
      state: 'blocked',
      reason: 'cleanup-unconfirmed',
      turnId: 'run:cleanup',
      connectionId: 'old',
      fingerprint: 'a'.repeat(64),
    });
    assert.deepEqual(facts.maintenanceRecoveryRuns()?.map(r => ({ ...r })), [{
      sessionKey: interruptedKey,
      commandId: 'command:cleanup',
      connectionId: 'old',
      runId: 'run:cleanup',
      revision: facts.get(interruptedKey)!.revision,
    }]);
  } finally { db.close(); }
});

test('batch ACK atomically binds all commands and preserves their history mapping across reopen and successor', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-batch-')), file = join(dir, 'state.db');
  let db = new DatabaseSync(file);
  const batch = { separator: '\n[boundary]\n', members: ['2', '3'].map(id => ({id, createdAt: 1, imageCount: 0})) };
  const evidence: string[] = [];
  try {
    const queue = new TurnQueue(db), facts = new CodexExecutions(db, undefined, 2048, Date.now, () => true,
      { recordExecutionInTransaction: (_db, _runtime, fact) => { evidence.push(`${fact.commandId}:${fact.phase}`); } });
    for (const member of batch.members) queue.enqueue('codex', { id: member.id, sessionKey: 's', createdAt: 1, payload: {} });
    queue.startBatch('codex', 's', ['2', '3']);
    assert.equal(facts.begin('s', '2', 'connection', false, batch), true);
    assert.throws(() => facts.acknowledge('s', '2', 'connection', 'run', owner => {
      queue.completeInTransaction(owner, 'codex', '2'); throw new Error('rollback');
    }), /rollback/);
    assert.equal(facts.get('s')?.runId, undefined);
    assert.equal(facts.batchForRun('s', 'run'), undefined);
    assert.equal(queue.list('codex').length, 2);
    assert.equal(facts.acknowledge('s', '2', 'connection', 'run', owner => {
      for (const member of batch.members) queue.completeInTransaction(owner, 'codex', member.id);
    }), true);
    facts.observe('s', 'connection', 'run', 'completed');
    facts.settleHistory({sessionKey:'s',commandId:'2',runId:'run'}, 'current');
    assert.ok(evidence.includes('2:running') && evidence.includes('3:running'));
    assert.ok(evidence.includes('2:completed') && evidence.includes('3:completed'));
    assert.equal(facts.begin('s', '4', 'connection'), true);
    db.close(); db = new DatabaseSync(file);
    assert.deepEqual(new CodexExecutions(db).batchForRun('s', 'run'), batch);
    assert.equal(new TurnQueue(db).list('codex').length, 0);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('batch preparation cannot change membership and a conflicting history binding rolls back ACK', () => {
  const db = new DatabaseSync(':memory:'), facts = new CodexExecutions(db);
  const batch = {separator:'boundary',members:['2','3'].map(id=>({id,createdAt:1,imageCount:0}))};
  try {
    facts.begin('s','2','connection',true,batch);
    facts.finishPreparation(facts.get('s')!);
    assert.equal(facts.begin('s','2','connection',false), false);
    assert.equal(facts.begin('s','2','connection',false,batch), true);
    db.prepare('INSERT INTO connector_codex_batch_history VALUES (?, ?, ?)').run('s','run',JSON.stringify({...batch,separator:'other'}));
    assert.throws(()=>facts.acknowledge('s','2','connection','run',()=>assert.fail('must not commit')), /identity conflict/);
    assert.equal(facts.get('s')?.runId, undefined);
    facts.recoverInterrupted();
    assert.equal(facts.canStart('s'), false);
    assert.equal(facts.get('s')?.batch?.members.length, 2);
  } finally { db.close(); }
});

function fixture(maxRows = 2048) {
  const db = new DatabaseSync(':memory:'), events = new ConnectorEventLog(db), queue = new TurnQueue(db);
  let now = 100;
  const facts = new CodexExecutions(db, events, maxRows, () => now++);
  const session = 'codex:synthetic', command = 'command', connection = 'connection', run = 'native';
  const admit = () => {
    queue.enqueue('codex', { id: command, sessionKey: session, createdAt: 1, payload: { text: 'synthetic' } });
    queue.start('codex', session, command);
    assert.equal(facts.begin(session, command, connection), true);
  };
  const ack = (native = run) => facts.acknowledge(session, command, connection, native,
    (owner) => queue.completeInTransaction(owner, 'codex', command));
  const settle = (sync: 'current' | 'error' = 'current') => facts.settleHistory({ sessionKey: session, commandId: command, runId: run }, sync);
  const eventCount = () => (db.prepare('SELECT count(*) AS n FROM connector_events').get() as { n: number }).n;
  return { db, events, facts, queue, session, command, connection, run, admit, ack, settle, eventCount };
}

test('repeated successor invalidation retains one fenced checkpoint without revision or journal churn', () => {
  const f = fixture();
  try {
    f.admit(); f.ack(); f.facts.observe(f.session, f.connection, f.run, 'completed'); f.settle();
    assert.equal(f.facts.invalidateNativeHistory(f.session), true);
    const blocked = f.facts.get(f.session)!, count = f.eventCount();
    assert.equal(blocked.sync, 'syncing');
    assert.equal(blocked.nativeHistory?.state, 'blocked');
    assert.equal(f.facts.canStart(f.session), false);
    for (let i = 0; i < 100; i++) assert.equal(f.facts.invalidateNativeHistory(f.session), false);
    assert.deepEqual(f.facts.get(f.session), blocked);
    assert.equal(f.eventCount(), count);
    assert.equal(f.facts.canStart(f.session), false);
    assert.equal(f.facts.invalidateNativeHistory(f.session, 'restarted'), true, 'different ownership evidence must still be recorded');
    assert.equal(f.facts.get(f.session)?.nativeHistory?.reason, 'restarted');
    assert.equal(f.facts.get(f.session)?.revision, blocked.revision + 1);
    f.settle('error');
    assert.equal(f.facts.invalidateNativeHistory(f.session, 'restarted'), true, 'a failed sync must still transition to a new read');
    assert.equal(f.facts.get(f.session)?.sync, 'syncing');
    assert.equal(f.facts.canStart(f.session), false);
  } finally { f.db.close(); }
});

for (const scenario of ['known-head', 'verified', 'new-head', 'owned-turn', 'lifecycle', 'failed-sync'] as const) {
  test(`readable predecessor preservation is limited to a blocked known head (${scenario})`, () => {
    const f = fixture();
    try {
      f.admit(); f.ack(); f.facts.observe(f.session, f.connection, f.run, 'completed');
      const expected = f.facts.get(f.session)!;
      assert.equal(f.facts.settleNativeHistory(expected, {
        turnId: scenario === 'owned-turn' ? f.run : 'successor',
        connectionId: f.connection, fingerprint: '1'.repeat(64),
        state: scenario === 'verified' ? 'verified' : 'blocked',
        reason: scenario === 'verified' ? 'settled' : 'background-work',
      }), true);
      if (scenario === 'failed-sync') f.settle('error');
      const before = f.facts.get(f.session)!, count = f.eventCount();
      const readable = scenario === 'lifecycle' ? undefined : scenario === 'new-head' ? 'new-head'
        : scenario === 'owned-turn' ? f.run : 'successor';
      const preserve = scenario === 'known-head';
      assert.equal(f.facts.invalidateNativeHistory(f.session, 'changed', readable), !preserve);
      const after = f.facts.get(f.session)!;
      assert.equal(after.commandId, f.command); assert.equal(after.runId, f.run);
      assert.equal(after.connectionId, f.connection);
      assert.equal(after.revision, before.revision + (preserve ? 0 : 1));
      assert.equal(f.eventCount(), count + (preserve ? 0 : 1));
      assert.equal(after.sync, preserve ? 'current' : 'syncing');
      assert.equal(after.nativeHistory?.state, 'blocked');
      assert.equal(f.facts.canStart(f.session), false);
      if (preserve) assert.deepEqual(after, before);
    } finally { f.db.close(); }
  });
}

test('native disconnect schedules acknowledged recovery once, preserving tool evidence and ownership', () => {
  const f = fixture();
  try {
    f.admit(); f.ack();
    f.facts.observeCommandTool(f.session, f.connection, f.run, 'pending-tool', false);
    const before = f.facts.get(f.session)!;
    assert.equal(f.facts.disconnectAcknowledged(f.session, f.connection), true);
    const after = f.facts.get(f.session)!;
    assert.equal(after.phase, 'unknown');
    assert.equal(after.reason, 'restarted');
    for (const field of ['commandId', 'runId', 'connectionId', 'pendingCommandTools'] as const) {
      assert.deepEqual(after[field], before[field]);
    }
    assert.equal(f.facts.canStart(f.session), false);
    assert.deepEqual(f.facts.recoveryPage('', 64, 'replacement'), [f.session]);
    assert.equal(f.facts.disconnectAcknowledged(f.session, f.connection), false);
    assert.deepEqual(f.facts.get(f.session), after);
  } finally { f.db.close(); }
});

for (const state of ['starting', 'uncertain', 'foreign', 'completed', 'fenced', 'preparation'] as const) {
  test(`native disconnect does not reinterpret ${state} executions`, () => {
    const f = fixture();
    try {
      if (state === 'preparation') f.facts.begin(f.session, f.command, f.connection, true);
      else {
        f.admit();
        if (state === 'uncertain') f.facts.uncertain(f.session, f.command);
        else if (state !== 'starting') f.ack();
        if (state === 'completed') f.facts.observe(f.session, f.connection, f.run, 'completed');
        if (state === 'fenced') f.ack('conflicting');
      }
      const before = f.facts.get(f.session);
      assert.equal(f.facts.disconnectAcknowledged(f.session, state === 'foreign' ? 'other' : f.connection), false);
      assert.deepEqual(f.facts.get(f.session), before);
    } finally { f.db.close(); }
  });
}

test('Codex pending tool identity is bounded, durable and bound to its acknowledged native run', () => {
  const setup = fixture();
  try {
    setup.admit(); setup.ack();
    assert.equal(setup.facts.observeCommandTool(setup.session, 'foreign', setup.run, 'tool'), false);
    assert.equal(setup.facts.observeCommandTool(setup.session, setup.connection, 'foreign', 'tool'), false);
    assert.equal(setup.facts.observeCommandTool(setup.session, setup.connection, setup.run, ' tool'), false);
    assert.equal(setup.facts.observeCommandTool(setup.session, setup.connection, setup.run, 'tool'), true);
    const original = setup.facts.get(setup.session);
    assert.equal(setup.facts.observeCommandTool(setup.session, setup.connection, setup.run, 'tool'), true);
    assert.deepEqual(setup.facts.get(setup.session), original);
    assert.equal(setup.facts.observeCommandTool(setup.session, setup.connection, setup.run, 'tool', true), true);
    assert.equal(setup.facts.get(setup.session)?.pendingCommandTools, undefined);
    setup.facts.observeCommandTool(setup.session, setup.connection, setup.run, 'tool');
    setup.facts.recoverInterrupted();
    assert.deepEqual(new CodexExecutions(setup.db).get(setup.session)?.pendingCommandTools, ['tool']);
    assert.equal(setup.facts.observeCommandTool(setup.session, setup.connection, setup.run, 'tool', true), false);
  } finally { setup.db.close(); }
});

test('Codex tool evidence overflow fences rather than forgetting a potentially running tool', () => {
  const setup = fixture();
  try {
    setup.admit(); setup.ack();
    for (let index = 0; index < 30; index++) setup.facts.observeCommandTool(setup.session, setup.connection, setup.run, String(index).padEnd(100, 'x'));
    assert.equal(setup.facts.get(setup.session)?.reason, 'evidence_overflow');
    assert.equal(setup.facts.canStart(setup.session), false);
  } finally { setup.db.close(); }
});

test('late same-run command evidence invalidates idle without reopening the native turn', () => {
  const setup = fixture();
  try {
    setup.admit(); setup.ack();
    setup.facts.observe(setup.session, setup.connection, setup.run, 'interrupted');
    setup.settle();
    assert.equal(setup.facts.canStart(setup.session), true);
    assert.equal(setup.facts.observeCommandTool(setup.session, 'foreign', setup.run, 'late'), false);
    assert.equal(setup.facts.observeCommandTool(setup.session, setup.connection, 'foreign', 'late'), false);
    assert.equal(setup.facts.canStart(setup.session), true);
    assert.equal(setup.facts.observeCommandTool(setup.session, setup.connection, setup.run, 'late'), true);
    assert.equal(setup.facts.get(setup.session)?.phase, 'interrupted');
    assert.equal(setup.facts.get(setup.session)?.sync, 'syncing');
    assert.equal(setup.facts.canStart(setup.session), false);
    setup.facts.observeCommandTool(setup.session, setup.connection, setup.run, 'late', true);
    assert.deepEqual(setup.facts.get(setup.session)?.pendingCommandTools, ['late']);
    assert.equal(setup.facts.canStart(setup.session), false, 'completion event is not a drain proof');
    setup.facts.recoverInterrupted();
    assert.deepEqual(new CodexExecutions(setup.db).get(setup.session)?.pendingCommandTools, ['late']);
  } finally { setup.db.close(); }
});

for (const stage of ['active', 'ready'] as const) {
  test(`Codex ${stage} preparation excludes native evidence and competing starts`, () => {
    const f = fixture();
    try {
      assert.equal(f.facts.begin(f.session, f.command, f.connection, true), true);
      if (stage === 'ready') assert.equal(f.facts.finishPreparation(f.facts.get(f.session)!), true);
      const before = f.facts.get(f.session), count = f.eventCount();
      assert.equal(f.ack(), false);
      for (const phase of ['running', 'completed', 'failed', 'interrupted'] as const) {
        assert.equal(f.facts.observe(f.session, f.connection, f.run, phase), false);
      }
      assert.equal(f.facts.begin(f.session, 'other', f.connection), false);
      assert.equal(f.facts.begin(f.session, f.command, 'other'), false);
      assert.equal(f.facts.begin(f.session, f.command, f.connection, true), false);
      assert.equal(f.facts.canStart(f.session), false);
      assert.deepEqual(f.facts.get(f.session), before);
      assert.equal(f.eventCount(), count);
      if (stage === 'active') assert.equal(f.facts.begin(f.session, f.command, f.connection), false);
      else {
        assert.equal(f.facts.begin(f.session, f.command, f.connection), true);
        assert.equal(f.facts.get(f.session)?.preparation, undefined);
        assert.equal(f.facts.begin(f.session, f.command, f.connection), false, 'ready is consumed once');
        assert.equal(f.facts.acknowledge(f.session, f.command, f.connection, f.run, () => {}), true);
      }
    } finally { f.db.close(); }
  });

  test(`Codex ${stage} preparation survives SQLite reopen as unknown without releasing successors`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-preparation-restart-'));
    let database = new ConnectorUserStore(join(directory, 'synthetic.sqlite'), undefined, { runtimeOwner: true });
    const session = 'codex:synthetic';
    try {
      for (const id of ['recovery', 'successor']) await database.turns.enqueueAsync('codex', { id, sessionKey: session, createdAt: 1, payload: { text: 'synthetic' } });
      database.turns.start('codex', session, 'recovery');
      database.codexExecutions.begin(session, 'recovery', 'old', true);
      if (stage === 'ready') database.codexExecutions.finishPreparation(database.codexExecutions.get(session)!);
      const expected = database.codexExecutions.get(session)!;
      database.close();
      database = new ConnectorUserStore(join(directory, 'synthetic.sqlite'), undefined, { runtimeOwner: true });
      assert.deepEqual(database.codexExecutions.get(session), expected);
      database.turns.recoverInterrupted('codex');
      database.codexExecutions.recoverInterrupted();
      const restarted = database.codexExecutions.get(session)!;
      assert.equal(restarted.phase, 'unknown'); assert.equal(restarted.reason, 'restarted');
      assert.equal(database.codexExecutions.finishPreparation(expected), false);
      assert.equal(database.codexExecutions.finishPreparation(restarted), false);
      assert.equal(database.codexExecutions.begin(session, 'recovery', 'old'), false);
      assert.equal(database.codexExecutions.begin(session, 'successor', 'new'), false);
      assert.equal(database.codexExecutions.acknowledge(session, 'recovery', 'old', 'late', () => assert.fail('no ACK')), false);
      assert.equal(database.codexExecutions.observe(session, 'old', 'late', 'completed'), false);
      assert.equal(database.codexExecutions.uncertain(session, 'recovery'), false);
      assert.deepEqual(database.codexExecutions.get(session), restarted);
      assert.deepEqual(database.turns.list('codex', session).map(({ state }) => state), ['outcome_unknown', 'queued']);
    } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  test(`Codex uncertain ${stage} preparation cannot finish or dispatch`, () => {
    const f = fixture();
    try {
      f.facts.begin(f.session, f.command, f.connection, true);
      if (stage === 'ready') f.facts.finishPreparation(f.facts.get(f.session)!);
      f.facts.uncertain(f.session, f.command);
      const before = f.facts.get(f.session)!;
      assert.equal(before.reason, 'preparation_unknown');
      assert.equal(f.facts.finishPreparation(before), false);
      assert.equal(f.facts.begin(f.session, f.command, f.connection), false);
      assert.equal(f.ack(), false);
      assert.deepEqual(f.facts.get(f.session), before);
    } finally { f.db.close(); }
  });
}

test('Codex preparation finish requires the exact owner revision and is single-use', () => {
  const f = fixture();
  try {
    f.facts.begin(f.session, f.command, f.connection, true);
    const expected = f.facts.get(f.session)!;
    for (const change of [{ commandId: 'other' }, { connectionId: 'other' }, { revision: expected.revision + 1 }, { sessionKey: 'other' }]) {
      assert.equal(f.facts.finishPreparation({ ...expected, ...change }), false);
      assert.deepEqual(f.facts.get(f.session), expected);
    }
    assert.equal(f.facts.finishPreparation(expected), true);
    assert.equal(f.facts.finishPreparation(expected), false);
    assert.equal(f.facts.finishPreparation(f.facts.get(f.session)!), false);
  } finally { f.db.close(); }
});

for (const operation of ['begin', 'finish', 'consume'] as const) {
  test(`Codex preparation ${operation} rolls back with its journal on persistence failure`, () => {
    const f = fixture();
    try {
      if (operation !== 'begin') f.facts.begin(f.session, f.command, f.connection, true);
      if (operation === 'consume') f.facts.finishPreparation(f.facts.get(f.session)!);
      const before = f.facts.get(f.session), count = f.eventCount();
      f.db.exec(`CREATE TRIGGER fail_codex_event BEFORE INSERT ON connector_events BEGIN SELECT RAISE(ABORT, 'synthetic journal failure'); END`);
      assert.throws(() => operation === 'finish' ? f.facts.finishPreparation(before!)
        : f.facts.begin(f.session, f.command, f.connection, operation === 'begin'), /synthetic journal failure/);
      assert.deepEqual(f.facts.get(f.session), before);
      assert.equal(f.eventCount(), count);
    } finally { f.db.close(); }
  });
}

test('Codex begin and ACK publish facts and queue deletion in the owning transaction only', () => {
  const f = fixture();
  try {
    f.admit();
    assert.equal(f.facts.get(f.session)?.phase, 'starting');
    assert.equal(f.queue.head('codex', f.session)?.state, 'dispatching');
    assert.equal(f.eventCount(), 1);
    assert.equal(f.facts.begin(f.session, f.command, f.connection), false);
    assert.equal(f.facts.canStart(f.session), false);
    assert.equal(f.ack(), true);
    assert.equal(f.facts.get(f.session)?.runId, f.run);
    assert.equal(f.facts.get(f.session)?.phase, 'running');
    assert.equal(f.eventCount(), 2);
    assert.equal(f.queue.head('codex', f.session), undefined);
    const before = f.facts.get(f.session);
    assert.equal(f.ack(), true);
    assert.deepEqual(f.facts.get(f.session), before);
    assert.equal(f.eventCount(), 2, 'duplicate ACK is idempotent');
  } finally { f.db.close(); }
});

test('Codex local dispatch errors cannot erase a durably acknowledged running fact', () => {
  const f = fixture();
  try {
    f.admit(); f.ack();
    const before = f.facts.get(f.session), events = f.eventCount();
    assert.equal(f.facts.uncertain(f.session, f.command), false);
    assert.deepEqual(f.facts.get(f.session), before);
    assert.equal(f.eventCount(), events);
  } finally { f.db.close(); }
});

for (const fault of ['queue', 'journal']) {
  test(`Codex ${fault} failure rolls back ACK, event and pending deletion together`, () => {
    const f = fixture();
    try {
      f.admit();
      const before = f.facts.get(f.session);
      if (fault === 'journal') f.db.exec(`CREATE TRIGGER fail_codex_event BEFORE INSERT ON connector_events BEGIN SELECT RAISE(ABORT, 'injected journal failure'); END`);
      assert.throws(() => f.facts.acknowledge(f.session, f.command, f.connection, f.run, (db) => {
        f.queue.completeInTransaction(db, 'codex', f.command);
        throw new Error('injected queue failure');
      }), /injected/);
      assert.deepEqual(f.facts.get(f.session), before);
      assert.equal(f.queue.head('codex', f.session)?.state, 'dispatching');
      assert.equal(f.eventCount(), 1);
      assert.equal(f.facts.canStart(f.session), false);
    } finally { f.db.close(); }
  });
}

test('Codex ACK rejects a queue belonging to another SQLite connection', () => {
  const f = fixture(), foreign = new DatabaseSync(':memory:');
  try {
    const queue = new TurnQueue(foreign);
    f.admit();
    assert.throws(() => f.queue.completeInTransaction(f.db, 'codex', f.command), /owning transaction/);
    assert.throws(() => f.facts.acknowledge(f.session, f.command, f.connection, f.run,
      (db) => queue.completeInTransaction(db, 'codex', f.command)), /owning transaction/);
    assert.equal(f.facts.get(f.session)?.runId, undefined);
    assert.equal(f.queue.head('codex', f.session)?.state, 'dispatching');
  } finally { f.db.close(); foreign.close(); }
});

for (const phase of ['completed', 'failed', 'interrupted'] as const) {
  for (const early of [true, false]) {
    test(`Codex ${phase} ${early ? 'before' : 'after'} ACK is absorbing and history is a separate gate`, () => {
      const f = fixture();
      try {
        f.admit();
        if (!early) f.ack();
        f.facts.observe(f.session, f.connection, f.run, 'running');
        f.facts.observe(f.session, f.connection, f.run, phase);
        f.facts.observe(f.session, f.connection, f.run, 'running');
        if (early) {
          assert.equal(f.facts.get(f.session)?.runId, undefined);
          f.facts.uncertain(f.session, f.command);
          assert.equal(f.facts.get(f.session)?.phase, 'unknown');
          const before = f.facts.get(f.session), events = f.eventCount();
          assert.equal(f.settle(), false, 'unbound history cannot certify the command');
          assert.deepEqual(f.facts.get(f.session), before);
          assert.equal(f.eventCount(), events);
          f.ack();
          assert.equal(f.facts.get(f.session)?.sync, 'syncing');
          f.settle();
        } else {
          assert.equal(f.facts.get(f.session)?.sync, 'syncing');
          assert.deepEqual(f.facts.recoveryPage('', 1), [f.session]);
          assert.equal(f.facts.canStart(f.session), false);
          f.settle('error');
          assert.equal(f.facts.get(f.session)?.phase, phase);
          f.settle();
        }
        assert.equal(f.facts.get(f.session)?.phase, phase);
        assert.equal(f.facts.get(f.session)?.sync, 'current');
        assert.equal(f.facts.canStart(f.session), true);
        const before = f.facts.get(f.session), count = f.eventCount();
        f.facts.observe(f.session, f.connection, f.run, 'running');
        f.facts.observe(f.session, f.connection, f.run, phase);
        f.facts.uncertain(f.session, f.command);
        f.settle();
        assert.deepEqual(f.facts.get(f.session), before);
        assert.equal(f.eventCount(), count);
        assert.deepEqual(f.facts.recoveryPage('', 1), []);
        assert.equal(f.facts.begin(f.session, 'successor', f.connection), true);
        f.settle('error');
        assert.equal(f.facts.get(f.session)?.sync, 'current', 'old history cannot settle the successor');
        assert.equal(f.facts.get(f.session)?.phase, 'starting');
      } finally { f.db.close(); }
    });
  }
}

for (const phase of ['completed', 'failed', 'interrupted'] as const) {
  test(`Codex legacy pre-ACK ${phase} sync marker cannot certify a newly bound reply`, () => {
    const f = fixture();
    try {
      f.admit();
      f.facts.observe(f.session, f.connection, f.run, phase);
      f.db.prepare("UPDATE connector_codex_executions SET fact = json_set(fact, '$.pending[0].sync', 'current') WHERE session_key = ?").run(f.session);
      f.ack();
      assert.equal(f.facts.get(f.session)?.phase, phase);
      assert.equal(f.facts.get(f.session)?.sync, 'syncing');
      assert.equal(f.facts.canStart(f.session), false);
      assert.deepEqual(f.facts.recoveryPage('', 64), [f.session]);
      f.settle();
      assert.equal(f.facts.canStart(f.session), true);
    } finally { f.db.close(); }
  });
}

test('Codex wrong connection/command cannot bind; conflicting native ACK fences dispatch', () => {
  const f = fixture();
  try {
    f.admit();
    const before = f.facts.get(f.session);
    assert.equal(f.facts.observe(f.session, 'foreign', f.run, 'completed'), false);
    for (const [command, connection] of [['foreign', f.connection], [f.command, 'foreign']]) {
      assert.equal(f.facts.acknowledge(f.session, command!, connection!, f.run, () => assert.fail('must not commit')), false);
    }
    assert.deepEqual(f.facts.get(f.session), before);
    f.ack();
    assert.equal(f.ack('conflicting'), false);
    assert.equal(f.facts.get(f.session)?.reason, 'identity_conflict');
    assert.equal(f.facts.canStart(f.session), false);
    f.facts.observe(f.session, f.connection, f.run, 'completed');
    assert.equal(f.facts.get(f.session)?.phase, 'unknown');
  } finally { f.db.close(); }
});

test('Codex bounded pre-ACK evidence fences overflow and conflicting running identity', () => {
  for (const overflow of [true, false]) {
    const f = fixture();
    try {
      f.admit();
      for (let index = 0; index < (overflow ? 5 : 1); index++) f.facts.observe(f.session, f.connection, `other-${index}`, 'running');
      assert.equal(f.ack(), false);
      assert.equal(f.facts.get(f.session)?.reason, overflow ? 'evidence_overflow' : 'identity_conflict');
      assert.equal(f.queue.head('codex', f.session)?.state, 'dispatching');
      assert.equal(f.facts.canStart(f.session), false);
    } finally { f.db.close(); }
  }
});

test('Codex row reservation leaves capacity for maximal ACK and terminal metadata', () => {
  const f = fixture(1);
  try {
    const session = 's'.repeat(4094), command = 'c'.repeat(510), connection = 'x'.repeat(126), run = 'n'.repeat(510);
    assert.equal(f.facts.begin(session, command, connection), true);
    assert.throws(() => f.facts.begin('another-session', command, connection), /capacity/);
    for (let index = 0; index < 4; index++) f.facts.observe(session, connection, index ? `${index}${run.slice(1)}` : run, 'completed');
    f.facts.settleHistory({ sessionKey: session, commandId: command, runId: run }, 'error');
    assert.equal(f.facts.acknowledge(session, command, connection, run, () => {}), true);
    assert.equal(f.facts.get(session)?.phase, 'completed');
    f.facts.settleHistory({ sessionKey: session, commandId: command, runId: run }, 'current');
    assert.equal(f.facts.begin(session, 'next', connection), true, 'existing sessions need no new row reservation');
    const size = (f.db.prepare('SELECT length(CAST(fact AS BLOB)) AS n FROM connector_codex_executions').get() as { n: number }).n;
    assert.ok(size <= 8192);
    for (const invalid of ['', ' ', '\n', 'x'.repeat(511), '😀'.repeat(128)]) {
      assert.throws(() => f.facts.acknowledge(session, 'next', connection, invalid, () => {}), /identity/);
    }
  } finally { f.db.close(); }
});

test('Codex recovery retains native identity, fences uncompleted work, and is idempotent', () => {
  const f = fixture();
  try {
    f.admit(); f.ack();
    f.facts.recoverInterrupted();
    assert.equal(f.queue.head('codex', f.session), undefined);
    assert.equal(f.facts.get(f.session)?.phase, 'unknown');
    assert.equal(f.facts.get(f.session)?.reason, 'restarted');
    assert.equal(f.facts.get(f.session)?.runId, f.run);
    assert.equal(f.facts.canStart(f.session), false);
    const before = f.facts.get(f.session), count = f.eventCount();
    f.facts.recoverInterrupted();
    f.facts.observe(f.session, 'new-connection', f.run, 'completed');
    assert.deepEqual(f.facts.get(f.session), before);
    assert.equal(f.eventCount(), count);
  } finally { f.db.close(); }
});

for (const phase of ['starting', 'send_unknown', 'running'] as const) {
  for (const callback of ['ack', 'notification', 'uncertain-then-ack'] as const) {
    test(`Codex restarted ${phase} storage rejects old-owner ${callback} without releasing the queue`, () => {
      const f = fixture();
      try {
        f.admit();
        if (phase === 'running') f.ack();
        if (phase === 'send_unknown') f.facts.uncertain(f.session, f.command);
        f.queue.enqueue('codex', { id: 'successor', sessionKey: f.session, createdAt: 2, payload: { text: 'synthetic successor' } });
        f.facts.recoverInterrupted(); f.queue.recoverInterrupted('codex');
        const before = f.facts.get(f.session), queued = f.queue.list('codex'), count = f.eventCount();
        // Exercise the storage contract directly. Production additionally has
        // owner locking and adapter connection fencing; this is not evidence
        // that concurrent old/new native processes can acquire the database.
        if (callback === 'uncertain-then-ack') assert.equal(f.facts.uncertain(f.session, f.command), false);
        if (callback === 'notification') {
          assert.equal(f.facts.observe(f.session, f.connection, f.run, 'running'), false);
          assert.equal(f.facts.observe(f.session, f.connection, f.run, 'completed'), false);
        } else {
          assert.equal(f.facts.acknowledge(f.session, f.command, f.connection, f.run,
            () => assert.fail('restarted callback cannot commit ACK or delete queue entry')), false);
        }
        assert.equal(f.settle(), false);
        assert.deepEqual(f.facts.get(f.session), before);
        assert.deepEqual(f.queue.list('codex'), queued);
        assert.equal(f.eventCount(), count);
        assert.equal(f.facts.canStart(f.session), false);
        assert.equal(f.facts.begin(f.session, 'successor', 'new-connection'), false);
      } finally { f.db.close(); }
    });
  }
}

for (const phase of ['completed', 'failed', 'interrupted'] as const) {
  test(`Codex restart retains ${phase} but invalidates the previous process history cache`, () => {
    const f = fixture();
    try {
      f.admit(); f.ack(); f.facts.observe(f.session, f.connection, f.run, phase); f.settle();
      const before = f.facts.get(f.session)!;
      f.facts.recoverInterrupted();
      const after = f.facts.get(f.session)!;
      assert.equal(after.sync, 'syncing');
      assert.deepEqual({ ...after, sync: before.sync, revision: before.revision, updatedAt: before.updatedAt }, before);
      assert.equal(after.revision, before.revision + 1);
      assert.equal(f.facts.canStart(f.session), false);
      assert.deepEqual(f.facts.recoveryPage('', 64), [f.session]);
      const events = f.eventCount();
      f.facts.recoverInterrupted();
      assert.deepEqual(f.facts.get(f.session), after);
      assert.equal(f.eventCount(), events, 'already invalidated cache does not generate another event');
      f.settle();
      assert.equal(f.facts.canStart(f.session), true);
      assert.deepEqual(f.facts.recoveryPage('', 64), []);
    } finally { f.db.close(); }
  });
}

test('Codex restart invalidation rolls back all facts and journal entries if publishing fails', () => {
  const f = fixture();
  try {
    for (const sessionKey of ['codex:a', 'codex:b']) {
      f.facts.begin(sessionKey, 'command', f.connection);
      f.facts.acknowledge(sessionKey, 'command', f.connection, 'native', () => {});
      f.facts.observe(sessionKey, f.connection, 'native', 'completed');
      f.facts.settleHistory({ sessionKey, commandId: 'command', runId: 'native' }, 'current');
    }
    const before = ['codex:a', 'codex:b'].map((key) => f.facts.get(key)), events = f.eventCount();
    const append = f.events.appendInTransaction.bind(f.events);
    let writes = 0;
    f.events.appendInTransaction = (...args) => {
      if (++writes === 2) throw new Error('synthetic journal failure');
      return append(...args);
    };
    assert.throws(() => f.facts.recoverInterrupted(), /synthetic journal failure/);
    assert.equal(writes, 2);
    assert.deepEqual(['codex:a', 'codex:b'].map((key) => f.facts.get(key)), before);
    assert.equal(f.eventCount(), events);
    f.events.appendInTransaction = append;
    f.facts.recoverInterrupted();
    assert.deepEqual(f.facts.recoveryPage('', 64), ['codex:a', 'codex:b']);
  } finally { f.db.close(); }
});

test('Codex terminal history pages are bounded, ordered and indexed; recovery cannot reopen terminals', () => {
  const f = fixture();
  try {
    for (const session of ['codex:c', 'codex:b', 'codex:a']) {
      f.facts.begin(session, 'command', f.connection);
      f.facts.acknowledge(session, 'command', f.connection, f.run, () => {});
      f.facts.observe(session, f.connection, f.run, 'completed');
    }
    assert.deepEqual(f.facts.recoveryPage('', 2), ['codex:a', 'codex:b']);
    assert.deepEqual(f.facts.recoveryPage('codex:b', 2), ['codex:c']);
    const before = f.facts.get('codex:a');
    f.facts.recoverInterrupted();
    assert.deepEqual(f.facts.get('codex:a'), before);
    const plan = f.db.prepare(`EXPLAIN QUERY PLAN SELECT session_key FROM connector_codex_executions WHERE session_key > ?
      AND json_extract(fact, '$.phase') IN ('completed', 'failed', 'interrupted')
      AND json_extract(fact, '$.sync') <> 'current' ORDER BY session_key LIMIT 16`).all('');
    assert.match(JSON.stringify(plan), /USING INDEX connector_codex_sync/);
  } finally { f.db.close(); }
});

test('Codex recovery merges indexed terminal, running and restarted pages without scanning settled facts', () => {
  const f = fixture();
  try {
    const sessions = Array.from({ length: 70 }, (_, index) => `codex:${String(index).padStart(3, '0')}`);
    for (const [index, session] of sessions.entries()) {
      f.facts.begin(session, 'command', f.connection);
      f.facts.acknowledge(session, 'command', f.connection, f.run, () => {});
      if (index % 2) f.facts.observe(session, f.connection, f.run, 'completed');
    }
    for (const [key, connection] of [['codex:foreign', 'foreign-connection'], ['codex:settled', f.connection]]) {
      f.facts.begin(key!, 'command', connection!);
      f.facts.acknowledge(key!, 'command', connection!, f.run, () => {});
      if (key === 'codex:settled') {
        f.facts.observe(key, connection!, f.run, 'completed');
        f.facts.settleHistory({ sessionKey: key, commandId: 'command', runId: f.run }, 'current');
      }
    }
    f.facts.begin('codex:starting', 'command', f.connection);
    assert.deepEqual(f.facts.recoveryPage('', 1000, f.connection), sessions.slice(0, 64));
    assert.deepEqual(f.facts.recoveryPage(sessions[63]!, 64, f.connection), sessions.slice(64));
    assert.deepEqual(f.facts.recoveryPage('', 64), sessions.filter((_, index) => index % 2));
    let query = '';
    const prepare = f.db.prepare.bind(f.db);
    f.db.prepare = (sql) => { query = sql; return prepare(sql); };
    f.facts.recoveryPage('', 64, f.connection);
    f.db.prepare = prepare;
    const plan = JSON.stringify(prepare(`EXPLAIN QUERY PLAN ${query}`).all('', '', f.connection, '', 64));
    assert.match(plan, /USING INDEX connector_codex_sync/);
    assert.match(plan, /USING INDEX connector_codex_running/);
    assert.match(plan, /USING INDEX connector_codex_restarted/);
    assert.doesNotMatch(plan, /SCAN connector_codex_executions|USE TEMP B-TREE/);
    f.facts.recoverInterrupted();
    assert.deepEqual(f.facts.recoveryPage('', 64, f.connection), sessions.slice(0, 64));
    assert.deepEqual(f.facts.recoveryPage(sessions[63]!, 64, f.connection), [...sessions.slice(64), 'codex:foreign', 'codex:settled']);
  } finally { f.db.close(); }
});

test('Codex restart invalidates settled history across pages without rewriting pending history', () => {
  const f = fixture();
  try {
    const sessions = Array.from({ length: 130 }, (_, index) => `codex:${String(index).padStart(3, '0')}`);
    for (const sessionKey of sessions) {
      f.facts.begin(sessionKey, 'command', f.connection);
      f.facts.acknowledge(sessionKey, 'command', f.connection, f.run, () => {});
      f.facts.observe(sessionKey, f.connection, f.run, 'completed');
      f.facts.settleHistory({ sessionKey, commandId: 'command', runId: f.run }, 'current');
    }
    for (const sync of ['syncing', 'error'] as const) {
      const sessionKey = `codex:${sync}`;
      f.facts.begin(sessionKey, 'command', f.connection);
      f.facts.acknowledge(sessionKey, 'command', f.connection, f.run, () => {});
      f.facts.observe(sessionKey, f.connection, f.run, 'completed');
      if (sync === 'error') f.facts.settleHistory({ sessionKey, commandId: 'command', runId: f.run }, sync);
    }
    const pending = ['codex:syncing', 'codex:error'].map((key) => f.facts.get(key));
    const before = sessions.map((key) => f.facts.get(key)!);
    const events = f.eventCount();
    f.facts.recoverInterrupted();
    assert.equal(f.eventCount(), events + sessions.length);
    assert.deepEqual(['codex:syncing', 'codex:error'].map((key) => f.facts.get(key)), pending);
    for (const [index, sessionKey] of sessions.entries()) {
      const fact = f.facts.get(sessionKey)!;
      assert.equal(fact.sync, 'syncing');
      assert.equal(fact.revision, before[index]!.revision + 1);
      assert.equal(f.facts.canStart(sessionKey), false);
    }
    const recovered: string[] = [];
    for (;;) {
      const page = f.facts.recoveryPage(recovered.at(-1) ?? '', 64);
      if (!page.length) break;
      recovered.push(...page);
    }
    assert.deepEqual(recovered, [...sessions, 'codex:error', 'codex:syncing']);
    f.facts.recoverInterrupted();
    assert.equal(f.eventCount(), events + sessions.length);
  } finally { f.db.close(); }
});

test('Codex read evidence requires the captured command, connection, native ID and revision', () => {
  const f = fixture();
  try {
    f.admit(); f.ack();
    const expected = f.facts.get(f.session)!;
    assert.equal(f.facts.observe(f.session, 'replacement', f.run, 'completed', expected), false);
    assert.equal(f.facts.observe(f.session, f.connection, 'foreign', 'completed', expected), false);
    assert.equal(f.facts.observe(f.session, f.connection, f.run, 'completed', { ...expected, commandId: 'foreign' }), false);
    assert.equal(f.facts.observe(f.session, f.connection, f.run, 'completed', { ...expected, revision: expected.revision - 1 }), false);
    assert.deepEqual(f.facts.get(f.session), expected);
    assert.equal(f.facts.observe(f.session, f.connection, f.run, 'completed', expected), true);
    f.settle();
    f.facts.begin(f.session, 'successor', f.connection);
    f.facts.acknowledge(f.session, 'successor', f.connection, f.run, () => {});
    assert.equal(f.facts.observe(f.session, f.connection, f.run, 'failed', expected), false, 'native ID reuse cannot erase command generation');
    assert.equal(f.facts.get(f.session)?.phase, 'running');
  } finally { f.db.close(); }
});
