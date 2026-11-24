import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {UsageManifests,usageSelection} from './usage-manifests.js';
import type {DelegationMember} from './workspace-delegation-preview.js';
test('volume pressure rejects new previews and child dispatch but preserves original requests and cancellation',()=>{
  const db=new DatabaseSync(':memory:');let pressure=false,admissions=0;
  try{
    const store=new UsageManifests(db,()=>true,()=>1000,(bytes,write)=>{
      admissions++;assert.ok(bytes>=16*1024**2);if(pressure)throw Error('volume-pressure');return write();
    });
    const s=usageSelection({requestId:randomUUID(),from:0,to:60000,bucketMs:60000,tags:[],tagMode:'all'});
    const member:DelegationMember={owner:'alice',sessionId:'session',nodeId:'node',connectionId:'dev',runtime:'codex',authorityEpoch:1,groupId:null,tags:[],taskBinding:'unknown'};
    const r=store.prepare('alice',s,'directory',[member]);assert.equal(admissions,1);
    pressure=true;
    assert.deepEqual(store.prepare('alice',s,'directory',[member]),r);assert.equal(admissions,1);
    assert.throws(()=>store.prepare('alice',{...s,tags:['changed']},'directory',[]),/request-reused/);
    const next={...s,requestId:randomUUID()};
    assert.throws(()=>store.prepare('alice',next,'directory',[]),/volume-pressure/);assert.equal(store.read('alice',next.requestId),undefined);
    store.confirm('alice',s.requestId);
    const child=r.members[0]!.requestId;
    assert.throws(()=>store.claim('alice',s.requestId,child),/volume-pressure/);
    assert.equal(store.read('alice',s.requestId)!.members[0]!.state,'prepared');
    pressure=false;assert.equal(store.claim('alice',s.requestId,child),true);
    pressure=true;const before=admissions;assert.equal(store.claim('alice',s.requestId,child),false);assert.equal(admissions,before);
    store.cancel('alice',next.requestId);assert.equal(store.cancelled('alice',next.requestId),true);
    assert.equal(db.isTransaction,false);
  }finally{db.close();}
});
test('cancellation before preview creates a durable owner-scoped tombstone',()=>{
  const db=new DatabaseSync(':memory:');try{
    const store=new UsageManifests(db,()=>true),id=randomUUID();store.cancel('alice',id);
    const reopened=new UsageManifests(db,()=>true);assert.equal(reopened.cancelled('alice',id),true);assert.equal(reopened.cancelled('bob',id),false);
    assert.throws(()=>reopened.prepare('alice',usageSelection({requestId:id,from:0,to:60000,bucketMs:60000,tags:[],tagMode:'all'}),'dir',[]),/cancelled/);
    reopened.cancel('alice',id);
  }finally{db.close();}
});
test('scope parser rejects injection, duplicates, invalid ranges and unknown fields',()=>{
  const input={requestId:randomUUID(),from:0,to:60000,bucketMs:60000,tags:[],tagMode:'all'};
  assert.deepEqual(usageSelection(input),input);
  for(const changed of [{from:'0'},{to:null},{tags:['a','a']},{tags:['\na']},{runtime:'shell'},{members:[]},{to:32*86400000},{bucketMs:1}])assert.throws(()=>usageSelection({...input,...changed}));
});
test('durable single claim, expiration, immutable IDs and dual coordinator authority check',()=>{
  const db=new DatabaseSync(':memory:');let now=1000,authorized=true;
  try{
    const store=new UsageManifests(db,()=>authorized,()=>now),other=new UsageManifests(db,()=>authorized,()=>now);
    const s=usageSelection({requestId:randomUUID(),from:0,to:60000,bucketMs:60000,tags:[],tagMode:'all'});
    const member:DelegationMember={owner:'alice',sessionId:'session',nodeId:'node',connectionId:'dev',runtime:'codex',authorityEpoch:1,groupId:null,tags:[],taskBinding:'unknown'};
    const r=store.prepare('alice',s,'directory',[member]);member.tags.push('late');assert.deepEqual(r.members[0]!.member.tags,[]);
    assert.equal(store.confirm('alice',s.requestId).claimed,true);assert.equal(other.confirm('alice',s.requestId).claimed,false);
    const child=r.members[0]!.requestId;assert.equal(store.claim('alice',s.requestId,child),true);assert.equal(other.claim('alice',s.requestId,child),false);
    assert.throws(()=>store.cancel('alice',s.requestId));assert.throws(()=>store.prepare('alice',{...s,tags:['changed']},'directory',[]));
    const next={...s,requestId:randomUUID()};store.prepare('alice',next,'directory',[]);now+=300000;assert.throws(()=>other.confirm('alice',next.requestId),/expired/);
    authorized=false;assert.throws(()=>store.read('alice',s.requestId),/authority/);assert.equal(store.read('bob',s.requestId),undefined);
  }finally{db.close();}
});
