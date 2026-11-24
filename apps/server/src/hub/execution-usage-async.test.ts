import assert from 'node:assert/strict';
import test from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {HubExecutionUsage, type ExecutionUsagePersistence} from './execution-usage.js';
import type {ExecutionLease} from './execution-leases.js';
import {PerformanceDiagnostics} from '../diagnostics/performance.js';

function gate() { let release!: () => void; const promise = new Promise<void>(r => {release=r;}); return {promise,release}; }
function fixture(options: {pause?: string; authorized?: boolean; needed?: boolean; expireDuringAuthority?: boolean; diagnostics?: PerformanceDiagnostics}={}) {
  const entered=gate(), original=gate(), calls:string[]=[], logs:string[]=[];
  let now=1000, probes=0, renewals=0, checks=0;
  const lease={id:1,state:'active',expiresAt:21_000,ref:{id:'synthetic-private-ref'},nodeId:'node',issuerId:'synthetic-private-issuer',
    proof:{ownerUserId:'owner',connectionId:'connection',nodeVersion:1},actions:['messages:send']} as unknown as ExecutionLease;
  async function run<T>(method:string,result:T) {calls.push(method);if(options.pause===method){entered.release();await original.promise;calls.push(method+':settled');}return result;}
  const leases:ExecutionUsagePersistence={
    usageDueAsync:()=>run('page',[{lease,version:1}]),
    get:()=>run('get',lease),
    authorized:async()=>{const accepted=await run(++checks===1?'authorized':'authorizedAgain',options.authorized??true);if(options.expireDuringAuthority)now=30_000;return accepted;},
    revoke:()=>run('revoke',undefined),
    usageQuiet:()=>run('quiet',false),
  };
  const diagnostics=options.diagnostics??new PerformanceDiagnostics(line=>logs.push(line));
  const client = {expectedNodeId:'node',json:async()=>{
    probes++;return {nodeId:'node',hubId:'hub',issuerTokenId:lease.issuerId,usage:[{id:lease.ref!.id,needed:options.needed??true}]};
  }};
  const usage=new HubExecutionUsage(leases,'hub',{synchronize:async()=>{renewals++;return lease;}},()=>options.pause==='clientFor'
    ?run('clientFor',client as never):client as never,()=>now,diagnostics);
  return {usage,lease,leases,calls,logs,entered,original,probes:()=>probes,renewals:()=>renewals};
}

for(const pause of ['page','clientFor','authorized','get','authorizedAgain','quiet','revoke'])
test(`usage async ${pause}: original settlement retained and shutdown starts no follow-up work`,async()=>{
  const f=fixture({pause,needed:pause!=='quiet',authorized:pause!=='revoke'});
  const operation=f.usage.reconcile();
  // Outer admission failures reject; per-task failures retain durable demand.
  const done=operation.then(()=>undefined,error=>{assert.match(String(error),/closed/);});
  await f.entered.promise;const probes=f.probes(),renewals=f.renewals();let closed=false;
  const closing=f.usage.close().then(()=>{closed=true;});await delay(0);assert.equal(closed,false);
  await assert.rejects(f.usage.reconcile(),/closed/);assert.equal(f.probes(),probes);assert.equal(f.renewals(),renewals);
  f.original.release();await done;await closing;
  assert.ok(f.calls.includes(pause+':settled'));assert.equal(f.probes(),probes);assert.equal(f.renewals(),renewals);
});

test('Promise false authorization is not truthy and cannot cause usage HTTP or lease renewal',async()=>{
  const f=fixture({authorized:false});
  try {assert.deepEqual(await f.usage.reconcile(),{examined:1});assert.equal(f.probes(),0);assert.equal(f.renewals(),0);assert.ok(f.calls.includes('revoke'));}
  finally{await f.usage.close();}
});
test('sync lookup with async false authorization cannot probe or renew',async()=>{
  const f=fixture({authorized:false});f.leases.get=()=>f.lease;f.leases.revoke=()=>undefined;
  try{await f.usage.reconcile();assert.equal(f.probes(),0);assert.equal(f.renewals(),0);}
  finally{await f.usage.close();}
});
test('lease expiry while awaiting authority is checked again before probing or renewing',async()=>{
  const f=fixture({expireDuringAuthority:true});
  try{await f.usage.reconcile();assert.equal(f.probes(),0);assert.equal(f.renewals(),0);assert.ok(f.calls.includes('revoke'));}
  finally{await f.usage.close();}
});
test('quiet CAS false is settled once and never converted into a retry or renewal',async()=>{
  const f=fixture({needed:false});
  try{await f.usage.reconcile();assert.equal(f.calls.filter(c=>c==='quiet').length,1);assert.equal(f.probes(),1);assert.equal(f.renewals(),0);}
  finally{await f.usage.close();}
});
for(const failure of ['start','clock','sink'] as const)
test(`usage diagnostics ${failure} cannot change original reconciliation`,async()=>{
  const diagnostics=new PerformanceDiagnostics(()=>{if(failure==='sink')throw Error('private');},()=>{if(failure==='clock')throw Error('private');return performance.now();});
  if(failure==='start')diagnostics.start=()=>{throw Error('private');};
  const f=fixture({diagnostics});
  try{assert.deepEqual(await f.usage.reconcile(),{examined:1});assert.equal(f.probes(),1);assert.equal(f.renewals(),1);}
  finally{await f.usage.close();}
});
test('usage settled logs do not expose private references or issuer bindings',async()=>{
  const f=fixture();
  try{await f.usage.reconcile();assert.equal(f.logs.some(line=>line.includes('synthetic-private')),false);assert.ok(f.logs.map(line=>JSON.parse(line)).some(row=>row.operation==='hub-usage-reconcile'&&row.settled===1));}
  finally{await f.usage.close();}
});
