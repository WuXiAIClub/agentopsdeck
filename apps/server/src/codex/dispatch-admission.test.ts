import assert from 'node:assert/strict';
import test from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { DeckStore } from '../projection/deck-store.js';
import { CodexAppServer } from './app-server.js';
import { admitCodexQueued, acknowledgeCodexDispatch, settleCodexDispatchFailure, codexAdmissionMatches, codexAdmissionProof, CodexAdmissionConflict } from './dispatch-admission.js';
import { TurnAuthorizationError } from '../commands/turn-queue.js';
import { describeBatch } from './queued-batch.js';
import { observedParticipant } from '../storage/observed-participant.js';
import { connectionRecoverySnapshot, StorageConnectionUnavailable } from '../storage/connection-recovery.js';

const key = 'codex:atomic-admission', connection = 'original';
type Payload = { text: string; images: unknown[]; actorId?: string };
function seed() {
  const owner = new ConnectorUserStore(':memory:');
  for (const id of ['first', 'second']) owner.turns.enqueue('codex', { id, sessionKey: key, createdAt: 1,
    payload: { text: id, images: [], actorId: 'actor' } });
  const entries = owner.turns.list<Payload>('codex', key), batch = describeBatch(entries)!;
  const proof = codexAdmissionProof(owner.turns, entries);
  const db = (owner as unknown as { db: DatabaseSync }).db;
  return { owner, db, entries, batch, proof };
}

for (const mismatch of ['absence', 'revision', 'command', 'connection'] as const) {
  test(`async predecessor ${mismatch} mismatch refuses inside the original transaction without queue admission`, () => {
    const f = seed();
    try {
      assert.ok(f.owner.codexExecutions.begin(key, 'previous', connection));
      assert.ok(f.owner.codexExecutions.acknowledge(key, 'previous', connection, 'previous-run', () => {}));
      assert.ok(f.owner.codexExecutions.observe(key, connection, 'previous-run', 'completed'));
      assert.ok(f.owner.codexExecutions.settleHistory({ sessionKey: key, commandId: 'previous', runId: 'previous-run' }, 'current'));
      const before = f.owner.codexExecutions.get(key)!;
      const predecessor = mismatch === 'absence' ? null : {
        commandId: mismatch === 'command' ? 'other' : before.commandId,
        connectionId: mismatch === 'connection' ? 'other' : before.connectionId,
        revision: mismatch === 'revision' ? before.revision + 1 : before.revision };
      let authorized = false;
      assert.equal(admitCodexQueued(f.owner, key, 'first', connection, f.proof, () => { authorized = true; return true; },
        { batch: f.batch, predecessor }), null);
      assert.equal(authorized, false, 'no issuer or FIFO participant on a stale predecessor');
      assert.deepEqual(f.owner.codexExecutions.get(key), before);
      assert.deepEqual(f.owner.turns.list('codex', key), f.entries);
    } finally { f.owner.close(); }
  });
}

test('async observed absence is accepted only while the original execution is still absent', () => {
  const f = seed();
  try {
    const result = admitCodexQueued(f.owner, key, 'first', connection, f.proof, () => {
      assert.equal(f.db.isTransaction, true); return true;
    }, { batch: f.batch, predecessor: null });
    assert.ok(result); assert.equal(result.execution.commandId, 'first');
  } finally { f.owner.close(); }
});

test('original Codex batch claim, context, execution, evidence and ACK share their original transactions', () => {
  const f = seed(), context = { hash: 'a'.repeat(64), originalLength: 12 };
  try {
    let checks = 0;
    const result = admitCodexQueued(f.owner, key, 'first', connection, f.proof, () => {
      assert.equal(f.db.isTransaction, true); checks++; return true;
    }, { batch: f.batch, context });
    assert.ok(result); assert.equal(checks, 2); assert.notEqual(result.proof.digest, f.proof.digest);
    assert.deepEqual(f.owner.turns.list('codex', key).map(row => row.state), ['dispatching', 'dispatching']);
    assert.deepEqual(result.execution.batch, f.batch);
    assert.ok(codexAdmissionMatches(f.owner.turns, key, result.proof, () => true, 'dispatching'));
    // Original stream may complete before ACK; revision CAS must not lose it.
    f.owner.codexExecutions.observe(key, connection, 'native-run', 'completed');
    assert.equal(acknowledgeCodexDispatch(f.owner, key, 'first', 'replaced', 'native-run'), false);
    assert.equal(f.owner.turns.list('codex', key).length, 2);
    assert.equal(acknowledgeCodexDispatch(f.owner, key, 'first', connection, 'native-run'), true);
    assert.equal(f.owner.codexExecutions.get(key)?.phase, 'completed');
    assert.equal(f.owner.turns.list('codex', key).length, 0);
    assert.equal((f.db.prepare('SELECT run_id FROM connector_codex_turn_context').get() as { run_id: string }).run_id, 'native-run');
    assert.deepEqual(f.owner.codexExecutions.batchForRun(key, 'native-run'), f.batch);
  } finally { f.owner.close(); }
});

