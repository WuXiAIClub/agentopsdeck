import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import { AsyncVolumeAdmission } from './async-volume-admission.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

type Message = { id: number; kind: string; full?: boolean; lease?: string; volume?: string };
class Owner extends EventEmitter {
  messages: Message[] = [];
  constructor(private readonly loseFinish = false) { super(); }
  postMessage(message: Message) {
    this.messages.push(message);
    queueMicrotask(() => {
      if (this.loseFinish && message.kind === 'finish') this.emit('error', Error('private-owner-failure'));
      else this.emit('message', { id: message.id, kind: message.kind, ok: true,
        ...(message.kind === 'begin' ? { volume: '42' } : {}) });
    });
  }
  ref() {}
  unref() {}
  terminate() { this.emit('exit', 1); return Promise.resolve(1); }
}

async function rejectedValue(work: Promise<unknown>) {
  let rejected = false, value: unknown;
  try { await work; } catch (error) { rejected = true; value = error; }
  assert.equal(rejected, true);
  // Box the rejection reason: returning a revoked proxy from an async helper
  // would itself attempt Promise/then assimilation and corrupt this assertion.
  return { value };
}
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 5));
const privateRoot = '/private-error-contract-fixture';

for (const kind of ['code-getter', 'result-getter', 'code-coercion', 'revoked-proxy'] as const) {
  for (const phase of ['binding', 'writer', 'lost-finish'] as const) {
    test(`async admission preserves ${kind} during ${phase} without replay or private logging`, async () => {
      const old = new Owner(phase === 'lost-finish'), fresh = new Owner(), rows: any[] = [];
      const inspection = Error('private-inspection-failure');
      let original: unknown;
      if (kind === 'code-getter') original = Object.defineProperty({}, 'code', { get() { throw inspection; } });
      else if (kind === 'result-getter') original = Object.defineProperty({ code: 'ERR_SQLITE_ERROR' }, 'errcode', { get() { throw inspection; } });
      else if (kind === 'code-coercion') original = { code: { [Symbol.toPrimitive]() { throw inspection; } } };
      else { const { proxy, revoke } = Proxy.revocable({}, {}); revoke(); original = proxy; }
      let launches = 0, calls = 0, bindings = 0;
      const admission = new AsyncVolumeAdmission(() => (++launches === 1 ? old : fresh) as unknown as Worker,
        new PerformanceDiagnostics(line => rows.push(JSON.parse(line))), { recoveryDelayMs: 1 }, async () => {
          if (++bindings === 1 && phase === 'binding') throw original;
          return '42';
        });
      const { value: observed } = await rejectedValue(admission.run(privateRoot, 'recovery', 17, async () => { calls++; throw original; }));
      assert.ok(observed === original, 'inspection and finish errors must not replace the original failure');
      assert.equal(calls, phase === 'binding' ? 0 : 1);
      assert.deepEqual(old.messages.map(m => m.kind), phase === 'binding' ? [] : ['begin', 'finish']);
      if (phase !== 'binding') assert.equal(old.messages[1]!.full, false);
      assert.equal(admission.snapshot().activeWriters, 0);
      assert.equal(admission.snapshot().recoveryProofs, phase === 'lost-finish' ? 1 : 0);
      const final = rows.find(row => row.operation === 'async-storage-admission' && row.phase === 'finished');
      assert.equal(final.category, 'failed');
      assert.equal(final.step, phase === 'binding' ? 5 : 3);
      assert.equal(final.pressureUnknown ?? 0, kind === 'code-coercion' ? 0 : 1);
      assert.equal(final.unknown ?? 0, phase === 'lost-finish' ? 1 : 0);
      assert.doesNotMatch(JSON.stringify(rows), /private-|transient-/);
      if (phase === 'lost-finish') {
        const lease = old.messages[0]!.lease;
        await pause();
        assert.equal(await admission.run(privateRoot, 'recovery', 19, async () => ++calls), 2);
        assert.deepEqual(fresh.messages.map(m => m.kind), ['reconcile', 'begin', 'finish']);
        assert.deepEqual(fresh.messages[0], { id: 2, kind: 'reconcile', lease, root: privateRoot, volume: '42', full: false });
        assert.equal(admission.snapshot().recoveryProofs, 0);
        assert.equal(calls, 2, 'only the new explicitly submitted writer runs; the original is not replayed');
      }
    });
  }
}

