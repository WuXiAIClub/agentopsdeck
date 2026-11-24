import assert from 'node:assert/strict';
import test from 'node:test';
import { PerformanceDiagnostics } from './performance.js';

for (const sinkFails of [false, true]) test(`Codex display lifecycle survives routine saturation; broken sink=${sinkFails}`, () => {
  const rows: any[] = [];
  const diagnostics = new PerformanceDiagnostics(line => {
    if (sinkFails) throw Error('private display sink');
    rows.push(JSON.parse(line));
  }, () => 0);
  for (let i = 0; i < 100; i++) diagnostics.start('connector-sqlite-command').finish();
  const open = diagnostics.start('codex-projection'); open.add('step', 1); open.add('settled', 1); open.finish();
  const close = diagnostics.start('codex-projection'); close.add('step', 6);
  close.reportPending({ pending: 1 }); close.add('settled', 1); close.finish();
  const events = diagnostics.snapshot().events.filter(row => row.operation === 'codex-projection');
  assert.equal(events.length, 3);
  assert.deepEqual(events.map(row => row.phase), ['finished', 'pending', 'finished']);
  assert.ok(events.every(row => row.delivery === (sinkFails ? 'failed' : 'delivered')));
  assert.equal(rows.filter(row => row.operation === 'codex-projection').length, sinkFails ? 0 : 3);
  for (let i = 0; i < 200; i++) {
    const failure = diagnostics.start('codex-projection'); failure.add('step', 2); failure.finish(true);
  }
  assert.equal(diagnostics.snapshot().events.length, 128);
  assert.ok(diagnostics.snapshot().events.some(row => row.delivery === 'rate-limited'));
  assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), /private display sink/);
});

for (const operation of ['hermes-execution-protection', 'hermes-runtime-close', 'hermes-session-deletion'] as const)
test(`${operation} retains bounded lifecycle evidence despite routine traffic and broken sink`, () => {
  for (const sinkFails of [false, true]) {
    const rows: string[] = [];
    const d = new PerformanceDiagnostics(line => { if (sinkFails) throw Error('PRIVATE'); rows.push(line); }, () => 0);
    for (let i = 0; i < 100; i++) d.start('storage-admission').finish();
    const trace = d.start(operation); trace.add('settled', 1); trace.add('unknown', 1); trace.finish();
    const events = d.snapshot().events.filter(e => e.operation === operation);
    assert.equal(events.length, 1); assert.equal(events[0]!.settled, 1);
    assert.equal(events[0]!.delivery, sinkFails ? 'failed' : 'delivered');
    assert.equal(rows.filter(row => JSON.parse(row).operation === operation).length, sinkFails ? 0 : 1);
    for (let i = 0; i < 200; i++) d.start(operation).finish();
    assert.equal(d.snapshot().events.length, 128);
    assert.doesNotMatch(JSON.stringify(d.snapshot()), /PRIVATE/);
  }
});

for (const operation of ['hub-user-change', 'hub-connector-user-change', 'hub-connector-user-http', 'hub-connection-mutation'] as const)
test(`${operation} HTTP pending and unknown evidence survives routine and unrelated failure saturation`, () => {
  for (const sinkFails of [false, true]) {
    const rows: any[] = [];
    const diagnostics = new PerformanceDiagnostics(line => {
      if (sinkFails) throw Error('PRIVATE user HTTP sink');
      rows.push(JSON.parse(line));
    }, () => 0);
    for (let i = 0; i < 100; i++) {
      diagnostics.start('storage-admission').finish();
      diagnostics.start('storage-admission').finish(true);
    }
    const trace = diagnostics.start(operation);
    trace.reportPending({ step: 4, pending: 1 });
    trace.add('step', 4); trace.add('unknown', 1); trace.finish(true);
    const events = diagnostics.snapshot().events.filter(row => row.operation === operation);
    assert.equal(events.length, 2);
    assert.equal(events[0]!.phase, 'pending'); assert.equal(events[0]!.pending, 1);
    assert.equal(events[1]!.unknown, 1);
    assert.ok(events.every(row => row.delivery === (sinkFails ? 'failed' : 'delivered')));
    assert.equal(rows.filter(row => row.operation === operation).length, sinkFails ? 0 : 2);
    assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), /PRIVATE user HTTP sink/);
  }
});