for (const mutation of ['edit', 'edit-aba', 'cancel', 'reinsert-aba', 'claimed', 'blocked', 'wrong-batch'] as const) {
  test(`Codex atomic admission refuses stale ${mutation} without changing original queue/fact`, () => {
    const f = seed();
    try {
      if (mutation === 'edit' || mutation === 'edit-aba') {
        f.owner.turns.edit<Payload>('codex', key, 'second', payload => ({ ...payload, text: 'changed' }));
        if (mutation === 'edit-aba') f.owner.turns.edit<Payload>('codex', key, 'second', payload => ({ ...payload, text: 'second' }));
      } else if (mutation === 'cancel' || mutation === 'reinsert-aba') {
        f.owner.turns.cancel('codex', key, 'second');
        if (mutation === 'reinsert-aba') f.owner.turns.enqueue('codex', f.entries[1]!);
      } else if (mutation === 'claimed') f.owner.turns.startBatch('codex', key, ['first', 'second']);
      else if (mutation === 'blocked') f.owner.turns.block('codex', 'first');
      else f.batch.members[1]!.id = 'foreign-command';
      const before = f.owner.turns.list('codex', key), cursor = f.owner.events.latestEventId();
      assert.throws(() => admitCodexQueued(f.owner, key, 'first', connection, f.proof, () => true, { batch: f.batch }), CodexAdmissionConflict);
      assert.equal(f.owner.codexExecutions.get(key), undefined);
      assert.deepEqual(f.owner.turns.list('codex', key), before);
      assert.equal(f.owner.events.latestEventId(), cursor);
    } finally { f.owner.close(); }
  });
}

for (const failure of ['queue-second-member', 'context-after-claim', 'revoked-second-member'] as const) {
  test(`Codex full admission rolls back fact, all members, context and events: ${failure}`, () => {
    const f = seed();
    try {
      const cursor = f.owner.events.latestEventId();
      if (failure === 'queue-second-member') f.db.exec(`CREATE TRIGGER reject_second BEFORE UPDATE ON connector_turns
        WHEN NEW.id = 'second' AND NEW.state = 'dispatching' BEGIN SELECT RAISE(ABORT, 'injected claim failure'); END`);
      if (failure === 'context-after-claim') f.db.exec(`CREATE TRIGGER reject_context BEFORE INSERT ON connector_codex_turn_context
        BEGIN SELECT RAISE(ABORT, 'injected context failure'); END`);
      assert.throws(() => admitCodexQueued<Payload>(f.owner, key, 'first', connection, f.proof,
        entry => failure !== 'revoked-second-member' || entry.id !== 'second',
        { batch: f.batch, context: { hash: 'a'.repeat(64), originalLength: 10 } }));
      assert.deepEqual(f.owner.turns.list('codex', key), f.entries);
      assert.equal(f.owner.codexExecutions.get(key), undefined);
      assert.equal(f.owner.events.latestEventId(), cursor);
      assert.equal((f.db.prepare('SELECT count(*) AS n FROM connector_codex_turn_context').get() as { n: number }).n, 0);
    } finally { f.owner.close(); }
  });
}

