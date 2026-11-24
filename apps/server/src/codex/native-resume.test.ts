import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CodexExecutions } from './executions.js';
import { validNativeResumeInput, validNativeResumeReceipt, type NativeResumeInput } from './native-resume.js';
import { recoverableConnection, connectionRecoverySnapshot, StorageConnectionUnavailable } from '../storage/connection-recovery.js';

const key = 'codex:original-resume';
function fixture(file = ':memory:') {
  const db = new DatabaseSync(file);
  let deleted = false;
  const executions = new CodexExecutions(db, undefined, undefined, undefined, undefined, undefined, () => deleted);
  if (!executions.get(key)) {
    executions.begin(key, 'original-command', 'original-connection');
    executions.acknowledge(key, 'original-command', 'original-connection', 'original-run', () => {});
    executions.observe(key, 'original-connection', 'original-run', 'completed');
    executions.settleHistory(executions.get(key)!, 'error');
  }
  const fact = executions.get(key)!;
  assert.ok(fact.runId);
  const input: NativeResumeInput = { expected: { sessionKey: key, commandId: fact.commandId,
    connectionId: fact.connectionId, runId: fact.runId, revision: fact.revision }, nativeConnectionId: 'current-connection',
    threadId: 'original-resume', fingerprint: 'a'.repeat(64), continuation: null };
  return { db, executions, resumes: executions.nativeResumes, input, fact, deleted: () => { deleted = true; } };
}

