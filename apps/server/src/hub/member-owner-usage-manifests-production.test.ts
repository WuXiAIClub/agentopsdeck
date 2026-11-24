import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { CONNECTOR_PROTOCOL, CONNECTOR_PROTOCOL_HEADER } from '@agentopsdeck/shared';
import { HubStore } from './hub-store.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { OriginalHubAdministrativeCommands } from './original-administrative-commands.js';
import { createHubAdministrativeServices } from './administrative-route-services.js';
import { createAsyncConnectorClientResolver } from './async-connector-client.js';
import { hubMemberEvidence } from './member-owner-domain.js';
import { validHubUsageManifestCommand, validHubUsageManifestResult } from './member-usage-manifest-domain.js';
import { encodeHubSessionId } from './session-id.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { EXPECTED_NODE_HEADER, NODE_ID_HEADER } from '../connector/node-identity.js';
import { projectSessionDirectory } from '../projection/session-directory.js';
import { registerHubRoutes } from '../routes/hub.js';
import { loadConfig } from '../config.js';

const base = '/api/hub/v1/usage-manifests';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

/** The production Hub composition, with the synchronous request-time store,
 * principal and resolver trapped. Reopen always drains the sole writer first. */
async function fixture(t: TestContext, mode: 'original' | 'worker', noResolver = false, collision = false) {
  const root = mkdtempSync(join(tmpdir(), 'manifest-production-')), file = join(root, 'hub.sqlite');
  const users = new ConnectorUserStore(':memory:', () => true, { runtimeOwner: true });
  const foreignUsers = collision ? new ConnectorUserStore(':memory:', () => true, { runtimeOwner: true }) : undefined;
  const seed = new HubStore(file, 'fixture');
  (seed as unknown as { db: DatabaseSync }).db.prepare("INSERT INTO hub_roles VALUES ('default','admin',1)").run();
  const admin = seed.identities.issueKey('default'), member = seed.createUser('Member'), other = seed.createUser('Other');
  const key = seed.identities.issueKey(member.id), second = seed.identities.issueKey(member.id), cookie = seed.identities.createSession(key.token)!;
  const otherKey = seed.identities.issueKey(other.id);
  seed.upsertConnection({ id: 'node', label: 'Node', ownerUserId: member.id, connectorUrl: 'http://manifest-connector.invalid', credentialToken: 'PRIVATE_CONNECTOR' });
  seed.pinConnectionNode('node', member.id, seed.connectionAuthority('node', member.id)!, users.nodeId);
  const sessions = ['codex:PRIVATE_SESSION','claude-code:PRIVATE_SESSION','ghcp:PRIVATE_SESSION'];
  if(foreignUsers){
    seed.upsertConnection({id:'node',label:'Node',ownerUserId:other.id,connectorUrl:'http://manifest-other.invalid',credentialToken:'PRIVATE_FOREIGN_CONNECTOR'});
    seed.pinConnectionNode('node',other.id,seed.connectionAuthority('node',other.id)!,foreignUsers.nodeId);
  }
  seed.workspace.save(member.id, { revision: 0, groups: [{ id: 'group', name: 'PRIVATE_GROUP', collapsed: false }],
    sessions: Object.fromEntries(sessions.map((s,i) => [encodeHubSessionId('node',s), { groupId: 'group', tags: i ? ['two'] : ['one','two'] }])) });
  seed.layouts.save(member.id,'current',{revision:0,content:JSON.stringify({id:'current',name:'Current',
    workspace:{version:2,panes:[{id:'first',kind:'session',sessionKey:encodeHubSessionId('node',sessions[0]!)}],floating:[{id:'first'}],active:'first'},collapsedKeys:[]})});
  await seed.close();
  for (const runtime of ['codex','claude-code','ghcp'] as const)
    users.tokenUsage.record(runtime, runtime + ':PRIVATE_SESSION', 'PRIVATE_EVENT', { inputTokens: 12, outputTokens: 3 }, 'synthetic');
  if(foreignUsers)for(const runtime of ['codex','claude-code','ghcp'] as const)
    foreignUsers.tokenUsage.record(runtime,runtime+':PRIVATE_SESSION','PRIVATE_EVENT',{inputTokens:300,outputTokens:30},'synthetic');
  const selection = { requestId: randomUUID(), from: Date.now() - 3600000, to: Date.now() + 1000, bucketMs: 60000, tags: [] as string[], tagMode: 'all' };
  const behavior: { posts: number; gets: number; directories: number; sync: number; source: string; resolving?: () => Promise<void>;
    transport?: (request: Request, response: Response) => Response | Promise<Response> } = { posts: 0, gets: 0, directories: 0, sync: 0, source: 'stable' };
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init), url = new URL(request.url);
    const foreign = url.hostname === 'manifest-other.invalid';
    assert.ok(url.hostname === 'manifest-connector.invalid' || foreign && foreignUsers, 'no real network');
    const runtimeUsers = foreign ? foreignUsers! : users;
    assert.equal(request.headers.get('authorization'), foreign ? 'Bearer PRIVATE_FOREIGN_CONNECTOR' : 'Bearer PRIVATE_CONNECTOR');
    assert.equal(request.headers.get(EXPECTED_NODE_HEADER),runtimeUsers.nodeId);
    let data;
    if (url.pathname.endsWith('/sessions/directory')) {
      behavior.directories++;
      data = projectSessionDirectory(sessions, { limit: Number(url.searchParams.get('limit')),
        ...(url.searchParams.has('after') ? { after: url.searchParams.get('after')! } : {}) }, behavior.source);
    } else {
      const match = /^\/api\/connector\/v1\/sessions\/([^/]+)\/token-usage\/snapshots(?:\/(.+))?$/.exec(url.pathname); assert.ok(match);
      const session = decodeURIComponent(match[1]!), runtime = session.split(':')[0] as 'codex' | 'claude-code' | 'ghcp';
      if (request.method === 'POST') {
        behavior.posts++; const s = await request.json() as typeof selection;
        data = runtimeUsers.tokenUsage.snapshot(runtime,session,s.requestId,s.from,s.to,s.bucketMs);
      } else { behavior.gets++; data = runtimeUsers.tokenUsage.readSnapshot(runtime,session,match[2]!); }
    }
    const response = Response.json(data ?? { error: 'missing' }, { status: data ? 200 : 404,
      headers: { [CONNECTOR_PROTOCOL_HEADER]: String(CONNECTOR_PROTOCOL.max), [NODE_ID_HEADER]: runtimeUsers.nodeId } });
    return behavior.transport ? behavior.transport(request,response) : response;
  });
  const logs: string[] = [], diagnostics = new PerformanceDiagnostics(line => { logs.push(line); });
  const mount = () => {
    const metadata = new HubStore(mode === 'original' ? file : join(root,'composition.sqlite'), 'fixture');
    const owner = mode === 'original' ? new OriginalHubAdministrativeCommands(metadata,diagnostics)
      : new AsyncHubMemberOwner({ file,encryptionSecret:'fixture' },diagnostics);
    const group = createHubAdministrativeServices(owner,diagnostics), resolver = createAsyncConnectorClientResolver(owner,undefined,diagnostics);
    let guarded = false;
    const store = new Proxy(metadata, { get(target,p,receiver) {
      if (guarded) { behavior.sync++; throw Error('SYNC_MANIFEST_STORE'); } return Reflect.get(target,p,receiver);
    } });
    const app = new Hono(), routes = registerHubRoutes(app, { config: loadConfig({ HOME:root,AOD_SERVER_ROLE:'hub' }), hubStore:store, administrative:group,
      principal: () => { behavior.sync++; throw Error('SYNC_MANIFEST_PRINCIPAL'); },
      connectorClient: () => { behavior.sync++; throw Error('SYNC_MANIFEST_RESOLVER'); },
      ...(!noResolver ? { asyncConnectorClient: async (...args: Parameters<typeof resolver>) => { await behavior.resolving?.(); return resolver(...args); } } : {}),
      normalizeError: () => 'safe' });
    guarded = true;
    assert.ok(routes);
    return { app,owner,close: () => routes.close(), dispose: async () => {
      guarded = false; await routes.close(); await group.close(); await resolver.close(); await owner.close(); await metadata.close();
    } };
  };
  let current = mount();
  t.after(async () => {
    await current.dispose(); users.close(); foreignUsers?.close();
    for (const secret of [key.token,second.token,cookie,otherKey.token,'PRIVATE_SESSION','PRIVATE_EVENT','PRIVATE_CONNECTOR','PRIVATE_GROUP'])
      assert.equal(logs.join('').includes(secret),false,'private diagnostic data');
    rmSync(root,{recursive:true,force:true});
  });
  const request = (method: string, suffix = '', body?: unknown, headers: Record<string,string> = { 'x-agentopsdeck-key':key.token }, signal?: AbortSignal) =>
    current.app.fetch(new Request('http://hub.invalid'+base+suffix, { method,headers,...(signal ? {signal} : {}),
      ...(body === undefined ? {} : {body:JSON.stringify(body)}) }));
  const proof = async (token: string) => {
    const evidence = hubMemberEvidence(new Request('http://hub.invalid',{headers:{'x-agentopsdeck-key':token}}));
    const snapshot = await current.owner.command('memberSnapshot',evidence); assert.ok(snapshot);
    return { evidence,expectedScope:snapshot.recoveryScope };
  };
  const revoke = async () => current.owner.command('memberKeyRevoke',{ ...await proof(admin.token),userId:member.id,keyId:key.id });
  const change = async () => {
    const p = await proof(second.token), target = await current.owner.command('connectionTarget',{...p,id:'node'});
    assert.ok(target && 'epoch' in target);
    const result = await current.owner.command('connectionChange',{...p,change:{action:'patch',id:'node',expectedEpoch:target.epoch,configuration:{enabled:false}}});
    assert.ok(result && !('error' in result));
  };
  return { request,selection,behavior,key,cookie,otherKey,revoke,change,sessions,fetch: (request: Request) => current.app.fetch(request),close: () => current.close(),
    reopen: async () => { await current.dispose(); current = mount(); } };
}

