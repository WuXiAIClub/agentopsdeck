import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { HubStore } from '../hub/hub-store.js';
import { ConnectorClient } from '../hub/connector-client.js';
import { encodeHubSessionId } from '../hub/session-id.js';
import { NativeTokenUsageStore } from '../connector/native-token-usage.js';
import { CONNECTOR_PROTOCOL_HEADER,CONNECTOR_PROTOCOL } from '@agentopsdeck/shared';
import type { DelegationCatalogSource } from '../hub/workspace-delegation-catalog.js';
import type { DelegationMember } from '../hub/workspace-delegation-preview.js';
import { registerHubUsageManifests } from './hub-usage-manifests.js';
import type { AsyncConnectorClientResolver } from '../hub/async-connector-client.js';
import { projectSessionDirectory } from '../projection/session-directory.js';

async function fixture(t:{after:(fn:()=>unknown)=>void},asyncMode=false,realDirectory=false) {
  const root=await mkdtemp(join(tmpdir(),'usage-manifest-http-'));let hub=new HubStore(join(root,'hub.sqlite'),'synthetic'),app=new Hono();
  const owner=hub.createUser('Alice').id,other=hub.createUser('Bob').id;
  hub.upsertConnection({id:'dev',ownerUserId:owner,label:'Dev',connectorUrl:'https://connector.example'});
  const nodeId='node_'+randomUUID();hub.pinConnectionNode('dev',owner,hub.connectionAuthority('dev',owner)!,nodeId);
  const db=new DatabaseSync(join(root,'connector.sqlite')),ledger=new NativeTokenUsageStore(db,()=>1000);
  const members:DelegationMember[]=['a','b'].map((s,i)=>({owner,nodeId,connectionId:'dev',runtime:'codex',sessionId:encodeHubSessionId('dev','codex:'+s),
    authorityEpoch:hub.connectionAuthority('dev',owner)!,groupId:'group',tags:i?['two']:['one','two'],taskBinding:'unknown'}));
  ledger.record('codex','codex:a','one',{inputTokens:10,outputTokens:2,cacheReadTokens:0});ledger.record('codex','codex:b','two',{inputTokens:20,outputTokens:4});
  let generation=1,complete=true,posts=0,gets=0,directoryReads=0,lost=false,malformed=false,revoke=false,offline=false,actor:string|undefined;
  const directory:DelegationCatalogSource={fence:()=>({generation,preferencesRevision:0}),enumerate:async()=>({complete,members}),authorized:(o,m)=>o===owner&&m.owner===owner};
  const client=()=>new ConnectorClient('https://connector.example','synthetic',async req=>{
    if(new URL(req.url).pathname.endsWith('/sessions/directory')){
      directoryReads++;return Response.json(projectSessionDirectory(['codex:a','codex:b'],{},'stable'),{headers:{[CONNECTOR_PROTOCOL_HEADER]:String(CONNECTOR_PROTOCOL.max)}});
    }
    const parts=new URL(req.url).pathname.split('/'),index=parts.indexOf('sessions'),session=decodeURIComponent(parts[index+1]!);
    let result;
    if(req.method==='POST'){
      posts++;const s=await req.json() as {requestId:string;from:number;to:number;bucketMs:number};
      result=ledger.snapshot('codex',session,s.requestId,s.from,s.to,s.bucketMs);
      if(lost)throw Error('lost ACK');
    }else{gets++;if(offline)throw Error('offline');result=ledger.readSnapshot('codex',session,parts.at(-1)!);}
    if(revoke)hub.upsertConnection({id:'dev',ownerUserId:owner,label:'Revoked',connectorUrl:'https://connector.example',status:'disabled'});
    if(malformed&&result)result={...result,memberDigest:'0'.repeat(64)};
    return new Response(JSON.stringify(result??{error:'missing'}),{status:result?200:404,headers:{'content-type':'application/json',[CONNECTOR_PROTOCOL_HEADER]:String(CONNECTOR_PROTOCOL.max)}});
  });
  let resolver:AsyncConnectorClientResolver=async()=>client();
  const mount=()=>registerHubUsageManifests(app,{hubStore:hub,principal:c=>({userId:actor??c.req.header('x-user')??owner,admin:false}),
    connectorClient:asyncMode?()=>{throw Error('PRIVATE synchronous fallback forbidden');}:client,
    ...(asyncMode?{asyncConnectorClient:((...args)=>resolver(...args)) as AsyncConnectorClientResolver}:{}),...(!realDirectory?{directory}:{})});let routes=mount();
  const req=(method:string,path='',body?:unknown,user=owner,signal?:AbortSignal)=>app.request('/api/hub/v1/usage-manifests'+path,{method,headers:{'x-user':user},...(signal?{signal}:{}),...(body!==undefined?{body:JSON.stringify(body)}:{})});
  const input={requestId:randomUUID(),from:0,to:60000,bucketMs:60000,tags:[],tagMode:'all'};
  t.after(async()=>{routes.close();hub.close();db.close();await rm(root,{recursive:true,force:true});});
  return{input,req,members,owner,other,client,close:()=>routes.close(),setActor:(value:string)=>{actor=value;},setResolver:(next:AsyncConnectorClientResolver)=>{resolver=next;},
    get hub(){return hub;},get posts(){return posts;},get gets(){return gets;},get directoryReads(){return directoryReads;},
    lost(){lost=true;},invalid(){malformed=true;},revoke(){revoke=true;},offline(){offline=true;},incomplete(){complete=false;},change(){generation++;},
    reopen(){routes.close();hub.close();hub=new HubStore(join(root,'hub.sqlite'),'synthetic');app=new Hono();routes=mount();}};
}

