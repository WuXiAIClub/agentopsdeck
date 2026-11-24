import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {Hono} from 'hono';
import {CONNECTOR_PROTOCOL,CONNECTOR_PROTOCOL_HEADER} from '@agentopsdeck/shared';
import {HubStore} from './hub-store.js';
import {OriginalHubAdministrativeCommands} from './original-administrative-commands.js';
import {AsyncHubMemberOwner} from './async-member-owner.js';
import {createHubAdministrativeServices} from './administrative-route-services.js';
import {createAsyncConnectorClientResolver} from './async-connector-client.js';
import {hubMemberEvidence} from './member-owner-domain.js';
import {PerformanceDiagnostics} from '../diagnostics/performance.js';
import {loadConfig} from '../config.js';
import {registerHubRoutes} from '../routes/hub.js';
import {encodeHubSessionId} from './session-id.js';
import {ConnectorTokenStore} from '../auth/connector-token.js';
import {ConnectorWorkspaceFiles} from '../connector/workspace-board-files.js';
import {cardFileCodec} from '../connector/workspace-file-card-format.js';
import {WorkspaceContentReplica} from '../connector/workspace-content-replica.js';
import {registerConnectorContentReplicas} from '../connector/workspace-content-http.js';
import {NODE_ID_HEADER} from '../connector/node-identity.js';
import type {ContentBinding,ContentResource} from './content-proposal-store.js';
import type {LocalContentProposal} from '../connector/workspace-content-replica.js';
import {contentOverviewResponses} from './content-overview-responses.js';
import {projectSessionDirectory,parseSessionDirectoryQuery} from '../projection/session-directory.js';
import type {ContentBatch} from './workspace-content-batches.js';
import {AsyncContentBackground} from './async-content-background.js';
import {contentReplicaTransport} from './workspace-content-transport.js';

