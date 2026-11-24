import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { PersistentLoginAttemptLimiter } from './persistent-login-limiter.js';
import { LoginAttemptLimiter } from './security.js';

const options = { maxFailures: 2, windowMs: 1_000, lockoutMs: 2_000, maxBuckets: 2 };
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-login-persistence-'));
  const path = join(directory, 'auth.sqlite');
  const connections: DatabaseSync[] = [];
  return { path, open() { const db = new DatabaseSync(path); connections.push(db); return db; },
    close() { for (const db of connections) if (db.isOpen) db.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('failures, bans and overflow survive restart without storing original subjects', () => {
  const f = fixture();
  let now = 10_000;
  try {
    let db = f.open();
    let limiter = new PersistentLoginAttemptLimiter(db, { ...options, now: () => now });
    for (const subject of ['raw-address-a', 'raw-address-b', 'raw-address-overflow']) limiter.recordFailure(subject);
    db.close(); db = f.open(); limiter = new PersistentLoginAttemptLimiter(db, { ...options, now: () => now });
    assert.equal(limiter.recordFailure('raw-address-a').allowed, false);
    assert.equal(limiter.recordFailure('new-overflow-address').allowed, false);
    db.close(); db = f.open(); limiter = new PersistentLoginAttemptLimiter(db, { ...options, now: () => now });
    assert.deepEqual(limiter.check('raw-address-a'), { allowed: false, failureCount: 2, retryAfterSeconds: 2 });
    limiter.recordSuccess('raw-address-b');
    limiter.recordSuccess('new-overflow-address');
    assert.equal(limiter.check('new-address').allowed, false);
    const rows = db.prepare('SELECT * FROM hub_login_limit_buckets').all();
    assert.doesNotMatch(JSON.stringify(rows), /raw-address|new-overflow-address/);
    assert.ok(rows.every(row => row.subject === 'overflow' || /^[a-f0-9]{64}$/.test(String(row.subject))));
    now += 1_001;
    assert.deepEqual(limiter.check('raw-address-a'), { allowed: false, failureCount: 0, retryAfterSeconds: 1 });
    now += 1_000;
    assert.equal(limiter.check('raw-address-a').allowed, true);
  } finally { f.close(); }
});

test('persistent limiter matches memory policy over deterministic mixed operations', () => {
  const db = new DatabaseSync(':memory:');
  let now = 10_000, seed = 17;
  const policy = { ...options, maxBuckets: 8, now: () => now };
  const memory = new LoginAttemptLimiter(policy), persistent = new PersistentLoginAttemptLimiter(db, policy);
  try {
    for (let i = 0; i < 2_000; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const subject = `subject-${seed % 13}`, operation = ['check', 'recordSuccess', 'recordFailure'][seed % 3] as 'check' | 'recordSuccess' | 'recordFailure';
      if (i % 7 === 0) now += seed % 1_003;
      assert.deepEqual(persistent[operation](subject), memory[operation](subject), `operation ${i}: ${operation}`);
      const count = db.prepare('SELECT COUNT(*) AS n FROM hub_login_limit_buckets').get()!.n as number;
      assert.ok(count <= 9);
    }
  } finally { db.close(); }
});

test('checks are read-only, exact window boundary and in-flight failures do not extend bans', () => {
  const db = new DatabaseSync(':memory:');
  let now = 10_000;
  const limiter = new PersistentLoginAttemptLimiter(db, { ...options, now: () => now });
  const changes = () => db.prepare('SELECT total_changes() AS n').get()!.n;
  try {
    const initial = changes();
    for (let i = 0; i < 100; i++) limiter.check(`unknown-${i}`);
    assert.equal(changes(), initial);
    limiter.recordFailure('a'); now += 1_000;
    assert.equal(limiter.check('a').failureCount, 1);
    limiter.recordFailure('a'); now += 1_000;
    const banned = limiter.check('a');
    for (let i = 0; i < 100; i++) assert.deepEqual(limiter.recordFailure('a'), banned);
    assert.equal(banned.retryAfterSeconds, 1);
    now += 1_000;
    assert.deepEqual(limiter.check('a'), { allowed: true, failureCount: 0 });
  } finally { db.close(); }
});

test('two database connections see committed failures, bans, success and overflow', () => {
  const f = fixture();
  try {
    const a = new PersistentLoginAttemptLimiter(f.open(), options), b = new PersistentLoginAttemptLimiter(f.open(), options);
    a.recordFailure('a'); assert.equal(b.check('a').failureCount, 1);
    b.recordFailure('a'); assert.equal(a.check('a').allowed, false);
    a.recordFailure('b'); b.recordFailure('overflow'); a.recordFailure('overflow-2');
    b.recordSuccess('b'); assert.equal(a.check('new').allowed, false);
    b.recordSuccess('a'); assert.equal(a.check('a').allowed, false); // shared overflow still applies
  } finally { f.close(); }
});

test('failed writes roll back, lock contention fails closed, outer transaction is not borrowed', () => {
  const f = fixture();
  try {
    const db = f.open(), other = f.open();
    const limiter = new PersistentLoginAttemptLimiter(db, options);
    db.exec("CREATE TRIGGER reject_failure BEFORE INSERT ON hub_login_limit_buckets BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
    assert.throws(() => limiter.recordFailure('a'), /fixture failure/);
    assert.equal(db.isTransaction, false);
    assert.equal(limiter.check('a').failureCount, 0);
    db.exec('DROP TRIGGER reject_failure');
    other.exec('BEGIN IMMEDIATE');
    assert.throws(() => limiter.recordFailure('a'), /locked/);
    other.exec('ROLLBACK');
    assert.equal(limiter.recordFailure('a').failureCount, 1);
    db.exec('BEGIN');
    assert.throws(() => limiter.recordSuccess('a'), /nested_transaction/);
    assert.equal(db.isTransaction, true);
    db.exec('ROLLBACK');
    assert.equal(limiter.check('a').failureCount, 1);
  } finally { f.close(); }
});

test('policy changes cannot clear active evidence and old instances fail closed after a permitted change', () => {
  const db = new DatabaseSync(':memory:');
  let now = 10_000;
  try {
    const first = new PersistentLoginAttemptLimiter(db, { ...options, now: () => now });
    first.recordFailure('a');
    assert.throws(() => new PersistentLoginAttemptLimiter(db, { ...options, maxFailures: 3, now: () => now }), /policy_conflict/);
    assert.equal(first.check('a').failureCount, 1);
    now += 1_001;
    const next = new PersistentLoginAttemptLimiter(db, { ...options, maxFailures: 3, now: () => now });
    assert.equal(next.check('a').failureCount, 0);
    for (const operation of ['check', 'recordSuccess', 'recordFailure'] as const) assert.throws(() => first[operation]('a'), /policy_conflict/);
  } finally { db.close(); }
});

test('corrupt evidence does not silently reset a source', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const limiter = new PersistentLoginAttemptLimiter(db, options);
    limiter.recordFailure('a');
    for (const invalid of ['null', '["unexpected"]', '[1,2,3]']) {
      db.prepare('UPDATE hub_login_limit_buckets SET failures = ?').run(invalid);
      assert.throws(() => limiter.check('a'), /corrupt/);
      assert.throws(() => limiter.recordFailure('a'), /corrupt/);
    }
  } finally { db.close(); }
});

test('separate processes do not lose shared failed attempts', async () => {
  const f = fixture();
  try {
    const policy = { ...options, maxFailures: 20, windowMs: 60_000, lockoutMs: 30_000 };
    const db = f.open();
    db.exec('PRAGMA journal_mode=WAL');
    const limiter = new PersistentLoginAttemptLimiter(db, policy);
    const typescript = import.meta.url.endsWith('.ts');
    const source = `import { DatabaseSync } from 'node:sqlite';
      import { PersistentLoginAttemptLimiter } from ${JSON.stringify(new URL(`./persistent-login-limiter.${typescript ? 'ts' : 'js'}`, import.meta.url).href)};
      const db = new DatabaseSync(process.argv[1]); db.exec('PRAGMA busy_timeout=1000');
      const limiter = new PersistentLoginAttemptLimiter(db, ${JSON.stringify(policy)});
      for(let i=0;i<10;i++) limiter.recordFailure('shared-subject'); db.close();`;
    const child = () => new Promise<void>((resolve, reject) => {
      const process_ = spawn(process.execPath, [...(typescript ? ['--import', import.meta.resolve('tsx')] : []), '--input-type=module', '-e', source, f.path], { stdio: 'pipe' });
      let error = '';
      process_.stderr.on('data', chunk => { error += chunk; });
      process_.on('error', reject);
      process_.on('exit', code => code === 0 ? resolve() : reject(Error(`fixture exit ${code}: ${error}`)));
    });
    await Promise.all([child(), child()]);
    assert.deepEqual(limiter.check('shared-subject'), { allowed: false, failureCount: 20, retryAfterSeconds: 30 });
  } finally { f.close(); }
});

for (const effected of [false, true]) test(`lost auth commit is not replayed and preserves live bans (${effected})`, () => {
  const db = new DatabaseSync(':memory:');
  const limiter = new PersistentLoginAttemptLimiter(db, { ...options, now: () => 10_000 });
  limiter.recordFailure('banned-private-subject'); limiter.recordFailure('banned-private-subject');
  const exec = db.exec.bind(db), original = Error('private-commit'); let commits = 0;
  db.exec = sql => { if (sql === 'COMMIT') { commits++; if (effected) exec(sql); throw original; } exec(sql); };
  try {
    assert.throws(() => limiter.recordFailure('different-private-subject'), error => error === original);
    assert.equal(commits, 1); assert.equal(db.isTransaction, false);
    db.exec = exec;
    assert.equal(limiter.check('different-private-subject').failureCount, Number(effected));
    assert.equal(limiter.check('banned-private-subject').allowed, false);
  } finally { db.exec = exec; db.close(); }
});

for (const effected of [false, true]) test(`auth cleanup failure preserves the original error and read snapshot (${effected})`, () => {
  const db = new DatabaseSync(':memory:'); let fail = false;
  const original = Error('private-clock');
  const limiter = new PersistentLoginAttemptLimiter(db, { ...options, now: () => { if (fail) throw original; return 10_000; } });
  limiter.recordFailure('private-subject');
  const exec = db.exec.bind(db), statements: string[] = [];
  db.exec = sql => { statements.push(sql); if (sql === 'ROLLBACK') { if (effected) exec(sql); throw Error('private-cleanup'); } exec(sql); };
  try {
    fail = true;
    assert.throws(() => limiter.check('private-subject'), error => error === original);
    assert.deepEqual(statements, ['BEGIN', 'ROLLBACK']);
    assert.equal(db.isTransaction, !effected);
    db.exec = exec; if (db.isTransaction) exec('ROLLBACK'); fail = false;
    assert.equal(limiter.check('private-subject').failureCount, 1);
  } finally { db.exec = exec; db.close(); }
});
