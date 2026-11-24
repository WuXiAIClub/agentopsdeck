import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { AuthPersistenceError } from './private-store.js';
import { AuthRoutePersistence } from './route-persistence.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

for (const outcome of ['resolve', 'reject'] as const) test(`close retains the original until late ${outcome}`, async () => {
  const diagnostics = new PerformanceDiagnostics(() => {}), owner = new AuthRoutePersistence(diagnostics, 2);
  const gate = deferred<void>(); let calls = 0, closed = false;
  const original = owner.run(5, () => { calls++; return gate.promise; });
  const observed = Promise.allSettled([original]);
  const closing = owner.close();
  void closing.then(() => { closed = true; });
  assert.equal(owner.close(), closing);
  await assert.rejects(owner.run(5, () => { calls++; }), AuthPersistenceError);
  await delay(12);
  assert.equal(closed, false); assert.equal(owner.pending, 1); assert.equal(calls, 1);
  assert.ok(diagnostics.snapshot().events.some(event => event.step === 73 && event.phase === 'pending'));
  if (outcome === 'resolve') gate.resolve(); else gate.reject(Error('PRIVATE late rejection'));
  await observed; await closing;
  assert.equal(closed, true); assert.equal(owner.pending, 0);
  await assert.rejects(owner.run(1, () => { calls++; }), AuthPersistenceError);
  assert.equal(calls, 1); assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), /PRIVATE/);
});

test('diagnostic reentrant close reserves and drains admission without dispatch', async () => {
  let owner!: AuthRoutePersistence, armed = false, closing: Promise<void> | undefined, calls = 0;
  const diagnostics = new PerformanceDiagnostics(() => {}, () => {
    if (armed) { armed = false; closing = owner.close(); }
    return performance.now();
  });
  owner = new AuthRoutePersistence(diagnostics);
  armed = true;
  await assert.rejects(owner.run(3, () => { calls++; }), AuthPersistenceError);
  assert.ok(closing); await closing;
  assert.equal(calls, 0); assert.equal(owner.pending, 0); assert.equal(owner.close(), closing);
  assert.equal(diagnostics.snapshot().events.some(event => event.unknown === 1), false);
});

test('close latches its promise before lifecycle diagnostics can reenter', async () => {
  let owner!: AuthRoutePersistence, armed = false, nested: Promise<void> | undefined;
  const diagnostics = new PerformanceDiagnostics(() => {}, () => {
    if (armed) { armed = false; nested = owner.close(); }
    return performance.now();
  });
  owner = new AuthRoutePersistence(diagnostics); armed = true;
  const closing = owner.close();
  assert.equal(nested, closing); await closing;
  assert.equal(owner.pending, 0);
});

test('close invoked inside dispatched work waits for that same original', async () => {
  const owner = new AuthRoutePersistence(new PerformanceDiagnostics(() => {})), gate = deferred<void>();
  let closing: Promise<void> | undefined, closed = false;
  const original = owner.run(4, () => {
    closing = owner.close(); void closing.then(() => { closed = true; }); return gate.promise;
  });
  await delay(1); assert.equal(closed, false); assert.equal(owner.pending, 1);
  gate.resolve(); await original; await closing;
  assert.equal(closed, true); assert.equal(owner.pending, 0);
});

test('route persistence preserves synchronous false and boxes its original result', async () => {
  const owner = new AuthRoutePersistence(new PerformanceDiagnostics(() => {}));
  assert.equal((await owner.run(3, () => false)).value, false);
  assert.equal((await owner.run(4, () => undefined)).value, undefined);
  assert.equal(owner.pending, 0);
});

test('pending warning neither settles nor releases nor replays the original route owner', async () => {
  const diagnostics = new PerformanceDiagnostics(() => {}), owner = new AuthRoutePersistence(diagnostics, 2);
  const original = deferred<boolean>();
  let calls = 0, settled = false;
  const pending = owner.run(3, () => { calls++; return original.promise; });
  void pending.then(() => { settled = true; });
  await delay(12);
  assert.equal(owner.pending, 1); assert.equal(calls, 1); assert.equal(settled, false);
  const event = diagnostics.snapshot().events.find(e => e.phase === 'pending')!;
  assert.equal(event.step, 3); assert.equal(event.pending, 1); assert.equal(event.settled, undefined);
  original.resolve(false); assert.equal((await pending).value, false);
  assert.equal(owner.pending, 0); assert.equal(calls, 1);
  assert.ok(diagnostics.snapshot().events.some(e => e.phase === 'finished' && e.settled === 1));
});