test('usage default directory, confirmation and recovery use request-bound async clients without sync fallback',async t=>{
  const f=await fixture(t,true,true);let resolutions=0;
  f.setResolver(async(request,id,options)=>{resolutions++;assert.equal(id,'dev');assert.equal(options?.expectedUserId,f.owner);
    assert.equal(request.headers.get('x-user'),f.owner);return f.client();});
  assert.equal((await f.req('POST','',f.input)).status,201);assert.equal(f.directoryReads,1);assert.equal(f.posts,0);
  f.lost();assert.equal((await f.req('POST',`/${f.input.requestId}/confirm`,{})).status,200);
  assert.equal(f.directoryReads,2);assert.equal(f.posts,2);
  f.reopen();assert.equal((await f.req('GET',`/${f.input.requestId}`)).status,200);
  assert.equal(f.posts,2);assert.equal(f.gets,2);assert.equal(resolutions,6);
});

for(const change of ['generation','identity','cancel','close','refusal'] as const)
  test(`usage async directory ${change} cannot dispatch or prepare a partial manifest`,async t=>{
    const f=await fixture(t,true,true),abort=new AbortController();let release!:()=>void,entered!:()=>void;
    const hold=new Promise<void>(resolve=>{release=resolve;}),reached=new Promise<void>(resolve=>{entered=resolve;});
    f.setResolver(async()=>{entered();await hold;if(change==='refusal')throw Error('PRIVATE refused');return f.client();});
    const pending=f.req('POST','',f.input,f.owner,abort.signal);await reached;
    if(change==='generation')f.hub.upsertConnection({id:'dev',ownerUserId:f.owner,label:'Changed',connectorUrl:'https://changed.example'});
    if(change==='identity')f.setActor(f.other);
    if(change==='cancel')abort.abort();
    if(change==='close')f.close();
    release();const response=await pending;assert.notEqual(response.status,201);assert.doesNotMatch(await response.text(),/PRIVATE/);
    assert.equal(f.directoryReads,0);assert.equal(f.posts,0);assert.equal(f.hub.usageManifests.read(f.owner,f.input.requestId),undefined);
  });

