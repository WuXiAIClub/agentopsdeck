import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { HubStore } from './hub-store.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { OriginalHubAdministrativeCommands } from './original-administrative-commands.js';
import { createHubAdministrativeServices } from './administrative-route-services.js';
import { createAsyncConnectorClientResolver } from './async-connector-client.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { registerHubRoutes } from '../routes/hub.js';
import { loadConfig } from '../config.js';
import { CONNECTOR_PROTOCOL, CONNECTOR_PROTOCOL_HEADER } from '@agentopsdeck/shared';
import { NODE_ID_HEADER } from '../connector/node-identity.js';
import { executeStorageMaintenance, validStorageMaintenanceResult } from './member-storage-maintenance-domain.js';

const nodeId = 'node_00000000-0000-4000-8000-000000000001';
const payload = { version: 1, source: { kind: 'connector', id: nodeId }, sampledAt: 10000, scope: 'process',
  cpu: { percent: null, cores: 1 }, memory: { usedBytes: 10, totalBytes: null, availableBytes: null }, volumes: [] };
const tick = () => new Promise<void>(r => setImmediate(r));
function gate() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function fixture(t: TestContext, mode: 'original' | 'worker') {
  const root = mkdtempSync(join(tmpdir(), 'hub-system-production-')), file = join(root, 'hub.sqlite');
  const seed = new HubStore(file, 'synthetic');
  const admin = seed.createUser('Admin'), member = seed.createUser('Member');
  (seed as unknown as { db: DatabaseSync }).db.prepare("INSERT INTO hub_roles VALUES (?, 'admin', 1)").run(admin.id);
  const key = seed.identities.issueKey(admin.id), other = seed.identities.issueKey(member.id);
  const cookie = seed.identities.createSession(key.token)!;
  const hubId = seed.identities.hubId;
  seed.upsertConnection({ id: 'node', ownerUserId: admin.id, label: 'Original node', connectorUrl: 'http://connector.invalid', credentialToken: 'PRIVATE_METRICS' });
  seed.pinConnectionNode('node', admin.id, seed.connectionAuthority('node', admin.id)!, nodeId);
  await seed.close();
  const original = mode === 'original' ? new HubStore(file, 'synthetic') : undefined;
  const composition = original ?? new HubStore(join(root, 'composition.sqlite'), 'synthetic');
  const logs: string[] = [], diagnostics = new PerformanceDiagnostics(s => logs.push(s));
  const owner = original ? new OriginalHubAdministrativeCommands(original, diagnostics) : new AsyncHubMemberOwner({ file, encryptionSecret: 'synthetic' }, diagnostics);
  const group = createHubAdministrativeServices(owner, diagnostics), resolver = createAsyncConnectorClientResolver(owner, undefined, diagnostics);
  const behavior: { effect?: () => Promise<void>; response: unknown; calls: number } = { response: payload, calls: 0 };
  t.mock.method(globalThis, 'fetch', async () => {
    behavior.calls++; await behavior.effect?.();
    return Response.json(behavior.response, { headers: { [CONNECTOR_PROTOCOL_HEADER]: String(CONNECTOR_PROTOCOL.max), [NODE_ID_HEADER]: nodeId } });
  });
  let poisoned = false;
  const store = new Proxy(composition, { get(target, property, receiver) { if (poisoned) throw Error('SYNC_SYSTEM_STORE'); return Reflect.get(target, property, receiver); } });
  const config = loadConfig({ HOME: root, AOD_SERVER_ROLE: 'hub' });
  const app = new Hono(), routes = registerHubRoutes(app, { config, hubStore: store, hubId, administrative: group,
    asyncConnectorClient: resolver, connectorClient: () => { throw Error('SYNC_SYSTEM_RESOLVER'); },
    principal: () => { throw Error('SYNC_SYSTEM_PRINCIPAL'); }, normalizeError: () => 'safe' });
  assert.ok(routes); poisoned = true;
  const headers = { 'x-agentopsdeck-key': key.token };
  const request = (path: string, init: RequestInit = {}) => new Request('http://hub.invalid/api/hub/v1/' + path, { headers, ...init });
  const proof = async () => { const evidence = { accessKey: key.token }, snapshot = await owner.command('memberSnapshot', evidence); assert.ok(snapshot); return { evidence, expectedScope: snapshot.recoveryScope }; };
  const revoke = async () => { await owner.command('memberKeyRevoke', { ...await proof(), userId: admin.id, keyId: key.id }); };
  const change = async () => {
    const p = await proof(), target = await owner.command('connectionTarget', { ...p, id: 'node' });
    assert.ok(target && 'epoch' in target);
    await owner.command('connectionChange', { ...p, change: { action: 'maintenance', id: 'node', expectedEpoch: target.epoch, token: 'PRIVATE_ROTATED' } });
  };
  t.after(async () => {
    poisoned = false;
    await routes.close(); await group.close(); await resolver.close(); await owner.close(); await composition.close();
    for (const secret of [key.token, cookie, 'PRIVATE_METRICS','PRIVATE_ROTATED']) assert.equal(logs.join('').includes(secret), false);
    rmSync(root, { recursive: true, force: true });
  });
  return { app, routes, request, headers, other, cookie, hubId, behavior, revoke, change };
}
for (const mode of ['original','worker'] as const) {
  test(`${mode}: actual Hub storage and metrics use original async authority, Key/Cookie and original wire`, async t => {
    const f = await fixture(t, mode);
    for (const headers of [f.headers, { cookie: 'agentopsdeck_session=' + f.cookie }]) {
      for (const suffix of ['maintenance/storage','maintenance/storage/recovery','system/metrics/sources','system/metrics/connectors/node']) {
        const result = await f.app.fetch(f.request(suffix, { headers }));
        assert.equal(result.status, 200, suffix + ': ' + await result.clone().text());
        assert.equal(result.headers.get('cache-control'), 'no-store');
        assert.doesNotMatch(await result.text(), /PRIVATE_|connectorUrl|credentialToken|SYNC_SYSTEM/);
      }
    }
    const sources = await (await f.app.fetch(f.request('system/metrics/sources'))).json();
    assert.deepEqual(sources.sources, [{ key: 'hub', kind: 'hub', id: f.hubId, label: 'Hub' }, { key: 'node', kind: 'connector', id: nodeId, label: 'Original node' }]);
    const checkpoint = await f.app.fetch(f.request('maintenance/storage/checkpoint', { method: 'POST', headers: { ...f.headers, 'Content-Type': 'application/json' }, body: '{}' }));
    assert.equal(checkpoint.status, 200);
    assert.equal(validStorageMaintenanceResult({ action: 'checkpoint', value: await checkpoint.json() }), true);
    assert.equal((await f.app.fetch(f.request('maintenance/storage/checkpoint', { method: 'POST', headers: { ...f.headers, 'Content-Type': 'application/json' }, body: '{}' }))).status, 429);
  });
  test(`${mode}: maintenance and local metrics refuse nonadmin; own directory remains scoped`, async t => {
    const f = await fixture(t, mode), headers = { 'x-agentopsdeck-key': f.other.token };
    for (const path of ['maintenance/storage','maintenance/storage/recovery','system/metrics/hub'])
      assert.equal((await f.app.fetch(f.request(path, { headers }))).status, 403, path);
    assert.deepEqual(await (await f.app.fetch(f.request('system/metrics/sources', { headers }))).json(), { sources: [] });
    assert.equal((await f.app.fetch(f.request('system/metrics/connectors/node', { headers }))).status, 404);
    assert.equal(f.behavior.calls, 0);
  });
  for (const change of ['revoke','epoch','badNode'] as const) test(`${mode}: metrics final delivery rejects ${change} after real transport`, async t => {
    const f = await fixture(t, mode);
    f.behavior.effect = change === 'revoke' ? f.revoke : change === 'epoch' ? f.change : async () => { f.behavior.response = { ...payload, source: { kind: 'connector', id: 'other' } }; };
    const response = await f.app.fetch(f.request('system/metrics/connectors/node'));
    assert.notEqual(response.status, 200); assert.equal(f.behavior.calls, 1);
    assert.equal(Object.hasOwn(await response.json(), 'memory'), false);
  });
  test(`${mode}: checkpoint malformed bodies do not consume its single original admission`, async t => {
    const f = await fixture(t, mode);
    for (const [body, type, status] of [['{}','text/plain',415], ['{"x":1}','application/json',400], [' '.repeat(257),'application/json',413]] as const) {
      assert.equal((await f.app.fetch(f.request('maintenance/storage/checkpoint', { method: 'POST', headers: { ...f.headers, 'Content-Type': type }, body }))).status, status);
    }
    assert.equal((await f.app.fetch(f.request('maintenance/storage/checkpoint', { method: 'POST', headers: { ...f.headers, 'Content-Type': 'application/json' }, body: '{}' }))).status, 200);
  });
  test(`${mode}: shutdown drains original metrics transport and its last authority ACK without replay`, async t => {
    const f = await fixture(t, mode), entered = gate(), released = gate();
    f.behavior.effect = async () => { entered.resolve(); await released.promise; };
    const response = f.app.fetch(f.request('system/metrics/connectors/node'));
    await entered.promise;
    let closed = false; const closing = f.routes.close().then(() => { closed = true; });
    await tick(); assert.equal(closed, false); released.resolve();
    await response; await closing; assert.equal(f.behavior.calls, 1);
  });
}
test('maintenance policy rechecks original authority after async stats and immediately before SQL, never replaying', async t => {
  const root = mkdtempSync(join(tmpdir(), 'maintenance-policy-')), store = new HubStore(join(root, 'hub.sqlite'), 'synthetic');
  t.after(async () => { await store.close(); rmSync(root, { recursive: true, force: true }); });
  const actor = { userId: 'default', admin: true }, request = new Request('http://hub.invalid');
  const scope = store.identities.recoveryScope(actor);
  let allowed = true, sql = 0;
  t.mock.method(store.identities, 'commandPrincipal', () => allowed ? actor : undefined);
  const stats = store.storageStats.bind(store);
  t.mock.method(store, 'storageStats', async () => { const value = await stats(); allowed = false; return value; });
  assert.deepEqual(await executeStorageMaintenance(store, request, scope, { action: 'stats' }), { error: 401 });
  allowed = true;
  t.mock.method(store, 'checkpointStorage', async (check?: () => void) => { await tick(); allowed = false; check?.(); sql++; return { deferred: true }; });
  assert.deepEqual(await executeStorageMaintenance(store, request, scope, { action: 'checkpoint' }), { error: 401 });
  assert.equal(sql, 0);
});
