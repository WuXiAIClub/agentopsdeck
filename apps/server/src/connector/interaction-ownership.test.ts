import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConnectorUserStore } from './connector-user-store.js';

const capabilities = { version: 1, modes: ['automatic', 'interactive'], kinds: ['text'] };
const evidence = { connectionId: 'connection', goal: { status: 'absent' as const, version: '1' } };
function seed(store: ConnectorUserStore, sessionKey = 'codex:thread', requestId = 'question') {
  const scope = { ownerId: 'owner', nodeId: store.nodeId, sessionKey, runId: 'turn' };
  const request = { ...scope, version: 1, requestId, kind: 'text', prompt: 'Question', createdAt: Date.now(), expiresAt: Date.now() + 60_000 };
  store.interactions.create(request, capabilities, scope, evidence, Date.now());
  return scope;
}

function claim(store: ConnectorUserStore, scope: ReturnType<typeof seed>) {
  const accepted = store.interactions.answer({ scope, requestId: 'question', responseId: 'reply', answer: { kind: 'text', text: 'Answer' },
    permissionAllowed: true, continuation: evidence, expectedRevision: 1, now: Date.now() });
  store.interactions.claim({ scope, requestId: 'question', expectedRevision: accepted.revision,
    permissionAllowed: true, continuation: evidence, now: Date.now() });
  store.interactions.closeRun(scope, 'disconnected', Date.now());
}

for (const agent of ['claude-code', 'ghcp'] as const) {
  test(`${agent}: persisted exact native settlement retires unknown after restart without replay`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'interaction-settlement-'));
    const file = join(dir, 'state.sqlite');
    let store = new ConnectorUserStore(file, undefined, { runtimeOwner: true });
    try {
      const journal = agent === 'claude-code' ? store.claudeJournal : store.copilotJournal;
      const key = `${agent}:thread`, ref = { key, id: 'turn', epoch: 'original-epoch' };
      journal.create({ key, nativeSessionId: 'native', title: 'Fixture', createdAt: 1 });
      await store.turns.enqueueAsync(agent, { id: 'message', sessionKey: key, createdAt: 1, payload: { text: 'fixture', actorId: 'owner' } });
      assert.ok(journal.begin(ref, ['message'], store.turns));
      const scope = seed(store, key); claim(store, scope);
      assert.deepEqual(store.reconcileEndedInteractions(key), []);
      assert.equal(journal.observeTerminal(ref, 'completed', store.turns), true);
      assert.deepEqual(store.reconcileEndedInteractions(key), [], 'settling is not native quiescence');
      assert.equal(journal.confirmSettled(ref), true);
      store.close();
      store = new ConnectorUserStore(file); // management must leave the gate untouched
      assert.deepEqual(store.reconcileEndedInteractions(), []);
      assert.equal(store.interactions.hasUnresolvedKey(key), true);
      store.close();
      store = new ConnectorUserStore(file, undefined, { runtimeOwner: true });
      assert.equal(store.interactions.hasUnresolvedKey(key), false);
      assert.equal(store.interactions.get(scope, 'question')?.delivery, 'unknown');
      assert.ok(store.interactions.get(scope, 'question')?.retiredAt);
      assert.deepEqual(store.reconcileEndedInteractions(), [], 'idempotent');
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}

test('Codex recovery requires exact run, node and verified current history; maintenance remains paused', () => {
  const store = new ConnectorUserStore(':memory:', undefined, { runtimeOwner: true });
  try {
    const key = 'codex:thread', executions = store.codexExecutions;
    executions.begin(key, 'command', 'connection');
    executions.acknowledge(key, 'command', 'connection', 'turn', () => {});
    const scope = seed(store); claim(store, scope);
    const other = { ...scope, nodeId: 'foreign-node' };
    store.interactions.create({ ...other, version: 1, requestId: 'foreign', kind: 'text', prompt: 'Other',
      createdAt: Date.now(), expiresAt: Date.now() + 60_000 }, capabilities, other, evidence, Date.now());
    assert.deepEqual(store.reconcileEndedInteractions(), []);
    executions.observe(key, 'connection', 'turn', 'completed');
    assert.deepEqual(store.reconcileEndedInteractions(), [], 'terminal with stale history still blocks');
    executions.settleHistory({ sessionKey: key, commandId: 'command', runId: 'turn' }, 'current');
    const resume = store.pauseTurnStarts();
    assert.deepEqual(store.reconcileEndedInteractions(key), [key]);
    assert.equal(store.interactions.get(scope, 'question')?.delivery, 'unknown');
    assert.equal(store.interactions.get(other, 'foreign')?.retiredAt, undefined);
    assert.equal(store.sdkCommandAdmissionOpen, false);
    resume();
  } finally { store.close(); }
});

