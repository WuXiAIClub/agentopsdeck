import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { AsyncHubWorkspaceBoardMachine } from './async-workspace-board-machine.js';
import type { AsyncHubMemberOwner } from './async-member-owner.js';
import type { HubBoardMachineCommand } from './member-board-machine-domain.js';
import { HubMemberRequestError } from './async-member-request.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { AuthRoutePersistence } from '../auth/route-persistence.js';
import { AuthRouteReadWait } from '../auth/route-read-wait.js';

const token = 'aod_board_' + 'a'.repeat(43), quiet = new PerformanceDiagnostics(() => {});
const document = () => ({ revision: 1, mutationId: randomUUID(), tasks: [{ id: randomUUID(), detail: 'private payload' }] });
const port = (fn: (v: HubBoardMachineCommand) => unknown | Promise<unknown>) => ({
  command: async (kind: string, value: HubBoardMachineCommand) => { assert.equal(kind, 'boardMachine'); return fn(value); },
}) as Pick<AsyncHubMemberOwner, 'command'>;
const saved = (v: { mutationId: string }) => ({ action: 'update', result: { status: 'saved', revision: 2, mutationId: v.mutationId } });
const authorized = (value = true) => ({ action: 'authorized', authorized: value });
const snapshot = { resourceId: 'default', revision: 1, tasks: [{ id: randomUUID(), title: 'Task', status: 'todo' as const, detail: 'private detail' }] };
const status = (code: number) => (e: unknown) => e instanceof HubMemberRequestError && e.status === code;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (v: T) => void, reject!: (e: Error) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

test('machine proof and mutation DTO are owned before wait; accessors never run', async () => {
  const wait = deferred<unknown>(), input = document(), original = structuredClone(input); let captured: unknown, calls = 0, getters = 0;
  const service = new AsyncHubWorkspaceBoardMachine(port(v => {
    calls++; if (v.action === 'authorized') return authorized(); captured = v; return wait.promise;
  }), quiet);
  const pending = service.update(token, input); input.tasks[0]!.detail = 'changed'; input.mutationId = randomUUID();
  assert.deepEqual(captured, { action: 'update', token, document: original }); wait.resolve(saved(original));
  assert.deepEqual(await pending, saved(original).result);
  const bad = document(); Object.defineProperty(bad, 'tasks', { enumerable: true, get() { getters++; return []; } });
  await assert.rejects(service.update(token, bad), status(400)); assert.equal(getters, 0); assert.equal(calls, 2);
});
test('read timeout retains original owner reservation and observes late failure without replay', async () => {
  const wait = deferred<unknown>(); let calls = 0;
  const service = new AsyncHubWorkspaceBoardMachine(port(() => { calls++; return wait.promise; }), quiet, 5, 5);
  await assert.rejects(service.read(token), status(503)); assert.equal(service.pending, 1); assert.equal(calls, 1);
  wait.reject(Error('late storage failure')); await tick(); assert.equal(service.pending, 0); assert.equal(calls, 1);
});
test('aborted machine read keeps actual settlement charged and publishes no stale data', async () => {
  const wait = deferred<unknown>(), controller = new AbortController(); let calls = 0;
  const service = new AsyncHubWorkspaceBoardMachine(port(() => { calls++; return wait.promise; }), quiet);
  const pending = assert.rejects(service.read(token, {}, new Request('http://fixture.invalid/', { signal: controller.signal })), status(499));
  await tick(); controller.abort(); await pending; assert.equal(service.pending, 1);
  wait.resolve({ action: 'read', snapshot }); await tick(); assert.equal(service.pending, 0); assert.equal(calls, 1);
});
test('accepted mutation outlives abort and read deadline; logs contain phase only, not credentials or text', async () => {
  const wait = deferred<unknown>(), controller = new AbortController(), logs: string[] = [], input = document(); let writes = 0;
  const service = new AsyncHubWorkspaceBoardMachine(port(v => {
    if (v.action === 'authorized') return authorized(); writes++; return wait.promise;
  }), new PerformanceDiagnostics(line => logs.push(line)), 5, 5);
  const pending = service.update(token, input, new Request('http://fixture.invalid/', { signal: controller.signal }));
  controller.abort(); await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(service.pending, 1); assert.equal(writes, 1);
  wait.resolve(saved(input)); assert.deepEqual(await pending, saved(input).result); assert.equal(service.pending, 0);
  assert.ok(logs.some(v => v.includes('"step":70') && v.includes('"phase":"pending"')));
  const text = logs.join('\n'); for (const secret of [token, input.mutationId, input.tasks[0]!.id, 'private payload']) assert.equal(text.includes(secret), false);
});
test('current capability is checked after read and after commit, without mutation replay', async () => {
  let writes = 0;
  const service = new AsyncHubWorkspaceBoardMachine(port(v => {
    if (v.action === 'authorized') return authorized(false);
    if (v.action === 'read') return { action: 'read', snapshot }; writes++; return saved(v.document);
  }), quiet);
  assert.equal(await service.read(token), undefined); assert.deepEqual(await service.update(token, document()), { status: 'denied' });
  assert.equal(writes, 1);
});
test('unknown write ACK cannot invent success or replay; write phase cannot enter cancellable read wrapper', async () => {
  let writes = 0;
  const service = new AsyncHubWorkspaceBoardMachine(port(() => { writes++; return saved(document()); }), quiet);
  await assert.rejects(service.update(token, document()), status(503)); assert.equal(writes, 1);
  const reads = new AuthRouteReadWait(new AuthRoutePersistence(quiet), quiet); let ran = false;
  await assert.rejects(reads.run(new Request('http://fixture.invalid/'), 70 as never, () => { ran = true; return true; })); assert.equal(ran, false);
});
test('legacy read and paged revision-pin retain original shapes; unexpected page fails closed', async () => {
  const service = new AsyncHubWorkspaceBoardMachine(port(v => v.action === 'authorized' ? authorized()
    : { action: 'read', snapshot: v.action === 'read' && Object.keys(v.query).length ? { ...snapshot,
      tasks: snapshot.tasks.map(({ detail, ...t }) => t), page: { offset: 0, limit: 20, total: 1, nextOffset: null } } : snapshot }), quiet);
  assert.deepEqual(await service.read(token), snapshot);
  const page = await service.read(token, { revision: 1 });
  assert.ok(page && !('error' in page)); assert.equal(page.revision, 1);
  const bad = new AsyncHubWorkspaceBoardMachine(port(() => ({ action: 'read', snapshot: { ...snapshot,
    page: { offset: 0, limit: 20, total: 1, nextOffset: null } } })), quiet);
  await assert.rejects(bad.read(token), status(503));
});

