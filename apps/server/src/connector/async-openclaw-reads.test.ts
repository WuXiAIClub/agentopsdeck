import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';
import { HISTORY_ASYNC_HEADER, HISTORY_DELTA_HEADER, type ChatMessage } from '@agentopsdeck/shared';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { AsyncConnectorEventProjection } from './async-event-projection.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { ConnectorOwnerUnavailable, createConnectorOwnerCommands, connectorOwnerSteps, validConnectorOwnerInput, validConnectorOwnerOutput } from './connector-owner-domain.js';
import { AsyncCodexReads } from './async-codex-reads.js';
import { registerCodexReadsHttp } from './codex-reads-http.js';
import { AsyncOpenClawReads } from './async-openclaw-reads.js';
import { registerOpenClawReadsHttp } from './openclaw-reads-http.js';
import { DeckStore } from '../projection/deck-store.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { EventSnapshotRead } from '../routes/events.js';
import { bindToolRecord } from '../codex/indexed-tool-output.js';

for (const runtime of ['openclaw', 'codex'] as const) describe(runtime + ' public read chain', () => {
const key = runtime === 'codex' ? 'codex:original' : 'agent:main:dashboard:original', authorization = 'Bearer isolated-runtime-reads';
const foreignKey = runtime === 'codex' ? 'agent:main:other' : 'codex:other';
const authorize = runtime === 'codex' ? 'codexReadAuthorize' : 'openClawReadAuthorize';
const deliver = runtime === 'codex' ? 'codexReadDeliver' : 'openClawReadDeliver';
const executionRead = runtime === 'codex' ? 'codexExecutionRead' : 'openClawExecutionRead';
const Reads = runtime === 'codex' ? AsyncCodexReads : AsyncOpenClawReads;
const registerReads = runtime === 'codex' ? registerCodexReadsHttp : registerOpenClawReadsHttp;
function protect(store: ConnectorUserStore) {
  if (runtime === 'codex') store.codexExecutions.begin(key, 'original-command', 'original-connection');
  else store.openClawExecutions.begin(key, 'original-command');
  (runtime === 'codex' ? store.codexExecutions : store.openClawExecutions).recoverInterrupted();
}
const execution = (store: ConnectorUserStore) => runtime === 'codex' ? store.codexExecutions.get(key) : store.openClawExecutions.get(key);
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
function fixture(options: { timeoutMs?: number; waitMs?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'openclaw-reads-'));
  const tokens = new ConnectorTokenStore(join(root, 'tokens.json'), authorization.slice(7));
  const store = new ConnectorUserStore(':memory:', undefined, { runtimeOwner: true });
  const command = createConnectorOwnerCommands(store, tokens), deck = new DeckStore(), logs: string[] = [];
  const add = (id: string, text: string, role: ChatMessage['role'] = 'assistant') => {
    const message: ChatMessage = { id, text, role, sessionKey: key, createdAt: 1 }; deck.addMessage(message); return message;
  };
  deck.upsertSession({ sessionKey: key, source: runtime, agentId: 'main', title: 'Original', status: 'idle' });
  add('first', 'Original reply'); add('tool', 'Private tool output '.repeat(120), 'tool');
  let ready: unknown = true, refreshes = 0;
  const hooks: { refresh?: (key: string) => Promise<void>; snapshot?: EventSnapshotRead; afterCommand?: (kind: string) => void | Promise<void> } = {};
  const port: Pick<AsyncConnectorOwner, 'command'> = { command: async (kind, input) => {
    const result = await command(kind, input); await hooks.afterCommand?.(kind); return result;
  } };
  const reads = new Reads(port, { projection: deck, snapshot: capture => hooks.snapshot ? hooks.snapshot(capture) : capture('original-cursor'),
    refresh: async (id, readOptions) => { refreshes++; assert.deepEqual(readOptions, { maxAgeMs: 1500, readOnly: true }); await hooks.refresh?.(id); },
    historyReady: () => ready as boolean, timeoutMs: options.timeoutMs ?? 5000, preparationWaitMs: options.waitMs ?? 5,
    diagnostics: new PerformanceDiagnostics(line => logs.push(line)) });
  const app = new Hono(); registerReads(app, '/sessions/:sessionKey', { reads });
  app.get('/sessions/:sessionKey/*', c => c.json({ legacy: true }));
  const request = (suffix = '/messages', headers: Record<string, string> = {}, signal?: AbortSignal, id = key) =>
    app.request(`/sessions/${encodeURIComponent(id)}${suffix}`, { headers: { authorization, ...headers }, ...(signal ? { signal } : {}) });
  return { root, tokens, store, command, port, deck, add, reads, hooks, request, logs, refreshes: () => refreshes,
    ready(value: unknown) { ready = value; },
    async close() { await reads.close(); command.dispose(); store.close(); rmSync(root, { recursive: true, force: true }); } };
}
function deleteSession(store: ConnectorUserStore) {
  const scope = JSON.stringify(['delete', JSON.stringify(['original-actor', key])]);
  store.commands.claim(scope, 'original-delete', {});
  store.commands.settle(scope, 'original-delete', { status: 200, body: { ok: true } });
}

test('OpenClaw original HTTP state, history, detail, anchor, summary, ETag and delta stay compatible', async () => {
  const f = fixture();
  try {
    assert.equal((await f.request('/state')).status, 200); assert.equal(f.refreshes(), 0);
    f.add('stream', 'Still streaming');
    const first = await f.request(); assert.equal(first.status, 200); assert.equal(first.headers.get('cache-control'), 'no-store');
    const body = await first.json() as { messages: ChatMessage[]; sourceCursor: string };
    assert.equal(body.sourceCursor, 'original-cursor'); assert.equal(body.messages.at(-1)?.id, 'stream');
    assert.equal(body.messages.find(m => m.id === 'tool')?.text.length, 1000);
    const detail = await f.request('/messages/tool'); assert.equal(detail.status, 200);
    assert.equal((await detail.json() as { message: ChatMessage }).message.text, f.deck.getMessages(key)[1]!.text);
    const count = f.refreshes();
    const before = await f.request('/messages?before=tool&limit=1'); assert.equal(before.status, 200);
    assert.deepEqual((await before.json() as { messages: ChatMessage[] }).messages.map(m => m.id), ['first']);
    assert.equal(f.refreshes(), count, 'stable ready anchor does not rescan a long native session');
    const missing = await f.request('/messages?before=missing'); assert.equal(missing.status, 409);
    assert.deepEqual(await missing.json(), { error: 'History anchor unavailable; refresh history' });
    assert.equal((await f.request('/messages', { 'if-none-match': first.headers.get('etag')! })).status, 304);
    const baseline = await f.request('/messages', { [HISTORY_DELTA_HEADER]: '1' }); f.add('new', 'New reply');
    const delta = await f.request('/messages', { 'if-none-match': baseline.headers.get('etag')!, [HISTORY_DELTA_HEADER]: '1' });
    assert.equal(delta.status, 200); assert.equal(delta.headers.get(HISTORY_DELTA_HEADER), '1');
    assert.equal((await f.request('/messages?before=')).status, 400);
    assert.equal((await f.request('/messages/missing')).status, 404);
    assert.deepEqual(await (await f.request('/state', {}, undefined, foreignKey)).json(), { legacy: true });
    for (const secret of [authorization, key, 'Private tool output', 'Original reply']) assert.equal(f.logs.join('\n').includes(secret), false);
  } finally { await f.close(); }
});

test('OpenClaw reads preserve original read-only and delegated scope policy, without granting authority from a grant header', async t => {
  const f = fixture();
  try {
    const weak = f.tokens.create({ label: 'no read', scopes: ['sessions:read'] });
    const readOnly = f.tokens.create({ label: 'read only', scopes: ['messages:read'] });
    const delegated = f.tokens.create({ label: 'delegate', scopes: ['messages:read', 'execution:delegate'] });
    for (const header of ['', 'Bearer invalid', `Bearer ${weak.token}`]) {
      const denied = await f.request('/messages?before=', { authorization: header, 'if-none-match': 'anything', 'x-agentopsdeck-execution-grant': 'grant' });
      assert.equal(denied.status, 403); assert.deepEqual(await denied.json(), { error: 'missing messages:read scope' });
    }
    assert.equal(f.refreshes(), 0);
    for (const token of [readOnly, delegated]) assert.equal((await f.request('/state', { authorization: `Bearer ${token.token}`, 'x-agentopsdeck-execution-grant': 'ignored' })).status, 200);
    const original = f.tokens.authenticateAuthorization(authorization)!;
    t.mock.method(f.tokens, 'authenticateAuthorization', () => ({ ...original, tokenId: 'actor_original', scopes: ['messages:read'] }));
    assert.equal((await f.request('/state')).status, 200, 'do not import Hermes owner-only restrictions');
  } finally { await f.close(); }
});

for (const phase of ['hydrate', 'snapshot'] as const) for (const change of ['revoke', 'reader', 'delete'] as const)
  test(`OpenClaw final delivery rechecks ${change} after ${phase}`, async t => {
    const f = fixture();
    try {
      const original = f.tokens.authenticateAuthorization(authorization)!;
      const mutate = () => {
        if (change === 'revoke') f.tokens.revoke(original.tokenId);
        if (change === 'reader') t.mock.method(f.tokens, 'authenticateAuthorization', () => ({ ...original, tokenId: 'replacement-reader' }));
        if (change === 'delete') deleteSession(f.store);
      };
      if (phase === 'hydrate') f.hooks.refresh = async () => { mutate(); };
      else f.hooks.snapshot = capture => { const result = capture('before-change'); mutate(); return result; };
      assert.equal((await f.request()).status, change === 'revoke' ? 403 : change === 'delete' ? 404 : 409);
    } finally { await f.close(); }
  });

test('OpenClaw reads never clear unknown execution and can observe a continuously running long session', async () => {
  const f = fixture();
  try {
    protect(f.store);
    const original = execution(f.store); assert.equal(original?.phase, 'unknown');
    f.deck.upsertSession({ sessionKey: key, source: runtime, agentId: 'main', title: 'Long session', status: 'running' });
    f.hooks.snapshot = capture => { f.add(`continuous-${f.deck.getMessages(key).length}`, 'Goal continues'); return capture('continuous-cursor'); };
    assert.equal((await f.request('/state')).status, 200); assert.equal(f.refreshes(), 0);
    assert.equal((await f.request()).status, 200);
    assert.deepEqual(execution(f.store), original);
  } finally { await f.close(); }
});

test('OpenClaw requires an original causal cursor and rechecks state existence after worker delivery', async () => {
  const f = fixture();
  try {
    f.hooks.snapshot = capture => capture(''); assert.equal((await f.request('/state')).status, 503);
    delete f.hooks.snapshot;
    f.hooks.afterCommand = async kind => { if (kind === deliver) f.deck.removeSession(key); };
    assert.equal((await f.request('/state')).status, 404);
  } finally { await f.close(); }
});

test('OpenClaw async history retains original hydration on 202 and shares retries', async () => {
  const f = fixture(), held = gate();
  try {
    f.ready(false); f.hooks.refresh = async () => held.promise;
    for (let i = 0; i < 3; i++) { const response = await f.request('/messages', { [HISTORY_ASYNC_HEADER]: '1' }); assert.equal(response.status, 202); assert.equal(response.headers.get('retry-after'), '1'); }
    assert.equal(f.refreshes(), 1);
    f.ready(true); held.release(); await tick();
    assert.equal((await f.request('/messages', { [HISTORY_ASYNC_HEADER]: '1' })).status, 200);
    f.ready(1); assert.equal((await f.request()).status, 503);
  } finally { held.release(); await f.close(); }
});

test('OpenClaw physical hydration is bounded and close waits after HTTP has already returned 202', async () => {
  const f = fixture(), held = gate(); let closed = false;
  try {
    f.hooks.refresh = async () => held.promise;
    for (let i = 0; i < 9; i++) {
      const response = await f.request('/messages', { [HISTORY_ASYNC_HEADER]: '1' }, undefined, runtime === 'codex' ? `codex:physical-${i}` : `agent:main:physical-${i}`);
      assert.equal(response.status, i < 8 ? 202 : 503);
    }
    assert.equal(f.refreshes(), 8);
    const closing = f.reads.close().then(() => { closed = true; }); await tick(); assert.equal(closed, false);
    assert.equal((await f.request('/state')).status, 503);
    held.release(); await closing;
    assert.ok(!('error' in await f.command(authorize, { key, authorization })), 'shared owner remains usable');
  } finally { held.release(); await f.close(); }
});

for (const interrupt of ['timeout', 'abort', 'close'] as const)
  test(`OpenClaw ${interrupt} does not publish a late snapshot or discard original physical work`, async () => {
    const f = fixture({ timeoutMs: interrupt === 'timeout' ? 30 : 5000 }), entered = gate(), held = gate(), controller = new AbortController();
    try {
      f.hooks.snapshot = async capture => { entered.release(); await held.promise; return capture('late'); };
      const pending = f.request('/state', {}, controller.signal); await entered.promise;
      let closed = false, closing: Promise<void> | undefined;
      if (interrupt === 'abort') controller.abort();
      if (interrupt === 'close') { closing = f.reads.close().then(() => { closed = true; }); await tick(); assert.equal(closed, false); }
      if (interrupt !== 'close') {
        const response = await pending; assert.equal(response.status, interrupt === 'abort' ? 408 : 503);
        assert.deepEqual(await response.json(), { error: interrupt === 'abort' ? 'Request interrupted' : 'Session state unavailable' });
      }
      held.release(); if (closing) { await closing; assert.equal((await pending).status, 503); }
      assert.equal(f.refreshes(), 0);
    } finally { held.release(); await f.close(); }
  });

test('OpenClaw detail revalidates its original projection after worker delivery', async () => {
  const f = fixture();
  try {
    f.hooks.snapshot = capture => { const result = capture('before-detail-change'); f.deck.replaceMessages(key, [], { authoritative: true }); return result; };
    const response = await f.request('/messages/tool'); assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: 'Tool detail projection changed; retry' });
  } finally { await f.close(); }
});

