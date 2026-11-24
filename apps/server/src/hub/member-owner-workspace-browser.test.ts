import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { chromium, type Browser } from 'playwright-core';
import { Hono } from 'hono';
import { HubStore } from './hub-store.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { OriginalHubAdministrativeCommands } from './original-administrative-commands.js';
import { createHubAdministrativeServices } from './administrative-route-services.js';
import { hubMemberEvidence, type HubMemberKind } from './member-owner-domain.js';
import { WorkspaceBrowser } from './workspace-browser.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { registerHubBrowser } from '../routes/hub-workspace-browser.js';
import { registerHubRoutes } from '../routes/hub.js';
import { loadConfig } from '../config.js';
import { pinOriginalRequestScope } from './original-request-scope.js';

const base = '/api/hub/v1/workspace/browser';
const config = { endpoint: 'ws://127.0.0.1/PRIVATE_ENDPOINT', users: ['default'], hosts: ['learn.microsoft.com'] };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
async function fixture(t: TestContext, mode: 'original' | 'worker') {
  const root = mkdtempSync(join(tmpdir(), 'browser-async-')), file = join(root, 'hub.sqlite');
  const seed = new HubStore(file, 'fixture');
  (seed as unknown as { db: DatabaseSync }).db.prepare("INSERT INTO hub_roles VALUES ('default','admin',1)").run();
  const key = seed.identities.issueKey('default'), observer = seed.identities.issueKey('default'), session = seed.identities.createSession(key.token)!;
  const other = seed.createUser('Other'), otherKey = seed.identities.issueKey(other.id); await seed.close();
  const original = mode === 'original' ? new HubStore(file, 'fixture') : undefined;
  const logs: string[] = [], diagnostics = new PerformanceDiagnostics(line => { logs.push(line); });
  const owner = original ? new OriginalHubAdministrativeCommands(original, diagnostics) : new AsyncHubMemberOwner({ file, encryptionSecret: 'fixture' }, diagnostics);
  const behavior: { after?: (kind: HubMemberKind) => void | Promise<void>; screenshot?: () => Promise<Buffer>; audits: number; calls: string[] } = { audits: 0, calls: [] };
  const port = { command: async (kind: HubMemberKind, value: never) => { const result = await owner.command(kind, value);
    if (kind === 'auditAppend') behavior.audits++; await behavior.after?.(kind); return result; } } as Pick<AsyncHubMemberOwner, 'command'>;
  const group = createHubAdministrativeServices({ ...port, weixinBackground: () => owner.weixinBackground(),
    weixinBindingEffect: () => owner.weixinBindingEffect(), connectionControlSettlement: () => owner.connectionControlSettlement() }, diagnostics), access = group.createWorkspaceBrowserAccess();
  const page = { on() {}, url: () => 'about:blank', title: async () => 'PRIVATE_TITLE',
    screenshot: async () => { behavior.calls.push('frame'); return behavior.screenshot ? behavior.screenshot() : Buffer.from('PRIVATE_IMAGE'); },
    keyboard: { press: async () => { behavior.calls.push('key'); } } };
  const context = { setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, route: async () => {}, routeWebSocket: async () => {}, on() {}, newPage: async () => page,
    close: async () => { behavior.calls.push('context.close'); } };
  const browser = { newContext: async () => context, close: async () => { behavior.calls.push('browser.close'); } } as unknown as Browser;
  const service = new WorkspaceBrowser(config, async () => { behavior.calls.push('connect'); return browser; });
  const app = new Hono(), routes = registerHubBrowser(app, { mode: 'async', service, access, diagnostics });
  const request = (path: string, body?: unknown, token = key.token, method = body === undefined ? 'GET' : 'POST', signal?: AbortSignal) => new Request('http://hub.invalid' + base + '/' + path,
    { method, headers: { 'x-agentopsdeck-key': token }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(signal ? { signal } : {}) });
  const revoke = async (keyId = key.id) => {
    const evidence = hubMemberEvidence(request('config', undefined, observer.token)), snapshot = await owner.command('memberSnapshot', evidence); assert.ok(snapshot);
    assert.deepEqual(await owner.command('memberKeyRevoke', { evidence, expectedScope: snapshot.recoveryScope, userId: 'default', keyId }), { ok: true });
  };
  t.after(async () => { await routes.close(); await group.close(); await owner.close(); await original?.close();
    for (const secret of [key.token, observer.token, session, otherKey.token, 'PRIVATE_TITLE', 'PRIVATE_IMAGE', 'PRIVATE_ENDPOINT']) assert.equal(logs.join('').includes(secret), false);
    rmSync(root, { recursive: true, force: true }); });
  return { root, original, app, group, service, routes, request, revoke, key, observer, session, otherKey, behavior, browser };
}

