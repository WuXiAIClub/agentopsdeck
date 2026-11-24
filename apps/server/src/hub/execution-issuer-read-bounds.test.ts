import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { HubExecutionIssuers } from './execution-issuers.js';
import type { ExecutionLease } from './execution-leases.js';

function fixture() {
  // One isolated in-memory owner, never a peer writer to a running Hub.
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE env_connections (id TEXT,owner_user_id TEXT,node_id TEXT,
    authority_version INTEGER,connector_url TEXT,kind TEXT,deleted_at INTEGER,status TEXT)`);
  const node = `node_${randomUUID()}`;
  db.prepare('INSERT INTO env_connections VALUES(?,?,?,?,?,?,NULL,?)')
    .run('node', 'default', node, 2, 'http://connector.example.invalid', 'local', 'ready');
  let reads = 0, calls = 0;
  const owner = new HubExecutionIssuers(db, 'synthetic-hub', {
    read() { reads++; return 'synthetic-secret'; }, write() { throw new Error('Unexpected write'); },
  });
  db.prepare(`INSERT INTO hub_execution_issuers
    (id,owner_id,connection_id,node_id,issuer_id,authority_version,connector_url,kind,creation_allowed)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(randomUUID(), 'default', 'node', node, 'synthetic-issuer', 2, 'http://connector.example.invalid', 'local', 1);
  const lease: ExecutionLease = { id: 1, grantKey: 'synthetic', version: 1, nodeId: node, issuerId: 'synthetic-issuer',
    proof: { ownerUserId: 'default', connectionId: 'node', userId: 'member', grantId: 'grant', version: 1,
      nodeVersion: 2, action: 'messages:send', resource: { runtime: 'codex', sessionKey: 'codex:synthetic' } },
    actions: ['messages:send'], expiresAt: Date.now() + 60_000, state: 'active' };
  const local = { connectionId: 'node', dispatch: async () => { calls++; return new Response('{}'); } };
  return { db, owner, lease, local, reads: () => reads, calls: () => calls, close: () => db.close() };
}

for (const value of ['broken', 'x'.repeat(32_768), -1, 2, 0.5]) {
  test(`issuer current refuses malformed creation flag (${typeof value}/${String(value).length})`, () => {
    const f = fixture();
    try {
      f.db.prepare('UPDATE hub_execution_issuers SET creation_allowed=?').run(value);
      assert.throws(() => f.owner.current('default', 'node'), /issuer/i);
      assert.equal(f.reads(), 0); assert.equal(f.calls(), 0);
    } finally { f.close(); }
  });
}

for (const field of ['id', 'connector_url', 'node_id', 'issuer_id'] as const) {
  test(`issuer current and creation preflight oversized ${field} before credential reads`, () => {
    const f = fixture();
    try {
      f.db.prepare(`UPDATE hub_execution_issuers SET ${field}=?`).run('x'.repeat(32_768));
      assert.throws(() => f.owner.current('default', 'node'), /issuer/i);
      assert.throws(() => f.owner.creationClient('default', 'node', 2, () => {}, f.local), /issuer/i);
      assert.equal(f.reads(), 0); assert.equal(f.calls(), 0);
    } finally { f.close(); }
  });
}

for (const field of ['node_id', 'connector_url'] as const) {
  test(`issuer current preflights oversized connection ${field}`, async () => {
    const f = fixture();
    try {
      f.db.prepare(`UPDATE env_connections SET ${field}=?`).run('x'.repeat(32_768));
      assert.throws(() => f.owner.current('default', 'node'), /issuer|Connector/i);
      await assert.rejects(f.owner.configure('default', 'node', 'synthetic-secret', () => {}, f.local), /issuer|Connector/i);
      assert.equal(f.reads(), 0); assert.equal(f.calls(), 0);
    } finally { await f.owner.close(); f.close(); }
  });
}

test('issuer current rejects mismatched pinned node rather than projecting it as current', () => {
  const f = fixture();
  try {
    f.db.prepare('UPDATE hub_execution_issuers SET node_id=?').run(`node_${randomUUID()}`);
    assert.throws(() => f.owner.current('default', 'node'), /issuer/i);
    assert.equal(f.reads(), 0);
  } finally { f.close(); }
});

test('creation client rechecks creation capability before later requests, without transport replay', async () => {
  const f = fixture();
  try {
    const client = f.owner.creationClient('default', 'node', 2, () => {}, f.local);
    f.db.exec('UPDATE hub_execution_issuers SET creation_allowed=0');
    await assert.rejects(client.json('/agents/codex/sessions', { method: 'POST', body: '{}' }), /retired/);
    assert.equal(f.calls(), 0);
    assert.equal(f.reads(), 1, 'only the originally admitted client read a credential');
  } finally { await f.owner.close(); f.close(); }
});

test('bounded issuer reads preserve valid current/creation/historical behavior without rewriting rows', () => {
  const f = fixture();
  try {
    assert.deepEqual(f.owner.current('default', 'node'), { issuerId: 'synthetic-issuer', nodeId: f.lease.nodeId, version: 2, creationAllowed: true });
    assert.ok(f.owner.creationClient('default', 'node', 2, () => {}, f.local));
    const original = f.owner.snapshotFor(f.lease);
    f.db.exec('UPDATE hub_execution_issuers SET creation_allowed=0,retired=1');
    assert.equal(f.owner.current('default', 'node'), undefined);
    assert.throws(() => f.owner.creationClient('default', 'node', 2, () => {}, f.local), /unavailable/i);
    assert.deepEqual(f.owner.snapshotFor(f.lease), original, 'retirement retains only pinned historical authority');
    assert.equal(f.calls(), 0);
    assert.deepEqual({ ...f.db.prepare('SELECT retired,creation_allowed FROM hub_execution_issuers').get() }, { retired: 1, creation_allowed: 0 });
  } finally { f.close(); }
});
