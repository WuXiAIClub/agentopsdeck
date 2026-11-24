import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Hono} from 'hono';
import {HubStore} from './hub-store.js';
import {OriginalHubAdministrativeCommands} from './original-administrative-commands.js';
import type {AsyncHubMemberOwner} from './async-member-owner.js';
import {AsyncHubContentDocuments} from './async-content-documents.js';
import {ContentOverviewResponses} from './content-overview-responses.js';
import {registerAsyncHubContentOverview} from '../routes/hub-async-workspace-content-overview.js';
import {encodeHubSessionId} from './session-id.js';

const resourceId=JSON.stringify(['taskboard','default']);
const url='http://hub.invalid/api/hub/v1/workspace/shared-content/'+encodeURIComponent(resourceId);
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};
async function fixture(t:TestContext,gate=false){
  const store=new HubStore(':memory:','fixture'),user=store.createUser('Member'),key=store.identities.issueKey(user.id);
  store.boards.save(user.id,'default',{title:'PRIVATE',tasks:[],revision:0,mutationId:randomUUID()});
  const original=new OriginalHubAdministrativeCommands(store),entered=deferred(),release=deferred();let commands=0;
  const port:Pick<AsyncHubMemberOwner,'command'>={command(kind,input){return original.command(kind,input).then(async value=>{
    if(kind==='contentDocument'){commands++;if(gate){entered.resolve();await release.promise;}}return value;
  });}};
  const budget=new ContentOverviewResponses(100_000),app=new Hono();
  const route=registerAsyncHubContentOverview(app,{access:new AsyncHubContentDocuments(port),enabled:()=>true,responses:budget});
  t.after(async()=>{release.resolve();await route.close();budget.close();await original.close();await store.close();assert.equal(budget.reservedBytes,0);});
  const request=(method='GET',signal?:AbortSignal)=>app.fetch(new Request(url,{method,headers:{'x-agentopsdeck-key':key.token},...(signal?{signal}:{})}));
  return {store,user,key,entered,release,route,budget,request,commands:()=>commands};
}
test('HEAD has no delivery lease; unconsumed GET saturates only response budget and cancel restores admission',async t=>{
  const f=await fixture(t);
  const head=await f.request('HEAD');assert.equal(head.status,200);assert.equal(await head.text(),'');assert.equal(f.budget.reservedBytes,0);
  const first=await f.request();assert.equal(first.status,200);assert.ok(f.budget.reservedBytes>0);
  const busy=await f.request();assert.equal(busy.status,503);await busy.text();
  await first.body!.cancel();assert.equal(f.budget.reservedBytes,0);
  const next=await f.request();assert.equal(next.status,200);await next.text();assert.equal(f.budget.reservedBytes,0);
});
for(const action of ['revoke','abort','close'] as const)test(`original manifest ACK gated during ${action}: no stale delivery, replay or leaked lease`,{timeout:15_000},async t=>{
  const f=await fixture(t,true),abort=new AbortController(),flight=f.request('GET',abort.signal);
  await f.entered.promise;let closed=false,closing:Promise<void>|undefined;
  if(action==='revoke')f.store.identities.revokeKey(f.user.id,f.key.id);
  if(action==='abort')abort.abort();
  if(action==='close'){
    closing=f.route.close().then(()=>{closed=true;});await new Promise<void>(r=>setImmediate(r));assert.equal(closed,false);
    const denied=await f.request();assert.equal(denied.status,503);await denied.text();
  }
  f.release.resolve();const response=await flight;
  assert.equal(response.status,action==='revoke'?403:action==='abort'?499:503);await response.text();
  if(closing)await closing;
  assert.equal(f.commands(),1);assert.equal(f.budget.reservedBytes,0);
});
for(const action of ['abort','close'] as const)test(`delivered but unconsumed response is reclaimed on ${action}`,async t=>{
  const f=await fixture(t),abort=new AbortController(),response=await f.request('GET',abort.signal);
  assert.equal(response.status,200);assert.ok(f.budget.reservedBytes>0);
  if(action==='abort')abort.abort();else await f.route.close();
  await assert.rejects(response.text(),/shared_content_response_closed/);assert.equal(f.budget.reservedBytes,0);
});
test('concurrent workspace content overview reads admit bursts >4 cards without 503',async t=>{
  const store=new HubStore(':memory:','fixture'),user=store.createUser('Member'),key=store.identities.issueKey(user.id);
  store.boards.save(user.id,'default',{title:'PRIVATE',tasks:[],revision:0,mutationId:randomUUID()});
  const original=new OriginalHubAdministrativeCommands(store),budget=new ContentOverviewResponses(32*1024*1024),app=new Hono();
  const route=registerAsyncHubContentOverview(app,{access:new AsyncHubContentDocuments({command:(kind,input)=>original.command(kind,input)}),enabled:()=>true,responses:budget});
  t.after(async()=>{await route.close();budget.close();await original.close();await store.close();});
  const responses=await Promise.all(Array.from({length:8},(_,i)=>app.fetch(new Request('http://hub.invalid/api/hub/v1/workspace/shared-content/'+encodeURIComponent(resourceId),{headers:{'x-agentopsdeck-key':key.token}}))));
  for(const res of responses){assert.equal(res.status,200);await res.text();}
  assert.equal(budget.reservedBytes,0);
});
test('notebook hot HTTP overview omits bound archive, retains CAS, timings and strict query validation',async t=>{
  const f=await fixture(t),resource=JSON.stringify(['notebook','hub:default']),archive='存档\\"'.repeat(13_000);
  f.store.upsertConnection({id:'node',label:'Node',ownerUserId:f.user.id,connectorUrl:'http://fixture.invalid',credentialToken:'private'});
  const authority=f.store.connectionAuthority('node',f.user.id)!;
  f.store.pinConnectionNode('node',f.user.id,authority,'node_'+randomUUID());
  const binding={bindingId:randomUUID(),userId:f.user.id,resourceId:resource,sessionId:encodeHubSessionId('node','codex:fixture'),connectionId:'node',authority:f.store.connectionAuthority('node',f.user.id)!};
  const revision=f.store.cardFileProjection.get(f.user.id,resource)!.revision;
  assert.ok(f.store.cardFiles.prepare(binding,revision));assert.ok(f.store.cardFiles.activate(f.user.id,binding.bindingId));
  const ref=f.store.cardFileProjection.notebookRef(f.user.id,resource)!;
  assert.ok(f.store.notebooks.save(f.user.id,{resourceId:ref.textId,revision:f.store.notebooks.get(f.user.id,ref.textId).revision,text:'x'.repeat(90)},binding.bindingId));
  assert.ok(f.store.notebooks.saveArchive(f.user.id,{resourceId:ref.textId,revision:f.store.notebooks.archiveRevision(f.user.id,ref.textId),text:archive},binding.bindingId));
  const full=f.store.cardFileProjection.get(f.user.id,resource)!;
  assert.equal(full.kind,'notebook');
  if(full.kind!=='notebook')assert.fail();
  assert.equal(full.content.archive,archive);
  // Prepared whole-note bindings own both areas; the ordinary full projection
  // remains the file export contract, independent of the hot HTTP projection.
  const original=new OriginalHubAdministrativeCommands(f.store),app=new Hono(),budget=new ContentOverviewResponses(2*1024*1024);
  const route=registerAsyncHubContentOverview(app,{access:new AsyncHubContentDocuments({command:(kind,input)=>original.command(kind,input)}),enabled:()=>true,responses:budget});
  t.after(async()=>{await route.close();budget.close();await original.close();});
  const request=(suffix:string)=>app.fetch(new Request('http://hub.invalid/api/hub/v1/workspace/shared-content/'+encodeURIComponent(resource)+suffix,{headers:{'x-agentopsdeck-key':f.key.token}}));
  for(const suffix of ['', '?view=hot']){
    const response=await request(suffix);assert.equal(response.status,200,await response.clone().text());
    assert.match(response.headers.get('server-timing')!,/auth;dur=\d.*owner;dur=\d.*assemble;dur=\d/);
    const body=await response.text(),value=JSON.parse(body);
    assert.equal(value.native.revision,full.revision);
    assert.equal(value.native.content.text.length,90);
    if(suffix){assert.equal(value.nativeView,'hot');assert.equal(Object.hasOwn(value.native.content,'archive'),false);assert.ok(Buffer.byteLength(body)<1000);}
    else assert.deepEqual(value.native,full);
    assert.equal(budget.reservedBytes,0);
  }
  for(const suffix of ['?view=hot&view=hot','?view=hot&owner=other']){
    const response=await request(suffix);assert.equal(response.status,400);await response.text();
  }
});
