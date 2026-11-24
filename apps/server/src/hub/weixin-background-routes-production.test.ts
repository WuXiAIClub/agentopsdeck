import assert from 'node:assert/strict';
import test, {type TestContext} from 'node:test';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Hono} from 'hono';
import {CONNECTOR_PROTOCOL, CONNECTOR_PROTOCOL_HEADER, type InteractionView} from '@agentopsdeck/shared';
import {HubStore} from './hub-store.js';
import {AsyncHubMemberOwner} from './async-member-owner.js';
import {OriginalHubAdministrativeCommands} from './original-administrative-commands.js';
import {createHubAdministrativeServices} from './administrative-route-services.js';
import {createAsyncConnectorClientResolver} from './async-connector-client.js';
import {AsyncHubOwnerControls} from './async-owner-control.js';
import {WeixinService} from './weixin-service.js';
import {WEIXIN_ORIGIN, type WeixinTransport} from './weixin-transport.js';
import {encodeHubSessionId} from './session-id.js';
import {PerformanceDiagnostics} from '../diagnostics/performance.js';
import {NODE_ID_HEADER} from '../connector/node-identity.js';
import {registerHubRoutes} from '../routes/hub.js';
import {registerAsyncHubRoutes} from '../routes/hub-async.js';
import {createHubConnectorReadServices} from './connector-read-services.js';
import {loadConfig} from '../config.js';
import {validHubMemberInput} from './member-owner-domain.js';
import {validHubOwnerControlCommand} from './member-owner-control-domain.js';

