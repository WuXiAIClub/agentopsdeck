import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Hono } from 'hono';
import { writePrivateAuthStore, AuthPersistenceError, PrivateAuthStoreGuard } from './private-store.js';
import { PersistentDeckSessionSet, PasskeyManager } from './passkeys.js';
import { AuthAuditLog, LoginAttemptLimiter } from './security.js';
import { registerAuthRoutes } from '../routes/auth.js';
import { credentialHashForAudit } from './security.js';

test('stale session owner denies authorization and cannot resurrect a revoked session', t => {
  const { file } = fixture(t), token = 'synthetic-session-123456';
  const first = new PersistentDeckSessionSet(file);
  first.add(token);
  const second = new PersistentDeckSessionSet(file);
  second.delete(token);
  const bytes = fs.readFileSync(file, 'utf8');
  assert.equal(first.has(token), false);
  for (const operation of [() => first.add(token), () => first.delete('missing'), () => first.clear()]) {
    assert.throws(operation, AuthPersistenceError);
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  }
  assert.equal(new PersistentDeckSessionSet(file).has(token), false);
});

test('a separate process revocation invalidates the parent owner without overwriting disk', t => {
  const { file } = fixture(t), token = 'synthetic-session-process-123456';
  const owner = new PersistentDeckSessionSet(file); owner.add(token);
  const source = import.meta.url.endsWith('.ts');
  execFileSync(process.execPath, [...(source ? ['--import', new URL('../../node_modules/tsx/dist/loader.mjs', import.meta.url).pathname] : []),
    '--input-type=module', '-e', `import {PersistentDeckSessionSet} from ${JSON.stringify(new URL(source ? './passkeys.ts' : './passkeys.js', import.meta.url).href)}; new PersistentDeckSessionSet(process.argv[1]).clear();`, file]);
  assert.equal(owner.has(token), false);
  assert.throws(() => owner.add('another-synthetic-123456'), AuthPersistenceError);
  assert.deepEqual([...new PersistentDeckSessionSet(file)], []);
});

test('competing and crash locks are not stolen, and owner can retry after explicit release', t => {
  const { file } = fixture(t), guard = new PrivateAuthStoreGuard(file), lock = `${file}.writer-lock`;
  fs.mkdirSync(lock, { mode: 0o700 });
  assert.throws(() => guard.write({ sessions: [] }), AuthPersistenceError);
  assert.equal(fs.existsSync(file), false); assert.equal(fs.existsSync(lock), true);
  fs.rmdirSync(lock);
  guard.write({ sessions: [] });
  assert.equal(guard.current(), true); assert.equal(fs.existsSync(lock), false);
});

test('invalid roots and JSON fail startup without erasing the damaged store', t => {
  const { file } = fixture(t);
  for (const text of ['{broken', 'null', '[]', '{}', '{"sessions":{},"credentials":{}}']) {
    fs.writeFileSync(file, text);
    assert.throws(() => new PersistentDeckSessionSet(file), AuthPersistenceError);
    assert.throws(() => new PasskeyManager(file), AuthPersistenceError);
    assert.equal(fs.readFileSync(file, 'utf8'), text);
  }
});

test('ambiguous credential IDs fail startup regardless of revocation order without rewriting evidence', t => {
  const { file } = fixture(t);
  const active = { id: 'c3ludGhldGlj', publicKey: 'ZmFrZQ', counter: 0, label: 'fixture', createdAt: 1, rpId: 'hub.example' };
  const revoked = { ...active, revokedAt: 2 };
  for (const credentials of [[active, active], [active, revoked], [revoked, active]]) {
    const text = JSON.stringify({ credentials }); fs.writeFileSync(file, text);
    assert.throws(() => new PasskeyManager(file), AuthPersistenceError);
    assert.equal(fs.readFileSync(file, 'utf8'), text);
  }
});

