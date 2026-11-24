import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { HubStore } from './hub-store.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { AsyncHubMemberSessions } from './async-member-session.js';
import { AsyncHubLoginLimiter } from './async-login-limiter.js';
import { validHubMemberInput, validHubMemberOutput, hubMemberOwnerConfig } from './member-owner-domain.js';
import { AuthAuditLog, fingerprintRequest, loginLimiterSubject } from '../auth/security.js';
import { AuthPersistenceError } from '../auth/private-store.js';
import { registerAuthRoutes } from '../routes/auth.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const quiet = new PerformanceDiagnostics(() => {}), policy = { maxFailures: 2, windowMs: 600_000, lockoutMs: 600_000, maxBuckets: 1 };
const subject = 'a'.repeat(24), second = 'b'.repeat(24), third = 'c'.repeat(24);
async function disk(work: (file: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'hub-login-limiter-'));
  try { await work(join(root, 'hub.sqlite')); } finally { rmSync(root, { recursive: true, force: true }); }
}
function rows(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA quick_check').get()!.quick_check, 'ok');
    return ['hub_login_limit_policy', 'hub_login_limit_buckets'].map(table =>
      db.prepare(`SELECT * FROM ${table}`).all().map(row => JSON.stringify(row)).sort());
  } finally { db.close(); }
}

test('typed limiter boundary accepts original HTTP fingerprint and exact policy, never raw subjects/callbacks or malformed decisions', () => {
  const fingerprint = loginLimiterSubject(fingerprintRequest(new Request('http://fixture.invalid/')));
  assert.equal(fingerprint.length, 24);
  for (const kind of ['loginLimiterCheck', 'loginLimiterFailure', 'loginLimiterSuccess'] as const) {
    assert.equal(validHubMemberInput(kind, { subject: fingerprint }), true);
    for (const input of [{ subject: '192.0.2.1' }, { subject }, { subject, allowed: true }]) {
      if (Object.keys(input).length === 1 && input.subject === subject) continue;
      assert.equal(validHubMemberInput(kind, input), false);
    }
  }
  assert.equal(validHubMemberOutput('loginLimiterCheck', { allowed: false, failureCount: 2, retryAfterSeconds: 100 }), true);
  assert.equal(validHubMemberOutput('loginLimiterCheck', null), false);
  assert.equal(validHubMemberOutput('loginLimiterFailure', { allowed: 'yes', failureCount: 0 }), false);
  assert.equal(validHubMemberOutput('loginLimiterSuccess', {}), false);
  assert.deepEqual(hubMemberOwnerConfig({ file: '/fixture.sqlite', loginLimiter: policy }).loginLimiter, policy);
  for (const bad of [{ ...policy, now: () => 0 }, { ...policy, maxFailures: 0 }, { maxFailures: 2 }])
    assert.throws(() => hubMemberOwnerConfig({ file: '/fixture.sqlite', loginLimiter: bad }));
});

test('old persistent ban survives complete worker open/close and original synchronous facade reopen', () => disk(async file => {
  const original = new HubStore(file, 'fixture-vault'), limiter = original.createLoginLimiter(policy);
  limiter.recordFailure(subject); assert.equal(limiter.recordFailure(subject).allowed, false);
  await original.close(); const before = rows(file);
  const owner = new AsyncHubMemberOwner({ file, encryptionSecret: 'fixture-vault', loginLimiter: policy }, quiet);
  try {
    const caller = new AsyncHubLoginLimiter(owner, quiet), decision = await caller.check(subject);
    assert.equal(decision.allowed, false); assert.equal(decision.failureCount, 2); assert.ok(decision.retryAfterSeconds);
    assert.deepEqual(rows(file), before);
  } finally { await owner.close(); }
  const reopened = new HubStore(file, 'fixture-vault');
  try { assert.equal(reopened.createLoginLimiter(policy).check(subject).allowed, false); assert.deepEqual(rows(file), before); }
  finally { await reopened.close(); }
}));

test('worker limiter keeps original overflow evidence across unrelated successful login and later reopen', () => disk(async file => {
  const original = new HubStore(file, 'fixture-vault'); original.createLoginLimiter(policy); await original.close();
  const owner = new AsyncHubMemberOwner({ file, encryptionSecret: 'fixture-vault', loginLimiter: policy }, quiet);
  try {
    const limiter = new AsyncHubLoginLimiter(owner, quiet);
    await limiter.recordFailure(subject); await limiter.recordFailure(second);
    assert.equal((await limiter.recordFailure(third)).allowed, false);
    await limiter.recordSuccess(subject);
    assert.equal((await limiter.check('d'.repeat(24))).allowed, false);
    assert.equal(limiter.pending, 0);
  } finally { await owner.close(); }
  const reopened = new HubStore(file, 'fixture-vault');
  try { assert.equal(reopened.createLoginLimiter(policy).check('d'.repeat(24)).allowed, false); }
  finally { await reopened.close(); }
}));

