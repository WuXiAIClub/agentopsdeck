import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HubStore, type HubDeliveryEvent } from './hub-store.js';
import { AsyncHubMemberOwner, encodeHubMemberJson } from './async-member-owner.js';
import { executeHubMemberCommand, validHubMemberInput, hubMemberCommandBytes, hubMemberCommandNodes } from './member-owner-domain.js';
import { encodeHubEventJson, hubEventWire, validHubEventCommand, type HubEventProof } from './member-event-domain.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { sessionRef } from './session-ref.js';
import { encodeHubSessionId } from './session-id.js';

const domain = 'a'.repeat(64);
const event: Omit<HubDeliveryEvent,'id'> = {envConnectionId:'node',type:'session.updated',ts:1,payload:{run:{state:'completed'}},remoteSessionKey:'synthetic'};
function fixture(t: TestContext) {
  const store = new HubStore(':memory:','synthetic-vault');
  store.upsertConnection({id:'node',label:'Synthetic',capabilities:['events'],connectorUrl:'http://synthetic',credentialToken:'synthetic'});
  const key = store.identities.issueKey('default').token;
  const principal = store.identities.keyIdentity(key)!;
  const request = new Request('http://localhost/',{headers:{'x-agentopsdeck-key':key}});
  const snapshot = executeHubMemberCommand(store,'memberSnapshot',{accessKey:key})!;
  const proof: HubEventProof = {evidence:{accessKey:key},expectedScope:snapshot.recoveryScope,command:{connectionId:'node',connectionVersion:store.connectionAuthority('node')!,domain,event:hubEventWire(event),cursor:'next',liveSince:0}};
  const db: DatabaseSync = (store as any).db;
  t.after(async () => { await store.close(); });
  return {store,key,principal,request,proof,db,rows:()=>Number(db.prepare('SELECT count(*) AS n FROM hub_events').get()!.n)};
}

test('event wire omits optional undefined exactly like legacy JSON and preserves empty values and tab cursor', t => {
  const f = fixture(t);
  const original = {...event,payload:undefined,envConnectionLabel:'',remoteSessionKey:'',agentId:'',sessionRef:undefined};
  f.proof.command.event = hubEventWire(original); f.proof.command.cursor = '\t';
  assert.equal(validHubMemberInput('eventAppend',f.proof),true);
  const wire = JSON.parse(encodeHubMemberJson(f.proof,hubMemberCommandBytes('eventAppend'),hubMemberCommandNodes('eventAppend')));
  assert.deepEqual(wire.command.event,JSON.parse(JSON.stringify(original)));
  assert.deepEqual(executeHubMemberCommand(f.store,'eventAppend',wire),{appended:true});
  assert.equal(f.store.upstreamCursor('node',domain),'\t');
  const row = JSON.parse(String(f.db.prepare('SELECT payload_json FROM hub_events').get()!.payload_json));
  assert.equal(Object.hasOwn(row,'payload'),false); assert.equal(row.agentId,'');
});

for (const shape of ['getter','proxy','toJSON','symbol','prototype'] as const) test(`event wire rejects ${shape} without executing caller code`, () => {
  let invoked = 0;
  const value = shape === 'getter' ? {...event,get agentId(){invoked++;return 'private';}}
    : shape === 'proxy' ? new Proxy(event,{ownKeys(){invoked++;return [];}})
    : shape === 'toJSON' ? {...event,toJSON(){invoked++;return {};}}
    : shape === 'symbol' ? {...event,[Symbol('private')]:true}
    : Object.assign(Object.create({}),event);
  assert.throws(()=>hubEventWire(value)); assert.equal(invoked,0);
});

for (const change of ['event-id','unknown','mismatch','nul-cursor','bad-ref','authority-boolean'] as const) test(`event command refuses ${change} before storage`, t => {
  const f = fixture(t), c:any = structuredClone(f.proof.command);
  if(change==='event-id') c.event.id='caller-id';
  else if(change==='unknown') c.sql='DELETE';
  else if(change==='mismatch') c.event.envConnectionId='other';
  else if(change==='nul-cursor') c.cursor='x\0y';
  else if(change==='bad-ref') c.event.sessionRef={nodeId:'wrong',runtimeId:'codex',nativeSessionKey:'x'};
  else c.authorized=true;
  assert.equal(validHubEventCommand(c),false);
  assert.throws(()=>executeHubMemberCommand(f.store,'eventAppend',{...f.proof,command:c}));
  assert.equal(f.rows(),0);
});

