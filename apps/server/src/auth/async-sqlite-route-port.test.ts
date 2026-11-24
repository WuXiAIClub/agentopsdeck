import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { AsyncSqliteAuthOwner } from './async-sqlite-owner.js';
import { AsyncSqliteAuthRoutePort } from './async-sqlite-route-port.js';
import { AuthPersistenceError } from './private-store.js';
import { AuthAuditLog, LoginAttemptLimiter, keyIdentityHash, credentialHashForAudit } from './security.js';
import { createDeckSession, type StoredPasskey } from './passkeys.js';
import { SqlitePasskeys } from './sqlite-passkeys.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { registerAuthRoutes } from '../routes/auth.js';
import { controlledHttpDeadline } from '../lifecycle/http-deadline-test-support.js';

const accessKey = 'private-test-route-key', digest = createHash('sha256').update(accessKey).digest('hex');
const key = keyIdentityHash(accessKey), origin = 'https://hub.example';
async function fixture(t: TestContext, credentials: StoredPasskey[] = [], prepare?: (db: DatabaseSync) => void,
  readWaitMs?: number) {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-async-auth-route-')); chmodSync(dir, 0o700);
  const file = join(dir, 'auth.sqlite');
  if (credentials.length || prepare) {
    const db = new DatabaseSync(file); chmodSync(file, 0o600);
    try { new SqlitePasskeys(db, () => key).importLegacy(credentials, true); prepare?.(db); }
    finally { db.close(); } // Offline fixture is closed before the runtime owner.
  }
  const logs: string[] = [], diagnostics = new PerformanceDiagnostics(line => logs.push(line));
  const owner = new AsyncSqliteAuthOwner({ file: join(dir, 'auth.sqlite'), legacyFiles: [], accessKeyDigest: digest }, diagnostics);
  t.after(async () => { await owner.closeForShutdown(); rmSync(dir, { recursive: true, force: true }); });
  await owner.open();
  const port = new AsyncSqliteAuthRoutePort(owner, digest), app = new Hono();
  registerAuthRoutes(app, { accessKey, ...port, auditLog: new AuthAuditLog(), diagnostics,
    isAuthorizedRequest: () => { throw Error('synchronous authority is forbidden'); },
    loginLimiter: new LoginAttemptLimiter({ maxFailures: 10, windowMs: 60_000, lockoutMs: 1000 }), lockoutSeconds: 1,
    ...(readWaitMs === undefined ? {} : { readWaitMs }) });
  const request = (path: string, init?: RequestInit) => app.request(origin + path, init);
  return { owner, port, request, logs, dir };
}

