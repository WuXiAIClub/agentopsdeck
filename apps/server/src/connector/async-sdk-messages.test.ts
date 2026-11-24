import assert from 'node:assert/strict';
import test from 'node:test';
import { AsyncSdkMessages } from './async-sdk-messages.js';
import { NativeOperationError } from './native-operation.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { ConnectorSdkMessageCommands } from './connector-sdk-message-domain.js';

type Command = ConstructorParameters<typeof AsyncSdkMessages>[0]['command'];
type Send = ConnectorSdkMessageCommands['sdkMessageSend']['input'];
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
const wait = { timeoutMs: 5_000 };
const unknown = (error: unknown) => error instanceof NativeOperationError && error.outcome === 'unknown';
function input(runtime: Send['runtime']): Send {
  return { runtime, key: `${runtime}:original`, authorization: 'Bearer private-example', commandKey: 'original-message',
    payloadJson: JSON.stringify({ message: 'original text' }) };
}
function result(request: Send, admitted = true) {
  return { runtime: request.runtime, key: request.key, commandKey: request.commandKey,
    receipt: { id: 'receipt', key: request.commandKey, state: 'accepted', createdAt: 0, updatedAt: 0,
      result: { status: 200, body: { ok: true, status: 'queued', queueDisposition: 'waiting', idempotencyKey: 'turn', media: [] } } },
    queue: { presence: 'present', state: 'queued', createdAt: 0, version: '1:1' }, admitted };
}

for (const runtime of ['claude-code', 'ghcp'] as const) {
  test(`${runtime}: message admission wakes only the original fresh commit, reads and duplicates never replay`, async () => {
    const request = input(runtime), admitted: unknown[] = [], calls: string[] = [];
    const messages = new AsyncSdkMessages({ command: (async kind => {
      calls.push(kind);
      const value = result(request, calls.length === 1);
      if (kind !== 'sdkMessageSend') { const { admitted: _admitted, ...read } = value; return read; }
      return value;
    }) as Command }, (id, key) => { admitted.push([id, key]); });
    try {
      assert.deepEqual(await messages.send(request, wait), result(request));
      assert.deepEqual(await messages.send(request, wait), result(request, false));
      const { payloadJson: _payload, ...scope } = request;
      await messages.readReceipt(scope, wait); await messages.readSendReceipt(scope, wait);
      assert.deepEqual(calls, ['sdkMessageSend', 'sdkMessageSend', 'sdkMessageReceiptRead', 'sdkMessageSendReceiptRead']);
      assert.deepEqual(admitted, [[runtime, request.key]]);
    } finally { await messages.close(); }
  });

  for (const cancelled of [false, true]) test(`${runtime}: ${cancelled ? 'cancelled' : 'expired'} wait retains late SQL ACK and asynchronous notification through close`, async () => {
    const request = input(runtime), ack = gate(), notify = gate(); let entered = false, notified = false, closed = false;
    const messages = new AsyncSdkMessages({ command: (async () => { entered = true; await ack.promise; return result(request); }) as Command },
      async () => { notified = true; await notify.promise; });
    const controller = new AbortController();
    try {
      const sending = messages.send(request, { timeoutMs: cancelled ? 5_000 : 5, signal: controller.signal });
      const rejected = assert.rejects(sending, unknown);
      await tick(); assert.equal(entered, true);
      if (cancelled) controller.abort();
      await rejected;
      const closing = messages.close(); assert.equal(messages.close(), closing);
      void closing.then(() => { closed = true; });
      await assert.rejects(messages.send(request, wait), unknown);
      await tick(); assert.equal(closed, false); assert.equal(notified, false);
      ack.release(); await tick(); assert.equal(notified, true); assert.equal(closed, false);
      notify.release(); await closing; assert.equal(closed, true);
    } finally { ack.release(); notify.release(); await messages.close(); }
  });

  test(`${runtime}: notification failure preserves committed receipt and bounded content-free diagnostic`, async () => {
    const request = input(runtime), lines: string[] = [], diagnostics = new PerformanceDiagnostics(line => { lines.push(line); });
    const messages = new AsyncSdkMessages({ command: (async () => result(request)) as Command },
      async () => { throw Error('private-example original text original-message'); }, diagnostics);
    try {
      assert.deepEqual(await messages.send(request, wait), result(request));
      assert.equal(diagnostics.snapshot().totals.finished, 1);
      assert.ok(lines.some(line => line.includes('sdk-message-admission') && line.includes('deferred')));
      assert.doesNotMatch(lines.join('\n'), /private-example|original text|original-message|original|receipt/);
    } finally { await messages.close(); }
  });

  for (const foreign of ['runtime', 'key', 'commandKey', 'malformed'] as const) {
    test(`${runtime}: ${foreign} ACK cannot notify or deliver another command's receipt`, async () => {
      const request = input(runtime); let notifications = 0;
      const alternate = { ...request, ...(foreign === 'runtime' ? { runtime: runtime === 'ghcp' ? 'claude-code' as const : 'ghcp' as const,
        key: `${runtime === 'ghcp' ? 'claude-code' : 'ghcp'}:original` } : foreign === 'key' ? { key: `${runtime}:foreign` }
        : { commandKey: 'foreign-command' }) };
      const messages = new AsyncSdkMessages({ command: (async () => foreign === 'malformed' ? { admitted: true } : result(alternate)) as Command },
        () => { notifications++; });
      try { await assert.rejects(messages.send(request, wait), unknown); assert.equal(notifications, 0); }
      finally { await messages.close(); }
    });
  }

  test(`${runtime}: snapshots original input and owner method before asynchronous submission`, async () => {
    const request = input(runtime), original = structuredClone(request), values: unknown[] = [];
    const owner = { command: (async (_kind, value) => { values.push(value); return result(original); }) as Command };
    const messages = new AsyncSdkMessages(owner, () => {});
    try {
      const sending = messages.send(request, wait);
      request.key = `${runtime}:mutated`; request.authorization = 'Bearer changed'; request.payloadJson = '{}';
      owner.command = (async () => { throw Error('replacement must not execute'); }) as Command;
      assert.deepEqual(await sending, result(original)); assert.deepEqual(values, [original]);
    } finally { await messages.close(); }
  });
}

