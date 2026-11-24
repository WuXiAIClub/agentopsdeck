import assert from 'node:assert/strict';
import test from 'node:test';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { observeBackgroundStartup, reportStartupFailure } from './startup-observation.js';

for (const synchronous of [true, false]) test(`background startup ${synchronous ? 'throw' : 'rejection'} is observed without retry or raw error`, async () => {
  const rows: Record<string, unknown>[] = []; let calls = 0;
  const d = new PerformanceDiagnostics(line => rows.push(JSON.parse(line)));
  const result = await observeBackgroundStartup(1, () => {
    calls++; const error = Error('private/path token native-output');
    if (synchronous) throw error;
    return Promise.reject(error);
  }, d);
  assert.equal(result, false); assert.equal(calls, 1);
  assert.equal(rows.length, 1); assert.equal(rows[0]!.operation, 'connector-startup-task');
  assert.equal(rows[0]!.step, 1); assert.equal(rows[0]!.unknown, 1); assert.equal(rows[0]!.category, 'failed');
  assert.equal(rows[0]!.settled, undefined);
  assert.doesNotMatch(JSON.stringify(rows), /private|token|native-output/);
});

test('held startup produces one correlated warning without releasing or replaying its work', async () => {
  const rows: Record<string, unknown>[] = []; let release!: () => void, calls = 0, finished = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  const result = observeBackgroundStartup(2, () => { calls++; return held; },
    new PerformanceDiagnostics(line => rows.push(JSON.parse(line))), 1);
  void result.then(() => { finished = true; });
  try {
    await new Promise<void>(resolve => setTimeout(resolve, 15));
    assert.equal(finished, false); assert.equal(calls, 1); assert.equal(rows.length, 1);
    assert.equal(rows[0]!.phase, 'pending'); assert.equal(rows[0]!.pending, 1);
    await new Promise<void>(resolve => setTimeout(resolve, 15)); assert.equal(rows.length, 1);
    release(); assert.equal(await result, true);
    assert.equal(rows.length, 2); assert.equal(rows[1]!.phase, 'finished'); assert.equal(rows[1]!.settled, 1);
    assert.equal(rows[0]!.instance, rows[1]!.instance); assert.equal(rows[0]!.sequence, rows[1]!.sequence);
    assert.equal(calls, 1);
  } finally { release(); await result; }
});

test('failed startup after a warning remains unknown, never recovered', async () => {
  const rows: Record<string, unknown>[] = []; let reject!: (error: unknown) => void;
  const result = observeBackgroundStartup(3, () => new Promise<void>((_, fail) => { reject = fail; }),
    new PerformanceDiagnostics(line => rows.push(JSON.parse(line))), 1);
  await new Promise<void>(resolve => setTimeout(resolve, 15)); reject(undefined);
  assert.equal(await result, false); assert.equal(rows.length, 2);
  assert.equal(rows[1]!.unknown, 1); assert.equal(rows[1]!.recovered, undefined); assert.equal(rows[1]!.settled, undefined);
});

test('diagnostic sink failure cannot change the work outcome or request retry', async () => {
  const d = new PerformanceDiagnostics(() => { throw Error('private sink'); }); let calls = 0;
  assert.equal(await observeBackgroundStartup(1, () => { calls++; }, d), true);
  assert.equal(await observeBackgroundStartup(2, () => { calls++; throw undefined; }, d), false);
  assert.doesNotThrow(() => reportStartupFailure(4, d)); assert.equal(calls, 2);
});
