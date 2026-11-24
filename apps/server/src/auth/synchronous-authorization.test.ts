import assert from 'node:assert/strict';
import test from 'node:test';
import { AuthPersistenceError } from './private-store.js';
import { synchronousAuthorization, synchronousAuthorizationCall } from './synchronous-authorization.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

test('only literal synchronous true authorizes a supplied guard', () => {
  assert.equal(synchronousAuthorization(), true);
  assert.equal(synchronousAuthorization(() => true), true);
  for (const result of [false, undefined, null, 1, 'true', {}])
    assert.equal(synchronousAuthorization(() => result as boolean), false);
});

test('native async authorization is denied without starting the callback', () => {
  let calls = 0;
  const check = async () => { calls++; throw Error('private-guard'); };
  assert.equal(synchronousAuthorization(check as unknown as () => boolean), false);
  assert.equal(calls, 0);
});

test('returned native Promise rejection is observed but never treated as authorization', async () => {
  let calls = 0;
  const result = Promise.reject(Error('private-guard'));
  assert.equal(synchronousAuthorization(() => { calls++; return result as unknown as boolean; }), false);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
});

test('denied arbitrary thenables and revoked values are never inspected', () => {
  let inspected = 0;
  const thenable = Object.defineProperty({}, 'then', { get() { inspected++; throw Error('private-getter'); } });
  const proxy = Proxy.revocable({}, {}); proxy.revoke();
  for (const value of [thenable, proxy.proxy])
    assert.equal(synchronousAuthorization(() => value as boolean), false);
  assert.equal(inspected, 0);
});

test('arbitrary thrown guard failures are sanitized without inspecting the error', () => {
  const proxy = Proxy.revocable({}, {}); proxy.revoke();
  for (const error of [Error('private-guard'), proxy.proxy])
    assert.throws(() => synchronousAuthorization(() => { throw error; }),
      error => error instanceof AuthPersistenceError && error.message === 'auth_persistence_failed');
});

test('argument-bearing guard preserves original async identity and synchronous receiver', () => {
  let calls = 0;
  const asynchronous = async (_token: string) => { calls++; return true; };
  assert.equal(synchronousAuthorizationCall(asynchronous as unknown as (token: string) => boolean, ['token']), false);
  assert.equal(calls, 0);
  const sessions = new Set(['token']);
  assert.equal(synchronousAuthorizationCall(sessions.has, ['token'], undefined, sessions), true);
  assert.equal(synchronousAuthorizationCall(sessions.has, ['missing'], undefined, sessions), false);
});

test('compatibility refusals have bounded fixed numeric diagnostics without credential or exception content', async () => {
  const rows: string[] = [];
  const diagnostics = new PerformanceDiagnostics(line => { rows.push(line); });
  const check = (guard: () => boolean) => synchronousAuthorizationCall(guard, [], undefined, undefined, diagnostics);
  assert.equal(check((async () => true) as unknown as () => boolean), false);
  assert.equal(check(() => Promise.reject(Error('private-promise-secret')) as unknown as boolean), false);
  assert.throws(() => check(() => { throw Error('private-operator-secret'); }), AuthPersistenceError);
  await new Promise<void>(resolve => setImmediate(resolve));
  const events = diagnostics.snapshot().events;
  assert.equal(events.length, 3);
  assert.ok(events.every(event => event.operation === 'auth-compatibility-check' && event.category === 'failed'));
  assert.equal(events[0]!.step, 1); assert.equal(events[0]!.deferred, 1);
  assert.equal(events[1]!.step, 4); assert.equal(events[1]!.unknown, 1);
  assert.equal(events[2]!.step, 2);
  assert.equal(rows.join('').includes('private-'), false);
});
