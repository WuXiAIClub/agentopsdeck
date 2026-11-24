import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { configuredModelProvider, ProviderModelCatalog } from './provider-model-catalog.js';

const config = (base_url: string, extra = {}) => ({ config: { model_provider: 'private', model_providers: { private: { base_url, env_key: 'CATALOG_TEST_KEY', ...extra } } } });
test('effective private provider resolves only its credential and never logs/configures a default model', () => {
  const first = configuredModelProvider(config('http://127.0.0.1:123/v1/'), undefined, { CATALOG_TEST_KEY: 'own-key', OPENAI_API_KEY: 'other-key' })!;
  assert.equal(first.url, 'http://127.0.0.1:123/v1/models');
  assert.equal(first.headers.authorization, 'Bearer own-key');
  assert.ok(!first.fingerprint.includes('own-key'));
  assert.notEqual(first.fingerprint, configuredModelProvider(config('http://127.0.0.1:123/v1/'), undefined, { CATALOG_TEST_KEY: 'rotated' })!.fingerprint);
  assert.throws(() => configuredModelProvider(config('http://localhost/v1'), undefined, { OPENAI_API_KEY: 'not-own-key' }), /unavailable/);
  assert.throws(() => configuredModelProvider(config('http://user:secret@localhost/v1'), undefined, { CATALOG_TEST_KEY: 'own' }), /unavailable/);
  assert.equal(configuredModelProvider({ config: { model_provider: 'openai' } }), undefined);
  assert.throws(() => configuredModelProvider({}, 'missing'), /unavailable/);
});

test('HTTP discovery coalesces, deduplicates, isolates credential rotation, fails closed and recovers', async t => {
  let calls = 0, status = 200, ids = ['auto', 'gpt-6.1-sol', 'gpt-6-luna', 'gpt-5.6-terra', 'gemini-4-argon', 'auto'];
  const server = createServer((request, response) => {
    calls++; assert.equal(request.url, '/v1/models'); assert.ok(request.headers.authorization?.startsWith('Bearer '));
    response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify({ data: ids.map(id => ({ id })) }));
  });
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
  t.after(() => new Promise<void>(ok => { server.closeAllConnections(); server.close(() => ok()); }));
  const address = server.address() as { port: number }, catalog = new ProviderModelCatalog(); t.after(() => catalog.close());
  const provider = (key: string) => configuredModelProvider(config(`http://127.0.0.1:${address.port}/v1`), undefined, { CATALOG_TEST_KEY: key })!;
  const results = await Promise.all(Array.from({ length: 8 }, () => catalog.read(provider('own'))));
  assert.equal(calls, 1); assert.equal(results[0]!.length, 5); assert.equal(results[0]![4]!.id, 'gemini-4-argon');
  results[0]!.pop(); assert.equal((await catalog.read(provider('own'))).length, 5);
  status = 401; await assert.rejects(catalog.read(provider('rotated')), /^Error: Provider model discovery unavailable$/);
  await assert.rejects(catalog.read(provider('rotated'))); assert.equal(calls, 2, 'failed reads are briefly throttled, not replaced by stale success');
  status = 200; ids = ['restored']; assert.deepEqual(await catalog.read(provider('restored')), [{ id: 'restored', label: 'restored' }]);
  await catalog.close(); await assert.rejects(catalog.read(provider('restored')));
});

test('malformed/oversized catalogs, HTTP errors and redirects cannot become choices', async () => {
  const provider = configuredModelProvider(config('http://localhost/v1'), undefined, { CATALOG_TEST_KEY: 'own' })!;
  for (const body of [{}, { data: [{ id: ' bad' }] }, { data: Array.from({ length: 513 }, () => ({ id: 'a' })) }, { data: [{ id: 'x'.repeat(140000) }] }]) {
    const catalog = new ProviderModelCatalog((async (_url, init) => {
      assert.equal(init?.redirect, 'error'); assert.equal(init?.credentials, 'omit');
      return new Response(JSON.stringify(body));
    }) as typeof fetch);
    await assert.rejects(catalog.read(provider), /unavailable/); await catalog.close();
  }
});

test('timeout and close abort the owned network request and permit no late cache delivery', async () => {
  const provider = configuredModelProvider(config('http://localhost/v1'), undefined, { CATALOG_TEST_KEY: 'own' })!;
  const fetcher = ((_url: unknown, init: RequestInit) => new Promise<Response>((_ok, reject) => {
    init.signal!.addEventListener('abort', () => reject(new Error('secret upstream detail')), { once: true });
  })) as typeof fetch;
  const keepAlive = setInterval(() => {}, 50);
  try {
    const timed = new ProviderModelCatalog(fetcher, 15); await assert.rejects(timed.read(provider), /^Error: Provider model discovery unavailable$/); await timed.close();
    const closing = new ProviderModelCatalog(fetcher); const work = closing.read(provider); await closing.close(); await assert.rejects(work, /unavailable/);
  } finally { clearInterval(keepAlive); }
});
