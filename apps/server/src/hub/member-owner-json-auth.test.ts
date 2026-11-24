import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync, existsSync, linkSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { Hono } from 'hono';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { AsyncHubAuthRoutePort } from './async-auth-route-port.js';
import { AsyncHubAuthIdentity } from './async-auth-identity.js';
import { AsyncHubMemberSessions } from './async-member-session.js';
import { AsyncHubAuditLog } from './async-audit-log.js';
import { AsyncHubLoginLimiter } from './async-login-limiter.js';
import { HubStore } from './hub-store.js';
import { LEGACY_HUB_PRINCIPAL } from './identity.js';
import { hubMemberOwnerConfig } from './member-owner-domain.js';
import { validHubLegacyAuthCommand, executeHubLegacyAuthCommand } from './legacy-auth-domain.js';
import { AsyncSqliteAuthRoutePort } from '../auth/async-sqlite-route-port.js';
import { PasskeyManager, PersistentDeckSessionSet, type StoredPasskey } from '../auth/passkeys.js';
import { OriginalJsonAuthCommandStore } from '../auth/original-json-command-store.js';
import { validOriginalJsonAuthCommand } from '../auth/original-json-command-domain.js';
import { AuthPersistenceError, writePrivateAuthStore } from '../auth/private-store.js';
import { createAccessKeyGuard } from '../auth/access-key.js';
import { keyIdentityHash } from '../auth/security.js';
import { openSqliteAuth } from '../auth/sqlite-store.js';
import { registerAuthRoutes } from '../routes/auth.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const key = 'isolated-json-original-key', digest = createHash('sha256').update(key).digest('hex');
const token = 'j'.repeat(43), legacyToken = 'original-noncanonical-session-token';
const origin = 'https://hub.example', secret = 'isolated-json-secret';
const quiet = new PerformanceDiagnostics(() => {});
const policy = { maxFailures: 2, windowMs: 600_000, lockoutMs: 600_000 };
const cookie = (value: string) => ({ cookie: `agentopsdeck_session=${encodeURIComponent(value)}` });
const request = (value: string, extra: HeadersInit = {}) => new Request(origin, { headers: { ...cookie(value), ...extra } });
const document = (revision = 0) => ({ revision, groups: [], sessions: {}, ungroupedCollapsed: true });
async function fixture(work: (f: { root: string; file: string; passkeysFile: string; sessionsFile: string;
  scope: string; memberToken: string; config: ConstructorParameters<typeof AsyncHubMemberOwner>[0] }) => Promise<void>, credentials: StoredPasskey[] = []) {
  const root = mkdtempSync(join(tmpdir(), 'hub-original-json-')), file = join(root, 'hub.sqlite');
  const passkeysFile = join(root, 'passkeys.json'), sessionsFile = join(root, 'sessions.json');
  writePrivateAuthStore(passkeysFile, { credentials });
  const store = new OriginalJsonAuthCommandStore(passkeysFile, sessionsFile, keyIdentityHash(key));
  store.sessions.add(token); store.sessions.add(legacyToken); store.close();
  const sessions = new OriginalJsonAuthCommandStore(passkeysFile, sessionsFile, keyIdentityHash(key)).sessions;
  const hub = new HubStore(file, secret, [], key, createAccessKeyGuard(key, sessions));
  const member = hub.createUser('original JSON member'), memberKey = hub.identities.issueKey(member.id);
  const memberToken = hub.identities.createSession(memberKey.token)!;
  const scope = hub.identities.recoveryScope(LEGACY_HUB_PRINCIPAL); await hub.close();
  try { await work({ root, file, passkeysFile, sessionsFile, scope, memberToken, config: {
    file, encryptionSecret: secret, administratorKey: key, loginLimiter: policy,
    auth: { kind: 'json', passkeysFile, sessionsFile },
  } }); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('original JSON cookies, including noncanonical legacy tokens, preserve Hub saves, logout and reopen without conversion', () => fixture(async f => {
  const originalPasskeys = readFileSync(f.passkeysFile), originalSessions = readFileSync(f.sessionsFile);
  const owner = new AsyncHubMemberOwner(f.config, quiet);
  try {
    await owner.open(); const port = new AsyncSqliteAuthRoutePort(owner.legacyAuth!, digest);
    assert.ok(Object.isFrozen(owner.legacyAuth!.originalJson));
    for (const value of [token, legacyToken]) {
      assert.equal(await port.sessions.has!(value), true);
      assert.equal(await port.authority.authorize(request(value)), true);
      assert.equal(await port.administrator(request(value)), true);
      assert.equal(await port.administrator(request(value, { 'x-agentopsdeck-key': 'wrong' })), false);
      assert.deepEqual(await owner.command('memberSnapshot', { sessionToken: value }), { principal: LEGACY_HUB_PRINCIPAL, recoveryScope: f.scope });
    }
    assert.deepEqual(readFileSync(f.passkeysFile), originalPasskeys);
    assert.deepEqual(readFileSync(f.sessionsFile), originalSessions);
    assert.ok(await owner.command('workspaceSave', { evidence: { sessionToken: legacyToken }, expectedScope: f.scope, document: document() }));
    const conflict = await owner.command('workspaceSave', { evidence: { sessionToken: token }, expectedScope: f.scope, document: document() });
    assert.deepEqual(conflict, { conflict: true });
    assert.equal(await port.sessions.delete(legacyToken), true);
    assert.equal(await port.sessions.delete(legacyToken), false);
    assert.equal(await port.authority.authorize(request(legacyToken)), false);
    assert.equal(await owner.command('workspaceSave', { evidence: { sessionToken: legacyToken }, expectedScope: f.scope, document: document(1) }), null);
    assert.ok(await owner.command('memberSnapshot', { sessionToken: f.memberToken }));
    assert.deepEqual(JSON.parse(readFileSync(f.sessionsFile, 'utf8')).sessions.map((s: { token: string }) => s.token), [token]);
    await owner.close();
    assert.throws(() => port.sessions.delete(''), AuthPersistenceError);
    const reopened = new AsyncHubMemberOwner(f.config, quiet);
    try {
      await reopened.open(); const current = new AsyncSqliteAuthRoutePort(reopened.legacyAuth!, digest);
      assert.equal(await current.sessions.has!(legacyToken), false); assert.equal(await current.sessions.has!(token), true);
      assert.ok(await reopened.command('memberSnapshot', { sessionToken: f.memberToken }));
    } finally { await reopened.close(); }
    const original = new HubStore(f.file, secret, [], key);
    try { assert.deepEqual(original.workspace.get('default'), document(1)); } finally { await original.close(); }
    assert.deepEqual(readFileSync(f.passkeysFile), originalPasskeys);
    assert.equal(existsSync(join(f.root, 'auth.sqlite')), false);
  } finally { await owner.close(); }
}));

test('original JSON composed HTTP status/login/logout and member sessions keep original authority, cookies and safe diagnostics', () => fixture(async f => {
  const lines: string[] = [], diagnostics = new PerformanceDiagnostics(line => lines.push(line));
  const owner = new AsyncHubMemberOwner(f.config, diagnostics), app = new Hono();
  const audit = new AsyncHubAuditLog(owner, diagnostics), limiter = new AsyncHubLoginLimiter(owner, diagnostics);
  const sessions = new AsyncHubMemberSessions(owner, diagnostics), identity = new AsyncHubAuthIdentity(owner, diagnostics);
  let routes: ReturnType<typeof registerAuthRoutes> | undefined;
  try {
    await owner.open(); const port = new AsyncHubAuthRoutePort(owner, digest);
    routes = registerAuthRoutes(app, { accessKey: key, ...port, diagnostics, auditLog: audit, loginLimiter: limiter, lockoutSeconds: 1,
      memberLogin: sessions.memberLogin, memberSessionCurrent: sessions.memberSessionCurrent,
      revokeMemberSession: sessions.revokeMemberSession, memberKeyIdentity: identity.keyIdentity,
      isAuthorizedRequest: () => { throw Error('synchronous authority forbidden'); } });
    for (const value of [legacyToken, token, f.memberToken]) {
      const status = await app.request(origin + '/api/auth/status', { headers: cookie(value) });
      assert.equal(status.status, 200); assert.equal((await status.json()).authenticated, true);
    }
    const login = await app.request(origin + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accessKey: key }) });
    assert.equal(login.status, 200);
    const issued = /agentopsdeck_session=([^;]+)/.exec(login.headers.get('set-cookie')!)![1]!;
    assert.match(issued, /^[A-Za-z0-9_-]{43}$/); assert.equal(await port.sessions.has!(issued), true);
    for (const value of [legacyToken, legacyToken, token, '', 'unknown', f.memberToken]) {
      const logout = await app.request(origin + '/api/auth/logout', { method: 'POST', headers: cookie(value) });
      assert.equal(logout.status, 200); assert.match(logout.headers.get('set-cookie')!, /Max-Age=0/);
    }
    assert.equal(await port.sessions.has!(issued), true);
    assert.equal(await owner.command('memberSnapshot', { sessionToken: f.memberToken }), null);
    await assert.rejects(audit.list(100));
    const records = await audit.list(100, request(issued)); assert.ok(records.length > 0);
    for (const value of [key, digest, token, legacyToken, f.memberToken, issued, f.root]) assert.equal(lines.join('').includes(value), false);
  } finally {
    await routes?.close(); await Promise.all([sessions.close(), identity.close(), audit.close(), limiter.close()]); await owner.close();
  }
}));

