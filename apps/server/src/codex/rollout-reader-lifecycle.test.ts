import assert from 'node:assert/strict';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { CodexRolloutReader } from './rollout-reader.js';
import { RolloutProjection, RolloutProjectionBuilder } from './rollout-projection.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise<void>(done => setImmediate(done));

for (const stage of ['open', 'stat', 'read', 'close'] as const) {
  for (const shared of [true, false]) test(`reader close drains original ${stage}, shared=${shared}`, async context => {
    const directory = await fsPromises.mkdtemp(join(tmpdir(), 'agentopsdeck-rollout-drain-'));
    const file = join(directory, 'private-rollout.jsonl');
    await fsPromises.writeFile(file, JSON.stringify({ type: 'turn_context', payload: { model: 'private-model' } }) + '\n');
    const held = gate(), entered = gate(), logs: any[] = [];
    const reader = new CodexRolloutReader({ shareConcurrentReads: shared,
      diagnostics: new PerformanceDiagnostics(line => logs.push(JSON.parse(line))) });
    const originalOpen = fsPromises.open;
    let handlesClosed = 0;
    context.mock.method(fsPromises, 'open', async (...args: Parameters<typeof originalOpen>) => {
      if (args[0] === file && stage === 'open') { entered.resolve(); await held.promise; }
      const handle = await originalOpen(...args);
      if (args[0] !== file) return handle;
      for (const method of ['stat', 'read', 'close'] as const) {
        const original = handle[method].bind(handle);
        context.mock.method(handle, method, async (...parameters: any[]) => {
          if (stage === method) { entered.resolve(); await held.promise; }
          const value = await (original as any)(...parameters);
          if (method === 'close') handlesClosed++;
          return value;
        });
      }
      return handle;
    });
    syncBuiltinESMExports();
    const reading = reader.readSnapshot(file);
    const observed = reading.then(async projection => { await projection.dispose(); return 'complete'; }, () => 'unavailable');
    let closeFinished = false;
    try {
      await entered.promise;
      const closing = reader.close();
      closing.then(() => { closeFinished = true; }, () => { closeFinished = true; });
      await tick();
      assert.equal(closeFinished, false, 'close must not certify an unresolved original descriptor operation');
      assert.equal(reader.close(), closing, 'repeated close observes the same original drain');
      await assert.rejects(reader.readSnapshot(file), /closed/);
      assert.equal(handlesClosed, 0);
      held.resolve();
      await observed; await closing;
      assert.equal(handlesClosed, 1);
      assert.equal((reader.cacheStats() as any).activeReadOperations, 0);
      assert.equal(reader.cacheStats().entries, 0);
      const closeLogs = logs.filter(log => log.operation === 'rollout-reader-close');
      assert.equal(closeLogs.length, 2);
      assert.equal(closeLogs[0].phase, 'pending');
      assert.equal(closeLogs[0].pending, 1);
      assert.equal(closeLogs[1].phase, 'finished');
      assert.equal(closeLogs[1].settled, 1);
      assert.equal(closeLogs[1].unknown, undefined);
      assert.equal(closeLogs[0].sequence, closeLogs[1].sequence);
      assert.doesNotMatch(JSON.stringify(logs), /private-rollout|private-model/);
    } finally {
      held.resolve(); await observed; await reader.close();
      context.mock.restoreAll(); syncBuiltinESMExports();
      await fsPromises.rm(directory, { recursive: true, force: true });
    }
  });
}

test('repeated projection dispose observes original block close, without replay', async () => {
  const entered = gate(), held = gate(); let closes = 0;
  const projection = new RolloutProjection([{ bytes: 0, memoryBytes: 0, refs: 0,
    lines: async function* () {}, close: async () => { closes++; entered.resolve(); await held.promise; } }]);
  const first = projection.dispose();
  try {
    await entered.promise;
    const second = projection.dispose();
    let settled = false; second.then(() => { settled = true; });
    await tick();
    assert.equal(settled, false, 'disposed flag is not original close proof');
    assert.equal(first, second);
    assert.throws(() => projection.fork(), /released/);
    assert.equal(closes, 1);
  } finally { held.resolve(); await first; }
});

test('reader close diagnostics survive a throwing sink and never replay cleanup', async () => {
  let attempts = 0;
  const diagnostics = new PerformanceDiagnostics(() => { attempts++; throw Error('private-log-sink'); });
  const reader = new CodexRolloutReader({ diagnostics });
  const closing = reader.close();
  assert.equal(reader.close(), closing);
  await closing;
  assert.equal(attempts, 2);
  const events = diagnostics.snapshot().events.filter(event => event.operation === 'rollout-reader-close');
  assert.equal(events.length, 2);
  assert.equal(events[0]!.phase, 'pending');
  assert.equal(events[1]!.settled, 1);
  assert.ok(events.every(event => event.delivery === 'failed'));
  assert.doesNotMatch(JSON.stringify(events), /private-log-sink/);
});

test('projection cleanup failure drains other original blocks and cannot become successful on retry', async () => {
  const held = gate(), entered = gate(), fault = Error('private-cleanup-fault');
  let closes = 0;
  const block = (close: () => Promise<void>) => ({ bytes: 0, memoryBytes: 0, refs: 0, lines: async function* () {}, close });
  const projection = new RolloutProjection([
    block(async () => { closes++; throw fault; }),
    block(async () => { closes++; entered.resolve(); await held.promise; }),
  ]);
  const first = projection.dispose();
  const outcome = first.then(() => undefined, error => error);
  try {
    await entered.promise;
    let settled = false; outcome.then(() => { settled = true; });
    await tick();
    assert.equal(settled, false, 'one failed close must not abandon another original close');
    assert.equal(projection.dispose(), first);
    held.resolve();
    assert.equal(await outcome, fault);
    await assert.rejects(projection.dispose(), error => error === fault);
    assert.equal(closes, 2);
  } finally { held.resolve(); await outcome; }
});

