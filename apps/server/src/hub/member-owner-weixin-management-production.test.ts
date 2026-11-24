import assert from 'node:assert/strict';
import test, {type TestContext} from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Hono} from 'hono';
import {HubStore} from './hub-store.js';
import {AsyncHubMemberOwner} from './async-member-owner.js';
import {OriginalHubAdministrativeCommands} from './original-administrative-commands.js';
import {createHubAdministrativeServices} from './administrative-route-services.js';
import {PerformanceDiagnostics} from '../diagnostics/performance.js';
import {registerHubRoutes} from '../routes/hub.js';
import {registerHubWeixin} from '../routes/hub-weixin.js';
import {WeixinService} from './weixin-service.js';
import {weixinBridge} from './weixin-bridge.js';
import {loadConfig} from '../config.js';
import {validHubMemberInput, validHubMemberOutput} from './member-owner-domain.js';
import {matchesWeixinBindingEffectReply} from './member-weixin-domain.js';
import {WEIXIN_ORIGIN, type WeixinQrStatus, type WeixinTransport} from './weixin-transport.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => {resolve = r;});
  return {promise, resolve};
}
const account = {botId: 'synthetic-bot', peerId: 'synthetic-peer', token: 'PRIVATE_PROVIDER_TOKEN', baseUrl: WEIXIN_ORIGIN};

async function fixture(t: TestContext, mode: 'original' | 'worker', auditFailure = false, assembly: 'full' | 'no-store' = 'full') {
  const root = mkdtempSync(join(tmpdir(), 'weixin-management-')), file = join(root, 'hub.sqlite');
  const seed = new HubStore(file, 'fixture'), user = seed.createUser('Weixin owner');
  const administrator = seed.createUser('Administrator');
  seed.roles.setHubRole({userId: 'default', admin: true}, administrator.id, 'admin', 0);
  const admin = seed.identities.issueKey(administrator.id), key = seed.identities.issueKey(user.id);
  const cookie = seed.identities.createSession(key.token)!, foreign = seed.identities.issueKey(seed.createUser('Foreign').id);
  if (auditFailure) (seed as unknown as {db: DatabaseSync}).db.exec(`CREATE TRIGGER fail_weixin_audit BEFORE INSERT ON hub_auth_audit
    WHEN json_extract(new.record, '$.reason')='weixin_qr_created' BEGIN SELECT RAISE(ABORT, 'private audit failure'); END`);
  await seed.close();
  const original = mode === 'original' ? new HubStore(file, 'fixture') : undefined;
  const logs: string[] = [], diagnostics = new PerformanceDiagnostics(line => logs.push(line));
  const owner = original ? new OriginalHubAdministrativeCommands(original, diagnostics) : new AsyncHubMemberOwner({file, encryptionSecret: 'fixture'}, diagnostics);
  const group = createHubAdministrativeServices(owner, diagnostics);
  // Composition metadata is NOT the real database owner, in either mode.
  // Poison the captured WeixinStore too: a getter returning a sync store at
  // registration must not evade the production HTTP-chain regression check.
  const metadata = new HubStore(join(root, 'metadata.sqlite'), 'fixture');
  let guarded = false, bypasses = 0;
  const poisonedWeixin = new Proxy(metadata.weixin, {get(target, property, receiver) {
    if (guarded) {bypasses++; throw Error('SYNC_WEIXIN_STORE');}
    return Reflect.get(target, property, receiver);
  }});
  const store = new Proxy(metadata, {get(target, property, receiver) {
    if (guarded) {bypasses++; throw Error('SYNC_HUB_STORE');}
    return property === 'weixin' ? poisonedWeixin : Reflect.get(target, property, receiver);
  }});
  const behavior: {qr: number; polls: number; qrWait?: (signal: AbortSignal) => Promise<void>;
    pollWait?: (signal: AbortSignal) => Promise<void>; result: WeixinQrStatus} = {qr: 0, polls: 0, result: {state: 'wait'}};
  const transport: WeixinTransport = {
    qr: async signal => {behavior.qr++; await behavior.qrWait?.(signal); return {code: 'PRIVATE_QR_CODE', url: 'https://weixin.qq.com/synthetic-qr'};},
    pollQr: async (code, origin, verify, signal) => {
      assert.equal(code, 'PRIVATE_QR_CODE'); assert.equal(origin, WEIXIN_ORIGIN);
      assert.ok(verify === undefined || /^\d{4,8}$/.test(verify));
      behavior.polls++; await behavior.pollWait?.(signal); return behavior.result;
    },
    receive: async () => {throw Error('UNEXPECTED_BACKGROUND_PROVIDER');},
    send: async () => {throw Error('UNEXPECTED_BACKGROUND_PROVIDER');},
  };
  const app = new Hono();
  const background = assembly === 'no-store' ? group.createWeixinBackgroundAccess() : undefined;
  const routes = background ? registerHubWeixin(app, {
    service: new WeixinService({mode: 'async', transport, background,
      bridge: weixinBridge(app, {mode: 'async', access: background, internal: new WeakMap()})}),
    access: group.createWeixinAccess(), transport,
  }) : registerHubRoutes(app, {
    config: loadConfig({HOME: root, AOD_SERVER_ROLE: 'hub'}), hubStore: store, administrative: group, weixinTransport: transport,
    principal: () => {bypasses++; throw Error('SYNC_WEIXIN_PRINCIPAL');},
    connectorClient: () => {throw Error('UNEXPECTED_CONNECTOR');}, normalizeError: () => 'safe',
  });
  assert.ok(routes); guarded = true;
  const request = (suffix = '', method = 'GET', body?: unknown, headers: Record<string, string> = {'x-agentopsdeck-key': key.token}, signal?: AbortSignal) =>
    new Request('http://hub.invalid/api/hub/v1/weixin' + suffix, {method, headers,
      ...(body === undefined ? {} : {body: JSON.stringify(body)}), ...(signal ? {signal} : {})});
  const proof = async (token = key.token) => {
    const evidence = {accessKey: token}, snapshot = await owner.command('memberSnapshot', evidence); assert.ok(snapshot);
    return {evidence, expectedScope: snapshot.recoveryScope};
  };
  const revoke = async () => owner.command('memberKeyRevoke', {...await proof(admin.token), userId: user.id, keyId: key.id});
  t.after(async () => {
    // Restore only the metadata test guard before legacy background teardown.
    guarded = false;
    try {await routes.close();} finally {try {await group.close();} finally {try {await owner.close();} finally {await original?.close(); await metadata.close();}}}
    for (const secret of [key.token, cookie, account.token, 'PRIVATE_QR_CODE', 'private audit failure']) assert.equal(logs.join('').includes(secret), false);
    rmSync(root, {recursive: true, force: true});
  });
  return {app, request, behavior, owner, proof, revoke, key, cookie, foreign, close: routes.close, bypasses: () => bypasses};
}

