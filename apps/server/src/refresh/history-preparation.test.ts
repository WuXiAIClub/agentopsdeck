import assert from 'node:assert/strict';
import test from 'node:test';
import { createHistoryPreparation } from './history-preparation.js';
import { HistoryReadSuperseded } from './history.js';

const signal = () => new AbortController().signal;
function deferred() { let resolve!: () => void, reject!: (error: Error) => void; const promise = new Promise<void>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

test('slow history releases HTTP waiters; polling/concurrent readers join one owned task and claim its completion', async () => {
  const prepare = createHistoryPreparation({ waitMs: 5 });
  const work = deferred(); let reads = 0, ready = false;
  const read = () => { reads++; return work.promise.then(() => { ready = true; }); };
  assert.deepEqual(await Promise.all(Array.from({ length: 8 }, () => prepare('one', read, () => ready, signal()))), Array(8).fill('pending'));
  assert.equal(await prepare('one', read, () => ready, signal()), 'pending'); assert.equal(reads, 1);
  work.resolve(); await work.promise;
  assert.equal(await prepare('one', read, () => ready, signal()), 'ready'); assert.equal(reads, 1);
  assert.equal(await prepare('one', read, () => ready, signal()), 'ready'); assert.equal(reads, 2, 'ticket is not a persistent readiness cache');
});

test('failures remain failures, including failure after the HTTP response', async () => {
  const prepare = createHistoryPreparation({ waitMs: 1 }), work = deferred();
  assert.equal(await prepare('one', () => work.promise, () => false, signal()), 'pending');
  work.reject(new Error('private upstream body')); await work.promise.catch(() => {});
  assert.equal(await prepare('one', () => Promise.resolve(), () => false, signal()), 'failed');
  assert.equal(await prepare('one', () => Promise.reject(Error('immediate')), () => false, signal()), 'failed');
});

test('superseded reads release their ticket as pending, without certifying or hiding actual failures', async () => {
  const prepare = createHistoryPreparation({ waitMs: 5 });
  assert.equal(await prepare('one', async () => { throw new HistoryReadSuperseded('superseded'); }, () => false, signal()), 'pending');
  assert.equal(await prepare('one', async () => {}, () => true, signal()), 'ready');
  assert.equal(await prepare('one', async () => { throw new Error('Codex thread snapshot obsolete'); }, () => false, signal()), 'failed',
    'do not classify arbitrary upstream error text as retryable');
});

test('successful hydration handed off to another runtime read is pending, never a false completion', async () => {
  const prepare = createHistoryPreparation({ waitMs: 5 });
  assert.equal(await prepare('one', async () => {}, () => false, signal()), 'pending');
  assert.equal(await prepare('one', async () => {}, () => true, signal()), 'ready');
  assert.equal(await prepare('one', async () => { throw Error('real failure'); }, () => true, signal()), 'failed',
    'a readable replica must not conceal an actual failed source read');
});

test('aborting one transport does not abort shared work or retain its waiter', async () => {
  const prepare = createHistoryPreparation({ waitMs: 5 }), work = deferred(), controller = new AbortController();
  let reads = 0;
  const pending = prepare('one', () => { reads++; return work.promise; }, () => false, controller.signal);
  controller.abort(new Error('cancelled')); await assert.rejects(pending, /cancelled/);
  assert.equal(await prepare('one', () => { reads++; return work.promise; }, () => false, signal()), 'pending');
  assert.equal(reads, 1); work.resolve();
});

test('invalidated completion is not readiness; capacity and expiry bound unclaimed metadata without evicting active work', async () => {
  let now = 0, reads = 0;
  const prepare = createHistoryPreparation({ waitMs: 1, capacity: 1, now: () => now }), work = deferred();
  assert.equal(await prepare('one', () => work.promise, () => false, signal()), 'pending');
  now = 99_000;
  assert.equal(await prepare('other', async () => { reads++; }, () => true, signal()), 'failed'); assert.equal(reads, 0);
  work.resolve(); await work.promise; await new Promise(resolve => setImmediate(resolve));
  assert.equal(await prepare('one', async () => { reads++; }, () => false, signal()), 'pending'); assert.equal(reads, 1);
  const second = deferred();
  assert.equal(await prepare('one', () => second.promise, () => true, signal()), 'pending');
  second.resolve(); await second.promise; await new Promise(resolve => setImmediate(resolve)); now += 30_001;
  assert.equal(await prepare('other', async () => { reads++; }, () => true, signal()), 'ready'); assert.equal(reads, 2);
});
