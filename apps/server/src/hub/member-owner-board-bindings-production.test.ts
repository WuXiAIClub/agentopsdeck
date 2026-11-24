import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { CONNECTOR_PROTOCOL, CONNECTOR_PROTOCOL_HEADER } from '@agentopsdeck/shared';
import { HubStore } from './hub-store.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { OriginalHubAdministrativeCommands } from './original-administrative-commands.js';
import { createHubAdministrativeServices } from './administrative-route-services.js';
import { createAsyncConnectorClientResolver } from './async-connector-client.js';
import { hubMemberEvidence, validHubMemberInput, validHubMemberOutput } from './member-owner-domain.js';
import { encodeHubSessionId } from './session-id.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { NODE_ID_HEADER } from '../connector/node-identity.js';
import { registerConnectorBoardBindings } from '../connector/board-bindings-http.js';
import { registerHubRoutes } from '../routes/hub.js';
import { isAsyncHubWorkspaceBoardRequest } from '../routes/hub-workspace-boards.js';
import { loadConfig } from '../config.js';

const base = '/api/hub/v1/workspace/boards/default/bindings';
const endpoint = 'https://hub.example/api/workspace-agent/v1/board';
const runtimes = ['codex','claude-code','ghcp'] as const;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise,resolve }; }

test('async private board selector admits only the complete human editor package', () => {
  const board = '/api/hub/v1/workspace/boards/default';
  for (const method of ['GET','HEAD']) for (const path of [board,board+'/summary',board+'/capabilities',board+'/audit','/api/hub/v1/workspace/boards'])
    assert.equal(isAsyncHubWorkspaceBoardRequest(method,path),true,method+' '+path);
  for (const [method,path] of [['PUT',board],['POST',board+'/capabilities'],['DELETE',board+'/capabilities/id']])
    assert.equal(isAsyncHubWorkspaceBoardRequest(method!,path!),true);
  for (const method of ['GET','HEAD','POST','PUT','DELETE','PATCH']) for (const suffix of ['/unknown','/capabilities/id/extra','/bindings','/file-binding','/delegations','/task-sessions'])
    assert.equal(isAsyncHubWorkspaceBoardRequest(method,board+suffix),false,method+' '+suffix);
  for (const [method,path] of [['PATCH',board],['DELETE',board],['POST',board],['GET',board+'/capabilities/id'],['POST',board+'/audit']])
    assert.equal(isAsyncHubWorkspaceBoardRequest(method!,path!),false);
});

/** Real five-API Hub registration, private Connector binding workers and
 * original/worker SQL. Request-time synchronous reads are forbidden. */
