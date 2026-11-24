import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodexRolloutReader } from './rollout-reader.js';
import { RolloutProjection } from './rollout-projection.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const gate = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return {promise,resolve}; };
const tick = () => new Promise<void>(done => setImmediate(done));

for (const stage of ['open','stat','read','close'] as const) {
  test(`bounded snapshot wait retains original ${stage}, refuses duplicate, and drains on shutdown`, async t => {
    const dir = await fs.mkdtemp(join(tmpdir(),'agentopsdeck-original-io-wait-'));
    const file = join(dir,'private-rollout.jsonl');
    await fs.writeFile(file,JSON.stringify({type:'turn_context',payload:{model:'private-model'}})+'\n');
    const entered=gate(),held=gate(), logs: any[]=[];
    const reader = new CodexRolloutReader({diagnostics:new PerformanceDiagnostics(line=>logs.push(JSON.parse(line)))});
    const open = fs.open; let opens=0, closes=0;
    t.mock.method(fs,'open',async (...args: Parameters<typeof open>) => {
      if(args[0]===file) { opens++; if(stage==='open'){entered.resolve();await held.promise;} }
      const h=await open(...args); if(args[0]!==file)return h;
      for(const method of ['stat','read','close'] as const){const original=h[method].bind(h);
        t.mock.method(h,method,async (...params: any[])=>{
          if(stage===method){entered.resolve();await held.promise;}
          const result=await (original as any)(...params);if(method==='close')closes++;return result;
        });
      }return h;
    });syncBuiltinESMExports();
    let closing: Promise<void>|undefined;
    try {
      const waiting=(reader as any).readSnapshotWithin(file,{},20);
      const refused=assert.rejects(waiting,/still pending/);
      await entered.promise; await refused;
      assert.equal((reader.cacheStats() as any).pendingSnapshotWaits,1);
      await assert.rejects((reader as any).readSnapshotWithin(file,{},20),/still pending/);
      assert.equal(opens,1,'an observation deadline must never repeat original IO');
      closing=reader.close();let exited=false;closing.then(()=>{exited=true;},()=>{exited=true;});
      await tick();assert.equal(exited,false);assert.equal(reader.close(),closing);
      held.resolve();await closing;
      assert.equal(closes,1);assert.equal((reader.cacheStats() as any).pendingSnapshotWaits,0);
      assert.equal(reader.cacheStats().entries,0);
      const events=logs.filter(row=>row.operation==='rollout-snapshot-wait');
      assert.ok(events.some(row=>row.timedOut===1));
      assert.ok(events.some(row=>row.deferred===1));
      // Closing freezes delivery; the admitted read can correctly fail while
      // still draining its descriptor. Require the original outcome log.
      assert.ok(events.some(row=>row.step===2&&(row.settled===1||row.unknown===1)));
      assert.doesNotMatch(JSON.stringify(logs),/private-rollout|private-model/);
    } finally { held.resolve();await closing;await reader.close();t.mock.restoreAll();syncBuiltinESMExports();await fs.rm(dir,{recursive:true,force:true}); }
  });
}

test('successful bounded snapshot transfers the original lease, without disposing caller ownership',async()=>{
  const dir=await fs.mkdtemp(join(tmpdir(),'agentopsdeck-original-io-success-'));const file=join(dir,'rollout.jsonl');
  await fs.writeFile(file,JSON.stringify({type:'turn_context',payload:{model:'fixture'}})+'\n');
  const reader=new CodexRolloutReader();
  try {
    const projection=await (reader as any).readSnapshotWithin(file,{},1000);
    await reader.close();const lines=[];for await(const line of projection)lines.push(line);
    assert.equal(lines.length,1);await projection.dispose();
  }finally{await reader.close();await fs.rm(dir,{recursive:true,force:true});}
});

test('healthy concurrent observations of the same path retain separate caller-owned leases',async()=>{
  const held=gate(),reader=new CodexRolloutReader();let reads=0,closes=0;
  reader.readSnapshot=async()=>{reads++;await held.promise;return new RolloutProjection([{bytes:0,memoryBytes:0,refs:0,
    lines:async function*(){},close:async()=>{closes++;}}]);};
  try{
    const first=reader.readSnapshotWithin('path',{},1000),second=reader.readSnapshotWithin('path',{},1000);
    await tick();assert.equal(reads,2);assert.equal(reader.cacheStats().pendingSnapshotWaits,2);
    held.resolve();const leases=await Promise.all([first,second]);assert.notEqual(leases[0],leases[1]);
    await reader.close();assert.equal(closes,0,'delivered leases stay caller-owned after reader shutdown');
    await Promise.all(leases.map(lease=>lease.dispose()));assert.equal(closes,2);
  }finally{held.resolve();await reader.close();}
});

test('late snapshot is disposed before retry admission, and never delivered after timeout',async()=>{
  const held=gate(),disposed=gate(),entered=gate(),reader=new CodexRolloutReader();let reads=0,closes=0;
  reader.readSnapshot=async()=>{reads++;await held.promise;return new RolloutProjection([{bytes:0,memoryBytes:0,refs:0,
    lines:async function*(){},close:async()=>{closes++;entered.resolve();await disposed.promise;}}]);};
  try{
    await assert.rejects(reader.readSnapshotWithin('private-path',{},10),/still pending/);
    held.resolve();await entered.promise;
    await assert.rejects(reader.readSnapshotWithin('private-path',{},10),/still pending/);
    assert.equal(reads,1);assert.equal(closes,1);
    disposed.resolve();await tick();assert.equal(reader.cacheStats().pendingSnapshotWaits,0);
    const lease=await reader.readSnapshotWithin('private-path',{},1000);await lease.dispose();assert.equal(reads,2);
  }finally{held.resolve();disposed.resolve();await reader.close();}
});

