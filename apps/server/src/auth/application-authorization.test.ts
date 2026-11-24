import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { registerApplicationAuthorization } from './application-authorization.js';
import { AuthAuditLog } from './security.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { HubPrincipal } from '../hub/identity.js';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function until(check: () => boolean) {
  const timeout = AbortSignal.timeout(3000);
  while (!check()) { timeout.throwIfAborted(); await new Promise<void>(resolve => setImmediate(resolve)); }
}
function fixture(options: Partial<Parameters<typeof registerApplicationAuthorization>[1]> = {}) {
  const app = new Hono(), audit = new AuthAuditLog(), logs: string[] = [], errors: Error[] = [];
  let handled = 0;
  const boundary = registerApplicationAuthorization(app, {
    hasHub: false, principal: () => undefined, authorize: () => true,
    recordActivity: () => {}, audit, signedStream: () => false,
    allowedBrowserOrigin: origin => origin === 'https://hub.example',
    diagnostics: new PerformanceDiagnostics(line => logs.push(line)), ...options,
  });
  app.onError((error, c) => { errors.push(error); return c.json({ error: 'handler_error' }, 500); });
  app.get('/api/failure', () => { throw Error('original-handler-error'); });
  app.all('/api/*', c => { handled++; return c.json({ ok: true }); });
  return { app, audit, boundary, logs, errors, get handled() { return handled; } };
}

for (const outcome of ['resolve', 'reject'] as const) test(`authorization close drains timed-out ${outcome} original`, async () => {
  const gate = deferred<boolean>(); let calls = 0, closed = false;
  const h = fixture({ authorize: () => { calls++; return gate.promise; }, readWaitMs: 5 });
  assert.equal((await h.app.request('/api/sessions')).status, 503);
  const closing = h.boundary.close(); void closing.then(() => { closed = true; });
  assert.equal(h.boundary.close(), closing);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(closed, false); assert.equal(h.boundary.pending, 1);
  assert.equal((await h.app.request('/api/sessions')).status, 503);
  assert.equal(calls, 1); assert.equal(h.handled, 0);
  if (outcome === 'resolve') gate.resolve(true); else gate.reject(Error('PRIVATE'));
  await closing;
  assert.equal(h.boundary.pending, 0); assert.equal(h.handled, 0); assert.equal(h.errors.length, 0);
  assert.equal((await h.app.request('/api/sessions')).status, 503);
  assert.equal(calls, 1); assert.doesNotMatch(h.logs.join('\n'), /PRIVATE/);
});

for (const allowed of [true, false]) test(`standalone production gate awaits ${allowed} rather than accepting a Promise`, async () => {
  const gate = deferred<boolean>(), h = fixture({ authorize: () => gate.promise });
  const response = h.app.request('/api/sessions');
  await until(() => h.boundary.pending === 1);
  assert.equal(h.handled, 0);
  gate.resolve(allowed);
  assert.equal((await response).status, allowed ? 200 : 401);
  assert.equal(h.handled, allowed ? 1 : 0);
  assert.equal(h.audit.list().length, allowed ? 0 : 1);
  assert.equal(h.boundary.pending, 0);
});

for (const phase of ['principal', 'authorization'] as const) {
  for (const outcome of ['deadline', 'cancel', 'reject'] as const) {
    test(`${phase} ${outcome} is unavailable/cancelled, not bad key or signed-stream fallback`, async () => {
      const gate = deferred<never>(), controller = new AbortController();
      let fallbacks = 0, invoked = 0;
      const callback = () => { invoked++; return gate.promise; };
      const h = fixture({ ...(phase === 'principal' ? { principal: callback } : { authorize: callback }),
        readWaitMs: outcome === 'deadline' ? 10 : 30_000, signedStream: () => { fallbacks++; return true; } });
      const request = h.app.request('/api/sessions', { signal: controller.signal });
      await until(() => invoked === 1);
      if (outcome === 'cancel') controller.abort();
      if (outcome === 'reject') gate.reject(Error('private-sql-file-token-cause'));
      const response = await request;
      assert.equal(response.status, outcome === 'cancel' ? 408 : 503);
      assert.deepEqual(await response.json(), { error: outcome === 'cancel' ? 'request_cancelled' : 'auth_persistence_failed' });
      assert.equal(fallbacks, 0); assert.equal(h.handled, 0); assert.equal(h.audit.list().length, 0);
      assert.equal(h.errors.length, 0);
      assert.equal(h.boundary.pending, outcome === 'reject' ? 0 : 1);
      if (outcome !== 'reject') gate.reject(Error('private-late-rejection'));
      await until(() => h.boundary.pending === 0);
      assert.equal(invoked, 1);
      assert.ok(h.logs.every(line => !/private|sql-file-token/.test(line)));
    });
  }
}

