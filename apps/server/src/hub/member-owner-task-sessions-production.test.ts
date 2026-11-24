import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { CONNECTOR_PROTOCOL, CONNECTOR_PROTOCOL_HEADER } from '@agentopsdeck/shared';
import { HubStore } from './hub-store.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { OriginalHubAdministrativeCommands } from './original-administrative-commands.js';
import { createHubAdministrativeServices } from './administrative-route-services.js';
import { createAsyncConnectorClientResolver } from './async-connector-client.js';
import { hubMemberEvidence, validHubMemberInput, validHubMemberOutput } from './member-owner-domain.js';
import { validHubTaskSessionCommand, validHubTaskSessionResult, type HubTaskSessionCommand } from './member-task-session-domain.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { NODE_ID_HEADER } from '../connector/node-identity.js';
import { registerConnectorBoardBindings } from '../connector/board-bindings-http.js';
import { CommandReceipts } from '../commands/receipts.js';
import { registerCreationReceipts } from '../commands/http.js';
import { registerHubTaskSessions } from '../routes/hub-task-sessions.js';
import { registerHubRoutes } from '../routes/hub.js';
import { registerAsyncHubSessionGuidance } from '../routes/hub-session-guidance-async.js';
import { encodeHubSessionId } from './session-id.js';
import { loadConfig } from '../config.js';

const base='/api/hub/v1/workspace/boards/default/task-sessions';
const endpoint='https://hub.example/api/workspace-agent/v1/board';
const runtimes=['codex','claude-code','ghcp'] as const;
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}

/** Real credential/transaction owners, original Connector receipt and binding
 * services. No native engine, provider, real network or live database. */