test('Codex payload recovery holds the same claimed batch through ready and normal dispatch; no replay or second claim', () => {
  const f = seed();
  try {
    const prepared = admitCodexQueued(f.owner, key, 'first', connection, f.proof, () => true, { batch: f.batch, preparing: true })!;
    assert.equal(prepared.execution.preparation, 'active');
    assert.equal(admitCodexQueued(f.owner, key, 'first', connection, prepared.proof, () => true, { batch: f.batch }), null);
    assert.equal(f.owner.codexExecutions.finishPreparation(prepared.execution), true);
    assert.throws(() => admitCodexQueued(f.owner, key, 'first', connection, prepared.proof, () => false, { batch: f.batch }), /authorization/);
    assert.equal(f.owner.codexExecutions.get(key)?.preparation, 'ready');
    assert.deepEqual(f.owner.turns.list('codex', key).map(row => row.state), ['dispatching', 'dispatching']);
    const started = admitCodexQueued(f.owner, key, 'first', connection, prepared.proof, () => true, { batch: f.batch })!;
    assert.equal(started.execution.preparation, undefined);
    assert.deepEqual(started.proof, prepared.proof, 'normal begin must not claim or increment the queue again');
    assert.equal(admitCodexQueued(f.owner, key, 'first', connection, prepared.proof, () => true, { batch: f.batch }), null);
  } finally { f.owner.close(); }
});

test('Codex queue async authority cannot enter its body or grant admission', () => {
  const f = seed(); let calls = 0;
  try {
    assert.throws(() => admitCodexQueued(f.owner, key, 'first', connection, f.proof, (async () => { calls++; return true; }) as any,
      { batch: f.batch }), /authorization/);
    assert.equal(calls, 0); assert.equal(f.owner.codexExecutions.get(key), undefined);
    assert.deepEqual(f.owner.turns.list('codex', key), f.entries);
  } finally { f.owner.close(); }
});

for (const caught of [false, true]) test(`Codex hidden async authority rolls back at original owner, including caught=${caught}`, async () => {
  const f = seed(); let release!: () => void, late: Promise<void> | undefined;
  const held = new Promise<void>(resolve => { release = resolve; });
  try {
    const allowed = () => {
      late = (async () => { await held; f.db.prepare('INSERT INTO connector_turns(id) VALUES (?)').run('escaped'); })();
      Object.defineProperty(late, 'then', { value: undefined });
      if (!caught) return late as unknown as boolean;
      try { observedParticipant(f.db, 'execution-issuer-check', () => late); } catch { /* Cannot grant outer commit. */ }
      return true;
    };
    assert.throws(() => admitCodexQueued(f.owner, key, 'first', connection, f.proof, allowed, { batch: f.batch }), /synchronous/);
    assert.equal(connectionRecoverySnapshot(f.db).state, 'close-required');
    const observed = new Promise<void>((resolve, reject) => Promise.prototype.then.call(late, resolve, reject));
    const rejected = assert.rejects(observed, StorageConnectionUnavailable); release(); await rejected;
    assert.throws(() => f.owner.codexExecutions.get(key), StorageConnectionUnavailable);
  } finally { release(); f.owner.close(); }
});

function runtimeFixture() {
  const f = seed(), store = new DeckStore();
  store.upsertSession({ sessionKey: key, agentId: 'codex', title: 'Original atomic dispatch', status: 'idle' });
  const codex = new CodexAppServer({ enabled: true, command: 'must-not-launch', defaultCwd: '.', defaultModel: 'test',
    approvalPolicy: 'never', store, turnQueue: f.owner.turns, executions: f.owner.codexExecutions, authorizeTurn: () => true });
  const runtime = codex as any, writes: any[] = [];
  runtime.setConnection(connection);
  runtime.ensureStarted = async () => {};
  runtime.ensureThreadLoaded = async () => {};
  runtime.threadRefreshResult.set(key, { at: Date.now(), available: true });
  runtime.child = { stdin: { writable: true, write(line: string) {
    const message = JSON.parse(line); writes.push(message);
    if (message.method === 'turn/start') {
      assert.deepEqual(f.owner.turns.list('codex', key).map(row => row.state), ['dispatching', 'dispatching']);
      assert.equal(f.owner.codexExecutions.get(key)?.phase, 'starting');
    }
    queueMicrotask(() => runtime.receive(JSON.stringify({ id: message.id, result: { turn: { id: 'native-run' } } })));
    return true;
  } } };
  return { ...f, store, runtime, writes, cleanup: async () => { await codex.close(); f.owner.close(); } };
}

