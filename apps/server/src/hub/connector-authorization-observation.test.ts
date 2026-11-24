import assert from 'node:assert/strict';
import test from 'node:test';
import { connectorAuthorization } from './connector-authorization.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const quiet = () => new PerformanceDiagnostics(() => {});

test('synchronous preflight remains single invocation and preserves thrown error identity', async () => {
  let calls = 0; const signal = new AbortController().signal, error = Error('denied');
  await connectorAuthorization(() => { calls++; }, signal, quiet());
  await assert.rejects(connectorAuthorization(() => { calls++; throw error; }, signal, quiet()), e => e === error);
  assert.equal(calls, 2);
});

test('pre-aborted authorization does not start diagnostics or authority work', async () => {
  const abort = new AbortController(); abort.abort(Error('cancelled')); let calls = 0;
  const diagnostics = { start() { calls++; throw Error('must not start'); } } as unknown as PerformanceDiagnostics;
  await assert.rejects(connectorAuthorization(() => { calls++; }, abort.signal, diagnostics), /cancelled/);
  assert.equal(calls, 0);
});

for (const lateOutcome of ['resolve', 'reject'] as const) {
  test(`cancelled pending preflight observes late ${lateOutcome} without a second finish`, async () => {
    let resolve!: () => void, reject!: (reason: Error) => void;
    const original = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const abort = new AbortController(), diagnostics = quiet();
    const pending = connectorAuthorization(() => original, abort.signal, diagnostics);
    const stopped = assert.rejects(pending, /cancelled/); abort.abort(Error('cancelled')); await stopped;
    assert.equal(diagnostics.snapshot().totals.finished, 1);
    if (lateOutcome === 'resolve') resolve(); else reject(Error('late-private-failure'));
    await tick(); assert.equal(diagnostics.snapshot().totals.finished, 1);
  });
}

test('a never-settling preflight is bounded by the original transport deadline signal', async () => {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(Error('Deadline exceeded')), 5);
  try { await assert.rejects(connectorAuthorization(() => new Promise<void>(() => {}), abort.signal, quiet()), /Deadline/); }
  finally { clearTimeout(timer); }
});

test('abort triggered by authority completion wins before delivery', async () => {
  const abort = new AbortController();
  await assert.rejects(connectorAuthorization(async () => { abort.abort(Error('cancelled')); }, abort.signal, quiet()), /cancelled/);
});

test('Promise assimilation errors are authority failures, not grants', async () => {
  const error = Error('private-then-getter');
  const invalid = Object.defineProperty({}, 'then', { get() { throw error; } });
  await assert.rejects(connectorAuthorization(() => invalid as Promise<void>, new AbortController().signal, quiet()), e => e === error);
});

for (const outcome of ['grant', 'deny', 'abort'] as const) {
  test(`abort listener removed after ${outcome}`, async () => {
    const abort = new AbortController(); let added = 0, removed = 0;
    const add = abort.signal.addEventListener.bind(abort.signal), remove = abort.signal.removeEventListener.bind(abort.signal);
    abort.signal.addEventListener = (...args: Parameters<AbortSignal['addEventListener']>) => { added++; add(...args); };
    abort.signal.removeEventListener = (...args: Parameters<AbortSignal['removeEventListener']>) => { removed++; remove(...args); };
    const pending = connectorAuthorization(() => {
      if (outcome === 'deny') throw Error('denied');
      if (outcome === 'abort') return new Promise<void>(() => {});
    }, abort.signal, quiet());
    if (outcome === 'grant') await pending;
    else {
      const stopped = assert.rejects(pending, outcome === 'deny' ? /denied/ : /cancelled/);
      if (outcome === 'abort') abort.abort(Error('cancelled'));
      await stopped;
    }
    assert.equal(added, 1); assert.equal(removed, 1);
  });
}

