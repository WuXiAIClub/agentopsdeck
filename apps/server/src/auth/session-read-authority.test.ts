import assert from 'node:assert/strict';
import test from 'node:test';
import { getEventListeners } from 'node:events';
import { SessionReadAuthority, type SessionReadActor } from './session-read-authority.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { controlledHttpDeadline } from '../lifecycle/http-deadline-test-support.js';

function held<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const request = (signal?: AbortSignal) => new Request('http://fixture/api/sessions/PRIVATE-session', {
  headers: { authorization: 'Bearer PRIVATE-key' }, ...(signal ? { signal } : {}),
});
function fixture(actor: SessionReadActor, waitMs = 20) {
  const lines: string[] = [];
  const diagnostics = new PerformanceDiagnostics(line => lines.push(line));
  return { owner: new SessionReadAuthority(actor, diagnostics, waitMs), diagnostics,
    redacted() { assert.doesNotMatch(lines.join('\n'), /PRIVATE|Bearer|fixture\/|SELECT|token/); } };
}

test('session read awaits admission and delivery observations, not a cached permission', async () => {
  let calls = 0, work = 0;
  const f = fixture(async () => { calls++; await tick(); return 'PRIVATE-actor'; });
  const response = await f.owner.run(request(), () => { work++; assert.equal(calls, 1); return Response.json({ retained: true }); });
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { retained: true });
  assert.equal(calls, 2); assert.equal(work, 1); assert.equal(f.owner.pending, 0);
  await f.owner.close(); f.redacted();
});

for (const outcome of ['revoke', 'switch', 'reject'] as const) test(`session read suppresses private delivery after ${outcome}`, async () => {
  let actor: string | undefined = 'PRIVATE-actor', work = 0, calls = 0;
  const f = fixture(async () => { calls++; if (outcome === 'reject' && calls > 1) throw Error('PRIVATE token SELECT'); return actor; });
  const response = await f.owner.run(request(), async check => {
    await check(); work++;
    actor = outcome === 'revoke' ? undefined : 'PRIVATE-replacement';
    return Response.json({ private: 'PRIVATE retained messages' });
  });
  assert.equal(response.status, outcome === 'reject' ? 503 : 403);
  assert.doesNotMatch(await response.text(), /PRIVATE|SELECT|token/);
  assert.equal(work, outcome === 'reject' ? 0 : 1);
  await f.owner.close(); f.redacted();
});

for (const value of [undefined, '', false, true, 1, {}, new Proxy({}, {})]) {
  test(`session read does not turn ${value === undefined ? 'missing' : typeof value} into actor permission`, async () => {
    const f = fixture((() => value) as SessionReadActor);
    const response = await f.owner.run(request(), () => assert.fail('No private read'));
    assert.equal(response.status, value === undefined || value === '' ? 403 : 503);
    await f.owner.close(); f.redacted();
  });
}

test('session read snapshots credentials before waiting and isolates observation request headers', async () => {
  const original = request(), gate = held<void>(); let calls = 0;
  const f = fixture(async supplied => {
    calls++;
    assert.equal(supplied.headers.get('authorization'), 'Bearer PRIVATE-key');
    supplied.headers.set('authorization', 'Bearer PRIVATE-mutated');
    if (calls === 1) await gate.promise;
    return 'PRIVATE-actor';
  });
  const response = f.owner.run(original, () => Response.json({ ok: true }));
  original.headers.set('authorization', 'Bearer PRIVATE-replacement');
  gate.resolve();
  assert.equal((await response).status, 200); assert.equal(calls, 2);
  await f.owner.close(); f.redacted();
});

test('repeated observations do not accumulate listeners on the original request signal', async t => {
  // This checks listener ownership, not host scheduling speed. Keep both the
  // monotonic deadline and its timer fixed; separate timeout/abort tests below
  // still exercise physical settlement and retained admission capacity.
  controlledHttpDeadline(t);
  const original = request();
  let observations = 0, deliveries = 0;
  const f = fixture(async () => { observations++; return 'PRIVATE-actor'; });
  for (let index = 0; index < 128; index++) {
    assert.equal((await f.owner.run(original, () => {
      deliveries++;
      return Response.json({ ok: true });
    })).status, 200);
    assert.equal(getEventListeners(original.signal, 'abort').length, 0);
    assert.equal(f.owner.pending, 0);
  }
  assert.equal(observations, 256); assert.equal(deliveries, 128);
  await f.owner.close(); f.redacted();
});

test('copied observation receives cancellation even when its SQL owner is still pending', async () => {
  const controller = new AbortController(), gate = held<string | undefined>(), entered = held<void>();
  let observed!: Request;
  const f = fixture(supplied => { observed = supplied; entered.resolve(); return gate.promise; });
  const response = f.owner.run(request(controller.signal), () => assert.fail('No history after cancellation'));
  await entered.promise; controller.abort();
  assert.equal((await response).status, 408); assert.equal(observed.signal.aborted, true);
  assert.equal(f.owner.pending, 1);
  gate.resolve('PRIVATE-late'); await f.owner.close(); f.redacted();
});

