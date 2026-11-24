import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {HubStore} from './hub-store.js';
import {ContentBatchTransactions} from './content-batch-transactions.js';
import {executeContentBatch,type ContentBatchCommand,type ContentBatchCatalog} from './member-content-batch-domain.js';
import {validHubContentDocumentCommand,validHubContentDocumentReply} from './member-content-document-domain.js';
import {encodeHubSessionId} from './session-id.js';
import {delegationDirectory} from './workspace-delegation-directory.js';
import type {ConnectorClientResolver} from './connector-client.js';

const resourceId=JSON.stringify(['taskboard','default']),selection={tags:['review'],tagMode:'all' as const};
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};
async function fixture(t:TestContext){
  const owner=new HubStore(':memory:','fixture');t.after(()=>owner.close());
  owner.upsertConnection({id:'local',kind:'local',label:'Local',connectorUrl:'local://aod-connector'});
  owner.pinConnectionNode('local','default',owner.connectionAuthority('local','default')!,'node_'+randomUUID());
  const sessions=[encodeHubSessionId('local','codex:one'),encodeHubSessionId('local','codex:two')];
  owner.workspace.save('default',{revision:0,groups:[],sessions:Object.fromEntries(sessions.map(s=>[s,{tags:['review']}]))});
  const content=owner.createContentDocumentStore(),head=await content.initializeAsync('default',resourceId,randomUUID(),
    JSON.stringify({kind:'taskboard',content:{title:'original',tasks:[]}}));
  const command=(c:ContentBatchCommand,check=()=>{})=>executeContentBatch(owner,'default',resourceId,c,check);
  const directory=await command({action:'batch-directory'});assert.equal(directory.action,'batch-directory');
  if(directory.action!=='batch-directory')throw Error('directory');
  const {connections:_,...fence}=directory.directory,catalog:ContentBatchCatalog={...fence,sessions},id=randomUUID();
  const prepare=()=>command({action:'batch-prepare',id,selection,catalog});
  const confirm=()=>command({action:'batch-confirm',id,catalog});
  return {owner,content,head,command,catalog,id,prepare,confirm,db:(owner as unknown as {db:DatabaseSync}).db};
}
test('original Hub composition keeps public directory fences outside transactions and checks batch facts inside commit',async t=>{
  const f=await fixture(t);
  const clients=(()=>({sessionDirectory:async()=>({sessions:[{sessionKey:'codex:one',runtime:'codex'},
    {sessionKey:'codex:two',runtime:'codex'}],nextCursor:null,sourceCursor:'original'})})) as unknown as ConnectorClientResolver;
  const source=delegationDirectory(f.owner,clients),coordinator=f.owner.createContentCoordinator(()=>{throw Error('offline');});
  t.after(()=>coordinator.close());
  const batches=f.owner.createContentBatches(coordinator,source),id=randomUUID();
  const prepared=await batches.prepare('default',resourceId,id,selection);
  assert.equal(prepared.state,'prepared');assert.equal(prepared.members.length,2);
  // The public display API must still refuse uncommitted reads. Only the
  // original transaction-local batch fence is permitted inside the commit.
  f.db.exec('BEGIN');try{assert.throws(()=>source.fence('default'));}finally{f.db.exec('ROLLBACK');}
  const confirmed=await batches.confirm('default',resourceId,id);
  assert.equal(confirmed.state,'confirmed');assert.ok(confirmed.members.every(m=>m.state==='unknown'));
  const cancelled=await batches.cancel('default',resourceId,id);
  assert.equal(cancelled.state,'cancelled');assert.ok(cancelled.members.every(m=>m.state==='cancelled'));
});
test('batch fixed commands validate exact input, nested binding proof and original batch/member correlation',async t=>{
  const f=await fixture(t),input={action:'batch-prepare' as const,resourceId,id:f.id,selection,catalog:f.catalog};
  assert.equal(validHubContentDocumentCommand(input),true);
  for(const extra of [{owner:'other'},{sql:'SELECT 1'},{authorized:true},{memberId:randomUUID()}])
    assert.equal(validHubContentDocumentCommand({...input,...extra}),false);
  for(const catalog of [{...f.catalog,sessions:[...f.catalog.sessions,f.catalog.sessions[0]]},{...f.catalog,generation:-1},{...f.catalog,owner:'other'}])
    assert.equal(validHubContentDocumentCommand({...input,catalog}),false);
  const prepared=await f.prepare();assert.equal(validHubContentDocumentReply(input,{resourceId,...prepared}),true);
  assert.equal(validHubContentDocumentReply({...input,id:randomUUID()},{resourceId,...prepared}),false);
  assert.equal(validHubContentDocumentReply({...input,selection:{tags:['other'],tagMode:'all'}},{resourceId,...prepared}),false);
  const confirmed=await f.confirm();assert.equal(confirmed.action,'batch-confirm');if(confirmed.action!=='batch-confirm')throw Error('confirm');
  const memberId=confirmed.batch.members[0]!.id,c={action:'batch-binding-prepare' as const,id:f.id,memberId};
  const bound=await f.command(c);assert.equal(bound.action,'batch-binding-prepare');if(bound.action!=='batch-binding-prepare')throw Error('prepare');
  assert.equal(validHubContentDocumentReply({resourceId,...c},{resourceId,...bound}),true);
  assert.equal(validHubContentDocumentReply({resourceId,...c,memberId:randomUUID()},{resourceId,...bound}),false);
  assert.equal(validHubContentDocumentReply({resourceId,...c},{resourceId,...bound,result:{...bound.result,binding:{...bound.result.binding,id:randomUUID()}}}),false);
});
test('batch claim is atomic and reentrant confirms/read do not create or resend member bindings',async t=>{
  const f=await fixture(t);await f.prepare();const [first,second]=await Promise.all([f.confirm(),f.confirm()]);
  if(first.action!=='batch-confirm'||second.action!=='batch-confirm')throw Error('confirm');
  assert.equal(Number(first.claimed)+Number(second.claimed),1);
  assert.ok(first.batch.members.every(m=>m.state==='unknown'));
  for(const member of first.batch.members)assert.equal(f.content.bindingRecord('default',resourceId,member.id),undefined);
  assert.deepEqual(await f.command({action:'batch-read',id:f.id}),{action:'batch-read',batch:first.batch});
});
test('batch settlement recognizes only persisted original installation ACK; cancellation and every tombstone roll back together',async t=>{
  const f=await fixture(t);await f.prepare();const confirmed=await f.confirm();if(confirmed.action!=='batch-confirm')throw Error('confirm');
  for(const member of confirmed.batch.members){
    const prepared=await f.command({action:'batch-binding-prepare',id:f.id,memberId:member.id});if(prepared.action!=='batch-binding-prepare')throw Error('prepare');
    const pending=await f.command({action:'batch-settle',id:f.id,memberId:member.id});if(pending.action!=='batch-settle')throw Error('settle');
    assert.equal(pending.batch.members.find(m=>m.id===member.id)!.state,'unknown');
    f.content.acknowledgeInstallation('default',resourceId,member.id,prepared.result.binding.generation,f.head);
    const done=await f.command({action:'batch-settle',id:f.id,memberId:member.id});if(done.action!=='batch-settle')throw Error('settle');
    assert.equal(done.batch.members.find(m=>m.id===member.id)!.state,'installed');
  }
  f.db.exec("CREATE TEMP TRIGGER fail_batch BEFORE UPDATE ON hub_content_batches BEGIN SELECT RAISE(ABORT,'synthetic batch write failure'); END");
  await assert.rejects(f.command({action:'batch-cancel',id:f.id}),/synthetic batch write failure/);
  for(const member of confirmed.batch.members)assert.equal(f.content.bindingRecord('default',resourceId,member.id)!.revoked,false);
  const unchanged=await f.command({action:'batch-read',id:f.id});if(unchanged.action!=='batch-read')throw Error('read');assert.equal(unchanged.batch.state,'confirmed');
  f.db.exec('DROP TRIGGER fail_batch');const cancelled=await f.command({action:'batch-cancel',id:f.id});if(cancelled.action!=='batch-cancel')throw Error('cancel');
  assert.ok(cancelled.batch.members.every(m=>m.state==='cleanup_pending'));
  for(const member of confirmed.batch.members){
    assert.equal(f.content.bindingRecord('default',resourceId,member.id)!.revoked,true);
    await assert.rejects(f.command({action:'batch-binding-prepare',id:f.id,memberId:member.id}),/batch-revoked/);
    await f.command({action:'batch-cleanup-settle',id:f.id,memberId:member.id});
  }
  const repeated=await f.command({action:'batch-cancel',id:f.id});if(repeated.action!=='batch-cancel')throw Error('cancel');
  assert.ok(repeated.batch.members.every(m=>m.state==='cancelled'),'cleanup ACK cannot be undone by repeated cancellation');
});
for(const change of ['caller','preferences','connection','head'] as const)test(`batch prepare revalidates ${change} INSIDE original transaction after capacity wait`,async t=>{
  const f=await fixture(t),entered=deferred(),release=deferred();t.after(()=>release.resolve());let allowed=true;
  t.mock.method(f.owner,'createContentBatchTransactions',(check:Parameters<HubStore['createContentBatchTransactions']>[0])=>
    new ContentBatchTransactions(f.db,f.content,check,async(_bytes,write)=>{entered.resolve();await release.promise;return write();}));
  const flight=f.command({action:'batch-prepare',id:f.id,selection,catalog:f.catalog},()=>{if(!allowed)throw Error('revoked caller');});
  const rejection=assert.rejects(flight,/revoked caller|preview-changed-or-expired/);await entered.promise;
  if(change==='caller')allowed=false;
  if(change==='preferences')f.owner.workspace.save('default',{...f.owner.workspace.get('default'),sessions:{}});
  if(change==='connection')f.owner.upsertConnection({id:'local',label:'Local',connectorUrl:'local://aod-connector',status:'disabled'});
  if(change==='head')await f.content.writeAsync('default',resourceId,{mutationId:randomUUID(),modeEpoch:f.head.epoch,
    baseRevision:f.head.revision,baseHash:f.head.hash,content:JSON.stringify({kind:'taskboard',content:{title:'changed',tasks:[]}})});
  release.resolve();await rejection;assert.equal(f.db.prepare('SELECT count(*) n FROM hub_content_batches').get()!.n,0);assert.equal(f.db.isTransaction,false);
});
test('batch confirmed member authority ignores later tag edits but rejects node/epoch replacement',async t=>{
  const f=await fixture(t);await f.prepare();const claim=await f.confirm();if(claim.action!=='batch-confirm')throw Error('confirm');
  const memberId=claim.batch.members[0]!.id;
  f.owner.workspace.save('default',{...f.owner.workspace.get('default'),sessions:{}});
  assert.equal((await f.command({action:'batch-effect-check',id:f.id,memberId})).action,'batch-effect-check');
  f.owner.upsertConnection({id:'local',label:'Local',connectorUrl:'local://aod-connector',status:'disabled'});
  await assert.rejects(f.command({action:'batch-effect-check',id:f.id,memberId}));
});
