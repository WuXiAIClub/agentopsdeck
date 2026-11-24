import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {Hono} from 'hono';
import {emptyDrawing, emptyNativeDrawio, workspaceFileCardResource, type WorkspaceFileCardWrite} from '@agentopsdeck/shared';
import {asyncNativeFileFixture} from './async-native-file-fixture.js';
import {createHubAdministrativeServices} from './administrative-route-services.js';
import {HubStore} from './hub-store.js';
import {loadConfig} from '../config.js';
import {registerHubRoutes} from '../routes/hub.js';
import {registerHubWorkspaceCards} from '../routes/hub-workspace-cards.js';
import {registerHubWorkspaceDrawingRoutes} from '../routes/hub-workspace-drawings.js';
import {registerHubNativeDrawioRoutes} from '../routes/hub-workspace-native-drawio.js';
import {registerHubWorkspaceBoardRoutes} from '../routes/hub-workspace-boards.js';
import {isAsyncHubWorkspaceVisualReadRequest} from '../routes/hub-native-file-write.js';

test('async visual read dispatch excludes mutation, nested, shared and machine paths', () => {
  for (const kind of ['cards', 'drawings', 'native-drawio']) {
    const base = '/api/hub/v1/workspace/' + kind;
    for (const method of ['GET', 'HEAD']) for (const path of [base, base + '/default'])
      assert.equal(isAsyncHubWorkspaceVisualReadRequest(method, path), true);
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH'])
      assert.equal(isAsyncHubWorkspaceVisualReadRequest(method, base + '/default'), false);
    for (const suffix of ['/default/file-binding', '/default/capabilities', '/default/unknown', '//default'])
      assert.equal(isAsyncHubWorkspaceVisualReadRequest('GET', base + suffix), false);
  }
  for (const path of ['/api/hub/v1/workspace/shared-content/default', '/api/workspace-agent/v1/board',
    '/api/hub/v1/workspace/file-cards/default/document', '/api/hub/v1/notebook'])
    assert.equal(isAsyncHubWorkspaceVisualReadRequest('GET', path), false);
});

