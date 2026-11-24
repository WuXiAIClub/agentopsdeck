import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { HubStore } from './hub-store.js';
import { LEGACY_HUB_PRINCIPAL } from './identity.js';
import { encodeHubSessionId } from './session-id.js';
import { executeHubMemberCommand } from './member-owner-domain.js';
import { validHubOwnedSessionSharingCommand, validHubOwnedSessionSharingReply, validHubOwnedSessionSharingResult,
  type HubOwnedSessionSharingCommand } from './member-owned-session-sharing-domain.js';
import { connectionRecoverySnapshot } from '../storage/connection-recovery.js';

function seed(store: HubStore) {
  const db = (store as unknown as { db: DatabaseSync }).db;
  const owner=store.createUser('Owner'), recipient=store.createUser('Recipient'), stranger=store.createUser('Stranger');
  store.upsertConnection({ id:'node', ownerUserId:owner.id, kind:'remote', label:'Environment', connectorUrl:'http://private.invalid' });
  store.pinConnectionNode('node',owner.id,store.connectionAuthority('node',owner.id)!,'node_'+randomUUID());
  const target = (userId: string) => ({ ownerUserId:owner.id,connectionId:'node',userId });
  const nodeVersion=store.connectionAuthority('node',owner.id)!;
  const member=target(recipient.id);
  store.roles.save(LEGACY_HUB_PRINCIPAL,member,{ ...store.roles.membership(member),role:'developer',migrateLegacy:true,
    nodeVersion,environments:{ codex:'developer',openclaw:'disabled' } });
  const sessionKey='codex:'+randomUUID(), sessionId=encodeHubSessionId('node',sessionKey);
  const key=store.identities.issueKey(owner.id),token=store.identities.createSession(key.token)!;
  const request=new Request('http://fixture.invalid/',{ headers:{ cookie:'agentopsdeck_session='+token } });
  const actor=store.identities.requestPrincipal(request,()=>false)!;
  const proof={ evidence:{sessionToken:token},expectedScope:store.identities.recoveryScope(actor)! };
  const base={ userId:owner.id,sessionId,nodeVersion };
  const command: HubOwnedSessionSharingCommand={ ...base,action:'create',recipientId:recipient.id,role:'collaborator',options:{media:true} };
  const call=(command: HubOwnedSessionSharingCommand)=>executeHubMemberCommand(store,'ownedSessionSharing',{ ...proof,command });
  const effects=()=>['node_grants','node_grant_dependencies','hub_session_owners','command_receipts','hub_execution_leases']
    .map(table=>db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all());
  return {db,store,owner,recipient,stranger,target,nodeVersion,sessionKey,sessionId,key,token,proof,base,command,call,effects};
}
async function fixture(work: (f:ReturnType<typeof seed>)=>unknown) {
  const root=mkdtempSync(join(tmpdir(),'hub-owned-sharing-domain-')),store=new HubStore(join(root,'hub.sqlite'),'fixture');
  try { await work(seed(store)); } finally { await store.close(); rmSync(root,{recursive:true,force:true}); }
}
test('owned sharing fixed domain preserves direct grants, list and original create/update/delete',()=>fixture(f=>{
  const before=f.effects().slice(2);
  const authorization=f.call({action:'authorize',userId:f.owner.id,sessionId:f.sessionId});
  assert.equal(authorization?.nodeVersion,f.nodeVersion);
  const created=f.call(f.command);assert.ok(validHubOwnedSessionSharingReply(f.command,created)&&created?.grant);
  assert.equal(created.status,201);assert.equal(created.grant.derived,undefined);
  assert.deepEqual(created.grant,f.store.grants.sessionGrants(f.target(f.owner.id),{runtime:'codex',sessionKey:f.sessionKey})[0]);
  const listed=f.call({action:'list',userId:f.owner.id,sessionId:f.sessionId});
  assert.ok(listed?.page);assert.deepEqual(listed.page.collaborators,[created.grant]);
  assert.ok(listed.page.candidates.some(c=>c.id===f.recipient.id));
  const update:HubOwnedSessionSharingCommand={...f.base,action:'update',id:created.grant.id,version:created.grant.version,
    role:'observer',options:{live:false}};
  const updated=f.call(update);assert.ok(validHubOwnedSessionSharingReply(update,updated)&&updated?.grant);
  assert.equal(updated.grant.version,2);assert.deepEqual(updated.grant.policy.actions,['messages:read','sessions:read']);
  assert.equal(f.call(update)?.conflict,'precondition');
  const remove:HubOwnedSessionSharingCommand={...f.base,action:'delete',id:updated.grant.id,version:updated.grant.version};
  const removed=f.call(remove);assert.ok(validHubOwnedSessionSharingReply(remove,removed));assert.equal(removed?.ok,true);
  assert.equal(f.call(remove)?.conflict,'precondition'); // Old owner route returns 409, unlike creator delete.
  assert.deepEqual(f.effects().slice(2),before);
}));
for(const options of [{},{live:false},{queue:false},{media:true},{live:false,queue:false,media:true}])
  test('owned sharing ACK pins exact policy '+JSON.stringify(options),()=>fixture(f=>{
    const command={...f.command,options},result=f.call(command);assert.ok(validHubOwnedSessionSharingReply(command,result)&&result?.grant);
  }));
