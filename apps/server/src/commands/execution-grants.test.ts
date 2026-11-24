import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { createTurnAuthorizer, ExecutionGrants } from '../connector/execution-grants.js';
import { CodexAppServer } from '../codex/app-server.js';
import { OpenClawTurnQueue } from '../openclaw/turn-queue.js';
import { DeckStore } from '../projection/deck-store.js';
import { TurnAuthorizationError } from './turn-queue.js';

for (const runtime of ['codex', 'openclaw'] as const) {
  for (const timing of ['before', 'preparing', 'expires', 'unknown', 'valid'] as const) {
    test(`${runtime} dispatch revalidates persisted grant (${timing}) without token fallback`, async () => {
      const database = new ConnectorUserStore(':memory:', () => true), store = new DeckStore();
      const grantDb = new DatabaseSync(':memory:');
      let now = 1000;
      const grants = new ExecutionGrants(grantDb, () => true, () => now);
      const sessionKey = runtime === 'codex' ? 'codex:delegated-fixture' : 'agent:main:dashboard:delegated-fixture';
      const binding = { issuerTokenId: 'issuer', hubId: 'hub', principalId: 'principal', grantKey: 'policy', version: 1, runtime, sessionKey };
      const ref = grants.issue(binding, ['messages:send'], now + 1000);
      const executionGrant = { ...ref, issuerTokenId: binding.issuerTokenId };
      const authorizeTurn = createTurnAuthorizer(grants, () => true);
      let sent = 0;
      const revoke = () => grants.revoke(binding.issuerTokenId, ref.id);
      const prepare = async () => { if (timing === 'preparing') revoke(); if (timing === 'expires') now = 2000; };
      const dispatch = async () => {
        sent++;
        if (timing === 'unknown') { revoke(); throw new Error('Synthetic lost acknowledgement'); }
        return { runId: 'synthetic-turn', status: 'started' };
      };
      store.upsertSession({ sessionKey, agentId: runtime === 'codex' ? 'codex' : 'main', title: 'Synthetic delegated turn', status: 'idle',
        hasActiveRun: false, runStartedAt: 1, lastActiveAt: 1 });
      assert.ok(store.getSession(sessionKey), 'synthetic session must be visible to the runtime queue');
      const codex = runtime === 'codex' ? new CodexAppServer({ store, turnQueue: database.turns, executions: database.codexExecutions, authorizeTurn,
        enabled: true, command: 'must-not-launch', defaultCwd: '/tmp', defaultModel: 'synthetic', approvalPolicy: 'never' }) : undefined;
      const openclaw = runtime === 'openclaw' ? new OpenClawTurnQueue({ store, turns: database.turns, executions: database.openClawExecutions, authorizeTurn,
        refreshSessions: prepare, refreshMessages: async () => {}, send: dispatch, mirror: async () => {} }) : undefined;
      if (codex) {
        (codex as any).connectionId = "synthetic-connection";
        // Private dispatch starts after the worker has validated predecessor history.
        (codex as any).threadRefreshResult.set(sessionKey, { at: 0, available: true });
        (codex as any).ensureStarted = prepare;
        (codex as any).ensureThreadLoaded = async () => {};
        (codex as any).request = async (method: string) => {
          assert.equal(method, 'turn/start');
          const result = await dispatch();
          return { turn: { id: result.runId } };
        };
      }
      const drain = () => codex ? (codex as any).drainQueuedTurn(sessionKey) : (openclaw as any).reconcile(sessionKey);
      try {
        if (codex) await codex.send(sessionKey, 'synthetic message', [], { actorId: ref.actorId, executionGrant });
        else openclaw!.enqueue({ id: 'synthetic-command', sessionKey, createdAt: 1,
          payload: { actorId: ref.actorId, executionGrant, message: 'synthetic message', media: [], deliveryMode: 'web-only' } });
        assert.deepEqual(database.turns.head<any>(runtime, sessionKey)?.payload.executionGrant, executionGrant);
        if (timing === 'before') revoke();
        await drain();
        assert.equal(sent, timing === 'unknown' || timing === 'valid' ? 1 : 0);
        assert.equal(database.turns.head(runtime, sessionKey)?.state,
          timing === 'valid' ? undefined : timing === 'unknown' ? 'outcome_unknown' : 'blocked');
        // A replacement grant cannot authorize work admitted with the old ref.
        grants.issue({ ...binding, version: 2 }, ['messages:send'], now + 1000);
        await drain();
        assert.equal(sent, timing === 'unknown' || timing === 'valid' ? 1 : 0);
      } finally { await codex?.close(); await openclaw?.close(); database.close(); grantDb.close(); }
    });
  }
}