// Fault-only competing connection on disposable data. This is NOT a runtime
// second-writer topology or permission to bypass the single application owner.
for (const outcome of ['deadline', 'cancel'] as const) {
  test(`real SQL lock: read ${outcome} does not release, replay or replace the original writer`, { timeout: 10_000 }, async t => {
    const h = await fixture(t, [], undefined, 30_000);
    // Keep the real worker and competing SQL lock. Only expire the HTTP
    // deadline after both original commands are admitted; restore real time
    // before unlock/recovery so a fresh read is not given a 10ms I/O budget.
    const clock = outcome === 'deadline' ? controlledHttpDeadline(t) : undefined;
    const fault = new DatabaseSync(join(h.dir, 'auth.sqlite'));
    const token = createDeckSession();
    let unlocked = false;
    let write: Promise<null> | undefined;
    let read: Promise<Response> | undefined;
    try {
      fault.exec('BEGIN IMMEDIATE');
      write = h.owner.command('issueAdministratorSession', { token, evidence: { suppliedKeyDigest: digest } });
      // Observe either late outcome immediately, including failures during a
      // failed test's cleanup. No background rejection or replay is permitted.
      void write.catch(() => {});
      const controller = new AbortController();
      read = Promise.resolve(h.request('/api/auth/status', { signal: controller.signal }));
      const expiry = AbortSignal.timeout(3000);
      while (h.owner.snapshot().pending !== 2) {
        expiry.throwIfAborted(); await new Promise(resolve => setImmediate(resolve));
      }
      if (outcome === 'cancel') controller.abort();
      const response = clock ? await clock.expire(30_000, read) : await read;
      assert.equal(response.status, outcome === 'deadline' ? 503 : 408);
      assert.deepEqual(await response.json(), { error: outcome === 'deadline' ? 'auth_persistence_failed' : 'request_cancelled' });
      assert.equal(response.headers.get('set-cookie'), null);
      // HTTP settlement is not SQL settlement: both original commands and
      // their byte reservations remain owned until the worker actually ACKs.
      assert.equal(h.owner.snapshot().accepted, 2);
      assert.equal(h.owner.snapshot().pending, 2);
      assert.ok(h.owner.snapshot().acceptedBytes > 0);
      assert.equal(h.owner.snapshot().closing, false);
      assert.equal(h.owner.snapshot().unavailable, false);
      if (outcome === 'deadline') assert.ok(h.logs.some(line => {
        const row = JSON.parse(line); return row.operation === 'auth-route-persistence' && row.step === 1 && row.timedOut === 1 && row.pending === 1;
      }));
      else assert.ok(h.logs.some(line => {
        const row = JSON.parse(line); return row.operation === 'auth-route-persistence' && row.step === 1 && row.cancelled === 1 && row.pending === 1;
      }));
      fault.exec('ROLLBACK'); unlocked = true;
      await write;
      // Queued reads now complete on the same owner; the ended HTTP request
      // cannot publish another response/Cookie. A new readonly request works.
      assert.equal(await h.owner.command('sessionCurrent', { token }), true);
      assert.equal(h.owner.snapshot().accepted, 0);
      assert.equal(h.owner.snapshot().pending, 0);
      assert.equal(h.owner.snapshot().acceptedBytes, 0);
      const recovered = await h.request('/api/auth/status', { headers: { cookie: `agentopsdeck_session=${token}` } });
      assert.equal(recovered.status, 200); assert.equal((await recovered.json()).authenticated, true);
      const originalWrite = h.logs.map(line => JSON.parse(line))
        .filter(row => row.operation === 'auth-sqlite-command' && row.step === 6);
      // Controlled expiry also fires the original command's slow-work warning.
      // Pending observations are not a second SQL dispatch or settlement.
      const completedWrite = originalWrite.filter(row => row.phase === 'finished');
      assert.equal(completedWrite.length, 1);
      assert.equal(completedWrite[0].settled, 1);
      assert.ok(originalWrite.every(row => row.instance === completedWrite[0].instance
        && row.sequence === completedWrite[0].sequence));
      for (const secret of [accessKey, digest, token, h.dir]) assert.equal(h.logs.join('').includes(secret), false);
      await h.owner.close();
      assert.equal(h.owner.snapshot().ownerExitConfirmed, true);
      const reopened = new AsyncSqliteAuthOwner({ file: join(h.dir, 'auth.sqlite'), legacyFiles: [], accessKeyDigest: digest }, new PerformanceDiagnostics(() => {}));
      try {
        await reopened.open();
        assert.equal(await reopened.command('sessionCurrent', { token }), true);
      } finally { await reopened.closeForShutdown(); }
    } finally {
      clock?.restore();
      if (!unlocked) fault.exec('ROLLBACK');
      fault.close();
      await Promise.allSettled([write, read]);
    }
  });
}

test('real SQL busy failure is logged; original owner recovers without replay or a replacement writer', { timeout: 10_000 }, async t => {
  const h = await fixture(t), token = createDeckSession();
  const fault = new DatabaseSync(join(h.dir, 'auth.sqlite'));
  try {
    fault.exec('BEGIN IMMEDIATE');
    await assert.rejects(h.owner.command('issueAdministratorSession', { token, evidence: { suppliedKeyDigest: digest } }), AuthPersistenceError);
    assert.equal(h.owner.snapshot().pending, 0); assert.equal(h.owner.snapshot().accepted, 0);
    assert.equal(h.owner.snapshot().unavailable, false);
    assert.ok(h.logs.some(line => {
      // The domain sanitizes its exception before the worker boundary. The
      // original SQL log carries SQLITE_BUSY; the parent must retain unknown,
      // not invent a SQL code or forward a private exception/cause.
      const row = JSON.parse(line); return row.operation === 'auth-sqlite-owner-failure' && row.step === 6 && row.classificationUnknown === 1;
    }));
    fault.exec('ROLLBACK');
    assert.equal(await h.owner.command('sessionCurrent', { token }), false);
    assert.equal((await h.request('/api/auth/status')).status, 200);
    assert.equal(h.logs.map(line => JSON.parse(line)).filter(row => row.operation === 'auth-sqlite-command' && row.step === 6).length, 1);
    for (const secret of [accessKey, digest, token, h.dir]) assert.equal(h.logs.join('').includes(secret), false);
  } finally {
    if (fault.isTransaction) fault.exec('ROLLBACK');
    fault.close();
  }
});