test('authorize and check never materialize collaborator or candidate lists',()=>fixture(f=>{
  f.store.grants.sessionGrants=()=>{throw Error('display list forbidden');};
  f.store.roles.sessionCandidates=()=>{throw Error('display list forbidden');};
  assert.equal(f.call({action:'authorize',userId:f.owner.id,sessionId:f.sessionId})?.status,200);
  assert.equal(f.call({...f.base,action:'check'})?.status,200);
}));
for(const change of ['credential','nodeVersion','connection','missingRecipient','selfRecipient','membership','observerQueue'] as const)
  test('owned sharing refuses original '+change+' without grant mutation',()=>fixture(f=>{
    let command:HubOwnedSessionSharingCommand=structuredClone(f.command);
    if(change==='credential')f.store.identities.revokeSession(f.token);
    if(change==='nodeVersion')command={...command,nodeVersion:f.nodeVersion+1};
    if(change==='connection')f.store.deleteConnection('node',f.owner.id);
    if(change==='missingRecipient')command={...command,recipientId:randomUUID()};
    if(change==='selfRecipient')command={...command,recipientId:f.owner.id};
    if(change==='membership')command={...command,recipientId:f.stranger.id};
    if(change==='observerQueue')command={...command,role:'observer',options:{queue:true}};
    const before=f.effects(),result=f.call(command);
    if(change==='credential')assert.equal(result,null);
    else {
      assert.ok(validHubOwnedSessionSharingReply(command,result));
      assert.equal(result?.status,change==='connection'?404:['missingRecipient','selfRecipient'].includes(change)?400:409);
      if(change==='membership')assert.equal(result?.conflict,'membership');
    }
    assert.deepEqual(f.effects(),before);
  }));
test('derived creator grant and managed environment grant cannot be modified by owner session scope',()=>fixture(f=>{
  const creation=f.store.grants.authorize(f.target(f.recipient.id),'sessions:create',{runtime:'codex'})!;
  f.store.grants.acceptCreatedSession(creation,f.sessionKey,randomUUID(),randomUUID(),()=>{});
  const share=f.store.grants.authorize(f.target(f.recipient.id),'sessions:share',{runtime:'codex',sessionKey:f.sessionKey})!;
  const derived=f.store.grants.get(f.target(f.recipient.id),share.grantId)!;
  const before=f.effects();
  const command:HubOwnedSessionSharingCommand={...f.base,action:'delete',id:derived.id,version:derived.version};
  assert.equal(f.call(command)?.conflict,'precondition');assert.deepEqual(f.effects(),before);
}));
test('duplicate create is definite policy refusal, not second grant or replay',()=>fixture(f=>{
  assert.equal(f.call(f.command)?.status,201);const before=f.effects(),result=f.call(f.command);
  assert.equal(result?.conflict,'policy');assert.deepEqual(f.effects(),before);
}));
test('owned mutation rolls back with outer same-connection transaction',()=>fixture(f=>{
  const before=f.effects();f.db.exec('BEGIN');assert.equal(f.call(f.command)?.status,201);f.db.exec('ROLLBACK');assert.deepEqual(f.effects(),before);
}));
for(const phase of ['beforeRelease','afterRelease'] as const)
  test('owned original '+phase+' settlement fault is unknown without replay',()=>fixture(f=>{
    const before=f.effects(),original=f.db.exec.bind(f.db);let releases=0;
    f.db.exec=sql=>{if(sql==='RELEASE hub_identity_check'){releases++;if(phase==='afterRelease')original(sql);throw Error('private RELEASE fault');}return original(sql);};
    try {assert.throws(()=>f.call(f.command));assert.equal(releases,1);assert.equal(f.db.isTransaction,false);
      if(phase==='beforeRelease')assert.deepEqual(f.effects(),before);else assert.notDeepEqual(f.effects(),before);
    }finally{f.db.exec=original;}
  }));
