import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { initializeSqliteAuthSchema } from './sqlite-schema.js';
import { SqlitePasskeys } from './sqlite-passkeys.js';
import { createDeckSession } from './passkeys.js';
import { credentialHashForAudit, keyIdentityHash } from './security.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { connectionRecoverySnapshot } from '../storage/connection-recovery.js';

// Frozen pre-index schema, intentionally independent of the current initializer.
const legacy = `CREATE TABLE shared_auth_credentials(id TEXT PRIMARY KEY,payload TEXT NOT NULL,version INTEGER NOT NULL);
  CREATE TABLE shared_auth_challenges(digest TEXT PRIMARY KEY,kind TEXT NOT NULL,payload TEXT NOT NULL,expires INTEGER NOT NULL,claim TEXT);
  CREATE TABLE shared_auth_sessions(digest TEXT PRIMARY KEY,binding TEXT NOT NULL,expires INTEGER NOT NULL);
  CREATE TABLE shared_auth_audit(seq INTEGER PRIMARY KEY,kind TEXT NOT NULL,identity TEXT NOT NULL,at INTEGER NOT NULL);
  CREATE TABLE shared_auth_limits(id INTEGER PRIMARY KEY CHECK(id=1),window INTEGER NOT NULL,count INTEGER NOT NULL,observed INTEGER NOT NULL);`;
const indexes = ['shared_auth_challenges_expires', 'shared_auth_challenges_kind_expires', 'shared_auth_sessions_expires'];
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const key = keyIdentityHash('synthetic-index-key'), now = 1000;
const silent = () => new PerformanceDiagnostics(() => {});
const indexNames = (db: DatabaseSync) => db.prepare("SELECT name FROM sqlite_schema WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all().map(row => row.name);
const schema = (db: DatabaseSync) => JSON.stringify(db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all());
function snapshot(db: DatabaseSync) {
  return JSON.stringify([
    db.prepare('SELECT hex(CAST(id AS BLOB)) id,hex(CAST(payload AS BLOB)) payload,version FROM shared_auth_credentials ORDER BY rowid').all(),
    db.prepare('SELECT digest,kind,hex(CAST(payload AS BLOB)) payload,expires,claim FROM shared_auth_challenges ORDER BY rowid').all(),
    db.prepare('SELECT digest,hex(CAST(binding AS BLOB)) binding,expires FROM shared_auth_sessions ORDER BY rowid').all(),
    db.prepare('SELECT * FROM shared_auth_audit ORDER BY seq').all(),
    db.prepare('SELECT * FROM shared_auth_limits ORDER BY id').all(),
  ]);
}
function seed(db: DatabaseSync) {
  const credential = { id: 'b2xkLWNyZWRlbnRpYWw', publicKey: 'AQID', counter: 7,
    rpId: 'hub.example', keyIdentityHash: key, createdAt: 1, label: '旧凭据' };
  db.prepare('INSERT INTO shared_auth_credentials VALUES(?,?,?)').run(credential.id, JSON.stringify(credential, null, 2), 11);
  const revoked = { ...credential, id: 'cmV2b2tlZC1jcmVkZW50aWFs', revokedAt: 900 };
  db.prepare('INSERT INTO shared_auth_credentials VALUES(?,?,?)').run(revoked.id, JSON.stringify(revoked), 12);
  const administrator = createDeckSession(), passkey = createDeckSession(), revokedSession = createDeckSession();
  const insert = db.prepare('INSERT INTO shared_auth_sessions VALUES(?,?,?)');
  insert.run(hash(administrator), ` { "keyIdentityHash": "${key}" } `, now + 30 * 86400_000);
  insert.run(hash(passkey), JSON.stringify({ keyIdentityHash: key, credentialHash: credentialHashForAudit(credential.id) }), now + 30 * 86400_000);
  insert.run(hash(revokedSession), JSON.stringify({ keyIdentityHash: key, credentialHash: credentialHashForAudit(revoked.id) }), now + 30 * 86400_000);
  insert.run('expired', '{}', now - 1);
  // Scalar indexes must not parse/rewrite unrelated legacy JSON, NUL or UTF-8.
  db.prepare('INSERT INTO shared_auth_sessions VALUES(?,CAST(? AS TEXT),?)')
    .run('damaged-unrelated-binding', Buffer.from([0x7b, 0x00, 0xff]), now + 2000);
  db.prepare('INSERT INTO shared_auth_challenges VALUES(?,?,?,?,?)').run('old-challenge', 'authenticate', '{ old unchanged payload }', now - 1, 'old-claim');
  db.prepare('INSERT INTO shared_auth_audit VALUES(?,?,?,?)').run(17, 'legacy-fixture', 'opaque', 900);
  db.prepare('INSERT INTO shared_auth_limits VALUES(1,?,?,?)').run(900, 4, 1000);
  return { administrator, passkey, revokedSession };
}

test('disk-backed pre-index database reopens twice without rewriting rows or invalidating old sessions', t => {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-auth-index-目录-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'auth.sqlite');
  let db = new DatabaseSync(file);
  try {
    db.exec(legacy); const tokens = seed(db), before = snapshot(db);
    db.close(); db = new DatabaseSync(file);
    for (let round = 0; round < 2; round++) {
      const passkeys = new SqlitePasskeys(db, () => key, () => now, silent());
      assert.equal(snapshot(db), before);
      assert.deepEqual(indexNames(db), indexes);
      assert.equal(passkeys.sessions.has(tokens.administrator), true);
      assert.equal(passkeys.sessions.isAccessKeySession(tokens.administrator), true);
      assert.equal(passkeys.sessions.has(tokens.passkey), true);
      assert.equal(passkeys.sessions.isAccessKeySession(tokens.passkey), false);
      assert.equal(passkeys.sessions.has(tokens.revokedSession), false);
      assert.equal(passkeys.list(key).length, 1);
      assert.equal(snapshot(db), before);
      assert.equal(db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
      const stable = schema(db);
      initializeSqliteAuthSchema(db, silent()); assert.equal(schema(db), stable);
      db.close(); db = new DatabaseSync(file);
    }
  } finally { db.close(); }
});

test('expiry cleanup and challenge capacity use scalar search indexes, while authority stays primary-key based', () => {
  const db = new DatabaseSync(':memory:');
  try {
    initializeSqliteAuthSchema(db, silent());
    const plan = (sql: string, ...parameters: (string | number)[]) => db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...parameters)
      .map(row => String(row.detail)).join('\n');
    assert.match(plan('DELETE FROM shared_auth_sessions WHERE expires<=?', now), /SEARCH shared_auth_sessions USING INDEX shared_auth_sessions_expires/);
    assert.match(plan('DELETE FROM shared_auth_challenges WHERE expires<=?', now), /SEARCH shared_auth_challenges USING INDEX shared_auth_challenges_expires/);
    assert.match(plan('SELECT count(*) n FROM shared_auth_challenges WHERE kind=?', 'authenticate'), /SEARCH shared_auth_challenges USING COVERING INDEX shared_auth_challenges_kind_expires/);
    assert.match(plan('SELECT count(*) n FROM shared_auth_challenges WHERE claim IS NOT NULL AND expires>?', now), /SEARCH shared_auth_challenges USING INDEX shared_auth_challenges_expires/);
    assert.match(plan('SELECT binding,expires FROM shared_auth_sessions WHERE digest=?', 'digest'), /SEARCH shared_auth_sessions USING INDEX sqlite_autoindex_shared_auth_sessions_1/);
    assert.deepEqual(db.prepare('PRAGMA index_info(shared_auth_challenges_kind_expires)').all().map(row => row.name), ['kind', 'expires']);
    assert.deepEqual(db.prepare('PRAGMA index_info(shared_auth_sessions_expires)').all().map(row => row.name), ['expires']);
  } finally { db.close(); }
});

