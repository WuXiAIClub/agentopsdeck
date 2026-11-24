import test from 'node:test';
import assert from 'node:assert/strict';
import { currentLayoutKey, layoutSnapshot, parseCurrentLayout } from './current-layout.js';
import { emptyWorkspace, floatWorkspacePane, presetWorkspace } from './workspace-layout.js';

test('current layout roundtrips split ratios, floating geometry, active pane and collapse', () => {
  const panes = Array.from({ length: 8 }, (_, i) => ({ id: `p${i}`, sessionKey: `s${i}` }));
  let workspace = presetWorkspace(panes.slice(0, 6), 'grid');
  workspace = { ...workspace, panes, floating: panes.slice(6).map(pane => ({ id: pane.id, x: .1, y: .2, width: .4, height: .5 })), active: 'p7' };
  if (workspace.dock?.kind === 'split') workspace.dock.ratio = .6;
  const snapshot = layoutSnapshot(workspace, new Set(['s7', 's0', 'missing']));
  assert.deepEqual(snapshot.collapsedKeys, ['s7']);
  assert.deepEqual(parseCurrentLayout(JSON.stringify(snapshot)), snapshot);
  assert.notEqual(currentLayoutKey('alice'), currentLayoutKey('bob'));
  assert.equal(currentLayoutKey(undefined), undefined);
});

test('empty workspace persists without resurrecting old panes; corrupted/unbounded storage is ignored', () => {
  const empty = layoutSnapshot(emptyWorkspace(), new Set());
  assert.deepEqual(parseCurrentLayout(JSON.stringify(empty)), empty);
  for (const raw of [null, '', '{', '{}', 'null', '[]', 'x'.repeat(65_537), JSON.stringify({ ...empty, workspace: { ...empty.workspace, version: 3 } })]) {
    assert.equal(parseCurrentLayout(raw), undefined);
  }
  const base = presetWorkspace([{ id: 'a', sessionKey: 'a' }], 'single');
  const invalid = layoutSnapshot({ ...base, active: 'unknown' }, new Set());
  assert.equal(parseCurrentLayout(JSON.stringify(invalid)), undefined);
});

test('restoring current layout retains unavailable identities without storing session content', () => {
  const workspace = floatWorkspacePane(presetWorkspace([{ id: 'a', sessionKey: 'remote:a' }, { id: 'b', sessionKey: 'remote:b' }], 'columns'), 'b', { x: .2, y: .3, width: .4, height: .5 });
  const stored = JSON.stringify(layoutSnapshot(workspace, new Set(['remote:b'])));
  assert.deepEqual(parseCurrentLayout(stored)?.workspace, workspace);
  assert.deepEqual(Object.keys(JSON.parse(stored)).sort(), ['collapsedKeys', 'id', 'name', 'workspace']);
});
