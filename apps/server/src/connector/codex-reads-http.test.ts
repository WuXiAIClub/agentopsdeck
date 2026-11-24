import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';
import { HISTORY_ASYNC_HEADER, CONNECTOR_PROTOCOL_HEADER } from '@agentopsdeck/shared';
import { EXPECTED_NODE_HEADER } from './node-identity.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { AsyncConnectorEventProjection } from './async-event-projection.js';
import { createAsyncCodexMessageIngress } from './async-codex-message-ingress.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { createConnectorOwnerCommands } from './connector-owner-domain.js';
import { registerConnectorRoutes } from '../routes/connector.js';
import { DeckStore } from '../projection/deck-store.js';
import { loadConfig } from '../config.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { AsyncCodexHistory } from './async-codex-history.js';
import { CodexAppServer } from '../codex/app-server.js';

const key = 'codex:original', authorization = 'Bearer isolated-read-router';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function fixture(worker: boolean, allowRecentProjection = false) {
  const directory = mkdtempSync(join(tmpdir(), 'codex-reads-router-')), tokenFile = join(directory, 'tokens.json');
  const logs: string[] = [], diagnostics = new PerformanceDiagnostics(line => logs.push(line));
  const tokens = new ConnectorTokenStore(tokenFile, authorization.slice(7), diagnostics);
  const local = new ConnectorUserStore(':memory:', undefined, { runtimeOwner: true });
  const original = createConnectorOwnerCommands(local, tokens);
  const owner = worker ? new AsyncConnectorOwner({ file: join(directory, 'connector.sqlite'), tokenFile,
    bootstrapToken: authorization.slice(7) }, diagnostics) : undefined;
  await owner?.open();
  const hooks: { refresh?: () => Promise<void>; beforeSnapshot?: () => Promise<void>; beforeDeliver?: () => Promise<void>;
    recovery?: (key: string, runId: string) => Promise<boolean>;
    display?: () => Promise<{ current(): boolean; verify(): Promise<boolean> } | undefined> } = {};
  const command: AsyncConnectorOwner['command'] = async (kind, input) => {
    if (kind === 'codexReadDeliver') await hooks.beforeDeliver?.();
    return owner ? owner.command(kind, input) : original(kind, input);
  };
  const events = owner ? new AsyncConnectorEventProjection(owner, diagnostics) : undefined;
  const deck = new DeckStore();
  deck.upsertSession({ sessionKey: key, source: 'codex', agentId: 'main', title: 'Original', status: 'running' });
  deck.addMessage({ id: 'original', sessionKey: key, role: 'assistant', text: 'Continuing goal', createdAt: 1 });
  let ready = true, refreshes = 0;
  const ingress = createAsyncCodexMessageIngress({ owner: { command }, diagnostics,
    runtime: { messageAdmissionReady: true, messageAdmissionState: () => ({ ready: true, exists: true, blocked: false }),
      publishMessageAdmission: () => assert.fail('reads cannot publish message admission') },
    reads: { projection: deck, allowRecentProjection, snapshot: async capture => {
      await hooks.beforeSnapshot?.();
      return events ? events.snapshot(capture, async () => {}) : capture('original-cursor');
    },
      display: () => hooks.display?.() ?? Promise.resolve(undefined),
      requestRecovery: (sessionKey, runId) => hooks.recovery?.(sessionKey, runId) ?? Promise.resolve(false),
      refresh: async (id, options) => { assert.equal(id, key); assert.deepEqual(options, { maxAgeMs: 1500, readOnly: true });
        refreshes++; await hooks.refresh?.(); }, historyReady: () => ready } });
  assert.ok(ingress.codexReads);
  const app = new Hono(), routes = registerConnectorRoutes(app, { config: loadConfig({} as NodeJS.ProcessEnv),
    tokens, connectorUsers: local, store: deck, gateway: {} as never, codexReads: ingress.codexReads,
    refreshSessions: async () => assert.fail('no synchronous-route refresh'), refreshMessages: async () => assert.fail('no synchronous-route history'),
    sessionSnapshotReady: () => true, historySnapshotReady: () => true, fallbackAgents: () => [],
    isAuthorizedRequest: () => true, normalizeError: () => 'private error' });
  const request = (suffix = '/messages', headers: Record<string, string> = {}) => app.request(
    `/api/connector/v1/sessions/${encodeURIComponent(key)}${suffix}`, { headers: { authorization, ...headers } });
  const requestRecovery = (headers: Record<string, string> = {}) => app.request(
    `/api/connector/v1/sessions/${encodeURIComponent(key)}/recovery`, { method: 'POST',
      headers: { authorization, 'content-type': 'application/json', ...headers }, body: JSON.stringify({ expectedRunId: 'original-run' }) });
  return { ingress, routes, tokens, local, deck, owner, command, request, requestRecovery, hooks, logs, refreshes: () => refreshes,
    ready(value: boolean) { ready = value; },
    async close() { await ingress.close(); await routes.close(); await events?.close(); original.dispose(); local.close();
      await owner?.closeForShutdown(); rmSync(directory, { recursive: true, force: true }); } };
}