async function fixture(t: TestContext, mode: 'original' | 'worker', noResolver = false, sharedSession = false) {
  const root = mkdtempSync(join(tmpdir(),'binding-production-')), file = join(root,'hub.sqlite');
  const node = 'node_'+randomUUID(), task = randomUUID(), native = randomUUID();
  const tokens = new ConnectorTokenStore(join(root,'tokens.json')), token = tokens.createTransient(['boards:bind'],'hub-token');
  const seed = new HubStore(file,'fixture');
  (seed as unknown as { db: DatabaseSync }).db.prepare("INSERT INTO hub_roles VALUES ('default','admin',1)").run();
  const admin = seed.identities.issueKey('default'), member = seed.createUser('Member'), other = seed.createUser('Other');
  const key = seed.identities.issueKey(member.id), second = seed.identities.issueKey(member.id), cookie = seed.identities.createSession(key.token)!;
  const otherKey = seed.identities.issueKey(other.id);
  seed.upsertConnection({id:'node',label:'Node',ownerUserId:member.id,connectorUrl:'http://binding-connector.invalid',credentialToken:token.token});
  seed.pinConnectionNode('node',member.id,seed.connectionAuthority('node',member.id)!,node);
  seed.boards.save(member.id,'default',{title:'Board',revision:0,mutationId:randomUUID(),tasks:[{id:task,title:'Task',detail:'',status:'todo'}]});
  if (sharedSession) {
    const target = {ownerUserId:member.id,connectionId:'node',userId:other.id};
    seed.roles.save({userId:'default',admin:true},target,{...seed.roles.membership(target),role:'developer',migrateLegacy:true,
      nodeVersion:seed.connectionAuthority('node',member.id)!,environments:{codex:'developer',openclaw:'disabled'}});
    const creator = {...target,userId:member.id}, sessionKey = 'codex:PRIVATE_SESSION';
    seed.grants.create(creator,{runtime:'codex',actions:['sessions:create']});
    const creation = seed.grants.authorize(creator,'sessions:create',{runtime:'codex'}); assert.ok(creation);
    seed.grants.acceptCreatedSession(creation,sessionKey,randomUUID(),randomUUID(),() => {});
    const share = seed.grants.authorize(creator,'sessions:share',{runtime:'codex',sessionKey}); assert.ok(share);
    seed.grants.shareSession(share,other.id,'collaborator',{media:true});
    assert.ok(seed.grants.authorize(target,'messages:send',{runtime:'codex',sessionKey}), 'real effective collaborator, not an unauthorised stranger');
    assert.equal(seed.grants.authorize(target,'messages:send',{runtime:'codex',sessionKey:'codex:OTHER'}),undefined);
  }
  await seed.close();
  const directories = Object.fromEntries(runtimes.map(runtime => {
    const directory = join(root,runtime); mkdirSync(directory,{mode:0o700}); return [runtime,directory];
  }));
  const connector = new Hono();
  connector.use('*',async (c,next) => { await next(); c.header(CONNECTOR_PROTOCOL_HEADER,String(CONNECTOR_PROTOCOL.max)); c.header(NODE_ID_HEADER,node); });
  const bindings = registerConnectorBoardBindings(connector,{tokens,directories,policies:runtimes.map(runtime => ({owner:'hub-token',runtime,endpoint})),
    resolveSession: key => {
      const runtime = runtimes.find(runtime => key === runtime+':PRIVATE_SESSION');
      return runtime ? {runtime,sessionId:native,ready:true} : undefined;
    }});
  await bindings.ready;
  const behavior: { puts:number; gets:number; deletes:number; sync:number; resolving?: () => Promise<void>;
    before?: (request:Request) => Promise<void>; after?: (request:Request,response:Response) => Response | Promise<Response> } = {puts:0,gets:0,deletes:0,sync:0};
  t.mock.method(globalThis,'fetch',async (input: string | URL | Request,init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input,init);
    assert.equal(new URL(request.url).hostname,'binding-connector.invalid','no real network');
    assert.equal(request.headers.get('authorization'),'Bearer '+token.token);
    await behavior.before?.(request);
    if (request.method === 'PUT') behavior.puts++; else if (request.method === 'GET') behavior.gets++; else if (request.method === 'DELETE') behavior.deletes++;
    const response = await connector.request(request);
    return behavior.after ? behavior.after(request,response) : response;
  });
  const logs: string[] = [], diagnostics = new PerformanceDiagnostics(line => { logs.push(line); });
  const mount = () => {
    const metadata = new HubStore(mode === 'original' ? file : join(root,'composition.sqlite'),'fixture');
    const owner = mode === 'original' ? new OriginalHubAdministrativeCommands(metadata,diagnostics) : new AsyncHubMemberOwner({file,encryptionSecret:'fixture'},diagnostics);
    const group = createHubAdministrativeServices(owner,diagnostics), resolver = createAsyncConnectorClientResolver(owner,undefined,diagnostics);
    let guarded = false;
    const store = new Proxy(metadata,{get(target,p,receiver) {
      if (guarded) { behavior.sync++; throw Error('SYNC_BINDING_STORE'); } return Reflect.get(target,p,receiver);
    }});
    const app = new Hono(), config = {...loadConfig({HOME:root,AOD_SERVER_ROLE:'hub'}),boardAgentEndpoint:endpoint};
    const routes = registerHubRoutes(app,{config,hubStore:store,administrative:group,
      principal: () => { behavior.sync++; throw Error('SYNC_BINDING_PRINCIPAL'); },
      connectorClient: () => { behavior.sync++; throw Error('SYNC_BINDING_RESOLVER'); },
      // Enable the complete native editor composition for cross-domain tests;
      // no request may actually fall back to this legacy synchronous transport.
      ...(sharedSession ? {fileCardClient: () => { behavior.sync++; throw Error('SYNC_BINDING_FILE_CARD'); }} : {}),
      ...(!noResolver ? {asyncConnectorClient:async (...args:Parameters<typeof resolver>) => { await behavior.resolving?.(); return resolver(...args); }} : {}),
      normalizeError: () => 'safe'});
    guarded = true; assert.ok(routes);
    return {app,owner,close: () => routes.close(),dispose:async () => {
      guarded = false; await routes.close(); await group.close(); await resolver.close(); await owner.close(); await metadata.close();
    }};
  };
  let current = mount();
  t.after(async () => {
    await current.dispose(); await bindings.close(); token.dispose();
    for (const secret of [key.token,second.token,cookie,otherKey.token,token.token,'PRIVATE_SESSION',task,native])
      assert.equal(logs.join('').includes(secret),false,'private diagnostic data');
    assert.equal(behavior.sync,0,'no synchronous request-time bypass');
    rmSync(root,{recursive:true,force:true});
  });
  const request = (method:string,suffix='',body?:unknown,headers:Record<string,string>={'x-agentopsdeck-key':key.token},signal?:AbortSignal) =>
    current.app.fetch(new Request('http://hub.invalid'+base+suffix,{method,headers,...(signal ? {signal} : {}),...(body === undefined ? {} : {body:JSON.stringify(body)})}));
  const proof = async (value:string) => {
    const evidence = hubMemberEvidence(new Request('http://hub.invalid',{headers:{'x-agentopsdeck-key':value}}));
    const snapshot = await current.owner.command('memberSnapshot',evidence); assert.ok(snapshot); return {evidence,expectedScope:snapshot.recoveryScope};
  };
  return {behavior,key,second,cookie,otherKey,request,
    hubRequest: (path:string,init?:RequestInit) => current.app.fetch(new Request('http://hub.invalid'+path,init)),
    input: (runtime:typeof runtimes[number]='codex') => ({requestId:randomUUID(),sessionId:encodeHubSessionId('node',runtime+':PRIVATE_SESSION'),grant:{taskIds:[task],fields:['status'],expiresAt:Date.now()+300_000}}),
    command: async (command: Parameters<typeof current.owner.command<'boardBinding'>>[1]['command']) => current.owner.command('boardBinding',{...await proof(second.token),command}),
    revoke: async () => current.owner.command('memberKeyRevoke',{...await proof(admin.token),userId:member.id,keyId:key.id}),
    change: async () => {
      const p = await proof(second.token), target = await current.owner.command('connectionTarget',{...p,id:'node'}); assert.ok(target && 'epoch' in target);
      const result = await current.owner.command('connectionChange',{...p,change:{action:'patch',id:'node',expectedEpoch:target.epoch,configuration:{enabled:false}}}); assert.ok(result && !('error' in result));
    },
    removeRemote: (runtime:typeof runtimes[number],id:string) => connector.request(`/api/connector/v1/sessions/${encodeURIComponent(runtime+':PRIVATE_SESSION')}/board-binding/${id}`,{method:'DELETE',headers:{authorization:'Bearer '+token.token}}),
    close: () => current.close(), reopen:async () => { await current.dispose(); current = mount(); }};
}