test('JSON stale external revisions fail closed even for a missing session and never overwrite newer files', () => fixture(async f => {
  const owner = new AsyncHubMemberOwner(f.config, quiet);
  try {
    await owner.open(); const port = new AsyncSqliteAuthRoutePort(owner.legacyAuth!, digest);
    writePrivateAuthStore(f.sessionsFile, { sessions: [] }); const changed = readFileSync(f.sessionsFile);
    await assert.rejects(async () => port.sessions.has!('missing'));
    await assert.rejects(async () => port.sessions.delete('missing'));
    await assert.rejects(async () => port.authority.authorize(request(token)));
    assert.equal(await owner.command('memberSnapshot', { sessionToken: token }), null);
    assert.deepEqual(readFileSync(f.sessionsFile), changed);
  } finally { await owner.close(); }
}));

test('JSON crash writer locks are not stolen; failed logout never becomes success or destroys the original cookie', () => fixture(async f => {
  const owner = new AsyncHubMemberOwner(f.config, quiet), before = readFileSync(f.sessionsFile);
  try {
    await owner.open(); const port = new AsyncSqliteAuthRoutePort(owner.legacyAuth!, digest);
    mkdirSync(f.sessionsFile + '.writer-lock');
    await assert.rejects(async () => port.sessions.delete(token));
    assert.equal(existsSync(f.sessionsFile + '.writer-lock'), true);
    assert.deepEqual(readFileSync(f.sessionsFile), before); assert.equal(await port.sessions.has!(token), true);
  } finally { await owner.close(); }
}));