async function fixture(t:TestContext,mode:'original'|'worker',parent=false){
  const root=mkdtempSync(join(tmpdir(),'task-session-production-')),file=join(root,'hub.sqlite'),node='node_'+randomUUID(),task=randomUUID();
  const seed=new HubStore(file,'fixture');
  (seed as unknown as {db:DatabaseSync}).db.prepare("INSERT INTO hub_roles VALUES ('default','admin',1)").run();
  const admin=seed.identities.issueKey('default'),member=seed.createUser('Member'),other=seed.createUser('Other');
  const key=seed.identities.issueKey(member.id),second=seed.identities.issueKey(member.id),cookie=seed.identities.createSession(key.token)!,otherKey=seed.identities.issueKey(other.id);
  const tokens=new ConnectorTokenStore(join(root,'tokens.json')),token=tokens.createTransient(['boards:bind','sessions:create'],'hub-token');
  seed.upsertConnection({id:'dev',ownerUserId:member.id,label:'Dev',connectorUrl:'http://task-connector.invalid',credentialToken:token.token});
  seed.pinConnectionNode('dev',member.id,seed.connectionAuthority('dev',member.id)!,node);
  seed.boards.save(member.id,'default',{revision:0,mutationId:randomUUID(),title:'Board',tasks:[{id:task,title:'Task',detail:'PRIVATE_TASK',status:'todo'}]});
  await seed.close();
  const directories=Object.fromEntries(runtimes.map(runtime=>{const directory=join(root,runtime);mkdirSync(directory,{mode:0o700});return [runtime,directory];}));
  const remote=new Hono(),db=new DatabaseSync(join(root,'connector.sqlite')),commands=new CommandReceipts(db),sessions=new Map<string,{runtime:typeof runtimes[number];sessionId:string}>();
  remote.use('*',async(c,next)=>{await next();c.header(CONNECTOR_PROTOCOL_HEADER,String(CONNECTOR_PROTOCOL.max));c.header(NODE_ID_HEADER,node);});
  const behavior:{creates:number;puts:number;gets:number;sync:number;messages:number;dropMessage:boolean;dropCreate:boolean;dropBind:boolean;models:string[];
    resolving?:()=>Promise<void>;before?:(request:Request)=>Promise<void>;after?:(request:Request,response:Response)=>Promise<Response>}={creates:0,puts:0,gets:0,sync:0,messages:0,dropMessage:false,dropCreate:false,dropBind:false,models:['synthetic']};
  const guidanceSession=encodeHubSessionId('dev','codex:'+randomUUID()),messageReceipts=new Map<string,unknown>();
  remote.post('/api/connector/v1/sessions/:session/messages',async c=>{
    const body=await c.req.json();assert.equal(body.idempotencyKey,c.req.header('idempotency-key'));behavior.messages++;
    const command={key:body.idempotencyKey,id:randomUUID(),state:'accepted'};messageReceipts.set(command.key,command);
    return c.json({command});
  });
  remote.get('/api/connector/v1/sessions/:session/commands/:id',c=>{
    const command=messageReceipts.get(c.req.param('id'));return command?c.json({command}):c.json({error:'missing'},404);
  });
  remote.get('/api/connector/v1/models/:runtime',c=>c.json({models:behavior.models.map(id=>({id}))}));
  const path='/api/connector/v1/agents/:agentId/sessions';
  registerCreationReceipts(remote,path,{receipts:commands,scope:c=>JSON.stringify(['hub-token',c.req.param('agentId')])});
  remote.post(path,async c=>{
    assert.equal((await c.req.json()).model,'synthetic');behavior.creates++;
    const runtime=c.req.param('agentId') as typeof runtimes[number],sessionId=randomUUID(),key=runtime+':'+sessionId;
    sessions.set(key,{runtime,sessionId});c.get('acknowledgeCreation')({status:201,body:{key}});return c.json({key},201);
  });
  const bindings=registerConnectorBoardBindings(remote,{tokens,directories,policies:runtimes.map(runtime=>({owner:'hub-token',runtime,endpoint})),
    resolveSession:key=>{const s=sessions.get(key);return s?{...s,ready:true}:undefined;}});
  await bindings.ready;
  t.mock.method(globalThis,'fetch',async(input:string|URL|Request,init?:RequestInit)=>{
    const request=input instanceof Request?input:new Request(input,init);
    assert.equal(new URL(request.url).hostname,'task-connector.invalid','no external network');
    assert.equal(request.headers.get('authorization'),'Bearer '+token.token);
    await behavior.before?.(request);
    if(request.method==='PUT')behavior.puts++;else if(request.method==='GET')behavior.gets++;
    if(behavior.dropCreate&&request.method==='GET'&&request.url.includes('creation-commands'))throw Error('offline');
    if(behavior.dropMessage&&request.method==='GET'&&request.url.includes('/commands/'))throw Error('offline');
    const response=await remote.request(request);
    if(behavior.dropCreate&&request.method==='POST'||behavior.dropBind&&request.method==='PUT')throw Error('lost ACK');
    if(behavior.dropMessage&&request.method==='POST'&&request.url.endsWith('/messages'))throw Error('lost ACK');
    return behavior.after?behavior.after(request,response):response;
  });
  const logs:string[]=[],diagnostics=new PerformanceDiagnostics(line=>{logs.push(line);});
  const mount=()=>{
    const metadata=new HubStore(mode==='original'?file:join(root,'composition.sqlite'),'fixture');
    const owner=mode==='original'?new OriginalHubAdministrativeCommands(metadata,diagnostics):new AsyncHubMemberOwner({file,encryptionSecret:'fixture'},diagnostics);
    const group=createHubAdministrativeServices(owner,diagnostics),resolver=createAsyncConnectorClientResolver(owner,undefined,diagnostics);
    const asyncConnectorClient:typeof resolver=Object.assign(async(...args:Parameters<typeof resolver>)=>{await behavior.resolving?.();return resolver(...args);},{close:()=>resolver.close()});
    const app=new Hono();let guarded=false;
    const store=new Proxy(metadata,{get(target,p,receiver){if(guarded){behavior.sync++;throw Error('SYNC_TASK_STORE');}return Reflect.get(target,p,receiver);}});
    const routes=parent?registerHubRoutes(app,{config:{...loadConfig({HOME:root,AOD_SERVER_ROLE:'hub'}),boardAgentEndpoint:endpoint},hubStore:store,administrative:group,
      asyncConnectorClient,principal:()=>{behavior.sync++;throw Error('SYNC_TASK_PRINCIPAL');},connectorClient:()=>{behavior.sync++;throw Error('SYNC_TASK_RESOLVER');},normalizeError:()=> 'safe'})
      :registerHubTaskSessions(app,{mode:'async',...group.createTaskSessionServices(asyncConnectorClient),asyncConnectorClient,endpoint});
    const guidance=parent?undefined:registerAsyncHubSessionGuidance(app,{mode:'async',guidance:group.createGuidanceAccess(),asyncConnectorClient,diagnostics});
    assert.ok(routes);
    const close=async()=>{await Promise.all([routes.close(),guidance?.close()]);};
    guarded=true;
    return {app,owner,close,dispose:async()=>{guarded=false;await close();await group.close();await resolver.close();await owner.close();await metadata.close();}};
  };
  let current=mount();
  t.after(async()=>{
    await current.dispose();await bindings.close();token.dispose();db.close();
    assert.equal(behavior.sync,0,'no synchronous production request bypass');
    for(const secret of [key.token,second.token,cookie,token.token,'PRIVATE_TASK'])assert.equal(logs.join('').includes(secret),false,'private diagnostics');
    rmSync(root,{recursive:true,force:true});
  });
  const proof=async(value=second.token)=>{
    const evidence=hubMemberEvidence(new Request('http://hub.invalid',{headers:{'x-agentopsdeck-key':value}}));
    const snapshot=await current.owner.command('memberSnapshot',evidence);assert.ok(snapshot);return {evidence,expectedScope:snapshot.recoveryScope};
  };
  const request=(method:string,suffix='',body?:unknown,headers:Record<string,string>={'x-agentopsdeck-key':key.token},signal?:AbortSignal)=>current.app.fetch(new Request('http://hub.invalid'+base+suffix,
    {method,headers,...(signal?{signal}:{}),...(body===undefined?{}:{body:JSON.stringify(body)})}));
  return {behavior,logs,key,second,cookie,otherKey,request,
    guidance:(method='GET',suffix='',body?:unknown)=>current.app.fetch(new Request('http://hub.invalid/api/hub/v1/sessions/'+encodeURIComponent(guidanceSession)+'/guidance'+suffix,
      {method,headers:{'x-agentopsdeck-key':key.token},...(body===undefined?{}:{body:JSON.stringify(body)})})),
    input:(runtime:typeof runtimes[number]='codex')=>({requestId:randomUUID(),connectionId:'dev',runtime,title:'Task session',model:'synthetic',taskIds:[task],fields:['status'],expiresAt:Date.now()+300000}),
    command:async(command:HubTaskSessionCommand)=>current.owner.command('taskSession',{...await proof(),command}),
    revoke:async()=>current.owner.command('memberKeyRevoke',{...await proof(admin.token),userId:member.id,keyId:key.id}),
    changeBoard:async()=>{
      const p=await proof(),old=await current.owner.command('workspaceBoard',{...p,command:{action:'get',resourceId:'default'}});assert.ok(old&&old.action==='get');
      return current.owner.command('workspaceBoard',{...p,command:{action:'save',resourceId:'default',document:{title:'Changed',tasks:old.document.tasks,revision:old.document.revision,mutationId:randomUUID()}}});
    },
    reopen:async()=>{await current.dispose();current=mount();},close:()=>current.close()};
}
async function receipt(response:Response,status=200){const body=await response.json();assert.equal(response.status,status,JSON.stringify(body));assert.ok(body.receipt);return body.receipt;}

