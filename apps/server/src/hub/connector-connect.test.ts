import assert from 'node:assert/strict';
import test from 'node:test';
import { connectWithRetry, ConnectorNotDispatchedError } from './connector-connect.js';

const refused = () => new TypeError('fetch failed', { cause: Object.assign(new Error('private endpoint'), { code: 'ECONNREFUSED', syscall: 'connect' }) });

test('startup refusal waits for connect, but successful dispatch occurs once', async () => {
  let attempts = 0, sends = 0, guards = 0;
  const result = await connectWithRetry(async () => {
    if (++attempts < 3) throw refused();
    sends++; return 'accepted';
  }, new AbortController().signal, () => { guards++; }, [1, 1]);
  assert.equal(result, 'accepted'); assert.equal(attempts, 3); assert.equal(sends, 1); assert.equal(guards, 3);
});

test('exhausted connection refusal is definitive non-dispatch without leaking endpoint', async () => {
  let attempts = 0;
  await assert.rejects(connectWithRetry(async () => { attempts++; throw refused(); }, new AbortController().signal, () => {}, [1]), error => {
    assert.ok(error instanceof ConnectorNotDispatchedError);
    assert.doesNotMatch(error.message, /private endpoint/); return true;
  });
  assert.equal(attempts, 2);
});

for (const error of [new Error('lost ACK'), new TypeError('fetch failed', { cause: { code: 'ECONNRESET', syscall: 'read' } }),
  new TypeError('fetch failed', { cause: { code: 'ETIMEDOUT', syscall: 'connect' } }),
  new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED', syscall: 'write' } }),
  new TypeError('fetch failed', { cause: new AggregateError([{ code: 'ECONNREFUSED', syscall: 'connect' }, { code: 'ECONNRESET' }]) })]) {
  test(`ambiguous failure never retries: ${JSON.stringify(error.cause) || error.message}`, async () => {
    let attempts = 0;
    await assert.rejects(connectWithRetry(async () => { attempts++; throw error; }, new AbortController().signal, () => {}, [1]), e => e === error);
    assert.equal(attempts, 1);
  });
}

test('all-refused dual-stack connect failures can retry', async () => {
  let attempts = 0;
  const result = await connectWithRetry(async () => {
    if (++attempts === 1) throw new TypeError('fetch failed', { cause: new AggregateError([refused().cause, refused().cause]) });
    return 1;
  }, new AbortController().signal, () => {}, [1]);
  assert.equal(result, 1); assert.equal(attempts, 2);
});

test('authority is checked again before a later connection attempt', async () => {
  let attempts = 0, guards = 0;
  await assert.rejects(connectWithRetry(async () => { attempts++; throw refused(); }, new AbortController().signal,
    () => { if (++guards === 2) throw new Error('revoked'); }, [1]), /revoked/);
  assert.equal(attempts, 1);
});

test('caller cancellation interrupts backoff without a later dispatch', async () => {
  const controller = new AbortController(); let attempts = 0;
  const pending = connectWithRetry(async () => { attempts++; throw refused(); }, controller.signal, () => {}, [1000]);
  setTimeout(() => controller.abort(new Error('cancelled')), 5);
  await assert.rejects(pending, /cancelled/); assert.equal(attempts, 1);
});

test('HTTP responses, including 503, are not retried or reclassified', async () => {
  let attempts = 0;
  const result = await connectWithRetry(async () => { attempts++; return new Response(null, { status: 503 }); }, new AbortController().signal, () => {}, [1]);
  assert.equal(result.status, 503); assert.equal(attempts, 1);
});
