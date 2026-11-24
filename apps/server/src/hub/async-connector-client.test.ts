import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONNECTOR_PROTOCOL, CONNECTOR_PROTOCOL_HEADER } from '@agentopsdeck/shared';
import { HubStore } from './hub-store.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { createAsyncConnectorClientResolver } from './async-connector-client.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { validHubMemberInput, validHubMemberOutput, hubMemberFailureSteps } from './member-owner-domain.js';
import type { HubConnectorAccessCommand } from './member-connector-access-domain.js';
import { authorizeContentReplicaRequest } from './connector-client.js';
import { pinOriginalRequestScope } from './original-request-scope.js';

const silence = new PerformanceDiagnostics(() => {});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const request = (key: string, signal?: AbortSignal) => new Request('http://hub/', {
  headers: { authorization: `Bearer ${key}` }, ...(signal ? { signal } : {}),
});
async function fixture(work: (f: Awaited<ReturnType<typeof seed>> & { worker: AsyncHubMemberOwner }) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'hub-async-connector-'));
  let worker: AsyncHubMemberOwner | undefined;
  try {
    const data = await seed(join(root, 'hub.sqlite'));
    worker = new AsyncHubMemberOwner({ file: join(root, 'hub.sqlite'), encryptionSecret: 'synthetic-fixture' }, silence);
    await worker.open(); await work({ ...data, worker });
  } finally { if (worker) await worker.close(); rmSync(root, { recursive: true, force: true }); }
}
async function seed(file: string) {
  const store = new HubStore(file, 'synthetic-fixture');
  try {
    const key = store.identities.issueKey('default');
    const admin = store.createUser('Administrator');
    store.roles.setHubRole({ userId: 'default', admin: true }, admin.id, 'admin', 0);
    const adminKey = store.identities.issueKey(admin.id);
    const recipient = store.createUser('Recipient'), recipientKey = store.identities.issueKey(recipient.id);
    store.upsertConnection({ id: 'local', kind: 'local', label: 'Local', connectorUrl: 'local://aod-connector' });
    store.upsertConnection({ id: 'remote', label: 'Remote', connectorUrl: 'http://fixture.invalid', credentialToken: 'synthetic-daily' });
    store.updateMaintenanceCredential('remote', 'synthetic-maintenance');
    const target = { ownerUserId: 'default', connectionId: 'remote', userId: recipient.id };
    const resource = { runtime: 'codex' as const, sessionKey: 'codex:fixture' };
    store.grants.create(target, { ...resource, actions: ['messages:read'] });
    const grant = store.grants.authorize(target, 'messages:read', resource)!;
    assert.ok(grant);
    return { key, adminKey, recipientKey, recipient, grant, file };
  } finally { await store.close(); }
}
async function proof(worker: AsyncHubMemberOwner, key: string) {
  const evidence = { accessKey: key }, snapshot = await worker.command('memberSnapshot', evidence);
  assert.ok(snapshot); return { evidence, expectedScope: snapshot.recoveryScope };
}

test('Connector resolver retains original private scope across independent authorization and refuses replacement before transport', () => fixture(async ({ worker, key }) => {
  let calls = 0;
  const resolve = createAsyncConnectorClientResolver(worker, { connectionId: 'local', token: 'synthetic-local',
    dispatch: () => { calls++; return Response.json({ ok: true }); } }, silence);
  try {
    const stale = request(key.token); pinOriginalRequestScope(stale, '0'.repeat(64));
    await assert.rejects(resolve(stale, 'local'), { status: 401 }); assert.equal(calls, 0);
    const current = request(key.token); pinOriginalRequestScope(current, (await proof(worker, key.token)).expectedScope);
    const client = await resolve(current, 'local'); assert.deepEqual(await client.json('/health'), { ok: true }); assert.equal(calls, 1);
  } finally { await resolve.close(); }
}));

