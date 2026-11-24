import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { HubStore } from './hub-store.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { OriginalHubAdministrativeCommands } from './original-administrative-commands.js';
import { hubMemberEvidence, validHubMemberInput, hubMemberResultBytes, hubMemberResultBudget } from './member-owner-domain.js';
import { encodeHubSessionId } from './session-id.js';
import { validHubDelegationCommand, validHubDelegationResult, type HubDelegationCommand,
  type HubDelegationResult } from './member-delegation-domain.js';
import type { DelegationBatch } from './workspace-delegation-store.js';

const endpoint = 'https://hub.example/api/workspace-agent/v1/board';
test('delegation fixed reply reservations fit recovery, four effects and cancellation without raising global budget', () => {
  const bytes = (command:HubDelegationCommand) => hubMemberResultBytes('delegation',{command});
  const batchId = randomUUID(), requestId = randomUUID(), boardId = 'default';
  const read = bytes({action:'read',boardId,batchId}), cancel = bytes({action:'cancel',boardId,batchId});
  const claim = bytes({action:'claim',boardId,batchId,requestId,endpoint});
  assert.equal(read,1024*1024);assert.equal(claim,64*1024);
  assert.equal(bytes({action:'check',boardId,fence:{generation:0,preferencesRevision:0}}),32*1024);
  assert.equal(bytes({action:'snapshot',boardId}),16*1024*1024);
  assert.ok(16*read+4*cancel+4*claim < hubMemberResultBudget('delegation'));
  assert.equal(hubMemberResultBudget('delegation'),32*1024*1024);
});
function batch(r: HubDelegationResult): DelegationBatch {
  assert.ok(r && 'batch' in r && r.batch); return r.batch;
}
async function fixture(t: TestContext, mode: 'original'|'worker') {
  const root = mkdtempSync(join(tmpdir(),'delegation-domain-')), file = join(root,'hub.sqlite');
  const seed = new HubStore(file,'fixture'), user = seed.createUser('Member'), other = seed.createUser('Other');
  const key = seed.identities.issueKey(user.id), cookie = seed.identities.createSession(key.token)!, otherKey = seed.identities.issueKey(other.id);
  const taskId = randomUUID(), sessionId = encodeHubSessionId('node','codex:PRIVATE_SESSION');
  seed.upsertConnection({id:'node',label:'Node',ownerUserId:user.id,connectorUrl:'http://connector.invalid',credentialToken:'private'});
  seed.pinConnectionNode('node',user.id,seed.connectionAuthority('node',user.id)!,'node_'+randomUUID());
  seed.boards.save(user.id,'default',{title:'Board',revision:0,mutationId:randomUUID(),tasks:[{id:taskId,title:'Task',detail:'',status:'todo'}]});
  seed.workspace.save(user.id,{revision:0,groups:[],sessions:{[sessionId]:{tags:['dev']}}});
  await seed.close();
  let local: HubStore | undefined;
  const mount = () => {
    if (mode === 'original') { local = new HubStore(file,'fixture'); return new OriginalHubAdministrativeCommands(local); }
    return new AsyncHubMemberOwner({file,encryptionSecret:'fixture'});
  };
  let owner = mount();
  const dispose = async () => { await owner.close(); await local?.close(); local = undefined; };
  t.after(async () => { await dispose(); rmSync(root,{recursive:true,force:true}); });
  const proof = async (headers: Record<string,string> = {'x-agentopsdeck-key':key.token}) => {
    const evidence = hubMemberEvidence(new Request('http://hub.invalid',{headers}));
    const snapshot = await owner.command('memberSnapshot',evidence); assert.ok(snapshot);
    return {evidence,expectedScope:snapshot.recoveryScope};
  };
  const command = async (command: HubDelegationCommand, headers?: Record<string,string>) => {
    const r = await owner.command('delegation',{...await proof(headers),command});
    assert.equal(validHubDelegationResult(r),true); return r;
  };
  const prepare = async () => {
    const snapshot = await command({action:'snapshot',boardId:'default'});
    assert.ok(snapshot && 'snapshot' in snapshot);
    const {generation,preferencesRevision} = snapshot.snapshot;
    const catalog = {generation,preferencesRevision,members:[{sessionId,taskBinding:'supported' as const}]};
    const batchId = randomUUID();
    const b = batch(await command({action:'prepare',boardId:'default',batchId,catalog,selection:{tags:['dev'],tagMode:'all'},taskIds:[taskId],fields:['status'],expiresAt:Date.now()+300_000}));
    return {batchId,catalog,b,requestId:b.members[0]!.requestId};
  };
  const confirm = async () => { const f = await prepare(); batch(await command({action:'confirm',boardId:'default',batchId:f.batchId,catalog:f.catalog})); return f; };
  return {user,key,cookie,otherKey,sessionId,taskId,proof,command,prepare,confirm,
    port: () => owner, local: () => { assert.ok(local); return local; },
    reopen: async () => { await dispose(); owner = mount(); },
    claim: (f: {batchId:string;requestId:string}) => command({action:'claim',boardId:'default',...f,endpoint}),
  };
}

