import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Hono} from 'hono';
import {CONNECTOR_PROTOCOL, CONNECTOR_PROTOCOL_HEADER} from '@agentopsdeck/shared';
import {HubStore} from './hub-store.js';
import {AsyncHubMemberOwner} from './async-member-owner.js';
import {OriginalHubAdministrativeCommands} from './original-administrative-commands.js';
import {createHubAdministrativeServices} from './administrative-route-services.js';
import {createAsyncConnectorClientResolver} from './async-connector-client.js';
import {PerformanceDiagnostics} from '../diagnostics/performance.js';
import {registerHubRoutes} from '../routes/hub.js';
import {loadConfig} from '../config.js';
import {NODE_ID_HEADER} from '../connector/node-identity.js';
import {pinOriginalRequestScope} from './original-request-scope.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() {let resolve!: () => void; const promise = new Promise<void>(r => {resolve = r;}); return {promise, resolve};}
async function fixture(t: TestContext, mode: 'original' | 'worker', noResolver = false) {
  const root = mkdtempSync(join(tmpdir(), 'verify-production-')), file = join(root, 'hub.sqlite'), nodeId = `node_${randomUUID()}`;
  const seed = new HubStore(file, 'fixture'), user = seed.createUser('Owner'), other = seed.createUser('Other');
  const key = seed.identities.issueKey(user.id), foreign = seed.identities.issueKey(other.id), cookie = seed.identities.createSession(key.token)!;
  seed.upsertConnection({id: 'node', ownerUserId: user.id, label: 'Node', connectorUrl: 'http://connector.invalid', credentialToken: 'PRIVATE_DAILY'});
  await seed.close();
  const original = mode === 'original' ? new HubStore(file, 'fixture') : undefined;
  const metadata = original ?? new HubStore(join(root, 'composition.sqlite'), 'fixture');
  const logs: string[] = [], diagnostics = new PerformanceDiagnostics(line => logs.push(line));
  const owner = original ? new OriginalHubAdministrativeCommands(original, diagnostics) : new AsyncHubMemberOwner({file, encryptionSecret: 'fixture'}, diagnostics);
  const group = createHubAdministrativeServices(owner, diagnostics), resolver = createAsyncConnectorClientResolver(owner, undefined, diagnostics);
  const behavior: {calls: Request[]; transport?: (request: Request) => Promise<void>; resolve?: () => Promise<void>;
    response?: (request: Request, headers: Record<string, string>) => Response} = {calls: []};
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init), url = new URL(request.url);
    assert.ok(['connector.invalid', 'probe.invalid'].includes(url.hostname)); behavior.calls.push(request);
    assert.equal(request.headers.get('authorization'), url.hostname === 'connector.invalid' ? 'Bearer PRIVATE_DAILY' : 'Bearer PRIVATE_PROBE');
    await behavior.transport?.(request);
    const headers = {[CONNECTOR_PROTOCOL_HEADER]: String(CONNECTOR_PROTOCOL.max), [NODE_ID_HEADER]: nodeId};
    return behavior.response?.(request, headers) ?? Response.json(url.pathname.endsWith('/identity') ? {nodeId, protocol: 1} : {ok: true}, {headers});
  });
  let guarded = false;
  const store = new Proxy(metadata, {get(target, property, receiver) {if (guarded) throw Error('SYNC_VERIFICATION_STORE'); return Reflect.get(target, property, receiver);}});
  const config = loadConfig({HOME: root, AOD_SERVER_ROLE: 'hub'}); config.hub.defaultConnectionId = 'node';
  const app = new Hono(), routes = registerHubRoutes(app, {config, hubStore: store, administrative: group,
    principal: () => {throw Error('SYNC_VERIFICATION_PRINCIPAL');}, connectorClient: () => {throw Error('SYNC_VERIFICATION_RESOLVER');},
    ...(!noResolver ? {asyncConnectorClient: async (...args: Parameters<typeof resolver>) => {await behavior.resolve?.(); return resolver(...args);}} : {}), normalizeError: () => 'safe'});
  assert.ok(routes); guarded = true;
  const request = (path: string, body?: unknown, headers: Record<string, string> = {'x-agentopsdeck-key': key.token}) =>
    new Request('http://hub.invalid/api/hub/v1/connections/' + path, {method: 'POST', headers, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
  const proof = async () => {const evidence = {accessKey: key.token}, actor = await owner.command('memberSnapshot', evidence); assert.ok(actor); return {evidence, expectedScope: actor.recoveryScope};};
  const target = async () => {const value = await owner.command('connectionTarget', {...await proof(), id: 'node'}); assert.ok(value && 'connection' in value); return value;};
  const change = async () => {const current = await target(); return owner.command('connectionChange', {...await proof(), change: {action: 'maintenance', id: 'node', expectedEpoch: current.epoch, token: 'PRIVATE_CHANGED'}});};
  t.after(async () => {
    guarded = false;
    try {await routes.close();} finally {try {await group.close();} finally {try {await resolver.close();} finally {try {await owner.close();} finally {await metadata.close();}}}}
    for (const secret of [key.token, cookie, 'PRIVATE_DAILY', 'PRIVATE_PROBE', 'PRIVATE_CHANGED']) assert.equal(logs.join('').includes(secret), false);
    rmSync(root, {recursive: true, force: true});
  });
  return {app, request, behavior, key, foreign, cookie, nodeId, proof, target, change, close: routes.close};
}

for (const mode of ['original', 'worker'] as const) {
  test(`${mode}: production verify commits first pin and delivers its new epoch, repeated same-node pin stays idempotent`, async t => {
    const f = await fixture(t, mode), before = await f.target(); assert.equal(before.connection.nodeId, undefined);
    for (const headers of [{'x-agentopsdeck-key': f.key.token}, {cookie: 'agentopsdeck_session=' + f.cookie}]) {
      const result = await f.app.fetch(f.request('node/verify', undefined, headers)); assert.equal(result.status, 200);
      assert.equal((await result.json()).connection.nodeId, f.nodeId);
      const current = await f.target(); assert.equal(current.epoch, before.epoch + 1); assert.equal(current.connection.nodeId, f.nodeId);
    }
    assert.equal(f.behavior.calls.length, 2);
  });
  test(`${mode}: verify refuses foreign owner, recovery header and original private scope before remote dispatch`, async t => {
    const f = await fixture(t, mode);
    assert.equal((await f.app.fetch(f.request('node/verify', undefined, {'x-agentopsdeck-key': f.foreign.token}))).status, 404);
    assert.equal((await f.app.fetch(f.request('node/verify', undefined, {'x-agentopsdeck-key': f.key.token, 'x-agentopsdeck-recovery-scope': 'wrong'}))).status, 409);
    const request = f.request('node/verify'); pinOriginalRequestScope(request, 'b'.repeat(64));
    assert.equal((await f.app.fetch(request)).status, 401); assert.equal(f.behavior.calls.length, 0);
  });
  test(`${mode}: resolver-time and post-identity credential changes prevent pin`, async t => {
    const f = await fixture(t, mode); f.behavior.resolve = async () => {await f.change();};
    assert.notEqual((await f.app.fetch(f.request('node/verify'))).status, 200); assert.equal(f.behavior.calls.length, 0);
    delete f.behavior.resolve; f.behavior.transport = async () => {await f.change();};
    assert.notEqual((await f.app.fetch(f.request('node/verify'))).status, 200);
    assert.equal((await f.target()).connection.nodeId, undefined);
  });
  test(`${mode}: malformed identity and mismatched protocol never commit a pin`, async t => {
    const f = await fixture(t, mode);
    for (const body of [{nodeId: 'invalid', protocol: 1}, {nodeId: f.nodeId, protocol: 99}]) {
      f.behavior.response = (_request, headers) => Response.json(body, {headers});
      assert.notEqual((await f.app.fetch(f.request('node/verify'))).status, 200);
      assert.equal((await f.target()).connection.nodeId, undefined);
    }
  });
  test(`${mode}: local probe returns original scoped projection via async capabilities and denies missing resolver`, async t => {
    const f = await fixture(t, mode), response = await f.app.fetch(f.request('test', {}));
    assert.equal(response.status, 200);
    const body = await response.json(); assert.equal(body.ok, true); assert.equal(body.connection.id, 'node'); assert.equal(body.connection.ownerUserLabel, 'Owner');
    assert.equal(f.behavior.calls.length, 1); assert.ok(f.behavior.calls[0]!.url.endsWith('/capabilities'));
    f.behavior.transport = async () => {await f.change();};
    assert.notEqual((await f.app.fetch(f.request('test', {}))).status, 200);
  });
  test(`${mode}: production missing async resolver cannot fall back to sync verify or local probe`, async t => {
    const f = await fixture(t, mode, true);
    for (const path of ['node/verify', 'test']) assert.equal((await f.app.fetch(f.request(path, {}))).status, 503);
    assert.equal(f.behavior.calls.length, 0);
  });
  test(`${mode}: unsaved probe uses only supplied URL/token, validates schema and preserves successful DTO`, async t => {
    const f = await fixture(t, mode), response = await f.app.fetch(f.request('test', {connectorUrl: 'http://probe.invalid/', token: 'PRIVATE_PROBE'}));
    assert.equal(response.status, 200); const body = await response.json(); assert.equal(body.ok, true); assert.equal(body.connectorUrl, 'http://probe.invalid');
    assert.deepEqual(body.connector, {ok: true}); assert.deepEqual(body.health, {ok: true});
    assert.deepEqual(f.behavior.calls.map(value => new URL(value.url).pathname).sort(), ['/api/connector/v1/health', '/api/connector/v1/info']);
    for (const raw of [{connectorUrl: 3}, {token: {}}, {connectorUrl: 'bad'}, {authorized: true}])
      assert.equal((await f.app.fetch(f.request('test', raw))).status, 400);
    assert.equal(f.behavior.calls.length, 2); assert.equal((await f.target()).connection.nodeId, undefined);
  });
  test(`${mode}: failed first probe retains sibling original transport until close fully drains`, async t => {
    const f = await fixture(t, mode), gate = deferred(), entered = deferred();
    f.behavior.transport = async request => {if (request.url.endsWith('/info')) throw Error('safe failure'); entered.resolve(); await gate.promise;};
    const pending = f.app.fetch(f.request('test', {connectorUrl: 'http://probe.invalid', token: 'PRIVATE_PROBE'}));
    await entered.promise; await tick(); let closed = false; const closing = f.close().then(() => {closed = true;});
    await tick(); assert.equal(closed, false); gate.resolve();
    assert.equal((await pending).status, 503); await closing; assert.equal(closed, true); assert.equal(f.behavior.calls.length, 2);
  });
  test(`${mode}: failed probe returns legacy failure DTO without borrowing a saved target`, async t => {
    const f = await fixture(t, mode); f.behavior.transport = async () => {throw Error('safe transport failure');};
    const response = await f.app.fetch(f.request('test', {connectorUrl: 'http://probe.invalid', token: 'PRIVATE_PROBE'}));
    assert.equal(response.status, 200); assert.equal((await response.json()).ok, false); assert.equal(f.behavior.calls.length, 2);
  });
  test(`${mode}: probe authenticates before streamed bytes and enforces real UTF8 body limit`, async t => {
    const f = await fixture(t, mode); let pulled = 0;
    const unauthorized = new Request('http://hub.invalid/api/hub/v1/connections/test', {method: 'POST', duplex: 'half',
      body: new ReadableStream({pull() {pulled++;}}, {highWaterMark: 0})} as RequestInit);
    assert.equal((await f.app.fetch(unauthorized)).status, 401); assert.equal(pulled, 0);
    const source = new ReadableStream({start(controller) {controller.enqueue(new TextEncoder().encode(JSON.stringify({token: '中'.repeat(20_000)}))); controller.close();}});
    const oversized = new Request('http://hub.invalid/api/hub/v1/connections/test', {method: 'POST', headers: {'x-agentopsdeck-key': f.key.token, 'content-length': '1'}, body: source, duplex: 'half'} as RequestInit);
    assert.equal((await f.app.fetch(oversized)).status, 413); assert.equal(f.behavior.calls.length, 0);
  });
  test(`${mode}: stalled upload close retains original cancel ACK without probing`, async t => {
    const f = await fixture(t, mode), gate = deferred(), entered = deferred(); let cancelled = false;
    const source = new ReadableStream({pull() {entered.resolve();}, async cancel() {await gate.promise; cancelled = true;}}, {highWaterMark: 0});
    const request = new Request('http://hub.invalid/api/hub/v1/connections/test', {method: 'POST', headers: {'x-agentopsdeck-key': f.key.token}, body: source, duplex: 'half'} as RequestInit);
    const pending = f.app.fetch(request); await entered.promise; let closed = false; const closing = f.close().then(() => {closed = true;});
    await tick(); assert.equal(closed, false); assert.equal(cancelled, false); gate.resolve();
    assert.equal((await pending).status, 503); await closing; assert.equal(cancelled, true); assert.equal(f.behavior.calls.length, 0);
  });
}
