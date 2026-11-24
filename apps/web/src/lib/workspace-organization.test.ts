import test from 'node:test';
import assert from 'node:assert/strict';
import type { WorkspacePreferences } from '@agentopsdeck/shared';
import { moveWorkspaceSession, reorderWorkspaceSession, moveWorkspaceGroup, removeWorkspaceGroup } from './workspace-organization.js';

const fixture = (): WorkspacePreferences => ({ revision: 4, groups: [{ id: 'work', name: 'Work' }], sessions: {
  a: { order: 0 }, b: { order: 1, color: '#ffffff' }, c: { groupId: 'work', order: 0 }, d: { groupId: 'work', order: 1 },
} });
test('flat reorder persists order without changing group or color', () => {
  const source = fixture();
  const next = reorderWorkspaceSession(source, 'd', 'a');
  assert.equal(next.sessions.d?.order, 0);
  assert.equal(next.sessions.d?.groupId, 'work');
  assert.equal(next.sessions.b?.color, '#ffffff');
  assert.equal(reorderWorkspaceSession(next, 'd').sessions.d?.order, 3);
  assert.deepEqual(source, fixture());
});
test('moving between groups preserves style and produces deterministic order without changing input', () => {
  const source = fixture();
  const next = moveWorkspaceSession(source, 'b', 'work', 'd');
  assert.deepEqual(next.sessions.b, { color: '#ffffff', groupId: 'work', order: 1 });
  assert.equal(next.sessions.d?.order, 2);
  assert.deepEqual(source, fixture());
  assert.equal(moveWorkspaceSession(next, 'b').sessions.b?.groupId, undefined);
  assert.deepEqual(moveWorkspaceSession(source, 'b', 'unknown'), source);
});
test('removing a group ungroups sessions rather than deleting them or their colors', () => {
  const source = moveWorkspaceSession(fixture(), 'b', 'work');
  const next = removeWorkspaceGroup(source, 'work');
  assert.equal(next.groups.length, 0);
  assert.equal(Object.keys(next.sessions).length, 4);
  assert.deepEqual(next.sessions.b, { color: '#ffffff' });
  assert.equal(source.groups.length, 1);
});

test('dropping a card on itself is a no-op, not a move to the end', () => {
  const source = fixture();
  assert.equal(moveWorkspaceSession(source, 'a', undefined, 'a'), source);
  assert.equal(moveWorkspaceSession(source, 'c', 'work', 'c'), source);
});

test('group reorder is stable, ignores stale targets and leaves sessions untouched', () => {
  const source = fixture(); source.groups.push({ id: 'b', name: 'B' }, { id: 'c', name: 'C' });
  assert.deepEqual(moveWorkspaceGroup(source, 'c', 'work').groups.map(group => group.id), ['c', 'work', 'b']);
  assert.deepEqual(moveWorkspaceGroup(source, 'work').groups.map(group => group.id), ['b', 'c', 'work']);
  assert.deepEqual(moveWorkspaceGroup(source, 'work').sessions, source.sessions);
  assert.equal(moveWorkspaceGroup(source, 'work', 'unknown'), source);
  assert.equal(moveWorkspaceGroup(source, 'work', 'work'), source);
  assert.deepEqual(source.groups.map(group => group.id), ['work', 'b', 'c']);
});