for(const change of ['generation','identity','cancel','close','refusal'] as const)
  test(`usage async collection ${change} retains unknown original claim and never retries mutation`,async t=>{
    const f=await fixture(t,true),abort=new AbortController();assert.equal((await f.req('POST','',f.input)).status,201);
    let release!:()=>void,entered!:()=>void,resolutions=0;
    const hold=new Promise<void>(resolve=>{release=resolve;}),reached=new Promise<void>(resolve=>{entered=resolve;});
    f.setResolver(async()=>{resolutions++;entered();await hold;if(change==='refusal')throw Error('PRIVATE refused');return f.client();});
    const pending=f.req('POST',`/${f.input.requestId}/confirm`,{},f.owner,abort.signal);await reached;
    assert.equal(f.hub.usageManifests.read(f.owner,f.input.requestId)?.members[0]?.state,'unknown');
    if(change==='generation')f.hub.upsertConnection({id:'dev',ownerUserId:f.owner,label:'Changed',connectorUrl:'https://changed.example'});
    if(change==='identity')f.setActor(f.other);
    if(change==='cancel')abort.abort();if(change==='close')f.close();
    release();const response=await pending;assert.doesNotMatch(await response.text(),/PRIVATE/);assert.equal(f.posts,0);
    if(change==='generation')return; // Changed authority invalidates the whole retained scope.
    f.setActor(f.owner);f.setResolver(async()=>f.client());f.reopen();
    await f.req('GET',`/${f.input.requestId}`);assert.equal(f.posts,0);assert.ok(f.gets>=1);assert.ok(resolutions>=1);
  });

