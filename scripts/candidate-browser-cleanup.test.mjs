import assert from 'node:assert/strict';
import test from 'node:test';
import { closeApplicationBrowser } from '../apps/web/tests/candidate-app-recovery.browser.mjs';

test('browser closes once after all ordinary context cleanup', async () => {
  const calls = [];
  await closeApplicationBrowser({ close: async () => calls.push('browser') }, [
    { close: async () => calls.push('first') },
    { close: async () => calls.push('second') },
  ]);
  assert.deepEqual(calls, ['first', 'second', 'browser']);
});

for (const synchronous of [false, true]) {
  test(`context failure still closes peers and browser (synchronous=${synchronous})`, async () => {
    const failure = new Error('context close failed'), calls = [];
    let settlePeer;
    const peer = new Promise(resolve => { settlePeer = resolve; });
    const close = () => {
      calls.push('failed');
      if (synchronous) throw failure;
      return Promise.reject(failure);
    };
    await assert.rejects(closeApplicationBrowser({ close: async () => {
      calls.push('browser'); settlePeer();
    } }, [{ close }, { close: () => { calls.push('peer'); return peer; } }]),
    error => error === failure);
    assert.deepEqual(calls, ['failed', 'peer', 'browser']);
  });
}

test('browser close failure is not reported as successful cleanup', async () => {
  const failure = new Error('browser close failed');
  await assert.rejects(closeApplicationBrowser({ close: async () => { throw failure; } }, []),
    error => error === failure);
});
