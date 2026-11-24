import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {HubStore} from './hub-store.js';
import {OriginalHubAdministrativeCommands} from './original-administrative-commands.js';
import {AsyncHubContentDocuments} from './async-content-documents.js';
import type {AsyncHubMemberOwner} from './async-member-owner.js';
import {HubMemberRequestError} from './async-member-request.js';
import {AuthPersistenceError} from '../auth/private-store.js';
import {hubMemberCommandBytes,hubMemberResultBytes,hubMemberResultBudget,validHubMemberInput} from './member-owner-domain.js';
import {validHubContentDocumentReply,validHubContentDocumentResult,type HubContentDocumentCommand} from './member-content-document-domain.js';
import {encodeHubSessionId} from './session-id.js';
import {Hono} from 'hono';
import {registerAsyncHubContentDocuments} from '../routes/hub-async-workspace-content-documents.js';

const resourceId=JSON.stringify(['taskboard','default']);
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};
const content=(title:string)=>JSON.stringify({kind:'taskboard',content:{title,tasks:[]}});

test('content fixed domain rejects authority/SQL/extra fields, correlates replies and reserves by action',()=>{
  const command:HubContentDocumentCommand={action:'migrate',resourceId,revision:0,requestId:randomUUID()};
  const proof={evidence:{accessKey:'test'},expectedScope:'a'.repeat(64),command};
  assert.equal(validHubMemberInput('contentDocument',proof),true);
  for(const extra of [{owner:'foreign'},{sql:'SELECT 1'},{authorized:true}]){
    assert.equal(validHubMemberInput('contentDocument',{...proof,...extra}),false);
    assert.equal(validHubMemberInput('contentDocument',{...proof,command:{...command,...extra}}),false);
  }
  const value=content('Original'),result={action:'migrate',resourceId,termination:null,receipt:{mutationId:command.requestId,
    resource:resourceId,nativeRevision:0,result:{epoch:randomUUID(),revision:0,content:value,hash:createHash('sha256').update(value).digest('hex')}}};
  assert.equal(validHubContentDocumentReply(command,result),true);
  assert.equal(validHubContentDocumentReply({...command,requestId:randomUUID()},result),false);
  assert.equal(validHubContentDocumentReply({...command,revision:1},result),false);
  assert.equal(validHubContentDocumentResult({...result,receipt:{...result.receipt,result:{...result.receipt.result,hash:'0'.repeat(64)}}}),false);
  assert.equal(hubMemberResultBytes('contentDocument',proof),16*1024*1024);
  assert.equal(hubMemberResultBytes('contentDocument',{...proof,command:{action:'overview',resourceId}}),2*1024*1024+128*1024);
  assert.equal(hubMemberResultBytes('contentDocument',{...proof,command:{action:'overview-snapshot',resourceId,source:'head',snapshot:{epoch:randomUUID(),revision:0,hash:'a'.repeat(64),bytes:128}}}),128+Buffer.byteLength(JSON.stringify({action:'overview-snapshot',resourceId,snapshot:null})));
  assert.equal(hubMemberResultBytes('contentDocument',{...proof,command:{action:'check',resourceId}}),32*1024);
  assert.equal(hubMemberResultBudget('contentDocument'),32*1024*1024);
  assert.ok(hubMemberCommandBytes('contentDocument')>4*1024*1024);
});

for(const lost of [false,true])test(`original content ACK survives abort and close without replay, lost=${lost}`,{timeout:15_000},async t=>{
  const store=new HubStore(':memory:','fixture'),user=store.createUser('Member'),key=store.identities.issueKey(user.id);
  const original=new OriginalHubAdministrativeCommands(store),entered=deferred(),release=deferred();let calls=0;
  const port:Pick<AsyncHubMemberOwner,'command'>={command(kind,input){
    return original.command(kind,input).then(async value=>{if(kind==='contentDocument'){
      calls++;entered.resolve();await release.promise;if(lost)throw Error('PRIVATE_ACK_ERROR');
    }return value;});
  }};
  const access=new AsyncHubContentDocuments(port);t.after(async()=>{release.resolve();await access.close();await original.close();await store.close();});
  const abort=new AbortController(),headers=new Headers({'x-agentopsdeck-key':key.token});
  const scope=await access.begin(new Request('http://hub.invalid',{headers,signal:abort.signal})),requestId=randomUUID();
  const flight=scope.command({action:'migrate',resourceId,revision:0,requestId});
  const rejected=assert.rejects(flight,(e:unknown)=>lost?e instanceof AuthPersistenceError:e instanceof HubMemberRequestError&&e.status===499);
  await entered.promise;headers.set('x-agentopsdeck-key','different');abort.abort();let closed=false;
  const closing=access.close().then(()=>{closed=true;});await new Promise<void>(r=>setImmediate(r));assert.equal(closed,false);
  release.resolve();await rejected;await closing;assert.equal(calls,1);
  assert.equal(store.createContentDocumentStore().migration(user.id,requestId)?.mutationId,requestId);
});

