import assert from 'node:assert/strict';
import test from 'node:test';
import { CONNECTOR_PROTOCOL, CONNECTOR_PROTOCOL_HEADER, type InteractionView } from '@agentopsdeck/shared';
import { ConnectorClient } from './connector-client.js';
import { NODE_ID_HEADER } from '../connector/node-identity.js';
import { encodeHubSessionId } from './session-id.js';
import { readWeixinActionResult, validWeixinAction, weixinActionFor, weixinActionWire, type WeixinAction } from './weixin-action-contract.js';
import { weixinOriginalAction } from './weixin-bridge.js';

const stop: WeixinAction = {operation:'stop',sessionKey:'codex:session',runId:'run1',key:'original-key'};
const answer: WeixinAction = {operation:'answer',sessionKey:'codex:session',requestId:'request1',ownerId:'owner1',
  submission:{runId:'run1',responseId:'original-response',expectedRevision:2,answer:{kind:'approval',decision:'deny'}}};
const view: InteractionView = {request:{version:1,ownerId:'owner1',nodeId:'node1',sessionKey:'codex:session',runId:'run1',requestId:'request1',kind:'approval',
  prompt:'Question',createdAt:Date.now(),expiresAt:Date.now()+60_000},revision:2,status:'answered',delivery:'confirmed'};
const headers = {[CONNECTOR_PROTOCOL_HEADER]:String(CONNECTOR_PROTOCOL.max),[NODE_ID_HEADER]:'node1'};
const response = (body:unknown,status=200) => Response.json(body,{status,headers});
const result = (command:WeixinAction) => command.operation==='stop'?{status:'interrupt_requested'}:view;
function gate() {let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}

test('only fixed original Codex stop and interaction paths enroll; public evidence never enrolls',()=>{
  const session=encodeHubSessionId('node','codex:session'),base=`/api/hub/v1/sessions/${encodeURIComponent(session)}`;
  const payload={message:'/stop',expectedRunId:'run1',deliveryMode:'web-only',media:[],idempotencyKey:'original-key'};
  assert.deepEqual(weixinActionFor('owner1',`${base}/messages`,payload),stop);
  assert.deepEqual(weixinActionFor('owner1',`${base}/interactions/request1/answer`,answer.submission),answer);
  for(const body of [{...payload,message:'message'},{...payload,media:[{}]},{...payload,extra:true},{...payload,expectedRunId:''}])
    assert.equal(weixinActionFor('owner1',`${base}/messages`,body),undefined);
  for(const path of [`${base}/messages?escape=true`,`${base}/messages#escape`,'/arbitrary'])assert.equal(weixinActionFor('owner1',path,payload),undefined);
  assert.equal(validWeixinAction({...stop,sessionKey:'claude:session'}),false);
  assert.equal(validWeixinAction({...stop,url:'http://other.invalid'}),false);
  const request=new Request(`http://hub.invalid${base}/messages`,{headers:{'x-weixin-binding':'forged',authorization:'Bearer forged'}});
  assert.equal(weixinOriginalAction(request),undefined);assert.equal(weixinOriginalAction(request.clone()),undefined);
});

test('stop result cannot confirm changed run/key, explicit unknown or arbitrary optimistic envelope',()=>{
  assert.deepEqual(readWeixinActionResult(stop,200,result(stop)),result(stop));
  for(const body of [{status:'interrupt_requested',runId:'other'},{status:'interrupt_requested',idempotencyKey:'other'},
    {status:'interrupt_requested',command:{key:stop.key,state:'unknown'}},{status:'interrupt_requested',command:{key:'other',state:'accepted'}},{ok:true}])
    assert.equal(readWeixinActionResult(stop,200,body),undefined);
  for(const status of [199,302,403,503])assert.equal(readWeixinActionResult(stop,status,result(stop)),undefined);
});

test('answer result binds original request, run, session, owner, node, kind, revision and known delivery',()=>{
  assert.deepEqual(readWeixinActionResult(answer,200,view,'node1'),view);
  for(const field of ['requestId','runId','sessionKey','ownerId','nodeId','kind'])
    assert.equal(readWeixinActionResult(answer,200,{...view,request:{...view.request,[field]:'wrong'}},'node1'),undefined,field);
  for(const changed of [{revision:1},{status:'pending',delivery:'none'},{delivery:'unknown'},{delivery:'queued'}])
    assert.equal(readWeixinActionResult(answer,200,{...view,...changed},'node1'),undefined);
  assert.equal(readWeixinActionResult({...answer,submission:{...answer.submission,answer:{kind:'approval',decision:'invalid'}}},200,view,'node1'),undefined);
});

