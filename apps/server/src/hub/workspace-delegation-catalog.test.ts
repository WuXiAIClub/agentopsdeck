import assert from 'node:assert/strict';
import test from 'node:test';
import { readDelegationCatalog,type DelegationCatalogSource } from './workspace-delegation-catalog.js';
import type { DelegationMember } from './workspace-delegation-preview.js';
const member:DelegationMember={owner:'alice',nodeId:'node',connectionId:'connector',runtime:'codex',sessionId:'session',authorityEpoch:1,groupId:'work',tags:['review'],taskBinding:'supported'};
const source=(change:Partial<DelegationCatalogSource>={}):DelegationCatalogSource=>({fence:()=>({generation:1,preferencesRevision:2}),enumerate:async()=>({complete:true,members:[{...member,tags:[...member.tags]}]}),authorized:()=>true,...change});
test('catalog retains exact owner/target and freezes copied allowlisted fields',async()=>{
  const extra={...member,credential:'synthetic-do-not-copy'};
  const r=await readDelegationCatalog('alice',source({enumerate:async()=>({complete:true,members:[extra]})}));
  assert.deepEqual(r.members[0],member);assert.ok(Object.isFrozen(r));assert.ok(Object.isFrozen(r.members[0]?.tags));
  assert.equal('credential' in r.members[0]!,false);assert.equal(r.preferencesRevision,2);
});
test('catalog rejects changes to authority or preferences across asynchronous enumeration',async()=>{
  for(const field of ['generation','preferencesRevision'] as const){let changed=false;
    await assert.rejects(readDelegationCatalog('alice',source({fence:()=>({generation:1,preferencesRevision:2,[field]:changed?3:1}),enumerate:async()=>{changed=true;return {complete:true,members:[member]};}})),/changed/);
  }
});
test('incomplete, duplicate and out-of-owner members fail closed rather than authorize partial groups',async()=>{
  await assert.rejects(readDelegationCatalog('alice',source({enumerate:async()=>({complete:false,members:[]})})),/incomplete/);
  await assert.rejects(readDelegationCatalog('alice',source({enumerate:async()=>({complete:true,members:[member,member]})})),/duplicate/);
  await assert.rejects(readDelegationCatalog('alice',source({enumerate:async()=>({complete:true,members:[{...member,owner:'bob'}]})})),/invalid/);
});
test('revoked member cannot appear in the frozen catalog; unknown capability remains unknown',async()=>{
  await assert.rejects(readDelegationCatalog('alice',source({authorized:()=>false})),/forbidden/);
  const r=await readDelegationCatalog('alice',source({enumerate:async()=>({complete:true,members:[{...member,taskBinding:'unknown'}]})}));assert.equal(r.members[0]?.taskBinding,'unknown');
});
test('hung enumeration is bounded and receives abort without retries',async()=>{
  let signal:AbortSignal|undefined,calls=0;
  await assert.rejects(readDelegationCatalog('alice',source({enumerate:(_owner,limit,s)=>{assert.equal(limit,10000);signal=s;calls++;return new Promise(()=>{});}}),10),/timeout/);
  assert.equal(calls,1);assert.equal(signal?.aborted,true);
});