test('OpenClaw indexed detail keeps full output local and source changes retain original 409 wire', async () => {
  const f = fixture();
  try {
    const file = join(f.root, 'original.jsonl'), output = 'Original full output '.repeat(500);
    const row = JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'original-call', output } });
    writeFileSync(file, row); const info = statSync(file);
    const message: ChatMessage = { id: 'indexed', role: 'tool', text: 'preview', sessionKey: key, createdAt: 2 };
    bindToolRecord(message, file, { preview: 'preview', lines: 1, reference: { offset: 0, bytes: Buffer.byteLength(row),
      digest: createHash('sha256').update(row).digest('hex'), dev: info.dev, ino: info.ino, callId: 'original-call' } }, 'prefix: ');
    f.deck.addMessage(message);
    const detail = await f.request('/messages/indexed'); assert.equal(detail.status, 200);
    assert.ok((await detail.json() as { message: ChatMessage }).message.text.includes(output));
    writeFileSync(file, 'changed');
    const conflict = await f.request('/messages/indexed'); assert.equal(conflict.status, 409);
    assert.deepEqual(await conflict.json(), { error: 'Tool detail source changed; refresh history' });
    assert.equal(f.logs.join('\n').includes(file), false);
  } finally { await f.close(); }
});

test('OpenClaw read command validation is exact, bounded and disallows foreign runtimes', () => {
  assert.equal(new Set(Object.values(connectorOwnerSteps)).size, Object.keys(connectorOwnerSteps).length,
    'each fixed worker command has an unambiguous diagnostic step');
  const input = { key, authorization }, identity = { key, readerId: 'owner' };
  assert.equal(validConnectorOwnerInput(authorize, input), true);
  assert.equal(validConnectorOwnerInput(authorize, { ...input, authorization: '' }), true, 'empty credentials retain original worker 403');
  for (const bad of [{ ...input, key: foreignKey }, { ...input, key: 'hermes:other' }, { ...input, authorization: 'a\n' }, { ...input, extra: true }])
    assert.equal(validConnectorOwnerInput(authorize, bad), false);
  assert.equal(validConnectorOwnerInput(deliver, { ...input, readerId: 'owner' }), true);
  assert.equal(validConnectorOwnerOutput(authorize, identity), true);
  assert.equal(validConnectorOwnerOutput(authorize, { ...identity, extra: true }), false);
});

