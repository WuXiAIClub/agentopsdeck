import assert from 'node:assert/strict';
import test from 'node:test';
import { getEventListeners } from 'node:events';
import { SessionReadAuthority } from './session-read-authority.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

function held<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const request = (signal?: AbortSignal) => new Request('http://private.invalid/api/sessions/PRIVATE-session', {
  headers: { authorization: 'Bearer PRIVATE-key' }, ...(signal ? { signal } : {}),
});

for (const ending of ['timeout', 'abort', 'close'] as const) for (const settlement of ['resolve', 'reject'] as const) {
  test(`whole session read ${ending} retains stalled history until original ${settlement}`, { timeout: 5000 }, async () => {
    const gate = held<Response>(), entered = held<void>(), abort = new AbortController();
    const lines: string[] = [];
    const diagnostics = new PerformanceDiagnostics(line => lines.push(line));
    let calls = 0, workCalls = 0, closed = false;
    const owner = new SessionReadAuthority(async () => { calls++; return 'PRIVATE-actor'; }, diagnostics, ending === 'timeout' ? 30 : 1000);
    const req = request(abort.signal);
    let lateCheck!: () => Promise<void>;
    const response = owner.run(req, check => { workCalls++; lateCheck = check; entered.resolve(); return gate.promise; });
    await entered.promise;
    if (ending === 'abort') abort.abort();
    const closing = ending === 'close' ? owner.close() : undefined;
    if (ending !== 'close') {
      const result = await response;
      assert.equal(result.status, ending === 'abort' ? 408 : 503);
      assert.doesNotMatch(await result.text(), /PRIVATE|Bearer|SELECT/);
      assert.equal(getEventListeners(req.signal, 'abort').length, 0);
    }
    assert.equal(owner.pending, 1); assert.equal(calls, 1); assert.equal(workCalls, 1);
    // A callback retained by history code cannot dispatch a new observation
    // after its HTTP caller has gone away, even before history settles.
    await assert.rejects(lateCheck()); assert.equal(calls, 1);
    const close = closing ?? owner.close();
    assert.equal(owner.close(), close);
    void close.then(() => { closed = true; });
    await tick(); assert.equal(closed, false);
    assert.equal((await owner.run(request(), () => assert.fail('No admission while closing'))).status, 503);
    if (settlement === 'resolve') gate.resolve(Response.json({ private: 'PRIVATE late history' }));
    else gate.reject(Error('PRIVATE SELECT messages'));
    assert.equal((await response).status, ending === 'abort' ? 408 : 503);
    await close; assert.equal(closed, true); assert.equal(owner.pending, 0); assert.equal(calls, 1);
    assert.equal(getEventListeners(req.signal, 'abort').length, 0);
    assert.doesNotMatch(lines.join('\n'), /PRIVATE|Bearer|SELECT|private\.invalid/);
    assert.ok(diagnostics.snapshot().events.some(event => event.operation === 'session-read-request'));
  });
}

test('whole read deadline cannot restart for each fresh authority check', { timeout: 5000 }, async () => {
  const history = held<Response>(), entered = held<void>(); let calls = 0;
  const owner = new SessionReadAuthority(async () => { calls++; return 'actor'; }, new PerformanceDiagnostics(() => {}), 40);
  const response = owner.run(request(), async check => {
    await check(); entered.resolve(); return history.promise;
  });
  await entered.promise; assert.equal(calls, 2);
  assert.equal((await response).status, 503); assert.equal(owner.pending, 1);
  history.resolve(Response.json({ ok: true })); await owner.close();
  assert.equal(calls, 2); assert.equal(owner.pending, 0);
});

test('history capacity remains reserved after HTTP timeout, not just while SQL is pending', { timeout: 15_000 }, async () => {
  const gates: ReturnType<typeof held<Response>>[] = []; let calls = 0;
  const owner = new SessionReadAuthority(async () => { calls++; return 'actor'; }, new PerformanceDiagnostics(() => {}), 50);
  const responses: Promise<Response>[] = [];
  for (let index = 0; index < 256; index++) {
    const gate = held<Response>(), entered = held<void>(); gates.push(gate);
    responses.push(owner.run(request(), () => { entered.resolve(); return gate.promise; }));
    await entered.promise;
    assert.equal(owner.pending, index + 1);
  }
  for (const response of await Promise.all(responses)) assert.equal(response.status, 503);
  assert.equal(calls, 256);
  assert.equal((await owner.run(request(), () => assert.fail('No capacity'))).status, 503);
  assert.equal(calls, 256); assert.equal(owner.pending, 256);
  gates[0]!.resolve(Response.json({ stale: true })); await tick(); assert.equal(owner.pending, 255);
  assert.equal((await owner.run(request(), () => Response.json({ ok: true }))).status, 200);
  assert.equal(calls, 258); assert.equal(owner.pending, 255);
  const close = owner.close();
  gates.slice(1).forEach(gate => gate.reject(Error('PRIVATE late history')));
  await close; assert.equal(owner.pending, 0);
});

test('active history failures remain original failures without a replacement authority lookup', async () => {
  const failure = Error('PRIVATE active history failure'); let calls = 0;
  const owner = new SessionReadAuthority(async () => { calls++; return 'actor'; }, new PerformanceDiagnostics(() => {}), 1000);
  try {
    await assert.rejects(owner.run(request(), async () => { throw failure; }), error => error === failure);
    assert.equal(calls, 1); assert.equal(owner.pending, 0);
  } finally { await owner.close(); }
});

test('deferred dispatch snapshots credentials before caller can mutate them', async () => {
  const seen: string[] = [], req = request();
  const owner = new SessionReadAuthority(async supplied => { seen.push(supplied.headers.get('authorization')!); return 'actor'; },
    new PerformanceDiagnostics(() => {}), 1000);
  const response = owner.run(req, () => Response.json({ ok: true }));
  req.headers.set('authorization', 'Bearer PRIVATE-replacement');
  assert.equal((await response).status, 200);
  assert.deepEqual(seen, ['Bearer PRIVATE-key', 'Bearer PRIVATE-key']);
  await owner.close();
});
