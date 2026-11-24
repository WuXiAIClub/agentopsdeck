import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { HubStore } from './hub-store.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { OriginalHubAdministrativeCommands } from './original-administrative-commands.js';
import { createHubAdministrativeServices } from './administrative-route-services.js';
import { createHubConnectorReadServices } from './connector-read-services.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { registerAsyncHubGovernance, isAsyncHubGovernanceRequest, type HubGovernanceServices } from '../routes/hub-governance-async.js';
import { registerHubExecutionIssuerRoutes } from '../routes/hub-execution-issuers.js';
import { registerHubMaintenanceRoutes } from './maintenance-http.js';
import { registerHubLifecycleRoutes } from './lifecycle-http.js';
import { registerHubRoutes } from '../routes/hub.js';
import { loadConfig } from '../config.js';
import { pinOriginalRequestScope } from './original-request-scope.js';
import type { HubMemberKind } from './member-owner-domain.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

async function fixture(t: TestContext, mode: 'original' | 'worker', parent = false) {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-governance-http-')), file = join(root, 'hub.sqlite');
  const seed = new HubStore(file, 'governance-fixture');
  seed.upsertConnection({ id: 'node', kind: 'remote', label: 'Node', connectorUrl: 'http://private.invalid' });
  seed.pinConnectionNode('node', 'default', seed.connectionAuthority('node')!, 'node_b6205f0b-55bc-4e77-b749-98c170f65a21');
  const key = seed.identities.issueKey('default'), cookie = seed.identities.createSession(key.token)!;
  const scope = seed.identities.recoveryScope({ userId: 'default', admin: true });
  await seed.close();
  const db = new DatabaseSync(file);
  try { db.prepare("INSERT INTO hub_roles VALUES ('default','admin',1)").run(); } finally { db.close(); }
  const metadata = new HubStore(mode === 'original' ? file : join(root, 'scaffold.sqlite'), 'governance-fixture');
  const logs: string[] = [], diagnostics = new PerformanceDiagnostics(line => { logs.push(line); });
  const owner = mode === 'original' ? new OriginalHubAdministrativeCommands(metadata, diagnostics)
    : new AsyncHubMemberOwner({ file, encryptionSecret: 'governance-fixture' }, diagnostics);
  const calls: HubMemberKind[] = [], behavior: { after?: (kind: HubMemberKind, input: unknown) => Promise<void> } = {};
  const command: Pick<AsyncHubMemberOwner, 'command'>['command'] = async (kind, input) => {
    calls.push(kind); const result = await owner.command(kind, input); await behavior.after?.(kind, input); return result;
  };
  const administrative = createHubAdministrativeServices({ command,
    contentBackground: () => owner.contentBackground(), nativeFileBackground: () => owner.nativeFileBackground(),
    connectionControlSettlement: () => owner.connectionControlSettlement(),
    weixinBindingEffect: () => owner.weixinBindingEffect(), weixinBackground: () => owner.weixinBackground(),
  }, diagnostics), reads = createHubConnectorReadServices({ command }, undefined, diagnostics);
  const ports = { issuerManagement: reads.issuerManagement, maintenance: reads.maintenanceCommands, lifecycle: reads.lifecycleCommands };
  const app = new Hono(); let sync = 0, routes: { close(): Promise<void> } | undefined;
  t.after(async () => {
    delete behavior.after;
    await routes?.close(); await reads.close(); await administrative.close(); await owner.close(); await metadata.close();
    rmSync(root, { recursive: true, force: true });
    assert.equal(sync, 0, 'governance HTTP must not enter synchronous authority/Connector lanes');
    assert.ok(logs.every(line => !line.includes(key.token) && !line.includes(cookie)
      && !line.includes('private.invalid') && !line.includes('synthetic-private-token')), 'fixed diagnostic fields only');
  });
  routes = parent ? registerHubRoutes(app, { config: loadConfig({ HOME: root, AOD_SERVER_ROLE: 'hub' }),
    hubStore: metadata, administrative, asyncIssuerManagement: ports.issuerManagement,
    asyncMaintenance: ports.maintenance, asyncLifecycle: ports.lifecycle,
    principal: () => { sync++; throw Error('SYNC_GOVERNANCE_PRINCIPAL'); },
    connectorClient: () => { sync++; throw Error('SYNC_GOVERNANCE_CONNECTOR'); }, normalizeError: () => 'unavailable',
  }) : registerAsyncHubGovernance(app, { mode: 'async', access: administrative.createGovernanceAccess(), services: ports, diagnostics });
  assert.ok(routes);
  const base = '/api/hub/v1/connections/node', paths = {
    issuer: `${base}/execution-issuer`, maintenance: `${base}/maintenance/commands/pause`,
    update: `${base}/update/commands/apply`, lifecycle: `${base}/lifecycle/commands/restart`, status: `${base}/lifecycle/status`,
  };
  const headers = (useKey = false) => ({ ...(useKey ? { 'x-agentopsdeck-key': key.token } : { cookie: `agentopsdeck_session=${cookie}` }), 'content-type': 'application/json' });
  const http = (path: string, method = 'GET', body?: unknown, useKey = false) => app.request(path, {
    method, headers: headers(useKey), ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const revoke = async () => {
    const evidence = { accessKey: key.token }, snapshot = await owner.command('memberSnapshot', evidence); assert.ok(snapshot);
    assert.deepEqual(await owner.command('memberKeyRevoke', { evidence, expectedScope: snapshot.recoveryScope,
      userId: 'default', keyId: key.id }), { ok: true });
  };
  return { app, routes, administrative, ports, owner, paths, http, headers, calls, behavior, revoke, scope };
}

for (const mode of ['original', 'worker'] as const) for (const parent of [false, true]) {
  const label = `${mode}/${parent ? 'parent' : 'standalone'}`;
  test(`governance complete no-store boundary preserves frontend HTTP ${label}`, async t => {
    const f = await fixture(t, mode, parent);
    for (const useKey of [false, true]) {
      for (const method of ['GET', 'HEAD']) assert.equal((await f.http(f.paths.issuer, method, undefined, useKey)).status, 200);
      assert.equal((await f.http(f.paths.status, 'GET', undefined, useKey)).status, 200);
      for (const path of [f.paths.maintenance, f.paths.update, f.paths.lifecycle]) {
        assert.equal((await f.http(path + '/original', 'GET', undefined, useKey)).status, 404);
        assert.equal((await f.http(path, 'POST', {}, useKey)).status, 400);
      }
    }
    const issuer = await f.http(f.paths.issuer); assert.equal(issuer.headers.get('cache-control'), 'no-store');
    const before = f.calls.length;
    for (const credential of ['aod_board_synthetic', 'aod_note_synthetic', 'hub_key_invalid']) {
      assert.equal((await f.app.request(f.paths.issuer, { headers: { ...f.headers(), 'x-agentopsdeck-key': credential } })).status, 401);
    }
    assert.equal((await f.app.request(f.paths.issuer, { headers: { ...f.headers(), 'x-agentopsdeck-recovery-scope': 'stale' } })).status, 409);
    assert.ok(f.calls.length >= before);
    const pinned = new Request('http://hub.example.invalid' + f.paths.issuer, { headers: f.headers() }); pinOriginalRequestScope(pinned, 'retired-private-scope');
    assert.equal((await f.app.fetch(pinned)).status, 401);
    assert.equal((await f.http(f.paths.issuer, 'DELETE')).status, 200);
  });
  for (const domain of ['issuer', 'maintenance', 'lifecycle'] as const) test(`governance final identity checks cover invalid ${domain} body ${label}`, async t => {
    const f = await fixture(t, mode, parent), entered = deferred(), release = deferred();
    const body = new ReadableStream<Uint8Array>({ async pull(controller) {
      entered.resolve(); await release.promise; controller.enqueue(new TextEncoder().encode('{bad')); controller.close();
    } }, { highWaterMark: 0 });
    const result = f.app.fetch(new Request('http://hub.example.invalid' + f.paths[domain], {
      method: domain === 'issuer' ? 'PUT' : 'POST', headers: f.headers(), body, duplex: 'half',
    } as RequestInit));
    try { await entered.promise; await f.revoke(); } finally { release.resolve(); }
    assert.equal((await result).status, 401);
    assert.ok(!f.calls.includes('maintenanceCommand'), 'no command admitted after invalid/revoked body');
  });
  test(`governance close waits actual HTTP body ${label}`, async t => {
    const f = await fixture(t, mode, parent), entered = deferred(), release = deferred();
    const body = new ReadableStream<Uint8Array>({ async pull(controller) {
      entered.resolve(); await release.promise; controller.enqueue(new TextEncoder().encode('{}')); controller.close();
    } }, { highWaterMark: 0 });
    const result = f.app.fetch(new Request('http://hub.example.invalid' + f.paths.lifecycle, {
      method: 'POST', headers: f.headers(), body, duplex: 'half',
    } as RequestInit));
    await entered.promise;
    let done = false; const closing = f.routes.close().then(() => { done = true; });
    try {
      await tick(); assert.equal(done, false);
      assert.equal((await f.http(f.paths.issuer)).status, 503);
    } finally { release.resolve(); }
    assert.equal((await result).status, 503); await closing;
  });
}

for (const mode of ['original', 'worker'] as const) {
  test(`all governance domains retain original private pin ${mode}`, async t => {
    const f = await fixture(t, mode);
    const request = () => {
      const r = new Request('http://hub.example.invalid' + f.paths.issuer, { headers: f.headers(true) });
      pinOriginalRequestScope(r, 'retired-private-scope'); return r;
    };
    for (const open of [() => f.ports.issuerManagement.open(request(), 'node'),
      () => f.ports.maintenance.open(request(), { connectionId: 'node', operation: 'pause' }),
      () => f.ports.lifecycle.open(request(), { connectionId: 'node', operation: 'restart' })]) {
      await assert.rejects(open, (e: unknown) => !!e && typeof e === 'object' && 'status' in e && e.status === 401);
    }
  });
  test(`governance close drains late original SQL ACK without replacement ${mode}`, async t => {
    const f = await fixture(t, mode), entered = deferred(), release = deferred(); let held = false;
    f.behavior.after = async kind => {
      if (kind === 'issuerManagement' && !held) { held = true; entered.resolve(); await release.promise; }
    };
    const result = f.http(f.paths.issuer);
    await entered.promise;
    let done = false; const closing = f.routes.close().then(() => { done = true; });
    try { await tick(); assert.equal(done, false); assert.equal(f.calls.filter(k => k === 'issuerManagement').length, 1); }
    finally { release.resolve(); }
    assert.equal((await result).status, 503); await closing;
  });
}

test('governance ports are complete before publishing any route', async () => {
  for (const register of [registerHubExecutionIssuerRoutes, registerHubMaintenanceRoutes, registerHubLifecycleRoutes]) {
    const app = new Hono(); assert.throws(() => register(app, { mode: 'async' } as never), /ports_required/);
    assert.equal(app.routes.length, 0);
  }
  const port = { open: async () => { throw Error('must not execute'); }, close: async () => {} };
  const services = { issuerManagement: port, maintenance: port, lifecycle: port };
  for (const missing of ['issuerManagement', 'maintenance', 'lifecycle'] as const) {
    const app = new Hono();
    assert.throws(() => registerAsyncHubGovernance(app, { mode: 'async', access: { begin: async () => { throw Error('must not execute'); }, close: async () => {} },
      services: { ...services, [missing]: undefined } as unknown as HubGovernanceServices }), /ports_required/);
    assert.equal(app.routes.length, 0);
  }
});

test('governance selection is exact across operations, methods and receipt paths', () => {
  const base = '/api/hub/v1/connections/node';
  for (const suffix of ['/execution-issuer', '/lifecycle/status', '/maintenance/commands/pause/original', '/update/commands/rollback/original', '/lifecycle/commands/upgrade/original']) {
    for (const method of ['GET', 'HEAD']) assert.equal(isAsyncHubGovernanceRequest(method, base + suffix), true);
  }
  for (const suffix of ['/execution-issuer/local', '/maintenance/commands/pause', '/maintenance/commands/resume', '/update/commands/apply', '/update/commands/rollback', '/lifecycle/commands/restart', '/lifecycle/commands/upgrade']) {
    assert.equal(isAsyncHubGovernanceRequest('POST', base + suffix), true);
    assert.equal(isAsyncHubGovernanceRequest('DELETE', base + suffix), false);
  }
  for (const path of [base + '/lifecycle/commands/restart/key/extra', base + '/update/commands/pause', base + '/maintenance/commands/apply', base + '/execution-issuer/fake', '/api/hub/v1/connections/other']) {
    for (const method of ['GET', 'POST', 'PUT', 'DELETE']) assert.equal(isAsyncHubGovernanceRequest(method, path), false);
  }
});
