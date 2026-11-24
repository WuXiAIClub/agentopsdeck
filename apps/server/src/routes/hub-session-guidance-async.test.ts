import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { CONNECTOR_PROTOCOL, CONNECTOR_PROTOCOL_HEADER } from '@agentopsdeck/shared';
import { NODE_ID_HEADER } from '../connector/node-identity.js';
import { HubStore } from '../hub/hub-store.js';
import { encodeHubSessionId } from '../hub/session-id.js';
import { AsyncHubMemberGuidance } from '../hub/async-member-guidance.js';
import { AsyncHubMemberOwner } from '../hub/async-member-owner.js';
import { HubMemberRequestError } from '../hub/async-member-request.js';
import { executeHubMemberCommand, type HubMemberCommands, type HubMemberKind } from '../hub/member-owner-domain.js';
import { ConnectorClient } from '../hub/connector-client.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { registerAsyncHubSessionGuidance } from './hub-session-guidance-async.js';
import { registerHubSessionGuidance } from './hub-session-guidance.js';

const quiet = new PerformanceDiagnostics(() => {});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() { let resolve!: (value: unknown) => void; const promise = new Promise(resolve_ => { resolve = resolve_; }); return { promise, resolve }; }
function port(work: (kind: HubMemberKind, input: unknown) => unknown) { return { command: work } as Pick<AsyncHubMemberOwner, 'command'>; }
function seed(store: HubStore) {
  const user = store.createUser('Guidance owner');
  store.upsertConnection({ id: 'environment', ownerUserId: user.id, label: 'Environment', connectorUrl: 'http://fixture.invalid' });
  const nodeId = 'node_' + randomUUID();
  store.pinConnectionNode('environment', user.id, store.connectionAuthority('environment', user.id)!, nodeId);
  const key = store.identities.issueKey(user.id), token = store.identities.createSession(key.token)!;
  const sessionId = encodeHubSessionId('environment', 'codex:synthetic');
  return { user, nodeId, key, token, sessionId };
}
async function fixture(work: (f: ReturnType<typeof setup>) => unknown) {
  const root = mkdtempSync(join(tmpdir(), 'guidance-async-http-')), path = join(root, 'hub.sqlite');
  const f = setup(path);
  try { await work(f); } finally { await f.routes.close(); await f.store.close(); rmSync(root, { recursive: true, force: true }); }
}
function setup(path: string) {
  let store = new HubStore(path, 'fixture');
  const s = seed(store), calls: {kind: HubMemberKind; action?: string}[] = [], rows: string[] = [], messages: string[] = [];
  const diagnostics = new PerformanceDiagnostics(line => rows.push(line));
  let posts = 0, gets = 0, lost = false, offline = false, wrong = false, reject = false, revokePost = false;
  let before: ((kind: HubMemberKind, input: unknown) => Promise<void> | void) | undefined;
  let after: ((kind: HubMemberKind, input: unknown, value: unknown) => Promise<void> | unknown) | undefined;
  let resolver: (() => Promise<void> | void) | undefined;
  const receipts = new Map<string, unknown>();
  const db = () => (store as unknown as {db: DatabaseSync}).db;
  const command = async (kind: HubMemberKind, input: unknown) => {
    calls.push({kind, ...('command' in (input as object) ? {action: (input as {command:{action:string}}).command.action} : {})});
    await before?.(kind, input);
    const value = executeHubMemberCommand(store, kind, input as never);
    if (after) return await after(kind, input, value);
    return value;
  };
  const owner = port(command);
  const client = () => new ConnectorClient('http://fixture.invalid', 'private-connector-token', async request => {
    let command: unknown;
    if (request.method === 'POST') {
      posts++;
      const body = await request.json() as {message:string; idempotencyKey:string};
      assert.equal(request.headers.get('idempotency-key'), body.idempotencyKey);
      messages.push(body.message);
      command = {key:wrong ? 'wrong-key' : body.idempotencyKey, id:randomUUID(), state:reject ? 'rejected' : 'accepted'};
      receipts.set(body.idempotencyKey, command);
      if (revokePost) store.upsertConnection({id:'environment',ownerUserId:s.user.id,label:'Environment',connectorUrl:'http://fixture.invalid',status:'disabled'});
      if (lost) throw Error('private-lost-ack');
    } else {
      gets++; if (offline) throw Error('private-offline');
      command = receipts.get(decodeURIComponent(new URL(request.url).pathname.split('/').at(-1)!));
    }
    return new Response(JSON.stringify(command ? {command} : {error:'missing'}), {status:command ? 200 : 404,
      headers:{[CONNECTOR_PROTOCOL_HEADER]:String(CONNECTOR_PROTOCOL.max),[NODE_ID_HEADER]:s.nodeId,'content-type':'application/json'}});
  }, 10000, 1024*1024, {nodeId:s.nodeId});
  let app = new Hono(), guidance = new AsyncHubMemberGuidance(owner, diagnostics);
  const mount = () => registerAsyncHubSessionGuidance(app, {guidance, diagnostics, connectorClient:async()=>{await resolver?.(); return client();}});
  let routes = mount();
  const request = (method = 'GET', suffix = '', body?: unknown, token = s.token) => new Request(
    'http://fixture.invalid/api/hub/v1/sessions/' + encodeURIComponent(s.sessionId) + '/guidance' + suffix,
    {method,headers:{cookie:'agentopsdeck_session='+token},...(body === undefined ? {} : {body:JSON.stringify(body)})});
  return {
    ...s, path, calls, rows, messages, owner, client, request, db,
    get store(){return store;}, get guidance(){return guidance;}, get routes(){return routes;},
    get posts(){return posts;}, get gets(){return gets;},
    http:(method = 'GET', suffix = '', body?: unknown, token = s.token) => app.request(request(method,suffix,body,token)),
    setBefore:(value: typeof before)=>{before=value;}, setAfter:(value: typeof after)=>{after=value;}, setResolver:(value: typeof resolver)=>{resolver=value;},
    lost:()=>{lost=true;offline=true;}, online:()=>{offline=false;}, wrong:()=>{wrong=true;}, rejected:()=>{reject=true;}, revokePost:()=>{revokePost=true;},
    async reopen(){await routes.close();await store.close();store=new HubStore(path,'fixture');app=new Hono();guidance=new AsyncHubMemberGuidance(owner,diagnostics);routes=mount();},
  };
}
async function preview(f:ReturnType<typeof setup>, input='Input') {
  assert.equal((await f.http('PUT','',{revision:0,text:'Keep this guidance.',enabled:true})).status,200);
  const requestId=randomUUID(), response=await f.http('POST','/submissions',{requestId,revision:1,input});
  assert.equal(response.status,201); return requestId;
}
test('async guidance keeps original HTTP wire shapes, cookies, no-store and save-never-sends',()=>fixture(async f=>{
  const old=new Hono();const mounted=registerHubSessionGuidance(old,{hubStore:f.store,principal:c=>f.store.identities.requestPrincipal(c.req.raw,()=>false)!,connectorClient:()=>f.client(),diagnostics:quiet});
  try {
    const before=await f.http();assert.deepEqual(await before.json(),await (await old.request(f.request())).json());
    assert.equal(before.headers.get('cache-control'),'no-store');
    const id=await preview(f);
    assert.deepEqual(await (await f.http()).json(),await (await old.request(f.request())).json());
    assert.deepEqual(await (await f.http('GET','/submissions/'+id)).json(),await (await old.request(f.request('GET','/submissions/'+id))).json());
    assert.equal(f.posts,0); assert.equal(f.gets,0);
    assert.equal((await f.http('DELETE','/submissions/'+id)).status,200);
    assert.deepEqual(await (await f.http('GET','/submissions/'+id)).json(),{receipt:null,cancelled:true,requestId:id});
  } finally {mounted.close();}
}));
for(const rejected of [false,true]) test('explicit submit dispatches exactly once and settles original '+(rejected?'rejected':'accepted')+' ACK',()=>fixture(async f=>{
  const id=await preview(f);if(rejected)f.rejected();
  const first=await f.http('POST','/submissions/'+id+'/submit',{});assert.equal(first.status,200);
  const body=await first.json() as {receipt:Record<string,unknown>};assert.equal(body.receipt.state,rejected?'rejected':'submitted');
  assert.equal('commandKey' in body.receipt,false);assert.equal('inputHash' in body.receipt,false);
  assert.equal((await f.http('POST','/submissions/'+id+'/submit',{})).status,200);
  assert.equal(f.posts,1);assert.equal(f.gets,0);assert.deepEqual(f.messages,['Keep this guidance.\n\nInput']);
}));
test('lost ACK and restart recover only original receipt, never resend or start session',()=>fixture(async f=>{
  const id=await preview(f);f.lost();
  const first=await f.http('POST','/submissions/'+id+'/submit',{});assert.equal(first.status,200);
  assert.equal((await first.json() as {receipt:{state:string}}).receipt.state,'unknown');
  assert.equal(f.posts,1);await f.reopen();
  assert.equal((await f.http('POST','/submissions/'+id+'/submit',{})).status,200);assert.equal(f.posts,1);
  f.online();const recovery=await f.http('GET','/submissions/'+id);assert.equal(recovery.status,200);
  assert.equal((await recovery.json() as {receipt:{state:string}}).receipt.state,'submitted');assert.equal(f.posts,1);
  assert.equal(f.db().prepare('SELECT count(*) AS n FROM command_receipts').get()!.n,0);
}));
test('wrong ACK stays UNKNOWN with fixed diagnostics, no replacement key',()=>fixture(async f=>{
  const id=await preview(f);f.wrong();
  assert.equal((await f.http('POST','/submissions/'+id+'/submit',{})).status,200);
  const result=await f.http('GET','/submissions/'+id);assert.equal((await result.json() as {receipt:{state:string}}).receipt.state,'unknown');
  assert.equal((await f.http('POST','/submissions/'+id+'/submit',{})).status,200);assert.equal(f.posts,1);
  assert.ok(f.rows.some(row=>{const r=JSON.parse(row);return r.operation==='hub-session-guidance'&&r.step===9&&r.deferred===1;}));
  for(const secret of [f.token,f.key.token,f.user.id,id,'Keep this guidance.','private-connector-token','private-offline']) assert.equal(f.rows.join('').includes(secret),false);
}));
test('identity or node change during resolver await suppresses POST and keeps UNKNOWN',()=>fixture(async f=>{
  const id=await preview(f);f.setResolver(()=>{f.db().prepare("UPDATE env_connections SET node_id=?,authority_version=authority_version+1 WHERE id='environment'").run('node_'+randomUUID());});
  const response=await f.http('POST','/submissions/'+id+'/submit',{});assert.equal(response.status,409);assert.equal(f.posts,0);
  const row=f.db().prepare('SELECT payload FROM guidance_submissions').get()!;assert.equal(JSON.parse(String(row.payload)).state,'unknown');
}));
test('authority change after remote effect never reveals response or retries',()=>fixture(async f=>{
  const id=await preview(f);f.revokePost();const response=await f.http('POST','/submissions/'+id+'/submit',{});
  assert.equal(response.status,404);assert.equal(f.posts,1);assert.equal(response.headers.get('cache-control'),'no-store');
  assert.equal(JSON.parse(String(f.db().prepare('SELECT payload FROM guidance_submissions').get()!.payload)).state,'unknown');
}));
test('invalid submit body cannot be interpreted as browser ACK or dispatch',()=>fixture(async f=>{
  const id=await preview(f);
  for(const body of [{state:'accepted'},null,[]]) assert.equal((await f.http('POST','/submissions/'+id+'/submit',body)).status,400);
  // Preserve the existing 32-byte body budget: an oversized fabricated ACK
  // is rejected by the reader before field validation, exactly as before.
  assert.equal((await f.http('POST','/submissions/'+id+'/submit',{command:{key:'fabricated',id:'queue',state:'accepted'}})).status,413);
  assert.equal(f.posts,0);assert.equal(f.calls.some(c=>c.action==='claim'),false);
}));
test('SQL COMMIT ACK failure is 503; refresh keeps original unknown and never sends',()=>fixture(async f=>{
  const id=await preview(f), db=f.db(), exec=db.exec.bind(db);let armed=true,commitFaults=0;
  f.setBefore((kind,input)=>{if(kind==='sessionGuidance'&&(input as {command:{action:string}}).command.action==='claim'&&armed){db.exec=sql=>{exec(sql);if(sql==='COMMIT'){armed=false;commitFaults++;db.exec=exec;throw Error('private-commit-ack');}};}});
  try {assert.equal((await f.http('POST','/submissions/'+id+'/submit',{})).status,503);}
  finally{db.exec=exec;f.setBefore(undefined);}
  assert.equal(commitFaults,1);assert.equal(f.posts,0);
  const recovery=await f.http('GET','/submissions/'+id);assert.equal(recovery.status,200);
  assert.equal((await recovery.json() as {receipt:{state:string}}).receipt.state,'unknown');
  assert.equal((await f.http('POST','/submissions/'+id+'/submit',{})).status,200);assert.equal(f.posts,0);
}));
test('closed route refuses without re-opening owner or dispatch',()=>fixture(async f=>{
  const id=await preview(f);f.routes.close();const before=f.calls.length;
  assert.equal((await f.http('POST','/submissions/'+id+'/submit',{})).status,503);
  assert.equal(f.calls.length,before);assert.equal(f.posts,0);
}));
test('read timeout ends only HTTP wait; original pending admission survives until settlement',()=>fixture(async f=>{
  const gate=deferred();let value:unknown;f.setAfter((kind,input,result)=>{
    if(kind==='sessionGuidance'&&(input as {command:{action:string}}).command.action==='inspect'){value=result;return gate.promise;}return result;
  });
  const adapter=new AsyncHubMemberGuidance(f.owner,quiet,5,15),scope=await adapter.begin(f.request(),f.sessionId);
  await assert.rejects(scope.inspect(),e=>e instanceof HubMemberRequestError&&e.status===503);assert.equal(adapter.pending,1);
  gate.resolve(value);await tick();assert.equal(adapter.pending,0);assert.equal(f.posts,0);
}));
test('accepted claim has no synthetic deadline, only one permit after late ACK',()=>fixture(async f=>{
  const id=await preview(f),gate=deferred();let value:unknown;f.setAfter((kind,input,result)=>{
    if(kind==='sessionGuidance'&&(input as {command:{action:string}}).command.action==='claim'){value=result;return gate.promise;}return result;
  });
  const adapter=new AsyncHubMemberGuidance(f.owner,quiet,5,15),scope=await adapter.begin(f.request(),f.sessionId);
  let settled=false;const work=scope.claim(id).finally(()=>{settled=true;});await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(settled,false);assert.equal(adapter.pending,1);assert.equal(f.posts,0);
  gate.resolve(value);assert.equal((await work).claimed,true);assert.equal(adapter.pending,0);
  f.setAfter(undefined);assert.equal((await scope.claim(id)).claimed,false);
}));
test('mis-correlated worker ACK cannot publish success or obtain another permit',()=>fixture(async f=>{
  const id=await preview(f);f.setAfter((kind,input,result)=>kind==='sessionGuidance'&&(input as {command:{action:string}}).command.action==='claim'?{...(result as object),digest:'0'.repeat(64)}:result);
  assert.equal((await f.http('POST','/submissions/'+id+'/submit',{})).status,503);assert.equal(f.posts,0);
  f.setAfter(undefined);assert.equal((await f.http('POST','/submissions/'+id+'/submit',{})).status,200);assert.equal(f.posts,0);
}));
test('aborted read keeps original pending owner work until its late settlement',()=>fixture(async f=>{
  const controller=new AbortController(), gate=deferred(); let value:unknown;
  const request=new Request(f.request(),{signal:controller.signal});
  const adapter=new AsyncHubMemberGuidance(f.owner,quiet,5,1000), scope=await adapter.begin(request,f.sessionId);
  f.setAfter((kind,input,result)=>{
    if(kind==='sessionGuidance'&&(input as {command:{action:string}}).command.action==='inspect'){value=result;return gate.promise;}
    return result;
  });
  const work=scope.inspect(); void work.catch(()=>{}); await tick(); controller.abort();
  await assert.rejects(work,e=>e instanceof HubMemberRequestError&&e.status===499);
  assert.equal(adapter.pending,1); assert.equal(f.posts,0);
  gate.resolve(value); await tick(); assert.equal(adapter.pending,0);
}));
test('abort after claim COMMIT cannot cancel UNKNOWN or create another permit',()=>fixture(async f=>{
  const id=await preview(f), controller=new AbortController(), gate=deferred(); let value:unknown;
  const adapter=new AsyncHubMemberGuidance(f.owner,quiet,5,1000);
  const scope=await adapter.begin(new Request(f.request(),{signal:controller.signal}),f.sessionId);
  f.setAfter((kind,input,result)=>{
    if(kind==='sessionGuidance'&&(input as {command:{action:string}}).command.action==='claim'){value=result;return gate.promise;}
    return result;
  });
  const work=scope.claim(id); void work.catch(()=>{}); await tick(); controller.abort();
  assert.equal(adapter.pending,1); gate.resolve(value);
  await assert.rejects(work,e=>e instanceof HubMemberRequestError&&e.status===499);
  assert.equal(adapter.pending,0); f.setAfter(undefined);
  const fresh=await adapter.begin(f.request(),f.sessionId);
  const claim=await fresh.claim(id); assert.equal(claim.claimed,false); assert.equal(claim.receipt?.state,'unknown');
  assert.equal(f.posts,0);
}));
test('throwing HTTP diagnostics cannot change a committed send or receipt',()=>fixture(async f=>{
  const diag=new PerformanceDiagnostics(()=>{throw Error('private-observer-failure');});
  const app=new Hono(), routes=registerAsyncHubSessionGuidance(app,{
    guidance:new AsyncHubMemberGuidance(f.owner,diag),diagnostics:diag,connectorClient:()=>f.client(),
  });
  try {
    const id=await preview(f), response=await app.request(f.request('POST','/submissions/'+id+'/submit',{}));
    assert.equal(response.status,200); assert.equal((await response.json() as {receipt:{state:string}}).receipt.state,'submitted');
    assert.equal((await app.request(f.request('POST','/submissions/'+id+'/submit',{}))).status,200);
    assert.equal(f.posts,1); assert.equal(f.gets,0);
  } finally {routes.close();}
}));
test('real async Hub worker preserves original HTTP receipt through lost ACK and same-data reopen',()=>fixture(async f=>{
  f.routes.close(); await f.store.close();
  let owner=new AsyncHubMemberOwner({file:f.path,encryptionSecret:'fixture'},quiet);
  let app=new Hono(), routes=registerAsyncHubSessionGuidance(app,{
    guidance:new AsyncHubMemberGuidance(owner,quiet),diagnostics:quiet,connectorClient:()=>f.client(),
  });
  const http=(method='GET',suffix='',body?:unknown)=>app.request(f.request(method,suffix,body));
  try {
    assert.equal((await http('PUT','',{revision:0,text:'Worker guidance',enabled:true})).status,200);
    const id=randomUUID();
    assert.equal((await http('POST','/submissions',{requestId:id,revision:1,input:'Worker input'})).status,201);
    f.lost(); const submitted=await http('POST','/submissions/'+id+'/submit',{});
    assert.equal(submitted.status,200); assert.equal((await submitted.json() as {receipt:{state:string}}).receipt.state,'unknown');
    assert.equal(f.posts,1); routes.close(); await owner.close();
    owner=new AsyncHubMemberOwner({file:f.path,encryptionSecret:'fixture'},quiet); app=new Hono();
    routes=registerAsyncHubSessionGuidance(app,{guidance:new AsyncHubMemberGuidance(owner,quiet),diagnostics:quiet,connectorClient:()=>f.client()});
    f.online(); const recovered=await http('GET','/submissions/'+id);
    assert.equal(recovered.status,200); assert.equal((await recovered.json() as {receipt:{state:string}}).receipt.state,'submitted');
    assert.equal((await http('POST','/submissions/'+id+'/submit',{})).status,200);
    assert.equal(f.posts,1); assert.deepEqual(f.messages,['Worker guidance\n\nWorker input']);
  } finally {routes.close(); await owner.close();}
}));

