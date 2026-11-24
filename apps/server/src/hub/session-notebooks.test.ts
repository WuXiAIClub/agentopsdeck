import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionNotebooks, validNotebookInput } from './session-notebooks.js';

test('personal notebooks persist, compare revisions atomically and retain empty tombstones', () => {
  const directory = mkdtempSync(join(tmpdir(), 'notebooks-')), path = join(directory, 'hub.sqlite');
  let db = new DatabaseSync(path), notes = new SessionNotebooks(db);
  try {
    const first = { resourceId: '["owner","node","codex","session"]', text: '小 tip\n<script>plain text</script>', revision: 0 };
    assert.equal(notes.save('alice', first)?.revision, 1);
    assert.equal(notes.save('alice', first), undefined);
    assert.equal(notes.get('bob', first.resourceId).text, '');
    for (const resourceId of ['["owner","other-node","codex","session"]', '["owner","node","hermes","session"]', '["other-owner","node","codex","session"]']) {
      assert.equal(notes.get('alice', resourceId).revision, 0);
    }
    db.close(); db = new DatabaseSync(path); notes = new SessionNotebooks(db);
    assert.equal(notes.get('alice', first.resourceId).text, first.text);
    assert.equal(notes.save('alice', { ...first, revision: 1, text: '' })?.revision, 2);
    assert.equal(notes.save('alice', first), undefined, 'clearing does not permit stale create');
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});
test('notebook validation bounds text and rejects identity injection or invalid revisions', () => {
  const valid = { resourceId: 'r', text: '文'.repeat(50_000), revision: 0 };
  assert.equal(validNotebookInput(valid), true);
  for (const value of [null, [], { ...valid, userId: 'someone' }, { ...valid, text: valid.text + 'x' }, { ...valid, revision: -1 },
    { ...valid, revision: 1.2 }, { ...valid, revision: Number.MAX_SAFE_INTEGER }, { ...valid, text: {} }]) assert.equal(validNotebookInput(value), false);
});

test('cold archive has independent 100k capacity, owner isolation, CAS and tombstones', () => {
  const directory = mkdtempSync(join(tmpdir(), 'notebook-archive-')), path = join(directory, 'hub.sqlite');
  let db = new DatabaseSync(path), notes = new SessionNotebooks(db);
  try {
    const input = { resourceId: 'same-resource', text: '文'.repeat(100_000), revision: 0 };
    assert.equal(notes.saveArchive('alice', input)?.revision, 1);
    assert.equal(notes.saveArchive('alice', input), undefined);
    assert.equal(notes.getArchive('bob', input.resourceId).text, '');
    assert.equal(notes.get('alice', input.resourceId).text, '');
    assert.equal(notes.listPrefix('alice', '').length, 0, 'archive never enters normal catalog');
    assert.throws(() => notes.saveArchive('alice', { ...input, text: input.text + 'x' }));
    assert.throws(() => notes.save('alice', input));
    assert.equal(notes.save('alice', { ...input, text: 'hot'.repeat(10000) })?.revision, 1);
    assert.equal(notes.getArchive('alice', input.resourceId).text.length, 100_000);
    db.close(); db = new DatabaseSync(path); notes = new SessionNotebooks(db);
    assert.equal(notes.getArchive('alice', input.resourceId).text, input.text, 'cold data survives database reopen');
    assert.equal(notes.saveArchive('alice', { ...input, revision: 1, text: '' })?.revision, 2);
    assert.equal(notes.saveArchive('alice', input), undefined);
    assert.equal(notes.get('alice', input.resourceId).text.length, 30000);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});
