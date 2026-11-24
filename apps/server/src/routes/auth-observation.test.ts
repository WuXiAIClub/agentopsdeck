import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { AuthAuditLog, LoginAttemptLimiter, keyIdentityHash } from '../auth/security.js';
import type { AuthPasskeyStore } from '../auth/route-persistence.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { registerAuthRoutes } from './auth.js';

function held<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>(yes => setImmediate(yes));
async function until(check: () => boolean) {
  const deadline = AbortSignal.timeout(3000);
  while (!check()) { deadline.throwIfAborted(); await tick(); }
}
const unsupported = async (): Promise<never> => { throw Error('Unexpected verification'); };
function fixture(overrides: Partial<Parameters<typeof registerAuthRoutes>[1]> = {}) {
  const app = new Hono(), rows: string[] = [], auditLog = new AuthAuditLog(); let syncCalls = 0;
  const passkeys: AuthPasskeyStore = { status: () => ({ available: true, count: 1 }), list: () => [], revoke: () => false,
    registrationOptions: unsupported, verifyRegistration: unsupported, authenticationOptions: unsupported, verifyAuthentication: unsupported };
  const deps = { accessKey: 'fixture-key', passkeys, sessions: new Set<string>(),
    isAuthorizedRequest: () => { syncCalls++; return false; }, observeAuthorization: async () => true,
    diagnostics: new PerformanceDiagnostics(line => rows.push(line)), auditLog, readWaitMs: 30_000,
    loginLimiter: new LoginAttemptLimiter({ maxFailures: 10, windowMs: 60_000, lockoutMs: 1000 }), lockoutSeconds: 1, ...overrides };
  registerAuthRoutes(app, deps);
  return { app, deps, passkeys, auditLog, rows, get syncCalls() { return syncCalls; } };
}
for (const endpoint of ['status', 'passkeys', 'audit']) for (const outcome of ['success', 'deny', 'reject', 'cancel', 'deadline']) {
  test(`HTTP ${endpoint} awaits original observation ${outcome} without transaction fallback`, async () => {
    const gate = held<boolean>(), controller = new AbortController(); let reads = 0;
    const h = fixture({ observeAuthorization: () => { reads++; return gate.promise; }, readWaitMs: outcome === 'deadline' ? 10 : 30_000 });
    const flight = h.app.request('/api/auth/' + endpoint, { signal: controller.signal });
    await until(() => reads === 1);
    if (outcome === 'success' || outcome === 'deny') gate.resolve(outcome === 'success');
    if (outcome === 'reject') gate.reject(Error('PRIVATE-lookup-path-secret'));
    if (outcome === 'cancel') controller.abort();
    const response = await flight;
    const expected = outcome === 'success' ? 200 : outcome === 'deny' ? endpoint === 'status' ? 200 : 401 : outcome === 'cancel' ? 408 : 503;
    assert.equal(response.status, expected); assert.equal(response.headers.get('set-cookie'), null);
    const body = await response.json();
    if (endpoint === 'status' && ['deny', 'success'].includes(outcome)) assert.equal(body.authenticated, outcome === 'success');
    assert.equal(h.syncCalls, 0); assert.doesNotMatch(JSON.stringify(h.rows), /PRIVATE/);
    assert.equal(h.auditLog.list().length, 0);
    if (outcome === 'cancel' || outcome === 'deadline') { gate.reject(Error('PRIVATE-late-error')); await tick(); }
  });
}
test('observed HTTP grant cannot replace original passkey transaction veto', async () => {
  const h = fixture(); let mutations = 0;
  h.passkeys.revoke = (_key, _id, _now, authorized) => { mutations++; assert.equal(authorized!(), false); return false; };
  const response = await h.app.request('/api/auth/passkeys/id', { method: 'DELETE' });
  assert.equal(response.status, 401); assert.equal(mutations, 1); assert.equal(h.syncCalls, 1); assert.equal(h.auditLog.list().length, 0);
});
test('full original authority takes precedence over optional HTTP observation', async () => {
  let observations = 0;
  const h = fixture({ observeAuthorization: async () => { observations++; return true; },
    authority: { keyIdentityHash: keyIdentityHash('fixture-key'), authorize: async () => false } as never });
  assert.equal((await h.app.request('/api/auth/passkeys')).status, 401);
  assert.equal(observations, 0); assert.equal(h.syncCalls, 0);
});
test('rotation during asynchronous observation refuses completed passkey data', async () => {
  const gate = held<boolean>(); let reads = 0;
  const h = fixture({ observeAuthorization: () => { reads++; return gate.promise; } });
  const flight = h.app.request('/api/auth/passkeys'); await until(() => reads === 1);
  h.deps.accessKey = 'rotated-key'; gate.resolve(true);
  assert.equal((await flight).status, 401); assert.equal(h.syncCalls, 0);
});
