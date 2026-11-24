import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmodSync, linkSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { Hono } from 'hono';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { SqlitePasskeys } from './sqlite-passkeys.js';
import { openSqliteAuth } from './sqlite-store.js';
import { AuthPersistenceError } from './private-store.js';
import { createDeckSession, sessionTokenFromRequest } from './passkeys.js';
import { AuthAuditLog, LoginAttemptLimiter, keyIdentityHash } from './security.js';
import { registerAuthRoutes } from '../routes/auth.js';
import { createApplication } from '../application.js';
import { loadConfig } from '../config.js';
import { recoverableConnection, connectionRecoverySnapshot, StorageConnectionUnavailable } from '../storage/connection-recovery.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const origin = 'https://hub.example', key = keyIdentityHash('synthetic-key');
const request = () => new Request(origin, { headers: { origin } });
test('corrupted session rows fail closed without promoting passkeys to administrators', t => {
  const h = fixture(t), token = createDeckSession();
  h.first.addAdministratorSession(token);
  assert.equal(h.first.isAccessKeySession(token), true);
  for (const binding of ['{', 'null', '[]', JSON.stringify({ keyIdentityHash: key, credentialHash: '' }),
    JSON.stringify({ keyIdentityHash: key, credentialHash: 0 }), JSON.stringify({ keyIdentityHash: key, extra: true })]) {
    h.a.prepare('UPDATE shared_auth_sessions SET binding=?').run(binding);
    assert.equal(h.first.sessionAuthorized(token), false);
    assert.equal(h.first.isAccessKeySession(token), false);
  }
  h.a.prepare('UPDATE shared_auth_sessions SET binding=?,expires=?').run(JSON.stringify({ keyIdentityHash: key }), 'invalid');
  assert.equal(h.first.sessionAuthorized(token), false);
});
test('credential corruption and database failures expose only safe persistence errors', t => {
  const h = fixture(t), original = h.a.prepare('SELECT payload FROM shared_auth_credentials').get()!.payload;
  assert.equal(typeof original, 'string');
  h.a.prepare('UPDATE shared_auth_credentials SET payload=?').run('{private-diagnostic');
  assert.throws(() => h.first.list(key), AuthPersistenceError);
  h.a.prepare('UPDATE shared_auth_credentials SET payload=?,version=-1').run(String(original));
  assert.throws(() => h.first.list(key), AuthPersistenceError);
  h.a.prepare('UPDATE shared_auth_credentials SET version=0,id=?').run('mismatched');
  assert.throws(() => h.first.list(key), AuthPersistenceError);
  h.a.exec("CREATE TRIGGER fail_session BEFORE INSERT ON shared_auth_sessions BEGIN SELECT RAISE(ABORT,'private-diagnostic'); END");
  assert.throws(() => h.first.addAdministratorSession(createDeckSession()), AuthPersistenceError);
  assert.equal(h.a.isTransaction, false);
});
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-sqlite-auth-')), file = join(dir, 'auth.sqlite');
  const a = new DatabaseSync(file); a.exec('PRAGMA journal_mode=WAL');
  const b = new DatabaseSync(file);
  t.after(() => { if (a.isOpen) a.close(); if (b.isOpen) b.close(); rmSync(dir, { recursive: true, force: true }); });
  let now = 10_000, currentKey: string | undefined = key;
  const first = new SqlitePasskeys(a, () => currentKey, () => now), second = new SqlitePasskeys(b, () => currentKey, () => now);
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const cose = Buffer.concat([Buffer.from('a5010203262001215820', 'hex'), Buffer.from(jwk.x!, 'base64url'),
    Buffer.from('225820', 'hex'), Buffer.from(jwk.y!, 'base64url')]);
  const id = Buffer.from('shared-auth-fixture').toString('base64url');
  first.importLegacy([{ id, publicKey: cose.toString('base64url'), counter: 0, rpId: 'hub.example',
    keyIdentityHash: key, createdAt: 1, label: 'fixture' }], true);
  const assertion = (challenge: string, counter = 1): AuthenticationResponseJSON => {
    const client = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin })), auth = Buffer.alloc(37);
    createHash('sha256').update('hub.example').digest().copy(auth); auth[32] = 5; auth.writeUInt32BE(counter, 33);
    return { id, rawId: id, type: 'public-key', clientExtensionResults: {}, response: {
      clientDataJSON: client.toString('base64url'), authenticatorData: auth.toString('base64url'),
      signature: sign('sha256', Buffer.concat([auth, createHash('sha256').update(client).digest()]), privateKey).toString('base64url'),
    } };
  };
  const registration = (challenge: string) => {
    const credentialId = Buffer.from('new-shared-auth-fixture'), auth = Buffer.alloc(55);
    createHash('sha256').update('hub.example').digest().copy(auth); auth[32] = 69; auth.writeUInt16BE(credentialId.length, 53);
    const attestation = isoCBOR.encode(new Map<string, string | Map<string, string> | Uint8Array>([
      ['fmt', 'none'], ['attStmt', new Map()], ['authData', new Uint8Array(Buffer.concat([auth, credentialId, cose]))],
    ]));
    return { id: credentialId.toString('base64url'), rawId: credentialId.toString('base64url'), type: 'public-key' as const,
      clientExtensionResults: {}, response: { clientDataJSON: Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin })).toString('base64url'),
        attestationObject: Buffer.from(attestation).toString('base64url') } };
  };
  return { a, b, first, second, assertion, registration, file, id, advance: (ms: number) => { now += ms; }, rotate: () => { currentKey = keyIdentityHash('rotated-key'); } };
}

