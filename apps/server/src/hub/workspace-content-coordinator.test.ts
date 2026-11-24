import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type WorkspaceFileCard } from '@agentopsdeck/shared';
import { WorkspaceContentCoordinator, type ContentReplicaTransport, type SharedContentTarget } from './workspace-content-coordinator.js';
import { WorkspaceContentReplica } from '../connector/workspace-content-replica.js';
import { ConnectorWorkspaceFiles } from '../connector/workspace-board-files.js';
import { cardFileCodec } from '../connector/workspace-file-card-format.js';
import { NativeWorkspaceCardFileProjection } from './workspace-card-file-projection.js';
import { WorkspaceBoards } from './workspace-boards.js';
import { WorkspaceCards } from './workspace-cards.js';
import { WorkspaceDrawings } from './workspace-drawings.js';
import { WorkspaceNativeDrawio } from './workspace-native-drawio.js';
import { WorkspaceCardConfigurations } from './workspace-card-configurations.js';
import { SessionNotebooks } from './session-notebooks.js';
import { Hono } from 'hono';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { registerConnectorContentReplicas } from '../connector/workspace-content-http.js';
import { contentReplicaTransport } from './workspace-content-transport.js';
import { registerHubWorkspaceContent } from '../routes/hub-workspace-content.js';
import { WorkspaceContentBatches } from './workspace-content-batches.js';
import type { DelegationCatalogSource } from './workspace-delegation-catalog.js';
import type { ContentAsyncStorageAdmission } from './content-proposal-store.js';

async function fixture(t: TestContext, http=false, admission?:ContentAsyncStorageAdmission) {
  const root=await mkdtemp(join(tmpdir(),'content-coordinator-'));
  const db=new DatabaseSync(':memory:'), localDb=new DatabaseSync(join(root,'replicas.sqlite'));
  const native=new NativeWorkspaceCardFileProjection(db,{boards:new WorkspaceBoards(db),cards:new WorkspaceCards(db),
    drawings:new WorkspaceDrawings(db),nativeDrawio:new WorkspaceNativeDrawio(db),configurations:new WorkspaceCardConfigurations(db),
    notebooks:new SessionNotebooks(db),sessionNotebook:()=>undefined});
  let authorized=true;
  const files=new ConnectorWorkspaceFiles<WorkspaceFileCard>(localDb,root,owner=>owner==='owner'&&authorized,cardFileCodec());
  const local=new WorkspaceContentReplica(localDb,files);
  t.after(async()=>{await files.close();localDb.close();db.close();await rm(root,{recursive:true,force:true});});
  const targets=new Map<string,SharedContentTarget>();
  let available=true;
  const tokens=new ConnectorTokenStore(join(root,'tokens')),ownerToken=tokens.createTransient(['boards:files'],'owner');
  const app=new Hono();
  registerConnectorContentReplicas(app,{tokens,replicas:local,files,available:()=>available,
    session:async key=>({exists:[...targets.values()].some(t=>t.sessionKey===key),ready:true})});
  const transport=():ContentReplicaTransport=>http?contentReplicaTransport({json:async<T>(path:string,init?:RequestInit)=>{
    const response=await app.request('/api/connector/v1'+path,{...init,headers:{...init?.headers,authorization:`Bearer ${ownerToken.token}`}});
    if(!response.ok)throw Error(`connector ${response.status}`);return await response.json() as T;
  }}):({capability:async()=>({protocol:1,available}),
    install:input=>local.install('owner',input),view:id=>local.view('owner',id),observe:id=>local.observe('owner',id),
    claim:(id,mutation)=>local.claimPublish('owner',id,mutation),settle:(id,mutation,receipt)=>local.settle('owner',id,mutation,receipt),
    resolve:(id,input)=>local.resolve('owner',id,input),
    project:(id,job)=>local.project('owner',id,job),projectionReceipt:(id,job)=>local.projectionReceipt('owner',id,job),
    revoke:id=>local.revoke('owner',id)});
  const resolve=(owner:string,id:string)=>{
    if(owner!=='owner'||!authorized||!targets.has(id))throw Error('forbidden');return targets.get(id)!;
  };
  const coordinator=new WorkspaceContentCoordinator(db,native,resolve,admission);
  const resource=JSON.stringify(['taskboard','default']);
  const base=(await coordinator.migrateAsync('owner',resource,0,randomUUID())).result;
  const source:DelegationCatalogSource={
    fence:()=>({generation:0,preferencesRevision:0}),
    authorized:owner=>owner==='owner'&&authorized,
    enumerate:async owner=>({complete:true,members:[...targets.values()].map(target=>({owner,nodeId:'fixture',connectionId:target.connectionId,
      runtime:'codex',sessionId:target.sessionId,authorityEpoch:0,groupId:'dev',tags:['shared'],taskBinding:'supported' as const}))}),
  };
  const batches=new WorkspaceContentBatches(db,coordinator,source);
  const hub=new Hono();
  registerHubWorkspaceContent(hub,{coordinator,batches,principal:c=>({userId:c.req.header('x-test-owner')??'owner',admin:false}),
    native:(owner,resource)=>native.get(owner,resource),enabled:()=>available});
  async function attach(change?:(transport:ContentReplicaTransport)=>void) {
    const sessionId=randomUUID(),id=randomUUID(),remote=transport();change?.(remote);
    const target:SharedContentTarget={sessionId,sessionKey:`codex:${sessionId}`,connectionId:randomUUID(),authority:0,
      valid(){if(!authorized)throw Error('forbidden');},transport:remote};targets.set(sessionId,target);
    const current=coordinator.store.resource('owner',resource)!;
    const input={id,sessionId,epoch:current.epoch,revision:current.revision};
    const binding=await coordinator.bind('owner',resource,input);
    return {binding,target,input,path:files.get('owner',id).path};
  }
  const edit=(path:string,title:string)=>writeFile(path,cardFileCodec().serialize({kind:'taskboard',content:{title,tasks:[]}}));
  const title=async(path:string)=>JSON.parse(await readFile(path,'utf8')).content.title;
  return {db,native,local,files,coordinator,resource,base,attach,edit,title,targets,batches,source,
    hub,app,tokens,ownerToken,pause:()=>{available=false;},deny:()=>{authorized=false;},second:()=>new WorkspaceContentCoordinator(db,native,resolve)};
}

