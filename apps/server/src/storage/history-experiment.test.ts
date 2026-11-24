import assert from 'node:assert/strict';
import test from 'node:test';
import { runHistoryExperiment } from './history-experiment.js';

test('bounded isolated experiment separates SQL/JSON/projection and reports WAL samples without content or paths', () => {
  const result = runHistoryExperiment({ rounds: 3, rows: 20, payloadBytes: 128 });
  assert.equal(result.scope, 'synthetic-local-only'); assert.equal(result.causal503Evidence, false); assert.equal(result.longSoak, false);
  assert.equal(result.samples.length, 3); assert.equal(result.stopped, 'round-budget');
  for (const [i, sample] of result.samples.entries()) {
    assert.equal(sample.rows, 20); assert.equal(sample.round, i);
    for (const key of ['sqlWriteMs', 'sqlReadMs', 'jsonMs', 'projectionMs', 'checkpointMs'] as const) assert.ok(sample[key] >= 0);
    assert.ok(sample.beforeCheckpoint.wal! > 0); assert.equal(sample.checkpointResult, null);
  }
  assert.notEqual(result.samples[0]!.projectionDigest, result.samples[1]!.projectionDigest);
  assert.doesNotMatch(JSON.stringify(result), /fixture.sqlite|agentopsdeck-history-experiment-|xxxxx/);
});
test('controlled passive checkpoint records page evidence rather than pretending WAL file size is live page count', () => {
  const result = runHistoryExperiment({ rounds: 2, rows: 10, payloadBytes: 64, checkpoint: 'passive' });
  for (const sample of result.samples) {
    assert.equal(sample.checkpointResult!.busy, 0);
    assert.equal(sample.checkpointResult!.log, sample.checkpointResult!.checkpointed);
    assert.ok(sample.footprint.database! > 0);
  }
});
test('oversized experiments and caller-selected paths reject before allocating a fixture', () => {
  for (const options of [{ rounds: 33 }, { rows: 2001 }, { payloadBytes: 4097 }, { rows: 2000, payloadBytes: 4096 },
    { rounds: NaN }, { checkpoint: 'truncate' }, { path: '/production.sqlite' }]) {
    assert.throws(() => runHistoryExperiment(options as never), /experiment-budget/);
  }
});
