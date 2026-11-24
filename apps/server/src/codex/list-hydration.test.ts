import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { DeckStore } from '../projection/deck-store.js';
import { CodexAppServer } from './app-server.js';

function fixture(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-list-hydration-'));
  const users = new ConnectorUserStore(':memory:');
  const store = new DeckStore({ sessionTitlesFile: join(directory, 'titles.json') });
  const codex = new CodexAppServer({ enabled: true, command: 'must-not-launch', defaultCwd: directory,
    defaultModel: 'synthetic-default', approvalPolicy: 'never', store, turnQueue: users.turns,
    executions: users.codexExecutions, authorizeTurn: () => true });
  const runtime = codex as any;
  runtime.ensureStarted = async () => {};
  runtime.setConnection('synthetic-connection');
  t.after(async () => { await codex.close(); users.close(); rmSync(directory, { recursive: true, force: true }); });
  const rollout = join(directory, 'rollout.jsonl');
  writeFileSync(rollout, JSON.stringify({ payload: { type: 'turn_context', model: 'synthetic-persisted' } }) + '\n');
  const thread = { id: 'synthetic', name: 'Synthetic', status: { type: 'idle' }, path: rollout, turns: [] };
  return { users, store, codex, runtime, thread, sessionKey: 'codex:synthetic' };
}

test('paginated lists read neither rollout paths nor per-thread histories', async t => {
  const f = fixture(t);
  let pages = 0;
  f.runtime.request = async (method: string, params: any) => {
    assert.equal(method, 'thread/list');
    assert.equal(params.cursor, pages ? 'next' : null);
    pages++;
    return { data: Array.from({ length: 100 }, (_, i) => ({ id: `page-${pages}-${i}`, name: 'Metadata',
      status: { type: 'idle' }, get path(): never { return assert.fail('list must not open a rollout'); } })), nextCursor: pages === 1 ? 'next' : null };
  };
  await f.codex.refreshSessions();
  assert.equal(pages, 2);
  assert.equal(f.codex.isSessionListReady(), true);
  assert.equal(f.store.getSession('codex:page-2-99')?.status, 'unknown', 'list idle is not execution evidence');
  assert.equal(f.runtime.threadRefreshResult.size, 0, 'listing does not create history freshness');
});

test('list publication does not wait for an unrelated pending history read', async t => {
  const f = fixture(t);
  let release!: (value: unknown) => void;
  f.runtime.request = async (method: string) => method === 'thread/list'
    ? { data: [f.thread], nextCursor: null } : method === 'thread/goal/get'
      ? { goal: null } : new Promise(resolve => { release = resolve; });
  const history = f.codex.refreshSession(f.sessionKey);
  await Promise.resolve();
  const list = f.codex.refreshSessions();
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.codex.isSessionListReady(), true);
    assert.equal(f.store.getMessages(f.sessionKey).length, 0);
  } finally { release({ thread: f.thread }); await Promise.all([history, list]); }
});

test('metadata refresh preserves known model, live execution and hydrated messages', async t => {
  const f = fixture(t);
  f.store.upsertSession({ sessionKey: f.sessionKey, agentId: 'codex', title: 'Known', status: 'running', hasActiveRun: true, model: 'known-model' });
  f.store.addMessage({ id: 'known', sessionKey: f.sessionKey, role: 'assistant', text: 'Live', status: 'sent', createdAt: 1 });
  f.runtime.threadModels.set(f.thread.id, 'known-model');
  const methods: string[] = [];
  f.runtime.request = async (method: string) => { methods.push(method); return method === 'thread/list'
    ? { data: [f.thread], nextCursor: null } : { thread: f.thread }; };
  await f.codex.refreshSessions();
  assert.deepEqual(methods, ['thread/list']);
  assert.equal(f.store.getSession(f.sessionKey)?.model, 'known-model');
  assert.equal(f.store.getSession(f.sessionKey)?.status, 'running');
  assert.equal(f.store.getMessages(f.sessionKey)[0]?.text, 'Live');
});

