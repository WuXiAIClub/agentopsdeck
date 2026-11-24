import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { serve } from '@hono/node-server';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { loadConfig } from '../config.js';
import { createConnectorRuntime } from './runtime.js';
import { HISTORY_ASYNC_HEADER, historyPendingBody } from '@agentopsdeck/shared';
import { ConnectorClient, HistoryPreparing } from '../hub/connector-client.js';

async function fixture(t: test.TestContext, transport: 'local' | 'http', key = 'agent:main:synthetic') {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-history-connection-')), home = join(directory, 'home');
  mkdirSync(home);
  const previousHome = process.env.HOME; process.env.HOME = home;
  const config = loadConfig({ AOD_SERVER_ROLE: 'connector', AOD_CODEX_ENABLED: String(key.startsWith('codex:')), AOD_LOCAL_OPENCLAW_CLI: 'false',
    AOD_OPENCLAW_GATEWAY_WS_URL: 'ws://unused.invalid', AOD_CONNECTOR_USERS_DATABASE_FILE: join(directory, 'connector.sqlite'),
    AOD_CONNECTOR_TOKENS_FILE: join(directory, 'tokens.json'), AOD_SESSION_TITLES_FILE: join(directory, 'titles.json') });
  const runtime = createConnectorRuntime(config, () => false);
  let connectionId: string | undefined = 'old';
  runtime.gateway.connectionId = () => connectionId;
  runtime.gateway.request = async <T>(method: string, params?: Record<string, unknown>) => (await runtime.gateway.requestWithConnection<T>(method, params)).payload;
  const connect = (id: string | undefined) => { connectionId = id; (runtime.gateway as any).options.onConnectionChange(id); };
  runtime.store.upsertSession({ sessionKey: key, agentId: 'main', title: 'Synthetic', status: 'unknown' });
  runtime.store.addMessage({ sessionKey: key, id: 'known', role: 'assistant', text: 'Known projection', createdAt: 1 });
  const server = transport === 'http' ? serve({ fetch: runtime.app.fetch, hostname: '127.0.0.1', port: 0 }) : undefined;
  if (server && !server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server?.address(), origin = address && typeof address !== 'string' ? `http://127.0.0.1:${address.port}` : '';
  t.after(async () => {
    await runtime.close();
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    rmSync(directory, { recursive: true, force: true });
  });
  const client = new ConnectorClient(origin || 'http://connector', runtime.localToken,
    transport === 'local' ? request => runtime.app.fetch(request) : undefined);
  return { runtime, key, connect, client, request: (detail = false, asynchronous = false) => {
    const route = `/api/connector/v1/sessions/${encodeURIComponent(key)}/messages${detail ? '/known' : ''}`;
    const headers = { authorization: `Bearer ${runtime.localToken}`, ...(asynchronous ? { [HISTORY_ASYNC_HEADER]: '1' } : {}) };
    return transport === 'local' ? runtime.app.request(route, { headers }) : fetch(`${origin}${route}`, { headers });
  } };
}

for (const transport of ['local', 'http'] as const) test(`${transport}: cross-session history budget preserves HTTP preparation, control priority and shutdown drain`, async t => {
  const f = await fixture(t, transport);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const controlKey = 'agent:main:authoritative', readKeys: string[] = [];
  f.runtime.gateway.requestWithConnection = async <T>(_method: string, params?: Record<string, unknown>) => {
    const key = String(params?.sessionKey); readKeys.push(key);
    if (key !== controlKey) await held;
    return { connectionId: 'old', payload: { sessionKey: key, messages: [{ id: 'latest', role: 'assistant', text: 'Verified', createdAt: 1 }] } as T };
  };
  const jobs: Promise<void>[] = [];
  try {
    for (let i = 0; i < 131; i++) {
      const key = `agent:main:display-${i}`;
      f.runtime.store.upsertSession({ sessionKey: key, agentId: 'main', title: 'Synthetic', status: 'unknown' });
      jobs.push(f.runtime.refreshMessages(key, { readOnly: true, maxAgeMs: 1500 }));
    }
    const pending = await f.request(false, true);
    assert.equal(pending.status, 202); assert.deepEqual(await pending.json(), historyPendingBody());
    assert.equal(pending.headers.get('retry-after'), '1');
    // An in-process pressure response can finish before display dispatch's
    // deliberate event-loop yield; wait for that boundary, not a wall timer.
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(readKeys.length, 3);
    assert.equal(f.runtime.inspectHistoryReads().pending, 128);
    assert.equal(f.runtime.inspectHistoryReads().deferred, 1, '132nd distinct display defers without growing the queue');
    assert.equal(f.runtime.store.getMessages(f.key)[0]!.text, 'Known projection');
    f.runtime.store.upsertSession({ sessionKey: controlKey, agentId: 'main', title: 'Synthetic', status: 'unknown' });
    await f.runtime.refreshMessages(controlKey, { fresh: true });
    assert.equal(readKeys.at(-1), controlKey, 'fresh recovery does not wait for unrelated displays');
    assert.equal(f.runtime.store.getMessages(controlKey)[0]!.text, 'Verified');
    let drained = false;
    const draining = f.runtime.stopAdmissions().then(() => { drained = true; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(drained, false);
    await assert.rejects(f.runtime.refreshMessages('agent:main:late'), /closing/);
    release(); await Promise.all([...jobs, draining]);
    assert.equal(readKeys.length, 132, '131 admitted displays plus the independent authoritative read');
    assert.equal(f.runtime.inspectHistoryReads().active, 0); assert.equal(f.runtime.inspectHistoryReads().pending, 0);
  } finally { release(); await Promise.allSettled(jobs); }
});

for (const transport of ['local', 'http'] as const) test(`${transport}: Codex worker handoff returns 202 then 200 without clearing the execution fence`, async t => {
  const f = await fixture(t, transport, 'codex:synthetic');
  const codex = f.runtime.codex as any, executions = f.runtime.connectorUsers.codexExecutions;
  // This case explicitly drives one reconciliation below. Drain and hold the
  // real scheduling lease first; otherwise its startup pass races the manual
  // callback and invalidates the very checkpoint under test. Async page reads
  // deliberately yield, so a fixture may not rely on timer ordering here.
  await codex.pauseQueueWorker().drained;
  codex.ensureStarted = async () => {};
  codex.setConnection('native');
  executions.begin(f.key, 'original', 'native');
  executions.acknowledge(f.key, 'original', 'native', 'tracked', () => {});
  executions.observe(f.key, 'native', 'tracked', 'completed');
  executions.settleHistory(executions.get(f.key)!, 'error');
  f.runtime.store.upsertSession({ sessionKey: f.key, agentId: 'codex', title: 'Synthetic', status: 'unknown',
    runtime: { turnId: 'tracked', phase: 'completed', sync: 'error', connection: 'connected', lastEventAt: 1 } });
  let release!: () => void, entered!: () => void, joined!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const browserJoined = new Promise<void>(resolve => { joined = resolve; });
  let reads = 0;
  codex.request = async (method: string) => {
    if (method === 'thread/goal/get') return {};
    if (method === 'thread/backgroundTerminals/list') return { data: [] };
    assert.equal(method, 'thread/read');
    if (++reads === 1) { entered(); await held; }
    return { thread: { id: 'synthetic', status: { type: 'idle' }, turns: ['tracked', 'successor'].map(id => ({
      id, status: 'completed', itemsView: 'full', items: [{ id: `reply-${id}`, type: 'agentMessage', text: id }],
    })) } };
  };
  const refresh = codex.refreshSession.bind(codex);
  codex.refreshSession = (key: string, options: { readOnly?: boolean }) => {
    const result = refresh(key, options);
    if (options?.readOnly) joined();
    return result;
  };
  const worker = codex.turnWorker.options.reconcile(f.key);
  // Observe rejection at creation, retaining the original rejected promise for
  // assertions below. Waiting for the browser boundary is not error handling.
  void worker.catch(() => {});
  try {
    await started;
    const response = f.request(false, true);
    await browserJoined; release();
    const pending = await response;
    assert.equal(pending.status, 202);
    assert.deepEqual(await pending.json(), historyPendingBody());
    await worker;
    const ready = await f.request(false, true);
    assert.equal(ready.status, 200);
    assert.ok((await ready.json()).messages.some((m: { text: string }) => m.text === 'successor'));
    assert.equal(executions.get(f.key)?.runId, 'tracked');
    assert.equal(executions.get(f.key)?.sync, 'current');
    assert.equal(executions.get(f.key)?.nativeHistory?.reason, 'goal-unknown');
    assert.equal(executions.canStart(f.key), false);
    assert.equal(reads, 3, 'one cold ownership probe, one hydration and one final reconciliation; browser adds no read');
  } finally { release(); await worker; }
});

for (const transport of ['local', 'http'] as const) test(`${transport}: slow read returns preparation, preserves projection and finishes without duplicate native reads`, async t => {
  const f = await fixture(t, transport);
  let release!: () => void, reads = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  f.runtime.gateway.requestWithConnection = async <T>() => {
    reads++; await held;
    return { connectionId: 'old', payload: { sessionKey: f.key, messages: [{ id: 'known', role: 'assistant', text: 'Verified latest', createdAt: 1 }] } as T };
  };
  try {
  const pending = await f.request(false, true);
  assert.equal(pending.status, 202); assert.equal(pending.headers.get('retry-after'), '1');
  assert.deepEqual(await pending.json(), historyPendingBody());
  assert.equal(f.runtime.store.getMessages(f.key)[0]!.text, 'Known projection', 'not replaced with fake empty success');
  assert.equal((await f.request(false, true)).status, 202); assert.equal(reads, 1);
  release();
  const result = await f.request(false, true);
  assert.equal(result.status, 200); assert.equal((await result.json()).messages[0].text, 'Verified latest');
  assert.equal(reads, 1);
  } finally { release(); }
});

test('HTTP history may exceed the Hub 10s deadline without losing the task or returning 503', { timeout: 20_000 }, async t => {
  const f = await fixture(t, 'http');
  let release!: () => void, reads = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  f.runtime.gateway.requestWithConnection = async <T>() => {
    reads++; await held;
    return { connectionId: 'old', payload: { sessionKey: f.key, messages: [{ id: 'known', role: 'assistant', text: 'Verified after 11 seconds', createdAt: 1 }] } as T };
  };
  const timer = setTimeout(release, 11_000), started = performance.now();
  try {
    for (;;) {
      try {
        const result = await f.client.messages(f.key, '200', undefined, undefined, true);
        assert.equal(result.messages[0]!.text, 'Verified after 11 seconds');
        break;
      } catch (error) {
        assert.ok(error instanceof HistoryPreparing, 'only negotiated pending is retried, not deadline failures');
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    assert.ok(performance.now() - started >= 11_000);
    assert.equal(reads, 1, 'HTTP polls must not repeat the native request');
  } finally { clearTimeout(timer); release(); }
});

for (const transport of ['local', 'http'] as const) for (const detail of [false, true]) {
  for (const boundary of ['reply', 'projection', 'cache-commit', 'publication', 'warm-cache'] as const) {
    test(`${transport}: OpenClaw ${detail ? 'detail' : 'history'} refuses connection replacement at ${boundary}`, async t => {
      const f = await fixture(t, transport);
      let invalidate = boundary !== 'warm-cache', reads = 0;
      f.runtime.gateway.requestWithConnection = async <T>(method: string) => {
        assert.equal(method, 'chat.history'); reads++;
        const connectionId = f.runtime.gateway.connectionId()!;
        if (invalidate && boundary === 'warm-cache') throw new Error('Synthetic unavailable replacement');
        if (invalidate && boundary === 'reply') f.connect('new');
        return { connectionId, payload: { sessionKey: f.key, messages: [{ id: 'known', role: 'assistant', createdAt: 1,
          get text() {
            if (invalidate && boundary === 'projection') queueMicrotask(() => f.connect('new'));
            return 'Known projection';
          },
        }] } as T };
      };
      const replace = f.runtime.store.replaceMessages.bind(f.runtime.store);
      f.runtime.store.replaceMessages = (...args) => {
        replace(...args);
        if (invalidate && boundary === 'cache-commit') queueMicrotask(() => f.connect('new'));
      };
      const hasScope = ConnectorTokenStore.prototype.hasScope;
      t.mock.method(ConnectorTokenStore.prototype, 'hasScope', function(this: ConnectorTokenStore, ...args: Parameters<typeof hasScope>) {
        const authorized = hasScope.apply(this, args);
        if (invalidate && boundary === 'publication' && args[1] === 'messages:read') f.connect('new');
        return authorized;
      });
      if (boundary === 'warm-cache') { await f.runtime.refreshMessages(f.key); invalidate = true; f.connect('new'); }
      const result = await f.request(detail);
      assert.equal(result.status, 503);
      assert.equal(result.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await result.json(), { error: 'Session history unavailable' });
      assert.equal(f.runtime.store.getMessages(f.key)[0]?.text, 'Known projection');
      if (boundary === 'warm-cache') assert.equal(reads, 2, 'replacement never uses old connection cache');
      invalidate = false;
      assert.equal((await f.request(detail)).status, 200, 'a subsequent native read restores availability');
      assert.equal(reads, boundary === 'warm-cache' ? 3 : 2, 'same rows still require connection validation');
    });
  }
}

for (const transport of ['local', 'http'] as const) test(`${transport}: OpenClaw replacement keeps one old inflight history until it is rejected`, async t => {
  const f = await fixture(t, transport);
  let release!: () => void, entered!: () => void, reads = 0;
  const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  f.runtime.gateway.requestWithConnection = async <T>(method: string) => {
    assert.equal(method, 'chat.history'); reads++;
    const connectionId = f.runtime.gateway.connectionId()!;
    entered(); await held;
    return { connectionId, payload: { sessionKey: f.key, messages: [] } as T };
  };
  const first = assert.rejects(f.runtime.refreshMessages(f.key), /connection changed/);
  await started; f.connect('new');
  const joined = assert.rejects(f.runtime.refreshMessages(f.key, { maxAgeMs: 60_000 }), /connection changed/);
  assert.equal(reads, 1);
  release(); await Promise.all([first, joined]);
  assert.equal(reads, 1, 'replacement cannot clear inflight and fork a second native read');
  assert.equal((await f.request()).status, 200);
  assert.equal(reads, 2);
});