for (const preparing of [false, true]) test(`dispatch failure commits complete claimed batch with execution, preparing=${preparing}`, () => {
  const f = seed();
  try {
    const claimed = admitCodexQueued(f.owner, key, 'first', connection, f.proof, () => true, { batch: f.batch, preparing })!;
    assert.equal(settleCodexDispatchFailure(f.owner, key, 'first', claimed.execution, claimed.proof, preparing, () => false), 'outcome_unknown');
    assert.deepEqual(f.owner.turns.list('codex', key).map(row => row.state), ['outcome_unknown', 'outcome_unknown']);
    const fact = f.owner.codexExecutions.get(key)!;
    assert.equal(fact.phase, 'unknown'); assert.equal(fact.reason, preparing ? 'preparation_unknown' : 'send_unknown');
    assert.equal(fact.revision, claimed.execution.revision + 1);
    assert.equal(settleCodexDispatchFailure(f.owner, key, 'first', claimed.execution, claimed.proof, false, () => true), null);
    assert.deepEqual(f.owner.codexExecutions.get(key), fact);
  } finally { f.owner.close(); }
});

for (const claimed of [false, true]) test(`authorization block is one transaction without manufacturing/replacing execution, claimed=${claimed}`, () => {
  const f = seed();
  try {
    const result = claimed ? admitCodexQueued(f.owner, key, 'first', connection, f.proof, () => true, { batch: f.batch })! : null;
    const before = f.owner.codexExecutions.get(key);
    assert.equal(settleCodexDispatchFailure(f.owner, key, 'first', before ?? null, result?.proof ?? f.proof, true, () => false), 'blocked');
    assert.deepEqual(f.owner.turns.list('codex', key).map(row => row.state), ['blocked', 'blocked']);
    assert.deepEqual(f.owner.codexExecutions.get(key), before);
  } finally { f.owner.close(); }
});

for (const claimed of [false, true]) test(`second-member failure rolls back queue versions, execution and journal, claimed=${claimed}`, () => {
  const f = seed();
  try {
    const result = claimed ? admitCodexQueued(f.owner, key, 'first', connection, f.proof, () => true, { batch: f.batch })! : null;
    const before = f.owner.codexExecutions.get(key), cursor = f.owner.events.latestEventId();
    const versions = f.entries.map(row => f.owner.turns.version('codex', key, row.id));
    f.db.exec(`CREATE TRIGGER reject_failure_second BEFORE UPDATE ON connector_turns
      WHEN NEW.id = 'second' AND NEW.state IN ('blocked','outcome_unknown') BEGIN SELECT RAISE(ABORT, 'injected failure settlement'); END`);
    assert.throws(() => settleCodexDispatchFailure(f.owner, key, 'first', before ?? null,
      result?.proof ?? f.proof, !claimed, () => false), /injected failure settlement/);
    assert.deepEqual(f.owner.codexExecutions.get(key), before);
    assert.deepEqual(f.owner.turns.list('codex', key).map(row => row.state), claimed ? ['dispatching', 'dispatching'] : ['queued', 'queued']);
    assert.deepEqual(f.entries.map(row => f.owner.turns.version('codex', key, row.id)), versions);
    assert.equal(f.owner.events.latestEventId(), cursor);
  } finally { f.owner.close(); }
});

for (const refusal of ['queue-aba', 'revision', 'ack', 'restart', 'authorized', 'unclaimed-unknown'] as const) {
  test(`dispatch failure receipt cannot overwrite ${refusal}`, () => {
    const f = seed();
    try {
      const claimed = !['queue-aba', 'authorized', 'unclaimed-unknown'].includes(refusal)
        ? admitCodexQueued(f.owner, key, 'first', connection, f.proof, () => true, { batch: f.batch })! : null;
      if (refusal === 'queue-aba') {
        f.owner.turns.edit<Payload>('codex', key, 'second', row => ({ ...row, text: 'away' }));
        f.owner.turns.edit<Payload>('codex', key, 'second', row => ({ ...row, text: 'second' }));
      } else if (refusal === 'revision') f.owner.codexExecutions.observe(key, connection, 'early-run', 'running');
      else if (refusal === 'ack') assert.ok(acknowledgeCodexDispatch(f.owner, key, 'first', connection, 'accepted-run'));
      else if (refusal === 'restart') f.owner.codexExecutions.recoverInterrupted();
      const before = f.owner.codexExecutions.get(key), rows = f.owner.turns.list('codex', key), cursor = f.owner.events.latestEventId();
      assert.equal(settleCodexDispatchFailure(f.owner, key, 'first', claimed?.execution ?? null, claimed?.proof ?? f.proof,
        refusal === 'queue-aba' || refusal === 'authorized', () => refusal === 'authorized'), null);
      assert.deepEqual(f.owner.codexExecutions.get(key), before);
      assert.deepEqual(f.owner.turns.list('codex', key), rows); assert.equal(f.owner.events.latestEventId(), cursor);
    } finally { f.owner.close(); }
  });
}