const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
async function fixture(t:TestContext,mode:'original'|'worker'|'async-original'|'async-worker',text?:string) {
  const root=mkdtempSync(join(tmpdir(),'weixin-routes-')),file=join(root,'hub.sqlite');
  const nodeId=`node_${randomUUID()}`,remoteSession='codex:fixture',session=encodeHubSessionId('node',remoteSession);
  const seed=new HubStore(file,'fixture'),key=seed.identities.issueKey('default');
  const hubId=seed.identities.hubId;
  const administrator=seed.createUser('administrator');seed.roles.setHubRole({userId:'default',admin:true},administrator.id,'admin',0);
  const admin=seed.identities.issueKey(administrator.id);
  seed.upsertConnection({id:'node',ownerUserId:'default',label:'Node',connectorUrl:'http://connector.invalid',credentialToken:'PRIVATE_CONNECTOR'});
  seed.pinConnectionNode('node','default',seed.connectionAuthority('node','default')!,nodeId);
  const created=seed.weixin.create('default',key.id,randomUUID()).row;
  seed.weixin.bind(created,{botId:'bot',peerId:'peer',token:'PRIVATE_PROVIDER',baseUrl:WEIXIN_ORIGIN});
  const row=seed.weixin.get('default')!;
  const view:InteractionView={request:{version:1,ownerId:'default',nodeId,sessionKey:remoteSession,runId:'run1',requestId:'request1',kind:'approval',
    prompt:'PRIVATE_QUESTION',createdAt:Date.now(),expiresAt:Date.now()+600_000},revision:1,status:'pending',delivery:'none'};
  seed.weixin.target(row,session,'target');
  seed.weixin.save(row,{...seed.weixin.secrets(row),context:'PRIVATE_CONTEXT',contextAt:Date.now(),
    stops:{confirmation:{session,run:'run1',expires:Date.now()+600_000}},questions:{question:{session,view}}});
  if(text===undefined) {seed.weixin.watch(row,'target',true);seed.weixin.snapshot(row,'target',JSON.stringify(['run1','running']));}
  await seed.close();
  const original=mode.endsWith('original')?new HubStore(file,'fixture'):undefined;
  const logs:string[]=[],diagnostics=new PerformanceDiagnostics(line=>logs.push(line));
  const owner=original?new OriginalHubAdministrativeCommands(original,diagnostics):new AsyncHubMemberOwner({file,encryptionSecret:'fixture'},diagnostics);
  const group=createHubAdministrativeServices(owner,diagnostics),resolver=createAsyncConnectorClientResolver(owner,undefined,diagnostics);
  const reads=createHubConnectorReadServices(owner,undefined,diagnostics);
  const controls=new AsyncHubOwnerControls(owner,resolver,diagnostics);
  const metadata=new HubStore(join(root,'metadata.sqlite'),'fixture');let guarded=false,bypasses=0;
  const poisonedWeixin=new Proxy(metadata.weixin,{get(target,property,receiver){if(guarded){bypasses++;throw Error('SYNC_CAPTURED_WEIXIN');}return Reflect.get(target,property,receiver);}});
  const store=new Proxy(metadata,{get(target,property,receiver){if(guarded){bypasses++;throw Error('SYNC_BACKGROUND_HUB');}
    return property==='weixin'?poisonedWeixin:Reflect.get(target,property,receiver);}});
  const behavior={calls:[] as Request[],hub:[] as {path:string,status:number}[],sent:[] as string[],mutations:[] as Record<string,unknown>[],phase:'running',run:'run1',sync:'current',
    revision:1,sendWait:undefined as undefined|((signal:AbortSignal)=>Promise<void>),transport:undefined as undefined|((request:Request)=>Promise<void>),
    response:undefined as undefined|((request:Request,response:Response)=>Promise<Response|void>)};
  const remote=new Hono();
  remote.use('*',async(c,next)=>{assert.equal(c.req.header('authorization'),'Bearer PRIVATE_CONNECTOR');await next();
    c.header(CONNECTOR_PROTOCOL_HEADER,String(CONNECTOR_PROTOCOL.max));c.header(NODE_ID_HEADER,nodeId);});
  remote.get('/api/connector/v1/sessions/state',c=>c.json({groups:[{agentId:'codex',sessions:[{
    sessionKey:remoteSession,agentId:'codex',title:'Synthetic session',status:'running',updatedAt:Date.now(),
    runtime:{turnId:behavior.run,phase:behavior.phase,connection:'connected',sync:behavior.sync},
  }]}]}));
  const base='/api/connector/v1/sessions/:session';
  remote.get(base+'/interactions',c=>c.json({version:1,mode:'interactive',capabilities:{version:1,kinds:['approval'],modes:['automatic','interactive']},
    requests:[{...view,revision:behavior.revision}]}));
  remote.post(base+'/interactions/:request/answer',async c=>{behavior.mutations.push(await c.req.json());return c.json({...view,status:'answered',delivery:'confirmed'});});
  remote.post(base+'/messages',async c=>{behavior.mutations.push(await c.req.json());return c.json({status:'interrupt_requested'});});
  t.mock.method(globalThis,'fetch',async(input:string|URL|Request,init?:RequestInit)=>{
    const request=input instanceof Request?input:new Request(input,init);assert.equal(new URL(request.url).hostname,'connector.invalid');
    behavior.calls.push(request);await behavior.transport?.(request);const response=await remote.fetch(request);
    return await behavior.response?.(request,response) ?? response;
  });
  const transport:WeixinTransport={qr:async()=>{throw Error('UNEXPECTED_QR');},pollQr:async()=>{throw Error('UNEXPECTED_POLL');},
    receive:async(_account,cursor)=>({cursor:'next',messages:!cursor&&text!==undefined?[{id:'inbound',peerId:'peer',at:Date.now(),context:'PRIVATE_CONTEXT',text}]:[]}),
    send:async(_account,context,message,_clientId,signal)=>{assert.equal(context,'PRIVATE_CONTEXT');behavior.sent.push(message);await behavior.sendWait?.(signal);return 'accepted';}};
  let service:WeixinService|undefined;
  t.mock.method(WeixinService.prototype,'startWorker',function(this:WeixinService){service=this;});
  const app=new Hono();
  app.use('*',async(c,next)=>{await next();behavior.hub.push({path:c.req.path,status:c.res.status});});
  const routes=mode.startsWith('async-')?await registerAsyncHubRoutes(app,{config:loadConfig({HOME:root,AOD_SERVER_ROLE:'hub'}),hubId,
    administrative:group,reads,eventFeed:()=>{throw Error('NO_EVENT_SUBSCRIPTION');},weixinTransport:transport,normalizeError:()=> 'safe'})
    :registerHubRoutes(app,{config:loadConfig({HOME:root,AOD_SERVER_ROLE:'hub'}),hubStore:store,
    administrative:group,asyncConnectorClient:resolver,asyncOwnerControl:controls,weixinTransport:transport,
    principal:()=>{bypasses++;throw Error('SYNC_BACKGROUND_PRINCIPAL');},connectorClient:()=>{bypasses++;throw Error('SYNC_BACKGROUND_RESOLVER');},normalizeError:()=> 'safe'});
  assert.ok(routes);if('activate' in routes)await routes.activate();assert.ok(service);guarded=true;
  const gates=new Set<()=>void>();
  const gate=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});gates.add(resolve);return {promise,resolve};};
  t.after(async()=>{for(const release of gates)release();guarded=false;
    try{await routes.close();}finally{try{await group.close();await reads.close();}finally{try{await resolver.close();}finally{try{await owner.close();}finally{await original?.close();await metadata.close();}}}}
    for(const secret of [key.token,admin.token,'PRIVATE_PROVIDER','PRIVATE_CONNECTOR','PRIVATE_CONTEXT','PRIVATE_QUESTION'])assert.equal(logs.join('').includes(secret),false);
    rmSync(root,{recursive:true,force:true});});
  const read=(sql:string)=>{const db=new DatabaseSync(file,{readOnly:true});try{return db.prepare(sql).all();}finally{db.close();}};
  const revoke=async()=>{const evidence={accessKey:admin.token},actor=await owner.command('memberSnapshot',evidence);assert.ok(actor);
    await owner.command('memberKeyRevoke',{evidence,expectedScope:actor.recoveryScope,userId:'default',keyId:key.id});};
  return {service:service!,row,behavior,session,nodeId,view,app,read,revoke,gate,close:routes.close,bypasses:()=>bypasses};
}

