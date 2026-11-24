import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { HubStore } from './hub-store.js';
import { LEGACY_HUB_PRINCIPAL } from './identity.js';
import { encodeHubSessionId } from './session-id.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { AsyncHubOwnedSessionSharing } from './async-owned-session-sharing.js';
import { executeHubMemberCommand, type HubMemberKind } from './member-owner-domain.js';
import { HubMemberRequestError } from './async-member-request.js';
import { registerHubOwnedSessionSharingRoutes } from '../routes/hub-owned-session-sharing.js';
import { SHARING_UNKNOWN } from '../routes/hub-sharing-outcome.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

type Port=Pick<AsyncHubMemberOwner,'command'>;
const port=(call:(kind:HubMemberKind,input:unknown)=>unknown):Port=>({
  command:(async(kind:HubMemberKind,input:unknown)=>call(kind,input)) as Port['command'],
});
const quiet=new PerformanceDiagnostics(()=>{});
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve!:(value:unknown)=>void;const promise=new Promise<unknown>(r=>{resolve=r;});return{promise,resolve};};
const command=(input:unknown)=>(input as {command:{action:string}}).command;
const mutation=(kind:HubMemberKind,input:unknown)=>kind==='ownedSessionSharing'&&['create','update','delete'].includes(command(input).action);
function seed(store:HubStore){
  const db=(store as unknown as {db:DatabaseSync}).db;
  const owner=store.createUser('Owner'),recipient=store.createUser('Recipient'),stranger=store.createUser('Stranger');
  store.upsertConnection({id:'node',ownerUserId:owner.id,kind:'remote',label:'Environment',connectorUrl:'http://private.invalid'});
  store.pinConnectionNode('node',owner.id,store.connectionAuthority('node',owner.id)!,'node_'+randomUUID());
  const target=(userId:string)=>({ownerUserId:owner.id,connectionId:'node',userId});
  const member=target(recipient.id);
  store.roles.save(LEGACY_HUB_PRINCIPAL,member,{...store.roles.membership(member),role:'developer',migrateLegacy:true,
    nodeVersion:store.connectionAuthority('node',owner.id)!,environments:{codex:'developer',openclaw:'disabled'}});
  const sessionKey='codex:'+randomUUID(),sessionId=encodeHubSessionId('node',sessionKey);
  const key=store.identities.issueKey(owner.id),token=store.identities.createSession(key.token)!;
  const url='http://fixture.invalid/api/hub/v1/sessions/'+sessionId+'/collaborators';
  const request=(signal?:AbortSignal)=>new Request(url,{headers:{cookie:'agentopsdeck_session='+token},...(signal?{signal}:{})});
  const calls:Array<{kind:HubMemberKind;input:unknown}>=[];
  const call=(kind:HubMemberKind,input:unknown)=>{calls.push({kind,input});return executeHubMemberCommand(store,kind,input as never);};
  const caller=new AsyncHubOwnedSessionSharing(port(call),quiet);
  const route=(asyncOwnedSharing?:Pick<AsyncHubOwnedSessionSharing,'begin'>)=>{
    const app=new Hono();registerHubOwnedSessionSharingRoutes(app,{hubStore:store,...(asyncOwnedSharing?{asyncOwnedSharing}:{}),principal:c=>{
      const actor=store.identities.requestPrincipal(c.req.raw,()=>false);if(!actor)throw new HTTPException(401);return actor;
    }});return app;
  };
  const http=(app:Hono,method:string,body?:unknown,suffix='')=>app.request(url+suffix,{method,
    headers:{cookie:'agentopsdeck_session='+token,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const effects=()=>['hub_session_owners','command_receipts','hub_execution_leases'].map(t=>db.prepare('SELECT * FROM '+t+' ORDER BY rowid').all());
  const mutations=()=>calls.filter(x=>mutation(x.kind,x.input));
  const grants=()=>store.grants.sessionGrants(target(owner.id),{runtime:'codex',sessionKey});
  return{db,store,owner,recipient,stranger,target,sessionKey,sessionId,key,token,url,request,calls,call,caller,route,http,effects,mutations,grants};
}
async function fixture(work:(f:ReturnType<typeof seed>)=>unknown){
  const root=mkdtempSync(join(tmpdir(),'hub-owned-sharing-http-')),store=new HubStore(join(root,'hub.sqlite'),'fixture');
  try{await work(seed(store));}finally{await store.close();rmSync(root,{recursive:true,force:true});}
}
async function workerFixture(work:(f:ReturnType<typeof seed>,owner:AsyncHubMemberOwner,
  route:(caller:AsyncHubOwnedSessionSharing)=>Hono,file:string)=>Promise<void>){
  const root=mkdtempSync(join(tmpdir(),'hub-owned-sharing-worker-http-')),file=join(root,'hub.sqlite');
  const original=new HubStore(file,'fixture');
  let seeded:ReturnType<typeof seed>;
  try{seeded=seed(original);}finally{await original.close();}
  // There is no simultaneous synchronous HubStore. Async routes must not use
  // the legacy dependencies as an authorization cache or a second writer.
  const owner=new AsyncHubMemberOwner({file,encryptionSecret:'fixture'},quiet);
  const route=(caller:AsyncHubOwnedSessionSharing)=>{
    const app=new Hono();registerHubOwnedSessionSharingRoutes(app,{hubStore:{} as HubStore,
      asyncOwnedSharing:caller,principal:()=>{throw Error('synchronous authorization forbidden');}});return app;
  };
  try{await owner.open();await work(seeded!,owner,route,file);}finally{
    await owner.close();rmSync(root,{recursive:true,force:true});
  }
}
test('real worker HTTP accepts original cookie and leaves direct sharing readable by original HubStore',()=>workerFixture(async(f,owner,route,file)=>{
  const caller=new AsyncHubOwnedSessionSharing(owner,quiet),app=route(caller);
  const created=await f.http(app,'POST',{userId:f.recipient.id,role:'collaborator',media:true});
  assert.equal(created.status,201);assert.equal(created.headers.get('cache-control'),'no-store');
  const first=(await created.json()).grant;assert.equal(first.userId,f.recipient.id);assert.equal(first.derived,undefined);
  const updated=await f.http(app,'PUT',{version:first.version,role:'observer',live:false},'/'+first.id);
  assert.equal(updated.status,200);const grant=(await updated.json()).grant;
  assert.deepEqual(grant.policy.actions,['messages:read','sessions:read']);assert.equal(grant.version,2);
  const stale=await f.http(app,'DELETE',{version:first.version},'/'+first.id);assert.equal(stale.status,409);
  const listed=await f.http(app,'GET');assert.equal(listed.status,200);
  assert.deepEqual((await listed.json()).collaborators,[grant]);assert.equal(caller.pending,0);
  await owner.close();
  const reopened=new HubStore(file,'fixture');
  try{
    assert.equal(reopened.identities.requestPrincipal(f.request(),()=>false)?.userId,f.owner.id);
    const actual=reopened.grants.sessionGrants(f.target(f.owner.id),{runtime:'codex',sessionKey:f.sessionKey});
    assert.deepEqual(actual,[grant]);
    const db=(reopened as unknown as {db:DatabaseSync}).db;
    for(const table of ['hub_session_owners','command_receipts','hub_execution_leases'])
      assert.equal((db.prepare('SELECT count(*) AS n FROM '+table).get() as {n:number}).n,0);
  }finally{await reopened.close();}
}));
test('real worker lost mutation reply recovers by GET only without replay or synchronous fallback',()=>workerFixture(async(f,owner,route)=>{
  const rows:any[]=[],diagnostics=new PerformanceDiagnostics(line=>rows.push(JSON.parse(line)));
  let writes=0;
  const transport:Port={command:(async(kind:HubMemberKind,input:unknown)=>{
    const reply=await owner.command(kind,input as never);
    if(mutation(kind,input)){writes++;throw Error('PRIVATE lost post-commit reply');}return reply;
  }) as Port['command']};
  const caller=new AsyncHubOwnedSessionSharing(transport,diagnostics),app=route(caller);
  const response=await f.http(app,'POST',{userId:f.recipient.id,role:'observer'});
  assert.equal(response.status,503);assert.equal(response.headers.get('cache-control'),'no-store');
  assert.deepEqual(await response.json(),{error:SHARING_UNKNOWN});
  const recovered=await f.http(app,'GET');assert.equal(recovered.status,200);
  const page=await recovered.json();assert.equal(page.collaborators.length,1);
  assert.equal(page.collaborators[0].userId,f.recipient.id);assert.equal(writes,1);assert.equal(caller.pending,0);
  assert.equal(owner.snapshot().unavailable,false,'lost HTTP ACK is not permission to replace the original writer');
  assert.ok(rows.some(row=>row.operation==='auth-route-persistence'&&row.step===46&&row.unknown===1));
  assert.doesNotMatch(JSON.stringify(rows),new RegExp('PRIVATE|'+f.token+'|'+f.owner.id+'|'+f.recipient.id));
}));
test('awaited owner HTTP preserves original direct create/update/delete/list and session state',()=>fixture(async f=>{
  const app=f.route(f.caller),before=f.effects();
  const created=await f.http(app,'POST',{userId:f.recipient.id,role:'collaborator',media:true});
  assert.equal(created.status,201);assert.equal(created.headers.get('cache-control'),'no-store');
  const {grant}=await created.json();assert.equal(grant.derived,undefined);assert.equal(grant.userId,f.recipient.id);
  const listed=await f.http(app,'GET');assert.equal(listed.status,200);
  const old=await f.http(f.route(),'GET');assert.deepEqual(await listed.json(),await old.json());
  const updated=await f.http(app,'PUT',{version:grant.version,role:'observer',live:false},'/'+grant.id);
  assert.equal(updated.status,200);const next=(await updated.json()).grant;
  assert.equal(next.version,2);assert.deepEqual(next.policy.actions,['messages:read','sessions:read']);
  const stale=await f.http(app,'PUT',{version:grant.version,role:'observer'},'/'+grant.id);assert.equal(stale.status,409);
  const removed=await f.http(app,'DELETE',{version:next.version},'/'+grant.id);assert.equal(removed.status,200);assert.deepEqual(await removed.json(),{ok:true});
  const twice=await f.http(app,'DELETE',{version:next.version},'/'+grant.id);assert.equal(twice.status,409);
  assert.deepEqual(f.effects(),before);assert.equal(f.grants().length,0);
}));
for(const item of [
  ['POST',{} , ''],['POST',{userId:'missing',role:'observer'},''],
  ['POST',{userId:'missing',role:'owner'},''],['POST',{userId:'missing',role:'observer',sql:'private'},''],
  ['POST',{userId:'missing',role:'observer',media:1},''],['POST',[],''],
  ['PUT',{version:0,role:'observer'},'/missing'],['DELETE',{version:0},'/missing'],
] as const)test('old and awaited owner body validation agree '+JSON.stringify(item),()=>fixture(async f=>{
  const old=await f.http(f.route(),item[0],item[1],item[2]),next=await f.http(f.route(f.caller),item[0],item[1],item[2]);
  assert.equal(old.status,400);assert.equal(next.status,old.status);assert.equal(await next.text(),await old.text());
  assert.equal(f.grants().length,0);
}));
test('old and awaited owner membership and policy conflict messages agree',()=>fixture(async f=>{
  const oldApp=f.route(),app=f.route(f.caller);
  for(const body of [{userId:f.stranger.id,role:'observer'},{userId:f.recipient.id,role:'observer',queue:true}]){
    const old=await f.http(oldApp,'POST',body),next=await f.http(app,'POST',body);
    assert.equal(old.status,409);assert.equal(next.status,old.status);assert.deepEqual(await next.json(),await old.json());
  }
  const body={userId:f.recipient.id,role:'observer'};assert.equal((await f.http(app,'POST',body)).status,201);
  const old=await f.http(oldApp,'POST',body),next=await f.http(app,'POST',body);
  assert.equal(old.status,409);assert.equal(next.status,409);assert.deepEqual(await next.json(),await old.json());assert.equal(f.grants().length,1);
}));
test('owner authorization and checks never read display lists',()=>fixture(async f=>{
  const original=f.store.grants.sessionGrants;f.store.grants.sessionGrants=()=>{throw Error('display forbidden');};
  const session=await f.caller.begin(f.request(),f.sessionId);await session.check();
  f.store.grants.sessionGrants=original;await session.create(f.recipient.id,'observer',{});
  assert.equal(f.calls.some(x=>x.kind==='ownedSessionSharing'&&command(x.input).action==='list'),false);
}));
for(const fault of ['credential','node','connection'] as const)test('owner authority change during body IO blocks mutation '+fault,()=>fixture(async f=>{
  const session=await f.caller.begin(f.request(),f.sessionId);
  if(fault==='credential')f.store.identities.revokeKey(f.owner.id,f.key.id);
  if(fault==='node')f.store.upsertConnection({id:'node',ownerUserId:f.owner.id,kind:'remote',label:'Changed',connectorUrl:'http://changed.invalid'});
  if(fault==='connection')f.store.deleteConnection('node',f.owner.id);
  await assert.rejects(session.create(f.recipient.id,'observer',{}),HubMemberRequestError);assert.equal(f.mutations().length,0);assert.equal(f.grants().length,0);
}));
test('owner GET refuses changed authority after the awaited list',()=>fixture(async f=>{
  const caller=new AsyncHubOwnedSessionSharing(port((kind,input)=>{
    const value=f.call(kind,input);if(kind==='ownedSessionSharing'&&command(input).action==='list')f.store.identities.revokeKey(f.owner.id,f.key.id);return value;
  }),quiet);
  const response=await f.http(f.route(caller),'GET');assert.equal(response.status,401);assert.equal(f.mutations().length,0);
}));
test('owner mutation options captured before first authority await',()=>fixture(async f=>{
  const session=await f.caller.begin(f.request(),f.sessionId),options={media:false};
  const work=session.create(f.recipient.id,'collaborator',options);options.media=true;
  const value=await work;assert.equal(value.grant.policy.actions.includes('media:read'),false);
  assert.deepEqual((f.mutations()[0]!.input as {command:{options:unknown}}).command.options,{media:false});
}));
for(const fault of ['lostAck','wrongAck','credential','node'] as const)test('committed owner mutation never compensates or replays '+fault,()=>fixture(async f=>{
  const before=Number(f.db.prepare('SELECT count(*) AS n FROM node_grants WHERE user_id=?').get(f.recipient.id)!.n);
  const caller=new AsyncHubOwnedSessionSharing(port((kind,input)=>{
    const value=f.call(kind,input);if(mutation(kind,input)){
      if(fault==='lostAck')throw Error('private lost ACK');
      if(fault==='wrongAck')return{...(value as object),command:{...command(input),recipientId:f.stranger.id}};
      if(fault==='credential')f.store.identities.revokeKey(f.owner.id,f.key.id);
      if(fault==='node')f.store.upsertConnection({id:'node',ownerUserId:f.owner.id,kind:'remote',label:'Changed',connectorUrl:'http://changed.invalid'});
    }return value;
  }),quiet);
  const session=await caller.begin(f.request(),f.sessionId);
  await assert.rejects(session.create(f.recipient.id,'observer',{}),HubMemberRequestError);
  assert.equal(f.mutations().length,1);assert.equal(f.db.prepare('SELECT count(*) AS n FROM node_grants WHERE user_id=?').get(f.recipient.id)!.n,before+1);
}));
test('cancelled owner request cannot dispatch mutation',()=>fixture(async f=>{
  const abort=new AbortController(),session=await f.caller.begin(f.request(abort.signal),f.sessionId);abort.abort();
  await assert.rejects(session.create(f.recipient.id,'observer',{}),(error:unknown)=>error instanceof HubMemberRequestError&&error.status===499);
  assert.equal(f.mutations().length,0);
}));
test('accepted owner mutation retains ownership after cancellation and logs pending without private data',()=>fixture(async f=>{
  const wait=deferred(),abort=new AbortController(),logs:string[]=[],diagnostics=new PerformanceDiagnostics(line=>logs.push(line));
  const caller=new AsyncHubOwnedSessionSharing(port((kind,input)=>mutation(kind,input)?(f.calls.push({kind,input}),wait.promise):f.call(kind,input)),diagnostics,1,5);
  const session=await caller.begin(f.request(abort.signal),f.sessionId),work=session.create(f.recipient.id,'observer',{});void work.catch(()=>{});
  for(let i=0;i<100&&!f.mutations().length;i++)await tick();assert.equal(f.mutations().length,1);
  abort.abort();await new Promise(resolve=>setTimeout(resolve,20));assert.equal(caller.pending,1);
  const sent=f.mutations()[0]!;wait.resolve(executeHubMemberCommand(f.store,sent.kind,sent.input as never));
  await assert.rejects(work,(error:unknown)=>error instanceof HubMemberRequestError&&error.status===499);
  assert.equal(caller.pending,0);assert.equal(f.mutations().length,1);assert.equal(f.grants().length,1);
  assert.ok(logs.map(line=>JSON.parse(line)).some(e=>e.operation==='auth-route-persistence'&&e.step===46&&e.phase==='pending'));
  for(const secret of [f.token,f.key.token,f.sessionId,f.recipient.id])assert.equal(logs.join('').includes(secret),false);
}));
test('lost owner ACK produces definite unknown phase46 diagnostics and HTTP503 without replay',()=>fixture(async f=>{
  const logs:string[]=[],caller=new AsyncHubOwnedSessionSharing(port((kind,input)=>{
    const value=f.call(kind,input);if(mutation(kind,input))throw Error(f.token+f.key.token);return value;
  }),new PerformanceDiagnostics(line=>logs.push(line)));
  const response=await f.http(f.route(caller),'POST',{userId:f.recipient.id,role:'observer'});
  assert.equal(response.status,503);assert.ok((await response.json()).error);assert.equal(f.mutations().length,1);assert.equal(f.grants().length,1);
  assert.ok(logs.map(line=>JSON.parse(line)).some(e=>e.operation==='auth-route-persistence'&&e.step===46&&e.unknown===1&&e.category==='failed'));
  for(const secret of [f.token,f.key.token,f.sessionId,f.recipient.id])assert.equal(logs.join('').includes(secret),false);
}));
test('mismatched owner ACK logs unknown rather than successful settlement',()=>fixture(async f=>{
  const logs:string[]=[],caller=new AsyncHubOwnedSessionSharing(port((kind,input)=>{
    const value=f.call(kind,input);return mutation(kind,input)?{...(value as object),command:{...command(input),recipientId:f.stranger.id}}:value;
  }),new PerformanceDiagnostics(line=>logs.push(line)));
  const session=await caller.begin(f.request(),f.sessionId);
  await assert.rejects(session.create(f.recipient.id,'observer',{}),(e:unknown)=>e instanceof HubMemberRequestError&&e.status===503);
  assert.equal(f.mutations().length,1);assert.equal(f.grants().length,1);
  assert.ok(logs.map(line=>JSON.parse(line)).some(e=>e.operation==='auth-route-persistence'&&e.step===46&&e.unknown===1&&e.category==='failed'));
  for(const secret of [f.token,f.key.token,f.sessionId,f.recipient.id])assert.equal(logs.join('').includes(secret),false);
}));
for(const fault of ['credential','node'] as const)test('HTTP pins owner before reading body and rejects authority change '+fault,()=>fixture(async f=>{
  let started=false;
  const caller={async begin(request:Request,id:string){const session=await f.caller.begin(request,id);started=true;
    if(fault==='credential')f.store.identities.revokeKey(f.owner.id,f.key.id);
    else f.store.upsertConnection({id:'node',ownerUserId:f.owner.id,kind:'remote',label:'Changed',connectorUrl:'http://changed.invalid'});
    return session;
  }};
  const response=await f.http(f.route(caller),'POST',{userId:f.recipient.id,role:'observer'});
  assert.equal(started,true);assert.equal(response.status,fault==='credential'?401:409);assert.equal(f.mutations().length,0);assert.equal(f.grants().length,0);
}));
