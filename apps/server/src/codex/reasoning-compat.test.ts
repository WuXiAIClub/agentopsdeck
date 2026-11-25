import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { TurnQueue } from '../commands/turn-queue.js';
import { DeckStore } from '../projection/deck-store.js';
import { CodexAppServer } from './app-server.js';
import { CodexExecutions } from './executions.js';
import { modelRejectsReasoningEffort, resolveCodexReasoningParams } from './reasoning-compat.js';

function createServer(store: DeckStore, defaultModel = 'gpt-6.1-sol') {
  const db = new DatabaseSync(':memory:');
  const instance = new CodexAppServer({
    authorizeTurn: () => true,
    turnQueue: new TurnQueue(db),
    executions: new CodexExecutions(db),
    enabled: true,
    command: 'codex',
    defaultCwd: '/workspace',
    defaultModel,
    approvalPolicy: 'never',
    store,
  });
  (instance as any).connectionId = 'synthetic-connection';
  (instance as any).ensureStarted = async () => undefined;
  return { instance, db };
}

test('resolveCodexReasoningParams preserves real effort on Neon/Hydrogen and normalizes disabled, invalid, and opt-in non-reasoning cases', () => {
  assert.deepEqual(resolveCodexReasoningParams({ model: 'gpt-6.1-sol', rawEffort: undefined }), {
    clearStickyEffort: false,
  });
  assert.deepEqual(resolveCodexReasoningParams({ model: 'gpt-6.1-sol', rawEffort: ' HIGH ' }), {
    effort: 'high',
    clearStickyEffort: false,
  });
  assert.deepEqual(resolveCodexReasoningParams({ model: 'gpt-6.1-sol', rawEffort: 'xhigh' }), {
    effort: 'xhigh',
    clearStickyEffort: false,
  });
  assert.deepEqual(resolveCodexReasoningParams({ model: 'gemini-3.1-pro-neon', rawEffort: 'high' }), {
    effort: 'high',
    clearStickyEffort: false,
  });
  assert.deepEqual(resolveCodexReasoningParams({ model: 'gemini-4-neon', rawEffort: 'medium' }), {
    effort: 'medium',
    clearStickyEffort: false,
  });
  assert.deepEqual(resolveCodexReasoningParams({ model: 'gemini-4-hydrogen', rawEffort: 'low' }), {
    effort: 'low',
    clearStickyEffort: false,
  });
  for (const disabled of ['off', 'none', 'minimal', 'disabled', 'false', '0']) {
    assert.deepEqual(resolveCodexReasoningParams({ model: 'gpt-6.1-sol', rawEffort: disabled }), {
      summary: 'none',
      clearStickyEffort: true,
    });
  }
  assert.deepEqual(resolveCodexReasoningParams({ model: 'gpt-6.1-sol', rawEffort: 'ultra' }), {
    summary: 'none',
    clearStickyEffort: true,
  });
  assert.deepEqual(resolveCodexReasoningParams({ model: 'gpt-6.1-sol', rawEffort: undefined, hadActiveEffort: true }), {
    clearStickyEffort: true,
  });
  assert.equal(modelRejectsReasoningEffort('gemini-3.1-pro-neon', {}), false);
  assert.equal(modelRejectsReasoningEffort('gemini-4-hydrogen', {}), false);
  assert.equal(modelRejectsReasoningEffort('custom-fast', { AOD_CODEX_NO_REASONING_MODELS: 'foo, custom-fast ,bar' }), true);
  assert.deepEqual(
    resolveCodexReasoningParams({
      model: 'custom-fast',
      rawEffort: 'high',
      env: { AOD_CODEX_NO_REASONING_MODELS: 'custom-fast' },
    }),
    { summary: 'none', clearStickyEffort: true },
  );
});

