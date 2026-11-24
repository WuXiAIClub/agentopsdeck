import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { WorkspaceBoards } from '../hub/workspace-boards.js';
import { WorkspaceBoardCapabilities } from '../hub/workspace-board-capabilities.js';
import { registerWorkspaceAgentRoutes } from '../routes/workspace-agent.js';
import { BOARD_READ_TOOL, BOARD_UPDATE_TOOL } from '../tools/workspace-board-worker.js';
import { CodexBoardTools, codexBoardToolSpecs } from './board-tools.js';

async function fixture(t: { after: (fn: () => unknown) => void }, fetcher?: typeof fetch) {
  const root = await mkdtemp(join(tmpdir(), 'codex-board-tools-')), directory = join(root, 'grants');
  await mkdir(directory, { mode: 0o700 });
  const threadId = randomUUID(), taskId = randomUUID(), hiddenId = randomUUID(), turnId = 'admitted-turn';
  const db = new DatabaseSync(':memory:'), boards = new WorkspaceBoards(db), caps = new WorkspaceBoardCapabilities(db, boards);
  boards.save('owner', 'default', { title: 'Task board', revision: 0, mutationId: randomUUID(), tasks: [
    { id: taskId, title: 'Allowed task', status: 'todo', detail: '' }, { id: hiddenId, title: 'Hidden task', status: 'todo', detail: '' },
  ] });
  const issued = caps.issue('owner', 'default', { taskIds: [taskId], fields: ['status'], expiresAt: Date.now() + 60000 })!;
  const credential = { endpoint: 'http://127.0.0.1:8791/api/workspace-agent/v1/board', token: issued.token, expiresAt: issued.capability.expiresAt };
  const path = join(directory, `codex-${threadId}.json`);
  await writeFile(path, JSON.stringify({ runtime: 'codex', sessionId: threadId, credential }), { mode: 0o600 });
  const hub = new Hono(); registerWorkspaceAgentRoutes(hub, caps);
  let calls = 0, authorized = true;
  const tools = new CodexBoardTools(directory, (async (url, init) => { calls++; return fetcher ? fetcher(url, init) : hub.request(String(url), init); }) as typeof fetch);
  const call = (tool = BOARD_READ_TOOL, args: unknown = {}, patch: Record<string, unknown> = {}) =>
    ({ threadId, turnId, callId: randomUUID(), namespace: null, tool, arguments: args, ...patch });
  t.after(async () => { await tools.close(); db.close(); await rm(root, { recursive: true, force: true }); });
  return { tools, call, threadId, turnId, path, boards, taskId, hiddenId, credential, directory,
    begin: () => tools.begin(threadId, id => authorized && id === turnId), deny: () => { authorized = false; },
    revoke: () => caps.revoke('owner', 'default', issued.capability.id), get calls() { return calls; } };
}
const content = (result: Awaited<ReturnType<CodexBoardTools['invoke']>>) => JSON.parse(result.contentItems[0]!.text);
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};

for (const allowed of [true, false, 'reject', 'nonboolean'] as const) test(`Codex task tools await exact worker authority: ${allowed}`, async t => {
  const f = await fixture(t), entered = deferred<void>(), authority = deferred<boolean>();
  f.tools.begin(f.threadId, async () => { entered.resolve(); const yes = await authority.promise;
    if (allowed === 'reject') throw Error('private worker diagnostic');
    return allowed === 'nonboolean' ? { authorized: yes } as unknown as boolean : yes;
  });
  const call = f.call(), pending = f.tools.invoke(call); await entered.promise;
  assert.equal(f.calls, 0, 'an unresolved Promise is never authorization');
  assert.equal((await f.tools.invoke(call)).success, false, 'reserve native id before worker await');
  authority.resolve(allowed === true);
  const outcome = await pending;
  assert.equal(outcome.success, allowed === true); assert.equal(f.calls, allowed === true ? 1 : 0);
  assert.ok(!JSON.stringify(outcome).includes('private worker diagnostic'));
});

