import assert from 'node:assert/strict';
import test from 'node:test';
import { createTaskDrain } from './task-drain.js';

function latch() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

test('task pause owns asynchronous cleanup, rejects new work, and resumes without replay', async () => {
  const tasks = createTaskDrain(), held = latch(), cleanup = latch();
  let calls = 0, drained = false;
  const result = tasks.run(async () => {
    calls++;
    try { await held.promise; throw new Error('synthetic'); }
    finally { await cleanup.promise; }
  }).catch(error => error);
  const lease = tasks.pause();
  assert.equal(tasks.pause(), lease);
  void lease.drained.then(() => { drained = true; });
  try {
    assert.equal(lease.resume(), false);
    await assert.rejects(tasks.run(() => { calls++; }), /maintenance/);
    held.release();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(drained, false);
    assert.equal(calls, 1);
  } finally { held.release(); cleanup.release(); }
  assert.match(String(await result), /synthetic/);
  await lease.drained;
  assert.equal(lease.resume(), true);
  assert.equal(await tasks.run(() => ++calls), 2);
  const next = tasks.pause();
  await next.drained;
  assert.equal(lease.resume(), false);
  await assert.rejects(tasks.run(() => { calls++; }), /maintenance/);
  assert.equal(next.resume(), true);
  assert.equal(calls, 2);
  await tasks.close();
});

test('closing a paused task owner waits every original task and makes all leases permanent', async () => {
  const tasks = createTaskDrain(), first = latch(), second = latch();
  const results = [tasks.run(() => first.promise), tasks.run(() => second.promise)];
  const lease = tasks.pause(), closing = tasks.close();
  assert.equal(tasks.close(), closing);
  let closed = false;
  void closing.then(() => { closed = true; });
  try {
    first.release(); await results[0];
    assert.equal(closed, false);
    assert.equal(lease.resume(), false);
    await assert.rejects(tasks.run(() => undefined), /closing/);
  } finally { first.release(); second.release(); await Promise.all(results); await closing; }
  await lease.drained;
  assert.equal(closed, true);
  assert.equal(lease.resume(), false);
  assert.equal(tasks.pause().resume(), false);
});

test('synchronous failures and thenables settle ownership without leaking admission counts', async () => {
  const tasks = createTaskDrain();
  await assert.rejects(tasks.run(() => { throw new Error('synchronous'); }), /synchronous/);
  await assert.rejects(tasks.run(() => ({ get then(): never { throw new Error('thenable'); } })), /thenable/);
  const lease = tasks.pause();
  await lease.drained;
  assert.equal(lease.resume(), true);
  assert.deepEqual(await tasks.run(() => ({ value: 42 })), { value: 42 });
  await tasks.close();
  await assert.rejects(tasks.run(() => undefined), /closing/);
});
