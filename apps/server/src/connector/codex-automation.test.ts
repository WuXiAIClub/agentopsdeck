import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { ConnectorUserStore } from './connector-user-store.js';
import { DeckStore } from '../projection/deck-store.js';
import { CodexAppServer } from '../codex/app-server.js';
import type { AutomationRule } from '../commands/automation-policy.js';

function fixture(t: TestContext) {
  const users = new ConnectorUserStore(':memory:', () => true, { runtimeOwner: true });
  const deck = new DeckStore(), key = 'codex:synthetic';
  deck.upsertSession({ sessionKey: key, agentId: 'codex', title: 'Fixture', status: 'idle', codexGoal: null });
  let allowed = true, nativeCalls = 0;
  const codex = new CodexAppServer({ enabled: true, command: 'must-not-launch', defaultCwd: '/nonexistent',
    defaultModel: 'test', approvalPolicy: 'never', store: deck, turnQueue: users.turns,
    executions: users.codexExecutions, authorizeTurn: () => allowed });
  const runtime = codex as any;
  runtime.setConnection('native-connection');
  runtime.request = async () => { nativeCalls++; throw Error('must not invoke native'); };
  runtime.threadRefreshResult.set(key, { at: Date.now(), available: true });
  const facts = users.codexExecutions;
  facts.begin(key, 'prior', 'native-connection'); facts.acknowledge(key, 'prior', 'native-connection', 'prior-turn', () => {});
  facts.observe(key, 'native-connection', 'prior-turn', 'completed');
  facts.settleNativeHistory(facts.get(key)!, { turnId: 'prior-turn', fingerprint: 'a'.repeat(64),
    connectionId: 'native-connection', state: 'verified', reason: 'settled' });
  const service = users.createCodexAutomation(codex, 'owner', 'connector-id', () => allowed);
  const at = Date.now(), target = { ownerId: 'owner', connectionId: 'connector-id', runtime: 'codex', sessionId: key };
  const rule: AutomationRule = { id: 'rule', revision: 1, authorityEpoch: 1, target, enabled: true,
    startsAt: at, expiresAt: at + 3600000, maxSends: 2, maxPerHour: 2, minIntervalMs: 60000,
    mode: { kind: 'once', at } };
  service.config.configure('owner', 'config1', { kind: 'save', rule, template: 'synthetic message', expectedRevision: 0, confirmEnable: true });
  function reserve() {
    return service.store.reserve('owner', rule.id, { kind: 'timer', at, slot: 0 }, {
      ...codex.automationObservation(key, 'owner'), target, revision: 1, authorityEpoch: 1, queueEmpty: true });
  }
  t.after(async () => { service.scheduler.stop(); await codex.close(); users.close(); });
  return { users, deck, codex, runtime, facts, key, service, reserve, target,
    revoke: () => { allowed = false; }, nativeCalls: () => nativeCalls };
}

test('real owned-store/native-send composition queues once, without starting native work or scheduler', async t => {
  const f = fixture(t);
  assert.equal(f.users.turns.maintenanceCount(), 0);
  assert.equal((await f.service.scheduler.tick()).considered, 0);
  const reserved = f.reserve();
  assert.equal((await f.service.runner.dispatch('owner', reserved.requestId)).state, 'queued');
  assert.equal((await f.service.runner.dispatch('owner', reserved.requestId)).state, 'queued');
  assert.equal(f.users.turns.maintenanceCount(), 1);
  assert.equal(f.deck.getMessages(f.key).filter(m => m.role === 'user').length, 1);
  assert.equal(f.nativeCalls(), 0);
  const turn = f.users.turns.head('codex', f.key)!;
  assert.equal((turn.payload as { actorId: string }).actorId, 'owner');
});

for (const barrier of ['maintenance', 'revoked', 'active', 'paused', 'blocked', 'usageLimited', 'budgetLimited',
  'unknown-goal', 'malformed-complete', 'history', 'reconnect', 'goal-write', 'goal-read', 'native-turn'] as const) {
  test(`native composition refuses ${barrier} after reservation and before admission`, async t => {
    const f = fixture(t), reserved = f.reserve();
    if (barrier === 'maintenance') f.users.pauseTurnStarts();
    else if (barrier === 'revoked') f.revoke();
    else if (barrier === 'history') f.facts.invalidateNativeHistory(f.key);
    else if (barrier === 'reconnect') f.runtime.setConnection('replacement');
    else if (barrier === 'goal-write') f.runtime.goalChangesInflight.add(f.key);
    else if (barrier === 'goal-read') f.runtime.goalReadInflight.set(f.key, Promise.resolve());
    else if (barrier === 'native-turn') f.runtime.activeTurnIds.set(f.key, 'active');
    else if (barrier === 'unknown-goal') {
      const { codexGoal: _, ...session } = f.deck.getSession(f.key)!; f.deck.upsertSession(session);
    } else f.deck.upsertSession({ ...f.deck.getSession(f.key)!, codexGoal: barrier === 'malformed-complete'
      ? { status: 'complete' } as any
      : { status: barrier, objective: 'Fixture', objectiveTruncated: false, tokenBudget: null,
        tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 } });
    if (barrier === 'revoked') await assert.rejects(f.service.runner.dispatch('owner', reserved.requestId), /forbidden/);
    else await assert.rejects(f.service.runner.dispatch('owner', reserved.requestId), /busy|admission|offline/);
    assert.equal(f.service.store.receipt('owner', reserved.requestId)!.state, 'reserved');
    assert.equal(f.users.turns.maintenanceCount(), 0);
    assert.equal(f.deck.getMessages(f.key).filter(m => m.role === 'user').length, 0);
    assert.equal(f.nativeCalls(), 0);
  });
}

test('management stores cannot construct automation and wrong connector/runtime targets cannot configure', t => {
  const f = fixture(t), reader = new ConnectorUserStore(':memory:'); t.after(() => reader.close());
  assert.throws(() => reader.createCodexAutomation(f.codex, 'owner', 'connector-id', () => true), /ownership/);
  for (const patch of [{ connectionId: 'foreign' }, { runtime: 'claude-code' }, { ownerId: 'foreign' }]) {
    const saved = f.service.store.read('owner', 'rule')!;
    assert.throws(() => f.service.config.configure('owner', 'wrong', { kind: 'save', template: 'test',
      rule: { ...saved.rule, id: 'wrong', target: { ...f.target, ...patch } }, expectedRevision: 0, confirmEnable: true }));
  }
});