test('JSON owner reserves both files and refuses lexical, symlink, hardlink and Hub aliases', () => fixture(async f => {
  const owner = new AsyncHubMemberOwner(f.config, quiet);
  try {
    await owner.open();
    for (const path of [f.sessionsFile, f.passkeysFile]) {
      assert.throws(() => new AsyncHubMemberOwner({ ...f.config, file: path }, quiet));
      const link = path + '.hard'; linkSync(path, link);
      assert.throws(() => new AsyncHubMemberOwner({ ...f.config, file: link }, quiet));
      if (process.platform !== 'win32') {
        const symbolic = path + '.symbolic'; symlinkSync(path, symbolic);
        assert.throws(() => new AsyncHubMemberOwner({ ...f.config, file: symbolic }, quiet));
      }
    }
  } finally { await owner.close(); }
  assert.throws(() => new AsyncHubMemberOwner({ ...f.config, auth: { kind: 'json', passkeysFile: f.sessionsFile, sessionsFile: f.sessionsFile } }, quiet));
}));

test('JSON-only protocol is bounded, rejects supplied authority and cannot widen the SQLite mutation schema', () => fixture(async f => {
  for (const command of [
    { kind: 'originalJsonSession', input: { action: 'delete', token: legacyToken } },
    { kind: 'originalJsonAuthorized', input: {} },
  ]) {
    assert.equal(validHubLegacyAuthCommand(command), true);
    assert.equal(validOriginalJsonAuthCommand({ ...command, hubEvidence: { accessKey: key } }), false);
    assert.equal(validHubLegacyAuthCommand({ ...command, hubEvidence: { accessKey: key } }), false);
  }
  assert.equal(validOriginalJsonAuthCommand({ kind: 'originalJsonSession', input: { action: 'add', token } }), false);
  assert.equal(validOriginalJsonAuthCommand({ kind: 'originalJsonSession', input: { action: 'current', token: 'a'.repeat(4097) } }), false);
  assert.equal(validOriginalJsonAuthCommand({ kind: 'originalJsonAuthorized', input: { authorized: true } }), false);
  assert.throws(() => hubMemberOwnerConfig({ ...f.config, auth: { kind: 'json', passkeysFile: f.passkeysFile, sessionsFile: f.sessionsFile, file: 'forbidden' } }));
  const sql = openSqliteAuth(join(f.root, 'sql-only.sqlite'), [], () => keyIdentityHash(key));
  const hub = new HubStore(f.file, secret, [], key);
  try {
    await assert.rejects(executeHubLegacyAuthCommand(hub, sql.passkeys, digest,
      { kind: 'originalJsonSession', input: { action: 'delete', token } }, createAccessKeyGuard(key, sql.sessions)));
  } finally { await sql.close(); await hub.close(); }
}));

