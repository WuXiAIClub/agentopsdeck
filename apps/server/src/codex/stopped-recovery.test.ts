import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { recoverableConnection, connectionRecoverySnapshot, StorageConnectionUnavailable } from '../storage/connection-recovery.js';
import { initializeStoppedCodexRecovery, recordStoppedCodexRecovery, hasStoppedCodexRecovery, sameStoppedCodexRuns } from './stopped-recovery.js';

test('run equality ignores JSON field/row order but rejects changed identities, revisions and duplicate sessions', () => {
  const first = { sessionKey: 'codex:a', commandId: 'command', connectionId: 'connection', runId: 'run', revision: 7 };
  const reordered = { revision: 7, runId: 'run', connectionId: 'connection', commandId: 'command', sessionKey: 'codex:a' };
  const second = { ...first, sessionKey: 'codex:b' };
  assert.equal(sameStoppedCodexRuns([first, second], [second, reordered]), true);
  for (const patch of [{ commandId: 'new' }, { connectionId: 'new' }, { runId: 'new' }, { revision: 8 }, { sessionKey: 'codex:new' }])
    assert.equal(sameStoppedCodexRuns([first], [{ ...reordered, ...patch }]), false);
  assert.equal(sameStoppedCodexRuns([first, first], [first, reordered]), false);
  assert.equal(sameStoppedCodexRuns([first], []), false);
  assert.equal(sameStoppedCodexRuns(undefined, undefined), false);
});

function fixture(context: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-stopped-proof-'));
  const db = new DatabaseSync(join(directory, 'connector.sqlite'));
  context.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  db.exec(`PRAGMA synchronous=FULL;
    CREATE TABLE connector_identity (singleton INTEGER, node_id TEXT);
    INSERT INTO connector_identity VALUES (1, 'node');
    CREATE TABLE connector_codex_executions (session_key TEXT, fact TEXT);`);
  initializeStoppedCodexRecovery(db);
  const run = { sessionKey: 'codex:thread', commandId: 'command', connectionId: 'connection', runId: 'turn', revision: 2 };
  const fact = { ...run, phase: 'interrupted', sync: 'error', updatedAt: Date.now() - 100 };
  const put = (value: typeof fact) => {
    db.prepare('DELETE FROM connector_codex_executions').run();
    db.prepare('INSERT INTO connector_codex_executions VALUES (?, ?)').run(value.sessionKey, JSON.stringify(value));
  };
  put(fact);
  const proof = { nodeId: 'node', jobId: 'job', fenceId: 'empty-cgroup', backupId: 'verified-backup', verifiedAt: Date.now() };
  return { db, run, fact, proof, put };
}

test('stopped proof only clears exact interrupted run identity, never another node or dispatch', context => {
  const { db, run, fact, proof } = fixture(context);
  const before = db.prepare('SELECT fact FROM connector_codex_executions').get();
  recordStoppedCodexRecovery(db, [run], proof);
  assert.deepEqual(db.prepare('SELECT fact FROM connector_codex_executions').get(), before);
  assert.equal(hasStoppedCodexRecovery(db, { ...fact, revision: 3 }, run.runId), true);
  for (const patch of [{ runId: 'other' }, { commandId: 'other' }, { connectionId: 'other' },
    { phase: 'running' }, { fenced: true }, { preparation: {} }, { revision: 1 }]) {
    assert.equal(hasStoppedCodexRecovery(db, { ...fact, ...patch }, run.runId), false);
  }
  db.prepare('UPDATE connector_identity SET node_id = ?').run('replacement-node');
  assert.equal(hasStoppedCodexRecovery(db, fact, run.runId), false);
});

test('invalid terminal or backup chronology never creates a partial proof batch', context => {
  const { db, run, fact, proof, put } = fixture(context);
  for (const patch of [{ phase: 'unknown' }, { phase: 'running' }, { sync: 'current' }, { revision: 1 }]) {
    put({ ...fact, ...patch });
    assert.throws(() => recordStoppedCodexRecovery(db, [run], proof));
  }
  put(fact);
  assert.throws(() => recordStoppedCodexRecovery(db, [run], { ...proof, verifiedAt: fact.updatedAt - 1 }));
  assert.throws(() => recordStoppedCodexRecovery(db, [run, { ...run, sessionKey: 'codex:missing' }], proof));
  assert.equal(db.prepare('SELECT count(*) AS total FROM connector_codex_stopped_recovery').get()!.total, 0);
  put({ ...fact, sync: 'current', nativeHistory: { state: 'blocked', reason: 'cleanup-unconfirmed', turnId: run.runId, verifiedAt: fact.updatedAt } } as typeof fact);
  recordStoppedCodexRecovery(db, [run], proof);
  assert.equal(hasStoppedCodexRecovery(db, fact, run.runId), true);
});

