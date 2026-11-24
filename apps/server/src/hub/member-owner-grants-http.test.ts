import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { HubStore } from './hub-store.js';
import type { AsyncHubMemberOwner } from './async-member-owner.js';
import { AsyncHubMemberGrants } from './async-member-grants.js';
import { HubMemberRequestError } from './async-member-request.js';
import { executeHubMemberCommand, type HubMemberKind } from './member-owner-domain.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { registerHubNodeGrantRoutes } from '../routes/hub-node-grants.js';
const quiet = new PerformanceDiagnostics(() => {});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
type Port = Pick<AsyncHubMemberOwner, 'command'>;
const port = (call: (kind: HubMemberKind, input: unknown) => unknown): Port => ({
  command: (async (kind: HubMemberKind, input: unknown) => call(kind, input)) as Port['command'],
});
const deferred = () => { let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>(r => { resolve = r; }); return { resolve, promise }; };
async function fixture(work: (f: ReturnType<typeof seed>) => unknown) {
  const root = mkdtempSync(join(tmpdir(), 'hub-grant-http-')), store = new HubStore(join(root, 'hub.sqlite'), 'fixture');
  try { await work(seed(store)); }
  finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
}
function seed(store: HubStore) {
  const db = (store as unknown as { db: DatabaseSync }).db;
  const owner = store.createUser('Owner'), member = store.createUser('Member');
  store.upsertConnection({ id: 'node', ownerUserId: owner.id, kind: 'remote', label: 'Node', connectorUrl: 'http://private.invalid' });
  store.pinConnectionNode('node', owner.id, store.connectionAuthority('node', owner.id)!, 'node_' + randomUUID());
  const target = { ownerUserId: owner.id, connectionId: 'node' };
  const key = store.identities.issueKey(owner.id), token = store.identities.createSession(key.token)!;
  const request = () => new Request('http://fixture.invalid', { headers: { cookie: 'agentopsdeck_session=' + token } });
  const input = () => ({ userId: member.id, nodeVersion: store.connectionAuthority('node', owner.id)!,
    policy: { runtime: 'codex' as const, sessionKey: 'codex:owned', actions: ['messages:read' as const] } });
  const calls: HubMemberKind[] = [];
  const call = (kind: HubMemberKind, value: unknown) => { calls.push(kind); return executeHubMemberCommand(store, kind, value as never); };
  const original = port(call);
  const route = (asyncGrants: Pick<AsyncHubMemberGrants, 'begin'> = new AsyncHubMemberGrants(original, quiet)) => {
    const app = new Hono(); registerHubNodeGrantRoutes(app, { hubStore: store,
      principal: () => { throw new Error('async owner routes must not read synchronous principal'); }, asyncGrants });
    const path = '/api/hub/v1/connections/node/grants';
    const http = (method = 'GET', body?: unknown, suffix = '') => app.request(path + suffix, { method,
      headers: request().headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { app, path, http };
  };
  return { db, store, owner, member, target, key, token, request, input, calls, call, original, route };
}
test('awaited grant HTTP retains original frontend page and create/replace/revoke shape/CAS',()=>fixture(async f=>{
  const { http }=f.route(),read=await http();assert.equal(read.status,200);assert.equal(read.headers.get('cache-control'),'no-store');
  assert.deepEqual(await read.json(),{ nodeVersion:f.input().nodeVersion,verified:true,executionConfigured:false,creationConfigured:false,...f.store.grants.list(f.target) });
  const create=await http('POST',f.input());assert.equal(create.status,201);
  const { grant }=await create.json() as {grant:{id:string;version:number}};assert.equal(grant.version,1);
  const body={ version:1,nodeVersion:f.input().nodeVersion,policy:f.input().policy };
  assert.equal((await http('PUT',body,'/'+grant.id)).status,200);
  assert.equal((await http('PUT',body,'/'+grant.id)).status,409);
  assert.equal((await http('DELETE',{version:2},'/'+grant.id)).status,200);
  assert.equal((await http('DELETE',{version:2},'/'+grant.id)).status,409);
  assert.equal(f.store.grants.get(f.target,grant.id)!.revoked,true);
  assert.equal(f.calls.filter(k=>k==='grantChange').length,5);
}));
test('pre-body owned connection check precedes invalid JSON; missing original target stays 404',()=>fixture(async f=>{
  const {app,path}=f.route();const response=await app.request(path.replace('/node/','/missing/'),{method:'POST',headers:f.request().headers,body:'{invalid'});
  assert.equal(response.status,404);assert.equal(f.calls.includes('grantChange'),false);
}));
test('invalid recipient, page, policy, strict bodies and overflow never dispatch writes',()=>fixture(async f=>{
  const {http}=f.route();
  assert.equal((await http('POST',{...f.input(),userId:'missing'})).status,400);
  const count=f.calls.filter(k=>k==='grantChange').length;
  assert.equal((await http('POST',{...f.input(),extra:true})).status,400);
  assert.equal((await http('POST',{...f.input(),policy:{runtime:'openclaw',actions:['sessions:create']}})).status,400);
  assert.equal((await http('POST',{...f.input(),nodeVersion:f.input().nodeVersion+1})).status,409);
  assert.equal((await http('PUT',{version:Number.MAX_SAFE_INTEGER,nodeVersion:f.input().nodeVersion,policy:f.input().policy},'/missing')).status,409);
  assert.equal((await http('DELETE',{version:0},'/missing')).status,400);
  assert.equal((await http('GET',undefined,'?limit=101')).status,400);
  assert.equal(f.calls.filter(k=>k==='grantChange').length,count);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM node_grants').get()!.n,0);
}));
for(const change of ['credentials','connection'] as const)test('grant body wait rechecks original '+change+' before dispatch',()=>fixture(async f=>{
  const gate=deferred(),grants=new AsyncHubMemberGrants(f.original,quiet),{app,path}=f.route({begin:async(request,id)=>{
    const scope=await grants.begin(request,id);setImmediate(()=>gate.resolve(null));return scope;
  }});const originalBody=f.input();let pulled=false;
  const body=new ReadableStream<Uint8Array>({async pull(controller){await gate.promise;if(pulled)return;pulled=true;
    if(change==='credentials')f.store.identities.revokeSession(f.token);
    else f.store.upsertConnection({id:'node',ownerUserId:f.owner.id,kind:'remote',label:'Replacement',connectorUrl:'http://new.invalid'});
    controller.enqueue(new TextEncoder().encode(JSON.stringify(originalBody)));controller.close();
  }});
  const response=await app.request(new Request('http://fixture.invalid'+path,{method:'POST',headers:f.request().headers,body,duplex:'half'} as RequestInit));
  assert.equal(response.status,change==='credentials'?401:409);assert.equal(f.calls.includes('grantChange'),false);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM node_grants').get()!.n,0);
}));
test('managed role ceilings, missing grant and disabled-node revoke preserve policy',()=>fixture(async f=>{
  const {http}=f.route();assert.equal((await http('DELETE',{version:1},'/missing')).status,404);
  const created=await http('POST',f.input()),{grant}=await created.json() as {grant:{id:string}};
  f.db.prepare("UPDATE env_connections SET status='disabled' WHERE id='node'").run();
  assert.equal((await http('POST',f.input())).status,409);
  assert.equal((await http('DELETE',{version:1},'/'+grant.id)).status,200);
  f.db.prepare("UPDATE env_connections SET status='enabled' WHERE id='node'").run();
  f.store.roles.save({userId:f.owner.id,admin:false},{...f.target,userId:f.member.id},{role:'developer',version:0,nodeVersion:f.input().nodeVersion,environments:{codex:'developer',openclaw:'disabled'},migrateLegacy:true});
  const managed=f.store.grants.list(f.target).grants.find(g=>f.store.roles.managedGrant(g.id))!;
  assert.equal((await http('DELETE',{version:managed.version},'/'+managed.id)).status,409);
  assert.equal(f.store.grants.get(f.target,managed.id)!.revoked,false);
}));
for(const committed of [false,true])test('grant RELEASE '+(committed?'after':'before')+' commit returns unknown 503 without replay',()=>fixture(async f=>{
  const exec=f.db.exec.bind(f.db);let releases=0;
  f.db.exec=(sql)=>{if(sql.startsWith('RELEASE hub_identity_check')&&f.db.prepare('SELECT count(*) AS n FROM node_grants').get()!.n===1){
    releases++;if(committed)exec(sql);throw new Error('private failure text');}return exec(sql);};
  try{const response=await f.route().http('POST',f.input());assert.equal(response.status,503);assert.match((await response.json() as {error:string}).error,/check the saved state/);
    assert.equal(releases,1);assert.equal(f.calls.filter(k=>k==='grantChange').length,1);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM node_grants').get()!.n,committed?1:0);assert.equal(f.db.isTransaction,false);
  }finally{f.db.exec=exec;}
}));
test('wrong mutation ACK and lost final credentials never undo or repeat committed grant',()=>fixture(async f=>{
  for(const fault of ['ack','credentials']){
    const owner=port((kind,input)=>{const result=f.call(kind,input);if(kind==='grantChange'){
      if(fault==='ack')return {error:'missing'};f.store.identities.revokeSession(f.token);
    }return result;});
    const response=await f.route(new AsyncHubMemberGrants(owner,quiet)).http('POST',f.input());assert.equal(response.status,fault==='ack'?503:401);
  }
  assert.equal(f.calls.filter(k=>k==='grantChange').length,2);assert.equal(f.db.prepare('SELECT count(*) AS n FROM node_grants').get()!.n,2);
}));
test('grant list timeout retains read slot and privacy-safe phase40 until real settlement',()=>fixture(async f=>{
  const gate=deferred(),logs:string[]=[],diagnostics=new PerformanceDiagnostics(line=>logs.push(line));let reply:unknown;
  const owner=port((kind,input)=>{const result=f.call(kind,input);if(kind==='grantRead'&&(input as {command:{action:string}}).command.action==='list'){reply=result;return gate.promise;}return result;});
  const grants=new AsyncHubMemberGrants(owner,diagnostics,5,15),scope=await grants.begin(f.request(),'node');
  await assert.rejects(scope.list('',50),e=>e instanceof HubMemberRequestError&&e.status===503);
  assert.equal(grants.pending,1);assert.ok(logs.some(line=>{const e=JSON.parse(line);return e.step===40&&e.timedOut===1;}));
  gate.resolve(reply);await tick();assert.equal(grants.pending,0);
  for(const secret of [f.token,f.key.token,f.owner.id,f.member.id,'private.invalid'])assert.equal(logs.join('').includes(secret),false);
}));
test('grant mutation warning/abort keeps original effect pending until owner ACK, never replay',()=>fixture(async f=>{
  const gate=deferred(),dispatched=deferred(),logs:string[]=[],diagnostics=new PerformanceDiagnostics(line=>logs.push(line));let reply:unknown;
  const owner=port((kind,input)=>{const result=f.call(kind,input);if(kind==='grantChange'){reply=result;dispatched.resolve(null);return gate.promise;}return result;});
  const grants=new AsyncHubMemberGrants(owner,diagnostics,5,10),abort=new AbortController();
  const scope=await grants.begin(new Request('http://fixture.invalid',{headers:f.request().headers,signal:abort.signal}),'node');
  const body=f.input(),work=scope.create(body.userId,body.nodeVersion,body.policy);void work.catch(()=>{});
  await dispatched.promise;abort.abort();await new Promise<void>(resolve=>setTimeout(resolve,20));
  assert.equal(grants.pending,1);assert.equal(f.calls.filter(k=>k==='grantChange').length,1);
  assert.ok(logs.some(line=>{const e=JSON.parse(line);return e.step===41&&e.phase==='pending';}));
  gate.resolve(reply);await assert.rejects(work,e=>e instanceof HubMemberRequestError&&e.status===499);assert.equal(grants.pending,0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM node_grants').get()!.n,1);
}));
test('grant policy and original headers remain owned across permission await',()=>fixture(async f=>{
  const gate=deferred();let paused=false;const owner=port(async(kind,input)=>{if(paused&&kind==='memberSnapshot'){paused=false;await gate.promise;}return f.call(kind,input);});
  const request=f.request(),grants=new AsyncHubMemberGrants(owner,quiet),scope=await grants.begin(request,'node'),body=f.input();
  paused=true;const work=scope.create(body.userId,body.nodeVersion,body.policy);
  body.policy.sessionKey='codex:retargeted';request.headers.set('cookie','agentopsdeck_session=invalid');gate.resolve(null);
  assert.equal((await work).grant.policy.sessionKey,'codex:owned');
  await assert.rejects(scope.create(body.userId,body.nodeVersion+1,body.policy),e=>e instanceof HubMemberRequestError&&e.status===409);
  assert.equal(f.calls.filter(k=>k==='grantChange').length,1);
}));
test('grant port preserves original outer transaction and logs cannot authorize writes',()=>fixture(async f=>{
  const diagnostics=new PerformanceDiagnostics(()=>{throw new Error('untrusted sink');}),grants=new AsyncHubMemberGrants(f.original,diagnostics);
  f.db.exec('BEGIN');try{const scope=await grants.begin(f.request(),'node'),body=f.input();await scope.create(body.userId,body.nodeVersion,body.policy);
    assert.equal(f.db.isTransaction,true);assert.equal(f.db.prepare('SELECT rows FROM node_grant_usage').get()!.rows,1);
  }finally{f.db.exec('ROLLBACK');}
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM node_grants').get()!.n,0);
  assert.equal(f.db.prepare('SELECT rows FROM node_grant_usage').get()!.rows,0);
}));
for(const fault of ['target','policy','version'] as const)test('forged grant success '+fault+' is unknown, not a replay instruction',()=>fixture(async f=>{
  const owner=port((kind,input)=>{
    const result=f.call(kind,input);
    if(kind!=='grantChange')return result;
    const forged=structuredClone(result) as {target:{connectionId:string};grant:{version:number;policy:{sessionKey:string}}};
    if(fault==='target')forged.target.connectionId='different-node';
    if(fault==='policy')forged.grant.policy.sessionKey='codex:different';
    if(fault==='version')forged.grant.version=2;
    return forged;
  });
  const response=await f.route(new AsyncHubMemberGrants(owner,quiet)).http('POST',f.input());
  assert.equal(response.status,503);assert.equal(f.calls.filter(k=>k==='grantChange').length,1);
  const saved=f.store.grants.list(f.target).grants;assert.equal(saved.length,1);
  assert.equal(saved[0]!.version,1);assert.equal(saved[0]!.policy.sessionKey,'codex:owned');
}));
test('aborted original request cannot dispatch a grant mutation',()=>fixture(async f=>{
  const abort=new AbortController(),grants=new AsyncHubMemberGrants(f.original,quiet);
  const scope=await grants.begin(new Request('http://fixture.invalid',{headers:f.request().headers,signal:abort.signal}),'node');
  abort.abort();const body=f.input();
  await assert.rejects(scope.create(body.userId,body.nodeVersion,body.policy),e=>e instanceof HubMemberRequestError&&e.status===499);
  assert.equal(f.calls.includes('grantChange'),false);assert.equal(grants.pending,0);
}));
test('aborted grant read keeps original reservation until late rejection is observed',()=>fixture(async f=>{
  let reject!: (error:Error)=>void;const gate=new Promise<never>((_,r)=>{reject=r;}),started=deferred(),abort=new AbortController();
  const logs:string[]=[],diagnostics=new PerformanceDiagnostics(line=>logs.push(line));
  const owner=port((kind,input)=>{
    if(kind==='grantRead'&&(input as {command:{action:string}}).command.action==='list'){started.resolve(null);return gate;}
    return f.call(kind,input);
  });
  const grants=new AsyncHubMemberGrants(owner,diagnostics,5,1000);
  const scope=await grants.begin(new Request('http://fixture.invalid',{headers:f.request().headers,signal:abort.signal}),'node');
  const work=scope.list('',50);void work.catch(()=>{});await started.promise;abort.abort();
  await assert.rejects(work,e=>e instanceof HubMemberRequestError&&e.status===499);assert.equal(grants.pending,1);
  reject(new Error('private late failure'));await tick();assert.equal(grants.pending,0);
  assert.ok(logs.some(line=>{const e=JSON.parse(line);return e.step===40&&e.cancelled===1;}));
  assert.equal(logs.join('').includes('private late failure'),false);
}));
test('oversized and malformed grant bodies retain original HTTP bounds without write dispatch',()=>fixture(async f=>{
  const {app,path}=f.route();
  const oversized=await app.request(path,{method:'POST',headers:f.request().headers,body:JSON.stringify({...f.input(),padding:'x'.repeat(8192)})});
  assert.equal(oversized.status,413);
  const invalid=await app.request(path,{method:'POST',headers:f.request().headers,body:'{'});assert.equal(invalid.status,400);
  assert.equal(f.calls.includes('grantChange'),false);
}));
