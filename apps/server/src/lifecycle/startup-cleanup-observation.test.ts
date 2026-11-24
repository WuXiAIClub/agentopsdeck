import test from 'node:test';
import assert from 'node:assert/strict';
import { StartupApplicationCleanup } from './startup-cleanup.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { StorageConnectionUnavailable } from '../storage/connection-recovery.js';

const turn = () => new Promise<void>(resolve => setImmediate(resolve));

test('a throwing admission clock cannot strand the original startup cleanup before its drain', async () => {
  let drains = 0, closes = 0;
  const owners = new StartupApplicationCleanup(new PerformanceDiagnostics(() => {}, () => 0), () => { throw Error('clock'); });
  assert.doesNotThrow(() => owners.abandon([() => { drains++; }], [() => { closes++; }]));
  await owners.waitForCurrentCleanup();
  assert.equal(drains, 1); assert.equal(closes, 1);
  owners.assertAvailable();
});

test('invalid initial clock does not permanently poison a later independent cleanup retry', async () => {
  let now = NaN, closes = 0, broken = true;
  const owners = new StartupApplicationCleanup(new PerformanceDiagnostics(() => {}, () => 0), () => now);
  owners.abandon([], [() => { closes++; if (broken) throw Error('close'); }]);
  await turn();
  assert.equal(closes, 1);
  now = 1000; broken = false;
  assert.throws(() => owners.assertAvailable(), StorageConnectionUnavailable);
  await owners.waitForCurrentCleanup();
  assert.equal(closes, 2); owners.assertAvailable();
});

test('startup cleanup holds replacement fence through its final diagnostic sink', async () => {
  let owners!: StartupApplicationCleanup, reentry: unknown = 'not-called', pending = -1;
  const diagnostics = new PerformanceDiagnostics(line => {
    if (JSON.parse(line).operation !== 'storage-startup-cleanup') return;
    pending = owners.snapshot().pending;
    try { owners.assertAvailable(); reentry = undefined; } catch (error) { reentry = error; }
  }, () => 0);
  owners = new StartupApplicationCleanup(diagnostics, () => 0);
  owners.abandon([], [() => {}]);
  await owners.waitForCurrentCleanup();
  assert.ok(reentry instanceof StorageConnectionUnavailable);
  assert.equal(pending, 1);
  owners.assertAvailable();
});

test('retry admission clock reentry observes the retained attempt without clock recursion', async () => {
  let owners!: StartupApplicationCleanup, now = 0, broken = true, closes = 0;
  let armed = false, clockCalls = 0, reentry: unknown;
  owners = new StartupApplicationCleanup(new PerformanceDiagnostics(() => {}, () => 0), () => {
    clockCalls++;
    if (armed) {
      armed = false;
      try { owners.assertAvailable(); } catch (error) { reentry = error; }
    }
    return now;
  });
  owners.abandon([], [() => { closes++; if (broken) throw Error('close'); }]);
  await turn();
  broken = false; now = 1000; armed = true; clockCalls = 0;
  assert.throws(() => owners.assertAvailable(), StorageConnectionUnavailable);
  await owners.waitForCurrentCleanup();
  assert.ok(reentry instanceof StorageConnectionUnavailable);
  assert.equal(clockCalls, 1); assert.equal(closes, 2);
});

test('an observer acquired by the initial admission clock waits for the original drain', async () => {
  let owners!: StartupApplicationCleanup, resolveDrain!: () => void;
  let observed!: Promise<void>, finished = false, closes = 0;
  owners = new StartupApplicationCleanup(new PerformanceDiagnostics(() => {}, () => 0), () => {
    observed = owners.waitForCurrentCleanup().then(() => { finished = true; });
    return 0;
  });
  owners.abandon([() => new Promise<void>(resolve => { resolveDrain = resolve; })], [() => { closes++; }]);
  await turn(); assert.equal(finished, false); assert.equal(closes, 0);
  resolveDrain(); await observed;
  assert.equal(finished, true); assert.equal(closes, 1);
});

test('invalid retry clock is not retry authority and does not prevent a later valid retry', async () => {
  let now = 0, closes = 0, broken = true;
  const owners = new StartupApplicationCleanup(new PerformanceDiagnostics(() => {}, () => 0), () => now);
  owners.abandon([], [() => { closes++; if (broken) throw Error('close'); }]);
  await turn(); broken = false; now = Infinity;
  assert.throws(() => owners.assertAvailable(), StorageConnectionUnavailable);
  await assert.rejects(owners.waitForCurrentCleanup(), StorageConnectionUnavailable);
  assert.equal(closes, 1);
  now = 1000; assert.throws(() => owners.assertAvailable(), StorageConnectionUnavailable);
  await owners.waitForCurrentCleanup(); assert.equal(closes, 2);
});
