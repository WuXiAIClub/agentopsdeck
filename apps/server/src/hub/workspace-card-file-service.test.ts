import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, writeFile, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { CONNECTOR_PROTOCOL_HEADER, CONNECTOR_PROTOCOL, workspaceFileCardResource } from '@agentopsdeck/shared';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { ConnectorWorkspaceFiles } from '../connector/workspace-board-files.js';
import { registerConnectorWorkspaceFiles } from '../connector/workspace-board-files-http.js';
import { cardFileCodec, parseCardFile, serializeCardFile } from '../connector/workspace-file-card-format.js';
import { HubStore } from './hub-store.js';
import { HubFileCardService } from './workspace-card-file-service.js';
import { createConnectorClientResolver } from './connector-client.js';
import { registerHubCardFiles } from '../routes/hub-workspace-card-files.js';
import { encodeHubSessionId } from './session-id.js';
import { NODE_ID_HEADER } from '../connector/node-identity.js';
import { DEFAULT_HUB_NOTEBOOK_LAYOUT, emptyNativeDrawio, WORKSPACE_FILE_CARD_KINDS, workspaceFileCardContent, type WorkspaceFileCard } from '@agentopsdeck/shared';
import { writeBoundNotebook } from '../routes/hub-native-file-write.js';
import { boundNotebookMove } from '../routes/hub-bound-notebook-move.js';
import { registerHubSessionNotebookRoutes } from '../routes/hub-session-notebooks.js';
import { notebookHash, type NotebookMove } from './notebook-operations.js';
import { FILE_BOARD_RUNTIMES, type FileBoardRuntime } from '../connector/workspace-board-file-policy.js';

