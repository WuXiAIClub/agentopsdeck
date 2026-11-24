import assert from 'node:assert/strict';
import test from 'node:test';
import { HubRequestWork } from './async-request-work.js';
import { HubMemberRequestError } from './async-member-request.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function held<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, bad) => { resolve = ok; reject = bad; });
  return { promise, resolve, reject };
}
const denied = (error: unknown) => error instanceof HubMemberRequestError && error.status === 503;

test('byte reservations survive waiter cancellation and close until original settlement', async () => {
  const work = new HubRequestWork(8, 10), gate = held<number>();
  const original = assert.rejects(work.run(() => gate.promise, 8), denied);
  assert.equal(work.pendingBytes, 8);
  for (const bytes of [3, -1, NaN, 1.1]) await assert.rejects(work.run(() => assert.fail('No physical work'), bytes), denied);
  assert.equal(await work.run(() => 1, 2), 1); assert.equal(work.pendingBytes, 8);
  const closing = work.close(); assert.equal(work.pendingBytes, 8);
  gate.resolve(1); await original; await closing; assert.equal(work.pendingBytes, 0);
});

for (const failure of [false, true]) test(`close retains whole original work; late failure=${failure}`, async () => {
  const work = new HubRequestWork(), gate = held<number>();
  const response = assert.rejects(work.run(() => gate.promise), denied);
  assert.equal(work.pending, 1);
  let closed = false;
  const closing = work.close(); assert.equal(work.close(), closing);
  void closing.then(() => { closed = true; });
  await tick(); assert.equal(closed, false); assert.equal(work.pending, 1);
  await assert.rejects(work.run(() => assert.fail('No replacement work')), denied);
  if (failure) gate.reject(Error('PRIVATE upstream failure')); else gate.resolve(7);
  await response; await closing; assert.equal(work.pending, 0); assert.equal(closed, true);
});

test('active result and exact active error retain original semantics', async () => {
  const work = new HubRequestWork(), error = Error('PRIVATE original error');
  assert.equal(await work.run(() => 7), 7);
  await assert.rejects(work.run(() => { throw error; }), value => value === error);
  await assert.rejects(work.run(() => Promise.reject(error)), value => value === error);
  assert.equal(work.pending, 0); await work.close();
});

test('reservation precedes reentrant close and never fabricates an early drain', async () => {
  const work = new HubRequestWork(), gate = held<number>();
  let closing!: Promise<void>, closed = false;
  const response = assert.rejects(work.run(() => {
    assert.equal(work.pending, 1); closing = work.close();
    void closing.then(() => { closed = true; }); return gate.promise;
  }), denied);
  await tick(); assert.equal(closed, false);
  gate.resolve(1); await response; await closing; assert.equal(closed, true);
});

test('256 unresolved non-SQL operations fill capacity until actual settlement', async () => {
  const work = new HubRequestWork(), gate = held<number>(); let calls = 0;
  const requests = Array.from({ length: 256 }, () => work.run(() => { calls++; return gate.promise; }));
  assert.equal(work.pending, 256);
  await assert.rejects(work.run(() => { calls++; return 2; }), denied);
  assert.equal(calls, 256); gate.resolve(1);
  assert.equal((await Promise.all(requests)).length, 256); assert.equal(work.pending, 0);
  assert.equal(await work.run(() => 2), 2); await work.close();
});

test('lifecycle lane preserves its original 32-operation capacity', async () => {
  const work = new HubRequestWork(32), gate = held<number>();
  const originals = Array.from({ length: 32 }, () => work.run(() => gate.promise));
  await assert.rejects(work.run(() => assert.fail('Must not exceed lifecycle capacity')), denied);
  assert.equal(work.pending, 32); gate.resolve(1); await Promise.all(originals);
  assert.equal(await work.run(() => 2), 2); await work.close();
});
