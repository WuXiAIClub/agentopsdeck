import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { loadConfig } from '../config.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { HubStore } from '../hub/hub-store.js';
import { AsyncHubMemberOwner } from '../hub/async-member-owner.js';
import { OriginalHubAdministrativeCommands } from '../hub/original-administrative-commands.js';
import { createHubAdministrativeServices } from '../hub/administrative-route-services.js';
import { createHubConnectorReadServices } from '../hub/connector-read-services.js';
import { encodeHubSessionId } from '../hub/session-id.js';
import { WeixinService } from '../hub/weixin-service.js';
import { AsyncNativeFileBackground } from '../hub/async-native-file-background.js';
import { AsyncContentBackground } from '../hub/async-content-background.js';
import { registerHubRoutes } from './hub.js';
import { registerAsyncHubRoutes, type AsyncHubRouteDeps } from './hub-async.js';

const base = '/api/hub/v1';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }

async function fixture(t: TestContext, mode: 'original' | 'worker') {
  const root = mkdtempSync(join(tmpdir(), 'hub-async-composition-')), file = join(root, 'hub.sqlite');
  const store = new HubStore(file, 'composition-fixture');
  (store as unknown as { db: DatabaseSync }).db.prepare("INSERT INTO hub_roles VALUES ('default','admin',1)").run();
  const key = store.identities.issueKey('default'), hubId = store.identities.hubId;
  const diagnostics = new PerformanceDiagnostics(() => {});
  if (mode === 'worker') await store.close();
  const owner = mode === 'original' ? new OriginalHubAdministrativeCommands(store, diagnostics)
    : new AsyncHubMemberOwner({ file, encryptionSecret: 'composition-fixture' }, diagnostics);
  const administrative = createHubAdministrativeServices(owner, diagnostics);
  const reads = createHubConnectorReadServices(owner, undefined, diagnostics);
  let starts = 0;
  t.mock.method(WeixinService.prototype, 'startWorker', () => { starts++; });
  // No real network/native effects are permitted by this composition fixture.
  t.mock.method(globalThis, 'fetch', async () => { throw Error('UNEXPECTED_EXTERNAL_EFFECT'); });
  const deps: AsyncHubRouteDeps = {
    config: loadConfig({ HOME: root, AOD_SERVER_ROLE: 'hub' }), hubId, administrative, reads,
    eventFeed: () => { throw Error('UNEXPECTED_EVENT_SUBSCRIPTION'); }, normalizeError: () => 'unavailable',
  };
  const closes: (() => void | Promise<void>)[] = [];
  t.after(async () => {
    for (const close of closes) await close();
    await administrative.close(); await reads.close(); await owner.close();
    if (mode === 'original') await store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const app = new Hono();
  const mount = async (input = deps) => {
    const routes = await registerAsyncHubRoutes(app, input); closes.push(() => routes.close()); return routes;
  };
  const request = (path: string, init?: RequestInit) => app.request(path, { ...init,
    headers: { 'x-agentopsdeck-key': key.token, ...init?.headers } });
  return { root, store, owner, app, deps, mount, closes, request, key, get starts() { return starts; } };
}

for (const mode of ['original', 'worker'] as const) {
  test(`async Hub ${mode}: prepared/active/closed fencing leaves native and Connector routes untouched`, async t => {
    const f = await fixture(t, mode), routes = await f.mount();
    f.app.get('/api/connector/v1/health', c => c.json({ connector: true }));
    f.app.get('/api/sessions/:id/state', c => c.json({ native: c.req.param('id') }));
    assert.equal((await f.request(base + '/me')).status, 503);
    assert.equal(f.starts, 0);
    for (const path of ['/api/connector/v1/health', '/api/sessions/codex%3Anative/state']) {
      assert.equal((await f.request(path)).status, 200, path);
    }
    const hubAlias = '/api/sessions/' + encodeURIComponent(encodeHubSessionId('dev', 'codex:native')) + '/state';
    assert.equal((await f.request(hubAlias)).status, 503);
    const activation = routes.activate(); assert.equal(routes.activate(), activation); await activation;
    assert.equal(f.starts, 1);
    assert.equal((await f.request(base + '/me')).status, 200);
    const one = routes.close(), two = routes.close(); assert.equal(one, two); await one;
    assert.equal((await f.request(base + '/me')).status, 503);
    await assert.rejects(routes.activate(), /composition_closed/);
    assert.equal((await f.request('/api/sessions/codex%3Anative/state')).status, 200);
    assert.ok(await f.owner.command('memberSnapshot', { accessKey: f.key.token }), 'borrowed owner remains open');
  });

  test(`async Hub ${mode}: legacy business route manifest is fully covered without sync dependencies`, async t => {
    const f = await fixture(t, mode), routes = await f.mount();
    const legacy = new Hono(), metadata = new HubStore(join(f.root, 'legacy.sqlite'), 'legacy-fixture');
    const old = registerHubRoutes(legacy, { config: f.deps.config, hubStore: metadata,
      connectorClient: () => { throw Error('UNEXPECTED_LEGACY_EFFECT'); }, normalizeError: () => 'unavailable' });
    assert.ok(old); f.closes.push(async () => { await old.close(); await metadata.close(); });
    const canonical = (method: string, path: string) => method + ' ' + path.replace(/:[A-Za-z][A-Za-z0-9_]*/g, ':param');
    const actual = new Set(routes.routes.filter(r => r.method !== 'ALL').map(r => canonical(r.method, r.path)));
    const expected = new Set(legacy.routes.filter(r => r.method !== 'ALL').map(r => canonical(r.method, r.path)));
    assert.deepEqual([...expected].filter(path => !actual.has(path)), [], 'every legacy business URL must be registered');
  });

  test(`async Hub ${mode}: Docker routes use async identity and keep host operations disabled`, async t => {
    const f = await fixture(t, mode), routes = await f.mount(); await routes.activate();
    const listed = await f.request(base + '/docker-sandboxes');
    assert.equal(listed.status, 200);
    assert.equal(listed.headers.get('cache-control'), 'no-store');
    const result = await listed.json();
    assert.equal(result.hostOperations, false);
    assert.deepEqual(result.containers, []);
    assert.equal((await f.app.request(base + '/docker-sandboxes')).status, 401);
    for (const action of ['start', 'stop', 'restart', 'remove']) {
      assert.equal((await f.request(base + '/docker-sandboxes/containers/fixture/' + action, { method: 'POST' })).status, 403);
    }
    assert.equal((await f.request(base + '/docker-sandboxes/containers/fixture/logs')).status, 403);
    await routes.close();
    assert.equal((await f.request(base + '/docker-sandboxes')).status, 503);
  });

  test(`async Hub ${mode}: parent owns late Docker body and refuses effects after close`, async t => {
    const f = await fixture(t, mode), routes = await f.mount(); await routes.activate();
    const entered = deferred(), release = deferred();
    const body = new ReadableStream<Uint8Array>({ async pull(controller) {
      entered.resolve(); await release.promise;
      controller.enqueue(new TextEncoder().encode('{"executeContainer":false}')); controller.close();
    } }, { highWaterMark: 0 });
    const pending = f.request(base + '/docker-sandboxes', { method: 'POST', body, duplex: 'half' } as RequestInit);
    await entered.promise;
    let closed = false;
    const closing = routes.close().then(() => { closed = true; });
    await tick(); assert.equal(closed, false);
    release.resolve(); assert.equal((await pending).status, 503); await closing;
  });

  test(`async Hub ${mode}: late assembly failure drains acquired peers before rejection and never publishes`, async t => {
    const f = await fixture(t, mode), entered = deferred(), release = deferred();
    const discovery = f.deps.administrative.createDiscoveryAccess();
    const originalClose = discovery.close.bind(discovery);
    let retired = 0, peers = 0, rejected = false;
    t.mock.method(discovery, 'close', async () => { retired++; entered.resolve(); await release.promise; await originalClose(); });
    t.mock.method(f.deps.administrative, 'createDiscoveryAccess', () => discovery);
    const permission = f.deps.administrative.createPermissionAccess(), permissionClose = permission.close.bind(permission);
    t.mock.method(permission, 'close', async () => { peers++; await permissionClose(); });
    t.mock.method(f.deps.administrative, 'createPermissionAccess', () => permission);
    t.mock.method(f.deps.administrative, 'createSystemAccess', () => { throw Error('LATE_ASSEMBLY_FAILURE'); });
    const before = f.app.routes.length;
    const pending = f.mount().catch(error => { rejected = true; throw error; });
    const check = assert.rejects(pending, /LATE_ASSEMBLY_FAILURE/);
    await entered.promise; await tick();
    assert.equal(peers, 1, 'a pending first cleanup cannot omit independent lanes');
    assert.equal(rejected, false); assert.equal(f.app.routes.length, before); assert.equal(f.starts, 0);
    release.resolve(); await check; assert.equal(retired, 1);
    assert.equal((await f.request(base + '/me')).status, 404);
  });

  test(`async Hub ${mode}: parent owns late user-mutation body and refuses effects after close`, async t => {
    const f = await fixture(t, mode), routes = await f.mount(); await routes.activate();
    const entered = deferred(), release = deferred();
    const original = f.deps.administrative.members.begin.bind(f.deps.administrative.members);
    let calls = 0;
    t.mock.method(f.deps.administrative.members, 'begin', async (...args: Parameters<typeof original>) => {
      const result = await original(...args); calls++;
      return result;
    });
    const body = new ReadableStream<Uint8Array>({ async pull(controller) {
      // Signal actual consumption, not begin() resolving just before the
      // child's pre-body close check. No eager stream pull is permitted.
      entered.resolve();
      await release.promise; controller.enqueue(new TextEncoder().encode('{"label":"must-not-create"}')); controller.close();
    } }, { highWaterMark: 0 });
    const response = f.request(base + '/users', { method: 'POST', body, duplex: 'half' } as RequestInit);
    await entered.promise; let closed = false;
    const closing = routes.close().then(() => { closed = true; });
    await tick(); assert.equal(closed, false, 'HTTP body still belongs to the parent');
    assert.equal((await f.request(base + '/users', { method: 'POST', body: '{"label":"new"}' })).status, 503);
    release.resolve(); assert.equal((await response).status, 503); await closing;
    assert.equal(calls, 2, 'close must not admit another identity/effect');
    const evidence = { accessKey: f.key.token }, proof = await f.owner.command('memberSnapshot', evidence);
    assert.ok(proof);
    const users = await f.owner.command('userDirectory', { evidence, expectedScope: proof.recoveryScope });
    assert.doesNotMatch(JSON.stringify(users), /must-not-create|"label":"new"/);
  });

  test(`async Hub ${mode}: legacy update writes stay retired and never dispatch`, async t => {
    const f = await fixture(t, mode), routes = await f.mount(); await routes.activate();
    for (const operation of ['apply', 'rollback']) {
      const response = await f.request(`${base}/connections/dev/update/${operation}`, { method: 'POST', body: '{"old":true}' });
      assert.equal(response.status, 410); assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.match((await response.json()).error, /reconciled, not resent/);
      assert.equal((await f.app.request(`${base}/connections/dev/update/${operation}`, { method: 'POST' })).status, 401);
    }
  });

  test(`async Hub ${mode}: activation failure freezes admission and awaits every original cleanup`, async t => {
    const f = await fixture(t, mode), entered = deferred(), release = deferred();
    f.deps.config.boardFilesEnabled = true;
    let nativeStarted = 0, contentStarted = 0, peers = 0, rejected = false;
    t.mock.method(AsyncNativeFileBackground.prototype, 'start', () => { nativeStarted++; });
    t.mock.method(AsyncContentBackground.prototype, 'start', () => { contentStarted++; });
    const nativeClose = AsyncNativeFileBackground.prototype.close;
    t.mock.method(AsyncNativeFileBackground.prototype, 'close', async function (this: AsyncNativeFileBackground) {
      entered.resolve(); await release.promise; await nativeClose.call(this);
    });
    const contentClose = AsyncContentBackground.prototype.close;
    t.mock.method(AsyncContentBackground.prototype, 'close', async function (this: AsyncContentBackground) {
      peers++; await contentClose.call(this);
    });
    t.mock.method(WeixinService.prototype, 'startWorker', () => { throw Error('ACTIVATION_FAILURE'); });
    const routes = await f.mount();
    const pending = routes.activate().catch(error => { rejected = true; throw error; });
    const checked = assert.rejects(pending, /ACTIVATION_FAILURE/);
    await entered.promise; await tick();
    assert.equal(nativeStarted, 1); assert.equal(contentStarted, 1); assert.equal(peers, 1);
    assert.equal(rejected, false, 'failure is not an original cleanup ACK');
    assert.equal((await f.request(base + '/me')).status, 503);
    await assert.rejects(routes.activate(), /composition_closed/);
    release.resolve(); await checked; await routes.close();
  });

  test(`async Hub ${mode}: a failed cleanup cannot skip or release a still-pending peer`, async t => {
    const f = await fixture(t, mode), entered = deferred(), release = deferred();
    const discovery = f.deps.administrative.createDiscoveryAccess(), discoveryClose = discovery.close.bind(discovery);
    const permission = f.deps.administrative.createPermissionAccess(), permissionClose = permission.close.bind(permission);
    t.mock.method(f.deps.administrative, 'createDiscoveryAccess', () => discovery);
    t.mock.method(f.deps.administrative, 'createPermissionAccess', () => permission);
    t.mock.method(discovery, 'close', async () => { await discoveryClose(); throw Error('CLEANUP_FAILURE'); });
    t.mock.method(permission, 'close', async () => { entered.resolve(); await release.promise; await permissionClose(); });
    const routes = await f.mount(); let settled = false;
    const pending = routes.close().finally(() => { settled = true; });
    const checked = assert.rejects(pending, /CLEANUP_FAILURE/);
    await entered.promise; await tick();
    assert.equal(settled, false); assert.equal((await f.request(base + '/me')).status, 503);
    release.resolve(); await checked;
    // The expected failed close is terminal; fixture still closes the borrowed
    // groups and original owner, without retrying or hiding that failure.
    f.closes.length = 0;
    await assert.rejects(routes.close(), /CLEANUP_FAILURE/);
  });
}