for(const command of [stop,answer]) {
  test(`${command.operation}: fixed wire, single dispatch, known observation before revoked public delivery`,async()=>{
    const events:string[]=[],wire=weixinActionWire(command);let revoked=false;
    const client=new ConnectorClient('http://connector.invalid','synthetic',async request=>{
      events.push('dispatch');assert.equal(new URL(request.url).pathname,`/api/connector/v1${wire.path}`);
      assert.equal(request.method,'POST');assert.equal(request.redirect,'error');assert.equal(await request.text(),wire.body);
      if(command.operation==='stop')assert.equal(request.headers.get('idempotency-key'),command.key);
      revoked=true;return response(result(command));
    },1000,4096,{nodeId:'node1',authorize:()=>{events.push('authority');if(revoked)throw Error('revoked');}});
    await assert.rejects(client.weixinActionOriginal(command,async fact=>{events.push('observe');assert.deepEqual(fact,result(command));}),/revoked/);
    assert.deepEqual(events,['authority','dispatch','observe','authority']);
  });
  test(`${command.operation}: preflight revocation causes zero dispatch or observation`,async()=>{
    let dispatches=0,observed=0;
    const client=new ConnectorClient('http://connector.invalid','synthetic',()=>{dispatches++;return response(result(command));},1000,4096,{authorize:()=>{throw Error('revoked');}});
    await assert.rejects(client.weixinActionOriginal(command,async()=>{observed++;}),/revoked/);assert.equal(dispatches,0);assert.equal(observed,0);
  });
}

for(const kind of ['protocol','node','redirect','server','json','oversize','empty','network','unknown','wrong-run'] as const) {
  test(`uncertain ${kind} never confirms original stop or retries`,async()=>{
    let dispatches=0,observed=0;
    const client=new ConnectorClient('http://connector.invalid','synthetic',()=>{
      dispatches++;
      if(kind==='network')throw Error('lost ACK');
      if(kind==='protocol')return Response.json(result(stop),{headers:{...headers,[CONNECTOR_PROTOCOL_HEADER]:'0'}});
      if(kind==='node')return Response.json(result(stop),{headers:{...headers,[NODE_ID_HEADER]:'other'}});
      if(kind==='redirect')return new Response('redirect',{status:302,headers});
      if(kind==='server')return response({},503);
      if(kind==='json')return new Response('{broken',{headers});
      if(kind==='oversize')return response({text:'x'.repeat(1024)});
      if(kind==='empty')return new Response(null,{status:204,headers});
      return response(kind==='unknown'?{status:'interrupt_requested',command:{key:stop.key,state:'unknown'}}:{status:'interrupt_requested',runId:'other'});
    },1000,128,{nodeId:'node1'});
    try{await client.weixinActionOriginal(stop,async()=>{observed++;});}catch{}
    assert.equal(dispatches,1);assert.equal(observed,0);
  });
}

test('command is pinned before asynchronous authority check',async()=>{
  const preflight=gate(),mutable:WeixinAction={...stop};
  const client=new ConnectorClient('http://connector.invalid','synthetic',async request=>{
    assert.equal((await request.json()).expectedRunId,'run1');return response(result(stop));
  },1000,4096,{authorize:()=>preflight.promise});
  const pending=client.weixinActionOriginal(mutable,async()=>{});Object.assign(mutable,{runId:'other'});preflight.resolve();await pending;
});

test('abort after known EOF waits original observation ACK before releasing request',async()=>{
  const abort=new AbortController(),entered=gate(),release=gate();let finished=false;
  const client=new ConnectorClient('http://connector.invalid','synthetic',()=>response(result(stop)));
  const pending=client.weixinActionOriginal(stop,async()=>{abort.abort(Error('stopped'));entered.resolve();await release.promise;},abort.signal);
  const rejected=assert.rejects(pending,/stopped/).then(()=>{finished=true;});
  await entered.promise;await new Promise(resolve=>setImmediate(resolve));assert.equal(finished,false);
  release.resolve();await rejected;
});
