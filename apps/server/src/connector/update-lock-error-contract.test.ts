import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fsPromises, { mkdtemp, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../config.js';
import { ConnectorUpdateService } from './update-service.js';
import { PerformanceDiagnostics, performanceDiagnostics } from '../diagnostics/performance.js';

type Boundary = { withMutationLock<T>(operation: string, callback: () => Promise<T>): Promise<T> };
async function fixture(t: TestContext, sinkThrows = false) {
  const directory = await mkdtemp(join(tmpdir(), 'agentopsdeck-update-error-contract-'));
  t.after(async () => { t.mock.restoreAll(); syncBuiltinESMExports(); await rm(directory, { recursive: true, force: true }); });
  const config = loadConfig({ AOD_CONNECTOR_UPDATE_ENABLED: 'true',
    AOD_CONNECTOR_UPDATE_STATE_FILE: join(directory, 'private-state.json'), AOD_CONNECTOR_INSTALL_ROOT: directory });
  const rows: Record<string, unknown>[] = [];
  const diagnostics = new PerformanceDiagnostics(line => { rows.push(JSON.parse(line)); if (sinkThrows) throw Error('private-log-failure'); });
  t.mock.method(performanceDiagnostics, 'start', diagnostics.start.bind(diagnostics));
  return { directory, rows, boundary: new ConnectorUpdateService(config) as unknown as Boundary };
}
async function rejectedValue(work: Promise<unknown>) {
  let rejected = false, value: unknown;
  try { await work; } catch (error) { rejected = true; value = error; }
  assert.equal(rejected, true);
  return { value }; // Do not assimilate arbitrary rejection reasons.
}
function failure(kind: string): unknown {
  if (kind === 'revoked-proxy') { const { proxy, revoke } = Proxy.revocable({}, {}); revoke(); return proxy; }
  if (kind === 'prototype-getter') return new Proxy({}, { getPrototypeOf() { throw Error('private-prototype-inspection'); } });
  if (kind === 'has-trap') return new Proxy({}, { has() { throw Error('private-property-inspection'); } });
  if (kind === 'code-getter') return Object.defineProperty({}, 'code', { get() { throw Error('private-code-inspection'); } });
  if (kind === 'result-getter') return Object.defineProperty({ code: 'ERR_SQLITE_ERROR' }, 'errcode', { get() { throw Error('private-result-inspection'); } });
  if (kind === 'result-coercion') return { code: 'ERR_SQLITE_ERROR', errcode: { [Symbol.toPrimitive]() { throw Error('private-result-coercion'); } } };
  return { code: 'ERR_SQLITE_ERROR', errcode: Number(kind) };
}

for (const kind of ['5', '6', '261', '262', 'revoked-proxy', 'prototype-getter', 'result-getter', 'result-coercion']) {
  for (const sinkThrows of [false, true]) test(`admitted update ${kind} failure retains identity and unknown outcome, sink throws ${sinkThrows}`, async t => {
    const f = await fixture(t, sinkThrows), original = failure(kind); let calls = 0;
    const { value } = await rejectedValue(f.boundary.withMutationLock('maintenance', async () => { calls++; throw original; }));
    assert.ok(value === original, 'an admitted effect failure must never become a busy/retry signal');
    assert.equal(calls, 1);
    const final = f.rows.find(row => row.operation === 'update-mutation-lock' && row.phase === 'finished');
    assert.equal(final?.unknown, 1); assert.equal(final?.admitted, 1); assert.equal(final?.settled, 1);
    assert.equal(final?.busy ?? 0, 0);
    assert.equal(await f.boundary.withMutationLock('maintenance', async () => 'new-distinct-request'), 'new-distinct-request');
    assert.equal(calls, 1, 'new work must not replay the original effect');
    assert.doesNotMatch(JSON.stringify(f.rows), /private-|agentopsdeck-update-error-contract-/);
  });
}

for (const [label, original, busy, classificationUnknown] of [
  ['busy', { code: 'ERR_SQLITE_ERROR', errcode: 5 }, true, false],
  ['locked', { code: 'ERR_SQLITE_ERROR', errcode: 6 }, true, false],
  ['extended-busy', { code: 'ERR_SQLITE_ERROR', errcode: 261 }, true, false],
  ['extended-locked', { code: 'ERR_SQLITE_ERROR', errcode: 262 }, true, false],
  ['unrelated-result', { code: 'private-unrelated-error', errcode: 5 }, false, false],
  ['string-result', { code: 'ERR_SQLITE_ERROR', errcode: '5' }, false, false],
  ['negative-result', { code: 'ERR_SQLITE_ERROR', errcode: -251 }, false, false],
  ['result-getter', failure('result-getter'), false, true],
  ['revoked-proxy', failure('revoked-proxy'), false, true],
  ['prototype-getter', failure('prototype-getter'), false, true],
  ['has-trap', failure('has-trap'), false, true],
  ['code-getter', failure('code-getter'), false, true],
  ['result-coercion', failure('result-coercion'), false, false],
] as const) test(`unadmitted update ${label} classifies only exact SQLite lock contention`, async t => {
  const f = await fixture(t); let calls = 0;
  t.mock.method(fsPromises, 'mkdir', async () => { throw original; }); syncBuiltinESMExports();
  const { value } = await rejectedValue(f.boundary.withMutationLock('maintenance', async () => ++calls));
  if (busy) assert.match((value as Error).message, /already in progress/);
  else assert.ok(value === original, 'best-effort inspection must preserve the exact failure');
  const final = f.rows.find(row => row.operation === 'update-mutation-lock' && row.phase === 'finished');
  assert.equal(calls, 0); assert.equal(final?.admitted, 0); assert.equal(final?.unknown ?? 0, 0);
  assert.equal(final?.busy ?? 0, Number(busy));
  assert.equal(final?.classificationUnknown ?? 0, Number(classificationUnknown));
  assert.doesNotMatch(JSON.stringify(f.rows), /private-|agentopsdeck-update-error-contract-/);
});

test('preadmission SQLite classification reads getters once and never coerces values', async t => {
  const f = await fixture(t); let codes = 0, results = 0, coercions = 0;
  const original = { get code() { codes++; return 'ERR_SQLITE_ERROR'; },
    get errcode() { results++; return { [Symbol.toPrimitive]() { coercions++; return 5; } }; } };
  t.mock.method(fsPromises, 'mkdir', async () => { throw original; }); syncBuiltinESMExports();
  const { value } = await rejectedValue(f.boundary.withMutationLock('maintenance', async () => assert.fail('not admitted')));
  assert.ok(value === original);
  assert.deepEqual({ codes, results, coercions }, { codes: 1, results: 1, coercions: 0 });
  const final = f.rows.find(row => row.phase === 'finished');
  assert.equal(final?.busy ?? 0, 0); assert.equal(final?.classificationUnknown ?? 0, 0);
});

test('an original busy error from a competing request is not reclassified when thrown by an admitted callback', async t => {
  const f = await fixture(t); let original: unknown;
  const { value } = await rejectedValue(f.boundary.withMutationLock('maintenance', async () => {
    ({ value: original } = await rejectedValue(f.boundary.withMutationLock('maintenance', async () => assert.fail('lock still held'))));
    throw original;
  }));
  assert.ok(value === original);
  const finals = f.rows.filter(row => row.phase === 'finished');
  const competing = finals.find(row => row.admitted === 0), admitted = finals.find(row => row.admitted === 1);
  assert.equal(competing?.busy, 1); assert.equal(competing?.unknown ?? 0, 0);
  assert.equal(admitted?.busy ?? 0, 0); assert.equal(admitted?.unknown, 1); assert.equal(admitted?.settled, 1);
});
