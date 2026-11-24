import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkspaceSyncTransport } from './workspace-sync-transport.js';
import { setWorkspaceSyncScope, setWorkspaceSyncEnabled, workspaceSyncPreference, markWorkspaceSyncUnavailable } from './workspace-sync-preference.js';

const pause = () => new Promise<void>(resolve => setTimeout(resolve, 5));
const item = (sessionKey: string) => ({ sessionKey, limit: 200 });
function context(signal = new AbortController().signal, legacy = async () => Response.json({ legacy: true })) {
  return { group: 'owner', url: '/api/hub/v1/workspace/sync', headers: { 'x-agentopsdeck-recovery-scope': 'owner' }, signal, legacy };
}
function stream() {
  let writer!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(controller) { writer = controller; } });
  return { response: new Response(body, { headers: { 'content-type': 'application/x-ndjson', 'x-agentopsdeck-workspace-sync': '1' } }),
    frame: (value: unknown) => writer.enqueue(new TextEncoder().encode(JSON.stringify(value) + '\n')), close: () => writer.close(),
    raw: (text: string) => writer.enqueue(new TextEncoder().encode(text)) };
}

test('aborted streams with stuck cleanup release batch capacity for the next read', async t => {
  let calls = 0;
  const transport = createWorkspaceSyncTransport({ enabled: () => true, unsupported() {}, collectMs: 0, intervalMs: 0, maxBatches: 1,
    fetch: async () => {
      calls++;
      if (calls === 1) return new Response(new ReadableStream({ cancel: () => new Promise(() => {}) }),
        { headers: { 'content-type': 'application/x-ndjson', 'x-agentopsdeck-workspace-sync': '1' } });
      return new Response(JSON.stringify({ sessionKey: 'next', status: 304 }) + '\n',
        { headers: { 'content-type': 'application/x-ndjson', 'x-agentopsdeck-workspace-sync': '1' } });
    } });
  t.after(() => transport.reset());
  const controller = new AbortController();
  const old = assert.rejects(transport.read(item('old'), context(controller.signal)), /cancelled/);
  await pause(); controller.abort(); await old;
  const next = transport.read(item('next'), context());
  void next.catch(() => {});
  await pause(); await pause();
  assert.equal(calls, 2, 'a cancelled body must not keep a scheduler slot');
  assert.equal((await next).status, 304);
});

test('all frames complete without waiting for a proxy to close the HTTP body', async t => {
  let calls = 0;
  const transport = createWorkspaceSyncTransport({ enabled: () => true, unsupported() {}, collectMs: 0, intervalMs: 0, maxBatches: 1,
    fetch: async (_url, init) => {
      calls++;
      const key = JSON.parse(String(init!.body)).items[0].sessionKey;
      return new Response(new ReadableStream({ start(c) {
        c.enqueue(new TextEncoder().encode(JSON.stringify({ sessionKey: key, status: 304 }) + '\n'));
      }, cancel: () => new Promise(() => {}) }), { headers: { 'content-type': 'application/x-ndjson', 'x-agentopsdeck-workspace-sync': '1' } });
    } });
  t.after(() => transport.reset());
  await transport.read(item('first'), context());
  const next = transport.read(item('next'), context()); void next.catch(() => {});
  await pause(); await pause(); assert.equal(calls, 2);
  assert.equal((await next).status, 304);
});

test('deadline releases a hung fetch and ignores its late response', async t => {
  let resolveLate!: (response: Response) => void, calls = 0;
  const transport = createWorkspaceSyncTransport({ enabled: () => true, unsupported() {}, collectMs: 0, intervalMs: 0, maxBatches: 1, timeoutMs: 15,
    fetch: async () => {
      if (++calls === 1) return new Promise(resolve => { resolveLate = resolve; });
      return new Response(JSON.stringify({ sessionKey: 'next', status: 304 }) + '\n', { headers: { 'content-type': 'application/x-ndjson', 'x-agentopsdeck-workspace-sync': '1' } });
    } });
  t.after(() => transport.reset());
  await assert.rejects(transport.read(item('hung'), context()), { name: 'TimeoutError' });
  assert.equal((await transport.read(item('next'), context())).status, 304);
  let disposed = false;
  resolveLate(new Response(new ReadableStream({ cancel() { disposed = true; } })));
  await pause(); assert.equal(disposed, true);
  assert.equal(transport.metrics().timeouts, 1); assert.equal(transport.metrics().errors, 1);
});

test('snapshot reset preserves counters; cancellation is not a service failure', async t => {
  const wire = stream();
  const transport = createWorkspaceSyncTransport({ enabled: () => true, unsupported() {}, collectMs: 0, fetch: async () => wire.response });
  t.after(() => transport.reset());
  const one = transport.read(item('one'), context()), two = assert.rejects(transport.read(item('two'), context()), { name: 'AbortError' });
  await pause(); wire.frame({ sessionKey: 'one', status: 503 }); await one;
  const startedAt = transport.metrics().startedAt;
  transport.reset(false); await two;
  const metrics = transport.metrics();
  assert.equal(metrics.batches, 1); assert.equal(metrics.items, 2); assert.equal(metrics.cancelled, 1);
  assert.equal(metrics.errors, 1); assert.equal(metrics.unavailable, 1); assert.equal(metrics.httpErrors, 1);
  assert.equal(metrics.startedAt, startedAt);
  transport.reset(); assert.equal(transport.metrics().errors, 0); assert.equal(transport.metrics().bytes, 0);
});