for (const worker of [false, true]) {
  test(`recovery POST preserves protocol, node and owner gates; worker=${worker}`, async () => {
    const fixtureState = await fixture(worker);
    let scheduled = 0;
    fixtureState.hooks.recovery = async (sessionKey, runId) => {
      assert.equal(sessionKey, key);
      assert.equal(runId, 'original-run');
      scheduled++;
      return true;
    };
    try {
      assert.equal((await fixtureState.requestRecovery({ [CONNECTOR_PROTOCOL_HEADER]: 'invalid' })).status, 426);
      assert.equal((await fixtureState.requestRecovery({ [EXPECTED_NODE_HEADER]: 'foreign-node' })).status, 409);
      assert.equal((await fixtureState.requestRecovery({ authorization: 'Bearer invalid' })).status, 403);
      assert.equal(scheduled, 0);
      const response = await fixtureState.requestRecovery();
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { requested: true });
      assert.equal(scheduled, 1);
      assert.equal(fixtureState.refreshes(), 0);
      const principal = await fixtureState.command('codexReadAuthorize', { key, authorization });
      assert.ok(!('error' in principal));
      await fixtureState.command('tokenRevoke', { tokenId: principal.readerId });
      assert.equal((await fixtureState.requestRecovery()).status, 403);
      assert.equal(scheduled, 1);
    } finally { await fixtureState.close(); }
  });
}

