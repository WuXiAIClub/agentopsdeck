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
import { QuickChatStore } from './quick-chat-store.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { AsyncHubMemberQuickChatState } from './async-member-quick-chat-state.js';
import { executeHubMemberCommand, validHubMemberInput, hubMemberResultBytes } from './member-owner-domain.js';
import { validHubQuickChatStateCommand, validHubQuickChatStateReply, validHubQuickChatStateResult,
  type HubQuickChatStateCommand } from './member-quick-chat-state-domain.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const capability = {ephemeralRequest:true,noPersistentThread:true,originalLookup:true,maxOutput:2000,epoch:'fixed-epoch'};
function seed(store: HubStore) {
  const db = (store as unknown as {db:DatabaseSync}).db, user = store.createUser('Owner');
  const key = store.identities.issueKey(user.id), token = store.identities.createSession(key.token)!;
  const request = new Request('http://fixture.invalid/',{headers:{cookie:'agentopsdeck_session='+token}});
  const principal = store.identities.requestPrincipal(request,()=>false)!;
  const proof = {evidence:{sessionToken:token},expectedScope:store.identities.recoveryScope(principal)!};
  store.quickChat.saveProfile(user.id,0,{id:'profile',name:'Profile',target:'hub-standalone',model:'fixture',outputLimit:2000},capability);
  store.quickChat.admit(user.id,'original','profile',1,'private prompt',capability);
  store.quickChat.claim(user.id,'original','private prompt',capability,()=>true);
  const call = (command:HubQuickChatStateCommand) => executeHubMemberCommand(store,'quickChatState',{...proof,command});
  const rows = () => ['quick_chat_profiles','quick_chat_receipts','quick_chat_results'].map(t=>db.prepare('SELECT * FROM '+t+' ORDER BY rowid').all());
  return {store,db,user,token,request,principal,proof,call,rows};
}
async function fixture(work:(f:ReturnType<typeof seed>)=>unknown) {
  const root = mkdtempSync(join(tmpdir(),'chat-state-owner-')),store = new HubStore(join(root,'hub.sqlite'),'fixture');
  try { await work(seed(store)); } finally { await store.close(); rmSync(root,{recursive:true,force:true}); }
}
test('pure snapshot preserves UNKNOWN and every replay barrier with no SQL effects',()=>fixture(f=>{
  const before = f.rows();
  for(let i=0;i<3;i++) {
    const state=f.call({action:'inspect',requestId:'original'});
    assert.equal(state?.receipt?.state,'unknown');assert.equal(state.output,null);
    const list=f.call({action:'list'});assert.equal(list?.profiles?.length,1);assert.equal(list.receipts?.length,1);
    assert.ok(validHubQuickChatStateReply({action:'list'},list));
    assert.deepEqual(f.rows(),before);assert.equal(f.db.isTransaction,false);
  }
  assert.equal(f.call({action:'inspect',requestId:'missing'})?.receipt,null);
  assert.equal(f.store.quickChat.claim(f.user.id,'original','private prompt',capability,()=>true).claimed,false);
}));
test('read snapshots preserve original profile revisions and encrypted result semantics',()=>fixture(f=>{
  f.store.quickChat.complete(f.user.id,'original','private output 中文');const before=f.rows();
  const state=f.call({action:'inspect',requestId:'original'});assert.equal(state?.output,'private output 中文');
  assert.equal(state.receipt?.state,'completed');assert.deepEqual(f.rows(),before);
  assert.ok(!JSON.stringify(before).includes('private output 中文'));
  f.store.quickChat.clearResult(f.user.id,'original');assert.equal(f.call({action:'inspect',requestId:'original'})?.output,null);
}));
test('pure expired read does not delete ciphertext; legacy read still cleans it',()=>fixture(f=>{
  let now=1000;const store=new QuickChatStore(f.db,()=>now,Buffer.alloc(32,1));
  store.saveProfile('isolated',0,{id:'p',name:'P',target:'fixed',model:'fixed',outputLimit:2000},capability);
  store.admit('isolated','r','p',1,'question',capability);store.claim('isolated','r','question',capability,()=>true);store.complete('isolated','r','answer');
  now+=86400001;const before=f.rows();assert.equal(store.peekResult('isolated','r'),undefined);assert.deepEqual(f.rows(),before);
  assert.equal(store.result('isolated','r'),undefined);assert.equal(f.db.prepare('SELECT count(*) n FROM quick_chat_results').get()!.n,0);
  assert.equal(store.receipt('isolated','r')?.state,'completed');
}));
for(const change of ['credential','scope','other-user'] as const)
  test('snapshot denies '+change+' without exposing the original account',()=>fixture(f=>{
    let proof=f.proof;
    if(change==='credential')f.store.identities.revokeSession(f.token);
    if(change==='scope')proof={...proof,expectedScope:'0'.repeat(64)};
    if(change==='other-user') {
      const other=f.store.createUser('Other'),key=f.store.identities.issueKey(other.id),token=f.store.identities.createSession(key.token)!;
      const principal=f.store.identities.requestPrincipal(new Request('http://fixture.invalid/',{headers:{cookie:'agentopsdeck_session='+token}}),()=>false)!;
      proof={evidence:{sessionToken:token},expectedScope:f.store.identities.recoveryScope(principal)!};
    }
    const before=f.rows(),state=executeHubMemberCommand(f.store,'quickChatState',{...proof,command:{action:'inspect',requestId:'original'}});
    assert.equal(change==='other-user'?state?.receipt:state,null);assert.deepEqual(f.rows(),before);
  }));
