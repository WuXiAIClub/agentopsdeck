import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentReadiness } from '@agentopsdeck/shared';
import { AsyncSdkConnectorRuntime } from './async-sdk-connector-runtime.js';
import { ConnectorAgentRuntimes } from './agent-runtimes.js';
import type { SdkAgentId } from './sdk-execution-journal.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { captureMaintenanceFacts } from './maintenance-facts.js';

function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const silence = new PerformanceDiagnostics(() => {});
const sanitized = (error: unknown) => error instanceof Error && !error.message.includes('PRIVATE');
function owned(id: SdkAgentId) {
  const calls = { initialized: 0, closed: 0, paused: 0, resumed: 0, history: 0, directory: 0 };
  const facts = { ownershipHeld: true, cleanupUnconfirmed: false, closed: false, faulted: false, nativeWorkers: 0 };
  let initialized = false, paused = false;
  const original = { id,
    get ready() { return initialized && !paused && !facts.closed && !facts.faulted; },
    get status(): AgentReadiness { return facts.closed ? 'closed' : facts.faulted ? 'failed' : paused ? 'maintenance' : initialized ? 'ready' : 'starting'; },
    async initialize() { calls.initialized++; initialized = true; return original.ready; },
    async refreshSession() { calls.history++; }, async refreshDirectory() { calls.directory++; },
    async refreshProjection() { calls.directory++; calls.history++; },
    isSessionHistoryReady() { return true; }, async inspectMaintenance() { return captureMaintenanceFacts(() => ({ ...facts })); },
    pauseQueueWorker() { calls.paused++; paused = true; return { drained: Promise.resolve(), resume: () => { calls.resumed++; paused = false; return true; } }; },
    async close() { calls.closed++; facts.closed = true; },
  };
  return { original, calls, facts };
}

