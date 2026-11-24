import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { validGitTreePage, validGitFilePreview } from './git-tree.js';
const page = () => ({ repositoryRef: 'project', snapshotId: 'a'.repeat(64), observedAt: 1, entries: [{ name: 'src', kind: 'directory', pathToken: randomUUID(), previewCapability: false, indexStatus: 'unknown', worktreeStatus: 'unknown' }], nextCursor: null, consistency: 'best_effort', truncationReason: null, gitStatus: 'unsupported' });
test('branch labels remain bounded, literal text', () => {
  assert.equal(validGitTreePage({ ...page(), branch: 'feature/worktree' }, 'project'), true);
  for (const branch of [null, 1, 'x'.repeat(1025), 'bad\nbranch', 'bad\u007fbranch']) {
    assert.equal(validGitTreePage({ ...page(), branch }, 'project'), false);
  }
});
test('directory response requires exact identity, bounded fields and honest unsupported capabilities', () => {
  assert.equal(validGitTreePage(page(), 'project'), true); assert.equal(validGitTreePage(page(), 'other'), false);
  for (const value of [null, [], {}, { ...page(), observedAt: NaN }, { ...page(), gitStatus: 'clean' }, { ...page(), nextCursor: '../x' }, { ...page(), snapshotId: 'bad' }]) assert.equal(validGitTreePage(value, 'project'), false);
  for (const patch of [{ name: '..' }, { name: 'a/b' }, { name: 'a\nb' }, { name: '.git' }, { kind: 'other' }, { previewCapability: true }, { pathToken: 'bad' }, { indexStatus: 'clean' }]) {
    const value = page(); Object.assign(value.entries[0]!, patch); assert.equal(validGitTreePage(value, 'project'), false);
  }
});
test('duplicate names, duplicate capabilities and excessive pages are rejected', () => {
  const value = page(); value.entries.push({ ...value.entries[0]! }); assert.equal(validGitTreePage(value, 'project'), false);
  value.entries[1]!.name = 'different'; assert.equal(validGitTreePage(value, 'project'), false);
  value.entries[1]!.pathToken = randomUUID(); assert.equal(validGitTreePage(value, 'project'), true);
  value.entries = Array.from({ length: 201 }, (_, i) => ({ ...value.entries[0]!, name: `${i}`, pathToken: randomUUID() })); assert.equal(validGitTreePage(value, 'project'), false);
});
test('raw statuses are permitted only for actual files on supported pages', () => {
  const value = { ...page(), gitStatus: 'raw-bytes' };
  Object.assign(value.entries[0]!, { kind: 'file', indexStatus: 'modified', worktreeStatus: 'differs-from-index' });
  assert.equal(validGitTreePage(value, 'project'), true);
  value.gitStatus = 'unsupported'; assert.equal(validGitTreePage(value, 'project'), false);
  value.gitStatus = 'raw-bytes'; value.entries[0]!.kind = 'symlink'; assert.equal(validGitTreePage(value, 'project'), false);
});
test('preview comparisons reject malformed states and unbounded diffs', () => {
  const pathToken = randomUUID(), base = { repositoryRef: 'project', pathToken, name: 'file.txt', text: 'new',
    bytes: 3, contentHash: 'a'.repeat(64), observedAt: 1, consistency: 'best_effort' };
  assert.equal(validGitFilePreview(base, 'project', pathToken), true);
  for (const diff of [null, '', '-old\n+new']) assert.equal(validGitFilePreview({ ...base,
    comparison: { indexStatus: 'unchanged', worktreeStatus: 'differs-from-index', diff } }, 'project', pathToken), true);
  for (const comparison of [null, [], {}, { indexStatus: 'clean', worktreeStatus: 'unknown', diff: null },
    { indexStatus: 'unknown', worktreeStatus: 'clean', diff: '' },
    { indexStatus: 'unknown', worktreeStatus: 'unknown', diff: 'a'.repeat(131073) }])
    assert.equal(validGitFilePreview({ ...base, comparison }, 'project', pathToken), false);
});
