import test from 'node:test';
import assert from 'node:assert/strict';
import {PerformanceDiagnostics} from './performance.js';
import {observeContentReplica} from './content-replica.js';

for(const operation of ['hub-content-replica-effect','connector-content-replica-http'] as const)
for(const sinkFails of [false,true])test(`${operation}: original settlement, fixed phases, safe failing sink=${sinkFails}`,async()=>{
  const diagnostics=new PerformanceDiagnostics(()=>{if(sinkFails)throw Error('PRIVATE_SINK');},()=>0);
  let release!:(value:string)=>void;
  const original=new Promise<string>(r=>{release=r;}),pending=observeContentReplica(operation,7,()=>original,diagnostics);
  let events=diagnostics.snapshot().events.filter(e=>e.operation===operation);
  assert.equal(events.length,1);assert.equal(events[0]!.phase,'pending');assert.equal(events[0]!.pending,1);
  release('PRIVATE_RESULT');assert.equal(await pending,'PRIVATE_RESULT');
  events=diagnostics.snapshot().events.filter(e=>e.operation===operation);
  assert.equal(events.length,2);assert.equal(events[1]!.settled,1);assert.equal(events[1]!.step,7);
  const error=Error('PRIVATE_EXCEPTION');
  await assert.rejects(observeContentReplica(operation,9,()=>{throw error;},diagnostics),e=>e===error);
  events=diagnostics.snapshot().events.filter(e=>e.operation===operation);
  assert.equal(events.at(-1)!.unknown,1);assert.equal(events.at(-1)!.category,'failed');
  assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()),/PRIVATE/);
});
