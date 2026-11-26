import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { TurnQueue } from '../commands/turn-queue.js';
import { PrivateAgentHomeLease } from '../connector/private-agent-home-lease.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { connectionRecoverySnapshot, recoverableConnection, StorageConnectionUnavailable } from '../storage/connection-recovery.js';
import { AntigravityJournal } from './journal.js';
import { AntigravityOwnedExecution, type AntigravityExecutionIdentity } from './owned-execution.js';

const supported = { skip: process.platform !== 'linux' };
const sessionKey = 'antigravity:synthetic-session';
const nativeSessionId = 'synthetic-provider-session';

function fixture(file = ':memory:') {
  const db = new DatabaseSync(file);
  const turns = new TurnQueue(db);
  const journal = new AntigravityJournal(db, () => 1000);
  const identity: AntigravityExecutionIdentity = {
    key: sessionKey,
    executionId: 'synthetic-execution',
    ownerEpoch: 'synthetic-epoch',
  };
  if (!journal.session(sessionKey)) {
    journal.create({ key: sessionKey, title: 'Synthetic Antigravity', createdAt: 1000 });
  }
  const enqueue = (id: string, target = sessionKey) => turns.enqueue('antigravity', {
    id,
    sessionKey: target,
    createdAt: 1000,
    payload: { text: 'synthetic prompt', actorId: 'owner' },
  });
  return { db, turns, journal, identity, enqueue };
}

for (const operation of ['create', 'create-hook', 'begin', 'deletion'] as const) {
  test(`Antigravity journal ${operation} async participant cannot outlive its original savepoint`, async () => {
    const raw = new DatabaseSync(':memory:'), db = recoverableConnection(raw);
    db.exec('CREATE TABLE late_effect(value INTEGER)');
    const insert = db.prepare('INSERT INTO late_effect VALUES(1)');
    let release!: () => void, late: Promise<void> | undefined, enabled = false, calls = 0;
    const held = new Promise<void>(resolve => { release = resolve; });
    const callback = (): unknown => {
      if (!enabled) return;
      calls++;
      return late = (async () => { await held; insert.run(); })();
    };
    const journal = new AntigravityJournal(db, () => 1000, operation === 'create-hook' ? callback as () => void : undefined);
    const turns = new TurnQueue(db);
    try {
      journal.create({ key: sessionKey, title: 'Synthetic', createdAt: 1 });
      if (operation === 'begin') turns.enqueue('antigravity', { id: 'one', sessionKey, createdAt: 1, payload: {} });
      const deletion = operation === 'deletion' ? journal.beginDeletion(sessionKey, 'delete-cmd') : undefined;
      const tables = ['antigravity_sessions', 'antigravity_executions', 'antigravity_deletions'];
      const before = tables.map(table => raw.prepare(`SELECT * FROM ${table}`).all());
      enabled = true;
      assert.throws(() => operation.startsWith('create')
        ? journal.create({ key: 'antigravity:other', title: 'Other', createdAt: 2 },
          operation === 'create' ? callback as () => void : undefined)
        : operation === 'begin'
          ? journal.begin({ key: sessionKey, executionId: 'exec', ownerEpoch: 'epoch' }, ['one'], turns, undefined, callback as () => boolean)
          : journal.settleDeletion(deletion!, true, callback as () => void), /must be synchronous/);
      assert.equal(calls, 1);
      assert.equal(raw.isTransaction, false);
      assert.deepEqual(tables.map(table => raw.prepare(`SELECT * FROM ${table}`).all()), before);
      assert.equal(connectionRecoverySnapshot(db).state, 'close-required');
      const rejected = assert.rejects(late!, StorageConnectionUnavailable);
      release();
      await rejected;
      assert.deepEqual(raw.prepare('SELECT * FROM late_effect').all(), []);
    } finally {
      release();
      if (late) await late.catch(() => {});
      db.close();
    }
  });
}