test('owned rollback failure blocks new effects until original cleanup',()=>fixture(f=>{
  const before=f.effects(),original=f.db.exec.bind(f.db);let releases=0,rollbacks=0;
  f.db.exec=sql=>{if(sql==='RELEASE hub_identity_check'){releases++;throw Error('release failed');}
    if(sql==='ROLLBACK'){rollbacks++;throw Error('rollback failed');}return original(sql);};
  try {assert.throws(()=>f.call(f.command));assert.equal(releases,1);assert.equal(connectionRecoverySnapshot(f.db).state,'owner-rollback-required');
    assert.throws(()=>f.call(f.command));assert.equal(releases,1);assert.equal(rollbacks,2);
  }finally{f.db.exec=original;}
  f.db.exec('ROLLBACK'); // Original facade cleans up; never a replacement writer.
  assert.equal(f.call({...f.base,action:'check'})?.status,200);assert.equal(connectionRecoverySnapshot(f.db).state,'ready');
  assert.deepEqual(f.effects(),before);
}));
test('all owned replies including negative and delete ACKs echo exact original command',()=>fixture(f=>{
  const result=f.call(f.command);assert.ok(result?.grant&&validHubOwnedSessionSharingResult(result));
  for(const change of [{recipientId:f.stranger.id},{nodeVersion:f.nodeVersion+1},{sessionId:encodeHubSessionId('node','codex:'+randomUUID())},
    {options:{live:false}},{role:'observer' as const}]) {
    const wrong:unknown={...result,command:{...result.command,...change}};
    assert.equal(validHubOwnedSessionSharingReply(f.command,wrong),false);
    const negative:unknown={...result,command:{...result.command,...change},status:409,nodeVersion:null,page:null,grant:null,ok:null,conflict:'precondition'};
    assert.ok(validHubOwnedSessionSharingResult(negative));assert.equal(validHubOwnedSessionSharingReply(f.command,negative),false);
  }
  const remove:HubOwnedSessionSharingCommand={...f.base,action:'delete',id:result.grant.id,version:result.grant.version};
  const removed=f.call(remove);assert.ok(removed&&validHubOwnedSessionSharingResult(removed));
  const wrong={...removed,command:{...remove,id:randomUUID()}};
  assert.ok(validHubOwnedSessionSharingResult(wrong));assert.equal(validHubOwnedSessionSharingReply(remove,wrong),false);
  const negative=f.call(remove);assert.ok(negative);
  assert.equal(validHubOwnedSessionSharingReply(remove,{...negative,command:{...remove,version:2}}),false);
}));
test('protocol rejects browser authority flags, SQL and unknown option fields',()=>fixture(f=>{
  for(const change of [{administrator:true},{sql:'private SQL'},{options:{live:true,replay:true}},{nodeVersion:0}])
    assert.equal(validHubOwnedSessionSharingCommand({...f.command,...change}),false);
}));
test('owned success permits maximum safe grant version while overflow rolls back',()=>fixture(f=>{
  const created=f.call(f.command);assert.ok(created?.grant);
  f.db.prepare('UPDATE node_grants SET version=? WHERE id=?').run(Number.MAX_SAFE_INTEGER-1,created.grant.id);
  const command:HubOwnedSessionSharingCommand={...f.base,action:'update',id:created.grant.id,version:Number.MAX_SAFE_INTEGER-1,role:'observer',options:{}};
  const updated=f.call(command);assert.ok(updated?.grant&&validHubOwnedSessionSharingReply(command,updated));
  assert.equal(updated.grant.version,Number.MAX_SAFE_INTEGER);
  const before=f.effects();assert.throws(()=>f.call({...command,version:Number.MAX_SAFE_INTEGER}));assert.deepEqual(f.effects(),before);
}));
test('owned list bounds persisted labels before original candidate materialization',()=>fixture(f=>{
  f.db.prepare('UPDATE users SET label=? WHERE id=?').run('x'.repeat(65537),f.recipient.id);
  let displayed=0;f.store.roles.sessionCandidates=()=>{displayed++;return [];};
  assert.throws(()=>f.call({action:'list',userId:f.owner.id,sessionId:f.sessionId}));assert.equal(displayed,0);
  assert.equal(f.call({action:'authorize',userId:f.owner.id,sessionId:f.sessionId})?.status,200);
}));
class FakeWorker extends EventEmitter {
  messages:{id:number;kind:string;body:string}[]=[];stops=0;
  postMessage(m:{id:number;kind:string;body:string}){this.messages.push(m);}
  terminate(){this.stops++;return Promise.resolve(1);}
}
test('owned mis-correlated negative ACK reserves same owner until real exit, never replacement',()=>fixture(async f=>{
  const root=mkdtempSync(join(tmpdir(),'hub-owned-sharing-ack-')),file=join(root,'hub.sqlite'),worker=new FakeWorker();
  const launch=()=>worker as unknown as Worker,owner=new AsyncHubMemberOwner({file},new PerformanceDiagnostics(()=>{}),launch);
  const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
  try {
    const work=owner.command('ownedSessionSharing',{...f.proof,command:f.command});void work.catch(()=>{});
    worker.emit('message',{kind:'ready'});await tick();const m=worker.messages[0]!;
    worker.emit('message',{id:m.id,kind:m.kind,ok:true,body:JSON.stringify({command:{...f.command,recipientId:randomUUID()},
      status:409,nodeVersion:null,page:null,grant:null,ok:null,conflict:'policy'})});
    await assert.rejects(work);assert.equal(worker.messages.length,1);assert.equal(worker.stops,0);
    assert.throws(()=>new AsyncHubMemberOwner({file},undefined,launch));
    const closing=owner.close();void closing.catch(()=>{});await tick();assert.equal(worker.stops,1);
    assert.throws(()=>new AsyncHubMemberOwner({file},undefined,launch));worker.emit('exit',1);await assert.rejects(closing);
  }finally{worker.emit('exit',1);rmSync(root,{recursive:true,force:true});}
}));
test('real owned worker reopens original data and cookies without changing execution state',async()=>{
  const root=mkdtempSync(join(tmpdir(),'hub-owned-sharing-worker-')),file=join(root,'hub.sqlite'),store=new HubStore(file,'fixture'),f=seed(store);
  const before=f.effects().slice(2);await store.close();
  const owner=new AsyncHubMemberOwner({file,encryptionSecret:'fixture'},new PerformanceDiagnostics(()=>{}));
  try {
    const created=await owner.command('ownedSessionSharing',{...f.proof,command:f.command});
    assert.ok(created?.grant&&validHubOwnedSessionSharingReply(f.command,created));await owner.close();
    const reopened=new HubStore(file,'fixture');try {
      const request=new Request('http://fixture.invalid/',{headers:{cookie:'agentopsdeck_session='+f.token}});
      assert.ok(reopened.identities.requestPrincipal(request,()=>false));
      assert.equal(reopened.grants.sessionGrants(f.target(f.owner.id),{runtime:'codex',sessionKey:f.sessionKey})[0]!.id,created.grant.id);
      const db=(reopened as unknown as {db:DatabaseSync}).db;
      assert.deepEqual(['hub_session_owners','command_receipts','hub_execution_leases'].map(t=>db.prepare('SELECT * FROM '+t+' ORDER BY rowid').all()),before);
    }finally{await reopened.close();}
  }finally{await owner.close();rmSync(root,{recursive:true,force:true});}
});
