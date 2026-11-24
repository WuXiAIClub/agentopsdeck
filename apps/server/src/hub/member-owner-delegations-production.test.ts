import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { CONNECTOR_PROTOCOL, CONNECTOR_PROTOCOL_HEADER } from '@agentopsdeck/shared';
import { HubStore } from './hub-store.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { OriginalHubAdministrativeCommands } from './original-administrative-commands.js';
import { createHubAdministrativeServices } from './administrative-route-services.js';
import { createAsyncConnectorClientResolver } from './async-connector-client.js';
import { hubMemberEvidence } from './member-owner-domain.js';
import { encodeHubSessionId } from './session-id.js';
import { registerHubRoutes } from '../routes/hub.js';
import { loadConfig } from '../config.js';
import { NODE_ID_HEADER } from '../connector/node-identity.js';
import { projectSessionDirectory, parseSessionDirectoryQuery } from '../projection/session-directory.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { DelegationBatch } from './workspace-delegation-store.js';
import { AsyncHubDelegations } from './async-delegations.js';
import { HubMemberRequestError } from './async-member-request.js';
import { asyncDelegationCatalog } from './async-workspace-delegation-directory.js';

const base = '/api/hub/v1/workspace/boards/default/delegations';
const endpoint = 'https://hub.example/api/workspace-agent/v1/board';
const deferred = () => { let resolve!:()=>void; const promise = new Promise<void>(r => {resolve=r;}); return {promise,resolve}; };
async function enteredWithin(promise:Promise<void>) {
  let timer:ReturnType<typeof setTimeout> | undefined;
  try {await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Effect did not enter within 30s')),30_000);})]);}
  finally {clearTimeout(timer);}
}
async function fixture(t:TestContext,mode:'original'|'worker',count=1) {
  const root = mkdtempSync(join(tmpdir(),'delegation-production-')), file = join(root,'hub.sqlite');
  const seed = new HubStore(file,'fixture'), user = seed.createUser('Member'), key = seed.identities.issueKey(user.id);
  const cookie = seed.identities.createSession(key.token)!, node = 'node_'+randomUUID(), taskId = randomUUID();
  const sessions = Array.from({length:count},(_,n)=>`codex:PRIVATE_${String(n).padStart(3,'0')}`);
  const native = randomUUID();
  seed.upsertConnection({id:'node',label:'Node',ownerUserId:user.id,connectorUrl:'http://delegation-connector.invalid',credentialToken:'PRIVATE_CONNECTOR_TOKEN'});
  seed.pinConnectionNode('node',user.id,seed.connectionAuthority('node',user.id)!,node);
  seed.workspace.save(user.id,{revision:0,groups:[],sessions:Object.fromEntries(sessions.map(s=>[encodeHubSessionId('node',s),{tags:['dev']}]))});
  seed.boards.save(user.id,'default',{title:'Board',revision:0,mutationId:randomUUID(),tasks:[{id:taskId,title:'Task',detail:'',status:'todo'}]});
  await seed.close();
  const logs:string[] = [], diagnostics = new PerformanceDiagnostics(line => {logs.push(line);});
  const bindings = new Map<string,{id:string;runtime:string;sessionId:string;expiresAt:number;state:string}>(), removed = new Set<string>();
  const behavior:{puts:number;gets:number;deletes:number;sync:number;inflight:number;max:number;loseAck:boolean;badCursor:boolean;
    before?:(request:Request)=>Promise<void>} = {puts:0,gets:0,deletes:0,sync:0,inflight:0,max:0,loseAck:false,badCursor:false};
  t.mock.method(globalThis,'fetch',async (input:string|URL|Request,init?:RequestInit) => {
    const request = input instanceof Request ? input : new Request(input,init), url = new URL(request.url);
    assert.equal(url.hostname,'delegation-connector.invalid'); assert.equal(request.headers.get('authorization'),'Bearer PRIVATE_CONNECTOR_TOKEN');
    const reply = (value:unknown,status=200) => new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json',
      [CONNECTOR_PROTOCOL_HEADER]:String(CONNECTOR_PROTOCOL.max),[NODE_ID_HEADER]:node}});
    const prefix = '/api/connector/v1';
    assert.ok(url.pathname.startsWith(prefix+'/'),url.pathname);
    const pathname = url.pathname.slice(prefix.length);
    if (pathname === '/sessions/directory') {
      await behavior.before?.(request);
      return reply(projectSessionDirectory(sessions,parseSessionDirectoryQuery(url.searchParams),behavior.badCursor ? '' : 'stable'));
    }
    const match = /^\/sessions\/([^/]+)\/board-binding(?:\/([^/]+))?$/.exec(pathname); assert.ok(match,pathname);
    const session = decodeURIComponent(match[1]!); assert.ok(sessions.includes(session));
    if (request.method === 'GET') {
      behavior.gets++; await behavior.before?.(request);
      return reply({runtime:'codex',sessionId:native,ready:true,binding:bindings.get(session) ?? null});
    }
    if (request.method === 'DELETE') {
      behavior.deletes++; await behavior.before?.(request); const id = match[2]!; removed.add(id);
      if (bindings.get(session)?.id === id) bindings.delete(session); return reply({id,state:'removed'});
    }
    assert.equal(request.method,'PUT'); behavior.puts++; behavior.inflight++; behavior.max = Math.max(behavior.max,behavior.inflight);
    try {
      const body = await request.json() as {id:string;credential:{endpoint:string;token:string;expiresAt:number}};
      assert.equal(body.credential.endpoint,endpoint); assert.ok(body.credential.token);
      await behavior.before?.(request);
      if (removed.has(body.id)) return reply({error:'revoked'},409);
      const binding = {id:body.id,runtime:'codex',sessionId:native,expiresAt:body.credential.expiresAt,state:'installed'};
      bindings.set(session,binding); if (behavior.loseAck) throw Error('private lost ACK'); return reply({binding});
    } finally { behavior.inflight--; }
  });
  const mount = () => {
    const metadata = new HubStore(mode === 'original' ? file : join(root,'composition.sqlite'),'fixture');
    const owner = mode === 'original' ? new OriginalHubAdministrativeCommands(metadata,diagnostics) : new AsyncHubMemberOwner({file,encryptionSecret:'fixture'},diagnostics);
    const group = createHubAdministrativeServices(owner,diagnostics), resolver = createAsyncConnectorClientResolver(owner,undefined,diagnostics);
    let guard = false;
    const store = new Proxy(metadata,{get(target,p,receiver) { if (guard) {behavior.sync++; throw Error('SYNC_DELEGATION_STORE');} return Reflect.get(target,p,receiver); }});
    const app = new Hono(), routes = registerHubRoutes(app,{config:{...loadConfig({HOME:root,AOD_SERVER_ROLE:'hub'}),boardAgentEndpoint:endpoint},
      hubStore:store,administrative:group,asyncConnectorClient:resolver,
      principal:()=>{behavior.sync++;throw Error('SYNC_DELEGATION_PRINCIPAL');},connectorClient:()=>{behavior.sync++;throw Error('SYNC_DELEGATION_CLIENT');},normalizeError:()=> 'safe'});
    assert.ok(routes); guard = true;
    return {app,owner,resolver,close:()=>routes.close(),dispose:async()=> {guard=false;await routes.close();await group.close();await resolver.close();await owner.close();await metadata.close();}};
  };
  let current = mount();
  const releases = new Set<()=>void>();
  t.after(async()=> {for (const release of releases) release();await current.dispose();assert.equal(behavior.sync,0);
    for (const secret of [key.token,cookie,'PRIVATE_CONNECTOR_TOKEN','PRIVATE_000',native,taskId]) assert.equal(logs.join('').includes(secret),false);
    rmSync(root,{recursive:true,force:true});});
  const request = (method:string,suffix='',body?:unknown,headers:Record<string,string>={'x-agentopsdeck-key':key.token}) =>
    current.app.fetch(new Request('http://hub.invalid'+base+suffix,{method,headers,...(body===undefined ? {} : {body:JSON.stringify(body)})}));
  const read = async (response:Response,status=200) => {assert.equal(response.status,status,await response.clone().text());return response.json() as Promise<{batch:DelegationBatch}>;};
  const prepare = async () => {
    const batchId = randomUUID(); const response = await request('POST','',{batchId,selection:{tags:['dev'],tagMode:'all'},taskIds:[taskId],fields:['status'],expiresAt:Date.now()+300_000});
    const value = await read(response,201); return {batchId,batch:value.batch};
  };
  const local = async (batchId:string) => {
    const evidence = hubMemberEvidence(new Request('http://hub.invalid',{headers:{'x-agentopsdeck-key':key.token}}));
    const snapshot = await current.owner.command('memberSnapshot',evidence); assert.ok(snapshot);
    return current.owner.command('delegation',{evidence,expectedScope:snapshot.recoveryScope,command:{action:'read',boardId:'default',batchId}});
  };
  const hold = () => {const value = deferred();releases.add(value.resolve);return value;};
  const change = async (kind:'board'|'preferences'|'epoch') => {
    const evidence = hubMemberEvidence(new Request('http://hub.invalid',{headers:{'x-agentopsdeck-key':key.token}}));
    const snapshot = await current.owner.command('memberSnapshot',evidence); assert.ok(snapshot);
    const proof = {evidence,expectedScope:snapshot.recoveryScope};
    if (kind === 'board') {
      const value = await current.owner.command('workspaceBoard',{...proof,command:{action:'get',resourceId:'default'}});
      assert.ok(value?.action === 'get');
      const result = await current.owner.command('workspaceBoard',{...proof,command:{action:'save',resourceId:'default',
        document:{revision:value.document.revision,mutationId:randomUUID(),title:'Changed',tasks:value.document.tasks}}});
      assert.ok(result?.action === 'save' && result.result.status === 'saved');
    } else if (kind === 'preferences') {
      const value = await current.owner.command('workspaceGet',proof); assert.ok(value && 'document' in value);
      const result = await current.owner.command('workspaceSave',{...proof,document:{...value.document,
        sessions:Object.fromEntries(sessions.map(s=>[encodeHubSessionId('node',s),{tags:['other']}]))}});
      assert.ok(result && 'document' in result);
    } else {
      const target = await current.owner.command('connectionTarget',{...proof,id:'node'}); assert.ok(target && 'epoch' in target);
      const result = await current.owner.command('connectionChange',{...proof,change:{action:'patch',id:'node',expectedEpoch:target.epoch,configuration:{enabled:false}}});
      assert.ok(result && !('error' in result));
    }
  };
  return {request,read,prepare,behavior,key,cookie,taskId,local,hold,change,diagnostics,current:()=>current,close:()=>current.close(),reopen:async()=> {await current.dispose();current=mount();}};
}