function signedCredential() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const cose = Buffer.concat([Buffer.from('a5010203262001215820', 'hex'), Buffer.from(jwk.x!, 'base64url'),
    Buffer.from('225820', 'hex'), Buffer.from(jwk.y!, 'base64url')]);
  const bytes = Buffer.from('signed-http-route-fixture'), id = bytes.toString('base64url');
  const credential: StoredPasskey = { id, publicKey: cose.toString('base64url'), counter: 0,
    rpId: 'hub.example', keyIdentityHash: key, createdAt: 1, label: 'offline fixture' };
  const assertion = (challenge: string, counter: number): AuthenticationResponseJSON => {
    const client = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin })), auth = Buffer.alloc(37);
    createHash('sha256').update('hub.example').digest().copy(auth); auth[32] = 5; auth.writeUInt32BE(counter, 33);
    return { id, rawId: id, type: 'public-key', clientExtensionResults: {}, response: {
      clientDataJSON: client.toString('base64url'), authenticatorData: auth.toString('base64url'),
      signature: sign('sha256', Buffer.concat([auth, createHash('sha256').update(client).digest()]), privateKey).toString('base64url'),
    } };
  };
  const registration = (challenge: string): RegistrationResponseJSON => {
    const auth = Buffer.alloc(55);
    createHash('sha256').update('hub.example').digest().copy(auth); auth[32] = 69; auth.writeUInt16BE(bytes.length, 53);
    const attestation = isoCBOR.encode(new Map<string, string | Map<string, string> | Uint8Array>([
      ['fmt', 'none'], ['attStmt', new Map()], ['authData', new Uint8Array(Buffer.concat([auth, bytes, cose]))],
    ]));
    return { id, rawId: id, type: 'public-key', clientExtensionResults: {}, response: {
      clientDataJSON: Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin })).toString('base64url'),
      attestationObject: Buffer.from(attestation).toString('base64url'),
    } };
  };
  return { credential, assertion, registration };
}

test('signed HTTP registration/login/self-revocation remain atomic and revoked after proven exit/reopen', async t => {
  const h = await fixture(t), signed = signedCredential(), headers = { authorization: `Bearer ${accessKey}` };
  const options = await h.request('/api/auth/passkeys/register/options', { method: 'POST', headers });
  assert.equal(options.status, 200);
  const registered = await h.request('/api/auth/passkeys/register/verify', { method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ credential: signed.registration((await options.json()).challenge), label: 'HTTP fixture' }) });
  assert.equal(registered.status, 200); assert.equal((await registered.json()).passkeys.count, 1);
  const challenge = await h.request('/api/auth/passkeys/login/options', { method: 'POST' });
  const login = await h.request('/api/auth/passkeys/login/verify', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(signed.assertion((await challenge.json()).challenge, 1)) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!, token = cookie.slice(cookie.indexOf('=') + 1);
  assert.equal(await h.owner.command('accessKeySession', { token }), false);
  const revoked = await h.request('/api/auth/passkeys/' + credentialHashForAudit(signed.credential.id), { method: 'DELETE', headers: { cookie } });
  assert.equal(revoked.status, 200); assert.deepEqual(await revoked.json(), { ok: true, reauthenticate: true });
  assert.match(revoked.headers.get('set-cookie')!, /Max-Age=0/);
  assert.equal(await h.owner.command('sessionCurrent', { token }), false);
  assert.equal((await h.request('/api/auth/passkeys', { headers: { cookie } })).status, 401);
  await h.owner.close(); assert.equal(h.owner.snapshot().ownerExitConfirmed, true);
  const reopened = new AsyncSqliteAuthOwner({ file: join(h.dir, 'auth.sqlite'), legacyFiles: [], accessKeyDigest: digest });
  try {
    await reopened.open(); assert.equal(await reopened.command('sessionCurrent', { token }), false);
    assert.equal(await reopened.command('credentialCurrent', { credentialHash: credentialHashForAudit(signed.credential.id) }), false);
  } finally { await reopened.closeForShutdown(); }
  const db = new DatabaseSync(join(h.dir, 'auth.sqlite'), { readOnly: true });
  try {
    assert.deepEqual(db.prepare('SELECT kind, count(*) n FROM shared_auth_audit GROUP BY kind ORDER BY kind').all().map(r => ({ ...r })),
      [{ kind: 'issued', n: 1 }, { kind: 'registered', n: 1 }, { kind: 'revoked', n: 1 }]);
  } finally { db.close(); }
  for (const secret of [accessKey, digest, token, signed.credential.id, h.dir]) assert.equal(h.logs.join('').includes(secret), false);
});

