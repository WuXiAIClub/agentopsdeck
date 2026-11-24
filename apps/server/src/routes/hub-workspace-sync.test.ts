import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { HubStore } from '../hub/hub-store.js';
import { loadConfig } from '../config.js';
import { registerHubRoutes, encodeHubSessionId } from './hub.js';
import { ConnectorClientError, HistoryPreparing, type ConnectorClientResolver, type MessagesPage } from '../hub/connector-client.js';
import { historyPendingBody } from '@agentopsdeck/shared';
import type { HubPrincipal } from '../hub/identity.js';
import type { WorkspaceSyncFrame } from '@agentopsdeck/shared';
import type { AsyncConnectorClientResolver } from '../hub/async-connector-client.js';

function fixture(t: test.TestContext, calibration = false, asyncMode = false) {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-workspace-sync-'));
  const config = loadConfig({ AOD_HUB_DATABASE_FILE: join(directory, 'hub.sqlite'), AOD_HUB_VAULT_SECRET: 'synthetic' } as NodeJS.ProcessEnv);
  const store = new HubStore(config.hub.databaseFile, config.hub.vaultSecret);
  let actor: HubPrincipal | undefined = { userId: 'default', admin: true };
  let read = async (key: string): Promise<MessagesPage> => ({ messages: [{ id: key, sessionKey: key, role: 'assistant', text: 'hello '.repeat(200), createdAt: 1 }], totalCount: 1, hiddenCount: 0, updatedAt: 1 });
  const calls: string[] = [];
  const client = (() => ({ messages: (key: string) => { calls.push(key); return read(key); } })) as unknown as ConnectorClientResolver;
  let resolver: AsyncConnectorClientResolver = async () => client('test');
  const app = new Hono();
  const hub = registerHubRoutes(app, { config, hubStore: store,
    connectorClient: asyncMode ? () => { throw Error('PRIVATE forbidden synchronous fallback'); } : client,
    ...(asyncMode ? { asyncConnectorClient: ((...args) => resolver(...args)) as AsyncConnectorClientResolver } : {}),
    principal: () => actor, normalizeError: String });
  store.upsertConnection({ id: 'test', kind: 'remote', label: 'Fixture', connectorUrl: 'http://fixture.invalid', status: 'enabled', capabilities: ['messages'] });
  const key = (name: string) => encodeHubSessionId('test', `codex:${name}`);
  const request = (items: unknown[], headers: Record<string, string> = {}, signal?: AbortSignal) => app.request(`/api/hub/v1/workspace/${calibration ? 'check' : 'sync'}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ version: 1, items }), ...(signal ? { signal } : {}),
  });
  const frames = async (items: unknown[]) => { const response = await request(items); assert.equal(response.status, 200); return (await response.text()).trim().split('\n').map(line => JSON.parse(line) as WorkspaceSyncFrame); };
  t.after(async () => { hub?.close(); await store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { app, store, key, request, frames, calls, client, setResolver: (next: AsyncConnectorClientResolver) => { resolver = next; },
    setRead: (next: typeof read) => { read = next; }, setActor: (next: typeof actor) => { actor = next; } };
}

for (const calibration of [false, true]) for (const change of ['none', 'generation', 'identity', 'refusal'] as const)
  test(`workspace ${calibration ? 'check' : 'sync'} async Connector ${change} is fenced before history dispatch`, async t => {
    const f = fixture(t, calibration, true); let release!: () => void, entered!: () => void, resolutions = 0;
    const hold = new Promise<void>(resolve => { release = resolve; }), reached = new Promise<void>(resolve => { entered = resolve; });
    f.setResolver(async (request, id, options) => {
      resolutions++; assert.equal(id, 'test'); assert.equal(options?.expectedUserId, 'default');
      assert.equal(request.method, 'POST'); assert.equal(request.headers.get('x-fixture'), 'original');
      entered(); await hold;
      if (change === 'refusal') throw new ConnectorClientError(503, 'Unavailable');
      return f.client(id);
    });
    const pending = f.request([{ sessionKey: f.key('a'), limit: 200 }], { 'x-fixture': 'original' });
    await reached;
    if (change === 'generation') f.store.upsertConnection({ id: 'test', label: 'Changed', connectorUrl: 'http://changed.invalid' });
    if (change === 'identity') f.setActor({ userId: 'other', admin: false });
    release(); const response = await pending, text = await response.text();
    if (change === 'identity' && response.status === 401) {
      // The outer authority middleware may replace the whole buffered stream.
      assert.deepEqual(JSON.parse(text), { error: 'unauthorized' });
    } else {
      const frame = JSON.parse(text.trim()) as WorkspaceSyncFrame;
      assert.equal(frame.status, change === 'none' ? 200 : change === 'generation' ? 403 : change === 'identity' ? 401 : 503);
    }
    assert.equal(f.calls.length, change === 'none' ? 1 : 0); assert.equal(resolutions, 1);
    assert.doesNotMatch(text, /PRIVATE/);
    if (calibration || change !== 'none') assert.doesNotMatch(text, /hello/);
  });

test('workspace asynchronous refusal is per-item and cannot suppress healthy history', async t => {
  const f = fixture(t, false, true); let resolutions = 0;
  f.setResolver(async () => { if (++resolutions === 1) throw new ConnectorClientError(503, 'Unavailable'); return f.client('test'); });
  const frames = await f.frames(['a', 'b'].map(name => ({ sessionKey: f.key(name), limit: 200 })));
  assert.deepEqual(frames.map(frame => frame.status).sort(), [200, 503]); assert.equal(f.calls.length, 1);
});

test('workspace cancelled authority wait never dispatches a late granted history client', async t => {
  const f = fixture(t, false, true), abort = new AbortController(); let release!: () => void, entered!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; }), reached = new Promise<void>(resolve => { entered = resolve; });
  f.setResolver(async () => { entered(); await hold; return f.client('test'); });
  const pending = f.request([{ sessionKey: f.key('a'), limit: 200 }], {}, abort.signal);
  await reached; abort.abort(); release();
  const response = await pending;
  // Fetch implementations may expose an aborted stream as an error or EOF.
  const text = await response.text().catch(() => ''); assert.doesNotMatch(text, /hello/);
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(f.calls.length, 0);
});

test('calibration batches only validators, detects changes without leaking history, and shares standard etags', async t => {
  const f = fixture(t, true), items = Array.from({ length: 6 }, (_, i) => ({ sessionKey: f.key(String(i)), limit: 200 }));
  const initial = await f.frames(items);
  for (const frame of initial) {
    assert.deepEqual(frame.body, { changed: true });
    const direct = await f.app.request(`/api/hub/v1/sessions/${encodeURIComponent(frame.sessionKey)}/messages?limit=200`);
    assert.equal(direct.headers.get('etag'), frame.headers!.etag);
  }
  const conditional = initial.map(frame => ({ sessionKey: frame.sessionKey, limit: 200, etag: frame.headers!.etag }));
  const unchanged = await f.frames(conditional);
  assert.ok(unchanged.every(frame => frame.status === 304 && !frame.body));
  f.setRead(async key => ({ messages: [{ id: key, sessionKey: key, role: 'assistant', text: 'changed private history', createdAt: 1 }], totalCount: 1, hiddenCount: 0, updatedAt: 2, sourceCursor: 'next-cursor' }));
  const changed = await f.frames(conditional);
  assert.ok(changed.every(frame => frame.status === 200 && JSON.stringify(frame.body) === '{"changed":true}'));
  assert.ok(changed.every(frame => frame.headers!['x-agentopsdeck-history-check'] === 'changed'));
  assert.ok(!JSON.stringify(changed).includes('changed private history'));
  assert.ok(changed.every(frame => JSON.parse(frame.headers!['x-agentopsdeck-history-meta']!).sourceCursor === 'next-cursor'));
});

test('calibration retains per-item preparation/failure, ownership and request validation', async t => {
  const f = fixture(t, true);
  f.setRead(async key => {
    if (key === 'codex:pending') throw new HistoryPreparing();
    if (key === 'codex:failed') throw new ConnectorClientError(503, 'Unavailable');
    return { messages: [], totalCount: 0, hiddenCount: 0, updatedAt: 1 };
  });
  const frames = await f.frames(['pending', 'failed', 'healthy'].map(name => ({ sessionKey: f.key(name), limit: 200 })));
  assert.equal(frames.find(frame => frame.sessionKey === f.key('pending'))!.status, 202);
  assert.equal(frames.find(frame => frame.sessionKey === f.key('failed'))!.status, 503);
  assert.equal(frames.find(frame => frame.sessionKey === f.key('healthy'))!.status, 200);
  assert.equal((await f.request([])).status, 400);
  assert.equal((await f.request([{ sessionKey: f.key('one'), limit: 200 }], { 'x-agentopsdeck-recovery-scope': 'wrong' })).status, 409);
  assert.equal((await f.frames([{ sessionKey: encodeHubSessionId('foreign', 'codex:one'), limit: 200 }]))[0]!.status, 404);
  f.setActor(undefined);
  assert.equal((await f.request([{ sessionKey: f.key('one'), limit: 200 }])).status, 401);
});

test('calibration cannot disclose validators after connection revocation during a read', async t => {
  const f = fixture(t, true);
  let release!: () => void, started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  f.setRead(async () => { started(); await held; return { messages: [], totalCount: 0, hiddenCount: 0, updatedAt: 1 }; });
  const pending = f.frames([{ sessionKey: f.key('one'), limit: 200 }]);
  await ready;
  f.store.upsertConnection({ id: 'test', kind: 'remote', label: 'Fixture', connectorUrl: 'http://fixture.invalid', status: 'disabled', capabilities: ['messages'] });
  release(); const [frame] = await pending;
  assert.equal(frame!.status, 403); assert.equal(frame!.headers, undefined);
});

test('preparing history is explicit in standard and batch routes; healthy peers continue normally', async t => {
  const f = fixture(t);
  f.setRead(async key => {
    if (key === 'codex:slow') throw new HistoryPreparing();
    return { messages: [], totalCount: 0, hiddenCount: 0, updatedAt: 1 };
  });
  const frames = await f.frames(['slow', 'fast', 'fast2', 'fast3', 'fast4', 'fast5'].map(name => ({ sessionKey: f.key(name), limit: 200 })));
  assert.equal(frames.find(frame => frame.sessionKey === f.key('slow'))?.status, 202);
  assert.deepEqual(frames.find(frame => frame.sessionKey === f.key('slow'))?.body, historyPendingBody());
  assert.equal(frames.find(frame => frame.sessionKey === f.key('fast'))?.status, 200);
  assert.equal(frames.filter(frame => frame.status === 200).length, 5);
  const direct = await f.app.request(`/api/hub/v1/sessions/${encodeURIComponent(f.key('slow'))}/messages?limit=200`);
  assert.equal(direct.status, 202); assert.equal(direct.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await direct.json(), historyPendingBody());
});

test('six-session batch uses real Hub authentication and wraps histories; conditional reuse stays fresh', async t => {
  const f = fixture(t), items = Array.from({ length: 6 }, (_, i) => ({ sessionKey: f.key(String(i)), limit: 200 }));
  const result = await f.frames(items);
  assert.equal(result.length, 6); assert.equal(f.calls.length, 6);
  for (const frame of result) { assert.equal(frame.status, 200); assert.equal((frame.body as any).messages[0].sessionKey, frame.sessionKey); assert.ok(frame.headers?.etag); }
  const next = await f.frames(result.map(frame => ({ sessionKey: frame.sessionKey, limit: 200, etag: frame.headers!.etag })));
  assert.ok(next.every(frame => frame.status === 304 && frame.body === undefined));
  assert.equal(f.calls.length, 12, '304 never bypasses fresh upstream authorization/read');
  const direct = await f.app.request(`/api/hub/v1/sessions/${encodeURIComponent(items[0]!.sessionKey)}/messages?limit=200`);
  assert.deepEqual(await direct.json(), result[0]!.body, 'switching transport preserves the exact legacy projection');
  assert.equal(direct.headers.get('etag'), result[0]!.headers!.etag);
  f.setActor(undefined); assert.equal((await f.request(items)).status, 401);
});

test('invalid requests, foreign ownership and recovery scope fail closed', async t => {
  const f = fixture(t), item = { sessionKey: f.key('one'), limit: 200 };
  for (const items of [[], [item, item], Array(9).fill(item), [{ ...item, limit: 501 }], [{ ...item, etag: 'bad' }]]) assert.equal((await f.request(items)).status, 400);
  assert.equal((await f.request([item], { 'x-agentopsdeck-recovery-scope': 'wrong' })).status, 409);
  const denied = await f.frames([{ sessionKey: encodeHubSessionId('not-owned', 'codex:one'), limit: 200 }]);
  assert.equal(denied[0]!.status, 404); assert.equal(f.calls.length, 0);
});

test('slow and 503 sessions do not hold a healthy frame; real failure stays per-item', async t => {
  const f = fixture(t);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  f.setRead(async key => {
    if (key === 'codex:slow') await held;
    if (key === 'codex:failed') throw new ConnectorClientError(503, 'Connector request failed: HTTP 503');
    return { messages: [], totalCount: 0, hiddenCount: 0, updatedAt: 1 };
  });
  const response = await f.request(['slow', 'fast', 'failed'].map(name => ({ sessionKey: f.key(name), limit: 200 })));
  const reader = response.body!.getReader();
  const first = JSON.parse(new TextDecoder().decode((await reader.read()).value));
  assert.equal(first.sessionKey, f.key('fast')); assert.equal(first.status, 200);
  release(); let text = '';
  for (;;) { const chunk = await reader.read(); if (chunk.done) break; text += new TextDecoder().decode(chunk.value); }
  const rest = text.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(rest.find(frame => frame.sessionKey === f.key('failed')).status, 503);
});

test('connection revocation while history is pending cannot disclose the buffered page', async t => {
  const f = fixture(t);
  let release!: () => void, started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  f.setRead(async () => { started(); await held; return { messages: [], totalCount: 0, hiddenCount: 0, updatedAt: 1 }; });
  const pending = f.frames([{ sessionKey: f.key('one'), limit: 200 }]);
  await ready;
  f.store.upsertConnection({ id: 'test', kind: 'remote', label: 'Fixture', connectorUrl: 'http://fixture.invalid', status: 'disabled', capabilities: ['messages'] });
  release(); const frames = await pending;
  assert.equal(frames[0]!.status, 403); assert.equal((frames[0]!.body as any).messages, undefined);
});

test('login revocation during streamed read is checked again before delivery', async t => {
  const f = fixture(t);
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  f.setRead(async () => { await hold; return { messages: [], totalCount: 0, hiddenCount: 0, updatedAt: 1 }; });
  const response = await f.request([{ sessionKey: f.key('one'), limit: 200 }]);
  f.setActor(undefined); release();
  const frame = JSON.parse((await response.text()).trim());
  assert.equal(frame.status, 401); assert.equal(frame.body.messages, undefined);
});