for (const boundary of ['BEGIN IMMEDIATE', 'COMMIT'] as const) for (const executed of [false, true]) {
  test(`stopped proof lost ${boundary} ACK preserves original error and never replays (${executed})`, context => {
    const f = fixture(context), logs: string[] = [], statements: string[] = [];
    const diagnostics = new PerformanceDiagnostics(line => logs.push(line));
    const db = recoverableConnection(f.db, diagnostics), exec = db.exec;
    const original = Error('private-boundary-secret');
    db.exec = sql => {
      statements.push(sql);
      if (sql === boundary) { if (executed) exec(sql); throw original; }
      exec(sql);
    };
    assert.throws(() => recordStoppedCodexRecovery(db, [f.run], f.proof, diagnostics), error => error === original);
    db.exec = exec;
    assert.equal(db.isTransaction, false);
    assert.equal(statements.filter(sql => sql === boundary).length, 1);
    assert.equal(Number(db.prepare('SELECT count(*) n FROM connector_codex_stopped_recovery').get()!.n),
      boundary === 'COMMIT' && executed ? 1 : 0);
    assert.equal(logs.map(line => JSON.parse(line)).find(row => row.operation === 'codex-stopped-recovery')?.unknown, 1);
    assert.doesNotMatch(logs.join('\n'), /private-boundary|codex:thread|verified-backup|connector.sqlite|SELECT|COMMIT/);
  });
}

test('stopped proof failed rollback fences cached statements and recovers only cleanup on later access', context => {
  const f = fixture(context), logs: string[] = [];
  const diagnostics = new PerformanceDiagnostics(line => logs.push(line));
  let clock = 0, broken = true, commits = 0;
  const db = recoverableConnection(f.db, diagnostics, () => clock), exec = db.exec;
  const cached = db.prepare('SELECT count(*) n FROM connector_codex_stopped_recovery');
  const original = Error('private-commit-secret');
  db.exec = sql => {
    if (sql === 'COMMIT') { commits++; throw original; }
    if (sql === 'ROLLBACK' && broken) throw Error('private-cleanup-secret');
    exec(sql);
  };
  assert.throws(() => recordStoppedCodexRecovery(db, [f.run], f.proof, diagnostics), error => error === original);
  assert.equal(connectionRecoverySnapshot(db).state, 'owner-rollback-required');
  assert.throws(() => cached.get(), StorageConnectionUnavailable);
  assert.throws(() => recordStoppedCodexRecovery(db, [f.run], f.proof, diagnostics), StorageConnectionUnavailable);
  broken = false; clock += 1001;
  assert.throws(() => cached.get(), StorageConnectionUnavailable, 'cleanup must abort the triggering request');
  assert.equal(connectionRecoverySnapshot(db).state, 'ready');
  assert.equal(cached.get()!.n, 0); assert.equal(commits, 1);
  assert.ok(logs.map(line => JSON.parse(line)).some(row => row.rollbackFailed === 1 && row.unknown === 1));
  assert.ok(logs.map(line => JSON.parse(line)).some(row => row.recovered === 1));
  assert.doesNotMatch(logs.join('\n'), /private-|codex:thread|verified-backup|connector.sqlite/);
});

test('stopped proof rejects foreign transactions without settling them, even with a failing log sink', context => {
  const f = fixture(context), diagnostics = new PerformanceDiagnostics(() => { throw Error('private-sink'); });
  f.db.exec('BEGIN IMMEDIATE');
  f.db.prepare('UPDATE connector_identity SET node_id = ?').run('foreign-write');
  assert.throws(() => recordStoppedCodexRecovery(f.db, [f.run], f.proof, diagnostics), /owning database boundary/);
  assert.equal(f.db.isTransaction, true);
  assert.equal(f.db.prepare('SELECT node_id FROM connector_identity').get()!.node_id, 'foreign-write');
  f.db.exec('ROLLBACK');
  assert.equal(f.db.prepare('SELECT node_id FROM connector_identity').get()!.node_id, 'node');
  recordStoppedCodexRecovery(f.db, [f.run], f.proof, diagnostics);
  assert.equal(hasStoppedCodexRecovery(f.db, f.fact, f.run.runId), true);
});

test('stopped proof rechecks deadline after acquiring a lock and before committing inserts', context => {
  const f = fixture(context), exec = f.db.exec, prepare = f.db.prepare;
  let deadline = Date.now() + 60_000;
  f.db.exec = sql => {
    exec.call(f.db, sql);
    if (sql === 'BEGIN IMMEDIATE') deadline = Date.now() - 1;
  };
  // The optional deadline is captured before BEGIN; advance wall clock at the
  // lock boundary rather than mutate the captured deadline.
  const now = Date.now;
  Date.now = () => deadline < now() ? now() + 120_000 : now();
  try {
    assert.throws(() => recordStoppedCodexRecovery(f.db, [f.run], f.proof, undefined, deadline));
  } finally { Date.now = now; f.db.exec = exec; }
  assert.equal(f.db.isTransaction, false);
  assert.equal(f.db.prepare('SELECT count(*) n FROM connector_codex_stopped_recovery').get()!.n, 0);
  deadline = Date.now() + 60_000;
  let inserted = false;
  f.db.prepare = sql => {
    const statement = prepare.call(f.db, sql);
    if (sql.startsWith('INSERT INTO connector_codex_stopped_recovery')) {
      const run = statement.run.bind(statement);
      statement.run = (...args) => { const result = Reflect.apply(run, statement, args); inserted = true; return result; };
    }
    return statement;
  };
  Date.now = () => now() + (inserted ? 120_000 : 0);
  try {
    assert.throws(() => recordStoppedCodexRecovery(f.db, [f.run], f.proof, undefined, deadline));
  } finally { Date.now = now; f.db.prepare = prepare; }
  assert.equal(inserted, true);
  assert.equal(f.db.isTransaction, false);
  assert.equal(f.db.prepare('SELECT count(*) n FROM connector_codex_stopped_recovery').get()!.n, 0);
});