test('real original JSON passkey authentication persists a bound session; revocation never downgrades it to a key session', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), jwk = publicKey.export({ format: 'jwk' });
  const cose = Buffer.concat([Buffer.from('a5010203262001215820', 'hex'), Buffer.from(jwk.x!, 'base64url'), Buffer.from('225820', 'hex'), Buffer.from(jwk.y!, 'base64url')]);
  const id = Buffer.from('original-json-passkey').toString('base64url');
  await fixture(async f => {
    const owner = new AsyncHubMemberOwner(f.config, quiet);
    try {
      await owner.open(); const port = new AsyncSqliteAuthRoutePort(owner.legacyAuth!, digest);
      const options = await port.passkeys.authenticationOptions(new Request(origin), keyIdentityHash(key));
      const client = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin }));
      const authenticator = Buffer.alloc(37); createHash('sha256').update('hub.example').digest().copy(authenticator);
      authenticator[32] = 5; authenticator.writeUInt32BE(1, 33);
      const signature = sign('sha256', Buffer.concat([authenticator, createHash('sha256').update(client).digest()]), privateKey);
      const result = await port.passkeys.verifyAuthentication(new Request(origin), { id, rawId: id, type: 'public-key', clientExtensionResults: {},
        response: { clientDataJSON: client.toString('base64url'), authenticatorData: authenticator.toString('base64url'), signature: signature.toString('base64url') } }, keyIdentityHash(key));
      assert.equal(result.verified, true); if (!result.verified) return;
      assert.ok('sessionToken' in result); if (!('sessionToken' in result)) return;
      assert.equal(await result.isCurrent(), true); assert.equal(await port.administrator(request(result.sessionToken!)), false);
      assert.equal(await owner.legacyAuth!.originalJson!.session({ action: 'authentication-current', token: result.sessionToken! }), true);
      assert.ok(await owner.command('memberSnapshot', { sessionToken: result.sessionToken! }));
      assert.equal(await port.authority.revoke(request(token), keyIdentityHash(key), result.credentialHash), true);
      assert.equal(await result.isCurrent(), false); assert.equal(await port.administrator(request(result.sessionToken!)), false);
      assert.equal(await owner.legacyAuth!.originalJson!.session({ action: 'authentication-current', token: result.sessionToken! }), false);
      assert.equal(await owner.command('memberSnapshot', { sessionToken: result.sessionToken! }), null);
      const entries = JSON.parse(readFileSync(f.sessionsFile, 'utf8')).sessions;
      assert.ok(entries.some((entry: { token?: string; credentialHash?: string }) => entry.token === result.sessionToken && entry.credentialHash === result.credentialHash));
    } finally { await owner.close(); }
  }, [{ id, publicKey: cose.toString('base64url'), counter: 0, rpId: 'hub.example', keyIdentityHash: keyIdentityHash(key), createdAt: 1, label: 'Original JSON passkey' }]);
});

test('closed original JSON store cannot be used for an empty or nonexistent token', () => fixture(async f => {
  const store = new OriginalJsonAuthCommandStore(f.passkeysFile, f.sessionsFile, keyIdentityHash(key));
  store.close(); assert.throws(() => store.sessionAuthorized(''), AuthPersistenceError);
  assert.throws(() => store.deleteSession('missing'), AuthPersistenceError);
  // No JSON reader is turned into a reload/reopen path after external changes.
  const current = new OriginalJsonAuthCommandStore(f.passkeysFile, f.sessionsFile, keyIdentityHash(key));
  writeFileSync(f.passkeysFile, '{"credentials":[]}\n');
  assert.throws(() => current.sessionAuthorized(token), AuthPersistenceError); current.close();
}));
