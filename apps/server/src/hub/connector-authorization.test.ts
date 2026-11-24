import assert from 'node:assert/strict';
import test from 'node:test';
import { connectWithRetry } from './connector-connect.js';

function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  // Red-phase legacy code does not observe the authority Promise itself.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const refusal = () => new TypeError('fetch failed', {
  cause: { code: 'ECONNREFUSED', syscall: 'connect' },
});

test('async authority must settle before the first dispatch', async () => {
  const authority = deferred(); let attempts = 0;
  const request = connectWithRetry(async () => { attempts++; return 'ok'; },
    new AbortController().signal, () => authority.promise, []);
  await tick(); const before = attempts; authority.resolve();
  assert.equal(await request, 'ok'); assert.equal(before, 0); assert.equal(attempts, 1);
});

test('async authority rejection is not permission to send', async () => {
  const authority = deferred(); let attempts = 0; const denied = Error('revoked');
  const request = connectWithRetry(async () => { attempts++; return 'ok'; },
    new AbortController().signal, () => authority.promise, []);
  const observed = request.then(value => ({ value }), error => ({ error }));
  authority.reject(denied); const result = await observed;
  assert.deepEqual(result, { error: denied }); assert.equal(attempts, 0);
});

test('caller abort settles while original authority is still pending', async () => {
  const authority = deferred(), abort = new AbortController(); let attempts = 0;
  const cancelled = Error('cancelled');
  const request = connectWithRetry(async () => { attempts++; return 'ok'; },
    abort.signal, () => authority.promise, []);
  const observed = request.then(value => ({ value }), error => ({ error }));
  await tick(); abort.abort(cancelled);
  const result = await observed; authority.resolve(); await tick();
  assert.deepEqual(result, { error: cancelled }); assert.equal(attempts, 0);
});

test('a retry waits for its own authority result, not the first grant', async () => {
  const authority = deferred(); let checks = 0, attempts = 0; const denied = Error('revoked');
  const request = connectWithRetry(async () => { attempts++; if (attempts === 1) throw refusal(); return 'ok'; },
    new AbortController().signal, () => ++checks === 1 ? undefined : authority.promise, [0]);
  const observed = request.then(value => ({ value }), error => ({ error }));
  while (checks < 2) await tick();
  const before = attempts; authority.reject(denied);
  assert.deepEqual(await observed, { error: denied }); assert.equal(before, 1); assert.equal(attempts, 1);
});

test('abort inside a synchronous authority callback prevents dispatch', async () => {
  const abort = new AbortController(); let attempts = 0; const cancelled = Error('cancelled');
  await assert.rejects(connectWithRetry(async () => { attempts++; return 'ok'; },
    abort.signal, () => abort.abort(cancelled), []), error => error === cancelled);
  assert.equal(attempts, 0);
});