for (const phase of ['snapshot', 'delivery'] as const) test(`OpenClaw detail keeps original 409 if history is invalidated at ${phase}`, async () => {
  const f = fixture();
  try {
    if (phase === 'snapshot') f.hooks.snapshot = capture => { f.ready(false); return capture('invalidated'); };
    else f.hooks.afterCommand = kind => { if (kind === deliver) {
      // Hydration reauthorization is the first delivery; invalidate at final delivery only.
      if (++deliveries === 2) f.ready(false);
    } };
    let deliveries = 0;
    const response = await f.request('/messages/tool');
    assert.equal(response.status, 409); assert.deepEqual(await response.json(), { error: 'Tool detail projection changed; retry' });
  } finally { await f.close(); }
});

test('OpenClaw real worker, causal event snapshot and HTTP retain read identity across reopen without clearing protection', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openclaw-reads-worker-')), file = join(root, 'connector.sqlite'), tokenFile = join(root, 'tokens.json');
  const seed = new ConnectorUserStore(file, undefined, { runtimeOwner: true });
  protect(seed); seed.close();
  let identity: unknown;
  try {
    for (let i = 0; i < 2; i++) {
      const diagnostics = new PerformanceDiagnostics(() => {});
      const owner = new AsyncConnectorOwner({ file, tokenFile, bootstrapToken: authorization.slice(7) }, diagnostics);
      const events = new AsyncConnectorEventProjection(owner, diagnostics), deck = new DeckStore();
      deck.upsertSession({ sessionKey: key, source: runtime, agentId: 'main', title: 'Original', status: 'running' });
      const refresh = async () => { assert.equal((await owner.command(executionRead, { sessionKey: key }))?.phase, 'unknown'); };
      const reads = new Reads(owner, { projection: deck, snapshot: capture => events.snapshot(capture, refresh),
        refresh: async () => {}, historyReady: () => true, diagnostics });
      const app = new Hono(); registerReads(app, '/sessions/:sessionKey', { reads });
      try {
        await owner.open();
        await refresh();
        const result = await owner.command(authorize, { key, authorization }); assert.ok(!('error' in result));
        if (i === 0) identity = result; else assert.deepEqual(result, identity);
        assert.deepEqual(await owner.command(deliver, { ...result, authorization }), result);
        for (const suffix of ['state', 'messages']) {
          const response = await app.request(`/sessions/${encodeURIComponent(key)}/${suffix}`, { headers: { authorization } });
          const body = await response.json() as { sourceCursor: string };
          assert.equal(response.status, 200, `${runtime} ${suffix}: ${JSON.stringify(body)}`); assert.ok(body.sourceCursor.startsWith('ce1_'));
        }
        assert.deepEqual(await owner.command(authorize, { key, authorization: 'Bearer invalid' }), { error: 403 });
        assert.equal((await owner.command(executionRead, { sessionKey: key }))?.phase, 'unknown');
      } finally { await reads.close(); await events.close(); await owner.close(); }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

class Fake extends EventEmitter {
  messages: { id: number; kind: string; body: string }[] = [];
  postMessage(message: { id: number; kind: string; body: string }) { this.messages.push(message); }
  terminate() { return Promise.resolve(0); }
}
for (const field of ['key', 'readerId'] as const)
  test(`OpenClaw worker rejects foreign ${field} delivery ACK and does not retry`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'openclaw-read-foreign-')), fake = new Fake();
    const owner = new AsyncConnectorOwner({ file: join(root, 'connector.sqlite') }, new PerformanceDiagnostics(() => {}), () => fake as unknown as Worker);
    try {
      fake.emit('message', { kind: 'ready' });
      const input = { key, readerId: 'owner', authorization };
      const pending = owner.command(deliver, input);
      const rejected = assert.rejects(pending, /connector_storage_unavailable/); await tick();
      const sent = fake.messages[0]!;
      fake.emit('message', { id: sent.id, kind: sent.kind, ok: true, body: JSON.stringify({ key, readerId: 'owner', [field]: 'foreign' }) });
      await rejected; assert.equal(fake.messages.length, 1);
      await assert.rejects(owner.command(authorize, { key, authorization }));
    } finally {
      const closing = owner.closeForShutdown(); await tick(); fake.emit('exit', 1); await closing;
      rmSync(root, { recursive: true, force: true });
    }
  });

