import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { Hono } from 'hono';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { HubStore } from './hub-store.js';
import { LEGACY_HUB_PRINCIPAL } from './identity.js';
import { AsyncSqliteAuthRoutePort } from '../auth/async-sqlite-route-port.js';
import { AuthPersistenceError } from '../auth/private-store.js';
import { openSqliteAuth } from '../auth/sqlite-store.js';
import { keyIdentityHash, fingerprintRequest, loginLimiterSubject } from '../auth/security.js';
import { AsyncHubAuditLog } from './async-audit-log.js';
import { AsyncHubLoginLimiter } from './async-login-limiter.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { registerAuthRoutes } from '../routes/auth.js';
import type { StoredPasskey } from '../auth/passkeys.js';

const accessKey = 'isolated-colocated-http-key', token = 'b'.repeat(43), origin = 'https://hub.example';
const digest = createHash('sha256').update(accessKey).digest('hex');
const policy = { maxFailures: 2, windowMs: 600_000, lockoutMs: 600_000 };
async function fixture(work: (f: { owner: AsyncHubMemberOwner; port: AsyncSqliteAuthRoutePort;
  request: (path: string, init?: RequestInit) => Response | Promise<Response>;
  logs: string[]; file: string; authFile: string; scope: string; audit: AsyncHubAuditLog; limiter: AsyncHubLoginLimiter }) => Promise<void>, credentials: StoredPasskey[] = []) {
  const root = mkdtempSync(join(tmpdir(), 'hub-auth-http-')), file = join(root, 'hub.sqlite'), authFile = join(root, 'auth.sqlite');
  const hub = new HubStore(file, 'isolated-secret', [], accessKey), auth = openSqliteAuth(authFile, [], () => keyIdentityHash(accessKey));
  const scope = hub.identities.recoveryScope(LEGACY_HUB_PRINCIPAL);
  if (credentials.length) auth.passkeys.importLegacy(credentials, true);
  auth.sessions.add(token); await hub.close(); await auth.close();
  const logs: string[] = [], diagnostics = new PerformanceDiagnostics(line => logs.push(line));
  const owner = new AsyncHubMemberOwner({ file, encryptionSecret: 'isolated-secret', administratorKey: accessKey,
    auth: { file: authFile, legacyFiles: [] }, loginLimiter: policy }, diagnostics);
  const audit = new AsyncHubAuditLog(owner, diagnostics), limiter = new AsyncHubLoginLimiter(owner, diagnostics);
  let routes: ReturnType<typeof registerAuthRoutes> | undefined;
  try {
    await owner.open(); assert.ok(owner.legacyAuth);
    const port = new AsyncSqliteAuthRoutePort(owner.legacyAuth, digest), app = new Hono();
    routes = registerAuthRoutes(app, { accessKey, ...port, diagnostics, auditLog: audit,
      isAuthorizedRequest: () => { throw Error('synchronous route authority forbidden'); },
      loginLimiter: limiter, lockoutSeconds: 1 });
    await work({ owner, port, request: (path, init) => app.request(origin + path, init), logs, file, authFile, scope, audit, limiter });
    for (const value of [accessKey, digest, token, root, authFile]) assert.equal(logs.join('').includes(value), false);
  } finally {
    await routes?.close(); await Promise.all([audit.close(), limiter.close()]);
    await owner.close(); rmSync(root, { recursive: true, force: true });
  }
}
const cookie = (value = token) => ({ cookie: `agentopsdeck_session=${value}` });
const document = (revision = 0) => ({ revision, groups: [], sessions: {}, ungroupedCollapsed: true });

test('original HTTP cookie/status/logout and Hub CAS save share one original worker without replay', () => fixture(async f => {
  const response = await f.request('/api/auth/status', { headers: cookie() });
  assert.equal(response.status, 200); assert.equal((await response.json()).authenticated, true);
  assert.ok(await f.owner.command('workspaceSave', { evidence: { sessionToken: token }, expectedScope: f.scope, document: document() }));
  const logout = await f.request('/api/auth/logout', { method: 'POST', headers: cookie() });
  assert.equal(logout.status, 200); assert.match(logout.headers.get('set-cookie')!, /Max-Age=0/);
  assert.equal(await f.owner.command('workspaceSave', { evidence: { sessionToken: token }, expectedScope: f.scope, document: document(1) }), null);
  const status = await f.request('/api/auth/status', { headers: cookie() });
  assert.equal(status.status, 200); assert.equal((await status.json()).authenticated, false);
  await f.owner.close();
  const hub = new HubStore(f.file, 'isolated-secret', [], accessKey), auth = openSqliteAuth(f.authFile, [], () => keyIdentityHash(accessKey));
  try { assert.deepEqual(hub.workspace.get('default'), document(1)); assert.equal(auth.sessions.has(token), false); }
  finally { await hub.close(); await auth.close(); }
}));

test('original HTTP key login issues one current cookie; incorrect explicit key never falls back for administrator routes', () => fixture(async f => {
  const refused = await f.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accessKey: 'wrong' }) });
  assert.equal(refused.status, 401); assert.equal(refused.headers.get('set-cookie'), null);
  const response = await f.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accessKey }) });
  assert.equal(response.status, 200); const setCookie = response.headers.get('set-cookie')!;
  const issued = /agentopsdeck_session=([^;]+)/.exec(setCookie)![1]!;
  assert.notEqual(issued, token); assert.equal(await f.owner.authCommand('accessKeySession', { token: issued }), true);
  assert.ok(await f.owner.command('memberSnapshot', { sessionToken: issued }));
  assert.equal(await f.port.administrator(new Request(origin, { headers: { ...cookie(), 'x-agentopsdeck-key': 'wrong' } })), false);
  assert.ok(await f.owner.command('memberSnapshot', { sessionToken: token, accessKey: 'wrong' }));
  const after = await f.request('/api/auth/status', { headers: cookie(issued) });
  assert.equal((await after.json()).authenticated, true);
}));

