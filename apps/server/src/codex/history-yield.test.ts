import assert from 'node:assert/strict';
import test from 'node:test';
import { HistoryYield } from './history-yield.js';

test('small histories have no scheduling await; record and size batches yield and reset', async () => {
  const fairness = new HistoryYield();
  for (let i = 0; i < 255; i++) assert.equal(fairness.checkpoint(1), undefined);
  await fairness.checkpoint(1);
  assert.equal(fairness.checkpoint(1), undefined);
  const large = fairness.checkpoint(256 * 1024);
  assert.ok(large instanceof Promise);
  await large;
  assert.equal(fairness.checkpoint(1), undefined);
});
