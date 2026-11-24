import assert from 'node:assert/strict';
import test from 'node:test';
import { createPageRefreshGate } from './page-refresh.js';

test('refresh requires every mounted editor to be safe and rechecks changing state', () => {
  const gate = createPageRefreshGate();
  let saved = true;
  const release = gate.register(() => saved);
  assert.equal(gate.ready(), true);
  saved = false;
  assert.equal(gate.ready(), false);
  const releaseOther = gate.register(() => true);
  assert.equal(gate.ready(), false);
  release(); release();
  assert.equal(gate.ready(), true);
  releaseOther();
  assert.equal(gate.ready(), true);
});

test('failed guard blocks reload, registration does not mutate or submit anything', () => {
  const gate = createPageRefreshGate();
  let reads = 0;
  gate.register(() => { reads++; throw Error('Storage unavailable'); });
  assert.equal(reads, 0);
  assert.equal(gate.ready(), false);
  assert.equal(reads, 1);
});