test('real worker permits only latest cached display when strict snapshot is unavailable, even with a ready older anchor', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openclaw-reads-page-fallback-')), file = join(root, 'connector.sqlite'), tokenFile = join(root, 'tokens.json');
  const seed = new ConnectorUserStore(file, undefined, { runtimeOwner: true });
  protect(seed); seed.close();
  const diagnostics = new PerformanceDiagnostics(() => {});
  const owner = new AsyncConnectorOwner({ file, tokenFile, bootstrapToken: authorization.slice(7) }, diagnostics);
  const deck = new DeckStore();
  deck.upsertSession({ sessionKey: key, source: runtime, agentId: 'main', title: 'Streaming', status: 'running' });
  deck.addMessage({ id: 'm1', sessionKey: key, role: 'user', text: 'first', createdAt: 1 });
  deck.addMessage({ id: 'm2', sessionKey: key, role: 'assistant', text: 'second', createdAt: 2 });
  const reads = new Reads(owner, {
    projection: deck,
    allowRecentProjection: true,
    snapshot: async () => { throw new ConnectorOwnerUnavailable(); },
    refresh: async () => {},
    historyReady: () => true,
    diagnostics,
  });
  const app = new Hono(); registerReads(app, '/sessions/:sessionKey', { reads });
  try {
    await owner.open();
    const original = await owner.command(executionRead, { sessionKey: key });
    assert.equal(original?.phase, 'unknown');
    const request = (suffix: string, credential = authorization) =>
      app.request(`/sessions/${encodeURIComponent(key)}${suffix}`, { headers: { authorization: credential } });
    const response = await request('/messages?limit=1');
    assert.equal(response.status, 200);
    const body = await response.json() as { messages: { id: string }[]; historyStatus?: string; sourceCursor?: string };
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0]?.id, 'm2');
    assert.equal(body.historyStatus, 'cached');
    assert.equal(body.sourceCursor, undefined, 'cached display cannot certify a causal snapshot');
    for (const [suffix, error] of [
      ['/messages?limit=1&before=m2', 'Session history unavailable'],
      ['/messages/m1', 'Tool detail snapshot unavailable'],
      ['/state', 'Session state unavailable'],
    ] as const) {
      const strict = await request(suffix);
      assert.equal(strict.status, 503, suffix);
      assert.deepEqual(await strict.json(), { error });
    }
    assert.equal((await request('/messages?limit=1&before=m2', 'Bearer invalid')).status, 403);
    assert.deepEqual(await owner.command(executionRead, { sessionKey: key }), original,
      'display fallback and failed strict reads must not unlock an unknown execution');
  } finally { await reads.close(); await owner.close(); rmSync(root, { recursive: true, force: true }); }
});

});
