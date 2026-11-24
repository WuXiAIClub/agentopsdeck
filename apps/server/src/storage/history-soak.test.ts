import assert from 'node:assert/strict';
import test from 'node:test';
import { runHistorySoak } from './history-soak.js';

test('bounded HTTP soak separates append, warm read, JSON, projection and pinned reader checkpoint evidence', async () => {
  const samples: unknown[] = [];
  // Exercise the 32-round reopen branch, not a throughput SLA. Leave headroom
  // for loopback HTTP and SQLite while the full suite runs concurrent files.
  const result = await runHistorySoak({ durationMs: 8000, intervalMs: 25, concurrency: 3, rowsPerAppend: 2, payloadBytes: 64 }, s => samples.push(s));
  assert.equal(result.stopped, 'duration-budget'); assert.ok(result.rounds >= 32);
  assert.ok(result.reopened >= 1); assert.ok(result.checkpointLagRounds > 0);
  assert.equal(result.appended, result.rounds * 2); assert.equal(result.httpRequests, result.rounds * 6);
  assert.equal(result.warmReads, result.rounds * 3); assert.equal(result.peakConcurrent, 3);
  assert.ok(result.maxFootprint < result.budgets.maxDiskBytes);
  for (const key of ['sqlWriteMs', 'sqlMs', 'jsonMs', 'projectionMs', 'checkpointMs', 'httpMs'] as const) assert.ok(result[key] >= 0);
  assert.equal(result.longSoak, false); assert.equal(result.osColdCache, false); assert.equal(result.causal503Evidence, false);
  assert.ok(samples.length > 0); assert.doesNotMatch(JSON.stringify(result), /fixture.sqlite|agentopsdeck-history-soak-|xxxx/);
});
test('cancellation stops without claiming duration/long stability success', async () => {
  const controller = new AbortController();
  const result = await runHistorySoak({ durationMs: 5000 }, () => controller.abort(), controller.signal);
  assert.equal(result.stopped, 'aborted'); assert.equal(result.rounds, 1); assert.equal(result.longSoak, false);
});
test('bounds and path injection reject before opening listener/database', async () => {
  for (const value of [{ durationMs: 0 }, { durationMs: 8 * 3600_000 + 1 }, { durationMs: 100, concurrency: 9 },
    { durationMs: 100, path: '/production.sqlite' }, { durationMs: 100, intervalMs: 1 }, { durationMs: 100, checkpoint: 'truncate' }])
    await assert.rejects(runHistorySoak(value as never), /soak-budget/);
});
