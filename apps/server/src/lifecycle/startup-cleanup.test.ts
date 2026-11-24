import test from 'node:test';
import assert from 'node:assert/strict';
import { StartupApplicationCleanup } from './startup-cleanup.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { StorageConnectionUnavailable } from '../storage/connection-recovery.js';

const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture() {
  const logs: Record<string, unknown>[] = []; let now = 0;
  const owners = new StartupApplicationCleanup(new PerformanceDiagnostics(line => logs.push(JSON.parse(line)), () => now), () => now);
  return { owners, logs, tick: () => { now += 1000; } };
}

test('startup stops every admission immediately and retains dependencies until drain ACK', async () => {
  const f = fixture(); let stopped = 0, closed = 0, resolveDrain: (() => void) | undefined;
  const drains = [() => { stopped++; return new Promise<void>(resolve => { resolveDrain = resolve; }); }, () => { stopped++; }];
  const cleanups = [() => { closed++; }];
  f.owners.abandon(drains, cleanups);
  drains.length = 0; cleanups.length = 0;
  assert.equal(stopped, 2); assert.equal(closed, 0);
  for (let index = 0; index < 3; index++) { f.tick(); assert.throws(() => f.owners.assertAvailable(), StorageConnectionUnavailable); }
  assert.equal(stopped, 2); assert.equal(closed, 0);
  resolveDrain!(); await turn();
  f.owners.assertAvailable(); assert.equal(closed, 1);
});

test('unknown drain fences replacement permanently without replaying stops or closing dependencies', async () => {
  const f = fixture(); let stopped = 0, closed = 0;
  f.owners.abandon([() => { stopped++; throw Error('private-drain-fault'); }, () => { stopped++; }], [() => { closed++; }]);
  await turn();
  for (let index = 0; index < 3; index++) { f.tick(); assert.throws(() => f.owners.assertAvailable(), StorageConnectionUnavailable); }
  assert.equal(stopped, 2); assert.equal(closed, 0);
  assert.doesNotMatch(JSON.stringify(f.logs), /private-drain-fault/);
  assert.ok(f.logs.some(log => log.operation === 'storage-startup-cleanup' && log.unknown === 1));
});

test('failed cleanup retries only exact unsettled callbacks after cooldown, preserving settled steps', async () => {
  const f = fixture(); let drains = 0, known = 0, unknown = 0, broken = true;
  f.owners.abandon([() => { drains++; }], [() => { known++; }, () => { unknown++; if (broken) throw Error('private-close-fault'); }]);
  await turn();
  assert.equal(known, 0); assert.equal(unknown, 1);
  assert.throws(() => f.owners.assertAvailable(), StorageConnectionUnavailable);
  assert.equal(unknown, 1);
  f.tick(); broken = false;
  assert.throws(() => f.owners.assertAvailable(), StorageConnectionUnavailable);
  assert.throws(() => f.owners.assertAvailable(), StorageConnectionUnavailable);
  await turn(); f.owners.assertAvailable();
  assert.equal(drains, 1); assert.equal(known, 1); assert.equal(unknown, 2);
  assert.doesNotMatch(JSON.stringify(f.logs), /private-close-fault/);
  assert.ok(f.logs.some(log => log.operation === 'storage-startup-cleanup' && log.settled === 1));
});

test('an unknown consumer close retains dependencies and skips already acknowledged consumers on retry', async () => {
  const f = fixture(); const calls: string[] = []; let broken = true;
  f.owners.abandon([], [() => { calls.push('database'); }, () => { calls.push('runtime'); if (broken) throw Error('private-runtime-fault'); },
    () => { calls.push('routes'); }]);
  await turn();
  assert.deepEqual(calls, ['routes', 'runtime']);
  broken = false; f.tick();
  assert.throws(() => f.owners.assertAvailable(), StorageConnectionUnavailable);
  await turn(); f.owners.assertAvailable();
  assert.deepEqual(calls, ['routes', 'runtime', 'runtime', 'database']);
});

test('a secondary pending close cannot overlap a retry or disappear after warning time', async () => {
  const f = fixture(); let attempts = 0, resolveClose: (() => void) | undefined;
  f.owners.abandon([], [() => { attempts++; return new Promise<void>(resolve => { resolveClose = resolve; }); }]);
  await turn();
  for (let index = 0; index < 4; index++) { f.tick(); assert.throws(() => f.owners.assertAvailable(), StorageConnectionUnavailable); }
  assert.equal(attempts, 1);
  resolveClose!(); await turn(); f.owners.assertAvailable();
});

test('no-resource startup failure does not create an artificial cleanup gate', () => {
  const f = fixture(); f.owners.abandon([], []); f.owners.assertAvailable(); assert.deepEqual(f.logs, []);
});

test('cleanup observer waits for the existing attempt without retrying or releasing pending dependencies', async () => {
  const f = fixture(); let drains = 0, closes = 0, observed = false, resolveDrain!: () => void, resolveClose!: () => void;
  f.owners.abandon([() => { drains++; return new Promise<void>(resolve => { resolveDrain = resolve; }); }],
    [() => { closes++; return new Promise<void>(resolve => { resolveClose = resolve; }); }]);
  const observing = f.owners.waitForCurrentCleanup().then(() => { observed = true; });
  await turn(); assert.equal(observed, false); assert.equal(closes, 0);
  resolveDrain(); await turn(); assert.equal(closes, 1); assert.equal(observed, false);
  f.tick(); assert.throws(() => f.owners.assertAvailable(), StorageConnectionUnavailable);
  assert.equal(drains, 1); assert.equal(closes, 1);
  resolveClose(); await observing; f.owners.assertAvailable();
});

test('unknown cleanup observer rejects with a sanitized status and never retries the original callback', async () => {
  const f = fixture(); let calls = 0;
  f.owners.abandon([], [() => { calls++; throw Error('private-observer-close-fault'); }]);
  await assert.rejects(f.owners.waitForCurrentCleanup(), StorageConnectionUnavailable);
  await assert.rejects(f.owners.waitForCurrentCleanup(), error => {
    assert.doesNotMatch(String(error), /private-observer-close-fault/);
    return error instanceof StorageConnectionUnavailable;
  });
  assert.equal(calls, 1);
});
