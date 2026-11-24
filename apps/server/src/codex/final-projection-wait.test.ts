import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { DeckStore } from '../projection/deck-store.js';
import { CodexAppServer } from './app-server.js';

for (const outcome of ['completed', 'failed', 'interrupted'] as const) {
  test(`pending original assistant projection reports ${outcome} history error without releasing execution`, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-final-projection-'));
    const users = new ConnectorUserStore(':memory:');
    const store = new DeckStore({ sessionTitlesFile: join(dir, 'titles.json') });
    const codex = new CodexAppServer({ enabled: true, command: 'must-not-launch', defaultCwd: dir,
      defaultModel: 'synthetic', approvalPolicy: 'never', store, turnQueue: users.turns,
      executions: users.codexExecutions, authorizeTurn: () => true, requestTimeoutMs: 10 });
    const runtime = codex as any, key = 'codex:synthetic';
    runtime.ensureStarted = async () => {}; runtime.setConnection('synthetic-connection');
    store.upsertSession({ sessionKey: key, agentId: 'codex', title: 'Known', status: 'unknown',
      runtime: { turnId: 'turn', phase: 'running', connection: 'connected', sync: 'current', lastEventAt: 1 } });
    store.addMessage({ id: 'known', sessionKey: key, role: 'assistant', text: 'Keep visible', createdAt: 1 });
    users.codexExecutions.begin(key, 'command', 'synthetic-connection');
    users.codexExecutions.acknowledge(key, 'command', 'synthetic-connection', 'turn', () => {});
    let release!: () => void, reads = 0, wakes = 0;
    const original = new Set<Promise<void>>();
    const pending = new Promise<void>(resolve => { release = resolve; }).finally(() => original.delete(pending));
    original.add(pending); runtime.assistantProjections.set(key, original);
    runtime.assistantText.set(`${key}:held`, 'Retain original live buffer');
    runtime.completedAssistantItems.add(`${key}:held-marker`);
    runtime.request = async () => { reads++; throw Error('must not read before original projection settles'); };
    runtime.turnWorker.wake = () => { wakes++; };
    const logs: unknown[][] = [], previousError = console.error;
    console.error = (...args) => { logs.push(args); };
    t.after(async () => { release(); console.error = previousError; await codex.close(); users.close(); rmSync(dir, { recursive: true, force: true }); });
    runtime.handleNotification('turn/completed', { threadId: 'synthetic', turn: { id: 'turn', status: outcome } });
    const task = runtime.completingTurns.get(key);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bounded = await Promise.race([task.then(() => true), new Promise<boolean>(resolve => {
      timer = setTimeout(() => resolve(false), 500);
    })]);
    clearTimeout(timer);
    // Release only after recording whether the history observer settled. This
    // is test cleanup, not production cancellation or execution recovery.
    if (!bounded) { release(); await task; }
    assert.equal(bounded, true, 'a hung original projection must not leave final history permanently syncing');
    assert.equal(reads, 0); assert.equal(wakes, 0);
    assert.equal(runtime.assistantProjections.get(key), original);
    assert.equal(original.size, 1, 'original owner remains accounted for until actual settlement');
    assert.equal(users.codexExecutions.canStart(key), false);
    assert.equal(users.codexExecutions.get(key)?.sync, 'error');
    assert.equal(store.getSession(key)?.runtime?.sync, 'error');
    assert.equal(store.getMessages(key)[0]?.text, 'Keep visible');
    assert.ok(logs.some(args => JSON.stringify(args).includes('assistant-projection-wait')));
    assert.equal(runtime.assistantText.get(`${key}:held`), 'Retain original live buffer');
    assert.ok(runtime.completedAssistantItems.has(`${key}:held-marker`));
    release(); await pending;
    assert.equal(original.size, 0);
    assert.equal(users.codexExecutions.canStart(key), false, 'actual projection settlement alone is not execution proof');
    assert.equal(wakes, 0);
    runtime.request = async (method: string) => {
      reads++;
      if (method === 'thread/backgroundTerminals/list') return { data: [] };
      assert.equal(method, 'thread/read', 'recovery may only reread, never resend');
      return { thread: { id: 'synthetic', status: { type: 'idle' }, turns: [
        { id: 'turn', status: outcome, items: [{ id: 'reply', type: 'agentMessage', text: 'Recovered' }] },
      ] } };
    };
    runtime.reconcileCompletedTurn(key, 'synthetic', 10, 'turn', outcome);
    await runtime.completingTurns.get(key);
    assert.equal(store.getSession(key)?.runtime?.sync, 'current', 'fresh original history proof enables read recovery');
    assert.ok(reads > 0);
  });
}

for (const fault of ['private-error', 'hostile-coercion', 'logger-failure'] as const) {
  test(`assistant projection ${fault} is observed without changing original settlement`, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-projection-diagnostic-'));
    const users = new ConnectorUserStore(':memory:');
    const store = new DeckStore({ sessionTitlesFile: join(dir, 'titles.json') });
    const codex = new CodexAppServer({ enabled: true, command: 'must-not-launch', defaultCwd: dir,
      defaultModel: 'synthetic', approvalPolicy: 'never', store, turnQueue: users.turns,
      executions: users.codexExecutions, authorizeTurn: () => true });
    const runtime = codex as any, key = 'codex:synthetic';
    runtime.ensureStarted = async () => {}; runtime.setConnection('synthetic-connection');
    store.upsertSession({ sessionKey: key, agentId: 'codex', title: 'Known', status: 'unknown',
      runtime: { turnId: 'turn', phase: 'running', connection: 'connected', sync: 'current', lastEventAt: 1 } });
    users.codexExecutions.begin(key, 'command', 'synthetic-connection');
    users.codexExecutions.acknowledge(key, 'command', 'synthetic-connection', 'turn', () => {});
    let coercions = 0, wakes = 0, calls = 0;
    const secret = 'PRIVATE_PATH_TOKEN_AND_REPLY';
    const hostile = { [Symbol.toPrimitive]() { coercions++; throw Error(secret); } };
    runtime.recordAssistantMessage = async () => { calls++; throw fault === 'private-error' ? Error(secret) : hostile; };
    runtime.turnWorker.wake = () => { wakes++; };
    const logs: unknown[][] = [], previousWarn = console.warn;
    console.warn = (...args) => { logs.push(args); if (fault === 'logger-failure') throw Error(secret); };
    t.after(async () => { console.warn = previousWarn; await codex.close(); users.close(); rmSync(dir, { recursive: true, force: true }); });
    runtime.handleNotification('item/completed', { threadId: 'synthetic', turnId: 'turn',
      item: { id: 'reply', type: 'agentMessage', text: 'Visible reply' } });
    const original = runtime.assistantProjections.get(key) as Set<Promise<void>>;
    const task = [...original][0]; assert.ok(task);
    await task;
    assert.equal(calls, 1); assert.equal(coercions, 0); assert.equal(wakes, 0);
    assert.equal(original.size, 0, 'only actual handled settlement retires the original task');
    assert.equal(users.codexExecutions.canStart(key), false);
    assert.equal(users.codexExecutions.get(key)?.phase, 'running');
    assert.deepEqual(logs, [['[codex-assistant-projection-failed]', { stage: 'assistant-projection', fault: 'unavailable' }]]);
    assert.equal(JSON.stringify(logs).includes(secret), false);
  });
}
