import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID, createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {Hono} from 'hono';
import {DEFAULT_HUB_NOTEBOOK_LAYOUT, type SessionNotebookDocument} from '@agentopsdeck/shared';
import {asyncNativeFileFixture, nativeNotebook, deferredNative} from './async-native-file-fixture.js';
import {hubMemberEvidence} from './member-owner-domain.js';
import {nativeNotebookMutation, type NativeNotebookAutosave} from './native-notebook-autosave.js';
import {nativeFileExpectation, validHubNativeFileReply, validHubNativeFileCommand} from './member-native-file-domain.js';
import {createHubAdministrativeServices} from './administrative-route-services.js';
import {HubStore} from './hub-store.js';
import {registerHubRoutes} from '../routes/hub.js';
import {loadConfig} from '../config.js';

const layoutResource = JSON.stringify(['hub-notebook-layout', 1, 'default']);
type Fixture = Awaited<ReturnType<typeof asyncNativeFileFixture>>;
const status = (code: number) => (e: unknown) => !!e && typeof e === 'object' && 'status' in e && e.status === code;
async function read(f: Fixture, area: NativeNotebookAutosave['area'] = 'hot') {
  const {owner, metadata} = f.current();
  const resourceId = area === 'layout' ? layoutResource : nativeNotebook;
  // The original administrative adapter deliberately exposes writes only for
  // this domain. Inspect its existing owner in fixtures; do not open a second DB
  // or broaden the production port merely to read test assertions.
  if (metadata) return area === 'cold' ? metadata.notebooks.getArchive('default', resourceId)
    : metadata.notebooks.get('default', resourceId);
  const evidence = hubMemberEvidence(f.request());
  const snapshot = await owner.command('memberSnapshot', evidence); assert.ok(snapshot);
  const value = await owner.command('personalNotebook', {evidence, expectedScope: snapshot.recoveryScope,
    command: {action: area === 'cold' ? 'archive' : 'get', resourceId}});
  assert.ok(value && 'document' in value && value.document);
  return value.document as SessionNotebookDocument;
}
const input = (d: SessionNotebookDocument, text: string) => ({resourceId: d.resourceId, revision: d.revision, text});
async function bind(f: Fixture) {
  const port = await f.begin(), id = randomUUID();
  await port.bind({requestId: id, sessionId: f.sessionId, revision: f.revision}); await port.writable();
  return {port, id};
}

test('notebook autosave keeps the original legacy byte-order UUID algorithm', () => {
  const d = {text: 'original', revision: 4, resourceId: nativeNotebook};
  for (const area of ['hot', 'cold', 'layout'] as const) {
    const h = createHash('sha256').update(JSON.stringify(area === 'cold' ? ['u', 'b', d, 'archive'] : ['u', 'b', d])).digest('hex');
    assert.equal(nativeNotebookMutation('u', 'b', d, area), `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`);
  }
});

