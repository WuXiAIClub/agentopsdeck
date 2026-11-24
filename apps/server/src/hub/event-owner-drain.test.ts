import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { parseConnectorEvents } from '../connector/sse.js';
import { ConnectorClient } from './connector-client.js';
import { HubEventBroker, HubEventBrokers } from './event-broker.js';
import { HubStore } from './hub-store.js';
import { performanceDiagnostics, PerformanceDiagnostics } from '../diagnostics/performance.js';
import { boundedDispatch, OriginalTransportDrain } from '../connector/transport.js';

function deferred() {
  let resolve!: () => void, reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function until(predicate: () => boolean) {
  const deadline = performance.now() + 2_000;
  while (!predicate()) { assert.ok(performance.now() < deadline, 'original feed must progress'); await delay(5); }
}
async function pending(promise: Promise<unknown>) {
  let settled = false;
  void promise.then(() => { settled = true; }, () => { settled = true; });
  await delay(15);
  assert.equal(settled, false, 'abort/second cancel must not acknowledge original idle');
}
function fixture(drainWarningMs = 30_000) {
  const store = new HubStore(':memory:', 'private-key');
  const member = store.createUser('member').id;
  for (const ownerUserId of ['default', member]) store.upsertConnection({ id: 'node-' + ownerUserId,
    ownerUserId, label: 'private-node', connectorUrl: 'http://private-node', capabilities: ['events'], credentialToken: 'private-token' });
  const cancellations: ReturnType<typeof deferred>[] = [];
  let requests = 0, cancelCalls = 0;
  let domain: string | undefined;
  const registry = new HubEventBrokers(store, () => {
    const client = new ConnectorClient('http://private-node', 'private-token', async () => {
    requests++;
    const original = deferred(); cancellations.push(original);
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('event: heartbeat\ndata: \n\n')); },
      cancel() { cancelCalls++; return original.promise; },
    }), { headers: { 'content-type': 'text/event-stream' } });
    });
    const originalDomain = client.eventDomain;
    Object.defineProperty(client, 'eventDomain', { get: () => domain ?? originalDomain });
    return client;
  },drainWarningMs);
  return { store, member, registry, cancellations, requests: () => requests, cancelCalls: () => cancelCalls,
    rotateDomain(next: string) { domain = next; },
    async close() { registry.close(); for (const original of cancellations) original.resolve(); await registry.drain(); await store.close(); } };
}

for (const removed of [false,true]) for (const broken of [false,true])
test(`rotated original feed has pending and real-exit evidence (removed=${removed},broken=${broken})`,async t=>{
  const lines:string[]=[];
  const diagnostics=new PerformanceDiagnostics(line=>{lines.push(line);if(broken)throw Error('private-sink');});
  t.mock.method(performanceDiagnostics,'start',diagnostics.start.bind(diagnostics));
  const store=new HubStore(':memory:','private-key');
  store.upsertConnection({id:'private-node',label:'private-label',connectorUrl:'http://private-node',
    capabilities:['events'],credentialToken:'private-token'});
  let requests=0,cancels=0,domain='original';
  const originals:ReturnType<typeof deferred>[]=[];
  const broker=new HubEventBroker(store,()=>{
    const client=new ConnectorClient('http://private-node','private-token',async()=>{
      requests++; const original=deferred();originals.push(original);
      return new Response(new ReadableStream<Uint8Array>({
        start(c){c.enqueue(new TextEncoder().encode('event: heartbeat\ndata: \n\n'));},
        cancel(){cancels++;return original.promise;},
      }),{headers:{'content-type':'text/event-stream'}});
    });
    Object.defineProperty(client,'eventDomain',{get:()=>domain});return client;
  },'default',60_000,500,5);
  const release=broker.acquire();
  try{
    await until(()=>requests===1);
    if(removed)store.deleteConnection('private-node');else domain='rotated';
    (broker as any).reconcileSafely(); await until(()=>cancels===1);
    for(let i=0;i<4;i++)(broker as any).reconcileSafely();
    await until(()=>diagnostics.snapshot().events.some(e=>e.step===7&&e.phase==='pending'));
    assert.equal(requests,1);assert.equal(broker.pendingFeeds,1);
    assert.equal(diagnostics.snapshot().events.filter(e=>e.step===7&&e.phase==='finished').length,0);
    originals[0]!.resolve();await until(()=>broker.pendingFeeds===0);
    await until(()=>diagnostics.snapshot().events.some(e=>e.step===7&&e.settled===1));
    const rows=diagnostics.snapshot().events.filter(e=>e.step===7);
    assert.equal(rows.length,2);assert.equal(rows[0]!.sequence,rows[1]!.sequence);
    assert.doesNotMatch(JSON.stringify(rows)+lines.join(''),/private-|original|rotated/);
    if(removed)store.upsertConnection({id:'private-node',label:'private-label',connectorUrl:'http://private-node',
      capabilities:['events'],credentialToken:'private-token'});
    (broker as any).reconcileSafely();await until(()=>requests===2);
  }finally{
    release();broker.close();for(const original of originals)original.resolve();await broker.drain();
    await store.close();t.mock.restoreAll();
  }
});

