import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { Worker } from 'node:worker_threads';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { recoverableConnection } from '../storage/connection-recovery.js';
import { registerNativeHistoryWriter } from './native-history.js';
import { registerNativeResumeWriter } from './native-resume.js';
import { disposeStoppedUnknown, inspectStoppedUnknown, type StoppedUnknownDisposition } from './stopped-unknown-disposition.js';
import { disposeStoppedUnknownOwned, StoppedUnknownOwnerUnavailable, type StoppedUnknownOwnerRequest } from './stopped-unknown-owner.js';

function fixture(context: test.TestContext, reason: 'restarted' | 'send_unknown' = 'restarted') {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-unknown-disposition-')), file = join(directory, 'connector.sqlite');
  const db = new DatabaseSync(file); chmodSync(file, 0o600);
  context.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  db.exec(`PRAGMA synchronous=FULL;
    CREATE TABLE connector_identity(singleton INTEGER, node_id TEXT);
    INSERT INTO connector_identity VALUES (1, 'node');
    CREATE TABLE connector_codex_executions(session_key TEXT PRIMARY KEY, fact TEXT);
    CREATE TABLE connector_codex_native_resume(session_key TEXT PRIMARY KEY REFERENCES connector_codex_executions(session_key), record TEXT);
    CREATE TABLE connector_turns(sequence INTEGER PRIMARY KEY AUTOINCREMENT, runtime TEXT, id TEXT,
      session_key TEXT, created_at INTEGER, state TEXT, payload TEXT, revision INTEGER);
    CREATE TABLE command_receipts(id TEXT PRIMARY KEY, receipt TEXT);
    INSERT INTO command_receipts VALUES ('original', 'accepted-not-native-completion');
    CREATE TABLE connector_turn_usage(rows INTEGER); INSERT INTO connector_turn_usage VALUES(0);
    CREATE TRIGGER count_insert AFTER INSERT ON connector_turns BEGIN UPDATE connector_turn_usage SET rows=rows+1; END;
    CREATE TRIGGER count_delete AFTER DELETE ON connector_turns BEGIN UPDATE connector_turn_usage SET rows=rows-1; END;
    CREATE TRIGGER native_history_guard BEFORE DELETE ON connector_codex_executions
      WHEN agentopsdeck_codex_native_history_epoch() IS NOT 1 BEGIN SELECT RAISE(ABORT, 'wrong history writer'); END;
    CREATE TRIGGER native_resume_guard BEFORE DELETE ON connector_codex_executions
      WHEN agentopsdeck_codex_native_resume_epoch() IS NOT 1 BEGIN SELECT RAISE(ABORT, 'wrong resume writer'); END;`);
  registerNativeHistoryWriter(db); registerNativeResumeWriter(db);
  const sessionKey = 'codex:synthetic', commandId = sessionKey + ':queued-original';
  const fact = JSON.stringify({ sessionKey, commandId, connectionId: 'original-connection', phase: 'unknown', sync: 'current',
    revision: 3, startedAt: Date.now() - 2000, updatedAt: Date.now() - 1000, pending: [], reason });
  db.prepare('INSERT INTO connector_codex_executions VALUES (?, ?)').run(sessionKey, fact);
  db.prepare('INSERT INTO connector_codex_executions VALUES (?, ?)').run('codex:other', fact);
  const insert = db.prepare("INSERT INTO connector_turns(runtime,id,session_key,created_at,state,payload,revision) VALUES ('codex',?,?,1,?,?,1)");
  insert.run(commandId, sessionKey, 'outcome_unknown', '{"message":"synthetic-private-original"}');
  for (let index = 0; index < 36; index++) insert.run('successor-' + index, sessionKey, 'queued', '{"message":"synthetic-successor-' + index + '"}');
  insert.run('unrelated', 'codex:other', 'outcome_unknown', '{"message":"synthetic-other"}');
  const disposition: StoppedUnknownDisposition = { expected: inspectStoppedUnknown(db, sessionKey),
    proof: { nodeId: 'node', jobId: 'unique-job', backupId: 'verified-encrypted-backup', verifiedAt: Date.now(),
      serviceInvocation: 'a'.repeat(32), ownerPid: 12345, physicalStopSha256: 'b'.repeat(64) },
    consentId: 'explicit-synthetic-consent', action: 'retain-unknown-without-replay' };
  const state = statSync(file, { bigint: true });
  const request: StoppedUnknownOwnerRequest = { file, dev: state.dev.toString(), ino: state.ino.toString(), deadline: Date.now() + 60_000, disposition };
  return { db, file, fact, sessionKey, commandId, disposition, request };
}

