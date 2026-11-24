import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { synchronousEffectAuthority, SynchronousEffectAuthorityError } from './synchronous-effect-authority.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

test('absent trusted callback and original synchronous void callback remain immediate', () => {
  let calls = 0;
  synchronousEffectAuthority();
  synchronousEffectAuthority(() => { calls++; });
  assert.equal(calls, 1);
});
test('original synchronous errors retain exact identity even with failing diagnostics', () => {
  const failure = new Error('PRIVATE original error');
  const diagnostics = { start() { throw Error('PRIVATE sink'); } } as unknown as PerformanceDiagnostics;
  assert.throws(() => synchronousEffectAuthority(() => { throw failure; }, undefined, diagnostics), error => error === failure);
});
test('native async callback is never invoked', () => {
  let calls = 0;
  assert.throws(() => synchronousEffectAuthority(async () => { calls++; }), SynchronousEffectAuthorityError);
  assert.equal(calls, 0);
});
for (const value of [null, false, true, 0, '', {}, []]) {
  test(`nonvoid authority result is denied: ${typeof value}/${String(value)}`, () => {
    assert.throws(() => synchronousEffectAuthority((() => value) as any), SynchronousEffectAuthorityError);
  });
}
test('native and foreign promises are denied and late rejection is observed', async () => {
  let reject!: (error: Error) => void;
  const late = new Promise<void>((_, no) => { reject = no; });
  for (const value of [Promise.resolve(), late, runInNewContext('Promise.reject(new Error("PRIVATE foreign"))')]) {
    assert.throws(() => synchronousEffectAuthority((() => value) as any), SynchronousEffectAuthorityError);
  }
  reject(new Error('PRIVATE late'));
  await new Promise<void>(resolve => setImmediate(resolve));
});
test('thenable and proxy properties are never read', () => {
  let reads = 0;
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  for (const value of [{ get then() { reads++; throw Error('PRIVATE then'); } },
    new Proxy({}, { get() { reads++; throw Error('PRIVATE proxy'); } }), revoked.proxy]) {
    assert.throws(() => synchronousEffectAuthority((() => value) as any), SynchronousEffectAuthorityError);
  }
  assert.equal(reads, 0);
});
test('broken promise species cannot turn denial into permission', () => {
  let reads = 0;
  const value = Promise.resolve();
  Object.defineProperty(value, 'constructor', { get() { reads++; throw Error('PRIVATE constructor'); } });
  assert.throws(() => synchronousEffectAuthority((() => value) as any), SynchronousEffectAuthorityError);
  assert.equal(reads, 1);
});
test('invalid-authority factory and redacted diagnostics retain caller envelope', () => {
  const failure = new Error('private envelope');
  const rows: Record<string, unknown>[] = [];
  const diagnostics = new PerformanceDiagnostics(line => rows.push(JSON.parse(line)));
  assert.throws(() => synchronousEffectAuthority(async () => {}, () => failure, diagnostics), error => error === failure);
  assert.equal(rows.at(-1)?.step, 6);
  assert.equal(rows.at(-1)?.deferred, 1);
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE|private envelope/);
});
for (const broken of ['start', 'add', 'finish'] as const) test(`${broken} diagnostics cannot grant or replace authority`, () => {
  let calls = 0;
  const diagnostics = { start() {
    if (broken === 'start') throw Error('PRIVATE start');
    return { add() { if (broken === 'add') throw Error('PRIVATE add'); }, finish() { if (broken === 'finish') throw Error('PRIVATE finish'); } };
  } } as unknown as PerformanceDiagnostics;
  synchronousEffectAuthority(() => { calls++; }, undefined, diagnostics);
  assert.equal(calls, 1);
  assert.throws(() => synchronousEffectAuthority(async () => { calls++; }, undefined, diagnostics), SynchronousEffectAuthorityError);
  assert.equal(calls, 1);
});