test('Codex ended interaction cannot bypass native goal protection or a history sync failure', () => {
  const store = new ConnectorUserStore(':memory:', undefined, { runtimeOwner: true });
  try {
    const key = 'codex:thread', facts = store.codexExecutions;
    facts.begin(key, 'command', 'connection'); facts.acknowledge(key, 'command', 'connection', 'turn', () => {});
    const scope = seed(store); claim(store, scope); facts.observe(key, 'connection', 'turn', 'completed');
    const checkpoint = { turnId: 'turn', connectionId: 'connection', fingerprint: 'a'.repeat(64) };
    facts.settleNativeHistory(facts.get(key)!, { ...checkpoint, state: 'blocked', reason: 'goal-blocked' });
    assert.equal(facts.canStart(key, true), true, 'An explicit blocked-goal input is a separate capability');
    assert.deepEqual(store.reconcileEndedInteractions(key), [], 'Interaction recovery cannot use that opt-in');
    facts.settleNativeHistory(facts.get(key)!, { ...checkpoint, state: 'verified', reason: 'settled' });
    facts.settleHistory(facts.get(key)!, 'error');
    assert.deepEqual(store.reconcileEndedInteractions(key), []);
    assert.equal(store.interactions.hasUnresolvedKey(key), true);
    facts.settleHistory(facts.get(key)!, 'current');
    assert.deepEqual(store.reconcileEndedInteractions(key), [key]);
    assert.equal(store.interactions.get(scope, 'question')?.delivery, 'unknown');
  } finally { store.close(); }
});

