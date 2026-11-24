import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { AsyncHubSessionNotebooks } from './async-session-notebooks.js';
import type { AsyncHubMemberOwner } from './async-member-owner.js';
import type { HubMemberKind } from './member-owner-domain.js';
import { HubMemberRequestError } from './async-member-request.js';
import { notebookHash, type NotebookMove } from './notebook-operations.js';
import { AuthRoutePersistence } from '../auth/route-persistence.js';
import { AuthRouteReadWait } from '../auth/route-read-wait.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const quiet = new PerformanceDiagnostics(() => {});
const snapshot = () => ({ principal: { userId: 'member', admin: false }, recoveryScope: 'a'.repeat(64) });
const request = (signal?: AbortSignal) => new Request('http://fixture.invalid/', {
  headers: { cookie: 'agentopsdeck_session=hub_session_' + 'x'.repeat(43) }, ...(signal ? { signal } : {}),
});
const doc = () => ({ resourceId: 'hub:default', revision: 0, text: 'Private notebook sentinel' });
const saved = (d = doc(), action: 'save' | 'saveArchive' = 'save') => ({ action, document: { ...d, revision: d.revision + 1, updatedAt: 1 } });
const port = (command: (kind: HubMemberKind, input: unknown) => unknown | Promise<unknown>) => ({
  command: async (kind: HubMemberKind, input: unknown) => command(kind, input),
}) as Pick<AsyncHubMemberOwner, 'command'>;
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const status = (code: number) => (e: unknown) => e instanceof HubMemberRequestError && e.status === code;