test('CodexAppServer preserves real effort on Neon/Hydrogen and clears sticky effort when thinking is set to off or default', async context => {
  const store = new DeckStore();
  const sessionKey = 'codex:thread-neon';
  store.upsertSession({ sessionKey, agentId: 'codex', title: 'Neon compatibility', status: 'idle', model: 'gemini-4-carbon' });
  const { instance, db } = createServer(store, 'gemini-4-carbon');
  context.after(async () => { await instance.close(); db.close(); });
  const turnParams = (cmd: string) => (instance as any).turnStartParams('thread-neon', cmd, [{ type: 'text', text: cmd }], false);

  instance.updateSessionRuntime(sessionKey, { model: 'gemini-4-carbon', thinking: 'high' });
  const first = turnParams('cmd-1');
  assert.equal(first.model, 'gemini-4-carbon');
  assert.equal(first.effort, 'high');
  assert.equal(first.summary, undefined);
  assert.equal(first.collaborationMode, undefined);

  instance.updateSessionRuntime(sessionKey, { model: 'gemini-3.1-pro-neon' });
  const second = turnParams('cmd-2');
  assert.equal(second.model, 'gemini-3.1-pro-neon');
  assert.equal(second.effort, 'high');
  assert.equal(second.summary, undefined);
  assert.equal(second.collaborationMode, undefined);

  instance.updateSessionRuntime(sessionKey, { model: 'gemini-4-hydrogen', thinking: 'medium' });
  const hydrogenTurn = turnParams('cmd-2b');
  assert.equal(hydrogenTurn.model, 'gemini-4-hydrogen');
  assert.equal(hydrogenTurn.effort, 'medium');
  assert.equal(hydrogenTurn.summary, undefined);
  assert.equal(hydrogenTurn.collaborationMode, undefined);

  instance.updateSessionRuntime(sessionKey, { model: 'gpt-6.1-sol', thinking: 'off' });
  const third = turnParams('cmd-3');
  assert.equal(third.model, 'gpt-6.1-sol');
  assert.equal(third.effort, undefined);
  assert.equal(third.summary, 'none');
  assert.deepEqual(third.collaborationMode, {
    mode: 'default',
    settings: { model: 'gpt-6.1-sol', reasoning_effort: null, developer_instructions: null },
  });

  instance.updateSessionRuntime(sessionKey, { model: 'gpt-6.1-sol', thinking: null });
  const fourth = turnParams('cmd-4');
  assert.equal(fourth.effort, undefined);
  assert.equal(fourth.summary, undefined);
  assert.deepEqual(fourth.collaborationMode, {
    mode: 'default',
    settings: { model: 'gpt-6.1-sol', reasoning_effort: null, developer_instructions: null },
  });

  const fifth = turnParams('cmd-5');
  assert.equal(fifth.effort, undefined);
  assert.equal(fifth.summary, undefined);
  assert.equal(fifth.collaborationMode, undefined);
});

test('CodexAppServer honors persisted store thinkingLevel on Neon/Hydrogen across restart and filters disabled effort on thread/resume', async context => {
  const dir = mkdtempSync(join(tmpdir(), 'aod-reasoning-compat-'));
  const thinkingFile = join(dir, 'thinking.json');
  const sessionA = 'codex:thread-persisted-medium';
  const sessionB = 'codex:thread-persisted-off';
  const sessionC = 'codex:thread-persisted-neon';
  writeFileSync(thinkingFile, JSON.stringify({
    [sessionA]: 'medium',
    [sessionB]: 'off',
    [sessionC]: 'high',
  }, null, 2));
  const store = new DeckStore({ sessionThinkingOverridesFile: thinkingFile });
  store.upsertSession({ sessionKey: sessionA, agentId: 'codex', title: 'A', status: 'idle', model: 'gpt-6.1-sol' });
  store.upsertSession({ sessionKey: sessionB, agentId: 'codex', title: 'B', status: 'idle', model: 'gpt-6.1-sol' });
  store.upsertSession({ sessionKey: sessionC, agentId: 'codex', title: 'C', status: 'idle', model: 'gemini-3.1-pro-neon' });
  const { instance, db } = createServer(store, 'gpt-6.1-sol');
  (instance as any).threadModels.set('thread-persisted-neon', 'gemini-3.1-pro-neon');
  (instance as any).threadRefreshResult.set(sessionA, { at: Date.now(), available: true });
  (instance as any).threadRefreshResult.set(sessionB, { at: Date.now(), available: true });
  (instance as any).threadRefreshResult.set(sessionC, { at: Date.now(), available: true });
  context.after(async () => {
    await instance.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const resumeCalls: any[] = [];
  const turnCalls: any[] = [];
  let seq = 0;
  (instance as any).request = async (method: string, params: any) => {
    if (method === 'thread/resume') {
      resumeCalls.push(params);
      return { thread: { id: params.threadId } };
    }
    if (method === 'turn/start') {
      turnCalls.push(params);
      return { turn: { id: `turn-${++seq}` } };
    }
    return {};
  };

  await (instance as any).ensureThreadLoaded('thread-persisted-medium');
  await (instance as any).ensureThreadLoaded('thread-persisted-off');
  await (instance as any).ensureThreadLoaded('thread-persisted-neon');

  assert.equal(resumeCalls[0]?.effort, 'medium');
  assert.equal(resumeCalls[1]?.effort, undefined);
  assert.equal(resumeCalls[2]?.effort, 'high');

  await instance.send(sessionA, 'Persisted medium');
  await (instance as any).drainQueuedTurn(sessionA);
  assert.equal(turnCalls[0]?.effort, 'medium');

  await instance.send(sessionB, 'Persisted off');
  await (instance as any).drainQueuedTurn(sessionB);
  assert.equal(turnCalls[1]?.effort, undefined);
  assert.equal(turnCalls[1]?.summary, 'none');

  await instance.send(sessionC, 'Persisted high on neon');
  await (instance as any).drainQueuedTurn(sessionC);
  assert.equal(turnCalls[2]?.effort, 'high');
  assert.equal(turnCalls[2]?.summary, undefined);
  assert.equal(turnCalls[2]?.collaborationMode, undefined);
});