test('preclaim authorization failure preserves an unrelated execution byte-for-byte', () => {
  const f = seed();
  try {
    f.owner.codexExecutions.begin(key, 'previous-command', connection);
    const before = f.owner.codexExecutions.get(key)!;
    assert.equal(settleCodexDispatchFailure(f.owner, key, 'first', before, f.proof, true, () => false), 'blocked');
    assert.deepEqual(f.owner.codexExecutions.get(key), before);
    assert.deepEqual(f.owner.turns.list('codex', key).map(row => row.state), ['blocked', 'blocked']);
  } finally { f.owner.close(); }
});

test('late original ACK may settle an unknown failure without any second dispatch', () => {
  const f = seed();
  try {
    const claimed = admitCodexQueued(f.owner, key, 'first', connection, f.proof, () => true, { batch: f.batch })!;
    assert.equal(settleCodexDispatchFailure(f.owner, key, 'first', claimed.execution, claimed.proof, false, () => true), 'outcome_unknown');
    assert.equal(acknowledgeCodexDispatch(f.owner, key, 'first', connection, 'late-accepted-run'), true);
    assert.equal(f.owner.turns.list('codex', key).length, 0);
    const before = f.owner.codexExecutions.get(key)!;
    assert.equal(before.runId, 'late-accepted-run'); assert.equal(before.phase, 'running');
    assert.equal(settleCodexDispatchFailure(f.owner, key, 'first', before, claimed.proof, false, () => true), null);
    assert.deepEqual(f.owner.codexExecutions.get(key), before);
  } finally { f.owner.close(); }
});

for (const missing of [false, true]) test(`hidden async failure authority rolls back and retires owner, missing=${missing}`, async () => {
  const f = seed(); let release!: () => void, late: Promise<void> | undefined;
  const held = new Promise<void>(resolve => { release = resolve; });
  try {
    const claimed = missing ? null : admitCodexQueued(f.owner, key, 'first', connection, f.proof, () => true, { batch: f.batch })!;
    const allowed = () => {
      late = (async () => { await held; f.db.prepare('DELETE FROM connector_turns').run(); })();
      Object.defineProperty(late, 'then', { value: undefined });
      return late as unknown as boolean;
    };
    assert.throws(() => settleCodexDispatchFailure(f.owner, key, 'first', claimed?.execution ?? null,
      claimed?.proof ?? f.proof, true, allowed), /synchronous/);
    assert.equal(connectionRecoverySnapshot(f.db).state, 'close-required');
    const observed = new Promise<void>((resolve, reject) => Promise.prototype.then.call(late, resolve, reject));
    const rejected = assert.rejects(observed, StorageConnectionUnavailable); release(); await rejected;
    assert.throws(() => f.owner.codexExecutions.get(key), StorageConnectionUnavailable);
  } finally { release(); f.owner.close(); }
});

test('failure evidence fault after all queue writes rolls back the complete batch', () => {
  const f = seed();
  try {
    const claimed = admitCodexQueued(f.owner, key, 'first', connection, f.proof, () => true, { batch: f.batch })!;
    const evidence = (f.owner.codexExecutions as any).commandEvidence, record = evidence.recordExecutionInTransaction.bind(evidence);
    const cursor = f.owner.events.latestEventId(); let calls = 0;
    evidence.recordExecutionInTransaction = (...args: any[]) => {
      assert.deepEqual(f.owner.turns.list('codex', key).map(row => row.state), ['outcome_unknown', 'outcome_unknown']);
      if (++calls === 2) throw Error('synthetic-second-evidence-failure');
      return record(...args);
    };
    assert.throws(() => settleCodexDispatchFailure(f.owner, key, 'first', claimed.execution, claimed.proof, false, () => true), /second-evidence-failure/);
    evidence.recordExecutionInTransaction = record;
    assert.equal(calls, 2); assert.deepEqual(f.owner.codexExecutions.get(key), claimed.execution);
    assert.deepEqual(f.owner.turns.list('codex', key).map(row => row.state), ['dispatching', 'dispatching']);
    assert.equal(f.owner.events.latestEventId(), cursor);
  } finally { f.owner.close(); }
});

