import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexRolloutReader } from './rollout-reader.js';
import { RolloutProjection } from './rollout-projection.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const gate = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise<void>(done => setImmediate(done));
const lease = (close: () => Promise<void> = async () => {}, lines: () => AsyncGenerator<string> = async function* () {}) =>
  new RolloutProjection([{ bytes:0, memoryBytes:0, refs:0, lines, close }]);

test('projected observation times out a stalled iterator without racing its resource release or retry', async () => {
  const held = gate(), entered = gate(), logs:unknown[] = [], reader = new CodexRolloutReader({ diagnostics:new PerformanceDiagnostics(line => logs.push(JSON.parse(line))) });
  let reads = 0, closes = 0, done = false;
  reader.readSnapshot = async () => { reads++; return lease(async () => { closes++; }, async function* () { entered.resolve(); await held.promise; yield 'private-line'; }); };
  try {
    const observed = (reader as any).readProjectedSnapshotWithin('private-path', {}, 20, async (snapshot:RolloutProjection) => {
      const result:string[] = []; for await (const line of snapshot) result.push(line); done = true; return result;
    });
    await assert.rejects(observed, /still pending/);
    assert.equal(done,false); assert.equal(closes,0); assert.equal(reads,1);
    await assert.rejects((reader as any).readProjectedSnapshotWithin('private-path', {}, 20, async () => []), /still pending/);
    assert.equal(reads,1);
    let exited = false; const originalClose = reader.close(); void originalClose.then(() => { exited = true; });
    await tick(); assert.equal(exited,false); assert.equal(closes,0);
    held.resolve(); await originalClose; assert.equal(done,true); assert.equal(closes,1);
    assert.equal(reader.cacheStats().pendingSnapshotWaits,0);
    assert.ok(logs.some((row:any) => row.operation === 'rollout-snapshot-wait' && row.timedOut === 1));
    assert.doesNotMatch(JSON.stringify(logs),/private-/);
  } finally { held.resolve(); await reader.close(); }
});

test('late snapshot does not start an unnecessary projection callback', async () => {
  const held = gate(), reader = new CodexRolloutReader(); let calls = 0, closes = 0;
  reader.readSnapshot = async () => { await held.promise; return lease(async () => { closes++; }); };
  try {
    await assert.rejects((reader as any).readProjectedSnapshotWithin('path', {}, 10, async () => { calls++; return 1; }), /still pending/);
    held.resolve(); await reader.close(); assert.equal(calls,0); assert.equal(closes,1);
  } finally { held.resolve(); await reader.close(); }
});

test('timely projected observations transfer independent leases without altering healthy concurrency', async () => {
  const held = gate(), reader = new CodexRolloutReader(); let reads = 0, closes = 0;
  reader.readSnapshot = async () => { reads++; await held.promise; return lease(async () => { closes++; }); };
  try {
    const first = (reader as any).readProjectedSnapshotWithin('path', {}, 1000, async () => 'first');
    const second = (reader as any).readProjectedSnapshotWithin('path', {}, 1000, async () => 'second');
    await tick(); assert.equal(reads,2); held.resolve(); const [a,b] = await Promise.all([first,second]);
    assert.equal(a.value,'first'); assert.equal(b.value,'second'); assert.notEqual(a.snapshot,b.snapshot);
    await reader.close(); assert.equal(closes,0); await Promise.all([a.snapshot.dispose(),b.snapshot.dispose()]); assert.equal(closes,2);
  } finally { held.resolve(); await reader.close(); }
});

test('projection rejection retains its original error while failed cleanup remains visible to close', async () => {
  const reader = new CodexRolloutReader(), original = Error('private-project'), cleanup = Error('private-cleanup');
  reader.readSnapshot = async () => lease(async () => { throw cleanup; });
  await assert.rejects((reader as any).readProjectedSnapshotWithin('path', {}, 1000, async () => { throw original; }), error => error === original);
  await assert.rejects(reader.close(), error => error === cleanup);
});

test('late projection cleanup failure is retained and never delivered as a successful projection', async () => {
  const held = gate(), reader = new CodexRolloutReader(), cleanup = Error('private-cleanup'); let closes = 0;
  reader.readSnapshot = async () => lease(async () => { closes++; throw cleanup; });
  try {
    await assert.rejects((reader as any).readProjectedSnapshotWithin('path', {}, 10, async () => { await held.promise; return 'late'; }), /still pending/);
    held.resolve(); await assert.rejects(reader.close(), error => error === cleanup); assert.equal(closes,1);
  } finally { held.resolve(); await reader.close().catch(() => {}); }
});

test('expired projection keeps retry suppressed through the original cleanup', async () => {
  const held = gate(), cleanup = gate(), closing = gate(), reader = new CodexRolloutReader(); let reads = 0;
  reader.readSnapshot = async () => { reads++; return lease(async () => { closing.resolve(); await cleanup.promise; }); };
  try {
    await assert.rejects((reader as any).readProjectedSnapshotWithin('path', {}, 10, async () => { await held.promise; return 1; }), /still pending/);
    held.resolve(); await closing.promise;
    await assert.rejects((reader as any).readProjectedSnapshotWithin('path', {}, 10, async () => 2), /still pending/); assert.equal(reads,1);
    cleanup.resolve(); await tick();
    const next = await (reader as any).readProjectedSnapshotWithin('path', {}, 1000, async () => 2); assert.equal(reads,2); assert.equal(next.value,2); await next.snapshot.dispose();
  } finally { held.resolve(); cleanup.resolve(); await reader.close(); }
});

test('projected deadline covers reading and projection together instead of restarting for the callback', async () => {
  const held = gate(), reader = new CodexRolloutReader(); let calls = 0;
  reader.readSnapshot = async () => { await new Promise(done => setTimeout(done,30)); return lease(); };
  try {
    await assert.rejects((reader as any).readProjectedSnapshotWithin('path', {}, 50, async () => { calls++; await held.promise; return 'late'; }), /still pending/);
    assert.equal(calls,1); held.resolve(); await reader.close();
  } finally { held.resolve(); await reader.close(); }
});