const resource=JSON.stringify(['taskboard','default']),sessionId=encodeHubSessionId('local','codex:fixture');
const base='http://hub.invalid/api/hub/v1/workspace/shared-content/'+encodeURIComponent(resource);
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};
const tick=()=>new Promise<void>(r=>setImmediate(r));
async function fixture(t:TestContext,mode:'original'|'worker',sessionCount=1,routeBackground=false){
  const reservedBefore=contentOverviewResponses.reservedBytes;
  const root=mkdtempSync(join(tmpdir(),'content-binding-production-')),file=join(root,'hub.sqlite'),nodeId='node_'+randomUUID();
  const seed=new HubStore(file,'fixture'),key=seed.identities.issueKey('default'),admin=seed.identities.issueKey('default');
  (seed as unknown as {db:DatabaseSync}).db.prepare("INSERT INTO hub_roles VALUES ('default','admin',1)").run();
  const cookie=seed.identities.createSession(key.token)!;
  seed.upsertConnection({id:'local',kind:'local',label:'Local',connectorUrl:'local://aod-connector'});
  seed.pinConnectionNode('local','default',seed.connectionAuthority('local','default')!,nodeId);
  const sessions=Array.from({length:sessionCount},(_,i)=>i?'codex:fixture-'+i:'codex:fixture');
  seed.workspace.save('default',{revision:0,groups:[],sessions:Object.fromEntries(sessions.map(s=>[encodeHubSessionId('local',s),{tags:['review']}]))});
  const head=await seed.createContentDocumentStore().initializeAsync('default',resource,randomUUID(),
    JSON.stringify({kind:'taskboard',content:{title:'PRIVATE_BINDING_CONTENT',tasks:[]}}));
  await seed.close();
  const logs:string[]=[],diagnostics=new PerformanceDiagnostics(line=>logs.push(line));
  const db=new DatabaseSync(join(root,'connector.sqlite')),tokens=new ConnectorTokenStore(join(root,'tokens.json'),undefined,diagnostics);
  const credential=tokens.createTransient(['boards:files'],'local:content-fixture');
  const files=new ConnectorWorkspaceFiles(db,root,(owner,key)=>owner==='local:content-fixture'&&sessions.includes(key),cardFileCodec('taskboard'));
  const replicas=new WorkspaceContentReplica(db,files),connector=new Hono();
  connector.use('*',async(c,next)=>{await next();c.header(CONNECTOR_PROTOCOL_HEADER,String(CONNECTOR_PROTOCOL.max));c.header(NODE_ID_HEADER,nodeId);});
  registerConnectorContentReplicas(connector,{tokens,files,replicas,available:()=>true,session:async()=>({exists:true,ready:true}),diagnostics});
  const calls={capability:0,install:0,view:0,revoke:0,observe:0,claim:0,settle:0,project:0,projectionReceipt:0,resolve:0,directory:0};
  const hooks:{before?:((request:Request)=>Promise<void>)|undefined;after?:((request:Request,response:Response)=>Promise<Response>)|undefined;
    sqlAfter?:((action:string)=>Promise<void>)|undefined}={};
  let sync=0,current:ReturnType<typeof mount>;
  const config={...loadConfig({HOME:root,AOD_SERVER_ROLE:'hub'}),boardFilesEnabled:false};
  function mount(){
    const metadata=new HubStore(mode==='original'?file:join(root,'composition.sqlite'),'fixture');
    const owner=mode==='original'?new OriginalHubAdministrativeCommands(metadata,diagnostics):new AsyncHubMemberOwner({file,encryptionSecret:'fixture'},diagnostics);
    const execute=owner.command.bind(owner);
    owner.command=(async(kind,input)=>{
      const result=await execute(kind,input);
      if(kind==='contentDocument')await hooks.sqlAfter?.((input as {command:{action:string}}).command.action);
      return result;
    }) as typeof owner.command;
    const group=createHubAdministrativeServices(owner,diagnostics);let guarded=false,routes:ReturnType<typeof registerHubRoutes>;
    const store=new Proxy(metadata,{get(target,p,receiver){
      if(p==='createContentCoordinator'||p==='createContentBatches')throw Error('LEGACY_CONTENT_CONSTRUCTION');
      if(guarded){sync++;throw Error('MAIN_THREAD_BINDING_SQL');}return Reflect.get(target,p,receiver);
    }});
    const resolver=createAsyncConnectorClientResolver(owner,{connectionId:'local',token:'FORBIDDEN_GENERAL_TOKEN',fileBoardToken:credential.token,
      dispatch:async request=>{
        const path=new URL(request.url).pathname;
        if(path.endsWith('/sessions/directory')){
          assert.equal(request.headers.get('authorization'),'Bearer FORBIDDEN_GENERAL_TOKEN');calls.directory++;
          await hooks.before?.(request);
          const response=Response.json(projectSessionDirectory(sessions,parseSessionDirectoryQuery(new URL(request.url).searchParams),'stable'),{
            headers:{[CONNECTOR_PROTOCOL_HEADER]:String(CONNECTOR_PROTOCOL.max),[NODE_ID_HEADER]:nodeId}});
          return hooks.after?hooks.after(request,response):response;
        }
        assert.equal(request.headers.get('authorization'),'Bearer '+credential.token);
        if(request.method==='PUT')calls.install++;
        else if(request.method==='DELETE')calls.revoke++;
        else if(path.endsWith('/content-replicas'))calls.capability++;
        else if(path.endsWith('/observe'))calls.observe++;
        else if(path.endsWith('/claim'))calls.claim++;
        else if(path.endsWith('/resolve'))calls.resolve++;
        else if(path.endsWith('/receipt'))calls.settle++;
        else if(path.endsWith('/project'))calls.project++;
        else if(path.endsWith('/projection-receipt'))calls.projectionReceipt++;
        else calls.view++;
        await hooks.before?.(request);
        const response=await connector.fetch(request);return hooks.after?hooks.after(request,response):response;
      }},diagnostics);
    const app=new Hono();config.boardFilesEnabled=routeBackground;
    const backgroundAccess=group.createContentBackgroundAccess();
    const background=new AsyncContentBackground(backgroundAccess,async reference=>contentReplicaTransport(await resolver.contentBackground!(backgroundAccess,reference)),
      ()=>config.boardFilesEnabled,diagnostics);
    const dispose=async()=>{guarded=false;try{await background.close();await routes?.close();}finally{try{await resolver.close();await group.close();}finally{await owner.close();await metadata.close();}}};
    try{
      routes=registerHubRoutes(app,{config,hubStore:store,administrative:group,asyncConnectorClient:resolver,
        principal:()=>{sync++;throw Error('MAIN_THREAD_BINDING_PRINCIPAL');},connectorClient:()=>{sync++;throw Error('MAIN_THREAD_BINDING_RESOLVER');},
        fileCardClient:()=>{sync++;throw Error('OLD_FILE_CARD_TRANSPORT');},normalizeError:()=> 'safe'});
      assert.ok(routes);guarded=true;config.boardFilesEnabled=true;
    }catch(error){void dispose();throw error;}
    return {app,owner,dispose,background,close:()=>routes!.close(),closeResolver:()=>resolver.close()};
  }
  t.after(async()=>{try{await current?.dispose();}finally{credential.dispose();await files.close();db.close();rmSync(root,{recursive:true,force:true});}
    assert.equal(contentOverviewResponses.reservedBytes,reservedBefore,'all delivered or suppressed responses release their budget');
    assert.equal(sync,0);for(const secret of [key.token,admin.token,cookie,credential.token,'PRIVATE_BINDING_CONTENT','FORBIDDEN_GENERAL_TOKEN',
      'PRIVATE_SYNC','PRIVATE_UNKNOWN','PRIVATE_SETTLE','PRIVATE_PROJECTION','PRIVATE_PROJECT','PRIVATE_REVOKED','PRIVATE_CONFLICT','PRIVATE_RESOLVE','PRIVATE_BACKGROUND'])assert.equal(logs.join('').includes(secret),false);});
  current=mount();
  const headers={'x-agentopsdeck-key':key.token};
  const request=(method:string,id:string,body?:unknown,extra:Record<string,string>=headers,signal?:AbortSignal)=>current.app.fetch(new Request(base+'/bindings/'+id,
    {method,headers:extra,...(signal?{signal}:{}),...(body===undefined?{}:{body:JSON.stringify(body)})}));
  const read=async(response:Response,status=200)=>{assert.equal(response.status,status,await response.clone().text());assert.equal(response.headers.get('cache-control'),'no-store');return response.json() as Promise<{binding:ContentBinding;revoked?:boolean;cleanup?:string}>;};
  const proof=async()=>{const evidence=hubMemberEvidence(new Request(base,{headers:{'x-agentopsdeck-key':admin.token}}));
    const snapshot=await current.owner.command('memberSnapshot',evidence);assert.ok(snapshot);return {evidence,expectedScope:snapshot.recoveryScope};};
  const stored=async(id:string)=>{const result=await current.owner.command('contentDocument',{...await proof(),command:{action:'overview',resourceId:resource}});
    assert.ok(result&&'action'in result&&result.action==='overview');return result.manifest.bindings.find(b=>b.id===id);};
  return {head,calls,hooks,key,cookie,headers,request,read,stored,config,files,
    background:()=>current.background.syncTick(),closeBackground:()=>current.background.close(),
    batch:(method:string,id:string,body?:unknown,signal?:AbortSignal,extra:Record<string,string>=headers)=>current.app.fetch(new Request(base+'/batches/'+id,
      {method,headers:extra,...(signal?{signal}:{}),...(body===undefined?{}:{body:JSON.stringify(body)})})),
    sync:(id:string,signal?:AbortSignal)=>request('POST',id+'/sync',undefined,headers,signal),
    edit:async(id:string,title:string)=>writeFile(files.get('local:content-fixture',id).path,cardFileCodec('taskboard').serialize({kind:'taskboard',content:{title,tasks:[]}})),
    title:async(id:string)=>JSON.parse(await readFile(files.get('local:content-fixture',id).path,'utf8')).content.title as string,
    view:(id:string)=>replicas.view('local:content-fixture',id),
    write:async(title:string)=>current.owner.command('contentDocument',{...await proof(),command:{action:'write',resourceId:resource,
      mutationId:randomUUID(),modeEpoch:head.epoch,baseRevision:head.revision,baseHash:head.hash,
      content:JSON.stringify({kind:'taskboard',content:{title,tasks:[]}})}}),
    advance:async(title:string)=>{
      const p=await proof(),result=await current.owner.command('contentDocument',{...p,command:{action:'overview',resourceId:resource}});
      assert.ok(result&&'action'in result&&result.action==='overview'&&result.manifest.head);const base=result.manifest.head;
      return current.owner.command('contentDocument',{...p,command:{action:'write',resourceId:resource,mutationId:randomUUID(),
        modeEpoch:base.epoch,baseRevision:base.revision,baseHash:base.hash,content:JSON.stringify({kind:'taskboard',content:{title,tasks:[]}})}});
    },
    bind:(id=randomUUID(),signal?:AbortSignal)=>request('PUT',id,{sessionId,epoch:head.epoch,revision:head.revision},headers,signal),
    close:()=>current.close(),closeResolver:()=>current.closeResolver(),reopen:async()=>{await current.dispose();current=mount();},
    revokeKey:async()=>current.owner.command('memberKeyRevoke',{...await proof(),userId:'default',keyId:key.id}),
    disable:async()=>{const p=await proof(),value=await current.owner.command('connectionTarget',{...p,id:'local'});
      assert.ok(value&&'epoch'in value);return current.owner.command('connectionChange',{...p,change:{action:'patch',id:'local',expectedEpoch:value.epoch,configuration:{enabled:false}}});}};
}

