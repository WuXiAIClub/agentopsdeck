import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AsyncHubBoardBindings } from './async-board-bindings.js';
import type { AsyncHubMemberOwner } from './async-member-owner.js';
import { HubMemberRequestError } from './async-member-request.js';
import { encodeHubSessionId } from './session-id.js';
import { validHubBoardBindingResult } from './member-board-binding-domain.js';

const request = () => new Request('http://hub.invalid',{headers:{'x-agentopsdeck-key':'hub_key_original'}});
const snapshot = {principal:{userId:'owner'},recoveryScope:'a'.repeat(64)};
function fixture(reply: (input: unknown) => unknown | Promise<unknown>) {
  const owner = {command:async (kind:string,input:unknown) => kind === 'memberSnapshot' ? snapshot : reply(input)};
  return new AsyncHubBoardBindings(owner as unknown as Pick<AsyncHubMemberOwner,'command'>);
}
const denied = (status:number) => (error:unknown) => error instanceof HubMemberRequestError && error.status === status;

test('board binding private lane captures original evidence before awaits',async t => {
  let observed:unknown;
  const access = fixture(input => { observed = input; return {action:'list',enabled:true,bindings:[]}; });
  t.after(() => access.close());
  const original = request(), beginning = access.begin(original);
  original.headers.set('x-agentopsdeck-key','hub_key_replaced');
  const scope = await beginning;
  assert.deepEqual(await scope.command({action:'list',boardId:'default'}),{action:'list',enabled:true,bindings:[]});
  assert.deepEqual(observed,{evidence:{accessKey:'hub_key_original'},expectedScope:snapshot.recoveryScope,command:{action:'list',boardId:'default'}});
});

test('board binding private lane rejects malformed/reflected replies and keeps denial sticky',async t => {
  let replies = 0;
  const access = fixture(() => { replies++; return {action:'list',enabled:true,bindings:[],credential:'PRIVATE_REFLECTION'}; });
  t.after(() => access.close());
  const scope = await access.begin(request());
  await assert.rejects(scope.command({action:'list',boardId:'default'}),denied(503));
  await assert.rejects(scope.command({action:'list',boardId:'default'}),denied(503));
  await assert.rejects(scope.check(),denied(503)); assert.equal(replies,1);
});

test('board binding private lane rejects a valid receipt correlated to a different target',async t => {
  const native = randomUUID(), sessionId = encodeHubSessionId('node','codex:'+native);
  const access = fixture(() => ({action:'claim',binding:{requestId:native,boardId:'default',sessionId:encodeHubSessionId('other','codex:'+native),
    capabilityId:randomUUID(),state:'uncertain',expiresAt:Date.now()+30_000,createdAt:Date.now()},credential:null}));
  t.after(() => access.close());
  const scope = await access.begin(request());
  await assert.rejects(scope.command({action:'claim',boardId:'default',id:native,
    target:{sessionId,connectionId:'node',remoteSessionKey:'codex:'+native,nodeId:'node_fixture',epoch:1}}),denied(503));
});

test('board binding private lane close owns original SQL ACK even after abort',async () => {
  let resolve!: (value:unknown) => void, entered!: () => void;
  const ack = new Promise<unknown>(done => { resolve = done; }), started = new Promise<void>(done => { entered = done; });
  const access = fixture(() => { entered(); return ack; }), controller = new AbortController();
  const original = new Request(request(),{signal:controller.signal}), scope = await access.begin(original);
  const writing = scope.command({action:'list',boardId:'default'});
  const rejected = assert.rejects(writing,denied(499));
  await started; controller.abort();
  const closing = access.close(); let closed = false; void closing.then(() => { closed = true; });
  try {
    await new Promise<void>(done => setImmediate(done)); assert.equal(closed,false);
    await assert.rejects(access.begin(request()));
  } finally { resolve({action:'list',enabled:true,bindings:[]}); }
  await rejected; await closing; assert.equal(closed,true);
});

test('board binding fixed claim reply cannot grant credentials for a terminal or mismatched receipt',() => {
  const expiresAt = Date.now()+30_000, receipt = {requestId:randomUUID(),boardId:'default',sessionId:encodeHubSessionId('node','codex:'+randomUUID()),
    capabilityId:randomUUID(),state:'uncertain',expiresAt,createdAt:Date.now()};
  const credential = {endpoint:'https://hub.example/api/workspace-agent/v1/board',token:'aod_board_'+'a'.repeat(43),expiresAt};
  assert.equal(validHubBoardBindingResult({action:'claim',binding:receipt,credential}),true);
  for (const state of ['prepared','installed','revoked','expired','unavailable'])
    assert.equal(validHubBoardBindingResult({action:'claim',binding:{...receipt,state},credential}),false);
  assert.equal(validHubBoardBindingResult({action:'claim',binding:receipt,credential:{...credential,expiresAt:expiresAt+1}}),false);
});