for (const stop of ['stop', 'replace', 'reset', 'close'] as const) test(`Codex ${stop} during worker authority cannot admit an old task call`, async t => {
  const f = await fixture(t), entered = deferred<void>(), authority = deferred<boolean>();
  f.tools.begin(f.threadId, async () => { entered.resolve(); return authority.promise; });
  const pending = f.tools.invoke(f.call()); await entered.promise;
  // The public promise must not be the object used by close to observe drain.
  Object.defineProperty(pending, 'then', { value() { throw Error('public then was replaced'); } });
  let drained = false, closing: Promise<void> | undefined;
  if (stop === 'stop') f.tools.stop(f.threadId);
  else if (stop === 'replace') f.begin();
  else if (stop === 'reset') f.tools.reset();
  else { closing = f.tools.close().then(() => { drained = true; }); }
  await Promise.resolve(); assert.equal(drained, false); assert.equal(f.calls, 0);
  authority.resolve(true);
  const outcome = await pending;
  if (closing) await closing;
  assert.equal(outcome.success, false); assert.equal(f.calls, 0); assert.equal(f.tools.inFlight, 0);
});

test('Codex native task request retains its original binding and immutable input before asynchronous work starts', async t => {
  const f = await fixture(t); f.begin();
  const call = f.call(), pending = f.tools.invoke(call);
  f.begin();
  assert.equal((await pending).success, false, 'a replacement may not authorize an earlier native request');
  const input = { revision: 1, mutationId: randomUUID(), tasks: [{ id: f.taskId, status: 'done' }] };
  const update = f.tools.invoke(f.call(BOARD_UPDATE_TOOL, input));
  input.tasks[0]!.id = f.hiddenId;
  assert.equal(content(await update).status, 'saved');
  assert.equal(f.boards.get('owner', 'default').tasks.find(task => task.id === f.hiddenId)!.status, 'todo');
});

test('late original binding cleanup cannot stop successor and drains physical permission work', async t => {
  const f = await fixture(t), entered = deferred<void>(), gate = deferred<boolean>();
  const stop = f.tools.begin(f.threadId, async () => { entered.resolve(); return gate.promise; });
  const old = f.tools.invoke(f.call()); await entered.promise;
  f.begin();
  let drained = false; const closing = stop().then(() => { drained = true; });
  await Promise.resolve(); assert.equal(drained, false);
  gate.resolve(true); assert.equal((await old).success, false); await closing;
  assert.equal((await f.tools.invoke(f.call())).success, true, 'late stop affects only the original turn');
});

test('Codex worker revocation during a submitted write retains its original uncertain receipt', async t => {
  const sent = deferred<void>(), reply = deferred<Response>(), f = await fixture(t, async () => { sent.resolve(); return reply.promise; });
  let allowed = true;
  f.tools.begin(f.threadId, async () => allowed);
  const mutationId = randomUUID(), pending = f.tools.invoke(f.call(BOARD_UPDATE_TOOL,
    { revision: 1, mutationId, tasks: [{ id: f.taskId, status: 'done' }] }));
  await sent.promise; allowed = false; reply.resolve(new Response(JSON.stringify({ status: 'saved' }), { status: 200 }));
  const outcome = content(await pending);
  assert.equal(outcome.uncertain, true); assert.equal(outcome.mutationId, mutationId); assert.equal(f.calls, 1);
});

test('Codex selective reads use the admitted host bridge and preserve native schema/authority', async t => {
  const f = await fixture(t); f.begin();
  const schema = codexBoardToolSpecs.find(s => s.name === BOARD_READ_TOOL)!.inputSchema;
  assert.ok('limit' in schema.properties); assert.ok('ifRevision' in schema.properties);
  const first = content(await f.tools.invoke(f.call(BOARD_READ_TOOL, { status: 'todo', limit: 1, includeDetail: false }))).board;
  assert.equal(first.tasks[0].id, f.taskId); assert.equal(first.page.total, 1); assert.equal(first.tasks[0].detail, undefined);
  assert.equal(content(await f.tools.invoke(f.call(BOARD_READ_TOOL, { ifRevision: first.revision, limit: 1 }))).board.unchanged, true);
  assert.equal(content(await f.tools.invoke(f.call(BOARD_READ_TOOL, { taskIds: [f.hiddenId] }))).board.page.total, 0);
  const count = f.calls;
  assert.equal((await f.tools.invoke(f.call(BOARD_READ_TOOL, { offset: 1 }))).success, false);
  assert.equal(f.calls, count);
  f.revoke(); assert.equal(content(await f.tools.invoke(f.call(BOARD_READ_TOOL, { ifRevision: first.revision }))).status, 401);
});