test('real complete owner serves local JSON and preserves a saved login cookie through reopen', () => fixture(async ({ worker, key, file }) => {
  const cookie = await worker.command('memberSessionCreate', { key: key.token }); assert.ok(cookie);
  let calls = 0;
  const resolve = createAsyncConnectorClientResolver(worker, { connectionId: 'local', token: 'synthetic-local',
    dispatch: () => { calls++; return Response.json({ ok: true }); } }, silence);
  const client = await resolve(new Request('http://hub/', { headers: { cookie: `agentopsdeck_session=${cookie.token}` } }), 'local');
  assert.deepEqual(await client.json('/health'), { ok: true }); assert.equal(calls, 1);
  await worker.close();
  await assert.rejects(client.json('/health'), { status: 503 });
  const reopened = new AsyncHubMemberOwner({ file, encryptionSecret: 'synthetic-fixture' }, silence);
  try {
    await reopened.open();
    const nextResolve = createAsyncConnectorClientResolver(reopened, { connectionId: 'local', token: 'synthetic-local',
      dispatch: () => { calls++; return Response.json({ ok: true }); } }, silence);
    const next = await nextResolve(new Request('http://hub/', { headers: { cookie: `agentopsdeck_session=${cookie.token}` } }), 'local');
    assert.deepEqual(await next.json('/health'), { ok: true }); assert.equal(calls, 2);
  } finally { await reopened.close(); }
}));

test('HTTP identity expectation cannot select another account or be replaced during the initial snapshot wait', () => fixture(async ({ worker, key }) => {
  let calls = 0;
  const resolve = createAsyncConnectorClientResolver(worker, { connectionId: 'local', token: 'synthetic-local',
    dispatch: () => { calls++; return Response.json({ ok: true }); } }, silence);
  const options = { expectedUserId: 'other-account' };
  const refused = resolve(request(key.token), 'local', options);
  options.expectedUserId = 'default';
  await assert.rejects(refused, { status: 403 }); assert.equal(calls, 0);
  for (const expectedUserId of ['', 'a\0b', 'x'.repeat(16_385)])
    await assert.rejects(resolve(request(key.token), 'local', { expectedUserId }), { status: 400 });
  const valid = await resolve(request(key.token), 'local', { expectedUserId: 'default' });
  assert.deepEqual(await valid.json('/health'), { ok: true }); assert.equal(calls, 1);
}));

for (const action of ['disable', 'delete'] as const) {
  test(`worker ${action} denies an in-flight pinned client without exposing initial visibility`, () => fixture(async ({ worker, key }) => {
    let calls = 0;
    const resolve = createAsyncConnectorClientResolver(worker, { connectionId: 'local', token: 'synthetic-local',
      dispatch: () => { calls++; return Response.json({ ok: true }); } }, silence);
    const id = action === 'delete' ? 'remote' : 'local';
    const stale = await resolve(request(key.token), id), p = await proof(worker, key.token);
    const target = await worker.command('connectionTarget', { ...p, id }); assert.ok(target && 'connection' in target);
    const changed = await worker.command('connectionChange', { ...p, change: action === 'delete'
      ? { action: 'delete', id, expectedEpoch: target.epoch }
      : { action: 'patch', id, expectedEpoch: target.epoch, configuration: { enabled: false } } });
    assert.ok(changed && (action === 'delete' ? 'ok' in changed && changed.ok : 'connection' in changed));
    await assert.rejects(stale.json('/health'), { status: 403 });
    await assert.rejects(resolve(request(key.token), id), { status: 404 });
    assert.equal(calls, 0);
  }));
}

for (const action of ['disable-enable','maintenance','delete-create'] as const) {
  test(`worker epoch ${action} retires cached clients before dispatch`, () => fixture(async ({ worker, key }) => {
    let calls = 0;
    const id = action === 'delete-create' ? 'remote' : 'local';
    const resolve = createAsyncConnectorClientResolver(worker, { connectionId: 'local', token: 'synthetic-local',
      dispatch: () => { calls++; return Response.json({ ok: true }); } }, silence);
    const stale = await resolve(request(key.token), id), p = await proof(worker, key.token);
    const target = await worker.command('connectionTarget', { ...p, id }); assert.ok(target && 'connection' in target);
    if (action === 'maintenance') {
      await worker.command('connectionChange', { ...p, change: { action: 'maintenance', id: 'local', expectedEpoch: target.epoch, token: 'synthetic-new' } });
    } else if (action === 'delete-create') {
      const deleted = await worker.command('connectionChange', { ...p, change: { action: 'delete', id, expectedEpoch: target.epoch } });
      assert.ok(deleted && 'ok' in deleted && deleted.ok);
      const created = await worker.command('connectionChange', { ...p, change: { action: 'create', configuration: { id, connectorUrl: 'http://fixture.invalid', token: 'synthetic-new' } } });
      assert.ok(created && 'connection' in created && created.connection.id === id);
    } else {
      const disabled = await worker.command('connectionChange', { ...p, change: { action: 'patch', id: 'local', expectedEpoch: target.epoch, configuration: { enabled: false } } });
      assert.ok(disabled && 'connection' in disabled);
      await worker.command('connectionChange', { ...p, change: { action: 'patch', id: 'local', expectedEpoch: disabled.epoch, configuration: { enabled: true } } });
    }
    await assert.rejects(stale.json('/health'), { status: 403 }); assert.equal(calls, 0);
  }));
}

