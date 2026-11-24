import test from 'node:test';
import assert from 'node:assert/strict';
import { arrangeDock, equalizeDock, projectDock, resizeDock, fitFloating, presetWorkspace, dockPaneIds, floatWorkspacePane, dockWorkspacePane, closeWorkspacePane, restoreWorkspace, findDockDrop, placeWorkspacePane, insertWorkspacePane, previewSessionCardDrop, type WorkspacePreset } from './workspace-layout.js';
import { emptyWorkspace, openResourcePane, withinWorkspaceBudget, canPlaceWorkspacePane, type SessionWorkspace } from './workspace-layout.js';
import { dockSubagentCompanionPane } from './workspace-layout.js';
import { validWorkspace, parseSavedLayouts } from './saved-layouts.js';
import { fitDockPane, resizeDockPane, selectWorkspaceSession, findWorkspaceDrop } from './workspace-layout.js';
const panes = ['a', 'b', 'c', 'd'].map(id => ({ id, sessionKey: `connector:codex:${id}` }));
const allowed = new Set(panes.map(pane => pane.sessionKey));
const eight = 'abcdefgh'.split('').map(id => ({ id, sessionKey: `connector:codex:${id}` }));
test('ordinary session docks into split or free-frame space without replacing existing hosts', () => {
  const initial = presetWorkspace(panes.slice(0, 2), 'columns');
  const splitNext = selectWorkspaceSession(initial, panes[2]!.sessionKey, panes[0]!.sessionKey, 'new', 1600, 1000);
  assert.equal(splitNext.floating.length, 0);
  assert.deepEqual(dockPaneIds(splitNext.dock), ['a', 'new', 'b']);
  assert.equal(splitNext.panes[0], initial.panes[0]);
  assert.equal(splitNext.panes[1], initial.panes[1]);
  assert.equal(splitNext.active, 'new');
  assert.equal(validWorkspace(splitNext), true);

  const layout = { ...initial, panes: initial.panes.map(pane => ({ ...pane, dockFrame: { x: .1, y: .1, width: .3, height: .6 } })) };
  const next = selectWorkspaceSession(layout, panes[2]!.sessionKey, panes[0]!.sessionKey, 'new', 1600, 1000);
  assert.equal(next.panes[0], layout.panes[0]);
  assert.equal(next.panes[1], layout.panes[1]);
  assert.equal(next.floating.length, 0);
  assert.ok(dockPaneIds(next.dock).includes('new'));
  assert.ok(next.panes[2]?.dockFrame);
  assert.equal(next.active, 'new');
  assert.equal(validWorkspace(next), true);
  const again = selectWorkspaceSession(next, panes[2]!.sessionKey, undefined, 'duplicate', 1600, 1000);
  assert.equal(again.panes, next.panes);
  assert.equal(again.floating.length, 0);
  assert.equal(again.active, 'new');
});
test('empty workspace docks first 12 sessions, cascades overflow into floating, and never evicts at capacity', () => {
  let layout = emptyWorkspace();
  for (let i = 0; i < 12; i++) layout = selectWorkspaceSession(layout, `s${i}`, undefined, `p${i}`, 1600, 1000);
  assert.equal(dockPaneIds(layout.dock).length, 12);
  assert.equal(layout.floating.length, 0);
  for (let i = 12; i < 16; i++) layout = selectWorkspaceSession(layout, `s${i}`, undefined, `p${i}`, 1600, 1000);
  assert.equal(dockPaneIds(layout.dock).length, 12);
  assert.equal(layout.floating.length, 4);
  assert.equal(new Set(layout.floating.map(pane => pane.x)).size, 4);
  assert.equal(validWorkspace(layout), true);
  assert.equal(selectWorkspaceSession(layout, 'overflow', undefined, 'overflow', 1600, 1000), layout);
  assert.equal(selectWorkspaceSession(layout, 'duplicate', undefined, 'p0', 1600, 1000), layout);
  const focused = selectWorkspaceSession(layout, 's12', undefined, 'unused', 1600, 1000);
  assert.equal(focused.active, 'p12');
  assert.equal(focused.floating.at(-1)?.id, 'p12');
  assert.equal(focused.panes, layout.panes);
});
test('new sidebar sessions fill resized blank height/width without moving neighbors', () => {
  for (const axis of ['height', 'width'] as const) {
    const initial = presetWorkspace(panes.slice(0, 2), 'columns');
    const layout = { ...initial, panes: initial.panes.map(p => p.id === 'a' ? { ...p, dockSize: { width: 1, height: 1, [axis]: .5 } } : p) };
    const before = projectDock(layout.dock, 1800, 1200).panes;
    const shown = fitDockPane(before.get('a')!, layout.panes[0]!.dockSize);
    const x = axis === 'width' ? shown.width + 100 : 100, y = axis === 'height' ? shown.height + 100 : 100;
    const preview = previewSessionCardDrop(layout, panes[2]!.sessionKey, 'c', x, y, 1800, 1200);
    assert.equal(preview.blocked, false);
    const after = projectDock(preview.layout.dock, 1800, 1200).panes;
    assert.deepEqual(after.get('b'), before.get('b'));
    const retained = fitDockPane(after.get('a')!, preview.layout.panes[0]!.dockSize);
    for (const key of ['x', 'y', 'width', 'height'] as const) assert.ok(Math.abs(retained[key] - shown[key]) < 0.001);
    assert.ok(Math.abs(after.get('c')![axis === 'height' ? 'y' : 'x'] - shown[axis] - 10) < 0.001);
    assert.equal(validWorkspace(preview.layout), true);
    assert.deepEqual(restoreWorkspace(preview.layout, allowed), preview.layout);
  }
});
test('moving an existing pane to blank space keeps its source vacant and clears its old preferred size', () => {
  const initial = presetWorkspace(panes.slice(0, 2), 'columns');
  const layout = { ...initial, panes: initial.panes.map(p => ({ ...p, dockSize: { width: 1, height: .5 } })) };
  const drop = findWorkspaceDrop(layout, 'b', 100, 800, 1800, 1200)!;
  assert.equal(drop.side, 'bottom'); assert.ok(drop.slack);
  const placed = placeWorkspacePane(layout, 'b', drop);
  const projection = projectDock(placed.dock, 1800, 1200);
  assert.equal(projection.panes.get('a')!.width, 895);
  assert.equal(projection.empty.size, 1);
  assert.equal(placed.panes.find(p => p.id === 'b')!.dockSize, undefined);
  assert.equal(validWorkspace(placed), true);
  assert.equal(new Set(dockPaneIds(placed.dock)).size, 2);
});
test('undersized blanks do not create slack drops and nonfinite coordinates are ignored', () => {
  const initial = presetWorkspace(panes.slice(0, 1), 'single');
  const layout = { ...initial, panes: initial.panes.map(p => ({ ...p, dockSize: { width: .9, height: .9 } })) };
  assert.equal(findWorkspaceDrop(layout, 'c', 500, 950, 1000, 1000)?.slack, undefined);
  assert.equal(findWorkspaceDrop(layout, 'c', NaN, 950, 1000, 1000), undefined);
});
test('a single pane can leave blank height without changing neighbors, with bounded persistent geometry', () => {
  const layout = presetWorkspace(panes.slice(0, 3), 'left-stack');
  const resized = resizeDockPane(layout, 'a', { width: .8, height: .55 });
  assert.equal(resized.dock, layout.dock);
  assert.equal(resized.panes[1], layout.panes[1]);
  const rect = projectDock(layout.dock, 1500, 1000).panes.get('a')!;
  assert.equal(fitDockPane(rect, resized.panes[0]!.dockSize).height, 550);
  assert.deepEqual(restoreWorkspace(resized, allowed), resized);
  const replaced = selectWorkspaceSession(resized, 'replacement', panes[0]!.sessionKey, 'unused', 1500, 1000);
  assert.deepEqual(replaced.panes[0]!.dockSize, resized.panes[0]!.dockSize, 'size belongs to the layout slot, not its session');
  assert.equal(validWorkspace(resized), true);
  assert.equal(fitDockPane({ x: 0, y: 0, width: 350, height: 400 }, { width: .1, height: .1 }).height, 288);
  for (const width of [0, -1, NaN, Infinity]) assert.equal(resizeDockPane(layout, 'a', { width, height: .5 }), layout);
  const invalid = { ...resized, panes: resized.panes.map(p => ({ ...p, dockSize: { width: Infinity, height: 1 } })) };
  assert.equal(validWorkspace(invalid), false);
  assert.equal(restoreWorkspace(invalid, allowed), undefined);
});
test('large generated layouts restore and keep usable equal widths without percentage clipping', () => {
  const sessions = Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, sessionKey: `session:${i}` }));
  for (const preset of ['columns', 'rows', 'grid'] as const) {
    const layout = { ...presetWorkspace(sessions, 'grid'), dock: arrangeDock(sessions.map(p => p.id), preset) };
    assert.deepEqual(restoreWorkspace(layout, new Set(sessions.map(p => p.sessionKey))), layout);
    assert.equal(validWorkspace(layout), true);
    const rects = [...projectDock(layout.dock, 4800, 4800).panes.values()];
    assert.equal(rects.length, 12);
    for (const rect of rects) assert.ok(rect.width >= 300 && rect.height >= 360);
    assert.ok(Math.max(...rects.map(r => r.width)) - Math.min(...rects.map(r => r.width)) < 25);
  }
});
test('12 docked plus 4 floating sessions keep a separate notebook budget across placement and storage', () => {
  const sessions = Array.from({ length: 16 }, (_, i) => ({ id: `s${i}`, sessionKey: `session:${i}` }));
  let layout: SessionWorkspace = presetWorkspace(sessions.slice(0, 12), 'grid');
  for (const pane of sessions.slice(12)) layout = floatWorkspacePane({ ...layout, panes: [...layout.panes, pane] }, pane.id);
  const keys = new Set(sessions.map(p => p.sessionKey));
  assert.equal(dockPaneIds(layout.dock).length, 12);
  assert.equal(layout.floating.length, 4);
  assert.deepEqual(restoreWorkspace(layout, keys), layout);
  assert.equal(floatWorkspacePane(layout, 's0'), layout, 'fifth floating session rejected');
  assert.equal(insertWorkspacePane(layout, 's12', 2600, 1800, 'grid'), layout, 'thirteenth docked session rejected');
  assert.equal(previewSessionCardDrop(layout, 'extra', 'extra', 1000, 500, 2600, 1800).layout, layout);
  layout = openResourcePane(layout, { id: 'note', kind: 'notebook', target: 'session', resourceId: sessions[0]!.sessionKey }, 2600, 1800);
  assert.equal(layout.panes.length, 17, 'note does not consume a session slot');
  assert.equal(dockPaneIds(layout.dock).length, 13);
  assert.equal(layout.floating.length, 4);
  assert.equal(canPlaceWorkspacePane(layout, 'note', true), true);
  layout = floatWorkspacePane(layout, 'note');
  assert.equal(layout.floating.length, 5, 'four chats plus a notebook');
  assert.equal(withinWorkspaceBudget(layout), true);
  assert.equal(validWorkspace(layout), true);
  assert.deepEqual(restoreWorkspace(layout, keys), layout);
  assert.equal(parseSavedLayouts(JSON.stringify([{ id: 'saved', name: 'Full', workspace: layout, collapsedKeys: [] }])).length, 1);
  const overflow = { ...layout, dock: arrangeDock(sessions.slice(1, 12).map(p => p.id), 'grid'), floating: [...layout.floating, { id: 's0', x: 0, y: 0, width: .4, height: .5 }] };
  assert.equal(validWorkspace(overflow), false);
  assert.equal(restoreWorkspace(overflow, keys), undefined);
  assert.equal(parseSavedLayouts(JSON.stringify([{ id: 'bad', name: 'Overflow', workspace: overflow, collapsedKeys: [] }])).length, 0);
});
test('resource DOM bound cannot consume or increase the independent session budget', () => {
  let layout = emptyWorkspace();
  for (let i = 0; i < 16; i++) layout = openResourcePane(layout, { id: `n${i}`, kind: 'notebook', target: 'session', resourceId: `session:${i}` }, 2600, 1800);
  assert.equal(layout.panes.length, 16);
  assert.equal(dockPaneIds(layout.dock).length, 16);
  assert.equal(layout.floating.length, 0);
  assert.equal(openResourcePane(layout, { id: 'overflow', kind: 'notebook', target: 'session', resourceId: 'extra' }, 2600, 1800), layout);
  const session = { id: 'chat', sessionKey: 'session:0' };
  const added = insertWorkspacePane({ ...layout, panes: [...layout.panes, session] }, session.id, 2600, 1800, 'grid');
  assert.equal(dockPaneIds(added.dock).length, 17);
  assert.ok(dockPaneIds(added.dock).includes('chat'));
  assert.equal(added.floating.length, 0);
  assert.equal(validWorkspace(added), true);
});
test('default docking handles unmeasured viewports, fills vacancies first, and builds balanced 2x2 grids', () => {
  const unmeasured = selectWorkspaceSession(emptyWorkspace(), 's0', undefined, 'initial', 0, 0);
  assert.deepEqual(dockPaneIds(unmeasured.dock), ['initial']);
  assert.equal(unmeasured.floating.length, 0);

  let layout = emptyWorkspace();
  for (let i = 0; i < 4; i++) layout = selectWorkspaceSession(layout, `s${i}`, undefined, `p${i}`, 1200, 900);
  const projected = projectDock(layout.dock, 1200, 900).panes;
  assert.equal(projected.size, 4);
  for (const rect of projected.values()) {
    assert.ok(rect.width >= 320 && rect.height >= 288, `expected balanced cell, got ${rect.width}x${rect.height}`);
  }

  const sole = floatWorkspacePane(presetWorkspace(panes.slice(0, 1), 'single'), 'a');
  const withVacancy = placeWorkspacePane(sole, 'a', { target: null, side: 'left' });
  assert.equal(projectDock(withVacancy.dock, 1200, 900).empty.size, 1);
  const filled = openResourcePane(withVacancy, { id: 'board', kind: 'taskboard', resourceId: 'default' }, 1200, 900);
  assert.equal(projectDock(filled.dock, 1200, 900).empty.size, 0);
  assert.deepEqual(dockPaneIds(filled.dock), ['a', 'board']);
  assert.equal(filled.floating.length, 0);
});
test('six-pane grid is three columns in each of two rows, without changing existing four-pane order', () => {
  const six = presetWorkspace(eight.slice(0, 6), 'grid');
  const rects = projectDock(six.dock, 1520, 1000).panes;
  for (const row of [['a', 'b', 'c'], ['d', 'e', 'f']]) {
    const r = row.map(id => rects.get(id)!);
    assert.equal(r[0]!.y, r[1]!.y); assert.equal(r[1]!.y, r[2]!.y);
    assert.ok(r[0]!.x < r[1]!.x && r[1]!.x < r[2]!.x);
    assert.ok(Math.max(...r.map(p => p.width)) - Math.min(...r.map(p => p.width)) < 6);
  }
  assert.ok(rects.get('d')!.y > rects.get('a')!.y);
  assert.deepEqual(dockPaneIds(equalizeDock(six.dock)), eight.slice(0, 6).map(p => p.id));
  const old = projectDock(presetWorkspace(panes, 'grid').dock, 1520, 1000).panes;
  assert.equal(old.get('a')!.x, old.get('b')!.x, 'existing 2x2 remains column-major');
});
test('fifth and sixth sidebar drops work; six docked plus two floats roundtrip and enforce separate limits', () => {
  let layout = presetWorkspace(panes, 'grid');
  for (const pane of eight.slice(4, 6)) {
    const target = projectDock(layout.dock, 2000, 1200).panes.get('a')!;
    const drop = previewSessionCardDrop(layout, pane.sessionKey, pane.id, target.x + target.width - 5, target.y + target.height / 2, 2000, 1200);
    assert.equal(drop.blocked, false);
    layout = { ...drop.layout, dock: arrangeDock(dockPaneIds(drop.layout.dock), 'grid') };
  }
  for (const pane of eight.slice(6)) {
    const rect = projectDock(layout.dock, 2000, 1200).panes.get('a')!;
    const drop = previewSessionCardDrop(layout, pane.sessionKey, pane.id, rect.x + rect.width / 2, rect.y + rect.height / 2, 2000, 1200);
    assert.equal(drop.blocked, false);
    layout = drop.layout;
  }
  assert.equal(layout.panes.length, 8); assert.equal(layout.floating.length, 2);
  assert.equal(dockPaneIds(layout.dock).length, 6);
  assert.deepEqual(restoreWorkspace(layout, new Set(eight.map(p => p.sessionKey))), layout);
  assert.notEqual(floatWorkspacePane(layout, 'a'), layout, 'third float now allowed');
  assert.notEqual(dockWorkspacePane(layout, 'g', 'a', 'right'), layout, 'seventh dock now allowed');
  assert.notEqual(placeWorkspacePane(layout, 'g', { target: 'a', side: 'right' }), layout);
  assert.notEqual(insertWorkspacePane(layout, 'g', 2000, 1200, 'grid'), layout);
  assert.equal(previewSessionCardDrop(layout, 'ninth', 'ninth', 400, 300, 2000, 1200).blocked, false);
  assert.notEqual(floatWorkspacePane(layout, 'g'), layout, 'existing float may still move at capacity');
  assert.ok(restoreWorkspace({ ...layout, dock: arrangeDock(eight.slice(0, 7).map(p => p.id), 'grid'), floating: layout.floating.slice(1) }, new Set(eight.map(p => p.sessionKey))));
  assert.ok(restoreWorkspace({ ...layout, dock: arrangeDock(eight.slice(0, 5).map(p => p.id), 'grid'), floating: [...layout.floating, { ...layout.floating[0]!, id: 'f' }] }, new Set(eight.map(p => p.sessionKey))));
});
test('empty workspace edge drops reserve a half, restore, then accept a second session', () => {
  for (const x of [2, 1198]) {
    const first = previewSessionCardDrop(emptyWorkspace(), panes[0]!.sessionKey, 'a', x, 400, 1200, 900);
    assert.equal(first.blocked, false);
    const geometry = projectDock(first.layout.dock, 1200, 900);
    assert.equal(geometry.empty.size, 1);
    assert.ok(geometry.panes.get('a')!.width < 600);
    assert.deepEqual(restoreWorkspace(first.layout, allowed), first.layout);
    const blank = [...geometry.empty.values()][0]!;
    const second = previewSessionCardDrop(first.layout, panes[1]!.sessionKey, 'b', blank.x + blank.width / 2, 400, 1200, 900);
    assert.equal(second.blocked, false);
    assert.equal(projectDock(second.layout.dock, 1200, 900).empty.size, 0);
    assert.equal(second.layout.panes.length, 2);
    let moved = first.layout;
    for (let index = 0; index < 12; index++) {
      const [target] = projectDock(moved.dock, 1200, 900).empty.keys();
      moved = placeWorkspacePane(moved, 'a', { target: target!, side: 'center' });
      assert.equal(projectDock(moved.dock, 1200, 900).empty.size, 1);
      assert.ok(restoreWorkspace(moved, allowed));
    }
  }
});
test('restoration rejects duplicate or colliding vacancy identifiers', () => {
  const value = presetWorkspace(panes.slice(0, 1), 'single');
  const empty = { kind: 'empty' as const, id: 'vacancy:a' };
  value.dock = { kind: 'split', axis: 'horizontal', ratio: .5, first: value.dock!, second: { kind: 'split', axis: 'horizontal', ratio: .5, first: empty, second: empty } };
  assert.equal(restoreWorkspace(value, allowed), undefined);
});
test('equalize keeps topology and bindings while balancing three columns and stacked layouts', () => {
  const uneven = resizeDock(arrangeDock(['a', 'b', 'c'], 'columns'), '', .65)!;
  const equal = equalizeDock(uneven)!;
  assert.deepEqual(dockPaneIds(equal), ['a', 'b', 'c']);
  assert.equal(equal.kind === 'split' && equal.ratio, 1 / 3);
  assert.equal(uneven.kind === 'split' && uneven.ratio, .65);
  assert.deepEqual(equalizeDock(arrangeDock(['a', 'b', 'c'], 'left-stack')), arrangeDock(['a', 'b', 'c'], 'left-stack'));
  assert.equal(equalizeDock(null), null);
});
test('sidebar preview adds only on commit, reuses existing hosts and preserves bindings', () => {
  const layout = presetWorkspace(panes.slice(0, 1), 'single');
  const next = previewSessionCardDrop(layout, panes[1]!.sessionKey, 'new', 995, 300, 1000, 900);
  assert.equal(next.blocked, false); assert.equal(layout.panes.length, 1);
  assert.deepEqual(dockPaneIds(next.layout.dock), ['a', 'new']);
  const swapped = previewSessionCardDrop(next.layout, panes[0]!.sessionKey, 'unused', 750, 450, 1000, 900);
  assert.equal(swapped.blocked, false); assert.deepEqual(dockPaneIds(swapped.layout.dock), ['new', 'a']);
  assert.deepEqual(swapped.layout.panes, next.layout.panes);
  const floating = previewSessionCardDrop(layout, panes[1]!.sessionKey, 'new', 500, 450, 1000, 900);
  assert.equal(floating.blocked, false); assert.equal(floating.layout.floating[0]?.id, 'new');
  assert.deepEqual(dockPaneIds(floating.layout.dock), ['a']);
});
test('sidebar drop rejects limits, unusable splits and outside coordinates without partial panes', () => {
  const layout = presetWorkspace(panes, 'grid');
  for (const [x, y, width, height] of [[699, 150, 700, 300], [-1, 100, 1000, 900], [250, 450, 0, 900], [NaN, 450, 1000, 900]]) {
    const result = previewSessionCardDrop(layout, 'extra', 'extra', x!, y!, width!, height!);
    assert.equal(result.blocked, true); assert.equal(result.layout, layout);
  }
  assert.equal(previewSessionCardDrop(layout, 'extra', 'extra', 699, 450, 700, 900).blocked, false, 'session columns no longer have a 240px minimum');
  assert.equal(previewSessionCardDrop(layout, 'extra', 'extra', 999, 450, 1000, 900).blocked, false, 'three columns fit once artificial percentage limits are removed');
  let full = previewSessionCardDrop(layout, 'extra', 'extra', 250, 225, 1000, 900).layout;
  full = previewSessionCardDrop(full, 'last', 'last', 250, 225, 1000, 900).layout;
  full = previewSessionCardDrop(full, 'third', 'third', 250, 225, 1000, 900).layout;
  full = previewSessionCardDrop(full, 'fourth', 'fourth', 250, 225, 1000, 900).layout;
  assert.equal(full.panes.length, 8);
  const denied = previewSessionCardDrop(full, 'seventh', 'seventh', 250, 225, 1000, 900);
  assert.equal(denied.blocked, true); assert.equal(denied.layout, full);
  const reused = previewSessionCardDrop(full, 'extra', 'unused', 250, 225, 1000, 900);
  assert.equal(reused.blocked, false); assert.equal(reused.layout.panes.length, 8);
});
test('adding or redocking preserves custom split ratios and unaffected geometry', () => {
  const original = presetWorkspace(panes.slice(0, 2), 'columns'); original.dock = resizeDock(original.dock, '', .6);
  const withNew = { ...original, panes: [...original.panes, panes[2]!] };
  const added = insertWorkspacePane(withNew, 'c', 1400, 950, 'rows');
  assert.equal(added.dock?.kind === 'split' && added.dock.ratio, .6, 'does not replace custom tree with preset');
  assert.deepEqual(projectDock(added.dock, 1400, 950).panes.get('b'), projectDock(original.dock, 1400, 950).panes.get('b'));
  assert.equal(added.panes, withNew.panes);
  assert.deepEqual(dockPaneIds(added.dock), ['a', 'c', 'b']);
  assert.equal(insertWorkspacePane(added, 'c', 1400, 950, 'grid'), added, 'already docked cannot duplicate');
  assert.equal(insertWorkspacePane(added, 'missing', 1400, 950, 'grid'), added);
  const redocked = insertWorkspacePane(floatWorkspacePane(added, 'c'), 'c', 1400, 950, 'rows');
  assert.deepEqual(redocked.dock, added.dock); assert.equal(redocked.floating.length, 0);
});
test('drag reparent collapses the old split without changing bindings or the input tree', () => {
  const original = presetWorkspace(panes, 'grid'), before = JSON.stringify(original);
  const placed = placeWorkspacePane(original, 'd', { target: 'a', side: 'right' });
  assert.deepEqual(dockPaneIds(placed.dock), ['a', 'd', 'b', 'c']);
  assert.equal(placed.panes, original.panes); assert.equal(placed.active, 'd');
  assert.equal(JSON.stringify(original), before); assert.ok(restoreWorkspace(placed, allowed));
  const rim = placeWorkspacePane(placed, 'b', { target: null, side: 'bottom' });
  assert.equal(rim.dock?.kind === 'split' && rim.dock.axis, 'vertical');
  assert.deepEqual(dockPaneIds(rim.dock), ['a', 'd', 'c', 'b']);
});
test('center placement swaps leaf geometry only, retaining resized ratios and controllers', () => {
  const original = presetWorkspace(panes, 'grid'); original.dock = resizeDock(original.dock, '', .6);
  const swapped = placeWorkspacePane(original, 'a', { target: 'd', side: 'center' });
  assert.equal(swapped.panes, original.panes); assert.equal(swapped.floating, original.floating);
  const before = projectDock(original.dock, 1500, 1000), after = projectDock(swapped.dock, 1500, 1000);
  assert.deepEqual(before.panes.get('a'), after.panes.get('d'));
  assert.deepEqual(before.panes.get('d'), after.panes.get('a'));
  assert.deepEqual(before.panes.get('b'), after.panes.get('b'));
});
test('float redocking, sole-pane docking and invalid or over-capacity drops are bounded', () => {
  const original = presetWorkspace(panes, 'grid'), floating = floatWorkspacePane(original, 'b');
  assert.equal(placeWorkspacePane(floating, 'b', { target: 'a', side: 'center' }), floating);
  const placed = placeWorkspacePane(floating, 'b', { target: 'a', side: 'bottom' });
  assert.deepEqual(dockPaneIds(placed.dock), ['a', 'b', 'c', 'd']); assert.equal(placed.floating.length, 0);
  assert.equal(placeWorkspacePane(original, 'a', { target: 'a', side: 'left' }), original);
  assert.equal(placeWorkspacePane(original, 'a', { target: 'missing', side: 'left' }), original);
  assert.equal(placeWorkspacePane(original, 'missing', { target: 'a', side: 'left' }), original);
  const thirteen = Array.from({ length: 13 }, (_, i) => ({ id: i === 12 ? 'g' : `p${i}`, sessionKey: `session:${i}` }));
  const full = { ...presetWorkspace(thirteen.slice(0, 12), 'grid'), panes: thirteen, floating: [{ id: 'g', x: 0, y: 0, width: .4, height: .6 }] };
  assert.equal(placeWorkspacePane(full, 'g', { target: null, side: 'right' }), full);
  const sole = floatWorkspacePane(presetWorkspace(panes.slice(0, 1), 'single'), 'a');
  const half = placeWorkspacePane(sole, 'a', { target: null, side: 'left' });
  assert.deepEqual(dockPaneIds(half.dock), ['a']);
  assert.equal(projectDock(half.dock, 1200, 900).empty.size, 1);
});
test('drop hit testing distinguishes workspace rim, local edges, swap center, and free float', () => {
  const rects = projectDock(presetWorkspace(panes.slice(0, 2), 'columns').dock, 1200, 900).panes;
  assert.deepEqual(findDockDrop(rects, 'a', 5, 450, 1200, 900, true), { target: null, side: 'left' });
  assert.deepEqual(findDockDrop(rects, 'a', 610, 450, 1200, 900, true), { target: 'b', side: 'left' });
  assert.deepEqual(findDockDrop(rects, 'a', 900, 40, 1200, 900, true), { target: 'b', side: 'top' });
  assert.deepEqual(findDockDrop(rects, 'a', 900, 450, 1200, 900, true), { target: 'b', side: 'center' });
  assert.equal(findDockDrop(rects, 'a', 300, 450, 1200, 900, true), undefined, 'source center floats');
  assert.equal(findDockDrop(rects, 'floating', 900, 450, 1200, 900, false), undefined, 'floating movement does not swap docked bindings');
  assert.equal(findDockDrop(rects, 'a', -1, 450, 1200, 900, true), undefined);
  assert.equal(findDockDrop(rects, 'a', 1201, 450, 1200, 900, true), undefined);
});
test('incomplete presets never create phantom panes; projected rectangles fit without overlap', () => {
  for (const preset of ['grid', 'columns', 'rows', 'left-stack'] as const) for (let count = 0; count <= 6; count++) {
    const ids = eight.slice(0, count).map(pane => pane.id), dock = arrangeDock(ids, preset);
    assert.deepEqual(dockPaneIds(dock), ids);
    const projected = projectDock(dock, 1200, 800);
    assert.equal(projected.panes.size, count); assert.equal(projected.dividers.length, Math.max(0, count - 1));
    for (const rect of projected.panes.values()) {
      assert.ok(rect.x >= 0 && rect.y >= 0 && rect.width > 0 && rect.height > 0);
      assert.ok(rect.x + rect.width <= 1200.01 && rect.y + rect.height <= 800.01);
      for (const other of projected.panes.values()) if (other !== rect) assert.ok(rect.x + rect.width <= other.x || other.x + other.width <= rect.x || rect.y + rect.height <= other.y || other.y + other.height <= rect.y);
    }
  }
});
test('nested resizing changes only the requested split and clamps extreme ratios', () => {
  const dock = arrangeDock(['a', 'b', 'c', 'd'], 'grid');
  const before = projectDock(dock, 1200, 800), after = projectDock(resizeDock(dock, '0', 100), 1200, 800);
  assert.deepEqual(after.panes.get('c'), before.panes.get('c'));
  const divider = after.dividers.find(divider => divider.path === '0')!;
  assert.equal(divider.ratio, divider.maxRatio);
  assert.ok(after.panes.get('b')!.height >= 288 - 1e-9, 'viewport fitting preserves usable minimums');
  assert.equal(resizeDock(dock, '', NaN), dock);
});
test('floating panels retain reachable controls and pixel minimums after viewport resize', () => {
  for (const [width, height] of [[1200, 800], [280, 300], [0, 0]]) {
    const rect = fitFloating({ id: 'a', x: .9, y: .9, width: .2, height: .2 }, width!, height!);
    assert.ok(rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= 1 && rect.y + rect.height <= 1);
    assert.ok(rect.width * width! >= Math.min(272, width!) && rect.height * height! >= Math.min(384, height!));
  }
});
test('all requested docked arrangements use one tree and preserve distinct pane/session identities', () => {
  for (const [name, count] of [['single', 1], ['columns', 2], ['rows', 2], ['grid', 4], ['left-stack', 3]] as [WorkspacePreset, number][]) {
    const layout = presetWorkspace(panes.slice(0, count), name);
    assert.deepEqual(dockPaneIds(layout.dock), panes.slice(0, count).map(pane => pane.id));
    assert.deepEqual(restoreWorkspace(JSON.parse(JSON.stringify(layout)), allowed), layout);
  }
});
test('left-one/right-two is a horizontal split with a nested vertical split', () => {
  const { dock } = presetWorkspace(panes.slice(0, 3), 'left-stack');
  assert.equal(dock?.kind, 'split');
  if (dock?.kind !== 'split') return;
  assert.equal(dock.axis, 'horizontal'); assert.deepEqual(dock.first, { kind: 'pane', id: 'a' });
  assert.equal(dock.second.kind === 'split' && dock.second.axis, 'vertical');
});
test('float/dock keeps pane ID and binding; split collapses, original layout is unchanged', () => {
  const original = presetWorkspace(panes, 'grid'), before = JSON.stringify(original);
  const floating = floatWorkspacePane(original, 'b', { x: 10, y: -2, width: .4, height: .6 });
  assert.deepEqual(dockPaneIds(floating.dock), ['a', 'c', 'd']);
  assert.deepEqual(floating.floating, [{ id: 'b', x: .6, y: 0, width: .4, height: .6 }]);
  const docked = dockWorkspacePane(floating, 'b', 'a', 'bottom');
  assert.deepEqual(dockPaneIds(docked.dock), ['a', 'b', 'c', 'd']);
  assert.deepEqual(docked.panes, panes); assert.equal(docked.floating.length, 0);
  assert.equal(JSON.stringify(original), before); assert.ok(restoreWorkspace(docked, allowed));
});
test('last pane may float, return to empty dock, and close without a phantom selection', () => {
  const layout = presetWorkspace(panes.slice(0, 1), 'single');
  const floating = floatWorkspacePane(layout, 'a'); assert.equal(floating.dock, null);
  const docked = dockWorkspacePane(floating, 'a', null, 'right'); assert.deepEqual(docked, layout);
  assert.deepEqual(closeWorkspacePane(docked, 'a'), { version: 1, panes: [], dock: null, floating: [], active: null });
});
test('restore rejects duplicate bindings, revoked sessions, malformed trees and orphaned panes', () => {
  const layout = presetWorkspace(panes, 'grid');
  assert.equal(restoreWorkspace(layout, new Set()), undefined);
  assert.equal(restoreWorkspace({ ...layout, version: 3 }, allowed), undefined);
  assert.equal(restoreWorkspace({ ...layout, dock: { kind: 'pane', id: 'a' } }, allowed), undefined);
  assert.equal(restoreWorkspace({ ...layout, floating: [{ id: 'a', x: 0, y: 0, width: .4, height: .4 }] }, allowed), undefined);
  assert.equal(restoreWorkspace({ ...layout, active: 'missing' }, allowed), undefined);
  assert.throws(() => presetWorkspace([panes[0]!, panes[0]!], 'columns'));
});
test('dockSubagentCompanionPane floats companion by default, converts legacy docked companion, preserves active focus, and round-trips restore', () => {
  const initial = presetWorkspace(panes.slice(0, 1), 'single');
  const floated = dockSubagentCompanionPane(initial, panes[0]!.sessionKey, 'pane:subagents', 1440, 900);
  assert.equal(floated.panes.length, 2);
  assert.deepEqual(floated.panes[1], { id: 'pane:subagents', kind: 'subagents', resourceId: 'follow' });
  assert.deepEqual(dockPaneIds(floated.dock), ['a']);
  assert.equal(floated.active, 'a');
  assert.equal(floated.floating.length, 1);
  assert.equal(floated.floating[0]?.id, 'pane:subagents');
  assert.equal(dockSubagentCompanionPane(floated, panes[0]!.sessionKey, 'pane:subagents-2', 1440, 900), floated);
  assert.equal(validWorkspace(floated), true);
  assert.deepEqual(restoreWorkspace(JSON.parse(JSON.stringify(floated)), allowed), floated);

  // Legacy docked companion converts cleanly to floating while preserving active focus
  const legacyDocked = dockWorkspacePane(floated, 'pane:subagents', 'a', 'right');
  assert.deepEqual(dockPaneIds(legacyDocked.dock), ['a', 'pane:subagents']);
  const converted = dockSubagentCompanionPane({ ...legacyDocked, active: 'a' }, panes[0]!.sessionKey, 'pane:subagents-3', 1440, 900);
  assert.deepEqual(dockPaneIds(converted.dock), ['a']);
  assert.equal(converted.floating.length, 1);
  assert.equal(converted.floating[0]?.id, 'pane:subagents');
  assert.equal(converted.active, 'a');
});