test('Antigravity session starts unbound, binds provider session ID on first intent, and resumes only that exact ID', async () => {
  const current = fixture();
  try {
    assert.deepEqual(current.journal.session(sessionKey), {
      key: sessionKey,
      nativeSessionId: null,
      title: 'Synthetic Antigravity',
      createdAt: 1000,
      nativeState: 'allocated',
    });
    current.enqueue('one');
    const first = current.journal.begin(current.identity, ['one'], current.turns);
    assert.equal(first?.nativeMode, 'create');
    assert.equal(first?.nativeSessionId, undefined);
    assert.equal(first?.phase, 'starting');
    assert.equal(current.journal.session(sessionKey)?.nativeState, 'starting');
    assert.throws(() => current.journal.assertBinding(current.identity, nativeSessionId));

    current.journal.bindAndPersistIntentSync(current.identity, nativeSessionId, current.turns);
    current.journal.assertBinding(current.identity, nativeSessionId);
    assert.throws(() => current.journal.assertBinding(current.identity, 'synthetic-foreign-session'));
    assert.equal(current.journal.current(sessionKey)?.phase, 'running');
    assert.equal(current.journal.current(sessionKey)?.nativeSessionId, nativeSessionId);
    assert.equal(current.journal.session(sessionKey)?.nativeSessionId, nativeSessionId);
    assert.equal(current.turns.head('antigravity', sessionKey), undefined);

    current.journal.settleSync(current.identity, { outcome: 'completed', nativeSessionId }, current.turns);
    assert.equal(current.journal.current(sessionKey)?.phase, 'completed');
    assert.equal(current.journal.session(sessionKey)?.nativeState, 'ready');
    assert.equal(current.journal.canStart(sessionKey), true);

    current.journal.settleSync(current.identity, { outcome: 'completed', nativeSessionId }, current.turns);
    assert.throws(() => current.journal.settleSync(current.identity, { outcome: 'failed', nativeSessionId }, current.turns));

    current.enqueue('two');
    const resumeIdentity: AntigravityExecutionIdentity = {
      key: sessionKey,
      executionId: 'synthetic-execution-2',
      ownerEpoch: 'synthetic-epoch',
    };
    const second = current.journal.begin(resumeIdentity, ['two'], current.turns);
    assert.equal(second?.nativeMode, 'resume');
    assert.equal(second?.nativeSessionId, nativeSessionId);
    current.journal.assertBinding(resumeIdentity, nativeSessionId);
    assert.throws(() => current.journal.bindAndPersistIntentSync(resumeIdentity, 'synthetic-rebound-session', current.turns));
    current.journal.bindAndPersistIntentSync(resumeIdentity, nativeSessionId, current.turns);
    current.journal.settleSync(resumeIdentity, { outcome: 'cancelled', nativeSessionId }, current.turns);
    assert.equal(current.journal.current(sessionKey)?.phase, 'cancelled');
    assert.equal(current.journal.session(sessionKey)?.nativeState, 'ready');
    assert.equal(current.journal.session(sessionKey)?.nativeSessionId, nativeSessionId);
  } finally {
    current.db.close();
  }
});

test('Lost intent acknowledgement or undispatched failure preserves durable session binding and freezes unknown work', () => {
  const current = fixture();
  try {
    current.enqueue('one');
    current.journal.begin(current.identity, ['one'], current.turns);
    current.journal.bindAndPersistIntentSync(current.identity, nativeSessionId, current.turns);
    current.journal.settleSync(current.identity, { outcome: 'unknown' }, current.turns);
    assert.equal(current.journal.current(sessionKey)?.phase, 'unknown');
    assert.equal(current.journal.session(sessionKey)?.nativeState, 'unknown');
    assert.equal(current.journal.session(sessionKey)?.nativeSessionId, nativeSessionId);
    assert.equal(current.journal.canStart(sessionKey), false);
    assert.equal(current.journal.hasUnresolved(sessionKey), true);
    assert.equal(current.journal.pendingCount(), 1);

    const secondKey = 'antigravity:undispatched';
    current.journal.create({ key: secondKey, title: 'Undispatched', createdAt: 1000 });
    current.enqueue('two', secondKey);
    const secondIdentity: AntigravityExecutionIdentity = {
      key: secondKey,
      executionId: 'undispatched-execution',
      ownerEpoch: 'synthetic-epoch',
    };
    current.journal.begin(secondIdentity, ['two'], current.turns);
    current.journal.settleSync(secondIdentity, { outcome: 'unknown' }, current.turns);
    assert.equal(current.journal.session(secondKey)?.nativeSessionId, null);
    assert.equal(current.journal.session(secondKey)?.nativeState, 'unknown');
    assert.equal(current.turns.head('antigravity', secondKey)?.state, 'outcome_unknown');
  } finally {
    current.db.close();
  }
});