for (const rejected of [false, true]) test(`SSE abort retains the original underlying cancel (${rejected ? 'rejection' : 'ACK'})`, async () => {
  const original = deferred(); const controller = new AbortController(); let cancelCalls = 0;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelCalls++; return original.promise; } });
  const iterator = parseConnectorEvents(body, controller.signal);
  const next = iterator.next(); const outcome = assert.rejects(next, { name: 'AbortError' });
  controller.abort();
  try {
    await until(() => cancelCalls === 1); await pending(outcome);
    assert.equal(body.locked, true);
    if (rejected) original.reject(Error('private-cancellation-error')); else original.resolve();
    await outcome; assert.equal(body.locked, false); assert.equal(cancelCalls, 1);
  } finally { original.resolve(); await outcome; }
});

test('SSE consumer return waits for its original cancellation and releases the reader', async () => {
  const original = deferred(); let calls = 0;
  // A consumer return, not an already-closed source, invokes underlying cancel.
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('event: heartbeat\ndata: \n\n')); },
    cancel() { calls++; return original.promise; },
  });
  const iterator = parseConnectorEvents(body, new AbortController().signal);
  assert.equal((await iterator.next()).done, false);
  const returned = iterator.return(undefined);
  try { await until(() => calls === 1); await pending(returned); original.resolve(); await returned; assert.equal(body.locked, false); }
  finally { original.resolve(); await returned; }
});

test('last browser release retains the feed slot until real transport cancellation; retry never duplicates the request', async () => {
  const f = fixture(), handle = f.registry.acquire('default');
  try {
    await until(() => f.requests() === 1); handle.release(); handle.release();
    await until(() => f.cancelCalls() === 1);
    assert.equal((f.registry as any).subscribers, 0);
    assert.equal((f.registry as any).retiring.size, 1);
    for (let i = 0; i < 3; i++) assert.throws(() => f.registry.acquire('default'), /draining/);
    assert.equal(f.requests(), 1); assert.equal(handle.events.pendingFeeds, 1);
    f.cancellations[0]!.resolve(); await handle.events.drain();
    await until(() => (f.registry as any).retiring.size === 0);
    const fresh = f.registry.acquire('default');
    await until(() => f.requests() === 2); fresh.release();
    await until(() => f.cancelCalls() === 2);
  } finally { await f.close(); }
});

test('registry drain freezes admission and waits for ALL owners, including retired feeds', async () => {
  const f = fixture(), first = f.registry.acquire('default'), second = f.registry.acquire(f.member);
  try {
    await until(() => f.requests() === 2); first.release();
    const drain = f.registry.drain(); assert.equal(f.registry.drain(), drain);
    assert.ok(second.events.isClosed); assert.throws(() => f.registry.acquire('default'), /closed/);
    await until(() => f.cancelCalls() === 2); await pending(drain);
    f.cancellations[0]!.resolve(); await first.events.drain(); await pending(drain);
    f.cancellations[1]!.resolve(); await drain;
    assert.equal(first.events.pendingFeeds, 0); assert.equal(second.events.pendingFeeds, 0);
    second.release(); assert.equal((f.registry as any).subscribers, 0);
  } finally { await f.close(); }
});