for (const mode of ['original','worker'] as const) {
  test(`delegation ${mode}: first committed claim alone yields credential; reopen never redelivers`, async t => {
    const f = await fixture(t,mode), p = await f.confirm();
    const c = await f.claim({batchId:p.batchId,requestId:p.requestId});
    assert.ok(c && 'action' in c && c.action === 'claim' && c.claimed && c.credential && c.intent);
    assert.equal(c.intent.owner,f.user.id); assert.equal(c.intent.member.sessionId,f.sessionId);
    const binding = await f.port().command('boardBinding',{...await f.proof(),command:{action:'read',boardId:'default',id:p.requestId}});
    assert.ok(binding && 'binding' in binding && binding.binding); assert.equal(binding.binding.state,'uncertain');
    const duplicate = () => f.claim({batchId:p.batchId,requestId:p.requestId});
    assert.deepEqual(await duplicate(),{action:'claim',batchId:p.batchId,requestId:p.requestId,claimed:false,intent:null,credential:null});
    await f.reopen(); assert.deepEqual(await duplicate(),{action:'claim',batchId:p.batchId,requestId:p.requestId,claimed:false,intent:null,credential:null});
    const r = batch(await f.command({action:'read',boardId:'default',batchId:p.batchId})); assert.equal(r.members[0]!.state,'dispatching');
    assert.equal(JSON.stringify(r).includes(c.credential.token),false);
  });
  test(`delegation ${mode}: cancel revokes before cleanup, fences late ACK and survives reopen`, async t => {
    const f = await fixture(t,mode), p = await f.confirm(); await f.claim({batchId:p.batchId,requestId:p.requestId});
    const cancelled = batch(await f.command({action:'cancel',boardId:'default',batchId:p.batchId}));
    assert.equal(cancelled.state,'cancelled'); assert.equal(cancelled.members[0]!.state,'cleanup_pending');
    const binding = await f.port().command('boardBinding',{...await f.proof(),command:{action:'read',boardId:'default',id:p.requestId}});
    assert.ok(binding && 'binding' in binding && binding.binding); assert.equal(binding.binding.state,'revoked');
    const late = batch(await f.command({action:'settle',boardId:'default',batchId:p.batchId,requestId:p.requestId,state:'installed',source:'put'}));
    assert.equal(late.members[0]!.state,'cleanup_pending');
    const done = batch(await f.command({action:'cleanup-settle',boardId:'default',batchId:p.batchId,requestId:p.requestId}));
    assert.equal(done.members[0]!.state,'revoked'); await f.reopen();
    assert.equal(batch(await f.command({action:'read',boardId:'default',batchId:p.batchId})).members[0]!.state,'revoked');
    const claim = await f.claim({batchId:p.batchId,requestId:p.requestId}); assert.ok(claim && 'action' in claim && claim.action === 'claim' && !claim.claimed);
  });
  test(`delegation ${mode}: original key/cookie proofs, owner/board isolation and stale scope`, async t => {
    const f = await fixture(t,mode), p = await f.prepare();
    assert.equal(batch(await f.command({action:'read',boardId:'default',batchId:p.batchId},{cookie:'agentopsdeck_session='+f.cookie})).owner,f.user.id);
    assert.deepEqual(await f.command({action:'read',boardId:'default',batchId:p.batchId},{'x-agentopsdeck-key':f.otherKey.token}),{error:404});
    assert.deepEqual(await f.command({action:'read',boardId:randomUUID(),batchId:p.batchId}),{error:404});
    assert.equal(await f.port().command('delegation',{...await f.proof(),expectedScope:'a'.repeat(64),command:{action:'read',boardId:'default',batchId:p.batchId}}),null);
    assert.deepEqual(await f.command({action:'confirm',boardId:'default',batchId:p.batchId,catalog:{...p.catalog,generation:p.catalog.generation+1}}),{error:409});
  });
  test(`delegation ${mode}: cancel-before-prepare reserves batch without minting member capabilities`, async t => {
    const f = await fixture(t,mode), p = await f.prepare();
    const c = batch(await f.command({action:'cancel',boardId:'default',batchId:p.batchId})); assert.equal(c.members[0]!.state,'cancelled');
    assert.deepEqual(await f.command({action:'confirm',boardId:'default',batchId:p.batchId,catalog:p.catalog}),{error:409});
    const absent = randomUUID(); assert.deepEqual(await f.command({action:'cancel',boardId:'default',batchId:absent}),{action:'cancel',batch:null});
    await f.reopen();
    assert.deepEqual(await f.command({action:'prepare',boardId:'default',batchId:absent,catalog:p.catalog,selection:{tags:['dev'],tagMode:'all'},taskIds:[f.taskId],fields:['status'],expiresAt:Date.now()+300_000}),{error:409});
  });
  test(`delegation ${mode}: installed settlement uses local capability ID, cleanup requires revocation`, async t => {
    const f = await fixture(t,mode), p = await f.confirm(); await f.claim({batchId:p.batchId,requestId:p.requestId});
    assert.deepEqual(await f.command({action:'write-check',boardId:'default',batchId:p.batchId,requestId:p.requestId}),{action:'write-check',batchId:p.batchId,requestId:p.requestId,ok:true});
    assert.deepEqual(await f.command({action:'cleanup-settle',boardId:'default',batchId:p.batchId,requestId:p.requestId}),{error:409});
    const installed = batch(await f.command({action:'settle',boardId:'default',batchId:p.batchId,requestId:p.requestId,state:'installed',source:'put'}));
    assert.equal(installed.members[0]!.state,'installed'); assert.ok(installed.members[0]!.bindingId);
  });
}

