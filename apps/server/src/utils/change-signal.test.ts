import assert from 'node:assert/strict';
import test from 'node:test';
import { getEventListeners } from 'node:events';
import { ChangeSignal } from './change-signal.js';

test('change wakeups coalesce and cover changes before and after registration', async () => {
  const changes = new ChangeSignal();
  const controller = new AbortController();
  const revision = changes.revision;
  changes.notify();
  changes.notify();
  await changes.wait(revision, controller.signal);
  assert.equal(changes.waiting, 0);
  const pending = changes.wait(changes.revision, controller.signal);
  assert.equal(changes.waiting, 1);
  changes.notify();
  await pending;
  assert.equal(changes.waiting, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('change waits clean up on timeout, early/late abort and repeated race cancellation', async () => {
  const changes = new ChangeSignal();
  const controller = new AbortController();
  await changes.wait(changes.revision, controller.signal, 1);
  assert.equal(changes.waiting, 0);
  const pending = changes.wait(changes.revision, controller.signal);
  controller.abort();
  await pending;
  await changes.wait(changes.revision, controller.signal);
  assert.equal(changes.waiting, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  const other = new ChangeSignal();
  for (let i = 0; i < 300; i++) {
    const race = new AbortController();
    const pending = Promise.race([changes.wait(changes.revision, race.signal, 60_000), other.wait(other.revision, race.signal)]);
    changes.notify();
    await pending;
    race.abort();
    assert.equal(changes.waiting + other.waiting, 0);
    assert.equal(getEventListeners(race.signal, 'abort').length, 0);
  }
});

test('change wait capacity fails explicitly and is reusable after cancellation', async () => {
  const changes = new ChangeSignal();
  const controllers = Array.from({ length: 256 }, () => new AbortController());
  const pending = controllers.map(c => changes.wait(changes.revision, c.signal));
  await assert.rejects(changes.wait(changes.revision, new AbortController().signal), /capacity/);
  for (const c of controllers) c.abort();
  await Promise.all(pending);
  assert.equal(changes.waiting, 0);
  const next = changes.wait(changes.revision, new AbortController().signal);
  changes.notify();
  await next;
});
