import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {Hono} from 'hono';
import {HubStore} from './hub-store.js';
import {OriginalHubAdministrativeCommands} from './original-administrative-commands.js';
import {AsyncHubMemberOwner} from './async-member-owner.js';
import {createHubAdministrativeServices} from './administrative-route-services.js';
import {hubMemberEvidence,hubMemberResultBudget} from './member-owner-domain.js';
import {PerformanceDiagnostics} from '../diagnostics/performance.js';
import {loadConfig} from '../config.js';
import {registerHubRoutes} from '../routes/hub.js';
import {encodeHubSessionId} from './session-id.js';
import type {ContentBinding,ContentResource} from './content-proposal-store.js';

const resource=JSON.stringify(['taskboard','default']);
const url=(id=resource)=>'http://hub.invalid/api/hub/v1/workspace/shared-content/'+encodeURIComponent(id);
type Overview={enabled:boolean;head:ContentResource|null;native:unknown;bindings:ContentBinding[]};
async function fixture(t:TestContext,mode:'original'|'worker',large=false,nativeDetails='',boundNotebook=false){
  const root=mkdtempSync(join(tmpdir(),'content-overview-production-')),file=join(root,'hub.sqlite');
  const seed=new HubStore(file,'fixture'),user=seed.createUser('Member'),key=seed.identities.issueKey(user.id);
  (seed as unknown as {db:DatabaseSync}).db.prepare("INSERT INTO hub_roles VALUES ('default','admin',1)").run();
  const admin=seed.identities.issueKey('default'),cookie=seed.identities.createSession(key.token)!;
  const tasks=Array.from({length:Math.ceil(nativeDetails.length/4000)},(_,i)=>({id:randomUUID(),title:'Task',detail:nativeDetails.slice(i*4000,(i+1)*4000),status:'todo' as const}));
  seed.boards.save(user.id,'default',{title:'PRIVATE_OVERVIEW_NATIVE',tasks,revision:0,mutationId:randomUUID()});
  seed.notebooks.save(user.id,{resourceId:JSON.stringify(['hub-notebook',1]),revision:0,text:nativeDetails});
  seed.notebooks.saveArchive(user.id,{resourceId:JSON.stringify(['hub-notebook',1]),revision:0,text:'PRIVATE_COLD_ARCHIVE'});
  const id=large?JSON.stringify(['native-drawio',randomUUID()]):resource;
  let expected:ContentResource|undefined;
  if(large){
    seed.upsertConnection({id:'node',label:'Node',ownerUserId:user.id,connectorUrl:'http://fixture.invalid',credentialToken:'private'});
    seed.pinConnectionNode('node',user.id,seed.connectionAuthority('node',user.id)!,'node_'+randomUUID());
    const store=seed.createContentDocumentStore(),authority=seed.connectionAuthority('node',user.id)!;
    const content=JSON.stringify({kind:'native-drawio',content:{format:'drawio-xml',version:1,title:'Large',xml:'<mxfile>'+ '"'.repeat(700_000)+'</mxfile>'}});
    expected=await store.initializeAsync(user.id,id,randomUUID(),content);
    for(let i=0;i<16;i++)await store.bindAsync(user.id,id,randomUUID(),JSON.stringify(['node',authority]),{
      target:{connectionId:'node',sessionId:encodeHubSessionId('node','codex:fixture'),sessionKey:'codex:fixture',authority},epoch:expected.epoch,revision:expected.revision});
  }
  if(boundNotebook){
    seed.upsertConnection({id:'note-node',label:'Note',ownerUserId:user.id,connectorUrl:'http://fixture.invalid',credentialToken:'private'});
    seed.pinConnectionNode('note-node',user.id,seed.connectionAuthority('note-node',user.id)!,'node_'+randomUUID());
    const note=JSON.stringify(['notebook','hub:default']),textId=JSON.stringify(['hub-notebook',1]);
    seed.notebooks.saveArchive(user.id,{resourceId:textId,revision:seed.notebooks.archiveRevision(user.id,textId),text:'cold'.repeat(17000)});
    const binding={bindingId:randomUUID(),userId:user.id,resourceId:note,sessionId:encodeHubSessionId('note-node','codex:fixture'),connectionId:'note-node',authority:seed.connectionAuthority('note-node',user.id)!};
    assert.ok(seed.cardFiles.prepare(binding,seed.cardFileProjection.get(user.id,note)!.revision));
    assert.ok(seed.cardFiles.activate(user.id,binding.bindingId));
  }
  await seed.close();
  const metadata=new HubStore(mode==='original'?file:join(root,'composition.sqlite'),'fixture');
  const lines:string[]=[],diagnostics=new PerformanceDiagnostics(line=>lines.push(line));
  const owner=mode==='original'?new OriginalHubAdministrativeCommands(metadata,diagnostics):new AsyncHubMemberOwner({file,encryptionSecret:'fixture'},diagnostics);
  const group=createHubAdministrativeServices(owner,diagnostics);let guarded=false,sync=0;
  const store=new Proxy(metadata,{get(target,p,receiver){if(guarded){sync++;throw Error('MAIN_THREAD_OVERVIEW_SQL');}return Reflect.get(target,p,receiver);}});
  const config={...loadConfig({HOME:root,AOD_SERVER_ROLE:'hub'}),boardFilesEnabled:false},app=new Hono();
  let routes:ReturnType<typeof registerHubRoutes>;
  t.after(async()=>{guarded=false;
    try { await routes?.close(); } finally {
      try { await group.close(); } finally {
        try { await owner.close(); } finally { await metadata.close(); rmSync(root,{recursive:true,force:true}); }
      }
    }
    assert.equal(sync,0);for(const secret of [key.token,admin.token,cookie,'PRIVATE_OVERVIEW_NATIVE'])assert.equal(lines.join('').includes(secret),false);
  });
  routes=registerHubRoutes(app,{config,hubStore:store,administrative:group,
    principal:()=>{sync++;throw Error('MAIN_THREAD_OVERVIEW_PRINCIPAL');},connectorClient:()=>{sync++;throw Error('UNEXPECTED_NETWORK');},
    fileCardClient:()=>{sync++;throw Error('UNEXPECTED_FILE_EFFECT');},normalizeError:()=> 'safe'});
  assert.ok(routes);guarded=true;config.boardFilesEnabled=true;
  const request=(method='GET',headers:Record<string,string>={'x-agentopsdeck-key':key.token},resourceId=id,suffix='')=>
    app.fetch(new Request(url(resourceId)+suffix,{method,headers}));
  const revoke=async()=>{
    const evidence=hubMemberEvidence(new Request(url(),{headers:{'x-agentopsdeck-key':admin.token}}));
    const snapshot=await owner.command('memberSnapshot',evidence);assert.ok(snapshot);
    await owner.command('memberKeyRevoke',{evidence,expectedScope:snapshot.recoveryScope,userId:user.id,keyId:key.id});
  };
  return {request,revoke,key,cookie,config,expected,id};
}
for(const mode of ['original','worker'] as const)test(`${mode}: production overview bypasses synchronous SQL/principal/effects and retains legacy native/canonical shape`,async t=>{
  const f=await fixture(t,mode);
  for(const headers of [{'x-agentopsdeck-key':f.key.token},{authorization:'Bearer '+f.key.token},{cookie:'agentopsdeck_session='+f.cookie}]){
    const response=await f.request('GET',headers);assert.equal(response.status,200,await response.clone().text());
    assert.equal(response.headers.get('cache-control'),'no-store');
    const value=await response.json() as Overview;assert.deepEqual(Object.keys(value),['enabled','head','native','bindings']);
    assert.equal(value.enabled,true);assert.equal(value.head,null);assert.deepEqual(value.bindings,[]);
    assert.deepEqual(value.native,{kind:'taskboard',content:{title:'PRIVATE_OVERVIEW_NATIVE',tasks:[]},revision:1});
  }
  f.config.boardFilesEnabled=false;
  const disabled=await f.request();assert.equal(disabled.status,200);assert.equal((await disabled.json() as Overview).enabled,false);
  const head=await f.request('HEAD');assert.equal(head.status,200);assert.equal(await head.text(),'');
  const missing=await f.request('GET',undefined,JSON.stringify(['notebook',randomUUID()]));assert.equal(missing.status,200);
  assert.deepEqual(await missing.json(),{enabled:false,head:null,native:null,bindings:[]});
  const status=await f.request('GET',undefined,JSON.stringify(['statuscard','default']));assert.equal(status.status,200);
  assert.equal((await status.json() as Overview).native!==null,true);
  for(const [resourceId,suffix,headers,expectedStatus] of [
    [resource,'?owner=foreign',{'x-agentopsdeck-key':f.key.token},400],['not-a-resource','',{'x-agentopsdeck-key':f.key.token},400],
    [resource,'',{'x-agentopsdeck-key':f.key.token,'x-agentopsdeck-recovery-scope':'0'.repeat(64)},409],
  ] as const){const response=await f.request('GET',headers,resourceId,suffix);assert.equal(response.status,expectedStatus);await response.text();}
  await f.revoke();const revoked=await f.request();assert.equal(revoked.status,401);await revoked.text();
});
test('worker: legal native overview above metadata budget survives concurrent card reads',async t=>{
  const detail='你\\"'.repeat(15000),f=await fixture(t,'worker',false,detail);
  const responses=await Promise.all(Array.from({length:8},()=>f.request()));
  for(const response of responses){
    assert.equal(response.status,200,await response.clone().text());
    const body=await response.text();assert.ok(Buffer.byteLength(body)>64*1024);
    const value=JSON.parse(body) as Overview;
    assert.equal(value.head,null);
    const native=value.native as {content:{tasks:{detail:string}[]}};
    assert.equal(native.content.tasks.map(task=>task.detail).join(''),detail);
  }
});
test('worker: large native notebook survives the same overview path without exposing undelegated archive',async t=>{
  const text='笔记\\"'.repeat(12000),f=await fixture(t,'worker',false,text);
  const response=await f.request('GET',undefined,JSON.stringify(['notebook','hub:default']));
  assert.equal(response.status,200,await response.clone().text());
  const body=await response.text();assert.ok(Buffer.byteLength(body)>64*1024);
  const value=JSON.parse(body) as Overview;
  assert.equal(value.head,null);
  assert.deepEqual(value.native,{kind:'notebook',content:{title:'Notebook',text},revision:2});
  assert.equal(body.includes('PRIVATE_COLD_ARCHIVE'),false);
});
test('worker: hot notebook view crosses production owner RPC without its delegated archive',async t=>{
  const text='x'.repeat(90),f=await fixture(t,'worker',false,text,true),note=JSON.stringify(['notebook','hub:default']);
  const fullResponse=await f.request('GET',undefined,note);assert.equal(fullResponse.status,200);
  const full=await fullResponse.json() as {native:{revision:number;content:{text:string;archive:string}}};
  assert.equal(full.native.content.archive,'cold'.repeat(17000));
  const response=await f.request('GET',undefined,note,'?view=hot');assert.equal(response.status,200);
  assert.ok(response.headers.get('server-timing')?.includes('owner;dur='));
  const body=await response.text();assert.ok(Buffer.byteLength(body)<1000);
  const hot=JSON.parse(body);assert.equal(hot.nativeView,'hot');assert.equal(hot.native.revision,full.native.revision);
  assert.equal(hot.native.content.text,text);assert.equal(Object.hasOwn(hot.native.content,'archive'),false);
});
test('worker production overview over 32MiB retains every original initial snapshot within unchanged RPC budget',{timeout:90_000},async t=>{
  const f=await fixture(t,'worker',true),response=await f.request();assert.equal(response.status,200);
  const body=await response.text();assert.ok(Buffer.byteLength(body)>32*1024*1024);
  const value=JSON.parse(body) as Overview;assert.equal(value.bindings.length,16);assert.deepEqual(value.head,f.expected);
  assert.equal(new Set(value.bindings.map(b=>b.id)).size,16);
  for(const binding of value.bindings)assert.deepEqual(binding.initial,f.expected);
  assert.equal(hubMemberResultBudget('contentDocument'),32*1024*1024);
});
