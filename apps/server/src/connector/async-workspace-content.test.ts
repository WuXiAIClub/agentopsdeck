import assert from 'node:assert/strict';
import test, {type TestContext} from 'node:test';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {Hono} from 'hono';
import {AsyncConnectorOwner} from './async-connector-owner.js';
import {AsyncWorkspaceFiles} from './async-workspace-files.js';
import {AsyncWorkspaceContent} from './async-workspace-content.js';
import {ConnectorTokenStore} from '../auth/connector-token.js';
import {ContentProposalStore} from '../hub/content-proposal-store.js';
import {cardFileCodec} from './workspace-file-card-format.js';
import {FileBoardError} from './workspace-file-metadata.js';
import {ContentReplicaConflict} from './workspace-content-metadata.js';
import {registerAsyncConnectorContentReplicas} from './workspace-content-http.js';
import {validConnectorContentReplicaInput,validConnectorContentReplicaOutput,connectorContentReplicaSteps} from './connector-content-replica-domain.js';
import {connectorOwnerLargeInput,connectorOwnerLargeResult,connectorOwnerCommandBytes} from './connector-owner-domain.js';
import {PerformanceDiagnostics} from '../diagnostics/performance.js';
const card=(title:string)=>({kind:'notebook' as const,content:{title,text:'hot',archive:'cold archive preserved'}});
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
const canonical=(title:string)=>JSON.stringify(cardFileCodec().parse(Buffer.from(cardFileCodec().serialize(card(title))))!.content);

async function fixture(t:TestContext){
  const root=await mkdtemp(join(tmpdir(),'async-content-chain-')),directory=join(root,'files');await mkdir(directory,{mode:0o700});
  const tokenFile=join(root,'tokens.json'),tokens=new ConnectorTokenStore(tokenFile);
  const token=tokens.create({label:'content',scopes:['boards:files','messages:send']});
  const other=tokens.create({label:'foreign',scopes:['boards:files','messages:send']});
  const actor={authorization:`Bearer ${token.token}`,tokenId:token.record.id};
  const config={file:join(root,'connector.sqlite'),tokenFile,boardFiles:{root:directory,policies:[{owner:actor.tokenId,runtime:'codex' as const}]}};
  let owner=new AsyncConnectorOwner(config,new PerformanceDiagnostics(()=>{}));
  let files=new AsyncWorkspaceFiles(owner,directory,cardFileCodec()),local=new AsyncWorkspaceContent(owner,files);
  await owner.command('tokensList',{});
  const db=new DatabaseSync(':memory:'),resource=JSON.stringify(['notebook','hub:default']);
  const hub=new ContentProposalStore(db,text=>{
    const value:unknown=JSON.parse(text),codec=cardFileCodec();if(!codec.valid(value))throw Error('schema');
    return JSON.stringify(codec.parse(Buffer.from(codec.serialize(value)))!.content);
  },id=>id===actor.tokenId);
  const base=hub.initialize(actor.tokenId,resource,'epoch1',JSON.stringify(card('Original'))),key=`codex:${randomUUID()}`;
  const attach=async()=>{
    const binding=hub.bind(actor.tokenId,resource,randomUUID(),'authority1');
    const input={id:binding.id,generation:binding.generation,resource,sessionKey:key,base};
    const proof=await local.install(actor,input);hub.acknowledgeInstallation(actor.tokenId,resource,binding.id,binding.generation,proof);
    return {...binding,input,path:(await files.get(actor,binding.id)).path};
  };
  const endpoint={propose:async(r:string,p:Parameters<typeof hub.propose>[2])=>hub.propose(actor.tokenId,r,p),
    original:async(r:string,p:Parameters<typeof hub.propose>[2])=>hub.receipt(actor.tokenId,r,p.bindingId,p.generation,p.mutationId)};
  const reopen=async()=>{
    await local.close();await files.close();await owner.close();owner=new AsyncConnectorOwner(config,new PerformanceDiagnostics(()=>{}));
    files=new AsyncWorkspaceFiles(owner,directory,cardFileCodec());local=new AsyncWorkspaceContent(owner,files);await owner.command('tokensList',{});
  };
  t.after(async()=>{await local.close();await files.close();await owner.close();db.close();await rm(root,{recursive:true,force:true});});
  return {root,actor,other,key,hub,base,resource,attach,endpoint,reopen,get owner(){return owner;},get files(){return files;},get local(){return local;},
    edit:(path:string,title:string)=>writeFile(path,cardFileCodec().serialize(card(title)))};
}

