import assert from 'node:assert/strict';
import test from 'node:test';
import { activeSessionSafetyInterval, historyFallbackInterval, historyRefreshInterval } from './history-refresh-budget.js';
import { createLiveRefresh } from './refresh-control.js';

test('idle fallback requires positive idle evidence, never foreground status', () => {
  for (const status of ['idle', 'failed']) {
    assert.equal(historyFallbackInterval({ status }), 15_000);
    assert.equal(historyFallbackInterval({ status }, 2), 60_000);
  }
  for (const status of ['unknown', 'running', 'waiting']) {
    assert.equal(historyFallbackInterval({ status }), 3_000);
    assert.equal(historyFallbackInterval({ status }, 20), 15_000);
  }
  assert.equal(historyFallbackInterval({ status: 'idle', hasActiveRun: true }), 3_000);
  assert.equal(historyFallbackInterval({ status: 'idle', runtime: { phase: 'finalizing' } }), 3_000);
});

test('17 disconnected sessions dynamically back off and stop cleanly', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let reads = 0;
  const controllers = Array.from({ length: 17 }, (_, index) => createLiveRefresh({
    refresh: async () => { reads++; return { changed: false }; }, isVisible: () => true, isConnected: () => false,
    fallbackMs: n => historyFallbackInterval({ status: index === 0 ? 'running' : 'idle' }, n), eventDelayMs: 1,
  }));
  controllers.forEach(controller => controller.start()); await Promise.resolve();
  const initial = reads;
  for (let step = 0; step < 6; step++) { t.mock.timers.tick(10_000); await Promise.resolve(); }
  assert.equal(reads - initial, 19);
  controllers.forEach(controller => controller.stop());
  t.mock.timers.tick(120_000); await Promise.resolve(); assert.equal(reads, initial + 19);
});

test('R19: low-density layouts accelerate event-triggered refresh and active safety intervals', () => {
  assert.equal(historyRefreshInterval(1, true), 400);
  assert.equal(historyRefreshInterval(1, false), 800);
  assert.equal(historyRefreshInterval(2, true), 600);
  assert.equal(historyRefreshInterval(2, false), 1_000);
  assert.equal(historyRefreshInterval(3, true), 1_000);
  assert.equal(historyRefreshInterval(5, true), 2_000);
  assert.equal(historyRefreshInterval(5, false), 4_000);

  assert.equal(activeSessionSafetyInterval(1, true, false), 60_000);
  assert.equal(activeSessionSafetyInterval(1, true, true), 1_500);
  assert.equal(activeSessionSafetyInterval(1, false, true), 3_000);
  assert.equal(activeSessionSafetyInterval(2, true, true), 2_500);
  assert.equal(activeSessionSafetyInterval(2, false, true), 5_000);
  assert.equal(activeSessionSafetyInterval(4, true, true), 5_000);
  assert.equal(activeSessionSafetyInterval(4, false, true), 15_000);
});
