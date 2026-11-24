import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { Hono } from 'hono';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { AsyncHubAuthRoutePort } from './async-auth-route-port.js';
import { AsyncHubAuthIdentity } from './async-auth-identity.js';
import { AsyncHubMemberSessions } from './async-member-session.js';
import { AsyncHubAuditLog } from './async-audit-log.js';
import { AsyncHubLoginLimiter } from './async-login-limiter.js';
import { HubStore } from './hub-store.js';
import { executeHubLegacyAuthCommand, validHubLegacyAuthCommand } from './legacy-auth-domain.js';
import { hubMemberEvidence, HubMemberOwnerUnavailable } from './member-owner-domain.js';
import { AsyncSqliteAuthRoutePort } from '../auth/async-sqlite-route-port.js';
import { executeSqliteAuthCommand } from '../auth/sqlite-owner-domain.js';
import { createAccessKeyGuard } from '../auth/access-key.js';
import { openSqliteAuth } from '../auth/sqlite-store.js';
import { AuthPersistenceError } from '../auth/private-store.js';
import { keyIdentityHash } from '../auth/security.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { registerAuthRoutes } from '../routes/auth.js';

const key = 'isolated-original-application-auth', digest = createHash('sha256').update(key).digest('hex');
const binding = keyIdentityHash(key)!, token = 'c'.repeat(43), origin = 'https://hub.example';
const quiet = new PerformanceDiagnostics(() => {});
const request = (headers: HeadersInit = {}) => new Request(origin, { headers });
const cookie = (value: string) => ({ cookie: `agentopsdeck_session=${value}` });
async function fixture(work: (f: {
  hub: HubStore; auth: ReturnType<typeof openSqliteAuth>; legacy: (request: Request) => boolean;
  member: { id: string }; memberKey: { token: string; id: string }; memberToken: string;
  file: string; authFile: string; root: string;
}) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'hub-original-auth-')), file = join(root, 'hub.sqlite'), authFile = join(root, 'auth.sqlite');
  const auth = openSqliteAuth(authFile, [], () => binding), legacy = createAccessKeyGuard(key, auth.sessions);
  const hub = new HubStore(file, 'isolated-auth-secret', [], key, legacy);
  const member = hub.createUser('Original application member'), memberKey = hub.identities.issueKey(member.id);
  const memberToken = hub.identities.createSession(memberKey.token)!;
  auth.sessions.add(token);
  try { await work({ hub, auth, legacy, member, memberKey, memberToken, file, authFile, root }); }
  finally { await hub.close(); await auth.close(); rmSync(root, { recursive: true, force: true }); }
}
const config = (f: { file: string; authFile: string }) => ({ file: f.file, encryptionSecret: 'isolated-auth-secret',
  administratorKey: key, auth: { file: f.authFile, legacyFiles: [] },
  loginLimiter: { maxFailures: 2, windowMs: 600_000, lockoutMs: 600_000 } });
function registration(challenge: string) {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), jwk = publicKey.export({ format: 'jwk' });
  const cose = Buffer.concat([Buffer.from('a5010203262001215820', 'hex'), Buffer.from(jwk.x!, 'base64url'),
    Buffer.from('225820', 'hex'), Buffer.from(jwk.y!, 'base64url')]);
  const id = Buffer.from('new-isolated-application-passkey'), data = Buffer.alloc(55);
  createHash('sha256').update('hub.example').digest().copy(data); data[32] = 69; data.writeUInt16BE(id.length, 53);
  const attestation = isoCBOR.encode(new Map<string, string | Map<string, string> | Uint8Array>([
    ['fmt', 'none'], ['attStmt', new Map()], ['authData', new Uint8Array(Buffer.concat([data, id, cose]))],
  ]));
  return { id: id.toString('base64url'), rawId: id.toString('base64url'), type: 'public-key' as const, clientExtensionResults: {},
    response: { clientDataJSON: Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin })).toString('base64url'),
      attestationObject: Buffer.from(attestation).toString('base64url') } };
}