function admissionGate() {
  let pending:Promise<void>|undefined,entered:()=>void=()=>{},release:()=>void=()=>{};
  const admission:ContentAsyncStorageAdmission=async(_bytes,write)=>{if(pending){entered();await pending;}return write();};
  return {admission,hold(){pending=new Promise<void>(resolve=>{release=resolve;});return new Promise<void>(resolve=>{entered=resolve;});},
    release(){pending=undefined;release();}};
}

for(const operation of ['write','recover-write','recover-migration'] as const)for(const paused of [false,true]) {
  test(`Hub HTTP ${operation} waits for physical admission and rechecks maintenance: ${paused}`,async t=>{
    const gate=admissionGate(),f=await fixture(t,false,gate.admission),id=randomUUID();
    const url='/api/hub/v1/workspace/shared-content/'+encodeURIComponent(f.resource);
    const input={mutationId:id,modeEpoch:f.base.epoch,baseRevision:0,baseHash:f.base.hash,
      content:JSON.stringify({kind:'taskboard',content:{title:'Async owner',tasks:[]}})};
    const entered=gate.hold();
    const flight=f.hub.request(operation==='write'?url+'/document':operation==='recover-write'?`${url}/writes/${f.base.epoch}/${id}/recover`:`${url}/migrations/${id}/recover`,{
      method:operation==='write'?'PUT':'POST',headers:{'content-type':'application/json'},body:JSON.stringify(operation==='write'?input:{})});
    await entered;
    assert.equal(f.coordinator.store.resource('owner',f.resource)!.revision,0);
    assert.equal(f.coordinator.store.ownerReceipt('owner',f.resource,f.base.epoch,id),undefined);
    assert.equal(f.coordinator.store.writeTermination('owner',f.resource,f.base.epoch,id),undefined);
    assert.equal(f.coordinator.store.migrationTermination('owner',id),undefined);
    if(paused)f.pause();gate.release();const response=await flight;
    assert.equal(response.status,paused?503:200);
    const body=await response.json() as {receipt:unknown;termination:unknown};
    if(!paused)assert.ok(operation==='write'?body.receipt:body.termination);
    assert.equal(f.coordinator.store.resource('owner',f.resource)!.revision,!paused&&operation==='write'?1:0);
    if(paused){assert.equal(f.coordinator.store.writeTermination('owner',f.resource,f.base.epoch,id),undefined);
      assert.equal(f.coordinator.store.migrationTermination('owner',id),undefined);}
  });
}

for(const action of ['bind','proposal','projection'] as const)for(const refusal of ['none','revoked','closed'] as const) {
  test(`Hub ${action} keeps original durable intent behind admission and rejects ${refusal}`,async t=>{
    const gate=admissionGate(),f=await fixture(t,false,gate.admission);
    let effects=0;
    if(action==='bind'){
      const entered=gate.hold(),flight=f.attach(remote=>{const install=remote.install;remote.install=async input=>{effects++;return install(input);};});
      const outcome=flight.then(value=>({value}),error=>({error}));await entered;
      assert.equal(f.coordinator.store.listBindings('owner',f.resource).length,0);assert.equal(effects,0);
      if(refusal==='revoked')f.deny();if(refusal==='closed')await f.coordinator.close();gate.release();
      const result=await outcome;
      if(refusal==='none'){assert.ok('value'in result);assert.equal(effects,1);}
      else{assert.ok('error'in result);assert.equal(effects,0);assert.equal(f.coordinator.store.listBindings('owner',f.resource).length,0);}
      return;
    }
    const a=await f.attach(remote=>{const project=remote.project;remote.project=async(id,job)=>{effects++;return project(id,job);};});
    if(action==='proposal')await f.edit(a.path,'Local async');
    else await f.coordinator.store.writeAsync('owner',f.resource,{mutationId:randomUUID(),modeEpoch:f.base.epoch,
      baseRevision:0,baseHash:f.base.hash,content:JSON.stringify({kind:'taskboard',content:{title:'Projection async',tasks:[]}})});
    const entered=gate.hold(),flight=f.coordinator.synchronize('owner',f.resource,a.binding.id);
    const outcome=flight.then(value=>({value}),error=>({error}));await entered;
    assert.equal(effects,0);assert.equal(f.coordinator.store.resource('owner',f.resource)!.revision,action==='proposal'?0:1);
    if(action==='projection')assert.equal(f.coordinator.store.projections('owner',f.resource,a.binding.id,a.binding.generation)[0]!.state,'pending');
    if(refusal==='revoked')f.deny();if(refusal==='closed')await f.coordinator.close();gate.release();
    const result=await outcome;
    if(refusal==='none'){assert.ok('value'in result);assert.equal(f.coordinator.store.resource('owner',f.resource)!.revision,1);
      assert.equal(await f.title(a.path),action==='proposal'?'Local async':'Projection async');assert.equal(effects,action==='projection'?1:0);}
    else{assert.ok('error'in result);assert.equal(effects,0);
      if(action==='proposal')assert.equal(f.coordinator.store.resource('owner',f.resource)!.revision,0);}
  });
}

test('async Hub owner refuses growing sync bypass and rejects asynchronous request guards before their body',async t=>{
  const gate=admissionGate(),f=await fixture(t,false,gate.admission);
  const input={mutationId:randomUUID(),modeEpoch:f.base.epoch,baseRevision:0,baseHash:f.base.hash,content:f.base.content};
  assert.throws(()=>f.coordinator.store.write('owner',f.resource,input),/async-admission-required/);
  let calls=0;
  await assert.rejects(f.coordinator.store.writeAsync('owner',f.resource,input,async()=>{calls++;}),/./);
  assert.equal(calls,0);assert.equal(f.coordinator.store.ownerReceipt('owner',f.resource,f.base.epoch,input.mutationId),undefined);
});

for(const action of ['proposal','projection'] as const) {
  test(`Hub HTTP ${action} rechecks new-work maintenance after physical wait without replay`,async t=>{
    const gate=admissionGate(),f=await fixture(t,false,gate.admission),a=await f.attach();
    if(action==='proposal')await f.edit(a.path,'Pending local');
    else await f.coordinator.store.writeAsync('owner',f.resource,{mutationId:randomUUID(),modeEpoch:f.base.epoch,baseRevision:0,
      baseHash:f.base.hash,content:JSON.stringify({kind:'taskboard',content:{title:'Pending projection',tasks:[]}})});
    const entered=gate.hold();
    const flight=f.hub.request(`/api/hub/v1/workspace/shared-content/${encodeURIComponent(f.resource)}/bindings/${a.binding.id}/sync`,{method:'POST'});
    await entered;f.pause();gate.release();assert.equal((await flight).status,503);
    assert.equal(f.coordinator.store.resource('owner',f.resource)!.revision,action==='proposal'?0:1);
    if(action==='proposal')assert.equal(f.local.proposals('owner',a.binding.id)[0]!.state,'unknown');
    else assert.equal(await f.title(a.path),JSON.parse(f.base.content).content.title);
  });
}

