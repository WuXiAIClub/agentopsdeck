import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Hono} from 'hono';
import {CONNECTOR_PROTOCOL_HEADER,CONNECTOR_PROTOCOL} from '@agentopsdeck/shared';
import {HubStore} from '../hub/hub-store.js';
import {ConnectorClient} from '../hub/connector-client.js';
import {encodeHubSessionId} from '../hub/session-id.js';
import {registerHubSessionGuidance} from './hub-session-guidance.js';
import {PerformanceDiagnostics} from '../diagnostics/performance.js';
import {NODE_ID_HEADER} from '../connector/node-identity.js';

function fixture(t:{after:(fn:()=>void)=>void},diagnostics?:PerformanceDiagnostics) {
  const dir=mkdtempSync(join(tmpdir(),'guidance-http-')),path=join(dir,'hub.sqlite');let hub=new HubStore(path,'test'),app=new Hono();
  const owner=hub.createUser('Alice').id,other=hub.createUser('Bob').id;
  hub.upsertConnection({id:'dev',ownerUserId:owner,label:'Dev',connectorUrl:'https://connector.example'});
  const nodeId='node_'+randomUUID();
  hub.pinConnectionNode('dev',owner,hub.connectionAuthority('dev',owner)!,nodeId);
  const session=encodeHubSessionId('dev','codex:synthetic'),receipts=new Map<string,unknown>();
  let posts=0,gets=0,lost=false,offline=false,revoke=false,wrongKey=false,denyTransactionAt=0,transactionChecks=0;const messages:string[]=[];
  let clientNode:string|undefined=nodeId;
  const client=()=>new ConnectorClient('https://connector.example','synthetic',async req=>{
    let command:unknown;
    if(req.method==='POST'){
      posts++;const body=await req.json() as {message:string;idempotencyKey:string};messages.push(body.message);
      assert.equal(req.headers.get('idempotency-key'),body.idempotencyKey);
      command={key:wrongKey?'different':body.idempotencyKey,id:randomUUID(),state:'accepted'};receipts.set(body.idempotencyKey,command);
      if(lost)throw Error('lost ACK');
    }else{gets++;if(offline)throw Error('offline');command=receipts.get(decodeURIComponent(new URL(req.url).pathname.split('/').at(-1)!));}
    if(revoke)hub.upsertConnection({id:'dev',ownerUserId:owner,label:'Dev',connectorUrl:'https://connector.example',status:'disabled'});
    return new Response(JSON.stringify(command?{command}:{error:'missing'}),{status:command?200:404,headers:{'content-type':'application/json',[CONNECTOR_PROTOCOL_HEADER]:String(CONNECTOR_PROTOCOL.max),[NODE_ID_HEADER]:nodeId}});
  },10000,8*1024*1024,clientNode===undefined?{}:{nodeId:clientNode});
  const mount=()=>registerHubSessionGuidance(app,{hubStore:hub,principal:c=>({userId:denyTransactionAt&&(hub as any).db.isTransaction&&++transactionChecks===denyTransactionAt?other:c.req.header('x-user')??owner,admin:false}),connectorClient:client,...(diagnostics?{diagnostics}:{})});let routes=mount();
  const req=(method:string,suffix='',body?:unknown,user=owner)=>app.request(`/api/hub/v1/sessions/${encodeURIComponent(session)}/guidance${suffix}`,{
    method,headers:{'x-user':user},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  t.after(()=>{routes.close();hub.close();rmSync(dir,{recursive:true,force:true});});
  return{req,messages,owner,other,get posts(){return posts;},get gets(){return gets;},lost(){lost=true;offline=true;},online(){offline=false;},revoke(){revoke=true;},wrong(){wrongKey=true;},denySettlement(){transactionChecks=0;denyTransactionAt=2;},
    unpin(){clientNode=undefined;}, wrongNode(){clientNode='node_'+randomUUID();},
    reopen(){routes.close();hub.close();hub=new HubStore(path,'test');app=new Hono();routes=mount();}};
}
async function preview(f:ReturnType<typeof fixture>) {
  assert.equal((await f.req('PUT','',{revision:0,text:'Keep this guidance.',enabled:true})).status,200);
  const id=randomUUID(),r=await f.req('POST','/submissions',{requestId:id,revision:1});assert.equal(r.status,201);return id;
}
for(const node of ['unpinned','wrong'] as const)
test(`guidance refuses ${node} transport identity without dispatch or replay`,async t=>{
  const f=fixture(t),id=await preview(f);
  if(node==='unpinned')f.unpin();else f.wrongNode();
  const response=await f.req('POST',`/submissions/${id}/submit`,{});
  assert.equal(response.status,200);assert.equal(f.posts,0);
  assert.equal((await response.json()).receipt.state,'unknown');
  await f.req('POST',`/submissions/${id}/submit`,{});
  await f.req('GET',`/submissions/${id}`);
  assert.equal(f.posts,0);
});
for(const change of ['save','prepare','cancel','claim'] as const)
test(`guidance HTTP ${change} refuses revoked settlement without a save or dispatch`,async t=>{
  const f=fixture(t),id=await preview(f),fresh=randomUUID();f.denySettlement();
  const r=change==='save'?await f.req('PUT','',{revision:1,text:'Rejected new text',enabled:true})
    :change==='prepare'?await f.req('POST','/submissions',{requestId:fresh,revision:1})
    :change==='cancel'?await f.req('DELETE',`/submissions/${id}`)
    :await f.req('POST',`/submissions/${id}/submit`,{});
  assert.equal(r.status,403);assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(f.posts,0);
  const receipt=await f.req('GET',`/submissions/${id}`);assert.equal(receipt.status,200);assert.equal((await receipt.json()).receipt.state,'prepared');
  assert.equal((await f.req('GET',`/submissions/${fresh}`)).status,404);
  assert.equal((await (await f.req('GET')).json()).guidance.config.text,'Keep this guidance.');
});
test('guidance route phases and lost ACK recovery are observable without private data or resends',async t=>{
  const rows:any[]=[],f=fixture(t,new PerformanceDiagnostics(line=>rows.push(JSON.parse(line)))),id=await preview(f);
  f.lost();const response=await f.req('POST',`/submissions/${id}/submit`,{});
  assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
  assert.equal((await response.json()).receipt.state,'unknown');
  await f.req('GET',`/submissions/${id}`);assert.equal(f.posts,1);
  assert.ok(rows.some(row=>row.step===8&&row.unknown===1));assert.ok(rows.some(row=>row.step===7&&row.unknown===1));
  assert.ok(rows.some(row=>row.step===6));assert.ok(rows.some(row=>row.step===4));
  const before=f.posts;f.reopen();f.online();assert.equal((await (await f.req('GET',`/submissions/${id}`)).json()).receipt.state,'submitted');
  assert.equal(f.posts,before);
  await f.req('DELETE',`/submissions/${randomUUID()}`);assert.ok(rows.some(row=>row.step===5));
  const encoded=JSON.stringify(rows);for(const privateValue of [id,f.owner,f.other,'Keep this guidance.','connector.example','synthetic','lost ACK','offline'])assert.equal(encoded.includes(privateValue),false);
  assert.ok(rows.every(row=>row.operation==='hub-session-guidance'));
});
test('throwing guidance log sink never changes durable once-only dispatch or read-only recovery',async t=>{
  const f=fixture(t,new PerformanceDiagnostics(()=>{throw Error('PRIVATE log sink');})),id=await preview(f);
  f.lost();assert.equal((await (await f.req('POST',`/submissions/${id}/submit`,{})).json()).receipt.state,'unknown');
  f.online();assert.equal((await (await f.req('GET',`/submissions/${id}`)).json()).receipt.state,'submitted');
  await f.req('POST',`/submissions/${id}/submit`,{});assert.equal(f.posts,1);
});
test('guidance wrong-key ACK and foreign owner refusal have fixed deferred diagnostics',async t=>{
  const rows:any[]=[],f=fixture(t,new PerformanceDiagnostics(line=>rows.push(JSON.parse(line)))),id=await preview(f);
  f.wrong();assert.equal((await (await f.req('POST',`/submissions/${id}/submit`,{})).json()).receipt.state,'unknown');
  assert.ok(rows.some(row=>row.step===9&&row.deferred===1));
  assert.equal((await f.req('GET','',undefined,f.other)).status,404);
  assert.ok(rows.some(row=>row.step===1&&row.category==='failed'&&row.deferred===1));assert.equal(f.posts,1);
});
test('save and preview cannot send; explicit submit is once only; queue acceptance is not context proof',async t=>{
  const f=fixture(t),id=await preview(f);assert.equal(f.posts,0);
  const r=await f.req('POST',`/submissions/${id}/submit`,{});assert.equal(r.status,200);assert.equal((await r.json()).receipt.state,'submitted');
  await f.req('POST',`/submissions/${id}/submit`,{});assert.equal(f.posts,1);assert.deepEqual(f.messages,['Keep this guidance.']);
  const state=await (await f.req('GET')).json();assert.equal(state.contextVerification,'unsupported');assert.equal(state.guidance.state,'unknown');
  assert.equal((await f.req('GET','',undefined,f.other)).status,404);
});
test('lost ACK and physical reopen recover original key only; no repeat send on POST or GET',async t=>{
  const f=fixture(t),id=await preview(f);f.lost();
  assert.equal((await (await f.req('POST',`/submissions/${id}/submit`,{})).json()).receipt.state,'unknown');
  f.reopen();f.online();assert.equal((await (await f.req('GET',`/submissions/${id}`)).json()).receipt.state,'submitted');
  await f.req('POST',`/submissions/${id}/submit`,{});assert.equal(f.posts,1);
});
test('optional next input is immutable, previewed and submitted once with guidance across reopen',async t=>{
  const f=fixture(t);await f.req('PUT','',{revision:0,text:'Guidance',enabled:true});
  const id=randomUUID(),body={requestId:id,revision:1,input:'Next user message'};
  const p=await f.req('POST','/submissions',body);assert.equal(p.status,201);
  assert.equal((await p.json()).receipt.text,'Guidance\n\nNext user message');assert.equal(f.posts,0);
  assert.equal((await f.req('POST','/submissions',{...body,input:'Changed'})).status,409);
  assert.equal((await f.req('POST','/submissions',{...body,requestId:randomUUID(),input:'x'.repeat(8001)})).status,400);
  f.lost();await f.req('POST',`/submissions/${id}/submit`,{});f.reopen();f.online();
  assert.equal((await (await f.req('GET',`/submissions/${id}`)).json()).receipt.state,'submitted');
  await f.req('POST',`/submissions/${id}/submit`,{});
  assert.deepEqual(f.messages,['Guidance\n\nNext user message']);assert.equal(f.posts,1);
});
test('changed config blocks old preview and disabled config cannot prepare',async t=>{
  const f=fixture(t),id=await preview(f);await f.req('PUT','',{revision:1,text:'new',enabled:false});
  assert.equal((await f.req('POST',`/submissions/${id}/submit`,{})).status,409);assert.equal(f.posts,0);
  assert.equal((await f.req('POST','/submissions',{requestId:randomUUID(),revision:2})).status,409);
  assert.equal((await f.req('PUT','',{revision:0,text:'stale',enabled:true})).status,409);
});
test('absent-preview cancellation tombstone rejects a late prepare after restart',async t=>{
  const f=fixture(t),id=randomUUID();assert.equal((await f.req('DELETE',`/submissions/${id}`)).status,200);f.reopen();
  await f.req('PUT','',{revision:0,text:'guidance',enabled:true});
  assert.equal((await f.req('POST','/submissions',{requestId:id,revision:1})).status,409);
  assert.equal((await (await f.req('GET',`/submissions/${id}`)).json()).cancelled,true);assert.equal(f.posts,0);
});
test('mismatched native receipt never settles an unknown delivery and cannot be cancelled',async t=>{
  const f=fixture(t),id=await preview(f);f.wrong();
  assert.equal((await (await f.req('POST',`/submissions/${id}/submit`,{})).json()).receipt.state,'unknown');
  assert.equal((await f.req('DELETE',`/submissions/${id}`)).status,409);assert.equal(f.posts,1);
});
test('revocation across native await releases no old-account result',async t=>{
  const f=fixture(t),id=await preview(f);f.revoke();assert.equal((await f.req('POST',`/submissions/${id}/submit`,{})).status,403);
  assert.equal((await f.req('GET',`/submissions/${id}`)).status,404);assert.equal(f.posts,1);
});
