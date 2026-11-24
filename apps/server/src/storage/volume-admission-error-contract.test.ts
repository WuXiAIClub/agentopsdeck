import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { VolumeAdmission } from './volume-admission.js';

function fixture(t: TestContext, sinkThrows = false) {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-volume-error-contract-'));
  const db = new DatabaseSync(':memory:');
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const rows: Record<string, unknown>[] = [];
  const diagnostics = new PerformanceDiagnostics(line => {
    rows.push(JSON.parse(line)); if (sinkThrows) throw Error('private-sink-failure');
  });
  const admission = new VolumeAdmission(db, root, () => 1000, () => 1024n * 1024n ** 2n, diagnostics);
  return { admission, rows, pressure: () => Number(db.prepare('SELECT count(*) n FROM storage_volume_pressure').get()!.n),
    reservations: () => Number(db.prepare('SELECT count(*) n FROM storage_work_reservations').get()!.n) };
}
function failure(kind: string): unknown {
  if (kind === 'code-getter') return Object.defineProperty({}, 'code', { get() { throw Error('private-code-inspection'); } });
  if (kind === 'result-getter') return Object.defineProperty({ code: 'ERR_SQLITE_ERROR' }, 'errcode', { get() { throw Error('private-result-inspection'); } });
  if (kind === 'revoked-proxy') { const { proxy, revoke } = Proxy.revocable({}, {}); revoke(); return proxy; }
  if (kind === 'full-with-unrelated-getter') return Object.defineProperty({ code: 'ENOSPC' }, 'errcode', { get() { throw Error('private-unused-result'); } });
  if (kind === 'code-coercion') return { code: { [Symbol.toPrimitive]() { return 'ENOSPC'; } } };
  if (kind === 'result-coercion') return { code: 'ERR_SQLITE_ERROR', errcode: { [Symbol.toPrimitive]() { return 13; } } };
  if (kind === 'negative-result') return { code: 'ERR_SQLITE_ERROR', errcode: -243 };
  if (kind === 'string-result') return { code: 'ERR_SQLITE_ERROR', errcode: '13' };
  if (kind === 'null') return null;
  if (kind === 'string') return 'private-failure';
  if (kind === 'full' || kind === 'extended-full') return { code: 'ERR_SQLITE_ERROR', errcode: kind === 'full' ? 13 : 269 };
  return { code: kind };
}

for (const mode of ['sync', 'async'] as const) {
  for (const kind of ['code-getter', 'result-getter', 'revoked-proxy', 'full-with-unrelated-getter', 'code-coercion',
    'result-coercion', 'negative-result', 'string-result', 'null', 'string', 'full', 'extended-full', 'ENOSPC', 'EDQUOT', 'SQLITE_FULL']) {
    test(`${mode} volume failure ${kind}: preserve rejection identity and record only actual pressure`, async t => {
      const f = fixture(t), original = failure(kind); let rejected = false, value: unknown, calls = 0;
      try {
        if (mode === 'sync') f.admission.runSync('durable', 1, () => { calls++; throw original; });
        else await f.admission.run('durable', 1, async () => { calls++; throw original; });
      } catch (error) { rejected = true; value = error; }
      assert.equal(rejected, true); assert.ok(value === original); assert.equal(calls, 1);
      const full = ['full-with-unrelated-getter', 'full', 'extended-full', 'ENOSPC', 'EDQUOT', 'SQLITE_FULL'].includes(kind);
      assert.equal(f.pressure(), Number(full)); assert.equal(f.reservations(), 0);
      const unknown = ['code-getter', 'result-getter', 'revoked-proxy'].includes(kind);
      assert.equal(f.rows.reduce((n, row) => n + Number(row.pressureUnknown ?? 0), 0), Number(unknown));
      assert.doesNotMatch(JSON.stringify(f.rows), /private-|agentopsdeck-volume-error-contract-/);
    });
  }
}

test('volume pressure classification reads fields once and does not coerce objects', t => {
  const f = fixture(t); let codes = 0, results = 0, coercions = 0;
  const original = { get code() { codes++; return 'ERR_SQLITE_ERROR'; },
    get errcode() { results++; return { [Symbol.toPrimitive]() { coercions++; return 13; } }; } };
  assert.throws(() => f.admission.runSync('durable', 1, () => { throw original; }), value => value === original);
  assert.deepEqual({ codes, results, coercions }, { codes: 1, results: 1, coercions: 0 });
  assert.equal(f.pressure(), 0); assert.equal(f.reservations(), 0);
});

test('failed pressure diagnostics cannot change original error or settled reservation', t => {
  const f = fixture(t, true), original = failure('code-getter');
  assert.throws(() => f.admission.runSync('durable', 1, () => { throw original; }), value => value === original);
  const pressure = f.rows.filter(row => row.operation === 'storage-admission' && row.pressureUnknown === 1);
  assert.equal(pressure.length, 1); assert.equal(pressure[0]!.category, 'failed');
  assert.equal(f.reservations(), 0);
});

test('escaped native Promise records classification uncertainty only after original writer settles', async t => {
  const f = fixture(t); let reject!: (value: unknown) => void;
  const work = new Promise<never>((_, no) => { reject = no; });
  assert.throws(() => (f.admission.runSync as Function)('durable', 1, () => work), /must be synchronous/);
  assert.equal(f.reservations(), 1);
  reject(failure('code-getter')); await work.catch(() => {});
  assert.equal(f.reservations(), 0);
  assert.equal(f.rows.reduce((n, row) => n + Number(row.pressureUnknown ?? 0), 0), 1);
  assert.equal(f.rows.filter(row => row.operation === 'storage-sync-contract' && row.phase === 'finished').length, 1);
});

for (const kind of ['revoked-proxy', 'prototype-getter']) test(`failed original capacity sample ${kind} cannot be replaced by backoff inspection`, t => {
  const f = fixture(t);
  f.admission.runSync('durable', 1, () => {}); // Establish the ledger before injecting the failed sample.
  const original = kind === 'revoked-proxy' ? failure(kind)
    : new Proxy({}, { getPrototypeOf() { throw Error('private-prototype-inspection'); } });
  t.mock.method(f.admission as unknown as { sample(): bigint }, 'sample', () => { throw original; });
  assert.throws(() => f.admission.runSync('durable', 1, () => assert.fail('not admitted')), value => value === original);
  assert.equal(f.reservations(), 0); assert.equal(f.pressure(), 0);
  assert.equal(f.rows.reduce((n, row) => n + Number(row.pressureUnknown ?? 0), 0), 1);
});