test('pre-aborted request never enters either authority owner', async () => {
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  const h = fixture({ principal: () => { calls++; return undefined; }, authorize: () => { calls++; return true; } });
  assert.equal((await h.app.request('/api/sessions', { signal: controller.signal })).status, 408);
  assert.equal(calls, 0); assert.equal(h.boundary.pending, 0);
});

test('stalled original authority does not prevent independent health request', async () => {
  const gate = deferred<boolean>();
  const h = fixture({ authorize: () => gate.promise, readWaitMs: 10 });
  const protectedResponse = h.app.request('/api/sessions');
  await until(() => h.boundary.pending === 1);
  assert.equal((await h.app.request('/api/health')).status, 200);
  assert.equal((await protectedResponse).status, 503);
  assert.equal(h.boundary.pending, 1);
  gate.resolve(true); await until(() => h.boundary.pending === 0);
  assert.equal(h.handled, 1, 'late read cannot enter original protected handler');
});

for (const [method, path, status] of [
  ['GET', '/api/hub/v1/state', 200], ['PATCH', '/api/sessions/canonical', 200],
  ['DELETE', '/api/sessions/canonical', 200], ['PATCH', '/api/sessions/canonical/pin', 200],
  ['PATCH', '/api/sessions/canonical/archive', 200], ['PATCH', '/api/sessions/canonical/visibility', 200],
  ['GET', '/api/auth/status', 200], ['POST', '/api/auth/login', 200], ['POST', '/api/auth/logout', 200],
  ['GET', '/api/health', 200], ['GET', '/api/sessions', 403], ['POST', '/api/sessions', 403],
  ['GET', '/api/auth/passkeys', 403], ['GET', '/api/connector/v1/health', 403],
  ['PATCH', '/api/sessions/canonical/other', 403],
] as const) test(`member legacy restrictions preserved: ${method} ${path} -> ${status}`, async () => {
  let activity = 0, standalone = 0;
  const h = fixture({ hasHub: true, principal: async () => ({ userId: 'member', admin: false }),
    authorize: () => { standalone++; return true; }, recordActivity: async () => { activity++; } });
  assert.equal((await h.app.request(path, { method })).status, status);
  assert.equal(standalone, 0, 'standalone grant cannot override Hub identity');
  assert.equal(activity, status === 200 && path !== '/api/health' ? 1 : 0);
  assert.equal(h.audit.list().length, 0);
});

for (const change of ['revoke', 'account', 'role'] as const) test(`activity ACK cannot preserve old principal after ${change}`, async () => {
  const gate = deferred<void>(), original = { userId: 'member', admin: false };
  let current: HubPrincipal | undefined = original, activities = 0;
  const h = fixture({ hasHub: true, principal: async () => current,
    recordActivity: () => { activities++; return gate.promise; } });
  const response = h.app.request('/api/hub/v1/state');
  await until(() => activities === 1);
  if (change === 'revoke') current = undefined;
  if (change === 'account') original.userId = 'different-member';
  if (change === 'role') original.admin = true;
  gate.resolve();
  assert.equal((await response).status, 401); assert.equal(h.handled, 0);
  assert.equal(activities, 1); assert.equal(h.boundary.pending, 0);
  assert.equal(h.audit.list().length, 0);
});

for (const outcome of ['success', 'reject', 'cancel'] as const) {
  test(`original activity write ${outcome}: read deadline never ends or releases mutation`, async () => {
    const gate = deferred<void>(), controller = new AbortController(); let calls = 0;
    const h = fixture({ hasHub: true, principal: async () => ({ userId: 'administrator', admin: true }),
      readWaitMs: 5, recordActivity: () => { calls++; return gate.promise; } });
    let completed = false;
    const request = Promise.resolve(h.app.request('/api/sessions', { signal: controller.signal })).finally(() => { completed = true; });
    await until(() => calls === 1);
    if (outcome === 'cancel') controller.abort();
    await new Promise<void>(resolve => setTimeout(resolve, 20));
    assert.equal(completed, false); assert.equal(h.boundary.pending, 1); assert.equal(h.handled, 0);
    if (outcome === 'reject') gate.reject(Error('private-after-commit-unknown')); else gate.resolve();
    assert.equal((await request).status, outcome === 'success' ? 200 : outcome === 'cancel' ? 408 : 503);
    assert.equal(calls, 1); assert.equal(h.boundary.pending, 0); assert.equal(h.errors.length, 0);
  });
}