test('effective authority rejects delegated actor without ref and requires explicit issuer delegation scope', () => {
  const database = new ConnectorUserStore(':memory:', () => true);
  try {
    const binding = { issuerTokenId: 'issuer', hubId: 'hub', principalId: 'principal', grantKey: 'policy', version: 1,
      runtime: 'codex' as const, sessionKey: 'codex:synthetic' };
    const ref = database.executionGrants.issue(binding, ['messages:send'], Date.now() + 60_000);
    let delegation = false;
    const authorize = createTurnAuthorizer(database.executionGrants, (_id, scope) => scope === 'messages:send' || delegation);
    assert.equal(authorize('direct-token', binding, 'messages:send'), true);
    assert.equal(authorize(ref.actorId, binding, 'messages:send'), false);
    assert.equal(authorize(ref.actorId, binding, 'messages:send', { ...ref, issuerTokenId: 'issuer' }), false);
    delegation = true;
    assert.equal(authorize(ref.actorId, binding, 'messages:send', { ...ref, issuerTokenId: 'issuer' }), true);
    assert.equal(authorize(ref.actorId, binding, 'runs:interrupt', { ...ref, issuerTokenId: 'issuer' }), false);
  } finally { database.close(); }
});

for (const runtime of ['codex', 'openclaw'] as const) {
  test(`${runtime} persisted queue retains revoked delegation across database reopen`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-delegation-reopen-'));
    const file = join(directory, 'connector.sqlite');
    let database = new ConnectorUserStore(file, () => true);
    const sessionKey = runtime === 'codex' ? 'codex:reopen' : 'agent:main:dashboard:reopen';
    const binding = { issuerTokenId: 'issuer', hubId: 'hub', principalId: 'principal', grantKey: 'policy', version: 1, runtime, sessionKey };
    const ref = database.executionGrants.issue(binding, ['messages:send'], Date.now() + 60_000);
    const executionGrant = { ...ref, issuerTokenId: 'issuer' };
    await database.turns.enqueueAsync(runtime, { id: 'queued', sessionKey, createdAt: 1,
      payload: { text: 'message', message: 'message', images: [], media: [], deliveryMode: 'web-only', actorId: ref.actorId, executionGrant } });
    database.executionGrants.revoke('issuer', ref.id);
    database.close();
    database = new ConnectorUserStore(file, () => true);
    const store = new DeckStore();
    store.upsertSession({ sessionKey, agentId: runtime === 'codex' ? 'codex' : 'main', title: 'Reopen', status: 'idle' });
    const authorizeTurn = createTurnAuthorizer(database.executionGrants, () => true);
    const codex = runtime === 'codex' ? new CodexAppServer({ store, turnQueue: database.turns, executions: database.codexExecutions, authorizeTurn,
      enabled: true, command: 'must-not-launch', defaultCwd: '/tmp', defaultModel: 'synthetic', approvalPolicy: 'never' }) : undefined;
    const forbidden = async () => { assert.fail('revoked queue cannot reach runtime preparation'); };
    const openclaw = runtime === 'openclaw' ? new OpenClawTurnQueue({ store, turns: database.turns, executions: database.openClawExecutions, authorizeTurn,
      refreshSessions: forbidden, refreshMessages: forbidden, send: forbidden, mirror: forbidden }) : undefined;
    if (codex) (codex as any).ensureStarted = forbidden;
    try {
      assert.deepEqual(database.turns.head<any>(runtime, sessionKey)?.payload.executionGrant, executionGrant);
      if (codex) await (codex as any).drainQueuedTurn(sessionKey);
      else await (openclaw as any).reconcile(sessionKey);
      assert.equal(database.turns.head(runtime, sessionKey)?.state, 'blocked');
    } finally { await codex?.close(); await openclaw?.close(); database.close(); rmSync(directory, { recursive: true, force: true }); }
  });
}

