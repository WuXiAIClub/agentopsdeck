import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyDrawing, drawingContent, DRAWING_MAX_BODY_BYTES } from '@agentopsdeck/shared';
import { drawingDraftKey, importDrawing, parseDrawingDraft, reconcileDrawing, removeDrawingNode, drawingTextColor } from './workspace-drawing.js';
import { emptyWorkspace, openResourcePane, paneKey, isSessionPane, floatWorkspacePane, restoreWorkspace, validPane } from './workspace-layout.js';
import { layoutSnapshot, parseCurrentLayout } from './current-layout.js';
const id = 'c29fa753-5299-4d28-a9ea-f947ae83d0a0';
test('drawing import/export is strictly data-only with no resource identity import', () => {
  const data = { ...emptyDrawing(), nodes: [{ id, x: 0, y: 0, width: 200, height: 100, text: '<script>alert(1)</script>', color: '#dbeafe' }] };
  assert.deepEqual(importDrawing(JSON.stringify(data)), data);
  assert.deepEqual(importDrawing(JSON.stringify({ ...data, title: '' })), { ...data, title: '' });
  for (const value of [{ ...data, owner: 'other' }, { ...data, revision: 1 }, { ...data, format: 'drawio' }, { ...data, nodes: [{ ...data.nodes[0], href: 'http://private' }] }]) assert.throws(() => importDrawing(JSON.stringify(value)));
  assert.throws(() => importDrawing('<svg/>')); assert.throws(() => importDrawing(' '.repeat(DRAWING_MAX_BODY_BYTES + 1)));
});
test('drawing drafts remain user/resource isolated and never overwrite diverged edits', () => {
  const document = { ...emptyDrawing(), resourceId: id, revision: 2, updatedAt: 1 };
  const draft = { ...emptyDrawing(), title: 'Local', revision: 1, mutationId: id };
  assert.notEqual(drawingDraftKey('a', id), drawingDraftKey('b', id)); assert.notEqual(drawingDraftKey('a', id), drawingDraftKey('a', 'default'));
  assert.deepEqual(parseDrawingDraft(JSON.stringify(draft)), draft); assert.equal(parseDrawingDraft('{}'), undefined);
  assert.deepEqual(reconcileDrawing(document, draft, id), { draft, conflict: true });
  assert.equal(reconcileDrawing(document, { ...draft, title: document.title }, id).draft.revision, 2);
  assert.deepEqual(Object.keys(drawingContent(document)).sort(), ['edges', 'format', 'nodes', 'title', 'version']);
});
test('node removal cleans connected edges', () => {
  assert.deepEqual(removeDrawingNode({ ...emptyDrawing(), edges: [{ id, from: id, to: 'other' }] }, id).edges, []);
});
test('card labels contrast with custom dark and light fills', () => {
  assert.equal(drawingTextColor('#000000'), '#ffffff'); assert.equal(drawingTextColor('#ffffff'), '#000000');
  assert.equal(drawingTextColor('#dbeafe'), '#000000');
});
test('drawing layout survives float/restore and never becomes a chat subscription', () => {
  const pane = { id: 'drawing', kind: 'drawing', resourceId: id } as const;
  assert.equal(validPane(pane), true); assert.equal(validPane({ ...pane, resourceId: '../file' }), false);
  assert.equal(validPane({ ...pane, sessionKey: 'injected' }), false); assert.equal(isSessionPane(pane), false);
  assert.equal(paneKey(pane), `\u0000drawing:${id}`);
  let layout = openResourcePane(emptyWorkspace(), pane, 1400, 900);
  assert.equal(openResourcePane(layout, { ...pane, id: 'duplicate' }, 1400, 900).panes.length, 1);
  layout = floatWorkspacePane(layout, pane.id);
  assert.deepEqual(restoreWorkspace(layout, new Set()), layout);
  assert.deepEqual(parseCurrentLayout(JSON.stringify(layoutSnapshot(layout, new Set())))?.workspace, layout);
});
