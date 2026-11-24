import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NotebookCapabilities, validNotebookCapability } from './notebook-capabilities.js';
import { SessionNotebooks } from './session-notebooks.js';
import { observedSavepoint } from '../storage/observed-savepoint.js';

test('capability issuance and revocation never settle the enclosing identity transaction', () => {
  const db = new DatabaseSync(':memory:'), notes = new SessionNotebooks(db);
  const caps = new NotebookCapabilities(db, notes, () => true, () => 1000);
  const input = { facets: ['hot:read' as const], expiresAt: 2000 };
  try {
    notes.save('owner', { resourceId: 'r', revision: 0, text: 'retained' });
    const original = caps.issue('owner', 'r', input, null)!;
    let uncommitted!: NonNullable<ReturnType<NotebookCapabilities['issue']>>;
    assert.throws(() => observedSavepoint(db, 'hub-identity-check', () => {
      assert.ok(caps.revoke('owner', 'r', original.capability.id));
      uncommitted = caps.issue('owner', 'r', input, null)!;
      assert.ok(uncommitted);
      assert.equal(db.isTransaction, true);
      // Issuance purges revoked grants inside this same transaction too.
      assert.deepEqual(caps.list('owner', 'r'), [uncommitted.capability]);
      throw Error('identity authority changed');
    }), /identity authority changed/);
    assert.equal(db.isTransaction, false);
    assert.deepEqual(caps.list('owner', 'r'), [original.capability]);
    assert.ok(caps.authorized(original.token));
    assert.equal(caps.authorized(uncommitted.token), undefined);
    const committed = observedSavepoint(db, 'hub-identity-check', () => caps.issue('owner', 'r', input, null))!;
    assert.ok(caps.authorized(committed.token));
    assert.equal(db.isTransaction, false);
    assert.equal(notes.get('owner', 'r').text, 'retained');
  } finally { db.close(); }
});

test('notebook grants persist digest only; expiry, clock rollback and authority changes fail closed', () => {
  const directory = mkdtempSync(join(tmpdir(), 'notebook-capability-')), path = join(directory, 'store.sqlite');
  let db = new DatabaseSync(path), time = 1000, version = 1;
  const open = () => {
    const notes = new SessionNotebooks(db);
    return { notes, caps: new NotebookCapabilities(db, notes, (_owner, proof) => proof?.version === version, () => time) };
  };
  try {
    let { notes, caps } = open();
    notes.save('owner', { resourceId: 'r', revision: 0, text: 'private' });
    const issued = caps.issue('owner', 'r', { facets: ['cold:read'], expiresAt: 2000 }, { connectionId: 'c', version: 1 })!;
    assert.ok(issued); assert.ok(caps.authorized(issued.token, ['cold:read']));
    assert.equal(caps.authorized(issued.token, ['hot:read']), undefined);
    assert.deepEqual(caps.list('other', 'r'), []);
    assert.equal(caps.revoke('other', 'r', issued.capability.id), false);
    db.close(); assert.ok(!readFileSync(path).includes(Buffer.from(issued.token)));
    db = new DatabaseSync(path); ({ notes, caps } = open());
    assert.ok(caps.authorized(issued.token));
    version = 2; assert.equal(caps.authorized(issued.token), undefined); version = 1;
    time = 999; assert.equal(caps.authorized(issued.token), undefined);
    time = 2000; assert.equal(caps.authorized(issued.token), undefined);
    time = 1500; assert.ok(caps.revoke('owner', 'r', issued.capability.id));
    assert.equal(caps.authorized(issued.token), undefined);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('grant issuance validates facets, owner quota, existing notebook and file binding identity', () => {
  const db = new DatabaseSync(':memory:'), notes = new SessionNotebooks(db);
  const caps = new NotebookCapabilities(db, notes, () => true, () => 1000);
  const input = { facets: ['hot:read'] as const, expiresAt: 2000 };
  try {
    for (const facets of [[], ['move'], ['hot:read', 'move'], ['cold:read', 'cold:read'], ['other']])
      assert.equal(validNotebookCapability({ facets, expiresAt: 2000 }), false);
    assert.equal(validNotebookCapability({ facets: ['hot:read'], expiresAt: 2000, owner: 'other' }), false);
    assert.equal(caps.issue('u', 'r', { ...input, facets: [...input.facets] }, null), undefined);
    notes.save('u', { resourceId: 'r', revision: 0, text: 'hot' });
    assert.equal(caps.issue('u', 'r', { facets: ['hot:read'], expiresAt: 1000 + 86400001 }, null), undefined);
    const issued = caps.issue('u', 'r', { facets: ['hot:read'], expiresAt: 2000 }, null)!;
    db.prepare('INSERT INTO hub_workspace_native_file_locks VALUES (?,?,?,?,?)').run('u', 'notebook', 'r', 'binding', 'all');
    assert.equal(caps.authorized(issued.token), undefined, 'binding changes invalidate preexisting grants');
    db.prepare('DELETE FROM hub_workspace_native_file_locks').run();
    assert.equal(caps.authorized(issued.token), undefined, 'detaching cannot resurrect an old grant');
    const active = caps.issue('u', 'r', { facets: ['hot:read'], expiresAt: 2000 }, null)!;
    for (let n = 1; n < 64; n++) assert.ok(caps.issue('u', 'r', { facets: ['hot:read'], expiresAt: 2000 }, null));
    assert.equal(caps.issue('u', 'r', { facets: ['hot:read'], expiresAt: 2000 }, null), undefined);
    caps.revoke('u', 'r', active.capability.id);
    assert.ok(caps.issue('u', 'r', { facets: ['cold:read'], expiresAt: 2000 }, null));
    assert.equal(caps.list('u', 'r').length, 64);
    assert.equal(caps.authorized(issued.token), undefined);
    assert.equal(db.isTransaction, false);
  } finally { db.close(); }
});

test('both-area search reserves archive results and cold-only never reads hot text', () => {
  const db = new DatabaseSync(':memory:'), notes = new SessionNotebooks(db);
  try {
    notes.save('u', { resourceId: 'r', revision: 0, text: 'match '.repeat(5000) });
    notes.saveArchive('u', { resourceId: 'r', revision: 0, text: 'match '.repeat(10000) });
    const both = notes.searchAreas('u', 'r', 'match', 'both');
    assert.equal(both.results.filter(r => r.area === 'hot').length, 10);
    assert.equal(both.results.filter(r => r.area === 'cold').length, 10);
    assert.ok(Buffer.byteLength(JSON.stringify(both)) <= 8000);
    notes.get = () => { throw Error('Must not read hot note'); };
    const cold = notes.searchAreas('u', 'r', 'match', 'cold');
    assert.equal(cold.hotRevision, null); assert.equal(cold.results.length, 20);
  } finally { db.close(); }
});
