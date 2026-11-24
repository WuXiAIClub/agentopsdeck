import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {workspaceFileCardResource, type WorkspaceFileCardWrite} from '@agentopsdeck/shared';
import {asyncNativeFileFixture, deferredNative} from './async-native-file-fixture.js';
import {nativeFileExpectation, validHubNativeFileReply, type NativeFileScope} from './member-native-file-domain.js';
import {writeBoundNativeCard} from '../routes/hub-native-file-write.js';

const status = (code: number) => (e: unknown) => !!e && typeof e === 'object' && 'status' in e && e.status === code;

for (const mode of ['original', 'worker'] as const) {
  test(`${mode}: editor save keeps original receipt, copies input and never calls legacy store`, async t => {
    const f = await asyncNativeFileFixture(t, mode, 'card'), port = await f.begin(), id = randomUUID();
    await port.bind({requestId: id, sessionId: f.sessionId, revision: f.revision}); await port.writable();
    const doc = await f.document(id) as Extract<WorkspaceFileCardWrite, {kind: 'notebook'}>;
    const input = {...doc, content: {...doc.content, title: 'Editor original'}, mutationId: randomUUID()};
    const savedInput = structuredClone(input), selected = deferredNative(), release = deferredNative();
    t.after(() => release.resolve());
    f.hooks.ack = async command => {if (command.action === 'editor-select') {selected.resolve(); await release.promise;}};
    const saving = writeBoundNativeCard({nativeFiles: f.current().service}, 'not-an-identity', 'hub:default', input, f.request());
    await selected.promise; input.content.title = 'MUTATED_AFTER_CALL'; release.resolve();
    assert.equal(await saving, true); f.hooks.ack = undefined;
    assert.equal(await port.saveEditor(savedInput), true);
    await assert.rejects(port.saveEditor({...savedInput, content: {...savedInput.content, title: 'Different same UUID'}}), status(409));
    assert.equal((await f.document(id) as typeof doc).content.title, 'Editor original');
    assert.equal(f.calls.write, 1);
  });

  for (const fault of ['admission-ack', 'connector-ack'] as const) {
    test(`${mode}: editor ${fault} loss and reopen inspect only original mutation`, async t => {
      const f = await asyncNativeFileFixture(t, mode, 'card'), port = await f.begin(), id = randomUUID();
      await port.bind({requestId: id, sessionId: f.sessionId, revision: f.revision}); await port.writable();
      const doc = await f.document(id) as Extract<WorkspaceFileCardWrite, {kind: 'notebook'}>;
      const input = {...doc, content: {...doc.content, title: 'Uncertain editor'}, mutationId: randomUUID()};
      if (fault === 'admission-ack') f.hooks.ack = command => {if (command.action === 'write-admit') throw Error('LOST_EDITOR_ADMISSION_ACK');};
      else f.hooks.after = async (request, response) => {if (request.method === 'POST') {await response.text(); throw Error('LOST_EDITOR_NETWORK_ACK');} return response;};
      await assert.rejects(port.saveEditor(input));
      f.hooks.ack = undefined; f.hooks.after = undefined;
      assert.equal(f.calls.write, fault === 'admission-ack' ? 0 : 1);
      await f.reopen();
      if (fault === 'admission-ack') await assert.rejects((await f.begin()).saveEditor(input), status(503));
      else assert.equal(await (await f.begin()).saveEditor(input), true);
      assert.equal(f.calls.write, fault === 'admission-ack' ? 0 : 1, 'unknown is never a second POST');
      assert.ok(f.calls.receipt > 0);
    });
  }

  test(`${mode}: editor task/status alias is same-ID only and ACK cannot substitute a destination`, async t => {
    const f = await asyncNativeFileFixture(t, mode, 'card'), id = randomUUID();
    const scope: NativeFileScope = {domain: 'card', resourceId: workspaceFileCardResource('statuscard', 'default')};
    const plan = await f.ok({...scope, action: 'bind-plan', bindingId: id, sessionId: f.sessionId, revision: 1});
    const exact = await f.current().service.begin(f.request(), scope);
    await exact.bind({requestId: id, sessionId: f.sessionId, revision: plan.document!.revision}); await exact.writable();
    const doc = (await f.ok({...scope, action: 'bind-plan', bindingId: id, sessionId: f.sessionId, revision: plan.document!.revision})).document! as Extract<WorkspaceFileCardWrite, {kind: 'taskboard' | 'statuscard'}>;
    const input: WorkspaceFileCardWrite = {kind: 'taskboard', content: {...doc.content, title: 'Alias editor'}, revision: doc.revision, mutationId: randomUUID()};
    const original: NativeFileScope = {domain: 'card', resourceId: workspaceFileCardResource('taskboard', 'default')};
    const command = {...original, action: 'editor-select' as const, input};
    const selected = await f.ok(command), expected = nativeFileExpectation(command);
    assert.equal(selected.binding?.resourceId, scope.resourceId);
    assert.equal(validHubNativeFileReply(expected, selected), true);
    assert.equal(validHubNativeFileReply(expected, {...selected, binding: {...selected.binding, resourceId: workspaceFileCardResource('statuscard', 'another')}}), false);
    assert.equal(validHubNativeFileReply(expected, {...selected, document: {...selected.document, content: {...doc.content, title: 'Substituted'}}}), false);
    const port = await f.current().service.begin(f.request(), original);
    assert.equal(await port.saveEditor(input, true, id), true);
    assert.equal(await port.saveEditor(input, true, id), true);
    assert.equal(f.calls.write, 1);
  });

  test(`${mode}: editor destination mismatch, disabled and revoked selection cannot become private saves`, async t => {
    const f = await asyncNativeFileFixture(t, mode, 'card'), port = await f.begin(), id = randomUUID();
    const doc = await f.document(id) as Extract<WorkspaceFileCardWrite, {kind: 'notebook'}>;
    const input = {...doc, mutationId: randomUUID()};
    assert.equal(await port.saveEditor(input, false, 'none'), false);
    await assert.rejects(port.saveEditor(input, true, id), status(409));
    await port.bind({requestId: id, sessionId: f.sessionId, revision: f.revision}); await port.writable();
    const bound = await f.document(id) as typeof doc;
    const write = {...bound, content: {...bound.content, title: 'Bound only'}, mutationId: randomUUID()};
    await assert.rejects(port.saveEditor(write, false, id), status(503));
    await assert.rejects(port.saveEditor(write, true, 'none'), status(409));
    await assert.rejects(port.saveEditor(write, true, randomUUID()), status(409));
    f.hooks.ack = async command => {if (command.action === 'editor-select') {f.hooks.ack = undefined; await port.revoke(id);}};
    await assert.rejects(port.saveEditor(write));
    assert.equal(f.calls.write, 0);
  });
}