test('whole event transaction deduplicates completion and still acknowledges the duplicate cursor', t => {
  const f=fixture(t); let completions=0;
  assert.equal(f.store.pinConnectionNode('node','default',f.store.connectionAuthority('node')!,'node_00000000-0000-4000-8000-000000000001').nodeId,'node_00000000-0000-4000-8000-000000000001');
  f.proof.command.connectionVersion=f.store.connectionAuthority('node')!;
  t.mock.method(f.store.completions,'ingest',()=>{completions++;});
  assert.deepEqual(executeHubMemberCommand(f.store,'eventAppend',f.proof),{appended:true});
  assert.deepEqual(executeHubMemberCommand(f.store,'eventAppend',f.proof),{appended:false});
  assert.equal(completions,1); assert.equal(f.rows(),1); assert.equal(f.store.upstreamCursor('node',domain),'next');
});

for (const changed of ['none','node','runtime','native','alias','session-key','missing-remote','unpinned'] as const)
test(`event transaction binds optional session identity to current connection: ${changed}`, t => {
  const f = fixture(t), node = 'node_00000000-0000-4000-8000-000000000001';
  if (changed !== 'unpinned') f.store.pinConnectionNode('node','default',f.store.connectionAuthority('node')!,node);
  f.proof.command.connectionVersion = f.store.connectionAuthority('node')!;
  const remote = 'codex:synthetic';
  f.proof.command.event = hubEventWire({...event,remoteSessionKey:remote,sessionRef:sessionRef(node,remote),
    hubSessionId:encodeHubSessionId('node',remote),sessionKey:encodeHubSessionId('node',remote)});
  const e = f.proof.command.event;
  if (changed === 'node') e.sessionRef!.nodeId = 'node_00000000-0000-4000-8000-000000000002';
  if (changed === 'runtime') e.sessionRef!.runtimeId = 'openclaw';
  if (changed === 'native') e.sessionRef!.nativeSessionKey = 'other';
  if (changed === 'alias') e.hubSessionId = encodeHubSessionId('other',remote);
  if (changed === 'session-key') e.sessionKey = encodeHubSessionId('other',remote);
  if (changed === 'missing-remote') delete e.remoteSessionKey;
  assert.equal(validHubMemberInput('eventAppend',f.proof),true);
  if (changed === 'none') assert.deepEqual(executeHubMemberCommand(f.store,'eventAppend',f.proof),{appended:true});
  else {
    assert.throws(()=>executeHubMemberCommand(f.store,'eventAppend',f.proof),/hub_event_invalid/);
    assert.equal(f.rows(),0); assert.equal(f.store.upstreamCursor('node',domain),undefined);
  }
});