test('SDK messages: invalid/accessor input and pre-aborted waits cannot invoke owner', async () => {
  let calls = 0, getters = 0;
  const messages = new AsyncSdkMessages({ command: (async () => { calls++; throw Error('must not execute'); }) as Command }, () => {});
  try {
    const accessor = { ...input('ghcp'), get payloadJson() { getters++; return '{}'; } };
    await assert.rejects(messages.send(accessor, wait), unknown);
    await assert.rejects(messages.send({ ...input('ghcp'), commandKey: 'bad key' }, wait), unknown);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(messages.send(input('ghcp'), { ...wait, signal: controller.signal }),
      error => error instanceof NativeOperationError && error.outcome === 'not_started');
    assert.equal(calls, 0); assert.equal(getters, 0);
  } finally { await messages.close(); }
});

test('SDK messages: 128 physical operations retain capacity after cancellation, failures release it, freeze is final', async () => {
  const ack = gate(), controller = new AbortController(); let calls = 0, fail = true;
  const messages = new AsyncSdkMessages({ command: (async (_kind, value) => {
    calls++; await ack.promise; if (fail) throw Error('original failure'); return result(value as Send);
  }) as Command }, () => {});
  try {
    const requests = Array.from({ length: 128 }, (_, i) => messages.send({ ...input('ghcp'), commandKey: `command-${i}` },
      { ...wait, signal: controller.signal }));
    const settled = Promise.all(requests.map(request => assert.rejects(request, unknown)));
    await tick(); assert.equal(calls, 128); controller.abort(); await settled;
    await assert.rejects(messages.send(input('ghcp'), wait), unknown); assert.equal(calls, 128);
    ack.release(); await tick(); fail = false;
    assert.deepEqual(await messages.send(input('ghcp'), wait), result(input('ghcp')));
    messages.freeze(); await assert.rejects(messages.send(input('ghcp'), wait), unknown);
    assert.equal(calls, 129);
  } finally { ack.release(); await messages.close(); }
});

test('SDK messages: broken diagnostic callbacks cannot replace original receipt or strand close', async () => {
  const diagnostics = new PerformanceDiagnostics(() => {});
  diagnostics.start = () => { throw Error('broken observer'); };
  const request = input('ghcp'), messages = new AsyncSdkMessages({ command: (async () => result(request)) as Command }, () => {}, diagnostics);
  assert.deepEqual(await messages.send(request, wait), result(request)); await messages.close();
});
