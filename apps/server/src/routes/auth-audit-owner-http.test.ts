import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { HubStore } from '../hub/hub-store.js';
import { AsyncHubMemberOwner } from '../hub/async-member-owner.js';
import { AsyncHubAuditLog } from '../hub/async-audit-log.js';
import { hubMemberEvidence } from '../hub/member-owner-domain.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { LoginAttemptLimiter } from '../auth/security.js';
import { registerAuthRoutes } from './auth.js';

const quiet = new PerformanceDiagnostics(() => {});
type Dependencies = Extract<Parameters<typeof registerAuthRoutes>[1], { isAuthorizedRequest: (request: Request) => boolean }>;
function appFor(extra: Pick<Dependencies, 'auditLog' | 'isAuthorizedRequest' | 'auditIdentity'> & Partial<Dependencies>) {
  const app = new Hono();
  const unexpected = async (): Promise<never> => { throw Error('unexpected_passkey_operation'); };
  registerAuthRoutes(app, {
    accessKey: undefined, sessions: new Set<string>(),
    passkeys: { status: () => ({ available: false, count: 0 }), list: () => [], revoke: () => false,
      registrationOptions: unexpected, verifyRegistration: unexpected,
      authenticationOptions: unexpected, verifyAuthentication: unexpected },
    loginLimiter: new LoginAttemptLimiter({ maxFailures: 10, windowMs: 60000, lockoutMs: 1000 }),
    lockoutSeconds: 1, diagnostics: quiet, ...extra,
  });
  return app;
}

test('original and full-owner async HTTP audit preserve cookie authentication, pagination and frontend JSON', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-audit-http-')), file = join(root, 'hub.sqlite');
  const store = new HubStore(file, 'fixture-audit-http');
  let owner: AsyncHubMemberOwner | undefined;
  try {
    const admin = store.createUser('Existing administrator');
    store.roles.setHubRole({ userId: 'default', admin: true }, admin.id, 'admin', 0);
    const key = store.identities.issueKey(admin.id), token = store.identities.createSession(key.token)!;
    for (let i = 0; i < 120; i++) store.identities.audit.append({ event: 'api_authz', outcome: 'failure', reason: 'http-' + i });
    const principal = (request: Request) => store.identities.requestPrincipal(request, () => false);
    const original = appFor({ auditLog: store.identities.audit, isAuthorizedRequest: request => !!principal(request),
      auditIdentity: request => { const p = principal(request); return p ? { userId: p.userId,
        authMethod: p.admin ? 'administrator' : 'member' } : undefined; } });
    const query = (app: Hono, suffix: string, cookie = token) => app.request('/api/auth/audit' + suffix,
      { headers: { cookie: 'agentopsdeck_session=' + cookie } });
    const suffixes = ['', '?limit=10000', '?page=true&limit=100', '?page=true&before=80&limit=10',
      '?page=true&userId=' + admin.id, '?page=true&before=0'];
    const expected = [];
    for (const suffix of suffixes) {
      const response = await query(original, suffix);
      expected.push({ status: response.status, body: await response.json(), cache: response.headers.get('cache-control') });
    }
    await store.close();
    owner = new AsyncHubMemberOwner({ file, encryptionSecret: 'fixture-audit-http' }, quiet);
    await owner.open();
    const worker = owner;
    const current = (request: Request) => worker.command('memberSnapshot', hubMemberEvidence(request));
    const unexpected = async (): Promise<never> => { throw Error('unexpected_authority_mutation'); };
    const asyncApp = appFor({ auditLog: new AsyncHubAuditLog(worker, quiet), isAuthorizedRequest: () => false,
      authority: { keyIdentityHash: undefined, authorize: async request => !!await current(request),
        revoke: unexpected, verifyRegistration: unexpected, sessionCurrent: unexpected },
      auditIdentity: async request => { const s = await current(request); return s ? {
        userId: s.principal.userId, authMethod: s.principal.admin ? 'administrator' : 'member' } : undefined; } });
    for (let i = 0; i < suffixes.length; i++) {
      const response = await query(asyncApp, suffixes[i]!);
      assert.deepEqual({ status: response.status, body: await response.json(), cache: response.headers.get('cache-control') }, expected[i]);
      assert.equal(response.headers.get('set-cookie'), null, 'sync does not issue a new session');
    }
    const denied = await query(asyncApp, '', 'hub_session_' + 'a'.repeat(43));
    assert.equal(denied.status, 401); assert.deepEqual(await denied.json(), { error: 'unauthorized' });
    assert.equal(worker.snapshot().unavailable, false);
  } finally { await owner?.close(); await store.close(); rmSync(root, { recursive: true, force: true }); }
});
