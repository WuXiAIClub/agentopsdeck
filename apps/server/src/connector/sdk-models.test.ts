import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSdkModelChoices, sdkModelChoices } from './sdk-models.js';

test('SDK catalog preserves default, order and private provider aliases without vendor assumptions', () => {
  assert.deepEqual(parseSdkModelChoices('my-default', undefined), ['my-default']);
  assert.deepEqual(parseSdkModelChoices('my-default', ' other, my-default, provider/alias '), ['my-default', 'other', 'provider/alias']);
  assert.deepEqual(sdkModelChoices('only'), ['only']);
});
test('SDK catalogs reject empty entries, controls, oversized IDs and unbounded lists', () => {
  for (const value of ['a,,b', 'bad model', 'bad\nmodel', 'a,', 'x'.repeat(257), Array(101).fill('a').join(',')]) {
    assert.throws(() => parseSdkModelChoices('default', value), /Invalid SDK model catalog/);
  }
});

test('SDK maximum catalog remains valid after configuration normalization', () => {
  const choices = Array.from({ length: 99 }, (_, index) => `model-${index}`);
  const catalog = parseSdkModelChoices('default', choices.join(','));
  assert.equal(catalog.length, 100);
  assert.deepEqual(sdkModelChoices('default', catalog), catalog);
  assert.throws(() => parseSdkModelChoices('default', [...choices, 'one-too-many'].join(',')));
});
