import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { BoardWrite } from '@agentopsdeck/shared';
import { AsyncHubWorkspaceBoards } from './async-workspace-boards.js';
import type { AsyncHubMemberOwner } from './async-member-owner.js';
import type { HubMemberKind } from './member-owner-domain.js';
import { HubMemberRequestError } from './async-member-request.js';
import { AuthRoutePersistence } from '../auth/route-persistence.js';
import { AuthRouteReadWait } from '../auth/route-read-wait.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import {hubBoardReplyExpectation, validHubBoardCommand, validHubBoardReply} from './member-board-domain.js';

test('atomic board presentation validates public binding, resource correlation and exact wire shape', () => {
  const command = {action: 'snapshot' as const, resourceId: 'default'};
  assert.ok(validHubBoardCommand(command));
  assert.equal(validHubBoardCommand({...command, userId: 'forged'}), false);
  const document = {title: 'Board', tasks: [], resourceId: 'default', revision: 1, updatedAt: 1};
  const binding = {bindingId: randomUUID(), resourceId: 'default', sessionId: 'session', state: 'active', problem: null};
  const expected = hubBoardReplyExpectation(command);
  const reply = {action: 'snapshot', document, binding};
  assert.ok(validHubBoardReply(expected, reply));
  assert.ok(validHubBoardReply(expected, {...reply, binding: null}));
  for (const value of [
    {...reply, action: 'get'}, {...reply, document: {...document, resourceId: 'other'}},
    {...reply, binding: {...binding, resourceId: 'other'}}, {...reply, binding: {...binding, authority: 1}},
    {...reply, binding: {...binding, sessionId: ''}}, {...reply, binding: {...binding, state: 'invalid'}},
  ]) assert.equal(validHubBoardReply(expected, value), false);
});

test('board presentation caller rejects mismatched resource without retry or local fallback', async () => {
  let calls = 0;
  const service = new AsyncHubWorkspaceBoards(port(kind => {
    if (kind === 'memberSnapshot') return snapshot();
    calls++;
    return {action: 'snapshot', document: {title: 'Wrong', tasks: [], resourceId: 'other', revision: 1, updatedAt: 1}, binding: null};
  }), quiet);
  try {
    await assert.rejects(service.snapshot(request(), 'member', 'default'), (error: unknown) => error instanceof HubMemberRequestError && error.status === 503);
    assert.equal(calls, 1);
  } finally { await service.close(); }
});

const quiet = new PerformanceDiagnostics(() => {});
const snapshot = () => ({ principal: { userId: 'member', admin: false }, recoveryScope: 'a'.repeat(64) });
const request = (signal?: AbortSignal) => new Request('http://fixture.invalid/', {
  headers: { cookie: 'agentopsdeck_session=hub_session_' + 'x'.repeat(43) }, ...(signal ? { signal } : {}),
});
const document = (): BoardWrite => ({ title: 'Private body sentinel', revision: 0, mutationId: randomUUID(), tasks: [
  { id: randomUUID(), title: 'Task', detail: 'Private detail sentinel', status: 'todo', tags: ['keep'], priority: 'high', dueDate: '2026-10-14' },
] });
const saved = (input: BoardWrite) => ({ action: 'save', result: { status: 'saved', document: {
  title: input.title, tasks: input.tasks, revision: input.revision + 1, resourceId: 'default', updatedAt: 1,
} } });
const port = (command: (kind: HubMemberKind, input: unknown) => unknown | Promise<unknown>) => ({
  command: async (kind: HubMemberKind, input: unknown) => command(kind, input),
}) as Pick<AsyncHubMemberOwner, 'command'>;
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const status = (code: number) => (error: unknown) => error instanceof HubMemberRequestError && error.status === code;