test('real signed cross-connection assertion atomically issues digest-only session; replay fails', async t => {
  const h = fixture(t), options = await h.first.authenticationOptions(request(), key), proof = h.assertion(options.challenge);
  const result = await h.second.verifyAuthentication(request(), proof, key); assert.ok(result.verified);
  assert.ok(h.first.sessions.has(result.sessionToken)); assert.ok(result.isCurrent());
  assert.equal(h.first.sessions.isAccessKeySession(result.sessionToken), false);
  assert.equal((await h.first.verifyAuthentication(request(), proof, key)).verified, false);
  assert.equal(h.a.prepare('SELECT count(*) n FROM shared_auth_sessions').get()!.n, 1);
  const stored = JSON.stringify(h.a.prepare('SELECT * FROM shared_auth_sessions').all());
  assert.ok(!stored.includes(result.sessionToken)); assert.ok(!readFileSync(h.file).includes(Buffer.from(result.sessionToken)));
});

test('real registration crosses instances, consumes challenge and honors authorization', async t => {
  const h = fixture(t), options = await h.first.registrationOptions(request(), key), proof = h.registration(options.challenge);
  assert.equal((await h.second.verifyRegistration(request(), proof, { keyIdentityHash: key, isAuthorized: () => true })).verified, true);
  assert.equal(h.first.status(key).count, 2);
  assert.equal((await h.first.verifyRegistration(request(), proof, { keyIdentityHash: key })).verified, false);
});

test('registration authorization disappearing during crypto creates no credential', async t => {
  const h = fixture(t), options = await h.first.registrationOptions(request(), key);
  assert.equal((await h.second.verifyRegistration(request(), h.registration(options.challenge), { keyIdentityHash: key, isAuthorized: () => false })).verified, false);
  assert.equal(h.first.status(key).count, 1);
});

for (const race of ['revoke', 'rotate', 'expire'] as const) test(`in-flight real signature fenced by ${race}`, async t => {
  const h = fixture(t), options = await h.first.authenticationOptions(request(), key);
  const pending = h.first.verifyAuthentication(request(), h.assertion(options.challenge), key);
  if (race === 'revoke') h.second.revoke(key, h.second.list(key)[0]!.id);
  if (race === 'rotate') h.rotate();
  if (race === 'expire') h.advance(300_000);
  assert.equal((await pending).verified, false);
  assert.equal(h.a.prepare('SELECT count(*) n FROM shared_auth_sessions').get()!.n, 0);
});

test('parallel assertions for same captured version issue only one session', async t => {
  const h = fixture(t), x = await h.first.authenticationOptions(request(), key), y = await h.second.authenticationOptions(request(), key);
  const results = await Promise.all([h.first.verifyAuthentication(request(), h.assertion(x.challenge), key),
    h.second.verifyAuthentication(request(), h.assertion(y.challenge), key)]);
  assert.equal(results.filter(r => r.verified).length, 1);
});

