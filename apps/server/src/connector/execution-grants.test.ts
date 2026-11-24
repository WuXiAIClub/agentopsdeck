import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ExecutionGrants } from './execution-grants.js';
import { TurnQueue } from '../commands/turn-queue.js';

const binding = { issuerTokenId: 'synthetic-token', hubId: 'hub-a', principalId: 'user-a', grantKey: 'grant-a', version: 1,
  runtime: 'codex' as const, sessionKey: 'codex:synthetic' };

for (const executed of [false, true]) test(`grant issue lost commit acknowledgement preserves identity without replay (${executed})`, () => {
  const db = new DatabaseSync(':memory:'), original = Error('synthetic-commit');
  let commits = 0;
  const proxy = new Proxy(db, { get(target, key) {
    if (key === 'exec') return (sql: string) => {
      if (sql === 'COMMIT') { commits++; if (executed) target.exec(sql); throw original; }
      return target.exec(sql);
    };
    const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  try {
    const grants = new ExecutionGrants(proxy, () => true, () => 1000);
    assert.throws(() => grants.issue(binding, ['messages:send'], 2000), error => error === original);
    assert.equal(commits, 1); assert.equal(db.isTransaction, false);
    const rows = db.prepare('SELECT id, actor_id FROM connector_execution_grants').all();
    assert.equal(rows.length, Number(executed));
    if (executed) {
      const ref = grants.issue(binding, ['messages:send'], 2000);
      assert.equal(ref.id, rows[0]!.id); assert.equal(ref.actorId, rows[0]!.actor_id);
      assert.equal(commits, 1);
    }
  } finally { db.close(); }
});

test('grant revocation rollback cannot mask capacity rejection or revoke newer authority', () => {
  const db = new DatabaseSync(':memory:');
  const proxy = new Proxy(db, { get(target, key) {
    if (key === 'exec') return (sql: string) => {
      if (sql === 'ROLLBACK') { target.exec(sql); throw Error('synthetic-cleanup'); }
      return target.exec(sql);
    };
    const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
  } });
  try {
    const grants = new ExecutionGrants(proxy, () => true, () => 1000, 1);
    const ref = grants.issue(binding, ['messages:send'], 2000);
    assert.throws(() => grants.revokeVersion({ ...binding, version: 2 }), /capacity reached/);
    assert.equal(db.isTransaction, false);
    assert.equal(grants.authorize(ref, binding.issuerTokenId, binding, 'messages:send'), true);
    assert.equal(db.prepare('SELECT count(*) n FROM connector_execution_grants').get()!.n, 1);
  } finally { db.close(); }
});

test('owner-only namespaces cannot acquire delegated leases disguised as OpenClaw or Codex', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const grants = new ExecutionGrants(db, () => true, () => 1000);
    for (const id of ['hermes', 'claude-code', 'ghcp'] as const) {
      for (const runtime of [id, 'codex', 'openclaw'] as const) {
        const invalid = { ...binding, runtime, sessionKey: `${id}:owned` };
        assert.throws(() => grants.issue(invalid, ['messages:send'], 2000), /Invalid execution binding/);
        assert.throws(() => grants.revokeVersion(invalid), /Invalid execution binding/);
      }
    }
    assert.equal(db.prepare('SELECT count(*) AS total FROM connector_execution_grants').get()!.total, 0);
    // An old database may contain an OpenClaw-labelled row from before the
    // namespace was reserved. Read-time checks must reject it too.
    const existing = grants.issue({ ...binding, runtime: 'openclaw', sessionKey: 'agent:legacy' }, ['messages:send'], 2000);
    db.prepare('UPDATE connector_execution_grants SET session_key = ? WHERE id = ?').run('claude-code:owned', existing.id);
    const disguised = { runtime: 'openclaw' as const, sessionKey: 'claude-code:owned' };
    assert.equal(grants.authorize(existing, binding.issuerTokenId, disguised, 'messages:send'), false);
    assert.equal(grants.resolve(existing.id, binding.issuerTokenId, binding.hubId, disguised), undefined);
  } finally { db.close(); }
});

test('usage survives reopen but never extends expiry or revives interrupted preparation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-usage-reopen-')), file = join(directory, 'usage.sqlite');
  let db = new DatabaseSync(file), now = 1000;
  try {
    let grants = new ExecutionGrants(db, () => true, () => now), queue = new TurnQueue(db);
    const ref = grants.issue(binding, ['messages:send'], 2000);
    const payload = { actorId: ref.actorId, executionGrant: { ...ref, issuerTokenId: binding.issuerTokenId } };
    queue.enqueue('codex', { id: 'queued', sessionKey: binding.sessionKey, createdAt: 1000, payload });
    const usage = () => grants.usage([ref.id], binding.issuerTokenId, binding.hubId, (target, grant) => queue.usesExecutionGrant(target, grant));
    assert.deepEqual(usage(), [{ id: ref.id, needed: true }]);
    db.close(); db = new DatabaseSync(file); grants = new ExecutionGrants(db, () => true, () => now); queue = new TurnQueue(db);
    assert.deepEqual(usage(), [{ id: ref.id, needed: true }]);
    assert.equal(db.prepare('SELECT expires_at FROM connector_execution_grants').get()!.expires_at, 2000);
    queue.start('codex', binding.sessionKey, 'queued'); queue.recoverInterrupted('codex');
    assert.deepEqual(usage(), [{ id: ref.id, needed: false }]);
    queue.enqueue('codex', { id: 'later', sessionKey: binding.sessionKey, createdAt: 1000, payload });
    assert.deepEqual(usage(), [{ id: ref.id, needed: true }]);
    now = 2000;
    assert.deepEqual(usage(), [{ id: ref.id, needed: false }]);
    assert.equal(queue.head('codex', binding.sessionKey)?.state, 'outcome_unknown');
    assert.equal(db.prepare('SELECT expires_at FROM connector_execution_grants').get()!.expires_at, 2000);
    assert.throws(() => grants.issue(binding, ['messages:send'], 3000), /stale/);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('version revocation precedes issuance, survives reopen, and cannot revoke a newer policy', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-revoke-barrier-'));
  let db = new DatabaseSync(join(directory, 'grants.sqlite'));
  try {
    let grants = new ExecutionGrants(db, () => true, () => 1000, 2);
    grants.revokeVersion(binding);
    grants.revokeVersion(binding); // duplicate ACK uses no additional capacity
    db.close();
    db = new DatabaseSync(join(directory, 'grants.sqlite'));
    grants = new ExecutionGrants(db, () => true, () => 1000, 2);
    assert.throws(() => grants.issue(binding, ['messages:send'], 2000), /stale/);
    const fresh = grants.issue({ ...binding, version: 2 }, ['messages:send'], 2000);
    grants.revokeVersion(binding);
    assert.equal(grants.authorize(fresh, binding.issuerTokenId, binding, 'messages:send'), true);
    grants.revokeVersion({ ...binding, version: 2 }); // existing version works even at capacity
    assert.equal(grants.authorize(fresh, binding.issuerTokenId, binding, 'messages:send'), false);
    assert.throws(() => grants.issue({ ...binding, version: 2 }, ['messages:send'], 2000), /stale/);
    assert.throws(() => grants.revokeVersion({ ...binding, version: 3 }), /capacity/);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('lost issuance ACK can be revoked by version without knowing ref; other actors and issuers are isolated', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const grants = new ExecutionGrants(db, () => true, () => 1000);
    const first = grants.issue(binding, ['messages:send'], 2000);
    for (const other of [{ ...binding, principalId: 'other' }, { ...binding, issuerTokenId: 'other' }, { ...binding, hubId: 'other' }]) {
      grants.revokeVersion({ ...other, version: 10 });
      assert.equal(grants.authorize(first, binding.issuerTokenId, binding, 'messages:send'), true);
    }
    grants.revokeVersion({ ...binding, version: 3 });
    assert.equal(grants.authorize(first, binding.issuerTokenId, binding, 'messages:send'), false);
    for (const version of [1, 2, 3]) assert.throws(() => grants.issue({ ...binding, version }, ['messages:send'], 2000), /stale/);
    assert.ok(grants.issue({ ...binding, version: 4 }, ['messages:send'], 2000));
  } finally { db.close(); }
});

test('execution authority separates principals, Hubs, issuers, exact targets and actions', () => {
  const db = new DatabaseSync(':memory:');
  try {
    let allowed = true;
    const grants = new ExecutionGrants(db, () => allowed, () => 1000);
    const ref = grants.issue(binding, ['messages:send'], 2000);
    const other = grants.issue({ ...binding, principalId: 'user-b' }, ['messages:send'], 2000);
    assert.notEqual(ref.actorId, other.actorId);
    for (const change of [{ hubId: 'hub-b' }, { issuerTokenId: 'other-token' }]) {
      assert.notEqual(ref.actorId, grants.issue({ ...binding, ...change }, ['messages:send'], 2000).actorId);
    }
    assert.equal(grants.authorize(ref, binding.issuerTokenId, binding, 'messages:send'), true);
    assert.equal(grants.authorize(ref, 'other-token', binding, 'messages:send'), false);
    assert.equal(grants.authorize({ ...ref, actorId: other.actorId }, binding.issuerTokenId, binding, 'messages:send'), false);
    assert.equal(grants.authorize(ref, binding.issuerTokenId, { ...binding, sessionKey: 'other-session' }, 'messages:send'), false);
    assert.equal(grants.authorize(ref, binding.issuerTokenId, { ...binding, runtime: 'openclaw' }, 'messages:send'), false);
    assert.equal(grants.authorize(ref, binding.issuerTokenId, binding, 'runs:interrupt'), false);
    allowed = false;
    assert.equal(grants.authorize(ref, binding.issuerTokenId, binding, 'messages:send'), false);
    assert.throws(() => grants.issue(binding, ['messages:send'], 2000), /not authorized/);
  } finally { db.close(); }
});

test('renewal preserves immutable grant identity and cannot widen or revive authority', () => {
  const db = new DatabaseSync(':memory:');
  try {
    let now = 1000;
    const grants = new ExecutionGrants(db, () => true, () => now);
    const ref = grants.issue(binding, ['messages:send'], 2000);
    assert.deepEqual(grants.issue(binding, ['messages:send'], 3000), ref);
    for (const change of [{ sessionKey: 'other' }, { runtime: 'openclaw' as const }]) {
      assert.throws(() => grants.issue({ ...binding, ...change }, ['messages:send'], 3000), /conflicts/);
    }
    assert.throws(() => grants.issue(binding, ['messages:send', 'runs:interrupt'], 3000), /conflicts/);
    assert.equal(grants.revoke('other-token', ref.id), false);
    assert.equal(grants.revoke(binding.issuerTokenId, ref.id), true);
    assert.equal(grants.authorize(ref, binding.issuerTokenId, binding, 'messages:send'), false);
    assert.throws(() => grants.issue(binding, ['messages:send'], 3000), /stale/);
    const replacement = grants.issue({ ...binding, version: 2 }, ['messages:send'], 3000);
    assert.equal(replacement.actorId, ref.actorId);
    assert.notEqual(replacement.id, ref.id);
    now = 3000;
    assert.throws(() => grants.issue({ ...binding, version: 2 }, ['messages:send'], 4000), /stale/);
    assert.equal(grants.authorize(replacement, binding.issuerTokenId, binding, 'messages:send'), false);
    now = 1000;
    assert.equal(grants.authorize(replacement, binding.issuerTokenId, binding, 'messages:send'), false);
  } finally { db.close(); }
});

test('expired and revoked grant tombstones survive SQLite reopen without eviction', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-grant-'));
  let db = new DatabaseSync(join(directory, 'grants.sqlite'));
  try {
    let now = 1000;
    let grants = new ExecutionGrants(db, () => true, () => now, 1);
    const ref = grants.issue(binding, ['messages:send'], 2000);
    now = 999;
    assert.equal(grants.authorize(ref, binding.issuerTokenId, binding, 'messages:send'), false);
    db.close();
    db = new DatabaseSync(join(directory, 'grants.sqlite'));
    now = 1000;
    grants = new ExecutionGrants(db, () => true, () => now, 1);
    assert.equal(grants.authorize(ref, binding.issuerTokenId, binding, 'messages:send'), false);
    assert.throws(() => grants.issue(binding, ['messages:send'], 2000), /stale/);
    assert.throws(() => grants.issue({ ...binding, version: 2 }, ['messages:send'], 2000), /capacity/);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('clock rollback behind the latest renewal durably revokes the same ref', () => {
  const db = new DatabaseSync(':memory:');
  try {
    let now = 1000;
    const grants = new ExecutionGrants(db, () => true, () => now);
    const ref = grants.issue(binding, ['messages:send'], 2000);
    now = 1500;
    assert.deepEqual(grants.issue(binding, ['messages:send'], 2500), ref);
    now = 1499;
    assert.equal(grants.authorize(ref, binding.issuerTokenId, binding, 'messages:send'), false);
    now = 1501;
    assert.equal(grants.authorize(ref, binding.issuerTokenId, binding, 'messages:send'), false);
  } finally { db.close(); }
});

test('new grant versions atomically invalidate old versions; failed replacement preserves authority', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const grants = new ExecutionGrants(db, () => true, () => 1000, 2);
    const old = grants.issue(binding, ['messages:send'], 2000);
    const fresh = grants.issue({ ...binding, version: 3 }, ['messages:send'], 2000);
    assert.equal(grants.authorize(old, binding.issuerTokenId, binding, 'messages:send'), false);
    assert.throws(() => grants.issue(binding, ['messages:send'], 2000), /stale/);
    assert.throws(() => grants.issue({ ...binding, version: 2 }, ['messages:send'], 2000), /stale/);
    assert.throws(() => grants.issue({ ...binding, version: 4 }, ['messages:send'], 2000), /capacity/);
    assert.equal(grants.authorize(fresh, binding.issuerTokenId, binding, 'messages:send'), true);
  } finally { db.close(); }
});

test('execution delegation rejects malformed, unbounded and unsupported input before storing', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const grants = new ExecutionGrants(db, () => true, () => 1000, 1);
    for (const expires of [1000, 61_001, Infinity, 1200.5]) assert.throws(() => grants.issue(binding, ['messages:send'], expires), /bound/);
    for (const change of [{ principalId: '' }, { grantKey: 'x'.repeat(1025) }, { sessionKey: 'a\n' }, { version: 0 }]) {
      assert.throws(() => grants.issue({ ...binding, ...change }, ['messages:send'], 2000), /binding/);
    }
    for (const actions of [[], ['messages:send', 'messages:send'], ['node:manage']]) {
      assert.throws(() => grants.issue(binding, actions as ['messages:send'], 2000), /actions/);
    }
    assert.ok(grants.issue(binding, ['messages:send'], 2000));
  } finally { db.close(); }
});
