import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import type { DatabaseSync } from 'node:sqlite';
import { HubStore } from './hub-store.js';
import { encodeHubSessionId } from './session-id.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { executeHubMemberCommand, hubMemberCommandBytes, hubMemberResultBytes, validHubMemberInput } from './member-owner-domain.js';
import { executeHubGuidanceCommand, hubGuidanceReplyExpectation, validHubGuidanceCommand,
  validHubGuidanceReply, validHubGuidanceResult, type HubGuidanceCommand } from './member-guidance-domain.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { connectionRecoverySnapshot } from '../storage/connection-recovery.js';

function seed(store: HubStore) {
  const db = (store as unknown as {db:DatabaseSync}).db, user = store.createUser('Owner');
  store.upsertConnection({id:'environment',ownerUserId:user.id,kind:'remote',label:'Environment',connectorUrl:'http://fixture.invalid'});
  store.pinConnectionNode('environment',user.id,store.connectionAuthority('environment',user.id)!,'node_'+randomUUID());
  const nodeVersion = store.connectionAuthority('environment',user.id)!, nodeId = store.getConnection('environment',user.id)!.nodeId;
  const sessionId = encodeHubSessionId('environment','codex:'+randomUUID()), target = JSON.stringify([sessionId,nodeId,nodeVersion]);
  const key = store.identities.issueKey(user.id), token = store.identities.createSession(key.token)!;
  const request = new Request('http://fixture.invalid/',{headers:{cookie:'agentopsdeck_session='+token}});
  const principal = store.identities.requestPrincipal(request,()=>false)!;
  const proof = {evidence:{sessionToken:token},expectedScope:store.identities.recoveryScope(principal)!};
  const call = (command: HubGuidanceCommand) => executeHubMemberCommand(store,'sessionGuidance',{...proof,command});
  const base = {sessionId,nodeVersion}, id = randomUUID();
  const save:HubGuidanceCommand = {...base,action:'save',revision:0,text:'private guidance 中文',enabled:true};
  const prepare:HubGuidanceCommand = {...base,action:'prepare',requestId:id,revision:1,input:'private input'};
  const ready = () => {assert.equal(call(save)?.status,200);const result=call(prepare);assert.equal(result?.status,201);return result!.receipt!;};
  const effects = () => ['hub_session_owners','command_receipts','hub_execution_leases'].map(t=>db.prepare('SELECT * FROM '+t+' ORDER BY rowid').all());
  return {store,db,user,key,token,request,principal,proof,call,base,id,target,save,prepare,ready,effects};
}
async function fixture(work: (f:ReturnType<typeof seed>)=>unknown) {
  const root=mkdtempSync(join(tmpdir(),'hub-guidance-domain-')),store=new HubStore(join(root,'hub.sqlite'),'fixture');
  try {await work(seed(store));} finally {await store.close();rmSync(root,{recursive:true,force:true});}
}
test('guidance domain preserves inspect/save/prepare/once-only claim and exact ACK',()=>fixture(f=>{
  const before=f.effects();
  const auth=f.call({action:'authorize',sessionId:f.base.sessionId});assert.equal(auth?.nodeVersion,f.base.nodeVersion);
  assert.equal(f.call({action:'inspect',sessionId:f.base.sessionId})?.config,null);
  const prepared=f.ready();assert.equal(prepared.state,'prepared');
  const prepareAgain=f.call(f.prepare);assert.deepEqual(prepareAgain?.receipt,prepared);
  const claim:HubGuidanceCommand={...f.base,action:'claim',requestId:f.id};
  const first=f.call(claim);assert.equal(first?.claimed,true);assert.equal(first.receipt?.state,'unknown');
  assert.equal(f.db.isTransaction,false);assert.equal(f.call(claim)?.claimed,false);
  const ack:HubGuidanceCommand={...f.base,action:'reconcile',requestId:f.id,ack:{key:prepared.commandKey!,id:randomUUID(),state:'accepted'}};
  const settled=f.call(ack);assert.equal(settled?.receipt?.state,'submitted');assert.equal(settled.receipt.commandKey,prepared.commandKey);
  assert.ok(validHubGuidanceReply(hubGuidanceReplyExpectation(ack),settled));assert.deepEqual(f.call(ack)?.receipt,settled.receipt);
  assert.equal(f.call(claim)?.claimed,false);assert.deepEqual(f.effects(),before);
}));
test('guidance cancellation receipt remains durable and never dispatches',()=>fixture(f=>{
  f.ready();const command:HubGuidanceCommand={...f.base,action:'cancel',requestId:f.id};
  assert.equal(f.call(command)?.cancelled,true);assert.equal(f.call(command)?.cancelled,true);
  const receipt=f.call({action:'receipt',sessionId:f.base.sessionId,requestId:f.id});assert.equal(receipt?.cancelled,true);assert.equal(receipt.receipt,null);
  assert.equal(f.call(f.prepare)?.status,409);assert.equal(f.call({...f.base,action:'claim',requestId:f.id})?.claimed,false);
}));
test('guidance rejected ACK settles only an UNKNOWN original receipt',()=>fixture(f=>{
  const original=f.ready(), command:HubGuidanceCommand={...f.base,action:'reconcile',requestId:f.id,ack:{key:original.commandKey!,id:randomUUID(),state:'rejected'}};
  assert.equal(f.call(command)?.status,409);
  assert.equal(f.call({...f.base,action:'claim',requestId:f.id})?.claimed,true);
  const result=f.call(command);assert.equal(result?.receipt?.state,'rejected');assert.equal(result.receipt.queueReceipt,null);
  assert.ok(validHubGuidanceReply(hubGuidanceReplyExpectation(command),result));assert.equal(f.call({...f.base,action:'cancel',requestId:f.id})?.status,409);
}));
for (const change of ['credential','scope','nodeVersion','disabled','nodeId','missing','unsupported'] as const)
  test('guidance stale '+change+' cannot mutate existing config',()=>fixture(f=>{
    f.ready();const original=f.store.sessionGuidance.config(f.user.id,f.target);
    let command:HubGuidanceCommand={...f.save,revision:1,text:'new private text'};
    if(change==='credential')f.store.identities.revokeSession(f.token);
    if(change==='nodeVersion')command={...command,nodeVersion:f.base.nodeVersion+1};
    if(change==='disabled')f.db.prepare("UPDATE env_connections SET status='disabled' WHERE id='environment'").run();
    if(change==='nodeId')f.db.prepare("UPDATE env_connections SET node_id=?,authority_version=authority_version+1 WHERE id='environment'").run('node_'+randomUUID());
    if(change==='missing')command={...command,sessionId:encodeHubSessionId('missing','codex:'+randomUUID())};
    if(change==='unsupported')command={...command,sessionId:encodeHubSessionId('environment','openclaw:'+randomUUID())};
    const result=change==='scope'?executeHubMemberCommand(f.store,'sessionGuidance',{...f.proof,expectedScope:'0'.repeat(64),command}):f.call(command);
    if(change==='credential'||change==='scope')assert.equal(result,null);else assert.ok(result&&result.status>=400);
    assert.deepEqual(f.store.sessionGuidance.config(f.user.id,f.target),original);
  }));
