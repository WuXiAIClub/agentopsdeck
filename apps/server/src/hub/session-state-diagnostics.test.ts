import assert from 'node:assert/strict';
import test from 'node:test';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { observeHubAggregation, observeSessionState } from './session-state-diagnostics.js';

for (const stage of [1, 2, 3, 4, 5] as const) test(`session-state stage ${stage} pending sample is bounded and never a SQL settlement`, t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const rows: any[] = [], diagnostics = new PerformanceDiagnostics(line => rows.push(JSON.parse(line)), () => 0);
  const controller = new AbortController(), observation = observeSessionState(controller.signal, diagnostics);
  observation.stage(stage); t.mock.timers.tick(1_000);
  assert.equal(rows.length, 1); assert.equal(rows[0].phase, 'pending'); assert.equal(rows[0].step, stage);
  assert.equal(rows[0].pending, 1); assert.equal(rows[0].settled, undefined); assert.equal(rows[0].unknown, undefined);
  t.mock.timers.tick(60_000); assert.equal(rows.length, 1, 'no polling loop or log storm');
  observation.changed(); controller.abort(); observation.finish(false); observation.finish(true, 99);
  assert.equal(rows.length, 2); assert.equal(rows[1].sequence, rows[0].sequence);
  assert.equal(rows[1].phase, 'finished'); assert.equal(rows[1].step, stage);
  assert.equal(rows[1].cancelled, 1); assert.equal(rows[1].changed, 1); assert.equal(rows[1].deferred, 1);
  assert.equal(rows[1].records, 0); assert.equal(rows[1].settled, undefined);
  assert.equal(rows[1].processId, process.pid);
  assert.equal(rows[1].threadId, 0);
  assert.ok(Number.isSafeInteger(rows[1].startedAtUnixMs));
  assert.ok(rows[1].observedAtUnixMs >= rows[1].startedAtUnixMs);
  assert.deepEqual(Object.keys(rows[1]).filter(key => ![
    'component', 'instance', 'sequence', 'operation', 'phase', 'category', 'elapsedMs', 'step',
    'processId', 'threadId', 'startedAtUnixMs', 'observedAtUnixMs',
    'cancelled', 'changed', 'deferred', 'records', 'suppressed',
  ].includes(key)), []);
});

test('session-state success cancels the original observation timer and reports only count', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const rows: any[] = [], diagnostics = new PerformanceDiagnostics(line => rows.push(JSON.parse(line)), () => 0);
  const observation = observeSessionState(new AbortController().signal, diagnostics);
  observation.stage(5); observation.finish(true, 4); t.mock.timers.tick(60_000);
  assert.equal(rows.length, 1); assert.equal(rows[0].records, 4); assert.equal(rows[0].category, 'routine');
  assert.equal(rows[0].deferred, undefined); assert.equal(rows[0].settled, undefined);
});

test('session-state failure observation survives saturation and contains no private result', () => {
  const diagnostics = new PerformanceDiagnostics(() => {}, () => 0);
  for (let i = 0; i < 80; i++) diagnostics.start('storage-admission').finish(true);
  const observation = observeSessionState(new AbortController().signal, diagnostics);
  observation.stage(3); observation.finish(false);
  const row = diagnostics.snapshot().events.find(event => event.operation === 'hub-session-state-read')!;
  assert.equal(row.step, 3); assert.equal(row.deferred, 1); assert.equal(row.delivery, 'rate-limited');
});

for (const fault of ['start', 'sink', 'clock'] as const) test(`session-state diagnostics ${fault} failure cannot change the route outcome`, () => {
  const diagnostics = new PerformanceDiagnostics(() => { if (fault === 'sink') throw Error('PRIVATE'); },
    () => { if (fault === 'clock') throw Error('PRIVATE'); return 0; });
  if (fault === 'start') diagnostics.start = () => { throw Error('PRIVATE'); };
  assert.doesNotThrow(() => {
    const observation = observeSessionState(new AbortController().signal, diagnostics);
    observation.stage(2); observation.changed(); observation.finish(false); observation.finish(true);
  });
});

test('connector-users fan-in observation logs once while pending and never claims SQL settlement', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const rows: any[] = [], diagnostics = new PerformanceDiagnostics(line => rows.push(JSON.parse(line)), () => 0);
  const observation = observeHubAggregation('hub-connector-users-read', new AbortController().signal, diagnostics);
  observation.stage(2); t.mock.timers.tick(1_000); t.mock.timers.tick(60_000);
  assert.equal(rows.length, 1); assert.equal(rows[0].operation, 'hub-connector-users-read');
  assert.equal(rows[0].step, 2); assert.equal(rows[0].phase, 'pending');
  assert.equal(rows[0].settled, undefined); assert.equal(rows[0].unknown, undefined);
  observation.stage(5); observation.finish(true, 4);
  assert.equal(rows.length, 2); assert.equal(rows[1].sequence, rows[0].sequence);
  assert.equal(rows[1].operation, 'hub-connector-users-read'); assert.equal(rows[1].records, 4);
  assert.equal(rows[1].phase, 'finished'); assert.equal(rows[1].settled, undefined);
});

test('aggregate admission diagnostics retain capacity at refusal and cannot assert execution settlement', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const rows: any[] = [], diagnostics = new PerformanceDiagnostics(line => rows.push(JSON.parse(line)), () => 0);
  const observation = observeSessionState(new AbortController().signal, diagnostics);
  observation.admission(8, false); observation.finish(false); t.mock.timers.tick(60_000);
  assert.equal(rows.length, 1); assert.equal(rows[0].pending, 8); assert.equal(rows[0].admitted, 0);
  assert.equal(rows[0].deferred, 1); assert.equal(rows[0].step, 1);
  assert.equal(rows[0].settled, undefined); assert.equal(rows[0].unknown, undefined);
  assert.equal(rows[0].records, 0);
  observation.admission(0, true); observation.finish(true, 99);
  assert.equal(rows.length, 1);
});

test('aggregate admission pending and final samples share a trace and do not release any resource', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const rows: any[] = [], diagnostics = new PerformanceDiagnostics(line => rows.push(JSON.parse(line)), () => 0);
  const observation = observeSessionState(new AbortController().signal, diagnostics);
  observation.admission(7, true); observation.stage(3); t.mock.timers.tick(1_000);
  assert.equal(rows.length, 1); assert.equal(rows[0].admitted, 1); assert.equal(rows[0].pending, 1);
  observation.finish(true, 11);
  assert.equal(rows.length, 2); assert.equal(rows[1].sequence, rows[0].sequence);
  assert.equal(rows[1].admitted, 1); assert.equal(rows[1].pending, 7);
  assert.equal(rows[1].records, 11); assert.equal(rows[1].settled, undefined);
});

test('aggregate admission diagnostic mutations are best effort even when the trace rejects counters', () => {
  const diagnostics = new PerformanceDiagnostics(() => {}, () => 0);
  const start = diagnostics.start.bind(diagnostics);
  diagnostics.start = operation => {
    const trace = start(operation);
    trace.add = () => { throw Error('PRIVATE diagnostic failure'); };
    return trace;
  };
  const observation = observeSessionState(new AbortController().signal, diagnostics);
  assert.doesNotThrow(() => { observation.admission(8, false); observation.finish(false); });
});
