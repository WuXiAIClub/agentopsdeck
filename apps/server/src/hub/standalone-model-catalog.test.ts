import assert from 'node:assert/strict';
import test from 'node:test';
import { StandaloneModelCatalog } from './standalone-model-catalog.js';

const config = { url: 'https://synthetic.example/v1/responses', model: 'astra', token: 'synthetic', users: ['alice'] };
test('credential-scoped bounded catalog, default preference, deduplication, single flight and cache', async () => {
  let now = 1000, calls = 0;
  const catalog = new StandaloneModelCatalog(config, async (url, init) => {
    calls++; assert.equal(url, 'https://synthetic.example/v1/models'); assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'error'); assert.equal(init?.credentials, 'omit');
    assert.deepEqual(init?.headers, { Authorization: 'Bearer synthetic', Accept: 'application/json' });
    return Response.json({ data: [{ id: 'astra' }, { id: 'sol' }, { id: 'sol' }] });
  }, () => now, { discoverModels: true, defaultModel: 'sol' });
  await Promise.all([catalog.read(), catalog.read()]); assert.equal(calls, 1);
  assert.deepEqual(catalog.target().models.map(m => m.id), ['astra', 'sol']); assert.equal(catalog.target().model, 'sol');
  const copy = catalog.target(); copy.models[0]!.id = 'mutation'; assert.equal(catalog.target().models[0]!.id, 'astra');
  await catalog.read(); assert.equal(calls, 1); now += 60_001; await catalog.read(); assert.equal(calls, 2); catalog.close();
});
test('discovery opt-in and only administrator default on failures, never stale extra permission', async () => {
  let calls = 0, now = 1000;
  const off = new StandaloneModelCatalog(config, async () => { calls++; throw Error('never'); }, () => now);
  assert.equal((await off.read()).model, 'astra'); assert.equal(calls, 0); off.close();
  const catalog = new StandaloneModelCatalog(config, async () => {
    calls++; return calls === 1 ? Response.json({ data: [{ id: 'sol' }] }) : new Response('blocked', { status: 403 });
  }, () => now, { discoverModels: true, defaultModel: 'sol' });
  assert.equal((await catalog.read()).model, 'sol'); now += 60_001;
  assert.deepEqual((await catalog.read()).models.map(m => m.id), ['astra']); assert.equal(catalog.target().catalogState, 'unavailable');
  await catalog.read(); assert.equal(calls, 2); catalog.close();
});
test('reject malformed, oversized, non-JSON, empty and excessive catalogs', async () => {
  const cases = [Response.json({ data: [] }), Response.json({ data: [{ id: ' bad' }] }), Response.json({ data: [{ id: 'x\n' }] }),
    Response.json({ data: [{ id: 7 }] }), Response.json({ data: Array.from({ length: 513 }, () => ({ id: 'x' })) }),
    Response.json({ data: [{ id: 'x'.repeat(129) }] }), new Response('{}', { headers: { 'content-type': 'text/html' } }),
    Response.json({ data: [{ id: 'sol' }], extra: 'x'.repeat(128 * 1024) })];
  for (const response of cases) {
    const catalog = new StandaloneModelCatalog(config, async () => response, Date.now, { discoverModels: true });
    assert.deepEqual((await catalog.read()).models.map(m => m.id), ['astra']); catalog.close();
  }
});
test('bounded timeout and close interrupt even a non-cooperating transport; late catalog cannot resurrect', async () => {
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const timeout = new StandaloneModelCatalog(config, async () => new Promise(() => {}), Date.now, { discoverModels: true, catalogTimeoutMs: 10 });
    assert.equal((await timeout.read()).catalogState, 'unavailable'); timeout.close();
    let resolve!: (value: Response) => void;
    const stopped = new StandaloneModelCatalog(config, async () => new Promise(done => { resolve = done; }), Date.now, { discoverModels: true });
    const pending = stopped.read(); stopped.close(); assert.equal((await pending).model, 'astra');
    resolve(Response.json({ data: [{ id: 'sol' }] })); await new Promise(done => setImmediate(done));
    assert.deepEqual(stopped.target().models.map(m => m.id), ['astra']);
  } finally { clearInterval(keepAlive); }
});