for (const mode of ['original', 'worker'] as const) {
  test(`${mode}: no-store assembly registers all management entries without synchronous identity, audit or store dependencies`, async t => {
    const f = await fixture(t, mode, false, 'no-store'), id = randomUUID();
    assert.equal((await f.app.fetch(f.request())).status, 200);
    assert.equal((await f.app.fetch(f.request('/bindings', 'POST', {id}))).status, 200);
    f.behavior.result = {state: 'confirmed', account};
    assert.equal((await f.app.fetch(f.request(`/bindings/${id}/poll`, 'POST', {}, {cookie: 'agentopsdeck_session=' + f.cookie}))).status, 200);
    assert.deepEqual(await (await f.app.fetch(f.request(`/bindings/${id}`, 'DELETE'))).json(), {removed: true});
    await f.close();
    const closed = await f.app.fetch(f.request());
    assert.equal(closed.status, 429);
    assert.deepEqual(await closed.json(), {error: 'weixin_busy'});
    assert.equal(f.behavior.qr, 1); assert.equal(f.behavior.polls, 1); assert.equal(f.bypasses(), 0);
  });
  test(`${mode}: four production Weixin management entries preserve public wire and never use sync HTTP stores`, async t => {
    const f = await fixture(t, mode), id = randomUUID();
    let response = await f.app.fetch(f.request());
    assert.deepEqual(await response.json(), {available: true, personalKey: true, administratorKey: false, binding: null});
    response = await f.app.fetch(f.request('/bindings', 'POST', {id})); assert.equal(response.status, 200);
    const qr = await response.json(); assert.equal(qr.binding.state, 'qr'); assert.equal(qr.binding.id, id);
    assert.equal(JSON.stringify(qr).includes('PRIVATE_'), false);
    response = await f.app.fetch(f.request('/bindings', 'POST', {id})); assert.equal(response.status, 200); assert.equal(f.behavior.qr, 1);
    f.behavior.result = {state: 'confirmed', account};
    response = await f.app.fetch(f.request(`/bindings/${id}/poll`, 'POST', {verify: '1234'}, {cookie: 'agentopsdeck_session=' + f.cookie}));
    assert.equal(response.status, 200);
    const bound = await response.json(); assert.equal(bound.state, 'confirmed'); assert.equal(bound.status.binding.state, 'bound');
    assert.equal(JSON.stringify(bound).includes(account.token), false);
    response = await f.app.fetch(f.request(`/bindings/${id}/poll`, 'POST', {})); assert.equal(response.status, 200); assert.equal(f.behavior.polls, 1);
    assert.equal((await f.app.fetch(f.request('', 'GET', undefined, {'x-agentopsdeck-key': f.foreign.token}))).status, 200);
    response = await f.app.fetch(f.request(`/bindings/${id}`, 'DELETE')); assert.deepEqual(await response.json(), {removed: true});
    assert.equal((await (await f.app.fetch(f.request())).json()).binding, null);
    assert.equal(f.bypasses(), 0);
  });
  test(`${mode}: exact scope, key and body fences precede provider admission`, async t => {
    const f = await fixture(t, mode), id = randomUUID();
    assert.equal((await f.app.fetch(f.request('/bindings', 'POST', {id}, {'x-agentopsdeck-key': 'bad'}))).status, 401);
    assert.equal((await f.app.fetch(f.request('/bindings', 'POST', {id}, {'x-agentopsdeck-key': f.key.token, 'x-agentopsdeck-recovery-scope': 'wrong'}))).status, 409);
    for (const body of [{id: 'invalid'}, {id, authorized: true}, {id, payload: 'x'.repeat(2048)}]) {
      const response = await f.app.fetch(f.request('/bindings', 'POST', body)); assert.ok([400, 413].includes(response.status));
    }
    assert.equal((await f.app.fetch(f.request('/bindings', 'POST', {id}))).status, 200);
    assert.equal((await f.app.fetch(f.request(`/bindings/${id}/poll`, 'POST', {verify: 'invalid'}))).status, 400);
    assert.equal((await f.app.fetch(f.request(`/bindings/${id}/poll`, 'POST', {account}))).status, 400);
    assert.equal(f.behavior.qr, 1); assert.equal(f.behavior.polls, 0); assert.equal(f.bypasses(), 0);
  });
  test(`${mode}: revoked original identity cannot install a late QR or deliver stale status`, async t => {
    const f = await fixture(t, mode), entered = deferred(), release = deferred(), id = randomUUID();
    f.behavior.qrWait = async () => {entered.resolve(); await release.promise;};
    const result = f.app.fetch(f.request('/bindings', 'POST', {id})); await entered.promise;
    assert.deepEqual(await f.revoke(), {ok: true}); release.resolve();
    assert.notEqual((await result).status, 200); assert.equal(f.behavior.qr, 1); assert.equal(f.bypasses(), 0);
  });
  test(`${mode}: unlink cancels original provider; late response cannot resurrect binding or release drain early`, async t => {
    const f = await fixture(t, mode), entered = deferred(), release = deferred(), id = randomUUID();
    let signal: AbortSignal | undefined;
    f.behavior.qrWait = async original => {signal = original; entered.resolve(); await release.promise;};
    const result = f.app.fetch(f.request('/bindings', 'POST', {id})); await entered.promise;
    assert.equal((await f.app.fetch(f.request(`/bindings/${id}`, 'DELETE'))).status, 200); assert.equal(signal?.aborted, true);
    let completed = false; const closing = f.close().then(() => {completed = true;});
    await tick(); assert.equal(completed, false); release.resolve();
    assert.notEqual((await result).status, 200); await closing; assert.equal(f.behavior.qr, 1);
    const status = await f.owner.command('weixin', {...await f.proof(), command: {action: 'status'}});
    assert.ok(status && !('error' in status) && status.action === 'status'); assert.equal(status.status.binding, null);
  });
  test(`${mode}: request abort retains ignored provider original; repeated binding never dispatches QR twice`, async t => {
    const f = await fixture(t, mode), entered = deferred(), release = deferred(), abort = new AbortController(), id = randomUUID();
    f.behavior.qrWait = async () => {entered.resolve(); await release.promise;};
    const result = f.app.fetch(f.request('/bindings', 'POST', {id}, undefined, abort.signal)); await entered.promise; abort.abort();
    assert.equal((await f.app.fetch(f.request('/bindings', 'POST', {id}))).status, 200);
    let completed = false; const closing = f.close().then(() => {completed = true;}); await tick(); assert.equal(completed, false);
    release.resolve(); assert.notEqual((await result).status, 200); await closing; assert.equal(f.behavior.qr, 1);
  });
  test(`${mode}: QR audit failure rolls back vault, phase and reference observation without provider replay`, async t => {
    const f = await fixture(t, mode, true), id = randomUUID();
    assert.equal((await f.app.fetch(f.request('/bindings', 'POST', {id}))).status, 503);
    const response = await f.app.fetch(f.request()); assert.equal(response.status, 200);
    const value = await response.json(); assert.equal(value.binding.state, 'creating'); assert.equal(value.binding.qrUrl, undefined);
    assert.equal((await f.app.fetch(f.request('/bindings', 'POST', {id}))).status, 200); assert.equal(f.behavior.qr, 1);
    // The reference was released after the failed original ACK, not left busy.
    assert.equal((await f.app.fetch(f.request(`/bindings/${id}`, 'DELETE'))).status, 200);
    assert.equal((await f.app.fetch(f.request('/bindings', 'POST', {id: randomUUID()}))).status, 503); assert.equal(f.behavior.qr, 2);
    assert.equal(f.bypasses(), 0);
  });
  test(`${mode}: private provider lane cannot be called through member command or forged internal identity`, async t => {
    const f = await fixture(t, mode), proof = await f.proof(), id = randomUUID();
    await assert.rejects(f.owner.command('weixinBindingEffect', {action: 'access', reference: id}));
    assert.equal(validHubMemberInput('weixin', {...proof, evidence: {weixinBinding: {id, user: 'default', keyId: id}}, command: {action: 'status'}}), false);
    const admitted = await f.owner.command('weixin', {...proof, command: {action: 'start', id}});
    assert.ok(admitted && 'work' in admitted && admitted.work);
    const privateLane = f.owner.weixinBindingEffect();
    assert.equal('error' in await privateLane.command({action: 'access', reference: randomUUID()}), true);
    assert.deepEqual(await privateLane.command({action: 'access', reference: admitted.work}), {action: 'access', reference: admitted.work, effect: {kind: 'qr'}});
    await assert.rejects(privateLane.command({action: 'observe', reference: admitted.work, observation: {kind: 'qr', code: 'secret', url: 'http://unsafe.invalid'}}));
    assert.deepEqual(await f.revoke(), {ok: true});
    assert.deepEqual(await privateLane.command({action: 'access', reference: admitted.work}), {error: 'denied'});
    await privateLane.command({action: 'release', reference: admitted.work});
  });
}

test('Weixin fixed result validators reject extra credentials and mismatched original observations', () => {
  const id = randomUUID();
  assert.equal(validHubMemberOutput('weixin', {action: 'status', status: {available: true, personalKey: true, administratorKey: false, binding: null}, account}), false);
  assert.equal(validHubMemberInput('weixinBindingEffect', {action: 'observe', reference: id, observation: {kind: 'poll', result: {state: 'confirmed'}}}), false);
  assert.equal(validHubMemberInput('weixinBindingEffect', {action: 'observe', reference: id, observation: {kind: 'poll', result: {state: 'redirect', baseUrl: 'https://attacker.invalid'}}}), false);
  assert.equal(matchesWeixinBindingEffectReply({action: 'observe', reference: id, observation: {kind: 'poll', result: {state: 'wait'}}}, {action: 'observe', reference: id, state: 'confirmed'}), false);
});
