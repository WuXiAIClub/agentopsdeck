import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { CodexExecutions } from './executions.js';
import { validOwnedThreadLoadInput, type OwnedThreadLoadInput } from './owned-thread-load.js';

const key = 'codex:owned-load';
function fixture() {
  const db = new DatabaseSync(':memory:');
  let deleted = false;
  const executions = new CodexExecutions(db, undefined, undefined, undefined, undefined, undefined, () => deleted);
  executions.begin(key, 'command', 'connection');
  const fact = executions.get(key)!;
  const input: OwnedThreadLoadInput = { sessionKey: key, commandId: fact.commandId, connectionId: fact.connectionId,
    revision: fact.revision, proof: { count: 1, digest: 'a'.repeat(64) }, fingerprint: 'b'.repeat(64) };
  return { db, executions, loads: executions.ownedThreadLoads, input, fact, deleted: () => { deleted = true; } };
}

test('owned cold-load schema is closed, bounded and distinct from bound-run recovery', () => {
  const f = fixture();
  try {
    assert.equal(validOwnedThreadLoadInput(f.input), true);
    for (const extra of ['authorized', 'runId', 'sql', 'payload', 'replay'])
      assert.equal(validOwnedThreadLoadInput({ ...f.input, [extra]: true }), false);
    for (const revision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
      assert.equal(validOwnedThreadLoadInput({ ...f.input, revision }), false);
    assert.equal(validOwnedThreadLoadInput({ ...f.input, proof: { count: 17, digest: 'a'.repeat(64) } }), false);
    assert.equal(validOwnedThreadLoadInput({ ...f.input, fingerprint: 'transcript' }), false);
    assert.throws(() => f.loads.begin({ ...f.input, fingerprint: 'bad' }, () => true));
  } finally { f.db.close(); }
});

test('original durable intent blocks admission and maintenance until exact ACK and current authority', () => {
  const f = fixture();
  try {
    assert.equal(f.loads.begin(f.input, () => false), null);
    assert.equal(f.loads.begin({ ...f.input, revision: f.input.revision + 1 }, () => true), null);
    const receipt = f.loads.begin(f.input, () => true)!; assert.ok(receipt);
    assert.equal(f.executions.nativeResumes.pending(key), true);
    assert.equal(f.executions.canStart(key, true), false);
    assert.equal(f.executions.canChangeSettings(key), false);
    assert.equal(f.executions.maintenancePending({ historyRecovery: true }), 1);
    assert.equal(f.loads.begin(f.input, () => true), null);
    assert.equal(f.loads.finish(receipt, () => true), false);
    assert.equal(f.loads.acknowledge({ ...receipt, nativeConnectionId: 'foreign' }), false);
    assert.equal(f.loads.acknowledge(receipt), true);
    assert.equal(f.loads.acknowledge(receipt), false);
    assert.equal(f.loads.finish(receipt, () => false), false);
    assert.equal(f.loads.finish(receipt, () => true), true);
    assert.equal(f.loads.finish(receipt, () => true), false);
    assert.equal(f.executions.nativeResumes.pending(key), false);
    assert.deepEqual(f.executions.get(key), f.fact, 'load ACK is not a turn ACK');
  } finally { f.db.close(); }
});

for (const mutation of ['deleted', 'unknown', 'bound', 'revision', 'preparation', 'fenced', 'pending'] as const)
  test(`cold-load refuses ${mutation} and preserves original ACK after a concurrent veto`, () => {
    const f = fixture();
    try {
      const receipt = f.loads.begin(f.input, () => true)!;
      if (mutation === 'deleted') f.deleted();
      else {
        const fact: any = { ...f.fact };
        if (mutation === 'unknown') { fact.phase = 'unknown'; fact.reason = 'send_unknown'; }
        if (mutation === 'bound') fact.runId = 'original-run';
        if (mutation === 'revision') fact.revision++;
        if (mutation === 'preparation') fact.preparation = 'active';
        if (mutation === 'fenced') fact.fenced = true;
        if (mutation === 'pending') fact.pending = ['request'];
        f.db.prepare('UPDATE connector_codex_executions SET fact=? WHERE session_key=?').run(JSON.stringify(fact), key);
      }
      assert.equal(f.loads.acknowledge(receipt), true, 'physical ACK survives authority loss');
      assert.equal(f.loads.finish(receipt, () => true), false);
      assert.equal(f.executions.nativeResumes.pending(key), true);
      assert.equal(f.loads.begin(f.input, () => true), null);
    } finally { f.db.close(); }
  });

test('failed authorization transaction rolls back without a resumable partial claim', () => {
  const f = fixture();
  try {
    assert.throws(() => f.loads.begin(f.input, () => { throw Error('original authority failed'); }));
    assert.equal(f.executions.nativeResumes.pending(key), false);
    assert.deepEqual(f.executions.get(key), f.fact);
  } finally { f.db.close(); }
});