test('all 256 pending attempts are bounded before invoking an excess persistence owner', async () => {
  const diagnostics = new PerformanceDiagnostics(() => {}), owner = new AuthRoutePersistence(diagnostics);
  const original = deferred<void>();
  const calls = Array.from({ length: 256 }, () => owner.run(4, () => original.promise));
  let excess = 0;
  try {
    await assert.rejects(owner.run(4, () => { excess++; }), AuthPersistenceError);
    assert.equal(excess, 0); assert.equal(owner.pending, 256);
    const event = diagnostics.snapshot().events.find(e => e.deferred === 1)!;
    assert.equal(event.pending, 256); assert.equal(event.unknown, undefined);
  } finally { original.resolve(); await Promise.all(calls); }
  assert.equal(owner.pending, 0);
});

for (const kind of ['sync-throw', 'rejection', 'revoked-proxy', 'throwing-then'] as const)
  test(`route persistence ${kind} is sanitized, observed, and never replayed`, async () => {
    const diagnostics = new PerformanceDiagnostics(() => { throw Error('private-sink'); });
    const owner = new AuthRoutePersistence(diagnostics);
    let calls = 0;
    await assert.rejects(owner.run(5, () => {
      calls++;
      if (kind === 'sync-throw') throw Error('private-path-and-token');
      if (kind === 'rejection') return Promise.reject(Error('private-path-and-token'));
      if (kind === 'revoked-proxy') {
        const proxy = Proxy.revocable({}, {}); proxy.revoke(); return Promise.reject(proxy.proxy);
      }
      return Object.defineProperty({}, 'then', { get() { throw Error('private-then'); } });
    }), error => error instanceof AuthPersistenceError && error.message === 'auth_persistence_failed');
    assert.equal(calls, 1); assert.equal(owner.pending, 0);
    const event = diagnostics.snapshot().events[0]!;
    assert.equal(event.unknown, 1); assert.equal(event.step, 5); assert.equal(event.delivery, 'failed');
    assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), /private-|token|path/);
  });

test('result boxing prevents second then inspection outside the persistence catch', async () => {
  const owner = new AuthRoutePersistence(new PerformanceDiagnostics(() => {}));
  let inspected = 0;
  const value = Object.defineProperty({}, 'then', { get() {
    if (++inspected > 1) throw Error('private-second-inspection');
    return undefined;
  } });
  const result = await owner.run(1, () => value);
  assert.equal(result.value, value); assert.equal(inspected, 1); assert.equal(owner.pending, 0);
});

test('reentrant persistence invocation still cannot overfill admitted attempts', async () => {
  const owner = new AuthRoutePersistence(new PerformanceDiagnostics(() => {})), original = deferred<void>();
  const calls = Array.from({ length: 255 }, () => owner.run(1, () => original.promise));
  let refused: Promise<unknown> | undefined, extra = 0;
  calls.push(owner.run(1, () => {
    refused = assert.rejects(owner.run(1, () => { extra++; }), AuthPersistenceError);
    return original.promise;
  }));
  try { await refused; assert.equal(extra, 0); assert.equal(owner.pending, 256); }
  finally { original.resolve(); await Promise.all(calls); }
});

test('warning configuration cannot disable the bounded observation contract', () => {
  for (const value of [0, -1, NaN, Infinity, 1.5, 2_147_483_648])
    assert.throws(() => new AuthRoutePersistence(undefined, value), AuthPersistenceError);
});

test('original last slot is reserved before the diagnostic clock can reenter', async () => {
  let armed = false, nested: Promise<unknown> | undefined, originalCalls = 0, nestedCalls = 0;
  let owner!: AuthRoutePersistence;
  const held = deferred<void>();
  const diagnostics = new PerformanceDiagnostics(() => {}, () => {
    if (armed) {
      armed = false;
      nested = owner.run(6, () => { nestedCalls++; return held.promise; });
      void nested.catch(() => {});
    }
    return performance.now();
  });
  owner = new AuthRoutePersistence(diagnostics);
  const accepted = Array.from({ length: 255 }, () => owner.run(6, () => held.promise));
  armed = true;
  const original = owner.run(6, () => { originalCalls++; return held.promise; });
  void original.catch(() => {});
  try {
    assert.equal(armed, false); assert.equal(originalCalls, 1); assert.equal(nestedCalls, 0);
    assert.ok(nested); await assert.rejects(nested, AuthPersistenceError);
    assert.equal(owner.pending, 256);
    // A trace made inside its own clock has no valid start time. Do not
    // fabricate elapsed time merely to retain that recursive observation.
    assert.equal(diagnostics.snapshot().events.some(e => e.deferred === 1), false);
    // Outside the clock fence, the same capacity refusal remains observable.
    await assert.rejects(owner.run(6, () => { nestedCalls++; return held.promise; }), AuthPersistenceError);
    assert.equal(nestedCalls, 0); assert.equal(owner.pending, 256);
    const refusal = diagnostics.snapshot().events.find(e => e.deferred === 1);
    assert.ok(refusal);
    assert.equal(refusal.pending, 256); assert.equal(refusal.unknown, undefined);
  } finally { held.resolve(); await Promise.allSettled([...accepted, original, nested!]); }
  assert.equal(owner.pending, 0);
});
