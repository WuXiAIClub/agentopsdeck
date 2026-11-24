import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {HubStore} from './hub-store.js';
import {contentSnapshotRef,contentOverviewResponseBytes,executeContentOverview,matchesContentSnapshot,
  validContentOverviewManifest,contentOverviewView} from './content-overview-domain.js';
import {validHubContentDocumentCommand,validHubContentDocumentReply} from './member-content-document-domain.js';
import {hubMemberResultBytes,hubMemberResultBudget,validHubMemberInput} from './member-owner-domain.js';
import {encodeHubSessionId} from './session-id.js';

const resourceId=JSON.stringify(['taskboard','default']);
const content=(title:string)=>JSON.stringify({kind:'taskboard',content:{title,tasks:[]}});
test('hot overview is an explicit read projection with strict query grammar and reply binding',()=>{
  assert.equal(contentOverviewView('http://fixture/'),'full');
  assert.equal(contentOverviewView('http://fixture/?view=hot'),'hot');
  for(const query of ['view=full','view=hot&view=hot','view=hot&owner=other','owner=other'])
    assert.equal(contentOverviewView('http://fixture/?'+query),'invalid');
  const manifest={head:null,native:{kind:'notebook' as const,content:{title:'Note',text:'90'},revision:7},bindings:[],nativeView:'hot' as const,responseBytes:0};
  manifest.responseBytes=contentOverviewResponseBytes(manifest);
  assert.equal(validContentOverviewManifest(manifest),true);
  assert.equal(manifest.responseBytes,Buffer.byteLength(JSON.stringify({enabled:false,head:null,native:manifest.native,bindings:[],nativeView:'hot'})));
  const resourceId=JSON.stringify(['notebook','hub:default']),command={action:'overview' as const,resourceId,nativeView:'hot' as const};
  assert.equal(validHubContentDocumentCommand(command),true);
  const reply={action:'overview',resourceId,manifest};
  assert.equal(validHubContentDocumentReply(command,reply),true);
  assert.equal(validHubContentDocumentReply({action:'overview',resourceId},reply),false);
  const leaked={...manifest,native:{...manifest.native,content:{...manifest.native.content,archive:'cold'}}};
  leaked.responseBytes=contentOverviewResponseBytes(leaked);
  assert.equal(validContentOverviewManifest(leaked),false);
});
test('overview fixed domain rejects caller authority and binds snapshot hash, byte length and epoch',()=>{
  const snapshot={epoch:randomUUID(),revision:0,content:content('original'),hash:''};
  snapshot.hash=createHash('sha256').update(snapshot.content).digest('hex');
  const ref=contentSnapshotRef(snapshot),command={action:'overview-snapshot' as const,resourceId,source:'head' as const,snapshot:ref};
  const proof={evidence:{accessKey:'fixture'},expectedScope:'a'.repeat(64),command};
  assert.equal(validHubMemberInput('contentDocument',proof),true);
  for(const extra of [{owner:'foreign'},{authorized:true},{sql:'SELECT 1'}]){
    assert.equal(validHubMemberInput('contentDocument',{...proof,...extra}),false);
    assert.equal(validHubContentDocumentCommand({...command,...extra}),false);
  }
  const reply={action:'overview-snapshot',resourceId,snapshot};
  assert.equal(validHubContentDocumentReply(command,reply),true);
  for(const changed of [{epoch:randomUUID()},{revision:1},{hash:'0'.repeat(64)},{bytes:ref.bytes+1}])
    assert.equal(validHubContentDocumentReply({...command,snapshot:{...ref,...changed}},reply),false);
  assert.equal(matchesContentSnapshot(ref,{...snapshot,content:content('tampered')}),false);
  assert.equal(hubMemberResultBytes('contentDocument',proof),ref.bytes+Buffer.byteLength(JSON.stringify({...reply,snapshot:null})));
  assert.equal(hubMemberResultBudget('contentDocument'),32*1024*1024);
});
test('manifest recomputes original full wire size, rejects underestimated, duplicated or mixed-view descriptors',()=>{
  const snapshot={epoch:randomUUID(),revision:0,content:content('quoted " \\ 你'),hash:''};
  snapshot.hash=createHash('sha256').update(snapshot.content).digest('hex');
  const binding={id:randomUUID(),generation:randomUUID(),authorityEpoch:'original',revoked:true,acknowledgedRevision:-1,acknowledgedHash:'',initial:snapshot};
  const manifest={head:contentSnapshotRef(snapshot),native:null,bindings:[{...binding,initial:contentSnapshotRef(snapshot)}],responseBytes:0};
  manifest.responseBytes=contentOverviewResponseBytes(manifest);
  assert.equal(manifest.responseBytes,Buffer.byteLength(JSON.stringify({enabled:false,head:snapshot,native:null,bindings:[binding]})));
  assert.equal(validContentOverviewManifest(manifest),true);
  assert.equal(validContentOverviewManifest({...manifest,responseBytes:manifest.responseBytes-1}),false);
  assert.equal(validContentOverviewManifest({...manifest,bindings:[...manifest.bindings,...manifest.bindings]}),false);
  assert.equal(validContentOverviewManifest({...manifest,native:{kind:'taskboard',content:{title:'Native',tasks:[]},revision:0}}),false);
});
test('original read view retains exact old head, binding generation and tombstone snapshots, never substitutes latest',async t=>{
  const owner=new HubStore(':memory:','fixture');t.after(()=>owner.close());
  const user=owner.createUser('Member');
  owner.boards.save(user.id,'default',{title:'Original',tasks:[],revision:0,mutationId:randomUUID()});
  owner.upsertConnection({id:'node',label:'Node',ownerUserId:user.id,connectorUrl:'http://fixture.invalid',credentialToken:'private'});
  owner.pinConnectionNode('node',user.id,owner.connectionAuthority('node',user.id)!,'node_'+randomUUID());
  const store=owner.createContentDocumentStore(),authority=owner.connectionAuthority('node',user.id)!;
  const migration=await store.migrateNativeRequestAsync(user.id,resourceId,1,randomUUID(),owner.cardFileProjection),head=migration.result;
  const binding=await store.bindAsync(user.id,resourceId,randomUUID(),JSON.stringify(['node',authority]),{
    target:{connectionId:'node',sessionId:encodeHubSessionId('node','codex:fixture'),sessionKey:'codex:fixture',authority},epoch:head.epoch,revision:head.revision});
  let checks=0;
  const manifest=executeContentOverview(owner,user.id,resourceId,{action:'overview'},()=>{checks++;});assert.equal(manifest.action,'overview');
  assert.equal(checks,2);
  if(manifest.action!=='overview')throw Error('Wrong action');
  assert.equal(validContentOverviewManifest(manifest.manifest),true);
  await store.writeAsync(user.id,resourceId,{mutationId:randomUUID(),modeEpoch:head.epoch,baseRevision:head.revision,baseHash:head.hash,content:content('Later')});
  const original=executeContentOverview(owner,user.id,resourceId,{action:'overview-snapshot',source:'head',snapshot:manifest.manifest.head!},()=>{});
  assert.deepEqual(original,{action:'overview-snapshot',snapshot:head});
  store.revoke(user.id,resourceId,binding.id);
  const fromBinding={action:'overview-snapshot' as const,source:'binding' as const,id:binding.id,generation:binding.generation,snapshot:contentSnapshotRef(head)};
  assert.deepEqual(executeContentOverview(owner,user.id,resourceId,fromBinding,()=>{}),original);
  assert.throws(()=>executeContentOverview(owner,user.id,resourceId,{...fromBinding,generation:randomUUID()},()=>{}),/overview-snapshot/);
  assert.throws(()=>executeContentOverview(owner,'foreign',resourceId,fromBinding,()=>{}),/overview-snapshot/);
  assert.throws(()=>executeContentOverview(owner,user.id,resourceId,{action:'overview-snapshot',source:'head',snapshot:{...contentSnapshotRef(head),epoch:randomUUID()}},()=>{}),/overview-snapshot/);
  assert.throws(()=>executeContentOverview(owner,user.id,resourceId,{action:'overview'},()=>{throw Error('revoked');}),/revoked/);
});