test('six sessions share one request; fast results and 503 are independent of a slow frame', async t => {
  const wire = stream(); let calls = 0, fallback = 0;
  const transport = createWorkspaceSyncTransport({ enabled: () => true, unsupported() { assert.fail(); }, collectMs: 0, intervalMs: 0,
    fetch: async (_url, init) => { calls++; assert.equal(JSON.parse(String(init?.body)).items.length, 6); return wire.response; } });
  t.after(() => transport.reset());
  const jobs = Array.from({ length: 6 }, (_, i) => transport.read(item(String(i)), context(undefined, async () => { fallback++; return Response.json({}); })));
  await pause(); assert.equal(calls, 1);
  wire.frame({ sessionKey: '1', status: 200, body: { messages: ['fast'] } });
  assert.deepEqual(await (await jobs[1]!).json(), { messages: ['fast'] });
  wire.frame({ sessionKey: '2', status: 503, body: { error: 'Unavailable' } });
  assert.equal((await jobs[2]!).status, 503);
  for (const sessionKey of ['0', '3', '4', '5']) wire.frame({ sessionKey, status: 304, headers: { etag: 'test' } });
  wire.close(); await Promise.all(jobs); await pause();
  assert.equal(fallback, 0); assert.equal(transport.metrics().errors, 1);
  assert.equal(transport.metrics().items, 6); assert.ok(transport.metrics().bytes > 0);
});

test('unsupported Hub falls back once and subsequent batches use sequential legacy reads', async t => {
  let enabled = true, calls = 0, legacy = 0, active = 0, peak = 0;
  const transport = createWorkspaceSyncTransport({ enabled: () => enabled, unsupported() { enabled = false; }, collectMs: 0, intervalMs: 0,
    fetch: async () => { calls++; return new Response(null, { status: 404 }); } });
  t.after(() => transport.reset());
  const old = async () => { active++; peak = Math.max(peak, active); await pause(); active--; legacy++; return Response.json({}); };
  await Promise.all(['1', '2', '3'].map(key => transport.read(item(key), context(undefined, old))));
  await transport.read(item('4'), context(undefined, old));
  assert.equal(calls, 1); assert.equal(legacy, 4); assert.equal(peak, 1);
});

test('outer 503 never triggers legacy fanout; account fence keeps canonical re-auth error', async t => {
  for (const status of [503, 409, 401]) {
    const transport = createWorkspaceSyncTransport({ enabled: () => true, unsupported() { assert.fail(); }, collectMs: 0,
      fetch: async () => new Response(null, { status }) });
    t.after(() => transport.reset());
    const response = await transport.read(item('one'), context(undefined, async () => { assert.fail('no fallback'); }));
    assert.equal(response.status, status);
    if (status === 409) assert.equal((await response.json()).error, 'Authenticated account or Hub changed; reload before continuing');
  }
});

test('truncated, duplicate and malformed streams reject unresolved sessions, not completed ones', async t => {
  for (const mode of ['truncated', 'duplicate', 'malformed', 'oversize']) {
    const wire = stream();
    const transport = createWorkspaceSyncTransport({ enabled: () => true, unsupported() {}, collectMs: 0, fetch: async () => wire.response });
    t.after(() => transport.reset());
    const one = transport.read(item('one'), context());
    const two = assert.rejects(transport.read(item('two'), context()));
    await pause(); wire.frame({ sessionKey: 'one', status: 200, body: { messages: [] } });
    assert.equal((await one).status, 200);
    if (mode === 'duplicate') wire.frame({ sessionKey: 'one', status: 304 });
    if (mode === 'malformed') wire.raw('{bad}\n');
    if (mode === 'oversize') wire.raw('x'.repeat(8 * 1024 * 1024 + 1));
    wire.close(); await two;
  }
});

test('abort one reader preserves peers; aborting all readers stops the shared fetch', async t => {
  const wire = stream(); let fetchSignal!: AbortSignal;
  const transport = createWorkspaceSyncTransport({ enabled: () => true, unsupported() {}, collectMs: 0,
    fetch: async (_url, init) => { fetchSignal = init!.signal!; return wire.response; } });
  t.after(() => transport.reset());
  const a = new AbortController(), b = new AbortController();
  const first = assert.rejects(transport.read(item('a'), context(a.signal)), /cancelled/);
  const second = assert.rejects(transport.read(item('b'), context(b.signal)), /cancelled/);
  await pause(); a.abort(); await first; assert.equal(fetchSignal.aborted, false);
  b.abort(); await second; assert.equal(fetchSignal.aborted, true); await pause();
  assert.throws(() => wire.close(), /already closed/, 'old stream cancelled promptly');
});

