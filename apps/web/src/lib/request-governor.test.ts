import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyRequestPriority,
  createRequestGovernor,
  parseServerTimingHeader,
} from './request-governor.js';
import {
  activeSessionSafetyInterval,
  historyRefreshInterval,
} from './history-refresh-budget.js';
import { createHistoryReadScheduler } from './history-read-scheduler.js';

test('parseServerTimingHeader extracts app, connectorWait, hydrateWait and sql durations', () => {
  const parsed = parseServerTimingHeader('app;dur=142.5, connectorWait;dur=98.2, sql;dur=4.1');
  assert.deepEqual(parsed, { appMs: 142.5, connectorWaitMs: 98.2, sqlMs: 4.1 });
  assert.deepEqual(parseServerTimingHeader(null), {});
});

test('classifyRequestPriority separates P0 mutations, P1 active messages, P2 visible, and P3 background', () => {
  assert.equal(classifyRequestPriority('/api/hub/v1/sessions/abc/messages', 'POST'), 'p0');
  assert.equal(classifyRequestPriority('/api/hub/v1/sessions/abc/messages?limit=200', 'GET'), 'p1');
  assert.equal(classifyRequestPriority('/api/hub/v1/sessions/abc/messages?limit=200', 'GET', { calibration: true }), 'p3');
  assert.equal(classifyRequestPriority('/api/hub/v1/sessions/completion-summary', 'POST'), 'p3');
  assert.equal(classifyRequestPriority('/api/hub/v1/notebooks/123/layout', 'GET'), 'p2');
});

test('requestGovernor boosts meaningful refresh rate on healthy capable hardware and throttles under 5xx/latency pressure', () => {
  let now = 100_000;
  const gov = createRequestGovernor({
    now: () => now,
    initialPolicy: 'auto',
    deviceProfile: () => ({ cores: 8, memoryGb: 16, saveData: false, effectiveType: '4g', capable: true, constrained: false }),
  });

  // Initial baseline with no samples stays normal
  assert.equal(gov.snapshot().regime, 'normal');
  assert.equal(gov.intervalMultiplier(), 1.0);
  assert.equal(gov.effectiveConcurrency(), 2);

  // Record fast healthy responses with low backend timing
  gov.record({ path: '/api/hub/v1/sessions/s1/messages?limit=200', status: 200, elapsedMs: 85, serverTiming: 'app;dur=32, connectorWait;dur=20' });
  now += 500;
  gov.record({ path: '/api/hub/v1/sessions/s1/messages?limit=200', status: 304, elapsedMs: 45, serverTiming: 'app;dur=12, connectorWait;dur=8' });

  const boosted = gov.snapshot();
  assert.equal(boosted.regime, 'boosted');
  assert.equal(boosted.intervalMultiplier, 0.75);
  assert.equal(boosted.effectiveConcurrency, 3);
  assert.equal(boosted.allowBackgroundPreload, true);
  assert.equal(historyRefreshInterval(1, true, boosted.intervalMultiplier), 300);
  assert.equal(activeSessionSafetyInterval(1, true, true, boosted.intervalMultiplier), 1125);

  // Simulate backend 503 pressure -> immediately enters throttled regime, sheds P3 preload, preserves P0/P1
  now += 500;
  gov.record({ path: '/api/hub/v1/sessions/s1/messages?limit=200', status: 503, elapsedMs: 1360, serverTiming: 'app;dur=1350, connectorWait;dur=1260' });
  const throttled = gov.snapshot();
  assert.equal(throttled.regime, 'throttled');
  assert.equal(throttled.intervalMultiplier, 2.5);
  assert.equal(throttled.effectiveConcurrency, 1);
  assert.equal(throttled.allowBackgroundPreload, false);
  assert.equal(gov.shouldAdmitPriority(0), true);
  assert.equal(gov.shouldAdmitPriority(1), true);
  assert.equal(gov.shouldAdmitPriority(4), false);

  // Advance past 10s window and switch to saver policy
  now += 15_000;
  gov.setPolicy('saver');
  const saver = gov.snapshot();
  assert.equal(saver.regime, 'conserving');
  assert.equal(saver.allowBackgroundPreload, false);
  assert.equal(saver.effectiveConcurrency, 1);
});

test('createHistoryReadScheduler supports dynamic concurrency getter from governor', async () => {
  let limit = 1;
  const scheduler = createHistoryReadScheduler(() => limit);
  assert.equal(scheduler.inspect().concurrency, 1);
  limit = 3;
  assert.equal(scheduler.inspect().concurrency, 3);
});