test('audit failure rolls back counter/session and burns proof without replay', async t => {
  const h = fixture(t), options = await h.first.authenticationOptions(request(), key), proof = h.assertion(options.challenge);
  h.a.exec("CREATE TRIGGER fail_auth BEFORE INSERT ON shared_auth_audit BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END");
  await assert.rejects(h.first.verifyAuthentication(request(), proof, key));
  assert.equal(h.a.prepare('SELECT version FROM shared_auth_credentials').get()!.version, 0);
  assert.equal(h.a.prepare('SELECT count(*) n FROM shared_auth_sessions').get()!.n, 0);
  h.a.exec('DROP TRIGGER fail_auth');
  assert.equal((await h.second.verifyAuthentication(request(), proof, key)).verified, false);
});

test('revoke invalidates every previously issued session across instances', async t => {
  const h = fixture(t);
  const first = await h.first.authenticationOptions(request(), key), r = await h.first.verifyAuthentication(request(), h.assertion(first.challenge), key);
  assert.ok(r.verified);
  const second = await h.second.authenticationOptions(request(), key), s = await h.second.verifyAuthentication(request(), h.assertion(second.challenge, 2), key);
  assert.ok(s.verified); assert.ok(h.first.sessions.has(r.sessionToken));
  h.second.revoke(key, h.second.list(key)[0]!.id);
  assert.equal(h.first.sessions.has(r.sessionToken), false); assert.equal(s.isCurrent(), false);
});

