import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { AsyncWorkspaceFiles } from './async-workspace-files.js';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { boardFileCodec } from './workspace-board-file-format.js';
import { cardFileCodec } from './workspace-file-card-format.js';
import { FileBoardError } from './workspace-board-files.js';
import { registerAsyncConnectorWorkspaceFiles } from './workspace-board-files-http.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { validConnectorWorkspaceFileInput, validConnectorWorkspaceFileOutput } from './connector-workspace-file-domain.js';
import { connectorOwnerResultBytes } from './connector-owner-domain.js';
import { WORKSPACE_FILE_CARD_MAX_BYTES } from '@agentopsdeck/shared';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(),'async-original-files-')), files = join(root,'files');
  await mkdir(files,{mode:0o700});
  const tokenFile = join(root,'tokens.json'), tokens = new ConnectorTokenStore(tokenFile);
  const original = tokens.create({label:'files',scopes:['boards:files','messages:send']});
  const other = tokens.create({label:'other',scopes:['boards:files','messages:send']});
  const actor = {authorization:`Bearer ${original.token}`,tokenId:original.record.id};
  const config = {file:join(root,'connector.sqlite'),tokenFile,
    boardFiles:{root:files,policies:[{owner:actor.tokenId,runtime:'codex' as const}]}};
  const owner = new AsyncConnectorOwner(config,new PerformanceDiagnostics(() => {}));
  const boards = new AsyncWorkspaceFiles(owner,files,boardFileCodec);
  const cards = new AsyncWorkspaceFiles(owner,files,cardFileCodec());
  await owner.command('tokensList',{});
  const key = `codex:${randomUUID()}`;
  t.after(async () => {
    await boards.close(); await cards.close(); await owner.close();
    await rm(root,{recursive:true,force:true});
  });
  return {root,files,config,owner,boards,cards,actor,other,key};
}
const denied = (error: unknown) => error instanceof FileBoardError && error.status === 403;

for (const kind of ['boards', 'cards'] as const) test(`${kind}: request identity is captured before await, rechecked after header mutation and never cached after revocation`, async t => {
  const f = await fixture(t), files = f[kind];
  const request = new Request('http://localhost/isolated', { headers: { authorization: f.actor.authorization } });
  const first = files.authenticate(request);
  request.headers.set('authorization', `Bearer ${f.other.token}`);
  assert.deepEqual(await first, f.actor);
  assert.deepEqual(await files.authenticate(request), f.actor, 'later credentials must not lend identity to the original request');
  await f.owner.command('tokenRevoke', { tokenId: f.actor.tokenId });
  assert.equal(await files.authenticate(request), null, 'original authority must be revalidated, not cached');
  const fresh = new Request(request);
  assert.deepEqual(await files.authenticate(fresh), { authorization: `Bearer ${f.other.token}`, tokenId: f.other.record.id });
  const anonymous = new Request('http://localhost/isolated');
  const originalAnonymous = files.authenticate(anonymous);
  anonymous.headers.set('authorization', `Bearer ${f.other.token}`);
  assert.equal(await originalAnonymous, null);
  assert.equal(await files.authenticate(anonymous), null, 'empty original evidence must not be replaced');
});

test('real worker owns metadata while original executor installs, writes and reads receipts',async t => {
  const f = await fixture(t), id = randomUUID();
  const input = {id,sessionKey:f.key,content:{title:'Original',tasks:[]}};
  const binding = await f.boards.install(f.actor,input);
  assert.equal(binding.state,'installed');
  const snapshot = await f.boards.snapshot(f.actor,id); assert.equal(snapshot.state,'ready');
  if (snapshot.state !== 'ready') throw Error('missing snapshot');
  const mutationId = randomUUID(), content = {title:'Updated',tasks:[]};
  const receipt = await f.boards.write(f.actor,id,{mutationId,expectedHash:snapshot.value.hash,content});
  assert.equal(receipt.state,'saved');
  assert.deepEqual(await f.boards.receipt(f.actor,id,mutationId),{mutationId,state:'saved'});
  const bytes = await readFile(binding.path,'utf8');
  assert.equal((await f.boards.install(f.actor,input)).state,'installed');
  assert.equal(await readFile(binding.path,'utf8'),bytes,'duplicate install never rewrites');
  assert.equal((await f.boards.write(f.actor,id,{mutationId,expectedHash:snapshot.value.hash,content})).state,'saved');
  assert.equal(await readFile(binding.path,'utf8'),bytes);
  assert.deepEqual(await f.boards.filesForSession(f.actor,f.key),[binding.path]);
  assert.ok((await f.boards.contextForSession(f.actor,f.key)).includes(binding.path));
});

