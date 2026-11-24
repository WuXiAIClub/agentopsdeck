import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { workspaceFileCardResource } from '@agentopsdeck/shared';
import { cardFileFixture } from './workspace-card-file-fixture.js';
import { parseCardFile, serializeCardFile } from '../connector/workspace-file-card-format.js';
import { writeBoundNotebook } from '../routes/hub-native-file-write.js';
import { boundNotebookMove } from '../routes/hub-bound-notebook-move.js';
import { notebookHash } from './notebook-operations.js';

const resource = workspaceFileCardResource('notebook', 'hub:default'), note = JSON.stringify(['hub-notebook', 1]);
const base = '/api/hub/v1/workspace/file-cards/' + encodeURIComponent(resource);
type Fixture = Awaited<ReturnType<typeof cardFileFixture>>;
async function bind(f: Fixture) {
  const b = await f.service.bind('default', resource, { requestId: randomUUID(), sessionId: f.sessionId,
    revision: f.store.cardFileProjection.get('default', resource)!.revision });
  assert.equal(await f.service.writable('default', resource), true); return b;
}
async function file(path: string) {
  const value = parseCardFile(await readFile(path))!.content;
  assert.equal(value.kind, 'notebook'); if (value.kind !== 'notebook') throw Error('wrong kind'); return value;
}
async function edit(path: string, content: Parameters<typeof serializeCardFile>[0]) {
  const tmp = path + '.test-' + randomUUID(); await writeFile(tmp, serializeCardFile(content)); await rename(tmp, path);
}
test('whole notebook binding synchronizes real archive both ways, preserves hot/title, and revokes future writes', async () => {
  const f = await cardFileFixture();
  try {
    f.store.notebooks.save('default', { resourceId: note, revision: 0, text: 'hot' });
    f.store.notebooks.saveArchive('default', { resourceId: note, revision: 0, text: 'private archive' });
    const b = await bind(f), path = f.remote.get('default', b.bindingId).path, initial = await file(path);
    assert.equal(initial.content.archive, 'private archive');
    const cold = f.store.notebooks.getArchive('default', note), deps = { hubStore: f.store, fileCards: f.service };
    assert.equal(f.store.notebooks.saveArchive('default', { ...cold, text: 'bypass' }), undefined);
    await writeBoundNotebook(deps, 'default', 'hub:default', { ...cold, text: 'web archive' }, false, true);
    assert.deepEqual(await file(path), { ...initial, content: { ...initial.content, archive: 'web archive' } });
    await edit(path, { ...initial, content: { title: 'Agent title', text: 'Agent hot', archive: 'Agent cold' } });
    await f.service.refresh('default', resource, b.bindingId);
    assert.equal(f.store.notebooks.getArchive('default', note).text, 'Agent cold');
    const hot = f.store.notebooks.get('default', note); assert.equal(hot.text, 'Agent hot');
    await writeBoundNotebook(deps, 'default', 'hub:default', { ...hot, text: 'web hot' });
    assert.deepEqual((await file(path)).content, { title: 'Agent title', text: 'web hot', archive: 'Agent cold' });
    await f.service.revoke('default', resource, b.bindingId);
    const unbound = f.store.cardFileProjection.get('default', resource)!;
    assert.equal(unbound.kind === 'notebook' && unbound.content.archive, undefined);
    assert.equal(f.store.notebooks.getArchive('default', note).text, 'Agent cold');
    assert.ok(f.store.notebooks.saveArchive('default', { ...f.store.notebooks.getArchive('default', note), text: 'local only' }));
    assert.equal((await file(path)).content.archive, 'Agent cold');
  } finally { await f.close(); }
});
test('missing or oversized archive never clears the last valid projection', async () => {
  const f = await cardFileFixture();
  try {
    const b = await bind(f), path = f.remote.get('default', b.bindingId).path, initial = await file(path);
    await edit(path, { ...initial, content: { ...initial.content, archive: 'retain me' } });
    await f.service.refresh('default', resource, b.bindingId);
    await edit(path, { ...initial, content: { title: 'old Agent', text: 'only hot' } });
    await assert.rejects(f.service.refresh('default', resource, b.bindingId));
    assert.equal(f.store.cardFiles.get('default', b.bindingId)?.problem, 'invalid');
    assert.equal(f.store.notebooks.getArchive('default', note).text, 'retain me');
    // Bypass the valid serializer to simulate a malformed Agent file.
    await writeFile(path, JSON.stringify({ version: 1, ...initial, content: { ...initial.content, archive: 'a'.repeat(100001) } }));
    await assert.rejects(f.service.refresh('default', resource, b.bindingId));
    assert.equal(f.store.notebooks.getArchive('default', note).text, 'retain me');
    await edit(path, { ...initial, content: { ...initial.content, archive: '' } });
    await f.service.refresh('default', resource, b.bindingId);
    assert.equal(f.store.notebooks.getArchive('default', note).text, '', 'explicit empty field is a valid edit');
  } finally { await f.close(); }
});
test('old binding stays hot-only until owner upgrades same file without standalone grant', async () => {
  const f = await cardFileFixture('codex', ['codex'], true);
  try {
    const b = await bind(f), path = f.remote.get('default', b.bindingId).path;
    assert.ok(f.store.notebooks.saveArchive('default', { resourceId: note, revision: 0, text: 'previously private' }));
    const initial = await file(path); assert.equal(initial.content.archive, undefined);
    const input = { requestId: randomUUID(), revision: f.store.cardFileProjection.get('default', resource)!.revision };
    const url = base + '/file-binding/' + b.bindingId + '/include-archive';
    const result = await f.hub.request(url, { method: 'POST', body: JSON.stringify(input) });
    assert.equal(result.status, 200, await result.clone().text()); assert.equal((await result.json()).receipt.state, 'saved');
    assert.deepEqual(await file(path), { ...initial, content: { ...initial.content, archive: 'previously private' } });
    assert.equal(f.store.cardFiles.current('default', resource)!.bindingId, b.bindingId);
    assert.equal((await f.hub.request(url, { method: 'POST', body: JSON.stringify(input) })).status, 200);
    assert.equal(f.writes(), 1, 'duplicate POST inspects the original, never replays');
    f.other();
    const denied = await f.hub.request(url, { method: 'POST', body: JSON.stringify(input) });
    assert.deepEqual(await denied.json(), { notAdmitted: true });
    assert.equal(f.writes(), 1, 'another owner cannot write or inspect the private receipt');
  } finally { await f.close(); }
});
test('archive upgrade lost reply recovers original after database reopen, preserving later Agent edits', async () => {
  const f = await cardFileFixture('codex', ['codex'], true);
  try {
    const b = await bind(f), path = f.remote.get('default', b.bindingId).path;
    f.store.notebooks.saveArchive('default', { resourceId: note, revision: 0, text: 'cold' });
    const requestId = randomUUID(), revision = f.store.cardFileProjection.get('default', resource)!.revision;
    f.loseWrite(); assert.equal((await f.service.includeArchive('default', resource, b.bindingId, requestId, revision)).state, 'uncertain');
    await edit(path, { kind: 'notebook', content: { title: 'later', text: 'later hot', archive: 'later cold' } });
    const reopened = await f.reopen();
    assert.equal((await reopened.fileCards.inspectWrite('default', resource, b.bindingId, requestId)).state, 'saved');
    assert.equal(f.store.notebooks.getArchive('default', note).text, 'later cold');
    assert.equal(f.store.notebooks.get('default', note).text, 'later hot'); assert.equal(f.writes(), 1);
  } finally { await f.close(); }
});
test('old Connector cannot admit a new archive binding or broaden an existing hot-only binding', async () => {
  const fresh = await cardFileFixture();
  try {
    fresh.archiveProtocol(false);
    await assert.rejects(bind(fresh), (error: any) => error.status === 409);
    assert.equal(fresh.store.notebooks.archiveFileBinding('default', note), undefined);
    assert.equal(fresh.store.cardFiles.current('default', resource), undefined);
    assert.equal(fresh.installs(), 0);
  } finally { await fresh.close(); }
  const legacy = await cardFileFixture('codex', ['codex'], true);
  try {
    const b = await bind(legacy);
    legacy.archiveProtocol(false);
    const requestId = randomUUID();
    const result = await legacy.hub.request(base + '/file-binding/' + b.bindingId + '/include-archive', {
      method: 'POST', body: JSON.stringify({ requestId, revision: legacy.store.cardFileProjection.get('default', resource)!.revision }) });
    assert.deepEqual(await result.json(), { notAdmitted: true });
    assert.equal(legacy.store.notebooks.archiveFileBinding('default', note), undefined);
    assert.equal(legacy.store.cardFiles.writeReceipt('default', b.bindingId, requestId), undefined);
    assert.equal(legacy.writes(), 0);
  } finally { await legacy.close(); }
});
for (const area of ['hot', 'cold'] as const) test(`archive upgrade rejects a ${area} edit during asynchronous admission, retaining private scope`, async () => {
  const f = await cardFileFixture('codex', ['codex'], true);
  try {
    const b = await bind(f), revision = f.store.cardFileProjection.get('default', resource)!.revision;
    // First capabilities GET builds the plan; the second is write admission's
    // asynchronous writable preflight. Race in that gap, not after disk write.
    f.beforeCapability(() => f.beforeCapability(() => {
      if (area === 'hot') assert.ok(f.store.notebooks.save('default', { ...f.store.notebooks.get('default', note), text: 'late hot' }, b.bindingId));
      else assert.ok(f.store.notebooks.saveArchive('default', { ...f.store.notebooks.getArchive('default', note), text: 'late cold' }));
    }));
    const result = await f.hub.request(base + '/file-binding/' + b.bindingId + '/include-archive', {
      method: 'POST', body: JSON.stringify({ requestId: randomUUID(), revision }) });
    assert.deepEqual(await result.json(), { notAdmitted: true });
    assert.equal(f.store.notebooks.archiveFileBinding('default', note), undefined);
    assert.equal(f.writes(), 0);
    assert.equal((area === 'hot' ? f.store.notebooks.get('default', note) : f.store.notebooks.getArchive('default', note)).text, `late ${area}`);
  } finally { await f.close(); }
});
test('admitted uncertain upgrade is inspected even if Connector later loses archive capability', async () => {
  const f = await cardFileFixture('codex', ['codex'], true);
  try {
    const b = await bind(f), revision = f.store.cardFileProjection.get('default', resource)!.revision, request = randomUUID();
    f.loseWrite(); assert.equal((await f.service.includeArchive('default', resource, b.bindingId, request, revision)).state, 'uncertain');
    f.archiveProtocol(false);
    assert.equal((await f.service.includeArchive('default', resource, b.bindingId, request, revision)).state, 'saved');
    assert.equal(f.writes(), 1);
  } finally { await f.close(); }
});
test('shutdown cancels archive capability preflight before any scope or file write is admitted', async () => {
  const f = await cardFileFixture('codex', ['codex'], true);
  try {
    const b = await bind(f), revision = f.store.cardFileProjection.get('default', resource)!.revision;
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.beforeCapability(async () => { entered(); await gate; });
    const result = f.service.includeArchive('default', resource, b.bindingId, randomUUID(), revision);
    const rejected = assert.rejects(result);
    await ready;
    const close = f.service.close(); release(); await close; await rejected;
    assert.equal(f.store.notebooks.archiveFileBinding('default', note), undefined);
    assert.equal(f.writes(), 0);
  } finally { await f.close(); }
});
test('upgrade file CAS conflict withdraws only new archive scope, retaining archive and late hot edits', async () => {
  const f = await cardFileFixture('codex', ['codex'], true);
  try {
    const b = await bind(f), path = f.remote.get('default', b.bindingId).path;
    f.store.notebooks.saveArchive('default', { resourceId: note, revision: 0, text: 'private' });
    const revision = f.store.cardFileProjection.get('default', resource)!.revision;
    f.beforeWrite(() => edit(path, { kind: 'notebook', content: { title: 'late', text: 'late hot' } }));
    assert.equal((await f.service.includeArchive('default', resource, b.bindingId, randomUUID(), revision)).state, 'conflict');
    await f.service.refresh('default', resource, b.bindingId);
    assert.equal(f.store.notebooks.archiveFileBinding('default', note), undefined);
    assert.equal(f.store.notebooks.getArchive('default', note).text, 'private');
    assert.equal(f.store.notebooks.get('default', note).text, 'late hot');
    assert.ok(f.store.notebooks.saveArchive('default', { ...f.store.notebooks.getArchive('default', note), text: 'still local' }));
    assert.equal((await f.service.includeArchive('default', resource, b.bindingId, randomUUID(),
      f.store.cardFileProjection.get('default', resource)!.revision)).state, 'saved', 'confirmed conflict permits a new consented request');
    assert.equal((await file(path)).content.archive, 'still local');
  } finally { await f.close(); }
});
test('full-file move is atomic and original receipt never overwrites later archive or hot edits', async () => {
  const f = await cardFileFixture();
  try {
    f.store.notebooks.save('default', { resourceId: note, revision: 0, text: 'keep old' });
    const b = await bind(f), path = f.remote.get('default', b.bindingId).path;
    const input = { requestId: randomUUID(), direction: 'archive' as const, hotRevision: f.store.notebooks.get('default', note).revision,
      coldRevision: f.store.notebooks.getArchive('default', note).revision, ranges: [{ start: 5, end: 8, sha256: notebookHash('old') }] };
    f.loseWrite();
    await assert.rejects(boundNotebookMove({ hubStore: f.store, fileCards: f.service }, 'default', note, input.requestId, () => {}, input), /pending/);
    assert.deepEqual((await file(path)).content, { title: 'Notebook', text: 'keep ', archive: 'old' });
    await edit(path, { kind: 'notebook', content: { title: 'Agent', text: 'later hot', archive: 'later archive' } });
    const deps = await f.reopen(); assert.ok(await boundNotebookMove(deps, 'default', note, input.requestId, () => {}));
    assert.equal(f.store.notebooks.getArchive('default', note).text, 'later archive');
    assert.equal(f.store.notebooks.get('default', note).text, 'later hot'); assert.equal(f.writes(), 1);
  } finally { await f.close(); }
});
