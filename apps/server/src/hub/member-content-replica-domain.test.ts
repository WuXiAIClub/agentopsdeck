import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {HubStore} from './hub-store.js';
import {ContentProposalStore,type ContentAsyncStorageAdmission} from './content-proposal-store.js';
import {normalizeSharedContent} from './workspace-content-coordinator.js';
import {encodeHubSessionId} from './session-id.js';
import {executeContentBinding,validContentBinding,validContentBindingTarget} from './member-content-replica-domain.js';
import {validHubContentDocumentCommand,validHubContentDocumentReply} from './member-content-document-domain.js';
import {executeContentSync} from './member-content-sync-domain.js';

const resourceId=JSON.stringify(['taskboard','default']);
const content=JSON.stringify({kind:'taskboard',content:{title:'Original',tasks:[]}});
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};
async function fixture(t:TestContext) {
  const owner=new HubStore(':memory:','fixture');t.after(()=>owner.close());
  owner.upsertConnection({id:'local',kind:'local',label:'Local',connectorUrl:'local://aod-connector'});
  owner.pinConnectionNode('local','default',owner.connectionAuthority('local','default')!,'node_'+randomUUID());
  const head=await owner.createContentDocumentStore().initializeAsync('default',resourceId,randomUUID(),content);
  const target={sessionId:encodeHubSessionId('local','codex:fixture'),connectionId:'local',sessionKey:'codex:fixture',
    authority:owner.connectionAuthority('local','default')!};
  return {owner,head,target,id:randomUUID()};
}

test('fixed binding domain rejects caller authority and correlates exact original installation proof',async t=>{
  const {owner,head,target,id}=await fixture(t);
  const command={action:'binding-prepare' as const,resourceId,id,target,epoch:head.epoch,revision:head.revision};
  assert.equal(validHubContentDocumentCommand(command),true);
  for(const extra of [{owner:'foreign'},{sql:'SELECT 1'},{authorized:true}])
    assert.equal(validHubContentDocumentCommand({...command,...extra}),false);
  for(const changed of [{connectionId:'foreign'},{sessionKey:'codex:foreign'},{authority:-1},{owner:'foreign'}])
    assert.equal(validContentBindingTarget({...target,...changed}),false);
  const prepared=await executeContentBinding(owner,'default',resourceId,command,()=>{});
  assert.equal(prepared.action,'binding-prepare');if(prepared.action!=='binding-prepare')throw Error('Wrong action');
  assert.equal(validContentBinding(prepared.binding),true);
  assert.equal(validContentBinding({...prepared.binding,initial:{...head,content:content+' '}}),false);
  const reply={...prepared,resourceId};
  assert.equal(validHubContentDocumentReply(command,reply),true);
  for(const changed of [{id:randomUUID()},{epoch:randomUUID()},{revision:head.revision+1},{target:{...target,authority:target.authority+1}}])
    assert.equal(validHubContentDocumentReply({...command,...changed},reply),false);
  const ack={action:'binding-ack' as const,resourceId,id,generation:prepared.binding.generation,
    proof:{epoch:head.epoch,revision:head.revision,hash:head.hash}};
  const settled=await executeContentBinding(owner,'default',resourceId,ack,()=>{});
  assert.equal(validHubContentDocumentReply(ack,{...settled,resourceId}),true);
  for(const changed of [{epoch:randomUUID()},{revision:head.revision+1},{hash:'0'.repeat(64)}])
    assert.equal(validHubContentDocumentReply({...ack,proof:{...ack.proof,...changed}},{...settled,resourceId}),false);
  const cleanup={action:'binding-cleanup' as const,resourceId,id,generation:prepared.binding.generation};
  const unavailable={...cleanup,target:null};
  assert.equal(validHubContentDocumentReply(cleanup,unavailable),true);
  assert.equal(validHubContentDocumentReply(cleanup,{...unavailable,id:randomUUID()}),false);
  assert.equal(validHubContentDocumentReply(cleanup,{...unavailable,generation:randomUUID()}),false);
});

