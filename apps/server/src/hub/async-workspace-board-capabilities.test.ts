import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { AsyncHubWorkspaceBoardCapabilities } from './async-workspace-board-capabilities.js';
import type { AsyncHubMemberOwner } from './async-member-owner.js';
import type { HubMemberKind } from './member-owner-domain.js';
import type { BoardCapabilityInput } from './workspace-board-capabilities.js';
import { HubMemberRequestError } from './async-member-request.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { AuthRoutePersistence } from '../auth/route-persistence.js';
import { AuthRouteReadWait } from '../auth/route-read-wait.js';

const quiet = new PerformanceDiagnostics(() => {});
const snapshot = () => ({ principal: { userId: 'member', admin: false }, recoveryScope: 'a'.repeat(64) });
const request = (signal?: AbortSignal) => new Request('http://fixture.invalid/', {
  headers: { cookie: 'agentopsdeck_session=hub_session_' + 'x'.repeat(43) }, ...(signal ? { signal } : {}),
});
const input = (): BoardCapabilityInput => ({ taskIds: [randomUUID()], fields: ['status'], expiresAt: Date.now() + 60_000 });
const issued = (v: BoardCapabilityInput) => ({ action: 'issue', issued: { token: 'aod_board_' + 'z'.repeat(43), capability: {
  ...v, id: randomUUID(), resourceId: 'default', createdAt: Date.now(), revokedAt: null,
} } });
const port = (fn: (kind: HubMemberKind, proof: unknown) => unknown | Promise<unknown>) => ({
  command: async (kind: HubMemberKind, proof: unknown) => fn(kind, proof),
}) as Pick<AsyncHubMemberOwner, 'command'>;
function deferred<T>() { let resolve!: (v: T) => void; let reject!: (e: Error) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const status = (code: number) => (e: unknown) => e instanceof HubMemberRequestError && e.status === code;

test('grant DTO and original cookie are captured before permission wait', async () => {
  const wait = deferred<unknown>(); let checks = 0, captured: unknown;
  const v = input(), expected = structuredClone(v), raw = request();
  const service = new AsyncHubWorkspaceBoardCapabilities(port((kind, proof) => {
    if (kind === 'memberSnapshot') return ++checks === 1 ? wait.promise : snapshot();
    captured = proof; return issued(expected);
  }), quiet);
  const pending = service.issue(raw, 'member', 'default', v);
  v.taskIds[0] = randomUUID(); v.fields[0] = 'detail'; v.expiresAt = 0;
  raw.headers.set('cookie', 'agentopsdeck_session=hub_session_' + 'q'.repeat(43)); wait.resolve(snapshot());
  assert.ok(await pending);
  const proof = captured as { evidence: { sessionToken: string }; command: { input: BoardCapabilityInput } };
  assert.deepEqual(proof.command.input, expected); assert.equal(proof.evidence.sessionToken, 'hub_session_' + 'x'.repeat(43));
});
test('user substitution, invalid IDs/DTO and accessors cannot reach command dispatch', async () => {
  let calls = 0, touched = 0;
  const service = new AsyncHubWorkspaceBoardCapabilities(port(() => { calls++; return snapshot(); }), quiet);
  await assert.rejects(service.list(request(), 'other', 'default'), status(401)); assert.equal(calls, 1);
  await assert.rejects(service.revoke(request(), 'member', 'default', '../private'), status(400));
  await assert.rejects(service.events(request(), 'member', 'default', 0), status(400));
  const v = input(); Object.defineProperty(v, 'taskIds', { enumerable: true, get() { touched++; return []; } });
  await assert.rejects(service.issue(request(), 'member', 'default', v), status(400));
  assert.equal(touched, 0); assert.equal(calls, 1);
});
test('aborted issuance remains charged until original settlement; no token/body in logs and no replay', async () => {
  const wait = deferred<unknown>(), controller = new AbortController(), logs: string[] = []; let writes = 0;
  const v = input();
  const service = new AsyncHubWorkspaceBoardCapabilities(port(kind => {
    if (kind === 'memberSnapshot') return snapshot(); writes++; return wait.promise;
  }), new PerformanceDiagnostics(line => logs.push(line)), 5, 5);
  const pending = assert.rejects(service.issue(request(controller.signal), 'member', 'default', v), status(499));
  await tick(); controller.abort(); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(service.pending, 1); assert.equal(writes, 1);
  assert.ok(logs.some(line => line.includes('"phase":"pending"') && line.includes('"step":68')));
  wait.resolve(issued(v)); await pending; assert.equal(service.pending, 0); assert.equal(writes, 1);
  const text = logs.join('\n'); for (const secret of ['aod_board_', 'hub_session_', v.taskIds[0]!]) assert.equal(text.includes(secret), false);
});
test('revocation has no read deadline, and runtime read wrapper refuses write phase 68', async () => {
  const wait = deferred<unknown>(); let writes = 0;
  const service = new AsyncHubWorkspaceBoardCapabilities(port(kind => {
    if (kind === 'memberSnapshot') return snapshot(); writes++; return wait.promise;
  }), quiet, 5, 5);
  const pending = service.revoke(request(), 'member', 'default', randomUUID());
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(service.pending, 1);
  wait.resolve({ action: 'revoke', revoked: true }); assert.equal(await pending, true); assert.equal(writes, 1);
  let dispatched = false;
  await assert.rejects(new AuthRouteReadWait(new AuthRoutePersistence(quiet), quiet, 5).run(request(), 68 as never, () => { dispatched = true; return true; }));
  assert.equal(dispatched, false);
});
test('read timeout retains pending original slot through late failure without unhandled rejection', async () => {
  const wait = deferred<unknown>(); let reads = 0;
  const service = new AsyncHubWorkspaceBoardCapabilities(port(kind => {
    if (kind === 'memberSnapshot') return snapshot(); reads++; return wait.promise;
  }), quiet, 5, 5);
  await assert.rejects(service.list(request(), 'member', 'default'), status(503));
  assert.equal(service.pending, 1); wait.reject(Error('late failure')); await tick();
  assert.equal(service.pending, 0); assert.equal(reads, 1);
});
test('post-COMMIT scope change denies token delivery, never reissues an accepted grant', async () => {
  let checks = 0, writes = 0; const v = input();
  const service = new AsyncHubWorkspaceBoardCapabilities(port(kind => {
    if (kind === 'memberSnapshot') return ++checks === 1 ? snapshot() : { ...snapshot(), recoveryScope: 'b'.repeat(64) };
    writes++; return issued(v);
  }), quiet);
  await assert.rejects(service.issue(request(), 'member', 'default', v), status(401)); assert.equal(writes, 1);
});
test('quota refusal, missing revocation and lost reply preserve original API outcomes with one dispatch', async () => {
  for (const action of ['issue', 'revoke', 'failure'] as const) {
    let writes = 0;
    const service = new AsyncHubWorkspaceBoardCapabilities(port(kind => {
      if (kind === 'memberSnapshot') return snapshot(); writes++;
      if (action === 'failure') throw Error('unknown commit');
      return action === 'issue' ? { action: 'issue', issued: null } : { action: 'revoke', revoked: false };
    }), quiet);
    if (action === 'issue') assert.equal(await service.issue(request(), 'member', 'default', input()), undefined);
    else if (action === 'revoke') assert.equal(await service.revoke(request(), 'member', 'default', randomUUID()), false);
    else await assert.rejects(service.issue(request(), 'member', 'default', input()), status(503));
    assert.equal(writes, 1);
  }
});
test('caller independently rejects miscorrelated action, foreign grant and invalid audit cursor', async () => {
  const v = input();
  for (const value of [{ action: 'revoke', revoked: true }, { ...issued(v), issued: { ...issued(v).issued,
    capability: { ...issued(v).issued.capability, resourceId: randomUUID() } } }]) {
    const service = new AsyncHubWorkspaceBoardCapabilities(port(kind => kind === 'memberSnapshot' ? snapshot() : value), quiet);
    await assert.rejects(service.issue(request(), 'member', 'default', v), status(503));
  }
  const service = new AsyncHubWorkspaceBoardCapabilities(port(kind => kind === 'memberSnapshot' ? snapshot()
    : { action: 'events', events: [{ sequence: 1, capabilityId: randomUUID(), event: 'issued', mutationId: null, revision: null, createdAt: 1 }] }), quiet);
  await assert.rejects(service.events(request(), 'member', 'default', 1), status(503));
});
test('empty legacy lists and events stay unchanged; already aborted read never dispatches', async () => {
  let reads = 0;
  const service = new AsyncHubWorkspaceBoardCapabilities(port((kind, proof) => {
    if (kind === 'memberSnapshot') return snapshot(); reads++;
    const action = (proof as { command: { action: string } }).command.action;
    return action === 'list' ? { action, capabilities: [] } : { action, events: [] };
  }), quiet);
  assert.deepEqual(await service.list(request(), 'member', 'default'), []);
  assert.deepEqual(await service.events(request(), 'member', 'default'), []);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(service.list(request(controller.signal), 'member', 'default'), status(499)); assert.equal(reads, 2);
});