test('rotating an upstream cannot replace it before the old cancellation settles', async () => {
  const f = fixture(), handle = f.registry.acquire('default');
  try {
    await until(() => f.requests() === 1);
    // Test transport domain tracks this credential rotation just as production.
    f.rotateDomain('rotated');
    (handle.events as any).reconcileSafely();
    await until(() => f.cancelCalls() === 1);
    for (let i = 0; i < 3; i++) (handle.events as any).reconcileSafely();
    assert.equal(f.requests(), 1);
    f.cancellations[0]!.resolve(); await until(() => handle.events.pendingFeeds === 0);
    (handle.events as any).reconcileSafely(); await until(() => f.requests() === 2);
    handle.release();
  } finally { await f.close(); }
});

test('removed then re-added connection still retains its old pump until it exits', async () => {
  const f = fixture(), handle = f.registry.acquire('default');
  try {
    await until(() => f.requests() === 1); f.store.deleteConnection('node-default');
    (handle.events as any).reconcileSafely(); await until(() => f.cancelCalls() === 1);
    f.store.upsertConnection({ id: 'node-default', connectorUrl: 'http://private-node', label: 'new',
      capabilities: ['events'], credentialToken: 'private-token' });
    (handle.events as any).reconcileSafely(); assert.equal(f.requests(), 1);
    f.cancellations[0]!.resolve(); await until(() => handle.events.pendingFeeds === 0);
    (handle.events as any).reconcileSafely(); await until(() => f.requests() === 2); handle.release();
  } finally { await f.close(); }
});

test('reentrant release during initial pump admission prevents any late transport dispatch', async () => {
  const f = fixture(), handle = f.registry.acquire('default');
  handle.release();
  try { await handle.events.drain(); assert.equal(f.requests(), 0); assert.equal(handle.events.pendingFeeds, 0); }
  finally { await f.close(); }
});

test('a gap SQL close failure still signals peer feeds and waits for original pumps before rejecting', async t => {
  const f = fixture(), first = f.registry.acquire('default'), second = f.registry.acquire(f.member);
  let gaps = 0;
  const error = Error('private-gap-error');
  try {
    await until(() => f.requests() === 2);
    t.mock.method(f.store.completions, 'markGap', () => { gaps++; throw error; });
    const drain = f.registry.drain(); const rejected = assert.rejects(drain, value => value === error);
    assert.equal(f.registry.drain(), drain); assert.equal(gaps, 2);
    await until(() => f.cancelCalls() === 2); await pending(rejected);
    f.cancellations[0]!.resolve(); f.cancellations[1]!.resolve(); await rejected;
    assert.equal(gaps, 2, 'drain/reentry never replays gap SQL');
    first.release(); second.release(); assert.equal((f.registry as any).subscribers, 0);
  } finally { t.mock.restoreAll(); for (const original of f.cancellations) original.resolve(); await f.store.close(); }
});

test('drain diagnostics contain only counts and phases, not credentials or private errors', async () => {
  const f = fixture(), handle = f.registry.acquire('default');
  const sequence = performanceDiagnostics.snapshot().events.at(-1)?.sequence ?? 0;
  try {
    await until(() => f.requests() === 1); const drain = f.registry.drain();
    await until(() => f.cancelCalls() === 1); f.cancellations[0]!.resolve(); await drain;
    const rows = performanceDiagnostics.snapshot().events.filter(row => row.sequence > sequence && row.operation === 'hub-event-broker' && row.step === 4);
    assert.ok(rows.some(row => row.settled === 1)); assert.doesNotMatch(JSON.stringify(rows), /private|token|node-default/);
    handle.release();
  } finally { await f.close(); }
});

for (const rejected of [false, true]) test(`event iterator retains dispatch before headers and late cleanup (${rejected ? 'failure' : 'ACK'})`, async () => {
  let respond!: (response: Response) => void, dispatched = false, calls = 0;
  const cleanup = deferred(), controller = new AbortController();
  const client = new ConnectorClient('http://synthetic', 'private-token', () => {
    dispatched = true; return new Promise<Response>(resolve => { respond = resolve; });
  });
  const iterator = client.events(controller.signal);
  const next = assert.rejects(iterator.next(), { name: 'AbortError' });
  try {
    await until(() => dispatched); controller.abort(); await pending(next);
    respond(new Response(new ReadableStream<Uint8Array>({ cancel() { calls++; return cleanup.promise; } })));
    await until(() => calls === 1); await pending(next);
    if (rejected) cleanup.reject(Error('private-error')); else cleanup.resolve();
    await next; assert.equal(calls, 1);
  } finally { cleanup.resolve(); }
});