test('parallel explicit submissions retain one original sending permit',()=>fixture(async f=>{
  const id=await preview(f);
  const responses=await Promise.all(Array.from({length:8},()=>f.http('POST','/submissions/'+id+'/submit',{})));
  assert.ok(responses.every(response=>response.status===200));
  assert.equal(f.posts,1);
  const receipt=await f.http('GET','/submissions/'+id);
  assert.equal((await receipt.json() as {receipt:{state:string}}).receipt.state,'submitted');
}));

test('close during the original committed claim suppresses dispatch without releasing UNKNOWN',()=>fixture(async f=>{
  const id=await preview(f), gate=deferred(); let entered=false, value:unknown;
  f.setAfter((kind,input,result)=>{
    if(kind==='sessionGuidance'&&(input as {command:{action:string}}).command.action==='claim'){
      entered=true; value=result; return gate.promise;
    }
    return result;
  });
  const work=f.http('POST','/submissions/'+id+'/submit',{});
  try {
    for(let i=0;i<100&&!entered;i++) await tick();
    assert.equal(entered,true); f.routes.close(); gate.resolve(value);
    assert.equal((await work).status,503); assert.equal(f.posts,0);
    f.setAfter(undefined); await f.reopen();
    assert.equal((await f.http('POST','/submissions/'+id+'/submit',{})).status,200);
    assert.equal(f.posts,0);
    assert.equal((await (await f.http('GET','/submissions/'+id)).json() as {receipt:{state:string}}).receipt.state,'unknown');
  } finally {gate.resolve(value); await work;}
}));

