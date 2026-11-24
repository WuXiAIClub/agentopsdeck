import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentReadiness } from '@agentopsdeck/shared';
import { ClaudeConnectorRuntime } from '../claude/connector-runtime.js';
import { CopilotConnectorRuntime } from '../copilot/connector-runtime.js';

// Both adapters must give the same bounded diagnostics without changing native ownership.
for (const Runtime of [ClaudeConnectorRuntime, CopilotConnectorRuntime]) {
  test(`${Runtime.name}: readiness follows startup, maintenance, failure and closure`, async () => {
    let status: AgentReadiness = 'starting', starts = 0;
    const owner = {
      get status() { return status; },
      initialize: async () => { starts++; return status === 'ready'; },
      pauseQueueWorker: () => ({ drained: Promise.resolve(), resume: () => true }),
      close: async () => {},
    };
    const runtime = new Runtime({} as never, () => owner as never);
    assert.equal(runtime.status, 'starting'); assert.equal(runtime.ready, false);
    runtime.activate(); assert.equal(starts, 1);
    status = 'ready'; assert.equal(runtime.ready, true);
    const pause = runtime.pauseQueueWorker();
    assert.equal(runtime.status, 'maintenance'); assert.equal(runtime.ready, false);
    assert.equal(pause.resume(), false);
    await pause.drained; assert.equal(pause.resume(), true);
    assert.equal(runtime.status, 'ready');
    status = 'failed';
    const failedPause = runtime.pauseQueueWorker();
    assert.equal(runtime.status, 'failed', 'maintenance must not mask an ownership or cleanup failure');
    await failedPause.drained;
    await runtime.close(); assert.equal(runtime.status, 'closed'); assert.equal(runtime.ready, false);
  });

  test(`${Runtime.name}: rejected initialization is failed, not an endless starting state`, async () => {
    const runtime = new Runtime({} as never, () => ({ status: 'starting',
      initialize: async () => { throw new Error('private path or provider secret'); }, close: async () => {},
    }) as never);
    runtime.activate(); await Promise.resolve(); await Promise.resolve();
    assert.equal(runtime.status, 'failed'); assert.equal(runtime.ready, false);
    await runtime.close();
  });

  test(`${Runtime.name}: ownership acquisition failure is not retried by a status read`, async () => {
    let acquisitions = 0;
    const runtime = new Runtime({} as never, () => { acquisitions++; throw new Error('private failure'); });
    runtime.activate();
    for (let i = 0; i < 5; i++) { assert.equal(runtime.status, 'failed'); assert.equal(runtime.ready, false); }
    runtime.activate(); assert.equal(acquisitions, 1);
    await runtime.close();
  });
}