test('notebook caller pins exact text, resource, CAS and original credentials before authority await', async () => {
  const wait = deferred<unknown>(), d = doc(), original = { ...d }, req = request(); let captured: unknown;
  const service = new AsyncHubSessionNotebooks(port((kind, body) => {
    if (kind === 'memberSnapshot') return captured ? snapshot() : wait.promise;
    captured = body; return saved(original);
  }), quiet);
  const pending = service.save(req, 'member', d);
  d.text = 'mutated'; d.revision = 5; d.resourceId = 'other'; req.headers.set('cookie', 'agentopsdeck_session=hub_session_' + 'z'.repeat(43));
  wait.resolve(snapshot()); assert.equal((await pending)?.text, original.text);
  const proof = captured as { evidence: { sessionToken: string }; command: { document: unknown } };
  assert.deepEqual(proof.command.document, original); assert.equal(proof.evidence.sessionToken, 'hub_session_' + 'x'.repeat(43));
});
test('notebook caller refuses principal substitution, getter invocation and invalid body before dispatch', async () => {
  let calls = 0, touched = 0;
  const service = new AsyncHubSessionNotebooks(port(() => { calls++; return snapshot(); }), quiet);
  await assert.rejects(service.get(request(), 'other', 'hub:default'), status(401)); assert.equal(calls, 1);
  const d = doc(); Object.defineProperty(d, 'text', { enumerable: true, get() { touched++; return 'note'; } });
  await assert.rejects(service.save(request(), 'member', d), status(400)); assert.equal(touched, 0);
  await assert.rejects(service.save(request(), 'member', { ...doc(), bindingId: randomUUID() } as ReturnType<typeof doc>), status(400));
  await assert.rejects(service.searchAreas(request(), 'member', 'hub:default', ' ', 'hot'), status(400)); assert.equal(calls, 1);
});
test('notebook save accepted before abort stays pending until real settlement without replay and logs phase72 only', async () => {
  const wait = deferred<unknown>(), controller = new AbortController(), logs: string[] = []; let writes = 0;
  const d = doc();
  const service = new AsyncHubSessionNotebooks(port(kind => { if (kind === 'memberSnapshot') return snapshot(); writes++; return wait.promise; }),
    new PerformanceDiagnostics(line => logs.push(line)), 5, 5);
  const pending = assert.rejects(service.save(request(controller.signal), 'member', d), status(499));
  await tick(); controller.abort(); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(writes, 1); assert.equal(service.pending, 1);
  assert.ok(logs.some(line => line.includes('"phase":"pending"') && line.includes('"step":72')));
  wait.resolve(saved(d)); await pending; assert.equal(service.pending, 0); assert.equal(writes, 1);
  for (const secret of [d.text, d.resourceId, 'x'.repeat(43)]) assert.equal(logs.join('').includes(secret), false);
});
test('notebook read timeout retains reservation until late failure and never redispatches', async () => {
  const wait = deferred<unknown>(); let reads = 0;
  const service = new AsyncHubSessionNotebooks(port(kind => { if (kind === 'memberSnapshot') return snapshot(); reads++; return wait.promise; }), quiet, 5, 5);
  await assert.rejects(service.getArchive(request(), 'member', 'hub:default'), status(503));
  assert.equal(service.pending, 1); assert.equal(reads, 1);
  wait.reject(Error('late failure')); await tick(); assert.equal(service.pending, 0); assert.equal(reads, 1);
});
test('notebook read cancellation observes late success without delivering stale text', async () => {
  const wait = deferred<unknown>(), controller = new AbortController(); let reads = 0;
  const service = new AsyncHubSessionNotebooks(port(kind => { if (kind === 'memberSnapshot') return snapshot(); reads++; return wait.promise; }), quiet);
  const pending = assert.rejects(service.get(request(controller.signal), 'member', 'hub:default'), status(499));
  await tick(); controller.abort(); await pending; assert.equal(service.pending, 1);
  wait.resolve({ action: 'get', document: { ...doc(), revision: 1, updatedAt: 1 } }); await tick();
  assert.equal(service.pending, 0); assert.equal(reads, 1);
});
test('notebook write/move phase is never eligible for read timeout wrapper', async () => {
  const reads = new AuthRouteReadWait(new AuthRoutePersistence(quiet), quiet, 5); let writes = 0;
  await assert.rejects(reads.run(request(), 72 as never, () => { writes++; return null; })); assert.equal(writes, 0);
});
test('post-commit authority loss denies delivery but never undoes, duplicates or changes move receipt', async () => {
  const text = 'selected private text', move: NotebookMove = { requestId: randomUUID(), direction: 'archive', hotRevision: 1, coldRevision: 0,
    ranges: [{ start: 0, end: text.length, sha256: notebookHash(text) }] }; let checks = 0, writes = 0;
  const service = new AsyncHubSessionNotebooks(port((kind, body) => {
    if (kind === 'memberSnapshot') return ++checks === 1 ? snapshot() : { ...snapshot(), recoveryScope: 'b'.repeat(64) };
    writes++; assert.deepEqual((body as { command: { input: NotebookMove } }).command.input, move);
    return { action: 'move', resourceId: doc().resourceId, requestId: move.requestId, result: { hotRevision: 2, coldRevision: 1, moved: text.length } };
  }), quiet);
  await assert.rejects(service.move(request(), 'member', doc().resourceId, move), status(401)); assert.equal(writes, 1); assert.equal(checks, 2);
});
test('move caller snapshots range array and original request ID without transporting callbacks', async () => {
  const wait = deferred<unknown>(), text = 'selection', move: NotebookMove = { requestId: randomUUID(), direction: 'archive', hotRevision: 1, coldRevision: 0,
    ranges: [{ start: 0, end: text.length, sha256: notebookHash(text) }] }, original = structuredClone(move); let dispatched = false;
  const service = new AsyncHubSessionNotebooks(port((kind, body) => {
    if (kind === 'memberSnapshot') return dispatched ? snapshot() : wait.promise;
    dispatched = true; assert.deepEqual((body as { command: { input: unknown } }).command.input, original);
    return { action: 'move', resourceId: doc().resourceId, requestId: original.requestId, result: { hotRevision: 2, coldRevision: 1, moved: text.length } };
  }), quiet);
  const pending = service.move(request(), 'member', doc().resourceId, move);
  move.requestId = randomUUID(); move.ranges[0]!.end = 1; move.ranges.length = 0; wait.resolve(snapshot());
  assert.deepEqual(await pending, { hotRevision: 2, coldRevision: 1, moved: text.length });
});
for (const action of ['save', 'saveArchive', 'move', 'receipt'] as const) {
  test(`notebook ${action} conflict/missing stays undefined without retry`, async () => {
    let calls = 0; const id = randomUUID(), move: NotebookMove = { requestId: id, direction: 'archive', hotRevision: 1, coldRevision: 0,
      ranges: [{ start: 0, end: 4, sha256: notebookHash('text') }] };
    const service = new AsyncHubSessionNotebooks(port(kind => {
      if (kind === 'memberSnapshot') return snapshot(); calls++;
      return action === 'save' || action === 'saveArchive' ? { action, document: null } : { action, resourceId: doc().resourceId, requestId: id, result: null };
    }), quiet);
    const value = action === 'save' || action === 'saveArchive' ? await service[action](request(), 'member', doc())
      : action === 'move' ? await service.move(request(), 'member', doc().resourceId, move) : await service.moveReceipt(request(), 'member', doc().resourceId, id);
    assert.equal(value, undefined); assert.equal(calls, 1);
  });
}
test('malformed action, revision or content ACK is storage503 and never a successful save', async () => {
  for (const value of [true, { action: 'archive', document: saved().document }, { ...saved(), document: { ...saved().document, revision: 2 } },
    { ...saved(), document: { ...saved().document, text: 'wrong content' } }]) {
    let writes = 0;
    const service = new AsyncHubSessionNotebooks(port(kind => { if (kind === 'memberSnapshot') return snapshot(); writes++; return value; }), quiet);
    await assert.rejects(service.save(request(), 'member', doc()), status(503)); assert.equal(writes, 1);
  }
});