test('denied revocation checks original transaction and preserves credentials, sessions and audit', async t => {
  const h = fixture(t), options = await h.first.authenticationOptions(request(), key);
  const result = await h.first.verifyAuthentication(request(), h.assertion(options.challenge), key);
  assert.ok(result.verified);
  const snapshot = () => JSON.stringify(['shared_auth_credentials', 'shared_auth_sessions', 'shared_auth_audit']
    .map(table => h.a.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
  const before = snapshot(), id = h.second.list(key)[0]!.id;
  let checks = 0;
  assert.equal(h.first.revoke(key, id, undefined, () => {
    checks++; assert.equal(h.a.isTransaction, true); return false;
  }), false);
  assert.equal(checks, 1); assert.equal(snapshot(), before);
  assert.equal(h.second.sessions.has(result.sessionToken), true);
  assert.throws(() => h.first.revoke(key, id, undefined, () => { throw Error('private-guard'); }), AuthPersistenceError);
  assert.equal(snapshot(), before); assert.equal(h.a.isTransaction, false);
  assert.equal(h.first.revoke(key, id, undefined, () => true), true);
  assert.equal(h.second.sessions.has(result.sessionToken), false);
});

test('async registration authorization is not a truthy grant and does not start the guard', async t => {
  const h = fixture(t), options = await h.first.registrationOptions(request(), key);
  let calls = 0;
  const check = async () => { calls++; return true; };
  const result = await h.second.verifyRegistration(request(), h.registration(options.challenge), {
    keyIdentityHash: key, isAuthorized: check as unknown as () => boolean,
  });
  assert.equal(result.verified, false); assert.equal(calls, 0); assert.equal(h.first.status(key).count, 1);
});

for (const operation of ['revoke', 'register'] as const) test(`SQLite auth ${operation} fences returned Promise authority and its late SQL`, async t => {
  const h = fixture(t), db = recoverableConnection(h.a), lines: string[] = [];
  const store = new SqlitePasskeys(db, () => key, () => 10_000, new PerformanceDiagnostics(line => lines.push(line)));
  db.exec('CREATE TABLE authority_effects(value INTEGER)'); const statement = db.prepare('INSERT INTO authority_effects VALUES(?)');
  const snapshot = () => JSON.stringify(['shared_auth_credentials', 'shared_auth_sessions', 'shared_auth_audit']
    .map(table => h.b.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
  const before = snapshot(); let release!: () => void, late!: Promise<boolean>, calls = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  const guard = (() => {
    calls++; statement.run(1);
    return late = (async () => { await held; statement.run(2); return false; })();
  }) as unknown as () => boolean;
  try {
    if (operation === 'revoke') assert.throws(() => store.revoke(key, store.list(key)[0]!.id, undefined, guard), AuthPersistenceError);
    else {
      const options = await store.registrationOptions(request(), key);
      await assert.rejects(store.verifyRegistration(request(), h.registration(options.challenge), {
        keyIdentityHash: key, isAuthorized: guard,
      }), AuthPersistenceError);
      // The durable one-shot claim remains consumed/claimed after failure;
      // closure or permission denial is never authorization to replay it.
      assert.equal(h.b.prepare('SELECT count(*) n FROM shared_auth_challenges WHERE claim IS NOT NULL').get()!.n, 1);
    }
    assert.equal(calls, 1); assert.equal(h.a.isTransaction, false); assert.equal(snapshot(), before);
    assert.deepEqual(h.b.prepare('SELECT * FROM authority_effects').all(), []);
    assert.equal(connectionRecoverySnapshot(db).state, 'close-required');
    const event = lines.map(line => JSON.parse(line)).find(event => event.unknown === 1);
    assert.ok(event); assert.equal(event.operation, 'auth-passkey-change'); assert.equal(event.step, 2);
    assert.ok(lines.every(line => !line.includes('authority_effects') && !line.includes('shared-auth-fixture')));
    const rejected = assert.rejects(late, StorageConnectionUnavailable); release(); await rejected;
    assert.equal(snapshot(), before); assert.deepEqual(h.b.prepare('SELECT * FROM authority_effects').all(), []);
  } finally { release(); if (late) await late.catch(() => {}); }
});

for (const rotate of [false, true]) test(`HTTP revoke preserves original Promise participant even when key rotation is ${rotate}`, async t => {
  const h = fixture(t), lines: string[] = [];
  const diagnostics = new PerformanceDiagnostics(line => lines.push(line));
  const db = recoverableConnection(h.a, diagnostics);
  const store = new SqlitePasskeys(db, () => key, () => 10_000, diagnostics);
  db.exec('CREATE TABLE route_authority_effects(value INTEGER)');
  const statement = db.prepare('INSERT INTO route_authority_effects VALUES(?)');
  const before = JSON.stringify(['shared_auth_credentials', 'shared_auth_sessions', 'shared_auth_audit']
    .map(table => h.b.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
  let calls = 0, release!: () => void, late: Promise<boolean> | undefined;
  const held = new Promise<void>(resolve => { release = resolve; });
  const deps = { accessKey: 'synthetic-key', passkeys: store, sessions: store.sessions, auditLog: new AuthAuditLog(),
    diagnostics, loginLimiter: new LoginAttemptLimiter({ maxFailures: 10, windowMs: 60_000, lockoutMs: 1000 }), lockoutSeconds: 1,
    isAuthorizedRequest: (() => {
      if (++calls === 1) return true; // Original route preflight, not a persistent grant.
      statement.run(1);
      if (rotate) deps.accessKey = 'rotated-key';
      late = held.then(() => { statement.run(2); return true; });
      void late.catch(() => {}); // Keep a failing red test isolated too.
      return late;
    }) as unknown as () => boolean };
  const app = new Hono(); registerAuthRoutes(app, deps);
  try {
    const response = await app.request(`/api/auth/passkeys/${store.list(key)[0]!.id}`, { method: 'DELETE' });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'auth_persistence_failed' });
    assert.equal(calls, 2); assert.equal(h.a.isTransaction, false);
    assert.equal(connectionRecoverySnapshot(db).state, 'close-required');
    assert.equal(JSON.stringify(['shared_auth_credentials', 'shared_auth_sessions', 'shared_auth_audit']
      .map(table => h.b.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())), before);
    assert.deepEqual(h.b.prepare('SELECT * FROM route_authority_effects').all(), []);
    assert.ok(late);
    const rejected = assert.rejects(late, StorageConnectionUnavailable); release(); await rejected;
    assert.ok(lines.map(line => JSON.parse(line)).some(event => event.operation === 'auth-passkey-change'
      && event.category === 'failed' && event.step === 2 && event.unknown === 1));
    assert.ok(lines.every(line => !/route_authority_effects|synthetic-key|rotated-key/.test(line)));
    // Stop the exact original writer and observer before reopening the same data.
    db.close(); h.b.close();
    const reopened = new DatabaseSync(h.file);
    try {
      assert.deepEqual(reopened.prepare('SELECT * FROM route_authority_effects').all(), []);
      assert.equal(new SqlitePasskeys(reopened, () => key, () => 10_000).status(key).count, 1);
      assert.throws(() => statement.run(3), StorageConnectionUnavailable);
    } finally { reopened.close(); }
  } finally { release(); if (late) await late.catch(() => {}); }
});

for (const mismatch of ['origin', 'key', 'clock'] as const) test(`mismatched ${mismatch} burns a challenge`, async t => {
  const h = fixture(t), options = await h.first.authenticationOptions(request(), key), proof = h.assertion(options.challenge);
  if (mismatch === 'clock') h.advance(-1);
  const r = await h.second.verifyAuthentication(mismatch === 'origin' ? new Request('https://other.example') : request(), proof, mismatch === 'key' ? 'wrong' : key);
  assert.equal(r.verified, false);
  if (mismatch === 'clock') h.advance(1);
  assert.equal((await h.first.verifyAuthentication(request(), proof, key)).verified, false);
});

test('administrator session has shared expiry/logout and never accepts passkey binding via add', t => {
  const h = fixture(t), token = createDeckSession();
  h.first.sessions.add(token); assert.ok(h.second.sessions.has(token));
  assert.equal(h.second.sessions.isAccessKeySession(token), true);
  assert.throws(() => h.second.sessions.add(createDeckSession(), { credentialHash: 'forged' }), AuthPersistenceError);
  assert.ok(h.second.sessions.delete(token)); assert.equal(h.first.sessions.has(token), false);
  const next = createDeckSession(); h.first.sessions.add(next); h.advance(30 * 86400_000);
  assert.equal(h.second.sessions.has(next), false);
});

test('separate OS process consumes parent challenge and parent sees atomic issuance', async t => {
  const h = fixture(t), options = await h.first.authenticationOptions(request(), key), proof = h.assertion(options.challenge);
  const source = `import { DatabaseSync } from 'node:sqlite';
    import { SqlitePasskeys } from ${JSON.stringify(new URL('./sqlite-passkeys.js', import.meta.url).href)};
    import { PerformanceDiagnostics } from ${JSON.stringify(new URL('../diagnostics/performance.js', import.meta.url).href)};
    const db = new DatabaseSync(process.argv[1]); db.exec('PRAGMA busy_timeout=1000');
    const manager = new SqlitePasskeys(db, () => ${JSON.stringify(key)}, () => 10000,
      new PerformanceDiagnostics(line => process.stderr.write(line + '\\n')));
    const result = await manager.verifyAuthentication(new Request(${JSON.stringify(origin)}), JSON.parse(process.argv[2]), ${JSON.stringify(key)});
    process.stdout.write(JSON.stringify(result)); db.close();`;
  const result = await new Promise<{ verified: boolean; sessionToken: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [...(import.meta.url.endsWith('.ts') ? ['--import', import.meta.resolve('tsx')] : []),
      '--input-type=module', '-e', source, h.file, JSON.stringify(proof)], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 });
    let text = ''; child.stdout.on('data', chunk => { text += chunk; }); child.stderr.resume();
    child.on('error', reject); child.on('close', code => {
      if (code !== 0) return reject(Error(`synthetic child failed: ${code}`));
      try { resolve(JSON.parse(text)); } catch (e) { reject(e); }
    });
  });
  assert.ok(result.verified); assert.ok(h.first.sessions.has(result.sessionToken));
  assert.equal((await h.second.verifyAuthentication(request(), proof, key)).verified, false);
});

test('HTTP login sets the already committed token; logout revokes it on another instance', async t => {
  const h = fixture(t), app = new Hono();
  registerAuthRoutes(app, { accessKey: 'synthetic-key', passkeys: h.second, sessions: h.second.sessions,
    isAuthorizedRequest: req => h.second.sessions.has(sessionTokenFromRequest(req) ?? ''),
    auditLog: new AuthAuditLog(), loginLimiter: new LoginAttemptLimiter({ maxFailures: 5, windowMs: 60000, lockoutMs: 60000 }), lockoutSeconds: 60 });
  const options = await h.first.authenticationOptions(request(), key);
  const res = await app.request(origin + '/api/auth/passkeys/login/verify', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(h.assertion(options.challenge)) });
  assert.equal(res.status, 200, await res.text());
  const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
  const token = sessionTokenFromRequest(new Request(origin, { headers: { cookie } })); assert.ok(token);
  assert.ok(h.first.sessions.has(token)); assert.equal(h.a.prepare('SELECT count(*) n FROM shared_auth_sessions').get()!.n, 1);
  const logout = await app.request(origin + '/api/auth/logout', { method: 'POST', headers: { origin, cookie } });
  assert.equal(logout.status, 200); assert.equal(h.first.sessions.has(token), false);
});

