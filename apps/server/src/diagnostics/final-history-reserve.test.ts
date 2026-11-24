import assert from 'node:assert/strict';
import test from 'node:test';
import { PerformanceDiagnostics } from './performance.js';

test('final history logs survive ordinary fault saturation without an unbounded separate reserve', () => {
  let now = 0;
  const rows: any[] = [];
  const d = new PerformanceDiagnostics(line => rows.push(JSON.parse(line)), () => now);
  for (let i = 0; i < 65; i++) d.start('storage-admission').finish(true);
  for (let i = 0; i < 61; i++) {
    const trace = d.start(i % 2 ? 'codex-final-history' : 'codex-interrupt-observation');
    trace.add('unknown', 1); trace.finish(true);
  }
  const lifecycle = rows.filter(row => row.operation !== 'storage-admission');
  assert.equal(lifecycle.length, 60);
  assert.equal(lifecycle.filter(row => row.operation === 'codex-final-history').length, 30);
  assert.equal(d.snapshot().events.at(-1)!.delivery, 'rate-limited');
  d.start('process-shutdown').finish(true); assert.equal(rows.at(-1)!.operation, 'process-shutdown');
  now += 60_000;
  const trace = d.start('codex-final-history'); trace.reportPending({ step: 1, pending: 1 });
  trace.add('settled', 1); trace.finish(); trace.reportPending({ step: 1, pending: 1 }); trace.finish();
  assert.equal(rows.at(-2)!.suppressed, 1);
  assert.equal(rows.at(-2)!.sequence, rows.at(-1)!.sequence);
  assert.equal(rows.at(-1)!.settled, 1); assert.equal(rows.at(-1)!.phase, 'finished');
});
