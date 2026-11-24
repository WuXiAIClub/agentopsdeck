import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { CONNECTOR_PROTOCOL, CONNECTOR_PROTOCOL_HEADER, createCommandKey } from '@agentopsdeck/shared';
import { HubStore } from './hub-store.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { OriginalHubAdministrativeCommands } from './original-administrative-commands.js';
import { createHubAdministrativeServices } from './administrative-route-services.js';
import { createAsyncConnectorClientResolver } from './async-connector-client.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { registerHubRoutes } from '../routes/hub.js';
import { loadConfig } from '../config.js';
import { NODE_ID_HEADER } from '../connector/node-identity.js';
import { pinOriginalRequestScope } from './original-request-scope.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => {resolve = r;});
  return {promise, resolve};
}

async function fixture(t: TestContext, mode: 'original' | 'worker', noResolver = false, failAudit = false) {
  const root = mkdtempSync(join(tmpdir(), 'control-production-')), file = join(root, 'hub.sqlite');
  const nodeId = `node_${randomUUID()}`;
  const seed = new HubStore(file, 'fixture'), db = (seed as unknown as {db: DatabaseSync}).db;
  db.prepare("INSERT INTO hub_roles VALUES ('default','admin',1)").run();
  const admin = seed.identities.issueKey('default'), user = seed.createUser('Control owner');
  const key = seed.identities.issueKey(user.id), second = seed.identities.issueKey(user.id), cookie = seed.identities.createSession(key.token)!;
  const foreign = seed.identities.issueKey(seed.createUser('Foreign').id);
  seed.upsertConnection({id: 'node', ownerUserId: user.id, label: 'Node', connectorUrl: 'http://connector.invalid', credentialToken: 'PRIVATE_DAILY'});
  seed.updateMaintenanceCredential('node', 'PRIVATE_MAINTENANCE', user.id);
  seed.pinConnectionNode('node', user.id, seed.connectionAuthority('node', user.id)!, nodeId);
  if (failAudit) db.exec("CREATE TRIGGER fail_control_audit BEFORE INSERT ON audit_logs WHEN new.action = 'connector.update.checked' BEGIN SELECT RAISE(ABORT, 'audit fail'); END");
  await seed.close();
  const original = mode === 'original' ? new HubStore(file, 'fixture') : undefined;
  const metadata = original ?? new HubStore(join(root, 'composition.sqlite'), 'fixture');
  const logs: string[] = [], diagnostics = new PerformanceDiagnostics(line => {logs.push(line);});
  const owner = original ? new OriginalHubAdministrativeCommands(original, diagnostics) : new AsyncHubMemberOwner({file, encryptionSecret: 'fixture'}, diagnostics);
  const group = createHubAdministrativeServices(owner, diagnostics), resolver = createAsyncConnectorClientResolver(owner, undefined, diagnostics);
  const behavior: {calls: Request[]; transport?: () => void | Promise<void>; resolve?: () => void | Promise<void>; status: number;
    response?: (headers: HeadersInit) => Response} = {calls: [], status: 200};
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    assert.equal(new URL(request.url).hostname, 'connector.invalid'); behavior.calls.push(request);
    const daily = ['/capabilities', '/update/status'].some(path => request.url.endsWith(path));
    assert.equal(request.headers.get('authorization'), daily ? 'Bearer PRIVATE_DAILY' : 'Bearer PRIVATE_MAINTENANCE');
    await behavior.transport?.();
    const headers = {[CONNECTOR_PROTOCOL_HEADER]: String(CONNECTOR_PROTOCOL.max), [NODE_ID_HEADER]: nodeId};
    return behavior.response?.(headers) ?? Response.json({ok: true, state: 'succeeded'}, {status: behavior.status, headers});
  });
  let guarded = false;
  const store = new Proxy(metadata, {get(target, property, receiver) {if (guarded) throw Error('SYNC_CONTROL_STORE'); return Reflect.get(target, property, receiver);}});
  const app = new Hono(), routes = registerHubRoutes(app, {
    config: loadConfig({HOME: root, AOD_SERVER_ROLE: 'hub'}), hubStore: store, administrative: group,
    principal: () => {throw Error('SYNC_CONTROL_PRINCIPAL');}, connectorClient: () => {throw Error('SYNC_CONTROL_RESOLVER');},
    ...(!noResolver ? {asyncConnectorClient: async (...args: Parameters<typeof resolver>) => {await behavior.resolve?.(); return resolver(...args);}} : {}),
    normalizeError: () => 'safe',
  });
  assert.ok(routes); guarded = true;
  const request = (path: string, body?: unknown, headers: Record<string, string> = {'x-agentopsdeck-key': key.token}) =>
    new Request('http://hub.invalid/api/hub/v1/connections/node/' + path, {headers,
      ...(body !== undefined ? {method: 'POST', body: JSON.stringify(body)} : {})});
  const receipt = (commandKey: string, operation = 'updateCheck', token = key.token) => app.fetch(request(`control/receipts/${commandKey}?operation=${operation}`, undefined, {'x-agentopsdeck-key': token}));
  const revoke = async () => {
    const evidence = {accessKey: admin.token}, actor = await owner.command('memberSnapshot', evidence); assert.ok(actor);
    await owner.command('memberKeyRevoke', {evidence, expectedScope: actor.recoveryScope, userId: user.id, keyId: key.id});
  };
  const read = (sql: string) => {const reader = new DatabaseSync(file, {readOnly: true}); try {return reader.prepare(sql).all();} finally {reader.close();}};
  t.after(async () => {
    guarded = false;
    try {await routes.close();} finally {try {await group.close();} finally {try {await resolver.close();} finally {try {await owner.close();} finally {await metadata.close();}}}}
    for (const secret of [key.token, cookie, 'PRIVATE_DAILY', 'PRIVATE_MAINTENANCE']) assert.equal(logs.join('').includes(secret), false);
    rmSync(root, {recursive: true, force: true});
  });
  return {app, request, receipt, behavior, key, second, cookie, foreign, revoke, read, close: routes.close};
}