test('Omitted nativeSessionId in undispatched resume failure never clears or rebinds an existing session ID', () => {
  const current = fixture();
  try {
    current.enqueue('one');
    current.journal.begin(current.identity, ['one'], current.turns);
    current.journal.bindAndPersistIntentSync(current.identity, nativeSessionId, current.turns);
    current.journal.settleSync(current.identity, { outcome: 'completed', nativeSessionId }, current.turns);

    current.enqueue('two');
    const resumeIdentity: AntigravityExecutionIdentity = {
      key: sessionKey,
      executionId: 'resume-execution',
      ownerEpoch: 'synthetic-epoch',
    };
    current.journal.begin(resumeIdentity, ['two'], current.turns);
    assert.throws(() => current.journal.settleSync(resumeIdentity, { outcome: 'unknown', nativeSessionId: 'foreign-session' }, current.turns));
    current.journal.settleSync(resumeIdentity, { outcome: 'unknown' }, current.turns);
    assert.equal(current.journal.session(sessionKey)?.nativeSessionId, nativeSessionId);
    assert.equal(current.journal.session(sessionKey)?.nativeState, 'unknown');
    assert.equal(current.turns.head('antigravity', sessionKey)?.state, 'outcome_unknown');
  } finally {
    current.db.close();
  }
});

test('Provider nativeSessionId uniqueness rejects cross-session collisions', () => {
  const current = fixture();
  try {
    const secondKey = 'antigravity:second';
    current.journal.create({ key: secondKey, title: 'Second', createdAt: 1000 });
    current.enqueue('one');
    current.enqueue('two', secondKey);
    current.journal.begin(current.identity, ['one'], current.turns);
    current.journal.bindAndPersistIntentSync(current.identity, nativeSessionId, current.turns);
    const secondIdentity: AntigravityExecutionIdentity = {
      key: secondKey,
      executionId: 'second-execution',
      ownerEpoch: 'synthetic-epoch',
    };
    current.journal.begin(secondIdentity, ['two'], current.turns);
    assert.throws(() => current.journal.bindAndPersistIntentSync(secondIdentity, nativeSessionId, current.turns), /UNIQUE/);
    assert.equal(current.journal.current(secondKey)?.phase, 'starting');
    assert.equal(current.journal.session(secondKey)?.nativeSessionId, null);
    assert.equal(current.turns.head('antigravity', secondKey)?.state, 'dispatching');
  } finally {
    current.db.close();
  }
});