test('preview has no snapshot effects; confirm aggregates independent overlapping dimensions, unknown cache and no fabricated credit',async t=>{
  const f=await fixture(t),id=f.input.requestId;
  const preview=await f.req('POST','',f.input);assert.equal(preview.status,201);assert.equal(f.posts,0);
  const response=await f.req('POST',`/${id}/confirm`,{});assert.equal(response.status,200);
  const r=(await response.json()).manifest;assert.equal(r.state,'complete');assert.equal(r.result.total.metrics.inputTokens.knownSubtotal,30);
  assert.equal(r.result.groups.find((g:{name:string})=>g.name==='tag:two').metrics.inputTokens.knownSubtotal,30);
  assert.equal(r.result.total.metrics.cacheReadTokens.unknownSampleCount,1);assert.equal(r.result.creditEstimate.status,'unavailable');
  assert.equal(f.posts,2);await f.req('POST',`/${id}/confirm`,{});await f.req('GET',`/${id}`);assert.equal(f.posts,2);
  assert.equal((await f.req('GET',`/${id}`,undefined,f.other)).status,404);
  assert.equal((await f.req('POST','',{...f.input,tags:['one']})).status,409);
});
test('lost snapshot ACK across physical Hub reopen recovers original children using only GET, preserving frozen tags',async t=>{
  const f=await fixture(t),id=f.input.requestId;await f.req('POST','',f.input);f.lost();
  const r=(await (await f.req('POST',`/${id}/confirm`,{})).json()).manifest;assert.equal(r.state,'collecting');assert.equal(r.result,null);
  f.members[0]!.tags=['changed'];f.change();f.reopen();
  const recovered=(await (await f.req('GET',`/${id}`)).json()).manifest;
  assert.equal(recovered.state,'complete');assert.equal(f.posts,2);assert.equal(f.gets,2);assert.deepEqual(recovered.members[0].tags,['one','two']);
});
test('changed directory blocks confirmation and incomplete enumeration never means zero',async t=>{
  const f=await fixture(t),id=f.input.requestId;await f.req('POST','',f.input);f.change();
  assert.equal((await f.req('POST',`/${id}/confirm`,{})).status,409);assert.equal(f.posts,0);
  f.incomplete();assert.equal((await f.req('POST','',{...f.input,requestId:randomUUID()})).status,409);
});
test('revocation during transport prevents snapshot disclosure and later receipt reads',async t=>{
  const f=await fixture(t),id=f.input.requestId;await f.req('POST','',f.input);f.revoke();
  assert.equal((await f.req('POST',`/${id}/confirm`,{})).status,409);assert.equal(f.posts,1);
  assert.equal((await f.req('GET',`/${id}`)).status,409);
});
test('invalid digest remains unknown and cannot be accepted or automatically reposted',async t=>{
  const f=await fixture(t),id=f.input.requestId;await f.req('POST','',f.input);f.invalid();
  const r=(await (await f.req('POST',`/${id}/confirm`,{})).json()).manifest;assert.equal(r.state,'collecting');assert.equal(r.result,null);
  await f.req('GET',`/${id}`);assert.equal(f.posts,2);assert.equal(f.gets,2);
});
test('explicit empty selection is distinct from incomplete directory; layout intersects only actual session panes',async t=>{
  const f=await fixture(t);
  const layout={id:'current',name:'Current',workspace:{version:2,panes:[{id:'pane',kind:'session',sessionKey:f.members[0]!.sessionId},
    {id:'note',kind:'notebook',target:'session',resourceId:f.members[1]!.sessionId}],floating:[]},collapsedKeys:[]};
  f.hub.layouts.save(f.owner,'current',{revision:0,content:JSON.stringify(layout)});
  const input={...f.input,layoutId:'current',tags:['one']};
  const r=(await (await f.req('POST','',input)).json()).manifest;assert.equal(r.members.length,1);
  await f.req('POST',`/${input.requestId}/confirm`,{});assert.equal(f.posts,1);
  const empty={...f.input,requestId:randomUUID(),tags:['absent']};await f.req('POST','',empty);
  const result=(await (await f.req('POST',`/${empty.requestId}/confirm`,{})).json()).manifest;
  assert.equal(result.state,'complete');assert.equal(result.result.memberCount,0);assert.equal(f.posts,1);
});
test('cancelled preview never collects and confirmation is permanently suppressed',async t=>{
  const f=await fixture(t),id=f.input.requestId;await f.req('POST','',f.input);
  assert.equal((await f.req('DELETE',`/${id}`)).status,200);await f.req('POST',`/${id}/confirm`,{});assert.equal(f.posts,0);
});
test('cancel before preview survives physical reopen and rejects late preview without snapshot dispatch',async t=>{
  const f=await fixture(t),id=f.input.requestId;
  assert.equal((await f.req('DELETE',`/${id}`)).status,200);f.reopen();
  assert.deepEqual(await (await f.req('GET',`/${id}`)).json(),{manifest:null,cancelled:true,requestId:id});
  assert.equal((await f.req('POST','',f.input)).status,409);
  assert.equal((await f.req('POST',`/${id}/confirm`,{})).status,404);
  assert.equal((await f.req('GET',`/${id}` ,undefined,f.other)).status,404);
  assert.equal(f.posts,0);assert.equal(f.gets,0);
});
test('restart continuation claims only never-dispatched members, GET and duplicate confirmation cannot dispatch',async t=>{
  const f=await fixture(t),id=f.input.requestId;await f.req('POST','',f.input);
  const r=f.hub.usageManifests.confirm(f.owner,id).receipt;
  await f.hub.usageManifests.claimAsync(f.owner,id,r.members[0]!.requestId);
  f.reopen();
  await f.req('GET',`/${id}`);await f.req('POST',`/${id}/confirm`,{});assert.equal(f.posts,0);
  const resumed=(await (await f.req('POST',`/${id}/continue`,{})).json()).manifest;
  assert.equal(resumed.state,'collecting');assert.equal(resumed.members[0].state,'unknown');assert.equal(resumed.members[1].state,'complete');
  assert.equal(f.posts,1);assert.equal(resumed.result,null);
  await f.req('POST',`/${id}/continue`,{});assert.equal(f.posts,1);
  assert.equal((await f.req('POST',`/${id}/continue`,{},f.other)).status,404);
});
test('floating geometry references do not masquerade as additional session panes',async t=>{
  const f=await fixture(t);
  const layout={id:'current',name:'Current',workspace:{version:1,panes:[{id:'floating',sessionKey:f.members[0]!.sessionId}],dock:null,
    floating:[{id:'floating',x:0,y:0,width:.8,height:.8}],active:'floating'},collapsedKeys:[]};
  f.hub.layouts.save(f.owner,'current',{revision:0,content:JSON.stringify(layout)});
  const res=await f.req('POST','',{...f.input,layoutId:'current'});assert.equal(res.status,201);
  assert.equal((await res.json()).manifest.members.length,1);
});