for (const sinkFails of [false, true]) {
  test(`Hub member pending/failure reserves evidence independently of ordinary traffic, sink failure=${sinkFails}`, () => {
    const rows: any[] = [];
    const diagnostics = new PerformanceDiagnostics(line => {
      if (sinkFails) throw Error('private-member-sink');
      rows.push(JSON.parse(line));
    }, () => 0);
    for (let i = 0; i < 100; i++) diagnostics.start('storage-admission').finish(true);
    for (let i = 0; i < 65; i++) {
      const command = diagnostics.start('hub-member-sqlite-command');
      command.add('step', 2); command.add('admitted', 1); command.reportPending({ pending: 1 });
      command.add('unknown', 1); command.finish(true);
    }
    const events = diagnostics.snapshot().events.filter(e => e.operation === 'hub-member-sqlite-command');
    assert.equal(events.length, 128);
    assert.ok(events.some(e => e.phase === 'pending' && e.pending === 1));
    assert.ok(events.some(e => e.phase === 'finished' && e.unknown === 1));
    assert.equal(rows.filter(e => e.operation === 'hub-member-sqlite-command').length, sinkFails ? 0 : 60);
    const owner = diagnostics.start('hub-member-sqlite-owner'); owner.add('step', 5); owner.finish(true);
    assert.equal(diagnostics.snapshot().events.at(-1)?.delivery, sinkFails ? 'failed' : 'delivered');
    assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), /private-member-sink/);
  });
}

for (const sinkFails of [false, true]) {
  test(`Hub connection settlement evidence survives routine saturation and sink failure=${sinkFails}`, () => {
    const rows: any[] = [];
    const d = new PerformanceDiagnostics(line => { if (sinkFails) throw Error('synthetic-private-sink-error'); rows.push(JSON.parse(line)); }, () => 0);
    for (let i = 0; i < 100; i++) d.start('storage-admission').finish();
    for (let i = 0; i < 65; i++) {
      const trace = d.start('hub-connection-change');
      trace.add('nested', 0); trace.add('settled', 1); trace.add('commitMs', 1); trace.finish();
    }
    const failed = d.start('hub-connection-change');
    failed.add('step', 3); failed.add('unknown', 1); failed.finish(true);
    const events = d.snapshot().events.filter(row => row.operation === 'hub-connection-change');
    assert.equal(events.length, 66);
    assert.equal(events.filter(row => row.delivery === 'rate-limited').length, 45);
    assert.equal(events.filter(row => row.delivery === (sinkFails ? 'failed' : 'delivered')).length, 21);
    assert.ok(events.slice(0, 65).every(row => row.settled === 1 && row.nested === 0 && row.commitMs === 1));
    assert.equal(events.at(-1)!.unknown, 1);
    assert.doesNotMatch(JSON.stringify(events), /synthetic-private-sink-error/);
    if (!sinkFails) assert.equal(rows.filter(row => row.operation === 'hub-connection-change').length, 21);
  });
}

test('Codex interrupt observation retains bounded ACK/cleanup evidence despite routine saturation and sink failure', () => {
  for (const sinkFails of [false, true]) {
    const rows: any[] = [];
    const d = new PerformanceDiagnostics(line => { if (sinkFails) throw Error('private sink'); rows.push(JSON.parse(line)); }, () => 0);
    for (let i = 0; i < 100; i++) d.start('storage-admission').finish(true);
    for (let i = 0; i < 65; i++) {
      const trace = d.start('codex-interrupt-observation');
      trace.add('step', 6); trace.add('admitted', 1); trace.add('unknown', 1); trace.finish(true);
    }
    const events = d.snapshot().events.filter(row => row.operation === 'codex-interrupt-observation');
    assert.equal(events.length, 65);
    assert.equal(events.filter(row => row.delivery === 'rate-limited').length, 5);
    assert.equal(events.filter(row => row.delivery === (sinkFails ? 'failed' : 'delivered')).length, 60);
    assert.ok(events.every(row => row.step === 6 && row.admitted === 1 && row.unknown === 1));
    assert.doesNotMatch(JSON.stringify(events), /private sink/);
    d.start('process-shutdown').finish(true);
    if (!sinkFails) assert.equal(rows.at(-1).operation, 'process-shutdown');
  }
});
test('quick chat UNKNOWN remains queryable without routine traffic replacing recovery evidence', () => {
  for (const sinkFails of [false, true]) {
    const d = new PerformanceDiagnostics(() => { if (sinkFails) throw Error('private sink'); }, () => 0);
    const unresolved = d.start('hub-quick-chat');
    unresolved.add('step', 3); unresolved.add('unknown', 1); unresolved.finish();
    for (let i = 0; i < 200; i++) d.start('hub-quick-chat').finish();
    const events = d.snapshot().events.filter(e => e.operation === 'hub-quick-chat');
    assert.equal(events.length, 1);
    assert.equal(events[0]!.unknown, 1);
    assert.equal(events[0]!.delivery, sinkFails ? 'failed' : 'delivered');
    assert.doesNotMatch(JSON.stringify(events), /private sink/);
  }
});