async function installed(t:TestContext) {
  const f=await fixture(t),store=f.owner.createContentDocumentStore();
  const binding=await store.bindAsync('default',resourceId,f.id,JSON.stringify([f.target.connectionId,f.target.authority]),
    {target:f.target,epoch:f.head.epoch,revision:f.head.revision});
  store.acknowledgeInstallation('default',resourceId,f.id,binding.generation,f.head);
  const proposal={bindingId:f.id,generation:binding.generation,mutationId:randomUUID(),modeEpoch:f.head.epoch,
    baseRevision:f.head.revision,baseHash:f.head.hash,content:JSON.stringify({kind:'taskboard',content:{title:'Edited',tasks:[]}})};
  return {...f,store,binding,proposal};
}

test('conflict proof correlates original fingerprint and immutable historical snapshot, never latest head',async t=>{
  const f=await installed(t);
  const write=(title:string,base=f.head)=>f.store.writeAsync('default',resourceId,{mutationId:randomUUID(),modeEpoch:base.epoch,
    baseRevision:base.revision,baseHash:base.hash,content:JSON.stringify({kind:'taskboard',content:{title,tasks:[]}})});
  await write('Historical');const historical=f.store.resource('default',resourceId)!;
  const receipt=await f.store.proposeAsync('default',resourceId,f.proposal);assert.equal(receipt.state,'conflict');
  await write('New head',historical);
  const command={action:'sync-conflict-proof' as const,resourceId,id:f.id,generation:f.binding.generation,proposal:f.proposal};
  const result=await executeContentSync(f.owner,'default',resourceId,command,()=>{});
  assert.equal(result.action,'sync-conflict-proof');if(result.action!=='sync-conflict-proof')throw Error('Wrong action');
  assert.deepEqual(result.snapshot,historical);assert.deepEqual(result.receipt,receipt);
  assert.equal(validHubContentDocumentReply(command,{...result,resourceId}),true);
  assert.equal(validHubContentDocumentReply(command,{...result,resourceId,snapshot:f.store.resource('default',resourceId)}),false);
  for(const proposal of [{...f.proposal,content:content},{...f.proposal,mutationId:randomUUID()}])
    await assert.rejects(executeContentSync(f.owner,'default',resourceId,{...command,proposal},()=>{}),/conflict-proof/);
  assert.equal(validHubContentDocumentCommand({...command,owner:'foreign'}),false);
  assert.equal(validHubContentDocumentReply(command,{...result,resourceId,id:randomUUID()}),false);
  assert.equal(validHubContentDocumentReply(command,{...result,resourceId,snapshot:{...historical,epoch:randomUUID()}}),false);
});