test('a resolver for another node cannot send or reconcile the original UNKNOWN receipt',()=>fixture(async f=>{
  const id=await preview(f), app=new Hono(); let sends=0;
  const routes=registerAsyncHubSessionGuidance(app,{guidance:f.guidance,diagnostics:quiet,
    connectorClient:()=>new ConnectorClient('http://fixture.invalid','fixture',async()=>{
      sends++; throw Error('wrong-node-must-not-be-contacted');
    },1000,1024,{nodeId:'node_'+randomUUID()}),
  });
  try {
    const response=await app.request(f.request('POST','/submissions/'+id+'/submit',{}));
    assert.equal(response.status,200);
    assert.equal((await response.json() as {receipt:{state:string}}).receipt.state,'unknown');
    assert.equal(sends,0); assert.equal(f.posts,0);
    assert.equal((await f.http('POST','/submissions/'+id+'/submit',{})).status,200); assert.equal(f.posts,0);
  } finally {routes.close();}
}));

for(const fault of ['start','add','finish'] as const) test('HTTP '+fault+' observer fault cannot lose a receipt or regrant its permit',()=>fixture(async f=>{
  const diagnostics=new PerformanceDiagnostics(()=>{});
  diagnostics.start=()=>{
    if(fault==='start') throw Error('private-observer-start');
    return {
      add(){if(fault==='add') throw Error('private-observer-add');},
      reportPending(){}, finish(){if(fault==='finish') throw Error('private-observer-finish');},
    };
  };
  const id=await preview(f), app=new Hono();
  const routes=registerAsyncHubSessionGuidance(app,{guidance:f.guidance,diagnostics,connectorClient:()=>f.client()});
  try {
    const response=await app.request(f.request('POST','/submissions/'+id+'/submit',{}));
    assert.equal(response.status,200);
    assert.equal((await response.json() as {receipt:{state:string}}).receipt.state,'submitted');
    assert.equal((await app.request(f.request('POST','/submissions/'+id+'/submit',{}))).status,200);
    assert.equal(f.posts,1);
  } finally {routes.close();}
}));
