import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { synchronousActorCall } from './synchronous-actor.js';

test('synchronous actor preserves request argument, receiver and exact nonempty string', () => {
  const receiver = { actor: ' private actor ' }, request = new Request('http://synthetic/');
  assert.equal(synchronousActorCall(function (this: typeof receiver, value: Request) {
    assert.equal(value, request); assert.equal(this, receiver); return this.actor;
  }, [request], receiver), receiver.actor);
});
for (const value of [undefined, null, '', false, true, 1, {}, [], new String('owner')] as const) {
  test(`synchronous actor rejects nonidentity ${typeof value}/${Object.prototype.toString.call(value)}`, () => {
    assert.equal(synchronousActorCall((() => value) as any, []), undefined);
  });
}
test('synchronous actor does not invoke native async lookup', () => {
  let calls = 0;
  assert.equal(synchronousActorCall((async () => { calls++; return 'owner'; }) as any, []), undefined);
  assert.equal(calls, 0);
});
test('synchronous actor rejects native and foreign-realm Promises and observes late rejection', async () => {
  const values = [Promise.resolve('owner'), Promise.reject(new Error('PRIVATE rejection')),
    runInNewContext('Promise.reject(new Error("PRIVATE foreign rejection"))')];
  for (const value of values) assert.equal(synchronousActorCall((() => value) as any, []), undefined);
  await new Promise<void>(resolve => setImmediate(resolve));
});
test('synchronous actor does not read arbitrary thenable or proxy properties', () => {
  let reads = 0;
  const values = [{ get then() { reads++; throw Error('PRIVATE getter'); } },
    new Proxy({}, { get() { reads++; throw Error('PRIVATE proxy'); } })];
  for (const value of values) assert.equal(synchronousActorCall((() => value) as any, []), undefined);
  assert.equal(reads, 0);
});
test('synchronous actor lookup failure cannot disclose exception in diagnostics', () => {
  const rows: Record<string, unknown>[] = [];
  const diagnostics = new PerformanceDiagnostics(line => rows.push(JSON.parse(line)));
  assert.equal(synchronousActorCall(() => { throw Error('PRIVATE token'); }, [], undefined, diagnostics), undefined);
  assert.equal(rows.at(-1)?.step, 5); assert.equal(rows.at(-1)?.deferred, 1);
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE|token/);
});
test('synchronous actor diagnostics failure cannot grant denied identity or revoke original valid result', () => {
  const diagnostics = { start() { throw Error('Observation unavailable'); } } as unknown as PerformanceDiagnostics;
  assert.equal(synchronousActorCall(() => 'owner', [], undefined, diagnostics), 'owner');
  assert.equal(synchronousActorCall((() => Promise.resolve('owner')) as any, [], undefined, diagnostics), undefined);
});