test('empty legacy import cannot repeat and explicit session invalidation is required', () => {
  const db = new DatabaseSync(':memory:');
  try { const manager = new SqlitePasskeys(db, () => key);
    assert.throws(() => manager.importLegacy([], false), AuthPersistenceError);
    manager.importLegacy([], true); assert.throws(() => manager.importLegacy([], true), AuthPersistenceError);
  } finally { db.close(); }
});

test('secure factory shares live sessions and preserves them on reopen', t => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-private-auth-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'auth.sqlite'), token = createDeckSession();
  const a = openSqliteAuth(file, [], () => key), b = openSqliteAuth(file, [], () => key);
  try { a.sessions.add(token); assert.ok(b.sessions.has(token)); } finally { a.close(); b.close(); }
  const c = openSqliteAuth(file, [], () => key); try { assert.ok(c.sessions.has(token)); } finally { c.close(); }
});

for (const afterEffect of [false, true]) test(`secure auth owner retains exact close recovery after lost ${afterEffect ? 'ACK' : 'effect'}`, t => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-auth-close-'));
  const store = openSqliteAuth(join(dir, 'auth.sqlite'), [], () => key), token = createDeckSession();
  store.sessions.add(token);
  const original = Error('private-auth-close-fault'), nativeClose = DatabaseSync.prototype.close;
  let closes = 0;
  const close = t.mock.method(DatabaseSync.prototype, 'close', function(this: DatabaseSync) {
    closes++;
    if (closes === 1 && !afterEffect) throw original;
    nativeClose.call(this);
    if (closes === 1 && afterEffect) throw original;
  });
  t.after(() => { close.mock.restore(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  assert.throws(() => store.close(), error => error === original);
  assert.equal(store.sessions.has(token), false, 'failed close cannot leave authentication admission live');
  store.close(); store.close();
  assert.equal(closes, afterEffect ? 1 : 2, 'only unresolved exact owner close is retried');
});

for (const invalid of ['legacy', 'symlink', 'hardlink', 'public-directory', 'public-file'] as const) test(`secure factory refuses ${invalid}`, t => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-invalid-auth-')), file = join(dir, 'auth.sqlite'), target = join(dir, 'target');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(target, '', { mode: 0o600 });
  if (invalid === 'symlink') symlinkSync(target, file);
  if (invalid === 'hardlink') linkSync(target, file);
  if (invalid === 'public-directory') chmodSync(dir, 0o755);
  if (invalid === 'public-file') { writeFileSync(file, ''); chmodSync(file, 0o644); }
  assert.throws(() => openSqliteAuth(file, invalid === 'legacy' ? [target] : [], () => key), AuthPersistenceError);
});

test('application opt-in uses shared auth without creating JSON and drains before close', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-auth-app-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = loadConfig({ HOME: dir, AOD_SERVER_ROLE: 'hub', AOD_ACCESS_KEY: 'synthetic-key',
    AOD_HUB_DATABASE_FILE: join(dir, 'hub.sqlite'), AOD_HUB_VAULT_SECRET: 'synthetic-vault',
    AOD_PASSKEYS_FILE: join(dir, 'old-passkeys.json'), AOD_AUTH_SESSIONS_FILE: join(dir, 'old-sessions.json'),
    AOD_AUTH_SQLITE_FILE: join(dir, 'auth.sqlite') });
  const a = createApplication(config);
  try {
    const login = await a.app.request(origin + '/api/auth/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ accessKey: 'synthetic-key' }) });
    assert.equal(login.status, 200, await login.text());
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const reader = openSqliteAuth(config.authSqliteFile!, [], () => key);
    try { assert.ok(reader.sessions.has(sessionTokenFromRequest(new Request(origin, { headers: { cookie } }))!)); } finally { reader.close(); }
  } finally { await a.close(); }
  assert.equal(loadConfig({ HOME: dir }).authSqliteFile, undefined);
});