test('private content proof is frozen and current revocation rejects late ACK delivery',{timeout:15_000},async t=>{
  const store=new HubStore(':memory:','fixture'),user=store.createUser('Member'),key=store.identities.issueKey(user.id);
  const original=new OriginalHubAdministrativeCommands(store),entered=deferred(),release=deferred();
  const port:Pick<AsyncHubMemberOwner,'command'>={command(kind,input){return original.command(kind,input).then(async value=>{
    if(kind==='contentDocument'){entered.resolve();await release.promise;}return value;
  });}};
  const access=new AsyncHubContentDocuments(port);t.after(async()=>{release.resolve();await access.close();await original.close();await store.close();});
  const scope=await access.begin(new Request('http://hub.invalid',{headers:{'x-agentopsdeck-key':key.token}}));
  const command:HubContentDocumentCommand={action:'migrate',resourceId,revision:0,requestId:randomUUID()},id=command.requestId;
  const flight=scope.command(command),rejected=assert.rejects(flight,(e:unknown)=>e instanceof HubMemberRequestError&&e.status===403);
  await entered.promise;command.requestId=randomUUID();store.identities.revokeKey(user.id,key.id);release.resolve();await rejected;
  assert.ok(store.createContentDocumentStore().migration(user.id,id));
});

test('HTTP shutdown freezes admission, drains original ACK and suppresses late response',{timeout:15_000},async t=>{
  const store=new HubStore(':memory:','fixture'),user=store.createUser('Member'),key=store.identities.issueKey(user.id);
  const original=new OriginalHubAdministrativeCommands(store),entered=deferred(),release=deferred();let commands=0;
  const port:Pick<AsyncHubMemberOwner,'command'>={command(kind,input){return original.command(kind,input).then(async value=>{
    if(kind==='contentDocument'){commands++;entered.resolve();await release.promise;}return value;
  });}};
  const app=new Hono(),routes=registerAsyncHubContentDocuments(app,{access:new AsyncHubContentDocuments(port),enabled:()=>true});
  t.after(async()=>{release.resolve();await routes.close();await original.close();await store.close();});
  const url='http://hub.invalid/api/hub/v1/workspace/shared-content/'+encodeURIComponent(resourceId)+'/migrate';
  const requestId=randomUUID(),request=()=>new Request(url,{method:'POST',headers:{'x-agentopsdeck-key':key.token},body:JSON.stringify({revision:0,requestId})});
  const flight=app.fetch(request());await entered.promise;let closed=false;
  const closing=routes.close().then(()=>{closed=true;});await new Promise<void>(r=>setImmediate(r));assert.equal(closed,false);
  assert.equal((await app.fetch(request())).status,503);release.resolve();assert.equal((await flight).status,503);await closing;
  assert.equal(commands,1);assert.ok(store.createContentDocumentStore().migration(user.id,requestId));
});

test('document original store keeps authorized projection intents and excludes revoked/stale targets',async t=>{
  const owner=new HubStore(':memory:','fixture'),user=owner.createUser('Member');t.after(()=>owner.close());
  owner.upsertConnection({id:'node',label:'Node',ownerUserId:user.id,connectorUrl:'http://fixture.invalid',credentialToken:'private'});
  owner.pinConnectionNode('node',user.id,owner.connectionAuthority('node',user.id)!,'node_'+randomUUID());
  const authority=owner.connectionAuthority('node',user.id)!,store=owner.createContentDocumentStore();
  const head=await store.migrateNativeRequestAsync(user.id,resourceId,0,randomUUID(),owner.cardFileProjection);
  const target={connectionId:'node',sessionId:encodeHubSessionId('node','codex:fixture'),sessionKey:'codex:fixture',authority};
  const live=store.bind(user.id,resourceId,randomUUID(),JSON.stringify(['node',authority]),{target,epoch:head.result.epoch,revision:0});
  const revoked=store.bind(user.id,resourceId,randomUUID(),JSON.stringify(['node',authority]),{target,epoch:head.result.epoch,revision:0});
  store.revoke(user.id,resourceId,revoked.id);
  assert.throws(()=>store.bind(user.id,resourceId,randomUUID(),JSON.stringify(['node',authority+1]),{
    target:{...target,authority:authority+1},epoch:head.result.epoch,revision:0}),/forbidden/);
  await store.writeAsync(user.id,resourceId,{mutationId:randomUUID(),modeEpoch:head.result.epoch,baseRevision:0,baseHash:head.result.hash,content:content('Project me')});
  assert.equal(store.projections(user.id,resourceId,live.id,live.generation).length,1);
  // Revoked capabilities must not enumerate even an empty job list. Inspect
  // this isolated fixture's durable outbox separately to prove no job queued.
  assert.throws(()=>store.projections(user.id,resourceId,revoked.id,revoked.generation),/forbidden/);
  const db=(owner as unknown as {db:DatabaseSync}).db;
  const jobs=db.prepare('SELECT payload FROM v2_projection_outbox WHERE owner=? AND resource=?').all(user.id,resourceId);
  assert.deepEqual(jobs.map(row=>(JSON.parse(String(row.payload)) as {bindingId:string}).bindingId),[live.id]);
});