for (const [label, original, full] of [
  ['ENOSPC', { code: 'ENOSPC' }, true], ['EDQUOT', { code: 'EDQUOT' }, true],
  ['SQLITE_FULL', { code: 'SQLITE_FULL' }, true],
  ['sqlite-primary', { code: 'ERR_SQLITE_ERROR', errcode: 13 }, true],
  ['sqlite-extended', { code: 'ERR_SQLITE_ERROR', errcode: 269 }, true],
  ['sqlite-busy', { code: 'ERR_SQLITE_ERROR', errcode: 5 }, false],
  ['string-result', { code: 'ERR_SQLITE_ERROR', errcode: '13' }, false],
  ['unsafe-result', { code: 'ERR_SQLITE_ERROR', errcode: Number.MAX_SAFE_INTEGER + 1 }, false],
  ['fractional-result', { code: 'ERR_SQLITE_ERROR', errcode: 13.5 }, false],
  ['negative-result', { code: 'ERR_SQLITE_ERROR', errcode: -243 }, false],
  ['null', null, false], ['undefined', undefined, false], ['primitive', 'ENOSPC', false],
  ['nonstring-code', { code: { toString() { throw Error('private-coercion'); } } }, false],
] as const) {
  test(`async admission classifies ${label} without changing the thrown value`, async () => {
    const owner = new Owner(), rows: any[] = [];
    const admission = new AsyncVolumeAdmission(() => owner as unknown as Worker,
      new PerformanceDiagnostics(line => rows.push(JSON.parse(line))), {}, () => '42');
    assert.ok((await rejectedValue(admission.run(privateRoot, 'durable', 1, async () => { throw original; }))).value === original);
    assert.equal(owner.messages[1]!.full, full);
    assert.equal(admission.snapshot().recoveryProofs, 0);
    assert.equal(rows.find(row => row.operation === 'async-storage-admission').pressureUnknown ?? 0, 0);
  });
}

test('SQLite pressure fields are inspected once, with no unrelated getter access', async () => {
  const owner = new Owner(); let codes = 0, results = 0;
  const original = { get code() { codes++; return 'ERR_SQLITE_ERROR'; }, get errcode() { results++; return 269; } };
  const admission = new AsyncVolumeAdmission(() => owner as unknown as Worker, new PerformanceDiagnostics(() => {}), {}, () => '42');
  assert.ok((await rejectedValue(admission.run(privateRoot, 'durable', 1, async () => { throw original; }))).value === original);
  assert.equal(codes, 1); assert.equal(results, 1); assert.equal(owner.messages[1]!.full, true);
  const plain = { code: 'ENOSPC', get errcode() { throw Error('must not read unrelated SQLite code'); } };
  assert.ok((await rejectedValue(admission.run(privateRoot, 'durable', 1, async () => { throw plain; }))).value === plain);
  assert.equal(owner.messages[3]!.full, true);
});

for (const full of [true, false]) test(`lost finish ACK retains original error and full=${full} exact proof despite failing diagnostics`, async () => {
  const old = new Owner(true), fresh = new Owner(); let launches = 0, calls = 0;
  const original = { code: full ? 'SQLITE_FULL' : 'SQLITE_BUSY' };
  const admission = new AsyncVolumeAdmission(() => (++launches === 1 ? old : fresh) as unknown as Worker,
    new PerformanceDiagnostics(() => { throw Error('private-log-failure'); }), { recoveryDelayMs: 1 }, () => '42');
  assert.ok((await rejectedValue(admission.run(privateRoot, 'durable', 7, async () => { calls++; throw original; }))).value === original);
  assert.equal(old.messages[1]!.full, full);
  assert.equal(admission.snapshot().recoveryProofs, 1);
  await pause();
  assert.equal(await admission.run(privateRoot, 'durable', 8, async () => ++calls), 2);
  assert.deepEqual(fresh.messages[0], { id: 2, kind: 'reconcile', lease: old.messages[0]!.lease,
    root: privateRoot, volume: '42', full });
  assert.equal(admission.snapshot().recoveryProofs, 0);
});