for (const failure of ['start', 'pending', 'add', 'finish'] as const) {
  for (const outcome of ['grant', 'deny', 'abort'] as const) {
    test(`diagnostic ${failure} failure never changes authority ${outcome}`, async () => {
      let calls = 0; const error = Error('original-denial'), abort = new AbortController();
      const diagnostics = { start() {
        if (failure === 'start') throw Error('private-start');
        return { reportPending() { if (failure === 'pending') throw Error('private-pending'); },
          add() { if (failure === 'add') throw Error('private-add'); },
          finish() { if (failure === 'finish') throw Error('private-finish'); } };
      } } as unknown as PerformanceDiagnostics;
      const pending = connectorAuthorization(() => {
        calls++; if (outcome === 'deny') throw error;
        if (outcome === 'abort') return new Promise<void>(() => {});
      }, abort.signal, diagnostics);
      if (outcome === 'grant') await pending;
      else {
        const stopped = assert.rejects(pending, e => e === error);
        if (outcome === 'abort') abort.abort(error);
        await stopped;
      }
      assert.equal(calls, 1);
    });
  }
}

test('numeric preflight logs distinguish pending, granted, denied and cancelled without private payloads', async () => {
  const rows: Record<string, unknown>[] = [], d = new PerformanceDiagnostics(line => rows.push(JSON.parse(line)), () => 0);
  await connectorAuthorization(() => {}, new AbortController().signal, d);
  await assert.rejects(connectorAuthorization(async () => { throw Error('PRIVATE cookie token URL SQL'); }, new AbortController().signal, d));
  const abort = new AbortController();
  const cancelled = assert.rejects(connectorAuthorization(() => new Promise<void>(() => {}), abort.signal, d));
  abort.abort(Error('PRIVATE cancellation')); await cancelled;
  const final = rows.filter(row => row.phase === 'finished');
  assert.equal(final.length, 3); assert.equal(final[0]!.settled, 1);
  assert.equal(final[1]!.category, 'failed'); assert.equal(final[2]!.deferred, 1);
  assert.ok(final.every(row => row.pending === 0 && row.operation === 'hub-request-authority'));
  assert.ok(!rows.some(row => row.phase === 'pending'), 'quick checks must not consume the recovery warning ring');
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE|cookie|token|URL|SQL/);
});

test('only a prolonged authority wait reports pending and cancellation clears its warning timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const rows: Record<string, unknown>[] = [], diagnostics = new PerformanceDiagnostics(line => rows.push(JSON.parse(line)), () => 0);
  const abort = new AbortController();
  const denied = assert.rejects(connectorAuthorization(() => new Promise<void>(() => {}), abort.signal, diagnostics), /cancelled/);
  t.mock.timers.tick(29_999);
  assert.ok(!rows.some(row => row.phase === 'pending'));
  t.mock.timers.tick(1);
  assert.equal(rows.filter(row => row.phase === 'pending' && row.pending === 1).length, 1);
  abort.abort(Error('cancelled')); await denied;
  t.mock.timers.tick(60_000);
  assert.equal(rows.filter(row => row.phase === 'pending').length, 1);
  assert.equal(diagnostics.snapshot().totals.finished, 1);
});

test('a throwing prolonged-wait observer cannot settle authority or escape its timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0, warnings = 0, finishes = 0, grant!: () => void;
  const diagnostics = { start() { return {
    reportPending() { warnings++; throw Error('private observer failure'); },
    add() {}, finish() { finishes++; },
  }; } } as unknown as PerformanceDiagnostics;
  const pending = connectorAuthorization(() => { calls++; return new Promise<void>(resolve => { grant = resolve; }); },
    new AbortController().signal, diagnostics);
  t.mock.timers.tick(30_000);
  assert.equal(warnings, 1); assert.equal(finishes, 0); assert.equal(calls, 1);
  grant(); await pending;
  t.mock.timers.tick(60_000);
  assert.equal(warnings, 1); assert.equal(finishes, 1); assert.equal(calls, 1);
});
