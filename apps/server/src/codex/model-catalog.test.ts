import test from 'node:test';
import assert from 'node:assert/strict';
import { readModelCatalog } from './model-catalog.js';

test('native models are paginated, deduplicated and sanitized', async () => {
  const requests: unknown[] = [];
  const models = await readModelCatalog(async params => {
    requests.push(params);
    return params.cursor ? { data: [{ model: 'other', displayName: 'Other' }, { model: 'hidden', hidden: true }], nextCursor: null }
      : { data: [{ model: 'custom', displayName: 'Custom', secret: 'never' }, { id: 'not-a-model' }], nextCursor: 'page2' };
  });
  assert.deepEqual(models, [{ id: 'custom', label: 'Custom' }, { id: 'other', label: 'Other' }]);
  assert.deepEqual(requests, [{ limit: 100, includeHidden: false }, { limit: 100, includeHidden: false, cursor: 'page2' }]);
});
test('invalid, cyclic and unbounded catalogs fail instead of looping', async () => {
  await assert.rejects(readModelCatalog(async () => ({})), /Invalid native/);
  await assert.rejects(readModelCatalog(async () => ({ data: [], nextCursor: 'same' })), /cursor/);
  let next = 0;
  await assert.rejects(readModelCatalog(async () => ({ data: [], nextCursor: String(++next) })), /pagination limit/);
});