for (const commitAfter of [false, true]) test(`original owner invalidates on unknown settlement COMMIT, persisted=${commitAfter}`, async () => {
  const f = runtimeFixture(), exec = f.db.exec.bind(f.db); let armed = false, commits = 0;
  try {
    f.runtime.request = async () => { armed = true; throw Error('synthetic-send-failure'); };
    f.db.exec = sql => {
      if (armed && sql === 'COMMIT') {
        commits++;
        if (commitAfter) exec(sql);
        throw Error('synthetic-unknown-commit');
      }
      exec(sql);
    };
    await f.runtime.drainQueuedTurn(key);
    assert.equal(commits, 1); assert.equal(f.runtime.executionUnavailable, true);
    assert.equal(f.owner.codexExecutions.get(key)?.phase, commitAfter ? 'unknown' : 'starting');
    assert.deepEqual(f.owner.turns.list('codex', key).map(row => row.state),
      commitAfter ? ['outcome_unknown', 'outcome_unknown'] : ['dispatching', 'dispatching']);
    await f.runtime.drainQueuedTurn(key); assert.equal(commits, 1); assert.equal(f.writes.length, 0);
  } finally { f.db.exec = exec; await f.cleanup(); }
});

for (const blocked of [false, true]) test(`dispatch failure refuses cross-physical queue participant, blocked=${blocked}`, () => {
  const f = seed(), other = seed();
  try {
    const claimed = admitCodexQueued(f.owner, key, 'first', connection, f.proof, () => true, { batch: f.batch })!;
    const otherClaim = admitCodexQueued(other.owner, key, 'first', connection, other.proof, () => true, { batch: other.batch })!;
    assert.deepEqual(claimed.proof, otherClaim.proof);
    assert.throws(() => settleCodexDispatchFailure({ turns: other.owner.turns, codexExecutions: f.owner.codexExecutions }, key,
      'first', claimed.execution, claimed.proof, blocked, () => false), /owning transaction/);
    assert.deepEqual(f.owner.codexExecutions.get(key), claimed.execution);
    assert.deepEqual(other.owner.turns.list('codex', key).map(row => row.state), ['dispatching', 'dispatching']);
  } finally { f.owner.close(); other.owner.close(); }
});

for (const blocked of [false, true]) test(`original catch commits failure batch before original frontend projection, blocked=${blocked}`, async () => {
  const f = runtimeFixture();
  try {
    f.runtime.request = async () => {
      assert.deepEqual(f.owner.turns.list('codex', key).map(row => row.state), ['dispatching', 'dispatching']);
      if (blocked) f.runtime.options.authorizeTurn = () => false;
      throw blocked ? new TurnAuthorizationError() : Error('synthetic-native-outcome-unknown');
    };
    await f.runtime.drainQueuedTurn(key);
    assert.equal(f.runtime.executionUnavailable, false);
    assert.deepEqual(f.owner.turns.list('codex', key).map(row => row.state), blocked ? ['blocked', 'blocked'] : ['outcome_unknown', 'outcome_unknown']);
    assert.equal(f.owner.codexExecutions.get(key)?.phase, blocked ? 'starting' : 'unknown');
    const messages = f.store.getMessages(key).filter(row => row.role === 'user');
    assert.deepEqual(messages.map(row => row.id), ['first', 'second']);
    assert.ok(messages.every(row => row.status === (blocked ? 'failed' : 'outcome_unknown')));
    assert.deepEqual(messages.map(row => row.queueDisposition), ['preparing', 'waiting']);
    assert.deepEqual(messages.map(row => row.queueVersion), f.entries.map(row => f.owner.turns.version('codex', key, row.id)));
    assert.equal(f.writes.length, 0);
  } finally { await f.cleanup(); }
});

test('original catch leaves no partial failed batch and invalidates owner on storage failure', async () => {
  const f = runtimeFixture();
  try {
    f.runtime.request = async () => {
      f.db.exec(`CREATE TRIGGER reject_original_failure BEFORE UPDATE ON connector_turns
        WHEN NEW.id = 'second' AND NEW.state = 'outcome_unknown' BEGIN SELECT RAISE(ABORT, 'injected catch failure'); END`);
      throw Error('synthetic-send-unknown');
    };
    await f.runtime.drainQueuedTurn(key);
    assert.equal(f.runtime.executionUnavailable, true);
    assert.equal(f.owner.codexExecutions.get(key)?.phase, 'starting');
    assert.deepEqual(f.owner.turns.list('codex', key).map(row => row.state), ['dispatching', 'dispatching']);
    await f.runtime.drainQueuedTurn(key); assert.equal(f.writes.length, 0);
  } finally { await f.cleanup(); }
});

