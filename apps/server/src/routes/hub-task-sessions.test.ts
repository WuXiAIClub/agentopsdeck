import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { CONNECTOR_PROTOCOL, CONNECTOR_PROTOCOL_HEADER } from '@agentopsdeck/shared';
import { HubStore } from '../hub/hub-store.js';
import { ConnectorClient } from '../hub/connector-client.js';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { CommandReceipts } from '../commands/receipts.js';
import { registerCreationReceipts } from '../commands/http.js';
import { registerConnectorBoardBindings } from '../connector/board-bindings-http.js';
import { registerHubTaskSessions } from './hub-task-sessions.js';

async function fixture(t: { after: (fn: () => unknown) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'task-session-http-')), directory = join(root, 'private'); await mkdir(directory, { mode: 0o700 });
  let store = new HubStore(join(root, 'hub.sqlite'), 'synthetic'), app = new Hono();
  const connector = new Hono(), db = new DatabaseSync(join(root, 'connector.sqlite')), commands = new CommandReceipts(db);
  const owner = store.createUser('Alice').id, other = store.createUser('Bob').id, task = randomUUID();
  const endpoint = 'https://hub.example/api/workspace-agent/v1/board';
  store.boards.save(owner, 'default', { revision: 0, mutationId: randomUUID(), title: 'Board', tasks: [{ id: task, title: 'Task', detail: 'Private task', status: 'todo' }] });
  store.upsertConnection({ id: 'dev', ownerUserId: owner, label: 'Dev', connectorUrl: 'https://connector.example' });
  store.pinConnectionNode('dev', owner, store.connectionAuthority('dev', owner)!, `node_${randomUUID()}`);
  const sessions = new Map<string,string>();
  const tokens = new ConnectorTokenStore(join(root, 'tokens.json')), token = tokens.createTransient(['boards:bind','sessions:create'], 'hub-token');
  connector.use('*', async (c, next) => { await next(); c.header(CONNECTOR_PROTOCOL_HEADER, String(CONNECTOR_PROTOCOL.max)); });
  let puts = 0, creates = 0, dropCreation = false, dropBinding = false, revokeDuringRead = false;
  let models = ['synthetic-model'], revokeDuringModels = false;
  connector.get('/api/connector/v1/models/:runtime', c => c.json({ models: models.map(id=>({id,label:id})) }));
  const path = '/api/connector/v1/agents/:agentId/sessions';
  registerCreationReceipts(connector, path, { receipts: commands, scope: c => JSON.stringify(['test-token', c.req.param('agentId')]) });
  connector.post(path, async c => {
    assert.equal((await c.req.json()).model,'synthetic-model');
    creates++; const native = randomUUID(), key = `${c.req.param('agentId')}:${native}`; sessions.set(key,native);
    c.get('acknowledgeCreation')({ status: 201, body: { key } }); return c.json({ key },201);
  });
  const bindings = registerConnectorBoardBindings(connector, { tokens, directories: { codex: directory }, policies: [{ owner: 'hub-token', runtime: 'codex', endpoint }],
    resolveSession: key => sessions.has(key) ? { runtime: 'codex', sessionId: sessions.get(key)!, ready: true } : undefined });
  await bindings.ready;
  const client = () => new ConnectorClient('https://connector.example', token.token, async request => {
    if (request.method === 'PUT') puts++;
    if (dropCreation && request.method === 'GET' && request.url.includes('creation-commands')) throw Error('offline');
    const result = await connector.request(request);
    if (revokeDuringRead && request.url.includes('/board-binding') || revokeDuringModels && request.url.includes('/models/')) {
      store.upsertConnection({ id:'dev', ownerUserId:owner, label:'Revoked', connectorUrl:'https://connector.example', status:'disabled' });
    }
    if (dropCreation && request.method === 'POST' || dropBinding && request.method === 'PUT') throw Error('lost ACK');
    return result;
  });
  const mount = () => registerHubTaskSessions(app, { hubStore: store, endpoint, principal: c => {
    const userId = c.req.header('x-user'); if (!userId) throw new HTTPException(401); return { userId, admin: false };
  }, connectorClient: client });
  let routes = mount();
  t.after(async () => { routes.close(); token.dispose(); await bindings.close(); db.close(); store.close(); await rm(root, { recursive:true,force:true }); });
  const input = { requestId: randomUUID(), connectionId:'dev', runtime:'codex', title:'Task session', model:'synthetic-model', taskIds:[task], fields:['status'], expiresAt:Date.now()+600000 };
  const req = (method:string,suffix='',body?:unknown,actor=owner) => app.request('/api/hub/v1/workspace/boards/default/task-sessions'+suffix,
    {method,headers:{'x-user':actor},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  return { get store(){return store;},owner,other,input,req,get creates(){return creates;},get puts(){return puts;},
    dropCreate(v=true){dropCreation=v;},dropBind(){dropBinding=true;},revoke(){revokeDuringRead=true;},
    removeModel(){models=[];},revokeModels(){revokeDuringModels=true;},
    reopen(){routes.close();store.close();store=new HubStore(join(root,'hub.sqlite'),'synthetic');app=new Hono();routes=mount();} };
}

test('prepare freezes tasks without effects; create and bind require distinct confirmations and never send messages', async t => {
  const f=await fixture(t),id=f.input.requestId;
  assert.equal((await f.req('POST','',f.input)).status,201);assert.equal(f.creates,0);assert.equal(f.puts,0);
  const created=await f.req('POST',`/${id}/create`,{});assert.equal(created.status,200);
  const first=(await created.json()).receipt;assert.equal(first.state,'created');assert.equal(f.creates,1);assert.equal(f.puts,0);
  assert.equal((await f.req('POST',`/${id}/create`,{})).status,200);assert.equal(f.creates,1);
  const result=await f.req('POST',`/${id}/bind`,{});assert.equal(result.status,200);
  const bound=(await result.json()).receipt;assert.equal(bound.state,'bound');assert.equal(bound.sessionId,first.sessionId);assert.equal(f.puts,1);
  const secret=f.store.boardBindings.credential(f.owner,'default',bound.bindingRequestId)!;assert.ok(secret);assert.ok(!JSON.stringify(bound).includes(secret.token));
  assert.equal((await f.req('POST',`/${id}/bind`,{})).status,200);assert.equal(f.puts,1);
  assert.equal((await f.req('GET',`/${id}`,undefined,f.other)).status,404);
  assert.equal((await f.req('DELETE',`/${id}`)).status,409,'cancel cannot undo an already-created session');
});

test('lost creation ACK survives physical Hub reopen; GET recovers original session and does not bind',async t=>{
  const f=await fixture(t),id=f.input.requestId;await f.req('POST','',f.input);f.dropCreate();
  assert.equal((await (await f.req('POST',`/${id}/create`,{})).json()).receipt.state,'creation_unknown');assert.equal(f.creates,1);
  f.reopen();assert.equal((await (await f.req('POST',`/${id}/create`,{})).json()).receipt.state,'creation_unknown');assert.equal(f.creates,1);
  f.dropCreate(false);const r=(await (await f.req('GET',`/${id}`)).json()).receipt;
  assert.equal(r.state,'created');assert.equal(f.puts,0);assert.equal(f.creates,1);
});

test('lost binding ACK only queries original binding; task changes do not hide created session receipt',async t=>{
  const f=await fixture(t),id=f.input.requestId;await f.req('POST','',f.input);await f.req('POST',`/${id}/create`,{});f.dropBind();
  assert.equal((await (await f.req('POST',`/${id}/bind`,{})).json()).receipt.state,'binding_unknown');assert.equal(f.puts,1);
  const b=f.store.boards.get(f.owner,'default');f.store.boards.save(f.owner,'default',{revision:b.revision,tasks:b.tasks,mutationId:randomUUID(),title:'Changed'});
  f.reopen();assert.equal((await (await f.req('GET',`/${id}`)).json()).receipt.state,'bound');assert.equal(f.puts,1);
});

test('changed frozen board blocks create or bind, but lookup retains already-created session',async t=>{
  const f=await fixture(t),id=f.input.requestId;await f.req('POST','',f.input);await f.req('POST',`/${id}/create`,{});
  const b=f.store.boards.get(f.owner,'default');f.store.boards.save(f.owner,'default',{revision:b.revision,tasks:b.tasks,mutationId:randomUUID(),title:'Changed'});
  assert.equal((await f.req('POST',`/${id}/bind`,{})).status,409);assert.equal(f.puts,0);
  assert.equal((await (await f.req('GET',`/${id}`)).json()).receipt.state,'created');
  assert.equal((await f.req('POST','',{...f.input,requestId:randomUUID(),tasks:[]})).status,400);
});

test('authority revoked during binding preflight prevents credentials and remote write',async t=>{
  const f=await fixture(t),id=f.input.requestId;await f.req('POST','',f.input);await f.req('POST',`/${id}/create`,{});f.revoke();
  assert.equal((await f.req('POST',`/${id}/bind`,{})).status,409);assert.equal(f.puts,0);
  assert.equal(f.store.boardBindings.list(f.owner,'default').length,0);
  assert.equal((await f.req('GET',`/${id}`)).status,409);
});

test('absent preview cancellation tombstone prevents late prepare; no creation or grant',async t=>{
  const f=await fixture(t),id=f.input.requestId;
  assert.equal((await f.req('DELETE',`/${id}`)).status,200);
  assert.equal((await f.req('POST','',f.input)).status,409);assert.equal(f.creates,0);assert.equal(f.puts,0);
});

test('removed model or authority replaced during catalog read never claims creation',async t=>{
  for(const mode of ['remove','revoke']){
    const f=await fixture(t),id=f.input.requestId;
    assert.equal((await f.req('POST','',f.input)).status,201);
    if(mode==='remove')f.removeModel();else f.revokeModels();
    assert.ok((await f.req('POST',`/${id}/create`,{})).status>=400);assert.equal(f.creates,0);assert.equal(f.puts,0);
    if(mode==='remove')assert.equal((await (await f.req('GET',`/${id}`)).json()).receipt.state,'prepared');
  }
});

test('new task preview requires explicit bounded model, not mutable environment default',async t=>{
  const f=await fixture(t);
  for(const model of [undefined,'',' model','a\nmodel','x'.repeat(257)])assert.equal((await f.req('POST','',{...f.input,model})).status,400);
  assert.equal(f.creates,0);
});