for (const mode of ['original', 'worker'] as const) {
  test(`${mode} browser request copy preserves mismatched private scope and refuses native work`, async t => {
    const f = await fixture(t, mode), request = f.request('sessions', { id: randomUUID() });
    pinOriginalRequestScope(request, 'unrelated-private-scope');
    assert.equal((await f.app.fetch(request)).status, 401);
    assert.deepEqual(f.behavior.calls, []);
    assert.equal(f.behavior.audits, 0);
  });
  test(`${mode} browser five-entry workflow uses real authority and original native executor`, async t => {
    const f = await fixture(t, mode), id = randomUUID();
    assert.deepEqual(await (await f.app.fetch(f.request('config'))).json(), { enabled: true, hosts: config.hosts });
    assert.equal((await f.app.fetch(f.request('config', undefined, undefined, 'HEAD'))).status, 200);
    for (const cookie of [`agentopsdeck_access=${f.key.token}`, `agentopsdeck_session=${f.session}`])
      assert.equal((await f.app.fetch(new Request('http://hub.invalid' + base + '/config', { headers: { cookie } }))).status, 200);
    const controller = new AbortController();
    assert.equal((await f.app.fetch(f.request('sessions', { id }, undefined, 'POST', controller.signal))).status, 200);
    controller.abort(); // Successful HTTP lifetime is not the creator evidence lifetime.
    const frame = await f.app.fetch(f.request(`sessions/${id}/frame`, undefined, f.observer.token)); assert.equal(frame.status, 200);
    assert.equal((await frame.json() as { image: string }).image, Buffer.from('PRIVATE_IMAGE').toString('base64'));
    assert.equal((await f.app.fetch(f.request(`sessions/${id}/actions`, { kind: 'key', key: 'Enter', seq: 1 }, f.observer.token))).status, 200);
    assert.equal((await f.app.fetch(f.request(`sessions/${id}/actions`, { kind: 'key', key: 'Enter', seq: 1 }))).status, 409);
    assert.equal((await f.app.fetch(f.request(`sessions/${id}`, undefined, undefined, 'DELETE'))).status, 200);
    assert.equal(f.behavior.calls.filter(v => v === 'connect').length, 1); assert.equal(f.behavior.calls.filter(v => v === 'key').length, 1);
    assert.equal(f.behavior.audits, 3);
    assert.equal((await f.app.fetch(f.request('sessions', { id: randomUUID() }, f.otherKey.token))).status, 403);
  });
  test(`${mode} browser revoked creator cannot be replaced by another live key of the same user`, async t => {
    const f = await fixture(t, mode), id = randomUUID(); assert.equal((await f.app.fetch(f.request('sessions', { id }))).status, 200);
    await f.revoke(); assert.equal((await f.app.fetch(f.request(`sessions/${id}/frame`, undefined, f.observer.token))).status, 404);
    assert.equal(f.behavior.calls.includes('frame'), false);
  });
  test(`${mode} browser revocation during original screenshot suppresses private delivery`, async t => {
    const f = await fixture(t, mode), id = randomUUID(), entered = deferred<void>(), release = deferred<Buffer>();
    assert.equal((await f.app.fetch(f.request('sessions', { id }))).status, 200);
    f.behavior.screenshot = () => { entered.resolve(); return release.promise; };
    const running = Promise.resolve(f.app.fetch(f.request(`sessions/${id}/frame`)));
    try { await entered.promise; await f.revoke(); release.resolve(Buffer.from('PRIVATE_IMAGE')); const response = await running;
      assert.equal(response.status, 502); assert.equal((await response.text()).includes('PRIVATE_IMAGE'), false);
      assert.equal(f.behavior.calls.filter(v => v === 'frame').length, 1);
    } finally { release.resolve(Buffer.from('PRIVATE_IMAGE')); await running; }
  });
  test(`${mode} browser close retains audit ACK across administrative close, with no replay`, async t => {
    const f = await fixture(t, mode), entered = deferred<void>(), release = deferred<void>();
    f.behavior.after = async kind => { if (kind === 'auditAppend') { entered.resolve(); await release.promise; } };
    const running = Promise.resolve(f.app.fetch(f.request('sessions', { id: randomUUID() })));
    try { await entered.promise; await f.group.close(); let drained = false;
      const closing = f.routes.close().then(() => { drained = true; }); await tick(); assert.equal(drained, false);
      assert.equal((await f.app.fetch(f.request('config'))).status, 503);
      release.resolve(); assert.equal((await running).status, 503); await closing;
      assert.equal(f.behavior.calls.filter(v => v === 'connect').length, 1); assert.equal(f.behavior.audits, 1);
    } finally { release.resolve(); await running; }
  });
  test(`${mode} browser unknown audit settlement never replays original native creation`, async t => {
    const f = await fixture(t, mode);
    f.behavior.after = kind => { if (kind === 'auditAppend') throw Error('PRIVATE_LOST_ACK'); };
    assert.equal((await f.app.fetch(f.request('sessions', { id: randomUUID() }))).status, 503);
    assert.equal(f.behavior.calls.filter(v => v === 'connect').length, 1); assert.equal(f.behavior.audits, 1);
  });
  test(`${mode} browser creator revoked during another key's audit suppresses late delivery`, async t => {
    const f = await fixture(t, mode), id = randomUUID(), entered = deferred<void>(), release = deferred<void>();
    assert.equal((await f.app.fetch(f.request('sessions', { id }))).status, 200);
    f.behavior.after = async kind => { if (kind === 'auditAppend') { entered.resolve(); await release.promise; } };
    const running = Promise.resolve(f.app.fetch(f.request(`sessions/${id}/actions`, { kind: 'key', key: 'Enter', seq: 1 }, f.observer.token)));
    try { await entered.promise; await f.revoke(); release.resolve(); assert.equal((await running).status, 403);
      assert.equal(f.behavior.calls.filter(v => v === 'key').length, 1);
      assert.equal(f.behavior.calls.filter(v => v === 'context.close').length, 1);
    } finally { release.resolve(); await running; }
  });
  test(`${mode} browser body-time revocation prevents all native creation`, async t => {
    const f = await fixture(t, mode);
    const body = new ReadableStream<Uint8Array>({ async pull(stream) { await f.revoke(); stream.enqueue(new TextEncoder().encode(JSON.stringify({ id: randomUUID() }))); stream.close(); } });
    const response = await f.app.fetch(new Request('http://hub.invalid' + base + '/sessions', { method: 'POST', headers: { 'x-agentopsdeck-key': f.key.token }, body, duplex: 'half' } as RequestInit));
    assert.ok([401, 403].includes(response.status)); assert.equal(f.behavior.calls.length, 0);
  });
  test(`${mode} browser current key revoked during screenshot cannot borrow the creator's live proof`, async t => {
    const f = await fixture(t, mode), id = randomUUID(), entered = deferred<void>(), release = deferred<Buffer>();
    assert.equal((await f.app.fetch(f.request('sessions', { id }))).status, 200);
    f.behavior.screenshot = () => { entered.resolve(); return release.promise; };
    const running = Promise.resolve(f.app.fetch(f.request(`sessions/${id}/frame`, undefined, f.observer.token)));
    try { await entered.promise; await f.revoke(f.observer.id); release.resolve(Buffer.from('PRIVATE_IMAGE'));
      assert.equal((await running).status, 502); assert.equal(f.behavior.calls.filter(v => v === 'frame').length, 1);
    } finally { release.resolve(Buffer.from('PRIVATE_IMAGE')); await running; }
  });
  test(`${mode} browser newer action while old audit awaits fences stale state without replay`, async t => {
    const f = await fixture(t, mode), id = randomUUID(), entered = deferred<void>(), release = deferred<void>(); let held = false;
    assert.equal((await f.app.fetch(f.request('sessions', { id }))).status, 200);
    f.behavior.after = async kind => { if (kind === 'auditAppend' && !held) { held = true; entered.resolve(); await release.promise; } };
    const running = Promise.resolve(f.app.fetch(f.request(`sessions/${id}/actions`, { kind: 'key', key: 'Enter', seq: 1 })));
    try { await entered.promise; assert.equal((await f.app.fetch(f.request(`sessions/${id}/actions`, { kind: 'key', key: 'Enter', seq: 2 }))).status, 200);
      release.resolve(); assert.equal((await running).status, 409); assert.equal(f.behavior.calls.filter(v => v === 'key').length, 2);
    } finally { release.resolve(); await running; }
  });
}