for(const mode of ['original','worker'] as const){
  test(`${mode}: no-store task sessions preserve explicit create/bind for all runtimes and original credentials`,async t=>{
    const f=await fixture(t,mode);
    for(const [index,runtime] of runtimes.entries()){
      const input=f.input(runtime),id=input.requestId,headers:Record<string,string>=index===1?{cookie:'agentopsdeck_session='+f.cookie}:{'x-agentopsdeck-key':f.key.token};
      const r=await receipt(await f.request('POST','',input,headers),201);assert.equal(r.state,'prepared');
      assert.deepEqual(await receipt(await f.request('POST','',input,headers),201),r,'original preview retry');
      const created=await receipt(await f.request('POST',`/${id}/create`,{},headers));assert.equal(created.state,'created');assert.equal(f.behavior.puts,index);
      assert.equal((await receipt(await f.request('POST',`/${id}/create`,{},headers))).sessionId,created.sessionId);
      const bound=await receipt(await f.request('POST',`/${id}/bind`,{},headers));assert.equal(bound.state,'bound');assert.equal(bound.sessionId,created.sessionId);
      assert.equal((await receipt(await f.request('POST',`/${id}/bind`,{},headers))).state,'bound');
      assert.equal((await f.request('GET',`/${id}`,undefined,{'x-agentopsdeck-key':f.otherKey.token})).status,404);
      assert.equal((await f.request('DELETE',`/${id}`,undefined,headers)).status,409);
      assert.equal(JSON.stringify(bound).includes('aod_board_'),false);
    }
    assert.equal(f.behavior.creates,3);assert.equal(f.behavior.puts,3);
  });
  test(`${mode}: production parent selects task async composition, no request-time legacy dependency`,async t=>{
    const f=await fixture(t,mode,true),input=f.input(),id=input.requestId;
    await receipt(await f.request('POST','',input),201);
    assert.equal((await receipt(await f.request('POST',`/${id}/create`,{}))).state,'created');
    assert.equal((await receipt(await f.request('POST',`/${id}/bind`,{}))).state,'bound');
    assert.equal(f.behavior.creates,1);assert.equal(f.behavior.puts,1);
  });
  test(`${mode}: lost creation and binding ACK survive owner reopen; recovery is GET-only`,async t=>{
    const f=await fixture(t,mode),input=f.input(),id=input.requestId;
    await receipt(await f.request('POST','',input),201);f.behavior.dropCreate=true;
    assert.equal((await receipt(await f.request('POST',`/${id}/create`,{}))).state,'creation_unknown');assert.equal(f.behavior.creates,1);
    await f.reopen();assert.equal((await receipt(await f.request('POST',`/${id}/create`,{}))).state,'creation_unknown');
    f.behavior.dropCreate=false;assert.equal((await receipt(await f.request('GET',`/${id}`))).state,'created');assert.equal(f.behavior.puts,0);
    f.behavior.dropBind=true;assert.equal((await receipt(await f.request('POST',`/${id}/bind`,{}))).state,'binding_unknown');
    await f.changeBoard();await f.reopen();f.behavior.dropBind=false;
    assert.equal((await receipt(await f.request('GET',`/${id}`))).state,'bound');assert.equal(f.behavior.puts,1);assert.equal(f.behavior.creates,1);
  });
  test(`${mode}: another native session cannot supply a binding ACK`,async t=>{
    const f=await fixture(t,mode),input=f.input(),id=input.requestId;
    await receipt(await f.request('POST','',input),201);await receipt(await f.request('POST',`/${id}/create`,{}));
    f.behavior.after=async(request,response)=>{
      if(request.method!=='GET'||!request.url.endsWith('/board-binding'))return response;
      const body=await response.json();return new Response(JSON.stringify({...body,sessionId:randomUUID(),binding:null}),{headers:response.headers});
    };
    assert.equal((await f.request('POST',`/${id}/bind`,{})).status,502);assert.equal(f.behavior.puts,0);
    delete f.behavior.after;f.behavior.dropBind=true;
    const original=await receipt(await f.request('POST',`/${id}/bind`,{}));assert.equal(original.state,'binding_unknown');
    const wrongSession=randomUUID(),result=await f.command({action:'binding',boardId:'default',id,
      remote:{ready:true,runtime:'codex',sessionId:wrongSession,binding:{id:original.bindingRequestId,runtime:'codex',sessionId:wrongSession,state:'installed',expiresAt:input.expiresAt}}});
    assert.ok(result&&'receipt'in result);assert.equal(result.receipt?.state,'binding_unknown');
    f.behavior.dropBind=false;assert.equal((await receipt(await f.request('GET',`/${id}`))).state,'bound');assert.equal(f.behavior.puts,1);
  });
  test(`${mode}: production parent guidance saves without sending and reopens unknown ACK without replay`,async t=>{
    const f=await fixture(t,mode,true),id=randomUUID();
    assert.equal((await f.guidance('PUT','',{revision:0,text:'PRIVATE_TASK',enabled:true})).status,200);
    assert.equal((await f.guidance('POST','/submissions',{requestId:id,revision:1,input:'Input'})).status,201);
    assert.equal(f.behavior.messages,0);f.behavior.dropMessage=true;
    const submitted=await f.guidance('POST',`/submissions/${id}/submit`,{});assert.equal(submitted.status,200);
    assert.equal((await submitted.json()).receipt.state,'unknown');assert.equal(f.behavior.messages,1);
    await f.reopen();f.behavior.dropMessage=false;
    const recovered=await f.guidance('GET',`/submissions/${id}`);assert.equal(recovered.status,200);
    assert.equal((await recovered.json()).receipt.state,'submitted');assert.equal(f.behavior.messages,1);
    assert.equal((await f.guidance('POST',`/submissions/${id}/submit`,{})).status,200);assert.equal(f.behavior.messages,1);
  });
  test(`${mode}: production guidance rechecks revocation while async resolver rejects`,async t=>{
    const f=await fixture(t,mode,true),id=randomUUID();
    await f.guidance('PUT','',{revision:0,text:'PRIVATE_TASK',enabled:true});
    await f.guidance('POST','/submissions',{requestId:id,revision:1});
    f.behavior.resolving=async()=>{await f.revoke();throw Error('resolver unavailable');};
    assert.equal((await f.guidance('POST',`/submissions/${id}/submit`,{})).status,401);assert.equal(f.behavior.messages,0);
  });
  test(`${mode}: production guidance close retains original ignoring-abort resolver`,async t=>{
    const f=await fixture(t,mode,true),id=randomUUID();
    await f.guidance('PUT','',{revision:0,text:'PRIVATE_TASK',enabled:true});await f.guidance('POST','/submissions',{requestId:id,revision:1});
    const entered=deferred(),release=deferred();f.behavior.resolving=async()=>{entered.resolve();await release.promise;};
    const request=f.guidance('POST',`/submissions/${id}/submit`,{});await entered.promise;
    let closed=false;const closing=f.close().then(()=>{closed=true;});await tick();assert.equal(closed,false);
    release.resolve();assert.equal((await request).status,503);await closing;assert.equal(f.behavior.messages,0);
    assert.equal((await f.guidance()).status,503);
  });
  test(`${mode}: frozen selection blocks effects, does not hide existing receipt; cancellation tombstones persist`,async t=>{
    const f=await fixture(t,mode),input=f.input(),id=input.requestId;
    await receipt(await f.request('POST','',input),201);await receipt(await f.request('POST',`/${id}/create`,{}));await f.changeBoard();
    assert.equal((await f.request('POST',`/${id}/bind`,{})).status,409);assert.equal(f.behavior.puts,0);
    assert.equal((await receipt(await f.request('GET',`/${id}`))).state,'created');
    const cancelled=f.input();assert.equal((await f.request('DELETE',`/${cancelled.requestId}`)).status,200);await f.reopen();
    assert.equal((await f.request('POST','',cancelled)).status,409);
  });
  for(const phase of ['models','board-binding'])test(`${mode}: revocation during ${phase} wait prevents new effects and credential delivery`,async t=>{
    const f=await fixture(t,mode),input=f.input(),id=input.requestId;await receipt(await f.request('POST','',input),201);
    if(phase==='board-binding')await receipt(await f.request('POST',`/${id}/create`,{}));
    let revoked=false;f.behavior.after=async(request,response)=>{if(!revoked&&request.url.includes('/'+phase)){revoked=true;await f.revoke();}return response;};
    const result=await f.request('POST',`/${id}/${phase==='models'?'create':'bind'}`,{});assert.equal(result.status,401);
    assert.equal(f.behavior.puts,0);assert.equal(f.behavior.creates,phase==='models'?0:1);
    assert.equal((await f.request('GET',`/${id}`)).status,401);
  });
  test(`${mode}: close waits original resolver ignoring abort and never starts a late create`,async t=>{
    const f=await fixture(t,mode),input=f.input(),id=input.requestId;await receipt(await f.request('POST','',input),201);
    const entered=deferred(),release=deferred();f.behavior.resolving=async()=>{entered.resolve();await release.promise;};
    const abort=new AbortController(),request=f.request('POST',`/${id}/create`,{},undefined,abort.signal);await entered.promise;abort.abort();
    let closed=false;const closing=f.close().then(()=>{closed=true;});await tick();assert.equal(closed,false);
    release.resolve();assert.equal((await request).status,503);await closing;assert.equal(closed,true);assert.equal(f.behavior.creates,0);
    assert.equal((await f.request('GET',`/${id}`)).status,503);
  });
  test(`${mode}: strict preview and empty phase body cannot smuggle owner or credentials`,async t=>{
    const f=await fixture(t,mode),input=f.input();
    for(const patch of [{owner:'default'},{model:''},{taskIds:['not-a-uuid']},{fields:[]},{authorityEpoch:1}])assert.equal((await f.request('POST','',{...input,...patch})).status,400);
    await receipt(await f.request('POST','',input),201);
    assert.equal((await f.request('POST',`/${input.requestId}/create`,{owner:'default'})).status,400);
    assert.equal(f.behavior.creates,0);assert.equal(f.behavior.puts,0);
  });
}
test('task-session fixed domain rejects caller identity and incomplete outputs',()=>{
  const command={action:'read',boardId:'default',id:randomUUID()};assert.equal(validHubTaskSessionCommand(command),true);
  for(const field of ['owner','principal','epoch','sql','credential'])assert.equal(validHubTaskSessionCommand({...command,[field]:'forbidden'}),false);
  assert.equal(validHubMemberInput('taskSession',{evidence:{},expectedScope:'scope',command:{...command,owner:'caller'}}),false);
  assert.equal(validHubTaskSessionResult({action:'bindingClaim',claimed:true,receipt:null,credential:null}),false);
  assert.equal(validHubMemberOutput('taskSession',{action:'claim',claimed:true,receipt:null}),false);
});
test('async task composition rejects missing ports before installing any route',()=>{
  const app=new Hono();assert.throws(()=>registerHubTaskSessions(app,{mode:'async'} as never),/async-ports/);assert.equal(app.routes.length,0);
});
test('async guidance composition rejects missing ports before installing any route',()=>{
  const app=new Hono();assert.throws(()=>registerAsyncHubSessionGuidance(app,{mode:'async'} as never),/async-ports/);assert.equal(app.routes.length,0);
});