test('an authority rejection after headers retains the original cleanup without replay', async () => {
  const cleanup = deferred(), controller = new AbortController(); let authorized = 0, calls = 0, dispatched = 0;
  const original = Error('private-authority');
  const client = new ConnectorClient('http://synthetic', 'private-token', () => {
    dispatched++; return new Response(new ReadableStream<Uint8Array>({ cancel() { calls++; return cleanup.promise; } }));
  }, 1000, 1024, { authorize() { if (++authorized > 1) throw original; } });
  const next = assert.rejects(client.events(controller.signal).next(), error => error === original);
  try { await until(() => calls === 1); await pending(next); cleanup.resolve(); await next; assert.equal(dispatched, 1); }
  finally { cleanup.resolve(); }
});

test('opt-in transport drain is independent from fast HTTP abort and retains the source reader', async () => {
  const cleanup = deferred(), controller = new AbortController(), drain = new OriginalTransportDrain(); let calls = 0;
  const source = new ReadableStream<Uint8Array>({ cancel() { calls++; return cleanup.promise; } });
  const response = await boundedDispatch(() => new Response(source), 1000, false, drain)(new Request('http://synthetic', { signal: controller.signal }));
  const reader = response.body!.getReader(), reading = assert.rejects(reader.read(), { name: 'AbortError' });
  try {
    controller.abort(); await reading; assert.equal(source.locked, true); assert.equal(calls, 1);
    const idle = drain.wait(); await pending(idle); cleanup.resolve(); await idle;
    assert.equal(source.locked, false); assert.equal(calls, 1);
  } finally { cleanup.resolve(); reader.releaseLock(); }
});

test('broken lifecycle observation cannot release a pending feed or prevent drain', async (t) => {
  const f = fixture(), handle = f.registry.acquire('default');
  try {
    await until(() => f.requests() === 1);
    t.mock.method(performanceDiagnostics, 'start', () => { throw Error('private-observer'); });
    const drain = f.registry.drain(); await until(() => f.cancelCalls() === 1); await pending(drain);
    assert.equal(handle.events.pendingFeeds, 1); f.cancellations[0]!.resolve(); await drain;
    assert.equal(handle.events.pendingFeeds, 0); handle.release();
  } finally { t.mock.restoreAll(); await f.close(); }
});

test('broken SQL observation preserves admission error and releases subscriber counts', async (t) => {
  const f = fixture(), original = Error('private-sql');
  try {
    t.mock.method(performanceDiagnostics, 'start', () => { throw Error('private-observer'); });
    t.mock.method(f.store.completions, 'markGap', () => { throw original; });
    assert.throws(() => f.registry.acquire('default'), error => error === original);
    assert.equal((f.registry as any).subscribers, 0); assert.equal((f.registry as any).brokers.size, 0);
    assert.equal(f.requests(), 0);
  } finally { t.mock.restoreAll(); await f.close(); }
});

for (const broken of [false,true]) test(`last subscriber retirement logs pending then original settlement (sink broken=${broken})`, async t => {
  const lines: string[] = [], diagnostics = new PerformanceDiagnostics(line => {
    lines.push(line); if (broken) throw Error('private-sink');
  });
  t.mock.method(performanceDiagnostics,'start',diagnostics.start.bind(diagnostics));
  const f = fixture(5), handle = f.registry.acquire('default');
  try {
    await until(()=>f.requests()===1); handle.release();
    await until(()=>diagnostics.snapshot().events.some(e=>e.step===5 && e.phase==='pending'));
    assert.throws(()=>f.registry.acquire('default'),/feed is draining/);
    assert.equal(handle.events.pendingFeeds,1); assert.equal(f.requests(),1);
    const draining = diagnostics.snapshot().events.find(e=>e.step===5 && e.phase==='pending')!;
    assert.equal(draining.pending,1);
    const refusal=diagnostics.snapshot().events.find(e=>e.step===6)!;
    assert.equal(refusal.deferred,1);assert.equal(refusal.ownerFailureCode,3);assert.equal(refusal.pending,1);
    f.cancellations[0]!.resolve();
    await until(()=>diagnostics.snapshot().events.some(e=>e.step===5 && e.settled===1));
    const next = f.registry.acquire('default'); next.release();
    assert.doesNotMatch(lines.join('\n'),/private-node|private-token|private-sink|default/);
  } finally { await f.close(); t.mock.restoreAll(); }
});

