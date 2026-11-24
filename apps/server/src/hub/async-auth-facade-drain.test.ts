import assert from 'node:assert/strict';
import test from 'node:test';
import { AsyncHubMemberSessions } from './async-member-session.js';
import { AsyncHubAuditLog } from './async-audit-log.js';
import { AsyncHubLoginLimiter } from './async-login-limiter.js';
import { AsyncHubWorkspacePreferences } from './async-workspace-preferences.js';
import { HubMemberRequestError } from './async-member-request.js';
import type { AsyncHubMemberOwner } from './async-member-owner.js';
import { AuthPersistenceError } from '../auth/private-store.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const quiet = new PerformanceDiagnostics(() => {});
const key = 'hub_key_' + 'x'.repeat(43), token = 'hub_session_' + 'y'.repeat(43);
const snapshot = { principal: { userId: 'member', admin: true }, recoveryScope: 'a'.repeat(64) };
const document = { revision: 0, groups: [], sessions: {} };
const record = { event: 'access_key_login', outcome: 'failure' } as const;
const request = () => new Request('http://fixture.invalid/');
const port = (command: (kind: string, input: unknown) => unknown) => ({
  command: async (kind: string, input: unknown) => command(kind, input),
}) as Pick<AsyncHubMemberOwner, 'command'>;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const unavailable = (error: unknown) => error instanceof HubMemberRequestError && error.status === 503;

test('member session drain freezes old and new request closures and never delivers a late issued cookie', async () => {
  const original = deferred<unknown>(); let calls = 0, settled = false;
  const service = new AsyncHubMemberSessions(port(() => { calls++; return original.promise; }), quiet);
  const caller = service.forRequest(request());
  const operation = assert.rejects(caller.memberLogin(key), AuthPersistenceError);
  assert.equal(calls, 1);
  const closing = service.close();
  assert.equal(service.close(), closing);
  void closing.then(() => { settled = true; });
  await assert.rejects(caller.memberLogin(undefined), AuthPersistenceError);
  await assert.rejects(caller.memberSessionCurrent(token), AuthPersistenceError);
  await assert.rejects(caller.revokeMemberSession(token), AuthPersistenceError);
  await assert.rejects(service.memberLogin(key, request()), AuthPersistenceError);
  await tick(); assert.equal(settled, false); assert.equal(service.pending, 1);
  original.resolve({ token }); await operation; await closing;
  assert.equal(service.pending, 0); assert.equal(calls, 1);
});

test('session proof timeout does not settle drain or release its real pending read', async () => {
  const original = deferred<unknown>(); let calls = 0;
  const service = new AsyncHubMemberSessions(port(() => { calls++; return original.promise; }), quiet, 5, 5);
  const caller = service.forRequest(request());
  await assert.rejects(caller.memberSessionCurrent(token), AuthPersistenceError);
  assert.equal(service.pending, 1);
  let settled = false; const closing = service.close(); void closing.then(() => { settled = true; });
  await tick(); assert.equal(settled, false);
  original.resolve(snapshot); await closing;
  await assert.rejects(caller.memberSessionCurrent(token), AuthPersistenceError);
  assert.equal(calls, 1); assert.equal(service.pending, 0);
});

test('session proof closing before real ACK cannot deliver stale authorization', async () => {
  const original = deferred<unknown>();
  const service = new AsyncHubMemberSessions(port(() => original.promise), quiet);
  const operation = assert.rejects(service.memberSessionCurrent(token, request()), AuthPersistenceError);
  const closing = service.close(); original.resolve(snapshot);
  await operation; await closing;
});

for (const kind of ['check', 'recordFailure', 'recordSuccess'] as const) {
  test(`limiter ${kind} drain waits the original ban transaction and refuses all later calls`, async () => {
    const original = deferred<unknown>(); let calls = 0, closed = false;
    const service = new AsyncHubLoginLimiter(port(() => { calls++; return original.promise; }), quiet);
    const operation = service[kind]('a'.repeat(24));
    const closing = service.close(); assert.equal(service.close(), closing);
    void closing.then(() => { closed = true; });
    for (const method of ['check', 'recordFailure', 'recordSuccess'] as const)
      await assert.rejects(service[method]('a'.repeat(24)), AuthPersistenceError);
    await tick(); assert.equal(closed, false); assert.equal(service.pending, 1);
    original.resolve(kind === 'recordSuccess' ? null : { allowed: false, failureCount: 3, retryAfterSeconds: 60 });
    await operation; await closing;
    assert.equal(calls, 1); assert.equal(service.pending, 0);
  });
}

test('late owner failure settles facade drain without replay or reopening the failed request', async () => {
  const original = deferred<unknown>(); let calls = 0;
  const service = new AsyncHubMemberSessions(port(() => { calls++; return original.promise; }), quiet);
  const caller = service.forRequest(request());
  const operation = assert.rejects(caller.revokeMemberSession(token), AuthPersistenceError);
  const closing = service.close(); original.reject(Error('private-owner-error'));
  await operation; await closing;
  await assert.rejects(caller.memberLogin(key), AuthPersistenceError);
  assert.equal(calls, 1); assert.equal(service.pending, 0);
});