for(const action of ['save','prepare','cancel','claim','reconcile'] as const)
  test('guidance '+action+' rechecks authority before root COMMIT and rolls back revoked credentials',()=>fixture(f=>{
    const receipt=f.ready();if(action==='reconcile')f.call({...f.base,action:'claim',requestId:f.id});
    const before=f.db.prepare('SELECT * FROM session_guidance').all(), receipts=f.db.prepare('SELECT * FROM guidance_submissions').all();
    const commands:Record<typeof action,HubGuidanceCommand>={
      save:{...f.save,revision:1,text:'changed'},prepare:{...f.prepare,requestId:randomUUID()},
      cancel:{...f.base,action:'cancel',requestId:f.id},claim:{...f.base,action:'claim',requestId:f.id},
      reconcile:{...f.base,action:'reconcile',requestId:f.id,ack:{key:receipt.commandKey!,id:randomUUID(),state:'accepted'}}};
    const original=f.store.identities.requestPrincipal.bind(f.store.identities);let calls=0;
    f.store.identities.requestPrincipal=(...args)=>{
      if(++calls===4)f.db.prepare('DELETE FROM hub_login_sessions WHERE secret_hash IS NOT NULL').run();
      return original(...args);
    };
    try {assert.equal(f.call(commands[action]),null);assert.ok(calls>=4);assert.equal(f.db.isTransaction,false);
      assert.deepEqual(f.db.prepare('SELECT * FROM session_guidance').all(),before);
      assert.deepEqual(f.db.prepare('SELECT * FROM guidance_submissions').all(),receipts);
      // Revocation occurred within the same original transaction and rolled back too.
      assert.ok(original(f.request,()=>false));
    }finally{f.store.identities.requestPrincipal=original;}
  }));
