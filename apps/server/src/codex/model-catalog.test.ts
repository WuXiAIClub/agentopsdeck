import test from 'node:test';
import assert from 'node:assert/strict';
import { readModelCatalog } from './model-catalog.js';
import { configuredModelProvider } from './provider-model-catalog.js';

test('an explicit native model catalog takes precedence over custom provider HTTP discovery', () => {
  const effective = { config: {
    model_provider: 'private',
    model_catalog_json: '/synthetic/codex-home/models.json',
    model_providers: { private: { base_url: 'http://localhost/v1', env_key: 'CATALOG_TEST_KEY' } },
  } };
  assert.equal(configuredModelProvider(effective, 'private', {}), undefined);
  effective.config.model_catalog_json = '';
  assert.throws(() => configuredModelProvider(effective, 'private', {}), /unavailable/);
});

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