test('application evidence is accepted only for fixed original-authority operations, never administrator issuance or grants', () => {
  for (const command of [{ kind: 'authorized', input: {} }, { kind: 'clearSessions', input: { evidence: {} } },
    { kind: 'revoke', input: { credentialHash: 'a'.repeat(24), evidence: {} } },
    { kind: 'registrationOptions', input: { origin, evidence: {} } }]) {
    assert.equal(validHubLegacyAuthCommand(command), true);
    assert.equal(validHubLegacyAuthCommand({ ...command, hubEvidence: { sessionToken: token } }), true);
    assert.equal(validHubLegacyAuthCommand({ ...command, hubEvidence: { authorized: true } }), false);
    assert.equal(validHubLegacyAuthCommand({ ...command, hubEvidence: {}, authorized: true }), false);
  }
  for (const command of [{ kind: 'status', input: {} }, { kind: 'sessionCurrent', input: { token } },
    { kind: 'deleteSession', input: { token } }, { kind: 'authenticationOptions', input: { origin } },
    { kind: 'issueAdministratorSession', input: { token, evidence: { suppliedKeyDigest: digest } } }]) {
    assert.equal(validHubLegacyAuthCommand(command), true);
    assert.equal(validHubLegacyAuthCommand({ ...command, hubEvidence: { accessKey: key } }), false);
  }
});

test('original member authority is checked inside original Auth transaction and revoked proof cannot reuse preflight', () => fixture(async f => {
  const command = { kind: 'authorized', input: {}, hubEvidence: { accessKey: f.memberKey.token } } as const;
  assert.equal((await executeHubLegacyAuthCommand(f.hub, f.auth.passkeys, digest, command, f.legacy)).value, true);
  const original = f.hub.identities.requestPrincipal.bind(f.hub.identities), transactions: boolean[] = [];
  f.hub.identities.requestPrincipal = (request, legacy) => { transactions.push(f.auth.passkeys.db.isTransaction); return original(request, legacy); };
  assert.equal((await executeHubLegacyAuthCommand(f.hub, f.auth.passkeys, digest,
    { kind: 'clearSessions', input: { evidence: {} }, hubEvidence: command.hubEvidence }, f.legacy)).value, true);
  assert.deepEqual(transactions, [true]); assert.equal(f.auth.sessions.has(token), false);
  f.auth.sessions.add(token); f.hub.identities.revokeKey(f.member.id, f.memberKey.id); transactions.length = 0;
  assert.equal((await executeHubLegacyAuthCommand(f.hub, f.auth.passkeys, digest,
    { kind: 'clearSessions', input: { evidence: {} }, hubEvidence: command.hubEvidence }, f.legacy)).value, false);
  assert.deepEqual(transactions, [true]); assert.equal(f.auth.sessions.has(token), true);
}));

test('valid real registration uses original member authority after crypto inside the Auth transaction', () => fixture(async f => {
  const hubEvidence = { sessionToken: f.memberToken };
  const options = await f.auth.passkeys.registrationOptions(request(), binding), original = f.hub.identities.requestPrincipal.bind(f.hub.identities);
  const transactions: boolean[] = [];
  f.hub.identities.requestPrincipal = (request, legacy) => { transactions.push(f.auth.passkeys.db.isTransaction); return original(request, legacy); };
  const result = await executeHubLegacyAuthCommand(f.hub, f.auth.passkeys, digest,
    { kind: 'verifyRegistration', input: { origin, response: registration(options.challenge), evidence: {} }, hubEvidence }, f.legacy);
  assert.equal((result.value as { verified: boolean }).verified, true);
  assert.deepEqual(transactions, [true]); assert.equal(f.auth.passkeys.list(binding).length, 1);
  const credentialHash = f.auth.passkeys.list(binding)[0]!.id; transactions.length = 0;
  assert.equal((await executeHubLegacyAuthCommand(f.hub, f.auth.passkeys, digest,
    { kind: 'revoke', input: { credentialHash, evidence: {} }, hubEvidence }, f.legacy)).value, true);
  assert.deepEqual(transactions, [true]); assert.equal(f.auth.passkeys.list(binding).length, 0);
}));

