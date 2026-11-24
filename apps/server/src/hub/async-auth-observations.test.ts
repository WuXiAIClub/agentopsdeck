import assert from 'node:assert/strict';
import test from 'node:test';
import { AsyncHubAuthIdentity } from './async-auth-identity.js';
import type { AsyncHubMemberOwner } from './async-member-owner.js';
import { AuthPersistenceError } from '../auth/private-store.js';
import { AuthReadCancelledError } from '../auth/route-read-wait.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const actor = { userId: 'original-member', admin: false };
const snapshot = () => ({ principal: { ...actor }, recoveryScope: 'a'.repeat(64) });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function held<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

for (const method of ['principal', 'scope'] as const) for (const outcome of ['cancel', 'timeout', 'close', 'reject'] as const) {
  test(`original HTTP ${method} ${outcome} retains original read and never falls back or replays`, async () => {
    const gate = held<ReturnType<typeof snapshot>>(), controller = new AbortController(), logs: string[] = [];
    let calls = 0, closed = false;
    const owner = { command(kind: string, input: unknown) {
      calls++; assert.equal(kind, 'memberSnapshot');
      assert.deepEqual(input, { accessKey: 'PRIVATE-explicit', sessionToken: 'PRIVATE-cookie' });
      return gate.promise;
    } } as unknown as Pick<AsyncHubMemberOwner, 'command'>;
    const service = new AsyncHubAuthIdentity(owner, new PerformanceDiagnostics(line => logs.push(line)), 5,
      outcome === 'timeout' ? 5 : 30_000);
    const request = new Request('http://fixture.invalid/', { signal: controller.signal,
      headers: { 'x-agentopsdeck-key': 'PRIVATE-explicit', cookie: 'agentopsdeck_session=PRIVATE-cookie' } });
    const original = method === 'principal' ? service.requestPrincipal(request) : service.recoveryScope(request, actor);
    const refused = assert.rejects(original, outcome === 'cancel' ? AuthReadCancelledError : AuthPersistenceError);
    assert.equal(calls, 1); assert.equal(service.pending, 1);
    if (outcome === 'cancel') controller.abort();
    if (outcome === 'timeout' || outcome === 'cancel') await refused;
    const closing = service.close(); void closing.then(() => { closed = true; });
    assert.equal(service.close(), closing); await tick(); assert.equal(closed, false);
    assert.equal(service.pending, 1);
    await assert.rejects(service.requestPrincipal(request), AuthPersistenceError);
    await assert.rejects(service.recoveryScope(request, actor), AuthPersistenceError);
    await assert.rejects(service.memberIdentity(request), AuthPersistenceError);
    if (outcome === 'reject') gate.reject(Error('PRIVATE original read failure'));
    else gate.resolve(snapshot());
    await refused; await closing;
    assert.equal(service.pending, 0); assert.equal(calls, 1); assert.equal(closed, true);
    assert.doesNotMatch(logs.join(''), /PRIVATE|original-member/);
  });
}

test('HTTP snapshots copy identity and re-read current scope without storing a grant', async () => {
  let current: ReturnType<typeof snapshot> | null = snapshot(), calls = 0;
  const owner = { command: async () => { calls++; return current; } } as Pick<AsyncHubMemberOwner, 'command'>;
  const service = new AsyncHubAuthIdentity(owner, new PerformanceDiagnostics(() => {}));
  const request = new Request('http://fixture.invalid/');
  const first = await service.requestPrincipal(request);
  current.principal.userId = 'other';
  assert.deepEqual(first, actor); assert.equal(Object.isFrozen(first), true);
  assert.equal(await service.recoveryScope(request, actor), undefined);
  current = snapshot(); current.principal.admin = true;
  assert.equal(await service.recoveryScope(request, actor), undefined);
  current = null;
  assert.equal(await service.requestPrincipal(request), undefined);
  assert.equal(await service.recoveryScope(request, actor), undefined);
  assert.equal(calls, 5); await service.close();
});

test('expected scope identity is pinned before the original wait; pre-aborted reads never dispatch', async () => {
  const gate = held<ReturnType<typeof snapshot>>(); let calls = 0;
  const owner = { command: async () => { calls++; return gate.promise; } } as Pick<AsyncHubMemberOwner, 'command'>;
  const service = new AsyncHubAuthIdentity(owner, new PerformanceDiagnostics(() => {}));
  const expected = { ...actor }, controller = new AbortController(); controller.abort();
  const aborted = new Request('http://fixture.invalid/', { signal: controller.signal });
  await assert.rejects(service.requestPrincipal(aborted), AuthReadCancelledError);
  await assert.rejects(service.recoveryScope(aborted, expected), AuthReadCancelledError);
  assert.equal(calls, 0);
  const result = service.recoveryScope(new Request('http://fixture.invalid/'), expected);
  expected.userId = 'changed'; expected.admin = true;
  gate.resolve(snapshot()); assert.equal(await result, 'a'.repeat(64));
  assert.equal(calls, 1); await service.close();
});