test('reader close drains every cached disposal before reporting failure, including repeated calls', async context => {
  const diagnostics = new PerformanceDiagnostics(() => { throw Error('private-sink'); });
  const reader = new CodexRolloutReader({ diagnostics });
  const held = gate(), entered = gate(), fault = Error('private-dispose');
  let disposals = 0;
  const projection = (dispose: () => Promise<void>) => ({ dispose });
  const cache = (reader as any).cache;
  cache.set('first', { projection: projection(async () => { disposals++; throw fault; }) });
  cache.set('second', { projection: projection(async () => { disposals++; entered.resolve(); await held.promise; }) });
  const first = reader.close(), outcome = first.then(() => undefined, error => error);
  try {
    await entered.promise;
    let finished = false; outcome.then(() => { finished = true; });
    await tick();
    assert.equal(finished, false);
    assert.equal(reader.close(), first);
    held.resolve(); assert.equal(await outcome, fault);
    await assert.rejects(reader.close(), error => error === fault);
    assert.equal(disposals, 2);
    assert.equal(reader.cacheStats().cleanupFailed, true);
    const events = diagnostics.snapshot().events.filter(event => event.operation === 'rollout-reader-close');
    assert.equal(events.length, 2);
    assert.equal(events[0]!.phase, 'pending');
    assert.equal(events[0]!.records, 2);
    assert.equal(events[1]!.phase, 'finished');
    assert.equal(events[1]!.unknown, 1);
    assert.equal(events[1]!.settled, undefined);
    assert.equal(events[1]!.category, 'failed');
    assert.ok(events.every(event => event.delivery === 'failed'));
    assert.doesNotMatch(JSON.stringify(events), /private-sink|private-dispose|first|second/);
  } finally { held.resolve(); await outcome; context.mock.restoreAll(); }
});

test('reader read failure cannot abandon another finally cleanup during close', async context => {
  const directory = await fsPromises.mkdtemp(join(tmpdir(), 'agentopsdeck-rollout-finally-'));
  const file = join(directory, 'rollout.jsonl');
  await fsPromises.writeFile(file, JSON.stringify({ type: 'turn_context', payload: { model: 'fixture' } }) + '\n');
  const held = gate(), entered = gate(), fault = Error('private-close-ack');
  const reader = new CodexRolloutReader({ projectionMemoryBytes: 0 });
  const originalOpen = fsPromises.open, originalAbort = RolloutProjectionBuilder.prototype.abort;
  let spillOpened = 0, spillClosed = 0;
  context.mock.method(fsPromises, 'open', async (...args: Parameters<typeof originalOpen>) => {
    const handle = await originalOpen(...args);
    if (args[0] === file) {
      const close = handle.close.bind(handle);
      context.mock.method(handle, 'close', async () => { await close(); throw fault; });
    } else if (String(args[0]).endsWith('records.jsonl')) {
      spillOpened++; const close = handle.close.bind(handle);
      context.mock.method(handle, 'close', async () => { await close(); spillClosed++; });
    }
    return handle;
  });
  context.mock.method(RolloutProjectionBuilder.prototype, 'abort', async function(this: RolloutProjectionBuilder) {
    entered.resolve(); await held.promise; await originalAbort.call(this);
  });
  syncBuiltinESMExports();
  const reading = reader.readSnapshot(file), outcome = reading.then(async value => { await value.dispose(); }, error => error);
  try {
    await entered.promise;
    const closing = reader.close(), closeOutcome = closing.then(() => undefined, error => error); let closed = false;
    closeOutcome.then(() => { closed = true; });
    await tick(); await tick();
    assert.equal(closed, false, 'failed descriptor close must not detach builder cleanup');
    held.resolve(); assert.equal(await outcome, fault); assert.equal(await closeOutcome, fault);
    assert.equal(spillOpened, 1); assert.equal(spillClosed, spillOpened, 'failed return releases its unpublished lease');
  } finally {
    held.resolve(); await outcome; await assert.rejects(reader.close(), error => error === fault); context.mock.restoreAll(); syncBuiltinESMExports();
    await fsPromises.rm(directory, { recursive: true, force: true });
  }
});

test('failed cache trimming does not detach another retired cache disposal from reader close', async context => {
  const held = gate(), entered = gate(), fault = Error('private-trim-dispose');
  const reader = new CodexRolloutReader({ cachePolicy: { maxEntries: 1, maxIdleMs: 1000 }, now: () => 2000,
    diagnostics: new PerformanceDiagnostics(() => {}) });
  const block = (dispose: () => Promise<void>) => ({ touchedAt: 0, projection: { bytes: 0, memoryBytes: 0, dispose } });
  const cache = (reader as any).cache;
  cache.set('first', block(async () => { throw fault; }));
  cache.set('second', block(async () => { entered.resolve(); await held.promise; }));
  const reading = reader.readSnapshot('unused-private-path'), outcome = reading.then(() => undefined, error => error);
  try {
    await entered.promise;
    const closing = reader.close(), closeOutcome = closing.then(() => undefined, error => error);
    let closed = false; closeOutcome.then(() => { closed = true; });
    await tick(); await tick();
    assert.equal(closed, false, 'removed cache entry is not original disposal proof');
    held.resolve(); assert.equal(await outcome, fault); assert.equal(await closeOutcome, fault);
  } finally { held.resolve(); await outcome; await assert.rejects(reader.close(), error => error === fault); context.mock.restoreAll(); }
});
