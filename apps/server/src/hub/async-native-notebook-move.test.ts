import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {Hono} from 'hono';
import {asyncNativeFileFixture, nativeNotebook, deferredNative} from './async-native-file-fixture.js';
import {notebookHash, type NotebookMove} from './notebook-operations.js';
import {nativeFileExpectation, validHubNativeFileReply, validHubNativeFileCommand} from './member-native-file-domain.js';
import {createHubAdministrativeServices} from './administrative-route-services.js';
import {HubStore} from './hub-store.js';
import {registerHubRoutes} from '../routes/hub.js';
import {loadConfig} from '../config.js';

type Fixture = Awaited<ReturnType<typeof asyncNativeFileFixture>>;
const status = (code: number) => (e: unknown) => !!e && typeof e === 'object' && 'status' in e && e.status === code;
const move = (f: Fixture): NotebookMove => ({requestId: randomUUID(), direction: 'archive', ...f.notebookRevisions(),
  ranges: [{start: 4, end: 7, sha256: notebookHash('old')}]});
async function bind(f: Fixture) {
  const port = await f.begin(), id = randomUUID();
  await port.bind({requestId: id, sessionId: f.sessionId, revision: f.revision});
  return {port, id};
}

for (const mode of ['original', 'worker'] as const) {
  test(`${mode}: selected native move returns original receipt before later binding/CAS selection`, async t => {
    const f = await asyncNativeFileFixture(t, mode, 'card'), {port, id} = await bind(f), input = move(f);
    assert.equal(await port.moveNotebook(nativeNotebook, randomUUID()), undefined);
    const saved = await port.moveNotebook(nativeNotebook, input.requestId, input);
    assert.equal(saved?.moved, 3);
    await port.revoke(id);
    assert.deepEqual(await port.moveNotebook(nativeNotebook, input.requestId), saved);
    assert.deepEqual(await port.moveNotebook(nativeNotebook, input.requestId, input, false), saved);
    await assert.rejects(port.moveNotebook(nativeNotebook, input.requestId, {...input, direction: 'restore'}), status(409));
    await f.reopen();
    assert.deepEqual(await (await f.begin()).moveNotebook(nativeNotebook, input.requestId), saved);
    assert.equal(f.calls.write, 1);
  });

  test(`${mode}: move selector owns body and rejects resource/UUID/reply substitution`, async t => {
    const f = await asyncNativeFileFixture(t, mode, 'card'), {port} = await bind(f), input = move(f), requestId = input.requestId;
    const entered = deferredNative(), release = deferredNative();
    f.hooks.ack = async command => {if (command.action === 'move-select') {f.hooks.ack = undefined; entered.resolve(); await release.promise;}};
    const flight = port.moveNotebook(nativeNotebook, requestId, input); await entered.promise;
    input.ranges[0]!.sha256 = notebookHash('different'); release.resolve();
    assert.equal((await flight)?.moved, 3);
    const command = {...f.scope, action: 'move-select' as const, notebookResource: nativeNotebook, requestId, input: null};
    assert.equal(validHubNativeFileCommand({...command, input: {...input, requestId: randomUUID()}}), false);
    assert.deepEqual(await f.command({...command, notebookResource: JSON.stringify(['hub-notebook', 1, randomUUID()])}), {error: 409});
    const result = await f.ok(command);
    assert.equal(validHubNativeFileReply(nativeFileExpectation(command), {...result, mutationId: randomUUID()}), false);
    assert.equal(validHubNativeFileReply(nativeFileExpectation(command), {...result, move: null}), false);
    assert.equal(f.calls.write, 1);
  });

  test(`${mode}: lost move admission ACK is GET-only after owner reopen and never private fallback`, async t => {
    const f = await asyncNativeFileFixture(t, mode, 'card'), {port} = await bind(f), input = move(f);
    f.hooks.ack = command => {if (command.action === 'write-admit') throw Error('lost_move_ack');};
    await assert.rejects(port.moveNotebook(nativeNotebook, input.requestId, input));
    f.hooks.ack = undefined; assert.equal(f.calls.write, 0); await f.reopen();
    const reopened = await f.begin();
    await assert.rejects(reopened.moveNotebook(nativeNotebook, input.requestId), status(503));
    await assert.rejects(reopened.moveNotebook(nativeNotebook, input.requestId, input), status(503));
    assert.equal(f.calls.write, 0); assert.equal(f.calls.receipt, 2);
    assert.deepEqual(f.notebookRevisions(), {hotRevision: input.hotRevision, coldRevision: input.coldRevision});
  });

  test(`${mode}: lost move response recovers original receipt without overwriting later Agent projection`, async t => {
    const f = await asyncNativeFileFixture(t, mode, 'card'), {port, id} = await bind(f), input = move(f);
    f.hooks.after = async (request, response) => {if (request.method === 'POST') {await response.text(); throw Error('lost_response');} return response;};
    await assert.rejects(port.moveNotebook(nativeNotebook, input.requestId, input), status(503));
    const remote = JSON.parse(await readFile(f.remotePath(id), 'utf8')); remote.content.text = 'Later Agent';
    await writeFile(f.remotePath(id), JSON.stringify(remote));
    f.hooks.after = undefined; await f.reopen();
    assert.equal((await (await f.begin()).moveNotebook(nativeNotebook, input.requestId))?.moved, 3);
    assert.equal((await f.document(id) as {content: {text: string}}).content.text, 'Later Agent');
    assert.equal(f.calls.write, 1); assert.equal(f.calls.receipt, 1);
  });

  test(`${mode}: disabled destination and revoked original authority cannot admit a fresh move`, async t => {
    const f = await asyncNativeFileFixture(t, mode, 'card'), {port} = await bind(f), input = move(f);
    await assert.rejects(port.moveNotebook(nativeNotebook, input.requestId, input, false), status(503));
    f.hooks.ack = async command => {if (command.action === 'move-select') {f.hooks.ack = undefined; await f.revokeKey();}};
    await assert.rejects(port.moveNotebook(nativeNotebook, input.requestId, input), status(403));
    assert.equal(f.calls.write, 0);
  });

  test(`${mode}: production private/native move POST and GET never touch synchronous dependencies`, {timeout: 30_000}, async t => {
    const f = await asyncNativeFileFixture(t, mode, 'card'), administration = createHubAdministrativeServices(f.current().owner);
    const metadata = f.current().metadata ?? new HubStore(':memory:', 'fixture');
    let guarded = false, synchronous = 0;
    const forbidden = () => {synchronous++; return assert.fail('Notebook move touched synchronous dependency');};
    const store = new Proxy(metadata, {get(target, property, receiver) {return guarded ? forbidden() : Reflect.get(target, property, receiver);}});
    const app = new Hono(), routes = registerHubRoutes(app, {config: {...loadConfig({HOME: f.root, AOD_SERVER_ROLE: 'hub'}), boardFilesEnabled: true},
      hubStore: store, administrative: administration, asyncConnectorClient: f.current().resolver,
      principal: forbidden, connectorClient: forbidden, fileCardClient: forbidden, normalizeError: () => 'safe'});
    assert.ok(routes); guarded = true;
    const request = (path: string, input?: NotebookMove) => app.request('/api/hub/v1/notebooks/' + path, {
      method: input ? 'POST' : 'GET', headers: f.request().headers, ...(input ? {body: JSON.stringify(input)} : {})});
    try {
      const notebookId = randomUUID(), resourceId = JSON.stringify(['hub-notebook', 1, notebookId]);
      await administration.privateNotebooks.savePrivate(f.request(), 'default', {resourceId, revision: 0, text: 'new old'}, 'hot', true);
      const local = {...move(f), hotRevision: 1, coldRevision: 0};
      const localResponse = await request(`${notebookId}/moves`, local);
      assert.equal(localResponse.status, 200, await localResponse.clone().text());
      assert.deepEqual(await (await request(`${notebookId}/moves/${local.requestId}`)).json(), await localResponse.json());
      assert.equal(f.calls.write, 0);
      await bind(f); const input = move(f);
      assert.equal((await request('default/moves/' + randomUUID())).status, 404);
      assert.equal((await request('default/moves/invalid')).status, 404);
      const saved = await request('default/moves', input);
      assert.equal(saved.status, 200, await saved.clone().text());
      assert.equal(saved.headers.get('cache-control'), 'no-store');
      const expected = await saved.json();
      assert.deepEqual(await (await request('default/moves/' + input.requestId)).json(), expected);
      assert.deepEqual(await (await request('default/moves', input)).json(), expected);
      assert.equal((await request('default/moves', {...input, direction: 'restore'})).status, 409);
      await f.revokeKey(); assert.equal((await request('default/moves/' + input.requestId)).status, 401);
      assert.equal(f.calls.write, 1); assert.equal(synchronous, 0);
    } finally {guarded = false; await routes.close(); await administration.close(); if (!f.current().metadata) await metadata.close();}
  });
}