for (const end of ['timeout', 'abort'] as const) for (const late of ['resolve', 'reject'] as const) {
  test(`session ${end} retains original actor lookup until actual late ${late}`, async () => {
    const gate = held<string | undefined>(), entered = held<void>(), controller = new AbortController(); let calls = 0, drained = false;
    const f = fixture(() => { calls++; entered.resolve(); return gate.promise; }, 30);
    const req = request(controller.signal);
    const pending = f.owner.run(req, () => assert.fail('No late history read'));
    await entered.promise;
    if (end === 'abort') controller.abort();
    const response = await pending;
    assert.equal(response.status, end === 'abort' ? 408 : 503);
    assert.equal(f.owner.pending, 1); assert.equal(calls, 1);
    assert.equal(getEventListeners(req.signal, 'abort').length, 0);
    const close = f.owner.close().then(() => { drained = true; });
    await tick(); assert.equal(drained, false);
    assert.equal((await f.owner.run(request(), () => assert.fail('Closed'))).status, 503);
    assert.equal(calls, 1);
    if (late === 'resolve') gate.resolve('PRIVATE-late-actor'); else gate.reject(Error('PRIVATE SELECT token'));
    await close; assert.equal(f.owner.pending, 0); f.redacted();
    assert.ok(f.diagnostics.snapshot().events.some(event => event[end === 'abort' ? 'cancelled' : 'timedOut'] === 1));
  });
}

test('already cancelled session read cannot start actor or history I/O', async () => {
  const controller = new AbortController(); controller.abort();
  const f = fixture(() => assert.fail('No lookup'));
  assert.equal((await f.owner.run(request(controller.signal), () => assert.fail('No history'))).status, 408);
  assert.equal(f.owner.pending, 0); await f.owner.close(); f.redacted();
});

test('close during history work suppresses late delivery and never dispatches a replacement lookup', async () => {
  let calls = 0, closed = false;
  const entered = held<void>(), gate = held<Response>();
  const f = fixture(async () => { calls++; return 'PRIVATE-actor'; }, 1000);
  const response = f.owner.run(request(), () => { entered.resolve(); return gate.promise; });
  await entered.promise;
  const closing = f.owner.close().then(() => { closed = true; });
  await tick(); assert.equal(closed, false); assert.equal(f.owner.pending, 1);
  gate.resolve(Response.json({ private: 'PRIVATE data' }));
  assert.equal((await response).status, 503); await closing;
  assert.equal(closed, true); assert.equal(calls, 1); f.redacted();
});

test('256 timed-out reads retain their slots; new admission requires real original settlement', async () => {
  const gates: ReturnType<typeof held<string | undefined>>[] = [];
  let ready = false, calls = 0;
  const f = fixture(() => { calls++; if (ready) return 'PRIVATE-actor'; const gate = held<string | undefined>(); gates.push(gate); return gate.promise; }, 5);
  const responses: Response[] = [];
  for (let index = 0; index < 256; index++) responses.push(await f.owner.run(request(), () => assert.fail('No late read')));
  assert.ok(responses.every(response => response.status === 503)); assert.equal(f.owner.pending, 256); assert.equal(calls, 256);
  assert.equal((await f.owner.run(request(), () => assert.fail('No over-admission'))).status, 503);
  assert.equal(calls, 256); assert.equal(f.owner.pending, 256);
  gates[0]!.resolve('PRIVATE-actor'); await tick(); assert.equal(f.owner.pending, 255);
  ready = true;
  assert.equal((await f.owner.run(request(), () => Response.json({ ok: true }))).status, 200);
  assert.equal(calls, 258); assert.equal(f.owner.pending, 255);
  for (const gate of gates.slice(1)) gate.resolve('PRIVATE-actor');
  await f.owner.close(); assert.equal(f.owner.pending, 0); f.redacted();
});

test('diagnostic failures cannot deny a valid read or authorize a refused one', async () => {
  const diagnostics = new PerformanceDiagnostics(() => { throw Error('PRIVATE observer'); });
  for (const actor of ['PRIVATE-actor', undefined]) {
    const owner = new SessionReadAuthority(async () => actor, diagnostics, 20);
    const response = await owner.run(request(), () => Response.json({ ok: true }));
    assert.equal(response.status, actor ? 200 : 403); await owner.close();
  }
});

for (const ending of ['timeout', 'abort'] as const) for (const late of [false, true])
  test(`stream ${ending}, ${late ? 'late source' : 'final authorization'}: bounded waiter retains slow cancel ACK`, { timeout: 3000 }, async () => {
    const source = held<void>(), observation = held<void>(), cancel = held<void>(), cancelling = held<void>();
    const entered = held<void>(), controller = new AbortController(); let calls = 0, cancels = 0, drained = false;
    const f = fixture(async () => { if (++calls === 2) { entered.resolve(); await observation.promise; } return 'PRIVATE-actor'; }, 30);
    const pending = f.owner.run(request(controller.signal), async () => {
      if (late) { entered.resolve(); await source.promise; }
      return new Response('PRIVATE response');
    }, async () => { cancels++; cancelling.resolve(); await cancel.promise; });
    await entered.promise;
    if (ending === 'abort') controller.abort();
    assert.equal((await pending).status, ending === 'abort' ? 408 : 503);
    if (late) source.resolve(); else observation.resolve();
    await cancelling.promise;
    const closing = f.owner.close().then(() => { drained = true; });
    await tick(); assert.equal(drained, false); assert.equal(cancels, 1);
    cancel.resolve(); await closing;
    assert.equal(drained, true); assert.equal(f.owner.pending, 0); assert.equal(cancels, 1); f.redacted();
  });

test('failed stream discard fails shutdown generically without leaking its private source error', async () => {
  let calls = 0;
  const f = fixture(() => ++calls === 1 ? 'PRIVATE-actor' : undefined);
  const response = await f.owner.run(request(), () => new Response('PRIVATE response'), async () => { throw Error('PRIVATE stream token'); });
  assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /PRIVATE|token/);
  await assert.rejects(f.owner.close(), { message: 'auth_persistence_failed' }); f.redacted();
});
