import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';
import { HISTORY_ASYNC_HEADER, HISTORY_DELTA_HEADER, type ChatMessage } from '@agentopsdeck/shared';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { createConnectorOwnerCommands, validConnectorOwnerInput, validConnectorOwnerOutput } from './connector-owner-domain.js';
import { AsyncHermesReads } from './async-hermes-reads.js';
import { registerHermesReadsHttp } from './hermes-reads-http.js';
import { DeckStore } from '../projection/deck-store.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { EventSnapshotRead } from '../routes/events.js';
import { hermesSessionView } from '../hermes/session-view.js';

const key = 'hermes:original', authorization = 'Bearer isolated-hermes-reads';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
function fixture(options: { timeoutMs?: number; waitMs?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hermes-reads-'));
  const tokens = new ConnectorTokenStore(join(root, 'tokens.json'), authorization.slice(7));
  const store = new ConnectorUserStore(':memory:', undefined, { runtimeOwner: true });
  const session = { key, stored: 'stored', title: 'Original', started: false, messages: [] };
  store.hermesJournal.save(session);
  const command = createConnectorOwnerCommands(store, tokens), deck = new DeckStore(), logs: string[] = [];
  const add = (id: string, text: string, role: ChatMessage['role'] = 'assistant') => {
    const message: ChatMessage = { id, text, role, sessionKey: key, createdAt: 1 }; deck.addMessage(message); return message;
  };
  deck.upsertSession(hermesSessionView(key, 'Original', undefined, true));
  add('first', 'Original reply'); add('tool', 'Private tool output '.repeat(120), 'tool');
  let ready: unknown = true, refreshes = 0;
  const hooks: { refresh?: (key: string) => Promise<void>; snapshot?: EventSnapshotRead; afterCommand?: (kind: string) => void | Promise<void> } = {};
  const port: Pick<AsyncConnectorOwner, 'command'> = { command: async (kind, input) => {
    const result = await command(kind, input); await hooks.afterCommand?.(kind); return result;
  } };
  const reads = new AsyncHermesReads(port, { projection: deck, snapshot: capture => hooks.snapshot ? hooks.snapshot(capture) : capture('original-cursor'),
    refresh: async (id, readOptions) => { refreshes++; assert.deepEqual(readOptions, { maxAgeMs: 1500, readOnly: true }); await hooks.refresh?.(id); },
    historyReady: () => ready as boolean, timeoutMs: options.timeoutMs ?? 5000, preparationWaitMs: options.waitMs ?? 5,
    diagnostics: new PerformanceDiagnostics(line => logs.push(line)) });
  const app = new Hono(); registerHermesReadsHttp(app, '/sessions/:sessionKey', { reads });
  app.get('/sessions/:sessionKey/*', c => c.json({ legacy: true }));
  const request = (suffix = '/messages', headers: Record<string, string> = {}, signal?: AbortSignal, id = key) =>
    app.request(`/sessions/${id}${suffix}`, { headers: { authorization, ...headers }, ...(signal ? { signal } : {}) });
  return { root, tokens, store, session, command, port, deck, add, reads, hooks, request, logs, refreshes: () => refreshes,
    ready(value: unknown) { ready = value; },
    async close() { await reads.close(); command.dispose(); store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('Hermes read HTTP preserves state, streaming projection, summary/detail, anchor, ETag and delta without legacy fallback', async () => {
  const f = fixture();
  try {
    assert.equal((await f.request('/state')).status, 200); assert.equal(f.refreshes(), 0);
    const stream = f.add('stream', 'Still streaming');
    const first = await f.request(); assert.equal(first.status, 200);
    const body = await first.json() as { messages: ChatMessage[]; sourceCursor: string };
    assert.equal(body.sourceCursor, 'original-cursor'); assert.equal(body.messages.at(-1)?.id, stream.id);
    assert.equal(body.messages.find(m => m.id === 'tool')?.text.length, 1000);
    const detail = await f.request('/messages/tool'); assert.equal(detail.status, 200);
    assert.equal((await detail.json() as { message: ChatMessage }).message.text, f.deck.getMessages(key)[1]!.text);
    const count = f.refreshes();
    const before = await f.request('/messages?before=tool&limit=1'); assert.equal(before.status, 200);
    assert.deepEqual((await before.json() as { messages: ChatMessage[] }).messages.map(m => m.id), ['first']);
    assert.equal(f.refreshes(), count, 'ready stable anchor needs no native hydration');
    assert.equal((await f.request('/messages?before=missing')).status, 409);
    const etag = first.headers.get('etag')!;
    assert.equal((await f.request('/messages', { 'if-none-match': etag })).status, 304);
    const baseline = await f.request('/messages', { [HISTORY_DELTA_HEADER]: '1' });
    f.add('new', 'New reply');
    const delta = await f.request('/messages', { 'if-none-match': baseline.headers.get('etag')!, [HISTORY_DELTA_HEADER]: '1' });
    assert.equal(delta.status, 200); assert.equal(delta.headers.get(HISTORY_DELTA_HEADER), '1');
    assert.equal((await f.request('/messages?before=')).status, 400);
    assert.equal((await f.request('/messages/missing')).status, 404);
    assert.deepEqual(await (await f.request('/messages', {}, undefined, 'codex:other')).json(), { legacy: true });
    for (const secret of [authorization, key, 'Private tool output', 'Original reply']) assert.equal(f.logs.join('\n').includes(secret), false);
  } finally { await f.close(); }
});

test('Hermes HTTP rejects missing, scope-only and delegated evidence, even conditional requests', async () => {
  const f = fixture();
  try {
    const weak = f.tokens.create({ label: 'no read', scopes: ['sessions:read'] });
    const delegated = f.tokens.create({ label: 'delegate', scopes: ['messages:read', 'execution:delegate'] });
    for (const [header, status] of [['', 401], ['Bearer invalid', 401], [`Bearer ${weak.token}`, 403], [`Bearer ${delegated.token}`, 403]] as const)
      assert.equal((await f.request('/messages', { authorization: header, 'if-none-match': 'anything' })).status, status);
    assert.equal((await f.request('/state', { 'x-agentopsdeck-execution-grant': 'grant' })).status, 403);
    assert.equal(f.refreshes(), 0);
  } finally { await f.close(); }
});

for (const change of ['revoke', 'reader', 'stored', 'aba', 'delete', 'unknown'] as const)
  test(`Hermes final delivery rechecks ${change} after causal snapshot and never releases execution protection`, async t => {
    const f = fixture();
    try {
      const original = f.tokens.authenticateAuthorization(authorization)!;
      f.hooks.snapshot = capture => {
        const body = capture('snapshot-before-change');
        if (change === 'revoke') f.tokens.revoke(original.tokenId);
        if (change === 'reader') t.mock.method(f.tokens, 'authenticateAuthorization', () => ({ ...original, tokenId: 'replacement-reader' }));
        if (change === 'stored') f.store.hermesJournal.save({ ...f.session, stored: 'replacement' });
        if (change === 'aba') { f.store.hermesJournal.save({ ...f.session, title: 'Intermediate' }); f.store.hermesJournal.save(f.session); }
        if (change === 'delete') f.store.hermesJournal.beginDeletion(key);
        if (change === 'unknown') f.store.hermesJournal.update({ key, id: 'unknown-original', epoch: 'epoch', live: 'live',
          members: ['input'], at: 1, updated: 1, phase: 'unknown' });
        return body;
      };
      assert.equal((await f.request()).status, change === 'revoke' ? 401 : change === 'delete' ? 404 : 409);
      if (change === 'unknown') assert.equal(f.store.hermesJournal.current(key)?.phase, 'unknown');
    } finally { await f.close(); }
  });

test('Hermes current reader and native identity cannot change during hydration; legitimate digest advancement is rebound', async () => {
  const f = fixture();
  try {
    f.hooks.refresh = async () => { f.store.hermesJournal.save({ ...f.session, title: 'Native history advanced' }); };
    assert.equal((await f.request()).status, 200);
    f.hooks.refresh = async () => { f.store.hermesJournal.save({ ...f.session, stored: 'different' }); };
    assert.equal((await f.request()).status, 409);
  } finally { await f.close(); }
});

test('Hermes hydration cannot substitute the original authorized reader', async t => {
  const f = fixture();
  try {
    const authenticate = f.tokens.authenticateAuthorization.bind(f.tokens);
    f.hooks.refresh = async () => {
      t.mock.method(f.tokens, 'authenticateAuthorization', (value: string) => {
        const actor = authenticate(value); return actor ? { ...actor, tokenId: 'replacement-reader' } : actor;
      });
    };
    assert.equal((await f.request()).status, 409);
  } finally { await f.close(); }
});

test('Hermes unknown execution remains observable without hydration, replay or unlocking', async () => {
  const f = fixture();
  try {
    const execution = { key, id: 'original-unknown', epoch: 'epoch', live: 'live', members: ['input'],
      at: 1, updated: 1, phase: 'unknown' as const };
    f.store.hermesJournal.update(execution);
    f.deck.upsertSession(hermesSessionView(key, 'Original', execution, false));
    const identity = f.store.hermesJournal.readIdentity(key);
    const result = await f.request('/state'); assert.equal(result.status, 200);
    assert.equal((await result.json() as { runtime: { phase: string } }).runtime.phase, 'unknown');
    assert.equal(f.refreshes(), 0);
    assert.deepEqual(f.store.hermesJournal.readIdentity(key), identity);
    assert.equal(f.store.hermesJournal.current(key)?.phase, 'unknown');
  } finally { await f.close(); }
});

test('Hermes public reads require an original causal cursor and existing projection', async () => {
  const f = fixture();
  try {
    f.hooks.snapshot = capture => capture('');
    assert.equal((await f.request('/state')).status, 503);
    delete f.hooks.snapshot;
    f.deck.removeSession(key);
    assert.equal((await f.request('/state')).status, 404);
    assert.equal((await f.request()).status, 409);
  } finally { await f.close(); }
});

test('Hermes async history retains original hydration on 202, shares retries and requires strict ready', async () => {
  const f = fixture(), held = gate();
  try {
    f.ready(false); f.hooks.refresh = async () => held.promise;
    for (let i = 0; i < 3; i++) assert.equal((await f.request('/messages', { [HISTORY_ASYNC_HEADER]: '1' })).status, 202);
    assert.equal(f.refreshes(), 1);
    f.ready(true); held.release(); await tick();
    assert.equal((await f.request('/messages', { [HISTORY_ASYNC_HEADER]: '1' })).status, 200);
    f.ready(1); assert.equal((await f.request()).status, 503);
  } finally { held.release(); await f.close(); }
});

test('Hermes 202 hydration occupies bounded physical slots until actual settlement, including close', async () => {
  const f = fixture(), held = gate(); let closed = false;
  try {
    f.hooks.refresh = async () => held.promise;
    for (let i = 0; i < 9; i++) {
      const id = `hermes:physical-${i}`;
      f.store.hermesJournal.save({ ...f.session, key: id });
      f.deck.upsertSession(hermesSessionView(id, 'Physical', undefined, true));
      const result = await f.request('/messages', { [HISTORY_ASYNC_HEADER]: '1' }, undefined, id);
      assert.equal(result.status, i < 8 ? 202 : 503);
    }
    assert.equal(f.refreshes(), 8);
    const close = f.reads.close().then(() => { closed = true; }); await tick(); assert.equal(closed, false);
    assert.equal((await f.request('/state')).status, 503);
    held.release(); await close; assert.equal(closed, true);
    const authorized = await f.command('hermesReadAuthorize', { key, authorization });
    assert.ok(!('error' in authorized)); assert.equal(authorized.key, key, 'shared owner stays open');
  } finally { held.release(); await f.close(); }
});

for (const interrupt of ['timeout', 'abort', 'close'] as const)
  test(`Hermes ${interrupt} never publishes a late snapshot or retires its original physical work`, async () => {
    const f = fixture({ timeoutMs: interrupt === 'timeout' ? 15 : 5000 }), entered = gate(), held = gate(), controller = new AbortController();
    try {
      f.hooks.snapshot = async capture => { entered.release(); await held.promise; return capture('late'); };
      const pending = f.request('/state', {}, controller.signal); await entered.promise;
      let closed = false, close: Promise<void> | undefined;
      if (interrupt === 'abort') controller.abort();
      if (interrupt === 'close') { close = f.reads.close().then(() => { closed = true; }); await tick(); assert.equal(closed, false); }
      if (interrupt !== 'close') assert.equal((await pending).status, interrupt === 'abort' ? 408 : 503);
      held.release();
      if (close) { await close; assert.equal((await pending).status, 503); }
      assert.equal(f.refreshes(), 0);
    } finally { held.release(); await f.close(); }
  });

test('Hermes detail changed during worker delivery does not publish a stale indexed body', async () => {
  const f = fixture();
  try {
    f.hooks.afterCommand = async kind => { if (kind === 'hermesReadDeliver') f.deck.replaceMessages(key, [], { authoritative: true }); };
    assert.equal((await f.request('/messages/tool')).status, 409);
  } finally { await f.close(); }
});

test('Hermes fixed read commands validate shape, key, digest and evidence boundaries', () => {
  const input = { key, authorization }, identity = { key, readerId: 'owner', stored: 'stored', digest: 'a'.repeat(64) };
  assert.equal(validConnectorOwnerInput('hermesReadAuthorize', input), true);
  for (const bad of [{ ...input, key: 'codex:other' }, { ...input, authorization: 'a\n' }, { ...input, extra: true }])
    assert.equal(validConnectorOwnerInput('hermesReadAuthorize', bad), false);
  assert.equal(validConnectorOwnerInput('hermesReadDeliver', { ...identity, authorization }), true);
  assert.equal(validConnectorOwnerInput('hermesReadDeliver', { ...identity, authorization, digest: 'bad' }), false);
  assert.equal(validConnectorOwnerOutput('hermesReadAuthorize', identity), true);
  assert.equal(validConnectorOwnerOutput('hermesReadAuthorize', { ...identity, extra: true }), false);
});

test('Hermes original worker enforces authorization and persistent identity across owner reopen without loading transcript', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hermes-reads-worker-')), file = join(root, 'connector.sqlite'), tokenFile = join(root, 'tokens.json');
  const seed = new ConnectorUserStore(file, undefined, { runtimeOwner: true });
  seed.hermesJournal.save({ key, stored: 'persisted', title: 'Original', started: false, messages: [] }); seed.close();
  let identity: unknown;
  try {
    for (let i = 0; i < 2; i++) {
      const owner = new AsyncConnectorOwner({ file, tokenFile, bootstrapToken: authorization.slice(7) }, new PerformanceDiagnostics(() => {}));
      try {
        await owner.open(); const result = await owner.command('hermesReadAuthorize', { key, authorization });
        assert.ok(!('error' in result)); assert.equal(result.stored, 'persisted');
        if (i === 0) identity = result; else assert.deepEqual(result, identity);
        assert.deepEqual(await owner.command('hermesReadDeliver', { ...result, authorization }), result);
        assert.deepEqual(await owner.command('hermesReadAuthorize', { key, authorization: 'Bearer invalid' }), { error: 401 });
      } finally { await owner.close(); }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

class Fake extends EventEmitter {
  messages: { id: number; kind: string; body: string }[] = [];
  postMessage(message: { id: number; kind: string; body: string }) { this.messages.push(message); }
  terminate() { return Promise.resolve(0); }
}
for (const field of ['key', 'readerId', 'stored', 'digest'] as const)
  test(`Hermes worker rejects foreign ${field} delivery ACK and retires without retry`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'hermes-read-foreign-')), fake = new Fake();
    const owner = new AsyncConnectorOwner({ file: join(root, 'connector.sqlite') }, new PerformanceDiagnostics(() => {}), () => fake as unknown as Worker);
    try {
      fake.emit('message', { kind: 'ready' });
      const identity = { key, readerId: 'owner', stored: 'stored', digest: 'a'.repeat(64) };
      const pending = owner.command('hermesReadDeliver', { ...identity, authorization });
      const rejected = assert.rejects(pending, /connector_storage_unavailable/); await tick();
      const sent = fake.messages[0]!;
      fake.emit('message', { id: sent.id, kind: sent.kind, ok: true, body: JSON.stringify({ ...identity,
        [field]: field === 'key' ? 'hermes:foreign' : field === 'digest' ? 'b'.repeat(64) : 'foreign' }) });
      await rejected; assert.equal(fake.messages.length, 1);
      await assert.rejects(owner.command('hermesReadAuthorize', { key, authorization }));
    } finally {
      const closing = owner.closeForShutdown(); await tick(); fake.emit('exit', 1); await closing;
      rmSync(root, { recursive: true, force: true });
    }
  });
