import test from 'node:test';
import assert from 'node:assert/strict';
import { validUsageManifest } from './usage-manifest.js';
const id='11111111-1111-4111-8111-111111111111',child='22222222-2222-4222-8222-222222222222';
const totals={events:1,metrics:Object.fromEntries(['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens'].map(k=>[k,{knownSubtotal:10,knownSampleCount:1,unknownSampleCount:0}]))};
const fixture=()=>({requestId:id,selection:{requestId:id,from:0,to:60000,bucketMs:60000,tags:[],tagMode:'all'},directoryRevision:'a'.repeat(64),createdAt:1,expiresAt:300001,state:'complete',
  members:[{sessionId:'session',connectionId:'connection',runtime:'codex',groupId:null,tags:[],requestId:child,state:'complete'}],
  result:{version:1,membership:'query-time',memberCount:1,manifestDigest:'b'.repeat(64),total:structuredClone(totals),groups:[{name:'tag:one',...structuredClone(totals)}],coverageReasons:['partial'],creditEstimate:{status:'unavailable',reason:'no-verified-versioned-billing-rule'}}});
test('usage manifest rejects malformed identities, range, runtime and duplicate children without throwing',()=>{
  assert.equal(validUsageManifest(fixture(),id),true);
  for(const value of [null,{}, {...fixture(),members:[null]}, {...fixture(),members:[fixture().members[0],fixture().members[0]]},
    {...fixture(),directoryRevision:'bad'}, {...fixture(),selection:{...fixture().selection,to:60000000000}},
    {...fixture(),members:[{...fixture().members[0],runtime:'unsupported'}]}, {...fixture(),members:[{...fixture().members[0],tags:['same','same']}]},
    {...fixture(),members:[{...fixture().members[0],requestId:id}]}])assert.equal(validUsageManifest(value,id),false);
});
test('usage manifest refuses incomplete totals, duplicate groups, invalid digest and precision overflow',()=>{
  for(const change of [(v:any)=>v.result.manifestDigest='invalid',(v:any)=>v.result.groups.push(v.result.groups[0]),
    (v:any)=>v.result.total.metrics.inputTokens.knownSampleCount=0,(v:any)=>v.result.total.metrics.inputTokens.knownSubtotal=Number.MAX_SAFE_INTEGER+1,
    (v:any)=>v.result.coverageReasons=[null],(v:any)=>v.members[0].state='unknown',(v:any)=>v.state='collecting']){
    const v=fixture();change(v);assert.equal(validUsageManifest(v,id),false);
  }
  assert.equal(validUsageManifest({...fixture(),state:'collecting',result:null},id),true);
});