test('audit ACK is awaited without write timeout, replay or cookie publication', async () => {
  const gate = deferred<never>(), audit = new AuthAuditLog(); let calls = 0;
  const h = fixture({ authorize: async () => false, readWaitMs: 5, audit: {
    append: () => { calls++; return gate.promise; }, page: audit.page.bind(audit), list: audit.list.bind(audit),
  } });
  const request = h.app.request('/api/sessions');
  await until(() => calls === 1);
  await new Promise<void>(resolve => setTimeout(resolve, 20));
  assert.equal(h.boundary.pending, 1); assert.equal(h.handled, 0);
  gate.reject(Error('private-lost-audit-ack'));
  const response = await request;
  assert.equal(response.status, 503); assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(calls, 1); assert.equal(h.boundary.pending, 0); assert.equal(h.errors.length, 0);
});

test('malformed owner principal is storage unavailable without invoking accessors', async () => {
  let touched = 0;
  const actor = Object.defineProperty({ userId: 'member' }, 'admin', { enumerable: true, get() { touched++; return true; } });
  const h = fixture({ hasHub: true, principal: async () => actor as HubPrincipal });
  assert.equal((await h.app.request('/api/sessions')).status, 503);
  assert.equal(touched, 0); assert.equal(h.handled, 0); assert.equal(h.audit.list().length, 0);
});

test('Hub missing principal cannot use standalone true as a second administrator grant', async () => {
  let standalone = 0;
  const h = fixture({ hasHub: true, principal: async () => undefined, authorize: async () => { standalone++; return true; } });
  assert.equal((await h.app.request('/api/sessions')).status, 401);
  assert.equal(standalone, 0);
});

test('confirmed denial may use existing signed media capability but cannot accept a truthy substitute', async () => {
  const signed = fixture({ authorize: async () => false, signedStream: () => true });
  assert.equal((await signed.app.request('/api/media')).status, 200); assert.equal(signed.audit.list().length, 0);
  const malformed = fixture({ authorize: async () => false, signedStream: (() => ({})) as () => boolean });
  assert.equal((await malformed.app.request('/api/media')).status, 401);
});

test('origin rejection precedes any owner observation including machine endpoints', async () => {
  let calls = 0;
  const h = fixture({ hasHub: true, principal: () => { calls++; return undefined; } });
  const response = await h.app.request('/api/workspace-agent/v1/board', { method: 'POST', headers: { origin: 'https://untrusted.example' } });
  assert.equal(response.status, 403); assert.equal(calls, 0); assert.equal(h.handled, 0);
});

test('exact machine route bypass is not widened to adjacent paths or bearer capabilities elsewhere', async () => {
  let calls = 0;
  const h = fixture({ hasHub: true, principal: () => { calls++; return undefined; } });
  assert.equal((await h.app.request('/api/workspace-agent/v1/board')).status, 200);
  assert.equal(calls, 0);
  assert.equal((await h.app.request('/api/workspace-agent/v1/board/other')).status, 401);
  assert.equal(calls, 1);
  assert.equal((await h.app.request('/api/health', { headers: { authorization: 'Bearer aod_board_synthetic' } })).status, 401);
  assert.equal(calls, 1);
});

test('diagnostic failure cannot suppress original authority, activity or response', async () => {
  let writes = 0;
  const diagnostics = new PerformanceDiagnostics(() => { throw Error('private-observer-fault'); });
  diagnostics.start = () => { throw Error('private-observer-clock-fault'); };
  const h = fixture({ hasHub: true, principal: async () => ({ userId: 'administrator', admin: true }), diagnostics,
    recordActivity: async () => { writes++; } });
  assert.equal((await h.app.request('/api/sessions')).status, 200);
  assert.equal(writes, 1); assert.equal(h.handled, 1); assert.equal(h.boundary.pending, 0);
});

test('downstream route failure keeps its own status instead of becoming an auth storage error', async () => {
  const h = fixture(); const response = await h.app.request('/api/failure');
  assert.equal(response.status, 500); assert.deepEqual(await response.json(), { error: 'handler_error' });
  assert.equal(h.errors.length, 1); assert.equal(h.errors[0]!.message, 'original-handler-error');
});
