import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { jointBrowserAction } from './permissions-joint-browser-action.mjs';

test('response listener is armed before the original UI action, which runs exactly once', async () => {
  const order = [];
  let respond;
  const expected = { status: 202 };
  const value = await jointBrowserAction(() => {
    order.push('listen'); return new Promise(resolve => { respond = resolve; });
  }, () => { order.push('click'); respond(expected); });
  assert.equal(value, expected);
  assert.deepEqual(order, ['listen', 'click']);
});

test('response timeout while click is pending stays caught; later click rejection is also observed', async () => {
  const timeout = new Error('response timeout');
  await assert.rejects(jointBrowserAction(() => delay(1).then(() => { throw timeout; }),
    () => delay(15).then(() => { throw new Error('disabled click'); })), error => error === timeout);
  await delay(30); // node:test fails this test on any unhandled rejection.
});

test('click failure does not orphan a later response timeout', async () => {
  const failure = new Error('click failed');
  await assert.rejects(jointBrowserAction(() => delay(15).then(() => { throw new Error('response timeout'); }),
    () => { throw failure; }), error => error === failure);
  await delay(30);
});

test('a synchronous listener setup failure never clicks or submits a replacement', async () => {
  let calls = 0;
  await assert.rejects(jointBrowserAction(() => { throw new Error('listener unavailable'); }, () => { calls++; }));
  assert.equal(calls, 0);
});
