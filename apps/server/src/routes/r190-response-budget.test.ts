import assert from 'node:assert/strict';
import test from 'node:test';
import { ConnectorResponseBudgetPool, ConnectorResponseBudgetExceeded } from '../hub/response-budget.js';

test('original collected bytes remain charged until explicit original-work settlement', () => {
  const pool = new ConnectorResponseBudgetPool(100), a = pool.acquire(60), b = pool.acquire(60);
  a.consume(60); b.consume(40);
  assert.equal(pool.retainedBytes, 100);
  assert.throws(() => b.consume(1), ConnectorResponseBudgetExceeded);
  assert.equal(pool.retainedBytes, 100);
  assert.deepEqual(b.snapshot(), { retainedBytes: 40, refused: true, closed: false });
  a.close(); assert.equal(pool.retainedBytes, 40);
  // Original refusal is sticky despite a later change in available capacity.
  assert.throws(() => b.consume(1), ConnectorResponseBudgetExceeded);
  b.close(); assert.equal(pool.retainedBytes, 0);
  const fresh = pool.acquire(60); fresh.consume(60); fresh.close();
  assert.equal(pool.retainedBytes, 0);
});

test('per-request limit cannot borrow spare global bytes', () => {
  const pool = new ConnectorResponseBudgetPool(100), request = pool.acquire(20);
  request.consume(20); assert.throws(() => request.consume(1), ConnectorResponseBudgetExceeded);
  assert.equal(pool.retainedBytes, 20); request.close();
});

test('failed consumption never charges a partial chunk', () => {
  const pool = new ConnectorResponseBudgetPool(100), request = pool.acquire(20);
  request.consume(10); assert.throws(() => request.consume(11), ConnectorResponseBudgetExceeded);
  assert.equal(pool.retainedBytes, 10); request.close();
});

test('close is idempotent and a stale collector cannot spend a new request reservation', () => {
  const pool = new ConnectorResponseBudgetPool(100), old = pool.acquire(100);
  old.consume(90); old.close(); old.close();
  const fresh = pool.acquire(100); fresh.consume(100);
  assert.throws(() => old.consume(0), ConnectorResponseBudgetExceeded);
  old.close(); assert.equal(pool.retainedBytes, 100);
  fresh.close(); assert.equal(pool.retainedBytes, 0);
});

test('eight concurrent request collectors cannot cumulatively exceed the pool', () => {
  const pool = new ConnectorResponseBudgetPool(128), requests = Array.from({ length: 8 }, () => pool.acquire(32));
  for (const request of requests) request.consume(16);
  assert.equal(pool.retainedBytes, 128);
  for (const request of requests) assert.throws(() => request.consume(1), ConnectorResponseBudgetExceeded);
  assert.equal(pool.retainedBytes, 128);
  for (const request of requests) request.close();
  assert.equal(pool.retainedBytes, 0);
});

test('zero-byte transport chunks do not borrow or release capacity', () => {
  const pool = new ConnectorResponseBudgetPool(10), request = pool.acquire(10);
  request.consume(10); request.consume(0); assert.equal(pool.retainedBytes, 10); request.close();
});

for (const invalid of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
  test(`invalid chunk size is a sticky refusal without changing accounting (${invalid})`, () => {
    const pool = new ConnectorResponseBudgetPool(100), request = pool.acquire(50);
    request.consume(1); assert.throws(() => request.consume(invalid), ConnectorResponseBudgetExceeded);
    assert.equal(pool.retainedBytes, 1);
    assert.throws(() => request.consume(0), ConnectorResponseBudgetExceeded);
    request.close(); assert.equal(pool.retainedBytes, 0);
  });
}

test('invalid configuration is refused before a reservation exists', () => {
  for (const invalid of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => new ConnectorResponseBudgetPool(invalid), RangeError);
    assert.throws(() => new ConnectorResponseBudgetPool(100).acquire(invalid), RangeError);
  }
  assert.throws(() => new ConnectorResponseBudgetPool(100).acquire(101), RangeError);
});

test('abort or elapsed time alone cannot refund original collected bytes', async () => {
  const pool = new ConnectorResponseBudgetPool(100), request = pool.acquire(100), controller = new AbortController();
  request.consume(100); controller.abort();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(pool.retainedBytes, 100); assert.equal(request.snapshot().closed, false);
  request.close(); assert.equal(pool.retainedBytes, 0);
});