test('audit drain waits append and authorized pruning together, freezes before diagnostics reentry', async () => {
  const append = deferred<unknown>(), page = deferred<unknown>(), pruning = deferred<void>();
  let writes = 0, reentered = false, service!: AsyncHubAuditLog, observed: Promise<unknown>[] = [];
  let reentrantClosing: Promise<void> | undefined;
  const diagnostics = new PerformanceDiagnostics(() => {}, () => {
    if (service && !reentered) {
      reentered = true;
      reentrantClosing = service.close();
      observed.push(assert.rejects(service.append(record), AuthPersistenceError));
      observed.push(assert.rejects(service.page({}, request()), AuthPersistenceError));
    }
    return 1;
  });
  // Disable reentry while original requests are admitted; enable only at close.
  reentered = true;
  service = new AsyncHubAuditLog(port(kind => {
    if (kind === 'memberSnapshot') return snapshot;
    writes++;
    if (kind === 'auditAppend') return append.promise;
    assert.equal(kind, 'auditPage'); pruning.resolve(); return page.promise;
  }), diagnostics);
  const appendWork = service.append(record);
  const pageWork = assert.rejects(service.page({}, request()), unavailable);
  await pruning.promise; assert.equal(service.pending, 2);
  reentered = false;
  const closing = service.close();
  assert.equal(reentrantClosing, closing);
  assert.equal(observed.length, 2);
  assert.equal(service.close(), closing);
  let closed = false; void closing.then(() => { closed = true; });
  await assert.rejects(service.list(10, request()), AuthPersistenceError);
  await Promise.all(observed); append.resolve(null); await appendWork;
  await tick(); assert.equal(closed, false); assert.equal(service.pending, 1);
  page.resolve({ records: [], retentionDays: 90, maxRecords: 10000, persistent: true, startedAt: 1 });
  await pageWork; await closing;
  assert.equal(writes, 2); assert.equal(service.pending, 0);
});

test('workspace drain preserves an admitted CAS while refusing principal and final response after close', async () => {
  const original = deferred<unknown>(), admitted = deferred<void>(); let writes = 0;
  const service = new AsyncHubWorkspacePreferences(port(kind => {
    if (kind === 'memberSnapshot') return snapshot;
    assert.equal(kind, 'workspaceSave'); writes++; admitted.resolve(); return original.promise;
  }), quiet);
  const operation = assert.rejects(service.save(request(), 'member', document), unavailable);
  await admitted.promise; const closing = service.close(); assert.equal(service.close(), closing);
  let closed = false; void closing.then(() => { closed = true; });
  await assert.rejects(service.principal(request()), unavailable);
  await assert.rejects(service.get(request(), 'member'), unavailable);
  await assert.rejects(service.save(request(), 'member', document), unavailable);
  await tick(); assert.equal(closed, false); assert.equal(service.pending, 1);
  original.resolve({ document: { ...document, revision: 1 } }); await operation; await closing;
  assert.equal(writes, 1); assert.equal(service.pending, 0);
});

test('workspace timed-out read still drains its original work and never starts replacement IO', async () => {
  const original = deferred<unknown>(); let reads = 0;
  const service = new AsyncHubWorkspacePreferences(port(kind => {
    if (kind === 'memberSnapshot') return snapshot;
    assert.equal(kind, 'workspaceGet'); reads++; return original.promise;
  }), quiet, 5, 5);
  await assert.rejects(service.get(request(), 'member'), unavailable);
  let closed = false; const closing = service.close(); void closing.then(() => { closed = true; });
  await tick(); assert.equal(closed, false); assert.equal(service.pending, 1);
  original.resolve({ document }); await closing;
  await assert.rejects(service.get(request(), 'member'), unavailable);
  assert.equal(reads, 1); assert.equal(service.pending, 0);
});

test('facade close logs contain numeric drain evidence without credentials or owner error strings', async () => {
  const lines: string[] = [], original = deferred<unknown>();
  const service = new AsyncHubMemberSessions(port(() => original.promise), new PerformanceDiagnostics(line => lines.push(line)), 5);
  const operation = assert.rejects(service.memberLogin(key, request()), AuthPersistenceError);
  const closing = service.close();
  await new Promise(resolve => setTimeout(resolve, 20));
  original.reject(Error('private-owner-error')); await operation; await closing;
  const text = lines.join('\n');
  assert.ok(text.includes('"step":73')); assert.ok(text.includes('"phase":"pending"'));
  for (const secret of [key, token, 'private-owner-error', 'fixture.invalid']) assert.equal(text.includes(secret), false);
});
