import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspacePreferencesStore, workspacePreferencesSchema } from './workspace-preferences.js';

test('workspace preferences are per-user, versioned and independent of connector resources', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const store = new WorkspacePreferencesStore(db);
    const first = { revision: 0, groups: [{ id: 'work', name: ' Work ' }], sessions: { 'remote:thread': { groupId: 'work', color: '#abcdef', order: 1, tags: ['前端', 'release'] } } };
    assert.equal(store.save('alice', first)?.revision, 1);
    assert.deepEqual(store.get('bob'), { revision: 0, groups: [], sessions: {} });
    assert.equal(store.save('alice', first), undefined, 'stale initial save cannot overwrite');
    assert.equal(store.get('alice').groups[0]?.name, 'Work');
    assert.deepEqual(store.get('alice').sessions['remote:thread']?.tags, ['前端', 'release']);
    assert.equal(store.save('alice', { revision: 1, groups: [], sessions: {} })?.revision, 2);
    assert.equal(store.save('alice', { ...first, revision: 1 }), undefined);
    assert.equal(new WorkspacePreferencesStore(db).get('alice').revision, 2);
  } finally { db.close(); }
});
test('session tags are bounded plain labels, not grants or arbitrary metadata', () => {
  const value = (tags: unknown) => ({ revision: 0, groups: [], sessions: { key: { tags } } });
  for (const tags of [[], ['文', 'x'.repeat(32)], ['<script>text</script>']]) assert.equal(workspacePreferencesSchema.safeParse(value(tags)).success, true);
  for (const tags of [null, 'tag', [''], [' x'], ['x', 'x'], ['x\n'], ['a,b'], ['a，b'], ['x'.repeat(33)], Array.from({ length: 9 }, (_, i) => `${i}`), [null]]) {
    assert.equal(workspacePreferencesSchema.safeParse(value(tags)).success, false);
  }
  assert.equal(workspacePreferencesSchema.safeParse({ revision: 0, groups: [], sessions: { key: { tags: ['work'], grants: ['*'] } } }).success, false);
});
test('workspace validation bounds data and rejects CSS injection, foreign groups and ambiguous IDs', () => {
  const empty = { revision: 0, groups: [], sessions: {} };
  for (const value of [
    { ...empty, userId: 'another-user' },
    { ...empty, ungroupedCollapsed: 'true' },
    { ...empty, sessions: { key: { color: 'url(evil)' } } },
    { ...empty, sessions: { key: { groupId: 'missing' } } },
    { ...empty, sessions: JSON.parse('{"__proto__": {"color":"#ffffff"}}') },
    { ...empty, groups: [{ id: 'x', name: 'a' }, { id: 'x', name: 'b' }] },
    { ...empty, groups: [{ id: 'x', name: ' ' }] },
    { ...empty, revision: -1 },
    { ...empty, sessions: { key: { order: Infinity } } },
  ]) assert.equal(workspacePreferencesSchema.safeParse(value).success, false);
});

test('workspace preferences survive closing and reopening a physical SQLite database', () => {
  const directory = mkdtempSync(join(tmpdir(), 'workspace-reopen-'));
  const file = join(directory, 'workspace.sqlite');
  let db = new DatabaseSync(file);
  try {
    const value = { revision: 0, ungroupedCollapsed: true, groups: [{ id: 'work', name: '工作', collapsed: true }], sessions: { 'opaque/session': { groupId: 'work', color: '#abc123', order: 2 } } };
    new WorkspacePreferencesStore(db).save('alice', value);
    db.close(); db = new DatabaseSync(file);
    assert.deepEqual(new WorkspacePreferencesStore(db).get('alice'), { ...value, revision: 1 });
    assert.deepEqual(new WorkspacePreferencesStore(db).get('bob'), { revision: 0, groups: [], sessions: {} });
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});
