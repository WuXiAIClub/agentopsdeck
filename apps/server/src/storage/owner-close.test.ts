import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import { createStorageOwnerClose } from './owner-close.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const silent = () => new PerformanceDiagnostics(() => {});

for (const method of ['start', 'add', 'finish'] as const) {
  test(`throwing diagnostic ${method} cannot strand the original close or replace its error`, async t => {
    const diagnostics = silent(), original = Error('original-close-error');
    const start = diagnostics.start.bind(diagnostics);
    t.mock.method(diagnostics, 'start', (...args: Parameters<typeof start>) => {
      if (method === 'start') throw Error('observer-start');
      const trace = start(...args);
      t.mock.method(trace, method, () => { throw Error('observer-' + method); });
      return trace;
    });
    let drains = 0, closes = 0;
    const close = createStorageOwnerClose([() => { drains++; }], () => {
      if (++closes === 1) throw original;
    }, diagnostics);
    assert.throws(() => close(), error => error === original);
    assert.deepEqual(close.snapshot(), { state: 'close-required', active: false, pending: 0, attempts: 1 });
    assert.equal(close(), undefined);
    assert.equal(drains, 1); assert.equal(closes, 2);
    assert.equal(close.snapshot().state, 'closed'); assert.equal(close.snapshot().active, false);
    const drain = gate(); let asyncCloses = 0;
    const asyncClose = createStorageOwnerClose([() => drain.promise], () => { asyncCloses++; }, diagnostics);
    const pending = asyncClose(); assert.equal(asyncClose(), pending); assert.equal(asyncCloses, 0);
    drain.resolve(); await pending;
    assert.equal(asyncCloses, 1); assert.equal(asyncClose.snapshot().active, false);
  });
}

