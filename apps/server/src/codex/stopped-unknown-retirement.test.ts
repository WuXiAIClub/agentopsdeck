import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { CodexExecutions } from './executions.js';
import { disposeStoppedUnknownBatch, inspectStoppedUnknownBatch } from './stopped-unknown-batch.js';
import { inspectStoppedUnknownRetirement, retireStoppedUnknown, validStoppedUnknownRetirement,
  type StoppedUnknownRetirement } from './stopped-unknown-retirement.js';

const key = 'codex:retained-batch';
function fixture(t: test.TestContext) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const executions = new CodexExecutions(db);
  db.exec(`CREATE TABLE connector_identity(singleton INTEGER, node_id TEXT);
    INSERT INTO connector_identity VALUES(1,'node');
    CREATE TABLE connector_turns(sequence INTEGER PRIMARY KEY AUTOINCREMENT, runtime TEXT, id TEXT,
      session_key TEXT, created_at INTEGER, state TEXT, payload TEXT, revision INTEGER);
    CREATE TABLE unrelated_proof(value TEXT); INSERT INTO unrelated_proof VALUES('original');`);
  const members = Array.from({ length: 16 }, (_, i) => ({ id: 'original-' + i, createdAt: i + 1, imageCount: 0 }));
  const first = members[0];
  assert.ok(first);
  const fact = { sessionKey: key, commandId: first.id, connectionId: 'original-connection', phase: 'unknown',
    sync: 'current', revision: 2, startedAt: Date.now() - 3000, updatedAt: Date.now() - 2000,
    pending: [], reason: 'send_unknown', batch: { separator: '\nprivate batch\n', members } };
  db.prepare('INSERT INTO connector_codex_executions VALUES(?,?)').run(key, JSON.stringify(fact));
  db.prepare('INSERT INTO connector_codex_executions VALUES(?,?)').run('codex:unrelated', '{"keep":"exact"}');
  const insert = db.prepare("INSERT INTO connector_turns(runtime,id,session_key,created_at,state,payload,revision) VALUES('codex',?,?,?,?,?,1)");
  for (const m of members) insert.run(m.id, key, m.createdAt, 'outcome_unknown', JSON.stringify({ text: m.id, images: [] }));
  for (let i = 0; i < 20; i++) insert.run('successor-' + i, key, i + 17, 'queued', JSON.stringify({ text: 'next-' + i, images: [] }));
  const proof = { nodeId: 'node', jobId: 'archive-job', backupId: 'archive-backup', verifiedAt: Date.now(),
    serviceInvocation: 'a'.repeat(32), ownerPid: 12345, physicalStopSha256: 'b'.repeat(64) };
  disposeStoppedUnknownBatch(db, { expected: inspectStoppedUnknownBatch(db, key), proof,
    consentId: 'archive-consent', action: 'retain-batch-without-replay-hold-successors' });
  const retained = { ...fact, revision: 3, reason: 'restarted', updatedAt: Date.now() - 500 };
  db.prepare('UPDATE connector_codex_executions SET fact=? WHERE session_key=?').run(JSON.stringify(retained), key);
  const disposition: StoppedUnknownRetirement = { expected: inspectStoppedUnknownRetirement(db, key),
    proof: { ...proof, jobId: 'fresh-retirement-job', backupId: 'fresh-stopped-backup', verifiedAt: Date.now() },
    consentId: 'explicit-retirement-no-replay', action: 'retire-archived-batch-protection-without-replay' };
  return { db, disposition, retained, executions };
}
const snapshot = (db: DatabaseSync) => ({ queue: db.prepare('SELECT * FROM connector_turns ORDER BY sequence').all(),
  archive: db.prepare('SELECT * FROM connector_codex_unknown_dispositions ORDER BY job_id').all(),
  facts: db.prepare('SELECT * FROM connector_codex_executions ORDER BY session_key').all(),
  other: db.prepare('SELECT * FROM unrelated_proof').all() });

test('separate retirement preserves 16 archived inputs and original receipt, all 20 successors and unrelated facts', t => {
  const f = fixture(t), before = snapshot(f.db);
  retireStoppedUnknown(f.db, f.disposition);
  const after = snapshot(f.db);
  assert.deepEqual(after.queue, before.queue);
  assert.deepEqual(after.archive, before.archive);
  assert.deepEqual(after.other, before.other);
  assert.deepEqual(after.facts, before.facts.filter(row => row.session_key !== key));
  const row = f.db.prepare('SELECT * FROM connector_codex_unknown_retirements').get()!;
  assert.equal(row.original_fact, JSON.stringify(f.retained));
  assert.equal(JSON.parse(String(row.receipt)).nativeOutcome, 'unknown');
  assert.equal(JSON.parse(String(row.receipt)).replayed, false);
  assert.throws(() => retireStoppedUnknown(f.db, f.disposition), /evidence mismatch/);
  assert.equal(f.executions.canStart(key, true), true);
});