test('signed counter regression is a fixed authentication refusal, not a SQL outage; original challenge stays spent', async t => {
  const signed = signedCredential(), h = await fixture(t, [signed.credential]);
  const authenticate = async (counter: number) => {
    const options = await h.request('/api/auth/passkeys/login/options', { method: 'POST' });
    const assertion = signed.assertion((await options.json()).challenge, counter);
    const send = () => h.request('/api/auth/passkeys/login/verify', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(assertion) });
    return { response: await send(), send };
  };
  assert.equal((await authenticate(1)).response.status, 200);
  const rejected = await authenticate(1);
  assert.equal(rejected.response.status, 400);
  assert.deepEqual(await rejected.response.json(), { error: 'passkey_verification_rejected' });
  assert.equal(rejected.response.headers.get('set-cookie'), null);
  assert.equal(h.owner.snapshot().unavailable, false);
  assert.equal((await rejected.send()).status, 401);
  assert.equal((await authenticate(2)).response.status, 200);
  assert.ok(h.logs.some(line => { const e = JSON.parse(line); return e.operation === 'auth-sqlite-command' && e.step === 14 && e.deferred === 1 && e.unknown === undefined; }));
});

test('invalid attestation is a fixed domain refusal and burns its original registration proof without storing a credential', async t => {
  const h = await fixture(t), signed = signedCredential(), headers = { authorization: `Bearer ${accessKey}`, 'content-type': 'application/json' };
  const options = await h.request('/api/auth/passkeys/register/options', { method: 'POST', headers });
  const credential = signed.registration((await options.json()).challenge);
  const send = (value: RegistrationResponseJSON) => h.request('/api/auth/passkeys/register/verify', {
    method: 'POST', headers, body: JSON.stringify(value),
  });
  const response = await send({ ...credential, response: { ...credential.response, attestationObject: 'invalid-attestation' } });
  assert.equal(response.status, 400); assert.deepEqual(await response.json(), { error: 'passkey_verification_rejected' });
  assert.equal(response.headers.get('set-cookie'), null); assert.equal((await send(credential)).status, 400);
  assert.deepEqual(await h.port.passkeys.status(key), { available: false, count: 0 });
  assert.equal(h.owner.snapshot().unavailable, false); assert.equal(h.logs.join('').includes('invalid-attestation'), false);
});

