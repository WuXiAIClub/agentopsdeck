import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { AsyncHubMemberEvents } from './async-member-events.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { HubMemberRequestError } from './async-member-request.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { HubEventCommand } from './member-event-domain.js';
import { HubStore } from './hub-store.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

const scope = 'b'.repeat(64), snapshot = {principal:{userId:'member',admin:false},recoveryScope:scope};
const event = (): HubEventCommand => ({connectionId:'node',connectionVersion:1,domain:'a'.repeat(64),
  event:{envConnectionId:'node',type:'message.created',ts:1,payload:{text:'private-payload'}},cursor:'private-cursor'});
const request = (signal?: AbortSignal) => new Request('http://synthetic',{headers:{'x-agentopsdeck-key':'private-key'},...(signal ? {signal} : {})});
function deferred<T>() { let resolve!: (value:T)=>void, reject!: (error:unknown)=>void;
  const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;}); return {promise,resolve,reject}; }
async function until(check:()=>boolean) { for(let i=0;i<400;i++) {if(check())return;await delay(5);} assert.fail('original boundary did not arrive'); }
function fixture(work:(kind:string,input:any)=>unknown, broken=false) {
  const calls:{kind:string,input:any}[]=[], lines:string[]=[];
  const diagnostics=new PerformanceDiagnostics(line=>{lines.push(line);if(broken)throw Error('private-sink');});
  const owner={command:async(kind:string,input:any)=>{calls.push({kind,input});return work(kind,input);}} as Pick<AsyncHubMemberOwner,'command'>;
  return {calls,lines,diagnostics,port:new AsyncHubMemberEvents(owner,diagnostics,5,1000)};
}

for(const appended of [true,false]) test(`awaited event preserves ${appended?'insert':'duplicate'} ACK and original credentials`,async()=>{
  const f=fixture(kind=>kind==='memberSnapshot'?snapshot:{appended}), req=request();
  const handle=await f.port.begin(req); req.headers.set('x-agentopsdeck-key','replacement');
  assert.deepEqual(await handle.append(event()),{appended}); assert.equal(f.port.pending,0);
  assert.deepEqual(f.calls.map(c=>c.kind),['memberSnapshot','memberSnapshot','eventAppend','memberSnapshot']);
  const proof=f.calls.find(c=>c.kind==='eventAppend')!.input;
  assert.equal(proof.evidence.accessKey,'private-key');assert.equal(proof.expectedScope,scope);
});

for(const broken of [false,true]) test(`event warning cannot settle original SQL or replay it (broken sink=${broken})`,async()=>{
  const original=deferred<{appended:boolean}>(), f=fixture(kind=>kind==='memberSnapshot'?snapshot:original.promise,broken);
  const handle=await f.port.begin(request()); let settled=false;
  const running=handle.append(event()).finally(()=>{settled=true;});
  await until(()=>f.diagnostics.snapshot().events.some(e=>e.step===51 && e.phase==='pending'));
  assert.equal(settled,false);assert.equal(f.port.pending,1);assert.equal(f.calls.filter(c=>c.kind==='eventAppend').length,1);
  original.resolve({appended:true}); assert.deepEqual(await running,{appended:true});assert.equal(f.port.pending,0);
  assert.doesNotMatch(f.lines.join('\n'),/private-|member|payload|cursor/);
});

test('event caller captures payload before an awaited authority check',async()=>{
  const check=deferred<typeof snapshot>();let reads=0;
  const f=fixture(kind=>kind==='memberSnapshot'?(++reads===2?check.promise:snapshot):{appended:true});
  const handle=await f.port.begin(request()), command=event(), running=handle.append(command);
  await until(()=>reads===2);(command.event.payload as any).text='replacement';command.cursor='replacement';
  check.resolve(snapshot);await running;
  assert.equal(f.calls.find(c=>c.kind==='eventAppend')!.input.command.event.payload.text,'private-payload');
  assert.equal(f.calls.find(c=>c.kind==='eventAppend')!.input.command.cursor,'private-cursor');
});

for(const phase of ['before','after','owner'] as const) test(`event revocation at ${phase} refuses without replay`,async()=>{
  let reads=0,effects=0;
  const f=fixture(kind=>{
    if(kind==='memberSnapshot')return ++reads===(phase==='before'?2:phase==='after'?3:-1)?null:snapshot;
    effects++;return phase==='owner'?null:{appended:true};
  });
  const handle=await f.port.begin(request());
  await assert.rejects(handle.append(event()),e=>e instanceof HubMemberRequestError && e.status===401);
  assert.equal(effects,phase==='before'?0:1);assert.equal(f.port.pending,0);
});

