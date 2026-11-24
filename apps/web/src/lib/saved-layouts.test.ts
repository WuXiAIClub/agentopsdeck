import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSavedLayouts, restoreSavedLayout, savedLayoutKey, validWorkspace, updateSavedLayout, layoutFingerprint, undoSavedLayoutUpdate, reorderSavedLayouts, areSavedLayoutsEquivalent, mergeSavedLayouts } from './saved-layouts.js';
import { arrangeDock, emptyWorkspace, floatWorkspacePane, presetWorkspace } from './workspace-layout.js';
const base = presetWorkspace(['a', 'b', 'c', 'd'].map(id => ({ id, sessionKey: `session:${id}` })), 'grid');
const saved = { id: 'saved', name: 'Work', workspace: base, collapsedKeys: [] };
test('tab reorder preserves identity, geometry and newer metadata, no-ops on unknown IDs', () => {
  const items = ['a', 'b', 'c'].map(id => ({ ...saved, id, name: `new-${id}` }));
  const next = reorderSavedLayouts(items, 'a', 'c');
  assert.deepEqual(next.map(row => row.id), ['b', 'c', 'a']);
  assert.equal(next[2], items[0]);
  assert.deepEqual(items.map(row => row.id), ['a', 'b', 'c']);
  assert.deepEqual(reorderSavedLayouts(next, 'a', 'b'), items);
  assert.equal(reorderSavedLayouts(items, 'gone', 'b'), items);
  assert.equal(reorderSavedLayouts(items, 'b', 'b'), items);
  assert.deepEqual(parseSavedLayouts(JSON.stringify(next)), next);
});
test('named blank canvases round-trip without accepting malformed or unavailable layouts', () => {
  const blank = { ...saved, workspace: emptyWorkspace() };
  assert.deepEqual(parseSavedLayouts(JSON.stringify([blank])), [blank]);
  assert.deepEqual(restoreSavedLayout(blank, new Set(), base), { workspace: emptyWorkspace(), missing: 0 });
  assert.equal(restoreSavedLayout(saved, new Set(), base).workspace, null);
  for (const workspace of [{ ...blank.workspace, active: 'ghost' }, { ...blank.workspace, dock: { kind: 'empty', id: 'vacancy:ghost' } }, { ...blank.workspace, floating: [{ id: 'ghost' }] }]) assert.equal(validWorkspace(workspace), false);
  assert.deepEqual(updateSavedLayout([saved], saved.id, blank.workspace, new Set())[0]?.workspace, blank.workspace);
});
test('layout dirty tracking ignores focus, host remapping, float stack and stale collapse keys', () => {
  const workspace = floatWorkspacePane(floatWorkspacePane(base, 'c'), 'd');
  const restored = restoreSavedLayout({ ...saved, workspace }, new Set(base.panes.map(p => p.sessionKey!)), emptyWorkspace()).workspace!;
  restored.active = restored.panes[1]!.id;
  restored.floating.reverse(); restored.panes.reverse();
  const collapsed = new Set(['session:c']);
  assert.equal(layoutFingerprint(workspace, collapsed), layoutFingerprint(restored, new Set(['session:c', 'gone', 'session:a'])));
  assert.notEqual(layoutFingerprint(workspace, collapsed), layoutFingerprint(workspace, new Set()));
  restored.floating[0]!.x += .01;
  assert.notEqual(layoutFingerprint(workspace, collapsed), layoutFingerprint(restored, collapsed));
});
test('layout dirty tracking detects resize, docking, cards and dock vacancies', () => {
  const signature = layoutFingerprint(base, new Set());
  for (const current of [
    { ...base, panes: base.panes.map((p, i) => i ? p : { ...p, dockFrame: { x: 0, y: 0, width: .3, height: .5 } }) },
    { ...base, panes: base.panes.map((p, i) => i ? p : { ...p, dockSize: { width: .3, height: .5 } }) },
    { ...base, dock: arrangeDock(base.panes.map(p => p.id), 'columns') },
    { ...base, panes: base.panes.map((p, i) => i ? p : { id: p.id, kind: 'dashboard' as const, resourceId: 'overview' as const }) },
    floatWorkspacePane(base, 'a'),
  ]) assert.notEqual(layoutFingerprint(current, new Set()), signature);
  const gap = { ...base, dock: { kind: 'split' as const, axis: 'horizontal' as const, ratio: .5, first: base.dock!, second: { kind: 'empty' as const, id: 'vacancy:a' } } };
  assert.notEqual(layoutFingerprint(gap, new Set()), signature);
  assert.equal(layoutFingerprint(gap, new Set()), layoutFingerprint({ ...gap, dock: { ...gap.dock, second: { kind: 'empty', id: 'vacancy:b' } } }, new Set()));
});
test('update undo preserves later names, other snapshots and rejects concurrent geometry edits or deletion', () => {
  const other = { ...saved, id: 'other' };
  const updated = updateSavedLayout([saved, other], saved.id, floatWorkspacePane(base, 'a'), new Set(['session:a']));
  const written = updated[0]!;
  const undone = undoSavedLayoutUpdate([{ ...written, name: 'Renamed' }, other], saved, written)!;
  assert.equal(undone[0]!.name, 'Renamed');
  assert.deepEqual(undone[0]!.workspace, base);
  assert.equal(undone[1], other);
  assert.equal(undoSavedLayoutUpdate([other], saved, written), null);
  assert.equal(undoSavedLayoutUpdate(updateSavedLayout(updated, saved.id, base, new Set()), saved, written), null);
  undone[0]!.workspace.panes[0]!.id = 'changed';
  assert.notEqual(saved.workspace.panes[0]!.id, 'changed');
});
test('six docked and two floating panes survive saving/updating/restoring with stable existing hosts', () => {
  const panes = 'abcdefgh'.split('').map(id => ({ id, sessionKey: `session:${id}` }));
  const workspace = { ...base, panes, dock: arrangeDock(panes.slice(0, 6).map(p => p.id), 'grid'), floating: panes.slice(6).map(({ id }) => ({ id, x: .1, y: .1, width: .5, height: .5 })) };
  const updated = updateSavedLayout([saved], saved.id, workspace, new Set(['session:h']));
  const parsed = parseSavedLayouts(JSON.stringify(updated));
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0]!.workspace, workspace);
  const result = restoreSavedLayout(parsed[0]!, new Set(panes.map(p => p.sessionKey)), workspace);
  assert.deepEqual(result.workspace, workspace);
  assert.equal(validWorkspace({ ...workspace, dock: arrangeDock(panes.slice(0, 7).map(p => p.id), 'columns'), floating: workspace.floating.slice(1) }), true);
  assert.equal(validWorkspace({ ...workspace, dock: arrangeDock(panes.slice(0, 5).map(p => p.id), 'columns'), floating: [...workspace.floating, { ...workspace.floating[0]!, id: 'f' }] }), true);
  assert.equal(validWorkspace({ ...workspace, dock: arrangeDock(panes.slice(0, 6).map(p => p.id), 'columns') }), true, 'valid skewed six-pane tree is not rejected by old four-level bound');
});
test('updating a layout preserves names/other layouts and detaches mutable geometry', () => {
  const current = structuredClone(base), other = { ...saved, id: 'other' };
  const updated = updateSavedLayout([saved, other], saved.id, current, new Set(['session:a', 'gone']));
  assert.equal(updated[0]!.name, 'Work');
  assert.equal(updated[1], other);
  assert.deepEqual(updated[0]!.collapsedKeys, ['session:a']);
  current.panes[0]!.sessionKey = 'changed';
  assert.equal(updated[0]!.workspace.panes[0]!.sessionKey, 'session:a');
  assert.equal(validWorkspace(updated[0]!.workspace), true);
  assert.deepEqual(updateSavedLayout([saved], 'removed', base, new Set()), [saved]);
});
test('saved layouts reject malformed, recursive and duplicate identity/geometry data', () => {
  assert.equal(validWorkspace(base), true);
  for (const raw of [null, '{', '{}', 'null', '[null]', '[{"workspace":{}}]']) assert.deepEqual(parseSavedLayouts(raw), []);
  assert.equal(parseSavedLayouts(JSON.stringify([saved, saved])).length, 1);
  for (const workspace of [{ ...base, version: 9 }, { ...base, panes: [...base.panes, base.panes[0]] }, { ...base, floating: [{ id: 'a', x: 0, y: 0, width: .5, height: .5 }] }, { ...base, active: 'unknown' }, { ...base, dock: { kind: 'split', ratio: NaN } }]) assert.equal(validWorkspace(workspace), false);
  const recursive: any = { kind: 'split', axis: 'horizontal', ratio: .5, second: base.dock }; recursive.first = recursive;
  assert.equal(validWorkspace({ ...base, dock: recursive }), false);
  assert.notEqual(savedLayoutKey('alice'), savedLayoutKey('bob'));
  assert.equal(savedLayoutKey(undefined), undefined);
});
test('restore keeps active editor identity, floats, skips inaccessible sessions and rejects an empty result', () => {
  const floating = floatWorkspacePane(base, 'd', { x: .3, y: .2, width: .5, height: .6 });
  assert.equal(validWorkspace(floating), true);
  const current = presetWorkspace([{ id: 'existing', sessionKey: 'session:a' }], 'single');
  const result = restoreSavedLayout({ ...saved, workspace: floating }, new Set(['session:a', 'session:c', 'session:d']), current);
  assert.equal(result.missing, 1);
  assert.equal(validWorkspace(result.workspace), true);
  assert.equal(result.workspace?.panes.find(p => p.sessionKey === 'session:a')?.id, 'existing');
  assert.equal(result.workspace?.floating.length, 1);
  assert.equal(result.workspace?.floating[0]?.x, .3);
  assert.equal(restoreSavedLayout(saved, new Set(), current).workspace, null);
  assert.equal(saved.workspace.panes.length, 4, 'restore never changes saved source');
});
test('saved layouts support four docked plus two floating and restore a float-only remainder', () => {
  const six = { ...base, panes: [...base.panes, { id: 'e', sessionKey: 'session:e' }, { id: 'f', sessionKey: 'session:f' }], floating: ['e', 'f'].map(id => ({ id, x: .2, y: .2, width: .5, height: .5 })) };
  assert.equal(validWorkspace(six), true);
  assert.equal(parseSavedLayouts(JSON.stringify([{ ...saved, workspace: six }])).length, 1);
  const result = restoreSavedLayout({ ...saved, workspace: six }, new Set(['session:f']), base);
  assert.equal(result.missing, 5);
  assert.equal(validWorkspace(result.workspace), true);
  assert.equal(result.workspace?.panes[0]?.sessionKey, 'session:f');
  assert.equal(result.workspace?.dock, null);
  assert.equal(result.workspace?.floating.length, 1);
});
test('saved layout equivalence ignores pane focus/order churn and 3-way merge reconciles disjoint edits', () => {
  const layoutA = { id: 'layout-a', name: 'Alpha', workspace: base, collapsedKeys: [] };
  const layoutAFocusChanged = {
    ...layoutA,
    workspace: { ...base, active: 'c', panes: [...base.panes].reverse() },
  };
  assert.equal(
    areSavedLayoutsEquivalent(JSON.stringify([layoutA]), JSON.stringify([layoutAFocusChanged])),
    true,
  );

  const columnsWs = { ...base, dock: arrangeDock(base.panes.map(p => p.id), 'columns') };
  const layoutB = { id: 'layout-b', name: 'Beta', workspace: columnsWs, collapsedKeys: [] };
  const layoutC = { id: 'layout-c', name: 'Gamma', workspace: emptyWorkspace(), collapsedKeys: [] };

  // Initial boot without base merges disjoint IDs cleanly
  const bootMergedRaw = mergeSavedLayouts({
    local: JSON.stringify([layoutA, layoutC]),
    remote: JSON.stringify([layoutA, layoutB]),
    base: undefined,
    initialBoot: true,
  });
  assert.ok(bootMergedRaw);
  assert.deepEqual(parseSavedLayouts(bootMergedRaw).map(item => item.id), ['layout-a', 'layout-b', 'layout-c']);

  // 3-way merge: editing layout A locally while editing layout B remotely merges both edits
  const baseRaw = JSON.stringify([layoutA, layoutB]);
  const localEditedA = { ...layoutA, name: 'Alpha v2' };
  const remoteEditedB = { ...layoutB, name: 'Beta v2' };
  const mergedDisjointEdits = mergeSavedLayouts({
    base: baseRaw,
    local: JSON.stringify([localEditedA, layoutB, layoutC]),
    remote: JSON.stringify([layoutA, remoteEditedB]),
  });
  assert.ok(mergedDisjointEdits);
  const parsedMerged = parseSavedLayouts(mergedDisjointEdits);
  assert.deepEqual(
    parsedMerged.map(item => [item.id, item.name]),
    [['layout-a', 'Alpha v2'], ['layout-b', 'Beta v2'], ['layout-c', 'Gamma']],
  );

  // Deleting an unchanged layout on one device omits it cleanly
  const deletedUnchanged = mergeSavedLayouts({
    base: baseRaw,
    local: JSON.stringify([layoutB]),
    remote: JSON.stringify([layoutA, remoteEditedB]),
  });
  assert.ok(deletedUnchanged);
  assert.deepEqual(
    parseSavedLayouts(deletedUnchanged).map(item => [item.id, item.name]),
    [['layout-b', 'Beta v2']],
  );

  // Deleting on one device while modifying on the other returns null (explicit conflict)
  assert.equal(
    mergeSavedLayouts({
      base: baseRaw,
      local: JSON.stringify([layoutB]),
      remote: JSON.stringify([ { ...layoutA, name: 'Modified Remotely' }, layoutB ]),
    }),
    null,
  );

  // Concurrently modifying the same layout differently returns null (explicit conflict)
  assert.equal(
    mergeSavedLayouts({
      base: baseRaw,
      local: JSON.stringify([{ ...layoutA, name: 'Local Name' }, layoutB]),
      remote: JSON.stringify([{ ...layoutA, name: 'Remote Name' }, layoutB]),
    }),
    null,
  );
});