test('real worker content chain uses original Hub receipts, file CAS and preserves later edits/archive',async t=>{
  const f=await fixture(t),a=await f.attach(),b=await f.attach();
  await f.edit(a.path,'Local proposal');const proposal=(await f.local.observe(f.actor,a.id))!;
  const committed=await f.local.publish(f.actor,a.id,proposal.proposal.mutationId,f.endpoint);assert.equal(committed.state,'committed');
  const pending=f.hub.projections(f.actor.tokenId,f.resource,b.id,b.generation).find(p=>p.state==='pending')!;
  const job=f.hub.claimProjection(f.actor.tokenId,f.resource,pending.id,f.base.hash,false).job;
  assert.equal((await f.local.project(f.actor,b.id,job)).state,'saved');
  const projected=await f.files.snapshot(f.actor,b.id);assert.equal(projected.state,'ready');
  if(projected.state==='ready')assert.deepEqual(projected.value.content,card('Local proposal'));
  await f.edit(b.path,'Later local edit');const bytes=await readFile(b.path,'utf8');
  assert.equal((await f.local.project(f.actor,b.id,job)).state,'saved');
  assert.equal((await f.local.projectionReceipt(f.actor,b.id,job)).state,'saved');assert.equal(await readFile(b.path,'utf8'),bytes);
  await f.reopen();assert.equal((await f.local.projectionReceipt(f.actor,b.id,job)).state,'saved');
  assert.equal(await readFile(b.path,'utf8'),bytes);assert.equal((await f.local.view(f.actor,b.id)).base.hash,job.hash);
});

test('unknown proposal survives worker reopen and only inspects original receipt, never resends',async t=>{
  const f=await fixture(t),a=await f.attach();await f.edit(a.path,'Unknown');const p=(await f.local.observe(f.actor,a.id))!;
  let sends=0,reads=0;
  const lost={propose:async()=>{sends++;throw Error('unknown transport');},original:async()=>{reads++;return undefined;}};
  assert.equal((await f.local.publish(f.actor,a.id,p.proposal.mutationId,lost)).state,'unknown');
  await f.reopen();assert.equal((await f.local.publish(f.actor,a.id,p.proposal.mutationId,lost)).state,'unknown');
  assert.equal((await f.local.recover(f.actor,a.id,p.proposal.mutationId,lost)).state,'unknown');
  assert.deepEqual({sends,reads},{sends:1,reads:1});
  const receipt=await f.endpoint.propose(f.resource,p.proposal);
  assert.equal((await f.local.recover(f.actor,a.id,p.proposal.mutationId,{...lost,original:async()=>receipt})).state,'committed');
  await assert.rejects(f.local.settle(f.actor,a.id,p.proposal.mutationId,{...receipt,hash:'f'.repeat(64)}),ContentReplicaConflict);
});