for (const mode of ['original', 'worker'] as const) {
  test(`${mode}: notebook hot/cold/title preserve other areas and retry the original receipt once`, async t => {
    const f = await asyncNativeFileFixture(t, mode, 'card'), {port} = await bind(f);
    const hot = input(await read(f), 'Saved hot');
    const coldBefore = await read(f, 'cold');
    assert.equal((await port.saveNotebook(hot, 'hot', true))?.text, hot.text);
    assert.deepEqual(await read(f, 'cold'), coldBefore);
    assert.equal((await port.saveNotebook(hot, 'hot', true))?.text, hot.text);
    const cold = input(await read(f, 'cold'), 'Saved cold');
    assert.equal((await port.saveNotebook(cold, 'cold', true))?.text, cold.text);
    assert.equal((await read(f)).text, hot.text);
    const geometry = {...DEFAULT_HUB_NOTEBOOK_LAYOUT, title: 'Changed title', x: 311, hidden: false};
    const layout = input(await read(f, 'layout'), JSON.stringify(geometry));
    assert.deepEqual(JSON.parse((await port.saveNotebook(layout, 'layout', true))!.text), geometry);
    assert.deepEqual(JSON.parse((await port.saveNotebook(layout, 'layout', true))!.text), geometry);
    assert.equal((await read(f)).text, hot.text); assert.equal((await read(f, 'cold')).text, cold.text);
    assert.equal(f.calls.write, 3);
    await assert.rejects(port.saveNotebook({...hot, text: 'stale different body'}, 'hot', true), status(409));
  });

  test(`${mode}: geometry-only and legacy unclaimed archive explicitly use private CAS, not a failed-write fallback`, async t => {
    const id = randomUUID(), f = await asyncNativeFileFixture(t, mode, 'card', id), port = await f.begin();
    await port.inspect(id); await port.writable();
    const note = await read(f, 'layout'), next = {...DEFAULT_HUB_NOTEBOOK_LAYOUT, x: 555};
    assert.equal(await port.saveNotebook(input(note, JSON.stringify(next)), 'layout', true, false), undefined);
    assert.equal(await port.saveNotebook(input(await read(f, 'cold'), 'Private archive'), 'cold', true, false), undefined);
    const administration = createHubAdministrativeServices(f.current().owner);
    try {
      assert.equal((await administration.privateNotebooks.savePrivate(f.request(), 'default', input(note, JSON.stringify(next)), 'layout', true)).status, 'saved');
      assert.equal((await administration.privateNotebooks.savePrivate(f.request(), 'default', input(await read(f, 'cold'), 'Private archive'), 'cold', true)).status, 'saved');
    } finally {await administration.close();}
    assert.equal(f.calls.write, 0);
    await assert.rejects(port.saveNotebook(input(await read(f), 'Bound'), 'hot', true, false), status(503));
  });

  test(`${mode}: notebook owns the request before awaits and rejects cross-resource/mutation/DTO substitution`, async t => {
    const f = await asyncNativeFileFixture(t, mode, 'card'), {port, id} = await bind(f);
    const document = input(await read(f), 'Original owned bytes'), entered = deferredNative(), release = deferredNative();
    f.hooks.ack = async command => {if (command.action === 'current') {f.hooks.ack = undefined; entered.resolve(); await release.promise;}};
    const flight = port.saveNotebook(document, 'hot', true); await entered.promise;
    document.text = 'Mutated later'; release.resolve();
    assert.equal((await flight)?.text, 'Original owned bytes');
    const original = input(await read(f), 'Next'), request: NativeNotebookAutosave = {mode: 'autosave', document: original, area: 'hot', styled: true,
      mutationId: nativeNotebookMutation('default', id, original, 'hot')};
    const command = {...f.scope, action: 'notebook-plan' as const, bindingId: id, request};
    assert.equal(validHubNativeFileCommand({...command, request: {...request, mutationId: 'not-a-uuid'}}), false);
    assert.deepEqual(await f.command({...command, request: {...request, mutationId: randomUUID()}}), {error: 409});
    const other = {...original, resourceId: JSON.stringify(['hub-notebook', 1, randomUUID()])};
    assert.deepEqual(await f.command({...command, request: {...request, document: other,
      mutationId: nativeNotebookMutation('default', id, other, 'hot')}}), {error: 409});
    const plan = await f.ok(command);
    assert.equal(validHubNativeFileReply(nativeFileExpectation(command), {...plan, note: await read(f)}), false);
    const finishedCommand = {...command, action: 'notebook-finish' as const};
    assert.equal(validHubNativeFileReply(nativeFileExpectation(finishedCommand), {...plan, action: 'notebook-finish', document: null,
      note: {...await read(f), resourceId: 'other'}}), false);
    assert.equal(f.calls.write, 1);
  });

  test(`${mode}: lost notebook admission ACK remains GET-only after owner reopen`, async t => {
    const f = await asyncNativeFileFixture(t, mode, 'card'), {port} = await bind(f);
    const document = input(await read(f), 'Unknown admitted');
    f.hooks.ack = command => {if (command.action === 'write-admit') throw Error('lost_autosave_ack');};
    await assert.rejects(port.saveNotebook(document, 'hot', true));
    f.hooks.ack = undefined; assert.equal(f.calls.write, 0); await f.reopen();
    await assert.rejects((await f.begin()).saveNotebook(document, 'hot', true), status(503));
    assert.equal(f.calls.write, 0); assert.equal(f.calls.receipt, 1); assert.equal((await read(f)).text, 'new old');
  });

  test(`${mode}: lost notebook network response recovers receipt and current Agent projection without rewriting`, async t => {
    const f = await asyncNativeFileFixture(t, mode, 'card'), {port, id} = await bind(f);
    const document = input(await read(f), 'Original saved');
    f.hooks.after = async (request, response) => {if (request.method === 'POST') {await response.text(); throw Error('lost_response');} return response;};
    await assert.rejects(port.saveNotebook(document, 'hot', true), status(503));
    const remote = JSON.parse(await readFile(f.remotePath(id), 'utf8')); remote.content.text = 'Later Agent';
    await writeFile(f.remotePath(id), JSON.stringify(remote));
    f.hooks.after = undefined; await f.reopen();
    assert.equal((await (await f.begin()).saveNotebook(document, 'hot', true))?.text, 'Later Agent');
    assert.equal(f.calls.write, 1); assert.equal(f.calls.receipt, 1);
  });

  test(`${mode}: original layout receipt cannot overwrite a later device geometry`, async t => {
    const f = await asyncNativeFileFixture(t, mode, 'card'), {port} = await bind(f);
    const first = {...DEFAULT_HUB_NOTEBOOK_LAYOUT, title: 'A title', x: 123};
    const document = input(await read(f, 'layout'), JSON.stringify(first));
    await port.saveNotebook(document, 'layout', true);
    const administration = createHubAdministrativeServices(f.current().owner);
    try {
      const moved = input(await read(f, 'layout'), JSON.stringify({...first, x: 888}));
      assert.equal((await administration.privateNotebooks.savePrivate(f.request(), 'default', moved, 'layout', true)).status, 'saved');
      await assert.rejects(port.saveNotebook(document, 'layout', true), status(409));
      assert.equal(JSON.parse((await read(f, 'layout')).text).x, 888); assert.equal(f.calls.write, 1);
    } finally {await administration.close();}
  });

  test(`${mode}: style downgrade and revoked binding/identity cannot admit notebook writes`, async t => {
    const f = await asyncNativeFileFixture(t, mode, 'card'), {port} = await bind(f);
    await assert.rejects(port.saveNotebook(input(await read(f), '<span data-agentopsdeck-note="v1">Styled</span>'), 'hot', false), status(409));
    const document = input(await read(f), 'Do not send');
    f.hooks.ack = async command => {if (command.action === 'notebook-plan') {f.hooks.ack = undefined; await f.revokeKey();}};
    await assert.rejects(port.saveNotebook(document, 'hot', true), status(403));
    assert.equal(f.calls.write, 0);
  });

  test(`${mode}: production Notebook PUT hot/cold/layout/private paths never touch synchronous principal/store/transport`, {timeout: 30_000}, async t => {
    const f = await asyncNativeFileFixture(t, mode, 'card'), administration = createHubAdministrativeServices(f.current().owner);
    const metadata = f.current().metadata ?? new HubStore(':memory:', 'fixture');
    let guarded = false, synchronous = 0;
    const forbidden = () => {synchronous++; return assert.fail('Notebook PUT touched synchronous dependency');};
    const store = new Proxy(metadata, {get(target, property, receiver) {return guarded ? forbidden() : Reflect.get(target, property, receiver);}});
    const app = new Hono(), routes = registerHubRoutes(app, {config: {...loadConfig({HOME: f.root, AOD_SERVER_ROLE: 'hub'}), boardFilesEnabled: true},
      hubStore: store, administrative: administration, asyncConnectorClient: f.current().resolver,
      principal: forbidden, connectorClient: forbidden, fileCardClient: forbidden, normalizeError: () => 'safe'});
    assert.ok(routes); guarded = true;
    const put = (path: string, body: unknown, styled = true) => app.request('/api/hub/v1/' + path, {method: 'PUT',
      headers: {...Object.fromEntries(f.request().headers), ...(styled ? {'x-agentopsdeck-notebook-format': 'styled-markdown-v1'} : {})}, body: JSON.stringify(body)});
    try {
      const privateBody = {resourceId: JSON.stringify(['hub-notebook', 1, randomUUID()]), revision: 0, text: 'Private save'};
      assert.equal((await put('notebooks/' + JSON.parse(privateBody.resourceId)[2], privateBody)).status, 200);
      await bind(f);
      for (const [path, area, text] of [['notebook', 'hot', 'Legacy saved'], ['notebooks/default', 'hot', 'Hot saved'],
        ['notebooks/default/archive', 'cold', 'Cold saved'], ['notebooks/default/layout', 'layout', JSON.stringify({...DEFAULT_HUB_NOTEBOOK_LAYOUT, title: 'Native title', x: 234})]] as const) {
        const body = input(await read(f, area), text), before = f.calls.write;
        const result = await put(path, body); assert.equal(result.status, 200, path + ': ' + await result.clone().text());
        assert.equal(result.headers.get('cache-control'), 'no-store');
        assert.equal((await result.json() as SessionNotebookDocument).resourceId, body.resourceId);
        assert.equal((await put(path, body)).status, 200, path + ': receipt retry');
        assert.equal(f.calls.write, before + 1);
      }
      const layout = JSON.parse((await read(f, 'layout')).text), before = f.calls.write;
      assert.equal((await put('notebooks/default/layout', input(await read(f, 'layout'), JSON.stringify({...layout, x: 777})))).status, 200);
      assert.equal(f.calls.write, before);
      assert.equal((await put('notebook', input(await read(f), '<span data-agentopsdeck-note="v1">styled</span>'), false)).status, 409);
      await f.revokeKey(); assert.equal((await put('notebook', {})).status, 401); assert.equal(synchronous, 0);
    } finally {guarded = false; await routes.close(); await administration.close(); if (!f.current().metadata) await metadata.close();}
  });
}