test('Restart recovery preserves allocated sessions and freezes starting or running turns as unknown', () => {
  const root = mkdtempSync(join(tmpdir(), 'aod-antigravity-journal-'));
  const file = join(root, 'connector.sqlite');
  let current = fixture(file);
  try {
    const allocatedKey = 'antigravity:allocated-only';
    current.journal.create({ key: allocatedKey, title: 'Allocated', createdAt: 1000 });
    current.enqueue('one');
    current.journal.begin(current.identity, ['one'], current.turns);
    current.db.close();

    current = fixture(file);
    current.journal.recover(current.turns);
    assert.equal(current.journal.session(allocatedKey)?.nativeState, 'allocated');
    assert.equal(current.journal.canStart(allocatedKey), true);
    assert.equal(current.journal.session(sessionKey)?.nativeState, 'unknown');
    assert.equal(current.journal.current(sessionKey)?.phase, 'unknown');
    assert.equal(current.journal.canStart(sessionKey), false);
    assert.equal(current.turns.head('antigravity', sessionKey)?.state, 'outcome_unknown');
  } finally {
    current.db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('AntigravityOwnedExecution integrates with AntigravityJournal across create, resume, and forced-cleanup downgrade', supported, async (context: TestContext) => {
  const root = mkdtempSync(join(tmpdir(), 'aod-antigravity-owned-journal-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home'), storeFile = join(root, 'connector.sqlite'), nodeId = `node_${randomUUID()}`;
  mkdirSync(home, { mode: 0o700 });
  writeFileSync(storeFile, '', { mode: 0o600 });
  const current = fixture(storeFile);
  context.after(() => current.db.close());

  current.enqueue('first-turn');
  current.journal.begin(current.identity, ['first-turn'], current.turns);
  const firstLease = PrivateAgentHomeLease.acquire('antigravity', home, storeFile, nodeId);
  const firstExecution = new AntigravityOwnedExecution({
    identity: current.identity,
    homeLease: firstLease,
    assertOwnership: () => {},
    journal: {
      assertBinding: (id, sid) => current.journal.assertBinding(id, sid),
      bindAndPersistIntent: async (id, sid) => current.journal.bindAndPersistIntentSync(id, sid, current.turns),
      settle: async (id, result) => current.journal.settleSync(id, result, current.turns),
    },
    createWorker: () => ({
      initialize: async () => ({ protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } } }),
      newSession: async () => nativeSessionId,
      resumeOwnedSession: async () => { assert.fail('first turn must not resume'); },
      prompt: async (_text, persist) => { await persist(nativeSessionId); return { stopReason: 'end_turn' }; },
      cancel: () => {},
      stopAndDrain: async () => ({ cleaned: true, quiescent: true }),
    }),
    update: () => {},
  });
  assert.deepEqual(await firstExecution.run('synthetic first prompt'), { outcome: 'completed', nativeSessionId });
  assert.equal(existsSync(join(home, '.agentopsdeck-antigravity-owner')), false);
  assert.equal(current.journal.session(sessionKey)?.nativeState, 'ready');
  assert.equal(current.journal.session(sessionKey)?.nativeSessionId, nativeSessionId);

  current.enqueue('second-turn');
  const secondIdentity: AntigravityExecutionIdentity = {
    key: sessionKey,
    executionId: 'synthetic-execution-2',
    ownerEpoch: 'synthetic-epoch',
  };
  current.journal.begin(secondIdentity, ['second-turn'], current.turns);
  const secondLease = PrivateAgentHomeLease.acquire('antigravity', home, storeFile, nodeId);
  const secondExecution = new AntigravityOwnedExecution({
    identity: secondIdentity,
    resumeSessionId: nativeSessionId,
    homeLease: secondLease,
    assertOwnership: () => {},
    journal: {
      assertBinding: (id, sid) => current.journal.assertBinding(id, sid),
      bindAndPersistIntent: async (id, sid) => current.journal.bindAndPersistIntentSync(id, sid, current.turns),
      settle: async (id, result) => current.journal.settleSync(id, result, current.turns),
    },
    createWorker: () => ({
      initialize: async () => ({ protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } } }),
      newSession: async () => { assert.fail('resume turn must not allocate new session'); },
      resumeOwnedSession: async (sid, check) => { check(sid); },
      prompt: async (_text, persist) => { await persist(nativeSessionId); return { stopReason: 'end_turn' }; },
      cancel: () => {},
      stopAndDrain: async () => ({ cleaned: true, quiescent: false }),
    }),
    update: () => {},
  });
  assert.deepEqual(await secondExecution.run('synthetic second prompt'), { outcome: 'unknown', nativeSessionId });
  assert.equal(existsSync(join(home, '.agentopsdeck-antigravity-owner')), false);
  assert.equal(current.journal.session(sessionKey)?.nativeState, 'unknown');
  assert.equal(current.journal.session(sessionKey)?.nativeSessionId, nativeSessionId);
  assert.equal(current.journal.canStart(sessionKey), false);
});

test('Snapshot size guard and diagnostic logs reject corrupt records without leaking session identities', () => {
  const rows: Record<string, unknown>[] = [];
  const db = new DatabaseSync(':memory:');
  const journal = new AntigravityJournal(
    db,
    () => 1000,
    undefined,
    undefined,
    new PerformanceDiagnostics(line => rows.push(JSON.parse(line))),
  );
  try {
    journal.create({ key: 'antigravity:private', title: 'private title', createdAt: 1000 });
    assert.equal(journal.readSnapshot('antigravity:private').canStart, true);
    assert.doesNotMatch(JSON.stringify(rows), /private/);
    db.prepare('UPDATE antigravity_sessions SET data = ? WHERE session_key = ?')
      .run('x'.repeat(200_000), 'antigravity:private');
    assert.throws(() => journal.readSnapshot('antigravity:private'), /connector_storage_unavailable/);
  } finally {
    db.close();
  }
});