test('already UNKNOWN claim still rechecks authority and cannot issue a second send permit',()=>fixture(f=>{
  f.ready();const command:HubGuidanceCommand={...f.base,action:'claim',requestId:f.id};f.call(command);
  f.store.identities.revokeSession(f.token);assert.equal(f.call(command),null);
  assert.equal(f.store.sessionGuidance.receipt(f.user.id,f.target,f.id)?.state,'unknown');
}));
test('wrong original ACK key is a conflict, leaves UNKNOWN and never changes execution state',()=>fixture(f=>{
  const original=f.ready();f.call({...f.base,action:'claim',requestId:f.id});const before=f.effects();
  assert.equal(f.call({...f.base,action:'reconcile',requestId:f.id,ack:{key:'wrong-original-key',id:randomUUID(),state:'accepted'}})?.status,409);
  assert.equal(f.store.sessionGuidance.receipt(f.user.id,f.target,f.id)?.commandKey,original.commandKey);
  assert.equal(f.store.sessionGuidance.receipt(f.user.id,f.target,f.id)?.state,'unknown');assert.deepEqual(f.effects(),before);
}));
test('guidance root transaction refuses outer savepoint and leaves it to its original caller',()=>fixture(f=>{
  f.db.exec('BEGIN');try{assert.throws(()=>f.call(f.save),/outer-transaction/);assert.equal(f.db.isTransaction,true);}finally{f.db.exec('ROLLBACK');}
  assert.equal(f.store.sessionGuidance.config(f.user.id,f.target),undefined);
}));
for(const phase of ['beforeCommit','afterCommit'] as const)
  test('guidance '+phase+' SQL settlement is UNKNOWN without retry',()=>fixture(f=>{
    f.ready();const original=f.db.exec.bind(f.db);let commits=0;
    f.db.exec=sql=>{if(sql==='COMMIT'){commits++;if(phase==='afterCommit')original(sql);throw Error('private SQL COMMIT failure');}return original(sql);};
    try {assert.throws(()=>f.call({...f.base,action:'claim',requestId:f.id}),/private SQL COMMIT failure/);assert.equal(commits,1);assert.equal(f.db.isTransaction,false);
      assert.equal(f.store.sessionGuidance.receipt(f.user.id,f.target,f.id)?.state,phase==='beforeCommit'?'prepared':'unknown');
    }finally{f.db.exec=original;}
  }));
