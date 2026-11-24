import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { CodexExecutions } from './executions.js';
import { disposeStoppedUnknownBatch, inspectStoppedUnknownBatch, type StoppedUnknownBatchDisposition } from './stopped-unknown-batch.js';
import { disposeStoppedUnknownOwned } from './stopped-unknown-owner.js';

function fixture(context: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-batch-disposition-')), file = join(directory, 'connector.sqlite');
  const db = new DatabaseSync(file); chmodSync(file, 0o600);
  context.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  const executions = new CodexExecutions(db);
  db.exec(`PRAGMA synchronous=FULL;
    CREATE TABLE connector_identity(singleton INTEGER, node_id TEXT);
    INSERT INTO connector_identity VALUES (1, 'node');
    CREATE TABLE connector_turns(sequence INTEGER PRIMARY KEY AUTOINCREMENT, runtime TEXT, id TEXT,
      session_key TEXT, created_at INTEGER, state TEXT, payload TEXT, revision INTEGER);
    CREATE TABLE command_receipts(id TEXT PRIMARY KEY, receipt TEXT);
    INSERT INTO command_receipts VALUES ('original', 'accepted-not-native-completion');
    CREATE TABLE connector_turn_usage(rows INTEGER); INSERT INTO connector_turn_usage VALUES(0);
    CREATE TRIGGER count_insert AFTER INSERT ON connector_turns BEGIN UPDATE connector_turn_usage SET rows=rows+1; END;
    CREATE TRIGGER count_delete AFTER DELETE ON connector_turns BEGIN UPDATE connector_turn_usage SET rows=rows-1; END;`);
  const sessionKey = 'codex:synthetic-batch';
  const members = Array.from({ length: 16 }, (_, index) => ({ id: 'original-' + index, createdAt: index + 1, imageCount: 0 }));
  const fact = JSON.stringify({ sessionKey, commandId: members[0]!.id, connectionId: 'original-connection', phase: 'unknown', sync: 'current',
    revision: 3, startedAt: Date.now() - 2000, updatedAt: Date.now() - 1000, pending: [], reason: 'send_unknown',
    batch: { separator: '\nsynthetic boundary\n', members } });
  db.prepare('INSERT INTO connector_codex_executions VALUES (?, ?)').run(sessionKey, fact);
  db.prepare('INSERT INTO connector_codex_executions VALUES (?, ?)').run('codex:other', fact);
  const insert = db.prepare("INSERT INTO connector_turns(runtime,id,session_key,created_at,state,payload,revision) VALUES ('codex',?,?,?,?,?,1)");
  for (const member of members) insert.run(member.id, sessionKey, member.createdAt, 'outcome_unknown',
    JSON.stringify({ text: 'synthetic-private-' + member.id, images: [], actorId: 'original-actor' }));
  for (let index = 0; index < 20; index++) insert.run('successor-' + index, sessionKey, index + 17, 'queued',
    JSON.stringify({ text: 'synthetic-private-successor-' + index, images: [], actorId: 'original-actor' }));
  insert.run('unrelated', 'codex:other', 1, 'outcome_unknown', '{"text":"synthetic-private-other","images":[]}');
  const disposition: StoppedUnknownBatchDisposition = { expected: inspectStoppedUnknownBatch(db, sessionKey),
    proof: { nodeId: 'node', jobId: 'unique-batch-job', backupId: 'verified-encrypted-backup', verifiedAt: Date.now(),
      serviceInvocation: 'a'.repeat(32), ownerPid: 12345, physicalStopSha256: 'b'.repeat(64) },
    consentId: 'explicit-synthetic-batch-consent', action: 'retain-batch-without-replay-hold-successors' };
  return { db, file, fact, sessionKey, disposition, executions };
}

const rows = (db: DatabaseSync) => db.prepare('SELECT * FROM connector_turns ORDER BY sequence').all();
const facts = (db: DatabaseSync) => db.prepare('SELECT * FROM connector_codex_executions ORDER BY session_key').all();