test('Codex dynamic tools: fixed definitions, default off, exact admitted thread and turn, private files', async t => {
  const f = await fixture(t), off = new CodexBoardTools(undefined);
  t.after(() => off.close());
  assert.deepEqual(codexBoardToolSpecs.map(s => s.name), [BOARD_READ_TOOL, BOARD_UPDATE_TOOL]);
  assert.ok(!JSON.stringify(codexBoardToolSpecs).includes(f.directory));
  assert.ok(!JSON.stringify(codexBoardToolSpecs).includes(f.credential.token));
  off.begin(f.threadId, () => true);
  assert.equal((await off.invoke(f.call())).success, false);
  assert.equal((await f.tools.invoke(f.call())).success, false);
  f.begin();
  for (const patch of [{ threadId: randomUUID() }, { turnId: 'old-turn' }, { namespace: 'other' },
    { tool: 'shell' }, { arguments: { endpoint: 'https://evil.example' } }, { callId: '' }]) {
    assert.equal((await f.tools.invoke(f.call(BOARD_READ_TOOL, {}, patch))).success, false);
  }
  assert.equal(f.calls, 0);
  const read = await f.tools.invoke(f.call());
  assert.equal(read.success, true); assert.equal(content(read).board.tasks.length, 1);
  assert.ok(!JSON.stringify(read).includes(f.credential.token));
  assert.ok(!JSON.stringify(read).includes('Hidden task'));
  await chmod(f.path, 0o644);
  assert.equal((await f.tools.invoke(f.call())).success, false); assert.equal(f.calls, 1);
  await chmod(f.path, 0o600); f.deny();
  assert.equal((await f.tools.invoke(f.call())).success, false); assert.equal(f.calls, 1);
});

test('Codex host bridge updates real Hub with CAS, deduplicates native calls, observes revocation', async t => {
  const f = await fixture(t); f.begin();
  const input = { revision: 1, mutationId: randomUUID(), tasks: [{ id: f.taskId, status: 'done' }] };
  const call = f.call(BOARD_UPDATE_TOOL, input);
  assert.equal(content(await f.tools.invoke(call)).status, 'saved');
  assert.equal((await f.tools.invoke(call)).success, false); assert.equal(f.calls, 1);
  assert.equal(content(await f.tools.invoke(f.call(BOARD_UPDATE_TOOL, input))).revision, 2, 'Hub keeps same-mutation idempotency');
  assert.equal(content(await f.tools.invoke(f.call(BOARD_UPDATE_TOOL, { ...input, mutationId: randomUUID() }))).status, 409);
  assert.equal(content(await f.tools.invoke(f.call(BOARD_UPDATE_TOOL, { ...input, mutationId: randomUUID(), revision: 2,
    tasks: [{ id: f.hiddenId, status: 'done' }] }))).status, 403);
  f.revoke(); assert.equal(content(await f.tools.invoke(f.call())).status, 401);
  assert.equal(f.boards.get('owner', 'default').revision, 2);
});

for (const stop of ['stop', 'reset', 'close'] as const) test(`Codex ${stop} aborts a pending write, retaining uncertain mutation without replay`, async t => {
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const f = await fixture(t, async (_url, init) => { started(); return new Promise<Response>((_resolve, reject) => {
    init!.signal!.addEventListener('abort', () => reject(Error('synthetic cancel')), { once: true });
  }); });
  f.begin();
  const input = { revision: 1, mutationId: randomUUID(), tasks: [{ id: f.taskId, status: 'done' }] };
  const pending = f.tools.invoke(f.call(BOARD_UPDATE_TOOL, input)); await ready;
  assert.equal(f.tools.inFlight, 1);
  assert.equal(content(await f.tools.invoke(f.call())).status, 429, 'same thread operations are serialized without queuing');
  if (stop === 'stop') f.tools.stop(f.threadId); else await f.tools[stop]();
  const result = await pending;
  assert.equal(result.success, false); assert.equal(content(result).uncertain, true);
  assert.equal(content(result).mutationId, input.mutationId); assert.equal(f.calls, 1);
  assert.equal(f.tools.inFlight, 0);
  assert.equal((await f.tools.invoke(f.call())).success, false); assert.equal(f.calls, 1);
});

test('Codex call budget is bounded per admitted turn and cannot be reset by changing call ids', async t => {
  const f = await fixture(t); f.begin();
  await rm(f.path);
  for (let i = 0; i < 512; i++) assert.equal((await f.tools.invoke(f.call())).success, false);
  assert.match(content(await f.tools.invoke(f.call())).error, /budget exceeded/);
  assert.equal(f.calls, 0);
});
