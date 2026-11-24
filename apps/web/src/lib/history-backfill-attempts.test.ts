import assert from 'node:assert/strict';
import test from 'node:test';
import { createHistoryBackfillAttempts } from './history-backfill-attempts.js';

test('superseded automatic reads get two delayed retries, never an unbounded loop', () => {
  const gate = createHistoryBackfillAttempts();
  for (let i = 1; i <= 3; i++) {
    const attempt = gate.begin('account/session/boundary')!;
    assert.equal(attempt.number, i);
    assert.equal(gate.begin(attempt.key), undefined);
    assert.equal(gate.retryDelay(attempt, 'superseded'), i < 3 ? i * 150 : undefined);
    assert.equal(gate.release(attempt), i < 3);
  }
  assert.equal(gate.begin('account/session/boundary'), undefined);
});

test('ordinary success and no progress do not auto-retry while retryable errors get two bounded retries', () => {
  const gate = createHistoryBackfillAttempts();
  const attempt = gate.begin('a')!;
  assert.equal(gate.retryDelay(attempt, undefined), undefined);
  assert.equal(gate.begin('a'), undefined);

  const errGate = createHistoryBackfillAttempts();
  for (let i = 1; i <= 3; i++) {
    const errAttempt = errGate.begin('b')!;
    assert.equal(errAttempt.number, i);
    assert.equal(errGate.retryDelay(errAttempt, 'retryable-error'), i < 3 ? i * 1000 : undefined);
    assert.equal(errGate.release(errAttempt), i < 3);
  }
  assert.equal(errGate.begin('b'), undefined);
});

test('new history boundary or session can progress; stale timers cannot release it', () => {
  const gate = createHistoryBackfillAttempts();
  const old = gate.begin('session-a:cursor1')!;
  const next = gate.begin('session-a:cursor2')!;
  assert.equal(next.number, 1);
  assert.equal(gate.retryDelay(old, 'superseded'), undefined);
  assert.equal(gate.release(old), false);
  assert.equal(gate.begin(next.key), undefined);
  assert.equal(gate.begin('session-b:cursor2')?.number, 1);
});

test('disposal invalidates outstanding retry tokens', () => {
  const gate = createHistoryBackfillAttempts();
  const old = gate.begin('a')!;
  gate.reset();
  assert.equal(gate.retryDelay(old, 'superseded'), undefined);
  assert.equal(gate.release(old), false);
  assert.equal(gate.begin('a')?.number, 1);
});