test('real remote token rotation changes the transport partition and never reuses old credentials', () => fixture(async ({ worker, key }) => {
  const resolve = createAsyncConnectorClientResolver(worker, undefined, silence);
  const stale = await resolve(request(key.token), 'remote'), p = await proof(worker, key.token);
  const target = await worker.command('connectionTarget', { ...p, id: 'remote' }); assert.ok(target && 'connection' in target);
  const deleted = await worker.command('connectionChange', { ...p, change: { action: 'delete', id: 'remote', expectedEpoch: target.epoch } });
  assert.ok(deleted && 'ok' in deleted && deleted.ok);
  const created = await worker.command('connectionChange', { ...p, change: { action: 'create', configuration: { id: 'remote', connectorUrl: 'http://fixture.invalid', token: 'synthetic-rotated' } } });
  assert.ok(created && 'connection' in created && created.connection.id === 'remote');
  const fresh = await resolve(request(key.token), 'remote'); assert.notEqual(fresh.eventDomain, stale.eventDomain);
  await assert.rejects(stale.json('/health'), { status: 403 });
}));

test('worker credential read separates remote daily/maintenance, local tokens and non-owners', () => fixture(async ({ worker, key, recipientKey }) => {
  const p = await proof(worker, key.token);
  for (const maintenance of [false,true]) {
    const value = await worker.command('connectorAccess', { ...p, command: { action: 'open', id: 'remote', maintenance } });
    assert.ok(value && 'token' in value); assert.equal(value.token, maintenance ? 'synthetic-maintenance' : 'synthetic-daily');
  }
  const local = await worker.command('connectorAccess', { ...p, command: { action: 'open', id: 'local', maintenance: false } });
  assert.ok(local && 'token' in local); assert.equal(local.token, null);
  const resolve = createAsyncConnectorClientResolver(worker, undefined, silence);
  await assert.rejects(resolve(request(key.token), 'local'), { status: 503 });
  await assert.rejects(resolve(request(recipientKey.token), 'remote'), { status: 404 });
  await assert.rejects(resolve(request('shared-administrator'), 'remote'), { status: 401 });
}));

test('revoking an original key prevents cached JSON dispatch and saved-cookie resolution', () => fixture(async ({ worker, key, adminKey }) => {
  let calls = 0;
  const resolve = createAsyncConnectorClientResolver(worker, { connectionId: 'local', token: 'synthetic', dispatch: () => { calls++; return Response.json({ ok: true }); } }, silence);
  const cookie = await worker.command('memberSessionCreate', { key: key.token }); assert.ok(cookie);
  const client = await resolve(request(key.token), 'local'), p = await proof(worker, adminKey.token);
  assert.deepEqual(await worker.command('memberKeyRevoke', { ...p, userId: 'default', keyId: key.id }), { ok: true });
  await assert.rejects(client.json('/health'), { status: 401 }); assert.equal(calls, 0);
  await assert.rejects(resolve(new Request('http://hub/', { headers: { cookie: `agentopsdeck_session=${cookie.token}` } }), 'local'), { status: 401 });
}));

test('original grant revalidation restricts exact session reads and rejects maintenance/admin forgery', () => fixture(async ({ worker, key, recipientKey, grant }) => {
  const resolve = createAsyncConnectorClientResolver(worker, undefined, silence);
  const client = await resolve(request(recipientKey.token), 'remote', { grant });
  await assert.rejects(client.json('/sessions/codex%3Aother/messages'), { status: 403 });
  await assert.rejects(client.json('/sessions/codex%3Afixture/messages', { method: 'POST', body: '{}' }), { status: 403 });
  await assert.rejects(resolve(request(recipientKey.token), 'remote', { grant, maintenance: true }), { status: 403 });
  await assert.rejects(resolve(request(recipientKey.token), 'remote', { grant: { ...grant, administrator: true } }), { status: 403 });
  await assert.rejects(resolve(request(key.token), 'remote', { grant }), { status: 403 });
  const p = await proof(worker, key.token);
  const revoked = await worker.command('grantChange', { ...p, command: { action: 'revoke', target: { ownerUserId: 'default', connectionId: 'remote' },
    id: grant.grantId, version: grant.version, nodeVersion: grant.nodeVersion } });
  assert.ok(revoked && 'grant' in revoked && revoked.grant.revoked);
  await assert.rejects(client.json('/sessions/codex%3Afixture/messages'), { status: 403 });
}));