test('production browser composition bypasses synchronous identity only for exact entries', async t => {
  const f = await fixture(t, 'original'), settings = loadConfig({ HOME: f.root, AOD_SERVER_ROLE: 'hub' });
  let guarded = false, principals = 0;
  const store = new Proxy(f.original!, { get(target, key, receiver) { if (guarded) throw Error('SYNC_STORE_FALLBACK'); return Reflect.get(target, key, receiver); } });
  const app = new Hono(), routes = registerHubRoutes(app, { config: settings, hubStore: store, administrative: f.group,
    principal: () => { principals++; return undefined; }, connectorClient: () => { throw Error('UNEXPECTED_CONNECTOR'); }, normalizeError: () => 'safe' });
  try { guarded = true;
    for (const token of ['aod_board_synthetic', 'aod_note_synthetic']) assert.equal((await app.fetch(f.request('config', undefined, token))).status, 401);
    assert.deepEqual(await (await app.fetch(f.request('config'))).json(), { enabled: false, hosts: [] });
    for (const [path, method, body] of [['sessions', 'POST', { id: randomUUID() }], ['sessions/id/frame', 'GET', undefined],
      ['sessions/id/actions', 'POST', { kind: 'reload', seq: 1 }], ['sessions/id', 'DELETE', undefined]] as const)
      assert.equal((await app.fetch(f.request(path, body, undefined, method))).status, 403);
    assert.equal(principals, 0);
    assert.equal((await app.fetch(f.request('config', undefined, undefined, 'PATCH'))).status, 401); assert.equal(principals, 1);
  } finally { guarded = false; await routes?.close(); }
});