test('resume DTO is bounded original identity evidence, never caller authority/content', () => {
  const f = fixture();
  try {
    assert.equal(validNativeResumeInput(f.input), true);
    for (const field of ['actor', 'authorized', 'sql', 'payload', 'release', 'replay'])
      assert.equal(validNativeResumeInput({ ...f.input, [field]: true }), false);
    for (const revision of [undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
      assert.equal(validNativeResumeInput({ ...f.input, expected: { ...f.input.expected, revision } }), false);
    for (const version of ['0:0', '01:0', '1:-1', '1:00', '9223372036854775808:0'])
      assert.equal(validNativeResumeInput({ ...f.input, continuation: { headId: 'head', headVersion: version } }), false);
    assert.equal(validNativeResumeInput({ ...f.input, fingerprint: 'private transcript' }), false);
    assert.equal(validNativeResumeInput({ ...f.input, threadId: 'thread\n' }), false);
    assert.equal(validNativeResumeInput({ ...f.input, continuation: { headId: 'head', headVersion: '9223372036854775807:0' } }), true);
  } finally { f.db.close(); }
});

test('one original intent fences both history paths, admission, settings and maintenance without changing execution identity', () => {
  const f = fixture();
  try {
    const receipt = f.resumes.prepare(f.input, () => true)!;
    assert.equal(validNativeResumeReceipt(receipt), true);
    assert.equal(f.resumes.prepare(f.input, () => true), null);
    assert.equal(f.resumes.pending(key), true);
    assert.equal(f.executions.canStart(key, true), false);
    assert.equal(f.executions.canChangeSettings(key), false);
    assert.equal(f.executions.maintenancePending({ historyRecovery: true }), 1);
    assert.deepEqual(f.executions.maintenanceHistorySessions(), []);
    f.deleted();
    assert.equal(f.executions.isDeletedTerminal(key), false, 'archive cannot bypass an unresolved native effect');
    f.executions.settleHistory(f.fact, 'current');
    f.executions.settleNativeHistory(f.fact, { turnId: 'original-run', connectionId: 'current-connection',
      fingerprint: 'b'.repeat(64), state: 'verified', reason: 'settled' });
    assert.deepEqual(f.executions.get(key), f.fact);
    assert.equal(f.resumes.finish(receipt, 'acknowledged'), false, 'prewrite is not a native ACK');
    assert.equal(f.resumes.begin(receipt, () => true), false, 'deletion is rechecked at begin');
    assert.equal(f.resumes.finish(receipt, 'not_dispatched'), true);
    assert.equal(f.resumes.finish(receipt, 'not_dispatched'), false);
  } finally { f.db.close(); }
});

test('begin binds exact receipt, execution revision and current transaction authority; observation is not a lease', () => {
  for (const mutation of ['none', 'revision', 'denied'] as const) {
    const f = fixture();
    try {
      const receipt = f.resumes.prepare(f.input, () => true)!;
      assert.equal(f.resumes.begin({ ...receipt, nativeConnectionId: 'replacement' }, () => true), false);
      assert.equal(f.resumes.begin({ ...receipt, intentId: '00000000-0000-0000-0000-000000000000' }, () => true), false);
      if (mutation === 'revision') f.executions.observeCommandTool(key, 'original-connection', 'original-run', 'racing-tool', false);
      assert.equal(f.resumes.begin(receipt, () => mutation !== 'denied'), mutation === 'none');
      if (mutation === 'none') {
        assert.equal(f.resumes.begin(receipt, () => true), false, 'begin is never replayable');
        assert.equal(f.resumes.finish({ ...receipt, nativeConnectionId: 'replacement' }, 'acknowledged'), false);
        // A known ACK belongs to this physical intent, even if a later event
        // changed execution revision. It does not settle the later history.
        f.executions.observeCommandTool(key, 'original-connection', 'original-run', 'later-tool', false);
        assert.equal(f.resumes.finish(receipt, 'acknowledged'), true);
        assert.equal(f.executions.get(key)?.sync, 'syncing');
        assert.equal(f.executions.canStart(key, true), false, 'resume ACK cannot revive an old idle proof');
        assert.equal(f.executions.get(key)?.nativeHistory?.reason, 'changed');
      } else assert.equal(f.resumes.finish(receipt, 'not_dispatched'), true);
    } finally { f.db.close(); }
  }
});

test('owned restarted outcome can load history, but its resume ACK grants neither completion nor replay', () => {
  const f = fixture();
  try {
    f.db.prepare("UPDATE connector_codex_executions SET fact = json_set(fact, '$.phase', 'unknown', '$.reason', 'restarted')").run();
    const before = f.executions.get(key)!;
    const receipt = f.resumes.prepare(f.input, () => true)!;
    assert.ok(receipt);
    assert.equal(f.resumes.begin(receipt, () => true), true);
    assert.equal(f.resumes.finish(receipt, 'acknowledged'), true);
    const after = f.executions.get(key)!;
    assert.equal(after.phase, 'unknown'); assert.equal(after.reason, 'restarted');
    assert.equal(after.runId, before.runId); assert.equal(after.commandId, before.commandId);
    assert.equal(after.revision, before.revision + 1);
    assert.equal(after.sync, 'syncing'); assert.equal(after.nativeHistory?.state, 'blocked');
    assert.equal(f.executions.canStart(key, true), false);
  } finally { f.db.close(); }
});

for (const mutation of ['fenced', 'preparation', 'send_unknown', 'preparation_unknown', 'running'] as const)
test(`resume admission AND begin reject a protected original execution: ${mutation}`, () => {
  for (const stage of ['prepare', 'begin'] as const) {
    const f = fixture();
    try {
      const receipt = stage === 'begin' ? f.resumes.prepare(f.input, () => true) : null;
      const value = mutation === 'fenced' ? "'$.fenced', json('true')"
        : mutation === 'preparation' ? "'$.preparation', 'ready'"
        : mutation === 'running' ? "'$.phase', 'running'"
        : ` '$.phase', 'unknown', '$.reason', '${mutation}'`;
      // Test-only raw corruption/race: even if a writer failed to bump revision,
      // the command must inspect the ORIGINAL hidden fence, not get()'s view.
      f.db.exec(`UPDATE connector_codex_executions SET fact = json_set(fact, ${value})`);
      if (stage === 'prepare') assert.equal(f.resumes.prepare(f.input, () => true), null);
      else {
        assert.equal(f.resumes.begin(receipt!, () => true), false);
        assert.equal(f.resumes.finish(receipt!, 'not_dispatched'), true);
      }
    } finally { f.db.close(); }
  }
});

for (const dispatched of [false, true]) test(`startup only recovers proven prewrites, dispatched=${dispatched}`, () => {
  const directory = mkdtempSync(join(tmpdir(), 'native-resume-reopen-')), file = join(directory, 'original.sqlite');
  const f = fixture(file);
  const receipt = f.resumes.prepare(f.input, () => true)!;
  if (dispatched) assert.equal(f.resumes.begin(receipt, () => true), true);
  f.db.close();
  const reopened = fixture(file);
  try {
    reopened.executions.recoverInterrupted();
    assert.equal(reopened.resumes.pending(key), dispatched);
    assert.equal(reopened.executions.maintenancePending({ historyRecovery: true }), dispatched ? 1 : 0);
    assert.equal(reopened.resumes.prepare(reopened.input, () => true) === null, dispatched);
    if (dispatched) {
      assert.equal(reopened.resumes.begin(receipt, () => true), false, 'unknown native outcome must not be replayed after reopen');
      assert.equal(reopened.resumes.finish(receipt, 'acknowledged'), true, 'exact known outcome may settle without replay');
    }
  } finally { reopened.db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('first intent prevents incompatible older writers from ignoring the persisted protection', () => {
  const directory = mkdtempSync(join(tmpdir(), 'native-resume-writer-')), file = join(directory, 'original.sqlite');
  const f = fixture(file), old = new DatabaseSync(file);
  try {
    const receipt = f.resumes.prepare(f.input, () => true)!;
    for (const sql of ['UPDATE connector_codex_executions SET fact = fact', 'DELETE FROM connector_codex_executions',
      'DELETE FROM connector_codex_native_resume']) assert.throws(() => old.exec(sql), /no such function/);
    assert.equal(f.resumes.pending(key), true);
    assert.equal(f.resumes.finish(receipt, 'not_dispatched'), true);
  } finally { old.close(); f.db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('startup prewrite cleanup rolls back with the original execution recovery transaction', () => {
  const f = fixture();
  try {
    assert.throws(() => f.resumes.recoverPrewritesInTransaction(), /original startup transaction/);
    f.executions.begin('codex:other-recovering-run', 'other-command', 'other-connection');
    const receipt = f.resumes.prepare(f.input, () => true)!;
    f.db.exec(`CREATE TRIGGER fail_resume_recovery BEFORE UPDATE ON connector_codex_executions
      BEGIN SELECT RAISE(ABORT, 'injected recovery failure'); END`);
    assert.throws(() => f.executions.recoverInterrupted(), /injected recovery failure/);
    assert.equal(f.db.isTransaction, false);
    assert.equal(f.resumes.pending(key), true, 'failed startup cannot partially remove protection');
    f.db.exec('DROP TRIGGER fail_resume_recovery');
    f.executions.recoverInterrupted();
    assert.equal(f.resumes.pending(key), false);
    assert.equal(f.resumes.begin(receipt, () => true), false, 'retired prewrite cannot authorize native IO');
  } finally { f.db.close(); }
});

for (const stage of ['prepare', 'begin'] as const) for (const hidden of [false, true])
test(`resume ${stage} rejects ${hidden ? 'hidden' : 'ordinary'} async authorization and retires original SQL owner`, async () => {
  const raw = new DatabaseSync(':memory:'), db = recoverableConnection(raw), executions = new CodexExecutions(db);
  executions.begin(key, 'command', 'connection'); executions.acknowledge(key, 'command', 'connection', 'run', () => {});
  executions.observe(key, 'connection', 'run', 'completed');
  const { sessionKey, commandId, connectionId, runId, revision } = executions.get(key)!;
  assert.ok(runId);
  const input: NativeResumeInput = { expected: { sessionKey, commandId, connectionId, runId, revision },
    nativeConnectionId: 'native', threadId: 'thread', fingerprint: 'a'.repeat(64), continuation: null };
  let resolve!: () => void;
  const held = new Promise<void>(r => { resolve = r; });
  const statement = db.prepare('UPDATE connector_codex_executions SET fact = fact');
  let late: Promise<void> | undefined;
  const authorize = () => { late = (async () => { await held; statement.run(); })();
    if (hidden) Object.defineProperty(late, 'then', { value: undefined }); return late as unknown as boolean; };
  try {
    const receipt = stage === 'begin' ? executions.nativeResumes.prepare(input, () => true)! : undefined;
    assert.throws(() => stage === 'prepare' ? executions.nativeResumes.prepare(input, authorize)
      : executions.nativeResumes.begin(receipt!, authorize), /must be synchronous/);
    assert.equal(raw.isTransaction, false);
    assert.equal(connectionRecoverySnapshot(db).state, 'close-required');
    const rejected = assert.rejects(new Promise((ok, no) => Promise.prototype.then.call(late, ok, no)), StorageConnectionUnavailable);
    resolve(); await rejected;
    assert.equal((raw.prepare('SELECT count(*) AS n FROM connector_codex_native_resume').get() as any).n, stage === 'begin' ? 1 : 0);
  } finally { resolve(); db.close(); }
});
