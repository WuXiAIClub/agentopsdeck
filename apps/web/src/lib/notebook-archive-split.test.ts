import test from 'node:test';
import assert from 'node:assert/strict';
import { archiveShare, dragArchiveShare } from './notebook-archive-split.js';

test('archive height starts at 45%, clamps both panes and tolerates invalid values', () => {
  assert.equal(archiveShare(NaN), 45);
  assert.equal(archiveShare(Infinity), 45);
  assert.equal(archiveShare(0), 15);
  assert.equal(archiveShare(100), 85);
  assert.equal(archiveShare(52), 52);
});
test('drag upward grows the archive; downward grows the hot note', () => {
  assert.equal(dragArchiveShare(45, -100, 500), 65);
  assert.equal(dragArchiveShare(45, 100, 500), 25);
  assert.equal(dragArchiveShare(45, -10000, 500), 85);
  assert.equal(dragArchiveShare(45, 10000, 500), 15);
});
test('invalid or zero-size layouts never corrupt the split', () => {
  for (const height of [0, -1, NaN, Infinity]) assert.equal(dragArchiveShare(45, 20, height), 45);
  assert.equal(dragArchiveShare(45, NaN, 500), 45);
});
