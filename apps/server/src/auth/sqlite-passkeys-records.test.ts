import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { SqlitePasskeys } from './sqlite-passkeys.js';
import { createDeckSession } from './passkeys.js';
import { AuthPersistenceError } from './private-store.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const key = 'a'.repeat(24), origin = 'https://hub.example';
const request = () => new Request(origin, { headers: { origin } });
function fixture(t: TestContext, sink?: (line: string) => void) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const lines: string[] = [];
  const diagnostics = new PerformanceDiagnostics(sink ?? (line => lines.push(line)));
  const owner = new SqlitePasskeys(db, () => key, () => 10_000, diagnostics);
  const credential = { id: 'Zml4dHVyZQ', publicKey: 'AQ', counter: 0, rpId: 'hub.example',
    createdAt: 1, label: 'fixture', keyIdentityHash: key };
  owner.importLegacy([credential], true);
  const snapshot = () => JSON.stringify(['shared_auth_credentials', 'shared_auth_challenges',
    'shared_auth_sessions', 'shared_auth_limits', 'shared_auth_audit'].map(table => db.prepare(`SELECT * FROM ${table}`).all()));
  return { db, owner, credential, lines, snapshot };
}
const suffix = '\0private-corruption';

for (const field of ['payload', 'id'] as const) test(`credential ${field} NUL suffix is refused without rewriting the row`, t => {
  const h = fixture(t);
  h.db.prepare(`UPDATE shared_auth_credentials SET ${field}=?`).run(
    (field === 'id' ? h.credential.id : JSON.stringify(h.credential)) + suffix);
  const before = h.snapshot();
  assert.throws(() => h.owner.status(key), AuthPersistenceError);
  assert.equal(h.snapshot(), before);
});

test('credential invalid UTF-8 inside JSON is not replaced before authorization', t => {
  const h = fixture(t), payload = Buffer.from(JSON.stringify({ ...h.credential, label: 'private-marker' }));
  payload[payload.indexOf('private-marker')] = 0xff;
  h.db.prepare('UPDATE shared_auth_credentials SET payload=CAST(? AS TEXT)').run(payload);
  const before = h.snapshot();
  assert.throws(() => h.owner.list(key), AuthPersistenceError);
  assert.equal(h.snapshot(), before);
});

test('credential BLOB storage is refused rather than coerced into JSON', t => {
  const h = fixture(t);
  h.db.prepare('UPDATE shared_auth_credentials SET payload=?').run(Buffer.from(JSON.stringify(h.credential)));
  assert.throws(() => h.owner.status(key), AuthPersistenceError);
});

for (const sqlType of ['TEXT', 'REAL'] as const) test(`credential ${sqlType} revision is not coerced to an integer`, t => {
  const h = fixture(t);
  // A deliberately noncanonical schema reproduces original SQL types without
  // INTEGER affinity silently converting the corrupt fixture back to INTEGER.
  h.db.exec(`ALTER TABLE shared_auth_credentials RENAME TO original_credentials;
    CREATE TABLE shared_auth_credentials(id TEXT PRIMARY KEY,payload TEXT NOT NULL,version);
    INSERT INTO shared_auth_credentials SELECT id,payload,CAST(version AS ${sqlType}) FROM original_credentials;`);
  assert.equal(h.db.prepare('SELECT typeof(version) kind FROM shared_auth_credentials').get()!.kind, sqlType.toLowerCase());
  const before = h.snapshot();
  assert.throws(() => h.owner.status(key), AuthPersistenceError);
  assert.equal(h.snapshot(), before);
});

test('valid credential Unicode remains exact and does not produce corruption logs', t => {
  const h = fixture(t);
  h.db.prepare('UPDATE shared_auth_credentials SET payload=?').run(JSON.stringify({ ...h.credential, label: '通行密钥🔑' }));
  assert.equal(h.owner.list(key)[0]!.label, '通行密钥🔑');
  assert.equal(h.lines.some(line => JSON.parse(line).operation === 'auth-passkey-read'), false);
});

test('corruption logs identify credential and challenge read phases without damaged bytes', async t => {
  const h = fixture(t), options = await h.owner.authenticationOptions(request(), key);
  h.db.prepare('UPDATE shared_auth_credentials SET payload=?').run('{private-credential');
  assert.throws(() => h.owner.status(key), AuthPersistenceError);
  h.db.prepare('UPDATE shared_auth_challenges SET payload=?').run('{private-challenge');
  const response = { response: { clientDataJSON: Buffer.from(JSON.stringify({ challenge: options.challenge })).toString('base64url') } } as AuthenticationResponseJSON;
  await assert.rejects(h.owner.verifyAuthentication(request(), response, key), AuthPersistenceError);
  const logs = h.lines.map(line => JSON.parse(line)).filter(event => event.operation === 'auth-passkey-read');
  assert.deepEqual(logs.map(event => event.step), [1, 2]);
  assert.ok(logs.every(event => event.category === 'failed'));
  assert.equal(JSON.stringify(logs).includes('private-'), false);
});

for (const accessKey of [true, false]) test(`NUL-suffixed ${accessKey ? 'administrator' : 'passkey'} session cannot authorize`, t => {
  const h = fixture(t), token = createDeckSession();
  h.owner.addAdministratorSession(token);
  const binding = { keyIdentityHash: key, ...(accessKey ? {} : { credentialHash: h.owner.list(key)[0]!.id }) };
  h.db.prepare('UPDATE shared_auth_sessions SET binding=?').run(JSON.stringify(binding) + suffix);
  const before = h.snapshot();
  assert.equal(h.owner.sessions.has(token), false);
  assert.equal(h.owner.isAccessKeySession(token), false);
  assert.equal(h.snapshot(), before);
});