test('batch disposition archives exactly 16 originals and retains all facts, receipts and 20 successors behind the original execution fence', context => {
  const value = fixture(context), { db, sessionKey } = value;
  const before = rows(db), originalFacts = facts(db), receipts = db.prepare('SELECT * FROM command_receipts').all();
  assert.equal(value.executions.canStart(sessionKey), false);
  disposeStoppedUnknownBatch(db, value.disposition);
  const audit = db.prepare('SELECT * FROM connector_codex_unknown_dispositions').get()!;
  assert.equal(audit.original_fact, value.fact);
  assert.deepEqual(JSON.parse(String(audit.original_queue)), before.slice(0, 16).map(entry => ({ ...entry, sequence: String(entry.sequence) })));
  assert.deepEqual(rows(db), before.slice(16));
  assert.deepEqual(facts(db), originalFacts);
  assert.deepEqual(db.prepare('SELECT * FROM command_receipts').all(), receipts);
  assert.equal(db.prepare('SELECT rows FROM connector_turn_usage').get()!.rows, 21);
  assert.equal(value.executions.canStart(sessionKey), false);
  assert.equal(value.executions.canStart(sessionKey, true), false);
  assert.equal(value.executions.maintenancePending(), 2);
  assert.equal(JSON.parse(String(audit.receipt)).executionProtectionRetained, true);
  assert.equal(JSON.parse(String(audit.receipt)).version, 2);
  assert.throws(() => disposeStoppedUnknownBatch(db, value.disposition));
  assert.deepEqual(rows(db), before.slice(16));
});

test('physical stopped proof owner performs batch archive in its one original worker', async context => {
  const value = fixture(context), stat = statSync(value.file, { bigint: true });
  await disposeStoppedUnknownOwned({ file: value.file, dev: stat.dev.toString(), ino: stat.ino.toString(),
    deadline: Date.now() + 30_000, disposition: value.disposition });
  assert.equal(rows(value.db).length, 21);
  assert.equal(value.executions.canStart(value.sessionKey), false);
  assert.equal(value.db.prepare('SELECT fact FROM connector_codex_executions WHERE session_key=?').get(value.sessionKey)!.fact, value.fact);
});

const mutations: Record<string, (db: DatabaseSync, sessionKey: string) => void> = {
  'head changed': db => { db.exec("UPDATE connector_turns SET revision=revision+1 WHERE id='original-0'"); },
  'member payload changed': db => { db.exec("UPDATE connector_turns SET payload='{}' WHERE id='original-5'"); },
  'member missing': db => { db.exec("DELETE FROM connector_turns WHERE id='original-6'"); },
  'member state changed': db => { db.exec("UPDATE connector_turns SET state='queued' WHERE id='original-3'"); },
  'extra unknown successor': db => { db.exec("UPDATE connector_turns SET state='outcome_unknown' WHERE id='successor-0'"); },
  'successor edited': db => { db.exec("UPDATE connector_turns SET revision=revision+1 WHERE id='successor-1'"); },
  'member order changed': (db, sessionKey) => { db.prepare("UPDATE connector_codex_executions SET fact=json_set(fact,'$.batch.members[1].id','original-2') WHERE session_key=?").run(sessionKey); },
  'member image metadata changed': (db, sessionKey) => { db.prepare("UPDATE connector_codex_executions SET fact=json_set(fact,'$.batch.members[1].imageCount',1) WHERE session_key=?").run(sessionKey); },
  'member timestamp changed': (db, sessionKey) => { db.prepare("UPDATE connector_codex_executions SET fact=json_set(fact,'$.batch.members[2].createdAt',9999) WHERE session_key=?").run(sessionKey); },
  'native ACK exists': (db, sessionKey) => { db.prepare("UPDATE connector_codex_executions SET fact=json_set(fact,'$.runId','native-turn') WHERE session_key=?").run(sessionKey); },
  'native observation pending': (db, sessionKey) => { db.prepare("UPDATE connector_codex_executions SET fact=json_set(fact,'$.pending',json('[{}]')) WHERE session_key=?").run(sessionKey); },
  'native resume pending': (db, sessionKey) => { db.prepare('INSERT INTO connector_codex_native_resume VALUES (?, ?)').run(sessionKey, '{}'); },
  'tool pending': (db, sessionKey) => { db.prepare("UPDATE connector_codex_executions SET fact=json_set(fact,'$.pendingCommandTools',json('[\"pending-tool\"]')) WHERE session_key=?").run(sessionKey); },
  'history protection exists': (db, sessionKey) => { db.prepare("UPDATE connector_codex_executions SET fact=json_set(fact,'$.nativeHistory',json('{}')) WHERE session_key=?").run(sessionKey); },
  'preparation exists': (db, sessionKey) => { db.prepare("UPDATE connector_codex_executions SET fact=json_set(fact,'$.preparation','active') WHERE session_key=?").run(sessionKey); },
  'different node': db => { db.exec("UPDATE connector_identity SET node_id='other-node'"); },
};
test('a restarted unbound batch retains its original execution protection after audited disposition', context => {
  const value = fixture(context);
  value.db.prepare("UPDATE connector_codex_executions SET fact=json_set(fact,'$.reason','restarted') WHERE session_key=?").run(value.sessionKey);
  value.disposition.expected = inspectStoppedUnknownBatch(value.db, value.sessionKey);
  const originalFacts = facts(value.db);
  disposeStoppedUnknownBatch(value.db, value.disposition);
  assert.deepEqual(facts(value.db), originalFacts);
  assert.equal(value.executions.canStart(value.sessionKey), false);
  assert.equal(value.executions.canStart(value.sessionKey, true), false);
  assert.equal(rows(value.db).length, 21);
});

