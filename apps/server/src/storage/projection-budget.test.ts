import assert from 'node:assert/strict';
import test from 'node:test';
import { ProjectionSpaceBudget, StorageSpaceDeferred } from './space-budget.js';

const MiB = 1024 * 1024;
test('low space shares one failed probe and retries only on demand after a second', async () => {
  let now = 0, calls = 0, free = 256n * BigInt(MiB);
  const budget = new ProjectionSpaceBudget('fixture', async () => { calls++; return free; }, () => now);
  const attempt = () => budget.consume(MiB);
  const first = await Promise.allSettled(Array.from({ length: 8 }, attempt));
  assert.ok(first.every(result => result.status === 'rejected' && result.reason instanceof StorageSpaceDeferred));
  assert.equal(calls, 1);
  now = 999;
  await assert.rejects(attempt(), StorageSpaceDeferred);
  assert.equal(calls, 1, 'a denied request must not cause another filesystem probe');
  free = 1024n * BigInt(MiB);
  await assert.rejects(attempt(), StorageSpaceDeferred);
  now = 1000;
  await attempt();
  assert.equal(calls, 2);
  now = 20_000;
  assert.equal(calls, 2, 'no background retry or disk polling');
});

test('reserve boundary admits initially but recovery needs an extra 64MiB', async () => {
  let now = 0, free = 272n * BigInt(MiB), calls = 0;
  const budget = new ProjectionSpaceBudget('fixture', async () => { calls++; return free; }, () => now);
  await budget.consume(16 * MiB);
  free--;
  await assert.rejects(budget.consume(1), StorageSpaceDeferred);
  free++;
  now = 1000;
  await assert.rejects(budget.consume(1), StorageSpaceDeferred);
  free = 336n * BigInt(MiB) - 1n;
  now = 2000;
  await assert.rejects(budget.consume(1), StorageSpaceDeferred);
  free++;
  now = 3000;
  await budget.consume(16 * MiB);
  assert.equal(calls, 5);
  free = 272n * BigInt(MiB);
  await budget.consume(16 * MiB);
  assert.equal(calls, 6, 'successful recovery clears the higher reserve requirement');
});

test('clock reversal does not strand denied requests; invalid writes do not probe', async () => {
  let now = 5000, free = 0n, calls = 0;
  const budget = new ProjectionSpaceBudget('fixture', async () => { calls++; return free; }, () => now);
  await assert.rejects(budget.consume(1), StorageSpaceDeferred);
  now = 4000; free = 1024n * BigInt(MiB);
  await budget.consume(1);
  assert.equal(calls, 2);
  for (const invalid of [-1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(budget.consume(invalid));
  await budget.consume(0);
  assert.equal(calls, 2);
});

test('I/O failures remain errors and do not erase a low-space recovery requirement', async () => {
  let now = 0, free = 0n, broken = false, calls = 0;
  const io = Object.assign(Error('fixture I/O'), { code: 'EIO' });
  const budget = new ProjectionSpaceBudget('fixture', async () => { calls++; if (broken) throw io; return free; }, () => now);
  await assert.rejects(budget.consume(1), StorageSpaceDeferred);
  now = 1000; broken = true;
  await assert.rejects(budget.consume(1), error => error === io);
  broken = false; free = 272n * BigInt(MiB);
  await assert.rejects(budget.consume(1), StorageSpaceDeferred);
  now = 2000; free = 336n * BigInt(MiB);
  await budget.consume(1);
  assert.equal(calls, 4);
});
