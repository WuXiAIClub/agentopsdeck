import assert from 'node:assert/strict';
import test from 'node:test';
import { ClaudeConnectorRuntime } from './connector-runtime.js';
import type { ClaudeOwnedRuntime } from './owned-runtime.js';

function fixture() {
  const calls = { acquired: 0, initialized: 0, closed: 0, paused: 0, resumed: 0 };
  const facts = { ownershipHeld: true, cleanupUnconfirmed: false, closed: false, faulted: false,
    nativeWorkers: 2, startupWorkers: 1, admissionInFlight: 3 };
  const owner = { ready: true, status: 'ready', initialize: async () => { calls.initialized++; return true; },
    inspectMaintenance: () => facts, close: async () => { calls.closed++; },
    pauseQueueWorker: () => { calls.paused++; return { drained: Promise.resolve(), resume: () => { calls.resumed++; return true; } }; },
  } as unknown as ClaudeOwnedRuntime;
  const runtime = new ClaudeConnectorRuntime({} as ConstructorParameters<typeof ClaudeOwnedRuntime>[0],
    () => { calls.acquired++; return owner; });
  return { runtime, calls, facts };
}

test('assembly has no HOME/native side effects; activation and close are once only', async () => {
  const { runtime, calls } = fixture();
  assert.equal(calls.acquired, 0);
  assert.equal(runtime.ready, false);
  assert.throws(() => runtime.inspectMaintenance());
  runtime.activate(); runtime.activate();
  assert.equal(calls.acquired, 1); assert.equal(calls.initialized, 1);
  assert.equal(runtime.ready, true);
  await runtime.close(); await runtime.close(); runtime.activate();
  assert.equal(calls.closed, 1); assert.equal(calls.initialized, 1);
  assert.equal(runtime.ready, false);
});

test('persisted boot maintenance acquires proof after assembly but never starts native until resumed', async () => {
  const { runtime, calls } = fixture();
  const pause = runtime.pauseQueueWorker();
  runtime.activate();
  assert.equal(calls.acquired, 1); assert.equal(calls.initialized, 0);
  assert.equal(pause.resume(), false);
  await pause.drained;
  assert.equal(runtime.inspectMaintenance().ownershipHeld, true);
  assert.equal(pause.resume(), true);
  assert.equal(pause.resume(), false);
  assert.equal(calls.acquired, 1); assert.equal(calls.initialized, 1);
  const active = runtime.pauseQueueWorker(); await active.drained;
  assert.equal(calls.paused, 2);
  assert.equal(active.resume(), true); assert.equal(calls.resumed, 2);
  await runtime.close();
});

test('ownership acquisition failure is degraded and cannot retry through maintenance resume', async () => {
  let acquired = 0;
  const runtime = new ClaudeConnectorRuntime({} as ConstructorParameters<typeof ClaudeOwnedRuntime>[0],
    () => { acquired++; throw new Error('private native error'); });
  runtime.activate(); assert.equal(runtime.ready, false);
  assert.throws(() => runtime.commands, error => !String(error).includes('private native error'));
  const pause = runtime.pauseQueueWorker(); await pause.drained; pause.resume(); runtime.activate();
  assert.equal(acquired, 1); assert.throws(() => runtime.inspectMaintenance());
  await runtime.close();
});

test('native/startup/admission facts are retained; uncertain cleanup and lost ownership refuse proof', async () => {
  const { runtime, facts } = fixture(); runtime.activate();
  assert.equal(runtime.inspectMaintenance().nativeWorkers, 2);
  assert.equal(runtime.inspectMaintenance().startupWorkers, 1);
  assert.equal(runtime.inspectMaintenance().admissionInFlight, 3);
  for (const key of ['cleanupUnconfirmed', 'faulted', 'closed'] as const) {
    facts[key] = true; assert.throws(() => runtime.inspectMaintenance()); facts[key] = false;
  }
  facts.ownershipHeld = false; assert.throws(() => runtime.inspectMaintenance());
  await runtime.close();
});
