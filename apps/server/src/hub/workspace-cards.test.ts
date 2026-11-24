import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { validCardWrite, type CardWrite } from '@agentopsdeck/shared';
import { WorkspaceCards } from './workspace-cards.js';

const write = (revision = 0): CardWrite => ({ title: 'Build', value: '42', detail: '<script>literal only</script>', tone: 'green', progress: 42, revision, mutationId: randomUUID() });
test('card validation bounds and explicit schema', () => {
  assert.equal(validCardWrite(write()), true);
  for (const patch of [{ title: '' }, { value: 'x'.repeat(161) }, { detail: 'x'.repeat(4001) }, { tone: 'url(evil)' }, { progress: Infinity }, { progress: -1 }, { revision: 1.2 }, { script: 'x' }]) assert.equal(validCardWrite({ ...write(), ...patch }), false);
});
test('private cards, bounded receipts, CAS, rollback and restart persistence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'workspace-cards-')), path = join(dir, 'db.sqlite');
  let db = new DatabaseSync(path), cards = new WorkspaceCards(db); const id = randomUUID(), first = write();
  try {
    assert.equal(cards.get('alice', id), undefined);
    const saved = cards.save('alice', id, first); assert.equal(saved.status, 'saved');
    assert.deepEqual(cards.save('alice', id, first), saved);
    assert.equal(cards.save('alice', id, { ...first, title: 'changed' }).status, 'mutation-reused');
    assert.equal(cards.save('alice', id, write()).status, 'conflict');
    assert.equal(cards.get('bob', id), undefined); assert.deepEqual(cards.list('bob'), []); assert.deepEqual(cards.revisions('bob'), []);
    assert.ok(!JSON.stringify(cards.list('alice')).includes('script'));
    db.exec('BEGIN'); cards.save('alice', id, write(1)); db.exec('ROLLBACK'); assert.equal(cards.get('alice', id)?.revision, 1);
    for (let revision = 1; revision <= 12; revision++) assert.equal(cards.save('alice', id, write(revision)).status, 'saved');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM hub_workspace_card_receipts').get() as { n: number }).n, 8);
    db.close(); db = new DatabaseSync(path); cards = new WorkspaceCards(db); assert.equal(cards.get('alice', id)?.revision, 13);
    for (let i = 1; i < 64; i++) assert.equal(cards.save('alice', randomUUID(), write()).status, 'saved');
    assert.equal(cards.save('alice', randomUUID(), write()).status, 'limit'); assert.equal(cards.save('bob', id, write()).status, 'saved');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