test('original Codex complete queue consumer claims and begins before one native write, then ACK consumes stored members', async () => {
  const f = runtimeFixture();
  try {
    await f.runtime.drainQueuedTurn(key);
    assert.deepEqual(f.writes.map(row => row.method), ['turn/start']);
    const fact = f.owner.codexExecutions.get(key)!;
    assert.deepEqual(fact.batch?.members.map(row => row.id), ['first', 'second']);
    assert.equal(fact.runId, 'native-run'); assert.equal(f.owner.turns.list('codex', key).length, 0);
    assert.deepEqual(f.store.getMessages(key).filter(row => row.role === 'user').map(row => row.id), ['first', 'second']);
  } finally { await f.cleanup(); }
});

for (const mutation of ['edit', 'cancel', 'edit-aba'] as const) {
  test(`original Codex waiting input ${mutation} cannot dispatch stale text or restore old queue state`, async () => {
    const f = runtimeFixture();
    f.runtime.ensureThreadLoaded = async () => {
      if (mutation === 'cancel') f.owner.turns.cancel('codex', key, 'second');
      else {
        f.owner.turns.edit<Payload>('codex', key, 'second', payload => ({ ...payload, text: 'new-content' }));
        if (mutation === 'edit-aba') f.owner.turns.edit<Payload>('codex', key, 'second', payload => ({ ...payload, text: 'second' }));
      }
    };
    try {
      await f.runtime.drainQueuedTurn(key);
      assert.equal(f.writes.length, 0); assert.equal(f.owner.codexExecutions.get(key), undefined);
      assert.ok(f.owner.turns.list('codex', key).every(row => row.state === 'queued'));
      const rows = f.owner.turns.list<Payload>('codex', key);
      assert.equal(rows.length, mutation === 'cancel' ? 1 : 2);
      if (mutation === 'edit') assert.equal(rows[1]!.payload.text, 'new-content');
    } finally { await f.cleanup(); }
  });
}

for (const mutation of ['edit', 'cancel', 'edit-aba', 'sql-rollback'] as const) {
  test(`original Codex ${mutation} during opaque preparation preserves current queue and does not invent unknown execution`, async () => {
    const f = runtimeFixture();
    f.runtime.bridgeOpaqueSecrets = async (_key: string, text: string) => {
      if (mutation === 'sql-rollback') f.db.exec(`CREATE TRIGGER reject_claim BEFORE UPDATE ON connector_turns
        WHEN NEW.state = 'dispatching' BEGIN SELECT RAISE(ABORT, 'claim failure'); END`);
      else if (mutation === 'cancel') f.runtime.cancelQueued(key, 'second', f.owner.turns.version('codex', key, 'second'));
      else {
        f.owner.turns.edit<Payload>('codex', key, 'second', payload => ({ ...payload, text: 'changed-during-preparation' }));
        if (mutation === 'edit-aba') f.owner.turns.edit<Payload>('codex', key, 'second', payload => ({ ...payload, text: 'second' }));
      }
      return text;
    };
    try {
      await f.runtime.drainQueuedTurn(key);
      assert.equal(f.writes.length, 0); assert.equal(f.owner.codexExecutions.get(key), undefined);
      assert.ok(f.owner.turns.list('codex', key).every(row => row.state === 'queued'));
      if (mutation === 'sql-rollback') {
        assert.equal(f.runtime.executionUnavailable, true);
        assert.throws(() => f.store.getSession(key), /execution facts unavailable/,
          'a failed owner cannot publish invented idle or unknown facts');
        await f.runtime.drainQueuedTurn(key);
        assert.equal(f.writes.length, 0, 'a failed storage owner must not automatically retry dispatch');
      } else assert.notEqual(f.store.getSession(key)?.runtime?.phase, 'unknown');
      if (mutation === 'cancel') assert.ok(!f.store.getMessages(key).some(row => row.id === 'second'));
      if (mutation === 'edit') assert.equal(f.store.getMessages(key).find(row => row.id === 'second')?.text, 'changed-during-preparation');
    } finally { await f.cleanup(); }
  });
}
