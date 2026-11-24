import assert from 'node:assert/strict';
import test from 'node:test';
import { AsyncConnectorEventProjection } from './async-event-projection.js';
import { ConnectorOwnerUnavailable } from './connector-owner-domain.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

type Owner = ConstructorParameters<typeof AsyncConnectorEventProjection>[0];
const epoch = 'ce1_00000000-0000-4000-8000-000000000001:';
const page = (seq = 0) => ({ cursor: epoch + seq, known: true, events: [] });
const event = () => ({ id: '', type: 'session.updated' as const, ts: 1, payload: { private: 'body' } });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function held<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

for (const fault of ['start', 'add', 'finish', 'pending'] as const) {
  test(`event projection ${fault} diagnostic failure cannot strand originals or drain`, async t => {
    const gate = held<unknown>(); let calls = 0, observations = 0;
    const diagnostics = { start() {
      if (fault === 'start') throw Error('private observer failure');
      return {
        add() { if (fault === 'add') throw Error('private observer failure'); },
        finish() { if (fault === 'finish') throw Error('private observer failure'); },
        reportPending() { observations++; if (fault === 'pending') throw Error('private observer failure'); },
      };
    } } as unknown as PerformanceDiagnostics;
    const owner = { command: async () => { calls++; return gate.promise; } };
    const projection = new AsyncConnectorEventProjection(owner as unknown as Owner, diagnostics);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const append = projection.append([event()]);
    const rejectionObserver = append.catch(() => {});
    await tick();
    const close = projection.close(); let closed = false;
    void close.then(() => { closed = true; }, () => {});
    try {
      t.mock.timers.tick(30_000);
      assert.equal(projection.status().pending, 1); assert.equal(closed, false);
      if (fault === 'pending') assert.equal(observations, 2);
    } finally { gate.resolve({ cursor: epoch + '1' }); await rejectionObserver; }
    assert.equal(await append, epoch + '1'); await close;
    assert.equal(calls, 1); assert.equal(closed, true);
    assert.equal(projection.status().pending, 0); assert.equal(projection.status().inputBytes, 0);
  });
}

test('diagnostic reentry cannot reorder reads or let close overtake the original queue', async () => {
  const first = held<unknown>(); const after = held<unknown>(); const calls: string[] = [];
  let projection!: AsyncConnectorEventProjection, nested: Promise<unknown> | undefined, reentered = false;
  const diagnostics = { start() {
    if (!reentered) { reentered = true; nested = projection.replay(epoch + '1'); }
    return { add() {}, reportPending() {}, finish() {} };
  } } as unknown as PerformanceDiagnostics;
  const owner = { command: async (_kind: string, input: { after: string | null }) => {
    calls.push(input.after ?? 'initial'); return calls.length === 1 ? first.promise : after.promise;
  } };
  projection = new AsyncConnectorEventProjection(owner as unknown as Owner, diagnostics);
  const original = projection.replay(null);
  void original.catch(() => {}); void nested?.catch(() => {});
  await tick(); assert.deepEqual(calls, ['initial']); assert.equal(projection.status().pending, 2);
  first.resolve(page(1)); await original; await tick();
  assert.deepEqual(calls, ['initial', epoch + '1']);
  let closed = false; const close = projection.close(); void close.then(() => { closed = true; });
  await tick(); assert.equal(closed, false);
  // Closing fences the read result, but must still drain its original owner
  // command rather than releasing ownership or admitting a replacement read.
  after.resolve(page(1)); await assert.rejects(nested!, ConnectorOwnerUnavailable);
  await close; assert.equal(projection.status().pending, 0);
});

test('close publishes its original drain before a diagnostic callback can reenter close', async () => {
  let projection!: AsyncConnectorEventProjection, nested: Promise<void> | undefined, reentered = false;
  const diagnostics = { start() {
    if (!reentered) { reentered = true; nested = projection.close(); }
    return { add() {}, reportPending() {}, finish() {} };
  } } as unknown as PerformanceDiagnostics;
  projection = new AsyncConnectorEventProjection({ command: async () => page() } as unknown as Owner, diagnostics);
  const close = projection.close(); assert.equal(nested, close); await close;
});

