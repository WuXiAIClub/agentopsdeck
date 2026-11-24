import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeOperationError, runNativeOperation } from './native-operation.js';

test('already cancelled work is not invoked', async () => {
  let calls = 0;
  const signal = AbortSignal.abort();
  await assert.rejects(runNativeOperation(async () => { calls++; }, { signal, timeoutMs: 20 }),
    (error: unknown) => error instanceof NativeOperationError && error.outcome === 'not_started');
  assert.equal(calls, 0);
});

test('normal acknowledgment returns once without subsequent abort changing it', async () => {
  const controller = new AbortController();
  assert.deepEqual(await runNativeOperation(async () => ({ id: 'native-ack' }), { signal: controller.signal, timeoutMs: 100 }), { id: 'native-ack' });
  controller.abort();
});

test('a hung native ACK is bounded, uncertain, and never replayed', async () => {
  let calls = 0;
  await assert.rejects(runNativeOperation(() => { calls++; return new Promise(() => {}); }, { timeoutMs: 10 }),
    (error: unknown) => error instanceof NativeOperationError && error.reason === 'deadline' && error.outcome === 'unknown');
  assert.equal(calls, 1);
});

test('transport loss rejects without raw native errors or credentials in the error', async () => {
  await assert.rejects(runNativeOperation(async () => { throw new Error('PRIVATE_NATIVE_TEXT'); }, { timeoutMs: 100 }),
    (error: unknown) => error instanceof NativeOperationError && error.reason === 'native_error'
      && error.outcome === 'unknown' && !String(error.stack).includes('PRIVATE_NATIVE_TEXT') && !('cause' in error));
});

test('mid-call abort is uncertain even if SDK later resolves or rejects', async () => {
  for (const rejectLate of [false, true]) {
    const controller = new AbortController();
    let finish!: () => void;
    let calls = 0;
    const pending = runNativeOperation(() => {
      calls++;
      return new Promise((resolve, reject) => { finish = () => rejectLate ? reject(new Error('late')) : resolve('late'); });
    }, { signal: controller.signal, timeoutMs: 100 });
    controller.abort();
    await assert.rejects(pending, (error: unknown) => error instanceof NativeOperationError && error.outcome === 'unknown');
    finish(); await Promise.resolve();
    assert.equal(calls, 1);
  }
});

test('synchronous native failure and synchronous abort during invocation are contained', async () => {
  await assert.rejects(runNativeOperation(() => { throw new Error('private'); }, { timeoutMs: 100 }), NativeOperationError);
  const controller = new AbortController();
  await assert.rejects(runNativeOperation(() => {
    controller.abort(); return Promise.reject(new Error('private'));
  }, { signal: controller.signal, timeoutMs: 100 }), NativeOperationError);
});

test('invalid deadlines never invoke native operations', async () => {
  for (const timeoutMs of [0, -1, NaN, Infinity, 1.1, 2_147_483_648]) {
    let invoked = false;
    await assert.rejects(runNativeOperation(async () => { invoked = true; }, { timeoutMs }), RangeError);
    assert.equal(invoked, false);
  }
});
