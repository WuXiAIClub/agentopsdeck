import assert from 'node:assert/strict';
import test from 'node:test';
import { planHermesReplay } from './replay.js';

const cursor = { epoch: 'epoch', sessionId: 'live', seq: 3 };
const event = (seq: number, session = 'live') => ({ type: 'message.delta', session_id: session, seq, payload: { text: 'x' } });
const reply = (events: unknown[], latest = 5) => ({ epoch: 'epoch', truncated: false, latest_seq: latest, count: events.length, events });

test('Hermes replay validates params array and returns a new cursor without mutating the committed cursor', () => {
  const plan = planHermesReplay(cursor, reply([event(4), event(5)]));
  assert.equal(plan.kind, 'apply');
  if (plan.kind !== 'apply') throw new Error('Expected apply');
  assert.equal(plan.events.length, 2); assert.deepEqual(plan.next, { ...cursor, seq: 5 });
  assert.equal(cursor.seq, 3);
  assert.equal(planHermesReplay(plan.next, reply([], 5)).kind, 'apply');
});

test('Hermes replay fails closed for epoch change, truncation and same-epoch sequence rollback', () => {
  for (const [input, reason] of [
    [{ ...reply([]), epoch: 'new' }, 'epoch'],
    [{ ...reply([]), truncated: true }, 'truncated'],
    [reply([], 0), 'sequence'], // Upstream evicts seq state without changing epoch.
  ] as const) assert.deepEqual(planHermesReplay(cursor, input), { kind: 'snapshot', reason });
});

test('Hermes replay refuses gaps, duplicates, out-of-order and latest-seq inconsistencies atomically', () => {
  for (const input of [reply([event(5)]), reply([event(4), event(4)]), reply([event(5), event(4)]),
    reply([event(4)], 5), reply([event(4), event(5)], 4), reply([event(3)], 3), reply([], 5)]) {
    assert.deepEqual(planHermesReplay(cursor, input), { kind: 'snapshot', reason: 'sequence' });
  }
});

test('Hermes replay cannot mix sessions or accept whole RPC envelopes', () => {
  assert.deepEqual(planHermesReplay(cursor, reply([event(4), event(5, 'other')])), { kind: 'snapshot', reason: 'identity' });
  assert.deepEqual(planHermesReplay(cursor, reply([{ jsonrpc: '2.0', method: 'event', params: event(4) }], 4)),
    { kind: 'snapshot', reason: 'malformed' });
  assert.deepEqual(planHermesReplay(cursor, { ...reply([event(4)], 4), count: 2 }), { kind: 'snapshot', reason: 'malformed' });
  assert.deepEqual(planHermesReplay({ ...cursor, seq: -1 }, reply([])), { kind: 'snapshot', reason: 'identity' });
  assert.deepEqual(planHermesReplay(cursor, reply([{ ...event(4), seq: undefined }], 4)), { kind: 'snapshot', reason: 'sequence' });
});