test('disconnect during event write retains original command until ACK before refusing publication',async()=>{
  const original=deferred<{appended:boolean}>(), f=fixture(kind=>kind==='memberSnapshot'?snapshot:original.promise), controller=new AbortController();
  const handle=await f.port.begin(request(controller.signal));let settled=false;
  const running=handle.append(event());void running.then(()=>{settled=true;},()=>{settled=true;});
  await until(()=>f.calls.some(c=>c.kind==='eventAppend'));controller.abort();await delay(15);
  assert.equal(settled,false);assert.equal(f.port.pending,1);
  const rejected=assert.rejects(running,e=>e instanceof HubMemberRequestError && e.status===499);
  original.resolve({appended:true});await rejected;assert.equal(f.port.pending,0);
  assert.equal(f.calls.filter(c=>c.kind==='eventAppend').length,1);
});

for(const invalid of ['getter','proxy','shape','oversized'] as const) test(`invalid event ${invalid} never dispatches`,async()=>{
  let invoked=0;
  const f=fixture(kind=>kind==='memberSnapshot'?snapshot:{appended:true}), handle=await f.port.begin(request());
  const command=invalid==='getter'?{...event(),get cursor(){invoked++;return 'x';}}
    :invalid==='proxy'?new Proxy(event(),{ownKeys(){invoked++;return [];}})
    :invalid==='oversized'?{...event(),cursor:'x'.repeat(800_000)}:{...event(),authorized:true};
  await assert.rejects(handle.append(command as HubEventCommand),e=>e instanceof HubMemberRequestError && e.status===400);
  assert.equal(invoked,0);assert.deepEqual(f.calls.map(c=>c.kind),['memberSnapshot']);
});

for(const failure of ['reject','bad-ack','getter-ack'] as const) test(`event ${failure} keeps UNKNOWN and does not replay`,async()=>{
  let invoked=0;
  const f=fixture(kind=>{if(kind==='memberSnapshot')return snapshot;
    if(failure==='reject')throw Error('private-sql');
    return failure==='getter-ack'?{get appended(){invoked++;return true;}}:{appended:'yes'};});
  const handle=await f.port.begin(request());
  await assert.rejects(handle.append(event()),e=>e instanceof HubMemberRequestError && e.status===503);
  assert.equal(invoked,0);assert.equal(f.port.pending,0);assert.equal(f.calls.filter(c=>c.kind==='eventAppend').length,1);
  assert.ok(f.diagnostics.snapshot().events.some(e=>e.step===51 && e.unknown===1));
});

test('event persistence capacity refuses the 257th original write without disturbing the first 256',async()=>{
  const original=deferred<{appended:boolean}>(), f=fixture(kind=>kind==='memberSnapshot'?snapshot:original.promise);
  const handle=await f.port.begin(request()), pending=Array.from({length:256},()=>handle.append(event()));
  await until(()=>f.calls.filter(c=>c.kind==='eventAppend').length===256);
  await assert.rejects(handle.append(event()),e=>e instanceof HubMemberRequestError && e.status===503);
  assert.equal(f.calls.filter(c=>c.kind==='eventAppend').length,256);assert.equal(f.port.pending,256);
  original.resolve({appended:false});assert.equal((await Promise.all(pending)).length,256);assert.equal(f.port.pending,0);
});

test('real awaited event owner commits once and preserves original cursor and event after reopen',async()=>{
  const root=mkdtempSync(join(tmpdir(),'agentopsdeck-awaited-event-')),file=join(root,'hub.sqlite');
  const diagnostics=new PerformanceDiagnostics(()=>{});
  let owner:AsyncHubMemberOwner|undefined;
  try {
    const seed=new HubStore(file,'synthetic-vault');
    seed.upsertConnection({id:'node',label:'Synthetic',connectorUrl:'http://synthetic',credentialToken:'synthetic',capabilities:['events']});
    const key=seed.identities.issueKey('default').token, command=event();
    command.connectionVersion=seed.connectionAuthority('node')!;
    await seed.close();
    owner=new AsyncHubMemberOwner({file,encryptionSecret:'synthetic-vault'},diagnostics);
    const port=new AsyncHubMemberEvents(owner,diagnostics),handle=await port.begin(new Request('http://synthetic',{headers:{'x-agentopsdeck-key':key}}));
    assert.deepEqual(await handle.append(command),{appended:true});
    assert.deepEqual(await handle.append(command),{appended:false});
    assert.equal(port.pending,0);await owner.close();assert.equal(owner.snapshot().ownerExitConfirmed,true);
    const reopened=new HubStore(file,'synthetic-vault');
    try {
      assert.equal(reopened.upstreamCursor('node',command.domain),command.cursor);
      const db=(reopened as unknown as {db:DatabaseSync}).db;
      assert.equal(db.prepare('SELECT count(*) AS n FROM hub_events').get()!.n,1);
      assert.equal(JSON.parse(String(db.prepare('SELECT payload_json FROM hub_events').get()!.payload_json)).payload.text,'private-payload');
    } finally {await reopened.close();}
  } finally {await owner?.close().catch(()=>{});rmSync(root,{recursive:true,force:true});}
});