for (const mode of ['original','worker'] as const) {
  test(`${mode} real collaborator grant cannot inherit the creator's board, machine capability or native binding`,async t => {
    const f = await fixture(t,mode,false,true), input = f.input(), headers = {'x-agentopsdeck-key':f.otherKey.token};
    const installed = await f.request('POST','',input); assert.equal(installed.status,201);
    const binding = (await installed.json()).binding; assert.equal(binding.state,'installed');
    const counts = {puts:f.behavior.puts,gets:f.behavior.gets,deletes:f.behavior.deletes};
    const boardPath = '/api/hub/v1/workspace/boards/default';
    const ownBoard = await f.hubRequest(boardPath,{headers}); assert.equal(ownBoard.status,200);
    const document = await ownBoard.json(); assert.equal(document.revision,0); assert.deepEqual(document.tasks,[]);
    assert.equal(ownBoard.headers.get('cache-control'),'no-store');
    const head = await f.hubRequest(boardPath,{method:'HEAD',headers}); assert.equal(head.status,200); assert.equal(await head.text(),'');
    for (const path of [boardPath,boardPath+'/summary',boardPath+'/capabilities',boardPath+'/audit','/api/hub/v1/workspace/boards']) {
      for (const token of ['hub_key_invalid','aod_board_synthetic']) {
        const denied = await f.hubRequest(path,{headers:{'x-agentopsdeck-key':token,cookie:'agentopsdeck_session='+f.cookie}});
        assert.equal(denied.status,401,'invalid Hub key/machine credential cannot fall back to valid owner cookie');
      }
      assert.equal((await f.hubRequest(path,{headers:{...headers,'x-agentopsdeck-recovery-scope':'wrong'}})).status,409);
    }
    const capabilities = await f.hubRequest(boardPath+'/capabilities',{headers}); assert.equal(capabilities.status,200);
    assert.deepEqual(await capabilities.json(),{capabilities:[]});
    const forged = await f.hubRequest(boardPath+'/capabilities',{method:'POST',headers,body:JSON.stringify(input.grant)});
    assert.equal(forged.status,409,'shared conversation does not grant another user\'s task IDs');
    assert.equal((await f.hubRequest(boardPath+'/capabilities/'+binding.capabilityId,{method:'DELETE',headers})).status,404);
    const listed = await f.request('GET','',undefined,headers); assert.equal(listed.status,200);
    assert.deepEqual((await listed.json()).bindings,[]);
    assert.equal((await f.request('GET','/'+input.requestId,undefined,headers)).status,404);
    assert.equal((await f.request('DELETE','/'+input.requestId,undefined,headers)).status,404);
    assert.equal((await f.request('POST','',input,headers)).status,404,'shared session is not an owned connection for native binding');
    const cancelled = await f.request('POST','/'+input.requestId+'/cancel-intent',{},headers); assert.equal(cancelled.status,200);
    assert.equal((await cancelled.json()).binding,null,'cancellation tombstone is scoped to its original human owner');
    assert.deepEqual({puts:f.behavior.puts,gets:f.behavior.gets,deletes:f.behavior.deletes},counts,'no foreign connector effects');
    const original = await f.request('GET','/'+input.requestId); assert.equal(original.status,200);
    assert.equal((await original.json()).binding.state,'installed','foreign cancel/revoke cannot alter the original binding');
    await f.reopen();
    const reopened = await f.request('GET','/'+input.requestId); assert.equal(reopened.status,200);
    assert.equal((await reopened.json()).binding.state,'installed');
    assert.equal((await f.request('GET','/'+input.requestId,undefined,headers)).status,404);
    const ownerHeaders = {'x-agentopsdeck-key':f.key.token};
    const originalBoard = await f.hubRequest(boardPath,{headers:ownerHeaders}); assert.equal(originalBoard.status,200);
    assert.deepEqual((await originalBoard.json()).tasks.map((task:{id:string}) => task.id),input.grant.taskIds);
    const originalCaps = await f.hubRequest(boardPath+'/capabilities',{headers:ownerHeaders}); assert.equal(originalCaps.status,200);
    assert.equal((await originalCaps.json()).capabilities.find((cap:{id:string}) => cap.id === binding.capabilityId).revokedAt,null);
    await f.revoke();
    for (const suffix of ['', '/summary','/capabilities','/audit'])
      assert.equal((await f.hubRequest(boardPath+suffix,{headers:ownerHeaders})).status,401,'revoked original credential cannot deliver board data');
  });

  test(`${mode} board bindings five production entries and three original credentials/runtimes`,async t => {
    const f = await fixture(t,mode);
    for (const headers of [{'x-agentopsdeck-key':f.key.token},{authorization:'Bearer '+f.key.token},{cookie:'agentopsdeck_session='+f.cookie}]) {
      for (const runtime of runtimes) {
        const input = f.input(runtime), created = await f.request('POST','',input,headers);
        assert.equal(created.status,201,await created.clone().text());
        const body = await created.json(); assert.equal(body.binding.state,'installed');
        assert.equal(JSON.stringify(body).includes('aod_board_'),false);
        const puts = f.behavior.puts, gets = f.behavior.gets;
        const repeated = await f.request('POST','',input,headers); assert.equal(repeated.status,200); assert.equal((await repeated.json()).repeated,true);
        assert.equal(f.behavior.puts,puts); assert.equal(f.behavior.gets,gets);
        assert.equal((await f.request('GET','/'+input.requestId,undefined,headers)).status,200);
        const list = await f.request('GET','',undefined,headers); assert.equal(list.status,200); assert.equal((await list.json()).enabled,true);
        const removed = await f.request('DELETE','/'+input.requestId,undefined,headers); assert.equal(removed.status,200);
        const revoked = await removed.json(); assert.equal(revoked.binding.state,'revoked'); assert.equal(revoked.cleanup,'confirmed');
        const cancelled = await f.request('POST','/'+input.requestId+'/cancel-intent',{},headers); assert.equal(cancelled.status,200);
        assert.equal((await cancelled.json()).cancelled,true);
      }
    }
    assert.equal(f.behavior.puts,9); assert.equal(f.behavior.deletes,9);
  });

  test(`${mode} board binding UNKNOWN physical reopen recovers only GET and explicit absence clears installed`,async t => {
    const f = await fixture(t,mode), input = f.input();
    f.behavior.after = async (request,response) => { if (request.method === 'PUT') { await response.body?.cancel(); throw Error('PRIVATE_LOST_ACK'); } return response; };
    const lost = await f.request('POST','',input); assert.equal(lost.status,202); assert.equal((await lost.json()).binding.state,'uncertain');
    assert.equal(f.behavior.puts,1); await f.reopen(); delete f.behavior.after;
    const repeated = await f.request('POST','',input); assert.equal(repeated.status,200); assert.equal((await repeated.json()).binding.state,'uncertain');
    const recovered = await f.request('GET','/'+input.requestId); assert.equal(recovered.status,200); assert.equal((await recovered.json()).binding.state,'installed');
    await f.removeRemote('codex',input.requestId);
    const absent = await f.request('GET','/'+input.requestId); assert.equal(absent.status,200); assert.equal((await absent.json()).binding.state,'uncertain');
    assert.equal(f.behavior.puts,1);
  });

  test(`${mode} board binding cancel tombstone precedes delayed discovery and survives reopen`,async t => {
    const f = await fixture(t,mode), input = f.input(), entered = deferred(), release = deferred();
    f.behavior.before = async request => { if (request.method === 'GET') { entered.resolve(); await release.promise; } };
    const post = f.request('POST','',input); await entered.promise;
    try {
      const cancelled = await f.request('POST','/'+input.requestId+'/cancel-intent',{}); assert.equal(cancelled.status,200); assert.equal((await cancelled.json()).binding,null);
    } finally { release.resolve(); }
    assert.equal((await post).status,409); assert.equal(f.behavior.puts,0);
    delete f.behavior.before; await f.reopen(); assert.equal((await f.request('POST','',input)).status,409); assert.equal(f.behavior.puts,0);
  });

  test(`${mode} board binding late install ACK cannot overwrite revoked or yield credential twice`,async t => {
    const f = await fixture(t,mode), input = f.input(), entered = deferred(), release = deferred();
    f.behavior.after = async (request,response) => { if (request.method === 'PUT') { entered.resolve(); await release.promise; } return response; };
    const post = f.request('POST','',input); await entered.promise;
    try {
      assert.equal((await f.request('POST','',input)).status,409,'concurrent owner/session refused');
      const cancelled = await f.request('POST','/'+input.requestId+'/cancel-intent',{}); assert.equal(cancelled.status,200); assert.equal((await cancelled.json()).binding.state,'revoked');
    } finally { release.resolve(); }
    const result = await post; assert.equal(result.status,201); assert.equal((await result.json()).binding.state,'revoked');
    const target = await f.command({action:'target',boardId:'default',sessionId:input.sessionId}); assert.ok(target && 'target' in target);
    const claim = await f.command({action:'claim',boardId:'default',id:input.requestId,target:target.target}); assert.ok(claim && 'credential' in claim); assert.equal(claim.credential,null);
    assert.equal(f.behavior.puts,1);
  });

  test(`${mode} board binding invalid evidence/scope/body and missing resolver never sync-fallback`,async t => {
    const f = await fixture(t,mode,true), input = f.input();
    assert.equal((await f.request('POST','',input,{authorization:'Bearer aod_board_untrusted'})).status,401);
    assert.equal((await f.request('POST','',input,{'x-agentopsdeck-key':f.key.token,'x-agentopsdeck-recovery-scope':'stale'})).status,409);
    assert.equal((await f.request('POST','',{...input,owner:'default'})).status,400);
    assert.equal((await f.request('POST','',{...input,sessionId:'invalid'})).status,400);
    assert.equal((await f.request('POST','',input)).status,503);
    assert.equal((await f.request('POST','/'+input.requestId+'/cancel-intent?bad=1',{})).status,400);
    assert.equal((await f.request('POST','/'+input.requestId+'/cancel-intent',{owner:'default'})).status,400);
    assert.equal(f.behavior.puts+f.behavior.gets,0);
  });

  for (const mutation of ['revoke','epoch'] as const) {
    test(`${mode} board binding ${mutation} during resolver prevents all remote effects`,async t => {
      const f = await fixture(t,mode);
      f.behavior.resolving = async () => { await (mutation === 'revoke' ? f.revoke() : f.change()); };
      assert.ok((await f.request('POST','',f.input())).status >= 400); assert.equal(f.behavior.puts+f.behavior.gets,0);
    });
    test(`${mode} board binding ${mutation} during lost PUT ACK takes priority over UNKNOWN delivery`,async t => {
      const f = await fixture(t,mode), input = f.input();
      f.behavior.after = async (request,response) => {
        if (request.method === 'PUT') { await response.body?.cancel(); await (mutation === 'revoke' ? f.revoke() : f.change()); throw Error('PRIVATE_LOST_ACK'); }
        return response;
      };
      const response = await f.request('POST','',input); assert.ok(response.status >= 400); assert.equal(f.behavior.puts,1);
      assert.equal((await response.text()).includes('PRIVATE_'),false);
    });
  }

  test(`${mode} board binding closes only after original PUT ACK and freezes late delivery`,async t => {
    const f = await fixture(t,mode), input = f.input(), entered = deferred(), release = deferred();
    f.behavior.after = async (request,response) => { if (request.method === 'PUT') { entered.resolve(); await release.promise; } return response; };
    const post = f.request('POST','',input); await entered.promise;
    const closing = f.close(); let closed = false; void closing.then(() => { closed = true; });
    try { await tick(); assert.equal(closed,false); assert.equal((await f.request('GET')).status,503); }
    finally { release.resolve(); }
    assert.equal((await post).status,503); await closing; await f.reopen(); delete f.behavior.after;
    const result = await f.request('GET','/'+input.requestId); assert.equal(result.status,200); assert.equal((await result.json()).binding.state,'installed'); assert.equal(f.behavior.puts,1);
  });

  test(`${mode} board binding aborted installation retains original receipt and never replays`,async t => {
    const f = await fixture(t,mode), input = f.input(), entered = deferred(), release = deferred(), controller = new AbortController();
    f.behavior.after = async (request,response) => {
      if (request.method === 'PUT') { entered.resolve(); await release.promise; }
      return response;
    };
    const post = f.request('POST','',input,undefined,controller.signal); await entered.promise;
    try {
      controller.abort(); await tick();
      assert.equal((await f.request('POST','',input)).status,409,'abort does not release original operation');
    } finally { release.resolve(); }
    assert.equal((await post).status,499);
    delete f.behavior.after; await f.reopen();
    const repeated = await f.request('POST','',input); assert.equal(repeated.status,200);
    assert.equal((await repeated.json()).binding.state,'uncertain'); assert.equal(f.behavior.puts,1);
    const recovered = await f.request('GET','/'+input.requestId);
    assert.equal(recovered.status,200); assert.equal((await recovered.json()).binding.state,'installed'); assert.equal(f.behavior.puts,1);
  });

  test(`${mode} board binding capacity owns 16 original GETs without queueing excess work`,async t => {
    const f = await fixture(t,mode), input = f.input(); assert.equal((await f.request('POST','',input)).status,201);
    const entered = deferred(), release = deferred(); let active = 0;
    f.behavior.before = async request => {
      if (request.method === 'GET') { if (++active === 16) entered.resolve(); await release.promise; }
    };
    const reads = Array.from({length:16},() => f.request('GET','/'+input.requestId));
    try {
      await entered.promise;
      assert.equal((await f.request('GET','/'+input.requestId)).status,503); assert.equal(active,16);
    } finally { release.resolve(); }
    for (const response of await Promise.all(reads)) assert.equal(response.status,200);
    delete f.behavior.before;
    assert.equal((await f.request('GET')).status,200,'capacity is recovered only after original completion');
    assert.equal(f.behavior.puts,1);
  });

  test(`${mode} board binding malformed installation ACK stays uncertain and recovery is read-only`,async t => {
    const f = await fixture(t,mode), input = f.input();
    f.behavior.after = async (request,response) => {
      if (request.method !== 'PUT') return response;
      const body = await response.json(); body.binding.id = randomUUID();
      return new Response(JSON.stringify(body),{headers:response.headers,status:response.status});
    };
    const post = await f.request('POST','',input); assert.equal(post.status,202); assert.equal((await post.json()).binding.state,'uncertain');
    delete f.behavior.after;
    assert.equal((await f.request('GET','/'+input.requestId)).status,200); assert.equal(f.behavior.puts,1);
    f.behavior.after = async (request,response) => {
      if (request.method !== 'GET') return response;
      await response.body?.cancel();
      return new Response(JSON.stringify({runtime:'PRIVATE_REFLECTION',sessionId:'not-a-session',binding:null}),{headers:response.headers});
    };
    const malformed = await f.request('GET','/'+input.requestId); assert.equal(malformed.status,502);
    assert.equal((await malformed.text()).includes('PRIVATE_REFLECTION'),false); assert.equal(f.behavior.puts,1);
    delete f.behavior.after;
    assert.equal((await f.request('GET','/'+input.requestId)).status,200);
  });

  test(`${mode} saturated binding effects retain bounded cancellation and revocation admission`,async t => {
    const f = await fixture(t,mode), input = f.input(); assert.equal((await f.request('POST','',input)).status,201);
    const entered = deferred(), release = deferred(); let active = 0;
    f.behavior.before = async request => {
      if (request.method === 'GET') { if (++active === 16) entered.resolve(); await release.promise; }
    };
    const reads = Array.from({length:16},() => f.request('GET','/'+input.requestId));
    try {
      await entered.promise;
      assert.equal((await f.request('GET')).status,503);
      const cancel = await f.request('POST','/'+input.requestId+'/cancel-intent',{});
      assert.equal(cancel.status,200); assert.equal((await cancel.json()).binding.state,'revoked');
      const revoked = await f.request('DELETE','/'+input.requestId);
      assert.equal(revoked.status,200); assert.equal((await revoked.json()).cleanup,'confirmed');
    } finally { release.resolve(); }
    for (const response of await Promise.all(reads)) {
      assert.equal(response.status,200); assert.equal((await response.json()).binding.state,'revoked','late GET cannot resurrect');
    }
    delete f.behavior.before; await f.reopen();
    assert.equal((await (await f.request('GET','/'+input.requestId)).json()).binding.state,'revoked');
    assert.equal(f.behavior.puts,1);
  });

  test(`${mode} binding control reserve is bounded and close drains both original lanes`,async t => {
    const f = await fixture(t,mode), input = f.input(); assert.equal((await f.request('POST','',input)).status,201);
    const readsEntered = deferred(), controlsEntered = deferred(), releaseReads = deferred(), releaseControls = deferred();
    let readsActive = 0, controlsActive = 0, closed = false;
    f.behavior.before = async request => {
      if (request.method === 'GET') { if (++readsActive === 16) readsEntered.resolve(); await releaseReads.promise; }
      if (request.method === 'DELETE') { if (++controlsActive === 4) controlsEntered.resolve(); await releaseControls.promise; }
    };
    const reads = Array.from({length:16},() => f.request('GET','/'+input.requestId));
    let controls: Promise<Response>[] = [], closing: Promise<void> | undefined;
    try {
      await readsEntered.promise;
      controls = Array.from({length:4},() => Promise.resolve(f.request('DELETE','/'+input.requestId))); await controlsEntered.promise;
      assert.equal((await f.request('POST','/'+input.requestId+'/cancel-intent',{})).status,503);
      assert.equal(controlsActive,4,'control work never queues beyond its reserve');
      const receipt = await f.command({action:'read',boardId:'default',id:input.requestId});
      assert.ok(receipt && 'action' in receipt); assert.equal(receipt.action,'read');
      closing = f.close(); void closing.then(() => { closed = true; });
      assert.equal((await f.request('GET')).status,503);
      assert.equal((await f.request('DELETE','/'+input.requestId)).status,503);
      releaseReads.resolve();
      for (const response of await Promise.all(reads)) assert.equal(response.status,503);
      await tick(); assert.equal(closed,false,'control transport remains owned after effect lane drains');
    } finally { releaseReads.resolve(); releaseControls.resolve(); }
    for (const response of await Promise.all(controls)) assert.equal(response.status,503);
    await closing; delete f.behavior.before; await f.reopen();
    assert.equal((await (await f.request('GET','/'+input.requestId)).json()).binding.state,'revoked');
    assert.equal(f.behavior.puts,1);
  });
}

test('board binding fixed RPC refuses untrusted owner/SQL/credential and reflection',() => {
  const input = {evidence:{accessKey:'hub_key_fixture'},expectedScope:'a'.repeat(64),command:{action:'list',boardId:'default'}};
  assert.equal(validHubMemberInput('boardBinding',input),true);
  for (const extra of [{owner:'default'},{authorized:true},{sql:'SELECT 1'},{credential:{token:'private'}}])
    assert.equal(validHubMemberInput('boardBinding',{...input,command:{...input.command,...extra}}),false);
  assert.equal(validHubMemberOutput('boardBinding',{action:'list',enabled:true,bindings:[]}),true);
  assert.equal(validHubMemberOutput('boardBinding',{action:'list',enabled:true,bindings:[],credential:'private'}),false);
});