for (const method of ['read', 'update'] as const) for (const phase of ['original', 'final'] as const) {
  test(`close fences machine ${method} at ${phase} and drains original ownership without another command`, async () => {
    const gate = deferred<unknown>(), arrived = deferred<void>(), input = document(); let calls = 0;
    const service = new AsyncHubWorkspaceBoardMachine(port(command => {
      calls++;
      if (phase === 'original' || command.action === 'authorized') { arrived.resolve(); return gate.promise; }
      return command.action === 'read' ? { action: 'read', snapshot } : saved(input);
    }), quiet);
    const pending = assert.rejects(method === 'read' ? service.read(token) : service.update(token, input), status(503));
    await arrived.promise;
    assert.equal(service.pendingWork, 1); assert.equal(service.pending, 1);
    let drained = false;
    const closing = service.close(); void closing.then(() => { drained = true; });
    assert.equal(service.close(), closing);
    await assert.rejects(service.authorized(token), status(503));
    await assert.rejects(service.read(token), status(503));
    await assert.rejects(service.update(token, input), status(503));
    await tick(); assert.equal(drained, false); assert.equal(service.pendingWork, 1);
    const before = calls;
    gate.resolve(phase === 'final' ? authorized() : method === 'read' ? { action: 'read', snapshot } : saved(input));
    await pending; await closing;
    assert.equal(calls, before); assert.equal(service.pending, 0); assert.equal(service.pendingWork, 0);
  });
}
test('cancelled read still drains its SQL reservation and cannot publish or start final proof', async () => {
  const gate = deferred<unknown>(), controller = new AbortController(); let calls = 0, drained = false;
  const service = new AsyncHubWorkspaceBoardMachine(port(() => { calls++; return gate.promise; }), quiet);
  const pending = assert.rejects(service.read(token, {}, new Request('http://fixture.invalid/', { signal: controller.signal })), status(499));
  controller.abort(); await pending;
  assert.equal(service.pendingWork, 0); assert.equal(service.pending, 1);
  const closing = service.close(); void closing.then(() => { drained = true; });
  await tick(); assert.equal(drained, false);
  gate.resolve({ action: 'read', snapshot }); await closing;
  assert.equal(calls, 1); assert.equal(service.pending, 0);
});
test('diagnostic reentrant close freezes machine admission before any original dispatch', async () => {
  let calls = 0, nested: Promise<void> | undefined;
  const diagnostics = new PerformanceDiagnostics(() => {});
  const service = new AsyncHubWorkspaceBoardMachine(port(() => { calls++; return authorized(); }), diagnostics);
  const start = diagnostics.start.bind(diagnostics);
  diagnostics.start = (...args) => { nested ??= service.close(); return start(...args); };
  await assert.rejects(service.authorized(token), status(503));
  await nested; assert.equal(calls, 0); assert.equal(service.pendingWork, 0);
  await assert.rejects(service.update(token, {} as never), status(503));
});
test('whole-operation admission is bounded and one close retains every original reservation', async () => {
  const gate = deferred<unknown>(); let calls = 0;
  const service = new AsyncHubWorkspaceBoardMachine(port(() => { calls++; return gate.promise; }), quiet);
  const pending = Array.from({ length: 256 }, () => assert.rejects(service.authorized(token), status(503)));
  assert.equal(service.pendingWork, 256); assert.equal(service.pending, 256);
  await assert.rejects(service.authorized(token), status(503)); assert.equal(calls, 256);
  const closing = service.close(); gate.resolve(authorized());
  await Promise.all(pending); await closing;
  assert.equal(service.pending, 0); assert.equal(service.pendingWork, 0); assert.equal(calls, 256);
});