async function resolutionFixture(t:TestContext){
  const f=await installed(t);
  await f.store.writeAsync('default',resourceId,{mutationId:randomUUID(),modeEpoch:f.head.epoch,
    baseRevision:f.head.revision,baseHash:f.head.hash,content:JSON.stringify({kind:'taskboard',content:{title:'Historical',tasks:[]}})});
  const historical=f.store.resource('default',resourceId)!;
  assert.equal((await f.store.proposeAsync('default',resourceId,f.proposal)).state,'conflict');
  const intent={conflictId:f.proposal.mutationId,mutationId:randomUUID(),expectedHash:f.head.hash,
    epoch:historical.epoch,revision:historical.revision,hash:historical.hash};
  const command={action:'sync-resolution-claim' as const,id:f.id,generation:f.binding.generation,intent};
  return {...f,historical,intent,command,db:(f.owner as unknown as {db:DatabaseSync}).db};
}
test('resolution claim is durable, single-use, exact-proof correlated and settlement is idempotent',async t=>{
  const f=await resolutionFixture(t),input={resourceId,...f.command};
  assert.equal(validHubContentDocumentCommand(input),true);
  for(const change of [{owner:'foreign'},{intent:{...f.intent,authorized:true}},{intent:{...f.intent,state:'unknown'}},
    {intent:{...f.intent,mutationId:f.intent.conflictId}}])assert.equal(validHubContentDocumentCommand({...input,...change}),false);
  const result=await executeContentSync(f.owner,'default',resourceId,f.command,()=>{});
  assert.ok(result.action==='sync-resolution-claim'&&result.claimed);assert.equal(result.intent.state,'unknown');
  assert.equal(validHubContentDocumentReply(input,{resourceId,...result}),true);
  for(const changed of [{mutationId:randomUUID()},{expectedHash:'0'.repeat(64)},{epoch:randomUUID()},
    {hash:'0'.repeat(64)},{revision:f.intent.revision+1},{conflictId:randomUUID()}]){
    assert.equal(validHubContentDocumentReply({...input,intent:{...f.intent,...changed}},{resourceId,...result}),false);
    await assert.rejects(executeContentSync(f.owner,'default',resourceId,{...f.command,intent:{...f.intent,...changed}},()=>{}));
  }
  const again=await executeContentSync(f.owner,'default',resourceId,f.command,()=>{});
  assert.ok(again.action==='sync-resolution-claim'&&!again.claimed);assert.deepEqual(again.intent,result.intent);
  const ack={...f.command,action:'sync-resolution-ack' as const};
  const settled=await executeContentSync(f.owner,'default',resourceId,ack,()=>{});
  assert.ok(settled.action==='sync-resolution-ack');assert.equal(settled.intent.state,'acknowledged');
  assert.equal(validHubContentDocumentReply({resourceId,...ack},{resourceId,...settled}),true);
  assert.deepEqual(await executeContentSync(f.owner,'default',resourceId,ack,()=>{}),settled);
  const recovered=await executeContentSync(f.owner,'default',resourceId,f.command,()=>{});
  assert.ok(recovered.action==='sync-resolution-claim'&&!recovered.claimed&&recovered.intent.state==='acknowledged');
});
test('resolution claim rolls back with original transaction and old-schema read never creates a table',async t=>{
  const f=await resolutionFixture(t);
  f.db.exec('DROP TABLE v2_content_resolutions');
  assert.equal(f.store.resolution('default',resourceId,f.id,f.binding.generation,f.intent.conflictId),undefined);
  assert.equal(f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='v2_content_resolutions'").get(),undefined);
  const ack={...f.command,action:'sync-resolution-ack' as const};
  await assert.rejects(executeContentSync(f.owner,'default',resourceId,ack,()=>{}),/resolution-missing/);
  assert.equal(f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='v2_content_resolutions'").get(),undefined,'failed settlement rolls schema back');
  // An unrelated original transaction creates the additive table; a failed
  // INSERT must leave neither an intent nor a partially acknowledged result.
  f.store.acknowledgeInstallation('default',resourceId,f.id,f.binding.generation,f.head);
  f.db.exec("CREATE TEMP TRIGGER fail_resolution BEFORE INSERT ON v2_content_resolutions BEGIN SELECT RAISE(ABORT,'resolution failure'); END");
  await assert.rejects(executeContentSync(f.owner,'default',resourceId,f.command,()=>{}),/resolution failure/);
  assert.equal(f.store.resolution('default',resourceId,f.id,f.binding.generation,f.intent.conflictId),undefined);
  f.db.exec('DROP TRIGGER fail_resolution');await executeContentSync(f.owner,'default',resourceId,f.command,()=>{});
  f.db.exec("CREATE TEMP TRIGGER fail_resolution_ack BEFORE UPDATE ON v2_content_resolutions BEGIN SELECT RAISE(ABORT,'resolution ACK failure'); END");
  await assert.rejects(executeContentSync(f.owner,'default',resourceId,ack,()=>{}),/resolution ACK failure/);
  assert.equal(f.store.resolution('default',resourceId,f.id,f.binding.generation,f.intent.conflictId)!.state,'unknown');
});
for(const fault of ['identity','connection','binding'] as const)test(`resolution admission wait rechecks ${fault} before original commit`,async t=>{
  const f=await resolutionFixture(t),entered=deferred(),release=deferred();t.after(()=>release.resolve());let valid=true;
  const admission:ContentAsyncStorageAdmission=async(_bytes,write)=>{entered.resolve();await release.promise;return write();};
  const store=new ContentProposalStore(f.db,normalizeSharedContent,()=>true,undefined,admission);
  f.owner.createContentDocumentStore=()=>store;
  const work=executeContentSync(f.owner,'default',resourceId,f.command,()=>{if(!valid)throw Error('revoked-current-identity');});
  const rejected=assert.rejects(work);await entered.promise;
  if(fault==='identity')valid=false;
  else if(fault==='connection')f.owner.upsertConnection({id:'local',kind:'local',label:'Disabled',connectorUrl:'local://aod-connector',status:'disabled'});
  else f.store.revoke('default',resourceId,f.id);
  release.resolve();await rejected;
  assert.equal(store.resolution('default',resourceId,f.id,f.binding.generation,f.intent.conflictId),undefined);
});

test('sync fixed domain correlates mutation fingerprint and refuses foreign authority DTOs',async t=>{
  const f=await installed(t),command={action:'sync-submit' as const,resourceId,id:f.id,generation:f.binding.generation,proposal:f.proposal};
  assert.equal(validHubContentDocumentCommand(command),true);
  for(const extra of [{owner:'foreign'},{authorized:true},{sql:'SELECT 1'},{proposal:{...f.proposal,bindingId:randomUUID()}},
    {proposal:{...f.proposal,generation:randomUUID()}}])assert.equal(validHubContentDocumentCommand({...command,...extra}),false);
  const result={resourceId,...await executeContentSync(f.owner,'default',resourceId,command,()=>{})};
  assert.equal(validHubContentDocumentReply(command,result),true);
  for(const proposal of [{...f.proposal,mutationId:randomUUID()},{...f.proposal,content:content},
    {...f.proposal,baseRevision:f.proposal.baseRevision+1}])assert.equal(validHubContentDocumentReply({...command,proposal},result),false);
  assert.equal(validHubContentDocumentReply({...command,generation:randomUUID()},result),false);
  const original={...command,action:'sync-original' as const};
  assert.equal(validHubContentDocumentReply(original,{resourceId,...await executeContentSync(f.owner,'default',resourceId,original,()=>{})}),true);
});

test('one-body projection reads and claim/ACK preserve original binding scope',async t=>{
  const f=await installed(t),other=randomUUID(),second=await f.store.bindAsync('default',resourceId,other,
    JSON.stringify([f.target.connectionId,f.target.authority]),{target:f.target,epoch:f.head.epoch,revision:f.head.revision});
  f.store.acknowledgeInstallation('default',resourceId,other,second.generation,f.head);
  await f.store.proposeAsync('default',resourceId,f.proposal);
  const next={action:'sync-projection-next' as const,resourceId,id:f.id,generation:f.binding.generation,excluded:[]};
  const result=await executeContentSync(f.owner,'default',resourceId,next,()=>{});
  assert.ok(result.action==='sync-projection-next'&&result.job);const job=result.job;
  assert.equal(validHubContentDocumentReply(next,{resourceId,...result}),true);
  assert.equal(validHubContentDocumentReply({...next,excluded:[job.id]},{resourceId,...result}),false);
  const claim={action:'sync-projection-claim' as const,resourceId,id:f.id,generation:f.binding.generation,jobId:job.id,actualHash:f.head.hash,pending:false};
  await assert.rejects(executeContentSync(f.owner,'default',resourceId,{...claim,id:other,generation:second.generation},()=>{}),/projection-scope/);
  await assert.rejects(executeContentSync(f.owner,'default',resourceId,{...claim,pending:true},()=>{}),/dirty-projection/);
  const claimed=await executeContentSync(f.owner,'default',resourceId,claim,()=>{});
  assert.equal(validHubContentDocumentReply(claim,{resourceId,...claimed}),true);
  assert.equal(validHubContentDocumentReply({...claim,actualHash:'0'.repeat(64)},{resourceId,...claimed}),false);
  const ack={action:'sync-projection-ack' as const,resourceId,id:f.id,generation:f.binding.generation,jobId:job.id,hash:job.hash};
  const settled=await executeContentSync(f.owner,'default',resourceId,ack,()=>{});
  assert.equal(validHubContentDocumentReply(ack,{resourceId,...settled}),true);
  assert.equal(validHubContentDocumentReply({...ack,jobId:randomUUID()},{resourceId,...settled}),false);
  assert.equal(f.store.nextProjection('default',resourceId,f.id,f.binding.generation,[]),undefined);
});

for(const operation of ['proposal','projection'] as const)for(const fault of ['identity','connection'] as const)
  test(`${operation} admission wait rechecks ${fault} inside original root transaction`,async t=>{
    const f=await installed(t),entered=deferred(),release=deferred();t.after(()=>release.resolve());let valid=true;
    let jobId='';
    if(operation==='projection'){
      await f.store.proposeAsync('default',resourceId,f.proposal);
      jobId=f.store.nextProjection('default',resourceId,f.id,f.binding.generation,[])!.id;
    }
    const admission:ContentAsyncStorageAdmission=async(_bytes,write)=>{entered.resolve();await release.promise;return write();};
    const store=new ContentProposalStore((f.owner as unknown as {db:DatabaseSync}).db,normalizeSharedContent,()=>true,undefined,admission);
    f.owner.createContentDocumentStore=()=>store;
    const scope={id:f.id,generation:f.binding.generation};
    const operationCommand=operation==='proposal'?{...scope,action:'sync-submit' as const,proposal:f.proposal}:
      {...scope,action:'sync-projection-claim' as const,jobId,actualHash:f.head.hash,pending:false};
    const pending=executeContentSync(f.owner,'default',resourceId,operationCommand,()=>{if(!valid)throw Error('revoked-current-identity');});
    const rejected=assert.rejects(pending,fault==='identity'?/revoked-current-identity/:/binding-authority/);
    try{await entered.promise;if(fault==='identity')valid=false;else f.owner.upsertConnection({id:'local',kind:'local',label:'Disabled',connectorUrl:'local://aod-connector',status:'disabled'});}
    finally{release.resolve();}
    await rejected;
    if(operation==='proposal')assert.equal(store.receipt('default',resourceId,f.id,f.binding.generation,f.proposal.mutationId),undefined);
    else {
      // Read retained outbox without granting the now-invalid target authority.
      const row=(f.owner as unknown as {db:DatabaseSync}).db.prepare('SELECT payload FROM v2_projection_outbox WHERE id=?').get(jobId)!;
      assert.equal(JSON.parse(String(row.payload)).state,'pending');
    }
  });

for(const fault of ['identity','connection'] as const)test(`volume wait rechecks ${fault} in original binding transaction`,async t=>{
  const {owner,head,target,id}=await fixture(t),entered=deferred(),release=deferred();
  t.after(()=>release.resolve());let admitted=false,currentIdentity=true;
  const admission:ContentAsyncStorageAdmission=async(_bytes,write)=>{entered.resolve();await release.promise;admitted=true;return write();};
  // Inject only physical admission, retaining the exact original SQLite root
  // and real store transaction; the domain's fresh target check is not mocked.
  const store=new ContentProposalStore((owner as unknown as {db:DatabaseSync}).db,normalizeSharedContent,()=>true,undefined,admission);
  owner.createContentDocumentStore=()=>store;
  const check=()=>{if(!currentIdentity)throw Error('revoked-current-identity');};
  const pending=executeContentBinding(owner,'default',resourceId,{action:'binding-prepare',id,target,epoch:head.epoch,revision:head.revision},check);
  const rejected=assert.rejects(pending,fault==='identity'?/revoked-current-identity/:/binding-authority/);
  try {
    await entered.promise;
    if(fault==='identity')currentIdentity=false;
    else owner.upsertConnection({id:'local',kind:'local',label:'Changed',connectorUrl:'local://aod-connector',status:'disabled'});
  }finally{release.resolve();}
  await rejected;assert.equal(admitted,true);assert.equal(store.bindingRecord('default',resourceId,id),undefined);
});
