import assert from 'node:assert/strict';
import test from 'node:test';
import { fileLinkEdges, fileLinkTargets, linkedFileSession, toggleFileLink } from './workspace-file-links.js';
import { paneKey, validPane, emptyWorkspace, openResourcePane, type Pane } from './workspace-layout.js';
import { layoutFingerprint, validWorkspace, restoreSavedLayout } from './saved-layouts.js';
import { fileEditorsReady, registerFileEditorGuard } from './file-editor-guard.js';
const panes: Pane[] = ['file-browser', 'file-editor', 'image-viewer'].map((kind, i) => ({ id: `host${i}`, kind, resourceId: `00000000-0000-4000-8000-00000000000${i}` } as Pane));
panes.push({ id: 'media', kind: 'media', resourceId: 'library' }, { id: 'session', sessionKey: 'session' });
const keys = panes.map(paneKey);
test('visible file edges use the persisted graph, deduplicate and discard dangling/unsupported links', () => {
  const linked = toggleFileLink(panes, keys[0]!, keys[1]!);
  assert.deepEqual(fileLinkEdges(linked), [{ card: 'host0', session: 'host1' }]);
  assert.deepEqual(fileLinkEdges(linked.map(p => ({ ...p, id: `new-${p.id}` }))), [{ card: 'new-host0', session: 'new-host1' }]);
  assert.deepEqual(fileLinkEdges(linked.slice(0, 1)), []);
  assert.deepEqual(fileLinkEdges(toggleFileLink(linked, keys[1]!, keys[0]!)), []);
  assert.deepEqual(fileLinkEdges(panes.map(p => p.id === 'host1' ? { ...p, fileLinks: [keys[0]!, keys[4]!, 'missing'] } : p)), [{ card: 'host0', session: 'host1' }]);
});
test('file links are symmetric, transitive, cycle safe and ignore unrelated/dangling nodes', () => {
  let linked = toggleFileLink(panes, keys[0]!, keys[1]!);
  linked = toggleFileLink(linked, keys[1]!, keys[2]!);
  linked = toggleFileLink(linked, keys[2]!, keys[0]!);
  linked = toggleFileLink(linked, keys[2]!, keys[3]!);
  for (const key of keys.slice(0, 4)) assert.deepEqual(new Set(fileLinkTargets(linked, key)), new Set(keys.slice(0, 4)));
  assert.equal(toggleFileLink(linked, keys[1]!, keys[4]!), linked, 'editors cannot link to sessions');
  assert.deepEqual(fileLinkTargets(linked, 'missing'), []);
  assert.deepEqual(fileLinkTargets(linked.slice(0, 1), keys[0]!), [keys[0]]);
  const unlinked = toggleFileLink(linked, keys[2]!, keys[3]!);
  assert.deepEqual(fileLinkTargets(unlinked, keys[3]!), [keys[3]]);
});
test('browser session association is singular, persisted and never bridges viewer selection', () => {
  let linked = toggleFileLink(panes, keys[0]!, keys[1]!);
  linked = toggleFileLink(linked, keys[0]!, keys[4]!);
  assert.equal(linkedFileSession(linked, keys[0]!), keys[4]);
  assert.deepEqual(new Set(fileLinkTargets(linked, keys[0]!)), new Set(keys.slice(0, 2)));
  assert.deepEqual(fileLinkTargets(linked, keys[4]!), []);
  assert.ok(fileLinkEdges(linked).some(edge => edge.card === 'host0' && edge.session === 'session'));
  const another: Pane = { id: 'other', sessionKey: 'another' };
  linked = toggleFileLink([...linked, another], keys[0]!, paneKey(another));
  assert.equal(linkedFileSession(linked, keys[0]!), 'another');
  assert.ok(!linked[0]!.fileLinks!.includes(keys[4]!));
  assert.equal(linkedFileSession(toggleFileLink(linked, keys[0]!, 'another'), keys[0]!), undefined);
  assert.equal(linkedFileSession(linked.filter(p => p !== another), keys[0]!), undefined);
  assert.equal(linkedFileSession(JSON.parse(JSON.stringify(linked)), keys[0]!), 'another');
});
test('new cards and links validate geometry, survive saved-layout remaps, affect dirty fingerprint', () => {
  let workspace = emptyWorkspace();
  for (const pane of panes.slice(0, 4)) workspace = openResourcePane(workspace, pane as Parameters<typeof openResourcePane>[1], 1400, 900);
  assert.equal(validWorkspace(workspace), true);
  const before = layoutFingerprint(workspace, new Set());
  workspace = { ...workspace, panes: toggleFileLink(workspace.panes, keys[0]!, keys[1]!) };
  assert.notEqual(layoutFingerprint(workspace, new Set()), before);
  const restored = restoreSavedLayout({ id: 'saved', name: 'Files', workspace, collapsedKeys: [] }, new Set(), emptyWorkspace()).workspace!;
  assert.ok(restored);
  assert.deepEqual(new Set(fileLinkTargets(restored.panes, keys[0]!)), new Set(keys.slice(0, 2)));
  for (const pane of panes.slice(0, 3)) {
    assert.equal(validPane(pane), true);
    assert.equal(validPane({ ...pane, dockFrame: { x: 0, y: 0, width: -1, height: 1 } }), false);
    assert.equal(validPane({ ...pane, fileLinks: ['x', 'x'] }), false);
  }
});
test('file editor guards block only destructive changes and release on unmount', () => {
  let dirty = true; const dispose = registerFileEditorGuard('editor', () => !dirty);
  assert.equal(fileEditorsReady(), false); assert.equal(fileEditorsReady('other'), true);
  dirty = false; assert.equal(fileEditorsReady(), true);
  dirty = true; dispose(); assert.equal(fileEditorsReady(), true);
});

test('multi-session co-binding allows a notebook or taskboard card to share across multiple sessions', () => {
  const s1: Pane = { id: 'sess1', sessionKey: 'parallel-codex:s1' };
  const s2: Pane = { id: 'sess2', sessionKey: 'parallel-codex:s2' };
  const s3: Pane = { id: 'sess3', sessionKey: 'parallel-codex:s3' };
  const nb: Pane = { id: 'nb1', kind: 'notebook', target: 'hub', resourceId: 'default' };
  const tb: Pane = { id: 'tb1', kind: 'taskboard', resourceId: 'default' };
  let multiPanes: Pane[] = [s1, s2, s3, nb, tb];

  multiPanes = toggleFileLink(multiPanes, paneKey(nb), paneKey(s1));
  multiPanes = toggleFileLink(multiPanes, paneKey(nb), paneKey(s2));
  multiPanes = toggleFileLink(multiPanes, paneKey(tb), paneKey(s1));
  multiPanes = toggleFileLink(multiPanes, paneKey(tb), paneKey(s3));

  const edges = fileLinkEdges(multiPanes);
  assert.ok(edges.some(e => e.card === 'nb1' && e.session === 'sess1'));
  assert.ok(edges.some(e => e.card === 'nb1' && e.session === 'sess2'));
  assert.ok(edges.some(e => e.card === 'tb1' && e.session === 'sess1'));
  assert.ok(edges.some(e => e.card === 'tb1' && e.session === 'sess3'));

  // Unbinding s1 from nb1 leaves s2 bound
  multiPanes = toggleFileLink(multiPanes, paneKey(nb), paneKey(s1));
  const afterEdges = fileLinkEdges(multiPanes);
  assert.ok(!afterEdges.some(e => e.card === 'nb1' && e.session === 'sess1'));
  assert.ok(afterEdges.some(e => e.card === 'nb1' && e.session === 'sess2'));
});
