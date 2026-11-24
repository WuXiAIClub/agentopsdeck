import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AsyncHubMemberActivity } from './async-member-activity.js';
import type { AsyncHubMemberOwner } from './async-member-owner.js';
import type { HubMemberKind } from './member-owner-domain.js';
import { HubMemberRequestError } from './async-member-request.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
const quiet = new PerformanceDiagnostics(() => {});
const snapshot = () => ({ principal: { userId: 'member', admin: false }, recoveryScope: 'a'.repeat(64) });
const request = (signal?: AbortSignal) => new Request('http://fixture.invalid/', {
  headers: { cookie: 'agentopsdeck_session=hub_session_' + 'x'.repeat(43) }, ...(signal ? { signal } : {}),
});
const port = (command: (kind: HubMemberKind, value: unknown) => unknown | Promise<unknown>) => ({
  command: async (kind: HubMemberKind, value: unknown) => command(kind, value),
}) as Pick<AsyncHubMemberOwner, 'command'>;
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const status = (code: number) => (error: unknown) => error instanceof HubMemberRequestError && error.status === code;
test('activity captures request credentials before async permission lookup', async () => {
  const wait = deferred<unknown>(); let checks = 0, captured: unknown;
  const service = new AsyncHubMemberActivity(port((kind, input) => {
    if (kind === 'memberSnapshot') return ++checks === 1 ? wait.promise : snapshot();
    captured = input; return { ok: true };
  }), quiet);
  const raw = request(), pending = service.recordActivity(raw);
  raw.headers.set('cookie', 'agentopsdeck_session=hub_session_' + 'z'.repeat(43));
  wait.resolve(snapshot()); await pending;
  assert.deepEqual(captured, { evidence: { sessionToken: 'hub_session_' + 'x'.repeat(43) }, expectedScope: 'a'.repeat(64) });
});
test('activity cancellation observes pending write but never releases or replays it', async () => {
  const wait = deferred<unknown>(), controller = new AbortController(), logs: string[] = []; let writes = 0;
  const service = new AsyncHubMemberActivity(port(kind => {
    if (kind === 'memberSnapshot') return snapshot(); writes++; return wait.promise;
  }), new PerformanceDiagnostics(line => logs.push(line)), 5, 5);
  const pending = assert.rejects(service.recordActivity(request(controller.signal)), status(499));
  await tick(); controller.abort(); await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(service.pending, 1); assert.equal(writes, 1);
  assert.ok(logs.some(line => line.includes('"phase":"pending"') && line.includes('"step":30')));
  wait.resolve({ ok: true }); await pending;
  assert.equal(service.pending, 0); assert.equal(writes, 1);
  assert.equal(logs.join('').includes('x'.repeat(43)), false);
});
test('activity final authority change refuses delivery without replaying the completed write', async () => {
  let checks = 0, writes = 0;
  const service = new AsyncHubMemberActivity(port(kind => {
    if (kind === 'memberSnapshot') return ++checks === 1 ? snapshot() : { ...snapshot(), recoveryScope: 'b'.repeat(64) };
    writes++; return { ok: true };
  }), quiet);
  await assert.rejects(service.recordActivity(request()), status(401)); assert.equal(writes, 1);
});
test('activity unknown mutation logs redacted outcome and never retries', async () => {
  let writes = 0; const logs: string[] = [];
  const service = new AsyncHubMemberActivity(port(kind => {
    if (kind === 'memberSnapshot') return snapshot(); writes++; throw Error('private-activity-sql-body');
  }), new PerformanceDiagnostics(line => logs.push(line)));
  await assert.rejects(service.recordActivity(request()), status(503)); assert.equal(writes, 1);
  assert.ok(logs.some(line => line.includes('"unknown":1') && line.includes('"step":30')));
  assert.equal(logs.join('').includes('private-activity-sql-body'), false);
  assert.equal(service.pending, 0);
});
test('activity pre-dispatch authentication failure never invokes mutation', async () => {
  let writes = 0;
  const service = new AsyncHubMemberActivity(port(kind => {
    if (kind === 'memberSnapshot') return null; writes++; return { ok: true };
  }), quiet);
  await assert.rejects(service.recordActivity(request()), status(401)); assert.equal(writes, 0);
});
test('activity owner rejects stale proof without reporting a successful write', async () => {
  let writes = 0, checks = 0;
  const service = new AsyncHubMemberActivity(port(kind => {
    if (kind === 'memberSnapshot') { checks++; return snapshot(); } writes++; return null;
  }), quiet);
  await assert.rejects(service.recordActivity(request()), status(401)); assert.equal(writes, 1); assert.equal(checks, 1);
});

for (const held of ['initial', 'write', 'final'] as const) {
  test(`activity close owns original ${held} operation, refuses late delivery and never replays`, async () => {
    const gate = deferred<unknown>(); let reads = 0, writes = 0, entered!: () => void;
    const arrived = new Promise<void>(resolve => { entered = resolve; });
    const service = new AsyncHubMemberActivity(port(kind => {
      if (kind === 'memberSnapshot') {
        reads++;
        if (held === 'initial' && reads === 1 || held === 'final' && reads === 2) { entered(); return gate.promise; }
        return snapshot();
      }
      writes++;
      if (held === 'write') { entered(); return gate.promise; }
      return { ok: true };
    }), quiet);
    const pending = assert.rejects(service.recordActivity(request()), status(503));
    await arrived;
    assert.equal(service.pendingWork, 1);
    let drained = false;
    const closing = service.close(); assert.equal(service.close(), closing);
    void closing.then(() => { drained = true; });
    const calls = reads + writes;
    await assert.rejects(service.recordActivity(request()), status(503));
    await tick(); assert.equal(drained, false); assert.equal(reads + writes, calls);
    gate.resolve(held === 'write' ? { ok: true } : snapshot());
    await pending; await closing;
    assert.equal(drained, true); assert.equal(service.pending, 0); assert.equal(service.pendingWork, 0);
    assert.equal(reads + writes, calls); assert.equal(writes, held === 'initial' ? 0 : 1);
  });
}

test('activity diagnostic reentry fences complete work before the first child drain', async () => {
  let calls = 0, nested: Promise<void> | undefined, reentry: Promise<void> | undefined;
  const diagnostics = new PerformanceDiagnostics(() => {});
  const service = new AsyncHubMemberActivity(port(() => { calls++; return snapshot(); }), diagnostics);
  const original = diagnostics.start.bind(diagnostics);
  diagnostics.start = (...args) => {
    if (!reentry && args[0] === 'hub-route-drain') {
      reentry = assert.rejects(service.recordActivity(request()), status(503));
      nested = service.close();
    }
    return original(...args);
  };
  const closing = service.close();
  assert.equal(nested, closing); assert.equal(service.close(), closing);
  await reentry; await closing; assert.equal(calls, 0);
});

test('activity read cancellation keeps original lookup in close ownership', async () => {
  const gate = deferred<unknown>(), controller = new AbortController(); let calls = 0;
  const service = new AsyncHubMemberActivity(port(() => { calls++; return gate.promise; }), quiet);
  const result = assert.rejects(service.recordActivity(request(controller.signal)), status(499));
  await tick(); controller.abort(); await result;
  assert.equal(service.pendingWork, 0); assert.equal(service.pending, 1);
  let drained = false; const closing = service.close().then(() => { drained = true; });
  await tick(); assert.equal(drained, false);
  gate.resolve(snapshot()); await closing;
  assert.equal(service.pending, 0); assert.equal(calls, 1);
});