test('raw evidence is required; foreign expected identity, missing scope and missing policy fail closed',async t => {
  const f = await fixture(t), id = randomUUID(), input = {id,sessionKey:f.key,content:{title:'No authority',tasks:[]}};
  await assert.rejects(f.boards.install({...f.actor,authorization:`Bearer ${f.other.token}`},input),denied);
  await assert.rejects(f.boards.install({...f.actor,authorization:''},input),denied);
  await assert.rejects(f.boards.install({...f.actor,authorization:`Bearer ${f.other.token}`,tokenId:f.other.record.id},input),denied);
  const token = await f.owner.command('tokenCreate',{label:'no files',scopes:['messages:send']});
  await assert.rejects(f.boards.install({authorization:`Bearer ${token.token}`,tokenId:token.record.id},input),denied);
  await assert.rejects(f.boards.get(f.actor,id),e => e instanceof FileBoardError && e.status === 404);
});

test('cancel-before-install tombstones survive card kind absence and never create files',async t => {
  const f = await fixture(t), id = randomUUID();
  await f.cards.revoke(f.actor,id,f.key);
  const binding = await f.cards.install(f.actor,{id,sessionKey:f.key,
    content:{kind:'notebook',content:{title:'Cancelled',text:'hot',archive:'cold'}}});
  assert.equal(binding.state,'revoked');
  await assert.rejects(readFile(binding.path),{code:'ENOENT'});
});

test('card worker binding preserves notebook archive and refuses changing bound kind',async t => {
  const f = await fixture(t), id = randomUUID();
  const binding = await f.cards.install(f.actor,{id,sessionKey:f.key,
    content:{kind:'notebook',content:{title:'Original',text:'hot',archive:'cold preserved'}}});
  const snapshot = await f.cards.snapshot(f.actor,id); assert.equal(snapshot.state,'ready');
  assert.ok((await readFile(binding.path,'utf8')).includes('cold preserved'));
  if (snapshot.state !== 'ready') throw Error('missing card snapshot');
  await assert.rejects(f.cards.write(f.actor,id,{mutationId:randomUUID(),expectedHash:snapshot.value.hash,
    content:{kind:'report',content:{title:'Changed kind',text:'must not replace notebook'}}}),
    e => e instanceof FileBoardError);
  assert.ok((await readFile(binding.path,'utf8')).includes('cold preserved'));
  const subscription = await f.cards.subscribe(f.actor,id,() => {});
  assert.equal((await subscription.current()).state,'ready');
  await subscription.release();
  await assert.rejects(subscription.current());
});

test('worker authority wake revokes idle subscriptions; no cached snapshot disclosure',async t => {
  const f = await fixture(t), id = randomUUID();
  await f.boards.install(f.actor,{id,sessionKey:f.key,content:{title:'Private',tasks:[]}});
  const sub = await f.boards.subscribe(f.actor,id,() => {});
  const revision = f.owner.authorityChanges.revision, abort = new AbortController();
  try {
    const wake = f.owner.authorityChanges.wait(revision,abort.signal,5000);
    assert.equal(await f.owner.command('tokenRevoke',{tokenId:f.actor.tokenId}),true);
    await wake; assert.ok(f.owner.authorityChanges.revision > revision);
    await assert.rejects(sub.current(),denied);
    await f.boards.reconcile();
    await assert.rejects(f.boards.snapshot(f.actor,id),denied);
  } finally { abort.abort(); await sub.release(); }
});

