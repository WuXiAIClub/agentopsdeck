import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyNativeDrawio, nativeDrawioEnvelope, nativeDrawioEditorUrl, validNativeDrawioWrite, NATIVE_DRAWIO_MAX_XML_BYTES } from '@agentopsdeck/shared';
import { nativeDrawioDraftKey, parseNativeDrawioDraft, reconcileNativeDrawio, isolatedDrawioUrl, readNativeDrawioEvent } from './workspace-native-drawio.js';
import { emptyWorkspace, openResourcePane, paneKey, paneSessionKey, restoreWorkspace, floatWorkspacePane, validPane } from './workspace-layout.js';
import { parseCurrentLayout, layoutSnapshot } from './current-layout.js';
const mutationId = 'c29fa753-5299-4d28-a9ea-f947ae83d0a0';
const write = () => ({ ...emptyNativeDrawio(), revision: 0, mutationId });
test('native document envelope rejects entities, active declarations, oversized bytes and write identity smuggling', () => {
  assert.ok(validNativeDrawioWrite(write()));
  for (const xml of ['', '<svg/>', '<mxfile><!ENTITY x "y"></mxfile>', '<!DOCTYPE mxfile><mxfile></mxfile>', '<mxfile><?evil a?></mxfile>', '<mxfile>\0</mxfile>', `<mxfile>${'a'.repeat(NATIVE_DRAWIO_MAX_XML_BYTES)}</mxfile>`, `<mxfile>${'中'.repeat(NATIVE_DRAWIO_MAX_XML_BYTES / 2)}</mxfile>`]) assert.equal(nativeDrawioEnvelope(xml), false);
  for (const value of [{ ...write(), owner: 'bob' }, { ...write(), revision: -1 }, { ...write(), revision: Number.MAX_SAFE_INTEGER }, { ...write(), mutationId: '' }, { ...write(), format: 'agentopsdeck-drawing' }, { ...write(), title: '' }]) assert.equal(validNativeDrawioWrite(value), false);
  assert.equal(validNativeDrawioWrite({ ...write(), title: '' }, true), true);
});
test('editor disabled without explicit separate HTTPS origin; no embedded secrets or URL flags accepted', () => {
  for (const value of [undefined, '', 'http://editor.example/', 'javascript:alert(1)', 'https://user:secret@editor.example/', 'https://editor.example/?token=secret', 'https://editor.example/#secret']) assert.equal(nativeDrawioEditorUrl(value), undefined);
  assert.equal(isolatedDrawioUrl('https://hub.example/editor/', 'https://hub.example'), undefined);
  const url = isolatedDrawioUrl('https://editor.example/editor/', 'https://hub.example');
  assert.equal(url?.origin, 'https://editor.example'); assert.equal(url?.searchParams.get('offline'), '1'); assert.equal(url?.searchParams.get('proto'), 'json');
});
test('protocol only accepts bounded JSON messages and approved event shapes', () => {
  for (const data of [null, { event: 'init' }, 'invalid', JSON.stringify({ event: 'export', data: 'private' }), JSON.stringify({ event: 'save', xml: '<script/>' }), ' '.repeat(2 * 1024 * 1024 + 1)]) assert.equal(readNativeDrawioEvent(data), undefined);
  assert.deepEqual(readNativeDrawioEvent('{"event":"init"}'), { event: 'init' });
  assert.deepEqual(readNativeDrawioEvent(JSON.stringify({ event: 'save', xml: write().xml, unrelated: true })), { event: 'save', xml: write().xml });
});
test('drafts isolate owners and restore same-mutation writes; conflicts are never auto-overwritten', () => {
  assert.notEqual(nativeDrawioDraftKey('alice', 'default'), nativeDrawioDraftKey('bob', 'default'));
  const local = { ...write(), title: 'Local' }, remote = { ...emptyNativeDrawio(), resourceId: 'default', revision: 2, updatedAt: 1 };
  assert.deepEqual(parseNativeDrawioDraft(JSON.stringify(local)), local);
  assert.equal(parseNativeDrawioDraft('{'), undefined);
  assert.deepEqual(reconcileNativeDrawio(remote, local, mutationId), { draft: local, conflict: true });
  const saved = { ...remote, title: 'Local' };
  assert.equal(reconcileNativeDrawio(saved, local, mutationId).draft.revision, 2);
  assert.equal(reconcileNativeDrawio(saved, local, mutationId).conflict, false);
});
test('native panes remain independent of whiteboards/chat and retain saved/float layout', () => {
  const pane = { id: 'native', kind: 'native-drawio', resourceId: 'default' } as const;
  assert.ok(validPane(pane)); assert.equal(validPane({ ...pane, sessionKey: 'secret' }), false);
  assert.notEqual(paneKey(pane), paneKey({ ...pane, kind: 'drawing' })); assert.equal(paneSessionKey(pane), undefined);
  const layout = floatWorkspacePane(openResourcePane(emptyWorkspace(), pane, 1400, 900), 'native');
  assert.deepEqual(restoreWorkspace(layout, new Set()), layout);
  assert.deepEqual(parseCurrentLayout(JSON.stringify(layoutSnapshot(layout, new Set())))?.workspace, layout);
});