for (const agent of ['claude-code', 'ghcp'] as const) {
  test(`${agent}: restart without native settlement keeps uncertain delivery and admission protection`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-interaction-unsettled-')), file = join(dir, 'state.sqlite');
    let store = new ConnectorUserStore(file, undefined, { runtimeOwner: true });
    try {
      const key = `${agent}:thread`, journal = agent === 'claude-code' ? store.claudeJournal : store.copilotJournal;
      journal.create({ key, nativeSessionId: 'native', title: 'Fixture', createdAt: 1 });
      await store.turns.enqueueAsync(agent, { id: 'message', sessionKey: key, createdAt: 1, payload: { text: 'fixture', actorId: 'owner' } });
      journal.begin({ key, id: 'turn', epoch: 'epoch' }, ['message'], store.turns);
      const scope = seed(store, key); claim(store, scope); store.close();
      store = new ConnectorUserStore(file, undefined, { runtimeOwner: true });
      const recovered = agent === 'claude-code' ? store.claudeJournal : store.copilotJournal;
      assert.equal(recovered.session(key)?.nativeState, 'unknown');
      assert.deepEqual(store.reconcileEndedInteractions(key), []);
      assert.equal(store.interactions.get(scope, 'question')?.delivery, 'unknown');
      assert.equal(store.interactions.get(scope, 'question')?.retiredAt, undefined);
      assert.equal(store.canChangeSettings(key), false); assert.equal(store.canDeleteSession(key), false);
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}

for (const agent of ['codex', 'claude-code', 'ghcp'] as const) {
  test(`${agent}: terminal evidence from another run never clears the original question`, () => {
    const store = new ConnectorUserStore(':memory:', undefined, { runtimeOwner: true });
    try {
      const key = `${agent}:thread`;
      if (agent === 'codex') {
        store.codexExecutions.begin(key, 'command', 'connection');
        store.codexExecutions.acknowledge(key, 'command', 'connection', 'other-turn', () => {});
        store.codexExecutions.observe(key, 'connection', 'other-turn', 'completed');
        store.codexExecutions.settleHistory({ sessionKey: key, commandId: 'command', runId: 'other-turn' }, 'current');
      } else {
        const journal = agent === 'claude-code' ? store.claudeJournal : store.copilotJournal;
        const ref = { key, id: 'other-turn', epoch: 'epoch' };
        journal.create({ key, nativeSessionId: 'native', title: 'Fixture', createdAt: 1 });
        store.turns.enqueue(agent, { id: 'message', sessionKey: key, createdAt: 1, payload: { text: 'fixture', actorId: 'owner' } });
        journal.begin(ref, ['message'], store.turns);
        journal.observeTerminal(ref, 'completed', store.turns); journal.confirmSettled(ref);
      }
      const scope = seed(store, key); claim(store, scope);
      assert.deepEqual(store.reconcileEndedInteractions(), []);
      assert.equal(store.interactions.hasUnresolvedKey(key), true);
      assert.equal(store.interactions.get(scope, 'question')?.delivery, 'unknown');
    } finally { store.close(); }
  });
}

test('only runtime owner can create; rejected admission does not install lazy writer fence', () => {
  const store = new ConnectorUserStore(':memory:');
  try { assert.throws(() => seed(store), /runtime owner/); assert.equal(store.interactions.unresolved().length, 0); }
  finally { store.close(); }
});

test('maintenance pause blocks new questions but allows authoritative native-end settlement', () => {
  const store = new ConnectorUserStore(':memory:', undefined, { runtimeOwner: true });
  try {
    const scope = seed(store);
    const accepted = store.interactions.answer({ scope, requestId: 'question', responseId: 'reply', answer: { kind: 'text', text: 'Answer' },
      permissionAllowed: true, continuation: evidence, expectedRevision: 1, now: Date.now() });
    store.interactions.claim({ scope, requestId: 'question', expectedRevision: accepted.revision, permissionAllowed: true, continuation: evidence, now: Date.now() });
    const resume = store.pauseTurnStarts();
    assert.throws(() => seed(store, 'codex:other'), /available runtime owner/);
    store.interactions.closeRun(scope, 'disconnected', Date.now());
    assert.equal(store.interactions.unresolvedCount(), 1);
    store.interactions.retireRun(scope, Date.now());
    assert.equal(store.interactions.get(scope, 'question')?.delivery, 'unknown');
    assert.equal(store.interactions.unresolvedCount(), 0);
    assert.equal(store.sdkCommandAdmissionOpen, false, 'settlement does not release maintenance');
    assert.equal(resume(), true);
  } finally { store.close(); }
});

for (const runtime of ['codex', 'claude-code', 'ghcp']) test(`${runtime}: unresolved request guards settings, deletion and queue dispatch across owner/run changes`, () => {
  const store = new ConnectorUserStore(':memory:', undefined, { runtimeOwner: true });
  try {
    const key = `${runtime}:session`, scope = seed(store, key);
    assert.equal(store.canDeleteSession(key), false); assert.equal(store.canChangeSettings(key), false);
    store.turns.enqueue(runtime, { sessionKey: key, id: 'next', payload: { actorId: 'other' }, createdAt: Date.now() });
    assert.equal(store.turns.start(runtime, key, 'next'), false);
    store.interactions.closeRun(scope, 'stopped', Date.now());
    assert.equal(store.turns.start(runtime, key, 'next'), true);
  } finally { store.close(); }
});

test('restart recovers pending but preserves uncertain answer; old writer cannot open fenced state', t => {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-interaction-owner-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'store.sqlite');
  let store = new ConnectorUserStore(file, undefined, { runtimeOwner: true });
  const scope = seed(store); seed(store, 'codex:pending');
  const accepted = store.interactions.answer({ scope, requestId: 'question', responseId: 'reply', answer: { kind: 'text', text: 'Answer' },
    permissionAllowed: true, continuation: evidence, expectedRevision: 1, now: Date.now() });
  store.interactions.claim({ scope, requestId: 'question', expectedRevision: accepted.revision, permissionAllowed: true, continuation: evidence, now: Date.now() });
  store.close();
  const old = new DatabaseSync(file);
  old.function('agentopsdeck_connector_writer_epoch', () => 1);
  assert.throws(() => old.prepare("INSERT INTO connector_users VALUES ('default','Default',1,1) ON CONFLICT DO NOTHING").run(), /interaction_writer_epoch/);
  old.close();
  store = new ConnectorUserStore(file); // management open MUST NOT recover
  assert.equal(store.interactions.get(scope, 'question')?.delivery, 'claimed'); store.close();
  store = new ConnectorUserStore(file, undefined, { runtimeOwner: true });
  try {
    assert.equal(store.interactions.get(scope, 'question')?.delivery, 'unknown');
    assert.equal(store.interactions.hasUnresolvedKey('codex:pending'), false);
    assert.equal(store.canChangeSettings(scope.sessionKey), false);
    assert.equal(store.canDeleteSession(scope.sessionKey), false);
  } finally { store.close(); }
});
