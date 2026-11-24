import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { SessionNotebooks } from './session-notebooks.js';
import { notebookHash, type NotebookMove } from './notebook-operations.js';

function fixture() {
  const db = new DatabaseSync(':memory:'), notes = new SessionNotebooks(db);
  notes.save('u', { resourceId: 'r', revision: 0, text: 'new\nold😀 text' });
  const input: NotebookMove = { requestId: randomUUID(), direction: 'archive', hotRevision: 1, coldRevision: 0, ranges: [{ start: 4, end: 14, sha256: notebookHash('old😀 text') }] };
  return { db, notes, input };
}
test('atomic hot/cold move, original receipt, isolation and restore', () => {
  const { db, notes, input } = fixture();
  try {
    const result = notes.move('u', 'r', input);
    assert.deepEqual(result, { hotRevision: 2, coldRevision: 1, moved: 10 });
    assert.equal(notes.get('u', 'r').text, 'new\n');
    assert.equal(notes.getArchive('u', 'r').text, 'old😀 text');
    assert.deepEqual(notes.move('u', 'r', input), result);
    assert.equal(notes.moveReceipt('other', 'r', input.requestId), undefined);
    assert.throws(() => notes.move('u', 'r', { ...input, coldRevision: 1 }), /already used/);
    notes.move('u', 'r', { ...input, requestId: randomUUID(), direction: 'restore', hotRevision: 2, coldRevision: 1, ranges: [{ start: 0, end: 10, sha256: notebookHash('old😀 text') }] });
    assert.equal(notes.getArchive('u', 'r').text, '');
    assert.equal(notes.get('u', 'r').text, 'new\n\n\nold😀 text');
    assert.deepEqual(notes.moveReceipt('u', 'r', input.requestId), result, 'receipt is original, not current revisions');
  } finally { db.close(); }
});
test('stale versions, overflow, changed hash, overlap and split Unicode roll back both facets', () => {
  const { db, notes, input } = fixture();
  try {
    for (const change of [{ hotRevision: 0 }, { coldRevision: 1 }, { ranges: [{ ...input.ranges[0]!, sha256: '0'.repeat(64) }] },
      { ranges: [...input.ranges, ...input.ranges] }, { ranges: [{ start: 8, end: 9, sha256: notebookHash('\ude00') }] }]) {
      assert.throws(() => notes.move('u', 'r', { ...input, ...change }));
      assert.equal(notes.get('u', 'r').revision, 1); assert.equal(notes.getArchive('u', 'r').revision, 0);
    }
    notes.saveArchive('u', { resourceId: 'r', revision: 0, text: 'x'.repeat(100000) });
    assert.throws(() => notes.move('u', 'r', { ...input, coldRevision: 1 }), /full/);
    assert.equal(notes.get('u', 'r').revision, 1);
    assert.equal(notes.moveReceipt('u', 'r', input.requestId), undefined);
  } finally { db.close(); }
});
test('file projection fence and cold search opt-in with bounded versioned locations', () => {
  const { db, notes, input } = fixture();
  try {
    db.prepare('INSERT INTO hub_workspace_native_file_locks VALUES (?,?,?,?,?)').run('u', 'notebook', 'r', 'binding', 'all');
    assert.throws(() => notes.move('u', 'r', input), /projection/);
    notes.saveArchive('u', { resourceId: 'r', revision: 0, text: 'cold'.repeat(20000) });
    assert.deepEqual(notes.search('u', 'r', 'cold').results, []);
    const found = notes.search('u', 'r', 'cold', true);
    assert.equal(found.results.length, 10); assert.equal(found.coldRevision, 1);
    assert.ok(Buffer.byteLength(JSON.stringify(found)) <= 8000);
    assert.deepEqual(notes.search('other', 'r', 'cold', true).results, []);
    assert.throws(() => notes.search('u', 'r', ''));
  } finally { db.close(); }
});