test('failed reads settle without an unknown-write diagnostic or implicit journal reset', async () => {
  const rows: Record<string, unknown>[] = [], calls: string[] = [];
  const projection = new AsyncConnectorEventProjection({ command: async (kind: string) => {
    calls.push(kind);
    if (kind === 'eventReplay') throw Error('private read failure');
    return { recovered: false, cursor: epoch + '3' };
  } } as unknown as Owner, new PerformanceDiagnostics(line => rows.push(JSON.parse(line))));
  await assert.rejects(projection.replay(null), ConnectorOwnerUnavailable); await tick();
  assert.equal(projection.status().unknown, false);
  const completion = rows.find(row => row.step === 2 && row.phase === 'finished');
  assert.equal(completion?.settled, 1); assert.notEqual(completion?.unknown, 1);
  assert.equal(await projection.recover(), true); await projection.close();
  assert.deepEqual(calls, ['eventReplay', 'eventProjectionRecover']);
  assert.equal(JSON.stringify(rows).includes('private read failure'), false);
});

for (const callback of ['add', 'pending', 'finish'] as const) {
  test(`${callback} diagnostic reentry retains the original drain and rejects late admission`, async t => {
    let projection!: AsyncConnectorEventProjection, nested: Promise<void> | undefined;
    let armed = false, attempts = 0;
    const reenter = () => {
      if (!armed) return;
      armed = false; attempts++; nested = projection.close();
    };
    const diagnostics = { start() {
      return { add() { if (callback === 'add') reenter(); },
        reportPending() { if (callback === 'pending') reenter(); },
        finish() { if (callback === 'finish') reenter(); } };
    } } as unknown as PerformanceDiagnostics;
    const gate = held<unknown>(); let calls = 0;
    projection = new AsyncConnectorEventProjection({ command: async () => { calls++; return gate.promise; } } as unknown as Owner, diagnostics);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    armed = true;
    const append = projection.append([event()]); await tick();
    if (callback === 'pending') t.mock.timers.tick(30_000);
    if (callback !== 'finish') {
      assert.equal(attempts, 1); assert.equal(projection.status().pending, 1);
      let closed = false; void nested!.then(() => { closed = true; });
      await tick(); assert.equal(closed, false);
      await assert.rejects(projection.replay(null), ConnectorOwnerUnavailable);
    }
    gate.resolve({ cursor: epoch + '1' }); assert.equal(await append, epoch + '1'); await tick();
    assert.equal(attempts, 1); assert.equal(nested, projection.close()); await nested;
    assert.equal(calls, 1); assert.equal(projection.status().pending, 0);
  });
}

test('failed-admission diagnostic reentry is bounded and cannot recursively log or reopen a closed projection', async () => {
  let projection!: AsyncConnectorEventProjection; let observations = 0;
  const rejections: Promise<unknown>[] = [];
  const diagnostics = { start() {
    observations++;
    // A sink that observes another failure must not recursively start itself.
    rejections.push(projection.replay(null).catch(error => error));
    return { add() {}, reportPending() {}, finish() {} };
  } } as unknown as PerformanceDiagnostics;
  projection = new AsyncConnectorEventProjection({ command: async () => assert.fail('no SQL after close') } as unknown as Owner, diagnostics);
  await projection.close();
  await assert.rejects(projection.replay(null), ConnectorOwnerUnavailable);
  assert.equal(observations, 2);
  assert.equal(rejections.length, 2);
  for (const outcome of await Promise.all(rejections)) assert.ok(outcome instanceof ConnectorOwnerUnavailable);
  assert.equal(projection.status().pending, 0);
});

test('unknown append ACK remains fenced even when all diagnostic callbacks throw', async () => {
  let calls = 0;
  const diagnostics = { start() {
    return { add() { throw Error('private observer failure'); },
      reportPending() { throw Error('private observer failure'); },
      finish() { throw Error('private observer failure'); } };
  } } as unknown as PerformanceDiagnostics;
  const projection = new AsyncConnectorEventProjection({ command: async () => { calls++; return { cursor: 'invalid' }; } } as unknown as Owner, diagnostics);
  const first = projection.append([event()]), follower = projection.append([event()]);
  await Promise.all([first, follower].map(work => assert.rejects(work, ConnectorOwnerUnavailable)));
  await assert.rejects(projection.recover(), ConnectorOwnerUnavailable);
  await projection.close();
  assert.equal(calls, 1); assert.equal(projection.status().unknown, true);
  assert.equal(projection.status().pending, 0); assert.equal(projection.status().inputBytes, 0);
});