test('quick chat drain logs retain a fixed bounded reserve after ordinary saturation', () => {
  const lines: string[] = [];
  const d = new PerformanceDiagnostics(line => lines.push(line), () => 1);
  for (let i = 0; i < 200; i++) {
    d.start('hub-quick-chat').finish();
    d.start('hub-quick-chat').finish(true);
  }
  const before = lines.length;
  const drain = d.start('hub-quick-chat'); drain.add('step', 17);
  drain.reportPending({ pending: 1, unknown: 1 });
  drain.add('settled', 1); drain.finish();
  assert.equal(lines.length, before + 2);
  const lifecycle = lines.slice(before).map(line => JSON.parse(line));
  assert.equal(lifecycle[0].phase, 'pending');
  assert.equal(lifecycle[0].unknown, 1);
  assert.equal(lifecycle[1].phase, 'finished');
  assert.equal(lifecycle[1].settled, 1);
  for (let i = 0; i < 200; i++) {
    const trace = d.start('hub-quick-chat'); trace.add('step', 17); trace.finish();
  }
  assert.equal(lines.length - before, 21); // 1 pending + 20 routine, globally bounded.
  const shutdown = d.start('process-shutdown'); shutdown.finish();
  assert.equal(lines.length - before, 22);
});

test('quick chat original drain acknowledgement survives routine polling and a failing sink', () => {
  for (const sinkFails of [false, true]) {
    const d = new PerformanceDiagnostics(() => { if (sinkFails) throw Error('private sink'); }, () => 0);
    const drain = d.start('hub-quick-chat');
    drain.add('step', 17); drain.add('settled', 1); drain.finish(); drain.finish();
    for (let i = 0; i < 200; i++) d.start('hub-quick-chat').finish();
    const events = d.snapshot().events.filter(e => e.operation === 'hub-quick-chat');
    assert.equal(events.length, 1);
    assert.equal(events[0]!.step, 17); assert.equal(events[0]!.settled, 1);
    assert.equal(events[0]!.delivery, sinkFails ? 'failed' : 'delivered');
    assert.doesNotMatch(JSON.stringify(events), /private sink/);
  }
});

test('allowlisted numeric metrics, no arbitrary fields, monotonic timings and exactly one finish', () => {
  let now = 0; const lines: string[] = [];
  const d = new PerformanceDiagnostics(line => lines.push(line), () => now);
  const t = d.start('rollout-read');
  t.add('sourceBytes', 1024); t.add('sourceBytes', 512);
  t.add('records', NaN); t.add('prefixBytes', -1);
  t.add('/private/path secret message' as any, 42);
  now = 251; t.finish(); t.finish(); t.add('records', 1);
  assert.equal(lines.length, 1);
  const row = JSON.parse(lines[0]!);
  assert.equal(row.sourceBytes, 1536); assert.equal(row.elapsedMs, 251); assert.equal(row.category, 'slow');
  assert.equal(row.records, undefined); assert.equal(row.prefixBytes, undefined);
  assert.doesNotMatch(lines[0]!, /private|secret|message/);
  const bad = d.start('private-path' as any); bad.finish(); assert.equal(lines.length, 1);
});