for (const override of [false, true]) test(`on-demand history restores model with ${override ? 'current override winning' : 'native rollout fallback'}`, async t => {
  const f = fixture(t);
  f.store.upsertSession({ sessionKey: f.sessionKey, agentId: 'codex', title: 'Metadata', status: 'unknown' });
  f.runtime.request = async (method: string) => {
    if (method === 'thread/goal/get') return { goal: null };
    assert.equal(method, 'thread/read'); return { thread: f.thread };
  };
  const read = f.codex.refreshSession(f.sessionKey);
  if (override) f.codex.updateSessionRuntime(f.sessionKey, { model: 'synthetic-override' });
  await read;
  const expected = override ? 'synthetic-override' : 'synthetic-persisted';
  assert.equal(f.store.getSession(f.sessionKey)?.model, expected);
  assert.equal(f.runtime.threadModels.get(f.thread.id), expected);
});

test('original queue worker hydrates cold session and restores model before synthetic resume/start', async t => {
  const f = fixture(t);
  const methods: string[] = [];
  f.runtime.request = async (method: string, params: any) => {
    methods.push(method);
    if (method === 'thread/list') return { data: [f.thread], nextCursor: null };
    if (method === 'thread/read') return { thread: f.thread };
    if (method === 'thread/goal/get') return { goal: null };
    if (method === 'thread/resume' || method === 'turn/start') {
      assert.equal(params.model, 'synthetic-persisted');
      return method === 'thread/resume' ? { thread: f.thread } : { turn: { id: 'synthetic-turn' } };
    }
    assert.fail(`unexpected RPC ${method}`);
  };
  await f.codex.refreshSessions();
  assert.deepEqual(methods, ['thread/list']);
  await f.codex.send(f.sessionKey, 'Synthetic queued input');
  assert.deepEqual(methods, ['thread/list'], 'admission does not hydrate or execute');
  await f.runtime.turnWorker.pass();
  assert.deepEqual(methods, ['thread/list', 'thread/read', 'thread/resume', 'turn/start']);
  assert.equal(f.users.codexExecutions.get(f.sessionKey)?.runId, 'synthetic-turn');
});

for (const boundary of ['metadata', 'history']) test(`on-demand ${boundary} cannot project model/messages or cache after connection replacement`, async t => {
  const f = fixture(t);
  f.store.upsertSession({ sessionKey: f.sessionKey, agentId: 'codex', title: 'Known', status: 'unknown' });
  const thread = { ...f.thread, turns: [{ id: 'old', status: 'completed', items: [
    { id: 'old-message', type: 'agentMessage', text: 'Retired reply' },
  ] }], get path() {
    if (boundary === 'metadata') queueMicrotask(() => f.runtime.setConnection('replacement'));
    return f.thread.path;
  } };
  f.runtime.options.projectAssistant = async (text: string) => {
    if (boundary === 'history') f.runtime.setConnection('replacement');
    return { text, media: [] };
  };
  f.runtime.request = async () => ({ thread });
  await assert.rejects(f.codex.refreshSession(f.sessionKey), /snapshot obsolete/);
  assert.equal(f.store.getSession(f.sessionKey)?.model, undefined);
  assert.equal(f.runtime.threadModels.has(f.thread.id), false);
  assert.equal(f.store.getMessages(f.sessionKey).length, 0);
  assert.equal(f.runtime.threadRefreshResult.has(f.sessionKey), false);
  f.runtime.request = async (method: string) => method === 'thread/backgroundTerminals/list' ? { data: [] } : ({ thread: f.thread });
  await f.codex.refreshSession(f.sessionKey, { maxAgeMs: 60_000 });
  assert.equal(f.store.getSession(f.sessionKey)?.model, 'synthetic-persisted');
});
