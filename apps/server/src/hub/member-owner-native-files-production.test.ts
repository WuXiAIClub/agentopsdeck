import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {Hono} from 'hono';
import {workspaceFileCardResource, type BoardWrite, type WorkspaceFileCardWrite} from '@agentopsdeck/shared';
import {asyncNativeFileFixture, deferredNative} from './async-native-file-fixture.js';
import {createHubAdministrativeServices} from './administrative-route-services.js';
import {AsyncNativeFileBackground} from './async-native-file-background.js';
import {HubFileBoardService} from './workspace-board-file-service.js';
import {HubFileCardService} from './workspace-card-file-service.js';
import {HubStore} from './hub-store.js';
import {registerHubRoutes} from '../routes/hub.js';
import {loadConfig} from '../config.js';
import {registerHubBoardFiles} from '../routes/hub-workspace-board-files.js';
import {registerHubCardFiles} from '../routes/hub-workspace-card-files.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
for (const mode of ['original', 'worker'] as const) {
  for (const domain of ['board', 'card'] as const)
    test(`${mode}/${domain}: binding registration needs no legacy dependencies, including disabled reads and close ACK`, {timeout: 30_000}, async t => {
      const f = await asyncNativeFileFixture(t, mode, domain);
      const administrative = createHubAdministrativeServices(f.current().owner);
      const nativeFiles = f.current().service;
      const mount = (enabled: boolean) => {
        const app = new Hono();
        if (domain === 'board') registerHubBoardFiles(app, {mode: 'async', nativeFiles, enabled});
        else registerHubCardFiles(app, {mode: 'async', nativeFiles, editorAccess: administrative.members,
          projections: administrative.projections, configurations: administrative.configurations, reports: administrative.reports, enabled});
        return app;
      };
      const app = mount(true), disabled = mount(false);
      const path = '/api/hub/v1/workspace/' + (domain === 'board' ? 'boards/default'
        : 'file-cards/' + encodeURIComponent(f.scope.resourceId)) + '/file-binding';
      const call = (target: Hono, suffix = '', method = 'GET', body?: unknown) => target.request(path + suffix, {
        method, headers: f.request().headers, ...(body === undefined ? {} : {body: JSON.stringify(body)}),
      });
      const release = deferredNative();
      try {
        const id = randomUUID();
        const installed = await call(app, '', 'POST', {requestId: id, sessionId: f.sessionId, revision: f.revision});
        assert.equal(installed.status, 200, await installed.clone().text());
        const read = await call(disabled); assert.equal(read.status, 200);
        const current = await read.json(); assert.equal(current.enabled, false); assert.equal(current.binding.bindingId, id);
        assert.deepEqual(await (await call(disabled, '/capabilities')).json(), {writable: false});
        assert.equal((await call(disabled, '', 'POST', {requestId: randomUUID(), sessionId: f.sessionId, revision: f.revision})).status, 503);
        await call(app, '/capabilities');
        const document = await f.document(id), mutationId = randomUUID();
        const input = domain === 'board' ? {...document as BoardWrite, title: 'No-store original write', mutationId}
          : {...document as WorkspaceFileCardWrite, content: {...(document as WorkspaceFileCardWrite).content, title: 'No-store original write'}, mutationId};
        const admitted = deferredNative();
        f.hooks.ack = async command => {if (command.action === 'write-admit') {admitted.resolve(); await release.promise;}};
        const saving = call(app, '/' + id + '/writes', 'POST', input); await admitted.promise;
        let drained = false; const closing = nativeFiles.close().then(() => {drained = true;});
        await tick(); assert.equal(drained, false);
        release.resolve(); assert.equal((await saving).status, 503); await closing;
        const receipt = await f.ok({...f.scope, action: 'write-read', bindingId: id, mutationId});
        assert.equal(receipt.receipt?.state, 'uncertain'); assert.equal(f.calls.write, 0); assert.equal(f.calls.install, 1);
        assert.equal((await call(app)).status, 503);
      } finally {release.resolve(); f.hooks.ack = undefined; await nativeFiles.close(); await administrative.close();}
    });

  test(`${mode}: card projections, configuration and report CAS register with only async ports`, async t => {
    const f = await asyncNativeFileFixture(t, mode, 'card'), administrative = createHubAdministrativeServices(f.current().owner);
    const app = new Hono();
    registerHubCardFiles(app, {mode: 'async', nativeFiles: f.current().service, editorAccess: administrative.members,
      projections: administrative.projections, configurations: administrative.configurations, reports: administrative.reports, enabled: false});
    const call = (resource: string, suffix = '', input?: WorkspaceFileCardWrite, binding?: string) => app.request(
      '/api/hub/v1/workspace/file-cards/' + encodeURIComponent(resource) + suffix, {
        method: input ? 'PUT' : 'GET', headers: {...Object.fromEntries(f.request().headers), ...(binding ? {'X-AgentOpsDeck-File-Binding': binding} : {})},
        ...(input ? {body: JSON.stringify(input)} : {}),
      });
    try {
      const browser = workspaceFileCardResource('browser', randomUUID());
      assert.deepEqual(await (await call(browser, '/configuration')).json(), {document: null});
      const configuration: WorkspaceFileCardWrite = {kind: 'browser', content: {title: 'Browser', url: 'https://example.org/'}, revision: 0, mutationId: randomUUID()};
      const saved = await call(browser, '/configuration', configuration); assert.equal(saved.status, 200, await saved.clone().text());
      assert.equal((await call(browser, '/configuration', configuration)).status, 200);
      const loaded = await call(browser, '/configuration'); assert.equal(loaded.status, 200);
      const loadedBody = await loaded.json(); assert.equal(loadedBody.document.revision, 1); assert.equal('updatedAt' in loadedBody.document, false);
      assert.equal((await call(browser)).status, 200, 'declarative projection remains readable with file execution disabled');
      const report = workspaceFileCardResource('report', randomUUID());
      const document: WorkspaceFileCardWrite = {kind: 'report', content: {title: 'Report', text: 'Private report'}, revision: 0, mutationId: randomUUID()};
      assert.equal((await call(report, '/document', document)).status, 409, 'destination is mandatory');
      const response = await call(report, '/document', document, 'none'); assert.equal(response.status, 200, await response.clone().text());
      assert.equal((await call(report, '/document', document, 'none')).status, 200, 'same receipt remains inspect-only');
      assert.equal((await call(report)).status, 200); assert.equal(f.calls.write, 0);
      await f.revokeKey(); assert.equal((await call(browser, '/configuration')).status, 401);
    } finally {await administrative.close();}
  });

  test(`${mode}: no-store card save retains original proof across body wait and rejects revocation before CAS`, async t => {
    const f = await asyncNativeFileFixture(t, mode, 'card'), administrative = createHubAdministrativeServices(f.current().owner);
    const app = new Hono(), begun = deferredNative(), release = deferredNative();
    let saves = 0;
    const owner = f.current().owner, execute = owner.command.bind(owner);
    t.mock.method(owner, 'command', (async (kind, input) => {
      if (kind === 'workspaceConfiguration' && (input as {command: {action: string}}).command.action === 'save') saves++;
      return execute(kind, input);
    }) as typeof owner.command);
    registerHubCardFiles(app, {mode: 'async', nativeFiles: f.current().service,
      editorAccess: {begin: async request => {const proof = await administrative.members.begin(request); begun.resolve(); return proof;}},
      projections: administrative.projections, configurations: administrative.configurations, reports: administrative.reports, enabled: true});
    const resource = workspaceFileCardResource('browser', randomUUID());
    const body = new ReadableStream<Uint8Array>({async start(controller) {await release.promise;
      controller.enqueue(new TextEncoder().encode(JSON.stringify({kind: 'browser', content: {title: 'Original', url: ''}, revision: 0, mutationId: randomUUID()}))); controller.close();}});
    const pending = app.fetch(new Request('http://hub.invalid/api/hub/v1/workspace/file-cards/' + encodeURIComponent(resource) + '/configuration', {
      method: 'PUT', headers: f.request().headers, body, duplex: 'half',
    } as RequestInit));
    try {
      await begun.promise; await f.revokeKey(); release.resolve(); assert.equal((await pending).status, 401);
      assert.equal(saves, 0, 'revoked original proof must be checked before a configuration save command');
    } finally {release.resolve(); await administrative.close();}
  });
}

