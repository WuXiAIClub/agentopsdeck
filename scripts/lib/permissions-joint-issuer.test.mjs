import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { assertPinnedJointLease, stoppedJointLease } from './permissions-joint-issuer.mjs';

const stopped = { exit: { code: 0 }, child: { exitCode: 0 } };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-native-sdk-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'hub'));
  const file = join(root, 'hub', 'hub.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE hub_execution_leases (id INTEGER PRIMARY KEY, version INTEGER, node_id TEXT,
    issuer_id TEXT, expires_at INTEGER, state TEXT, principal_id TEXT, proof TEXT)`);
  const insert = db.prepare('INSERT INTO hub_execution_leases VALUES (?, 1, ?, ?, 123, ?, ?, ?)');
  for (const [id, actor, key] of [[1, 'bob', 'codex:one'], [2, 'alice', 'codex:one'], [3, 'bob', 'codex:other']]) {
    insert.run(id, 'original-node', 'original-issuer', 'revoking', actor,
      JSON.stringify({ resource: { sessionKey: key }, privateField: 'must-not-be-projected' }));
  }
  db.close(); return { root, file };
}

test('stopped ledger reader selects only the exact principal/resource and never exposes proof', async t => {
  const { root } = await fixture(t);
  const selection = { root, hub: stopped, principalId: 'bob', sessionKey: 'codex:one' };
  const row = await stoppedJointLease(selection);
  assert.deepEqual(row, { id: 1, version: 1, nodeId: 'original-node', issuerId: 'original-issuer', expiresAt: 123, state: 'revoking' });
  await assert.rejects(stoppedJointLease({ ...selection, leaseId: 3 }), /Exact disposable/);
  await assert.rejects(stoppedJointLease({ ...selection, principalId: 'nobody' }), /Exact disposable/);
});

test('ledger inspection refuses running, failed, or not physically exited Hub', async t => {
  const { root } = await fixture(t);
  for (const hub of [undefined, {}, { exit: { code: 1 }, child: { exitCode: 1 } }, { exit: { code: 0 }, child: { exitCode: null } }]) {
    await assert.rejects(stoppedJointLease({ root, hub, principalId: 'bob', sessionKey: 'codex:one' }), /Hub/);
  }
});

test('ledger inspection refuses a symlink outside the isolated Hub', async t => {
  const target = await fixture(t), other = await fixture(t);
  await rm(other.file); await symlink(target.file, other.file);
  await assert.rejects(stoppedJointLease({ root: other.root, hub: stopped, principalId: 'bob', sessionKey: 'codex:one' }), /symlink/);
});

test('durable convergence cannot substitute lease, node, issuer, deadline or version', () => {
  const original = { id: 1, version: 2, nodeId: 'node-one', issuerId: 'old', expiresAt: 123, state: 'revoking' };
  assertPinnedJointLease(original, { ...original }, 'revoking');
  assertPinnedJointLease(original, { ...original, state: 'revoked' }, 'revoked');
  for (const key of ['id', 'version', 'nodeId', 'issuerId', 'expiresAt']) {
    assert.throws(() => assertPinnedJointLease(original, { ...original, [key]: 'replacement', state: 'revoked' }, 'revoked'), /pinned original/);
  }
  assert.throws(() => assertPinnedJointLease(original, original, 'revoked'), /pinned original/);
});