test('guidance rollback failure remains fenced, original cleanup alone restores access',()=>fixture(f=>{
  f.ready();const original=f.db.exec.bind(f.db);let commits=0;
  f.db.exec=sql=>{if(sql==='COMMIT'){commits++;throw Error('commit failure');}if(sql==='ROLLBACK')throw Error('rollback failure');return original(sql);};
  try {assert.throws(()=>f.call({...f.base,action:'claim',requestId:f.id}));assert.equal(connectionRecoverySnapshot(f.db).state,'owner-rollback-required');
    assert.throws(()=>f.call({...f.base,action:'claim',requestId:f.id}));assert.equal(commits,1);
  }finally{f.db.exec=original;}
  f.db.exec('ROLLBACK');assert.equal(f.call({action:'authorize',sessionId:f.base.sessionId})?.status,200);
  assert.equal(connectionRecoverySnapshot(f.db).state,'ready');assert.equal(f.store.sessionGuidance.receipt(f.user.id,f.target,f.id)?.state,'prepared');
}));
test('legacy receipt remains readable, but no command key is synthesized to dispatch it',()=>fixture(f=>{
  const receipt=f.ready();delete receipt.commandKey;delete receipt.createdAt;delete receipt.expiresAt;
  f.db.prepare('UPDATE guidance_submissions SET payload=? WHERE owner=? AND request_id=?').run(JSON.stringify(receipt),f.user.id,f.id);
  const command:HubGuidanceCommand={action:'receipt',sessionId:f.base.sessionId,requestId:f.id};
  const result=f.call(command);assert.ok(validHubGuidanceReply(hubGuidanceReplyExpectation(command),result));assert.deepEqual(result?.receipt,receipt);
  assert.equal(f.call({...f.base,action:'claim',requestId:f.id})?.status,409);
}));
test('expired original preview is refused without erasing it or creating new key',()=>fixture(f=>{
  const receipt=f.ready();receipt.createdAt=1;receipt.expiresAt=300001;
  f.db.prepare('UPDATE guidance_submissions SET payload=? WHERE owner=? AND request_id=?').run(JSON.stringify(receipt),f.user.id,f.id);
  assert.equal(f.call({...f.base,action:'claim',requestId:f.id})?.status,409);
  assert.deepEqual(f.store.sessionGuidance.receipt(f.user.id,f.target,f.id),receipt);
}));
for (const change of ['owner','target','sql','callback','authorized','extra','badAck','badRevision','nul'] as const)
  test('typed guidance rejects '+change+' before dispatch',()=>fixture(f=>{
    const command:Record<string,unknown>={...f.save};
    if(change==='badRevision')command.revision=-1;else if(change==='nul')command.text='bad\0text';
    else if(change==='badAck')Object.assign(command,{action:'reconcile',requestId:f.id,ack:{key:'key',id:'id',state:'submitted'}});
    else command[change]=change==='callback'?()=>true:change==='authorized'?true:'private caller content';
    assert.equal(validHubGuidanceCommand(command),false);assert.equal(validHubMemberInput('sessionGuidance',{...f.proof,command}),false);
    assert.throws(()=>executeHubMemberCommand(f.store,'sessionGuidance',{...f.proof,command} as never));
    assert.equal(f.store.sessionGuidance.config(f.user.id,f.target),undefined);
  }));