test('invalid credential entries and counters cannot be silently discarded on the next mutation', t => {
  const { file } = fixture(t);
  const active = { id: 'c3ludGhldGlj', publicKey: 'ZmFrZQ', counter: 0, label: 'fixture', createdAt: 1, rpId: 'hub.example' };
  for (const invalid of [null, {}, { ...active, id: '' }, { ...active, publicKey: '' }, { ...active, rpId: '' },
    ...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1].map(counter => ({ ...active, counter }))]) {
    const text = JSON.stringify({ credentials: [active, invalid] }); fs.writeFileSync(file, text);
    assert.throws(() => new PasskeyManager(file), AuthPersistenceError);
    assert.equal(fs.readFileSync(file, 'utf8'), text);
  }
  const overflow = '{"credentials":[{"id":"fixture","publicKey":"fixture","counter":1e309,"rpId":"hub.example"}]}';
  fs.writeFileSync(file, overflow);
  assert.throws(() => new PasskeyManager(file), AuthPersistenceError);
  assert.equal(fs.readFileSync(file, 'utf8'), overflow);
});

test('unique credentials preserve revocations and support zero or positive integral counters across reopen', t => {
  const { file } = fixture(t);
  const active = { id: 'c3ludGhldGlj', publicKey: 'ZmFrZQ', counter: 0, label: 'fixture', createdAt: 1, rpId: 'hub.example' };
  const revoked = { ...active, id: 'cmV2b2tlZA', counter: 42, revokedAt: 2 };
  fs.writeFileSync(file, JSON.stringify({ credentials: [active, revoked] }));
  const owner = new PasskeyManager(file);
  assert.equal(owner.isCredentialCurrent(credentialHashForAudit(active.id)), true);
  assert.equal(owner.isCredentialCurrent(credentialHashForAudit(revoked.id)), false);
  assert.equal(owner.revoke(undefined, credentialHashForAudit(active.id), 3), true);
  assert.equal(new PasskeyManager(file).status().count, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).credentials, [{ ...active, revokedAt: 3 }, revoked]);
});

test('replacement, deletion and symlinks invalidate an existing owner', t => {
  const { file, dir } = fixture(t), token = 'synthetic-session-replaced-123456';
  const owner = new PersistentDeckSessionSet(file); owner.add(token);
  const bytes = fs.readFileSync(file);
  fs.unlinkSync(file);
  assert.equal(owner.has(token), false);
  fs.writeFileSync(join(dir, 'replacement'), bytes);
  fs.renameSync(join(dir, 'replacement'), file);
  assert.equal(owner.has(token), false, 'same bytes do not restore ownership');
  fs.renameSync(file, join(dir, 'target'));
  fs.symlinkSync(join(dir, 'target'), file);
  assert.throws(() => new PersistentDeckSessionSet(file), AuthPersistenceError);
  assert.throws(() => owner.add(token), AuthPersistenceError);
  assert.deepEqual(fs.readFileSync(join(dir, 'target')), bytes);
});

test('stale passkey owner denies options and cannot overwrite another owner revocation', async t => {
  const { file } = fixture(t), credential = { id: 'c3ludGhldGlj', publicKey: 'ZmFrZQ', counter: 0, label: 'fixture', createdAt: 1, rpId: 'hub.example' };
  fs.writeFileSync(file, JSON.stringify({ credentials: [credential] }));
  const first = new PasskeyManager(file), second = new PasskeyManager(file), id = credentialHashForAudit(credential.id);
  second.revoke(undefined, id);
  const bytes = fs.readFileSync(file, 'utf8');
  assert.equal(first.isCredentialCurrent(id), false);
  assert.deepEqual(first.list(), []);
  assert.throws(() => first.revoke(undefined, id), AuthPersistenceError);
  const request = new Request('https://hub.example/api/auth', { headers: { origin: 'https://hub.example' } });
  await assert.rejects(first.registrationOptions(request), AuthPersistenceError);
  await assert.rejects(first.authenticationOptions(request), AuthPersistenceError);
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
});

function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'agentopsdeck-private-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, file: join(dir, 'auth.json') };
}

