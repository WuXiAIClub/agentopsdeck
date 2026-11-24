import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { HubStore } from './hub-store.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { AsyncHubReceivedGrants } from './async-received-grants.js';
import { executeHubMemberCommand, type HubMemberKind } from './member-owner-domain.js';
import { HubMemberRequestError } from './async-member-request.js';
import { validHubReceivedGrantReply, validHubReceivedGrantResult } from './member-received-grants-domain.js';
import { registerHubNodeGrantRoutes } from '../routes/hub-node-grants.js';
import { originalRequestScope, pinOriginalRequestScope } from './original-request-scope.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
const quiet = new PerformanceDiagnostics(()=>{});
const tick = ()=>new Promise<void>(resolve=>setImmediate(resolve));
const deferred = ()=>{let resolve!:(v:unknown)=>void;const promise=new Promise<unknown>(r=>{resolve=r;});return {resolve,promise};};
type Port = Pick<AsyncHubMemberOwner,'command'>;
const port = (call:(kind:HubMemberKind,input:unknown)=>unknown):Port=>({command:(async(kind:HubMemberKind,input:unknown)=>call(kind,input)) as Port['command']});
function seed(store:HubStore) {
  const db=(store as unknown as {db:DatabaseSync}).db,owner=store.createUser('Owner'),member=store.createUser('Recipient');
  store.upsertConnection({id:'node',ownerUserId:owner.id,kind:'remote',label:'Private label',connectorUrl:'http://private.invalid'});
  store.pinConnectionNode('node',owner.id,store.connectionAuthority('node',owner.id)!,'node_'+randomUUID());
  const target={ownerUserId:owner.id,connectionId:'node',userId:member.id};
  const policy={runtime:'codex' as const,sessionKey:'codex:owned',actions:['messages:read' as const]};
  const key=store.identities.issueKey(member.id),token=store.identities.createSession(key.token)!;
  const request=(suffix='',signal?:AbortSignal)=>new Request('http://fixture.invalid/api/hub/v1/shared/grants'+suffix,{headers:{cookie:'agentopsdeck_session='+token},...(signal?{signal}:{})});
  const proof=()=>({evidence:{sessionToken:token},expectedScope:store.identities.recoveryScope({userId:member.id,admin:store.roles.hubRole(member.id).role==='admin'})});
  const command={userId:member.id,after:'',limit:50};
  const calls:HubMemberKind[]=[],call=(kind:HubMemberKind,input:unknown)=>{calls.push(kind);return executeHubMemberCommand(store,kind,input as never);};
  const original=port(call);
  const route=(asyncReceived?:Pick<AsyncHubReceivedGrants,'received'>)=>{
    const app=new Hono();registerHubNodeGrantRoutes(app,{hubStore:store,...(asyncReceived?{asyncReceived}:{}),principal:c=>{
      const actor=store.identities.requestPrincipal(c.req.raw,()=>false);if(!actor)throw new HTTPException(401);return actor;
    }});return app;
  };
  const admin=()=>store.roles.setHubRole({userId:'default',admin:true},member.id,'admin',0);
  const count=()=>Number(db.prepare('SELECT count(*) AS n FROM node_grants').get()!.n);
  return {store,db,owner,member,target,policy,key,token,request,proof,command,calls,call,original,route,admin,count};
}
async function fixture(work:(f:ReturnType<typeof seed>)=>unknown) {
  const root=mkdtempSync(join(tmpdir(),'hub-received-')),store=new HubStore(join(root,'hub.sqlite'),'fixture');
  try{await work(seed(store));}finally{await store.close();rmSync(root,{recursive:true,force:true});}
}
test('recipient awaited HTTP retains original frontend page/cursor/session link and excludes private configuration',()=>fixture(async f=>{
  for(let i=0;i<3;i++)f.store.grants.create(f.target,f.policy);
  const original=f.route(),asyncApp=f.route(new AsyncHubReceivedGrants(f.original,quiet));
  let suffix='?limit=1';
  for(let i=0;i<3;i++){
    const before=await original.request(f.request(suffix)),after=await asyncApp.request(f.request(suffix));
    assert.equal(after.status,200);assert.equal(after.headers.get('cache-control'),'no-store');
    const expected=await before.json(),actual=await after.json() as {grants:{sessionId:string|null}[];nextCursor:string|null};
    assert.deepEqual(actual,expected);assert.ok(actual.grants[0]!.sessionId);
    assert.equal(JSON.stringify(actual).includes('private.invalid'),false);assert.equal(JSON.stringify(actual).includes('Private label'),false);
    if(actual.nextCursor)suffix='?limit=1&after='+actual.nextCursor;
  }
  assert.equal(f.calls.filter(k=>k==='receivedGrants').length,3);assert.equal(f.count(),3);
}));
for(const status of ['disabled','unverified','reauthorization_required'] as const)test('recipient original '+status+' projection never yields session admission',()=>fixture(async f=>{
  f.store.grants.create(f.target,f.policy);
  if(status==='disabled')f.db.prepare("UPDATE env_connections SET status='disabled' WHERE id='node'").run();
  else if(status==='unverified')f.db.prepare("UPDATE env_connections SET node_id=NULL WHERE id='node'").run();
  else f.store.upsertConnection({id:'node',ownerUserId:f.owner.id,kind:'remote',label:'Changed',connectorUrl:'http://new.invalid'});
  const expected=await (await f.route().request(f.request())).json();
  const actual=await (await f.route(new AsyncHubReceivedGrants(f.original,quiet)).request(f.request())).json() as {grants:{availability:string;sessionId:null}[]};
  assert.deepEqual(actual,expected);assert.equal(actual.grants[0]!.availability,status);assert.equal(actual.grants[0]!.sessionId,null);
}));
test('recipient identity correlation cannot retarget another user',()=>fixture(f=>{
  f.store.grants.create(f.target,f.policy);
  assert.equal(f.call('receivedGrants',{...f.proof(),command:{...f.command,userId:f.owner.id}}),null);
  assert.equal(f.count(),1);
}));
test('revoked and role-ceiling filtered pages retain original advancing cursor even when empty',()=>fixture(async f=>{
  for(let i=0;i<3;i++)f.store.grants.create(f.target,f.policy);
  f.db.prepare("INSERT INTO connector_memberships VALUES (?,?,?,'none',1,?,?)").run(f.owner.id,'node',f.member.id,f.store.connectionAuthority('node',f.owner.id)!,JSON.stringify({codex:'disabled',openclaw:'disabled'}));
  const response=await f.route(new AsyncHubReceivedGrants(f.original,quiet)).request(f.request('?limit=1'));
  const page=await response.json() as {grants:unknown[];nextCursor:string};assert.equal(response.status,200);assert.deepEqual(page.grants,[]);assert.ok(page.nextCursor);
  assert.deepEqual(page,await (await f.route().request(f.request('?limit=1'))).json());
  f.db.prepare('UPDATE node_grants SET revoked=1').run();assert.deepEqual(await new AsyncHubReceivedGrants(f.original,quiet).received(f.request(),'',50),{grants:[],nextCursor:null});
}));
test('GET administrator maintenance uses original read-only inheritance, idempotently',()=>fixture(async f=>{
  f.admin();const caller=new AsyncHubReceivedGrants(f.original,quiet);
  const first=await caller.received(f.request(),'',50);assert.equal(first.grants.length,2);assert.equal(f.count(),2);
  assert.deepEqual(await caller.received(f.request(),'',50),first);assert.equal(f.count(),2);
  for(const grant of first.grants){assert.equal(grant.sessionId,null);assert.ok(grant.policy.actions.every(a=>!['messages:send','queue:manage','sessions:create'].includes(a)));}
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM hub_execution_issuers').get()!.n,0);
}));
test('GET administrator maintenance shares original outer rollback and failing log sink cannot change results',()=>fixture(async f=>{
  f.admin();f.db.exec('BEGIN');try{
    const caller=new AsyncHubReceivedGrants(f.original,new PerformanceDiagnostics(()=>{throw Error('sink');}));
    assert.equal((await caller.received(f.request(),'',50)).grants.length,2);assert.equal(f.count(),2);assert.equal(f.db.isTransaction,true);
  }finally{f.db.exec('ROLLBACK');}assert.equal(f.count(),0);
}));
for(const committed of [false,true])test('GET maintenance RELEASE '+(committed?'after':'before')+' commit remains unknown without replay',()=>fixture(async f=>{
  f.admin();const exec=f.db.exec.bind(f.db);let releases=0;
  f.db.exec=sql=>{if(sql.startsWith('RELEASE hub_identity_check')&&f.count()===2){releases++;if(committed)exec(sql);throw Error('private failure');}return exec(sql);};
  try{const response=await f.route(new AsyncHubReceivedGrants(f.original,quiet)).request(f.request());assert.equal(response.status,503);
    assert.match((await response.json() as {error:string}).error,/saved state/);assert.equal(releases,1);assert.equal(f.calls.filter(k=>k==='receivedGrants').length,1);
    assert.equal(f.count(),committed?2:0);assert.equal(f.db.isTransaction,false);
  }finally{f.db.exec=exec;}
}));
test('maintenance abort after dispatch keeps reservation until actual ACK; phase42 logs omit credentials',()=>fixture(async f=>{
  f.admin();const gate=deferred(),dispatched=deferred(),logs:string[]=[];let reply:unknown;
  const owner=port((kind,input)=>{const result=f.call(kind,input);if(kind==='receivedGrants'){reply=result;dispatched.resolve(null);return gate.promise;}return result;});
  const caller=new AsyncHubReceivedGrants(owner,new PerformanceDiagnostics(line=>logs.push(line)),5,10),abort=new AbortController();
  const work=caller.received(f.request('',abort.signal),'',50);void work.catch(()=>{});await dispatched.promise;abort.abort();await new Promise<void>(resolve=>setTimeout(resolve,25));
  assert.equal(caller.pending,1);assert.equal(f.count(),2);assert.equal(f.calls.filter(k=>k==='receivedGrants').length,1);
  assert.ok(logs.some(line=>{const v=JSON.parse(line);return v.step===42&&v.phase==='pending';}));gate.resolve(reply);
  await assert.rejects(work,e=>e instanceof HubMemberRequestError&&e.status===499);assert.equal(caller.pending,0);
  for(const secret of [f.token,f.key.token,f.member.id,f.owner.id,'private.invalid'])assert.equal(logs.join('').includes(secret),false);
}));
test('credentials revoked after maintenance deny delivery without undo or replay',()=>fixture(async f=>{
  f.admin();const caller=new AsyncHubReceivedGrants(port((kind,input)=>{const result=f.call(kind,input);if(kind==='receivedGrants')f.store.identities.revokeSession(f.token);return result;}),quiet);
  await assert.rejects(caller.received(f.request(),'',50),e=>e instanceof HubMemberRequestError&&e.status===401);
  assert.equal(f.count(),2);assert.equal(f.calls.filter(k=>k==='receivedGrants').length,1);
}));
for(const field of ['userId','after','limit'] as const)test('forged '+field+' ACK cannot substitute recipient page or repeat maintenance',()=>fixture(async f=>{
  f.admin();const caller=new AsyncHubReceivedGrants(port((kind,input)=>{const result=f.call(kind,input);if(kind==='receivedGrants')return {...result as object,[field]:field==='limit'?1:field==='after'?randomUUID():f.owner.id};return result;}),quiet);
  await assert.rejects(caller.received(f.request(),'',50),e=>e instanceof HubMemberRequestError&&e.status===503);assert.equal(f.count(),2);assert.equal(f.calls.filter(k=>k==='receivedGrants').length,1);
}));
test('strict malformed ACK page/session correlation does not throw or expand resource scope',()=>fixture(f=>{
  const grant=f.store.grants.create(f.target,f.policy),result=f.call('receivedGrants',{...f.proof(),command:f.command});assert.ok(result&&'page' in result&&result.page&&'grants' in result.page);
  assert.equal(validHubReceivedGrantReply(f.command,result),true);
  for(const page of [{...result.page,extra:true},{grants:[{...result.page.grants[0],sessionId:'other:session'}],nextCursor:null},{grants:[{...result.page.grants[0],id:grant.id},result.page.grants[0]],nextCursor:null}])assert.equal(validHubReceivedGrantResult({...result,page}),false);
  assert.equal(validHubReceivedGrantResult({userId:f.member.id,after:'',limit:1,page:{grants:[{policy:null}],nextCursor:null}}),false);
}));
test('authentication precedes query rejection; invalid queries never dispatch maintenance',()=>fixture(async f=>{
  const app=f.route(new AsyncHubReceivedGrants(f.original,quiet));
  assert.equal((await app.request('/api/hub/v1/shared/grants?extra=true')).status,401);
  for(const suffix of ['?extra=true','?limit=101','?limit=nan','?after=bad'])assert.equal((await app.request(f.request(suffix))).status,400);
  assert.equal(f.calls.includes('receivedGrants'),false);assert.equal(f.count(),0);
}));
test('stale HTTP recovery scope cannot read a different recipient or initiate role maintenance',()=>fixture(async f=>{
  f.admin();
  const app=f.route(new AsyncHubReceivedGrants(f.original,quiet));
  const request=f.request();request.headers.set('x-agentopsdeck-recovery-scope','0'.repeat(64));
  assert.equal((await app.request(request)).status,409);
  assert.equal(f.calls.includes('receivedGrants'),false);assert.equal(f.count(),0);
  const anonymous=new Request(request.url,{headers:{'x-agentopsdeck-recovery-scope':'0'.repeat(64)}});
  assert.equal((await app.request(anonymous)).status,401);
}));
for(const explicit of [false,true])test('recipient page pins server original scope with '+(explicit?'matching':'absent')+' HTTP hint',()=>fixture(async f=>{
  f.store.grants.create(f.target,f.policy);
  const caller=new AsyncHubReceivedGrants(f.original,quiet),request=f.request(),scope=f.proof().expectedScope;
  if(explicit)request.headers.set('x-agentopsdeck-recovery-scope',scope);
  const page=await caller.received(request,'',50);
  assert.equal(page.grants.length,1);assert.equal(originalRequestScope(request),scope);
  assert.throws(()=>pinOriginalRequestScope(request,'0'.repeat(64)),/original_request_scope_changed/);
}));
test('private original scope remains authoritative over a matching public header',()=>fixture(async f=>{
  const caller=new AsyncHubReceivedGrants(f.original,quiet),request=f.request();
  request.headers.set('x-agentopsdeck-recovery-scope',f.proof().expectedScope);
  pinOriginalRequestScope(request,'0'.repeat(64));
  await assert.rejects(caller.received(request,'',50),e=>e instanceof HubMemberRequestError&&e.status===401);
  assert.equal(f.calls.includes('receivedGrants'),false);
}));
for(const column of ['actions','label','environments'] as const)test('oversized legacy '+column+' refused before administrator maintenance/materialization',()=>fixture(async f=>{
  f.admin();if(column==='actions'){f.store.grants.create(f.target,f.policy);f.db.prepare('UPDATE node_grants SET actions=?').run('x'.repeat(65537));}
  else if(column==='label')f.db.prepare('UPDATE env_connections SET label=?').run('x'.repeat(65537));
  else f.db.prepare("INSERT INTO connector_memberships VALUES (?,?,?,'none',1,1,?)").run(f.owner.id,'node',f.member.id,'x'.repeat(65537));
  const before=f.count(),response=await f.route(new AsyncHubReceivedGrants(f.original,quiet)).request(f.request());assert.equal(response.status,503);assert.equal(f.count(),before);
}));
class FakeWorker extends EventEmitter {messages:{id:number;kind:string;body:string}[]=[];stops=0;postMessage(m:{id:number;kind:string;body:string}){this.messages.push(m);}terminate(){this.stops++;return Promise.resolve(1);}}
test('wrong recipient worker ACK fences original physical owner until real exit; no replacement/replay',async()=>{
  const root=mkdtempSync(join(tmpdir(),'hub-received-ack-')),file=join(root,'hub.sqlite'),worker=new FakeWorker(),launch=()=>worker as unknown as Worker;
  const owner=new AsyncHubMemberOwner({file},quiet,launch);
  try{const result=owner.command('receivedGrants',{evidence:{},expectedScope:'a'.repeat(64),command:{userId:'user',after:'',limit:50}});void result.catch(()=>{});
    worker.emit('message',{kind:'ready'});await tick();const m=worker.messages[0]!;
    worker.emit('message',{id:m.id,kind:m.kind,ok:true,body:JSON.stringify({userId:'other',after:'',limit:50,page:{grants:[],nextCursor:null}})});
    await assert.rejects(result);assert.equal(worker.stops,0);assert.equal(worker.messages.length,1);assert.throws(()=>new AsyncHubMemberOwner({file},quiet,launch));
    const closing=owner.close();await tick();assert.equal(worker.stops,1);assert.throws(()=>new AsyncHubMemberOwner({file},quiet,launch));worker.emit('exit',1);await assert.rejects(closing);
  }finally{worker.emit('exit',1);rmSync(root,{recursive:true,force:true});}
});
test('real worker original-data reopen preserves maintenance, sessions and projection',async()=>{
  const root=mkdtempSync(join(tmpdir(),'hub-received-worker-')),file=join(root,'hub.sqlite'),store=new HubStore(file,'fixture'),f=seed(store);f.admin();const proof=f.proof();await store.close();
  const owner=new AsyncHubMemberOwner({file,encryptionSecret:'fixture'},quiet);
  try{const result=await owner.command('receivedGrants',{...proof,command:f.command});assert.ok(result);assert.equal(result.page.grants.length,2);await owner.close();
    const reopened=new HubStore(file,'fixture');try{
      const actor=reopened.identities.requestPrincipal(f.request(),()=>false);assert.ok(actor&&actor.admin);
      const page=executeHubMemberCommand(reopened,'receivedGrants',{...proof,command:f.command});assert.deepEqual(page,result);
    }finally{await reopened.close();}
  }finally{await owner.close();rmSync(root,{recursive:true,force:true});}
});