for (const persistent of [false, true]) {
  test(`native snapshot through history reader and messages API handles snapshot churn; persistent=${persistent}`, async () => {
    const f = await fixture(false);
    const directory = mkdtempSync(join(tmpdir(), 'codex-history-refresh-api-'));
    const path = join(directory, 'rollout.jsonl');
    writeFileSync(path, '');
    let opens = 0, nativeReads = 0;
    const history = new AsyncCodexHistory({ command: async (kind: any, input: any) => {
      if (kind === 'codexHistoryOpen') opens++;
      const result = await f.command(kind, input);
      if (kind === 'codexHistoryEvidence' && (persistent || opens === 1))
        await f.local.turns.enqueueAsync('codex', { id: `preserved-${opens}`, sessionKey: key,
          createdAt: opens, state: 'queued', payload: { text: `Original pending ${opens}`, images: [] } });
      return result;
    } } as any, new PerformanceDiagnostics(() => {}));
    const codex = new CodexAppServer({ enabled: true, command: 'must-not-launch', defaultCwd: directory,
      defaultModel: 'test', approvalPolicy: 'never', store: f.deck, turnQueue: f.local.turns,
      executions: f.local.codexExecutions, authorizeTurn: () => true, historyReader: history });
    const runtime = codex as any;
    runtime.ensureStarted = async () => {};
    runtime.setConnection('isolated-connection');
    runtime.activeTurnIds.set(key, 'active-turn');
    runtime.request = async (method: string) => {
      if (method === 'thread/goal/get') return { threadId: 'original', goal: null };
      if (method === 'thread/backgroundTerminals/list') return { data: [] };
      assert.equal(method, 'thread/read', 'history GET must never dispatch or resume a native turn');
      nativeReads++;
      return { thread: { id: 'original', path, status: { type: 'active', activeFlags: [] }, turns: [
        { id: 'active-turn', status: 'inProgress', items: [
          { id: 'input', type: 'userMessage', content: [{ type: 'text', text: 'Original native input' }] },
          { id: 'reply', type: 'agentMessage', phase: 'commentary', text: 'Current native reply' },
        ] },
      ] } };
    };
    f.deck.replaceMessages(key, [], { authoritative: true });
    f.deck.upsertSession({ sessionKey: key, agentId: 'codex', title: 'Active native session', status: 'running',
      runtime: { turnId: 'active-turn', phase: 'running', connection: 'connected', sync: 'current', lastEventAt: 1 } });
    f.hooks.refresh = () => codex.refreshSession(key, { readOnly: true, fresh: true });
    try {
      const response = await f.request('/messages?limit=50');
      assert.equal(response.status, persistent ? 503 : 200);
      assert.equal(opens, 2);
      assert.equal(nativeReads, 1, 'a storage conflict must not repeat native requests');
      if (!persistent) {
        const body = await response.json();
        assert.ok(body.messages.some((message: any) => message.text === 'Original native input'));
        assert.ok(body.messages.some((message: any) => message.text === 'Current native reply'));
        assert.ok(body.messages.some((message: any) => message.id === 'preserved-1'));
      } else assert.deepEqual(f.deck.getMessages(key), [], 'invalid snapshots must not publish partial history');
      assert.deepEqual(f.local.turns.list('codex', key).map(row => row.id),
        persistent ? ['preserved-1', 'preserved-2'] : ['preserved-1']);
    } finally { await codex.close(); await history.close(); await f.close(); rmSync(directory, { recursive: true, force: true }); }
  });
}

