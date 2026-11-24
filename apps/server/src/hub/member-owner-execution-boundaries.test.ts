import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Worker } from 'node:worker_threads';
import type { DatabaseSync } from 'node:sqlite';
import { HubStore } from './hub-store.js';
import { HubExecutionLeases } from './execution-leases.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { AsyncHubExecutionLeases } from './async-execution-leases.js';
import { executeHubExecutionLeaseCommand, observeHubExecutionLeaseCommand, executionLeaseOwnerSteps, type HubExecutionLeaseCommand } from './member-execution-lease-domain.js';
import { PerformanceDiagnostics, performanceDiagnostics } from '../diagnostics/performance.js';
const quiet=new PerformanceDiagnostics(()=>{});
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
const held=()=>{let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};};
class FakeWorker extends EventEmitter {
  messages: {id:number;kind:string;body:string}[]=[];
  stops=0;
  postMessage(v:{id:number;kind:string;body:string}) {this.messages.push(v);}
  terminate() {this.stops++;return Promise.resolve(1);}
  ready() {this.emit('message',{kind:'ready'});}
  reply(i:number,value:unknown) {const m=this.messages[i]!;this.emit('message',{id:m.id,kind:m.kind,ok:true,body:JSON.stringify(value)});}
}
function fixture(file=':memory:') {
  const store=new HubStore(file,'synthetic-vault');
  const user=store.createUser('Recipient'),nodeId='node_'+randomUUID();
  store.upsertConnection({id:'node',kind:'remote',label:'Fixture',connectorUrl:'http://private.invalid'});
  store.pinConnectionNode('node','default',store.connectionAuthority('node','default')!,nodeId);
  const target={ownerUserId:'default',connectionId:'node',userId:user.id};
  const resource={runtime:'codex' as const,sessionKey:'codex:fixture/空 格'};
  const actions=['messages:send'] as const;
  const grant=store.grants.create(target,{...resource,actions:[...actions]});
  const proof=store.grants.authorize(target,'messages:send',resource,grant.id)!;
  const db=(store as unknown as {db:DatabaseSync}).db;
  return {store,db,proof,nodeId,actions};
}
test('execution owner retains close and file reservation until original ACK and actual exit',async()=>{
  const fake=new FakeWorker(),file=join(tmpdir(),'execution-fake-'+randomUUID()+'.sqlite'),logs:string[]=[];
  const owner=new AsyncHubMemberOwner({file},new PerformanceDiagnostics(line=>logs.push(line)),()=>fake as unknown as Worker,5);
  const leases=new AsyncHubExecutionLeases(owner);fake.ready();await owner.open();
  const request=leases.get(999);await tick();
  const close=owner.close();let closed=false;void close.then(()=>{closed=true;},()=>{closed=true;});
  try {
    await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal(fake.messages.length,1);assert.equal(fake.stops,0);assert.equal(closed,false);
    assert.equal(owner.snapshot().accepted,1);assert.ok(logs.some(l=>JSON.parse(l).phase==='pending'));
    assert.throws(()=>new AsyncHubMemberOwner({file},quiet,()=>new FakeWorker() as unknown as Worker));
    fake.reply(0,{action:'get',lease:null});assert.equal(await request,undefined);await tick();
    assert.equal(fake.messages[1]!.kind,'close');fake.reply(1,null);await tick();
    assert.equal(closed,false);assert.equal(owner.snapshot().ownerExitConfirmed,false);
    assert.throws(()=>new AsyncHubMemberOwner({file},quiet,()=>new FakeWorker() as unknown as Worker));
    fake.emit('exit',0);await close;assert.equal(owner.snapshot().ownerExitConfirmed,true);
  } finally {if(!owner.snapshot().ownerExitConfirmed)fake.emit('exit',0);await close.catch(()=>{});}
});
test('wrong execution reply fences unknown effects without SQL replay or early file release',async()=>{
  const f=fixture(),fake=new FakeWorker(),file=join(tmpdir(),'execution-bad-reply-'+randomUUID()+'.sqlite');
  const owner=new AsyncHubMemberOwner({file},quiet,()=>fake as unknown as Worker);fake.ready();await owner.open();
  let close:Promise<void>|undefined;
  try {
    const lease=f.store.executionLeases.reserve(f.proof,f.nodeId,'issuer',[...f.actions]);
    const request=new AsyncHubExecutionLeases(owner).get(lease.id+1),rejected=assert.rejects(request);
    await tick();fake.reply(0,{action:'get',lease});await rejected;
    assert.equal(owner.snapshot().unavailable,true);assert.equal(fake.messages.length,1);assert.equal(fake.stops,0);
    await assert.rejects(owner.command('executionLease',{action:'get',id:lease.id}));assert.equal(fake.messages.length,1);
    close=owner.close();const rejectedClose=assert.rejects(close);await tick();
    assert.equal(fake.stops,1);assert.equal(owner.snapshot().ownerExitConfirmed,false);
    assert.throws(()=>new AsyncHubMemberOwner({file},quiet,()=>new FakeWorker() as unknown as Worker));
    fake.emit('exit',1);await rejectedClose;assert.equal(fake.messages.length,1);
  } finally {if(!owner.snapshot().ownerExitConfirmed)fake.emit('exit',1);await close?.catch(()=>{});await f.store.close();}
});
test('execution facade rejects getters and proxies without invoking caller code or dispatch',async()=>{
  let calls=0,reads=0;
  const facade=new AsyncHubExecutionLeases({command:async()=>{calls++;throw Error('unexpected');}} as unknown as Pick<AsyncHubMemberOwner,'command'>);
  const f=fixture();
  try {
    const accessor={...f.proof};Object.defineProperty(accessor,'userId',{enumerable:true,get(){reads++;return 'bad';}});
    await assert.rejects(facade.reserve(accessor,f.nodeId,'issuer',[...f.actions]));
    const proxy=new Proxy(f.proof,{ownKeys(){reads++;return [];},getPrototypeOf(){reads++;return null;}});
    await assert.rejects(facade.reserve(proxy,f.nodeId,'issuer',[...f.actions]));
    assert.equal(reads,0);assert.equal(calls,0);
  } finally {await f.store.close();}
});
test('execution usage domain yields outside transaction and revalidates original rows after admission',async()=>{
  const f=fixture(),gate=held();let callbacks=0;
  const leases=new HubExecutionLeases(f.db,f.store.grants,Date.now,10000,quiet,async(_,write)=>{await gate.promise;callbacks++;return write();});
  const l=leases.reserve(f.proof,f.nodeId,'issuer',[...f.actions]);
  leases.acknowledgeIssue(l.id,{id:randomUUID(),actorId:'actor_'+'a'.repeat(64)},l.expiresAt);
  f.db.prepare('UPDATE hub_execution_leases SET usage_pending=1 WHERE id=?').run(l.id);
  const request=executeHubExecutionLeaseCommand(f.db,leases,{action:'usageDue',limit:1}),rejected=assert.rejects(request);
  try {
    await tick();assert.equal(f.db.isTransaction,false);
    f.db.prepare('UPDATE hub_execution_leases SET proof=? WHERE id=?').run('{}',l.id);
    gate.release();await rejected;assert.equal(callbacks,1);assert.equal(f.db.isTransaction,false);
    assert.equal(f.db.prepare('SELECT usage_after FROM hub_execution_leases WHERE id=?').get(l.id)!.usage_after,0);
    f.db.prepare('UPDATE hub_execution_leases SET proof=? WHERE id=?').run(JSON.stringify(f.proof),l.id);
    const recovered=await executeHubExecutionLeaseCommand(f.db,leases,{action:'usageDue',limit:1});
    assert.ok('page' in recovered);assert.equal(recovered.page.length,1);
  } finally {gate.release();await request.catch(()=>{});await f.store.close();}
});
test('execution domain logs fixed action steps and throwing observation cannot change effects',async t=>{
  const logs:string[]=[],diagnostics=new PerformanceDiagnostics(line=>logs.push(line),()=>1000);
  t.mock.method(performanceDiagnostics,'start',diagnostics.start.bind(diagnostics));
  const f=fixture();
  try {
    assert.deepEqual(Object.values(executionLeaseOwnerSteps),Array.from({length:11},(_,i)=>52+i));
    const commands:HubExecutionLeaseCommand[]=[{action:'get',id:999},{action:'authorized',proof:f.proof,actions:[...f.actions]},
      {action:'reserve',proof:f.proof,nodeId:f.nodeId,issuerId:'issuer',actions:[...f.actions]}];
    for(const c of commands)await observeHubExecutionLeaseCommand(f.db,f.store.executionLeases,c);
    for(const c of commands)assert.ok(logs.some(l=>{const row=JSON.parse(l);return row.operation==='hub-member-sqlite-owner'&&row.step===executionLeaseOwnerSteps[c.action]&&row.settled===1;}));
    assert.equal(logs.some(l=>/private\.invalid|fixture\/|node_|actor_|SELECT|INSERT/.test(l)),false);
    t.mock.method(performanceDiagnostics,'start',()=>{throw Error('sink fault');});
    const result=await observeHubExecutionLeaseCommand(f.db,f.store.executionLeases,{action:'get',id:999});
    assert.deepEqual(result,{action:'get',lease:null});
  } finally {await f.store.close();}
});
