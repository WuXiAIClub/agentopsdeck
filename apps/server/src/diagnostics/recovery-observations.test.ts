import assert from 'node:assert/strict';
import test from 'node:test';
import { PerformanceDiagnostics } from "./performance.js";

test('failed and pending recovery evidence remains queryable after log budget exhaustion', () => {
  const lines: string[] = [], d = new PerformanceDiagnostics(line => lines.push(line), () => 0);
  // Exhaust the same lifecycle reserve as the original operation. Ordinary
  // polling now has a separate budget and must not hide owner recovery.
  for (let i = 0; i < 60; i++) d.start('storage-coordinator-recovery').finish(true);
  const original = d.start('storage-coordinator-recovery');
  original.add('unknown', 1); original.reportPending({ pending: 2 }); original.finish(true);
  const snapshot = d.snapshot();
  assert.equal(lines.length, 60);
  assert.equal(snapshot.scope, 'process'); assert.equal(snapshot.retention, 'volatile');
  assert.equal(snapshot.totals.pending, 1); assert.equal(snapshot.totals.failed, 61);
  assert.equal(snapshot.totals.unknownObservations, 2); assert.equal(snapshot.totals.suppressed, 2);
  assert.equal(snapshot.events.at(-2)!.phase, 'pending');
  assert.equal(snapshot.events.at(-1)!.phase, 'finished');
  assert.equal(snapshot.events.at(-1)!.sequence, snapshot.events.at(-2)!.sequence);
  assert.equal(snapshot.events.at(-1)!.instance, snapshot.events.at(-2)!.instance);
  assert.equal(snapshot.events.at(-1)!.delivery, 'rate-limited');
  assert.equal(snapshot.events.at(-2)!.pending, 2);
  assert.equal(snapshot.events.at(-1)!.pending, undefined);
});

test('diagnostic sink failure does not erase recovery evidence or replace operation outcome', () => {
  const d = new PerformanceDiagnostics(() => { throw Error('/secret/token'); }, () => 1);
  const original = d.start('owned-wal-checkpoint'); original.add('unknown', 1);
  assert.doesNotThrow(() => original.finish(true));
  const snapshot = d.snapshot();
  assert.equal(snapshot.totals.sinkFailures, 1); assert.equal(snapshot.events[0]!.delivery, 'failed');
  assert.equal(snapshot.events[0]!.unknown, 1); assert.doesNotMatch(JSON.stringify(snapshot), /secret|token/);
});

test('routine completion of an observed pending operation is retained with its original identity', () => {
  let now = 0;
  const d = new PerformanceDiagnostics(() => {}, () => now), trace = d.start('shutdown-cleanup');
  now = 1; trace.reportPending({ pending: 1 }); now = 2; trace.finish();
  const { events, totals } = d.snapshot();
  assert.equal(events.length, 2); assert.equal(events[1]!.phase, 'finished');
  assert.equal(events[1]!.category, 'routine'); assert.equal(events[1]!.sequence, events[0]!.sequence);
  assert.equal(totals.failed, 0); assert.equal(totals.pending, 1); assert.equal(totals.finished, 1);
});

test('recovery retention and counters are bounded and routine traffic cannot evict abnormal events', () => {
  const d = new PerformanceDiagnostics(() => {}, () => 1);
  for (let i = 0; i < 300; i++) d.start('storage-connection-recovery').finish(true);
  const before = d.snapshot(); assert.equal(before.events.length, before.capacity);
  assert.equal(before.events[0]!.sequence, 173); assert.equal(before.events.at(-1)!.sequence, 300);
  for (let i = 0; i < 1000; i++) d.start('rollout-read').finish();
  assert.deepEqual(d.snapshot().events, before.events);
  assert.equal(d.snapshot().totals.observations, 1300);
  assert.equal(d.snapshot().totals.suppressed, 1220);
});

test('snapshot is detached, read-only and cannot reset log budgets or evidence', () => {
  const lines: string[] = [], d = new PerformanceDiagnostics(line => lines.push(line), () => 0);
  for (let i = 0; i < 60; i++) d.start('storage-connection-recovery').finish(true);
  const original = d.snapshot(), changed = d.snapshot();
  changed.totals.failed = 0; changed.events[0]!.operation = 'rollout-read'; changed.events.length = 0;
  assert.deepEqual(d.snapshot(), original);
  d.start('storage-connection-recovery').finish(true); assert.equal(lines.length, 60);
});

test('recovery evidence includes only allowlisted enums/numbers, never arbitrary fields or exception text', () => {
  const d = new PerformanceDiagnostics(() => {}, () => 0), trace = d.start('owned-wal-checkpoint');
  trace.add('secret-credential-path' as any, 100);
  trace.reportPending({ '/private/transcript': 100, pending: 3, unknown: NaN, busy: -1 } as any);
  trace.finish(true); d.start('/secret-operation' as any).finish(true);
  assert.equal(d.snapshot().totals.observations, 2);
  assert.doesNotMatch(JSON.stringify(d.snapshot()), /private|secret|transcript|NaN|busy/);
});

test('querying observations never completes, cancels or replaces an original pending operation', () => {
  const d = new PerformanceDiagnostics(() => {}, () => 1), original = d.start('maintenance-journal-rpc');
  original.reportPending({ pending: 1, unknown: 1 });
  const before = d.snapshot(); for (let i = 0; i < 25; i++) assert.deepEqual(d.snapshot(), before);
  original.add('settled', 1); original.finish(); original.finish(true); original.reportPending();
  const after = d.snapshot(); assert.equal(after.totals.finished, 1); assert.equal(after.totals.pending, 1);
  assert.equal(after.events.at(-1)!.settled, 1); assert.equal(after.events.at(-1)!.sequence, before.events[0]!.sequence);
});
