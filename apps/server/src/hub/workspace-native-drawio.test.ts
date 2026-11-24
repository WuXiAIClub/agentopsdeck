import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyNativeDrawio, NATIVE_DRAWIO_MAX_DOCUMENTS } from '@agentopsdeck/shared';
import { WorkspaceNativeDrawio } from './workspace-native-drawio.js';
const input = () => ({ ...emptyNativeDrawio(), revision: 0, mutationId: randomUUID() });
test('native XML, CAS and idempotency survive reopen; receipts do not duplicate XML', () => {
  const root = mkdtempSync(join(tmpdir(), 'native-drawio-')), path = join(root, 'db.sqlite');
  let db = new DatabaseSync(path), store = new WorkspaceNativeDrawio(db);
  try {
    const body = input(), first = store.save('alice', 'default', body);
    assert.equal(first.status, 'saved');
    assert.equal(store.get('alice', 'default').xml, body.xml);
    assert.deepEqual(store.list('bob'), []); assert.equal(store.get('bob', 'default').revision, 0);
    assert.equal(JSON.stringify(store.list('alice')).includes('<mxfile>'), false);
    assert.equal(store.save('alice', 'default', { ...body, title: 'new' }).status, 'mutation-reused');
    assert.equal(store.save('alice', 'default', { ...body, mutationId: randomUUID() }).status, 'conflict');
    db.close(); db = new DatabaseSync(path); store = new WorkspaceNativeDrawio(db);
    assert.deepEqual(store.save('alice', 'default', body), first);
    assert.equal(store.save('alice', 'default', { ...body, title: 'Next', revision: 1, mutationId: randomUUID() }).status, 'saved');
    assert.deepEqual(store.save('alice', 'default', body), first, 'lost response retry reproduces old receipt without rolling back newer document');
    assert.equal(store.get('alice', 'default').title, 'Next');
    for (let revision = 2; revision < 12; revision++) assert.equal(store.save('alice', 'default', { ...body, revision, mutationId: randomUUID() }).status, 'saved');
    assert.equal((db.prepare('SELECT count(*) AS n FROM hub_workspace_native_drawio_receipts').get() as { n: number }).n, 8);
    assert.ok(!JSON.stringify(db.prepare('SELECT * FROM hub_workspace_native_drawio_receipts').all()).includes('mxfile'));
    assert.equal(store.save('alice', 'default', body).status, 'conflict');
    for (let i = 1; i < NATIVE_DRAWIO_MAX_DOCUMENTS; i++) assert.equal(store.save('alice', randomUUID(), input()).status, 'saved');
    assert.equal(store.save('alice', randomUUID(), input()).status, 'limit');
    assert.equal(store.save('bob', randomUUID(), input()).status, 'saved');
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
test('receipt failure rolls back native XML and catalog atomically', () => {
  const db = new DatabaseSync(':memory:'), store = new WorkspaceNativeDrawio(db);
  try {
    db.exec("CREATE TRIGGER fail_native_receipt BEFORE INSERT ON hub_workspace_native_drawio_receipts BEGIN SELECT RAISE(ABORT, 'synthetic'); END");
    assert.throws(() => store.save('alice', 'default', input()), /synthetic/);
    assert.equal(store.get('alice', 'default').revision, 0); assert.deepEqual(store.list('alice'), []);
  } finally { db.close(); }
});