test('process-wide independent bounded budgets report suppression after rollover', () => {
  let now = 0; const rows: any[] = [];
  const d = new PerformanceDiagnostics(line => rows.push(JSON.parse(line)), () => now);
  for (let i = 0; i < 25; i++) d.start('rollout-read').finish();
  assert.equal(rows.length, 20);
  for (let i = 0; i < 63; i++) { const t = d.start('storage-admission'); now += 50; t.finish(); }
  assert.equal(rows.length, 80);
  for (let i = 0; i < 62; i++) d.start('storage-admission').finish(true);
  assert.equal(rows.length, 140);
  now += 60_000;
  d.start('rollout-read').finish(); assert.equal(rows.at(-1).suppressed, 5);
  let t = d.start('storage-admission'); now += 50; t.finish(); assert.equal(rows.at(-1).suppressed, 3);
  d.start('storage-admission').finish(true); assert.equal(rows.at(-1).suppressed, 2);
});

test('sink and clock exceptions cannot replace original operation outcome', () => {
  const broken = new PerformanceDiagnostics(() => { throw Error('sink'); });
  assert.doesNotThrow(() => broken.start('storage-admission').finish(true));
  const clock = new PerformanceDiagnostics(() => {}, () => { throw Error('clock'); });
  assert.doesNotThrow(() => clock.start('rollout-read').finish());
});

test('bounded process closure evidence survives ordinary drain and transaction traffic', () => {
  let now = 0; const rows: any[] = [];
  const d = new PerformanceDiagnostics(line => rows.push(JSON.parse(line)), () => now);
  for (let i = 0; i < 100; i++) d.start('application-drain').finish();
  for (let i = 0; i < 100; i++) d.start('storage-admission').finish(true);
  d.start('process-startup').finish(true);
  d.start('process-shutdown').finish();
  assert.equal(rows.filter(row => row.operation === 'process-startup').length, 1);
  assert.equal(rows.filter(row => row.operation === 'process-shutdown').length, 1);
  for (let i = 0; i < 100; i++) d.start('process-shutdown').finish();
  assert.equal(rows.filter(row => row.operation === 'process-shutdown').length, 20,
    'critical evidence still has a fixed rate bound, not an unrestricted bypass');
  now = 60_000;
  d.start('process-shutdown').finish();
  assert.equal(rows.at(-1).suppressed, 81);
});

test('auth reader lifecycle has a bounded reserve independent of display polling and process closure', () => {
  let now = 0; const rows: any[] = [];
  const d = new PerformanceDiagnostics(line => rows.push(JSON.parse(line)), () => now);
  for (let i = 0; i < 100; i++) {
    d.start('storage-admission').finish();
    const poll = d.start('auth-display-read'); poll.add('step', i % 2 + 1); poll.finish();
  }
  for (let i = 0; i < 25; i++) {
    const lifecycle = d.start('auth-display-read'); lifecycle.add('step', i % 2 + 3);
    lifecycle.add(i % 2 ? 'recovered' : 'settled', 1); lifecycle.finish();
  }
  assert.equal(rows.filter(row => row.operation === 'auth-display-read' && (row.step === 3 || row.step === 4)).length, 20);
  const events = d.snapshot().events;
  assert.equal(events.length, 25);
  assert.equal(events.filter(event => event.delivery === 'rate-limited').length, 5);
  assert.ok(events.every(event => event.step === 3 || event.step === 4));
  d.start('process-shutdown').finish();
  assert.equal(rows.at(-1).operation, 'process-shutdown');
  now = 60_000;
  const close = d.start('auth-display-read'); close.add('step', 3); close.finish();
  assert.equal(rows.at(-1).suppressed, 5);
  assert.equal(rows.at(-1).step, 3);
});

test('auth reader lifecycle evidence is bounded and retained even when the output sink fails', () => {
  const d = new PerformanceDiagnostics(() => { throw Error('private-sink'); }, () => 0);
  for (let i = 0; i < 200; i++) {
    const lifecycle = d.start('auth-display-read'); lifecycle.add('step', 3); lifecycle.add('settled', 1);
    assert.doesNotThrow(() => lifecycle.finish());
  }
  const snapshot = d.snapshot();
  assert.equal(snapshot.events.length, snapshot.capacity);
  assert.equal(snapshot.totals.sinkFailures, 20);
  assert.equal(snapshot.totals.suppressed, 180);
  assert.ok(snapshot.events.every(event => event.delivery === 'rate-limited' && event.settled === 1));
  assert.doesNotMatch(JSON.stringify(snapshot), /private-sink/);
});