test('production enabled browser uses async access for original five-entry native workflow', async t => {
  const f = await fixture(t, 'original'), settings = loadConfig({ HOME: f.root, AOD_SERVER_ROLE: 'hub' }); settings.hub.browser = config;
  let guarded = false, principals = 0, connects = 0;
  t.mock.method(chromium, 'connect', async () => { connects++; return f.browser; });
  const store = new Proxy(f.original!, { get(target, key, receiver) { if (guarded) throw Error('SYNC_STORE_FALLBACK'); return Reflect.get(target, key, receiver); } });
  const app = new Hono(), routes = registerHubRoutes(app, { config: settings, hubStore: store, administrative: f.group,
    principal: () => { principals++; return undefined; }, connectorClient: () => { throw Error('UNEXPECTED_CONNECTOR'); }, normalizeError: () => 'safe' });
  try { guarded = true; const id = randomUUID();
    assert.equal((await app.fetch(f.request('config'))).status, 200);
    assert.equal((await app.fetch(f.request('sessions', { id }))).status, 200);
    assert.equal((await app.fetch(f.request(`sessions/${id}/frame`))).status, 200);
    assert.equal((await app.fetch(f.request(`sessions/${id}/actions`, { kind: 'key', key: 'Enter', seq: 1 }))).status, 200);
    assert.equal((await app.fetch(f.request(`sessions/${id}`, undefined, undefined, 'DELETE'))).status, 200);
    assert.equal(principals, 0); assert.equal(connects, 1);
  } finally { guarded = false; await routes?.close(); }
});