test('guidance ACK rejects mismatched request, body, action and malformed state',()=>fixture(f=>{
  const receipt=f.ready(), expected=hubGuidanceReplyExpectation(f.prepare), result=f.call(f.prepare)!;
  assert.ok(validHubGuidanceReply(expected,result));
  for(const mutation of [{digest:'0'.repeat(64)},{action:'receipt'},{receipt:{...receipt,requestId:randomUUID()}},
    {receipt:{...receipt,inputHash:'0'.repeat(64)}},{receipt:{...receipt,state:'submitted',queueReceipt:null}},
    {receipt:{...receipt,extra:'private'}},{receipt:{...receipt,expiresAt:receipt.createdAt}}])
    assert.equal(validHubGuidanceReply(expected,{...result,...mutation}),false);
  assert.equal(validHubGuidanceResult({...result,config:{revision:1,text:'false hash',hash:'0'.repeat(64),enabled:true}}),false);
}));
test('waiter expectation retains hashes rather than guidance, input or credential text',()=>fixture(f=>{
  const save=JSON.stringify(hubGuidanceReplyExpectation(f.save)),prepare=JSON.stringify(hubGuidanceReplyExpectation(f.prepare));
  for(const secret of ['private guidance','private input',f.token,f.key.token]){assert.equal(save.includes(secret),false);assert.equal(prepare.includes(secret),false);}
}));
test('guidance fixed action logs are redacted and sink failure cannot change persisted UNKNOWN',()=>fixture(f=>{
  const rows:string[]=[],diag=new PerformanceDiagnostics(row=>rows.push(row));
  const original=f.ready(), command:HubGuidanceCommand={...f.base,action:'claim',requestId:f.id};
  const result=executeHubGuidanceCommand(f.db,f.store,f.principal,()=>f.principal,command,diag);assert.equal(result?.claimed,true);
  assert.ok(rows.some(row=>row.includes('"step":17')));
  for(const secret of ['private guidance','private input',f.user.id,f.id,original.commandKey!,f.token,f.key.token])assert.equal(rows.join('').includes(secret),false);
  const throwing=new PerformanceDiagnostics(()=>{throw Error('private sink');});
  const again=executeHubGuidanceCommand(f.db,f.store,f.principal,()=>f.principal,command,throwing);assert.equal(again?.claimed,false);
  assert.equal(again.receipt?.state,'unknown');
}));
class FakeWorker extends EventEmitter {
  messages:{id:number;kind:string;body:string}[]=[];stops=0;
  postMessage(m:{id:number;kind:string;body:string}){this.messages.push(m);}
  terminate(){this.stops++;return Promise.resolve(1);}
}
test('mis-correlated guidance ACK preserves physical-exit fence and never spawns replacement writer',()=>fixture(async f=>{
  const root=mkdtempSync(join(tmpdir(),'hub-guidance-ack-')),file=join(root,'hub.sqlite'),worker=new FakeWorker(),launch=()=>worker as unknown as Worker;
  const owner=new AsyncHubMemberOwner({file},new PerformanceDiagnostics(()=>{}),launch),tick=()=>new Promise<void>(r=>setImmediate(r));
  try{
    const work=owner.command('sessionGuidance',{...f.proof,command:f.save});void work.catch(()=>{});
    worker.emit('message',{kind:'ready'});await tick();const m=worker.messages[0]!;
    const result=f.call(f.save)!;worker.emit('message',{id:m.id,kind:m.kind,ok:true,body:JSON.stringify({...result,digest:'0'.repeat(64)})});
    await assert.rejects(work);assert.equal(worker.messages.length,1);assert.equal(worker.stops,0);
    assert.throws(()=>new AsyncHubMemberOwner({file},undefined,launch));
    const closing=owner.close();void closing.catch(()=>{});await tick();assert.equal(worker.stops,1);
    assert.throws(()=>new AsyncHubMemberOwner({file},undefined,launch));worker.emit('exit',1);await assert.rejects(closing);
  }finally{worker.emit('exit',1);rmSync(root,{recursive:true,force:true});}
}));
test('real guidance worker accepts maximum Chinese input and recovers UNKNOWN after owner reopens',async()=>{
  const root=mkdtempSync(join(tmpdir(),'hub-guidance-worker-')),file=join(root,'hub.sqlite'),store=new HubStore(file,'fixture'),f=seed(store),before=f.effects();
  await store.close();let owner=new AsyncHubMemberOwner({file,encryptionSecret:'fixture'},new PerformanceDiagnostics(()=>{}));
  try {
    const save:HubGuidanceCommand={...f.save,text:'中'.repeat(8000)},prepare:HubGuidanceCommand={...f.prepare,input:'文'.repeat(8000)};
    assert.ok(Buffer.byteLength(JSON.stringify({...f.proof,command:save}))>16384);
    assert.ok(hubMemberCommandBytes('sessionGuidance')>16384);assert.ok(hubMemberResultBytes('sessionGuidance')>48000);
    assert.equal((await owner.command('sessionGuidance',{...f.proof,command:save}))?.status,200);
    const preview=await owner.command('sessionGuidance',{...f.proof,command:prepare});assert.equal(preview?.receipt?.text.length,16002);
    const claim:HubGuidanceCommand={...f.base,action:'claim',requestId:f.id};assert.equal((await owner.command('sessionGuidance',{...f.proof,command:claim}))?.claimed,true);
    await owner.close();owner=new AsyncHubMemberOwner({file,encryptionSecret:'fixture'},new PerformanceDiagnostics(()=>{}));
    const recovered=await owner.command('sessionGuidance',{...f.proof,command:{action:'receipt',sessionId:f.base.sessionId,requestId:f.id}});
    assert.equal(recovered?.receipt?.state,'unknown');assert.equal(recovered.receipt.commandKey,preview!.receipt!.commandKey);
    assert.equal((await owner.command('sessionGuidance',{...f.proof,command:claim}))?.claimed,false);await owner.close();
    const reopened=new HubStore(file,'fixture');try{
      assert.ok(reopened.identities.requestPrincipal(f.request,()=>false));
      const db=(reopened as unknown as {db:DatabaseSync}).db;
      assert.deepEqual(['hub_session_owners','command_receipts','hub_execution_leases'].map(t=>db.prepare('SELECT * FROM '+t+' ORDER BY rowid').all()),before);
    }finally{await reopened.close();}
  }finally{await owner.close();rmSync(root,{recursive:true,force:true});}
});