async function until(predicate: () => boolean) {
  const end = Date.now() + 4000;
  while (!predicate()) { assert.ok(Date.now() < end, 'condition did not converge'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
import { cardFileFixture as fixture } from './workspace-card-file-fixture.js';

test('bound notebook HTTP move commits both areas, original receipt and reverse move without replay', async () => {
  const f = await fixture(), resource = workspaceFileCardResource('notebook', 'hub:default'), note = JSON.stringify(['hub-notebook', 1]);
  try {
    f.store.notebooks.save('default', { resourceId: note, revision: 0, text: 'new old' });
    const bound = await f.service.bind('default', resource, { requestId: randomUUID(), sessionId: f.sessionId, revision: 1 });
    assert.ok(bound);
    await f.service.writable('default', resource);
    const app = new Hono();
    registerHubSessionNotebookRoutes(app, { hubStore: f.store, fileCards: f.service, principal: () => ({ userId: 'default', admin: false }) });
    const send = (suffix: string, body?: unknown) => app.request('/api/hub/v1/notebooks/default' + suffix,
      { method: body ? 'POST' : 'GET', ...(body ? { body: JSON.stringify(body) } : {}) });
    const input: NotebookMove = { requestId: randomUUID(), direction: 'archive', hotRevision: f.store.notebooks.get('default', note).revision, coldRevision: f.store.notebooks.getArchive('default', note).revision,
      ranges: [{ start: 4, end: 7, sha256: notebookHash('old') }] };
    const response = await send('/moves', input); assert.equal(response.status, 200, await response.clone().text());
    const receipt = await response.json();
    assert.equal(f.store.notebooks.get('default', note).text, 'new ');
    assert.equal(f.store.notebooks.getArchive('default', note).text, 'old');
    assert.deepEqual(await (await send('/moves/' + input.requestId)).json(), receipt);
    assert.deepEqual(await (await send('/moves', input)).json(), receipt);
    assert.equal((await send('/moves', { ...input, direction: 'restore' })).status, 409);
    assert.equal(f.writes(), 1);
    const restore: NotebookMove = { requestId: randomUUID(), direction: 'restore', hotRevision: receipt.hotRevision,
      coldRevision: receipt.coldRevision, ranges: [{ start: 0, end: 3, sha256: notebookHash('old') }] };
    assert.equal((await send('/moves', restore)).status, 200);
    assert.equal(f.store.notebooks.getArchive('default', note).text, '');
    assert.equal(f.store.notebooks.get('default', note).text, 'new \n\nold');
    assert.equal(f.writes(), 2);
  } finally { await f.close(); }
});

test('legacy bound move lost response freezes archive and unrelated writes, recovers original after restart preserving later Agent edit', async () => {
  const f = await fixture('codex', ['codex'], true), resource = workspaceFileCardResource('notebook', 'hub:default'), note = JSON.stringify(['hub-notebook', 1]);
  try {
    f.store.notebooks.save('default', { resourceId: note, revision: 0, text: 'new old' });
    await f.service.bind('default', resource, { requestId: randomUUID(), sessionId: f.sessionId, revision: 1 });
    await f.service.writable('default', resource);
    const binding = f.store.cardFiles.current('default', resource)!;
    const input: NotebookMove = { requestId: randomUUID(), direction: 'archive', hotRevision: f.store.notebooks.get('default', note).revision, coldRevision: f.store.notebooks.getArchive('default', note).revision,
      ranges: [{ start: 4, end: 7, sha256: notebookHash('old') }] };
    const deps = { hubStore: f.store, fileCards: f.service };
    f.loseWrite();
    await assert.rejects(boundNotebookMove(deps, 'default', note, input.requestId, () => {}, input), /pending/);
    assert.equal(f.store.notebooks.getArchive('default', note).text, '');
    assert.equal(f.store.notebooks.saveArchive('default', { resourceId: note, revision: 0, text: 'racing cold edit' }), undefined);
    const projection = f.store.cardFileProjection.get('default', resource)!;
    assert.equal(f.store.cardFiles.prepareWrite('default', binding.bindingId, { kind: 'notebook', revision: projection.revision,
      mutationId: randomUUID(), content: { title: 'Notebook', text: 'racing hot edit' } }), undefined);
    await atomicAgentEdit(f.remote.get('default', binding.bindingId).path,
      { kind: 'notebook', content: { title: 'Agent', text: 'Later Agent text' } });
    deps.fileCards = await f.restart();
    const result = await boundNotebookMove(deps, 'default', note, input.requestId, () => {});
    assert.ok(result);
    assert.equal(f.store.notebooks.getArchive('default', note).text, 'old');
    assert.equal(f.store.notebooks.get('default', note).text, 'Later Agent text');
    assert.equal(f.store.notebooks.boundMove('default', note, input.requestId)?.payload, '');
    assert.deepEqual(await boundNotebookMove(deps, 'default', note, input.requestId, () => {}), result);
    assert.equal(f.writes(), 1);
    assert.ok(f.store.notebooks.saveArchive('default', { resourceId: note, revision: 1, text: 'now editable' }));
  } finally { await f.close(); }
});

test('bound move survives real database close/reopen with its original receipt and cold fence', async () => {
  const f = await fixture(), resource = workspaceFileCardResource('notebook', 'hub:default'), note = JSON.stringify(['hub-notebook', 1]);
  try {
    f.store.notebooks.save('default', { resourceId: note, revision: 0, text: 'keep archive' });
    await f.service.bind('default', resource, { requestId: randomUUID(), sessionId: f.sessionId, revision: 1 });
    await f.service.writable('default', resource);
    const input: NotebookMove = { requestId: randomUUID(), direction: 'archive', hotRevision: f.store.notebooks.get('default', note).revision,
      coldRevision: f.store.notebooks.getArchive('default', note).revision, ranges: [{ start: 5, end: 12, sha256: notebookHash('archive') }] };
    f.loseWrite();
    await assert.rejects(boundNotebookMove({ hubStore: f.store, fileCards: f.service }, 'default', note, input.requestId, () => {}, input), /pending/);
    const deps = await f.reopen();
    assert.equal(f.store.notebooks.boundMove('default', note, input.requestId)?.state, 'pending');
    assert.equal(f.store.notebooks.saveArchive('default', { resourceId: note, revision: 0, text: 'must not overwrite reservation' }), undefined);
    const result = await boundNotebookMove(deps, 'default', note, input.requestId, () => {});
    assert.ok(result);
    assert.equal(f.store.notebooks.getArchive('default', note).text, 'archive');
    assert.equal(f.store.notebooks.get('default', note).text, 'keep ');
    const reopened = await f.reopen();
    assert.deepEqual(await boundNotebookMove(reopened, 'default', note, input.requestId, () => {}, input), result);
    assert.equal(f.writes(), 1);
  } finally { await f.close(); }
});

test('legacy bound notebook admission rechecks cold revision after asynchronous file capability check', async () => {
  const f = await fixture('codex', ['codex'], true), resource = workspaceFileCardResource('notebook', 'hub:default'), note = JSON.stringify(['hub-notebook', 1]);
  try {
    f.store.notebooks.save('default', { resourceId: note, revision: 0, text: 'new old' });
    await f.service.bind('default', resource, { requestId: randomUUID(), sessionId: f.sessionId, revision: 1 });
    await f.service.writable('default', resource);
    const input: NotebookMove = { requestId: randomUUID(), direction: 'archive', hotRevision: f.store.notebooks.get('default', note).revision, coldRevision: f.store.notebooks.getArchive('default', note).revision,
      ranges: [{ start: 4, end: 7, sha256: notebookHash('old') }] };
    const pending = boundNotebookMove({ hubStore: f.store, fileCards: f.service }, 'default', note, input.requestId, () => {}, input);
    f.store.notebooks.saveArchive('default', { resourceId: note, revision: 0, text: 'racing edit' });
    await assert.rejects(pending, /changed/);
    assert.equal(f.writes(), 0);
    assert.equal(f.store.notebooks.boundMove('default', note, input.requestId), undefined);
    assert.equal(f.store.notebooks.get('default', note).text, 'new old');
    assert.equal(f.store.notebooks.getArchive('default', note).text, 'racing edit');
  } finally { await f.close(); }
});

test('legacy bound move definitive file conflict releases cold fence without deleting either area', async () => {
  const f = await fixture('codex', ['codex'], true), resource = workspaceFileCardResource('notebook', 'hub:default'), note = JSON.stringify(['hub-notebook', 1]);
  try {
    f.store.notebooks.save('default', { resourceId: note, revision: 0, text: 'new old' });
    await f.service.bind('default', resource, { requestId: randomUUID(), sessionId: f.sessionId, revision: 1 });
    await f.service.writable('default', resource);
    const binding = f.store.cardFiles.current('default', resource)!;
    const input: NotebookMove = { requestId: randomUUID(), direction: 'archive', hotRevision: f.store.notebooks.get('default', note).revision, coldRevision: f.store.notebooks.getArchive('default', note).revision,
      ranges: [{ start: 4, end: 7, sha256: notebookHash('old') }] };
    f.beforeWrite(() => atomicAgentEdit(f.remote.get('default', binding.bindingId).path,
      { kind: 'notebook', content: { title: 'Agent', text: 'newer old' } }));
    const deps = { hubStore: f.store, fileCards: f.service };
    await assert.rejects(boundNotebookMove(deps, 'default', note, input.requestId, () => {}, input), /conflicted/);
    assert.equal(f.store.notebooks.getArchive('default', note).text, '');
    assert.equal(f.store.notebooks.boundMove('default', note, input.requestId)?.state, 'conflict');
    assert.ok(f.store.notebooks.saveArchive('default', { resourceId: note, revision: 0, text: 'unlocked' }));
    await assert.rejects(boundNotebookMove(deps, 'default', note, input.requestId, () => {}, input), /conflicted/);
    assert.equal(f.writes(), 1);
    await f.service.refresh('default', resource, binding.bindingId);
    assert.equal(f.store.notebooks.get('default', note).text, 'newer old');
  } finally { await f.close(); }
});

test('bound move authorization changes before admission cause zero file writes and no reservation', async () => {
  const f = await fixture(), resource = workspaceFileCardResource('notebook', 'hub:default'), note = JSON.stringify(['hub-notebook', 1]);
  try {
    f.store.notebooks.save('default', { resourceId: note, revision: 0, text: 'new old' });
    await f.service.bind('default', resource, { requestId: randomUUID(), sessionId: f.sessionId, revision: 1 });
    await f.service.writable('default', resource);
    const input: NotebookMove = { requestId: randomUUID(), direction: 'archive', hotRevision: f.store.notebooks.get('default', note).revision, coldRevision: f.store.notebooks.getArchive('default', note).revision,
      ranges: [{ start: 4, end: 7, sha256: notebookHash('old') }] };
    await assert.rejects(boundNotebookMove({ hubStore: f.store, fileCards: f.service }, 'default', note, input.requestId,
      () => { throw Error('authority-revoked'); }, input), /authority-revoked/);
    assert.equal(f.writes(), 0);
    assert.equal(f.store.notebooks.boundMove('default', note, input.requestId), undefined);
    assert.equal(f.store.notebooks.getArchive('default', note).text, '');
  } finally { await f.close(); }
});
for (const runtime of FILE_BOARD_RUNTIMES) test(`${runtime}: a denied runtime leaves the notebook unbound and unchanged`, async () => {
  const f = await fixture(runtime, []);
  try {
    const resource = workspaceFileCardResource('notebook', 'hub:default');
    const base = '/api/hub/v1/workspace/file-cards/' + encodeURIComponent(resource);
    const before = await (await f.hub.request(base)).json();
    const response = await f.hub.request(base + '/file-binding', { method: 'POST', body: JSON.stringify({
      requestId: randomUUID(), sessionId: f.sessionId, revision: before.revision,
    }) });
    assert.equal(response.status, 409);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(f.installs(), 0); assert.equal(f.writes(), 0); assert.equal(f.streams(), 0);
    assert.equal(f.store.cardFiles.current('default', resource), undefined);
    assert.deepEqual(await (await f.hub.request(base)).json(), before);
  } finally { await f.close(); }
});

test('fresh binding can save before SSE without bypassing concurrent Agent CAS', async () => {
  const f = await fixture();
  try {
    for (const concurrent of [false, true]) {
      const resource = workspaceFileCardResource('notebook', `hub:${randomUUID()}`);
      const base = '/api/hub/v1/workspace/file-cards/' + encodeURIComponent(resource);
      const bound = await f.hub.request(base + '/file-binding', { method: 'POST', body: JSON.stringify({ requestId: randomUUID(), sessionId: f.sessionId, revision: 0 }) });
      assert.equal(bound.status, 200); const { binding } = await bound.json();
      assert.ok(!f.store.cardFiles.get('default', binding.bindingId)?.sourceHash);
      const initial = f.store.cardFileProjection.get('default', resource)!;
      if (concurrent) await atomicAgentEdit(f.remote.get('default', binding.bindingId).path,
        { kind: 'notebook', content: { title: 'Agent', text: 'Preserve new Agent text', archive: '' } });
      const before = f.writes();
      const saved = await f.hub.request(base + `/file-binding/${binding.bindingId}/writes`, { method: 'POST', body: JSON.stringify({
        kind: 'notebook', content: { title: 'Human', text: 'First edit', archive: '' }, revision: initial.revision, mutationId: randomUUID(),
      }) });
      assert.equal(saved.status, concurrent ? 409 : 200);
      assert.equal(f.writes(), before + (concurrent ? 0 : 1));
      assert.equal(f.store.cardFileProjection.get('default', resource)!.content.title, concurrent ? 'Agent' : 'Human');
      assert.equal(f.streams(), 0, 'First save does not rely on subscription timing');
    }
  } finally { await f.close(); }
});

test('initial snapshot unavailable never advertises writable or submits a mutation', async () => {
  const f = await fixture();
  try {
    const resource = workspaceFileCardResource('notebook', 'hub:default');
    const base = '/api/hub/v1/workspace/file-cards/' + encodeURIComponent(resource);
    const bound = await f.hub.request(base + '/file-binding', { method: 'POST', body: JSON.stringify({ requestId: randomUUID(), sessionId: f.sessionId, revision: 0 }) });
    assert.equal(bound.status, 200);
    f.failSnapshot();
    assert.equal((await f.hub.request(base + '/file-binding/capabilities')).status, 503);
    assert.equal(f.writes(), 0);
    assert.equal((await (await f.hub.request(base + '/file-binding/capabilities')).json()).writable, true);
    assert.equal(f.writes(), 0, 'Retry is read-only');
    assert.equal(f.snapshots(), 2, 'One failed read and one successful baseline read');
    for (let n = 0; n < 3; n++)
      assert.equal((await (await f.hub.request(base + '/file-binding/capabilities')).json()).writable, true);
    assert.equal(f.snapshots(), 2, 'Established baseline does not add repeated snapshot polling');
  } finally { await f.close(); }
});

test('production private resolver + Hub HTTP + Connector SSE writes native notebook both ways; lost replies never replay', async () => {
  const f = await fixture();
  try {
    const resource = workspaceFileCardResource('notebook', 'hub:default');
    const base = '/api/hub/v1/workspace/file-cards/' + encodeURIComponent(resource);
    const bind = await f.hub.request(base + '/file-binding', { method: 'POST', body: JSON.stringify({ requestId: randomUUID(), sessionId: f.sessionId, revision: 0 }) });
    assert.equal(bind.status, 200);
    const { binding } = await bind.json();
    f.service.start(); await until(() => !!f.store.cardFiles.get('default', binding.bindingId)?.sourceHash);
    assert.equal(f.streams(), 1);
    assert.equal((await (await f.hub.request(base + '/file-binding/capabilities')).json()).writable, true);
    const input = { kind: 'notebook' as const, content: { title: 'UI', text: 'User edit', archive: '' }, revision: f.store.cardFileProjection.get('default', resource)!.revision, mutationId: randomUUID() };
    f.loseWrite();
    const write = await f.hub.request(base + `/file-binding/${binding.bindingId}/writes`, { method: 'POST', body: JSON.stringify(input) });
    assert.equal(write.status, 200); assert.equal((await write.json()).receipt.state, 'uncertain');
    await until(() => f.store.cardFileProjection.get('default', resource)?.content.title === 'UI');
    const path = f.remote.get('default', binding.bindingId).path;
    assert.equal(parseCardFile(await readFile(path))?.content.content.title, 'UI');
    await writeFile(path, serializeCardFile({ kind: 'notebook', content: { title: 'Agent', text: '# Agent update', archive: '' } }));
    await until(() => f.store.cardFileProjection.get('default', resource)?.content.title === 'Agent');
    f.failSnapshot();
    const failedReadback = await f.hub.request(base + `/file-binding/${binding.bindingId}/writes/${input.mutationId}`);
    assert.equal(failedReadback.status, 503, 'saved receipt with unavailable readback must remain pending at the UI');
    assert.equal(f.writes(), 1);
    const again = await f.hub.request(base + `/file-binding/${binding.bindingId}/writes`, { method: 'POST', body: JSON.stringify(input) });
    assert.equal((await again.json()).receipt.state, 'saved'); assert.equal(f.writes(), 1);
    assert.equal(f.store.notebooks.get('default', JSON.stringify(['hub-notebook', 1])).text, '# Agent update', 'inspection reads current content, never rolls back to old receipt snapshot');
    f.other(); assert.equal((await f.hub.request(base + `/file-binding/${binding.bindingId}`)).status, 404);
    const restarted = await f.restart();
    assert.equal((await restarted.inspectWrite('default', resource, binding.bindingId, input.mutationId)).state, 'saved');
    assert.equal(f.installs(), 1); assert.equal(f.writes(), 1);
    assert.equal(f.store.notebooks.get('default', JSON.stringify(['hub-notebook', 1])).text, '# Agent update');
  } finally { await f.close(); }
});

test('configuration API stores desired settings only and rejects executable or cross-kind fields', async () => {
  const f = await fixture();
  try {
    const resource = workspaceFileCardResource('terminal', randomUUID()), base = '/api/hub/v1/workspace/file-cards/' + encodeURIComponent(resource);
    const absent = await f.hub.request(base + '/configuration');
    assert.equal(absent.status, 200); assert.equal(absent.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await absent.json(), { document: null });
    assert.equal((await f.hub.request(base)).status, 404, 'mandatory content reads retain missing-resource semantics');
    const input = { kind: 'terminal', content: { title: 'Shell', connectionId: 'local', targetId: 'daily-shell' }, revision: 0, mutationId: randomUUID() };
    const put = (value: unknown) => f.hub.request(base + '/configuration', { method: 'PUT', body: JSON.stringify(value) });
    assert.equal((await put({ ...input, content: { ...input.content, command: 'execute' } })).status, 400);
    assert.equal((await put(input)).status, 200);
    assert.equal((await f.hub.request(base)).status, 200);
    const saved = await (await f.hub.request(base + '/configuration')).json();
    assert.equal(saved.document.kind, 'terminal'); assert.deepEqual(saved.document.content, input.content);
    assert.equal(f.installs(), 0); assert.equal(f.writes(), 0); assert.equal(f.streams(), 0);
    f.other(); assert.equal((await f.hub.request(base)).status, 404);
    assert.deepEqual(await (await f.hub.request(base + '/configuration')).json(), { document: null }, 'account isolation');
    assert.equal((await f.hub.request(base + '/configuration?other=user')).status, 400);
    assert.equal((await f.hub.request('/api/hub/v1/workspace/file-cards/' + encodeURIComponent(workspaceFileCardResource('report', randomUUID())) + '/configuration')).status, 400);
  } finally { await f.close(); }
});

test('native report HTTP save is atomic, idempotent and cannot change destination on retry', async () => {
  const f = await fixture();
  try {
    const id = randomUUID(), resource = workspaceFileCardResource('report', id), base = '/api/hub/v1/workspace/file-cards/' + encodeURIComponent(resource);
    const put = (input: unknown, bindingId = 'none') => f.hub.request(base + '/document', { method: 'PUT', headers: { 'X-AgentOpsDeck-File-Binding': bindingId }, body: JSON.stringify(input) });
    const original = { kind: 'report', content: { title: 'Local title', text: '# Original' }, revision: 0, mutationId: randomUUID() };
    const saved = await put(original); assert.equal(saved.status, 200);
    const document = await saved.json(); assert.equal(document.revision, 2);
    assert.equal((await put(original)).status, 200);
    assert.equal((await put({ ...original, content: { ...original.content, text: 'UUID collision' } })).status, 409);
    assert.equal((await put({ ...original, mutationId: randomUUID() })).status, 409);
    const bound = await f.hub.request(base + '/file-binding', { method: 'POST', body: JSON.stringify({ requestId: randomUUID(), sessionId: f.sessionId, revision: document.revision }) });
    assert.equal(bound.status, 200); const { binding } = await bound.json();
    f.service.start(); await until(() => !!f.store.cardFiles.get('default', binding.bindingId)?.sourceHash);
    assert.equal((await put(original)).status, 409, 'old local intent cannot become a file save');
    assert.equal(f.writes(), 0);
    const input = { ...original, content: { title: 'Bound title', text: 'Bound text' }, revision: f.store.cardFileProjection.get('default', resource)!.revision, mutationId: randomUUID() };
    f.loseWrite(); assert.equal((await put(input, binding.bindingId)).status, 503);
    assert.equal((await put(input, binding.bindingId)).status, 200);
    assert.equal(f.writes(), 1, 'native retry only inspects the original write');
    assert.equal(parseCardFile(await readFile(f.remote.get('default', binding.bindingId).path))?.content.content.title, 'Bound title');
    assert.deepEqual(f.store.cardFileProjection.revisions('default').map(value => ({ ...value })), [{ resourceId: id, revision: input.revision + 2 }]);
    f.other(); assert.equal((await put(input, binding.bindingId)).status, 409); assert.equal(f.writes(), 1);
  } finally { await f.close(); }
});

test('native notebook body round trips Agent → editor → Agent and protects newer body from stale saves', async () => {
  const f = await fixture();
  try {
    const resource = workspaceFileCardResource('notebook', 'hub:default');
    const base = '/api/hub/v1/workspace/file-cards/' + encodeURIComponent(resource);
    const bound = await f.hub.request(base + '/file-binding', { method: 'POST', body: JSON.stringify({ requestId: randomUUID(), sessionId: f.sessionId, revision: 0 }) });
    assert.equal(bound.status, 200); const { binding } = await bound.json();
    f.service.start(); await until(() => !!f.store.cardFiles.get('default', binding.bindingId)?.sourceHash);
    const path = f.remote.get('default', binding.bindingId).path;
    const resourceId = JSON.stringify(['hub-notebook', 1]);
    const deps = { hubStore: f.store, fileCards: f.service, fileCardsEnabled: true };
    const body = '# Agent 正文\n\n**保留原文**\n- [ ] 验收';
    await atomicAgentEdit(path, { kind: 'notebook', content: { title: 'Stable title', text: body, archive: '' } });
    await until(() => f.store.notebooks.get('default', resourceId).text === body);
    const human = { resourceId, revision: f.store.notebooks.get('default', resourceId).revision, text: body + '\n\n人补充的段落' };
    f.loseWrite();
    await assert.rejects(writeBoundNotebook(deps, 'default', 'hub:default', human), error => (error as { status: number }).status === 503);
    assert.equal((await writeBoundNotebook(deps, 'default', 'hub:default', human))?.text, human.text);
    assert.equal(f.writes(), 1, 'lost acknowledgement only inspects original write');
    const file = parseCardFile(await readFile(path))!.content;
    assert.equal(file.kind, 'notebook');
    if (file.kind !== 'notebook') throw Error('wrong card');
    assert.deepEqual(file.content, { title: 'Stable title', text: human.text, archive: '' });
    const next = file.content.text + '\n\nAgent 读取并保留人的补充';
    const stale = { resourceId, revision: f.store.notebooks.get('default', resourceId).revision, text: 'stale replacement' };
    await atomicAgentEdit(path, { kind: 'notebook', content: { ...file.content, text: next } });
    await until(() => f.store.notebooks.get('default', resourceId).text === next);
    await assert.rejects(writeBoundNotebook(deps, 'default', 'hub:default', stale), error => (error as { status: number }).status === 409);
    assert.equal(f.store.notebooks.get('default', resourceId).text, next);
    assert.equal(f.writes(), 1);
  } finally { await f.close(); }
});

test('native notebook title+geometry retry writes once and never overwrites a later move', async () => {
  const f = await fixture();
  try {
    const resource = workspaceFileCardResource('notebook', 'hub:default'), base = '/api/hub/v1/workspace/file-cards/' + encodeURIComponent(resource);
    const bound = await f.hub.request(base + '/file-binding', { method: 'POST', body: JSON.stringify({ requestId: randomUUID(), sessionId: f.sessionId, revision: 0 }) });
    assert.equal(bound.status, 200); const { binding } = await bound.json();
    f.service.start(); await until(() => !!f.store.cardFiles.get('default', binding.bindingId)?.sourceHash);
    const deps = { hubStore: f.store, fileCards: f.service, fileCardsEnabled: true };
    const layoutId = JSON.stringify(['hub-notebook-layout', 1, 'default']);
    const input = { resourceId: layoutId, revision: f.store.notebooks.get('default', layoutId).revision, text: JSON.stringify({ ...DEFAULT_HUB_NOTEBOOK_LAYOUT, title: 'Renamed', x: 140 }) };
    await assert.rejects(writeBoundNotebook(deps, 'default', 'hub:default', { ...input, revision: 0 }, true), error => (error as { status: number }).status === 409);
    assert.equal(f.writes(), 0, 'pre-binding private title must not be written to the Agent file');
    f.loseWrite(); await assert.rejects(writeBoundNotebook(deps, 'default', 'hub:default', input, true), error => (error as { status: number }).status === 503);
    const saved = await writeBoundNotebook(deps, 'default', 'hub:default', input, true);
    assert.equal(JSON.parse(saved!.text).x, 140); assert.equal(f.writes(), 1);
    assert.equal((await writeBoundNotebook(deps, 'default', 'hub:default', input, true))?.text, saved!.text);
    assert.ok(f.store.notebooks.save('default', { ...saved!, text: JSON.stringify({ ...JSON.parse(saved!.text), x: 220 }) }));
    await assert.rejects(writeBoundNotebook(deps, 'default', 'hub:default', input, true), error => (error as { status: number }).status === 409);
    assert.equal(JSON.parse(f.store.notebooks.get('default', layoutId).text).x, 220); assert.equal(f.writes(), 1);
  } finally { await f.close(); }
});

const cards: WorkspaceFileCard[] = [
  { kind: 'taskboard', content: { title: 'Tasks', tasks: [] } },
  { kind: 'statuscard', content: { title: 'Status', tasks: [] } },
  { kind: 'notebook', content: { title: 'Note', text: '- [ ] Task' } },
  { kind: 'report', content: { title: 'Report', text: '# Findings' } },
  { kind: 'metric-card', content: { title: 'Metric', value: 'OK', detail: '', tone: 'green', progress: 100 } },
  { kind: 'drawing', content: { format: 'agentopsdeck-drawing', version: 1, title: 'Drawing', nodes: [], edges: [], strokes: [] } },
  { kind: 'native-drawio', content: emptyNativeDrawio() },
  { kind: 'website', content: { title: 'Site', connectionId: 'local', websiteId: 'app' } },
  { kind: 'browser', content: { title: 'Browser', url: 'https://example.org/' } },
  { kind: 'research', content: { title: 'Search', query: 'test', sources: [] } },
  { kind: 'terminal', content: { title: 'Shell', connectionId: 'local', targetId: 'daily' } },
  { kind: 'media', content: { title: 'Media', mediaId: 'sample' } },
  { kind: 'dashboard', content: { title: 'Dashboard', description: '', items: [] } },
];
// Real business fields, not just the common title. Stable object identities
// make accidental reconstruction/deletion of unrelated content observable.
const ids = Array.from({ length: 4 }, () => randomUUID());
function editedContent(card: WorkspaceFileCard, phase: number): WorkspaceFileCard {
  const title = `${card.kind} ${phase} 中文 ✅`;
  switch (card.kind) {
    case 'taskboard': case 'statuscard': return { kind: card.kind, content: { title, tasks: [
      { id: ids[0]!, title: 'Keep this task', detail: 'Unrelated user content', status: 'todo', tags: ['保留'], priority: 'normal', dueDate: '2028-02-29' },
      { id: ids[1]!, title: 'Verify interaction', detail: `Evidence ${phase}\nsecond line`, status: phase === 1 ? 'doing' : 'done',
        ...(phase === 1 ? { tags: ['同步'], priority: 'urgent' as const, dueDate: '2028-03-01' } : {}) },
    ] } };
    case 'notebook': case 'report': return { kind: card.kind, content: { title, text: `# Evidence ${phase}\n\n- [${phase === 1 ? ' ' : 'x'}] Review 中文\n\n**Keep this**\n\n\`code\``, ...(card.kind === 'notebook' ? { archive: `Archived evidence ${phase}` } : {}) } };
    case 'metric-card': return { kind: card.kind, content: { title, value: `${phase * 25}%`, detail: `Measurement ${phase}`, tone: phase === 1 ? 'blue' : 'green', progress: phase * 25 } };
    case 'drawing': return { kind: card.kind, content: { format: 'agentopsdeck-drawing', version: 1, title,
      nodes: [
        { id: ids[0]!, x: 10, y: 10, width: 100, height: 60, text: 'Keep node', color: '#336699' },
        { id: ids[1]!, x: 200 + phase * 10, y: 100, width: 120, height: 80, text: `Node ${phase}`, color: '#22aa44' },
      ], edges: [{ id: ids[2]!, from: ids[0]!, to: ids[1]! }],
      strokes: [{ id: ids[3]!, color: '#ff8800', width: phase, points: [[20, 30], [40 + phase, 50]] }] } };
    case 'native-drawio': return { kind: card.kind, content: { ...emptyNativeDrawio(), title,
      xml: `<mxfile><diagram id="stable-page" name="Page"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="node" value="Phase ${phase}" vertex="1" parent="1"><mxGeometry x="${phase * 10}" y="20" width="120" height="60" as="geometry"/></mxCell></root></mxGraphModel></diagram></mxfile>` } };
    case 'website': return { kind: card.kind, content: { title, connectionId: `environment-${phase}`, websiteId: `site-${phase}` } };
    case 'browser': return { kind: card.kind, content: { title, url: `https://example.org/read/${phase}?q=hello#section` } };
    case 'research': return { kind: card.kind, content: { title, query: `Query ${phase}`, sources: [
      { title: 'Keep source', url: 'https://example.org/original', excerpt: 'Original citation' },
      { title: `Source ${phase}`, url: `https://example.org/${phase}`, excerpt: 'Evidence\n中文' },
    ] } };
    case 'terminal': return { kind: card.kind, content: { title, connectionId: `environment-${phase}`, targetId: `shell-${phase}` } };
    case 'media': return { kind: card.kind, content: { title, mediaId: `clip-${phase}` } };
    case 'dashboard': return { kind: card.kind, content: { title, description: `Summary ${phase}`, items: [
      { label: 'Keep item', value: 'Original' }, { label: 'Progress', value: `${phase}` },
    ] } };
  }
}
const canonical = (card: WorkspaceFileCard) => workspaceFileCardContent(card);
async function atomicAgentEdit(path: string, card: WorkspaceFileCard) {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, serializeCardFile(card)); await rename(temp, path);
}
test('HTTP coverage includes all card schemas', () => assert.deepEqual(cards.map(c => c.kind).sort(), [...WORKSPACE_FILE_CARD_KINDS].sort()));
for (const runtime of FILE_BOARD_RUNTIMES) for (const card of cards)
test(`${runtime}/${card.kind}: content roundtrips, stale human edit, invalid recovery, lost receipt and unlink`, async () => {
  const f = await fixture(runtime);
  try {
    const id = card.kind === 'notebook' ? 'hub:default' : randomUUID(), resource = workspaceFileCardResource(card.kind, id);
    const base = '/api/hub/v1/workspace/file-cards/' + encodeURIComponent(resource);
    if (card.kind === 'metric-card') assert.equal(f.store.cards.save('default', id, { ...card.content, revision: 0, mutationId: randomUUID() }).status, 'saved');
    if (['website', 'browser', 'research', 'terminal', 'media', 'dashboard'].includes(card.kind))
      assert.equal((await f.hub.request(base + '/configuration', { method: 'PUT', body: JSON.stringify({ ...card, revision: 0, mutationId: randomUUID() }) })).status, 200);
    const document = await (await f.hub.request(base)).json();
    const response = await f.hub.request(base + '/file-binding', { method: 'POST', body: JSON.stringify({ requestId: randomUUID(), sessionId: f.sessionId, revision: document.revision }) });
    assert.equal(response.status, 200); const { binding } = await response.json();
    f.service.start(); await until(() => !!f.store.cardFiles.get('default', binding.bindingId)?.sourceHash);
    const path = f.remote.get('default', binding.bindingId).path;
    const agent = editedContent(card, 1);
    await atomicAgentEdit(path, agent);
    await until(() => f.store.cardFileProjection.get('default', resource)?.content.title === agent.content.title);
    const next = await (await f.hub.request(base)).json();
    assert.deepEqual(canonical(next), canonical(agent), 'all Agent fields reach Hub/native projection');
    const human = editedContent(card, 2);
    const input = { ...human, revision: next.revision, mutationId: randomUUID() };
    const write = (value: unknown) => f.hub.request(base + `/file-binding/${binding.bindingId}/writes`, { method: 'POST', body: JSON.stringify(value) });
    const result = await write(input);
    assert.equal(result.status, 200); assert.equal((await result.json()).receipt.state, 'saved');
    const observed = parseCardFile(await readFile(path))!.content;
    assert.deepEqual(observed, canonical(human), 'next Agent reads actual human business edits');
    // Agent performs a read-modify-write, retaining every human field.
    const continued = { ...observed, content: { ...observed.content, title: 'Agent acknowledged human content' } } as WorkspaceFileCard;
    await atomicAgentEdit(path, continued);
    await until(() => f.store.cardFileProjection.get('default', resource)?.content.title === continued.content.title);
    assert.deepEqual(canonical(await (await f.hub.request(base)).json()), canonical(continued));
    assert.equal((await write({ ...input, mutationId: randomUUID() })).status, 409, 'stale human draft cannot overwrite Agent');
    assert.equal(f.writes(), 1, 'stale draft rejected before Connector mutation');

    for (const invalid of ['{"version":1,', JSON.stringify({ version: 1, kind: 'browser', content: { title: 'Wrong schema', url: 'javascript:alert(1)' } })]) {
      await writeFile(path, invalid);
      await until(() => !!f.store.cardFiles.get('default', binding.bindingId)?.problem);
      assert.deepEqual(canonical(await (await f.hub.request(base)).json()), canonical(continued), 'invalid source retains last good content');
      await atomicAgentEdit(path, continued);
      await until(() => !f.store.cardFiles.get('default', binding.bindingId)?.problem);
    }

    const latest = await (await f.hub.request(base)).json();
    const final = editedContent(card, 3), finalInput = { ...final, revision: latest.revision, mutationId: randomUUID() };
    f.loseWrite();
    assert.equal((await (await write(finalInput)).json()).receipt.state, 'uncertain');
    const inspected = await f.hub.request(base + `/file-binding/${binding.bindingId}/writes/${finalInput.mutationId}`);
    assert.equal((await inspected.json()).receipt.state, 'saved');
    assert.deepEqual(parseCardFile(await readFile(path))!.content, canonical(final));
    assert.equal(f.writes(), 2, 'inspection never repeats a mutation');
    const unlinked = await f.hub.request(base + `/file-binding/${binding.bindingId}`, { method: 'DELETE' });
    assert.equal(unlinked.status, 200);
    assert.deepEqual(canonical(await (await f.hub.request(base)).json()), final.kind === 'notebook'
      ? { kind: 'notebook', content: { title: final.content.title, text: final.content.text } } : canonical(final), 'unlink keeps native hot projection');
    assert.deepEqual(parseCardFile(await readFile(path))!.content, canonical(final), 'unlink keeps file');
    assert.equal((await write({ ...finalInput, mutationId: randomUUID() })).status, 409, 'revoked binding rejects writes');
    assert.equal(f.writes(), 2);
    assert.equal(f.streams(), 1, 'one shared subscription, no per-edit streams');
  } finally { await f.close(); }
});

test('13 active cards share one stream and concurrent edits remain resource/owner isolated', async () => {
  const f = await fixture();
  try {
    const entries: { card: WorkspaceFileCard; resource: string; base: string; binding: { bindingId: string }; path: string }[] = [];
    for (const card of cards) {
      const id = card.kind === 'notebook' ? 'hub:default' : randomUUID();
      const resource = workspaceFileCardResource(card.kind, id), base = '/api/hub/v1/workspace/file-cards/' + encodeURIComponent(resource);
      if (card.kind === 'metric-card') f.store.cards.save('default', id, { ...card.content, revision: 0, mutationId: randomUUID() });
      if (['website', 'browser', 'research', 'terminal', 'media', 'dashboard'].includes(card.kind))
        assert.equal((await f.hub.request(base + '/configuration', { method: 'PUT', body: JSON.stringify({ ...card, revision: 0, mutationId: randomUUID() }) })).status, 200);
      const document = await (await f.hub.request(base)).json();
      const response = await f.hub.request(base + '/file-binding', { method: 'POST', body: JSON.stringify({ requestId: randomUUID(), sessionId: f.sessionId, revision: document.revision }) });
      assert.equal(response.status, 200);
      const { binding } = await response.json();
      entries.push({ card, resource, base, binding, path: f.remote.get('default', binding.bindingId).path });
    }
    f.service.start();
    await until(() => entries.every(e => !!f.store.cardFiles.get('default', e.binding.bindingId)?.sourceHash));
    await Promise.all(entries.map(e => atomicAgentEdit(e.path, editedContent(e.card, 1))));
    await until(() => entries.every(e => f.store.cardFileProjection.get('default', e.resource)?.content.title === editedContent(e.card, 1).content.title));
    await Promise.all(entries.map(async e => {
      const document = await (await f.hub.request(e.base)).json(), human = editedContent(e.card, 2);
      assert.deepEqual(canonical(document), canonical(editedContent(e.card, 1)));
      const reply = await f.hub.request(e.base + `/file-binding/${e.binding.bindingId}/writes`, { method: 'POST',
        body: JSON.stringify({ ...human, revision: document.revision, mutationId: randomUUID() }) });
      assert.equal(reply.status, 200); assert.equal((await reply.json()).receipt.state, 'saved');
      assert.deepEqual(parseCardFile(await readFile(e.path))!.content, canonical(human));
    }));
    assert.equal(f.streams(), 1); assert.equal(f.writes(), 13);
    f.other();
    for (const e of entries) {
      const reply = await f.hub.request(e.base + `/file-binding/${e.binding.bindingId}`);
      assert.equal(reply.status, 404, 'another owner cannot inspect the card binding');
    }
    assert.equal(f.writes(), 13);
    const restarted = await f.restart();
    for (const e of entries) {
      await restarted.refresh('default', e.resource, e.binding.bindingId);
      assert.deepEqual(canonical(f.store.cardFileProjection.get('default', e.resource)!), canonical(editedContent(e.card, 2)));
    }
    assert.equal(f.writes(), 13, 'restart performs no replay');
    assert.equal(f.installs(), 13, 'restart does not recreate files');
  } finally { await f.close(); }
});
