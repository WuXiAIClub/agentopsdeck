import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { AsyncSqliteAuthOwner } from './async-sqlite-owner.js';
import { AsyncSqliteAuthRoutePort } from './async-sqlite-route-port.js';
import { standaloneAuthCommandStep, standaloneAuthConfig } from './standalone-owner-domain.js';
import { AuthPersistenceError, writePrivateAuthStore } from './private-store.js';
import { createDeckSession } from './passkeys.js';
import { AuthAuditLog, credentialHashForAudit, LoginAttemptLimiter } from './security.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { registerAuthRoutes } from '../routes/auth.js';

const accessKey = 'standalone-test-key', digest = createHash('sha256').update(accessKey).digest('hex');
const origin = 'https://hub.example', legacyToken = 'original-json-cookie-not-a-canonical-token';
function directory(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-standalone-config-')); chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true })); return root;
}
function quiet() { return new PerformanceDiagnostics(() => {}); }
function manage(t: TestContext, owner: AsyncSqliteAuthOwner) {
  t.after(() => owner.closeForShutdown()); return owner;
}
for (const format of ['json', 'sqlite'] as const) for (const fixedKey of [true, false]) {
  test(`standalone ${format}/${fixedKey ? 'fixed-key' : 'no-key'} preserves real HTTP login and owner reopen`, async t => {
    const root = directory(t), bound = fixedKey ? { accessKeyDigest: digest } : {};
    const config = format === 'json'
      ? { kind: 'json' as const, passkeysFile: join(root, 'passkeys.json'), sessionsFile: join(root, 'sessions.json'), ...bound }
      : { kind: 'sqlite' as const, file: join(root, 'auth.sqlite'), legacyFiles: [], ...bound };
    if (config.kind === 'json') {
      writePrivateAuthStore(config.passkeysFile, { credentials: [] });
      writePrivateAuthStore(config.sessionsFile, { sessions: [legacyToken] });
    }
    const owner = manage(t, new AsyncSqliteAuthOwner(config, quiet())); await owner.open();
    const port = new AsyncSqliteAuthRoutePort(owner, fixedKey ? digest : undefined);
    const request = new Request(origin);
    assert.equal(await port.authority.authorize(request), !fixedKey);
    assert.equal(await port.administrator(request), false);
    assert.throws(() => new AsyncSqliteAuthRoutePort(owner, fixedKey ? undefined : digest), AuthPersistenceError);
    const app = new Hono();
    registerAuthRoutes(app, { accessKey: fixedKey ? accessKey : undefined, ...port,
      auditLog: new AuthAuditLog(), diagnostics: quiet(),
      isAuthorizedRequest: () => { throw Error('synchronous authority is forbidden'); },
      loginLimiter: new LoginAttemptLimiter({ maxFailures: 10, windowMs: 60_000, lockoutMs: 1000 }), lockoutSeconds: 1 });
    const login = await app.request(origin + '/api/auth/login', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accessKey }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    if (fixedKey) {
      assert.ok(cookie); const cookieRequest = new Request(origin, { headers: { cookie } });
      assert.equal(await port.authority.authorize(cookieRequest), true);
      assert.equal(await port.administrator(cookieRequest), true);
      assert.equal(await port.administrator(new Request(origin, { headers: { cookie, 'x-agentopsdeck-key': 'wrong' } })), false);
      await assert.rejects(owner.command('issueUnrestrictedSession', { token: createDeckSession() }), AuthPersistenceError);
      await owner.close();
      const reopened = manage(t, new AsyncSqliteAuthOwner(config, quiet())); await reopened.open();
      const next = new AsyncSqliteAuthRoutePort(reopened, digest);
      assert.equal(await next.administrator(cookieRequest), true);
      const token = cookie.slice(cookie.indexOf('=') + 1);
      assert.equal(await next.sessions.delete(token), true);
      assert.equal(await next.administrator(cookieRequest), false);
    } else {
      assert.ok(cookie);
      assert.equal(await port.administrator(new Request(origin, { headers: { cookie } })), false);
      assert.equal(await port.administrator(new Request(origin, { headers: { 'x-agentopsdeck-key': accessKey } })), false);
      await owner.close();
      const reopened = manage(t, new AsyncSqliteAuthOwner(config, quiet())); await reopened.open();
      const next = new AsyncSqliteAuthRoutePort(reopened);
      assert.equal(await next.authority.authorize(request), true);
      assert.equal(await next.sessions.has!(cookie.slice(cookie.indexOf('=') + 1)), true);
    }
    if (format === 'json') assert.ok(readdirSync(root).every(file => !file.includes('sqlite')));
  });
}