test('lease settlement binds exact original intent and survives revocation without reexecution',async t => {
  const f = await fixture(t), id = randomUUID();
  await f.boards.install(f.actor,{id,sessionKey:f.key,content:{title:'Original',tasks:[]}});
  const snapshot = await f.boards.snapshot(f.actor,id); if(snapshot.state !== 'ready') throw Error('missing');
  const mutationId = randomUUID(), intent = {mutationId,expectedHash:snapshot.value.hash,content:{title:'Never executed',tasks:[]}};
  const admitted = await f.owner.command('workspaceFileWrite',{file:'board',actor:f.actor,id,intent,retainedBytes:0});
  assert.ok(admitted.ok && !admitted.value.existing && admitted.value.effectId);
  if (!admitted.ok || admitted.value.existing || !admitted.value.effectId) throw Error('missing lease');
  const lease = {effectId:admitted.value.effectId,id,mutationId,fingerprint:admitted.value.fingerprint};
  assert.deepEqual(await f.owner.command('workspaceFileSettled',{...lease,id:randomUUID(),state:'saved'}),{ok:false,status:409});
  await f.owner.command('tokenRevoke',{tokenId:f.actor.tokenId});
  assert.deepEqual(await f.owner.command('workspaceFileSettled',{...lease,state:'uncertain'}),{ok:true,value:null});
  assert.deepEqual(await f.owner.command('workspaceFileSettled',{...lease,state:'saved'}),{ok:false,status:409});
  assert.ok((await readFile(join(f.files,id,'tasks.json'),'utf8')).includes('Original'));
});

test('prepared installation and uncertain write are receipts, never replay permission',async t => {
  const f = await fixture(t), id = randomUUID(), intent = {id,sessionKey:f.key,content:{title:'Prepared only',tasks:[]}};
  const admitted = await f.owner.command('workspaceFileInstall',{file:'board',actor:f.actor,intent,reserve:true});
  assert.ok(admitted.ok && !admitted.value.existing);
  assert.equal((await f.boards.install(f.actor,intent)).state,'prepared');
  await assert.rejects(readFile(join(f.files,id,'tasks.json')),{code:'ENOENT'});
  assert.deepEqual(await f.owner.command('workspaceFileInstalled',{effectId:randomUUID(),id,fingerprint:'a'.repeat(64)}),{ok:false,status:409});
  await f.boards.close(); await f.cards.close(); await f.owner.close();
  const reopened = new AsyncConnectorOwner(f.config,new PerformanceDiagnostics(() => {}));
  const boards = new AsyncWorkspaceFiles(reopened,f.files,boardFileCodec);
  try {
    assert.equal((await boards.install(f.actor,intent)).state,'prepared');
    await assert.rejects(readFile(join(f.files,id,'tasks.json')),{code:'ENOENT'});
  } finally { await boards.close(); await reopened.close(); }
});

test('effect lease capacity rejects new admission but preserves original receipt reads',async t => {
  const f = await fixture(t), id = randomUUID();
  await f.boards.install(f.actor,{id,sessionKey:f.key,content:{title:'Unchanged',tasks:[]}});
  const snapshot = await f.boards.snapshot(f.actor,id); if(snapshot.state !== 'ready') throw Error('missing');
  const first = {mutationId:randomUUID(),expectedHash:snapshot.value.hash,content:{title:'Prepared',tasks:[]}};
  for (let n=0;n<128;n++) {
    const result = await f.owner.command('workspaceFileWrite',{file:'board',actor:f.actor,id,
      intent:n===0 ? first : {...first,mutationId:randomUUID()},retainedBytes:0});
    assert.ok(result.ok && !result.value.existing && result.value.effectId);
  }
  const duplicate = await f.owner.command('workspaceFileWrite',{file:'board',actor:f.actor,id,intent:first,retainedBytes:0});
  assert.ok(duplicate.ok && duplicate.value.existing);
  assert.deepEqual(await f.owner.command('workspaceFileWrite',{file:'board',actor:f.actor,id,
    intent:{...first,mutationId:randomUUID()},retainedBytes:0}),{ok:false,status:429});
  assert.deepEqual(await f.boards.receipt(f.actor,id,first.mutationId),{mutationId:first.mutationId,state:'uncertain'});
  assert.ok((await readFile(join(f.files,id,'tasks.json'),'utf8')).includes('Unchanged'));
});

