import assert from 'node:assert/strict';
import test from 'node:test';
import { createHistoryReadCoalescer, HistoryPreparing, readPreparedHistory } from './history-preparation.js';

test('duplicate panes share preparation; one cancellation cannot cancel the other', async () => {
  const run = createHistoryReadCoalescer(), first = new AbortController(), second = new AbortController();
  let release!: (value: string) => void, reads = 0, transport!: AbortSignal;
  const read = (signal: AbortSignal) => { reads++; transport = signal; return new Promise<string>(resolve => { release = resolve; }); };
  const a = run('same', read, first.signal), b = run('same', read, second.signal);
  const rejected = assert.rejects(a, /aborted/i);
  await Promise.resolve(); first.abort(); await rejected;
  assert.equal(reads, 1); assert.equal(transport.aborted, false);
  release('verified'); assert.equal(await b, 'verified');
  assert.equal(await run('same', async () => 'fresh'), 'fresh', 'completed data is not cached');
});

test('last cancellation aborts owned transport and a new mount does not inherit it', async () => {
  const run = createHistoryReadCoalescer(), controller = new AbortController();
  let transport!: AbortSignal;
  const old = run('same', signal => { transport = signal; return new Promise<string>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))); }, controller.signal);
  const rejected = assert.rejects(old, /aborted/i);
  await Promise.resolve(); controller.abort(); await rejected;
  assert.equal(transport.aborted, true);
  assert.equal(await run('same', async signal => { assert.equal(signal.aborted, false); return 'new'; }), 'new');
});

test('an immediate consumer promotes queued shared work without duplicating the read', async () => {
  const run = createHistoryReadCoalescer();
  let calls = 0, promoted = 0, release!: (value: string) => void;
  const first = run('scheduled', () => { calls++; return new Promise<string>(resolve => { release = resolve; }); }, undefined,
    { immediate: false, onImmediateJoin: () => { promoted++; } });
  const second = run('scheduled', async () => { throw Error('must coalesce'); }, undefined, { immediate: true });
  await Promise.resolve();
  assert.equal(promoted, 1); assert.equal(calls, 1);
  release('same page');
  assert.deepEqual(await Promise.all([first, second]), ['same page', 'same page']);
});

test('only explicit preparation is retried, ordinary failures are not concealed', async () => {
  let reads = 0;
  const result = await readPreparedHistory(async () => { if (++reads < 3) throw new HistoryPreparing(1); return 'verified'; }, () => {});
  assert.equal(result, 'verified'); assert.equal(reads, 3);
  reads = 0;
  await assert.rejects(readPreparedHistory(async () => { reads++; throw Error('real failure'); }, () => {}), /real failure/);
  assert.equal(reads, 1);
});

test('preparation is finite, cancellable, and checks account changes before another read or publication', async () => {
  let reads = 0;
  await assert.rejects(readPreparedHistory(async () => { reads++; throw new HistoryPreparing(1000); }, () => {}, undefined, { maxWaitMs: 5 }), /still synchronizing/);
  assert.equal(reads, 1);
  const controller = new AbortController();
  const waiting = readPreparedHistory(async () => { queueMicrotask(() => controller.abort(Error('cancelled'))); throw new HistoryPreparing(1000); }, () => {}, controller.signal);
  await assert.rejects(waiting, /cancelled/);
  let changed = false;
  await assert.rejects(readPreparedHistory(async () => { changed = true; return 'private'; }, () => { if (changed) throw Error('account changed'); }), /account changed/);
  await assert.rejects(readPreparedHistory(async () => { throw Error('must not read'); }, () => { throw Error('account changed'); }), /account changed/);
});