test('board caller snapshots credentials, revision, mutationId and all optional fields before permission wait', async () => {
  const wait = deferred<unknown>(); let checks = 0, captured: unknown;
  const input = document(), expected = structuredClone(input), raw = request();
  const service = new AsyncHubWorkspaceBoards(port((kind, proof) => {
    if (kind === 'memberSnapshot') return ++checks === 1 ? wait.promise : snapshot();
    captured = proof; return saved(expected);
  }), quiet);
  const pending = service.save(raw, 'member', 'default', input);
  input.title = 'changed'; input.tasks[0]!.tags![0] = 'changed'; input.mutationId = randomUUID(); input.revision = 42;
  raw.headers.set('cookie', 'agentopsdeck_session=hub_session_' + 'z'.repeat(43)); wait.resolve(snapshot());
  assert.equal((await pending).status, 'saved');
  const proof = captured as { evidence: { sessionToken: string }; command: { document: BoardWrite } };
  assert.deepEqual(proof.command.document, expected); assert.equal(proof.evidence.sessionToken, 'hub_session_' + 'x'.repeat(43));
});
test('board caller rejects user substitution, invalid resource, extra write fields and descriptor before dispatch', async () => {
  let calls = 0;
  const service = new AsyncHubWorkspaceBoards(port(() => { calls++; return snapshot(); }), quiet);
  await assert.rejects(service.save(request(), 'other', 'default', document()), status(401)); assert.equal(calls, 1);
  await assert.rejects(service.get(request(), 'member', '../private'), status(400));
  await assert.rejects(service.save(request(), 'member', 'default', { ...document(), userId: 'other' } as BoardWrite), status(400));
  let touched = 0;
  const bad = document(); Object.defineProperty(bad, 'title', { enumerable: true, get() { touched++; return 'title'; } });
  await assert.rejects(service.save(request(), 'member', 'default', bad), status(400)); assert.equal(touched, 0); assert.equal(calls, 1);
});
test('board save abort never cancels pending original commit, releases early or retries; content-free logs identify phase', async () => {
  const wait = deferred<unknown>(), controller = new AbortController(), logs: string[] = []; let writes = 0;
  const input = document();
  const service = new AsyncHubWorkspaceBoards(port(kind => { if (kind === 'memberSnapshot') return snapshot(); writes++; return wait.promise; }),
    new PerformanceDiagnostics(line => logs.push(line)), 5, 5);
  const pending = assert.rejects(service.save(request(controller.signal), 'member', 'default', input), status(499));
  await tick(); controller.abort(); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(service.pending, 1); assert.equal(writes, 1);
  assert.ok(logs.some(line => line.includes('"phase":"pending"') && line.includes('"step":66')));
  wait.resolve(saved(input)); await pending; assert.equal(service.pending, 0); assert.equal(writes, 1);
  for (const secret of ['x'.repeat(43), input.title, input.tasks[0]!.detail, input.mutationId, input.tasks[0]!.id]) assert.equal(logs.join('').includes(secret), false);
});
test('board read timeout retains original reservation until late failure, never rereads', async () => {
  const wait = deferred<unknown>(); let reads = 0;
  const service = new AsyncHubWorkspaceBoards(port(kind => { if (kind === 'memberSnapshot') return snapshot(); reads++; return wait.promise; }), quiet, 5, 5);
  await assert.rejects(service.get(request(), 'member', 'default'), status(503));
  assert.equal(service.pending, 1); assert.equal(reads, 1);
  wait.reject(new Error('late failure sentinel')); await tick(); assert.equal(service.pending, 0); assert.equal(reads, 1);
});
test('board write phase is never eligible for read deadline wrapper', async () => {
  const reads = new AuthRouteReadWait(new AuthRoutePersistence(quiet), quiet, 5); let calls = 0;
  await assert.rejects(reads.run(request(), 66 as never, () => { calls++; return null; })); assert.equal(calls, 0);
});
test('board commit followed by role change denies delivery without undoing, replaying or regenerating mutationId', async () => {
  let checks = 0, writes = 0;
  const input = document();
  const service = new AsyncHubWorkspaceBoards(port(kind => {
    if (kind === 'memberSnapshot') return ++checks === 1 ? snapshot() : { ...snapshot(), recoveryScope: 'b'.repeat(64) };
    writes++; return saved(input);
  }), quiet);
  await assert.rejects(service.save(request(), 'member', 'default', input), status(401)); assert.equal(writes, 1); assert.equal(checks, 2);
});
for (const outcome of ['conflict', 'mutation-reused', 'file-managed', 'limit'] as const) {
  test(`board ${outcome} stays original outcome, never automatically replays`, async () => {
    let writes = 0;
    const service = new AsyncHubWorkspaceBoards(port(kind => {
      if (kind === 'memberSnapshot') return snapshot(); writes++; return { action: 'save', result: { status: outcome } };
    }), quiet);
    assert.deepEqual(await service.save(request(), 'member', 'default', document()), { status: outcome }); assert.equal(writes, 1);
  });
}
test('board caller rejects malformed or miscorrelated replies even for injected owner ports', async () => {
  const input = document();
  for (const reply of [true, { action: 'list', summaries: [] }, saved({ ...input, title: 'wrong' }),
    { action: 'save', result: { status: 'saved', document: { ...saved(input).result.document, resourceId: randomUUID() } } }]) {
    const service = new AsyncHubWorkspaceBoards(port(kind => kind === 'memberSnapshot' ? snapshot() : reply), quiet);
    await assert.rejects(service.save(request(), 'member', 'default', input), status(503));
  }
});
test('board read abort refuses before original command dispatch and read/list/summary shapes remain compatible', async () => {
  const empty = { title: 'Task board', tasks: [], resourceId: 'default', revision: 0, updatedAt: null };
  let reads = 0;
  const service = new AsyncHubWorkspaceBoards(port((kind, proof) => {
    if (kind === 'memberSnapshot') return snapshot(); reads++;
    const action = (proof as { command: { action: string } }).command.action;
    return action === 'get' ? { action, document: empty } : action === 'list' ? { action, summaries: [] }
      : { action, summary: { title: empty.title, resourceId: 'default', revision: 0, updatedAt: null, counts: { todo: 0, doing: 0, done: 0 } } };
  }), quiet);
  assert.deepEqual(await service.get(request(), 'member', 'default'), empty);
  assert.deepEqual(await service.list(request(), 'member'), []);
  assert.deepEqual((await service.summary(request(), 'member', 'default')).counts, { todo: 0, doing: 0, done: 0 });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(service.get(request(controller.signal), 'member', 'default'), status(499)); assert.equal(reads, 3);
});
