import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {Hono} from 'hono';
import type {BoardWrite, WorkspaceFileCardWrite} from '@agentopsdeck/shared';
import {asyncNativeFileFixture} from '../hub/async-native-file-fixture.js';
import type {NativeFileScope} from '../hub/member-native-file-domain.js';
import {registerHubBoardFiles} from './hub-workspace-board-files.js';
import {registerHubCardFiles} from './hub-workspace-card-files.js';
import type {HubStore} from '../hub/hub-store.js';
import type {HubFileCardService} from '../hub/workspace-card-file-service.js';
import type {HubFileBoardService} from '../hub/workspace-board-file-service.js';
import type {WorkspaceBoardFiles} from '../hub/workspace-board-files.js';

for (const mode of ['original', 'worker'] as const) for (const domain of ['board', 'card'] as const) {
  const mount = (f: Awaited<ReturnType<typeof asyncNativeFileFixture>>, enabled = true) => {
    const app = new Hono(), forbidden = new Proxy({}, {get() {assert.fail('HTTP async chain touched synchronous identity/store/service');}});
    const deps = {principal: () => assert.fail('HTTP async chain touched synchronous principal'), files: forbidden as WorkspaceBoardFiles,
      service: forbidden as HubFileBoardService, enabled,
      nativeFiles: {begin: (request: Request, scope: NativeFileScope) => f.current().service.begin(request, scope)}};
    const path = '/api/hub/v1/workspace/' + (domain === 'board' ? 'boards/default' : 'file-cards/' + encodeURIComponent(f.scope.resourceId)) + '/file-binding';
    if (domain === 'board') registerHubBoardFiles(app, deps as Parameters<typeof registerHubBoardFiles>[1]);
    else registerHubCardFiles(app, {...deps, store: {cardFiles: forbidden} as unknown as HubStore, service: forbidden as HubFileCardService});
    return {app, path};
  };
  test(`${mode}/${domain}: HTTP binding chain preserves public protocol with no synchronous fallback and GET-only recovery`, async t => {
    const f = await asyncNativeFileFixture(t, mode, domain), {app, path} = mount(f), id = randomUUID();
    const call = (suffix = '', method = 'GET', body?: unknown, headers = f.request().headers) => app.request(path + suffix, {
      method, headers, ...(body === undefined ? {} : {body: JSON.stringify(body)}),
    });
    const initial = await call(); assert.equal(initial.status, 200); assert.deepEqual(await initial.json(), {enabled: true, binding: null});
    const install = await call('', 'POST', {requestId: id, sessionId: f.sessionId, revision: f.revision});
    assert.equal(install.status, 200, await install.clone().text());
    const installed = await install.json() as {binding: Record<string, unknown>};
    assert.equal(installed.binding.bindingId, id); assert.equal(installed.binding.state, 'active');
    assert.deepEqual(Object.keys(installed.binding).sort(), ['bindingId', 'problem', 'resourceId', 'sessionId', 'state']);
    assert.equal(install.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await (await call('/capabilities')).json(), {writable: true});
    const document = await f.document(id), mutationId = randomUUID();
    const input: BoardWrite | WorkspaceFileCardWrite = domain === 'board' ? {...document as BoardWrite, title: 'HTTP saved', mutationId}
      : {...document as WorkspaceFileCardWrite, content: {...(document as Extract<WorkspaceFileCardWrite, {kind: 'notebook'}>).content, title: 'HTTP saved'}, mutationId} as WorkspaceFileCardWrite;
    f.hooks.after = async (request, response) => {
      if (request.method === 'POST' && new URL(request.url).pathname.endsWith('/writes')) {await response.text(); throw Error('PRIVATE_HTTP_LOST_ACK');}
      return response;
    };
    const write = await call('/' + id + '/writes', 'POST', input);
    assert.equal(write.status, 200, await write.clone().text());
    assert.deepEqual(await write.json(), {receipt: {mutationId, state: 'uncertain'}});
    f.hooks.after = undefined; await f.reopen();
    const recovered = await call('/' + id + '/writes/' + mutationId);
    assert.equal(recovered.status, 200, await recovered.clone().text());
    assert.deepEqual(await recovered.json(), {receipt: {mutationId, state: 'saved'}});
    assert.equal(f.calls.install, 1); assert.equal(f.calls.write, 1);
    assert.equal((await call('?owner=someone')).status, 400);
    assert.equal((await call('/' + id + '/writes', 'POST', {...input, mutationId: randomUUID(), userId: 'somebody'})).status, 400);
    const disabled = mount(f, false);
    assert.equal((await disabled.app.request(disabled.path + '/' + id, {headers: f.request().headers})).status, 200);
    assert.equal((await disabled.app.request(disabled.path + '/' + id + '/writes', {method: 'POST', headers: f.request().headers, body: JSON.stringify(input)})).status, 503);
    const cancelled = await call('/' + randomUUID() + '/cancel', 'POST'); assert.equal(cancelled.status, 200);
    assert.deepEqual(await cancelled.json(), {cancelled: true, cleanup: 'confirmed'});
    const removed = await call('/' + id, 'DELETE'); assert.equal(removed.status, 200, await removed.clone().text());
    const removedBody = await removed.json() as {binding: {state: string}};
    assert.equal(removedBody.binding.state, 'revoked'); assert.deepEqual(Object.keys(removedBody).sort(), ['binding', 'cleanup']);
    assert.equal(f.calls.install, 1); assert.equal(f.calls.write, 1);
    const bad = await call('', 'GET', undefined, new Headers({'x-agentopsdeck-key': 'invalid'})); assert.equal(bad.status, 401);
    assert.doesNotMatch(await bad.text(), /PRIVATE|sqlite|token/i);
  });
  if (domain === 'card') test(`${mode}: HTTP archive upgrade uses original atomic admission and explicit negative evidence`, async t => {
    const id = randomUUID(), f = await asyncNativeFileFixture(t, mode, domain, id), {app, path} = mount(f);
    const call = (suffix: string, body: unknown) => app.request(path + suffix, {
      method: 'POST', headers: f.request().headers, body: JSON.stringify(body),
    });
    assert.equal((await call('', {requestId: id, sessionId: f.sessionId, revision: f.revision})).status, 200);
    const document = await f.document(id), requestId = randomUUID();
    const rejected = await call('/' + id + '/include-archive', {requestId: randomUUID(), revision: document.revision + 10});
    assert.equal(rejected.status, 200, await rejected.clone().text()); assert.deepEqual(await rejected.json(), {notAdmitted: true});
    assert.equal(f.calls.write, 0);
    f.hooks.after = async (request, response) => {
      if (request.method === 'POST' && new URL(request.url).pathname.endsWith('/writes')) {await response.text(); throw Error('PRIVATE_ARCHIVE_LOST_ACK');}
      return response;
    };
    const input = {requestId, revision: document.revision};
    const unknown = await call('/' + id + '/include-archive', input);
    assert.equal(unknown.status, 200, await unknown.clone().text());
    assert.deepEqual(await unknown.json(), {receipt: {mutationId: requestId, state: 'uncertain'}});
    f.hooks.after = undefined; await f.reopen();
    // An existing original receipt must recover before capability/preflight,
    // even if the original revision is no longer the current projection.
    const recovered = await call('/' + id + '/include-archive', input);
    assert.equal(recovered.status, 200, await recovered.clone().text());
    assert.deepEqual(await recovered.json(), {receipt: {mutationId: requestId, state: 'saved'}});
    assert.equal(f.calls.install, 0, 'historical binding is never reinstalled'); assert.equal(f.calls.write, 1); assert.ok(f.calls.receipt >= 1);
    const saved = await f.document(id); assert.ok('kind' in saved); assert.equal(saved.kind, 'notebook');
    assert.equal((saved as Extract<WorkspaceFileCardWrite, {kind: 'notebook'}>).content.archive, '');
    assert.equal((await call('/' + id + '/include-archive?owner=other', input)).status, 400);
  });
}