test('readonly retirement, actual exit and stop refusal share a bounded lifecycle reserve', () => {
  const rows: any[] = [];
  const d = new PerformanceDiagnostics(line => rows.push(JSON.parse(line)), () => 0);
  for (let i = 0; i < 100; i++) d.start('storage-admission').finish(true);
  for (let i = 0; i < 200; i++) {
    const trace = d.start(i % 2 ? 'auth-display-read' : 'hub-delivery-read');
    trace.add('step', 6 + i % 3); trace.add('ownerFailureCode', i % 3 ? 9 : 2); trace.finish(true);
  }
  assert.equal(rows.filter(row => row.step >= 6).length, 60);
  const snapshot = d.snapshot();
  assert.equal(snapshot.events.length, snapshot.capacity);
  assert.ok(snapshot.events.every(row => row.step! >= 6 && row.delivery === 'rate-limited'));
  d.start('process-shutdown').finish(true);
  assert.equal(rows.at(-1).operation, 'process-shutdown');
});

test('original auth SQL failures share the bounded database lifecycle reserve, not ordinary failure traffic', () => {
  let now = 0; const rows: any[] = [];
  const d = new PerformanceDiagnostics(line => rows.push(JSON.parse(line)), () => now);
  for (let i = 0; i < 100; i++) d.start('storage-admission').finish(true);
  const operations = ['auth-sqlite-owner-failure', 'maintenance-sql-owner-failure', 'readonly-sql-owner-failure'] as const;
  for (let i = 0; i < 65; i++) {
    const trace = d.start(operations[i % operations.length]!);
    trace.add('step', 7); trace.add('sqlErrorCode', 1811); trace.finish(true);
  }
  const ownerRows = rows.filter(row => operations.includes(row.operation));
  assert.equal(ownerRows.length, 60, 'one shared bounded reserve, not one bypass per owner');
  assert.equal(ownerRows.filter(row => row.operation === 'auth-sqlite-owner-failure').length, 20);
  assert.equal(d.snapshot().events.filter(row => row.operation === 'auth-sqlite-owner-failure').at(-1)?.delivery, 'rate-limited');
  d.start('process-shutdown').finish(true);
  assert.equal(rows.at(-1).operation, 'process-shutdown', 'SQL failure traffic cannot consume final process closure evidence');
  now = 60_000;
  const recovered = d.start('auth-sqlite-owner-failure'); recovered.add('step', 7); recovered.finish(true);
  assert.equal(rows.at(-1).operation, 'auth-sqlite-owner-failure');
  assert.equal(rows.at(-1).suppressed, 5);
});

test('original auth SQL failure reserve still retains numeric evidence when its sink fails', () => {
  const d = new PerformanceDiagnostics(() => { throw Error('private-sink'); }, () => 0);
  for (let i = 0; i < 60; i++) d.start('storage-admission').finish(true);
  const trace = d.start('auth-sqlite-owner-failure'); trace.add('step', 7); trace.add('sqlErrorCode', 1811);
  assert.doesNotThrow(() => trace.finish(true));
  const row = d.snapshot().events.at(-1)!;
  assert.equal(row.operation, 'auth-sqlite-owner-failure'); assert.equal(row.delivery, 'failed');
  assert.equal(row.sqlErrorCode, 1811); assert.doesNotMatch(JSON.stringify(row), /private-sink/);
});

test('auth and Hub readonly lifecycle share one bounded reserve independent of replay polling', () => {
  let now = 0; const rows: any[] = [];
  const d = new PerformanceDiagnostics(line => rows.push(JSON.parse(line)), () => now);
  for (let n = 0; n < 100; n++) {
    const read = d.start('hub-delivery-read'); read.add('step', 1); read.finish();
  }
  for (let n = 0; n < 25; n++) {
    const lifecycle = d.start(n % 2 ? 'auth-display-read' : 'hub-delivery-read');
    lifecycle.add('step', n % 2 ? 4 : 3); lifecycle.add(n % 2 ? 'recovered' : 'settled', 1); lifecycle.finish();
  }
  const lifecycleRows = rows.filter(row => row.step === 3 || row.step === 4);
  assert.equal(lifecycleRows.length, 20);
  assert.equal(lifecycleRows.filter(row => row.operation === 'hub-delivery-read').length, 10);
  assert.equal(d.snapshot().events.filter(row => row.delivery === 'rate-limited').length, 5);
  d.start('process-shutdown').finish(); assert.equal(rows.at(-1).operation, 'process-shutdown');
  now = 60_000;
  const close = d.start('hub-delivery-read'); close.add('step', 3); close.finish();
  assert.equal(rows.at(-1).suppressed, 5);
});