for (const mode of ['original', 'worker'] as const) {
  test(`${mode}: editor registration and complete read/write/capability routes need no synchronous store or principal`, {timeout: 30_000}, async t => {
    const f = await asyncNativeFileFixture(t, mode, 'board');
    const administrative = createHubAdministrativeServices(f.current().owner);
    t.after(() => administrative.close());
    const app = new Hono();
    const deps = {mode: 'async' as const, nativeFiles: f.current().service, editorAccess: administrative.members,
      fileCardsEnabled: true, visuals: administrative.visuals};
    registerHubWorkspaceCards(app, deps);
    registerHubWorkspaceDrawingRoutes(app, deps);
    registerHubNativeDrawioRoutes(app, {...deps, editorUrl: 'https://embed.diagrams.net/'});
    registerHubWorkspaceBoardRoutes(app, {...deps, boards: administrative.boards, capabilities: administrative.boardCapabilities});
    const request = (path: string, method = 'GET', body?: unknown) => app.request('/api/hub/v1/workspace/' + path,
      {method, headers: f.request().headers, ...(body ? {body: JSON.stringify(body)} : {})});
    const cardId = randomUUID(), taskId = randomUUID();
    for (const item of [
      {route: 'cards/' + cardId, content: {title: 'Metric', value: '1', detail: '', progress: 1, tone: 'blue'}},
      {route: 'drawings/default', content: emptyDrawing()},
      {route: 'native-drawio/default', content: emptyNativeDrawio()},
      {route: 'boards/default', content: {title: 'Board', tasks: [{id: taskId, title: 'Task', detail: '', status: 'todo'}]}},
    ]) {
      // The board fixture already contains the default board; all other visual
      // resources are unsaved. Read the actual revision, never reset old data.
      const prior = await request(item.route);
      const revision = prior.status === 404 ? 0 : (await prior.json()).revision;
      const body = {...item.content, revision, mutationId: randomUUID()};
      const saved = await request(item.route, 'PUT', body);
      assert.equal(saved.status, 200, item.route + ': ' + await saved.clone().text());
      assert.equal(saved.headers.get('cache-control'), 'no-store');
      const document = await saved.json();
      assert.equal(document.revision, revision + 1);
      assert.deepEqual(await (await request(item.route, 'PUT', body)).json(), document, 'same receipt replay');
      assert.deepEqual(await (await request(item.route)).json(), document, 'original browser document wire');
      assert.equal((await request(item.route, 'PUT', {...body, title: 'UUID reused'})).status, 409);
    }
    for (const path of ['cards', 'drawings', 'native-drawio', 'boards', 'boards/default/summary', 'native-drawio/config']) {
      const response = await request(path); assert.equal(response.status, 200, path);
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    const issued = await request('boards/default/capabilities', 'POST', {taskIds: [taskId], fields: ['status'], expiresAt: Date.now() + 60_000});
    assert.equal(issued.status, 201, await issued.clone().text());
    const capability = await issued.json();
    const list = await request('boards/default/capabilities'); assert.equal(list.status, 200);
    assert.equal((await list.json()).capabilities.length, 1);
    assert.equal((await request('boards/default/capabilities/' + capability.capability.id, 'DELETE')).status, 200);
    assert.equal((await request('boards/default/audit')).status, 200);
    // Mount a real original board binding and require the exact original
    // public DTO, observed in the same worker transaction as its projection.
    const boardScope = {domain: 'board' as const, resourceId: 'default'};
    const port = await f.current().service.begin(f.request(), boardScope);
    const board = await administrative.boards.get(f.request(), 'default', 'default'), bindingId = randomUUID();
    await port.bind({requestId: bindingId, sessionId: f.sessionId, revision: board.revision});
    const bound = await request('boards/default'); assert.equal(bound.status, 200);
    const snapshot = await bound.json();
    assert.equal(snapshot.fileBinding.bindingId, bindingId);
    assert.deepEqual(Object.keys(snapshot.fileBinding).sort(), ['bindingId', 'resourceId', 'sessionId', 'state', 'problem'].sort());
    await f.revokeKey();
    for (const path of ['cards', 'drawings/default', 'native-drawio/config', 'boards/default', 'boards/default/capabilities', 'boards/default/audit']) {
      assert.equal((await request(path)).status, 401, path + ' current authority');
    }
    assert.equal((await request('cards/' + cardId, 'PUT', {})).status, 401);
    assert.equal(f.calls.write, 0, 'unbound local saves and reads never cause native writes');
  });
}

test('async editor routes reject missing business ports before registering endpoints', () => {
  for (const register of [registerHubWorkspaceCards, registerHubWorkspaceDrawingRoutes, registerHubNativeDrawioRoutes, registerHubWorkspaceBoardRoutes]) {
    const app = new Hono();
    assert.throws(() => Reflect.apply(register, undefined, [app, {mode: 'async'}]), /dependencies unavailable/);
    assert.equal(app.routes.length, 0);
  }
});

for (const mode of ['original', 'worker'] as const) {
  test(`${mode}: full Hub editor reads and five PUT chains use original async identity, receipts and projections`, {timeout: 30_000}, async t => {
    const f = await asyncNativeFileFixture(t, mode, 'card');
    const metadata = f.current().metadata ?? new HubStore(':memory:', 'fixture');
    const administrative = createHubAdministrativeServices(f.current().owner);
    const cardId = randomUUID(), reportId = randomUUID();
    await administrative.visuals.saveCard(f.request(), 'default', cardId, {title: 'Metric', value: '1', detail: '', progress: 1, tone: 'blue', revision: 0, mutationId: randomUUID()});
    await administrative.visuals.saveDrawing(f.request(), 'default', 'default', {...emptyDrawing(), revision: 0, mutationId: randomUUID()});
    await administrative.visuals.saveNativeDrawio(f.request(), 'default', 'default', {...emptyNativeDrawio(), revision: 0, mutationId: randomUUID()});
    await administrative.reports.save(f.request(), 'default', workspaceFileCardResource('report', reportId), {
      kind: 'report', content: {title: 'Report', text: 'Report body'}, revision: 0, mutationId: randomUUID(),
    });
    let guarded = false, synchronous = 0;
    const forbidden = () => {synchronous++; return assert.fail('editor request touched synchronous principal/store/transport');};
    const store = new Proxy(metadata, {get(target, property, receiver) {
      if (guarded) return forbidden();
      return Reflect.get(target, property, receiver);
    }});
    const app = new Hono(), routes = registerHubRoutes(app, {
      config: {...loadConfig({HOME: f.root, AOD_SERVER_ROLE: 'hub'}), boardFilesEnabled: true},
      hubStore: store, administrative, asyncConnectorClient: f.current().resolver,
      principal: forbidden, connectorClient: forbidden, fileCardClient: forbidden, normalizeError: () => 'safe',
    });
    assert.ok(routes); guarded = true;
    try {
      const readPaths = ['cards', 'cards/' + cardId, 'drawings', 'drawings/default',
        'native-drawio', 'native-drawio/default', 'native-drawio/config', 'boards', 'boards/default',
        'boards/default/summary', 'boards/default/capabilities', 'boards/default/audit'];
      const headers = Object.fromEntries(f.request().headers);
      const scope = (await administrative.members.begin(f.request())).recoveryScope;
      const credentials = [headers, {authorization: 'Bearer ' + f.key.token}, {cookie: 'agentopsdeck_session=' + f.cookie}];
      for (const path of readPaths) {
        const url = '/api/hub/v1/workspace/' + path;
        for (const auth of credentials) for (const method of ['GET', 'HEAD']) {
          const response = await app.request(url, {method, headers: {...auth, 'x-agentopsdeck-recovery-scope': scope}});
          assert.equal(response.status, 200, method + ' ' + path + ': ' + await response.clone().text());
          assert.equal(response.headers.get('cache-control'), 'no-store');
          if (method === 'HEAD') assert.equal(await response.text(), '');
        }
        const wrongScope = await app.request(url, {headers: {...headers, 'x-agentopsdeck-recovery-scope': 'stale'}});
        assert.equal(wrongScope.status, 409, path + ' stale browser scope');
        for (const token of ['hub_key_invalid', 'aod_board_synthetic', 'aod_note_synthetic']) {
          const denied = await app.request(url, {headers: {...headers, cookie: 'agentopsdeck_session=' + f.cookie, 'x-agentopsdeck-key': token}});
          assert.equal(denied.status, 401, path + ' explicit invalid/machine credential');
        }
      }
      for (const item of [
        {kind: 'taskboard', id: 'default', route: 'boards/default'},
        {kind: 'metric-card', id: cardId, route: 'cards/' + cardId},
        {kind: 'drawing', id: 'default', route: 'drawings/default'},
        {kind: 'native-drawio', id: 'default', route: 'native-drawio/default'},
        {kind: 'report', id: reportId, route: 'file-cards/' + encodeURIComponent(workspaceFileCardResource('report', reportId)) + '/document'},
      ] as const) {
        const scope = {domain: 'card' as const, resourceId: workspaceFileCardResource(item.kind, item.id)}, id = randomUUID();
        const original = await administrative.projections.get(f.request(), 'default', scope.resourceId);
        assert.ok(original);
        const plan = await f.ok({...scope, action: 'bind-plan', bindingId: id, sessionId: f.sessionId, revision: original.revision});
        const port = await f.current().service.begin(f.request(), scope);
        await port.bind({requestId: id, sessionId: f.sessionId, revision: plan.document!.revision}); await port.writable();
        const document = (await f.ok({...scope, action: 'bind-plan', bindingId: id, sessionId: f.sessionId, revision: plan.document!.revision})).document! as WorkspaceFileCardWrite;
        const content = {...document.content, title: 'Saved ' + item.kind}, mutationId = randomUUID();
        const body = item.kind === 'report' ? {...document, content, mutationId} : {...content, revision: document.revision, mutationId};
        const path = '/api/hub/v1/workspace/' + item.route;
        const request = (value: unknown, binding: string = id) => app.request(path, {method: 'PUT',
          headers: {...Object.fromEntries(f.request().headers), 'X-AgentOpsDeck-File-Binding': binding}, body: JSON.stringify(value)});
        const before = f.calls.write;
        const stale = await app.request(path, {method: 'PUT', headers: {...headers,
          'X-AgentOpsDeck-File-Binding': id, 'x-agentopsdeck-recovery-scope': 'stale'}, body: JSON.stringify(body)});
        assert.equal(stale.status, 409, item.kind + ' stale scope cannot write');
        assert.equal(f.calls.write, before);
        const saved = await request(body); assert.equal(saved.status, 200, item.kind + ': ' + await saved.clone().text());
        assert.equal(saved.headers.get('cache-control'), 'no-store');
        assert.equal((await request(body)).status, 200, item.kind + ' receipt retry');
        const altered = item.kind === 'report' ? {...body, content: {...content, title: 'Changed same UUID'}} : {...body, title: 'Changed same UUID'};
        assert.equal((await request(altered)).status, 409, item.kind + ' original fingerprint');
        if (item.kind === 'report') assert.equal((await request(body, 'none')).status, 409, 'report local retry cannot retarget into file');
        assert.equal(f.calls.write, before + 1, item.kind + ' must dispatch exactly once');
      }
      await f.revokeKey();
      for (const path of readPaths)
        assert.equal((await app.request('/api/hub/v1/workspace/' + path, {headers})).status, 401, path + ' revoked identity');
      const denied = await app.request('/api/hub/v1/workspace/boards/default', {method: 'PUT', headers: f.request().headers, body: '{}'});
      assert.equal(denied.status, 401); assert.equal(synchronous, 0);
    } finally {
      guarded = false;
      await routes.close(); await administrative.close(); if (!f.current().metadata) await metadata.close();
    }
  });
}