function failWrite(t: TestContext, phase: 'write' | 'flush' | 'rename') {
  const write = fs.writeFileSync;
  const method = phase === 'write' ? 'writeFileSync' : phase === 'flush' ? 'fsyncSync' : 'renameSync';
  const mocked = t.mock.method(fs, method, (...args: unknown[]) => {
    if (phase === 'write') write(args[0] as number, 'partial private content');
    throw Object.assign(new Error('ENOSPC private filesystem path'), { code: 'ENOSPC' });
  });
  syncBuiltinESMExports();
  const restore = () => { mocked.mock.restore(); syncBuiltinESMExports(); };
  t.after(restore);
  return restore;
}

test('atomic private storage replaces old contents with owner-only permissions', t => {
  const h = fixture(t);
  fs.writeFileSync(h.file, 'old', { mode: 0o644 });
  writePrivateAuthStore(h.file, { value: 'new' });
  assert.deepEqual(JSON.parse(fs.readFileSync(h.file, 'utf8')), { value: 'new' });
  assert.equal(fs.statSync(h.file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(h.dir), ['auth.json']);
});

for (const phase of ['write', 'flush', 'rename'] as const) test(`failed ${phase} leaves original bytes intact and cleans temporary private data`, t => {
  const h = fixture(t);
  const original = '{"value":"original"}\n';
  fs.writeFileSync(h.file, original);
  failWrite(t, phase);
  assert.throws(() => writePrivateAuthStore(h.file, { value: 'replacement' }), error => {
    assert.ok(error instanceof AuthPersistenceError);
    assert.equal(error.message, 'auth_persistence_failed');
    assert.equal('cause' in error, false, 'no sensitive filesystem error exposed');
    return true;
  });
  assert.equal(fs.readFileSync(h.file, 'utf8'), original);
  assert.deepEqual(fs.readdirSync(h.dir), ['auth.json']);
});

test('persistent sessions add/delete/clear survive reload and failed mutations publish no memory changes', t => {
  const h = fixture(t);
  const sessions = new PersistentDeckSessionSet(h.file);
  const first = 'test-session-first-123456', second = 'test-session-second-123456';
  sessions.add(first);
  assert.equal(new PersistentDeckSessionSet(h.file).has(first), true);
  const restore = failWrite(t, 'write');
  assert.throws(() => sessions.add(second), AuthPersistenceError);
  assert.equal(sessions.has(second), false);
  assert.throws(() => sessions.delete(first), AuthPersistenceError);
  assert.throws(() => sessions.clear(), AuthPersistenceError);
  assert.deepEqual([...sessions], [first]);
  assert.deepEqual([...new PersistentDeckSessionSet(h.file)], [first]);
  assert.equal(sessions.add(first), sessions, 'duplicate add has no write');
  assert.equal(sessions.delete(second), false, 'missing delete has no write');
  restore();
  sessions.add(second);
  assert.equal(sessions.delete(first), true);
  assert.deepEqual([...new PersistentDeckSessionSet(h.file)], [second]);
  sessions.clear();
  assert.equal(sessions.size, 0);
  assert.equal(new PersistentDeckSessionSet(h.file).size, 0);
});

test('bound sessions revalidate on every check and survive reload without downgrading or resurrecting revoked credentials', t => {
  const h = fixture(t), binding = { credentialHash: 'a'.repeat(24), keyIdentityHash: 'b'.repeat(24) };
  const token = 'bound-test-session-123456', legacy = 'legacy-test-session-123456';
  let current = true;
  const sessions = new PersistentDeckSessionSet(h.file, value => current && value.credentialHash === binding.credentialHash && value.keyIdentityHash === binding.keyIdentityHash);
  sessions.add(token, binding); sessions.add(legacy);
  assert.equal(sessions.has(token), true);
  assert.equal(sessions.isAccessKeySession(legacy), true);
  assert.equal(new PersistentDeckSessionSet(h.file).has(token), false, 'missing authority validator fails closed');
  assert.equal(new PersistentDeckSessionSet(h.file, () => true).has(token), true);
  assert.equal(new PersistentDeckSessionSet(h.file, () => true).isAccessKeySession(token), false, 'valid passkey is not a Key login');
  assert.equal(new PersistentDeckSessionSet(h.file, () => false).isAccessKeySession(token), false, 'revoked passkey never downgrades to Key login');
  const stored = JSON.parse(fs.readFileSync(h.file,'utf8')).sessions;
  assert.deepEqual(stored, [{token,...binding},legacy]);
  current = false;
  assert.equal(sessions.has(token), false); assert.equal(sessions.has(legacy), true);
  sessions.add(token); assert.equal(sessions.has(token), false,'ordinary add never downgrades an existing bound record');
  assert.equal(new PersistentDeckSessionSet(h.file, () => false).has(token), false);
  assert.equal(sessions.delete(token), true,'revoked tokens remain explicitly removable');
  assert.deepEqual(JSON.parse(fs.readFileSync(h.file,'utf8')).sessions,[legacy]);
});

test('malformed and duplicate bound sessions cannot be loaded as legacy tokens', t => {
  const h = fixture(t), token = 'malformed-test-session-123456';
  for (const entries of [[{token}], [{token,credentialHash:'invalid'}], [token,{token,credentialHash:'a'.repeat(24)}], [{token,credentialHash:'a'.repeat(24)},token,token]]) {
    fs.writeFileSync(h.file,JSON.stringify({sessions:entries}));
    assert.equal(new PersistentDeckSessionSet(h.file,()=>true).has(token),false);
  }
});

test('failed bound-session writes preserve both binding authority and file bytes', t => {
  const h = fixture(t), token = 'bound-test-session-123456', other = 'other-test-session-123456';
  const binding = {credentialHash:'a'.repeat(24)};
  const sessions = new PersistentDeckSessionSet(h.file,()=>true); sessions.add(token,binding);
  const before = fs.readFileSync(h.file,'utf8');
  failWrite(t,'rename');
  assert.throws(()=>sessions.add(other,binding),AuthPersistenceError);
  assert.equal(sessions.has(other),false); assert.equal(sessions.has(token),true);
  assert.throws(()=>sessions.delete(token),AuthPersistenceError);
  assert.equal(sessions.has(token),true); assert.equal(fs.readFileSync(h.file,'utf8'),before);
});

test('login and logout report persistence failure without issuing or clearing cookies; recovery works', async t => {
  const h = fixture(t);
  const sessions = new PersistentDeckSessionSet(h.file);
  const token = 'test-session-existing-123456';
  sessions.add(token);
  const auditLog = new AuthAuditLog();
  const app = new Hono();
  registerAuthRoutes(app, { accessKey: 'fixture-access-key', sessions, passkeys: new PasskeyManager(join(h.dir, 'keys.json')),
    isAuthorizedRequest: () => true, auditLog,
    loginLimiter: new LoginAttemptLimiter({ maxFailures: 5, windowMs: 60_000, lockoutMs: 30_000 }), lockoutSeconds: 30 });
  const restore = failWrite(t, 'write');
  const login = () => app.request('https://hub.example/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accessKey: 'fixture-access-key' }) });
  const logout = () => app.request('https://hub.example/api/auth/logout', { method: 'POST', headers: { cookie: 'agentopsdeck_session=' + token } });
  for (const request of [login, logout]) {
    const result = await request();
    assert.equal(result.status, 503);
    assert.equal(result.headers.get('set-cookie'), null);
    assert.deepEqual(await result.json(), { error: 'auth_persistence_failed' });
    assert.deepEqual([...sessions], [token]);
    assert.deepEqual([...new PersistentDeckSessionSet(h.file)], [token]);
    assert.equal(auditLog.list().length, 0);
  }
  restore();
  assert.equal((await logout()).status, 200);
  assert.equal(new PersistentDeckSessionSet(h.file).size, 0);
  const success = await login();
  assert.equal(success.status, 200);
  assert.match(success.headers.get('set-cookie')!, /agentopsdeck_session=/);
  assert.equal(new PersistentDeckSessionSet(h.file).size, 1);
});