for(const mode of ['original','worker'] as const){
  test(`${mode}: private background commits local content and projects original receipt without HTTP identity`,{timeout:30_000},async t=>{
    const f=await fixture(t,mode),a=randomUUID(),b=randomUUID();await f.read(await f.bind(a));await f.read(await f.bind(b));
    await f.edit(a,'PRIVATE_BACKGROUND_CONTENT');await f.revokeKey();
    await f.background();await f.background();
    assert.equal((await f.view(a)).proposals[0]?.state,'committed');assert.equal(await f.title(b),'PRIVATE_BACKGROUND_CONTENT');
    assert.equal((await f.stored(a))?.acknowledgedRevision,f.head.revision+1);assert.equal(f.calls.claim,1);assert.equal(f.calls.project,1);
    await f.background();assert.equal(f.calls.claim,1);assert.equal(f.calls.project,1);
  });
  test(`${mode}: private background retains one page flight and stays idle while disabled`,{timeout:30_000},async t=>{
    const f=await fixture(t,mode),id=randomUUID();await f.read(await f.bind(id));const before=f.calls.view;
    f.config.boardFilesEnabled=false;await f.background();assert.equal(f.calls.view,before);
    f.config.boardFilesEnabled=true;const entered=deferred(),release=deferred();
    f.hooks.before=async request=>{if(new URL(request.url).pathname.endsWith('/observe')){entered.resolve();await release.promise;}};
    const first=f.background();await entered.promise;assert.equal(f.background(),first);release.resolve();await first;
    assert.equal(f.calls.observe,1);await f.closeBackground();await f.background();assert.equal(f.calls.observe,1);
  });
  test(`${mode}: private background restores lost installation ACK by view, never install`,{timeout:30_000},async t=>{
    const f=await fixture(t,mode),id=randomUUID();
    f.hooks.after=async(request,response)=>{if(request.method==='PUT'){await response.text();throw Error('PRIVATE_BACKGROUND_INSTALL_ACK');}return response;};
    await f.read(await f.bind(id));assert.equal((await f.stored(id))?.acknowledgedRevision,-1);
    f.hooks.after=undefined;await f.reopen();await f.background();
    assert.equal((await f.stored(id))?.acknowledgedRevision,f.head.revision);assert.equal(f.calls.install,1);
  });
  test(`${mode}: private background cannot replay a claim with lost original ACK after reopen`,{timeout:30_000},async t=>{
    const f=await fixture(t,mode),id=randomUUID();await f.read(await f.bind(id));await f.edit(id,'PRIVATE_BACKGROUND_UNKNOWN');
    f.hooks.after=async(request,response)=>{if(new URL(request.url).pathname.endsWith('/claim')){await response.text();throw Error('PRIVATE_BACKGROUND_CLAIM_ACK');}return response;};
    await f.background();assert.equal((await f.view(id)).proposals[0]?.state,'unknown');
    f.hooks.after=undefined;await f.reopen();await f.background();await f.background();
    assert.equal(f.calls.claim,1);assert.equal(f.calls.settle,0);assert.equal((await f.stored(id))?.acknowledgedRevision,f.head.revision);
  });
  test(`${mode}: private background resumes unknown projection by original receipt after reopen`,{timeout:30_000},async t=>{
    const f=await fixture(t,mode),id=randomUUID();await f.read(await f.bind(id));await f.write('PRIVATE_BACKGROUND_PROJECT');
    f.hooks.after=async(request,response)=>{if(new URL(request.url).pathname.endsWith('/project')){await response.text();throw Error('PRIVATE_BACKGROUND_PROJECT_ACK');}return response;};
    await f.background();assert.equal(f.calls.project,1);assert.equal((await f.stored(id))?.acknowledgedRevision,f.head.revision);
    f.hooks.after=undefined;await f.reopen();await f.background();
    assert.equal(f.calls.project,1);assert.equal(f.calls.projectionReceipt,1);assert.equal((await f.stored(id))?.acknowledgedRevision,f.head.revision+1);
  });
  test(`${mode}: background close drains an executed projection ACK before retiring private authority`,{timeout:30_000},async t=>{
    const f=await fixture(t,mode),id=randomUUID();await f.read(await f.bind(id));await f.write('PRIVATE_BACKGROUND_DRAIN');
    const entered=deferred(),release=deferred();
    f.hooks.after=async(request,response)=>{if(new URL(request.url).pathname.endsWith('/project')){entered.resolve();await release.promise;}return response;};
    const flight=f.background();await entered.promise;let closed=false;const close=f.closeBackground().then(()=>{closed=true;});
    await tick();assert.equal(closed,false);release.resolve();await Promise.all([flight,close]);
    assert.equal((await f.stored(id))?.acknowledgedRevision,f.head.revision+1);assert.equal(f.calls.project,1);
    await f.background();assert.equal(f.calls.project,1);
  });
  test(`${mode}: background disable after claim preserves unknown and admits no original proposal`,{timeout:30_000},async t=>{
    const f=await fixture(t,mode),id=randomUUID();await f.read(await f.bind(id));await f.edit(id,'PRIVATE_BACKGROUND_PAUSED');
    f.hooks.after=async(request,response)=>{if(new URL(request.url).pathname.endsWith('/claim'))f.config.boardFilesEnabled=false;return response;};
    await f.background();assert.equal((await f.view(id)).proposals[0]?.state,'unknown');assert.equal(f.calls.settle,0);
    f.hooks.after=undefined;f.config.boardFilesEnabled=true;await f.background();assert.equal(f.calls.claim,1);assert.equal(f.calls.settle,0);
  });
  test(`${mode}: private background refuses changed connection authority after a view await`,{timeout:30_000},async t=>{
    const f=await fixture(t,mode),id=randomUUID();await f.read(await f.bind(id));
    f.hooks.before=async request=>{if(new URL(request.url).pathname.endsWith('/'+id)){f.hooks.before=undefined;await f.disable();}};
    await f.background();assert.equal(f.calls.observe,0);assert.equal(f.calls.claim,0);assert.equal(f.calls.project,0);
    const views=f.calls.view;await f.background();assert.equal(f.calls.view,views);
  });
  test(`${mode}: production background advances four then two bindings and wraps without exceeding four effects`,{timeout:30_000},async t=>{
    const f=await fixture(t,mode),ids=Array.from({length:6},()=>randomUUID());
    for(const id of ids)await f.read(await f.bind(id));
    const entered=deferred(),release=deferred(),observed=new Set<string>();let active=0,maximum=0;
    t.after(()=>release.resolve());
    f.hooks.before=async request=>{
      const path=new URL(request.url).pathname;
      if(path.endsWith('/observe')){
        observed.add(path.split('/').at(-2)!);maximum=Math.max(maximum,++active);
        if(active===4)entered.resolve();await release.promise;
      }
    };
    f.hooks.after=async(request,response)=>{if(new URL(request.url).pathname.endsWith('/observe'))active--;return response;};
    const first=f.background();await entered.promise;assert.equal(f.calls.observe,4);assert.equal(f.background(),first);
    release.resolve();await first;assert.equal(observed.size,4);
    await f.background();assert.equal(observed.size,6);assert.equal(f.calls.observe,6);
    await f.background();assert.equal(f.calls.observe,10);assert.equal(maximum,4);
    assert.equal(f.calls.install,6);assert.equal(f.calls.claim,0);assert.equal(f.calls.project,0);
  });
  test(`${mode}: original binding revocation remains available while the bulk conflict response pool is full`,{timeout:30_000},async t=>{
    const f=await fixture(t,mode),id=randomUUID();await f.read(await f.bind(id));
    const held=contentOverviewResponses.reserveParts();
    try{
      assert.equal((await f.request('GET',id)).status,503);
      const result=await f.read(await f.request('DELETE',id));assert.equal(result.revoked,true);
      assert.equal((await f.stored(id))?.revoked,true);assert.equal(f.calls.revoke,1);
    }finally{held.release();}
  });
  test(`${mode}: actual route timer drains original projection ACK while HTTP services and resolver close`,{timeout:30_000},async t=>{
    // The production interval and node:test timeout are both unref'ed.
    const keepAlive=setInterval(()=>{},1000);t.after(()=>clearInterval(keepAlive));
    const f=await fixture(t,mode,1,true),id=randomUUID();await f.read(await f.bind(id));await f.write('PRIVATE_BACKGROUND_TIMER');
    const entered=deferred(),release=deferred();t.after(()=>release.resolve());
    f.hooks.after=async(request,response)=>{if(new URL(request.url).pathname.endsWith('/project')){entered.resolve();await release.promise;}return response;};
    // The production timer must stay unref'ed, but the test needs a bounded
    // live handle while waiting for its original projection to enter.
    let watchdog:ReturnType<typeof setTimeout>|undefined;
    try{await Promise.race([entered.promise,new Promise<never>((_,reject)=>{
      watchdog=setTimeout(()=>reject(new Error('Original content projection did not enter')),15_000);
    })]);}finally{clearTimeout(watchdog);}let closed=false;
    const close=Promise.all([f.close(),f.closeResolver()]).then(()=>{closed=true;});await tick();assert.equal(closed,false);
    release.resolve();await close;assert.equal((await f.stored(id))?.acknowledgedRevision,f.head.revision+1);
    assert.equal(await f.title(id),'PRIVATE_BACKGROUND_TIMER');assert.equal(f.calls.project,1);
  });
  test(`${mode}: production sync retains original CAS conflict and never overwrites a dirty replica`,{timeout:30_000},async t=>{
    const f=await fixture(t,mode),id=randomUUID();await f.read(await f.bind(id));
    await f.edit(id,'PRIVATE_LOCAL_CONFLICT');await f.write('PRIVATE_OWNER_CONFLICT');
    const result=await f.read(await f.sync(id)),view=await f.view(id);
    assert.equal(result.binding.acknowledgedRevision,f.head.revision);assert.equal(view.proposals[0]?.state,'conflict');
    assert.equal(f.calls.project,0);assert.equal(await f.title(id),'PRIVATE_LOCAL_CONFLICT');
    await f.reopen();await f.read(await f.sync(id));assert.equal(f.calls.claim,1);assert.equal(f.calls.project,0);
  });
  test(`${mode}: contradictory projection result cannot ACK; original saved receipt recovers`,{timeout:30_000},async t=>{
    const f=await fixture(t,mode),id=randomUUID();await f.read(await f.bind(id));await f.write('PRIVATE_PROJECT_PROOF');
    f.hooks.after=async(request,response)=>{
      if(new URL(request.url).pathname.endsWith('/project')){
        const body=await response.json() as Record<string,unknown>;return Response.json({...body,id:randomUUID()},{headers:response.headers});
      }return response;
    };
    await f.read(await f.sync(id),409);assert.equal((await f.stored(id))?.acknowledgedRevision,f.head.revision);
    f.hooks.after=undefined;await f.reopen();const result=await f.read(await f.sync(id));
    assert.equal(result.binding.acknowledgedRevision,f.head.revision+1);assert.equal(f.calls.project,1);assert.equal(f.calls.projectionReceipt,1);
  });
  test(`${mode}: production sync commits original proposal and projects once to the second binding`,{timeout:30_000},async t=>{
    const f=await fixture(t,mode),a=randomUUID(),b=randomUUID();await f.read(await f.bind(a));await f.read(await f.bind(b));
    await f.edit(a,'PRIVATE_SYNC_EDIT');const synced=await f.read(await f.sync(a));
    assert.equal(synced.binding.acknowledgedRevision,f.head.revision+1);assert.equal(f.calls.claim,1);assert.equal(f.calls.settle,1);
    const remote=await f.view(a);assert.equal(remote.proposals[0]?.state,'committed');
    const projected=await f.read(await f.sync(b));assert.equal(projected.binding.acknowledgedHash,synced.binding.acknowledgedHash);
    assert.equal(await f.title(b),'PRIVATE_SYNC_EDIT');assert.equal(f.calls.project,1);
    await f.reopen();await f.read(await f.sync(a));await f.read(await f.sync(b));assert.equal(f.calls.claim,1);assert.equal(f.calls.project,1);
  });
  test(`${mode}: lost claim ACK remains unknown after reopen and cannot resubmit`,{timeout:30_000},async t=>{
    const f=await fixture(t,mode),id=randomUUID();await f.read(await f.bind(id));await f.edit(id,'PRIVATE_UNKNOWN_CLAIM');
    f.hooks.after=async(request,response)=>{if(new URL(request.url).pathname.endsWith('/claim')){await response.text();throw Error('PRIVATE_CLAIM_LOST');}return response;};
    await f.read(await f.sync(id),503);assert.equal((await f.view(id)).proposals[0]?.state,'unknown');
    f.hooks.after=undefined;await f.reopen();const retry=await f.read(await f.sync(id));
    assert.equal(retry.binding.acknowledgedRevision,f.head.revision);assert.equal(f.calls.claim,1);assert.equal(f.calls.settle,0);
    assert.equal((await f.view(id)).proposals[0]?.state,'unknown');
  });
  test(`${mode}: lost settle ACK recovers original committed receipt without another claim`,{timeout:30_000},async t=>{
    const f=await fixture(t,mode),id=randomUUID();await f.read(await f.bind(id));await f.edit(id,'PRIVATE_SETTLE_RECOVERY');
    f.hooks.after=async(request,response)=>{if(new URL(request.url).pathname.endsWith('/receipt')){await response.text();throw Error('PRIVATE_SETTLE_LOST');}return response;};
    await f.read(await f.sync(id),503);assert.equal((await f.view(id)).proposals[0]?.state,'committed');
    f.hooks.after=undefined;await f.reopen();const retry=await f.read(await f.sync(id));
    assert.equal(retry.binding.acknowledgedRevision,f.head.revision+1);assert.equal(f.calls.claim,1);assert.equal(f.calls.settle,1);
  });
  for(const saved of [false,true])test(`${mode}: unknown projection only reads original receipt after reopen, saved=${saved}`,{timeout:30_000},async t=>{
    const f=await fixture(t,mode),id=randomUUID();await f.read(await f.bind(id));await f.write('PRIVATE_PROJECTION_RECOVERY');
    if(saved)f.hooks.after=async(request,response)=>{if(new URL(request.url).pathname.endsWith('/project')){await response.text();throw Error('PRIVATE_PROJECT_LOST');}return response;};
    else f.hooks.before=async request=>{if(new URL(request.url).pathname.endsWith('/project'))throw Error('PRIVATE_PROJECT_UNSENT');};
    await f.read(await f.sync(id),503);assert.equal(f.calls.project,1);
    f.hooks.after=undefined;f.hooks.before=undefined;await f.reopen();const retry=await f.read(await f.sync(id));
    assert.equal(f.calls.project,1);assert.equal(f.calls.projectionReceipt,1);
    assert.equal(retry.binding.acknowledgedRevision,f.head.revision+Number(saved));
    assert.equal(await f.title(id),saved?'PRIVATE_PROJECTION_RECOVERY':'PRIVATE_BINDING_CONTENT');
  });
  for(const close of [false,true])test(`${mode}: production projection ACK drains through ${close?'shutdown':'browser abort'}`,{timeout:30_000},async t=>{
    const entered=deferred(),release=deferred(),abort=new AbortController();t.after(()=>release.resolve());
    const f=await fixture(t,mode),id=randomUUID();await f.read(await f.bind(id));await f.write('PRIVATE_PROJECT_DRAIN');
    f.hooks.after=async(request,response)=>{if(new URL(request.url).pathname.endsWith('/project')){entered.resolve();await release.promise;}return response;};
    const flight=f.sync(id,abort.signal);await entered.promise;
    await f.read(await f.sync(id),409);
    let drained=false,closing:Promise<void>|undefined;
    if(close){closing=f.close().then(()=>{drained=true;});await tick();assert.equal(drained,false);}else abort.abort();
    release.resolve();const response=await flight;assert.equal(response.status,close?503:499);await response.text();await closing;
    assert.equal((await f.stored(id))?.acknowledgedRevision,f.head.revision+1);assert.equal(f.calls.project,1);
    f.hooks.after=undefined;await f.reopen();await f.read(await f.sync(id));assert.equal(f.calls.project,1);
  });
  test(`${mode}: revocation while original Connector claim waits prevents proposal commit`,{timeout:30_000},async t=>{
    const entered=deferred(),release=deferred();t.after(()=>release.resolve());
    const f=await fixture(t,mode),id=randomUUID();await f.read(await f.bind(id));await f.edit(id,'PRIVATE_REVOKED_PROPOSAL');
    f.hooks.after=async(request,response)=>{if(new URL(request.url).pathname.endsWith('/claim')){entered.resolve();await release.promise;}return response;};
    const flight=f.sync(id);await entered.promise;await f.revokeKey();release.resolve();await f.read(await flight,403);
    assert.equal(f.calls.settle,0);assert.equal((await f.stored(id))?.acknowledgedRevision,f.head.revision);
    assert.equal((await f.view(id)).proposals[0]?.state,'unknown');
  });
}

