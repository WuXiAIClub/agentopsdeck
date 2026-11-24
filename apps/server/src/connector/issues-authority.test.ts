import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { registerConnectorIssueRoutes, type ConnectorIssueAuthority } from './issues-http.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const source = { id: 'fixture', label: 'Fixture', provider: 'gitlab' as const, origin: 'https://fixture.invalid', project: '12', token: 'synthetic-secret', epoch: 'one' };
const actor = { tokenId: 'synthetic-owner', scopes: ['issues:read'] } as Awaited<ReturnType<ConnectorIssueAuthority['authenticate']>>;
const list = () => Response.json([{ id: 1, iid: 1, project_id: 12, title: 'PRIVATE PAYLOAD', state: 'opened', labels: [], assignees: [], web_url: 'https://fixture.invalid/a/issues/1', description: null, updated_at: '2026-10-15T00:00:00Z' }], { headers: { 'x-next-page': '2' } });

for (const phase of ['authenticate', 'requireScope', 'final'] as const) {
  for (const ending of ['timeout', 'abort', 'close'] as const) {
    test(`issue HTTP retains ${phase} original after ${ending} and prevents late delivery`, async () => {
      const gate = deferred<any>(), entered = deferred<void>();
      let scopeCalls = 0, providerCalls = 0;
      const tokens: ConnectorIssueAuthority = {
        authenticate: async () => { if (phase === 'authenticate') { entered.resolve(); return gate.promise; } return actor; },
        requireScope: async () => { if (phase === 'requireScope') { entered.resolve(); return gate.promise; } return actor; },
        hasScope: async () => { scopeCalls++; if (phase === 'final' && scopeCalls === 3) { entered.resolve(); return gate.promise; } return true; },
      };
      const app = new Hono();
      const routes = registerConnectorIssueRoutes(app, tokens, [source], (async () => { providerCalls++; return list(); }) as typeof fetch,
        { requestWaitMs: ending === 'timeout' ? 50 : 10_000 });
      const controller = new AbortController();
      const responseWork = app.request(new Request('http://localhost/api/connector/v1/issues/fixture/items', { signal: controller.signal }));
      await entered.promise;
      if (ending === 'abort') controller.abort();
      let closed = false;
      const closing = ending === 'close' ? routes.close().then(() => { closed = true; }) : undefined;
      if (ending !== 'close') {
        const response = await responseWork;
        assert.equal(response.status, ending === 'abort' ? 408 : 503);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.ok(!(await response.text()).includes('PRIVATE PAYLOAD'));
      }
      const drain = closing ?? routes.close().then(() => { closed = true; });
      await tick(); assert.equal(closed, false);
      gate.resolve(phase === 'final' ? true : actor);
      await drain;
      assert.equal((await responseWork).status, ending === 'abort' ? 408 : 503);
      assert.equal(providerCalls, phase === 'final' ? 1 : 0);
      assert.equal((await app.request('/api/connector/v1/issues/sources')).status, 503);
    });
  }
}

test('issue HTTP awaits denied authority at each stage without leaking payload', async () => {
  for (const denied of ['authenticate', 'requireScope', 'final'] as const) {
    let calls = 0, scopes = 0;
    const tokens: ConnectorIssueAuthority = {
      authenticate: async () => denied === 'authenticate' ? undefined : actor,
      requireScope: async () => denied === 'requireScope' ? undefined : actor,
      hasScope: async () => ++scopes === 3 && denied === 'final' ? false : true,
    };
    const app = new Hono();
    const routes = registerConnectorIssueRoutes(app, tokens, [source], (async () => { calls++; return list(); }) as typeof fetch);
    const response = await app.request('/api/connector/v1/issues/fixture/items');
    assert.equal(response.status, denied === 'authenticate' ? 401 : 403);
    assert.ok(!(await response.text()).includes('PRIVATE PAYLOAD'));
    assert.equal(calls, denied === 'final' ? 1 : 0);
    await routes.close();
  }
});

test('issue HTTP retains provider owner after timeout and does not publish late cooldown', async () => {
  const gate = deferred<Response>(), entered = deferred<void>(); let calls = 0;
  const tokens: ConnectorIssueAuthority = { authenticate: async () => actor, requireScope: async () => actor, hasScope: async () => true };
  const app = new Hono();
  const routes = registerConnectorIssueRoutes(app, tokens, [source], (async () => {
    if (++calls === 1) { entered.resolve(); return gate.promise; }
    return list();
  }) as typeof fetch, { requestWaitMs: 10_000, providerWaitMs: 30 });
  const first = app.request('/api/connector/v1/issues/fixture/items'); await entered.promise;
  assert.equal((await first).status, 409);
  assert.equal((await app.request('/api/connector/v1/issues/fixture/items')).status, 429);
  assert.equal(calls, 1);
  gate.resolve(new Response('', { status: 429, headers: { 'retry-after': '60' } }));
  await tick(); await tick();
  assert.equal((await app.request('/api/connector/v1/issues/fixture/items')).status, 200);
  assert.equal(calls, 2); await routes.close();
});

test('issue HTTP observes late authority rejection and drains it', async () => {
  const gate = deferred<any>();
  const tokens: ConnectorIssueAuthority = { authenticate: () => gate.promise, requireScope: async () => actor, hasScope: async () => true };
  const app = new Hono(); const routes = registerConnectorIssueRoutes(app, tokens, [], fetch, { requestWaitMs: 20 });
  assert.equal((await app.request('/api/connector/v1/issues/sources')).status, 503);
  const close = routes.close(); gate.reject(new Error('PRIVATE AUTHORITY ERROR')); await close;
});

test('outer authority deadline signals nested provider without releasing its owner', async () => {
  const gate = deferred<Response>(), entered = deferred<AbortSignal>(); let calls = 0;
  const tokens: ConnectorIssueAuthority = { authenticate: async () => actor, requireScope: async () => actor, hasScope: async () => true };
  const app = new Hono();
  const routes = registerConnectorIssueRoutes(app, tokens, [source], (async (_url, init) => {
    calls++; entered.resolve(init!.signal!); return gate.promise;
  }) as typeof fetch, { requestWaitMs: 40, providerWaitMs: 10_000 });
  const response = app.request('/api/connector/v1/issues/fixture/items');
  const signal = await entered.promise;
  assert.equal((await response).status, 503); assert.equal(signal.aborted, true);
  assert.equal((await app.request('/api/connector/v1/issues/fixture/items')).status, 429);
  assert.equal(calls, 1);
  let drained = false; const close = routes.close().then(() => { drained = true; });
  await tick(); assert.equal(drained, false); gate.resolve(list()); await close;
});

test('issue HTTP preserves authority for unknown paths and unsupported methods', async () => {
  for (const granted of [false, true]) {
    let calls = 0;
    const tokens: ConnectorIssueAuthority = { authenticate: async () => { calls++; return granted ? actor : undefined; }, requireScope: async () => actor, hasScope: async () => true };
    const app = new Hono(); const routes = registerConnectorIssueRoutes(app, tokens);
    for (const [path, method] of [['missing', 'GET'], ['sources', 'POST'], ['fixture/items', 'DELETE']] as const) {
      const response = await app.request('/api/connector/v1/issues/' + path, { method });
      assert.equal(response.status, granted ? 404 : 401);
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    assert.equal(calls, 3); await routes.close();
  }
});