for (const worker of [false, true]) {
  test(`R20 verified session pagination is isolated from unrelated global churn; worker=${worker}`, async () => {
    const f = await fixture(worker);
    try {
      f.deck.replaceMessages(key, [
        { id: 'older', sessionKey: key, role: 'assistant', text: 'Verified older message', createdAt: 0 },
        ...f.deck.getMessages(key),
      ], { authoritative: true });
      let barriers = 0, checks = 0;
      f.hooks.beforeSnapshot = async () => { barriers++; throw Error('unrelated runtime keeps committing'); };
      f.hooks.display = async () => ({ current: () => true, verify: async () => { checks++; return true; } });
      const response = await f.request('/messages?before=original');
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.deepEqual(body.messages.map((message: any) => message.id), ['older']);
      assert.equal(body.sourceCursor, undefined, 'session proof must not impersonate a Deck-wide event cursor');
      assert.equal(body.historyStatus, 'verified-session', 'only a verified native session proof may acknowledge a session invalidation');
      assert.equal(checks, 1); assert.equal(barriers, 0);
      assert.equal((await f.request('/state')).status, 503);
      assert.equal((await f.request('/messages/original')).status, 503, 'indexed detail still needs its original strict snapshot');
      delete f.hooks.display;
      assert.equal((await f.request('/messages?before=original')).status, 503, 'no proof means no pagination bypass');
    } finally { await f.close(); }
  });

  test(`R20 session proof cannot publish changed rows or bypass final authorization; worker=${worker}`, async () => {
    const f = await fixture(worker);
    try {
      f.hooks.display = async () => ({ current: () => true, verify: async () => {
        f.deck.replaceMessages(key, [{ id: 'replacement', sessionKey: key, role: 'assistant', text: 'Changed', createdAt: 2 }], { authoritative: true });
        return true;
      } });
      assert.equal((await f.request('/messages?before=original')).status, 409, 'even a broken proof adapter cannot certify replaced rows');
      f.hooks.display = async () => ({ current: () => true, verify: async () => {
        f.deck.addMessage({ id: 'replacement', sessionKey: key, role: 'assistant', text: 'Changed in place', createdAt: 2 });
        return true;
      } });
      assert.equal((await f.request('/messages')).status, 409, 'in-place message updates also invalidate the captured page');
      f.hooks.display = async () => ({ current: () => true, verify: async () => true });
      let deliveries = 0;
      f.hooks.beforeDeliver = async () => {
        if (++deliveries !== 2) return;
        const principal = await f.command('codexReadAuthorize', { key, authorization });
        assert.ok(!('error' in principal));
        await f.command('tokenRevoke', { tokenId: principal.readerId });
        delete f.hooks.beforeDeliver;
      };
      assert.equal((await f.request('/messages?before=replacement')).status, 403);
      assert.equal(deliveries, 2, 'authorization is checked again after native verification');
    } finally { await f.close(); }
  });

  test(`Global snapshot contention is isolated from recent display, never from strict reads; worker=${worker}`, async () => {
    const f = await fixture(worker, true);
    try {
      let barriers = 0;
      f.hooks.beforeSnapshot = async () => { barriers++; throw new Error('unrelated runtime projection changed'); };
      const response = await f.request();
      assert.equal(response.status, 200);
      const cached = await response.json();
      assert.equal(cached.historyStatus, 'cached');
      assert.equal(cached.sourceCursor, undefined, 'unverified display cannot invent a causal proof');
      assert.equal(JSON.parse(response.headers.get('x-agentopsdeck-history-meta')!).sourceCursor, null);
      assert.deepEqual(cached.messages.map((m: any) => m.id), ['original']);
      // Include a nonempty older page: rejecting only an empty fallback page
      // would hide an unauthorized pagination bypass behind a 409 response.
      f.deck.replaceMessages(key, [
        { id: 'older', sessionKey: key, role: 'assistant', text: 'Strict older history', createdAt: 0 },
        ...f.deck.getMessages(key),
      ], { authoritative: true });
      assert.equal((await f.request('/state')).status, 503);
      const strict = await f.request('/messages?before=original');
      assert.equal(strict.status, 503);
      assert.deepEqual(await strict.json(), { error: 'Session history unavailable' });
      assert.equal((await f.request('/messages/original')).status, 503);
      f.ready(false);
      const before = barriers;
      assert.equal((await f.request()).status, 200);
      assert.equal(barriers, before, 'fallback must not reenter the broken global barrier');
      f.deck.replaceMessages(key, [], { authoritative: true });
      assert.equal((await f.request('/messages', { [HISTORY_ASYNC_HEADER]: '1' })).status, 202, 'empty memory is not a successful empty history');
      assert.equal((await f.request()).status, 503);
      delete f.hooks.beforeSnapshot; f.ready(true);
      f.deck.addMessage({ id: 'recovered', sessionKey: key, role: 'assistant', text: 'New authoritative reply', createdAt: 2 });
      const restored = await (await f.request()).json();
      assert.equal(restored.historyStatus, undefined);
      assert.ok(restored.sourceCursor);
      assert.deepEqual(restored.messages.map((m: any) => m.id), ['recovered']);
    } finally { await f.close(); }
  });

  test(`Slow global snapshot is bounded, single-flight and drained without publishing a late proof; worker=${worker}`, async () => {
    const f = await fixture(worker, true), held = gate();
    let captures = 0, closed = false;
    f.hooks.beforeSnapshot = async () => { captures++; await held.promise; };
    let closing: Promise<void> | undefined;
    try {
      const response = await f.request();
      assert.equal(response.status, 200);
      const cached = await response.json();
      assert.equal(cached.historyStatus, 'cached'); assert.equal(cached.sourceCursor, undefined);
      assert.equal((await (await f.request()).json()).historyStatus, 'cached');
      assert.equal(captures, 1, 'a timed-out observer cannot create duplicate barriers');
      closing = f.close().then(() => { closed = true; });
      await tick(); assert.equal(closed, false, 'shutdown must own and drain the original snapshot');
      held.release(); await closing;
    } finally { held.release(); if (closing) await closing; else await f.close(); }
  });

  test(`Late verification is bounded, single-flight and drained without claiming synchronized state; worker=${worker}`, async () => {
    const f = await fixture(worker, true), held = gate();
    let checks = 0, captures = 0, closed = false;
    f.hooks.display = async () => { captures++; return { current: () => true, verify: async () => { checks++; await held.promise; return true; } }; };
    let closing: Promise<void> | undefined;
    try {
      const response = await f.request();
      assert.equal(response.status, 200);
      assert.equal((await response.json()).historyStatus, 'cached');
      assert.equal((await (await f.request()).json()).historyStatus, 'cached');
      assert.equal(checks, 1); assert.equal(captures, 1);
      closing = f.close().then(() => { closed = true; });
      await tick(); assert.equal(closed, false);
      held.release(); await closing;
    } finally { held.release(); if (closing) await closing; else await f.close(); }
  });

  test(`Slow display proof cannot block latest cached rows and retains original ownership; worker=${worker}`, async () => {
    const f = await fixture(worker, true), held = gate(), shutdown = gate();
    let captures = 0, closed = false;
    f.hooks.display = async () => {
      captures++; await held.promise;
      return { current: () => true, verify: async () => true };
    };
    let closing: Promise<void> | undefined;
    try {
      const cached = await f.request('/messages', { [HISTORY_ASYNC_HEADER]: '1' });
      assert.equal(cached.status, 200);
      assert.equal((await cached.json()).historyStatus, 'cached');
      const retry = await f.request('/messages', { [HISTORY_ASYNC_HEADER]: '1' });
      assert.equal((await retry.json()).historyStatus, 'cached');
      assert.equal(captures, 1, 'observers join the same physical proof');
      assert.equal(f.refreshes(), 0, 'pending proof does not launch duplicate hydration');
      held.release(); await tick();
      const restored = await f.request('/messages', { [HISTORY_ASYNC_HEADER]: '1' });
      assert.equal(restored.status, 200);
      const verified = await restored.json();
      assert.equal(verified.historyStatus, 'verified-session', 'settled original proof restores session-scoped verified history');
      assert.equal(verified.sourceCursor, undefined, 'session proof is not a global snapshot or execution authority');
      assert.equal(captures, 1, 'completed proof is claimed, not restarted');
      f.hooks.display = async () => { await shutdown.promise; return undefined; };
      assert.equal((await f.request()).status, 200);
      closing = f.close().then(() => { closed = true; });
      await tick(); assert.equal(closed, false, 'shutdown must drain detached proof');
      shutdown.release(); await closing;
    } finally { held.release(); shutdown.release(); if (closing) await closing; else await f.close(); }
  });

  test(`Slow latest hydration is bounded without async negotiation and drains original work; worker=${worker}`, async () => {
    const f = await fixture(worker, true), held = gate();
    let closing: Promise<void> | undefined, closed = false;
    try {
      f.ready(false); f.hooks.refresh = () => held.promise;
      for (let i = 0; i < 3; i++) {
        const response = await f.request();
        assert.equal(response.status, 200);
        const page = await response.json();
        assert.equal(page.historyStatus, 'cached'); assert.equal(page.sourceCursor, undefined);
      }
      assert.equal(f.refreshes(), 1, 'observer deadlines must not duplicate native hydration');
      f.deck.removeMessage(key, 'original');
      assert.equal((await f.request()).status, 503, 'no cache is not a successful empty history');
      assert.equal((await f.request('/messages', { [HISTORY_ASYNC_HEADER]: '1' })).status, 202);
      closing = f.close().then(() => { closed = true; });
      await tick(); assert.equal(closed, false, 'original hydration stays owned until physical completion');
      held.release(); await closing;
    } finally { held.release(); if (closing) await closing; else await f.close(); }
  });

  test(`Recent projection remains readable during verification, without admitting execution; worker=${worker}`, async () => {
    const f = await fixture(worker, true), held = gate();
    try {
      f.ready(false); f.hooks.refresh = () => held.promise;
      const response = await f.request('/messages', { [HISTORY_ASYNC_HEADER]: '1' });
      assert.equal(response.status, 200);
      const page = await response.json() as { historyStatus?: string; messages: { id: string }[]; revision: string };
      assert.equal(page.historyStatus, 'cached'); assert.match(page.revision, /^cached:/);
      assert.deepEqual(page.messages.map(m => m.id), ['original']);
      assert.equal((await f.request('/messages?before=original', { [HISTORY_ASYNC_HEADER]: '1' })).status, 202);
      held.release(); await tick();
      f.hooks.refresh = async () => { throw new Error('provider unavailable'); };
      assert.equal((await f.request()).status, 200);
      assert.equal((await f.request('/messages/original')).status, 503, 'details still require verified history');
      f.hooks.display = async () => { throw new Error('display proof temporarily unavailable'); };
      assert.equal((await f.request()).status, 200);
      delete f.hooks.display;
      f.ready(true); f.hooks.refresh = async () => {};
      assert.equal((await (await f.request()).json() as { historyStatus?: string }).historyStatus, undefined);
      const principal = await f.command('codexReadAuthorize', { key, authorization });
      assert.ok(!('error' in principal));
      f.hooks.beforeDeliver = async () => {
        if (worker) await f.command('tokenRevoke', { tokenId: principal.readerId });
        else f.tokens.revoke(principal.readerId);
      };
      f.ready(false);
      assert.equal((await f.request()).status, 403, 'cached delivery reauthorizes after capture');
    } finally { held.release(); await f.close(); }
  });
  test(`Codex readiness loss inside the original snapshot stays pending and still reauthorizes; worker=${worker}`, async () => {
    const f = await fixture(worker);
    try {
      f.hooks.beforeSnapshot = async () => { f.ready(false); };
      const response = await f.request('/messages', { [HISTORY_ASYNC_HEADER]: '1' });
      assert.equal(response.status, 202);
      assert.equal(response.headers.get('retry-after'), '1');
      assert.equal((await response.json()).messages, undefined);
      f.ready(true);
      assert.equal((await f.request()).status, 503);
      f.ready(true);
      assert.equal((await f.request('/messages/original')).status, 409);
      f.ready(true);
      f.hooks.beforeSnapshot = async () => {
        f.ready(false);
        const principal = await f.command('codexReadAuthorize', { key, authorization });
        assert.ok(!('error' in principal));
        await f.command('tokenRevoke', { tokenId: principal.readerId });
      };
      assert.equal((await f.request('/messages', { [HISTORY_ASYNC_HEADER]: '1' })).status, 403);
    } finally { await f.close(); }
  });

  test(`Codex display proof does not wait for execution recovery or bypass delivery checks; worker=${worker}`, async () => {
    const f = await fixture(worker);
    try {
      f.ready(false);
      let current = true, verified = true, captures = 0, checks = 0;
      f.hooks.display = async () => { captures++; return { current: () => current, verify: async () => { checks++; return verified; } }; };
      assert.equal((await f.request('/messages', { authorization: 'Bearer invalid' })).status, 403);
      assert.equal(captures, 0);
      const page = await f.request('/messages', { [HISTORY_ASYNC_HEADER]: '1' });
      assert.equal(page.status, 200);
      const body = await page.json();
      assert.deepEqual(body.messages.map((message: any) => message.id), ['original']);
      assert.equal(body.historyStatus, 'verified-session'); assert.equal(body.sourceCursor, undefined);
      assert.equal(f.refreshes(), 0);
      assert.equal(checks, 1);
      verified = false;
      assert.equal((await f.request()).status, 409);
      const pending = await f.request('/messages', { [HISTORY_ASYNC_HEADER]: '1' });
      assert.equal(pending.status, 202);
      assert.equal(pending.headers.get('retry-after'), '1');
      assert.equal((await pending.json()).messages, undefined);
      assert.equal(f.refreshes(), 0);
      verified = true;
      f.hooks.display = async () => ({ current: () => current, verify: async () => { current = false; return true; } });
      assert.equal((await f.request('/messages/original')).status, 409);
      current = true;
      f.hooks.display = async () => ({ current: () => true, verify: async () => {
        const principal = await f.command('codexReadAuthorize', { key, authorization });
        assert.ok(!('error' in principal));
        await f.command('tokenRevoke', { tokenId: principal.readerId });
        return false;
      } });
      assert.equal((await f.request('/messages', { [HISTORY_ASYNC_HEADER]: '1' })).status, 403);
    } finally { await f.close(); }
  });

  test(`Codex original router preserves gates, current read authority, wire and no SQL fallback; worker=${worker}`, async t => {
    const f = await fixture(worker);
    try {
      t.mock.method(f.local.commands, 'sessionDeletion', () => assert.fail('no main-thread deletion SQL'));
      t.mock.method(f.local.codexExecutions, 'get', () => assert.fail('no main-thread execution SQL'));
      if (worker) {
        t.mock.method(f.tokens, 'authenticateAuthorization', () => assert.fail('no main-thread authorization'));
        t.mock.method(f.tokens, 'hasScope', () => assert.fail('no main-thread scope check'));
      } else {
        // Local command fixture executes the same worker domain: allow its deletion check only.
        t.mock.restoreAll();
      }
      assert.equal((await f.request('/state', { [CONNECTOR_PROTOCOL_HEADER]: 'invalid' })).status, 426);
      assert.equal((await f.request('/state', { [EXPECTED_NODE_HEADER]: 'foreign-node' })).status, 409);
      assert.equal(f.refreshes(), 0);
      const state = await f.request('/state'); assert.equal(state.status, 200); assert.equal(f.refreshes(), 0);
      const first = await f.request(); assert.equal(first.status, 200); assert.equal(first.headers.get('cache-control'), 'no-store');
      const body = await first.json() as { messages: { id: string }[]; sourceCursor: string };
      assert.deepEqual(body.messages.map(m => m.id), ['original']); assert.ok(body.sourceCursor);
      assert.equal((await f.request('/messages/original')).status, 200);
      assert.equal((await f.request('/messages', { 'if-none-match': first.headers.get('etag')! })).status, 304);
      assert.equal((await f.request('/messages?before=missing')).status, 409);
      assert.equal((await f.request('/state', { authorization: 'Bearer invalid' })).status, 403);
      if (worker) {
        const principal = await f.command('codexReadAuthorize', { key, authorization }); assert.ok(!('error' in principal));
        await f.command('tokenRevoke', { tokenId: principal.readerId });
      } else {
        f.tokens.revoke(f.tokens.authenticateAuthorization(authorization)!.tokenId);
      }
      assert.equal((await f.request('/messages', { 'if-none-match': first.headers.get('etag')! })).status, 403);
      assert.doesNotMatch(f.logs.join('\n'), /isolated-read-router|codex:original|Continuing goal/);
    } finally { t.mock.restoreAll(); await f.close(); }
  });

  test(`Codex ingress owns slow history after 202 and freezes/drains without closing shared DB; worker=${worker}`, async () => {
    const f = await fixture(worker), held = gate(); let drained = false;
    try {
      f.ready(false); f.hooks.refresh = () => held.promise;
      for (let i = 0; i < 3; i++) {
        const response = await f.request('/messages', { [HISTORY_ASYNC_HEADER]: '1' });
        assert.equal(response.status, 202); assert.equal(response.headers.get('retry-after'), '1');
      }
      assert.equal(f.refreshes(), 1);
      f.ingress.freeze(); const draining = f.ingress.drain().then(() => { drained = true; });
      await tick(); assert.equal(drained, false); assert.equal((await f.request('/state')).status, 503);
      held.release(); await draining;
      assert.ok(!('error' in await f.command('codexReadAuthorize', { key, authorization })), 'shared owner stays live until upper close');
    } finally { held.release(); await f.close(); }
  });
}
