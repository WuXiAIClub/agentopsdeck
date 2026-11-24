import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ResearchAuthorization, ResearchWork } from './research-execution.js';
import { WorkspaceResearch } from './workspace-research.js';
import { WorkspaceReader } from './workspace-reader.js';
import { WorkspaceSynthesis } from './workspace-synthesis.js';
import { StandaloneModelCatalog } from './standalone-model-catalog.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const config = { searchUrl: 'https://search.example/search', users: ['alice'] };
const ai = { url: 'https://ai.example/responses', model: 'fixture', token: 'SECRET_MODEL', users: ['alice'] };
const extraction = { url: 'https://extract.example/read', users: ['alice'], sourceOrigins: ['https://article.example'] };
const snapshot = () => ({ searchId: randomUUID(), query: 'PRIVATE_QUERY', fetchedAt: Date.now(),
  sources: [{ id: 'S1', title: 'PRIVATE_TITLE', url: 'https://article.example/one', snippet: 'PRIVATE_SNIPPET' }] });
const searchResponse = () => Response.json({ results: [{ title: 'Title', url: 'https://article.example/one', content: 'Snippet' }] });

test('research authority never accepts a Promise as true, coalesces checks and retains original pending permission on stop', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const originals = new ResearchWork(), controller = new AbortController(), gate = deferred<boolean>();
  let calls = 0;
  const authority = new ResearchAuthorization(() => { calls++; return gate.promise; }, controller, originals);
  const first = authority.check(); assert.ok(first); assert.equal(authority.check(), first);
  const denied = assert.rejects(first, /authorization_changed/);
  authority.watch(); t.mock.timers.tick(250); t.mock.timers.tick(2000); assert.equal(calls, 1);
  authority.stop(); let drained = false; const closing = originals.drain().then(() => { drained = true; });
  await tick(); assert.equal(drained, false); gate.resolve(false); await denied; await closing;
  assert.equal(calls, 1);
});

for (const kind of ['search', 'reader', 'synthesis'] as const) {
  test(`${kind} pending/rejected authority cannot dispatch and close drains original check`, async () => {
    const gate = deferred<boolean>(); let calls = 0;
    const transport: typeof fetch = async () => { calls++; return searchResponse(); };
    const search = new WorkspaceResearch(config, transport), reader = new WorkspaceReader(extraction, transport),
      synthesis = new WorkspaceSynthesis(ai, transport);
    const service = kind === 'search' ? search : kind === 'reader' ? reader : synthesis;
    const data = snapshot(), signal = new AbortController().signal;
    const run = () => kind === 'search' ? search.search('alice', 'q', signal, () => gate.promise)
      : kind === 'reader' ? reader.read('alice', data, 'S1', signal, () => gate.promise)
      : synthesis.synthesize('alice', data, ['S1'], signal, () => gate.promise);
    const result = run(), stopped = assert.rejects(result, /stopped/);
    await tick(); assert.equal(calls, 0);
    let drained = false; const closing = service.close().then(() => { drained = true; });
    await stopped; await tick(); assert.equal(drained, false);
    gate.resolve(true); await closing; assert.equal(calls, 0);
    await Promise.all([search.close(), reader.close(), synthesis.close()]);
  });

  test(`${kind} timeout/cancel cannot refund uncompleted provider admission or conceal it from drain`, async () => {
    const gate = deferred<Response>(), entered = deferred<void>(); let calls = 0;
    const data = snapshot(), caller = new AbortController();
    const transport: typeof fetch = async () => { calls++; entered.resolve(); return gate.promise; };
    const search = new WorkspaceResearch(config, transport), reader = new WorkspaceReader(extraction, transport), synthesis = new WorkspaceSynthesis(ai, transport);
    const service = kind === 'search' ? search : kind === 'reader' ? reader : synthesis;
    const run = () => kind === 'search' ? search.search('alice', 'q', caller.signal, () => true)
      : kind === 'reader' ? reader.read('alice', data, 'S1', caller.signal, () => true)
      : synthesis.synthesize('alice', data, ['S1'], caller.signal, () => true);
    const original = run(), stopped = assert.rejects(original, /stopped/); await entered.promise;
    caller.abort(); await stopped;
    const fresh = new AbortController().signal;
    await assert.rejects(kind === 'search' ? search.search('alice', 'q', fresh, () => true)
      : kind === 'reader' ? reader.read('alice', data, 'S1', fresh, () => true)
      : synthesis.synthesize('alice', data, ['S1'], fresh, () => true), /budget_exceeded/);
    let drained = false; const closing = service.close().then(() => { drained = true; });
    await tick(); assert.equal(drained, false); assert.equal(calls, 1);
    let cancelled = false;
    gate.resolve(new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-type': 'application/json' } }));
    await closing; assert.equal(cancelled, true); assert.equal(calls, 1);
    await Promise.all([search.close(), reader.close(), synthesis.close()]);
  });
}

test('research rejected permission fails closed, while a fresh later explicit request may proceed after original completion', async () => {
  let calls = 0; const service = new WorkspaceResearch(config, async () => { calls++; return searchResponse(); });
  try {
    await assert.rejects(service.search('alice', 'q', new AbortController().signal, () => Promise.reject(Error('private'))), /authorization_changed/);
    await tick(); assert.equal(calls, 0);
    assert.equal((await service.search('alice', 'q', new AbortController().signal, async () => true)).sources.length, 1);
    assert.equal(calls, 1);
  } finally { await service.close(); }
});

test('local snapshot fence after an asynchronous proof cannot itself grant authority or send stale extraction', async () => {
  const data = snapshot(), gate = deferred<boolean>(); let current = true, calls = 0;
  const reader = new WorkspaceReader(extraction, async () => { calls++; return Response.json({}); });
  const authorized = Object.assign(() => gate.promise, { current: () => current });
  try {
    const denied = assert.rejects(reader.read('alice', data, 'S1', new AbortController().signal, authorized), /authorization_changed/);
    current = false; gate.resolve(true); await denied; assert.equal(calls, 0);
  } finally { await reader.close(); }
});

test('catalog timeout retains the original fetch, cannot overlap discovery, and close drains late body cancellation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 1000, calls = 0; const gate = deferred<Response>(), cancel = deferred<void>();
  const catalog = new StandaloneModelCatalog(ai, async () => { calls++; return gate.promise; }, () => now,
    { discoverModels: true, catalogTimeoutMs: 20 });
  const reading = catalog.read(); t.mock.timers.tick(20); await reading;
  now += 10000; await catalog.read(); assert.equal(calls, 1);
  let drained = false; const closing = catalog.close().then(() => { drained = true; }); await tick(); assert.equal(drained, false);
  gate.resolve(new Response(new ReadableStream({ cancel() { return cancel.promise; } }), { headers: { 'content-type': 'application/json' } }));
  await tick(); assert.equal(drained, false); cancel.resolve(); await closing;
  assert.equal(catalog.target().catalogState, 'unavailable'); assert.equal(calls, 1);
});
