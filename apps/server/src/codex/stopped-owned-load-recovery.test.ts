import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { CodexExecutions } from './executions.js';
import { TurnQueue } from '../commands/turn-queue.js';
import { admitCodexQueued, codexAdmissionProof, settleCodexDispatchFailure } from './dispatch-admission.js';
import { registerNativeHistoryWriter } from './native-history.js';
import { registerNativeResumeWriter } from './native-resume.js';
import { disposeStoppedUnknownOwned } from './stopped-unknown-owner.js';
import { inspectStoppedOwnedLoad, recoverStoppedOwnedLoad, validStoppedOwnedLoadRecovery,
  type StoppedOwnedLoadRecovery } from './stopped-owned-load-recovery.js';

const key = 'codex:owned-load-recovery';
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
function fixture(t: test.TestContext, count = 16) {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-owned-load-recovery-'));
  chmodSync(dir, 0o700);
  const file = join(dir, 'connector.sqlite'), db = new DatabaseSync(file); chmodSync(file, 0o600);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const executions = new CodexExecutions(db), turns = new TurnQueue(db);
  registerNativeHistoryWriter(db); registerNativeResumeWriter(db);
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE connector_identity(singleton INTEGER, node_id TEXT);
    INSERT INTO connector_identity VALUES(1,'node');
    CREATE TABLE command_receipts(id TEXT PRIMARY KEY, receipt TEXT);
    INSERT INTO command_receipts VALUES('original','immutable-receipt');
    CREATE TABLE unrelated_protection(value TEXT); INSERT INTO unrelated_protection VALUES('keep');`);
  for (let i = 0; i < count + 4; i++) turns.enqueue('codex', { id: 'input-' + i, sessionKey: key,
    createdAt: i + 1, payload: { text: 'private-original-' + i, images: [], actorId: 'original-actor' } });
  turns.enqueue('codex', { id: 'other', sessionKey: 'codex:other', createdAt: 1,
    payload: { text: 'other-input', images: [] } });
  const entries = turns.list<any>('codex', key).slice(0, count);
  const batch = count === 1 ? undefined : { separator: '\n<batch-boundary>\n',
    members: entries.map(e => ({ id: e.id, createdAt: e.createdAt, imageCount: e.payload.images.length })) };
  const claim = admitCodexQueued({ turns, codexExecutions: executions }, key, entries[0]!.id, 'original-connection',
    codexAdmissionProof(turns, entries), () => true, batch ? { batch } : {});
  assert.ok(claim);
  const loads = executions.ownedThreadLoads;
  const receipt = loads.begin({ sessionKey: key, commandId: entries[0]!.id, connectionId: 'original-connection',
    revision: claim.execution.revision, proof: claim.proof, fingerprint: 'f'.repeat(64) }, () => true);
  assert.ok(receipt); assert.equal(loads.acknowledge(receipt), true);
  // Same durable transition as the original worker's dispatch failure. There
  // has been no finish, and therefore no authorization for turn/start.
  const original = executions.get(key)!;
  assert.ok(settleCodexDispatchFailure({ turns, codexExecutions: executions }, key, entries[0]!.id,
    { commandId: original.commandId, connectionId: original.connectionId, revision: original.revision },
    claim.proof, false, () => true));
  const recovery: StoppedOwnedLoadRecovery = { action: 'recover-acknowledged-load-before-turn-start',
    expected: inspectStoppedOwnedLoad(db, key), consentId: 'explicit-synthetic-repair', dispatchContractSha256: 'c'.repeat(64),
    proof: { nodeId: 'node', jobId: 'fresh-job', backupId: 'fresh-stopped-restorable-backup', verifiedAt: Date.now(),
      serviceInvocation: 'a'.repeat(32), ownerPid: process.pid, physicalStopSha256: 'b'.repeat(64) } };
  return { db, turns, executions, loads, receipt, recovery, file, count };
}
const snapshot = (db: DatabaseSync) => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all().map(row => [row.name, db.prepare('SELECT * FROM "' + String(row.name).replaceAll('"', '""') + '" ORDER BY rowid').all()]);

for (const count of [1, 16]) test(`audited recovery conserves ${count} original inputs, four successors and all unrelated data`, t => {
  const f = fixture(t, count), { db } = f;
  const before = f.turns.list<any>('codex', key);
  const allRows = db.prepare('SELECT * FROM connector_turns ORDER BY sequence').all();
  const originalFact = db.prepare('SELECT fact FROM connector_codex_executions WHERE session_key=?').get(key)!.fact;
  const originalIntent = db.prepare('SELECT record FROM connector_codex_native_resume WHERE session_key=?').get(key)!.record;
  const receipts = db.prepare('SELECT * FROM command_receipts').all(), usage = db.prepare('SELECT * FROM connector_turn_usage').all();
  recoverStoppedOwnedLoad(db, f.recovery);
  assert.deepEqual(f.turns.list<any>('codex', key), before.map(q => ({ ...q, state: 'queued' })));
  assert.deepEqual(db.prepare('SELECT * FROM connector_turns ORDER BY sequence').all().map(q => ({ ...q })), allRows.map((q, i) =>
    i < count ? { ...q, state: 'queued', revision: Number(q.revision) + 1 } : { ...q }));
  assert.deepEqual(db.prepare('SELECT * FROM command_receipts').all(), receipts);
  assert.deepEqual(db.prepare('SELECT * FROM connector_turn_usage').all(), usage);
  assert.equal(db.prepare('SELECT value FROM unrelated_protection').get()!.value, 'keep');
  assert.equal(f.executions.get(key), undefined);
  assert.equal(db.prepare('SELECT * FROM connector_codex_native_resume').get(), undefined);
  const audit = db.prepare('SELECT * FROM connector_codex_owned_load_recoveries').get()!;
  assert.equal(audit.original_fact, originalFact); assert.equal(audit.original_intent, originalIntent);
  const receipt = JSON.parse(String(audit.receipt));
  assert.equal(receipt.turnStartDispatched, false); assert.equal(receipt.requeuedCount, count);
  assert.equal(receipt.nativeCompletionFabricated, false);
  assert.equal(hash(String(audit.original_queue)), f.recovery.expected.queueSha256);
  const recovered = snapshot(db);
  assert.throws(() => recoverStoppedOwnedLoad(db, f.recovery)); assert.deepEqual(snapshot(db), recovered);
  // Requeue does not restore issuer authority or bypass normal admission.
  const entries = f.turns.list<any>('codex', key).slice(0, count);
  assert.throws(() => admitCodexQueued({ turns: f.turns, codexExecutions: f.executions }, key, entries[0]!.id,
    'new-connection', codexAdmissionProof(f.turns, entries), () => false));
  assert.equal(f.executions.get(key), undefined);
  assert.ok(f.turns.list<any>('codex', key).every(q => q.state === 'queued'));
});

function editJSON(db: DatabaseSync, table: string, column: string, change: (v: any) => void) {
  const v = JSON.parse(String(db.prepare(`SELECT ${column} AS value FROM ${table} WHERE session_key=?`).get(key)!.value));
  change(v); db.prepare(`UPDATE ${table} SET ${column}=? WHERE session_key=?`).run(JSON.stringify(v), key);
}
const fact = (change: (v: any) => void) => (db: DatabaseSync) => editJSON(db, 'connector_codex_executions', 'fact', change);
const intent = (change: (v: any) => void) => (db: DatabaseSync) => editJSON(db, 'connector_codex_native_resume', 'record', change);
const mutations: Record<string, (db: DatabaseSync) => void> = {
  'bound turn': fact(v => { v.runId = 'possibly-running'; }),
  'preparation': fact(v => { v.preparation = 'ready'; }),
  'hard fence': fact(v => { v.fenced = true; }),
  'native history protection': fact(v => { v.nativeHistory = {}; }),
  'pending native work': fact(v => { v.pending = [{}]; }),
  'pending tool': fact(v => { v.pendingCommandTools = [{}]; }),
  'noncurrent sync': fact(v => { v.sync = 'pending'; }),
  'restart without exact failure provenance': fact(v => { v.reason = 'restarted'; }),
  'changed fact revision': fact(v => { v.revision++; }),
  'changed command': fact(v => { v.commandId = 'other'; }),
  'changed connection': fact(v => { v.connectionId = 'other'; }),
  'changed batch member': fact(v => { v.batch.members[1].id = 'other'; }),
  'changed separator': fact(v => { v.batch.separator = 'private-original'; }),
  'unacknowledged effect': intent(v => { v.state = 'dispatch_may_have_started'; }),
  'other native resume kind': intent(v => { v.kind = 'bound-run'; }),
  'extra intent field': intent(v => { v.runId = 'bound'; }),
  'wrong native connection': intent(v => { v.nativeConnectionId = 'other'; }),
  'changed original proof': intent(v => { v.proof.digest = '0'.repeat(64); }),
  'missing original ACK fence': db => { db.exec('DELETE FROM connector_codex_native_resume'); },
  'edited input': db => { db.exec("UPDATE connector_turns SET payload=json_set(payload,'$.text','changed') WHERE id='input-0'"); },
  'input ABA revision': db => { db.exec("UPDATE connector_turns SET revision=revision+2 WHERE id='input-0'"); },
  'reinserted input ABA sequence': db => { db.exec("UPDATE connector_turns SET sequence=10000 WHERE id='input-0'"); },
  'missing input': db => { db.exec("DELETE FROM connector_turns WHERE id='input-0'"); },
  'changed unknown state': db => { db.exec("UPDATE connector_turns SET state='dispatching' WHERE id='input-0'"); },
  'protected successor': db => { db.exec("UPDATE connector_turns SET state='outcome_unknown' WHERE id='input-16'"); },
};
for (const [name, mutate] of Object.entries(mutations)) test(`rejects ${name} without any write`, t => {
  const f = fixture(t); mutate(f.db); const before = snapshot(f.db);
  assert.throws(() => inspectStoppedOwnedLoad(f.db, key));
  assert.throws(() => recoverStoppedOwnedLoad(f.db, f.recovery)); assert.deepEqual(snapshot(f.db), before);
});

test('all expected hashes are CAS gates, including queued successors', t => {
  const f = fixture(t);
  f.db.exec("UPDATE connector_turns SET payload=json_set(payload,'$.text','edited-successor') WHERE id='input-16'");
  assert.doesNotThrow(() => inspectStoppedOwnedLoad(f.db, key));
  const before = snapshot(f.db);
  assert.throws(() => recoverStoppedOwnedLoad(f.db, f.recovery)); assert.deepEqual(snapshot(f.db), before);
});
for (const name of ['future proof', 'stale proof', 'pre-failure proof', 'wrong node', 'expired deadline',
  'extra root field', 'missing contract proof', 'bad action', 'changed fact hash', 'changed intent hash']) {
  test(`rejects ${name} and leaves complete snapshot unchanged`, t => {
    const f = fixture(t); const r = structuredClone(f.recovery); let deadline = Date.now() + 30_000;
    if (name === 'future proof') r.proof.verifiedAt = Date.now() + 100_000;
    if (name === 'stale proof') r.proof.verifiedAt = Date.now() - 300_001;
    if (name === 'pre-failure proof') r.proof.verifiedAt = 1;
    if (name === 'wrong node') r.proof.nodeId = 'other';
    if (name === 'expired deadline') deadline = Date.now() - 1;
    if (name === 'extra root field') (r as any).extra = true;
    if (name === 'missing contract proof') delete (r as any).dispatchContractSha256;
    if (name === 'bad action') (r as any).action = 'force-unlock';
    if (name === 'changed fact hash') r.expected.factSha256 = '0'.repeat(64);
    if (name === 'changed intent hash') r.expected.intentSha256 = '0'.repeat(64);
    const before = snapshot(f.db);
    assert.throws(() => recoverStoppedOwnedLoad(f.db, r, deadline)); assert.deepEqual(snapshot(f.db), before);
  });
}

test('failure after queue updates rolls back audit, queue, fact and ACK atomically', t => {
  const f = fixture(t);
  f.db.exec(`CREATE TRIGGER reject_fact_delete BEFORE DELETE ON connector_codex_executions
    BEGIN SELECT RAISE(ABORT,'synthetic final-write failure'); END`);
  const before = snapshot(f.db);
  assert.throws(() => recoverStoppedOwnedLoad(f.db, f.recovery), /synthetic final-write failure/);
  assert.deepEqual(snapshot(f.db), before);
});

test('actual stopped worker persists exact audit then physically exits', async t => {
  const f = fixture(t), st = statSync(f.file, { bigint: true });
  assert.equal(validStoppedOwnedLoadRecovery(f.recovery), true);
  await disposeStoppedUnknownOwned({ file: f.file, dev: st.dev.toString(), ino: st.ino.toString(),
    deadline: Date.now() + 30_000, disposition: f.recovery });
  assert.ok(f.turns.list<any>('codex', key).every(q => q.state === 'queued'));
  assert.equal(f.db.prepare('SELECT count(*) AS count FROM connector_codex_owned_load_recoveries').get()!.count, 1);
  assert.equal(f.executions.get(key), undefined);
});

function restartFixture(t: test.TestContext) {
  const fixtureState = fixture(t);
  const failureFact = String(fixtureState.db.prepare('SELECT fact FROM connector_codex_executions WHERE session_key=?').get(key)!.fact);
  fixtureState.executions.recoverInterrupted();
  const restartProof = { failureFact, failureFactSha256: hash(failureFact), backupId: 'original-stopped-backup' };
  const recovery = { ...fixtureState.recovery, restartProof,
    expected: { ...fixtureState.recovery.expected,
      factSha256: hash(String(fixtureState.db.prepare('SELECT fact FROM connector_codex_executions WHERE session_key=?').get(key)!.fact)) },
    proof: { ...fixtureState.recovery.proof, verifiedAt: Date.now() } };
  return { ...fixtureState, recovery, restartProof };
}

test('recovering across actual startup requires the exact original stopped failure fact', async t => {
  const fixtureState = restartFixture(t);
  const { db, recovery, restartProof } = fixtureState;
  assert.throws(() => inspectStoppedOwnedLoad(db, key));
  assert.deepEqual(inspectStoppedOwnedLoad(db, key, restartProof), recovery.expected);
  assert.equal(validStoppedOwnedLoadRecovery(recovery), true);
  const originalRows = db.prepare('SELECT * FROM connector_turns ORDER BY sequence').all();
  const originalUsage = db.prepare('SELECT * FROM connector_turn_usage').all();
  const originalReceipts = db.prepare('SELECT * FROM command_receipts').all();
  const stat = statSync(fixtureState.file, { bigint: true });
  await disposeStoppedUnknownOwned({ file: fixtureState.file, dev: stat.dev.toString(), ino: stat.ino.toString(),
    deadline: Date.now() + 30_000, disposition: recovery });
  assert.deepEqual(db.prepare('SELECT * FROM connector_turns ORDER BY sequence').all().map(row => ({ ...row })),
    originalRows.map((row, index) => ({ ...row,
      ...(index < fixtureState.count ? { state: 'queued', revision: Number(row.revision) + 1 } : {}) })));
  assert.deepEqual(db.prepare('SELECT * FROM connector_turn_usage').all(), originalUsage);
  assert.deepEqual(db.prepare('SELECT * FROM command_receipts').all(), originalReceipts);
  assert.equal(fixtureState.executions.get(key), undefined);
  assert.equal(db.prepare('SELECT count(*) AS count FROM connector_codex_native_resume').get()!.count, 0);
  const receipt = JSON.parse(String(db.prepare('SELECT receipt FROM connector_codex_owned_load_recoveries').get()!.receipt));
  assert.deepEqual(receipt.restartProof, restartProof);
  const recovered = snapshot(db);
  assert.throws(() => recoverStoppedOwnedLoad(db, recovery));
  assert.deepEqual(snapshot(db), recovered);
});

for (const name of ['missing backup', 'bad failure hash', 'changed failure command', 'changed failure revision',
  'bound original turn', 'non-failure predecessor', 'extra provenance field', 'changed current batch',
  'additional current revision', 'earlier restart timestamp', 'stale pre-restart stop proof']) {
  test(`restart recovery rejects ${name} without writes`, t => {
    const fixtureState = restartFixture(t), { db, recovery, restartProof } = fixtureState;
    const changeFailure = (change: (value: any) => void) => {
      const value = JSON.parse(restartProof.failureFact); change(value);
      restartProof.failureFact = JSON.stringify(value); restartProof.failureFactSha256 = hash(restartProof.failureFact);
    };
    if (name === 'missing backup') restartProof.backupId = '';
    if (name === 'bad failure hash') restartProof.failureFactSha256 = '0'.repeat(64);
    if (name === 'changed failure command') changeFailure(value => { value.commandId = 'other'; });
    if (name === 'changed failure revision') changeFailure(value => { value.revision++; });
    if (name === 'bound original turn') changeFailure(value => { value.runId = 'possibly-running'; });
    if (name === 'non-failure predecessor') changeFailure(value => { value.reason = 'restarted'; });
    if (name === 'extra provenance field') (restartProof as any).extra = true;
    if (name === 'changed current batch') fact(value => { value.batch.members[0].id = 'changed'; })(db);
    if (name === 'additional current revision') fact(value => { value.revision++; })(db);
    if (name === 'earlier restart timestamp') fact(value => { value.updatedAt = JSON.parse(restartProof.failureFact).updatedAt - 1; })(db);
    if (name === 'stale pre-restart stop proof') {
      fact(value => { value.updatedAt = recovery.proof.verifiedAt + 1; })(db);
    }
    const before = snapshot(db);
    assert.throws(() => recoverStoppedOwnedLoad(db, recovery));
    assert.deepEqual(snapshot(db), before);
  });
}
