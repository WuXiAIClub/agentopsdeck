import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AsyncHubSessionPreferences } from './async-session-preferences.js';
import type { AsyncHubMemberOwner } from './async-member-owner.js';
import type { HubMemberKind } from './member-owner-domain.js';
import { HubMemberRequestError } from './async-member-request.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { pinOriginalRequestScope } from './original-request-scope.js';
const quiet = new PerformanceDiagnostics(() => {});
const snapshot = () => ({ principal: { userId: 'member', admin: false }, recoveryScope: 'a'.repeat(64) });
const change = () => ({ sessionKey: 'connection:b2xk', field: 'hidden' as const, value: true });
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
test('preference independent begin preserves the private original scope and refuses same-user replacement before SQL', async () => {
  let writes = 0;
  const service = new AsyncHubSessionPreferences(port(kind => {
    if (kind === 'memberSnapshot') return snapshot();
    writes++; return { ok: true };
  }), quiet);
  try {
    const raw = request(); pinOriginalRequestScope(raw, 'b'.repeat(64));
    await assert.rejects(service.set(raw, 'member', change()), status(401)); assert.equal(writes, 0);
    const current = request(); pinOriginalRequestScope(current, snapshot().recoveryScope);
    await service.set(current, 'member', change()); assert.equal(writes, 1);
  } finally { await service.close(); }
});
test('preference caller copies credential and flags before permission awaits', async () => {
  const wait = deferred<unknown>(); let checks = 0, captured: unknown;
  const service = new AsyncHubSessionPreferences(port((kind, input) => {
    if (kind === 'memberSnapshot') return ++checks === 1 ? wait.promise : snapshot();
    captured = input; return { ok: true };
  }), quiet);
  const raw = request(), value = change(), pending = service.set(raw, 'member', value);
  raw.headers.set('cookie', 'agentopsdeck_session=hub_session_' + 'z'.repeat(43)); value.value = false;
  wait.resolve(snapshot()); await pending;
  const copy = captured as { evidence: { sessionToken: string }; change: { value: boolean } };
  assert.equal(copy.change.value, true); assert.equal(copy.evidence.sessionToken, 'hub_session_' + 'x'.repeat(43));
});
test('preference abort retains pending original write and never retries or grants an ACK early', async () => {
  const wait = deferred<unknown>(), controller = new AbortController(), logs: string[] = []; let writes = 0;
  const service = new AsyncHubSessionPreferences(port(kind => {
    if (kind === 'memberSnapshot') return snapshot(); writes++; return wait.promise;
  }), new PerformanceDiagnostics(line => logs.push(line)), 5, 5);
  const pending = assert.rejects(service.set(request(controller.signal), 'member', change()), status(499));
  await tick(); controller.abort(); await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(service.pending, 1); assert.equal(writes, 1);
  assert.ok(logs.some(line => line.includes('"phase":"pending"')));
  wait.resolve({ ok: true }); await pending;
  assert.equal(service.pending, 0); assert.equal(writes, 1);
  assert.equal(logs.join('').includes('x'.repeat(43)), false);
});
test('preference final scope change denies delivery but never rolls back or replays a committed write', async () => {
  let checks = 0, writes = 0;
  const service = new AsyncHubSessionPreferences(port(kind => {
    if (kind === 'memberSnapshot') return ++checks === 1 ? snapshot() : { ...snapshot(), recoveryScope: 'b'.repeat(64) };
    writes++; return { ok: true };
  }), quiet);
  await assert.rejects(service.set(request(), 'member', change()), status(401)); assert.equal(writes, 1);
});
test('preference unknown owner outcome logs redacted failure and never retries', async () => {
  let writes = 0; const logs: string[] = [];
  const service = new AsyncHubSessionPreferences(port(kind => {
    if (kind === 'memberSnapshot') return snapshot(); writes++; throw Error('private-sql-body');
  }), new PerformanceDiagnostics(line => logs.push(line)));
  await assert.rejects(service.set(request(), 'member', change()), status(503)); assert.equal(writes, 1);
  assert.ok(logs.some(line => line.includes('"unknown":1'))); assert.equal(logs.join('').includes('private-sql-body'), false);
});