for(const mode of ['original','worker'] as const){
  test(`${mode}: production install/query/revoke uses complete owner and real restricted Connector files`,{timeout:30_000},async t=>{
    const f=await fixture(t,mode),id=randomUUID(),first=await f.read(await f.bind(id));
    assert.deepEqual(first.binding.initial,f.head);assert.equal(first.binding.acknowledgedRevision,f.head.revision);
    for(const headers of [f.headers,{authorization:'Bearer '+f.key.token},{cookie:'agentopsdeck_session='+f.cookie}]){
      assert.deepEqual(await f.read(await f.request('GET',id,undefined,headers)),first);
    }
    assert.deepEqual(await f.read(await f.bind(id)),first);assert.equal(f.calls.install,1);assert.equal(f.calls.capability,1);
    const head=await f.request('HEAD',id);assert.equal(head.status,200);assert.equal(await head.text(),'');
    await f.reopen();assert.deepEqual(await f.read(await f.request('GET',id)),first);
    assert.deepEqual(await f.read(await f.request('DELETE',id)),{revoked:true,cleanup:'confirmed'});
    assert.equal((await f.stored(id))?.revoked,true);assert.equal(f.calls.revoke,1);
    await f.read(await f.bind(id),409);await f.read(await f.request('GET',id),409);assert.equal(f.calls.install,1);
  });
  for(const installed of [false,true])test(`${mode}: lost installation outcome survives reopen; retry only inspects, installed=${installed}`,{timeout:30_000},async t=>{
    const f=await fixture(t,mode),id=randomUUID();
    if(installed)f.hooks.after=async(request,response)=>{if(request.method==='PUT'){await response.text();throw Error('PRIVATE_LOST_INSTALL_ACK');}return response;};
    else f.hooks.before=async request=>{if(request.method==='PUT')throw Error('PRIVATE_UNSENT_INSTALL');};
    const pending=await f.read(await f.bind(id));assert.equal(pending.binding.acknowledgedRevision,-1);
    f.hooks.after=undefined;f.hooks.before=undefined;await f.reopen();
    if(installed){const recovered=await f.read(await f.bind(id));assert.equal(recovered.binding.acknowledgedRevision,f.head.revision);}
    else await f.read(await f.bind(id),503);
    assert.equal(f.calls.install,1);assert.equal(f.calls.capability,1);assert.equal(f.calls.view,1);
    assert.ok(await f.stored(id));
  });
  for(const close of [false,true])test(`${mode}: admitted file effect settles installation ACK through ${close?'shutdown':'browser abort'}`,{timeout:30_000},async t=>{
    const entered=deferred(),release=deferred(),abort=new AbortController();
    t.after(()=>release.resolve());
    const f=await fixture(t,mode),id=randomUUID();
    f.hooks.after=async(request,response)=>{if(request.method==='PUT'){entered.resolve();await release.promise;}return response;};
    const flight=f.bind(id,abort.signal);await entered.promise;let drained=false,closing:Promise<void>|undefined;
    if(close){closing=f.close().then(()=>{drained=true;});await tick();assert.equal(drained,false);}else abort.abort();
    release.resolve();await f.read(await flight,close?503:499);await closing;
    assert.equal((await f.stored(id))?.acknowledgedRevision,f.head.revision);assert.equal(f.calls.install,1);
    f.hooks.after=undefined;await f.reopen();await f.read(await f.bind(id));assert.equal(f.calls.install,1);
  });
  test(`${mode}: durable tombstone survives offline cleanup and changed connection authority`,{timeout:30_000},async t=>{
    const f=await fixture(t,mode),id=randomUUID();await f.read(await f.bind(id));
    f.hooks.before=async request=>{if(request.method==='DELETE')throw Error('OFFLINE');};
    await f.read(await f.request('DELETE',id),503);assert.equal((await f.stored(id))?.revoked,true);
    f.hooks.before=undefined;await f.disable();
    assert.deepEqual(await f.read(await f.request('DELETE',id)),{revoked:true,cleanup:'unavailable'});
    assert.equal(f.calls.revoke,1);await f.read(await f.bind(id),409);assert.equal(f.calls.install,1);
  });
  test(`${mode}: capability wait cannot admit a binding after key revocation`,{timeout:30_000},async t=>{
    const entered=deferred(),release=deferred();t.after(()=>release.resolve());
    const f=await fixture(t,mode),id=randomUUID();
    f.hooks.before=async request=>{if(new URL(request.url).pathname.endsWith('/content-replicas')){entered.resolve();await release.promise;}};
    const flight=f.bind(id);await entered.promise;await f.revokeKey();release.resolve();
    await f.read(await flight,503);assert.equal(await f.stored(id),undefined);assert.equal(f.calls.install,0);
  });
  test(`${mode}: exact body/scope, disabled admission and contradictory original view fail closed`,{timeout:30_000},async t=>{
    const f=await fixture(t,mode),id=randomUUID(),input={sessionId,epoch:f.head.epoch,revision:f.head.revision};
    await f.read(await f.request('PUT',id,{...input,owner:'injected'}),400);
    await f.read(await f.request('PUT',id,input,{...f.headers,'x-agentopsdeck-recovery-scope':'0'.repeat(64)}),409);
    f.config.boardFilesEnabled=false;await f.read(await f.bind(id),503);assert.equal(f.calls.install,0);f.config.boardFilesEnabled=true;
    await f.read(await f.bind(id));
    f.hooks.after=async(request,response)=>{
      if(request.method==='GET'&&!new URL(request.url).pathname.endsWith('/content-replicas')){
        const value=await response.json() as Record<string,unknown>;
        return Response.json({...value,generation:randomUUID()},{headers:response.headers});
      }return response;
    };
    await f.read(await f.request('GET',id),409);assert.equal(f.calls.install,1);
  });
}