for (const reason of ['restarted', 'send_unknown'] as const)
test('audited disposition retains exact unknown bytes, all 36 successors, other sessions and original receipts: ' + reason, context => {
  const value = fixture(context, reason), { db } = value;
  const before = db.prepare('SELECT * FROM connector_turns ORDER BY sequence').all();
  const receipts = db.prepare('SELECT * FROM command_receipts').all();
  disposeStoppedUnknown(db, value.disposition);
  const audit = db.prepare('SELECT * FROM connector_codex_unknown_dispositions').get()!;
  assert.equal(audit.original_fact, value.fact);
  assert.deepEqual(JSON.parse(String(audit.original_queue)), { ...before[0], sequence: String(before[0]!.sequence) });
  assert.deepEqual(db.prepare('SELECT * FROM connector_turns ORDER BY sequence').all(), before.slice(1));
  assert.deepEqual(db.prepare('SELECT * FROM command_receipts').all(), receipts);
  assert.equal(db.prepare('SELECT count(*) AS count FROM connector_codex_executions').get()!.count, 1);
  assert.equal(db.prepare('SELECT rows FROM connector_turn_usage').get()!.rows, 37);
  const receipt = JSON.parse(String(audit.receipt));
  assert.equal(receipt.action, 'retain-unknown-without-replay');
  assert.equal(receipt.expected.successorCount, 36);
  assert.equal(receipt.phase, undefined);
  assert.throws(() => disposeStoppedUnknown(db, value.disposition));
});

test('successor evidence follows numeric queue sequence across digit boundaries', context => {
  const { db, sessionKey } = fixture(context);
  const successors = db.prepare(`SELECT CAST(sequence AS TEXT) AS sequence, runtime, id, session_key, created_at, state, payload, revision
    FROM connector_turns WHERE session_key = ? ORDER BY connector_turns.sequence`).all(sessionKey).slice(1);
  assert.equal(successors[7]!.sequence, '9');
  assert.equal(successors[8]!.sequence, '10');
  assert.equal(inspectStoppedUnknown(db, sessionKey).successorsSha256,
    createHash('sha256').update(JSON.stringify(successors)).digest('hex'));
});

for (const patch of [{ physicalStopSha256: 'missing' }, { physicalStopSha256: undefined },
  { serviceInvocation: 'not-an-invocation' }, { ownerPid: 0 }, { ownerPid: 1.5 },
  { fenceId: 'maintenance-pause-is-not-physical-stop' }])
  test('refuses invalid physical stop proof ' + Object.keys(patch)[0] + ':' + String(Object.values(patch)[0]), context => {
    const { db, disposition } = fixture(context);
    assert.throws(() => disposeStoppedUnknown(db, { ...disposition,
      proof: { ...disposition.proof, ...patch } as StoppedUnknownDisposition['proof'] }));
    assert.equal(db.prepare('SELECT count(*) AS count FROM connector_turns').get()!.count, 38);
  });

for (const name of ['commandId', 'connectionId', 'revision', 'factSha256', 'queueVersion', 'queueSha256', 'successorsSha256', 'successorCount'] as const)
  test('refuses changed ' + name + ' without removing records', context => {
    const value = fixture(context);
    const expected = { ...value.disposition.expected, [name]: typeof value.disposition.expected[name] === 'number' ? 100 : 'changed' };
    assert.throws(() => disposeStoppedUnknown(value.db, { ...value.disposition, expected }));
    assert.equal(value.db.prepare('SELECT count(*) AS count FROM connector_turns').get()!.count, 38);
  });

for (const patch of [{ phase: 'running' }, { runId: 'native-turn' }, { fenced: true }, { preparation: 'active' },
  { pending: [{}] }, { pendingCommandTools: ['tool'] }, { batch: {} }, { nativeHistory: {} }, { reason: 'preparation_unknown' }])
  test('refuses protected execution ' + Object.keys(patch)[0], context => {
    const value = fixture(context);
    value.db.prepare('UPDATE connector_codex_executions SET fact=? WHERE session_key=?')
      .run(JSON.stringify({ ...JSON.parse(value.fact), ...patch }), value.sessionKey);
    assert.throws(() => inspectStoppedUnknown(value.db, value.sessionKey));
  });

