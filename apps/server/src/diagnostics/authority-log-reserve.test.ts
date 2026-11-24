import assert from 'node:assert/strict';
import test from 'node:test';
import { PerformanceDiagnostics } from './performance.js';

for (const operation of ['hub-request-authority', 'connector-grants-http', 'connector-storage-maintenance', 'auth-route-persistence', 'session-preference-change'] as const)
  test(`critical ${operation} refusal remains logged after unrelated failure saturation`, () => {
    const rows: Record<string, unknown>[] = [];
    const diagnostics = new PerformanceDiagnostics(line => rows.push(JSON.parse(line)), () => 0);
    for (let i = 0; i < 65; i++) diagnostics.start('storage-admission').finish(true);
    const trace = diagnostics.start(operation);
    trace.add('step', operation === 'hub-request-authority' ? 2 : 18);
    trace.add('unknown', operation === 'hub-request-authority' ? 0 : 1);
    trace.add('deferred', operation === 'hub-request-authority' ? 1 : 0);
    trace.finish(true);
    assert.equal(rows.filter(row => row.operation === operation).length, 1);
    assert.equal(diagnostics.snapshot().events.find(row => row.operation === operation)!.delivery, 'delivered');
  });

test('authority fault reserve is shared and bounded across operations and survives rollover', () => {
  let now = 0;
  const rows: Record<string, unknown>[] = [];
  const diagnostics = new PerformanceDiagnostics(line => rows.push(JSON.parse(line)), () => now);
  const operations = ['hub-request-authority', 'auth-route-persistence', 'auth-sqlite-command', 'auth-compatibility-check', 'session-preference-change'] as const;
  for (let i = 0; i < 65; i++) {
    const trace = diagnostics.start(operations[i % operations.length]!);
    trace.add('step', 17);
    if (i % 2) trace.reportPending({ pending: 1 });
    else trace.finish(true);
  }
  assert.equal(rows.length, 60);
  assert.equal(diagnostics.snapshot().events.filter(row => row.delivery === 'rate-limited').length, 5);
  // The reserve cannot steal the original process or physical owner evidence.
  diagnostics.start('process-shutdown').finish(true);
  diagnostics.start('auth-sqlite-owner-failure').finish(true);
  assert.equal(rows.length, 62);
  now = 60_000;
  diagnostics.start('hub-request-authority').finish(true);
  assert.equal(rows.at(-1)!.suppressed, 5); assert.equal(rows.length, 63);
});

test('successful auth polling cannot consume the fixed critical failure reserve', () => {
  const rows: Record<string, unknown>[] = [];
  const diagnostics = new PerformanceDiagnostics(line => rows.push(JSON.parse(line)), () => 0);
  for (let i = 0; i < 100; i++) diagnostics.start('auth-route-persistence').finish();
  diagnostics.start('auth-route-persistence').finish(true);
  assert.equal(rows.filter(row => row.category === 'routine').length, 20);
  assert.equal(rows.filter(row => row.category === 'failed').length, 1);
});

test('broken sink retains bounded numeric refusal evidence without altering the outcome', () => {
  const diagnostics = new PerformanceDiagnostics(() => { throw Error('private-token-path'); }, () => 0);
  for (let i = 0; i < 65; i++) {
    const trace = diagnostics.start('auth-route-persistence'); trace.add('step', 18); trace.add('unknown', 1);
    assert.doesNotThrow(() => trace.finish(true));
  }
  const snapshot = diagnostics.snapshot();
  assert.equal(snapshot.events.length, 65); assert.equal(snapshot.totals.sinkFailures, 60);
  assert.equal(snapshot.events.filter(row => row.delivery === 'failed').length, 60);
  assert.equal(snapshot.events.filter(row => row.delivery === 'rate-limited').length, 5);
  assert.doesNotMatch(JSON.stringify(snapshot), /private-token-path/);
});