test('real worker revocation between SSE frames stops delivery and cancels original source', () => fixture(async ({ worker, key, adminKey }) => {
  let source!: ReadableStreamDefaultController<Uint8Array>, cancelled = 0;
  const body = new ReadableStream<Uint8Array>({ start(c) { source = c; }, cancel() { cancelled++; } });
  const resolve = createAsyncConnectorClientResolver(worker, { connectionId: 'local', token: 'synthetic',
    dispatch: () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }) }, silence);
  const client = await resolve(request(key.token), 'local'), p = await proof(worker, adminKey.token);
  const controller = new AbortController(), events = client.events(controller.signal);
  const event = { id: 'fixture-event', type: 'message', sessionKey: 'codex:fixture', connectionId: 'local', createdAt: 1 };
  source.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
  assert.equal((await events.next()).done, false);
  assert.deepEqual(await worker.command('memberKeyRevoke', { ...p, userId: 'default', keyId: key.id }), { ok: true });
  source.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
  await assert.rejects(events.next(), { status: 401 }); assert.equal(cancelled, 1);
}));

test('worker-backed binding transports retain narrow route policy', () => fixture(async ({ worker, key }) => {
  let calls = 0;
  const resolve = createAsyncConnectorClientResolver(worker, { connectionId: 'local', token: 'synthetic', boardBindingToken: 'synthetic-binding', fileBoardToken:'synthetic-files', dispatch: () => { calls++; return Response.json({}); } }, silence);
  for (const mode of [true, 'file-boards', 'card-files', 'content-replicas'] as const) {
    const client = await resolve(request(key.token), 'local', { boardBindingsOnly: mode });
    await assert.rejects(client.json('/health'), { status: 403 });
    await assert.rejects(resolve(request(key.token), 'local', { boardBindingsOnly: mode, maintenance: true }), { status: 403 });
  }
  assert.equal(calls, 0);
}));

test('replica transport authorizes only exact existing file protocol operations',()=>{
  const id='abcdefab-1234-4123-8123-abcdefabcdef',mutation='12345678-1234-4123-8123-123456789abc';
  const root='/workspace/content-replicas',binding=root+'/'+id;
  const allowed:[string,string][]=[[root,'GET'],...[ 'GET','PUT','DELETE'].map(method=>[binding,method] as [string,string]),
    ...['observe','resolve','project','projection-receipt',`proposals/${mutation}/claim`,`proposals/${mutation}/receipt`]
      .map(suffix=>[binding+'/'+suffix,'POST'] as [string,string])];
  for(const [path,method] of allowed)assert.doesNotThrow(()=>authorizeContentReplicaRequest(path,method));
  for(const [path,method] of [[root,'POST'],[binding,'POST'],[binding+'/observe','GET'],[binding+'/settle','POST'],
    [binding+'/proposals/invalid/claim','POST'],[binding+'?foreign=1','GET'],[binding+'/../'+id,'GET'],
    ['/health','GET'],['/sessions/codex%3Afixture/messages','POST'],['/workspace/card-files','GET'],
    [binding+'/proposals/'+mutation+'/claim?foreign=1','POST'],[root+'/invalid','PUT']])
    assert.throws(()=>authorizeContentReplicaRequest(path!,method!),{status:403});
});

test('local file modes require dedicated file credential without general or binding fallback',()=>fixture(async({worker,key})=>{
  let calls=0;
  const local={connectionId:'local',token:'general-private',boardBindingToken:'binding-private',dispatch:(request:Request)=>{
    calls++;assert.equal(request.headers.get('authorization'),'Bearer files-private');
    return Response.json({},{headers:{[CONNECTOR_PROTOCOL_HEADER]:String(CONNECTOR_PROTOCOL.max)}});
  }};
  const missing=createAsyncConnectorClientResolver(worker,local,silence);
  const dedicated=createAsyncConnectorClientResolver(worker,{...local,fileBoardToken:'files-private'},silence);
  try{
    for(const mode of ['file-boards','card-files','content-replicas'] as const){
      await assert.rejects(missing(request(key.token),'local',{boardBindingsOnly:mode}),{status:401});
      const client=await dedicated(request(key.token),'local',{boardBindingsOnly:mode});
      await client.json('/workspace/'+(mode==='file-boards'?'board-files':mode));
      await assert.rejects(client.json('/health'),{status:403});
    }
    assert.equal(calls,3);
  }finally{await Promise.all([missing.close(),dedicated.close()]);}
}));

