import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import type { HubStore } from '../hub/hub-store.js';
import type { ConnectorClientResolver } from '../hub/connector-client.js';
import { registerHubMetrics } from './metrics-http.js';
import { MetricsSampler } from './metrics.js';
function held<T>() { let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const node = 'node_00000000-0000-4000-8000-000000000001';
const connection = { id: 'fixture', nodeId: node, label: 'PRIVATE NODE', status: 'enabled' };
const payload = { version: 1 as const, source: { kind: 'connector' as const, id: node }, sampledAt: 10_000,
  scope: 'process' as const, cpu: { percent: null, cores: 1 }, memory: { usedBytes: 10, totalBytes: null, availableBytes: null }, volumes: [] };
const sampler = () => new MetricsSampler({ kind: 'hub', id: node }, async () => ({ scope: 'process', identity: 'private', busy: 1, capacity: 1, clock: 1, cores: 1, memory: payload.memory, volumes: [] }));
for (const route of ['sources', 'connectors/fixture']) for (const phase of ['initial', 'provider', 'final']) {
  for (const ending of ['timeout', 'abort', 'close'] as const) test(`Hub metrics ${route} ${phase} ${ending} retains original and refuses late payload`, async () => {
    const gate = held<void>(), entered = held<void>(); let principalCalls = 0, providerCalls = 0;
    const actor = { userId: 'fixture-owner', admin: true };
    const principal = async () => {
      principalCalls++;
      if (phase === 'initial' && principalCalls === 1 || phase === 'final' && principalCalls === 2) { entered.resolve(); await gate.promise; }
      return actor;
    };
    const provider = async () => { providerCalls++; if (phase === 'provider') { entered.resolve(); await gate.promise; } };
    const store = { identities: { hubId: node }, connectionDirectoryVersion: () => 1,
      listConnectionsAsync: async () => { await provider(); return [connection]; },
      getConnection: () => connection, connectionAuthority: () => 1 } as unknown as HubStore;
    const client = (() => ({ json: async () => { await provider(); return payload; } })) as unknown as ConnectorClientResolver;
    const app = new Hono(), local = sampler();
    const routes = registerHubMetrics(app, store, principal, client, local, { requestWaitMs: ending === 'timeout' ? 30 : 10_000 });
    const controller = new AbortController();
    const work = app.request(new Request('http://local/api/hub/v1/system/metrics/' + route, { signal: controller.signal }));
    await entered.promise;
    if (ending === 'abort') controller.abort();
    let drained = false;
    const close = ending === 'close' ? routes.close().then(() => { drained = true; }) : undefined;
    const expected = ending === 'abort' ? route === 'sources' ? 499 : 408 : 503;
    if (ending !== 'close') assert.equal((await work).status, expected);
    const closing = close ?? routes.close().then(() => { drained = true; });
    await tick(); assert.equal(drained, false);
    gate.resolve(); await closing;
    const response = await work; assert.equal(response.status, expected);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.doesNotMatch(await response.text(), /PRIVATE NODE|usedBytes/);
    assert.equal(providerCalls, phase === 'initial' ? 0 : 1);
    await assert.rejects(local.sample(), /closed/);
    assert.equal((await app.request('/api/hub/v1/system/metrics/' + route)).status, 503);
  });
}

test('Hub metrics initial authority snapshots cannot be mutated into a different owner during a read', async () => {
  for (const route of ['hub', 'sources', 'connectors/fixture']) {
    const actor = { userId: 'original', admin: true };
    const mutate = () => { actor.userId = 'replacement'; };
    const store = { identities: { hubId: node }, connectionDirectoryVersion: () => 1,
      listConnectionsAsync: async () => { mutate(); return [connection]; },
      getConnection: () => connection, connectionAuthority: () => 1 } as unknown as HubStore;
    const local = new MetricsSampler({ kind: 'hub', id: node }, async () => { mutate(); return { scope: 'process', identity: 'fixture', busy: 1, capacity: 1, clock: 1, cores: 1, memory: payload.memory, volumes: [] }; });
    const app = new Hono();
    const routes = registerHubMetrics(app, store, async () => actor,
      (() => ({ json: async () => { mutate(); return payload; } })) as unknown as ConnectorClientResolver, local);
    assert.equal((await app.request('/api/hub/v1/system/metrics/' + route)).status, 403);
    await routes.close();
  }
});

test('Hub remote metrics refuses connection changes during awaited final authority', async () => {
  const gate = held<void>(), entered = held<void>(); let version = 1, principalCalls = 0;
  const store = { identities: { hubId: node }, connectionDirectoryVersion: () => version,
    getConnection: () => connection, connectionAuthority: () => 1 } as unknown as HubStore;
  const app = new Hono();
  const routes = registerHubMetrics(app, store, async () => {
    if (++principalCalls === 2) { entered.resolve(); await gate.promise; }
    return { userId: 'fixture-owner', admin: true };
  }, (() => ({ json: async () => payload })) as unknown as ConnectorClientResolver, sampler());
  const work = app.request('/api/hub/v1/system/metrics/connectors/fixture');
  await entered.promise; version++; gate.resolve();
  assert.equal((await work).status, 503); await routes.close();
});