for(const failed of [false,true])test(`real worker close drains original transport and receipt before owner release (${failed})`,async t=>{
  const f=await fixture(t),binding=await f.attach();await f.edit(binding.path,'Shutdown draft');
  const p=(await f.local.observe(f.actor,binding.id))!;
  let enter!:()=>void,release!:()=>void,sends=0,drained=false;
  const entered=new Promise<void>(resolve=>{enter=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  const flight=f.local.publish(f.actor,binding.id,p.proposal.mutationId,{...f.endpoint,propose:async(...args)=>{
    sends++;enter();await gate;if(failed)throw Error('unknown original transport');return f.endpoint.propose(...args);
  }});
  await entered;const closing=f.local.close().then(()=>{drained=true;});
  try{
    await assert.rejects(f.local.view(f.actor,binding.id),/closing/);
    await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(drained,false);
    // The original database still owns UNKNOWN while the physical handoff waits.
    const original=await f.owner.command('contentReplicaProposals',{actor:f.actor,args:[binding.id]});
    assert.ok(original.ok);if(original.ok)assert.equal(original.value[0]!.state,'unknown');
  }finally{release();}
  assert.equal((await flight).state,failed?'unknown':'committed');await closing;await f.local.close();
  await f.reopen();assert.equal((await f.local.recover(f.actor,binding.id,p.proposal.mutationId,f.endpoint)).state,failed?'unknown':'committed');
  assert.equal(sends,1);assert.equal(await readFile(binding.path,'utf8'),cardFileCodec().serialize(card('Shutdown draft')));
});

test('projection metadata never accepts invented success or an unrelated original file mutation',async t=>{
  const f=await fixture(t),a=await f.attach(),binding=a.id;
  const content=canonical('Projection'),job={id:randomUUID(),bindingId:binding,generation:a.generation,revision:1,
    hash:digest(content),content,state:'unknown' as const,expectedHash:f.base.hash};
  const execute=(state:'saved'|'conflict'|'uncertain')=>f.owner.command('contentReplicaProjected',{actor:f.actor,args:[binding,job,state]});
  assert.deepEqual(await execute('saved'),{ok:false,status:409});
  assert.equal((await f.local.projectionReceipt(f.actor,binding,job)).state,'uncertain');
  const owned=await f.owner.command('contentReplicaOwned',{actor:f.actor,args:[binding]});assert.equal(owned.ok,true);if(!owned.ok)throw Error('owned');
  assert.deepEqual(await f.owner.command('contentReplicaPrepareProjection',{actor:f.actor,args:[binding,job,owned.value]}),
    {ok:true,value:{content:JSON.parse(content)}});
  assert.deepEqual(await execute('saved'),{ok:false,status:409});
  await f.files.write(f.actor,binding,{mutationId:job.id,expectedHash:f.base.hash,content:card('Different write')});
  assert.deepEqual(await execute('saved'),{ok:false,status:409});
  assert.equal((await f.local.view(f.actor,binding)).base.hash,f.base.hash);
});

test('real worker conflict resolution retains original receipt, local edit and reopen identity',async t=>{
  const f=await fixture(t),a=await f.attach(),b=await f.attach();
  await f.edit(a.path,'First accepted');const first=(await f.local.observe(f.actor,a.id))!;
  assert.equal((await f.local.publish(f.actor,a.id,first.proposal.mutationId,f.endpoint)).state,'committed');
  await f.edit(b.path,'Local conflict');const stale=(await f.local.observe(f.actor,b.id))!;
  const conflict=await f.local.publish(f.actor,b.id,stale.proposal.mutationId,f.endpoint);assert.equal(conflict.state,'conflict');
  const accepted=await f.local.view(f.actor,a.id),snapshot=await f.files.snapshot(f.actor,b.id);
  assert.equal(snapshot.state,'ready');if(snapshot.state!=='ready')throw Error('snapshot');
  const resolution={conflictId:stale.proposal.mutationId,mutationId:randomUUID(),expectedHash:snapshot.value.hash,base:accepted.base};
  const replacement=await f.local.resolve(f.actor,b.id,resolution);
  assert.equal(replacement.proposal.baseHash,accepted.base.hash);
  assert.equal(replacement.proposal.content,JSON.stringify(snapshot.value.content));
  await f.reopen();assert.deepEqual(await f.local.resolve(f.actor,b.id,resolution),replacement);
  const proposals=(await f.local.view(f.actor,b.id)).proposals;
  assert.deepEqual(proposals.find(p=>p.proposal.mutationId===stale.proposal.mutationId)?.receipt,conflict.receipt);
  assert.equal(proposals.find(p=>p.proposal.mutationId===stale.proposal.mutationId)?.resolvedBy,resolution.mutationId);
  assert.equal((await f.local.publish(f.actor,b.id,replacement.proposal.mutationId,f.endpoint)).state,'committed');
  assert.equal(JSON.parse((await f.local.view(f.actor,b.id)).base.content).content.archive,'cold archive preserved');
});

test('projection recovery after reopen inspects only the original intent and receipt, never rewrites',async t=>{
  const f=await fixture(t),a=await f.attach(),content=canonical('Durable projection');
  const job={id:randomUUID(),bindingId:a.id,generation:a.generation,revision:1,
    hash:digest(content),content,state:'unknown' as const,expectedHash:f.base.hash};
  const plan=await f.owner.command('contentReplicaProjection',{actor:f.actor,args:[a.id,job]});
  assert.equal(plan.ok,true);if(!plan.ok)throw Error('projection');
  assert.equal((await f.owner.command('contentReplicaPrepareProjection',{actor:f.actor,args:[a.id,job,plan.value.replica]})).ok,true);
  const before=await readFile(a.path,'utf8');await f.reopen();
  assert.equal((await f.local.project(f.actor,a.id,job)).state,'uncertain');
  assert.equal(await readFile(a.path,'utf8'),before);
  assert.equal((await f.local.view(f.actor,a.id)).base.hash,f.base.hash);
  // Simulate the original physical writer completing before its journal ACK.
  assert.equal((await f.files.write(f.actor,a.id,{mutationId:job.id,expectedHash:job.expectedHash,content:JSON.parse(content)})).state,'saved');
  await f.reopen();await f.edit(a.path,'Later edit must survive');
  assert.equal((await f.local.projectionReceipt(f.actor,a.id,job)).state,'saved');
  const current=await f.files.snapshot(f.actor,a.id);assert.equal(current.state,'ready');
  if(current.state==='ready')assert.equal(current.value.content.content.title,'Later edit must survive');
  assert.equal((await f.local.view(f.actor,a.id)).base.hash,job.hash);
});

test('content worker rejects ID-only identity, foreign bearer, missing scope/policy and revocation',async t=>{
  const f=await fixture(t),a=await f.attach();
  const denied=(e:unknown)=>e instanceof FileBoardError&&e.status===403;
  await assert.rejects(f.local.view({...f.actor,authorization:''},a.id),denied);
  await assert.rejects(f.local.view({...f.actor,authorization:`Bearer ${f.other.token}`},a.id),denied);
  await assert.rejects(f.local.view({tokenId:f.other.record.id,authorization:`Bearer ${f.other.token}`},a.id));
  const token=await f.owner.command('tokenCreate',{label:'no files',scopes:['messages:send']});
  await assert.rejects(f.local.view({tokenId:token.record.id,authorization:`Bearer ${token.token}`},a.id),denied);
  const original=await readFile(a.path,'utf8');await f.local.revoke(f.actor,a.id);
  await assert.rejects(f.local.view(f.actor,a.id));assert.equal(await readFile(a.path,'utf8'),original);
  await f.owner.command('tokenRevoke',{tokenId:f.actor.tokenId});await assert.rejects(f.local.revoke(f.actor,a.id),denied);
});

test('same content HTTP protocol awaits authority/session and rejects revoked in-flight installation',async t=>{
  const f=await fixture(t),app=new Hono();let beforeSession:(()=>Promise<void>)|undefined;
  registerAsyncConnectorContentReplicas(app,{files:f.files,replicas:f.local,available:()=>true,
    authority:{authenticate:async request=>{const actor=await f.files.authenticate(request);return actor&&{id:actor.tokenId,actor};}},
    session:async key=>{await beforeSession?.();return {exists:key===f.key,ready:true};}});
  const request=(method:string,path:string,body?:unknown)=>app.request('/api/connector/v1/workspace/content-replicas'+path,
    {method,headers:{authorization:f.actor.authorization},...(body===undefined?{}:{body:JSON.stringify(body)})});
  assert.deepEqual(await (await request('GET','')).json(),{protocol:1,maxBindings:32,available:true});
  assert.equal((await request('GET','?forbidden=1')).status,400);
  const id=randomUUID(),input={id,resource:f.resource,generation:randomUUID(),sessionKey:f.key,base:f.base};
  const installed=await request('PUT','/'+id,input);assert.equal(installed.status,200);assert.equal(installed.headers.get('cache-control'),'no-store');
  assert.equal((await request('GET','/'+id)).status,200);assert.deepEqual(await (await request('POST','/'+id+'/observe')).json(),{proposal:null});
  beforeSession=async()=>{await f.owner.command('tokenRevoke',{tokenId:f.actor.tokenId});};
  const pending=randomUUID();assert.ok([401,403].includes((await request('PUT','/'+pending,{...input,id:pending})).status));
  const inspector=new ConnectorTokenStore(join(f.root,'tokens.json'));assert.equal(inspector.hasScope(f.actor.tokenId,'boards:files'),false);
});

test('fixed content command schemas, diagnostics and shared large-work budgets remain bounded',()=>{
  assert.deepEqual(Object.values(connectorContentReplicaSteps),Array.from({length:14},(_,i)=>321+i));
  const actor={authorization:'Bearer test',tokenId:'test'},id=randomUUID();
  assert.equal(validConnectorContentReplicaInput('contentReplicaOwned',{actor,args:[id]}),true);
  for(const bad of [{actor:{tokenId:'test'},args:[id]},{actor,args:[id],sql:'select 1'},{actor,args:[id,id]},{actor,args:['not-a-uuid']}])
    assert.equal(validConnectorContentReplicaInput('contentReplicaOwned',bad),false);
  assert.equal(validConnectorContentReplicaOutput('contentReplicaOwned',{ok:true,value:{owner:'test',id}}),false);
  assert.equal(validConnectorContentReplicaOutput('contentReplicaRevoke',{ok:true,value:null}),true);
  assert.equal(connectorOwnerLargeResult('contentReplicaProposals'),true);
  assert.equal(connectorOwnerLargeInput('contentReplicaResolve',32768),true);
  assert.equal(connectorOwnerCommandBytes('contentReplicaResolve'),32*1024*1024+65536);
  const base={epoch:'epoch',revision:0,hash:digest(canonical('Original')),content:canonical('Original')};
  const installation={id,resource:JSON.stringify(['notebook','hub:default']),generation:randomUUID(),sessionKey:'codex:test',base};
  assert.equal(validConnectorContentReplicaInput('contentReplicaInstallation',{actor,args:[installation]}),true);
  assert.equal(validConnectorContentReplicaInput('contentReplicaInstallation',{actor,args:[{...installation,resource:JSON.stringify(['taskboard','hub:default'])}]}),false);
});