test('Hub binding target async validity cannot authorize installation or run its body',async t=>{
  const gate=admissionGate(),f=await fixture(t,false,gate.admission);
  const id=randomUUID();let calls=0,effects=0;
  f.targets.set(id,{sessionId:id,sessionKey:`codex:${id}`,connectionId:randomUUID(),authority:0,
    valid:async()=>{calls++;},transport:{capability:async()=>{effects++;return {protocol:1,available:true};}} as ContentReplicaTransport});
  await assert.rejects(f.coordinator.bind('owner',f.resource,{id:randomUUID(),sessionId:id,epoch:f.base.epoch,revision:0}));
  assert.equal(calls,0);assert.equal(effects,0);assert.equal(f.coordinator.store.listBindings('owner',f.resource).length,0);
});

test('full-card batch HTTP preview freezes members and confirm/recovery never reinstall',async t=>{
  const f=await fixture(t,true),a=await f.attach(),b=await f.attach();let installs=0;
  for(const target of [a.target,b.target]){const install=target.transport.install;target.transport.install=async input=>{installs++;return install(input);};}
  const id=randomUUID(),url=`/api/hub/v1/workspace/shared-content/${encodeURIComponent(f.resource)}/batches/${id}`;
  const prepared=await f.hub.request(url,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({selection:{groupId:'dev',tags:['shared'],tagMode:'all'}})});
  assert.equal(prepared.status,200);const preview=(await prepared.json()).batch;assert.equal(preview.members.length,2);assert.equal(installs,0);
  for(let i=0;i<2;i++){const confirmed=await f.hub.request(url+'/confirm',{method:'POST'});assert.equal(confirmed.status,200);assert.ok((await confirmed.json()).batch.members.every((m:{state:string})=>m.state==='installed'));}
  assert.equal(installs,2);
  assert.equal((await f.hub.request(url,{headers:{'x-test-owner':'other'}})).status,409);
  const cancelled=await f.hub.request(url,{method:'DELETE'});assert.equal(cancelled.status,200);
  assert.ok((await cancelled.json()).batch.members.every((m:{state:string})=>m.state==='cancelled'));
  assert.equal(f.coordinator.store.bindingRecord('owner',f.resource,a.binding.id)!.revoked,false);
});

test('owner recovery fences absent migration, GET recovers lost ACK and delayed POST cannot change head',async t=>{
  const f=await fixture(t),id=randomUUID(),root=`/api/hub/v1/workspace/shared-content/${encodeURIComponent(f.resource)}`;
  const post={method:'POST',headers:{'content-type':'application/json'},body:'{}'};
  assert.deepEqual(await (await f.hub.request(root+'/migrations/'+id)).json(),{receipt:null,termination:null});
  const response=await f.hub.request(root+'/migrations/'+id+'/recover',post);
  assert.equal(response.status,200);
  const proof=await response.json();assert.deepEqual(proof,{receipt:null,termination:{mutationId:id,resource:f.resource,state:'not-executed'}});
  assert.deepEqual(await (await f.hub.request(root+'/migrations/'+id)).json(),proof);
  assert.deepEqual(await (await f.hub.request(root+'/migrations/'+id+'/recover',post)).json(),proof);
  const late=await f.hub.request(root+'/migrate',{...post,body:JSON.stringify({requestId:id,revision:0})});
  assert.equal(late.status,409);assert.deepEqual(f.coordinator.store.resource('owner',f.resource),f.base);
  assert.equal((await f.hub.request(root+'/migrations/'+id,{headers:{'x-test-owner':'other'}})).status,200);
  assert.deepEqual(await (await f.hub.request(root+'/migrations/'+id,{headers:{'x-test-owner':'other'}})).json(),{receipt:null,termination:null});
  const other=`/api/hub/v1/workspace/shared-content/${encodeURIComponent(JSON.stringify(['taskboard',randomUUID()]))}`;
  assert.equal((await f.hub.request(other+'/migrations/'+id)).status,404);
  assert.equal((await f.hub.request(other+'/migrations/'+id+'/recover',post)).status,409);
  assert.equal((await f.hub.request(root+'/migrations/'+randomUUID()+'/recover',{...post,body:'{"overwrite":true}'})).status,400);
  f.pause();assert.equal((await f.hub.request(root+'/migrations/'+randomUUID()+'/recover',post)).status,503);
  assert.deepEqual(await (await f.hub.request(root+'/migrations/'+id)).json(),proof);
});

test('native notebook recovery leaves text and revision unchanged and only fences the original migration',async t=>{
  const f=await fixture(t),resource=JSON.stringify(['notebook','hub:default']),id=randomUUID();
  const notebooks=new SessionNotebooks(f.db);
  notebooks.save('owner',{resourceId:JSON.stringify(['hub-notebook',1]),revision:0,text:'Keep this native notebook'});
  const before=f.native.get('owner',resource);assert.ok(before);
  const root='/api/hub/v1/workspace/shared-content/'+encodeURIComponent(resource);
  const post={method:'POST',headers:{'content-type':'application/json'},body:'{}'};
  assert.equal(f.coordinator.store.resource('owner',resource),undefined);
  assert.equal((await f.hub.request(root+'/migrations/'+id+'/recover',post)).status,200);
  assert.deepEqual(f.native.get('owner',resource),before);
  assert.equal(f.coordinator.store.resource('owner',resource),undefined);
  assert.equal((await f.hub.request(root+'/migrate',{...post,body:JSON.stringify({requestId:id,revision:before.revision})})).status,409);
  assert.deepEqual(f.native.get('owner',resource),before);
  assert.equal((await f.hub.request(root+'/migrate',{...post,body:JSON.stringify({requestId:randomUUID(),revision:before.revision})})).status,200);
  assert.deepEqual(f.native.get('owner',resource)?.content,before.content);
});