for (const operation of ['login', 'register'] as const)
  test(`malformed ${operation} credential DTO is refused before SQL dispatch, not reported as storage recovery`, async t => {
    const h = await fixture(t), before = h.owner.snapshot();
    const response = await h.request(`/api/auth/passkeys/${operation}/verify`, { method: 'POST',
      headers: { authorization: `Bearer ${accessKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ id: 'incomplete-fixture' }) });
    assert.equal(response.status, 400); assert.deepEqual(await response.json(), { error: 'passkey_verification_rejected' });
    assert.equal(response.headers.get('set-cookie'), null); assert.equal(h.owner.snapshot().unavailable, before.unavailable);
    assert.ok(h.logs.some(line => { const e = JSON.parse(line); return e.operation === 'auth-sqlite-command'
      && e.step === (operation === 'login' ? 14 : 13) && e.deferred === 1 && e.admitted === undefined && e.unknown === undefined; }));
    assert.equal(h.logs.join('').includes('incomplete-fixture'), false);
  });

test('valid signature with SQL audit failure remains unknown/503, rolls back session/counter, and never becomes a crypto refusal', async t => {
  const signed = signedCredential();
  const h = await fixture(t, [signed.credential], db => db.exec(
    "CREATE TRIGGER reject_issued BEFORE INSERT ON shared_auth_audit WHEN NEW.kind='issued' BEGIN SELECT RAISE(ABORT,'private-audit-fixture'); END"));
  const options = await h.request('/api/auth/passkeys/login/options', { method: 'POST' });
  const credential = signed.assertion((await options.json()).challenge, 1);
  const send = () => h.request('/api/auth/passkeys/login/verify', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(credential) });
  const response = await send();
  assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: 'auth_persistence_failed' });
  assert.equal(response.headers.get('set-cookie'), null); assert.equal((await send()).status, 401);
  assert.equal(h.owner.snapshot().unavailable, false);
  assert.ok(h.logs.some(line => { const e = JSON.parse(line); return e.operation === 'auth-sqlite-command' && e.step === 14 && e.unknown === 1 && e.deferred === undefined; }));
  assert.equal(h.logs.join('').includes('private-audit-fixture'), false);
  await h.owner.close();
  const db = new DatabaseSync(join(h.dir, 'auth.sqlite'), { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT count(*) n FROM shared_auth_sessions').get()!.n, 0);
    assert.equal(JSON.parse(db.prepare('SELECT payload FROM shared_auth_credentials WHERE id=?').get(signed.credential.id)!.payload as string).counter, 0);
  } finally { db.close(); }
});

test('real standalone HTTP key login, cookie authorization and logout use one awaited SQL owner', async t => {
  const h = await fixture(t);
  assert.equal((await h.request('/api/auth/passkeys')).status, 401);
  const login = await h.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accessKey }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const token = decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1));
  assert.equal(await h.owner.command('sessionCurrent', { token }), true);
  const list = await h.request('/api/auth/passkeys', { headers: { cookie } });
  assert.equal(list.status, 200); assert.deepEqual(await list.json(), { passkeys: [] });
  const status = await h.request('/api/auth/status', { headers: { cookie } });
  assert.equal((await status.json()).authenticated, true);
  const logout = await h.request('/api/auth/logout', { method: 'POST', headers: { cookie } });
  assert.equal(logout.status, 200); assert.match(logout.headers.get('set-cookie')!, /Max-Age=0/);
  assert.equal(await h.owner.command('sessionCurrent', { token }), false);
  assert.equal((await h.request('/api/auth/passkeys', { headers: { cookie } })).status, 401);
  assert.ok(h.logs.some(line => JSON.parse(line).operation === 'auth-sqlite-command'));
  assert.ok(h.logs.some(line => JSON.parse(line).operation === 'auth-route-persistence'));
  for (const secret of [accessKey, digest, token, h.dir]) assert.equal(h.logs.join('').includes(secret), false);
});

test('public audit identity and browser-provided evidence do not authorize or issue a login session', async t => {
  const h = await fixture(t);
  const request = (supplied: string) => h.request('/api/auth/login', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accessKey: supplied,
      evidence: { suppliedKeyDigest: digest }, authorized: true }) });
  for (const supplied of [key, digest]) {
    const response = await request(supplied);
    assert.equal(response.status, 401); assert.equal(response.headers.get('set-cookie'), null);
    assert.equal((await h.request('/api/auth/passkeys', { headers: { authorization: `Bearer ${supplied}` } })).status, 401);
  }
  assert.equal(await h.port.authority.authorize(new Request(origin, { headers: { authorization: `Bearer ${accessKey}` } })), true);
});

test('no registered passkey is a fixed domain refusal, not a SQL outage or arbitrary exception', async t => {
  const h = await fixture(t);
  const response = await h.request('/api/auth/passkeys/login/options', { method: 'POST' });
  assert.equal(response.status, 400); assert.deepEqual(await response.json(), { error: 'No passkeys registered for this host' });
  assert.equal(response.headers.get('retry-after'), null); assert.equal(h.owner.snapshot().unavailable, false);
  assert.deepEqual(await h.port.passkeys.status(key), { available: false, count: 0 });
});

test('route facade refuses legacy callbacks and non-administrator second issuance without evaluating callback', async t => {
  const h = await fixture(t); let calls = 0;
  const callback = () => { calls++; return true; };
  assert.throws(() => h.port.passkeys.revoke(key, 'a'.repeat(24), undefined, callback), AuthPersistenceError);
  await assert.rejects(h.port.passkeys.verifyRegistration(new Request(origin), {} as never,
    { keyIdentityHash: key, isAuthorized: callback }), AuthPersistenceError);
  assert.throws(() => h.port.sessions.add(createDeckSession(), { credentialHash: 'a'.repeat(24), keyIdentityHash: key }), AuthPersistenceError);
  assert.equal(calls, 0); assert.equal(h.owner.snapshot().accepted, 0);
});

test('fixed-key mismatch and owner close reject new route admission, never restart or replace writer', async t => {
  const h = await fixture(t);
  await assert.rejects(Promise.resolve(h.port.passkeys.status('b'.repeat(24))), AuthPersistenceError);
  assert.throws(() => new AsyncSqliteAuthRoutePort(h.owner, key), AuthPersistenceError);
  const close = h.owner.close();
  assert.throws(() => new AsyncSqliteAuthRoutePort(h.owner, digest), AuthPersistenceError);
  const response = await h.request('/api/auth/passkeys', { headers: { authorization: `Bearer ${accessKey}` } });
  assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: 'auth_persistence_failed' });
  await close; assert.equal(h.owner.snapshot().ownerExitConfirmed, true);
  await assert.rejects(Promise.resolve(h.port.authority.sessionCurrent(createDeckSession())), AuthPersistenceError);
});

test('logout filters only non-Auth tokens, keeps strict worker schema, and never bypasses close', async t => {
  const h = await fixture(t), token = createDeckSession();
  await h.port.sessions.add(token);
  const before = h.owner.snapshot().accepted;
  const values = ['', 'not-a-session', 'hub_session_' + 'z'.repeat(43)];
  for (const value of values) assert.equal(await h.port.sessions.delete(value), false);
  assert.equal(h.owner.snapshot().accepted, before);
  assert.equal(await h.owner.command('sessionCurrent', { token }), true);
  assert.equal(await h.port.sessions.delete(token), true);
  assert.equal(await h.port.sessions.delete(token), false);
  const close = h.owner.close();
  for (const value of values) await assert.rejects(async () => h.port.sessions.delete(value), AuthPersistenceError);
  await close;
});

for (const mismatched of ['b'.repeat(64), digest.slice(0, 24) + 'b'.repeat(40)]) {
  test('a route adapter with a different full key cannot reuse original SQL authority, even with the same audit identity', async t => {
    const h = await fixture(t), before = h.owner.snapshot();
    assert.throws(() => new AsyncSqliteAuthRoutePort(h.owner, mismatched), AuthPersistenceError);
    assert.equal(h.owner.snapshot().accepted, before.accepted); assert.equal(h.owner.snapshot().unavailable, false);
    assert.equal(await h.port.authority.authorize(new Request(origin, { headers: { authorization: `Bearer ${accessKey}` } })), true);
    const rejected = h.logs.map(line => JSON.parse(line)).filter(e => e.operation === 'auth-sqlite-owner' && e.step === 6);
    assert.equal(rejected.length, 1); assert.equal(rejected[0].deferred, 1); assert.equal(rejected[0].unknown, undefined);
    assert.equal(h.logs.join('').includes(mismatched), false);
  });
}

test('fixed-key replacement requires original exit and a new bound owner; old key sessions remain denied on preserved data', async t => {
  const h = await fixture(t), oldToken = createDeckSession();
  await h.port.sessions.add(oldToken); await h.owner.close();
  assert.equal(h.owner.snapshot().ownerExitConfirmed, true);
  const nextKey = 'private-next-route-key', nextDigest = createHash('sha256').update(nextKey).digest('hex');
  const owner = new AsyncSqliteAuthOwner({ file: join(h.dir, 'auth.sqlite'), legacyFiles: [], accessKeyDigest: nextDigest });
  try {
    await owner.open();
    assert.throws(() => new AsyncSqliteAuthRoutePort(owner, digest), AuthPersistenceError);
    const port = new AsyncSqliteAuthRoutePort(owner, nextDigest);
    assert.equal(await port.authority.sessionCurrent(oldToken), false);
    assert.equal(await port.authority.authorize(new Request(origin, { headers: { authorization: `Bearer ${accessKey}` } })), false);
    assert.equal(await port.authority.authorize(new Request(origin, { headers: { authorization: `Bearer ${nextKey}` } })), true);
    const nextToken = createDeckSession(); await port.sessions.add(nextToken);
    assert.equal(await port.authority.sessionCurrent(nextToken), true);
  } finally { await owner.closeForShutdown(); }
  const observation = new DatabaseSync(join(h.dir, 'auth.sqlite'), { readOnly: true });
  try { assert.equal(observation.prepare('SELECT count(*) n FROM shared_auth_sessions').get()!.n, 2); }
  finally { observation.close(); }
});

test('administrator session issuance survives original owner close and stopped-data reopen', async t => {
  const h = await fixture(t), token = createDeckSession();
  await h.port.sessions.add(token); await h.owner.close();
  const reopened = new AsyncSqliteAuthOwner({ file: join(h.dir, 'auth.sqlite'), legacyFiles: [], accessKeyDigest: digest });
  try {
    await reopened.open(); const port = new AsyncSqliteAuthRoutePort(reopened, digest);
    assert.equal(await port.authority.sessionCurrent(token), true);
    await port.sessions.delete(token); assert.equal(await port.authority.sessionCurrent(token), false);
  } finally { await reopened.closeForShutdown(); }
});

test('real challenge capacity remains 429 with bounded retry hint; same original owner remains usable', async t => {
  const h = await fixture(t);
  for (let i = 0; i < 256; i++) await h.owner.command('registrationOptions', { origin, evidence: { suppliedKeyDigest: digest } });
  const response = await h.request('/api/auth/passkeys/register/options', { method: 'POST',
    headers: { authorization: `Bearer ${accessKey}` } });
  assert.equal(response.status, 429); assert.equal(response.headers.get('retry-after'), '1');
  assert.deepEqual(await response.json(), { error: 'passkey_challenge_capacity', retryAfterSeconds: 1 });
  assert.equal(h.owner.snapshot().unavailable, false);
  assert.equal(await h.port.authority.authorize(new Request(origin, { headers: { authorization: `Bearer ${accessKey}` } })), true);
  assert.ok(h.logs.some(line => { const e = JSON.parse(line); return e.operation === 'auth-sqlite-command' && e.deferred === 1; }));
});

test('awaited original-owner membership and administrator classification preserve credential precedence', async t => {
  const h = await fixture(t), signed = signedCredential(), token = createDeckSession();
  await h.owner.command('issueAdministratorSession', { token, evidence: { suppliedKeyDigest: digest } });
  assert.equal(await h.port.sessions.has!(token), true);
  const cookie = { cookie: 'agentopsdeck_session=' + token };
  assert.equal(await h.port.administrator(new Request(origin, { headers: cookie })), true);
  assert.equal(await h.port.administrator(new Request(origin, { headers: { ...cookie, authorization: 'Bearer incorrect' } })), false);
  assert.equal(await h.port.administrator(new Request(origin, { headers: { authorization: 'Bearer ' + accessKey } })), true);
  assert.equal(await h.port.administrator(new Request(origin)), false);
  assert.equal(await h.port.administrator(new Request(origin, { headers: { cookie: 'agentopsdeck_session=malformed' } })), false);
  const headers = { authorization: 'Bearer ' + accessKey };
  const options = await h.request('/api/auth/passkeys/register/options', { method: 'POST', headers });
  const registered = await h.request('/api/auth/passkeys/register/verify', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ credential: signed.registration((await options.json()).challenge) }) });
  assert.equal(registered.status, 200);
  const challenge = await h.request('/api/auth/passkeys/login/options', { method: 'POST' });
  const login = await h.request('/api/auth/passkeys/login/verify', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(signed.assertion((await challenge.json()).challenge, 1)) });
  assert.equal(login.status, 200);
  const passkeyCookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const passkeyToken = passkeyCookie.slice(passkeyCookie.indexOf('=') + 1);
  assert.equal(await h.port.sessions.has!(passkeyToken), true);
  assert.equal(await h.port.administrator(new Request(origin, { headers: { cookie: passkeyCookie } })), false);
  assert.equal(await h.port.administrator(new Request(origin, { headers: { cookie: passkeyCookie, authorization: 'Bearer ' + accessKey } })), true);
  await h.owner.command('deleteSession', { token });
  assert.equal(await h.port.sessions.has!(token), false);
  assert.equal(await h.port.administrator(new Request(origin, { headers: cookie })), false);
  const revoked = await h.request('/api/auth/passkeys/' + credentialHashForAudit(signed.credential.id), { method: 'DELETE', headers: { cookie: passkeyCookie } });
  assert.equal(revoked.status, 200);
  assert.equal(await h.port.sessions.has!(passkeyToken), false);
  for (const secret of [accessKey, digest, token, passkeyToken, h.dir]) assert.equal(h.logs.join('').includes(secret), false);
});

for (const kind of ['membership', 'administrator'] as const) {
  test('awaited ' + kind + ' refuses a late true result after original owner shutdown starts', { timeout: 10_000 }, async t => {
    const h = await fixture(t), token = createDeckSession(), pendingToken = createDeckSession();
    await h.owner.command('issueAdministratorSession', { token, evidence: { suppliedKeyDigest: digest } });
    // Competing connection exists ONLY for SQL fault injection on disposable data.
    const fault = new DatabaseSync(join(h.dir, 'auth.sqlite'));
    let write: Promise<null> | undefined, read: Promise<boolean> | undefined, close: Promise<void> | undefined;
    try {
      fault.exec('BEGIN IMMEDIATE');
      write = h.owner.command('issueAdministratorSession', { token: pendingToken, evidence: { suppliedKeyDigest: digest } });
      void write.catch(() => {});
      read = kind === 'membership' ? Promise.resolve(h.port.sessions.has!(token))
        : h.port.administrator(new Request(origin, { headers: { cookie: 'agentopsdeck_session=' + token } }));
      void read.catch(() => {});
      const deadline = AbortSignal.timeout(3000);
      while (h.owner.snapshot().pending !== 2) { deadline.throwIfAborted(); await new Promise(resolve => setImmediate(resolve)); }
      close = h.owner.close(); void close.catch(() => {});
      assert.equal(h.owner.snapshot().closing, true);
      assert.equal(h.owner.snapshot().accepted, 2);
      fault.exec('ROLLBACK');
      await write;
      await assert.rejects(read, AuthPersistenceError);
      await close;
      assert.equal(h.owner.snapshot().ownerExitConfirmed, true);
      assert.equal(h.owner.snapshot().accepted, 0);
    } finally {
      if (fault.isTransaction) fault.exec('ROLLBACK'); fault.close();
      await Promise.allSettled([write, read, close].filter(Boolean));
    }
  });
}

test('awaited classification reads saved original sessions after proven exit/reopen, never a token cache', async t => {
  const h = await fixture(t), token = createDeckSession();
  await h.owner.command('issueAdministratorSession', { token, evidence: { suppliedKeyDigest: digest } });
  assert.equal(await h.port.sessions.has!(token), true);
  await h.owner.close();
  await assert.rejects(Promise.resolve(h.port.sessions.has!(token)), AuthPersistenceError);
  await assert.rejects(h.port.administrator(new Request(origin)), AuthPersistenceError);
  const owner = new AsyncSqliteAuthOwner({ file: join(h.dir, 'auth.sqlite'), legacyFiles: [], accessKeyDigest: digest }, new PerformanceDiagnostics(() => {}));
  t.after(() => owner.closeForShutdown()); await owner.open();
  const port = new AsyncSqliteAuthRoutePort(owner, digest);
  assert.equal(await port.sessions.has!(token), true);
  assert.equal(await port.administrator(new Request(origin, { headers: { cookie: 'agentopsdeck_session=' + token } })), true);
  await owner.command('deleteSession', { token });
  assert.equal(await port.sessions.has!(token), false);
  assert.equal(await port.administrator(new Request(origin, { headers: { cookie: 'agentopsdeck_session=' + token } })), false);
  await owner.close();
});
