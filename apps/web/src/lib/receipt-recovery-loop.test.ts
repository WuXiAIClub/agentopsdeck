import assert from 'node:assert/strict';
import test from 'node:test';
import { createReceiptRecoveryLoop, receiptFailureKind } from './receipt-recovery-loop.js';

const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

test('new unknown records recover without remounting; events cannot reset backoff', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10_000 });
  let rows: string[] = [];
  let accepted = false;
  const calls: number[] = [];
  const loop = createReceiptRecoveryLoop({ read: () => rows, identity: row => row,
    enabled: () => true, busy: () => false, check: async () => { calls.push(Date.now()); if (accepted) rows = []; } });
  t.after(() => loop.stop());
  loop.request(true); t.mock.timers.tick(60_000); await settle(); assert.equal(calls.length, 0);
  rows = ['new']; loop.request(); t.mock.timers.tick(1_000); loop.request();
  t.mock.timers.tick(1_000); await settle(); assert.equal(calls.length, 1);
  loop.request(); t.mock.timers.tick(2_000); await settle(); assert.equal(calls.length, 2);
  accepted = true; loop.request(); t.mock.timers.tick(4_999); await settle(); assert.equal(calls.length, 2);
  t.mock.timers.tick(1); await settle(); assert.equal(calls.length, 3);
  t.mock.timers.tick(600_000); await settle(); assert.equal(calls.length, 3, 'no reads once all records resolve');
});

test('old unavailable receipts cannot starve record five; batches are bounded and paced', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10_000 });
  const rows = Array.from({ length: 9 }, (_, i) => String(i));
  const calls: string[][] = [];
  const loop = createReceiptRecoveryLoop({ read: () => rows, identity: row => row,
    enabled: () => true, busy: () => false, check: async batch => { calls.push(batch); } });
  t.after(() => loop.stop());
  loop.request(true); t.mock.timers.tick(0); await settle();
  t.mock.timers.tick(1_000); await settle(); t.mock.timers.tick(1_000); await settle();
  assert.deepEqual(calls.slice(0, 2), [['0', '1', '2', '3'], ['4', '5', '6', '7']]);
  assert.equal(calls[2]![0], '8'); assert.ok(calls.every(batch => batch.length <= 4));
});

test('hidden/offline recovery pauses and resumes; stopping during a read cannot restart timers', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10_000 });
  let enabled = false, calls = 0;
  let release!: () => void;
  const loop = createReceiptRecoveryLoop({ read: () => ['a'], identity: row => row,
    enabled: () => enabled, busy: () => false,
    check: async () => { calls++; await new Promise<void>(resolve => { release = resolve; }); } });
  loop.request(true); t.mock.timers.tick(60_000); await settle(); assert.equal(calls, 0);
  enabled = true; loop.request(true); t.mock.timers.tick(0); await settle(); assert.equal(calls, 1);
  loop.request(true); t.mock.timers.tick(60_000); await settle(); assert.equal(calls, 1, 'no overlapping GET');
  loop.stop(); release(); await settle(); t.mock.timers.tick(600_000); await settle(); assert.equal(calls, 1);
});

test('manual checks and automatic reads cannot overlap, and busy waits do not consume attempts', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10_000 });
  let busy = true, calls = 0;
  const loop = createReceiptRecoveryLoop({ read: () => ['a'], identity: row => row,
    enabled: () => true, busy: () => busy, check: async () => { calls++; } });
  t.after(() => loop.stop()); loop.request(true);
  t.mock.timers.tick(0); await settle(); assert.equal(calls, 0);
  busy = false; t.mock.timers.tick(1_000); await settle(); assert.equal(calls, 1);
  t.mock.timers.tick(2_000); await settle(); assert.equal(calls, 2);
});

test('failed receipt queries back off to one per minute instead of polling continuously', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10_000 });
  const calls: number[] = [];
  const loop = createReceiptRecoveryLoop({ read: () => ['a'], identity: row => row,
    enabled: () => true, busy: () => false, check: async () => { calls.push(Date.now()); throw new Error('unavailable'); } });
  t.after(() => loop.stop()); loop.request(true); t.mock.timers.tick(0); await settle();
  for (const delay of [2_000, 5_000, 10_000, 30_000, 60_000, 60_000]) {
    loop.request(); t.mock.timers.tick(delay - 1); await settle(); const count = calls.length;
    t.mock.timers.tick(1); await settle(); assert.equal(calls.length, count + 1);
  }
  assert.deepEqual(calls, [10_000, 12_000, 17_000, 27_000, 57_000, 117_000, 177_000]);
});

test('scope disabled before a scheduled check prevents the request', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 10_000 });
  let validScope = true, calls = 0;
  const loop = createReceiptRecoveryLoop({ read: () => ['a'], identity: row => row,
    enabled: () => validScope, busy: () => false, check: async () => { calls++; } });
  t.after(() => loop.stop()); loop.request(); validScope = false;
  t.mock.timers.tick(60_000); await settle(); assert.equal(calls, 0);
});

test('receipt diagnostics distinguish missing, permissions, authentication and temporary errors', () => {
  assert.equal(receiptFailureKind({ status: 404 }), 'missing');
  assert.equal(receiptFailureKind({ status: 410 }), 'missing');
  assert.equal(receiptFailureKind({ status: 403 }), 'denied');
  assert.equal(receiptFailureKind({ status: 401 }), 'auth');
  assert.equal(receiptFailureKind({ name: 'AuthRequiredError' }), 'auth');
  for (const error of [{ status: 503 }, new Error('timeout'), new TypeError('invalid body'), undefined]) {
    assert.equal(receiptFailureKind(error), 'temporary');
  }
});