for (const stage of ['insert','completion','cursor','retention','commit'] as const) test(`event ${stage} failure rolls back event, completion and cursor without retry`, t => {
  const f=fixture(t); let attempts=0;
  f.db.exec('CREATE TABLE test_completion (n INTEGER)');
  assert.equal(f.store.pinConnectionNode('node','default',f.store.connectionAuthority('node')!,'node_00000000-0000-4000-8000-000000000001').nodeId,'node_00000000-0000-4000-8000-000000000001');
  f.proof.command.connectionVersion=f.store.connectionAuthority('node')!;
  t.mock.method(f.store.completions,'ingest',()=>{
    f.db.prepare('INSERT INTO test_completion VALUES (1)').run();
    if(stage==='completion'){attempts++;throw Error('synthetic original failure');}
  });
  const exec=f.db.exec.bind(f.db);
  t.mock.method(f.db,'prepare',function(this: DatabaseSync,sql:string){
    const hit = stage==='insert' && sql.startsWith('INSERT INTO hub_events')
      || stage==='cursor' && sql.startsWith('INSERT INTO remote_event_cursors')
      || stage==='retention' && sql.startsWith('DELETE FROM hub_events');
    if(hit){attempts++;throw Error('synthetic original failure');} return DatabaseSync.prototype.prepare.call(this,sql);
  });
  f.db.exec=(sql:string)=>{if(stage==='commit' && sql==='COMMIT'){attempts++;throw Error('synthetic original failure');} return exec(sql);};
  t.after(()=>{f.db.exec=exec;});
  assert.throws(()=>executeHubMemberCommand(f.store,'eventAppend',f.proof),/synthetic original failure/);
  assert.equal(attempts,1); assert.equal(f.db.isTransaction,false); assert.equal(f.rows(),0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM test_completion').get()!.n,0);
  assert.equal(f.store.upstreamCursor('node',domain),undefined);
});

for (const change of ['revoked','rotated','disabled','deleted','scope','no-events'] as const) test(`event ${change} authority refuses without acknowledging upstream`, t => {
  const f=fixture(t);
  if(change==='revoked') f.store.identities.revokeKey('default',f.principal.keyId);
  else if(change==='scope') f.proof.expectedScope='b'.repeat(64);
  else if(change==='deleted') f.store.deleteConnection('node');
  else f.store.upsertConnection({id:'node',label:'Synthetic',status:change==='disabled'?'disabled':'enabled',capabilities:change==='no-events'?[]:['events'],connectorUrl:'http://synthetic',credentialToken:'changed'});
  assert.equal(executeHubMemberCommand(f.store,'eventAppend',f.proof),null);
  assert.equal(f.rows(),0); assert.equal(f.store.upstreamCursor('node',domain),undefined);
});

for (const phase of ['entry','precommit','postcommit'] as const) test(`event ${phase} fresh authority cannot be replaced by earlier proof`, t => {
  const f=fixture(t), lookup=f.store.identities.requestPrincipal.bind(f.store.identities); let reads=0;
  const at=phase==='entry'?2:phase==='precommit'?3:4;
  t.mock.method(f.store.identities,'requestPrincipal',(...args:Parameters<typeof lookup>)=>{if(++reads===at)return undefined;return lookup(...args);});
  assert.equal(executeHubMemberCommand(f.store,'eventAppend',f.proof),null);
  assert.equal(f.rows(),phase==='postcommit'?1:0);
  assert.equal(f.store.upstreamCursor('node',domain),phase==='postcommit'?'next':undefined);
});

test('event original default transaction and supplied authority callbacks retain synchronous contract', t => {
  const f=fixture(t); let checks=0;
  assert.equal(f.store.appendDelivery(event,domain,'original'),true);
  assert.equal(f.store.appendDelivery(event,domain,'guarded','default',undefined,()=>{checks++;}),true);
  assert.equal(checks,2); assert.equal(f.rows(),2);
  assert.throws(()=>f.store.appendDelivery(event,domain,'denied','default',undefined,()=>{throw Error('denied');}),/denied/);
  assert.equal(f.rows(),2); assert.equal(f.store.upstreamCursor('node',domain),'guarded');
});

test('real worker whole event transaction closes, reopens and refuses revoked saved evidence', async () => {
  const dir=mkdtempSync(join(tmpdir(),'agentopsdeck-event-owner-')), file=join(dir,'hub.sqlite');
  const diagnostics=new PerformanceDiagnostics(()=>{});
  let owner:AsyncHubMemberOwner|undefined;
  try{
    const seed=new HubStore(file,'synthetic-vault');
    seed.upsertConnection({id:'node',label:'Synthetic',capabilities:['events'],connectorUrl:'http://synthetic',credentialToken:'synthetic'});
    const key=seed.identities.issueKey('default').token, keyId=seed.identities.keyIdentity(key)!.keyId;
    const snapshot=executeHubMemberCommand(seed,'memberSnapshot',{accessKey:key})!;
    const proof:HubEventProof={evidence:{accessKey:key},expectedScope:snapshot.recoveryScope,command:{connectionId:'node',connectionVersion:seed.connectionAuthority('node')!,domain,event:hubEventWire(event),cursor:'next'}};
    await seed.close();
    owner=new AsyncHubMemberOwner({file,encryptionSecret:'synthetic-vault'},diagnostics);
    await owner.open(); assert.deepEqual(await owner.command('eventAppend',proof),{appended:true});
    assert.deepEqual(await owner.command('eventAppend',proof),{appended:false});
    const large = { ...proof, command: { ...proof.command, cursor: 'large-array', event: hubEventWire({ ...event, payload: new Array(32768).fill(0) }) } };
    let deep: unknown = 0;
    for (let index = 0; index < 1000; index++) deep = { payload: deep };
    const nested = { ...proof, command: { ...proof.command, cursor: 'deep-payload', event: hubEventWire({ ...event, payload: deep }) } };
    assert.equal(encodeHubEventJson(large),JSON.stringify(large));
    assert.equal(encodeHubEventJson(nested),JSON.stringify(nested));
    assert.deepEqual(await owner.command('eventAppend',large),{appended:true});
    assert.deepEqual(await owner.command('eventAppend',nested),{appended:true});
    await owner.close(); assert.equal(owner.snapshot().ownerExitConfirmed,true);
    const reopened=new HubStore(file,'synthetic-vault');
    assert.equal(reopened.upstreamCursor('node',domain),'deep-payload');
    assert.equal((reopened as any).db.prepare('SELECT count(*) AS n FROM hub_events').get().n,3);
    const persisted=(reopened as any).db.prepare('SELECT remote_event_id,payload_json FROM hub_events').all();
    for(const sample of [large,nested]){
      const row=persisted.find((row:any)=>row.remote_event_id===sample.command.cursor);
      assert.ok(row); const stored=JSON.parse(row.payload_json); delete stored.id;
      assert.deepEqual(stored,JSON.parse(JSON.stringify(sample.command.event)));
    }
    reopened.identities.revokeKey('default',keyId); await reopened.close();
    owner=new AsyncHubMemberOwner({file,encryptionSecret:'synthetic-vault'},diagnostics);
    await owner.open(); assert.equal(await owner.command('eventAppend',proof),null); await owner.close();
  }finally{await owner?.close();rmSync(dir,{recursive:true,force:true});}
});