test('local binding transport uses dedicated credential and never falls back to general token', () => fixture(async ({ worker,key }) => {
  let calls = 0;
  const local = {connectionId:'local',token:'general-private',dispatch:(request:Request) => {
    calls++; assert.equal(request.headers.get('authorization'),'Bearer binding-private');
    return Response.json({},{headers:{[CONNECTOR_PROTOCOL_HEADER]:String(CONNECTOR_PROTOCOL.max)}});
  }};
  const missing = createAsyncConnectorClientResolver(worker,local,silence);
  const dedicated = createAsyncConnectorClientResolver(worker,{...local,boardBindingToken:'binding-private'},silence);
  try {
    await assert.rejects(missing(request(key.token),'local',{boardBindingsOnly:true}),{status:401});
    assert.equal(calls,0);
    const client = await dedicated(request(key.token),'local',{boardBindingsOnly:true});
    await client.json('/sessions/codex%3Afixture/board-binding'); assert.equal(calls,1);
    await assert.rejects(client.json('/health'),{status:403}); assert.equal(calls,1);
  } finally { await missing.close(); await dedicated.close(); }
}));

test('RPC rejects caller authority, SQL, broad DTOs and malformed epochs before dispatch', () => {
  const input = { evidence: { accessKey: 'hub_key_fixture' }, expectedScope: 'a'.repeat(64), command: { action: 'open', id: 'local', maintenance: false } };
  assert.equal(validHubMemberInput('connectorAccess', input), true);
  for (const command of [{ ...input.command, authorized: true }, { ...input.command, userId: 'default' },
    { ...input.command, sql: 'SELECT 1' }, { ...input.command, action: 'check', expectedEpoch: 0 },
    { ...input.command, action: 'open', expectedEpoch: 1 }, { ...input.command, grant: {} }]) {
    assert.equal(validHubMemberInput('connectorAccess', { ...input, command }), false);
  }
  assert.equal(hubMemberFailureSteps.connectorAccess, 63);
  assert.equal(validHubMemberOutput('connectorAccess', { ok: true, epoch: 1, token: 'not-allowed-on-check' }), false);
});

for (const end of ['cancel','timeout'] as const) {
  test(`pending original authority ${end} never dispatches or replays after late rejection`, () => fixture(async ({ worker, key }) => {
    let reject!: (error: Error) => void, checks = 0, calls = 0;
    // Isolate the timeout under test from unrelated worker scheduling during
    // initial login. The snapshot still originates in the real database owner.
    const initial = await worker.command('memberSnapshot', { accessKey: key.token });
    assert.ok(initial);
    const late = new Promise<never>((_, no) => { reject = no; });
    let reached!: () => void;
    const dispatched = new Promise<void>(resolve => { reached = resolve; });
    const port: Pick<AsyncHubMemberOwner, 'command'> = { command: (kind, input) => {
      if (kind === 'memberSnapshot') return Promise.resolve(initial) as ReturnType<AsyncHubMemberOwner['command']>;
      if (kind === 'connectorAccess') { checks++; reached(); return late; }
      return worker.command(kind, input);
    } };
    const resolve = createAsyncConnectorClientResolver(port, { connectionId: 'local', token: 'synthetic', dispatch: () => { calls++; return Response.json({}); } }, silence, 100);
    const abort = new AbortController();
    const result = resolve(request(key.token, abort.signal), 'local');
    // Observe rejection before triggering abort/timeout.
    const denied = assert.rejects(result, { status: end === 'cancel' ? 499 : 503 });
    await dispatched;
    assert.equal(checks, 1, 'authority command must reach the original owner');
    if (end === 'cancel') abort.abort();
    await denied; reject(new Error('synthetic late SQL failure')); await tick();
    assert.equal(checks, 1); assert.equal(calls, 0);
  }));
}
