import assert from 'node:assert/strict';
import test from 'node:test';
import { readRecoveryPage } from './recovery-page.js';
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test('async recovery sources read one bounded page and merge in SQLite BINARY order', async () => {
  const seen: Array<[string, number]> = [];
  const values = await readRecoveryPage('', 3, [
    async (after, limit) => { seen.push([after, limit]); return ['a', '\uE000', '😀']; },
    (after, limit) => { seen.push([after, limit]); return ['a', 'b', '\u{10000}']; },
  ], () => true);
  assert.deepEqual(values, ['a', 'b', '\uE000']);
  assert.deepEqual(seen, [['', 3], ['', 3]]);
});
for (const reason of ['pause', 'closed', 'connection-changed', 'execution-unavailable']) {
  test(`recovery ${reason} during retained read suppresses later reads and stale results`, async () => {
    const original = deferred<string[]>(); let current = true, reads = 0;
    const pending = readRecoveryPage('', 2, [() => original.promise, () => { reads++; return ['later']; }], () => current);
    await Promise.resolve(); current = false; original.resolve(['earlier']);
    assert.deepEqual(await pending, []); assert.equal(reads, 0);
  });
}
test('stale recovery owner cannot start even the first read', async () => {
  let calls = 0;
  assert.deepEqual(await readRecoveryPage('', 1, [() => { calls++; return ['a']; }], () => false), []);
  assert.equal(calls, 0);
});
test('journal rejection is not an empty queue and does not read the next journal', async () => {
  let reads = 0;
  await assert.rejects(readRecoveryPage('', 2, [async () => { throw Error('synthetic-failure'); },
    () => { reads++; return ['b']; }], () => true));
  assert.equal(reads, 0);
});
for (const page of [['b', 'a'], ['a', 'a'], ['a', 'b', 'c'], [''], ['nul\0'], ['x'.repeat(4097)], ['a']]) {
  test(`malformed or out-of-cursor recovery page is rejected: ${page.length} entries`, async () => {
    await assert.rejects(readRecoveryPage('a', 2, [async () => page], () => true), /Recovery page unavailable/);
  });
}
test('invalid cursor and bound are rejected before any journal is queried', async () => {
  let reads = 0;
  for (const [after, limit] of [['', 0], ['', 65], ['', 1.5], ['\0', 1], ['x'.repeat(4097), 1]] as const)
    await assert.rejects(readRecoveryPage(after, limit, [() => { reads++; return []; }], () => true));
  assert.equal(reads, 0);
});
