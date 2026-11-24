import test from 'node:test';
import assert from 'node:assert/strict';
import { paneMinimum, presetWorkspace, projectWorkspace, setDockFrame, fitFloating, floatWorkspacePane,
  restoreWorkspace, resizePaneEdge, resizeDock, previewResourceDrop, dockFitsWorkspace, type Pane } from './workspace-layout.js';

const session: Pane = { id: 'session', sessionKey: 'connector:codex:test' };
const note: Pane = { id: 'note', kind: 'notebook', target: 'hub', resourceId: 'default' };
const board: Pane = { id: 'board', kind: 'taskboard', resourceId: 'default' };
const file: Pane = { id: 'file', kind: 'file-browser', resourceId: 'e6031ec4-2670-4f13-9ef4-e3e9e10be233' };
for (const pane of [session, note, board]) test(`${pane.id}: 96/160/240/320/400px survive resize, dock, float and restore`, () => {
  for (const width of [96, 160, 240, 320, 400]) {
    const layout = presetWorkspace([pane], 'single');
    const rect = resizePaneEdge({ x: 0, y: 0, width: 800, height: 700 }, 'right', width - 800, 0, 1600, 1000, paneMinimum(pane));
    assert.equal(rect.width, width);
    const docked = setDockFrame(layout, pane.id, rect, 1600, 1000);
    assert.equal(projectWorkspace(docked, 1600, 1000).panes.get(pane.id)!.width, width);
    const floated = floatWorkspacePane(docked, pane.id, { x: .1, y: .1, width: width / 1600, height: .7 });
    const restored = restoreWorkspace(JSON.parse(JSON.stringify(floated)), new Set([session.sessionKey!]));
    assert.ok(restored);
    assert.equal(fitFloating(restored.floating[0]!, 1600, 1000, pane).width * 1600, width);
  }
});
test('mixed-kind tree keeps file browser protection but lets a session shrink', () => {
  const layout = presetWorkspace([session, file], 'columns');
  const next = { ...layout, dock: resizeDock(layout.dock, '', .1) };
  const rects = projectWorkspace(next, 970, 900).panes;
  assert.equal(rects.get(session.id)!.width, 96);
  assert.ok(rects.get(file.id)!.width >= 240);
  assert.equal(dockFitsWorkspace(next, 970, 900), true);
  assert.equal(fitFloating({ id: file.id, x: 0, y: 0, width: .01, height: .5 }, 1600, 1000, file).width * 1600, 240);
});
test('sidebar resource drops use kind-aware geometry on narrow surfaces', () => {
  const base = presetWorkspace([session], 'single');
  assert.equal(previewResourceDrop(base, note, 159, 200, 160, 800).blocked, false);
  assert.equal(previewResourceDrop(base, file, 159, 200, 160, 800).blocked, true);
});
