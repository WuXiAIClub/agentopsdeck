import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexRolloutReader, RolloutObservationPendingError } from './rollout-reader.js';
import { RolloutProjection } from './rollout-projection.js';

const gate = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise<void>(done => setImmediate(done));
const lease = (close: () => Promise<void>) => new RolloutProjection([{ bytes: 0, memoryBytes: 0, refs: 0, lines: async function* () {}, close }]);

test('owned snapshot lifecycle includes actual cleanup in the observation budget', async () => {
  const reader = new CodexRolloutReader(), cleaning = gate(); let reads = 0, closes = 0;
  reader.readSnapshot = async () => { reads++; return lease(async () => { closes++; await cleaning.promise; }); };
  try {
    await assert.rejects((reader as any).projectAndDisposeSnapshotWithin('path', {}, 10, async () => 7), RolloutObservationPendingError);
    assert.equal(reads, 1); assert.equal(closes, 1);
    await assert.rejects((reader as any).projectAndDisposeSnapshotWithin('path', {}, 10, async () => 9), RolloutObservationPendingError);
    assert.equal(reads, 1, 'a cleanup wait cannot admit a replacement observation');
    let closed = false; const closing = reader.close().then(() => { closed = true; });
    await tick(); assert.equal(closed, false);
    cleaning.resolve(); await closing; assert.equal(reader.cacheStats().pendingSnapshotWaits, 0);
  } finally { cleaning.resolve(); await reader.close(); }
});

test('owned snapshot deadline never disposes an active original projector', async () => {
  const reader = new CodexRolloutReader(), held = gate(); let closes = 0, active = true, expired = false;
  reader.readSnapshot = async () => lease(async () => { assert.equal(active, false); closes++; });
  try {
    await assert.rejects((reader as any).projectAndDisposeSnapshotWithin('path', {}, 10, async (_snapshot: unknown, isExpired: () => boolean) => {
      await held.promise; expired = isExpired(); active = false; return 1;
    }), RolloutObservationPendingError);
    assert.equal(closes, 0); held.resolve(); await reader.close(); assert.equal(expired, true); assert.equal(closes, 1);
  } finally { held.resolve(); await reader.close(); }
});

test('snapshot arriving after deadline is cleaned without starting optional proof', async () => {
  const reader = new CodexRolloutReader(), held = gate(); let projects = 0, closes = 0;
  reader.readSnapshot = async () => { await held.promise; return lease(async () => { closes++; }); };
  try {
    await assert.rejects((reader as any).projectAndDisposeSnapshotWithin('path', {}, 10, async () => { projects++; return 1; }), RolloutObservationPendingError);
    held.resolve(); await reader.close(); assert.equal(projects, 0); assert.equal(closes, 1);
  } finally { held.resolve(); await reader.close(); }
});

test('timely owned lifecycle returns only a pure value after one original disposal', async () => {
  const reader = new CodexRolloutReader(); let closes = 0;
  const snapshot = lease(async () => { closes++; }); reader.readSnapshot = async () => snapshot;
  const value = await (reader as any).projectAndDisposeSnapshotWithin('path', {}, 1000, async (original: unknown, expired: () => boolean) => {
    assert.equal(original, snapshot); assert.equal(expired(), false); return 7;
  });
  assert.equal(value, 7); assert.equal(closes, 1); await reader.close(); assert.equal(closes, 1);
});

for (const projectFails of [false, true]) test(`owned lifecycle retains cleanup failure independently (project fails: ${projectFails})`, async () => {
  const reader = new CodexRolloutReader(), original = Error('private-original'), cleanup = Error('private-cleanup');
  reader.readSnapshot = async () => lease(async () => { throw cleanup; });
  await assert.rejects((reader as any).projectAndDisposeSnapshotWithin('path', {}, 1000, async () => {
    if (projectFails) throw original; return 7;
  }), (error: unknown) => error === (projectFails ? original : cleanup));
  await assert.rejects(reader.close(), error => error === cleanup);
});

test('invalid or closed owned lifecycle never reads an original snapshot', async () => {
  const reader = new CodexRolloutReader(); let reads = 0;
  reader.readSnapshot = async () => { reads++; return lease(async () => {}); };
  await assert.rejects((reader as any).projectAndDisposeSnapshotWithin('path', {}, 0, async () => 7), /Invalid rollout observation deadline/);
  await reader.close();
  await assert.rejects((reader as any).projectAndDisposeSnapshotWithin('path', {}, 10, async () => 7), /reader closed/);
  assert.equal(reads, 0);
});
