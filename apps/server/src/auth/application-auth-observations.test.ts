import assert from 'node:assert/strict';
import test from 'node:test';
import { createApplicationAuthObservations } from './application-auth-observations.js';
import { AuthPersistenceError } from './private-store.js';
import type { HubPrincipal } from '../hub/identity.js';

const request = () => new Request('http://fixture/api/auth/status');
const scope = 'a'.repeat(64);
function held<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function fixture(overrides: Partial<Parameters<typeof createApplicationAuthObservations>[0]> = {}) {
  return createApplicationAuthObservations({ hasHub: true, principal: () => ({ userId: 'member', admin: false }),
    standaloneAuthorization: () => { throw Error('Must not fallback'); },
    memberIdentity: () => ({ userId: 'member', keyId: 'key' }), keyIdentity: () => ({ userId: 'member', keyId: 'key' }),
    recoveryScope: () => scope, ...overrides });
}

for (const user of [{ userId: 'member', admin: false }, undefined]) {
  test(`HTTP original principal is awaited: ${user ? 'member' : 'denial'}`, async () => {
    const gate = held<HubPrincipal | undefined>(), h = fixture({ principal: () => gate.promise });
    let done = false;
    const flight = h.observeAuthorization(request()).finally(() => { done = true; });
    await Promise.resolve(); assert.equal(done, false);
    gate.resolve(user); assert.equal(await flight, user !== undefined);
  });
}
for (const proof of [false, undefined, 'true', 1, true]) test(`standalone observation requires literal true: ${String(proof)}`, async () => {
  const h = fixture({ hasHub: false, principal: () => undefined,
    standaloneAuthorization: async () => proof as boolean });
  assert.equal(await h.observeAuthorization(request()), proof === true);
});
for (const identity of [undefined, { userId: 'member', keyId: 'key' }]) test(`new member session awaits exact cookie lookup: ${!!identity}`, async () => {
  const gate = held<typeof identity>(), controller = new AbortController(); let observed!: Request;
  const h = fixture({ memberIdentity: r => { observed = r; return gate.promise; } });
  let done = false;
  const flight = h.memberSessionCurrent('hub_session_a+b/', new Request('http://fixture/login', {
    headers: { 'x-agentopsdeck-key': 'old-key', cookie: 'agentopsdeck_session=old' }, signal: controller.signal,
  })).finally(() => { done = true; });
  await Promise.resolve(); assert.equal(done, false);
  assert.equal(observed.headers.get('cookie'), 'agentopsdeck_session=hub_session_a%2Bb%2F');
  assert.equal(observed.headers.get('x-agentopsdeck-key'), null);
  controller.abort(); assert.equal(observed.signal.aborted, true);
  gate.resolve(identity); assert.equal(await flight, identity !== undefined);
});
test('member key and audit identity copy awaited primitive fields', async () => {
  const original = { userId: 'member', keyId: 'key' };
  const h = fixture({ keyIdentity: async () => original, memberIdentity: async () => original });
  const key = await h.memberKeyIdentity('hub_key_test'), audit = await h.auditIdentity(request());
  original.userId = 'other';
  assert.deepEqual(key, { userId: 'member', keyId: 'key' });
  assert.deepEqual(audit, { userId: 'member', keyId: 'key', authMethod: 'member' });
  assert.equal(Object.isFrozen(key), true); assert.equal(Object.isFrozen(audit), true);
});
for (const next of [undefined, { userId: 'other', admin: false }, { userId: 'member', admin: true }]) {
  test(`member audit refuses revocation/account/role change ${JSON.stringify(next)}`, async () => {
    let actor: HubPrincipal | undefined = { userId: 'member', admin: false };
    const h = fixture({ principal: async () => actor, memberIdentity: async () => {
      actor = next; return { userId: 'member', keyId: 'key' };
    } });
    assert.equal(await h.auditIdentity(request()), undefined);
  });
  test(`scope refuses revocation/account/role change ${JSON.stringify(next)}`, async () => {
    let actor: HubPrincipal | undefined = { userId: 'member', admin: false };
    const h = fixture({ principal: async () => actor, recoveryScope: async () => { actor = next; return scope; } });
    assert.equal(await h.recoveryScope(request()), undefined);
  });
}
test('member audit refuses mismatched original identity', async () => {
  assert.equal(await fixture({ memberIdentity: async () => ({ userId: 'other', keyId: 'key' }) }).auditIdentity(request()), undefined);
});
test('administrator and standalone audit retain original attribution', async () => {
  assert.deepEqual(await fixture({ principal: async () => ({ userId: 'admin', admin: true }) }).auditIdentity(request()), {
    userId: 'admin', authMethod: 'administrator',
  });
  const h = fixture({ hasHub: false, principal: () => undefined, standaloneAuthorization: async () => true });
  assert.deepEqual(await h.auditIdentity(request()), { userId: 'default', authMethod: 'administrator' });
  assert.equal(await h.recoveryScope(request()), undefined, 'do not invent a new standalone recovery namespace');
});
for (const value of [null, {}, { userId: 'member' }, { userId: 'member', keyId: '' }, { userId: 'member', keyId: 'key', admin: true },
  Object.defineProperty({ keyId: 'key' }, 'userId', { get() { throw Error('getter must not execute'); }, enumerable: true })]) {
  test(`invalid original member data is unavailable, not authenticated: ${Reflect.ownKeys(value ?? {}).join(',')}`, async () => {
    const h = fixture({ memberIdentity: async () => value as never, keyIdentity: async () => value as never });
    await assert.rejects(h.memberSessionCurrent('hub_session_test', request()), AuthPersistenceError);
    await assert.rejects(h.memberKeyIdentity('hub_key_test'), AuthPersistenceError);
    await assert.rejects(h.auditIdentity(request()), AuthPersistenceError);
  });
}
for (const value of ['', 'bad-scope', 'A'.repeat(64), true]) test(`invalid original scope ${String(value).slice(0, 9)} fails closed`, async () => {
  await assert.rejects(fixture({ recoveryScope: async () => value as string }).recoveryScope(request()), AuthPersistenceError);
});
test('original scope principal is a frozen primitive copy across the wait', async () => {
  const actor = { userId: 'member', admin: false }; let frozen = false;
  const h = fixture({ principal: () => actor, recoveryScope: async p => {
    frozen = Object.isFrozen(p); actor.userId = 'other'; assert.equal(p.userId, 'member'); return scope;
  } });
  assert.equal(await h.recoveryScope(request()), undefined); assert.equal(frozen, true);
});

test('scope receives the exact original request evidence and cancellation, not a reconstructed grant', async () => {
  const controller = new AbortController(), original = new Request('http://fixture/api/auth/status', {
    headers: { cookie: 'agentopsdeck_session=fixture', 'x-agentopsdeck-key': 'explicit' }, signal: controller.signal,
  });
  const h = fixture({ recoveryScope: async (actor, observed) => {
    assert.equal(observed, original); assert.equal(actor.userId, 'member');
    controller.abort(); assert.equal(observed.signal.aborted, true); return scope;
  } });
  assert.equal(await h.recoveryScope(original), scope);
});