test('real limiter write faults roll back exact buckets and keep healthy owner plus redacted diagnostics', () => disk(async file => {
  const original = new HubStore(file, 'fixture-vault'); original.createLoginLimiter(policy); await original.close();
  const before = rows(file), db = new DatabaseSync(file);
  try { db.exec("CREATE TRIGGER fail_limit BEFORE INSERT ON hub_login_limit_buckets BEGIN SELECT RAISE(ABORT,'private-fixture-limiter'); END"); }
  finally { db.close(); }
  const logs: string[] = [], owner = new AsyncHubMemberOwner({ file, encryptionSecret: 'fixture-vault', loginLimiter: policy },
    new PerformanceDiagnostics(line => logs.push(line)));
  try {
    const limiter = new AsyncHubLoginLimiter(owner, quiet);
    await assert.rejects(limiter.recordFailure(subject), AuthPersistenceError);
    assert.deepEqual(await limiter.check(subject), { allowed: true, failureCount: 0 });
    assert.equal(owner.snapshot().unavailable, false); assert.deepEqual(rows(file), before);
    assert.ok(logs.map(line => JSON.parse(line)).some(entry => entry.operation === 'hub-member-sqlite-command'
      && entry.category === 'failed' && entry.unknown === 1));
    assert.equal(logs.join('').includes('private-fixture'), false); assert.equal(logs.join('').includes(subject), false);
  } finally { await owner.close(); }
}));

test('active stored policy conflict refuses startup without erasing bans or acquiring a replacement writer', () => disk(async file => {
  const original = new HubStore(file, 'fixture-vault'), limiter = original.createLoginLimiter(policy);
  limiter.recordFailure(subject); limiter.recordFailure(subject); await original.close(); const before = rows(file);
  const owner = new AsyncHubMemberOwner({ file, encryptionSecret: 'fixture-vault', loginLimiter: { ...policy, maxFailures: 3 } }, quiet);
  await assert.rejects(owner.open()); await owner.close().catch(() => {});
  assert.equal(owner.snapshot().ownerExitConfirmed, true); assert.deepEqual(rows(file), before);
  const restored = new AsyncHubMemberOwner({ file, encryptionSecret: 'fixture-vault', loginLimiter: policy }, quiet);
  try { assert.equal((await restored.command('loginLimiterCheck', { subject })).allowed, false); }
  finally { await restored.close(); }
}));

test('unconfigured limiter refuses without creating policy or replacing the original owner', () => disk(async file => {
  const original = new HubStore(file, 'fixture-vault'); await original.close();
  const owner = new AsyncHubMemberOwner({ file, encryptionSecret: 'fixture-vault' }, quiet);
  try {
    await assert.rejects(new AsyncHubLoginLimiter(owner, quiet).check(subject), AuthPersistenceError);
    assert.equal(owner.snapshot().unavailable, false);
    assert.equal(await owner.command('memberSnapshot', {}), null);
    const db = new DatabaseSync(file, { readOnly: true });
    try { assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='hub_login_limit_policy'").get(), undefined); }
    finally { db.close(); }
  } finally { await owner.close(); }
}));

test('worker-backed HTTP login rate limit survives reopen and returns existing 429/Retry-After contract', () => disk(async file => {
  const original = new HubStore(file, 'fixture-vault'); original.createLoginLimiter(policy); await original.close();
  const makeApp = (owner: AsyncHubMemberOwner) => {
    const app = new Hono(), sessions = new AsyncHubMemberSessions(owner, quiet);
    const unsupported = async (): Promise<never> => { throw Error('unexpected_passkey_operation'); };
    registerAuthRoutes(app, { accessKey: 'fixture-admin', sessions: new Set(), isAuthorizedRequest: () => false,
      passkeys: { status: () => ({ available: false, count: 0 }), list: () => [], revoke: () => false,
        registrationOptions: unsupported, verifyRegistration: unsupported, authenticationOptions: unsupported, verifyAuthentication: unsupported },
      auditLog: new AuthAuditLog(), loginLimiter: new AsyncHubLoginLimiter(owner, quiet), lockoutSeconds: 600,
      memberLogin: sessions.memberLogin, memberSessionCurrent: sessions.memberSessionCurrent, revokeMemberSession: sessions.revokeMemberSession, diagnostics: quiet });
    return app;
  };
  const login = (app: Hono) => app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accessKey: 'hub_key_' + 'x'.repeat(43) }) });
  let owner = new AsyncHubMemberOwner({ file, encryptionSecret: 'fixture-vault', loginLimiter: policy }, quiet);
  try {
    const app = makeApp(owner); assert.equal((await login(app)).status, 401);
    const second = await login(app); assert.equal(second.status, 429); assert.ok(second.headers.get('retry-after'));
    assert.equal(second.headers.get('set-cookie'), null);
  } finally { await owner.close(); }
  owner = new AsyncHubMemberOwner({ file, encryptionSecret: 'fixture-vault', loginLimiter: policy }, quiet);
  try {
    const result = await login(makeApp(owner)); assert.equal(result.status, 429);
    const body = await result.json() as { error: string; retryAfterSeconds: number };
    assert.equal(body.error, 'too_many_attempts'); assert.ok(body.retryAfterSeconds > 0);
    assert.equal(result.headers.get('retry-after'), String(body.retryAfterSeconds)); assert.equal(result.headers.get('set-cookie'), null);
  } finally { await owner.close(); }
}));