test('retirement publishes before synchronous close reentry and observes only once', async t => {
  const diagnostics = new PerformanceDiagnostics(()=>{});
  t.mock.method(performanceDiagnostics,'start',diagnostics.start.bind(diagnostics));
  const f = fixture(5), handle = f.registry.acquire('default'), original = handle.events.close.bind(handle.events);
  let closed = 0;
  try {
    await until(()=>f.requests()===1);
    t.mock.method(handle.events,'close',()=>{ if (!handle.events.isClosed) { closed++; f.registry.close(); } original(); });
    handle.release(); handle.release();
    await until(()=>diagnostics.snapshot().events.some(e=>e.step===5 && e.phase==='pending'));
    assert.equal(closed,1); assert.equal((f.registry as any).retiring.size,1);
    f.cancellations[0]!.resolve(); await f.registry.drain();
    assert.equal(diagnostics.snapshot().events.filter(e=>e.step===5 && e.phase==='finished').length,1);
    assert.equal((f.registry as any).retiring.size,0);
  } finally { t.mock.restoreAll(); await f.close(); }
});

for (const refusal of ['closed','subscriber','owner'] as const) test(`feed admission refusal is observable: ${refusal}`, async t => {
  const diagnostics = new PerformanceDiagnostics(()=>{});
  t.mock.method(performanceDiagnostics,'start',diagnostics.start.bind(diagnostics));
  const f = fixture();
  try {
    if (refusal==='closed') f.registry.close();
    else if (refusal==='subscriber') (f.registry as any).subscribers=256;
    else for(let index=0;index<256;index++) (f.registry as any).retiring.set(String(index),{});
    assert.throws(()=>f.registry.acquire('default'),/closed|capacity exceeded/);
    assert.equal(f.requests(),0);
    const row=diagnostics.snapshot().events.find(e=>e.step===6)!;
    assert.equal(row.deferred,1); assert.equal(row.category,'failed');
    assert.equal(row.ownerFailureCode,refusal==='closed'?1:refusal==='subscriber'?2:4);
    assert.equal(row.pending,0);
  } finally {
    if(refusal==='owner') (f.registry as any).retiring.clear();
    if(refusal==='subscriber') (f.registry as any).subscribers=0;
    await f.close(); t.mock.restoreAll();
  }
});

for(const broken of [false,true]) test(`rotation observer reentry cannot replay gap SQL or replace the old feed (${broken})`,async t=>{
  const f=fixture(),handle=f.registry.acquire('default');
  const diagnostics=new PerformanceDiagnostics(()=>{});
  let entered=0,gaps=0;
  try{
    await until(()=>f.requests()===1);
    f.rotateDomain('rotated');
    const originalGap=f.store.completions.markGap.bind(f.store.completions);
    t.mock.method(f.store.completions,'markGap',(...args:Parameters<typeof originalGap>)=>{gaps++;return originalGap(...args);});
    t.mock.method(performanceDiagnostics,'start',(operation:Parameters<typeof performanceDiagnostics.start>[0])=>{
      if(operation==='hub-event-broker'&&entered===0){entered++;(handle.events as any).reconcileSafely();}
      if(broken)throw Error('private-observer');return diagnostics.start(operation);
    });
    (handle.events as any).reconcileSafely();await until(()=>f.cancelCalls()===1);
    for(let i=0;i<3;i++)(handle.events as any).reconcileSafely();
    assert.equal(entered,1);assert.equal(gaps,1);assert.equal(f.requests(),1);
    f.cancellations[0]!.resolve();await until(()=>handle.events.pendingFeeds===0);
    if(!broken)await until(()=>diagnostics.snapshot().events.some(e=>e.step===7&&e.settled===1));
    assert.equal(diagnostics.snapshot().events.filter(e=>e.step===7&&e.phase==='finished').length,broken?0:1);
    (handle.events as any).reconcileSafely();await until(()=>f.requests()===2);handle.release();
  }finally{t.mock.restoreAll();await f.close();}
});
