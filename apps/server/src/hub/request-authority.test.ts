import assert from 'node:assert/strict';
import test from 'node:test';
import { HTTPException } from 'hono/http-exception';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { HubPrincipal } from './identity.js';
import { pinHubRequestAuthority, synchronousHubPrincipalCall } from './request-authority.js';

for (const change of ['revoked', 'account', 'role', 'in-place-account', 'in-place-role'] as const)
  test(`request authority pins primitive identity and refuses ${change}`, () => {
    const rows: any[] = [], diagnostics = new PerformanceDiagnostics(line => rows.push(JSON.parse(line)));
    let current: HubPrincipal | undefined = { userId: 'PRIVATE initial', admin: true };
    const authority = pinHubRequestAuthority(current, () => current, diagnostics);
    assert.notEqual(authority.principal, current); assert.equal(Object.isFrozen(authority.principal), true);
    assert.deepEqual(authority.check(), { userId: 'PRIVATE initial', admin: true });
    if (change === 'revoked') current = undefined;
    if (change === 'account') current = { userId: 'PRIVATE other', admin: true };
    if (change === 'role') current = { userId: 'PRIVATE initial', admin: false };
    if (change === 'in-place-account') current!.userId = 'PRIVATE other';
    if (change === 'in-place-role') current!.admin = false;
    const unauthorized = (error: unknown) => error instanceof HTTPException && error.status === 401;
    assert.throws(() => authority.check(), unauthorized); assert.throws(() => authority.check(), unauthorized);
    assert.equal(rows.length, 1); assert.equal(rows[0].operation, 'hub-request-authority');
    assert.equal(rows[0].step, change === 'revoked' ? 1 : change.includes('account') ? 2 : 3);
    assert.equal(rows[0].deferred, 1); assert.equal(rows[0].settled, undefined); assert.equal(rows[0].unknown, undefined);
    assert.doesNotMatch(JSON.stringify(rows), /PRIVATE/);
    current = { userId: 'PRIVATE initial', admin: true };
    assert.throws(() => authority.check(), unauthorized, 'a refused request must not be resurrected');
    assert.equal(rows.length, 1);
  });

test('request authority rechecks fresh identity on every call without object equality requirements', () => {
  let calls = 0;
  const authority = pinHubRequestAuthority({ userId: 'user', admin: false }, () => { calls++; return { userId: 'user', admin: false }; });
  assert.equal(authority.check(), authority.principal); assert.equal(authority.check(), authority.principal);
  assert.equal(calls, 2);
});

test('request authority refuses even when its diagnostic sink fails or reenters', () => {
  let current: HubPrincipal | undefined = { userId: 'user', admin: true }, authority!: ReturnType<typeof pinHubRequestAuthority>, observations = 0;
  const diagnostics = new PerformanceDiagnostics(() => { observations++; assert.throws(() => authority.check()); throw Error('PRIVATE sink'); });
  authority = pinHubRequestAuthority(current, () => current, diagnostics); current = undefined;
  assert.throws(() => authority.check(), (error: unknown) => error instanceof HTTPException && error.status === 401);
  assert.equal(observations, 1);
});

test('request authority never converts thrown persistence failures into a grant', () => {
  const failure = Error('PRIVATE SQL'), authority = pinHubRequestAuthority({ userId: 'user', admin: true }, () => { throw failure; });
  assert.throws(() => authority.check(), error => error === failure);
});

for (const initial of [{ userId: '', admin: true }, { userId: 'user', admin: undefined }, Promise.resolve({ userId: 'user', admin: true })])
  test('request authority rejects invalid initial synchronous evidence', () => {
    assert.throws(() => pinHubRequestAuthority(initial as HubPrincipal, () => undefined),
      (error: unknown) => error instanceof HTTPException && error.status === 401);
  });

test('decorated Promise is never initial or current synchronous principal evidence', () => {
  const promised = Object.assign(Promise.resolve(undefined), { userId: 'user', admin: true });
  const unauthorized = (error: unknown) => error instanceof HTTPException && error.status === 401;
  assert.throws(() => pinHubRequestAuthority(promised as unknown as HubPrincipal, () => undefined), unauthorized);
  const authority = pinHubRequestAuthority({ userId: 'user', admin: true }, () => promised as unknown as HubPrincipal);
  assert.throws(() => authority.check(), unauthorized);
});

test('principal getters and Proxy traps cannot execute at synchronous authority boundaries', () => {
  let getters = 0, traps = 0;
  const accessor = { get userId() { getters++; return 'user'; }, admin: true };
  const proxy = new Proxy({ userId: 'user', admin: true }, { get(target, key) { traps++; return Reflect.get(target, key); } });
  const unauthorized = (error: unknown) => error instanceof HTTPException && error.status === 401;
  for (const initial of [accessor, proxy]) {
    assert.throws(() => pinHubRequestAuthority(initial, () => undefined), unauthorized);
    const authority = pinHubRequestAuthority({ userId: 'user', admin: true }, () => initial);
    assert.throws(() => authority.check(), unauthorized);
  }
  assert.equal(getters, 0); assert.equal(traps, 0);
});

test('native async principal callback is rejected without starting its lookup', () => {
  let calls = 0;
  const callback = async () => { calls++; return { userId: 'user', admin: true }; };
  const authority = pinHubRequestAuthority({ userId: 'user', admin: true }, callback as unknown as () => HubPrincipal);
  assert.throws(() => authority.check(), (error: unknown) => error instanceof HTTPException && error.status === 401);
  assert.equal(calls, 0);
});

test('synchronous principal call preserves own null-prototype evidence without trimming identity', () => {
  const value = Object.assign(Object.create(null), { userId: ' user ', admin: false });
  const proof = synchronousHubPrincipalCall(() => value, []);
  assert.deepEqual(proof, { userId: ' user ', admin: false });
  assert.notEqual(proof, value); assert.equal(Object.isFrozen(proof), true);
  assert.equal(synchronousHubPrincipalCall(() => ({ ...value, then: () => { throw Error('must not run'); } }), []), undefined);
  assert.equal(synchronousHubPrincipalCall(() => Object.create(value), []), undefined);
});

test('late promise rejection is observed and only fixed denial metadata is logged', async () => {
  const rows: any[] = [], diagnostics = new PerformanceDiagnostics(line => rows.push(JSON.parse(line)));
  let reject!: (reason: unknown) => void;
  const pending = Object.assign(new Promise((_, fail) => { reject = fail; }), { userId: 'PRIVATE', admin: true });
  assert.equal(synchronousHubPrincipalCall(() => pending as unknown as HubPrincipal, [], diagnostics), undefined);
  reject(Error('PRIVATE SQL token')); await new Promise(resolve => setImmediate(resolve));
  assert.equal(rows.length, 1); assert.equal(rows[0].operation, 'auth-compatibility-check');
  assert.equal(rows[0].step, 6); assert.equal(rows[0].deferred, 1);
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE|SQL|token/);
});

test('callback Proxy and principal accessors are denied without traps even with failing diagnostics', () => {
  let invoked = 0;
  const callback = new Proxy(() => ({ userId: 'user', admin: true }), {
    apply() { invoked++; throw Error('PRIVATE'); }, get() { invoked++; throw Error('PRIVATE'); },
  });
  const diagnostics = new PerformanceDiagnostics(() => { throw Error('PRIVATE sink'); });
  assert.equal(synchronousHubPrincipalCall(callback, [], diagnostics), undefined); assert.equal(invoked, 0);
  const failure = Error('PRIVATE SQL');
  assert.throws(() => synchronousHubPrincipalCall(() => { throw failure; }, [], diagnostics), error => error === failure);
});