test('session BLOB and malformed UTF-8 are refused, while a valid original binding still works', t => {
  const h = fixture(t), token = createDeckSession();
  h.owner.addAdministratorSession(token);
  const binding = JSON.stringify({ keyIdentityHash: key });
  h.db.prepare('UPDATE shared_auth_sessions SET binding=?').run(Buffer.from(binding));
  assert.equal(h.owner.sessions.has(token), false);
  h.db.prepare('UPDATE shared_auth_sessions SET binding=CAST(? AS TEXT)').run(Buffer.concat([Buffer.from(binding), Buffer.from([0xff])]));
  assert.equal(h.owner.sessions.has(token), false);
  h.db.prepare('UPDATE shared_auth_sessions SET binding=?').run(binding);
  assert.equal(h.owner.sessions.has(token), true);
});

test('session raw-byte bound accepts exactly 512 bytes, refuses oversized rows without repair', t => {
  const h = fixture(t), token = createDeckSession();
  h.owner.addAdministratorSession(token);
  const binding = JSON.stringify({ keyIdentityHash: key });
  const bytes = binding + ' '.repeat(512 - Buffer.byteLength(binding));
  h.db.prepare('UPDATE shared_auth_sessions SET binding=?').run(bytes);
  assert.equal(h.owner.sessions.has(token), true);
  h.db.prepare('UPDATE shared_auth_sessions SET binding=?').run(bytes + ' ');
  const before = h.snapshot();
  assert.equal(h.owner.sessions.has(token), false);
  assert.equal(h.snapshot(), before);
});

test('malformed binding logs refusal but an ordinarily expired session does not log corruption', t => {
  const h = fixture(t), token = createDeckSession();
  h.owner.addAdministratorSession(token);
  h.db.prepare('UPDATE shared_auth_sessions SET binding=?').run('null');
  assert.equal(h.owner.sessions.has(token), false);
  const observed = () => h.lines.map(line => JSON.parse(line)).filter(event => event.operation === 'auth-passkey-read');
  assert.equal(observed().length, 1);
  h.db.prepare('UPDATE shared_auth_sessions SET binding=?,expires=?').run(JSON.stringify({ keyIdentityHash: key }), 9_999);
  assert.equal(h.owner.sessions.has(token), false);
  assert.equal(observed().length, 1);
});

for (const defect of ['NUL suffix', 'wrong challenge', 'timestamp string', 'wrong expiry', 'BLOB', 'invalid UTF-8'] as const) {
  test(`challenge ${defect} is refused before claiming, consuming or charging the verification limit`, async t => {
    const h = fixture(t), options = await h.owner.authenticationOptions(request(), key);
    const row = h.db.prepare('SELECT payload FROM shared_auth_challenges').get()!;
    const meta = JSON.parse(String(row.payload));
    if (defect === 'wrong challenge') meta.challenge = createDeckSession();
    if (defect === 'timestamp string') meta.at = String(meta.at);
    const encoded = JSON.stringify(meta);
    if (defect === 'wrong expiry') h.db.exec('UPDATE shared_auth_challenges SET expires=expires+1');
    else if (defect === 'invalid UTF-8') {
      const bytes = Buffer.from(encoded); bytes[bytes.indexOf('hub.example')] = 0xff;
      h.db.prepare('UPDATE shared_auth_challenges SET payload=CAST(? AS TEXT)').run(bytes);
    } else h.db.prepare('UPDATE shared_auth_challenges SET payload=?').run(
      defect === 'BLOB' ? Buffer.from(encoded) : encoded + (defect === 'NUL suffix' ? suffix : ''));
    const before = h.snapshot();
    const response = { response: { clientDataJSON: Buffer.from(JSON.stringify({ challenge: options.challenge })).toString('base64url') } } as AuthenticationResponseJSON;
    await assert.rejects(h.owner.verifyAuthentication(request(), response, key), AuthPersistenceError);
    assert.equal(h.snapshot(), before);
  });
}

test('session corruption log is fixed numeric evidence, never token, SQL or damaged JSON', t => {
  const h = fixture(t), token = createDeckSession();
  h.owner.addAdministratorSession(token);
  h.db.prepare('UPDATE shared_auth_sessions SET binding=?').run(JSON.stringify({ keyIdentityHash: key }) + suffix);
  assert.equal(h.owner.sessions.has(token), false);
  const logs = h.lines.map(line => JSON.parse(line)).filter(event => event.operation === 'auth-passkey-read');
  assert.equal(logs.length, 1);
  assert.equal(logs[0].category, 'failed');
  assert.equal(logs[0].step, 3);
  for (const privateValue of [token, createHash('sha256').update(token).digest('hex'), key, 'private-corruption', 'SELECT'])
    assert.equal(JSON.stringify(logs).includes(privateValue), false);
});

test('throwing corruption log sink cannot grant a damaged session or change the original row', t => {
  const h = fixture(t, () => { throw Error('private-sink'); }), token = createDeckSession();
  h.owner.addAdministratorSession(token);
  h.db.prepare('UPDATE shared_auth_sessions SET binding=?').run(JSON.stringify({ keyIdentityHash: key }) + suffix);
  const before = h.snapshot();
  assert.equal(h.owner.sessions.has(token), false);
  assert.equal(h.snapshot(), before);
});