for (const mode of ['original', 'worker'] as const) {
  test(`${mode}: six production controls use original authority and exact credential/wire, no sync fallback`, async t => {
    const f = await fixture(t, mode);
    for (const headers of [{'x-agentopsdeck-key': f.key.token}, {cookie: 'agentopsdeck_session=' + f.cookie}]) {
      for (const path of ['capabilities', 'gateway/model-set', 'update/status', 'maintenance/status']) {
        const response = await f.app.fetch(f.request(path, undefined, headers)); assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), {ok: true, state: 'succeeded'});
      }
      for (const path of ['gateway/model-set/reconcile', 'update/check']) {
        const response = await f.app.fetch(f.request(path, {idempotencyKey: createCommandKey(randomUUID())}, headers)); assert.equal(response.status, 200);
      }
    }
    assert.equal(f.behavior.calls.length, 12);
    for (const request of f.behavior.calls) assert.ok(new URL(request.url).pathname.startsWith('/api/connector/v1/'));
  });
  test(`${mode}: stable key and read-only original receipt prevent redispatch across HTTP retries`, async t => {
    const f = await fixture(t, mode), key = createCommandKey(randomUUID());
    assert.equal((await f.app.fetch(f.request('update/check', {}))).status, 428);
    assert.equal((await f.app.fetch(f.request('update/check', {idempotencyKey: key, unexpected: true}))).status, 400);
    assert.equal(f.behavior.calls.length, 0);
    assert.equal((await f.app.fetch(f.request('update/check', {idempotencyKey: key}))).status, 200);
    assert.equal((await f.app.fetch(f.request('update/check', {idempotencyKey: key}))).status, 409);
    const recovered = await f.receipt(key); assert.equal(recovered.status, 200);
    assert.deepEqual(await recovered.json(), {command: {key, operation: 'updateCheck', state: 'accepted', status: 200}});
    assert.equal((await f.receipt(key, 'reconcile')).status, 404);
    assert.notEqual((await f.receipt(key, 'updateCheck', f.foreign.token)).status, 200);
    assert.equal(f.behavior.calls.length, 1);
    assert.equal(f.read("SELECT * FROM audit_logs WHERE action='connector.update.checked'").length, 1);
  });
  test(`${mode}: post-effect revocation denies delivery but original settlement survives for another valid key`, async t => {
    const f = await fixture(t, mode), key = createCommandKey(randomUUID()); f.behavior.transport = f.revoke;
    assert.notEqual((await f.app.fetch(f.request('update/check', {idempotencyKey: key}))).status, 200);
    assert.equal(f.behavior.calls.length, 1);
    const response = await f.receipt(key, 'updateCheck', f.second.token); assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {command: {key, operation: 'updateCheck', state: 'accepted', status: 200}});
    assert.equal(f.read("SELECT * FROM audit_logs WHERE action='connector.update.checked'").length, 1);
  });
  test(`${mode}: original audit failure rolls back terminal receipt and does not repeat remote effect`, async t => {
    const f = await fixture(t, mode, false, true), key = createCommandKey(randomUUID());
    assert.notEqual((await f.app.fetch(f.request('update/check', {idempotencyKey: key}))).status, 200);
    const response = await f.receipt(key); assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {command: {key, operation: 'updateCheck', state: 'outcome_unknown'}});
    assert.equal((await f.app.fetch(f.request('update/check', {idempotencyKey: key}))).status, 409);
    assert.equal(f.behavior.calls.length, 1);
    assert.equal(f.read("SELECT * FROM audit_logs WHERE action='connector.update.checked'").length, 0);
  });
  test(`${mode}: missing async resolver fails closed without dispatch`, async t => {
    const f = await fixture(t, mode, true);
    assert.equal((await f.app.fetch(f.request('capabilities'))).status, 503); assert.equal(f.behavior.calls.length, 0);
  });
  test(`${mode}: resolver-time revocation prevents any original remote dispatch`, async t => {
    const f = await fixture(t, mode); f.behavior.resolve = f.revoke;
    assert.notEqual((await f.app.fetch(f.request('update/check', {idempotencyKey: createCommandKey(randomUUID())}))).status, 200);
    assert.equal(f.behavior.calls.length, 0);
  });
  test(`${mode}: original control upload authenticates scope and pin before reading any bytes`, async t => {
    const f = await fixture(t, mode);
    for (const kind of ['key', 'owner', 'scope', 'pin'] as const) {
      let pulled = 0;
      const body = new ReadableStream<Uint8Array>({pull() {pulled++; throw Error('UNAUTHORIZED_CONTROL_BODY');}}, {highWaterMark: 0});
      const request = new Request(f.request('update/check').url, {method: 'POST', body, duplex: 'half', headers: {
        'x-agentopsdeck-key': kind === 'key' ? 'invalid' : kind === 'owner' ? f.foreign.token : f.key.token,
        ...(kind === 'scope' ? {'x-agentopsdeck-recovery-scope': 'foreign'} : {}),
      }} as RequestInit);
      if (kind === 'pin') pinOriginalRequestScope(request, 'foreign');
      assert.equal((await f.app.fetch(request)).status, kind === 'scope' ? 409 : kind === 'owner' ? 404 : 401);
      assert.equal(pulled, 0); await body.cancel();
    }
    assert.equal(f.behavior.calls.length, 0);
  });
  test(`${mode}: original control upload bounds actual UTF8 bytes without trusting Content-Length`, async t => {
    const f = await fixture(t, mode), limit = 48 * 1024;
    for (const length of [undefined, '1', String(limit + 1)]) {
      let pulled = 0, cancelled = 0;
      const body = new ReadableStream<Uint8Array>({pull(c) {pulled++; c.enqueue(new TextEncoder().encode('界'.repeat(limit / 3 + 1)));}, cancel() {cancelled++;}}, {highWaterMark: 0});
      const request = new Request(f.request('update/check').url, {method: 'POST', body, duplex: 'half', headers: {
        'x-agentopsdeck-key': f.key.token, ...(length ? {'content-length': length} : {}),
      }} as RequestInit);
      assert.equal((await f.app.fetch(request)).status, 413);
      assert.equal(pulled, length === String(limit + 1) ? 0 : 1); assert.equal(cancelled, 1);
    }
    assert.equal(f.behavior.calls.length, 0);
  });
  for (const reason of ['abort', 'close', 'oversize'] as const) {
    test(`${mode}: control upload ${reason} drains original cancellation ACK and never dispatches`, {timeout: 20000}, async t => {
      const f = await fixture(t, mode), reading = deferred(), cancelling = deferred(), ack = deferred(), abort = new AbortController();
      const body = new ReadableStream<Uint8Array>({pull(c) {reading.resolve(); if (reason === 'oversize') c.enqueue(new Uint8Array(48 * 1024 + 1));},
        async cancel() {cancelling.resolve(); await ack.promise;}}, {highWaterMark: 0});
      const base = f.request('update/check'); let delivered = false, closed = false;
      const response = Promise.resolve(f.app.fetch(new Request(base.url, {method: 'POST', headers: base.headers, body,
        signal: abort.signal, duplex: 'half'} as RequestInit))).then(value => {delivered = true; return value;});
      try {
        await reading.promise;
        if (reason === 'abort') abort.abort();
        const closing = reason === 'close' ? f.close().then(() => {closed = true;}) : undefined;
        await cancelling.promise; await tick(); assert.equal(delivered, false); assert.equal(closed, false);
        ack.resolve(); assert.equal((await response).status, reason === 'close' ? 503 : reason === 'abort' ? 499 : 413);
        await closing; assert.equal(f.behavior.calls.length, 0);
      } finally {ack.resolve();}
    });
  }
  test(`${mode}: known rejection settles while uncertain upstream status/JSON retains original fence`, async t => {
    const f = await fixture(t, mode);
    for (const kind of ['rejected', 'server', 'json'] as const) {
      const key = createCommandKey(randomUUID());
      f.behavior.response = headers => kind === 'json' ? new Response('broken', {headers})
        : Response.json({error: 'synthetic'}, {status: kind === 'rejected' ? 422 : 503, headers});
      assert.notEqual((await f.app.fetch(f.request('update/check', {idempotencyKey: key}))).status, 200);
      assert.deepEqual(await (await f.receipt(key)).json(), {command: {key, operation: 'updateCheck',
        state: kind === 'rejected' ? 'rejected' : 'outcome_unknown', ...(kind === 'rejected' ? {status: 422} : {})}});
      assert.equal((await f.app.fetch(f.request('update/check', {idempotencyKey: key}))).status, 409);
    }
    assert.equal(f.behavior.calls.length, 3);
  });
  test(`${mode}: close waits for late original dispatch and original receipt settlement`, {timeout: 20000}, async t => {
    const f = await fixture(t, mode), entered = deferred(), release = deferred(), key = createCommandKey(randomUUID());
    f.behavior.transport = async () => {entered.resolve(); await release.promise;};
    const response = f.app.fetch(f.request('update/check', {idempotencyKey: key}));
    try {
      await entered.promise; let closed = false; const closing = f.close().then(() => {closed = true;});
      await tick(); assert.equal(closed, false); release.resolve();
      assert.equal((await response).status, 503); await closing;
      assert.equal(f.behavior.calls.length, 1);
      assert.equal(f.read("SELECT * FROM audit_logs WHERE action='connector.update.checked'").length, 1);
    } finally {release.resolve();}
  });
}
