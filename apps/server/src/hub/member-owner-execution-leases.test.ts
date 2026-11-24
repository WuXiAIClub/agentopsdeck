import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { HubStore } from './hub-store.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { AsyncHubExecutionLeases } from './async-execution-leases.js';
import { HubExecutionLeases } from './execution-leases.js';
import { validHubExecutionLeaseCommand, validHubExecutionLeaseReply, executeHubExecutionLeaseCommand } from './member-execution-lease-domain.js';
import { validHubMemberInput } from './member-owner-domain.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { ExecutionLeasePersistence } from './execution-sync.js';
import type { ExecutionUsagePersistence } from './execution-usage.js';
const quiet = new PerformanceDiagnostics(() => {});
const actions = ['messages:send','runs:compact'] as ('messages:send'|'runs:compact')[];
const ref = () => ({ id:randomUUID(), actorId:'actor_'+'a'.repeat(64) });
function seed(store: HubStore) {
  const user=store.createUser('Recipient'), nodeId='node_'+randomUUID();
  store.upsertConnection({ id:'node',kind:'remote',label:'Fixture',connectorUrl:'http://private.invalid' });
  store.pinConnectionNode('node','default',store.connectionAuthority('node','default')!,nodeId);
  const target={ ownerUserId:'default',connectionId:'node',userId:user.id };
  const resource={ runtime:'codex' as const,sessionKey:'codex:fixture/空 格' };
  const grant=store.grants.create(target,{ ...resource,actions });
  const proof=store.grants.authorize(target,'messages:send',resource,grant.id)!;
  assert.ok(proof);
  const db=(store as unknown as { db:DatabaseSync }).db;
  return { db,store,target,resource,grant,proof,nodeId };
}
async function disk(work:(file:string)=>Promise<void>) {
  const root=mkdtempSync(join(tmpdir(),'execution-owner-'));
  try { await work(join(root,'hub.sqlite')); }
  finally { rmSync(root,{ recursive:true,force:true }); }
}
async function local(work:(f:ReturnType<typeof seed>)=>Promise<void>) {
  const store=new HubStore(':memory:','synthetic-vault');
  try { await work(seed(store)); } finally { await store.close(); }
}
test('fixed execution domain refuses generic SQL, callbacks and missing revoke generation', async()=> {
  const invalid:unknown[]=[{ action:'sql',sql:'SELECT 1' },{ action:'get',id:1,authorized:true },
    { action:'acknowledgeRevoke',id:1 },{ action:'acknowledgeRevoke',id:1,throughVersion:0 },
    { action:'usageDue',limit:33 },{ action:'usageDue',limit:1,check:()=>{} },
    { action:'revocations',after:-1,limit:1 },{ action:'usageQuiet',id:1,version:-1 }];
  for(const c of invalid) { assert.equal(validHubExecutionLeaseCommand(c),false); assert.equal(validHubMemberInput('executionLease',c),false); }
  assert.equal(validHubExecutionLeaseCommand({ action:'usageQuiet',id:1,version:0 }),true);
});
test('original proof restrictions survive the async boundary',()=>local(async f=> {
  const c={ action:'reserve',proof:f.proof,nodeId:f.nodeId,issuerId:'issuer',actions };
  assert.equal(validHubExecutionLeaseCommand(c),true);
  for(const resource of [{ runtime:'codex' },{ ...f.resource,agentId:'asserted' },{ runtime:'claude',sessionKey:'claude:owned' },{ runtime:'openclaw',sessionKey:'codex:owned' }]) {
    assert.equal(validHubExecutionLeaseCommand({ ...c,proof:{ ...f.proof,resource } }),false);
  }
}));
test('real single worker preserves ACK false, cross-action reuse, tombstones and reopen',()=>disk(async file=> {
  const original=new HubStore(file,'synthetic-vault'); let f:ReturnType<typeof seed>;
  try { f=seed(original); } finally { await original.close(); }
  const owner=new AsyncHubMemberOwner({ file,encryptionSecret:'synthetic-vault' },quiet);
  const leases=new AsyncHubExecutionLeases(owner);
  // Compile-time ports: no Promise asserted away and no callback serialized.
  const syncPort:ExecutionLeasePersistence=leases, usagePort:ExecutionUsagePersistence=leases;
  assert.ok(syncPort && usagePort);
  let id=0;
  try {
    await owner.open();
    const initial=await leases.reserve(f!.proof,f!.nodeId,'issuer',actions); id=initial.id;
    assert.equal(initial.state,'pending');
    assert.equal((await leases.reserve({ ...f!.proof,action:'runs:compact' },f!.nodeId,'issuer',actions)).id,id);
    const issuing=await leases.prepareIssue(id), r=ref();
    assert.equal(await leases.acknowledgeIssue(id,r,issuing.expiresAt+1),false);
    assert.equal((await leases.get(id))!.state,'pending');
    assert.equal(await leases.acknowledgeIssue(id,r,issuing.expiresAt),true);
    assert.equal(await leases.authorized(f!.proof,actions),true);
    await leases.revoke(id);
    assert.deepEqual((await leases.revocations()).map(l=>l.id),[id]);
    assert.equal(await leases.acknowledgeRevoke(id,initial.version+1),false);
    assert.equal(await leases.acknowledgeRevoke(id,initial.version),true);
    const actor=await leases.nextQueueActor({ ...f!.target,nodeId:f!.nodeId,sessionKey:f!.resource.sessionKey });
    assert.equal(actor!.id,id); assert.equal(actor!.state,'revoked'); assert.deepEqual(actor!.ref,r);
    assert.equal(await leases.get(999999),undefined);
  } finally { await owner.close(); }
  assert.equal(owner.snapshot().ownerExitConfirmed,true);
  const reopened=new HubStore(file,'synthetic-vault');
  try { assert.equal(reopened.executionLeases.get(id)!.state,'revoked'); }
  finally { await reopened.close(); }
}));
test('parent grant revocation remains authoritative, not cached authorization',()=>local(async f=> {
  const c={ action:'reserve' as const,proof:f.proof,nodeId:f.nodeId,issuerId:'issuer',actions };
  const result=await executeHubExecutionLeaseCommand(f.db,f.store.executionLeases,c);
  assert.ok('lease' in result && result.lease);
  f.store.grants.revoke(f.target,f.grant.id,f.grant.version);
  assert.deepEqual(await f.store.executionLeaseCommand({ action:'authorized',proof:f.proof,actions }),{ action:'authorized',value:false });
  await assert.rejects(f.store.executionLeaseCommand({ action:'prepareIssue',id:result.lease.id }));
  assert.equal(f.store.executionLeases.get(result.lease.id)!.state,'revoking');
}));
test('bounded usage reservation keeps original generation CAS and 15-second retry fence',()=>local(async f=> {
  const l=f.store.executionLeases.reserve(f.proof,f.nodeId,'issuer',actions);
  f.store.executionLeases.acknowledgeIssue(l.id,ref(),l.expiresAt);
  f.db.prepare('UPDATE hub_execution_leases SET usage_pending=1,usage_version=2 WHERE id=?').run(l.id);
  const before=Date.now(); const result=await f.store.executionLeaseCommand({ action:'usageDue',limit:1 });
  assert.ok('page' in result); assert.equal(result.page.length,1); assert.equal(result.page[0]!.version,2);
  const after=f.db.prepare('SELECT usage_after FROM hub_execution_leases WHERE id=?').get(l.id)!.usage_after as number;
  assert.ok(after>=before+15000 && after<=Date.now()+15000);
  assert.equal(f.db.isTransaction,false);
  assert.deepEqual(await f.store.executionLeaseCommand({ action:'usageDue',limit:1 }),{ action:'usageDue',page:[] });
  assert.deepEqual(await f.store.executionLeaseCommand({ action:'usageQuiet',id:l.id,version:1 }),{ action:'usageQuiet',value:false });
  assert.deepEqual(await f.store.executionLeaseCommand({ action:'usageQuiet',id:l.id,version:2 }),{ action:'usageQuiet',value:true });
}));
for(const fault of ['oversize','malformed','write-failure'] as const) test(`usage ${fault} rejects before partial reservation and remains recoverable`,()=>local(async f=> {
  const leases=f.store.executionLeases;
  for(const issuer of ['one','two']) {
    const l=leases.reserve(f.proof,f.nodeId,issuer,actions);
    leases.acknowledgeIssue(l.id,ref(),l.expiresAt);
  }
  f.db.exec('UPDATE hub_execution_leases SET usage_pending=1');
  const rows=f.db.prepare('SELECT id,proof FROM hub_execution_leases ORDER BY id').all();
  const second=rows[1]!;
  if(fault==='write-failure') f.db.exec(`CREATE TRIGGER reservation_fault BEFORE UPDATE OF usage_after ON hub_execution_leases WHEN NEW.id=${second.id} BEGIN SELECT RAISE(ABORT,'synthetic fault'); END`);
  else f.db.prepare('UPDATE hub_execution_leases SET proof=? WHERE id=?').run(fault==='oversize'?JSON.stringify({ ...f.proof,extra:'x'.repeat(17000) }):'{}',second.id!);
  await assert.rejects(f.store.executionLeaseCommand({ action:'usageDue',limit:2 }));
  assert.deepEqual(f.db.prepare('SELECT usage_after FROM hub_execution_leases ORDER BY id').all().map(r=>r.usage_after),[0,0]);
  assert.equal(f.db.isTransaction,false);
  if(fault==='write-failure') f.db.exec('DROP TRIGGER reservation_fault');
  else f.db.prepare('UPDATE hub_execution_leases SET proof=? WHERE id=?').run(second.proof!,second.id!);
  const recovered=await f.store.executionLeaseCommand({ action:'usageDue',limit:2 });
  assert.ok('page' in recovered); assert.equal(recovered.page.length,2);
}));
test('reply correlation refuses wrong lease while allowing the original cross-action key',()=>local(async f=> {
  const l=f.store.executionLeases.reserve(f.proof,f.nodeId,'issuer',actions);
  const c={ action:'reserve' as const,proof:{ ...f.proof,action:'runs:compact' as const },nodeId:f.nodeId,issuerId:'issuer',actions };
  assert.equal(validHubExecutionLeaseReply(c,{ action:'reserve',lease:l }),true);
  assert.equal(validHubExecutionLeaseReply(c,{ action:'reserve',lease:{ ...l,issuerId:'other' } }),false);
  assert.equal(validHubExecutionLeaseReply({ action:'get',id:l.id+1 },{ action:'get',lease:l }),false);
}));
test('facade snapshots mutable input and never transports local cancellation callbacks',()=>local(async f=> {
  let done!:(v:unknown)=>void, input:unknown;
  const lease=f.store.executionLeases.reserve(f.proof,f.nodeId,'issuer',actions);
  const mock={ command:(_kind:string,c:unknown)=>{ input=c; return new Promise(resolve=>{ done=resolve; }); } } as unknown as Pick<AsyncHubMemberOwner,'command'>;
  const adapter=new AsyncHubExecutionLeases(mock), mutable={ ...f.proof,resource:{ ...f.proof.resource } };
  const pending=adapter.reserve(mutable,f.nodeId,'issuer',[...actions]);
  mutable.userId='changed'; mutable.resource.sessionKey='codex:changed';
  done({ action:'reserve',lease }); assert.deepEqual(await pending,lease);
  assert.equal((input as { proof:typeof f.proof }).proof.userId,f.proof.userId);
  let checks=0; const usage=adapter.usageDueAsync(1,()=>{ if(++checks===2) throw Error('cancelled'); });
  assert.deepEqual(input,{ action:'usageDue',limit:1 });
  done({ action:'usageDue',page:[] }); await assert.rejects(usage,/cancelled/); assert.equal(checks,2);
}));
test('transaction guard inspects the exact reservation cutoff, not a prior wall clock',()=>local(async f=> {
  let now=Date.now()+60_000;
  const leases=new HubExecutionLeases(f.db,f.store.grants,()=>now,10000,quiet);
  for(const issuer of ['one','two']) {
    const l=leases.reserve(f.proof,f.nodeId,issuer,actions);
    leases.acknowledgeIssue(l.id,ref(),l.expiresAt);
  }
  const rows=f.db.prepare('SELECT id,proof FROM hub_execution_leases ORDER BY id').all();
  f.db.prepare('UPDATE hub_execution_leases SET usage_pending=1,usage_after=?').run(now);
  f.db.prepare('UPDATE hub_execution_leases SET proof=? WHERE id=?').run('{}',rows[1]!.id!);
  await assert.rejects(executeHubExecutionLeaseCommand(f.db,leases,{ action:'usageDue',limit:2 }));
  assert.deepEqual(f.db.prepare('SELECT usage_after FROM hub_execution_leases ORDER BY id').all().map(r=>r.usage_after),[now,now]);
  assert.equal(f.db.isTransaction,false);
  f.db.prepare('UPDATE hub_execution_leases SET proof=? WHERE id=?').run(rows[1]!.proof!,rows[1]!.id!);
  const result=await executeHubExecutionLeaseCommand(f.db,leases,{ action:'usageDue',limit:2 });
  assert.ok('page' in result); assert.equal(result.page.length,2);
  assert.deepEqual(f.db.prepare('SELECT usage_after FROM hub_execution_leases ORDER BY id').all().map(r=>r.usage_after),[now+15000,now+15000]);
}));