for(const mode of ['original','worker','async-original','async-worker'] as const) {
  for(const command of ['sessions','status target','questions target']) test(`${mode}: background ${command} uses real Hub routes with poisoned synchronous owners`,async t=>{
    const f=await fixture(t,mode,command);await f.service.tick(f.row);
    assert.equal(f.bypasses(),0);assert.equal(f.behavior.sent.length,1);
    assert.ok(f.behavior.calls.some(r=>new URL(r.url).pathname.endsWith('/sessions/state')));
    assert.match(f.behavior.sent[0]!,command.startsWith('questions')?/PRIVATE_QUESTION/:command==='sessions'?/Synthetic session/:/running/);
    await f.service.tick(f.row);assert.equal(f.behavior.sent.length,1);assert.equal(f.behavior.mutations.length,0);
  });
  test(`${mode}: confirmed original Codex stop crosses real message route exactly once`,async t=>{
    const f=await fixture(t,mode,'confirm confirmation');await f.service.tick(f.row);
    assert.equal(f.bypasses(),0);assert.equal(f.behavior.mutations.length,1,JSON.stringify(f.behavior.hub));
    const body=f.behavior.mutations[0]!;assert.equal(body.message,'/stop');assert.equal(body.expectedRunId,'run1');assert.equal(body.deliveryMode,'web-only');assert.deepEqual(body.media,[]);
    assert.equal(typeof body.idempotencyKey,'string');assert.match(f.behavior.sent[0]!,/停止请求已接收/);
    await f.service.tick(f.row);assert.equal(f.behavior.mutations.length,1);
    const rows=f.read("SELECT state FROM hub_weixin_deliveries");assert.ok(rows.length>=2);assert.ok(rows.every(r=>r.state==='accepted'));
  });
  test(`${mode}: changed Goal run refuses old stop confirmation without mutation`,async t=>{
    const f=await fixture(t,mode,'confirm confirmation');f.behavior.run='next-goal-turn';await f.service.tick(f.row);
    assert.equal(f.bypasses(),0);assert.equal(f.behavior.mutations.length,0);assert.match(f.behavior.sent[0]!,/未确认完成/);
  });
  test(`${mode}: approval reply uses real interaction read/answer routes and original revision`,async t=>{
    const f=await fixture(t,mode,'deny question');await f.service.tick(f.row);
    assert.equal(f.bypasses(),0);assert.equal(f.behavior.mutations.length,1);
    assert.deepEqual(f.behavior.mutations[0],{runId:'run1',expectedRevision:1,responseId:'weixin-question',answer:{kind:'approval',decision:'deny'}});
    assert.match(f.behavior.sent[0]!,/已确认/);await f.service.tick(f.row);assert.equal(f.behavior.mutations.length,1);
  });
  test(`${mode}: changed interaction revision never dispatches an answer`,async t=>{
    const f=await fixture(t,mode,'deny question');f.behavior.revision=2;await f.service.tick(f.row);
    assert.equal(f.bypasses(),0);assert.equal(f.behavior.mutations.length,0);assert.match(f.behavior.sent[0]!,/未确认完成/);
  });
  test(`${mode}: revocation during original interaction read fences answer and provider delivery`,async t=>{
    const f=await fixture(t,mode,'deny question');
    f.behavior.response=async request=>{if(new URL(request.url).pathname.endsWith('/interactions'))await f.revoke();};
    await f.service.tick(f.row);
    assert.equal(f.behavior.mutations.length,0);assert.equal(f.behavior.sent.length,0);assert.equal(f.bypasses(),0);
    await assert.rejects(f.service.tick(f.row),{code:'denied'});assert.equal(f.behavior.mutations.length,0);
  });
  test(`${mode}: lost original stop ACK retains unknown action and never redispatches`,async t=>{
    const f=await fixture(t,mode,'confirm confirmation');
    f.behavior.response=async request=>{if(request.method==='POST'&&new URL(request.url).pathname.endsWith('/messages'))throw Error('SYNTHETIC_LOST_ACK');};
    await f.service.tick(f.row);assert.equal(f.behavior.mutations.length,1);assert.equal(f.bypasses(),0);
    assert.ok(f.read('SELECT state FROM hub_weixin_deliveries').some(row=>row.state==='unknown'));
    await f.service.tick(f.row);assert.equal(f.behavior.mutations.length,1);
  });
  for(const action of ['stop','answer'] as const) {
    test(`${mode}: ${action} original ACK survives revocation but never authorizes provider delivery`,async t=>{
      const f=await fixture(t,mode,action==='stop'?'confirm confirmation':'deny question');
      f.behavior.response=async request=>{if(request.method==='POST')await f.revoke();};
      await f.service.tick(f.row);
      assert.equal(f.behavior.mutations.length,1);assert.equal(f.behavior.sent.length,0);assert.equal(f.bypasses(),0);
      // The inbound reply admission stays unknown: revocation forbids sending
      // that reply. The independently admitted native action keeps its ACK.
      const inbound=createHash('sha256').update('in:inbound').digest('hex');
      const actionEvent=createHash('sha256').update(action==='stop'?'stop:confirmation':'action:question').digest('hex');
      const deliveries=f.read('SELECT event_hash,state FROM hub_weixin_deliveries');
      assert.equal(deliveries.length,2);
      assert.equal(deliveries.find(r=>r.event_hash===inbound)?.state,'unknown');
      assert.equal(deliveries.find(r=>r.event_hash===actionEvent)?.state,'accepted');
      if(action==='stop')assert.deepEqual(f.read('SELECT state FROM command_receipts').map(r=>r.state),['accepted']);
      await assert.rejects(f.service.tick(f.row),{code:'denied'});assert.equal(f.behavior.mutations.length,1);assert.equal(f.behavior.sent.length,0);
    });
    test(`${mode}: mismatched ${action} ACK remains unknown across repeated background ticks`,async t=>{
      const f=await fixture(t,mode,action==='stop'?'confirm confirmation':'deny question');
      f.behavior.response=async(request,response)=>request.method==='POST'?Response.json(action==='stop'
        ?{status:'interrupt_requested',runId:'different-run'}
        :{...f.view,request:{...f.view.request,ownerId:'different-owner'},status:'answered',delivery:'confirmed'},
        {headers:response.headers}):undefined;
      await f.service.tick(f.row);assert.equal(f.behavior.mutations.length,1);assert.equal(f.bypasses(),0);
      assert.ok(f.read('SELECT state FROM hub_weixin_deliveries').some(r=>r.state==='unknown'));
      await f.service.tick(f.row);assert.equal(f.behavior.mutations.length,1);
    });
  }
  test(`${mode}: Goal notifications require current runtime, not stale synchronization or transport idle`,async t=>{
    const f=await fixture(t,mode);f.behavior.phase='completed';f.behavior.sync='stale';await f.service.tick(f.row);assert.equal(f.behavior.sent.length,0);
    f.behavior.sync='current';await f.service.tick(f.row);assert.equal(f.behavior.sent.length,1);assert.match(f.behavior.sent[0]!,/已完成/);
    assert.doesNotMatch(f.behavior.sent[0]!,/Synthetic|PRIVATE/);await f.service.tick(f.row);assert.equal(f.behavior.sent.length,1);assert.equal(f.bypasses(),0);
  });
  test(`${mode}: real route shutdown waits late provider ACK and settles before retiring owner`,async t=>{
    const f=await fixture(t,mode,'sessions'),entered=f.gate(),release=f.gate();let signal:AbortSignal|undefined;
    f.behavior.sendWait=async s=>{signal=s;entered.resolve();await release.promise;};
    const ticking=f.service.tick(f.row);await entered.promise;let closed=false;const closing=f.close().then(()=>{closed=true;});
    await turn();assert.equal(signal?.aborted,true);assert.equal(closed,false);release.resolve();await ticking;await closing;
    assert.deepEqual(f.read('SELECT state FROM hub_weixin_receipts').map(r=>r.state),['accepted']);assert.equal(f.bypasses(),0);
  });
}

test('private stop schema rejects general messages, changed payloads and public evidence',()=>{
  const command={action:'claim',target:{operation:'message',connectionId:'node',sessionId:encodeHubSessionId('node','codex:fixture')},
    epoch:1,key:'stop-key',payload:{message:'/stop',expectedRunId:'run1',deliveryMode:'web-only',media:[]}};
  const proof={evidence:{weixinBinding:{id:randomUUID(),user:'default',keyId:randomUUID()}},expectedScope:'a'.repeat(64),command};
  assert.equal(validHubOwnerControlCommand(command),true);
  assert.equal(validHubMemberInput('ownerControl',proof),true);
  for(const evidence of [{accessKey:'synthetic-key'},{sessionToken:'synthetic-session'},{}])
    assert.equal(validHubMemberInput('ownerControl',{...proof,evidence}),false);
  for(const payload of [{...command.payload,message:'ordinary message'},{...command.payload,expectedRunId:''},
    {...command.payload,deliveryMode:'all'},{...command.payload,media:[{}]},{...command.payload,extra:true}])
    assert.equal(validHubOwnerControlCommand({...command,payload}),false);
});