test('pending reports correlate with completion without completing or contaminating its counters', () => {
  let now = 0; const rows: any[] = [];
  const d = new PerformanceDiagnostics(line => rows.push(JSON.parse(line)), () => now);
  const t = d.start('shutdown-cleanup'); t.add('settled', 1);
  now = 30_000;
  t.reportPending({ pending: 2, settled: 4, step: 2,
    'private/path credential' : 4, unknown: NaN, busy: -1 } as any);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].phase, 'pending'); assert.equal(rows[0].category, 'failed');
  assert.equal(rows[0].pending, 2); assert.equal(rows[0].settled, 4); assert.equal(rows[0].step, 2);
  assert.equal(rows[0].elapsedMs, 30_000);
  t.add('settled', 2); now = 30_500; t.finish();
  assert.equal(rows.length, 2); assert.equal(rows[1].phase, 'finished'); assert.equal(rows[1].settled, 3);
  assert.equal(rows[1].pending, undefined); assert.equal(rows[1].step, undefined);
  assert.equal(rows[0].sequence, rows[1].sequence); assert.equal(rows[0].instance, rows[1].instance);
  t.reportPending({ pending: 99 }); t.finish(true); assert.equal(rows.length, 2);
  assert.doesNotMatch(JSON.stringify(rows), /private|credential|NaN|busy/);
});

test('pending observations have bounded exceptional budgets independent of routine traffic', () => {
  let now = 0; const rows: any[] = [];
  const d = new PerformanceDiagnostics(line => rows.push(JSON.parse(line)), () => now);
  for (let i = 0; i < 100; i++) d.start('rollout-read').finish();
  const trace = d.start('shutdown-drain');
  for (let i = 0; i < 100; i++) trace.reportPending({ pending: 1 });
  assert.equal(rows.length, 80);
  now = 60_000; trace.reportPending({ pending: 1 });
  assert.equal(rows.length, 81); assert.equal(rows.at(-1).suppressed, 40);
  trace.finish(); assert.equal(rows.at(-1).phase, 'finished');
});

test('pending diagnostic failures cannot end a trace or prevent its eventual completion', () => {
  let sinkCalls = 0;
  const d = new PerformanceDiagnostics(() => { sinkCalls++; throw Error('private-sink'); });
  const trace = d.start('shutdown-drain');
  assert.doesNotThrow(() => trace.reportPending({ pending: 1 }));
  assert.doesNotThrow(() => trace.finish()); assert.equal(sinkCalls, 2);
  const clock = new PerformanceDiagnostics(() => {}, () => { throw Error('private-clock'); });
  assert.doesNotThrow(() => clock.start('shutdown-drain').reportPending({ pending: 1 }));
});

test('coordinator failure, recovery and refused stop survive ordinary polling saturation', () => {
  const rows: any[] = [];
  const diagnostics = new PerformanceDiagnostics(line => rows.push(JSON.parse(line)), () => 0);
  for (let i = 0; i < 100; i++) diagnostics.start('storage-admission').finish();
  for (let i = 0; i < 100; i++) diagnostics.start('storage-admission').finish(true);
  for (const [step, failed] of [[1, true], [1, false], [5, true]] as const) {
    const trace = diagnostics.start('storage-coordinator-recovery');
    trace.add('step', step); trace.add(failed ? 'unknown' : 'recovered', 1); trace.finish(failed);
  }
  assert.equal(rows.filter(row => row.operation === 'storage-coordinator-recovery').length, 3);
});

test('coordinator lifecycle shares a bounded reserve and cannot hide process closure', () => {
  const rows: any[] = [];
  const diagnostics = new PerformanceDiagnostics(line => rows.push(JSON.parse(line)), () => 0);
  for (let i = 0; i < 200; i++) {
    const trace = diagnostics.start('storage-coordinator-recovery');
    trace.add('step', 5); trace.add('unknown', 1); trace.finish(true);
  }
  assert.equal(rows.length, 60);
  const snapshot = diagnostics.snapshot();
  assert.equal(snapshot.events.length, snapshot.capacity);
  assert.equal(snapshot.totals.suppressed, 140);
  assert.ok(snapshot.events.every(row => row.delivery === 'rate-limited'));
  diagnostics.start('process-shutdown').finish(true);
  assert.equal(rows.at(-1).operation, 'process-shutdown');
});