type ConflictView={local:LocalContentProposal;remote:ContentResource;actualHash:string|null};
async function jsonReply<T>(response:Response,status=200):Promise<T>{
  assert.equal(response.status,status,await response.clone().text());
  assert.equal(response.headers.get('cache-control'),'no-store');return response.json() as Promise<T>;
}

const batchSelection={tags:['review'],tagMode:'all' as const};
async function preparedBatch(f:Awaited<ReturnType<typeof fixture>>,id=randomUUID()){
  const {batch}=await jsonReply<{batch:ContentBatch}>(await f.batch('PUT',id,{selection:batchSelection}));
  assert.equal(batch.state,'prepared');return batch;
}
for(const mode of ['original','worker'] as const){
  test(`${mode}: production batch prepare/confirm/inspect/cancel retain original JSON and transaction facts`,{timeout:30_000},async t=>{
    const f=await fixture(t,mode,6),batch=await preparedBatch(f);assert.equal(batch.members.length,6);
    let inflight=0,max=0;
    f.hooks.before=async r=>{if(r.method==='PUT'){inflight++;max=Math.max(max,inflight);await tick();}};
    f.hooks.after=async(r,response)=>{if(r.method==='PUT')inflight--;return response;};
    const first=await jsonReply<{batch:ContentBatch}>(await f.batch('POST',batch.id+'/confirm'));
    assert.equal(first.batch.state,'confirmed');assert.ok(first.batch.members.every(m=>m.state==='installed'));
    assert.ok(max<=4&&max>1);assert.equal(f.calls.install,6);assert.equal(f.calls.directory,2);
    assert.deepEqual(await jsonReply(await f.batch('POST',batch.id+'/confirm')),first);
    assert.deepEqual(await jsonReply(await f.batch('GET',batch.id)),first);assert.equal(f.calls.install,6);
    const head=await f.batch('HEAD',batch.id);assert.equal(head.status,200);assert.equal(await head.text(),'');
    await f.reopen();assert.deepEqual(await jsonReply(await f.batch('POST',batch.id+'/confirm')),first);assert.equal(f.calls.directory,2);
    f.hooks.before=async r=>{if(r.method==='DELETE'){
      for(const member of batch.members)assert.equal((await f.stored(member.id))!.revoked,true,'all tombstones commit before any cleanup');
    }};
    const cancelled=await jsonReply<{batch:ContentBatch}>(await f.batch('DELETE',batch.id));
    assert.equal(cancelled.batch.state,'cancelled');assert.ok(cancelled.batch.members.every(m=>m.state==='cancelled'));
    assert.equal(f.calls.revoke,6);
    assert.deepEqual(await jsonReply(await f.batch('DELETE',batch.id)),cancelled);assert.equal(f.calls.revoke,6);
    assert.deepEqual(await jsonReply(await f.batch('POST',batch.id+'/confirm')),cancelled);assert.equal(f.calls.install,6);
  });
  test(`${mode}: production batch lost install ACK reopens read-only and preserves subsequent file edits`,{timeout:30_000},async t=>{
    const f=await fixture(t,mode),batch=await preparedBatch(f),member=batch.members[0]!;
    f.hooks.after=async(r,response)=>{if(r.method==='PUT')throw Error('PRIVATE_UNKNOWN');return response;};
    const unknown=await jsonReply<{batch:ContentBatch}>(await f.batch('POST',batch.id+'/confirm'));
    assert.equal(unknown.batch.members[0]!.state,'unknown');assert.equal(f.calls.install,1);
    await f.edit(member.id,'PRIVATE_UNKNOWN_EDIT');f.hooks.after=undefined;await f.reopen();
    const recovered=await jsonReply<{batch:ContentBatch}>(await f.batch('POST',batch.id+'/confirm'));
    assert.equal(recovered.batch.members[0]!.state,'installed');assert.equal(await f.title(member.id),'PRIVATE_UNKNOWN_EDIT');
    assert.equal(f.calls.install,1);assert.equal(f.calls.directory,2);
  });
  test(`${mode}: production batch unknown before install never dispatches on read or repeated confirmation`,{timeout:30_000},async t=>{
    const f=await fixture(t,mode),batch=await preparedBatch(f);
    f.hooks.before=async r=>{if(new URL(r.url).pathname.endsWith('/content-replicas'))throw Error('offline');};
    const first=await jsonReply<{batch:ContentBatch}>(await f.batch('POST',batch.id+'/confirm'));
    assert.equal(first.batch.members[0]!.state,'unknown');assert.equal(f.calls.install,0);
    f.hooks.before=undefined;await f.reopen();
    assert.deepEqual(await jsonReply(await f.batch('POST',batch.id+'/confirm')),first);
    assert.deepEqual(await jsonReply(await f.batch('GET',batch.id)),first);assert.equal(f.calls.install,0);
    const cancelled=await jsonReply<{batch:ContentBatch}>(await f.batch('DELETE',batch.id));
    assert.equal(cancelled.batch.members[0]!.state,'cancelled');assert.equal(f.calls.revoke,0);
  });
  test(`${mode}: production batch repeats prepare without catalog and rejects forged body, catalog and caller`,{timeout:30_000},async t=>{
    const f=await fixture(t,mode),batch=await preparedBatch(f);
    f.hooks.before=async r=>{if(new URL(r.url).pathname.endsWith('/sessions/directory'))throw Error('offline');};
    assert.deepEqual(await jsonReply<{batch:ContentBatch}>(await f.batch('PUT',batch.id,{selection:batchSelection})),{batch});
    assert.equal(f.calls.directory,1);await jsonReply(await f.batch('PUT',randomUUID(),{selection:batchSelection}),503);
    await jsonReply(await f.batch('PUT',batch.id,{selection:{tags:['other'],tagMode:'all'}}),409);
    await jsonReply(await f.batch('PUT',batch.id,{selection:batchSelection,catalog:{sessions:[]}}),400);
    await jsonReply(await f.batch('GET',batch.id,undefined,undefined,{'x-agentopsdeck-key':'invalid'}),401);
    await jsonReply(await f.batch('GET',batch.id+'?unexpected=1'),400);
    await jsonReply(await f.batch('GET','not-an-id'),400);
    f.hooks.before=undefined;f.hooks.after=async(r,response)=>new URL(r.url).pathname.endsWith('/sessions/directory')
      ?Response.json({sessions:[{sessionKey:'codex:fixture',runtime:'codex'}],nextCursor:null,sourceCursor:''},{headers:response.headers}):response;
    await jsonReply(await f.batch('POST',batch.id+'/confirm'),409);assert.equal(f.calls.install,0);
    f.hooks.after=undefined;f.config.boardFilesEnabled=false;
    assert.deepEqual(await jsonReply(await f.batch('GET',batch.id)),{batch});
    await jsonReply(await f.batch('POST',batch.id+'/confirm'),503);
    const cancelled=await jsonReply<{batch:ContentBatch}>(await f.batch('DELETE',batch.id));assert.equal(cancelled.batch.state,'cancelled');
  });
  test(`${mode}: production batch rechecks authority after original catalog wait`,{timeout:30_000},async t=>{
    const f=await fixture(t,mode),entered=deferred(),release=deferred(),id=randomUUID();t.after(()=>release.resolve());
    f.hooks.after=async(r,response)=>{if(new URL(r.url).pathname.endsWith('/sessions/directory')){entered.resolve();await release.promise;}return response;};
    const flight=f.batch('PUT',id,{selection:batchSelection});await entered.promise;await f.revokeKey();release.resolve();
    await jsonReply(await flight,403);assert.equal(f.calls.install,0);
  });
  for(const close of [false,true])test(`${mode}: batch admitted install retains original ACK through ${close?'close':'browser abort'}`,{timeout:30_000},async t=>{
    const f=await fixture(t,mode),batch=await preparedBatch(f),entered=deferred(),release=deferred(),abort=new AbortController();t.after(()=>release.resolve());
    f.hooks.after=async(r,response)=>{if(r.method==='PUT'){entered.resolve();await release.promise;}return response;};
    const flight=f.batch('POST',batch.id+'/confirm',undefined,abort.signal);await entered.promise;
    await jsonReply(await f.batch('POST',batch.id+'/confirm'),409);
    let drained=false;const closing=close?f.close().then(()=>{drained=true;}):undefined;
    if(close){await tick();assert.equal(drained,false);}else abort.abort();
    release.resolve();await jsonReply(await flight,close?503:499);await closing;f.hooks.after=undefined;await f.reopen();
    const recovered=await jsonReply<{batch:ContentBatch}>(await f.batch('POST',batch.id+'/confirm'));
    assert.equal(recovered.batch.members[0]!.state,'installed');assert.equal(f.calls.install,1);
  });
}
async function conflicted(t:TestContext,mode:'original'|'worker'){
  const f=await fixture(t,mode),id=randomUUID();await f.read(await f.bind(id));
  await f.edit(id,'PRIVATE_CONFLICT_LOCAL');await f.write('PRIVATE_CONFLICT_HISTORICAL');await f.read(await f.sync(id));
  const view=await f.view(id),local=view.proposals[0]!;assert.equal(local.state,'conflict');
  return {f,id,local,expectedHash:view.actualHash!};
}
for(const mode of ['original','worker'] as const){
  for(const lost of ['dispatch','claim-ack','settlement-ack'] as const)
    test(`${mode}: durable resolve intent survives lost ${lost} and reopen without another effect`,{timeout:30_000},async t=>{
      const {f,id,local,expectedHash}=await conflicted(t,mode);
      const input={conflictId:local.proposal.mutationId,mutationId:randomUUID(),expectedHash};
      if(lost==='dispatch')f.hooks.before=async request=>{
        if(new URL(request.url).pathname.endsWith('/resolve'))throw Error('PRIVATE_RESOLVE_DISPATCH_UNKNOWN');
      };
      else f.hooks.sqlAfter=async action=>{
        if(action===(lost==='claim-ack'?'sync-resolution-claim':'sync-resolution-ack'))throw Error('PRIVATE_RESOLVE_SQL_ACK_UNKNOWN');
      };
      await jsonReply(await f.request('POST',id+'/resolve',input),503);
      const effects=lost==='claim-ack'?0:1;assert.equal(f.calls.resolve,effects);
      f.hooks.before=undefined;f.hooks.sqlAfter=undefined;await f.reopen();
      await jsonReply(await f.request('POST',id+'/resolve',input),lost==='settlement-ack'?200:503);
      assert.equal(f.calls.resolve,effects,'lost COMMIT or dispatch ACK never permits another resolve');
      await jsonReply(await f.request('POST',id+'/resolve',{...input,mutationId:randomUUID()}),409);
      assert.equal(f.calls.resolve,effects);assert.equal(await f.title(id),'PRIVATE_CONFLICT_LOCAL');
      assert.equal(f.calls.project,0);
    });
  test(`${mode}: production conflicts preserve historical snapshot and proposal reads never mutate`,{timeout:30_000},async t=>{
    const {f,id,local,expectedHash}=await conflicted(t,mode);await f.advance('PRIVATE_CONFLICT_LATEST');
    const before={...f.calls};
    const result=await jsonReply<{conflicts:ConflictView[]}>(await f.request('GET',id+'/conflicts'));
    assert.equal(result.conflicts.length,1);const conflict=result.conflicts[0]!;
    assert.deepEqual(conflict.local,local);assert.equal(conflict.actualHash,expectedHash);
    assert.equal(conflict.remote.revision,local.receipt!.revision);assert.equal(conflict.remote.hash,local.receipt!.hash);
    assert.equal(JSON.parse(conflict.remote.content).content.title,'PRIVATE_CONFLICT_HISTORICAL');
    assert.deepEqual(await jsonReply(await f.request('GET',id+'/proposals/'+local.proposal.mutationId)),{proposal:local});
    assert.deepEqual(await jsonReply(await f.request('GET',id+'/proposals/'+randomUUID())),{proposal:null});
    const head=await f.request('HEAD',id+'/conflicts');assert.equal(head.status,200);assert.equal(await head.text(),'');
    for(const key of ['observe','claim','settle','resolve','project'] as const)assert.equal(f.calls[key],before[key]);
    await jsonReply(await f.request('GET',id+'/proposals/not-an-id'),400);
    await f.reopen();assert.deepEqual(await jsonReply(await f.request('GET',id+'/conflicts')),result);
  });
  test(`${mode}: explicit resolve uses historical base, leaves file intact and original ACK recovery is read only`,{timeout:30_000},async t=>{
    const {f,id,local,expectedHash}=await conflicted(t,mode);await f.advance('PRIVATE_CONFLICT_NEW_HEAD');
    const input={conflictId:local.proposal.mutationId,mutationId:randomUUID(),expectedHash};
    f.hooks.after=async(request,response)=>{if(new URL(request.url).pathname.endsWith('/resolve')){
      await response.text();throw Error('PRIVATE_RESOLVE_ACK_LOST');}return response;};
    await jsonReply(await f.request('POST',id+'/resolve',input),503);assert.equal(f.calls.resolve,1);
    f.hooks.after=undefined;await f.edit(id,'PRIVATE_RESOLVE_NEWER_FILE');await f.reopen();
    const original=await jsonReply<{proposal:LocalContentProposal}>(await f.request('GET',id+'/proposals/'+input.mutationId));
    assert.equal(original.proposal.state,'prepared');assert.equal(original.proposal.proposal.baseRevision,local.receipt!.revision);
    assert.equal(JSON.parse(original.proposal.baseContent).content.title,'PRIVATE_CONFLICT_HISTORICAL');
    assert.deepEqual(await jsonReply(await f.request('POST',id+'/resolve',input)),original);assert.equal(f.calls.resolve,1);
    assert.equal(await f.title(id),'PRIVATE_RESOLVE_NEWER_FILE');assert.equal(f.calls.project,0);
    assert.deepEqual(await jsonReply(await f.request('GET',id+'/conflicts')),{conflicts:[]});
    await jsonReply(await f.request('POST',id+'/resolve',{...input,expectedHash:'0'.repeat(64)}),409);assert.equal(f.calls.resolve,1);
  });
  test(`${mode}: conflict receipt forgery and wrong resolved mutation fail before successful delivery`,{timeout:30_000},async t=>{
    const {f,id,local,expectedHash}=await conflicted(t,mode);
    f.hooks.after=async(request,response)=>{
      if(request.method==='GET'&&new URL(request.url).pathname.endsWith('/'+id)){
        const value=await response.json() as {proposals:LocalContentProposal[]};value.proposals[0]!.receipt!.hash='0'.repeat(64);
        return Response.json(value,{headers:response.headers});}return response;};
    await jsonReply(await f.request('GET',id+'/conflicts'),409);assert.equal(f.calls.resolve,0);
    const input={conflictId:local.proposal.mutationId,mutationId:randomUUID(),expectedHash};
    f.hooks.after=async(request,response)=>{
      if(new URL(request.url).pathname.endsWith('/resolve')){
        const value=await response.json() as LocalContentProposal;value.proposal.mutationId=randomUUID();
        return Response.json(value,{headers:response.headers});}return response;};
    await jsonReply(await f.request('POST',id+'/resolve',input),409);assert.equal(f.calls.resolve,1);
    f.hooks.after=undefined;const recovered=await jsonReply<{proposal:LocalContentProposal}>(await f.request('POST',id+'/resolve',input));
    assert.equal(recovered.proposal.proposal.mutationId,input.mutationId);assert.equal(f.calls.resolve,1);
  });
  test(`${mode}: revoked caller after original conflict view wait cannot resolve`,{timeout:30_000},async t=>{
    const entered=deferred(),release=deferred();t.after(()=>release.resolve());
    const {f,id,local,expectedHash}=await conflicted(t,mode);
    f.hooks.after=async(request,response)=>{if(request.method==='GET'&&new URL(request.url).pathname.endsWith('/'+id)){
      entered.resolve();await release.promise;}return response;};
    const flight=f.request('POST',id+'/resolve',{conflictId:local.proposal.mutationId,mutationId:randomUUID(),expectedHash});
    await entered.promise;await f.revokeKey();release.resolve();await jsonReply(await flight,403);assert.equal(f.calls.resolve,0);
  });
  for(const close of [false,true])test(`${mode}: admitted resolve survives ${close?'close':'browser abort'} without replay`,{timeout:30_000},async t=>{
    const entered=deferred(),release=deferred(),abort=new AbortController();t.after(()=>release.resolve());
    const {f,id,local,expectedHash}=await conflicted(t,mode);
    f.hooks.after=async(request,response)=>{if(new URL(request.url).pathname.endsWith('/resolve')){entered.resolve();await release.promise;}return response;};
    const input={conflictId:local.proposal.mutationId,mutationId:randomUUID(),expectedHash};
    const flight=f.request('POST',id+'/resolve',input,f.headers,abort.signal);await entered.promise;
    await jsonReply(await f.request('POST',id+'/resolve',input),409);
    let drained=false;const closing=close?f.close().then(()=>{drained=true;}):undefined;
    if(close){await tick();assert.equal(drained,false);}else abort.abort();
    release.resolve();await jsonReply(await flight,close?503:499);await closing;
    f.hooks.after=undefined;await f.reopen();
    assert.equal((await jsonReply<{proposal:LocalContentProposal}>(await f.request('POST',id+'/resolve',input))).proposal.proposal.mutationId,input.mutationId);
    assert.equal(f.calls.resolve,1);
  });
}