for (const nested of [false, true]) test(`index DDL failure rolls back the entire original upgrade, nested=${nested}`, () => {
  const db = new DatabaseSync(':memory:');
  const lines: string[] = [], diagnostics = new PerformanceDiagnostics(line => lines.push(line));
  try {
    db.exec(legacy); seed(db);
    // A real schema collision fails after the preceding two CREATE INDEXs.
    db.exec('CREATE TABLE shared_auth_sessions_expires(private_note TEXT); CREATE TABLE caller_data(id INTEGER)');
    if (nested) db.exec('BEGIN IMMEDIATE; INSERT INTO caller_data VALUES(7)');
    const before = snapshot(db), oldSchema = schema(db);
    assert.throws(() => initializeSqliteAuthSchema(db, diagnostics));
    assert.equal(snapshot(db), before); assert.equal(schema(db), oldSchema);
    assert.deepEqual(indexNames(db), []);
    assert.equal(db.isTransaction, nested);
    assert.equal(connectionRecoverySnapshot(db).state, 'ready');
    if (nested) {
      assert.equal(db.prepare('SELECT id FROM caller_data').get()!.id, 7);
      db.exec('ROLLBACK');
      assert.equal(db.prepare('SELECT count(*) n FROM caller_data').get()!.n, 0);
    }
    const event = lines.map(line => JSON.parse(line)).find(event => event.operation === 'auth-passkey-schema');
    assert.ok(event); assert.equal(event.category, 'failed'); assert.equal(event.step, 2);
    assert.equal(event.nested, Number(nested));
    assert.doesNotMatch(lines.join('\n'), /private_note|old-challenge|damaged|synthetic-index-key|旧凭据|sqlite_master|CREATE INDEX/);
    db.exec('DROP TABLE shared_auth_sessions_expires');
    initializeSqliteAuthSchema(db, silent()); assert.deepEqual(indexNames(db), indexes);
    assert.equal(snapshot(db), before);
  } finally { db.close(); }
});

test('fresh-schema DDL failure leaves no half-created authentication tables', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE shared_auth_sessions_expires(id INTEGER)');
    const before = schema(db);
    assert.throws(() => initializeSqliteAuthSchema(db, silent()));
    assert.equal(schema(db), before); assert.equal(db.isTransaction, false);
  } finally { db.close(); }
});

test('successful nested initialization never commits or rolls back the caller transaction', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE caller_data(id INTEGER); BEGIN IMMEDIATE; INSERT INTO caller_data VALUES(42)');
    initializeSqliteAuthSchema(db, silent());
    assert.equal(db.isTransaction, true); assert.deepEqual(indexNames(db), indexes);
    db.exec('ROLLBACK');
    assert.equal(db.prepare('SELECT count(*) n FROM caller_data').get()!.n, 0);
    assert.equal(db.prepare("SELECT count(*) n FROM sqlite_schema WHERE name LIKE 'shared_auth_%'").get()!.n, 0);
  } finally { db.close(); }
});

test('throwing diagnostics cannot prevent or turn successful original DDL into a retry', () => {
  const db = new DatabaseSync(':memory:');
  const diagnostics = new PerformanceDiagnostics(() => { throw Error('private diagnostic'); }, () => { throw Error('private clock'); });
  try {
    initializeSqliteAuthSchema(db, diagnostics);
    assert.deepEqual(indexNames(db), indexes); assert.equal(db.isTransaction, false);
    assert.equal(connectionRecoverySnapshot(db).state, 'ready');
  } finally { db.close(); }
});