test('late original rejection is logged and only real settlement permits a fresh read',async()=>{
  const held=gate(),logs:any[]=[],reader=new CodexRolloutReader({diagnostics:new PerformanceDiagnostics(line=>logs.push(JSON.parse(line)))});
  let reads=0;reader.readSnapshot=async()=>{if(++reads===1){await held.promise;throw Error('private-rejection');}return new RolloutProjection([]);};
  try{
    await assert.rejects(reader.readSnapshotWithin('private-path',{},10),/still pending/);
    await assert.rejects(reader.readSnapshotWithin('private-path',{},10),/still pending/);assert.equal(reads,1);
    held.resolve();await tick();assert.equal(reader.cacheStats().pendingSnapshotWaits,0);
    const projection=await reader.readSnapshotWithin('private-path',{},1000);await projection.dispose();assert.equal(reads,2);
    assert.ok(logs.some(row=>row.operation==='rollout-snapshot-wait'&&row.step===2&&row.unknown===1));
    assert.doesNotMatch(JSON.stringify(logs),/private-/);
  }finally{held.resolve();await reader.close();}
});

test('late lease close failure remains the original reader close failure without replay',async()=>{
  const held=gate(),reader=new CodexRolloutReader(),failure=Error('private-close');let closes=0;
  reader.readSnapshot=async()=>{await held.promise;return new RolloutProjection([{bytes:0,memoryBytes:0,refs:0,
    lines:async function*(){},close:async()=>{closes++;throw failure;}}]);};
  await assert.rejects(reader.readSnapshotWithin('private-path',{},10),/still pending/);
  held.resolve();await tick();const closing=reader.close();
  await assert.rejects(closing,error=>error===failure);assert.equal(reader.close(),closing);
  await assert.rejects(reader.close(),error=>error===failure);assert.equal(closes,1);
});

test('validation deadline covers original disposal and retains its pending path',async()=>{
  const held=gate(),entered=gate(),reader=new CodexRolloutReader();let reads=0,closes=0;
  reader.readSnapshot=async()=>{reads++;return new RolloutProjection([{bytes:0,memoryBytes:0,refs:0,
    lines:async function*(){},close:async()=>{closes++;entered.resolve();await held.promise;}}]);};
  let closing:Promise<void>|undefined;
  try{
    const waiting=reader.validateWithin('private-path',10),observed=assert.rejects(waiting,/still pending/);
    await entered.promise;await observed;
    await assert.rejects(reader.validateWithin('private-path',10),/still pending/);assert.equal(reads,1);
    closing=reader.close();let finished=false;closing.then(()=>{finished=true;});await tick();assert.equal(finished,false);
    held.resolve();await closing;assert.equal(closes,1);assert.equal(reader.cacheStats().pendingSnapshotWaits,0);
  }finally{held.resolve();await closing;await reader.close();}
});

test('bounded pending-path budget refuses new IO and reentrant throwing logs do not retire originals',async()=>{
  const held=gate();let reads=0,reentered=false,refused:Promise<unknown>|undefined;
  const reader=new CodexRolloutReader({diagnostics:new PerformanceDiagnostics(()=>{
    if(!reentered){reentered=true;refused=reader.readSnapshotWithin('path-0',{},10).catch(e=>e);}
    throw Error('private-sink');
  })});
  reader.readSnapshot=async()=>{reads++;await held.promise;return new RolloutProjection([]);};
  try{
    const waits=Array.from({length:64},(_,i)=>reader.readSnapshotWithin('path-'+i,{},10).catch(e=>e));
    await assert.rejects(reader.readSnapshotWithin('overflow',{},10),/still pending/);
    await Promise.all(waits);await refused;assert.equal(reads,64);assert.equal(reader.cacheStats().pendingSnapshotWaits,64);
    held.resolve();await tick();assert.equal(reader.cacheStats().pendingSnapshotWaits,0);
    const result=await reader.readSnapshotWithin('overflow',{},1000);await result.dispose();assert.equal(reads,65);
  }finally{held.resolve();await reader.close();}
});

test('invalid deadlines perform no IO and closed reader never reopens',async()=>{
  const reader=new CodexRolloutReader();let reads=0;reader.readSnapshot=async()=>{reads++;return new RolloutProjection([]);};
  for(const timeout of [0,-1,NaN,Infinity,1.5,2147483648])await assert.rejects(reader.readSnapshotWithin('path',{},timeout),/Invalid/);
  await reader.close();await assert.rejects(reader.readSnapshotWithin('path',{},10),/closed/);assert.equal(reads,0);
});

test('routine read traffic cannot hide late settlement; bounded diagnostics retain suppressed lifecycle',()=>{
  const logs:any[]=[],diagnostics=new PerformanceDiagnostics(line=>logs.push(JSON.parse(line)),()=>0);
  for(let i=0;i<80;i++){diagnostics.start('rollout-read').finish();diagnostics.start('rollout-read').finish(true);}
  const late=diagnostics.start('rollout-snapshot-wait');late.add('step',2);late.add('settled',1);late.finish();
  assert.ok(logs.some(row=>row.operation==='rollout-snapshot-wait'&&row.step===2&&row.settled===1));
  for(let i=0;i<150;i++){const trace=diagnostics.start('rollout-snapshot-wait');trace.add('step',2);trace.add('unknown',1);trace.finish(true);}
  const snapshot=diagnostics.snapshot();assert.equal(snapshot.events.length,128);
  assert.ok(snapshot.events.some(row=>row.operation==='rollout-snapshot-wait'&&row.delivery==='rate-limited'));
});
