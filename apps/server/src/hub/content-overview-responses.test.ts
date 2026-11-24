import test from 'node:test';
import assert from 'node:assert/strict';
import {ContentOverviewResponses,CONTENT_CONTROL_RESPONSE_BYTES,CONTENT_CONTROL_RESPONSE_CAPACITY} from './content-overview-responses.js';
import {CONTENT_OVERVIEW_RESPONSE_BYTES} from './content-overview-domain.js';
import {HubMemberRequestError} from './async-member-request.js';

const unavailable=(error:unknown)=>error instanceof HubMemberRequestError&&error.status===503;
test('overview admits one entire legal response without occupying the RPC budget, then rejects saturation',()=>{
  const budget=new ContentOverviewResponses(),lease=budget.reserve(CONTENT_OVERVIEW_RESPONSE_BYTES);
  assert.ok(budget.reservedBytes>CONTENT_OVERVIEW_RESPONSE_BYTES);
  assert.throws(()=>budget.reserve(1),unavailable);
  lease.release();lease.release();assert.equal(budget.reservedBytes,0);
  const next=budget.reserve(CONTENT_OVERVIEW_RESPONSE_BYTES);next.release();budget.close();
  assert.throws(()=>budget.reserve(1),unavailable);
});
test('overview validates reservation and payload size before transferring ownership',()=>{
  const budget=new ContentOverviewResponses();
  for(const value of [0,-1,1.1,NaN,Infinity,CONTENT_OVERVIEW_RESPONSE_BYTES+1])assert.throws(()=>budget.reserve(value),unavailable);
  const lease=budget.reserve(1),signal=new AbortController().signal;
  assert.throws(()=>lease.response('too large',signal),unavailable);lease.release();assert.equal(budget.reservedBytes,0);
});
for(const mode of ['consume','cancel','abort','close'] as const)test(`unconsumed overview retains memory until ${mode}, cleanup exactly once`,async()=>{
  const budget=new ContentOverviewResponses(),lease=budget.reserve(200_000),abort=new AbortController();let finishes=0;
  const body='你'.repeat(60_000),response=lease.response(body,abort.signal,()=>{finishes++;});
  lease.release();await new Promise<void>(r=>setImmediate(r));assert.ok(budget.reservedBytes>0);assert.equal(finishes,0);
  assert.throws(()=>lease.response(body,abort.signal),unavailable);
  if(mode==='consume')assert.equal(await response.text(),body);
  if(mode==='cancel')await response.body!.cancel();
  if(mode==='abort'){abort.abort();await assert.rejects(response.text(),/shared_content_response_closed/);}
  if(mode==='close'){budget.close();await assert.rejects(response.text(),/shared_content_response_closed/);}
  abort.abort();budget.close();lease.release();assert.equal(budget.reservedBytes,0);assert.equal(finishes,1);
});
test('cancel after one copied chunk releases remaining payload without retaining its backing buffer',async()=>{
  const budget=new ContentOverviewResponses(),lease=budget.reserve(200_000),abort=new AbortController();
  const reader=lease.response('x'.repeat(150_000),abort.signal).body!.getReader();
  const first=await reader.read();assert.equal(first.value!.byteLength,65536);
  assert.equal(first.value!.buffer.byteLength,65536);assert.ok(budget.reservedBytes>0);
  await reader.cancel();assert.equal(budget.reservedBytes,0);budget.close();
});
test('already aborted delivery remains caller owned and releases without producing a stream',()=>{
  const budget=new ContentOverviewResponses(),lease=budget.reserve(10),abort=new AbortController();abort.abort();
  assert.throws(()=>lease.response('ok',abort.signal),unavailable);lease.release();assert.equal(budget.reservedBytes,0);
});
test('fragment reservation shares the unchanged global ceiling and permits repeated wire bytes without copies',async()=>{
  const budget=new ContentOverviewResponses(),lease=budget.reserveParts();
  assert.equal(budget.reservedBytes,6*CONTENT_OVERVIEW_RESPONSE_BYTES+65536);
  assert.throws(()=>budget.reserve(1),unavailable);
  const part=lease.encode('x'.repeat(1024*1024));
  const reader=lease.responseParts(Array.from({length:128},()=>part),new AbortController().signal).body!.getReader();
  let bytes=0;
  for(;;){const next=await reader.read();if(next.done)break;assert.ok(next.value.byteLength<=65536);
    assert.equal(next.value.buffer.byteLength,next.value.byteLength);bytes+=next.value.byteLength;}
  assert.equal(bytes,128*1024*1024);assert.equal(budget.reservedBytes,0);budget.close();
});
test('fixed control reserve admits four small revocations under bulk saturation without borrowing either lane',async()=>{
  const budget=new ContentOverviewResponses(),bulk=budget.reserveParts(),controls=Array.from({length:4},()=>budget.reserveControl());
  assert.equal(budget.reservedBytes,budget.capacityBytes);
  assert.equal(budget.capacityBytes,6*CONTENT_OVERVIEW_RESPONSE_BYTES+65536+CONTENT_CONTROL_RESPONSE_CAPACITY);
  assert.throws(()=>budget.reserveControl(),unavailable);assert.throws(()=>budget.reserve(1),unavailable);
  assert.throws(()=>controls[0]!.encode('x'.repeat(CONTENT_CONTROL_RESPONSE_BYTES+1)),unavailable);
  const reply=controls[0]!.response('{"revoked":true}',new AbortController().signal);
  controls[0]!.release();assert.equal(budget.reservedBytes,budget.capacityBytes);
  assert.deepEqual(await reply.json(),{revoked:true});const replacement=budget.reserveControl();
  assert.equal(budget.reservedBytes,budget.capacityBytes);
  for(const lease of controls)lease.release();replacement.release();bulk.release();assert.equal(budget.reservedBytes,0);budget.close();
});
test('near 3*C unique encoded allocations stream fully while a control response remains available',async()=>{
  const budget=new ContentOverviewResponses(),lease=budget.reserveParts(),limit=3*CONTENT_OVERVIEW_RESPONSE_BYTES,parts:Uint8Array[]=[];
  let remaining=limit-1;
  while(remaining){const bytes=Math.min(1024*1024,remaining);parts.push(lease.encode('x'.repeat(bytes)));remaining-=bytes;}
  parts.push(lease.encode('!'));assert.equal(new Set(parts.map(p=>p.buffer)).size,parts.length);
  assert.throws(()=>lease.encode('!'),unavailable);
  const control=budget.reserveControl();assert.deepEqual(await control.response('{"revoked":true}',new AbortController().signal).json(),{revoked:true});
  const reader=lease.responseParts(parts,new AbortController().signal).body!.getReader();let received=0;
  for(;;){const chunk=await reader.read();if(chunk.done)break;assert.ok(chunk.value.byteLength<=65536);received+=chunk.value.byteLength;}
  assert.equal(received,limit);assert.equal(budget.reservedBytes,0);budget.close();
});
test('fragment assembly is byte bounded and rejects unowned buffers or unbounded reference lists before publication',async()=>{
  const budget=new ContentOverviewResponses(),lease=budget.reserveParts(100);
  const part=lease.encode('你'.repeat(33));assert.throws(()=>lease.encode('xx'),unavailable);
  assert.throws(()=>lease.responseParts([part.slice()],new AbortController().signal),unavailable);
  assert.throws(()=>lease.responseParts(Array.from({length:1025},()=>part),new AbortController().signal),unavailable);
  assert.equal(await lease.responseParts([part,lease.encode('!')],new AbortController().signal).text(),'你'.repeat(33)+'!');
  assert.equal(budget.reservedBytes,0);budget.close();
});
for(const mode of ['consume','cancel','abort','close'] as const)test(`fragmented response releases exactly once after ${mode}`,async()=>{
  const budget=new ContentOverviewResponses(),lease=budget.reserveParts(1000),abort=new AbortController();let finishes=0;
  const part=lease.encode('"历史"'),response=lease.responseParts([lease.encode('['),part,lease.encode(','),part,lease.encode(']')],abort.signal,()=>finishes++);
  lease.release();assert.ok(budget.reservedBytes>0);assert.throws(()=>lease.encode('x'),unavailable);
  if(mode==='consume')assert.deepEqual(await response.json(),['历史','历史']);
  if(mode==='cancel')await response.body!.cancel();
  if(mode==='abort'){abort.abort();await assert.rejects(response.text(),/shared_content_response_closed/);}
  if(mode==='close'){budget.close();await assert.rejects(response.text(),/shared_content_response_closed/);}
  abort.abort();budget.close();lease.release();assert.equal(finishes,1);assert.equal(budget.reservedBytes,0);
});
