import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { QuickChatStore } from '../hub/quick-chat-store.js';
import { QuickChatService } from '../hub/quick-chat-service.js';
import { registerHubQuickChat } from './hub-quick-chat.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const config = {url:'https://private-provider.invalid/v1/responses',model:'fixture-model',token:'PRIVATE_PROVIDER_TOKEN',users:['alice']};
async function fixture(work: (f: ReturnType<typeof setup>)=>Promise<void>, throwing = false, loseAck = false) {
  const f=setup(throwing,loseAck);try{await work(f);}finally{f.service.close();f.db.close();}
}
function setup(throwing:boolean, loseAck:boolean) {
  const db=new DatabaseSync(':memory:'),store=new QuickChatStore(db,Date.now,Buffer.alloc(32,1));
  const logs:string[]=[];let owner='alice',posts=0;
  const diagnostics=new PerformanceDiagnostics(line=>{logs.push(line);if(throwing)throw Error('PRIVATE_SINK_FAILURE');});
  const service=new QuickChatService(store,config,async()=>{
    posts++;if(loseAck)throw Error('PRIVATE_PROVIDER_FAILURE');
    return Response.json({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'PRIVATE_OUTPUT'}]}]});
  });
  const app=new Hono();registerHubQuickChat(app,{service,diagnostics,principal:()=>({userId:owner,admin:false})});
  const profileId=randomUUID(),requestId=randomUUID();
  const profile={revision:0,name:'Temporary',target:'hub-standalone',model:config.model,outputLimit:512};
  const body={requestId,profileId,revision:1,input:'PRIVATE_INPUT'};
  const request=(path='',method='GET',data?:unknown)=>app.request('/api/hub/v1/quick-chat'+path,{method,
    ...(data===undefined?{}:{body:JSON.stringify(data),headers:{'Content-Type':'application/json'}})});
  return{db,store,service,diagnostics,logs,request,profile,body,profileId,requestId,posts:()=>posts,changeOwner:()=>{owner='bob';}};
}
test('quick chat fixed stage logs distinguish unknown from errors without private data or replay',()=>fixture(async f=>{
  assert.equal((await f.request()).status,200);
  assert.equal((await f.request('/profiles/'+f.profileId,'PUT',f.profile)).status,200);
  const first=await f.request('/requests','POST',f.body);assert.equal(first.status,200);assert.equal((await first.json()).receipt.state,'unknown');
  assert.equal((await f.request('/requests/'+f.requestId)).status,200);
  assert.equal((await f.request('/requests/'+f.requestId+'/result','DELETE')).status,409);
  assert.equal((await f.request('/requests/'+f.requestId+'/cancel','POST',{})).status,409);
  assert.equal((await f.request('/requests','POST',f.body)).status,200);assert.equal(f.posts(),1);
  const events=f.logs.map(line=>JSON.parse(line)).filter(e=>e.operation==='hub-quick-chat');
  assert.deepEqual([...new Set(events.map(e=>e.step))].sort(),[1,2,3,4,5,6]);
  assert.ok(events.some(e=>e.step===3&&e.unknown===1));assert.ok(events.some(e=>e.category==='failed'));
  assert.ok(f.diagnostics.snapshot().events.some(e=>e.operation==='hub-quick-chat'&&e.unknown===1));
  for(const privateValue of ['PRIVATE_INPUT','PRIVATE_OUTPUT',config.token,config.url,f.profileId,f.requestId,'PRIVATE_PROVIDER_FAILURE'])
    assert.equal(f.logs.join('\n').includes(privateValue),false);
},false,true));
test('throwing log sink cannot alter durable result, create duplicate POST or break existing response shape',()=>fixture(async f=>{
  assert.equal((await f.request('/profiles/'+f.profileId,'PUT',f.profile)).status,200);
  const response=await f.request('/requests','POST',f.body);assert.equal(response.status,200);
  const result=await response.json();assert.equal(result.output,'PRIVATE_OUTPUT');assert.equal(result.receipt.state,'completed');
  for(const key of ['fingerprint','capabilityEpoch','resultRef'])assert.equal(Object.hasOwn(result.receipt,key),false);
  assert.equal((await f.request('/requests','POST',f.body)).status,200);assert.equal(f.posts(),1);
  assert.equal((await f.request('/requests/'+f.requestId+'/result','DELETE')).status,200);
  assert.equal((await f.request('/requests','POST',f.body)).status,200);assert.equal(f.posts(),1);
  assert.ok(f.diagnostics.snapshot().totals.sinkFailures>0);
},true));
test('fresh authority loss after claim SQL rolls back UNKNOWN and never dispatches provider I/O',()=>fixture(async f=>{
  assert.equal((await f.request('/profiles/'+f.profileId,'PUT',f.profile)).status,200);
  const original=f.store.claim.bind(f.store);let checks=0;
  f.store.claim=(owner,id,input,capability,authorized)=>original(owner,id,input,capability,()=>{
    if(++checks===3)f.changeOwner();return authorized();
  });
  const response=await f.request('/requests','POST',f.body);assert.equal(response.status,403);assert.equal(checks,3);
  assert.equal(f.posts(),0);assert.equal(f.store.receipt('alice',f.requestId)?.state,'admitted');assert.equal(f.db.isTransaction,false);
}));
for(const action of ['save','cancel','clear'] as const)
test('HTTP '+action+' rechecks principal inside root transaction before COMMIT',()=>fixture(async f=>{
  assert.equal((await f.request('/profiles/'+f.profileId,'PUT',f.profile)).status,200);
  if(action==='cancel'){
    const cap={ephemeralRequest:true,noPersistentThread:true,originalLookup:true,maxOutput:2000,epoch:'fixture'};
    f.store.admit('alice',f.requestId,f.profileId,1,'input',cap);
  }else if(action==='clear')assert.equal((await f.request('/requests','POST',f.body)).status,200);
  let checks=0;
  const fault=(authorized:()=>boolean)=>()=>{if(++checks===2)f.changeOwner();return authorized();};
  if(action==='save'){
    const original=f.store.saveProfile.bind(f.store);
    f.store.saveProfile=(owner,revision,profile,cap,authorized)=>original(owner,revision,profile,cap,fault(authorized!));
    assert.equal((await f.request('/profiles/'+f.profileId,'PUT',{...f.profile,revision:1,name:'Changed'})).status,403);
    assert.equal(f.store.profile('alice',f.profileId)?.name,'Temporary');
  }else if(action==='cancel'){
    const original=f.store.cancelAdmitted.bind(f.store);
    f.store.cancelAdmitted=(owner,id,authorized)=>original(owner,id,fault(authorized!));
    assert.equal((await f.request('/requests/'+f.requestId+'/cancel','POST',{})).status,403);
    assert.equal(f.store.receipt('alice',f.requestId)?.state,'admitted');
  }else{
    const original=f.store.clearResult.bind(f.store);
    f.store.clearResult=(owner,id,authorized)=>original(owner,id,fault(authorized!));
    assert.equal((await f.request('/requests/'+f.requestId+'/result','DELETE')).status,403);
    assert.equal(f.store.result('alice',f.requestId),'PRIVATE_OUTPUT');
  }
  assert.equal(checks,2);assert.equal(f.db.isTransaction,false);
}));
test('throwing authority still rolls back and is not treated as sending permission',()=>fixture(async f=>{
  assert.equal((await f.request('/profiles/'+f.profileId,'PUT',f.profile)).status,200);
  const original=f.store.claim.bind(f.store);let calls=0;
  f.store.claim=(owner,id,input,cap,authorized)=>original(owner,id,input,cap,()=>{
    if(++calls===3)throw new HTTPException(403);return authorized();
  });
  assert.equal((await f.request('/requests','POST',f.body)).status,403);assert.equal(f.posts(),0);
  assert.equal(f.store.receipt('alice',f.requestId)?.state,'admitted');
}));