test('diagnostic clock reentry cannot recursively measure the same observer', () => {
  let calls = 0;
  const lines: string[] = [];
  let diagnostics: PerformanceDiagnostics;
  diagnostics = new PerformanceDiagnostics(line => lines.push(line), () => {
    calls++;
    // Bound the failing original implementation without consuming the stack.
    if (calls <= 4) diagnostics.start('storage-admission').finish(true);
    return 100;
  });
  const trace = diagnostics.start('auth-sqlite-owner');
  trace.add('step', 7); trace.add('deferred', 1); trace.finish(true);
  assert.equal(calls, 2);
  const original = lines.map(line => JSON.parse(line)).filter(line => line.operation === 'auth-sqlite-owner');
  assert.equal(original.length, 1);
  assert.equal(original[0].deferred, 1);
  assert.equal(original[0].unknown, undefined);
});

test('a throwing clock restores its observation fence and never publishes a fabricated time', () => {
  let calls = 0, throws = true;
  const lines: string[] = [];
  let diagnostics: PerformanceDiagnostics;
  diagnostics = new PerformanceDiagnostics(line => lines.push(line), () => {
    calls++;
    if (calls <= 4) diagnostics.start('storage-admission').finish(true);
    if (throws) throw Error('private-clock-error');
    return 200;
  });
  diagnostics.start('auth-sqlite-owner').finish(true);
  assert.equal(calls, 2);
  assert.equal(lines.length, 0);
  throws = false;
  diagnostics.start('auth-sqlite-owner').finish(true);
  assert.equal(calls, 4);
  assert.equal(lines.length, 1);
  const line = lines[0];
  assert.ok(line);
  assert.doesNotMatch(line, /private-clock-error/);
});

test('a failed start clock cannot fabricate a duration when the clock later recovers', () => {
  let calls = 0;
  const lines: string[] = [];
  const diagnostics = new PerformanceDiagnostics(line => lines.push(line), () => {
    if (++calls === 1) throw Error('private-clock-start-error');
    return 200;
  });
  diagnostics.start('auth-sqlite-owner').finish(true);
  assert.equal(calls, 2);
  assert.equal(lines.length, 0);
  assert.equal(diagnostics.snapshot().totals.observations, 0);
  diagnostics.start('auth-sqlite-owner').finish(true);
  assert.equal(lines.length, 1);
  const line = lines[0];
  assert.ok(line);
  assert.equal(JSON.parse(line).elapsedMs, 0);
  assert.doesNotMatch(line, /private-clock-start-error/);
});

for (const operation of ['session-read-request', 'codex-native-effect', 'codex-dispatch',
  'combined-application-layer', 'connector-runtime-assembly'] as const)
for (const sinkFails of [false, true]) test(`${operation} recovery evidence survives saturation; sink failure=${sinkFails}`, () => {
  const rows: any[] = [];
  const diagnostics = new PerformanceDiagnostics(line => {
    if (sinkFails) throw Error('PRIVATE SQL session-read sink');
    rows.push(JSON.parse(line));
  }, () => 0);
  for (let index = 0; index < 100; index++) {
    diagnostics.start('storage-admission').finish();
    diagnostics.start('storage-admission').finish(true);
  }
  const trace = diagnostics.start(operation);
  trace.reportPending({ step: 98, pending: 1 });
  trace.add('timedOut', 1); trace.add('pending', 1); trace.add('startupStage', 9); trace.finish(true);
  const events = diagnostics.snapshot().events.filter(row => row.operation === operation);
  assert.equal(events.length, 2); assert.equal(events[0]!.phase, 'pending');
  assert.equal(events[0]!.step, 98); assert.equal(events[1]!.timedOut, 1);
  assert.equal(events[1]!.startupStage, 9);
  assert.ok(events.every(row => row.pending === 1 && row.delivery === (sinkFails ? 'failed' : 'delivered')));
  assert.equal(rows.filter(row => row.operation === operation).length, sinkFails ? 0 : 2);
  assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), /PRIVATE|SQL|Bearer/);
});
