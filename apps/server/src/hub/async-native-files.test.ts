import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {BoardWrite, WorkspaceFileCardWrite} from '@agentopsdeck/shared';
import {asyncNativeFileFixture, deferredNative, nativeNotebook} from './async-native-file-fixture.js';
import {nativeFileExpectation, validHubNativeFileCommand, validHubNativeFileReply, validHubNativeFileResult, type NativeFileWrite} from './member-native-file-domain.js';
import {notebookHash} from './notebook-operations.js';

// Original synchronous settlement is not a cross-file contention test. The
// source runner removes this private coordinator after the test process exits.
const coordinatorTemp = mkdtempSync(join(tmpdir(), 'native-files-coordinator-'));
for (const name of ['TMPDIR', 'TMP', 'TEMP']) process.env[name] = coordinatorTemp;

const changed = (document: NativeFileWrite, title = 'Changed'): NativeFileWrite => 'kind' in document
  ? {kind: 'notebook', content: {...(document as Extract<WorkspaceFileCardWrite, {kind: 'notebook'}>).content, title}, revision: document.revision, mutationId: randomUUID()}
  : {...document, title, mutationId: randomUUID()};
const status = (code: number) => (e: unknown) => !!e && typeof e === 'object' && 'status' in e && e.status === code;

for (const mode of ['original', 'worker'] as const) {
  for (const domain of ['board', 'card'] as const) {
    test(`${mode}/${domain}: real Connector install, baseline, exact original receipt, terminal fence and reopen`, async t => {
      const f = await asyncNativeFileFixture(t, mode, domain), port = await f.begin(), id = randomUUID();
      assert.equal((await port.bind({requestId: id, sessionId: f.sessionId, revision: f.revision})).state, 'active');
      assert.equal(await port.writable(), true);
      const input = changed(await f.document(id));
      const written = await port.write(id, {mode: 'ordinary', input});
      assert.deepEqual(written, {mutationId: input.mutationId, state: 'saved'}, JSON.stringify({
        calls: f.calls, diagnostics: f.logs.map(line => {
          const row = JSON.parse(line); return {operation: row.operation, step: row.step, unknown: row.unknown, deferred: row.deferred};
        }).slice(-8),
      }));
      assert.deepEqual(await port.write(id, {mode: 'ordinary', input}), {mutationId: input.mutationId, state: 'saved'});
      const altered = changed(input, 'Different body'); altered.mutationId = input.mutationId;
      await assert.rejects(port.write(id, {mode: 'ordinary', input: altered}), status(409));
      const receipt = await f.ok({...f.scope, action: 'write-read', bindingId: id, mutationId: input.mutationId});
      assert.equal(receipt.receipt?.state, 'saved'); assert.ok(receipt.target);
      assert.deepEqual(await f.command({...f.scope, action: 'write-settle', bindingId: id, target: receipt.target, mutationId: input.mutationId,
        expectedHash: receipt.receipt!.expectedHash, state: 'conflict', snapshot: null}), {error: 409});
      assert.equal(f.calls.install, 1); assert.equal(f.calls.write, 1);
      await f.reopen();
      const resumed = await f.begin(undefined, {cookie: 'agentopsdeck_session=' + f.cookie});
      assert.deepEqual(await resumed.inspectWrite(id, input.mutationId), {mutationId: input.mutationId, state: 'saved'});
      assert.equal((await resumed.revoke(id)).cleanup, 'confirmed');
      assert.equal((await resumed.get(id)).state, 'revoked');
      assert.equal(f.calls.install, 1); assert.equal(f.calls.write, 1);
    });
    test(`${mode}/${domain}: lost install response and reopen never repeat PUT`, async t => {
      const f = await asyncNativeFileFixture(t, mode, domain), id = randomUUID();
      f.hooks.after = async (request, response) => {if (request.method === 'PUT') {await response.text(); throw Error('PRIVATE_LOST_INSTALL');} return response;};
      assert.equal((await (await f.begin()).bind({requestId: id, sessionId: f.sessionId, revision: f.revision})).state, 'prepared');
      f.hooks.after = undefined; await f.reopen();
      const port = await f.begin();
      assert.equal((await port.bind({requestId: id, sessionId: f.sessionId, revision: f.revision})).state, 'prepared');
      assert.equal((await port.inspect(id)).state, 'active');
      assert.equal(await port.writable(), true); assert.equal(f.calls.install, 1);
    });
    test(`${mode}/${domain}: lost write response recovers receipt and CURRENT Agent contents, never historical snapshot`, async t => {
      const f = await asyncNativeFileFixture(t, mode, domain), port = await f.begin(), id = randomUUID();
      await port.bind({requestId: id, sessionId: f.sessionId, revision: f.revision}); await port.writable();
      const input = changed(await f.document(id));
      f.hooks.after = async (request, response) => {if (request.method === 'POST') {await response.text(); throw Error('PRIVATE_LOST_WRITE');} return response;};
      assert.equal((await port.write(id, {mode: 'ordinary', input})).state, 'uncertain');
      const document = JSON.parse(await readFile(f.remotePath(id), 'utf8')) as {title?: string; content?: {title: string}};
      if (document.content) document.content.title = 'Later Agent'; else document.title = 'Later Agent';
      await writeFile(f.remotePath(id), JSON.stringify(document));
      f.hooks.after = undefined; await f.reopen();
      assert.equal((await (await f.begin()).write(id, {mode: 'ordinary', input})).state, 'saved');
      const current = await f.document(id);
      assert.equal('kind' in current ? (current as Extract<WorkspaceFileCardWrite, {kind: 'notebook'}>).content.title : current.title, 'Later Agent');
      assert.equal(f.calls.install, 1); assert.equal(f.calls.write, 1); assert.equal(f.calls.receipt, 1);
    });
  }
  test(`${mode}: cancelled capability preflight tombstones late installation`, async t => {
    const f = await asyncNativeFileFixture(t, mode), port = await f.begin(), id = randomUUID();
    f.hooks.before = async request => {if (new URL(request.url).pathname.endsWith('/board-files')) {f.hooks.before = undefined; await port.cancel(id);}};
    await assert.rejects(port.bind({requestId: id, sessionId: f.sessionId, revision: f.revision}), status(409));
    assert.equal(f.calls.install, 0); assert.equal(await port.current(), null);
    await f.reopen(); await assert.rejects((await f.begin()).bind({requestId: id, sessionId: f.sessionId, revision: f.revision}), status(409));
  });
  test(`${mode}: revoked identity during preflight cannot admit a durable binding`, async t => {
    const f = await asyncNativeFileFixture(t, mode), port = await f.begin();
    f.hooks.before = async request => {if (new URL(request.url).pathname.endsWith('/board-files')) {f.hooks.before = undefined; await f.revokeKey();}};
    await assert.rejects(port.bind({requestId: randomUUID(), sessionId: f.sessionId, revision: f.revision}), status(401));
    assert.equal(f.calls.install, 0);
  });
  test(`${mode}: unknown admission ACK before dispatch remains inspect-only after reopen`, async t => {
    const f = await asyncNativeFileFixture(t, mode), port = await f.begin(), id = randomUUID();
    await port.bind({requestId: id, sessionId: f.sessionId, revision: f.revision}); await port.writable();
    const input = changed(await f.document(id));
    f.hooks.ack = command => {if (command.action === 'write-admit') throw Error('PRIVATE_LOST_COMMIT_ACK');};
    await assert.rejects(port.write(id, {mode: 'ordinary', input}));
    assert.equal(f.calls.write, 0); f.hooks.ack = undefined; await f.reopen();
    assert.deepEqual(await (await f.begin()).write(id, {mode: 'ordinary', input}), {mutationId: input.mutationId, state: 'uncertain'});
    assert.equal(f.calls.write, 0); assert.equal(f.calls.receipt, 1);
  });
  test(`${mode}: browser abort after admission suppresses delivery but retains exact write settlement`, async t => {
    const f = await asyncNativeFileFixture(t, mode), abort = new AbortController(), port = await f.begin(abort.signal), id = randomUUID();
    await port.bind({requestId: id, sessionId: f.sessionId, revision: f.revision}); await port.writable();
    const entered = deferredNative(), release = deferredNative(), input = changed(await f.document(id));
    f.hooks.ack = async command => {if (command.action === 'write-admit') {entered.resolve(); await release.promise;}};
    const flight = port.write(id, {mode: 'ordinary', input}); await entered.promise;
    abort.abort(); release.resolve(); await assert.rejects(flight, status(499));
    assert.equal((await f.ok({...f.scope, action: 'write-read', bindingId: id, mutationId: input.mutationId})).receipt?.state, 'saved');
    assert.equal(f.calls.write, 1); assert.equal(f.current().service.active, 0);
  });
  test(`${mode}: close waits for original settlement ACK before retiring SQL lane`, async t => {
    const f = await asyncNativeFileFixture(t, mode), port = await f.begin(), id = randomUUID();
    await port.bind({requestId: id, sessionId: f.sessionId, revision: f.revision}); await port.writable();
    const entered = deferredNative(), release = deferredNative(), input = changed(await f.document(id));
    f.hooks.ack = async command => {if (command.action === 'write-settle') {entered.resolve(); await release.promise;}};
    const flight = port.write(id, {mode: 'ordinary', input});
    // Attach rejection before close freezes delivery.
    const rejected = assert.rejects(flight, status(503)); await entered.promise;
    let closed = false; const closing = f.current().service.close().then(() => {closed = true;});
    await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(closed, false);
    assert.equal(f.current().service.active, 1); release.resolve(); await Promise.all([closing, rejected]);
    assert.equal((await f.ok({...f.scope, action: 'write-read', bindingId: id, mutationId: input.mutationId})).receipt?.state, 'saved');
  });
  test(`${mode}: delayed refresh cannot overwrite a newer original stream projection`, async t => {
    const f = await asyncNativeFileFixture(t, mode), port = await f.begin(), id = randomUUID();
    await port.bind({requestId: id, sessionId: f.sessionId, revision: f.revision}); await port.writable();
    const initial = await port.get(id), target = (await f.ok({...f.scope, action: 'target', sessionId: f.sessionId})).target!;
    f.hooks.after = async (request, response) => {
      if (new URL(request.url).pathname.endsWith('/snapshot')) {
        f.hooks.after = undefined;
        await f.ok({...f.scope, action: 'refresh-apply', bindingId: id, target, baseline: initial.sourceHash, snapshot: f.snapshot({title: 'New stream', tasks: []})});
      }
      return response;
    };
    await port.refresh(id); assert.equal((await f.document(id) as BoardWrite).title, 'New stream');
  });
  test(`${mode}: complete notebook move admission and settlement use original same-database receipts`, async t => {
    const f = await asyncNativeFileFixture(t, mode, 'card'), port = await f.begin(), id = randomUUID();
    await port.bind({requestId: id, sessionId: f.sessionId, revision: f.revision}); await port.writable();
    const input = {requestId: randomUUID(), direction: 'archive' as const, ...f.notebookRevisions(), ranges: [{start: 4, end: 7, sha256: notebookHash('old')}]};
    const result = await port.write(id, {mode: 'move', notebookResource: nativeNotebook, input}); assert.equal(result.state, 'saved');
    const finished = await port.finishMove(id, nativeNotebook, input.requestId); assert.equal(finished.moveState, 'saved'); assert.equal(finished.move?.moved, 3);
    assert.deepEqual((await port.finishMove(id, nativeNotebook, input.requestId)).move, finished.move);
    await f.reopen(); assert.equal((await (await f.begin()).write(id, {mode: 'move', notebookResource: nativeNotebook, input})).state, 'saved');
    assert.equal(f.calls.write, 1);
  });
  test(`${mode}: archive recovery ignores downgraded capabilities and a lost admission ACK never becomes negative evidence`, async t => {
    const id = randomUUID(), f = await asyncNativeFileFixture(t, mode, 'card', id), port = await f.begin();
    await port.bind({requestId: id, sessionId: f.sessionId, revision: f.revision});
    const revision = (await f.document(id)).revision, mutationId = randomUUID();
    f.hooks.ack = command => {if (command.action === 'write-admit') throw Error('PRIVATE_ARCHIVE_ADMISSION_ACK');};
    await assert.rejects(port.includeArchive(id, mutationId, revision));
    f.hooks.ack = undefined;
    assert.equal((await f.ok({...f.scope, action: 'archive-status', bindingId: id, mutationId})).receipt?.state, 'uncertain');
    assert.equal(f.calls.write, 0);
    await f.reopen();
    f.hooks.before = request => {
      if (new URL(request.url).pathname.endsWith('/card-files')) assert.fail('admitted archive queried capabilities again');
    };
    const recovered = await (await f.begin()).includeArchive(id, mutationId, revision);
    assert.deepEqual(recovered, {receipt: {mutationId, state: 'uncertain'}});
    assert.equal(f.calls.write, 0); assert.ok(f.calls.receipt >= 1);
  });
  test(`${mode}: archive capability rejection is negative only while its original receipt remains absent`, async t => {
    const id = randomUUID(), f = await asyncNativeFileFixture(t, mode, 'card', id), port = await f.begin();
    await port.bind({requestId: id, sessionId: f.sessionId, revision: f.revision});
    const revision = (await f.document(id)).revision, mutationId = randomUUID();
    f.hooks.after = (request, response) => new URL(request.url).pathname.endsWith('/card-files')
      ? new Response(JSON.stringify({notebookArchiveProtocol: 0}), {headers: response.headers}) : response;
    assert.deepEqual(await port.includeArchive(id, mutationId, revision), {notAdmitted: true});
    assert.equal((await f.ok({...f.scope, action: 'archive-status', bindingId: id, mutationId})).receipt, null);
    assert.equal((await f.document(id) as Extract<WorkspaceFileCardWrite, {kind: 'notebook'}>).content.archive, undefined);
    assert.equal(f.calls.write, 0);
  });
  for (const area of ['hot', 'cold'] as const) test(`${mode}: archive admission rejects a concurrent ${area} edit without broadening the historical binding`, async t => {
    const id = randomUUID(), f = await asyncNativeFileFixture(t, mode, 'card', id), port = await f.begin();
    await port.writable();
    const before = f.notebookRevisions(), revision = (await f.document(id)).revision, mutationId = randomUUID();
    let capabilities = 0;
    f.hooks.before = request => {
      if (request.method !== 'GET' || !new URL(request.url).pathname.endsWith('/card-files') || ++capabilities !== 2) return;
      // Another original writer wins during the external preflight gap.
      f.sql(area === 'hot' ? "UPDATE hub_session_notebooks SET text='late hot',revision=revision+1 WHERE user_id='default' AND resource_id='[\"hub-notebook\",1]'"
        : "INSERT INTO hub_notebook_archives VALUES ('default','[\"hub-notebook\",1]','late cold',1,1)");
    };
    assert.deepEqual(await port.includeArchive(id, mutationId, revision), {notAdmitted: true});
    assert.equal(capabilities, 2);
    assert.equal((await f.ok({...f.scope, action: 'archive-status', bindingId: id, mutationId})).receipt, null);
    assert.equal((await f.document(id) as Extract<WorkspaceFileCardWrite, {kind: 'notebook'}>).content.archive, undefined);
    assert.deepEqual(f.notebookRevisions(), {...before, [area === 'hot' ? 'hotRevision' : 'coldRevision']: before[area === 'hot' ? 'hotRevision' : 'coldRevision'] + 1});
    assert.equal(f.calls.write, 0);
  });
  test(`${mode}: failed archive intent rolls back delegation and original projection before a safe explicit retry`, async t => {
    const id = randomUUID(), f = await asyncNativeFileFixture(t, mode, 'card', id), port = await f.begin();
    await port.writable();
    const before = f.notebookRevisions(), revision = (await f.document(id)).revision, mutationId = randomUUID();
    f.sql("CREATE TRIGGER fail_archive_intent BEFORE INSERT ON hub_workspace_card_file_writes BEGIN SELECT RAISE(ABORT,'fixture'); END");
    await assert.rejects(port.includeArchive(id, mutationId, revision));
    assert.deepEqual(f.notebookRevisions(), before);
    assert.equal((await f.ok({...f.scope, action: 'archive-status', bindingId: id, mutationId})).receipt, null);
    assert.equal((await f.document(id) as Extract<WorkspaceFileCardWrite, {kind: 'notebook'}>).content.archive, undefined);
    assert.equal(f.calls.write, 0);
    f.sql('DROP TRIGGER fail_archive_intent');
    assert.deepEqual(await port.includeArchive(id, mutationId, revision), {receipt: {mutationId, state: 'saved'}});
    assert.equal(f.calls.write, 1); assert.equal(f.calls.install, 0);
  });
  test(`${mode}: notebook move and file-intent failure roll back the full original transaction`, async t => {
    const f = await asyncNativeFileFixture(t, mode, 'card'), port = await f.begin(), id = randomUUID();
    await port.bind({requestId: id, sessionId: f.sessionId, revision: f.revision}); await port.writable();
    const input = {requestId: randomUUID(), direction: 'archive' as const, ...f.notebookRevisions(), ranges: [{start: 4, end: 7, sha256: notebookHash('old')}]};
    f.sql("CREATE TRIGGER fail_native_intent BEFORE INSERT ON hub_workspace_card_file_writes BEGIN SELECT RAISE(ABORT,'fixture'); END");
    await assert.rejects(port.write(id, {mode: 'move', notebookResource: nativeNotebook, input}));
    f.sql('DROP TRIGGER fail_native_intent');
    assert.deepEqual(await f.command({...f.scope, action: 'write-read', bindingId: id, mutationId: input.requestId}), {error: 404});
    assert.equal(f.calls.write, 0);
    assert.equal((await port.write(id, {mode: 'move', notebookResource: nativeNotebook, input})).state, 'saved');
    assert.equal((await port.finishMove(id, nativeNotebook, input.requestId)).moveState, 'saved');
  });
}

test('native file DTO rejects cross-action executable fields, target changes and nonnumeric errors', async t => {
  const f = await asyncNativeFileFixture(t, 'worker'), result = await f.ok({...f.scope, action: 'current'});
  assert.equal(validHubNativeFileResult({...result, error: '403'}), false);
  assert.equal(validHubNativeFileResult({...result, document: {title: 'Injected', tasks: [], revision: 0, mutationId: randomUUID()}}), false);
  assert.equal(validHubNativeFileCommand({...f.scope, action: 'current', userId: 'default'}), false);
  const command = {...f.scope, action: 'bind-plan' as const, bindingId: randomUUID(), sessionId: f.sessionId, revision: f.revision};
  const plan = await f.ok(command);
  assert.equal(validHubNativeFileReply(nativeFileExpectation(command), {...plan, bindingId: randomUUID()}), false);
  assert.equal(validHubNativeFileReply(nativeFileExpectation({...f.scope, action: 'bind-admit', bindingId: command.bindingId, revision: f.revision, target: plan.target!}), {...plan, action: 'bind-admit', target: {...plan.target, nodeId: 'different'}}), false);
});