test('same async HTTP routes preserve protocol, readonly retry and session wait authority fence',async t => {
  const f = await fixture(t), app = new Hono();
  let running = true, beforeSession: (() => Promise<void>) | undefined;
  const service = registerAsyncConnectorWorkspaceFiles(app,{boards:f.boards,authority:{
    changes:f.owner.authorityChanges,
    authenticate:async request => { const actor = await f.boards.authenticate(request); return actor && {id:actor.tokenId,actor}; },
    hasScope:id => f.owner.command('tokenHasScope',{tokenId:id,scope:'boards:files'}),
  },session:async key => {await beforeSession?.();return {exists:key === f.key,ready:running};}});
  t.after(() => service.close()); await service.ready;
  const request = (method: string,path: string,body?: unknown) => app.request('/api/connector/v1/workspace/board-files'+path,
    {method,headers:{authorization:f.actor.authorization},...(body === undefined ? {} : {body:JSON.stringify(body)})});
  assert.equal((await request('GET','')).status,200);
  assert.equal((await request('GET','?token=forbidden')).status,400);
  const id = randomUUID(), input = {sessionKey:f.key,content:{title:'HTTP original',tasks:[]}};
  assert.equal((await request('PUT','/'+id,input)).status,200);
  const response = await request('GET','/'+id); assert.equal(response.headers.get('cache-control'),'no-store');
  assert.equal((await response.json()).binding.id,id);
  running = false; assert.equal((await request('PUT','/'+id,input)).status,200);
  assert.equal((await request('PUT','/'+randomUUID(),input)).status,503);
  running = true;
  const stream = await request('POST','/subscribe',{ids:[id]});
  assert.equal(stream.status,200); assert.match(stream.headers.get('content-type') ?? '',/text\/event-stream/);
  const reader = stream.body!.getReader(), decoder = new TextDecoder(); let events = '';
  const deadline = setTimeout(() => { void reader.cancel(); },5000);
  try {
    while (events.split('\n\n').length < 3) {
      const next = await reader.read(); assert.equal(next.done,false);
      events += decoder.decode(next.value,{stream:true});
    }
    assert.match(events,/board-file.snapshot/);
    assert.match(events,/HTTP original/);
    beforeSession = async () => { await f.owner.command('tokenRevoke',{tokenId:f.actor.tokenId}); };
    assert.equal((await request('PUT','/'+randomUUID(),input)).status,401);
    assert.equal((await reader.read()).done,true,'worker authority signal closes idle SSE without another file edit');
    await service.close();
    assert.equal(f.owner.authorityChanges.waiting,0); assert.equal(f.boards.changes.waiting,0);
  } finally { clearTimeout(deadline); await reader.cancel(); }
});

test('workspace commands reject capability fabrication and malformed output envelopes',() => {
  const base = {file:'board',actor:{authorization:'Bearer original',tokenId:'owner'},id:randomUUID()};
  assert.equal(validConnectorWorkspaceFileInput('workspaceFileBinding',base),true);
  for (const field of ['authorized','sql','callback','root','grant'])
    assert.equal(validConnectorWorkspaceFileInput('workspaceFileBinding',{...base,[field]:true}),false);
  assert.equal(validConnectorWorkspaceFileInput('workspaceFileBinding',{...base,actor:{...base.actor,authorized:true}}),false);
  assert.equal(validConnectorWorkspaceFileOutput('workspaceFileGuard',{ok:true,value:null,extra:true}),false);
  assert.equal(validConnectorWorkspaceFileOutput('workspaceFileGuard',{ok:false,status:500}),false);
  assert.equal(validConnectorWorkspaceFileOutput('workspaceFileGuard',{ok:false,status:'403'}),false);
  // Worst-case JSON string escaping remains bounded without rejecting a valid
  // original 2MiB file. Other commands retain their original result ceilings.
  const text = '"'.repeat(WORKSPACE_FILE_CARD_MAX_BYTES);
  const bytes = Buffer.byteLength(JSON.stringify({ok:true,value:{text,fingerprint:'a'.repeat(64),effectId:randomUUID()}}));
  assert.ok(bytes <= connectorOwnerResultBytes('workspaceFileInstall'));
  assert.ok(bytes <= connectorOwnerResultBytes('workspaceFileWrite'));
  assert.equal(connectorOwnerResultBytes('workspaceFileGuard'),1024*1024);
});