for (const mode of ['original','worker'] as const) {
  test(`delegation HTTP ${mode}: missing read and full server-owned catalog preserve domain results`,async t => {
    const f = await fixture(t,mode), current = f.current(), access = new AsyncHubDelegations(current.owner);
    t.after(()=>access.close());
    const request = new Request('http://hub.invalid'+base,{headers:{'x-agentopsdeck-key':f.key.token}});
    const scope = await access.begin(request);
    await assert.rejects(scope.command({action:'read',boardId:'default',batchId:randomUUID()}),
      (e:unknown)=>e instanceof HubMemberRequestError && e.status === 404);
    const catalog = await asyncDelegationCatalog(scope,request,'default',{tags:['dev'],tagMode:'all'},[f.taskId],['status'],current.resolver);
    assert.equal(catalog.members.length,1);assert.equal(catalog.members[0]!.taskBinding,'supported');
  });
  test(`delegation HTTP ${mode}: all four APIs, three original identity proofs and no synchronous bypass`,async t => {
    const f = await fixture(t,mode), p = await f.prepare(); assert.equal(p.batch.state,'prepared');
    const confirmed = await f.read(await f.request('POST',`/${p.batchId}/confirm`,{})); assert.equal(confirmed.batch.members[0]!.state,'installed');
    assert.equal(f.behavior.puts,1);
    for (const headers of [{'x-agentopsdeck-key':f.key.token},{authorization:'Bearer '+f.key.token},{cookie:'agentopsdeck_session='+f.cookie}])
      assert.equal((await f.read(await f.request('GET','/'+p.batchId,undefined,headers))).batch.state,'confirmed');
    const duplicate = await f.read(await f.request('POST',`/${p.batchId}/confirm`,{})); assert.equal(duplicate.batch.members[0]!.state,'installed'); assert.equal(f.behavior.puts,1);
    const cancelled = await f.read(await f.request('DELETE','/'+p.batchId)); assert.equal(cancelled.batch.members[0]!.state,'revoked'); assert.equal(f.behavior.deletes,1);
    const effects = f.diagnostics.snapshot().events.filter(e=>e.operation === 'hub-delegation-effect');
    assert.ok(effects.some(e=>e.phase === 'pending' && e.step === 11));
    assert.ok(effects.some(e=>e.phase === 'finished' && e.step === 16 && e.settled === 1 && e.unknown === 0));
    assert.ok(effects.some(e=>e.phase === 'finished' && e.step === 33 && e.settled === 1));
  });
  test(`delegation HTTP ${mode}: lost PUT ACK, physical reopen and GET-only recovery`,async t => {
    const f = await fixture(t,mode), p = await f.prepare(); f.behavior.loseAck = true;
    assert.equal((await f.read(await f.request('POST',`/${p.batchId}/confirm`,{}))).batch.members[0]!.state,'unknown');
    assert.ok(f.diagnostics.snapshot().events.some(e=>e.operation === 'hub-delegation-effect' && e.step === 16 && e.unknown === 1 && e.settled === 1));
    await f.reopen(); assert.equal(f.behavior.puts,1);
    assert.equal((await f.read(await f.request('POST',`/${p.batchId}/confirm`,{}))).batch.members[0]!.state,'unknown');
    assert.equal((await f.read(await f.request('GET','/'+p.batchId))).batch.members[0]!.state,'installed'); assert.equal(f.behavior.puts,1);
    assert.ok(f.diagnostics.snapshot().events.some(e=>e.operation === 'hub-delegation-effect' && e.step === 23 && e.settled === 1 && e.unknown === 0));
  });
  for (const kind of ['board','preferences','epoch'] as const) {
    test(`delegation HTTP ${mode}: ${kind} change during remote preflight prevents original PUT`,async t => {
      const f = await fixture(t,mode), p = await f.prepare(), entered = deferred(), held = f.hold();
      let preflights = 0;
      f.behavior.before = async r => {
        // Confirmation has its own catalog preflight before claim. Hold the
        // runner's second binding read, after durable claim and before PUT.
        if (r.method === 'GET' && new URL(r.url).pathname.endsWith('/board-binding') && ++preflights === 2) {
          entered.resolve(); await held.promise;
        }
      };
      const running = f.request('POST',`/${p.batchId}/confirm`,{}); await enteredWithin(entered.promise);
      const claimed = await f.local(p.batchId);
      assert.ok(claimed && 'action' in claimed && claimed.action === 'read' && claimed.batch?.members[0]!.state === 'dispatching');
      await f.change(kind); held.resolve();
      // A changed authority must not be made into a successful write receipt.
      // The original dispatch claim stays durable and cannot be PUT again.
      assert.equal((await running).status,502);
      assert.equal(f.behavior.puts,0);
      const original = await f.local(p.batchId);
      assert.ok(original && 'action' in original && original.action === 'read' && original.batch?.members[0]!.state === 'dispatching');
      await f.request('POST',`/${p.batchId}/confirm`,{});
      assert.equal(f.behavior.puts,0);
      assert.ok(f.diagnostics.snapshot().events.some(e=>e.operation === 'hub-delegation-effect' && e.unknown === 1));
    });
  }
  test(`delegation HTTP ${mode}: cancellation commits before held PUT settles; late ACK cannot revive`,async t => {
    const f = await fixture(t,mode), p = await f.prepare(), entered = deferred(), held = f.hold();
    f.behavior.before = async r => {if (r.method==='PUT') {entered.resolve();await held.promise;}};
    const running = f.request('POST',`/${p.batchId}/confirm`,{}); await enteredWithin(entered.promise);
    const cancelled = await f.read(await f.request('DELETE','/'+p.batchId)); assert.equal(cancelled.batch.members[0]!.state,'revoked');
    held.resolve(); await running;
    const value = await f.read(await f.request('GET','/'+p.batchId)); assert.equal(value.batch.members[0]!.state,'revoked');assert.equal(f.behavior.puts,1);
  });
  test(`delegation HTTP ${mode}: invalid directory refuses complete preview, no subset grant`,async t => {
    const f = await fixture(t,mode); f.behavior.badCursor = true;
    const response = await f.request('POST','',{batchId:randomUUID(),selection:{tags:['dev'],tagMode:'all'},taskIds:[f.taskId],fields:['status'],expiresAt:Date.now()+300_000});
    assert.equal(response.status,409); assert.equal(f.behavior.puts,0);
  });
  test(`delegation HTTP ${mode}: six members retain four-effect bound and original receipts`,async t => {
    const f = await fixture(t,mode,6), p = await f.prepare(), entered = deferred(), held = f.hold();
    f.behavior.before = async r => {if (r.method==='PUT') {if (f.behavior.inflight===4) entered.resolve();await held.promise;}};
    const running = f.request('POST',`/${p.batchId}/confirm`,{}); await enteredWithin(entered.promise); assert.equal(f.behavior.max,4);
    held.resolve(); const result = await f.read(await running); assert.equal(f.behavior.puts,6); assert.equal(f.behavior.max,4);
    assert.ok(result.batch.members.every(m => m.state==='installed'));
    assert.deepEqual(result.batch.members.map(m=>m.requestId),p.batch.members.map(m=>m.requestId));
  });
  test(`delegation HTTP ${mode}: close freezes new work and drains original held PUT`,async t => {
    const f = await fixture(t,mode), p = await f.prepare(), entered = deferred(), held = f.hold();
    f.behavior.before = async r => {if (r.method==='PUT') {entered.resolve();await held.promise;}};
    const running = f.request('POST',`/${p.batchId}/confirm`,{}); await enteredWithin(entered.promise);
    let closed = false; const closing = f.close().then(()=>{closed=true;}); await new Promise<void>(r=>setImmediate(r));assert.equal(closed,false);
    assert.equal((await f.request('GET','/'+p.batchId)).status,503);
    held.resolve(); await running;await closing; assert.equal(closed,true);assert.equal(f.behavior.puts,1);
  });
  test(`delegation HTTP ${mode}: cancellation reserve survives sixteen occupied recovery slots`,async t => {
    const f = await fixture(t,mode), p = await f.prepare(); f.behavior.loseAck = true;
    assert.equal((await f.read(await f.request('POST',`/${p.batchId}/confirm`,{}))).batch.members[0]!.state,'unknown');
    const entered = deferred(), held = f.hold(); let reads = 0;
    f.behavior.before = async r => {if (r.method === 'GET') {if (++reads === 16) entered.resolve();await held.promise;}};
    const recovery = Array.from({length:16},()=>f.request('GET','/'+p.batchId)); await enteredWithin(entered.promise);
    assert.equal((await f.request('GET','/'+p.batchId)).status,503);
    const cancelled = await f.read(await f.request('DELETE','/'+p.batchId));assert.equal(cancelled.batch.state,'cancelled');
    assert.equal(cancelled.batch.members[0]!.state,'revoked');assert.equal(f.behavior.deletes,1);
    held.resolve();await Promise.all(recovery);assert.equal(f.behavior.puts,1);
    assert.equal((await f.read(await f.request('GET','/'+p.batchId))).batch.members[0]!.state,'revoked');
  });
  test(`delegation HTTP ${mode}: cancellation during preview fences the late prepare`,async t => {
    const f = await fixture(t,mode), batchId = randomUUID(), entered = deferred(), held = f.hold();
    f.behavior.before = async r => {if (new URL(r.url).pathname === '/api/connector/v1/sessions/directory') {entered.resolve();await held.promise;}};
    const preparing = f.request('POST','',{batchId,selection:{tags:['dev'],tagMode:'all'},taskIds:[f.taskId],fields:['status'],expiresAt:Date.now()+300_000});
    await enteredWithin(entered.promise);
    const cancelled = await f.read(await f.request('DELETE','/'+batchId));assert.equal(cancelled.batch,null);
    held.resolve();assert.equal((await preparing).status,409);assert.equal(f.behavior.puts,0);
    assert.equal((await f.request('GET','/'+batchId)).status,404);
  });
}