test('scope reset aborts old stream, fences late bytes, and cancels queued work before fetch', async t => {
  const wire = stream(); let calls = 0, signal!: AbortSignal;
  const transport = createWorkspaceSyncTransport({ enabled: () => true, unsupported() {}, collectMs: 0,
    fetch: async (_url, init) => { calls++; signal = init!.signal!; return wire.response; } });
  t.after(() => transport.reset());
  const first = assert.rejects(transport.read(item('old'), context()), /scope changed/);
  await pause(); transport.reset(); await first; assert.equal(signal.aborted, true);
  await pause();
  assert.throws(() => wire.frame({ sessionKey: 'old', status: 200, body: { secret: 'old account' } }), /already closed/);
  assert.equal(transport.metrics().bytes, 0);
  const controller = new AbortController();
  const queued = assert.rejects(transport.read(item('new'), context(controller.signal)), /cancelled/);
  controller.abort(); await queued; await pause(); assert.equal(calls, 1);
});

test('batch starts obey rate and concurrency budgets under six-session synthetic load', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const wires: ReturnType<typeof stream>[] = [], starts: number[] = [];
  const transport = createWorkspaceSyncTransport({ enabled: () => true, unsupported() {}, collectMs: 0,
    fetch: async () => { starts.push(Date.now()); const wire = stream(); wires.push(wire); return wire.response; } });
  t.after(() => transport.reset());
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  let reads = 0;
  for (let round = 0; round < 10; round++) {
    const pending = Array.from({ length: 6 }, (_, i) => transport.read(item(String(i)), context())); reads += pending.length;
    t.mock.timers.tick(round === 0 ? 0 : 1499); await settle();
    if (round > 0) { assert.equal(starts.length, round); t.mock.timers.tick(1); await settle(); }
    const wire = wires[round]!;
    for (let i = 0; i < 6; i++) wire.frame({ sessionKey: String(i), status: 304 });
    wire.close(); await Promise.all(pending); await settle();
  }
  assert.equal(reads, 60); assert.equal(starts.length, 10);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i]! - starts[i - 1]! >= 1500);
  t.diagnostic('Synthetic aligned workload: 60 session reads -> 10 HTTP batches (83.3% fewer history requests; not a live-page measurement).');
});

test('two batch ceiling, eight item cap and scope grouping remain enforced', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const wires: ReturnType<typeof stream>[] = [], requests: Array<Array<{ sessionKey: string }>> = [];
  const transport = createWorkspaceSyncTransport({ enabled: () => true, unsupported() {}, collectMs: 0, intervalMs: 0,
    fetch: async (_url, init) => { requests.push(JSON.parse(String(init!.body)).items); const wire = stream(); wires.push(wire); return wire.response; } });
  t.after(() => transport.reset());
  const pending = Array.from({ length: 18 }, (_, i) => transport.read(item(String(i)), { ...context(), group: i < 16 ? 'owner' : 'other' }));
  t.mock.timers.tick(0); for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(requests.length, 2); assert.ok(requests.every(items => items.length === 8));
  for (let batch = 0; batch < 2; batch++) { for (const entry of requests[batch]!) wires[batch]!.frame({ sessionKey: entry.sessionKey, status: 304 }); wires[batch]!.close(); }
  for (let i = 0; i < 30; i++) await Promise.resolve();
  t.mock.timers.tick(0); for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(requests.length, 3); assert.equal(requests[2]!.length, 2);
  for (const entry of requests[2]!) wires[2]!.frame({ sessionKey: entry.sessionKey, status: 304 }); wires[2]!.close();
  await Promise.all(pending);
});

test('Preview preference defaults off, persists per account, retries unavailable Hub and tolerates denied storage', t => {
  const originalWindow = globalThis.window, storage = new Map<string, string>();
  Object.assign(globalThis, { window: { localStorage: { getItem: (key: string) => storage.get(key), setItem: (key: string, value: string) => storage.set(key, value) } } });
  t.after(() => { setWorkspaceSyncScope(undefined); Object.assign(globalThis, { window: originalWindow }); });
  setWorkspaceSyncScope('first'); assert.equal(workspaceSyncPreference().enabled, false);
  setWorkspaceSyncEnabled(true); markWorkspaceSyncUnavailable(); assert.equal(workspaceSyncPreference().unavailable, true);
  setWorkspaceSyncEnabled(true); assert.equal(workspaceSyncPreference().unavailable, false);
  setWorkspaceSyncScope('second'); assert.equal(workspaceSyncPreference().enabled, false);
  setWorkspaceSyncScope('first'); assert.equal(workspaceSyncPreference().enabled, true);
  Object.assign(globalThis, { window: { get localStorage() { throw new Error('denied'); } } });
  setWorkspaceSyncScope('private'); setWorkspaceSyncEnabled(true);
  assert.equal(workspaceSyncPreference().enabled, true); assert.equal(workspaceSyncPreference().persistent, false);
  setWorkspaceSyncEnabled(false); assert.equal(workspaceSyncPreference().enabled, false);
});