test('authority revocation between read and delivery withholds all private output',()=>fixture(f=>{
  f.store.quickChat.complete(f.user.id,'original','private output');const read=f.store.quickChat.peekResult.bind(f.store.quickChat);
  f.store.quickChat.peekResult=(...args)=>{const value=read(...args);f.store.identities.revokeSession(f.token);return value;};
  assert.equal(f.call({action:'inspect',requestId:'original'}),null);assert.equal(f.db.isTransaction,false);
  assert.equal(f.store.quickChat.receipt(f.user.id,'original')?.state,'completed');
}));
for(const bad of [{action:'claim',requestId:'original'}, {action:'inspect',requestId:'original',authorized:true},
  {action:'list',sql:'DELETE FROM quick_chat_receipts'}, {action:'inspect',requestId:'x\n'}, {action:'inspect',requestId:''}])
  test('query protocol refuses unsafe shape '+JSON.stringify(bad),()=>fixture(f=>{
    assert.equal(validHubQuickChatStateCommand(bad),false);
    assert.equal(validHubMemberInput('quickChatState',{...f.proof,command:bad}),false);
    assert.throws(()=>executeHubMemberCommand(f.store,'quickChatState',{...f.proof,command:bad} as never));
  }));
test('reply binds the original request/action and rejects output for UNKNOWN',()=>fixture(f=>{
  const command={action:'inspect',requestId:'original'} as const,state=f.call(command)!;
  assert.ok(validHubQuickChatStateReply(command,state));
  assert.equal(validHubQuickChatStateReply({action:'inspect',requestId:'other'},state),false);
  assert.equal(validHubQuickChatStateReply({action:'list'},state),false);
  assert.equal(validHubQuickChatStateResult({...state,output:'invented output'}),false);
  assert.equal(validHubQuickChatStateResult({...state,receipt:{...state.receipt,requestId:'other'}}),true);
  assert.equal(validHubQuickChatStateReply(command,{...state,receipt:{...state.receipt,requestId:'other'}}),false);
}));
test('query traces preserve UNKNOWN, redact all bodies and survive a throwing sink',()=>fixture(f=>{
  const logs:string[]=[],diagnostics=new PerformanceDiagnostics(row=>{logs.push(JSON.stringify(row));throw Error('sink');});
  const value=f.store.identities.memberQuickChatStateCommand;
  // The direct domain accepts the same already-pinned principal and scope.
  return import('./member-quick-chat-state-domain.js').then(({executeHubQuickChatStateCommand})=>{
    const state=executeHubQuickChatStateCommand(f.store,f.principal,()=>f.principal,{action:'inspect',requestId:'original'},diagnostics);
    assert.equal(state?.receipt?.state,'unknown');assert.ok(diagnostics.snapshot().events.some(row=>row.operation==='hub-quick-chat'&&row.step===9&&row.unknown===1));
    for(const secret of ['private prompt',f.token,'original',f.user.id])assert.ok(!logs.join('').includes(secret));
    assert.equal(f.store.identities.memberQuickChatStateCommand,value);
  });
}));
test('real complete owner returns maximum Chinese output and recovers UNKNOWN after reopen',async()=>{
  const root=mkdtempSync(join(tmpdir(),'chat-state-worker-')),file=join(root,'hub.sqlite'),store=new HubStore(file,'fixture'),f=seed(store);
  f.store.quickChat.saveProfile(f.user.id,0,{id:'second',name:'Second',target:'fixed',model:'fixed',outputLimit:2000},capability);
  f.store.quickChat.admit(f.user.id,'completed','second',1,'question',capability);f.store.quickChat.claim(f.user.id,'completed','question',capability,()=>true);
  f.store.quickChat.complete(f.user.id,'completed','中'.repeat(32000));const before=f.rows();await store.close();
  let owner=new AsyncHubMemberOwner({file,encryptionSecret:'fixture'},new PerformanceDiagnostics(()=>{}));
  try {
    const state=await owner.command('quickChatState',{...f.proof,command:{action:'inspect',requestId:'completed'}});
    assert.equal(state?.output?.length,32000);assert.ok(Buffer.byteLength(JSON.stringify(state))<hubMemberResultBytes('quickChatState'));
    await owner.close();owner=new AsyncHubMemberOwner({file,encryptionSecret:'fixture'},new PerformanceDiagnostics(()=>{}));
    const queries=new AsyncHubMemberQuickChatState(owner,new PerformanceDiagnostics(()=>{})),scope=await queries.begin(f.request);
    assert.equal((await scope.inspect('original')).receipt?.state,'unknown');assert.equal((await scope.list()).receipts?.length,2);
    assert.equal(queries.pending,0);await owner.close();
    const reopened=new HubStore(file,'fixture');try {const db=(reopened as unknown as {db:DatabaseSync}).db;
      assert.deepEqual(['quick_chat_profiles','quick_chat_receipts','quick_chat_results'].map(t=>db.prepare('SELECT * FROM '+t+' ORDER BY rowid').all()),before);
    } finally {await reopened.close();}
  } finally {await owner.close().catch(()=>{});rmSync(root,{recursive:true,force:true});}
});
class FakeWorker extends EventEmitter {
  messages:{id:number;kind:string;body:string}[]=[];stops=0;
  postMessage(m:{id:number;kind:string;body:string}){this.messages.push(m);}
  terminate(){this.stops++;return Promise.resolve(1);}
}
for(const corrupt of ['digest','request'] as const)
  test('mis-correlated query '+corrupt+' retains the real-exit fence',()=>fixture(async f=>{
    const root=mkdtempSync(join(tmpdir(),'chat-state-ack-')),file=join(root,'hub.sqlite'),worker=new FakeWorker(),launch=()=>worker as unknown as Worker;
    const owner=new AsyncHubMemberOwner({file},new PerformanceDiagnostics(()=>{}),launch),tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
    try {
      const command={action:'inspect',requestId:'original'} as const,work=owner.command('quickChatState',{...f.proof,command});void work.catch(()=>{});
      worker.emit('message',{kind:'ready'});await tick();const message=worker.messages[0]!,state=f.call(command)!;
      const altered=corrupt==='digest'?{...state,digest:'0'.repeat(64)}:{...state,receipt:{...state.receipt,requestId:randomUUID()}};
      worker.emit('message',{id:message.id,kind:message.kind,ok:true,body:JSON.stringify(altered)});await assert.rejects(work);
      assert.equal(worker.messages.length,1);assert.equal(worker.stops,0);assert.throws(()=>new AsyncHubMemberOwner({file},undefined,launch));
      const closing=owner.close();void closing.catch(()=>{});await tick();assert.equal(worker.stops,1);
      assert.throws(()=>new AsyncHubMemberOwner({file},undefined,launch));worker.emit('exit',1);await assert.rejects(closing);
    } finally {worker.emit('exit',1);rmSync(root,{recursive:true,force:true});}
  }));
