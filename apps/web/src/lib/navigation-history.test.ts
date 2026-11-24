import assert from 'node:assert/strict';
import test from 'node:test';
import { createNavigationHistory } from './navigation-history.js';

test('navigation pages expire without sliding expiry and cannot exceed LRU or byte budgets', () => {
  let now = 0;
  const cache = createNavigationHistory<string>(() => now, 80, 2);
  cache.put('a', 'one', 'hello', cache.epoch());
  cache.put('b', 'two', 'world', cache.epoch());
  assert.equal(cache.get('a'), 'hello');
  cache.put('c', 'three', 'next', cache.epoch());
  assert.equal(cache.get('b'), undefined);
  now = 29_999; assert.equal(cache.get('a'), 'hello');
  now = 30_000; assert.equal(cache.get('a'), undefined);
  cache.put('c', 'three', 'x'.repeat(50), cache.epoch());
  assert.equal(cache.get('c'), undefined, 'oversized update also evicts its old snapshot');
});
test('scope, node and event invalidation fences in-flight seeding; errors do not retain success', () => {
  const cache = createNavigationHistory<number>();
  const epoch = cache.epoch();
  cache.put('account1:hub1:node1:200', 'node1:session', 1, epoch);
  cache.put('account1:hub1:node2:200', 'node2:session', 2, epoch);
  assert.equal(cache.get('account2:hub1:node1:200'), undefined);
  assert.equal(cache.get('account1:hub2:node1:200'), undefined);
  assert.equal(cache.get('account1:hub1:node1:400'), undefined);
  cache.clear(session => session.startsWith('node1:'));
  cache.put('account1:hub1:node1:200', 'node1:session', 3, epoch);
  assert.equal(cache.get('account1:hub1:node1:200'), undefined);
  assert.equal(cache.get('account1:hub1:node2:200'), 2);
  cache.clear(); assert.equal(cache.get('account1:hub1:node2:200'), undefined);
});