test('member revocation during asynchronous WebAuthn proof prevents final original credential write', () => fixture(async f => {
  const hubEvidence = { accessKey: f.memberKey.token }, options = await f.auth.passkeys.registrationOptions(request(), binding);
  assert.equal((await executeHubLegacyAuthCommand(f.hub, f.auth.passkeys, digest,
    { kind: 'authorized', input: {}, hubEvidence }, f.legacy)).value, true);
  const original = f.hub.identities.requestPrincipal.bind(f.hub.identities), transactions: boolean[] = [];
  f.hub.identities.requestPrincipal = (request, legacy) => { transactions.push(f.auth.passkeys.db.isTransaction); return original(request, legacy); };
  const result = executeHubLegacyAuthCommand(f.hub, f.auth.passkeys, digest,
    { kind: 'verifyRegistration', input: { origin, response: registration(options.challenge), evidence: {} }, hubEvidence }, f.legacy);
  f.hub.identities.revokeKey(f.member.id, f.memberKey.id);
  const reply = await result;
  assert.equal((reply.value as { verified: boolean }).verified, false);
  assert.deepEqual(transactions, [true]); assert.equal(f.auth.passkeys.list(binding).length, 0);
}));

test('worker-local authorization callback cannot become an async truthy grant or mint an administrator cookie', () => fixture(async f => {
  let calls = 0;
  const asynchronous = async () => { calls++; return true; };
  assert.equal(await executeSqliteAuthCommand(f.auth.passkeys, digest, 'authorized', {}, asynchronous as unknown as () => boolean), false);
  assert.equal(calls, 0);
  await assert.rejects(executeSqliteAuthCommand(f.auth.passkeys, digest, 'issueAdministratorSession',
    { token: 'z'.repeat(43), evidence: {} }, () => true), AuthPersistenceError);
  assert.equal(f.auth.sessions.has('z'.repeat(43)), false);
}));

test('colocated application port preserves original member key/cookie, explicit-key precedence, revocation and close fence', () => fixture(async f => {
  await f.hub.close(); await f.auth.close();
  const owner = new AsyncHubMemberOwner(config(f), quiet);
  try {
    await owner.open(); const port = new AsyncHubAuthRoutePort(owner, digest), standalone = new AsyncSqliteAuthRoutePort(owner.legacyAuth!, digest);
    assert.equal(await standalone.authority.authorize(request(cookie(f.memberToken))), false);
    assert.equal(await port.authority.authorize(request(cookie(f.memberToken))), true);
    assert.equal(await port.authority.authorize(request({ 'x-agentopsdeck-key': f.memberKey.token })), true);
    assert.equal(await port.authority.authorize(request({ ...cookie(f.memberToken), 'x-agentopsdeck-key': 'hub_key_' + 'z'.repeat(43) })), false);
    assert.equal(await port.authority.authorize(request(cookie(token))), true);
    await assert.rejects(owner.authCommand('accessKeySession', { token: f.memberToken }), HubMemberOwnerUnavailable);
    assert.equal(await port.sessions.delete(f.memberToken), false);
    assert.equal(await port.authority.authorize(request(cookie(f.memberToken))), true);
    await owner.command('memberSessionDelete', { token: f.memberToken });
    assert.equal(await port.authority.authorize(request(cookie(f.memberToken))), false);
    await assert.rejects(async () => port.passkeys.revoke(binding, 'a'.repeat(24), undefined, () => true), AuthPersistenceError);
    assert.equal(await port.sessions.delete(token), true);
    assert.equal(await port.authority.authorize(request(cookie(token))), false);
    const close = owner.close(); await assert.rejects(async () => port.authority.authorize(request(cookie(token))), AuthPersistenceError);
    await assert.rejects(async () => port.sessions.delete(f.memberToken), AuthPersistenceError); await close;
    assert.equal(owner.snapshot().ownerExitConfirmed, true);
  } finally { await owner.close(); }
}));

