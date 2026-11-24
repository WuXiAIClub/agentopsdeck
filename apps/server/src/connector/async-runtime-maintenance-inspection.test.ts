import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createAsyncRuntimeMaintenanceInspection } from './async-runtime-maintenance-inspection.js';

function gate() { let release!: () => void; return { promise: new Promise<void>(r => { release = r; }), release: () => release() }; }
function fixture(t: TestContext, extraSdk: { inspectMaintenance(): Promise<{
  nativeWorkers: number; admissionInFlight: number; startupWorkers: number; assertCurrent(): void;
}> }[] = []) {
  const calls: string[] = [];
  let paused = false, stopped = false, unsupported = false, nativeCurrent = true, sdkCurrent = true;
  let fence: string | undefined;
  let statusHook: (() => void) | undefined, durableHook: (() => Promise<void>) | undefined;
  const authority = async () => { calls.push('authority'); };
  const inspection = createAsyncRuntimeMaintenanceInspection({
    nodeId: 'original-node',
    updateService: { maintenanceStatus: async authorize => {
      await authorize?.(); calls.push('status'); statusHook?.();
      return { state: paused ? 'paused' : 'released', ...(fence ? { fenceId: fence } : {}), boundary: 'admission_only', nativeQuiescent: false };
    } },
    codex: { inspectMaintenanceAsync: async (authorize, local) => {
      local(); await authorize(); local(); calls.push('native');
      return { activeRuns: 2, backgroundTerminals: 3, inFlightWrites: 5,
        assertCurrent() { if (!nativeCurrent) throw Error('Native changed'); } };
    } },
    sdk: [{ inspectMaintenance: async () => {
      calls.push('sdk'); return { nativeWorkers: 7, admissionInFlight: 11, startupWorkers: 13,
        assertCurrent() { if (!sdkCurrent) throw Error('SDK changed'); } };
    } }, ...extraSdk],
    persistence: { command: (async (kind: string, input: unknown, check: () => void) => {
      assert.equal(kind, 'runtimeMaintenanceObserve'); assert.deepEqual(input, { historyRecovery: false });
      assert.equal(check(), undefined, 'persistence guard is synchronous local ownership, never worker permission');
      calls.push('durable'); await durableHook?.(); check();
      return { nodeId: 'original-node', pendingExecutions: 17, queuedMessages: 19 };
    }) as any },
    requests: { isStopping: () => stopped, isPaused: () => paused, activeWrites: () => 23 },
    unsupportedNative: () => unsupported, probes: () => 29,
  });
  t.after(() => inspection.close());
  return { calls, inspection, authority, pause() { paused = true; fence = 'original-fence'; },
    stop() { stopped = true; }, unsupported() { unsupported = true; },
    invalidateNative() { nativeCurrent = false; }, invalidateSdk() { sdkCurrent = false; },
    status(fn: () => void) { statusHook = fn; }, durable(fn: () => Promise<void>) { durableHook = fn; } };
}

test('original status/native/SDK/durable/status sequence preserves complete counts and final local proof', async t => {
  const f = fixture(t); f.pause();
  const result = await f.inspection.inspect(f.authority, () => {});
  assert.deepEqual(f.calls.filter(c => c !== 'authority'), ['status', 'native', 'sdk', 'durable', 'status']);
  assert.equal(result.activeRuns, 9); assert.equal(result.backgroundTerminals, 3);
  assert.equal(result.pendingExecutions, 17); assert.equal(result.queuedMessages, 19);
  assert.equal(result.inFlightWrites, 81); assert.equal(result.fenceId, 'original-fence');
  assert.equal(result.nativeVerified, true); result.assertCurrent();
  f.invalidateSdk(); assert.throws(result.assertCurrent, /SDK changed/);
});

for (const changed of ['native', 'SDK', 'fence', 'stopping'] as const) {
  test(`final status await invalidates ${changed} before an idle proof can escape`, async t => {
    const f = fixture(t); let statuses = 0;
    f.status(() => { if (++statuses !== 2) return;
      if (changed === 'native') f.invalidateNative();
      if (changed === 'SDK') f.invalidateSdk();
      if (changed === 'fence') f.pause();
      if (changed === 'stopping') f.stop();
    });
    await assert.rejects(f.inspection.inspect(f.authority, () => {}));
  });
}

test('unsupported native runtimes fail closed before status/native/database effects', async t => {
  const f = fixture(t); f.unsupported();
  await assert.rejects(f.inspection.inspect(f.authority, () => {})); assert.deepEqual(f.calls, []);
});

test('durable failure cannot produce a proof or run final status', async t => {
  const f = fixture(t); f.durable(async () => { throw Error('PRIVATE database detail'); });
  await assert.rejects(f.inspection.inspect(f.authority, () => {}));
  assert.equal(f.calls.filter(c => c === 'status').length, 1);
});

test('shutdown retains a physically pending durable read and rejects late observations and new callers', async t => {
  const f = fixture(t), entered = gate(), held = gate(); let closed = false;
  f.durable(async () => { entered.release(); await held.promise; });
  const work = f.inspection.inspect(f.authority, () => {}); void work.catch(() => {});
  await entered.promise;
  const closing = f.inspection.close().then(() => { closed = true; });
  try {
    await new Promise<void>(r => setImmediate(r)); assert.equal(closed, false);
    await assert.rejects(f.inspection.inspect(f.authority, () => {}));
    held.release(); await assert.rejects(work); await closing;
  } finally { held.release(); await Promise.allSettled([work, closing]); }
});

test('last authority await cannot conceal local native activity changes', async t => {
  const f = fixture(t);
  await assert.rejects(f.inspection.inspect(async () => {
    if (f.calls.filter(c => c === 'status').length === 2) f.invalidateNative();
  }, () => {}), /Native changed/);
});

for (const synchronous of [false, true]) {
  test(`SDK ${synchronous ? 'synchronous throw' : 'rejection'} retains pending siblings through shutdown`, async t => {
    const entered = gate(), held = gate();
    const failure = Error('SDK inspection unavailable');
    const f = fixture(t, [
      { inspectMaintenance() { if (synchronous) throw failure; return Promise.reject(failure); } },
      { async inspectMaintenance() { entered.release(); await held.promise;
        return { nativeWorkers: 0, admissionInFlight: 0, startupWorkers: 0, assertCurrent() {} };
      } },
    ]);
    let settled = false, closed = false;
    const work = f.inspection.inspect(f.authority, () => {});
    void work.then(() => { settled = true; }, () => { settled = true; });
    await entered.promise;
    const closing = f.inspection.close().then(() => { closed = true; });
    try {
      await new Promise<void>(r => setImmediate(r));
      assert.equal(settled, false); assert.equal(closed, false);
      assert.equal(f.calls.includes('durable'), false);
      held.release(); await assert.rejects(work, error => error === failure); await closing;
      assert.equal(closed, true);
      assert.equal(f.calls.includes('durable'), false);
    } finally { held.release(); await Promise.allSettled([work, closing]); }
  });
}