test('migration recovery returns existing exact committed receipt, never labels committed work not-executed',async t=>{
  const f=await fixture(t),rows=f.db.prepare('SELECT mutation FROM v2_content_migrations WHERE owner=?').all('owner');
  const id=String(rows[0]!.mutation),root=`/api/hub/v1/workspace/shared-content/${encodeURIComponent(f.resource)}`;
  const existing=f.coordinator.store.migration('owner',id)!;
  const response=await f.hub.request(root+'/migrations/'+id+'/recover',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  assert.equal(response.status,200);assert.deepEqual(await response.json(),{receipt:existing,termination:null});
  assert.equal(f.coordinator.store.migrationTermination('owner',id),undefined);
  assert.deepEqual(f.coordinator.store.resource('owner',f.resource),f.base);
});

test('batch cancellation atomically rolls back every local revoke when receipt persistence fails',async t=>{
  const f=await fixture(t),original=await f.attach();await f.attach();
  const id=randomUUID();await f.batches.prepare('owner',f.resource,id,{groupId:'dev',tags:[],tagMode:'all'});
  const confirmed=await f.batches.confirm('owner',f.resource,id);
  f.db.exec(`CREATE TRIGGER reject_cancel BEFORE UPDATE ON hub_content_batches
    WHEN json_extract(NEW.payload,'$.state')='cancelled'
    BEGIN SELECT RAISE(ABORT,'injected cancel persistence failure'); END`);
  await assert.rejects(f.batches.cancel('owner',f.resource,id),/injected cancel/);
  assert.equal(f.batches.get('owner',f.resource,id)!.state,confirmed.state);
  for(const member of confirmed.members)assert.equal(f.coordinator.store.bindingRecord('owner',f.resource,member.id)!.revoked,false);
  f.db.exec('DROP TRIGGER reject_cancel');
  assert.equal((await f.batches.cancel('owner',f.resource,id)).state,'cancelled');
  for(const member of confirmed.members)assert.equal(f.coordinator.store.bindingRecord('owner',f.resource,member.id)!.revoked,true);
  assert.equal(f.coordinator.store.bindingRecord('owner',f.resource,original.binding.id)!.revoked,false);
});

test('manual sync coalesces and close waits for its in-flight scan',async t=>{
  const f=await fixture(t);await f.attach();let release!:()=>void,calls=0,closed=false;
  const held=new Promise<void>(resolve=>release=resolve),synchronize=f.coordinator.synchronize.bind(f.coordinator);
  f.coordinator.synchronize=async(...args)=>{calls++;await held;return synchronize(...args);};
  const a=f.coordinator.syncTick(()=>true),b=f.coordinator.syncTick(()=>true);
  assert.equal(a,b);assert.equal(calls,1);
  const closing=f.coordinator.close().then(()=>{closed=true;});
  await Promise.resolve();assert.equal(closed,false);
  await f.coordinator.syncTick(()=>true);assert.equal(calls,1);
  release();await a;await closing;assert.equal(closed,true);
});

test('full-card batch rejects empty selection, reused UUID and changed preview',async t=>{
  const f=await fixture(t);await f.attach();const id=randomUUID(),selection={groupId:'dev',tags:[],tagMode:'all' as const};
  await assert.rejects(f.batches.prepare('owner',f.resource,randomUUID(),{tags:[],tagMode:'all'}),/selection/);
  await f.batches.prepare('owner',f.resource,id,selection);
  await assert.rejects(f.batches.prepare('owner',f.resource,id,{...selection,tags:['shared']}),/batch-reused/);
  f.source.fence=()=>({generation:1,preferencesRevision:0});
  await assert.rejects(f.batches.confirm('owner',f.resource,id),/preview-changed/);
  assert.equal(f.batches.get('owner',f.resource,id)!.state,'prepared');
});

test('full-card batch lost installation ACK recovers only original member',async t=>{
  const f=await fixture(t),a=await f.attach();let installs=0;const install=a.target.transport.install;
  a.target.transport.install=async input=>{installs++;await install(input);throw Error('lost');};
  const id=randomUUID();await f.batches.prepare('owner',f.resource,id,{tags:['shared'],tagMode:'any'});
  assert.equal((await f.batches.confirm('owner',f.resource,id)).members[0]!.state,'unknown');
  assert.equal((await f.batches.confirm('owner',f.resource,id)).members[0]!.state,'installed');assert.equal(installs,1);
});

test('full-card cancel during capability await fences before any durable binding',async t=>{
  const f=await fixture(t),a=await f.attach(),id=randomUUID();let entered!:()=>void,release!:()=>void,installs=0;
  const inside=new Promise<void>(r=>entered=r),held=new Promise<void>(r=>release=r);
  a.target.transport.capability=async()=>{entered();await held;return {protocol:1,available:true};};
  a.target.transport.install=async()=>{installs++;throw Error('must not install');};
  await f.batches.prepare('owner',f.resource,id,{groupId:'dev',tags:[],tagMode:'all'});
  const confirming=f.batches.confirm('owner',f.resource,id);await inside;
  const cancelled=await f.batches.cancel('owner',f.resource,id);release();await confirming;
  assert.equal(cancelled.members[0]!.state,'cancelled');assert.equal(installs,0);
  assert.equal(f.coordinator.store.listBindings('owner',f.resource).length,1);
});

test('maintenance during batch capability discovery blocks installation and recovery never dispatches it',async t=>{
  const f=await fixture(t),a=await f.attach(),id=randomUUID();let entered!:()=>void,release!:()=>void,installs=0;
  const inside=new Promise<void>(r=>entered=r),held=new Promise<void>(r=>release=r);
  a.target.transport.capability=async()=>{entered();await held;return {protocol:1,available:true};};
  a.target.transport.install=async()=>{installs++;throw Error('must not install');};
  await f.batches.prepare('owner',f.resource,id,{groupId:'dev',tags:[],tagMode:'all'});
  const url=`/api/hub/v1/workspace/shared-content/${encodeURIComponent(f.resource)}/batches/${id}`;
  const confirming=f.hub.request(url+'/confirm',{method:'POST'});await inside;
  f.pause();release();assert.equal((await confirming).status,503);
  assert.equal(installs,0);assert.equal(f.coordinator.store.listBindings('owner',f.resource).length,1);
  const inspected=await f.hub.request(url);assert.equal(inspected.status,200);
  assert.equal((await inspected.json()).batch.members[0].state,'unknown');assert.equal(installs,0);
  assert.equal((await f.hub.request(url,{method:'DELETE'})).status,200);
  assert.equal(f.coordinator.store.bindingRecord('owner',f.resource,a.binding.id)!.revoked,false);
});

test('full-card cancel with install in flight retains cleanup until original replica exists',async t=>{
  const f=await fixture(t),a=await f.attach(),id=randomUUID();let entered!:()=>void,release!:()=>void;
  const inside=new Promise<void>(r=>entered=r),held=new Promise<void>(r=>release=r),install=a.target.transport.install;
  a.target.transport.install=async input=>{entered();await held;return install(input);};
  await f.batches.prepare('owner',f.resource,id,{tags:['shared'],tagMode:'all'});
  const confirming=f.batches.confirm('owner',f.resource,id);await inside;
  const cancelled=await f.batches.cancel('owner',f.resource,id);assert.equal(cancelled.members[0]!.state,'cleanup_pending');
  release();await confirming;
  const member=cancelled.members[0]!;assert.equal(f.coordinator.store.listBindings('owner',f.resource).find(b=>b.id===member.id)!.revoked,true);
  assert.equal((await f.batches.cancel('owner',f.resource,id)).members[0]!.state,'cancelled');
  await assert.rejects(f.local.view('owner',member.id),/unavailable/);
});

test('full-card admission refusal leaves preview untouched; expired preview never dispatches',async t=>{
  const f=await fixture(t);await f.attach();let deny=false,now=1;
  const batches=new WorkspaceContentBatches(f.db,f.coordinator,f.source,(_bytes,write)=>{if(deny)throw Error('low-space');return write();},()=>now);
  const id=randomUUID();await batches.prepare('owner',f.resource,id,{tags:['shared'],tagMode:'all'});deny=true;
  await assert.rejects(batches.confirm('owner',f.resource,id),/low-space/);assert.equal(batches.get('owner',f.resource,id)!.state,'prepared');
  deny=false;now+=300001;await assert.rejects(batches.confirm('owner',f.resource,id),/expired/);
  assert.equal((await batches.cancel('owner',f.resource,id)).state,'cancelled');
});

test('full-card simultaneous confirmations retain one dispatch per member',async t=>{
  const f=await fixture(t),a=await f.attach();let installs=0;const install=a.target.transport.install;
  a.target.transport.install=async input=>{installs++;return install(input);};const id=randomUUID();
  await f.batches.prepare('owner',f.resource,id,{tags:['shared'],tagMode:'all'});
  const other=new WorkspaceContentBatches(f.db,f.second(),f.source);
  await Promise.all([f.batches.confirm('owner',f.resource,id),other.confirm('owner',f.resource,id)]);
  assert.equal(installs,1);assert.equal((await f.batches.inspect('owner',f.resource,id)).members[0]!.state,'installed');
});

for (const change of ['request', 'member', 'generation', 'preferences', 'head', 'expired', 'cancelled'] as const) {
  test(`async full-card admission rechecks ${change} before claim and never dispatches early`, async t => {
    const f = await fixture(t), attached = await f.attach();
    let hold = false, permitted = true, memberCurrent = true, generation = 0, preferencesRevision = 0, now = 1, installs = 0;
    let entered!: () => void, release!: () => void;
    const inside = new Promise<void>(resolve => { entered = resolve; });
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const source: DelegationCatalogSource = { ...f.source,
      fence: () => ({ generation, preferencesRevision }),
      authorized: (owner, member) => memberCurrent && f.source.authorized(owner, member) };
    const batches = new WorkspaceContentBatches(f.db, f.coordinator, source, async (_bytes, write) => {
      if (hold) { entered(); await waiting; }
      return write();
    }, () => now);
    const install = attached.target.transport.install;
    attached.target.transport.install = async input => { installs++; return install(input); };
    const id = randomUUID();
    await batches.prepare('owner', f.resource, id, { tags: ['shared'], tagMode: 'all' });
    hold = true;
    const flight = batches.confirm('owner', f.resource, id, () => { if (!permitted) throw Error('request revoked'); });
    const outcome = flight.then(value => ({ value }), error => ({ error }));
    try {
      await inside;
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(installs, 0, 'a pending admission Promise is not a successful durable claim');
      assert.equal(batches.get('owner', f.resource, id)!.state, 'prepared');
      if (change === 'request') permitted = false;
      if (change === 'member') memberCurrent = false;
      if (change === 'generation') generation++;
      if (change === 'preferences') preferencesRevision++;
      if (change === 'expired') now += 300001;
      if (change === 'head') {
        const head = f.coordinator.store.resource('owner', f.resource)!;
        f.coordinator.store.write('owner', f.resource, { mutationId: randomUUID(), modeEpoch: head.epoch,
          baseRevision: head.revision, baseHash: head.hash, content: JSON.stringify({ kind: 'taskboard', content: { title: 'changed', tasks: [] } }) });
      }
      if (change === 'cancelled') assert.equal((await batches.cancel('owner', f.resource, id)).state, 'cancelled');
      release();
      const result = await outcome;
      if (change === 'cancelled') {
        assert.ok('value' in result); assert.equal(result.value!.state, 'cancelled');
      } else {
        assert.ok('error' in result, 'stale admission must reject rather than confirm');
        assert.equal(batches.get('owner', f.resource, id)!.state, 'prepared');
      }
      assert.equal(installs, 0);
      assert.equal(f.coordinator.store.listBindings('owner', f.resource).length, 1, 'no new binding intent');
    } finally { release(); await outcome; }
  });
}

for (const change of ['request', 'catalog', 'head'] as const) {
  test(`async full-card prepare refuses stale ${change} after storage wait`, async t => {
    const f = await fixture(t); await f.attach();
    let permitted = true, generation = 0;
    let entered!: () => void, release!: () => void;
    const inside = new Promise<void>(resolve => { entered = resolve; });
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const source: DelegationCatalogSource = { ...f.source, fence: () => ({ generation, preferencesRevision: 0 }) };
    const batches = new WorkspaceContentBatches(f.db, f.coordinator, source, async (_bytes, write) => {
      entered(); await waiting; return write();
    });
    const id = randomUUID();
    const flight = batches.prepare('owner', f.resource, id, { tags: ['shared'], tagMode: 'all' },
      () => { if (!permitted) throw Error('request revoked'); });
    const outcome = flight.then(value => ({ value }), error => ({ error }));
    try {
      await inside;
      assert.equal(batches.get('owner', f.resource, id), undefined);
      if (change === 'request') permitted = false;
      if (change === 'catalog') generation++;
      if (change === 'head') {
        const head = f.coordinator.store.resource('owner', f.resource)!;
        f.coordinator.store.write('owner', f.resource, { mutationId: randomUUID(), modeEpoch: head.epoch,
          baseRevision: head.revision, baseHash: head.hash, content: JSON.stringify({ kind: 'taskboard', content: { title: 'changed', tasks: [] } }) });
      }
      release(); assert.ok('error' in await outcome);
      assert.equal(batches.get('owner', f.resource, id), undefined, 'no stale preview persisted');
    } finally { release(); await outcome; }
  });
}

test('background pages bound four bindings and wrap fairly; disabled and closed do no work',async t=>{
  const f=await fixture(t);for(let i=0;i<6;i++)await f.attach();const seen:string[]=[];
  f.coordinator.synchronize=async(_o,_r,id)=>{seen.push(id);return f.coordinator.store.listBindings('owner',f.resource).find(b=>b.id===id)!;};
  await f.coordinator.syncTick(()=>false);assert.equal(seen.length,0);
  await f.coordinator.syncTick(()=>true);assert.equal(seen.length,4);
  await f.coordinator.syncTick(()=>true);assert.equal(new Set(seen).size,6);
  await f.coordinator.syncTick(()=>true);assert.equal(seen.length,10);
  await f.coordinator.close();await f.coordinator.syncTick(()=>true);assert.equal(seen.length,10);
});

test('native migration through two session replicas converges without echo proposals',async t=>{
  const f=await fixture(t),a=await f.attach(),b=await f.attach();
  await f.edit(a.path,'Shared edit');
  assert.equal((await f.coordinator.synchronize('owner',f.resource,a.binding.id)).acknowledgedRevision,1);
  assert.equal((await f.coordinator.synchronize('owner',f.resource,b.binding.id)).acknowledgedRevision,1);
  assert.equal(await f.title(b.path),'Shared edit');
  await f.coordinator.synchronize('owner',f.resource,b.binding.id);
  assert.equal(f.local.proposals('owner',b.binding.id).length,0);
  assert.equal(f.coordinator.store.resource('owner',f.resource)!.revision,1);
});

test('lost installation ACK is recovered by view without reinstall',async t=>{
  const f=await fixture(t);let installs=0;
  const a=await f.attach(remote=>{const install=remote.install;remote.install=async input=>{installs++;await install(input);throw Error('lost ACK');};});
  assert.equal(a.binding.acknowledgedRevision,-1);
  const binding=await f.coordinator.bind('owner',f.resource,a.input);
  assert.equal(binding.acknowledgedRevision,0);assert.equal(installs,1);
  await assert.rejects(f.coordinator.bind('owner',f.resource,{...a.input,revision:1}),/binding-reused/);
});

test('lost claim stays unknown and a second host cannot resubmit',async t=>{
  const f=await fixture(t),a=await f.attach();let claims=0;
  const claim=a.target.transport.claim;a.target.transport.claim=async(id,mutation)=>{claims++;await claim(id,mutation);throw Error('lost claim');};
  await f.edit(a.path,'Claim lost');
  await assert.rejects(f.coordinator.synchronize('owner',f.resource,a.binding.id),/lost claim/);
  await f.second().synchronize('owner',f.resource,a.binding.id);
  assert.equal(claims,1);assert.equal(f.coordinator.store.resource('owner',f.resource)!.revision,0);
  assert.equal(f.local.proposals('owner',a.binding.id)[0]!.state,'unknown');
});

test('lost settlement is recovered from original proposal, never a new mutation',async t=>{
  const f=await fixture(t),a=await f.attach();
  const settle=a.target.transport.settle;a.target.transport.settle=async()=>{throw Error('lost settlement');};
  await f.edit(a.path,'Receipt recovery');
  await assert.rejects(f.coordinator.synchronize('owner',f.resource,a.binding.id),/lost settlement/);
  a.target.transport.settle=settle;
  await f.second().synchronize('owner',f.resource,a.binding.id);
  assert.equal(f.coordinator.store.resource('owner',f.resource)!.revision,1);
  assert.equal(f.local.proposals('owner',a.binding.id).length,1);
  assert.equal(f.local.proposals('owner',a.binding.id)[0]!.state,'committed');
});

test('lost projection ACK recovers only original file receipt',async t=>{
  const f=await fixture(t),a=await f.attach(),b=await f.attach();let writes=0,reads=0;
  const project=b.target.transport.project,receipt=b.target.transport.projectionReceipt;
  b.target.transport.project=async(id,job)=>{writes++;await project(id,job);throw Error('lost projection');};
  b.target.transport.projectionReceipt=async(id,job)=>{reads++;return receipt(id,job);};
  await f.edit(a.path,'Projected');await f.coordinator.synchronize('owner',f.resource,a.binding.id);
  await assert.rejects(f.coordinator.synchronize('owner',f.resource,b.binding.id),/lost projection/);
  assert.equal((await f.second().synchronize('owner',f.resource,b.binding.id)).acknowledgedRevision,1);
  assert.equal(writes,1);assert.equal(reads,1);assert.equal(await f.title(b.path),'Projected');
});

test('unknown projection without connector intent is not dispatched again',async t=>{
  const f=await fixture(t),a=await f.attach(),b=await f.attach();let writes=0;
  b.target.transport.project=async()=>{writes++;throw Error('lost before dispatch');};
  await f.edit(a.path,'Remote');await f.coordinator.synchronize('owner',f.resource,a.binding.id);
  await assert.rejects(f.coordinator.synchronize('owner',f.resource,b.binding.id));
  await f.second().synchronize('owner',f.resource,b.binding.id);
  assert.equal(writes,1);assert.notEqual(await f.title(b.path),'Remote');
});

test('concurrent file edits retain conflict instead of overwriting either draft',async t=>{
  const f=await fixture(t),a=await f.attach(),b=await f.attach();
  await f.edit(a.path,'A');await f.edit(b.path,'B');
  await f.coordinator.synchronize('owner',f.resource,a.binding.id);
  await f.coordinator.synchronize('owner',f.resource,b.binding.id);
  assert.equal(f.local.proposals('owner',b.binding.id)[0]!.state,'conflict');
  assert.equal(await f.title(b.path),'B');assert.equal(await f.title(a.path),'A');
});

test('authority replacement during await rejects stale reply before any proposal',async t=>{
  const f=await fixture(t),a=await f.attach();const view=a.target.transport.view;
  a.target.transport.view=async id=>{const result=await view(id);f.targets.set(a.target.sessionId,{...a.target,authority:1});return result;};
  await f.edit(a.path,'No stale authority');
  await assert.rejects(f.coordinator.synchronize('owner',f.resource,a.binding.id),/forbidden/);
  assert.equal(f.coordinator.store.resource('owner',f.resource)!.revision,0);
});

test('revocation fences immediately even when connector cleanup loses ACK',async t=>{
  const f=await fixture(t),a=await f.attach();a.target.transport.revoke=async()=>{throw Error('lost cleanup');};
  await assert.rejects(f.coordinator.revoke('owner',f.resource,a.binding.id),/lost cleanup/);
  await assert.rejects(f.coordinator.synchronize('owner',f.resource,a.binding.id),/binding-unavailable/);
  assert.equal(f.coordinator.store.bindingRecord('owner',f.resource,a.binding.id)!.revoked,true);
  assert.equal(typeof await f.title(a.path),'string');
});

test('status alias shares native head and kind-changing proposals are rejected',async t=>{
  const f=await fixture(t),a=await f.attach();
  assert.equal(f.coordinator.resourceId(JSON.stringify(['statuscard','default'])),f.resource);
  await f.edit(a.path,'Edit');const local=(await f.local.observe('owner',a.binding.id))!;
  assert.throws(()=>f.coordinator.store.propose('owner',f.resource,{...local.proposal,
    content:JSON.stringify({kind:'notebook',content:{title:'Wrong kind',text:''}})}),/card-kind-or-schema/);
  assert.equal(f.coordinator.store.resource('owner',f.resource)!.revision,0);
});

test('delayed installation proves its pinned base then catches up via outbox',async t=>{
  const f=await fixture(t),a=await f.attach();
  const b=await f.attach(remote=>{const install=remote.install;remote.install=async input=>{
    const proof=await install(input);
    await f.edit(a.path,'Advanced during install');await f.coordinator.synchronize('owner',f.resource,a.binding.id);
    return proof;
  };});
  assert.equal(b.binding.acknowledgedRevision,0);
  assert.equal((await f.coordinator.synchronize('owner',f.resource,b.binding.id)).acknowledgedRevision,1);
  assert.equal(await f.title(b.path),'Advanced during install');
});

test('owner can revoke an offline binding without cleaning a replacement connection',async t=>{
  const f=await fixture(t),a=await f.attach();let cleanups=0;
  a.target.transport.revoke=async()=>{cleanups++;};
  f.targets.set(a.target.sessionId,{...a.target,connectionId:randomUUID()});
  assert.deepEqual(await f.coordinator.revoke('owner',f.resource,a.binding.id),{revoked:true,cleanup:'unavailable'});
  assert.equal(cleanups,0);
  const b=await f.attach();f.deny();
  assert.deepEqual(await f.coordinator.revoke('owner',f.resource,b.binding.id),{revoked:true,cleanup:'unavailable'});
  assert.equal(cleanups,0);
});

test('HTTP transport performs migration/install/proposal/projection and scoped revoke',async t=>{
  const f=await fixture(t,true),a=await f.attach(),b=await f.attach();
  assert.equal(a.binding.acknowledgedRevision,0);
  await f.edit(a.path,'Over HTTP');await f.coordinator.synchronize('owner',f.resource,a.binding.id);
  await f.coordinator.synchronize('owner',f.resource,b.binding.id);
  assert.equal(await f.title(b.path),'Over HTTP');
  assert.deepEqual(await f.coordinator.revoke('owner',f.resource,b.binding.id),{revoked:true,cleanup:'confirmed'});
});

test('HTTP protocol rejects missing scope, foreign owner, malformed proof and query credentials',async t=>{
  const f=await fixture(t,true),a=await f.attach();
  const base='/api/connector/v1/workspace/content-replicas';
  const request=(path:string,token:string,init?:RequestInit)=>f.app.request(path,{...init,headers:{authorization:`Bearer ${token}`}});
  assert.equal((await f.app.request(base)).status,401);
  const reader=f.tokens.createTransient(['files:read'],'reader'),other=f.tokens.createTransient(['boards:files'],'other');
  assert.equal((await request(base,reader.token)).status,403);
  assert.equal((await request(`${base}/${a.binding.id}`,other.token)).status,409);
  assert.equal((await request(`${base}?token=not-a-credential`,f.ownerToken.token)).status,400);
  const invalid=await request(`${base}/${a.binding.id}/proposals/${randomUUID()}/receipt`,f.ownerToken.token,{method:'POST',body:'{}'});
  assert.equal(invalid.status,400);assert.equal(invalid.headers.get('cache-control'),'no-store');
  assert.equal((await request(`${base}/${a.binding.id}/project`,f.ownerToken.token,{method:'POST',body:'null'})).status,400);
});

test('maintenance blocks fresh work but leaves original reads and revocation available',async t=>{
  const f=await fixture(t,true),a=await f.attach();f.pause();
  assert.equal((await a.target.transport.view(a.binding.id)).base.revision,0);
  await assert.rejects(a.target.transport.observe(a.binding.id),/503/);
  assert.deepEqual(await f.coordinator.revoke('owner',f.resource,a.binding.id),{revoked:true,cleanup:'confirmed'});
});

test('unavailable capability does not leave an unconfirmed binding',async t=>{
  const f=await fixture(t,true);f.pause();
  await assert.rejects(f.attach(),/capability-or-authority/);
  assert.equal(f.db.prepare('SELECT count(*) n FROM v2_proposal_bindings').get()!.n,0);
});

test('HTTP conflict resolution preserves originals and converges the chosen local draft',async t=>{
  const f=await fixture(t,true),a=await f.attach(),b=await f.attach();
  await f.edit(a.path,'A');await f.edit(b.path,'B');
  await f.coordinator.synchronize('owner',f.resource,a.binding.id);
  await f.coordinator.synchronize('owner',f.resource,b.binding.id);
  const [conflict]=await f.coordinator.conflicts('owner',f.resource,b.binding.id);assert.ok(conflict);
  assert.equal(JSON.parse(conflict.remote.content).content.title,'A');
  const input={conflictId:conflict.local.proposal.mutationId,mutationId:randomUUID(),expectedHash:conflict.actualHash!};
  const replacement=await f.coordinator.resolveConflict('owner',f.resource,b.binding.id,input);
  assert.equal(replacement.state,'prepared');
  assert.deepEqual(await f.coordinator.resolveConflict('owner',f.resource,b.binding.id,input),replacement);
  await f.coordinator.synchronize('owner',f.resource,b.binding.id);
  await f.coordinator.synchronize('owner',f.resource,a.binding.id);
  assert.equal(await f.title(a.path),'B');assert.equal(await f.title(b.path),'B');
  assert.equal(f.local.proposals('owner',b.binding.id)[0]!.state,'conflict');
  assert.deepEqual(await f.coordinator.conflicts('owner',f.resource,b.binding.id),[]);
});

test('historical conflict resolution does not overwrite a newer head',async t=>{
  const f=await fixture(t,true),a=await f.attach(),b=await f.attach();
  await f.edit(a.path,'A');await f.edit(b.path,'B');
  await f.coordinator.synchronize('owner',f.resource,a.binding.id);
  await f.coordinator.synchronize('owner',f.resource,b.binding.id);
  await f.edit(a.path,'A newer');await f.coordinator.synchronize('owner',f.resource,a.binding.id);
  const [conflict]=await f.coordinator.conflicts('owner',f.resource,b.binding.id);assert.ok(conflict);
  assert.equal(JSON.parse(conflict.remote.content).content.title,'A');
  await f.coordinator.resolveConflict('owner',f.resource,b.binding.id,{conflictId:conflict.local.proposal.mutationId,
    mutationId:randomUUID(),expectedHash:conflict.actualHash!});
  await f.coordinator.synchronize('owner',f.resource,b.binding.id);
  assert.equal(f.local.proposals('owner',b.binding.id)[1]!.state,'conflict');
  assert.equal(await f.title(a.path),'A newer');assert.equal(await f.title(b.path),'B');
});

test('owner CAS editor projects changes and recovers only the immutable original receipt',async t=>{
  const f=await fixture(t,true),a=await f.attach();
  const content=JSON.stringify({kind:'taskboard',content:{title:'Owner edit',tasks:[]}});
  const input={mutationId:randomUUID(),modeEpoch:f.base.epoch,baseRevision:0,baseHash:f.base.hash,content};
  const receipt=f.coordinator.store.write('owner',f.resource,input);assert.equal(receipt.state,'committed');
  await f.coordinator.synchronize('owner',f.resource,a.binding.id);assert.equal(await f.title(a.path),'Owner edit');
  assert.deepEqual(f.coordinator.store.write('owner',f.resource,input),receipt);
  assert.throws(()=>f.coordinator.store.write('owner',f.resource,{...input,content:content.replace('Owner edit','changed')}),/mutation-reused/);
  assert.equal(f.coordinator.store.ownerReceipt('other',f.resource,f.base.epoch,input.mutationId),undefined);
  const conflict=f.coordinator.store.write('owner',f.resource,{...input,mutationId:randomUUID()});assert.equal(conflict.state,'conflict');
  assert.equal(f.coordinator.store.resource('owner',f.resource)!.revision,1);
});

test('Hub HTTP owner editor validates scope and supports original receipt reads during maintenance',async t=>{
  const f=await fixture(t,true),root=`/api/hub/v1/workspace/shared-content/${encodeURIComponent(f.resource)}`;
  const input={mutationId:randomUUID(),modeEpoch:f.base.epoch,baseRevision:0,baseHash:f.base.hash,
    content:JSON.stringify({kind:'taskboard',content:{title:'HTTP owner edit',tasks:[]}})};
  assert.equal((await f.hub.request(root+'/document',{method:'PUT',body:JSON.stringify({...input,owner:'other'})})).status,400);
  assert.equal((await f.hub.request(root+'/document',{method:'PUT',headers:{'x-test-owner':'other'},body:JSON.stringify(input)})).status,409);
  const response=await f.hub.request(root+'/document',{method:'PUT',body:JSON.stringify(input)});assert.equal(response.status,200);
  const receipt=(await response.json()).receipt;assert.equal(receipt.state,'committed');
  f.pause();
  assert.equal((await f.hub.request(root+'/document',{method:'PUT',body:JSON.stringify({...input,mutationId:randomUUID()})})).status,503);
  assert.deepEqual(await (await f.hub.request(root+`/writes/${input.modeEpoch}/${input.mutationId}`)).json(),{receipt,termination:null});
  assert.deepEqual(await (await f.hub.request(root+`/writes/${input.modeEpoch}/${input.mutationId}`,{headers:{'x-test-owner':'other'}})).json(),{receipt:null,termination:null});
  assert.equal((await f.hub.request(root+'?owner=other')).status,400);
});

test('Hub HTTP safely terminates an absent owner write; GET remains read-only and late PUT rejected',async t=>{
  const f=await fixture(t,true),root=`/api/hub/v1/workspace/shared-content/${encodeURIComponent(f.resource)}`;
  const id=randomUUID(),path=`/writes/${f.base.epoch}/${id}`,post={method:'POST',headers:{'content-type':'application/json'},body:'{}'};
  assert.deepEqual(await (await f.hub.request(root+path)).json(),{receipt:null,termination:null});
  assert.equal(f.coordinator.store.writeTermination('owner',f.resource,f.base.epoch,id),undefined);
  assert.equal((await f.hub.request(root+path+'/recover',{...post,body:'{"overwrite":true}'})).status,400);
  assert.equal((await f.hub.request(root+path+'/recover',{...post,headers:{...post.headers,'x-test-owner':'other'}})).status,409);
  const response=await f.hub.request(root+path+'/recover',post);assert.equal(response.status,200);
  const proof=await response.json();assert.deepEqual(proof,{receipt:null,termination:{mutationId:id,resource:f.resource,epoch:f.base.epoch,state:'not-executed'}});
  assert.deepEqual(await (await f.hub.request(root+path)).json(),proof);
  const input={mutationId:id,modeEpoch:f.base.epoch,baseRevision:0,baseHash:f.base.hash,content:f.base.content};
  assert.equal((await f.hub.request(root+'/document',{method:'PUT',body:JSON.stringify(input)})).status,409);
  assert.deepEqual(f.coordinator.store.resource('owner',f.resource),f.base);
  f.pause();assert.equal((await f.hub.request(root+`/writes/${f.base.epoch}/${randomUUID()}/recover`,post)).status,503);
  assert.deepEqual(await (await f.hub.request(root+path)).json(),proof);
});

test('Hub HTTP binds and synchronizes only an owned session, and revoked grants stay revoked',async t=>{
  const f=await fixture(t,true),a=await f.attach(),root=`/api/hub/v1/workspace/shared-content/${encodeURIComponent(f.resource)}`;
  const path=`${root}/bindings/${a.binding.id}`;
  await f.edit(a.path,'from session');
  assert.equal((await f.hub.request(path+'/sync',{method:'POST',headers:{'x-test-owner':'other'}})).status,409);
  assert.equal((await f.hub.request(path+'/sync',{method:'POST'})).status,200);
  assert.equal(JSON.parse((await (await f.hub.request(root)).json()).head.content).content.title,'from session');
  f.pause();assert.equal((await f.hub.request(path,{method:'DELETE'})).status,200);
  assert.equal((await f.hub.request(path)).status,409);
});
