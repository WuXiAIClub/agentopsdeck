import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import type { PasskeyManager } from '../auth/passkeys.js';
import { AuthAuditLog, LoginAttemptLimiter } from '../auth/security.js';
import { registerAuthRoutes } from './auth.js';

for (const route of ['register/options', 'login/options', 'register/verify', 'login/verify']) {
  test(`auth ${route} suppresses unknown downstream responses, logs and audit diagnostics`, async context => {
    const app = new Hono(), audit = new AuthAuditLog();
    const secret = 'synthetic-private-diagnostic';
    const failure = () => { throw new Error(`/synthetic/private/${secret} Bearer ${secret}`); };
    const logs: unknown[][] = [];
    context.mock.method(console, 'error', (...args: unknown[]) => logs.push(args));
    const routes = registerAuthRoutes(app, { accessKey: 'synthetic-key', sessions: new Set(), auditLog: audit,
      isAuthorizedRequest: () => true, lockoutSeconds: 30,
      loginLimiter: new LoginAttemptLimiter({ maxFailures: 5, windowMs: 60_000, lockoutMs: 30_000 }),
      passkeys: { registrationOptions: failure, authenticationOptions: failure,
        verifyRegistration: failure, verifyAuthentication: failure } as unknown as PasskeyManager });
    context.after(() => routes.close());
    const response = await app.request(`/api/auth/passkeys/${route}`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'auth_operation_failed' });
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(JSON.stringify(audit.list()).includes(secret), false);
    assert.equal(JSON.stringify(logs).includes(secret), false);
  });
}