test('standalone JSON uses original legacy evidence for mutation; SQLite protocol stays canonical', async t => {
  const root = directory(t), passkeysFile = join(root, 'passkeys.json'), sessionsFile = join(root, 'sessions.json');
  const credentialId = Buffer.from('legacy-authority').toString('base64url');
  writePrivateAuthStore(passkeysFile, { credentials: [{ id: credentialId, publicKey: 'AA', counter: 0,
    rpId: 'hub.example', keyIdentityHash: digest.slice(0, 24), createdAt: 1 }] });
  writePrivateAuthStore(sessionsFile, { sessions: [legacyToken] });
  const owner = manage(t, new AsyncSqliteAuthOwner({ kind: 'json', passkeysFile, sessionsFile, accessKeyDigest: digest }, quiet()));
  await owner.open(); const port = new AsyncSqliteAuthRoutePort(owner, digest);
  const request = new Request(origin, { headers: { cookie: `agentopsdeck_session=${legacyToken}` } });
  assert.equal(await port.sessions.has!(legacyToken), true);
  const options = await port.passkeys.registrationOptions(request, digest.slice(0, 24));
  assert.ok(options.challenge);
  const before = readFileSync(passkeysFile);
  assert.equal(await port.authority.revoke!(new Request(origin), digest.slice(0, 24), credentialHashForAudit(credentialId)), false);
  assert.deepEqual(readFileSync(passkeysFile), before);
  assert.equal(await port.authority.revoke!(request, digest.slice(0, 24), credentialHashForAudit(credentialId)), true);
  assert.equal(await port.sessions.delete(legacyToken), true);
  await assert.rejects(port.passkeys.registrationOptions(request, digest.slice(0, 24)), AuthPersistenceError);
  const sql = manage(t, new AsyncSqliteAuthOwner({ file: join(root, 'auth.sqlite'), legacyFiles: [], accessKeyDigest: digest }, quiet()));
  await sql.open();
  await assert.rejects(sql.command('registrationOptions', { origin, evidence: { sessionToken: legacyToken } }), AuthPersistenceError);
  assert.equal(sql.snapshot().unavailable, false);
});

for (const fixedKey of [true, false]) test(`standalone JSON/${fixedKey ? 'fixed-key' : 'no-key'} signed HTTP login retains original owner delivery proof`, async t => {
  const root = directory(t), passkeysFile = join(root, 'passkeys.json'), sessionsFile = join(root, 'sessions.json');
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), jwk = publicKey.export({ format: 'jwk' });
  const publicCose = Buffer.concat([Buffer.from('a5010203262001215820', 'hex'), Buffer.from(jwk.x!, 'base64url'),
    Buffer.from('225820', 'hex'), Buffer.from(jwk.y!, 'base64url')]);
  const id = Buffer.from('standalone-signed-credential').toString('base64url');
  writePrivateAuthStore(passkeysFile, { credentials: [{ id, publicKey: publicCose.toString('base64url'), counter: 0,
    rpId: 'hub.example', ...(fixedKey ? { keyIdentityHash: digest.slice(0, 24) } : {}), createdAt: 1 }] });
  const config = { kind: 'json' as const, passkeysFile, sessionsFile, ...(fixedKey ? { accessKeyDigest: digest } : {}) };
  const owner = manage(t, new AsyncSqliteAuthOwner(config, quiet())); await owner.open();
  const port = new AsyncSqliteAuthRoutePort(owner, fixedKey ? digest : undefined), app = new Hono();
  registerAuthRoutes(app, { accessKey: fixedKey ? accessKey : undefined, ...port, auditLog: new AuthAuditLog(), diagnostics: quiet(),
    isAuthorizedRequest: () => { throw Error('no synchronous fallback'); },
    loginLimiter: new LoginAttemptLimiter({ maxFailures: 10, windowMs: 60_000, lockoutMs: 1000 }), lockoutSeconds: 1 });
  const options = await (await app.request(origin + '/api/auth/passkeys/login/options', { method: 'POST' })).json() as { challenge: string };
  const client = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin }));
  const authenticator = Buffer.alloc(37); createHash('sha256').update('hub.example').digest().copy(authenticator);
  authenticator[32] = 5; authenticator.writeUInt32BE(1, 33);
  const response: AuthenticationResponseJSON = { id, rawId: id, type: 'public-key', clientExtensionResults: {}, response: {
    clientDataJSON: client.toString('base64url'), authenticatorData: authenticator.toString('base64url'),
    signature: sign('sha256', Buffer.concat([authenticator, createHash('sha256').update(client).digest()]), privateKey).toString('base64url'),
  } };
  const login = await app.request(origin + '/api/auth/passkeys/login/verify', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(response) });
  assert.equal(login.status, 200);
  const body = JSON.stringify(await login.json()); assert.doesNotMatch(body, /deliveryExpiresAt|isCurrent|sessionToken/);
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!, token = cookie.slice(cookie.indexOf('=') + 1);
  assert.equal(await owner.originalJson!.session({ action: 'authentication-current', token }), true);
  assert.equal(await port.administrator(new Request(origin, { headers: { cookie } })), false);
  await owner.close();
  const reopened = manage(t, new AsyncSqliteAuthOwner(config, quiet())); await reopened.open();
  assert.equal(await reopened.originalJson!.session({ action: 'current', token }), true);
  assert.equal(await reopened.originalJson!.session({ action: 'authentication-current', token }), false);
});