test('delegation original: binding participant failure rolls back claim, capability and vault together', async t => {
  const f = await fixture(t,'original'), p = await f.confirm(), store = f.local();
  const db = (store as unknown as {db:DatabaseSync}).db;
  const before = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  const outcome = store.boardBindings.outcome.bind(store.boardBindings);
  t.mock.method(store.boardBindings,'outcome',(...args:Parameters<typeof outcome>) => { outcome(...args); throw Error('private injected failure'); });
  await assert.rejects(f.claim({batchId:p.batchId,requestId:p.requestId}));
  assert.equal(db.isTransaction,false);
  assert.equal(store.delegations.read(f.user.id,p.batchId)!.members[0]!.state,'prepared');
  assert.equal(store.boardBindings.get(f.user.id,'default',p.requestId),undefined);
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all(),before);
});

test('delegation fixed input rejects caller authority and executable/SQL extensions', () => {
  const base = {action:'read',boardId:'default',batchId:randomUUID()}; assert.equal(validHubDelegationCommand(base),true);
  for (const extra of [{owner:'alice'},{sql:'DELETE FROM hub_users'},{authorize:() => true},{bindingId:randomUUID()}])
    assert.equal(validHubDelegationCommand({...base,...extra}),false);
  assert.equal(validHubMemberInput('delegation',{evidence:{},expectedScope:'a'.repeat(64),command:{...base,owner:'alice'}}),false);
  assert.equal(validHubDelegationResult({action:'claim',batchId:base.batchId,requestId:randomUUID(),claimed:false,intent:null,credential:{token:'PRIVATE'}}),false);
});
