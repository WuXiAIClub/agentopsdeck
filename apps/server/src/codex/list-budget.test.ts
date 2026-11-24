import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { DeckStore } from '../projection/deck-store.js';
import { CodexAppServer } from './app-server.js';

function fixture(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-list-budget-'));
  const users = new ConnectorUserStore(':memory:');
  const store = new DeckStore({ sessionTitlesFile: join(directory, 'titles.json') });
  const codex = new CodexAppServer({ enabled: true, command: 'must-not-launch', defaultCwd: directory,
    defaultModel: 'synthetic', approvalPolicy: 'never', store, turnQueue: users.turns,
    executions: users.codexExecutions, authorizeTurn: () => true, requestTimeoutMs: 50 });
  const runtime = codex as any;
  runtime.ensureStarted = async () => {};
  runtime.setConnection('synthetic-connection');
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  t.after(async () => { await codex.close(); users.close(); rmSync(directory, { recursive: true, force: true }); });
  return { codex, runtime, store, advance: (ms: number) => { now += ms; } };
}

test('unique endless list cursors stop at a bounded page count without certifying a partial snapshot', async t => {
  const f = fixture(t);
  let requests = 0;
  f.runtime.request = async () => {
    if (++requests > 101) throw new Error('synthetic test safety bound');
    return { data: [], nextCursor: `unique-${requests}` };
  };
  await assert.rejects(f.codex.refreshSessions(), /Codex session list page limit/);
  assert.equal(requests, 100);
  assert.equal(f.codex.isSessionListReady(), false);
  f.runtime.request = async () => ({ data: [], nextCursor: null });
  await f.codex.refreshSessions({ maxAgeMs: 60_000 });
  assert.equal(f.codex.isSessionListReady(), true, 'explicit retry can recover');
});

test('a final page at the page-count bound remains a valid complete list', async t => {
  const f = fixture(t);
  let requests = 0;
  f.runtime.request = async () => ({ data: [], nextCursor: ++requests < 100 ? `unique-${requests}` : null });
  await f.codex.refreshSessions();
  assert.equal(requests, 100);
  assert.equal(f.codex.isSessionListReady(), true);
});

test('list rejects more rows than requested before projecting any of that page', async t => {
  const f = fixture(t);
  f.runtime.request = async () => ({ data: Array.from({ length: 101 }, (_, i) => ({ id: `oversized-${i}` })), nextCursor: null });
  await assert.rejects(f.codex.refreshSessions(), /Invalid Codex session list/);
  assert.equal(f.store.getSession('codex:oversized-0'), undefined);
  assert.equal(f.codex.isSessionListReady(), false);
});

test('all pages share one monotonic budget and forward only the remainder to each existing RPC timer', async t => {
  const f = fixture(t);
  const budgets: number[] = [];
  f.runtime.request = async (_method: string, _params: unknown, timeoutMs: number) => {
    budgets.push(timeoutMs); f.advance(20);
    return { data: [], nextCursor: budgets.length < 3 ? `next-${budgets.length}` : null };
  };
  await assert.rejects(f.codex.refreshSessions(), /Codex session list timed out/);
  assert.deepEqual(budgets, [50, 30, 10]);
  assert.equal(f.codex.isSessionListReady(), false, 'even a final page after the deadline is not publishable');
});

test('initialization consumes the same list budget without dispatching a read after expiry', async t => {
  const f = fixture(t);
  f.runtime.ensureStarted = async () => { f.advance(51); };
  let requests = 0;
  f.runtime.request = async () => { requests++; return { data: [], nextCursor: null }; };
  await assert.rejects(f.codex.refreshSessions(), /Codex session list timed out/);
  assert.equal(requests, 0);
});

test('metadata projection cannot commit success after exhausting the list deadline', async t => {
  const f = fixture(t);
  f.runtime.request = async () => ({ data: [{ id: 'synthetic' }], nextCursor: null });
  const restore = f.runtime.restoreThread.bind(f.runtime);
  f.runtime.restoreThread = (thread: unknown, connection: string) => { restore(thread, connection); f.advance(50); };
  await assert.rejects(f.codex.refreshSessions(), /Codex session list timed out/);
  assert.equal(f.codex.isSessionListReady(), false);
});