for (const id of ['claude-code', 'ghcp'] as const) {
  test(`${id}: maintenance preparation retains the original owner without claiming native readiness`, async () => {
    const f = owned(id), held = gate(), entered = gate(); let created = 0;
    const runtime = new AsyncSdkConnectorRuntime(id, async () => { created++; entered.release(); await held.promise; return f.original; }, silence);
    const pause = runtime.pauseQueueWorker();
    const preparing = runtime.whenPrepared(); await entered.promise;
    assert.equal(runtime.ready, false); assert.equal(f.calls.initialized, 0);
    held.release(); await preparing;
    assert.equal(created, 1); assert.equal(f.calls.initialized, 0); assert.equal(runtime.status, 'maintenance');
    await assert.rejects(runtime.whenStarted(), sanitized);
    await runtime.refreshProjection(); (await runtime.inspectMaintenance()).assertCurrent();
    assert.equal(pause.resume(), true); await runtime.whenStarted();
    assert.equal(created, 1); assert.equal(f.calls.initialized, 1); assert.equal(runtime.ready, true);
    await runtime.close();
  });

  test(`${id}: preparation cannot hide original owner failure under a maintenance lease`, async () => {
    const f = owned(id), runtime = new AsyncSdkConnectorRuntime(id, async () => f.original, silence);
    const pause = runtime.pauseQueueWorker(); f.facts.faulted = true;
    await assert.rejects(runtime.whenPrepared(), sanitized);
    assert.equal(runtime.ready, false); assert.equal(f.calls.initialized, 0);
    await pause.drained; assert.equal(pause.resume(), false);
    assert.equal(f.calls.resumed, 0, 'failed original owner stays physically fenced');
    await assert.rejects(runtime.whenStarted(), sanitized);
    await runtime.close();
  });

  test(`${id}: final maintenance guard rejects resumed pause, native changes and closed original owner`, async () => {
    const f = owned(id), runtime = new AsyncSdkConnectorRuntime(id, async () => f.original, silence);
    runtime.activate(); await tick();
    try {
      const pause = runtime.pauseQueueWorker(); await pause.drained;
      const paused = await runtime.inspectMaintenance(); paused.assertCurrent();
      assert.equal(pause.resume(), true);
      assert.throws(paused.assertCurrent, /unavailable/);
      const idle = await runtime.inspectMaintenance(); idle.assertCurrent();
      f.facts.nativeWorkers++;
      assert.throws(idle.assertCurrent, /native observation changed/);
      const active = await runtime.inspectMaintenance();
      await runtime.close();
      assert.throws(active.assertCurrent, /unavailable/);
    } finally { await runtime.close(); }
  });
  test(`${id}: full refresh requires the retained owner and forwards its original failure`, async () => {
    const f = owned(id), runtime = new AsyncSdkConnectorRuntime(id, async () => f.original, silence);
    await assert.rejects(runtime.refreshProjection(), sanitized);
    assert.equal(f.calls.directory, 0);
    runtime.activate(); await tick();
    await runtime.refreshProjection(); assert.equal(f.calls.directory, 1); assert.equal(f.calls.history, 1);
    f.original.refreshProjection = async () => { throw Error('PRIVATE_REFRESH'); };
    await assert.rejects(runtime.refreshProjection(), sanitized);
    await runtime.close(); await assert.rejects(runtime.refreshProjection(), sanitized);
  });

  test(`${id}: retained original control remains available during maintenance, never before acquisition or after close`, async () => {
    const f = owned(id), runtime = new AsyncSdkConnectorRuntime(id, async () => f.original, silence);
    assert.throws(() => runtime.withRetainedOwner(() => true), sanitized);
    runtime.activate(); await tick(); assert.equal(runtime.ready, true);
    const pause = runtime.pauseQueueWorker(); await pause.drained;
    assert.throws(() => runtime.withReady(() => true), sanitized);
    assert.equal(runtime.withRetainedOwner(original => original), f.original);
    f.facts.faulted = true;
    assert.equal(runtime.withRetainedOwner(original => original), f.original, 'a new admission failure cannot hide the original control owner');
    await runtime.close(); assert.throws(() => runtime.withRetainedOwner(() => true), sanitized);
  });

  test(`${id}: unactivated assembly and close have no factory or native effects`, async () => {
    let created = 0; const f = owned(id);
    const runtime = new AsyncSdkConnectorRuntime(id, async () => { created++; return f.original; }, silence);
    assert.equal(created, 0); assert.equal(runtime.ready, false);
    assert.throws(() => runtime.withReady(() => true), sanitized);
    await assert.rejects(runtime.refreshSession(`${id}:original`), sanitized);
    const close = runtime.close(); assert.equal(runtime.close(), close); runtime.activate(); await close;
    assert.equal(created, 0); assert.equal(f.calls.closed, 0);
  });

  test(`${id}: close owns late original factory and waits actual cleanup, never initializes it`, async () => {
    const creation = gate(), entered = gate(), cleanup = gate(), f = owned(id);
    let created = 0;
    f.original.close = async () => { f.calls.closed++; await cleanup.promise; f.facts.closed = true; };
    const runtime = new AsyncSdkConnectorRuntime(id, async () => { created++; entered.release(); await creation.promise; return f.original; }, silence);
    runtime.activate(); runtime.activate(); await entered.promise;
    let closed = false; const closing = runtime.close().then(() => { closed = true; });
    assert.equal(runtime.status, 'closed'); await tick(); assert.equal(closed, false);
    creation.release(); await tick(); assert.equal(f.calls.closed, 1); assert.equal(f.calls.initialized, 0);
    assert.equal(closed, false); cleanup.release(); await closing;
    assert.equal(created, 1); assert.equal(f.calls.closed, 1);
  });

  test(`${id}: registry boot maintenance binds late HOME before drain, then starts only once`, async () => {
    const f = owned(id), creation = gate(), entered = gate(), drain = gate();
    f.original.pauseQueueWorker = () => { f.calls.paused++; return { drained: drain.promise,
      resume: () => { f.calls.resumed++; return true; } }; };
    const runtime = new AsyncSdkConnectorRuntime(id, async () => { entered.release(); await creation.promise; return f.original; }, silence);
    const registry = new ConnectorAgentRuntimes([runtime]);
    const pause = registry.pauseQueueWorkers(); runtime.activate(); await entered.promise;
    assert.equal(pause.resume(), false); creation.release(); await tick();
    assert.equal(f.calls.paused, 1); assert.equal(f.calls.initialized, 0);
    let drained = false; void pause.drained.then(() => { drained = true; });
    await tick(); assert.equal(drained, false); drain.release(); await pause.drained;
    assert.equal((await runtime.inspectMaintenance()).ownershipHeld, true);
    assert.equal(pause.resume(), true); assert.equal(pause.resume(), false); await tick();
    assert.equal(f.calls.initialized, 1); assert.equal(runtime.ready, true);
    await registry.close(); assert.equal(f.calls.closed, 1);
  });

  test(`${id}: maintenance arriving during original construction suppresses startup`, async () => {
    const f = owned(id), creation = gate(), entered = gate();
    const runtime = new AsyncSdkConnectorRuntime(id, async () => { entered.release(); await creation.promise; return f.original; }, silence);
    runtime.activate(); await entered.promise;
    const pause = runtime.pauseQueueWorker(); assert.equal(runtime.pauseQueueWorker(), pause);
    assert.equal(pause.resume(), false); creation.release(); await pause.drained;
    assert.equal(f.calls.initialized, 0); assert.equal(runtime.status, 'maintenance');
    assert.equal(pause.resume(), true); await tick(); assert.equal(f.calls.initialized, 1);
    await runtime.refreshSession(`${id}:original`); await runtime.refreshDirectory();
    assert.equal(f.calls.history, 1); assert.equal(f.calls.directory, 1);
    await runtime.close(); assert.equal(runtime.isSessionHistoryReady(`${id}:original`), false);
  });

  test(`${id}: close interrupts physical startup before waiting for its original completion`, async () => {
    const f = owned(id), startup = gate(), entered = gate();
    f.original.initialize = async () => { f.calls.initialized++; entered.release(); await startup.promise; return false; };
    f.original.close = async () => { f.calls.closed++; f.facts.closed = true; startup.release(); };
    const runtime = new AsyncSdkConnectorRuntime(id, async () => f.original, silence);
    runtime.activate(); await entered.promise; await runtime.close();
    assert.equal(f.calls.closed, 1); assert.equal(runtime.status, 'closed');
    runtime.activate(); assert.equal(f.calls.initialized, 1);
  });

  test(`${id}: failed acquisition is degraded, sanitized and never retried on resume`, async () => {
    let created = 0;
    const runtime = new AsyncSdkConnectorRuntime(id, async () => { created++; throw Error('PRIVATE_HOME'); }, silence);
    runtime.activate(); await tick(); assert.equal(runtime.status, 'failed');
    const pause = runtime.pauseQueueWorker(); await assert.rejects(pause.drained, sanitized);
    assert.equal(pause.resume(), false); runtime.activate(); assert.equal(created, 1);
    await assert.rejects(runtime.inspectMaintenance(), sanitized); await runtime.close();
  });

  test(`${id}: original cleanup failure stays rejected and no replacement owner is created`, async () => {
    const f = owned(id); let created = 0;
    f.original.close = async () => { f.calls.closed++; throw Error('PRIVATE_NATIVE_CLOSE'); };
    const runtime = new AsyncSdkConnectorRuntime(id, async () => { created++; return f.original; }, silence);
    runtime.activate(); await tick(); const closing = runtime.close();
    await assert.rejects(closing, sanitized); assert.equal(runtime.close(), closing);
    runtime.activate(); assert.equal(created, 1); assert.equal(f.calls.closed, 1);
  });

  test(`${id}: maintenance rejects late facts after close, lease replacement and ownership loss`, async () => {
    for (const race of ['close', 'resume', 'ownership'] as const) {
      const f = owned(id), held = gate(), entered = gate();
      f.original.inspectMaintenance = async () => { const snapshot = captureMaintenanceFacts(() => ({ ...f.facts })); entered.release(); await held.promise; return snapshot; };
      const runtime = new AsyncSdkConnectorRuntime(id, async () => f.original, silence);
      runtime.activate(); await tick(); const pause = runtime.pauseQueueWorker(); await pause.drained;
      const checking = runtime.inspectMaintenance(); await entered.promise;
      let closing;
      if (race === 'close') closing = runtime.close();
      else if (race === 'resume') assert.equal(pause.resume(), true);
      else f.facts.faulted = true;
      held.release(); await assert.rejects(checking, sanitized); await (closing ?? runtime.close());
    }
  });

  test(`${id}: pause exceptions freeze the runtime and diagnostic exceptions cannot skip cleanup`, async () => {
    const f = owned(id), broken = { start() { throw Error('PRIVATE_LOG'); } } as unknown as PerformanceDiagnostics;
    f.original.pauseQueueWorker = () => { throw Error('PRIVATE_PAUSE'); };
    const runtime = new AsyncSdkConnectorRuntime(id, async () => f.original, broken);
    runtime.activate(); await tick(); assert.equal(runtime.ready, true);
    assert.throws(() => runtime.pauseQueueWorker(), sanitized); assert.equal(runtime.status, 'failed');
    await runtime.close(); assert.equal(f.calls.closed, 1);
  });
}