test('pending native resume, changed successor, foreign node and stale backup cannot authorize disposition', context => {
  const value = fixture(context), { db, disposition } = value;
  for (const proof of [{ ...disposition.proof, nodeId: 'other' }, { ...disposition.proof, verifiedAt: 1 },
    { ...disposition.proof, verifiedAt: Date.now() + 60_000 }]) assert.throws(() => disposeStoppedUnknown(db, { ...disposition, proof }));
  db.prepare('INSERT INTO connector_codex_native_resume VALUES (?, ?)').run(value.sessionKey, '{}');
  assert.throws(() => disposeStoppedUnknown(db, disposition));
  db.exec('DELETE FROM connector_codex_native_resume');
  db.exec("UPDATE connector_turns SET payload='changed' WHERE id='successor-0'");
  assert.throws(() => disposeStoppedUnknown(db, disposition));
  assert.equal(db.prepare('SELECT count(*) AS count FROM connector_turns').get()!.count, 38);
});

test('failure after audit insert rolls back archive, execution, queue and usage atomically', context => {
  const value = fixture(context);
  value.db.exec("CREATE TRIGGER refusal BEFORE DELETE ON connector_codex_executions BEGIN SELECT RAISE(ABORT, 'synthetic refusal'); END");
  assert.throws(() => disposeStoppedUnknown(value.db, value.disposition));
  assert.equal(value.db.prepare('SELECT count(*) AS count FROM connector_turns').get()!.count, 38);
  assert.equal(value.db.prepare('SELECT rows FROM connector_turn_usage').get()!.rows, 38);
  assert.equal(value.db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name='connector_codex_unknown_dispositions'").get()!.count, 0);
});

for (const executed of [false, true]) test('lost commit ACK is not retried and remains auditable: ' + executed, context => {
  const value = fixture(context), db = recoverableConnection(value.db, new PerformanceDiagnostics(() => {})), exec = db.exec;
  let commits = 0;
  db.exec = sql => { if (sql === 'COMMIT') { commits++; if (executed) exec(sql); throw Error('private-commit'); } exec(sql); };
  assert.throws(() => disposeStoppedUnknown(db, value.disposition), /private-commit/);
  assert.equal(commits, 1);
  assert.equal(value.db.prepare('SELECT count(*) AS count FROM connector_turns').get()!.count, executed ? 37 : 38);
  if (executed) assert.equal(value.db.prepare('SELECT count(*) AS count FROM connector_codex_unknown_dispositions').get()!.count, 1);
});

test('real one-shot owner exits after private synthetic SQLite commit', async context => {
  const value = fixture(context);
  await disposeStoppedUnknownOwned(value.request, new PerformanceDiagnostics(() => {}));
  assert.equal(value.db.prepare('SELECT count(*) AS count FROM connector_codex_unknown_dispositions').get()!.count, 1);
  assert.equal(value.db.prepare('SELECT count(*) AS count FROM connector_turns').get()!.count, 37);
});

test('wrong database inode cannot authorize a one-shot owner', async context => {
  const value = fixture(context);
  await assert.rejects(disposeStoppedUnknownOwned({ ...value.request, ino: (BigInt(value.request.ino) + 1n).toString() },
    new PerformanceDiagnostics(() => {})), StoppedUnknownOwnerUnavailable);
  assert.equal(value.db.prepare('SELECT count(*) AS count FROM connector_turns').get()!.count, 38);
});

for (const ino of [Number.MAX_SAFE_INTEGER + 1, '01', '18446744073709551616'])
  test('imprecise or noncanonical file identity is refused before launching a writer: ' + ino, async context => {
    const value = fixture(context);
    await assert.rejects(disposeStoppedUnknownOwned({ ...value.request, ino }, new PerformanceDiagnostics(() => {}),
      () => { assert.fail('Invalid file identity launched a writer'); }), StoppedUnknownOwnerUnavailable);
    assert.equal(value.db.prepare('SELECT count(*) AS count FROM connector_turns').get()!.count, 38);
  });

test('termination acknowledgment is never owner exit or mutation retry', async context => {
  const value = fixture(context), owner = new EventEmitter(); let terminations = 0, settled = false;
  Object.assign(owner, { terminate: () => { terminations++; return Promise.resolve(1); } });
  const pending = disposeStoppedUnknownOwned(value.request, new PerformanceDiagnostics(() => {}), () => owner as unknown as Worker);
  const checked = assert.rejects(pending, StoppedUnknownOwnerUnavailable).then(() => { settled = true; });
  owner.emit('error', Error('private-worker')); await delay(5);
  assert.equal(settled, false); assert.ok(terminations >= 1);
  owner.emit('exit', 1); await checked;
  assert.equal(value.db.prepare('SELECT count(*) AS count FROM connector_turns').get()!.count, 38);
});