for (const mode of ['original','worker'] as const) {
  test(`${mode} same connection, native IDs, events and request UUID remain owner/node/runtime scoped across reopen`,async t=>{
    const f=await fixture(t,mode,false,true),other={'x-agentopsdeck-key':f.otherKey.token};
    const id=f.selection.requestId;
    assert.equal((await f.request('POST','',f.selection)).status,201);
    assert.equal((await f.request('GET','/'+id,undefined,other)).status,404,'same UUID is not a transferable receipt');
    assert.equal((await f.request('POST','',f.selection,other)).status,201);
    async function confirm(headers?:Record<string,string>){
      const response=await f.request('POST','/'+id+'/confirm',{},headers);assert.equal(response.status,200);
      return (await response.json()).manifest;
    }
    const first=await confirm(),second=await confirm(other);
    for(const result of [first,second]){
      assert.equal(result.state,'complete');assert.equal(result.members.length,3);assert.equal(result.result.total.events,3);
    }
    assert.equal(first.result.total.metrics.inputTokens.knownSubtotal,36);
    assert.equal(second.result.total.metrics.inputTokens.knownSubtotal,900);
    assert.equal(f.behavior.posts,6);
    await f.reopen();
    for(const [headers,total] of [[undefined,36],[other,900]] as const){
      const response=await f.request('GET','/'+id,undefined,headers);assert.equal(response.status,200);
      assert.equal((await response.json()).manifest.result.total.metrics.inputTokens.knownSubtotal,total);
    }
    assert.equal((await f.request('DELETE','/'+id)).status,409,'completed collection cannot be cancelled');
    const pending={...f.selection,requestId:randomUUID()};
    for(const headers of [undefined,other])assert.equal((await f.request('POST','',pending,headers)).status,201);
    assert.equal((await f.request('DELETE','/'+pending.requestId)).status,200);
    const ownCancelled=await f.request('GET','/'+pending.requestId);assert.equal(ownCancelled.status,200);
    assert.equal((await ownCancelled.json()).cancelled,true);
    const otherPending=await f.request('GET','/'+pending.requestId,undefined,other);assert.equal(otherPending.status,200);
    const otherPreview=await otherPending.json();assert.equal(otherPreview.cancelled,undefined);assert.equal(otherPreview.manifest.state,'prepared');
    const retained=await f.request('GET','/'+id,undefined,other);assert.equal(retained.status,200);
    assert.equal((await retained.json()).manifest.result.total.metrics.inputTokens.knownSubtotal,900);
    assert.equal(f.behavior.posts,6,'reopen and other-owner cancellation must not recollect snapshots');
    assert.equal(f.behavior.sync,0);
  });
  test(`${mode} manifest production five entries, three credentials and runtime membership`,async t => {
    const f = await fixture(t,mode);
    for (const headers of [{ 'x-agentopsdeck-key':f.key.token },{authorization:'Bearer '+f.key.token},{cookie:'agentopsdeck_session='+f.cookie}]) {
      const selection = {...f.selection,requestId:randomUUID()};
      const prepared = await f.request('POST','',selection,headers); assert.equal(prepared.status,201,await prepared.clone().text());
      const preview = await prepared.json(); assert.equal(preview.manifest.members.length,3); assert.equal(preview.manifest.result,null);
      const confirmed = await f.request('POST','/'+selection.requestId+'/confirm',{},headers); assert.equal(confirmed.status,200,await confirmed.clone().text());
      const complete = (await confirmed.json()).manifest;
      assert.equal(complete.state,'complete'); assert.equal(complete.result.total.events,3); assert.equal(complete.result.total.metrics.inputTokens.knownSubtotal,36);
      assert.equal((await f.request('GET','/'+selection.requestId,undefined,headers)).status,200);
      assert.equal((await f.request('POST','/'+selection.requestId+'/continue',{},headers)).status,200);
      assert.equal((await f.request('POST','/'+selection.requestId+'/confirm',{},headers)).status,200);
    }
    assert.equal(f.behavior.posts,9); assert.equal(f.behavior.gets,0); assert.equal(f.behavior.sync,0);
    const filtered = {...f.selection,requestId:randomUUID(),groupId:'group',tags:['one']};
    const response = await f.request('POST','',filtered); assert.equal(response.status,201);
    assert.equal((await response.json()).manifest.members.length,1);
    assert.equal((await f.request('DELETE','/'+filtered.requestId)).status,200);
    const tombstone = await f.request('GET','/'+filtered.requestId); assert.equal(tombstone.status,200); assert.equal((await tombstone.json()).cancelled,true);
    assert.equal((await f.request('POST','',filtered)).status,200,'original cancelled preview stays cancelled');
    const layout = await f.request('POST','',{...f.selection,requestId:randomUUID(),layoutId:'current'});
    assert.equal(layout.status,201,await layout.clone().text()); assert.equal((await layout.json()).manifest.members.length,1);
  });
  test(`${mode} manifest UNKNOWN survives physical reopen and continue never repeats POST`,async t => {
    const f = await fixture(t,mode);
    assert.equal((await f.request('POST','',f.selection)).status,201);
    f.behavior.transport = async (request,response) => { if (request.method === 'POST') { await response.body?.cancel(); throw Error('PRIVATE_LOST_ACK'); } return response; };
    const result = await f.request('POST','/'+f.selection.requestId+'/confirm',{}); assert.equal(result.status,200);
    const unknown = (await result.json()).manifest; assert.equal(unknown.state,'collecting'); assert.ok(unknown.members.every((m: {state:string}) => m.state === 'unknown'));
    assert.equal(f.behavior.posts,3);
    await f.reopen(); delete f.behavior.transport;
    const continued = await f.request('POST','/'+f.selection.requestId+'/continue',{}); assert.equal(continued.status,200,await continued.clone().text());
    assert.equal((await continued.json()).manifest.state,'complete'); assert.equal(f.behavior.posts,3); assert.equal(f.behavior.gets,3);
    assert.equal((await f.request('POST','',{...f.selection,tags:['one']})).status,409);
  });
  test(`${mode} manifest rejects untrusted identity, stale scope, malformed input and unavailable resolver`,async t => {
    const f = await fixture(t,mode,true);
    assert.equal((await f.request('POST','',f.selection,{authorization:'Bearer aod_board_untrusted'})).status,401);
    assert.equal((await f.request('POST','',f.selection,{'x-agentopsdeck-key':f.key.token,'x-agentopsdeck-recovery-scope':'stale'})).status,409);
    assert.equal((await f.request('POST','',{...f.selection,owner:'default'})).status,409);
    assert.equal((await f.request('POST','',f.selection)).status,503); assert.equal(f.behavior.directories,0); assert.equal(f.behavior.posts,0);
  });
  for (const mutation of ['revoke','epoch'] as const) test(`${mode} manifest ${mutation} during original resolver prevents directory and mutation`,async t => {
    const f = await fixture(t,mode);
    f.behavior.resolving = async () => { await (mutation === 'revoke' ? f.revoke() : f.change()); };
    assert.ok((await f.request('POST','',f.selection)).status >= 400); assert.equal(f.behavior.directories,0); assert.equal(f.behavior.posts,0);
  });
  for (const mutation of ['revoke','epoch'] as const) test(`${mode} manifest ${mutation} during failed snapshot ACK takes priority over partial totals`,async t => {
    const f = await fixture(t,mode); assert.equal((await f.request('POST','',f.selection)).status,201);
    f.behavior.transport = async (request,response) => {
      if (request.method !== 'POST') return response;
      await response.body?.cancel(); await (mutation === 'revoke' ? f.revoke() : f.change()); throw Error('PRIVATE_REMOTE_FAILURE');
    };
    const response = await f.request('POST','/'+f.selection.requestId+'/confirm',{});
    assert.ok(response.status >= 400); assert.doesNotMatch(await response.text(),/PRIVATE/); assert.equal(f.behavior.posts,1);
  });
  test(`${mode} manifest incomplete paged directory refuses the whole selection`,async t => {
    const f = await fixture(t,mode);
    f.sessions.push(...Array.from({length:102},(_,i) => 'codex:page-'+String(i).padStart(3,'0')));
    f.behavior.transport = async (request,response) => {
      if (!request.url.includes('/sessions/directory') || f.behavior.directories !== 2) return response;
      const value = await response.json(); value.sourceCursor = 'changed'; return Response.json(value,{headers:response.headers});
    };
    assert.equal((await f.request('POST','',f.selection)).status,409); assert.equal(f.behavior.directories,2);
    assert.equal((await f.request('GET','/'+f.selection.requestId)).status,404); assert.equal(f.behavior.posts,0);
  });
  test(`${mode} manifest invalid remote digest never publishes partial totals or resends UNKNOWN`,async t => {
    const f = await fixture(t,mode); assert.equal((await f.request('POST','',f.selection)).status,201);
    f.behavior.transport = async (request,response) => {
      if (!request.url.includes('/snapshots')) return response;
      const value = await response.json(); value.memberDigest = '0'.repeat(64); return Response.json(value,{headers:response.headers});
    };
    const response = await f.request('POST','/'+f.selection.requestId+'/confirm',{}); assert.equal(response.status,200);
    const value = (await response.json()).manifest; assert.equal(value.state,'collecting'); assert.equal(value.result,null);
    await f.request('POST','/'+f.selection.requestId+'/continue',{}); assert.equal(f.behavior.posts,3); assert.equal(f.behavior.gets,3);
  });
  for (const waiting of ['resolver','network'] as const) test(`${mode} manifest close drains original ${waiting} after HTTP abort`,async t => {
    const f = await fixture(t,mode), entered = deferred(), release = deferred(), controller = new AbortController();
    if (waiting === 'resolver') f.behavior.resolving = async () => { entered.resolve(); await release.promise; };
    else f.behavior.transport = async (_request,response) => { entered.resolve(); await release.promise; return response; };
    const pending = f.request('POST','',f.selection,undefined,controller.signal);
    try {
      await entered.promise; controller.abort(); let settled = false;
      const closing = f.close().then(() => {settled = true;});
      assert.equal((await f.request('POST','',f.selection)).status,503); await tick(); assert.equal(settled,false);
      release.resolve(); assert.equal((await pending).status,503); await closing; assert.equal(f.behavior.posts,0);
    } finally { release.resolve(); await pending; }
  });
  for (const stopping of ['revoke','close'] as const) test(`${mode} manifest original body-time ${stopping} cannot prepare or dispatch`,async t => {
    const f = await fixture(t,mode), entered = deferred(), release = deferred();
    const body = new ReadableStream<Uint8Array>({ async pull(stream) {
      entered.resolve(); await release.promise; stream.enqueue(new TextEncoder().encode(JSON.stringify(f.selection))); stream.close();
    } },{highWaterMark:0});
    const pending = f.fetch(new Request('http://hub.invalid'+base,{method:'POST',headers:{'x-agentopsdeck-key':f.key.token},body,duplex:'half'} as RequestInit));
    try {
      await entered.promise; let settled = false;
      const closing = stopping === 'close' ? f.close().then(() => {settled = true;}) : undefined;
      if (stopping === 'revoke') await f.revoke();
      await tick(); assert.equal(settled,false); release.resolve(); assert.ok((await pending).status >= 400); await closing;
      assert.equal(f.behavior.directories,0); assert.equal(f.behavior.posts,0);
    } finally { release.resolve(); await pending; }
  });
}

test('manifest fixed protocol rejects forged authority, snapshots in receipts and loose view aggregates',() => {
  assert.equal(validHubUsageManifestCommand({action:'prepare',selection:{},pin:'a'.repeat(64),entries:[],owner:'default'}),false);
  assert.equal(validHubUsageManifestResult({error:'403'}),false);
  assert.equal(validHubUsageManifestResult({action:'view',cancelled:false,view:{requestId:randomUUID(),selection:{},result:{total:0}}}),false);
  assert.equal(validHubUsageManifestResult({action:'claim',claimed:true,authorization:true}),false);
});