test('application HTTP member cookie/login/logout preserve response scope and persistent audit/limiter ownership', () => fixture(async f => {
  const scope = f.hub.identities.recoveryScope({ userId: f.member.id, admin: false });
  await f.hub.close(); await f.auth.close();
  const lines: string[] = [], diagnostics = new PerformanceDiagnostics(line => lines.push(line));
  const owner = new AsyncHubMemberOwner(config(f), diagnostics), app = new Hono();
  const audit = new AsyncHubAuditLog(owner, diagnostics), limiter = new AsyncHubLoginLimiter(owner, diagnostics);
  const sessions = new AsyncHubMemberSessions(owner, diagnostics), identity = new AsyncHubAuthIdentity(owner, diagnostics);
  let routes: ReturnType<typeof registerAuthRoutes> | undefined;
  try {
    await owner.open(); const port = new AsyncHubAuthRoutePort(owner, digest);
    routes = registerAuthRoutes(app, { accessKey: key, ...port, diagnostics, auditLog: audit, loginLimiter: limiter, lockoutSeconds: 1,
      isAuthorizedRequest: () => { throw Error('no synchronous HTTP preflight'); }, memberLogin: sessions.memberLogin,
      memberSessionCurrent: sessions.memberSessionCurrent, revokeMemberSession: sessions.revokeMemberSession,
      memberKeyIdentity: identity.keyIdentity,
      recoveryScope: async request => (await owner.command('memberSnapshot', hubMemberEvidence(request)))?.recoveryScope,
    });
    const status = await app.request(origin + '/api/auth/status', { headers: cookie(f.memberToken) });
    assert.equal(status.status, 200); const body = await status.json(); assert.equal(body.authenticated, true); assert.equal(body.recoveryScope, scope);
    assert.deepEqual(Object.keys(body).sort(), ['authenticated', 'passkeys', 'recoveryScope']);
    const login = await app.request(origin + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accessKey: f.memberKey.token }) });
    assert.equal(login.status, 200); const newToken = /agentopsdeck_session=([^;]+)/.exec(login.headers.get('set-cookie')!)![1]!;
    await assert.rejects(owner.authCommand('accessKeySession', { token: newToken }), HubMemberOwnerUnavailable);
    assert.equal(await port.authority.authorize(request(cookie(newToken))), true);
    const logout = await app.request(origin + '/api/auth/logout', { method: 'POST', headers: cookie(newToken) });
    assert.equal(logout.status, 200); assert.equal(await port.authority.authorize(request(cookie(newToken))), false);
    assert.equal(await port.authority.authorize(request(cookie(f.memberToken))), true);
    // The composed route always visits both stores. Neither token family
    // may turn the other store's known no-op into an unavailable response.
    for (const [index, value] of [token, token, 'hub_session_' + 'q'.repeat(43), 'q'.repeat(43),
      'invalid-cookie', 'hub_session_invalid', '%not-encoded', ''].entries()) {
      const result = await app.request(origin + '/api/auth/logout', { method: 'POST', headers: cookie(value) });
      assert.equal(result.status, 200, `logout compatibility case ${index}`);
      assert.match(result.headers.get('set-cookie')!, /Max-Age=0/);
      assert.equal(await port.authority.authorize(request(cookie(f.memberToken))), true);
    }
    assert.equal(await port.authority.authorize(request(cookie(token))), false);
    await routes.close(); await Promise.all([sessions.close(), identity.close(), audit.close(), limiter.close()]); await owner.close();
    const reopened = new HubStore(f.file, 'isolated-auth-secret', [], key);
    try {
      assert.equal(reopened.identities.requestIdentity(request(cookie(newToken))), undefined);
      assert.ok(reopened.identities.requestIdentity(request(cookie(f.memberToken))));
      assert.ok(reopened.identities.audit.list(100).some(event => event.event === 'access_key_login' && event.authMethod === 'member'));
    } finally { await reopened.close(); }
    const reopenedAuth = openSqliteAuth(f.authFile, [], () => binding);
    try { assert.equal(reopenedAuth.sessions.has(token), false); }
    finally { await reopenedAuth.close(); }
    for (const secret of [key, digest, f.memberKey.token, f.memberToken, newToken, f.root]) assert.equal(lines.join('').includes(secret), false);
  } finally {
    await routes?.close(); await Promise.all([sessions.close(), identity.close(), audit.close(), limiter.close()]); await owner.close();
  }
}));