test('fixed command logging retains old codes independently of command-list growth and rejects unknown phases', () => {
  assert.equal(standaloneAuthCommandStep('issueAdministratorSession'), 6);
  assert.equal(standaloneAuthCommandStep('verifyAuthentication'), 14);
  assert.deepEqual(['originalJsonSession', 'originalJsonAuthorized', 'issueUnrestrictedSession'].map(standaloneAuthCommandStep), [15, 16, 17]);
  assert.equal(standaloneAuthCommandStep('currentKeyBinding'), 18);
  for (const kind of ['__proto__', 'constructor', null, undefined, new Proxy({}, { get() { assert.fail('no coercion'); } })]) {
    assert.equal(standaloneAuthCommandStep(kind), 0);
  }
});

test('standalone backend selection never defaults unknown configuration into a different owner', () => {
  for (const config of [{ kind: 'unknown', file: 'auth', legacyFiles: [] },
    { kind: 'json', passkeysFile: 'keys', sessionsFile: 'sessions', file: 'auth' },
    { kind: 'json', passkeysFile: 'keys', sessionsFile: 'sessions', accessKeyDigest: 'public-identity-not-proof' },
    { kind: 'json', passkeysFile: '', sessionsFile: 'sessions' },
    { kind: 'sqlite', file: 'auth', legacyFiles: ['bad\0path'] }]) {
    assert.throws(() => standaloneAuthConfig(config), AuthPersistenceError);
  }
});

for (const alias of ['same', 'hardlink', 'symlink'] as const) {
  test(`JSON second-file ${alias} conflict releases only newly acquired reservations`, async t => {
    const root = directory(t), passkeysFile = join(root, 'passkeys.json'), sessionsFile = join(root, 'sessions.json');
    writePrivateAuthStore(passkeysFile, { credentials: [] }); writePrivateAuthStore(sessionsFile, { sessions: [] });
    const first = join(root, 'other-passkeys.json'), second = alias === 'same' ? sessionsFile : join(root, 'alias.json');
    writePrivateAuthStore(first, { credentials: [] });
    if (alias === 'hardlink') linkSync(sessionsFile, second);
    if (alias === 'symlink') symlinkSync(sessionsFile, second);
    const held = manage(t, new AsyncSqliteAuthOwner({ kind: 'json', passkeysFile, sessionsFile }, quiet())); await held.open();
    assert.throws(() => new AsyncSqliteAuthOwner({ kind: 'json', passkeysFile: first, sessionsFile: second }, quiet()), AuthPersistenceError);
    assert.deepEqual(await held.command('status', {}), { available: false, count: 0 });
    const separate = manage(t, new AsyncSqliteAuthOwner({ kind: 'json', passkeysFile: first, sessionsFile: join(root, 'other-sessions.json') }, quiet()));
    await separate.open(); await separate.close(); await held.close();
    const reopened = manage(t, new AsyncSqliteAuthOwner({ kind: 'json', passkeysFile, sessionsFile }, quiet())); await reopened.open();
  });
}

for (const fault of ['external-drift', 'writer-lock'] as const) {
  test(`JSON ${fault} refuses safely without overwrite, lock stealing or private log fields`, async t => {
    const root = directory(t), passkeysFile = join(root, 'passkeys.json'), sessionsFile = join(root, 'sessions.json');
    writePrivateAuthStore(passkeysFile, { credentials: [] }); writePrivateAuthStore(sessionsFile, { sessions: [] });
    const diagnostics = quiet(), config = { kind: 'json' as const, passkeysFile, sessionsFile, accessKeyDigest: digest };
    const owner = manage(t, new AsyncSqliteAuthOwner(config, diagnostics)); await owner.open();
    if (fault === 'external-drift') writePrivateAuthStore(sessionsFile, { sessions: ['externally-revoked-private-token'] });
    else mkdirSync(sessionsFile + '.writer-lock');
    const before = readFileSync(sessionsFile);
    await assert.rejects(owner.command('issueAdministratorSession', { token: createDeckSession(), evidence: { suppliedKeyDigest: digest } }), AuthPersistenceError);
    assert.deepEqual(readFileSync(sessionsFile), before);
    assert.throws(() => new AsyncSqliteAuthOwner(config, quiet()), AuthPersistenceError);
    assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), new RegExp(`${digest}|${root}|externally-revoked-private-token`));
    if (fault === 'writer-lock') assert.ok(readdirSync(root).includes('sessions.json.writer-lock'));
    await owner.close();
    const reopened = manage(t, new AsyncSqliteAuthOwner(config, quiet())); await reopened.open();
    assert.deepEqual(await reopened.command('status', {}), { available: false, count: 0 });
  });
}