const mutations: Record<string, (db: DatabaseSync) => void> = {
  'bound turn': db => { db.prepare("UPDATE connector_codex_executions SET fact=json_set(fact,'$.runId','native-run') WHERE session_key=?").run(key); },
  'pending tool': db => { db.prepare("UPDATE connector_codex_executions SET fact=json_set(fact,'$.pendingCommandTools',json('[\"tool\"]')) WHERE session_key=?").run(key); },
  'preparation': db => { db.prepare("UPDATE connector_codex_executions SET fact=json_set(fact,'$.preparation','active') WHERE session_key=?").run(key); },
  'native checkpoint': db => { db.prepare("UPDATE connector_codex_executions SET fact=json_set(fact,'$.nativeHistory',json('{}')) WHERE session_key=?").run(key); },
  'pending load': db => { db.prepare('INSERT INTO connector_codex_native_resume VALUES(?,?)').run(key, '{}'); },
  'successor edit': db => { db.exec("UPDATE connector_turns SET revision=revision+1 WHERE id='successor-0'"); },
  'successor delete': db => { db.exec("DELETE FROM connector_turns WHERE id='successor-3'"); },
  'successor state': db => { db.exec("UPDATE connector_turns SET state='dispatching' WHERE id='successor-1'"); },
  'archived replay': db => { db.exec("UPDATE connector_turns SET id='original-0' WHERE id='successor-0'"); },
  'archive payload': db => { db.exec("UPDATE connector_codex_unknown_dispositions SET original_queue='[]'"); },
  'archive receipt': db => { db.exec("UPDATE connector_codex_unknown_dispositions SET receipt=json_set(receipt,'$.executionProtectionRetained',json('false'))"); },
  'other node': db => { db.exec("UPDATE connector_identity SET node_id='other'"); },
  'current revision': db => { db.prepare("UPDATE connector_codex_executions SET fact=json_set(fact,'$.revision',4) WHERE session_key=?").run(key); },
};
for (const [name, mutate] of Object.entries(mutations)) test(`retirement refuses ${name} without changing original records`, t => {
  const f = fixture(t); mutate(f.db); const before = snapshot(f.db);
  assert.throws(() => retireStoppedUnknown(f.db, f.disposition));
  assert.deepEqual(snapshot(f.db), before);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='connector_codex_unknown_retirements'").get()!.n, 0);
});

for (const name of ['old-job', 'old-backup', 'stale-proof', 'future-proof', 'wrong-archive-hash', 'expired', 'closed-schema'] as const)
  test(`retirement refuses ${name} proof and transactionally preserves the fence`, t => {
    const f = fixture(t), d = structuredClone(f.disposition), before = snapshot(f.db);
    if (name === 'old-job') d.proof.jobId = d.expected.archiveJobId;
    if (name === 'old-backup') d.proof.backupId = JSON.parse(String(f.db.prepare(
      'SELECT receipt FROM connector_codex_unknown_dispositions WHERE job_id=?').get(d.expected.archiveJobId)!.receipt)).proof.backupId;
    if (name === 'stale-proof') d.proof.verifiedAt -= 300_001;
    if (name === 'future-proof') d.proof.verifiedAt += 30_000;
    if (name === 'wrong-archive-hash') d.expected.archiveReceiptSha256 = 'f'.repeat(64);
    if (name === 'closed-schema') { (d as any).authorized = true; assert.equal(validStoppedUnknownRetirement(d), false); }
    assert.throws(() => retireStoppedUnknown(f.db, d, name === 'expired' ? Date.now() - 1 : Date.now() + 30_000));
    assert.deepEqual(snapshot(f.db), before);
  });

test('failure after receipt insert rolls back both audit and deletion without altering prior archive', t => {
  const f = fixture(t), before = snapshot(f.db);
  f.db.exec(`CREATE TRIGGER forbid_retirement BEFORE DELETE ON connector_codex_executions
    BEGIN SELECT RAISE(ABORT,'synthetic deletion failure'); END`);
  assert.throws(() => retireStoppedUnknown(f.db, f.disposition), /synthetic deletion failure/);
  assert.deepEqual(snapshot(f.db), before);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='connector_codex_unknown_retirements'").get()!.n, 0);
});