for (const [name, mutate] of Object.entries(mutations)) test(`batch disposition refuses ${name} without changing original records`, context => {
  const value = fixture(context);
  mutate(value.db, value.sessionKey);
  const before = rows(value.db), originalFacts = facts(value.db);
  assert.throws(() => disposeStoppedUnknownBatch(value.db, value.disposition));
  assert.deepEqual(rows(value.db), before);
  assert.deepEqual(facts(value.db), originalFacts);
  assert.equal(value.db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name='connector_codex_unknown_dispositions'").get()!.count, 0);
});

for (const fault of ['expired', 'future-proof', 'stale-proof', 'pre-fact-proof', 'single-input-consent', 'no-hold', 'extra-field', 'wrong-count'] as const)
  test(`batch disposition refuses ${fault}`, context => {
    const value = fixture(context), disposition = structuredClone(value.disposition);
    let deadline = Date.now() + 30_000;
    if (fault === 'expired') deadline = Date.now() - 1;
    if (fault === 'future-proof') disposition.proof.verifiedAt = Date.now() + 60_000;
    if (fault === 'stale-proof') disposition.proof.verifiedAt = Date.now() - 600_000;
    if (fault === 'pre-fact-proof') disposition.proof.verifiedAt = Date.now() - 3000;
    if (fault === 'single-input-consent') Object.assign(disposition, { action: 'retain-unknown-without-replay' });
    if (fault === 'no-hold') Object.assign(disposition, { action: 'retain-batch-without-replay' });
    if (fault === 'extra-field') Object.assign(disposition, { releaseProtection: true });
    if (fault === 'wrong-count') disposition.expected.unknownCount = 15;
    const before = rows(value.db);
    assert.throws(() => disposeStoppedUnknownBatch(value.db, disposition, undefined, deadline));
    assert.deepEqual(rows(value.db), before);
  });

test('mid-batch failure rolls back audit, all deletions and usage counters together', context => {
  const value = fixture(context), before = rows(value.db), originalFacts = facts(value.db);
  value.db.exec(`CREATE TRIGGER reject_batch BEFORE DELETE ON connector_turns WHEN OLD.id='original-9'
    BEGIN SELECT RAISE(ABORT, 'synthetic batch write failure'); END`);
  assert.throws(() => disposeStoppedUnknownBatch(value.db, value.disposition));
  assert.deepEqual(rows(value.db), before);
  assert.deepEqual(facts(value.db), originalFacts);
  assert.equal(value.db.prepare('SELECT rows FROM connector_turn_usage').get()!.rows, 37);
  assert.equal(value.db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name='connector_codex_unknown_dispositions'").get()!.count, 0);
});

test('audit capacity refusal preserves the entire unknown batch and protection', context => {
  const value = fixture(context), before = rows(value.db);
  value.db.exec(`CREATE TABLE connector_codex_unknown_dispositions(job_id TEXT PRIMARY KEY,session_key TEXT,command_id TEXT,
    original_fact TEXT,original_queue TEXT,receipt TEXT)`);
  const insert = value.db.prepare('INSERT INTO connector_codex_unknown_dispositions VALUES(?,?,?,?,?,?)');
  for (let index = 0; index < 128; index++) insert.run('prior-' + index, 'prior', 'prior-' + index, '{}', '[]', '{}');
  assert.throws(() => disposeStoppedUnknownBatch(value.db, value.disposition));
  assert.deepEqual(rows(value.db), before);
  assert.equal(value.executions.canStart(value.sessionKey), false);
});

test('batch archive diagnostics do not contain payloads or business identities', context => {
  const value = fixture(context), lines: string[] = [];
  const diagnostics = new PerformanceDiagnostics(line => lines.push(line));
  disposeStoppedUnknownBatch(value.db, value.disposition, diagnostics);
  assert.ok(lines.length > 0);
  assert.doesNotMatch(lines.join('\n'), /synthetic-private|original-actor|synthetic-batch|unique-batch-job|verified-encrypted-backup/);
});