for (const stage of ['send-only', 'thread/read', 'thread/rollback', 'thread/compact/start', 'valid'] as const) {
  test(`Codex explicit successor recovery preserves reference and separate compact action (${stage})`, async () => {
    const database = new ConnectorUserStore(':memory:', () => true), store = new DeckStore();
    const sessionKey = 'codex:delegated-recovery';
    const binding = { issuerTokenId: 'issuer', hubId: 'hub', principalId: 'principal', grantKey: 'policy', version: 1, runtime: 'codex' as const, sessionKey };
    const ref = database.executionGrants.issue(binding, stage === 'send-only' ? ['messages:send'] : ['messages:send', 'runs:compact'], Date.now() + 60_000);
    const executionGrant = { ...ref, issuerTokenId: 'issuer' };
    const codex = new CodexAppServer({ store, turnQueue: database.turns, executions: database.codexExecutions, authorizeTurn: createTurnAuthorizer(database.executionGrants, () => true),
      enabled: true, command: 'must-not-launch', defaultCwd: '/tmp', defaultModel: 'synthetic', approvalPolicy: 'never' });
    store.upsertSession({ sessionKey, agentId: 'codex', title: 'Recovery', status: 'idle' });
    const calls: string[] = [];
    let starts = 0, reconciling = false;
    (codex as any).connectionId = "synthetic-connection";
    (codex as any).threadRefreshResult.set(sessionKey, { at: 0, available: true });
    (codex as any).ensureStarted = async () => {};
    (codex as any).ensureThreadLoaded = async () => {};
    (codex as any).request = async (method: string) => {
      if (reconciling) {
        if (method === 'thread/backgroundTerminals/list') return { data: [] };
        assert.equal(method, 'thread/read', 'terminal reconciliation must remain read-only');
        return { thread: { id: 'delegated-recovery', turns: [{ id: 'run', status: 'failed', error: { message: '413 Payload Too Large' }, items: [] }] } };
      }
      calls.push(method);
      if (method === stage) database.executionGrants.revoke('issuer', ref.id);
      if (method === 'thread/read') return { thread: { id: 'delegated-recovery', turns: [{ id: 'failed', status: 'failed', error: { message: '413 Payload Too Large' }, items: [] }] } };
      if (method === 'thread/compact/start') queueMicrotask(() => {
        for (const event of ['item/started', 'item/completed']) (codex as any).handleNotification(event, {
          threadId: 'delegated-recovery', turnId: 'compact', item: { type: 'contextCompaction', id: 'compact-item' }, startedAtMs: 1, completedAtMs: 2,
        });
        (codex as any).handleNotification('turn/completed', { threadId: 'delegated-recovery', turn: { id: 'compact', status: 'completed' } });
      });
      return method === 'turn/start' ? { turn: { id: ++starts === 1 ? 'run' : 'successor' } } : {};
    };
    try {
      await codex.send(sessionKey, 'message', [], { actorId: ref.actorId, executionGrant });
      await (codex as any).drainQueuedTurn(sessionKey);
      calls.length = 0;
      reconciling = true;
      (codex as any).handleNotification('turn/completed', { threadId: 'delegated-recovery',
        turn: { id: 'run', status: 'failed', error: { message: '413 Payload Too Large' }, items: [] } });
      await (codex as any).completingTurns.get(sessionKey);
      reconciling = false;
      assert.deepEqual(calls, [], '413 cannot silently authorize another native turn');
      await codex.send(sessionKey, 'explicit next request', [], { actorId: ref.actorId, executionGrant });
      assert.deepEqual(database.turns.head<any>('codex', sessionKey)?.payload.executionGrant, executionGrant);
      await (codex as any).drainQueuedTurn(sessionKey);
      const sequence = ['thread/read', 'thread/rollback', 'thread/compact/start', 'turn/start'];
      assert.deepEqual(calls, stage === 'valid' ? sequence : sequence.slice(0, stage === 'send-only' ? 1 : sequence.indexOf(stage) + 1));
      const mutated = stage === 'thread/rollback' || stage === 'thread/compact/start';
      assert.equal(database.turns.head('codex', sessionKey)?.state, stage === 'valid' ? undefined : mutated ? 'outcome_unknown' : 'blocked');
      if (mutated) assert.equal(database.codexExecutions.get(sessionKey)?.reason, 'preparation_unknown');
      assert.equal(starts, stage === 'valid' ? 2 : 1);
      if (stage === 'valid') assert.equal(store.getSession(sessionKey)?.runtime?.turnId, 'successor');
    } finally { await codex.close(); database.close(); }
  });
}

test('Codex run-bound interrupt carries the separate delegated action and rechecks grant during preparation', async () => {
  const database = new ConnectorUserStore(':memory:', () => true), store = new DeckStore();
  const sessionKey = 'codex:interrupt-fixture';
  const binding = { issuerTokenId: 'issuer', hubId: 'hub', principalId: 'principal', grantKey: 'policy', version: 1, runtime: 'codex' as const, sessionKey };
  const ref = database.executionGrants.issue(binding, ['runs:interrupt'], Date.now() + 60_000);
  const executionGrant = { ...ref, issuerTokenId: 'issuer' };
  const codex = new CodexAppServer({ store, turnQueue: database.turns, executions: database.codexExecutions, authorizeTurn: createTurnAuthorizer(database.executionGrants, () => true),
    enabled: true, command: 'must-not-launch', defaultCwd: '/tmp', defaultModel: 'synthetic', approvalPolicy: 'never' });
  store.upsertSession({ sessionKey, agentId: 'codex', title: 'Synthetic interrupt', status: 'running' });
  (codex as any).activeTurnIds.set(sessionKey, 'run-a');
  (codex as any).connectionId = "synthetic-connection";
  (codex as any).ensureStarted = async () => { database.executionGrants.revoke('issuer', ref.id); };
  (codex as any).request = async () => { assert.fail('revoked interrupt cannot reach runtime'); };
  try {
    await assert.rejects(codex.send(sessionKey, 'not allowed', [], { actorId: ref.actorId, executionGrant }), TurnAuthorizationError);
    await assert.rejects(codex.interrupt(sessionKey, 'run-a', ref.actorId, executionGrant), TurnAuthorizationError);
  } finally { await codex.close(); database.close(); }
});