test('async binding and card registration reject incomplete ports before installing routes', () => {
  const app = new Hono();
  for (const register of [registerHubBoardFiles, registerHubCardFiles]) {
    assert.throws(() => Reflect.apply(register, undefined, [app, {mode: 'async', enabled: true}]), /dependencies unavailable/);
    assert.equal(app.routes.length, 0);
  }
});

for (const mode of ['original', 'worker'] as const) for (const domain of ['board', 'card'] as const)
  test(`${mode}/${domain}: production binding middleware, single background and aggregate drain have no synchronous request bypass`, {timeout: 30_000}, async t => {
    const f = await asyncNativeFileFixture(t, mode, domain), metadata = f.current().metadata ?? new HubStore(':memory:', 'fixture');
    let guarded = false, synchronous = 0, starts = 0, background: AsyncNativeFileBackground | undefined;
    const store = new Proxy(metadata, {get(target, property, receiver) {
      if (guarded) {synchronous++; assert.fail('Native HTTP/background touched main-thread store');}
      return Reflect.get(target, property, receiver);
    }});
    const start = AsyncNativeFileBackground.prototype.start;
    t.mock.method(AsyncNativeFileBackground.prototype, 'start', function(this: AsyncNativeFileBackground) {
      starts++; background = this; return start.call(this);
    });
    t.mock.method(HubFileBoardService.prototype, 'start', () => assert.fail('Legacy board background started alongside async owner'));
    t.mock.method(HubFileCardService.prototype, 'start', () => assert.fail('Legacy card background started alongside async owner'));
    const owner = f.current().owner, execute = owner.command.bind(owner);
    t.mock.method(owner, 'command', (async (kind, input) => {
      const value = await execute(kind, input);
      if (kind === 'nativeFile') await f.hooks.ack?.((input as {command: Parameters<NonNullable<typeof f.hooks.ack>>[0]}).command, value as Parameters<NonNullable<typeof f.hooks.ack>>[1]);
      return value;
    }) as typeof owner.command);
    const administrative = createHubAdministrativeServices(owner), app = new Hono();
    const forbidden = () => {synchronous++; return assert.fail('Native HTTP/background touched synchronous principal/transport');};
    const routes = registerHubRoutes(app, {config: {...loadConfig({HOME: f.root, AOD_SERVER_ROLE: 'hub'}), boardFilesEnabled: true},
      hubStore: store, administrative, asyncConnectorClient: f.current().resolver, principal: forbidden,
      connectorClient: forbidden, ...(domain === 'board' ? {fileBoardClient: forbidden} : {fileCardClient: forbidden}), normalizeError: () => 'safe'});
    assert.ok(routes); guarded = true;
    const path = '/api/hub/v1/workspace/' + (domain === 'board' ? 'boards/default' : 'file-cards/' + encodeURIComponent(f.scope.resourceId)) + '/file-binding';
    const call = (suffix = '', method = 'GET', body?: unknown) => app.request(path + suffix, {
      method, headers: f.request().headers, ...(body === undefined ? {} : {body: JSON.stringify(body)}),
    });
    const release = deferredNative();
    try {
      assert.equal((await call()).status, 200);
      const id = randomUUID(), installed = await call('', 'POST', {requestId: id, sessionId: f.sessionId, revision: f.revision});
      assert.equal(installed.status, 200, await installed.clone().text());
      assert.equal((await call('/capabilities')).status, 200);
      if (domain === 'card') {
        const rejected = await call('/' + id + '/include-archive', 'POST', {requestId: randomUUID(), revision: f.revision + 20});
        assert.equal(rejected.status, 200, await rejected.clone().text()); assert.deepEqual(await rejected.json(), {notAdmitted: true});
      }
      assert.equal(starts, 1); assert.ok(background);
      const subscribed = deferredNative();
      f.hooks.before = request => {if (new URL(request.url).pathname.endsWith('/subscribe')) subscribed.resolve();};
      await background.syncTick(); await background.syncTick(); await subscribed.promise;
      assert.equal(f.calls.subscribe, 1, 'only async background owns the original SSE group');
      const document = await f.document(id), mutationId = randomUUID();
      const input = domain === 'board' ? {...document as BoardWrite, title: 'Original write', mutationId}
        : {...document as WorkspaceFileCardWrite, content: {...(document as Extract<WorkspaceFileCardWrite, {kind: 'notebook'}>).content, title: 'Original write'}, mutationId};
      const admitted = deferredNative();
      f.hooks.ack = async command => {if (command.action === 'write-admit') {admitted.resolve(); await release.promise;}};
      const saving = call('/' + id + '/writes', 'POST', input); await admitted.promise;
      let closed = false; const closing = routes.close().then(() => {closed = true;});
      await tick(); assert.equal(closed, false, 'aggregate close retains the original SQL ACK lane');
      release.resolve(); const response = await saving; await closing;
      assert.ok([200, 503].includes(response.status), await response.clone().text());
      const receipt = await f.ok({...f.scope, action: 'write-read', bindingId: id, mutationId});
      assert.equal(receipt.receipt?.state, 'uncertain');
      assert.equal(f.calls.write, 0, 'close never sends an admitted-but-undispatched original write');
      assert.equal(f.calls.install, 1); assert.equal(synchronous, 0);
    } finally {
      release.resolve(); f.hooks.ack = undefined; guarded = false;
      await routes.close(); await administrative.close(); if (!f.current().metadata) await metadata.close();
    }
  });