test('throwing pending diagnostic cannot authorize close or lose its original drain promise', async t => {
  const diagnostics = silent(), start = diagnostics.start.bind(diagnostics), drain = gate();
  let reports = 0, closes = 0;
  t.mock.method(diagnostics, 'start', (...args: Parameters<typeof start>) => {
    const trace = start(...args);
    t.mock.method(trace, 'reportPending', () => { reports++; throw Error('observer-pending'); });
    return trace;
  });
  const close = createStorageOwnerClose([() => drain.promise], () => { closes++; }, diagnostics, 1000);
  const pending = close();
  try {
    await wait(1100); assert.equal(reports, 1); assert.equal(closes, 0); assert.equal(close(), pending);
    assert.equal(close.snapshot().pending, 1);
  } finally { drain.resolve(); await pending; }
  assert.equal(closes, 1); assert.equal(close.snapshot().state, 'closed');
});
function gate() {
  let resolve!: () => void, reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('idle database owner closes synchronously and never repeats acknowledged cleanup', () => {
  let stopped = 0, closed = 0;
  const close = createStorageOwnerClose([() => { stopped++; }], () => { closed++; }, silent());
  assert.equal(close(), undefined); assert.equal(close(), undefined);
  assert.equal(stopped, 1); assert.equal(closed, 1);
  assert.deepEqual(close.snapshot(), { state: 'closed', active: false, pending: 0, attempts: 1 });
});

test('independent original drains all start before waiting; timeout never releases the connection', async () => {
  const first = gate(), second = gate(); const started: number[] = [], logs: any[] = [];
  let closed = 0;
  const close = createStorageOwnerClose([
    () => { started.push(1); return first.promise; },
    () => { started.push(2); return second.promise; },
  ], () => { closed++; }, new PerformanceDiagnostics(line => logs.push(JSON.parse(line))), 1000);
  const pending = close();
  assert.deepEqual(started, [1, 2]); assert.equal(close(), pending);
  assert.equal(close.snapshot().pending, 2);
  try {
    await wait(1100);
    assert.equal(closed, 0); assert.equal(close(), pending);
    assert.ok(logs.some(row => row.operation === 'storage-owner-close' && row.phase === 'pending' && row.pending === 2));
    first.resolve(); await first.promise; await wait(0);
    assert.equal(closed, 0); assert.equal(close.snapshot().pending, 1);
    second.resolve(); await pending;
    assert.equal(closed, 1); assert.equal(close.snapshot().state, 'closed');
  } finally { first.resolve(); second.resolve(); await pending; }
});

for (const mode of ['throw', 'reject'] as const) test(`failed original ${mode} drain is retained, does not suppress another lane or authorize close`, async () => {
  const other = gate(), original = new Proxy({}, { get() { throw Error('private-error-getter'); } });
  let stops = 0, closed = 0;
  const logs: any[] = [];
  const close = createStorageOwnerClose([
    () => { stops++; if (mode === 'throw') throw original; return Promise.reject(original); },
    () => { stops++; return other.promise; },
  ], () => { closed++; }, new PerformanceDiagnostics(line => logs.push(JSON.parse(line))));
  const pending = close();
  // Node's assert.rejects itself reads properties of arbitrary rejections.
  // Box the original error, as production observation does, before comparing.
  const failed = Promise.resolve(pending).then(() => ({ error: undefined }), error => ({ error }));
  assert.equal(stops, 2); assert.equal(closed, 0); assert.equal(close(), pending);
  other.resolve(); assert.equal((await failed).error, original);
  assert.equal(close.snapshot().state, 'drain-failed');
  let caught: { error: unknown } | undefined;
  try { close(); } catch (error) { caught = { error }; }
  assert.equal(caught?.error, original);
  assert.equal(stops, 2); assert.equal(closed, 0);
  assert.equal(logs.at(-1).unknown, 1); assert.doesNotMatch(JSON.stringify(logs), /private-error-getter/);
});

test('close failure retries only the exact original connection after acknowledged drains', async () => {
  const drained = gate(), original = Error('private-close-failure');
  let stops = 0, closes = 0;
  const close = createStorageOwnerClose([() => { stops++; return drained.promise; }], () => {
    closes++; if (closes === 1) throw original;
  }, silent());
  const first = close(), failed = assert.rejects(Promise.resolve(first), error => error === original);
  drained.resolve(); await failed;
  assert.equal(close.snapshot().state, 'close-required');
  assert.equal(close(), undefined); assert.equal(close(), undefined);
  assert.equal(stops, 1); assert.equal(closes, 2); assert.equal(close.snapshot().state, 'closed');
});

test('synchronous close failure preserves its throw and retries without rerunning drains', () => {
  let stops = 0, closes = 0; const original = Error('private-close');
  const close = createStorageOwnerClose([() => { stops++; }], () => { if (++closes === 1) throw original; }, silent());
  assert.throws(() => close(), error => error === original);
  assert.equal(close.snapshot().state, 'close-required');
  close(); assert.equal(stops, 1); assert.equal(closes, 2);
});

test('reentrant drain and output sink share the original close attempt', async () => {
  const captured: { reentrant?: void | Promise<void>; observed?: void | Promise<void> } = {};
  let closes = 0;
  const close = createStorageOwnerClose([() => { captured.reentrant = close(); }], () => { closes++; },
    new PerformanceDiagnostics(() => { captured.observed = close(); }));
  assert.equal(close(), undefined);
  assert.ok(captured.reentrant instanceof Promise); assert.equal(captured.observed, captured.reentrant);
  await captured.reentrant; assert.equal(closes, 1);
});

test('untrusted acknowledgement is refused without reading a then getter or closing SQL', () => {
  let reads = 0, closed = 0;
  const thenable = { get then() { reads++; throw Error('private-then'); } };
  const close = createStorageOwnerClose([(() => thenable) as any], () => { closed++; }, silent());
  assert.throws(() => close(), /Invalid storage drain acknowledgement/);
  assert.equal(reads, 0); assert.equal(closed, 0);
  assert.equal(close.snapshot().state, 'drain-failed');
});

test('a malformed asynchronous drain ACK cannot authorize original connection close', async () => {
  let closed = 0;
  const close = createStorageOwnerClose([(() => Promise.resolve(42)) as any], () => { closed++; }, silent());
  await assert.rejects(Promise.resolve(close()), /Invalid storage drain acknowledgement/);
  assert.equal(closed, 0); assert.equal(close.snapshot().state, 'drain-failed');
  assert.throws(() => close(), /Invalid storage drain acknowledgement/);
  assert.equal(closed, 0);
});

test('native drain observation does not read replaceable then or finally accessors', async () => {
  const original = gate(); let reads = 0, closed = 0;
  for (const name of ['then', 'finally']) Object.defineProperty(original.promise, name, {
    get() { reads++; throw Error('private-drain-accessor'); },
  });
  const close = createStorageOwnerClose([() => original.promise], () => { closed++; }, silent());
  const pending = close();
  assert.equal(closed, 0); assert.equal(reads, 0);
  original.resolve(); await pending;
  assert.equal(closed, 1); assert.equal(reads, 0);
  assert.equal(close.snapshot().pending, 0);
});

test('unobservable native drain remains failed without replay or closing the original connection', async () => {
  const original = gate(), failure = Error('private-species'); let stops = 0, closes = 0;
  Object.defineProperty(original.promise, 'constructor', { get() { throw failure; } });
  const close = createStorageOwnerClose([() => { stops++; return original.promise; }], () => { closes++; }, silent());
  await assert.rejects(Promise.resolve(close()), error => error === failure);
  assert.equal(close.snapshot().state, 'drain-failed'); assert.equal(close.snapshot().pending, 0);
  original.resolve(); await wait(0);
  assert.throws(() => close(), error => error === failure);
  assert.equal(stops, 1); assert.equal(closes, 0);
});

test('async connection close is refused before invocation; unknown returned close is never replayed', async () => {
  let closes = 0;
  assert.throws(() => createStorageOwnerClose([], async () => { closes++; }, silent()), /configuration/);
  assert.equal(closes, 0);
  const close = createStorageOwnerClose([], (() => { closes++; return Promise.reject(Error('private-late-close')); }) as any, silent());
  assert.throws(() => close(), /Invalid storage close acknowledgement/);
  assert.equal(close.snapshot().state, 'close-outcome-unknown');
  await wait(0);
  assert.throws(() => close(), /Invalid storage close acknowledgement/);
  assert.equal(closes, 1);
});

test('sink failure cannot replace cleanup, drain error, or original close error', () => {
  const diagnostics = new PerformanceDiagnostics(() => { throw Error('private-sink'); });
  let closes = 0; const original = Error('private-close');
  const close = createStorageOwnerClose([], () => { if (++closes === 1) throw original; }, diagnostics);
  assert.throws(() => close(), error => error === original);
  close(); assert.equal(closes, 2); assert.equal(close.snapshot().state, 'closed');
  assert.ok(diagnostics.snapshot().totals.sinkFailures > 0);
});