test('colocated HTTP adapter binds the full private digest and closes delivery without retiring a correct owner on mismatch', () => fixture(async f => {
  assert.ok(Object.isFrozen(f.owner.legacyAuth));
  for (const value of [digest.slice(0, 24), '0'.repeat(64), digest.toUpperCase()]) {
    assert.throws(() => new AsyncSqliteAuthRoutePort(f.owner.legacyAuth!, value), AuthPersistenceError);
  }
  assert.equal(f.owner.snapshot().unavailable, false);
  assert.equal(await f.port.administrator(new Request(origin, { headers: cookie() })), true);
  const close = f.owner.close();
  await assert.rejects(f.port.administrator(new Request(origin, { headers: cookie() })), AuthPersistenceError);
  const status = await f.request('/api/auth/status', { headers: cookie() });
  assert.equal(status.status, 503); assert.equal(status.headers.get('set-cookie'), null);
  await close; assert.equal(f.owner.snapshot().ownerExitConfirmed, true);
}));

test('real signed original Passkey HTTP login remains distinct from key-login authority; revoke invalidates Hub use immediately', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), jwk = publicKey.export({ format: 'jwk' });
  const cose = Buffer.concat([Buffer.from('a5010203262001215820', 'hex'), Buffer.from(jwk.x!, 'base64url'), Buffer.from('225820', 'hex'), Buffer.from(jwk.y!, 'base64url')]);
  const id = Buffer.from('isolated-colocated-http-passkey').toString('base64url');
  await fixture(async f => {
    const optionsResponse = await f.request('/api/auth/passkeys/login/options', { method: 'POST' });
    assert.equal(optionsResponse.status, 200); const options = await optionsResponse.json();
    const client = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin }));
    const data = Buffer.alloc(37); createHash('sha256').update('hub.example').digest().copy(data); data[32] = 5; data.writeUInt32BE(1, 33);
    const assertion = { id, rawId: id, type: 'public-key', clientExtensionResults: {}, response: {
      clientDataJSON: client.toString('base64url'), authenticatorData: data.toString('base64url'),
      signature: sign('sha256', Buffer.concat([data, createHash('sha256').update(client).digest()]), privateKey).toString('base64url') } };
    const response = await f.request('/api/auth/passkeys/login/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(assertion) });
    assert.equal(response.status, 200);
    const issued = /agentopsdeck_session=([^;]+)/.exec(response.headers.get('set-cookie')!)![1]!;
    assert.equal(await f.port.administrator(new Request(origin, { headers: cookie(issued) })), false);
    assert.ok(await f.owner.command('memberSnapshot', { sessionToken: issued }));
    const weixin = (sessionToken: string) => f.owner.command('weixin', {
      evidence: { sessionToken }, expectedScope: f.scope, command: { action: 'status' },
    });
    const passkeyStatus = await weixin(issued), keyStatus = await weixin(token);
    assert.ok(passkeyStatus && !('error' in passkeyStatus) && passkeyStatus.action === 'status');
    assert.equal(passkeyStatus.status.personalKey, false);
    assert.equal(passkeyStatus.status.administratorKey, false);
    assert.ok(keyStatus && !('error' in keyStatus) && keyStatus.action === 'status');
    assert.equal(keyStatus.status.administratorKey, true);
    const credentials = await f.owner.authCommand('list', {});
    assert.equal(await f.port.authority.revoke(new Request(origin, { headers: cookie() }), keyIdentityHash(accessKey), credentials[0]!.id), true);
    assert.equal(await f.owner.command('memberSnapshot', { sessionToken: issued }), null);
    const status = await f.request('/api/auth/status', { headers: cookie(issued) });
    assert.equal((await status.json()).authenticated, false);
    assert.ok(await f.owner.command('memberSnapshot', { sessionToken: token }));
  }, [{ id, publicKey: cose.toString('base64url'), counter: 0, rpId: 'hub.example', keyIdentityHash: keyIdentityHash(accessKey), label: 'isolated offline credential', createdAt: 1 }]);
});

test('HTTP login ban and audit remain in the original Hub database after combined owner close and reopen', () => fixture(async f => {
  const login = () => f.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accessKey: 'wrong' }) });
  assert.equal((await login()).status, 401);
  const second = await login(); assert.equal(second.status, 429);
  assert.equal(second.headers.get('set-cookie'), null);
  const blocked = await f.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accessKey }) });
  assert.equal(blocked.status, 429); assert.equal(blocked.headers.get('set-cookie'), null);
  const subject = loginLimiterSubject(fingerprintRequest(new Request(origin + '/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
  })));
  const decision = await f.limiter.check(subject); assert.equal(decision.allowed, false);
  assert.equal(decision.failureCount, 2);
  const audit = await f.audit.list(100, new Request(origin, { headers: cookie() }));
  assert.equal(audit.filter(row => row.event === 'access_key_login').length, 3);
  assert.equal(audit.filter(row => row.outcome === 'throttled').length, 2);
  await Promise.all([f.audit.close(), f.limiter.close()]); await f.owner.close();
  const hub = new HubStore(f.file, 'isolated-secret', [], accessKey);
  try {
    const current = hub.createLoginLimiter(policy).check(subject);
    assert.equal(current.allowed, false); assert.equal(current.failureCount, decision.failureCount);
    assert.deepEqual(hub.identities.audit.list(100), audit);
  } finally { await hub.close(); }
}));
