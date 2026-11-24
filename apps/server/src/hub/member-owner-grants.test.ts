import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import { HubStore } from './hub-store.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { executeHubMemberCommand, validHubMemberInput, hubMemberFailureSteps } from './member-owner-domain.js';
import { validHubGrantReply, type HubGrantCommand } from './member-grant-domain.js';
import { connectionRecoverySnapshot } from '../storage/connection-recovery.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
const quiet = new PerformanceDiagnostics(() => {});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function seed(store: HubStore) {
  const db = (store as unknown as { db: DatabaseSync }).db;
  const owner = store.createUser('Owner'), user = store.createUser('Recipient'), other = store.createUser('Other');
  const target = { ownerUserId: owner.id, connectionId: 'node' };
  store.upsertConnection({ id: 'node', ownerUserId: owner.id, kind: 'remote', label: 'Node', connectorUrl: 'http://private.invalid' });
  store.pinConnectionNode('node', owner.id, store.connectionAuthority('node', owner.id)!, 'node_' + randomUUID());
  const key = store.identities.issueKey(owner.id), token = store.identities.createSession(key.token)!;
  const proof = { evidence: { sessionToken: token }, expectedScope: store.identities.recoveryScope({ userId: owner.id, admin: false }) };
  const command = (command: HubGrantCommand) => executeHubMemberCommand(store,
    ['authorize', 'list', 'get'].includes(command.action) ? 'grantRead' : 'grantChange', { ...proof, command } as never);
  const create = (): Extract<HubGrantCommand, { action: 'create' }> => ({ action: 'create', target, userId: user.id,
    nodeVersion: store.connectionAuthority('node', owner.id)!, policy: { runtime: 'codex', sessionKey: 'codex:owned', actions: ['messages:read','messages:send'] } });
  const list = (): Extract<HubGrantCommand, { action: 'list' }> => ({ action: 'list', target, after: '', limit: 50 });
  return { db, store, owner, user, other, target, key, token, proof, command, create, list };
}
async function fixture(work: (f: ReturnType<typeof seed>) => unknown) {
  const root = mkdtempSync(join(tmpdir(), 'hub-grant-domain-')), store = new HubStore(join(root,'hub.sqlite'), 'grant-fixture');
  try { await work(seed(store)); } finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
}
test('grant owner list preserves original pagination, issuer flags and revoked tombstones', () => fixture(f => {
  for (let i=0;i<3;i++) f.store.grants.create({ ...f.target, userId:f.user.id }, f.create().policy);
  const first = f.store.grants.list(f.target,'',1), command = { ...f.list(), limit: 1 };
  const result = f.command(command);
  assert.deepEqual(result, { target:f.target, action:'list', authority: { nodeVersion:f.create().nodeVersion,
    verified:true, executionConfigured:false, creationConfigured:false }, ...first });
  assert.ok(result && 'grants' in result);
  const grant = result.grants[0]!;
  f.store.grants.revoke({ ...f.target,userId:grant.userId },grant.id,grant.version);
  const page = f.command({ ...command, after:first.nextCursor! });
  assert.deepEqual(page, { target:f.target, action:'list', authority:result.authority, ...f.store.grants.list(f.target,first.nextCursor!,1) });
  assert.equal(f.store.grants.get(f.target,grant.id)!.revoked,true);
}));
test('grant create/replace/revoke match original CAS and never provision execution', () => fixture(f => {
  const created = f.command(f.create()); assert.ok(created && 'grant' in created);
  assert.equal(validHubGrantReply(f.create(), created), true);
  assert.deepEqual(created.grant, f.store.grants.get(f.target,created.grant.id));
  const replace: HubGrantCommand = { action:'replace',target:f.target,id:created.grant.id,version:1,nodeVersion:f.create().nodeVersion,
    policy:{ runtime:'codex',sessionKey:'codex:owned',actions:['messages:read'] } };
  const updated=f.command(replace); assert.ok(updated && 'grant' in updated); assert.equal(updated.grant.version,2);
  assert.deepEqual(f.command(replace), { error:'changed' });
  const revoke: HubGrantCommand={ action:'revoke',target:f.target,id:created.grant.id,version:2,nodeVersion:f.create().nodeVersion };
  const removed=f.command(revoke); assert.ok(removed && 'grant' in removed); assert.equal(removed.grant.revoked,true);
  assert.deepEqual(f.command(revoke),{ error:'changed' });
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM hub_execution_issuers').get()!.n,0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM hub_execution_leases').get()!.n,0);
}));
test('grant parent mutation revokes original derived children in same connection', () => fixture(f => {
  const created=f.command(f.create()); assert.ok(created && 'grant' in created);
  const child=f.store.grants.create({ ...f.target,userId:f.other.id },f.create().policy);
  f.db.prepare('INSERT INTO node_grant_dependencies VALUES(?,?,?)').run(child.id,created.grant.id,1);
  const result=f.command({ action:'revoke',target:f.target,id:created.grant.id,version:1,nodeVersion:f.create().nodeVersion });
  assert.ok(result && 'grant' in result && result.grant.revoked);
  assert.equal(f.store.grants.get(f.target,child.id)!.revoked,true);
  assert.equal(f.store.grants.get(f.target,child.id)!.version,2);
}));
test('grant managed membership ceiling and managed revocation are unchanged', () => fixture(f => {
  const member={ ...f.target,userId:f.user.id };
  f.store.roles.save({ userId:f.owner.id,admin:false },member,{ role:'developer',version:0,nodeVersion:f.create().nodeVersion,
    environments:{ codex:'developer',openclaw:'disabled' },migrateLegacy:true });
  assert.deepEqual(f.command({ ...f.create(),policy:{ runtime:'codex',actions:['messages:send'] } }),{ error:'managed' });
  const grant=f.store.grants.list(f.target).grants.find(g=>f.store.roles.managedGrant(g.id))!;
  assert.deepEqual(f.command({ action:'revoke',target:f.target,id:grant.id,version:grant.version,nodeVersion:f.create().nodeVersion }),{ error:'managed' });
  assert.equal(f.store.grants.get(f.target,grant.id)!.revoked,false);
}));
test('grant member or Hub administrator cannot use another owner target', () => fixture(f => {
  const proofFor=(admin:boolean)=>({ evidence:{ accessKey:f.store.identities.issueKey(f.other.id).token },
    expectedScope:f.store.identities.recoveryScope({ userId:f.other.id,admin }) });
  let proof=proofFor(false);
  assert.deepEqual(executeHubMemberCommand(f.store,'grantRead',{ ...proof,command:f.list() }),{ error:'denied' });
  f.store.roles.setHubRole({ userId:f.owner.id,admin:true },f.other.id,'admin',0);
  proof=proofFor(true);
  assert.deepEqual(executeHubMemberCommand(f.store,'grantChange',{ ...proof,command:f.create() }),{ error:'denied' });
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM node_grants').get()!.n,0);
}));
test('grant missing recipient, grant and authority are distinct original policy outcomes', () => fixture(f => {
  assert.deepEqual(f.command({ ...f.create(),userId:'missing' }),{ error:'recipient' });
  assert.deepEqual(f.command({ action:'get',target:f.target,id:'missing' }),{ error:'missing' });
  assert.deepEqual(f.command({ ...f.create(),nodeVersion:f.create().nodeVersion+1 }),{ error:'changed' });
  assert.deepEqual(f.command({ ...f.list(),target:{ ...f.target,connectionId:'missing' } }),{ error:'denied' });
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM node_grants').get()!.n,0);
}));
test('grant disabled node refuses create but preserves original revoke availability', () => fixture(f => {
  const created=f.command(f.create()); assert.ok(created && 'grant' in created);
  f.db.prepare("UPDATE env_connections SET status='disabled' WHERE id='node'").run();
  assert.deepEqual(f.command(f.create()),{ error:'unverified' });
  const revoked=f.command({ action:'revoke',target:f.target,id:created.grant.id,version:1,nodeVersion:f.create().nodeVersion });
  assert.ok(revoked && 'grant' in revoked && revoked.grant.revoked);
}));
test('grant capacity zero-row refusal is typed while SQL failure remains unknown', () => fixture(f => {
  f.db.prepare('UPDATE node_grant_usage SET rows=10000').run();
  assert.deepEqual(f.command(f.create()),{ error:'capacity' });
  f.db.prepare('UPDATE node_grant_usage SET rows=0').run();
  f.db.exec("CREATE TRIGGER grant_fault BEFORE INSERT ON node_grants BEGIN SELECT RAISE(ABORT, 'private SQL fault'); END;");
  assert.throws(()=>f.command(f.create()),/private SQL fault/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM node_grants').get()!.n,0);
  assert.equal(f.db.isTransaction,false);
}));
test('grant SQL failure after create rolls back original capacity and row', () => fixture(f => {
  const get=f.store.grants.get;
  f.store.grants.get=()=>{ throw Error('private post-insert failure'); };
  assert.throws(()=>f.command(f.create()),/private post-insert failure/);
  f.store.grants.get=get;
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM node_grants').get()!.n,0);
  assert.equal(f.db.prepare('SELECT rows FROM node_grant_usage').get()!.rows,0);
}));
for(const committed of [false,true]) test(`grant RELEASE ${committed?'after':'before'} physical commit retains unknown without replay`,()=>fixture(f=>{
  const exec=f.db.exec;
  f.db.exec=sql=>{ if(sql.startsWith('RELEASE hub_identity_check')) { if(committed) exec(sql); throw Error('private commit ACK loss'); } return exec(sql); };
  assert.throws(()=>f.command(f.create()),/private commit ACK loss/);
  f.db.exec=exec;
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM node_grants').get()!.n,committed?1:0);
  assert.equal(f.db.isTransaction,false); assert.equal(connectionRecoverySnapshot(f.db).state,'ready');
}));
test('grant outer caller rollback includes original row, child invalidation and capacity',()=>fixture(f=>{
  f.db.exec('BEGIN');
  const result=f.command(f.create());assert.ok(result && 'grant' in result);
  f.db.exec('ROLLBACK');
  assert.equal(f.store.grants.get(f.target,result.grant.id),undefined);
  assert.equal(f.db.prepare('SELECT rows FROM node_grant_usage').get()!.rows,0);
}));
test('grant oversized legacy JSON fails before original decoding; no truncated permission page',()=>fixture(f=>{
  const result=f.command(f.create());assert.ok(result && 'grant' in result);
  f.db.prepare('UPDATE node_grants SET actions=? WHERE id=?').run(' '.repeat(65537),result.grant.id);
  let called=false;const list=f.store.grants.list;f.store.grants.list=(...args)=>{ called=true;return list(...args); };
  assert.throws(()=>f.command(f.list()),/hub_grant_unavailable/);assert.equal(called,false);
}));
test('grant stale scope and revoked credentials cannot execute original changes',()=>fixture(f=>{
  assert.equal(executeHubMemberCommand(f.store,'grantChange',{ ...f.proof,expectedScope:'0'.repeat(64),command:f.create() }),null);
  f.store.identities.revokeKey(f.owner.id,f.key.id);assert.equal(f.command(f.create()),null);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM node_grants').get()!.n,0);
}));
test('grant oversized recipient label refuses before original user materialization',()=>fixture(f=>{
  f.db.prepare('UPDATE users SET label=? WHERE id=?').run('x'.repeat(65537),f.user.id);
  let called=false;const get=f.store.getUser;
  f.store.getUser=(id)=>{ if(id===f.user.id)called=true;return get.call(f.store,id); };
  assert.throws(()=>f.command(f.create()),/hub_grant_unavailable/);
  assert.equal(called,false);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM node_grants').get()!.n,0);
}));
test('grant strict command/ACK correlation rejects cross-action errors and forged success',()=>fixture(f=>{
  const create=f.create(),result=f.command(create);assert.ok(result && 'grant' in result);
  assert.equal(validHubMemberInput('grantRead',{ ...f.proof,command:create }),false);
  assert.equal(validHubMemberInput('grantChange',{ ...f.proof,command:{ ...create,authorized:true } }),false);
  assert.equal(validHubMemberInput('grantChange',{ ...f.proof,command:{ ...create,policy:{ runtime:'openclaw',actions:['sessions:create'] } } }),false);
  assert.equal(validHubGrantReply(create,{ ...result,grant:{ ...result.grant,userId:f.other.id } }),false);
  assert.equal(validHubGrantReply(create,{ ...result,grant:{ ...result.grant,revoked:true } }),false);
  assert.equal(validHubGrantReply(create,{ error:'missing' }),false);
  assert.equal(validHubGrantReply(f.list(),{ error:'changed' }),false);
  assert.equal(validHubGrantReply({ action:'get',target:f.target,id:result.grant.id },{ error:'capacity' }),false);
  assert.equal(hubMemberFailureSteps.grantRead,40);assert.equal(hubMemberFailureSteps.grantChange,41);
}));
class FakeWorker extends EventEmitter {
  messages:{ id:number;kind:string;body:string }[]=[];stops=0;
  postMessage(m:{ id:number;kind:string;body:string }){ this.messages.push(m); }
  terminate(){ this.stops++;return Promise.resolve(1); }
}
test('grant invalid negative ACK preserves original owner until real exit, never replay',async()=>{
  const root=mkdtempSync(join(tmpdir(),'hub-grant-ack-')),file=join(root,'hub.sqlite'),worker=new FakeWorker();
  const launch=()=>worker as unknown as Worker,owner=new AsyncHubMemberOwner({ file },quiet,launch);
  try {
    const command:HubGrantCommand={ action:'create',target:{ ownerUserId:'owner',connectionId:'node' },userId:'user',nodeVersion:1,policy:{ runtime:'codex',actions:['messages:read'] } };
    const result=owner.command('grantChange',{ evidence:{},expectedScope:'a'.repeat(64),command });void result.catch(()=>{});
    worker.emit('message',{ kind:'ready' });await tick();const m=worker.messages[0]!;
    worker.emit('message',{ id:m.id,kind:m.kind,ok:true,body:JSON.stringify({ error:'missing' }) });
    await assert.rejects(result);assert.equal(worker.stops,0);assert.equal(worker.messages.length,1);
    assert.throws(()=>new AsyncHubMemberOwner({ file },quiet,launch));
    const closing=owner.close();await tick();assert.equal(worker.stops,1);
    assert.throws(()=>new AsyncHubMemberOwner({ file },quiet,launch));worker.emit('exit',1);await assert.rejects(closing);
  } finally { worker.emit('exit',1);rmSync(root,{ recursive:true,force:true }); }
});
test('grant real worker same-data reopen uses complete original store and policy',async()=>{
  const root=mkdtempSync(join(tmpdir(),'hub-grant-worker-')),file=join(root,'hub.sqlite');
  const store=new HubStore(file,'grant-fixture'),f=seed(store),proof=f.proof,command=f.create();await store.close();
  const owner=new AsyncHubMemberOwner({ file,encryptionSecret:'grant-fixture' },quiet);
  try {
    const result=await owner.command('grantChange',{ ...proof,command });assert.ok(result && 'grant' in result);
    const list=await owner.command('grantRead',{ ...proof,command:{ action:'list',target:command.target,after:'',limit:50 } });
    assert.ok(list && 'grants' in list);assert.deepEqual(list.grants,[result.grant]);await owner.close();
    const reopened=new HubStore(file,'grant-fixture');try { assert.deepEqual(reopened.grants.get(command.target,result.grant.id),result.grant); }finally{ await reopened.close(); }
  } finally { await owner.close();rmSync(root,{ recursive:true,force:true }); }
});
