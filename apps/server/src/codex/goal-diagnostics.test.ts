import assert from 'node:assert/strict';
import test from 'node:test';
import { GoalDiagnostics } from './goal-diagnostics.js';

test('Goal diagnostics allowlist fields and correlate without recording supplied text', () => {
  const lines: string[] = [];
  const diagnostics = new GoalDiagnostics(line => lines.push(line), () => 100);
  const trace = diagnostics.trace('private-session-title', 'private-connection', 'pause');
  trace('dispatch_started', { rpcId: 42, version: 3, objective: 'SECRET', error: 'SECRET', currentVersion: -1 } as any);
  trace('ack_persisted');
  trace('SECRET' as any);
  const [start, end] = lines.map(line => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.equal(start.operation, end.operation);
  assert.equal(start.instance, end.instance);
  assert.equal(start.rpcId, 42);
  assert.equal(start.version, 3);
  assert.equal(start.currentVersion, undefined);
  assert.ok(!lines.join('').includes('SECRET'));
  assert.ok(!lines.join('').includes('private-'));
  assert.deepEqual(Object.keys(start).sort(), ['component', 'instance', 'operation', 'session', 'connection', 'action', 'event', 'elapsedMs', 'rpcId', 'version', 'suppressed'].sort());
  diagnostics.trace('private-session-title', 'other-connection', 'SECRET')('change_started');
  const other = JSON.parse(lines[2]!);
  assert.equal(other.action, 'invalid');
  assert.equal(other.session, start.session);
  assert.notEqual(other.connection, start.connection);
  assert.notEqual(other.operation, start.operation);
});

test('Goal diagnostics use bounded independent read/control/fault budgets with suppressed counts', () => {
  const lines: string[] = []; let now = 1;
  const diagnostics = new GoalDiagnostics(line => lines.push(line), () => now);
  const trace = diagnostics.trace('session', 'connection', 'read');
  for (let i = 0; i < 1000; i++) trace('read_joined');
  assert.equal(lines.length, 20);
  for (let i = 0; i < 125; i++) trace('write_timeout');
  assert.equal(lines.length, 140);
  now += 60_000;
  trace('read_completed'); trace('ack_persisted');
  assert.equal(JSON.parse(lines[140]!).suppressed, 980);
  assert.equal(JSON.parse(lines[141]!).suppressed, 0);
  trace('write_timeout');
  assert.equal(JSON.parse(lines[142]!).suppressed, 5);
  trace('ack_persisted');
  assert.equal(JSON.parse(lines[143]!).suppressed, 0);
});

test('Goal diagnostics swallow sink failures and do not retry or schedule work', () => {
  let calls = 0;
  const diagnostics = new GoalDiagnostics(() => { calls++; throw new Error('secret sink failure'); });
  const trace = diagnostics.trace('session', undefined, 'clear');
  assert.doesNotThrow(() => { for (let i = 0; i < 1000; i++) trace('ack_persisted'); });
  assert.equal(calls, 120);
});

test('Goal trace creation survives a failed clock and later observations recover', () => {
  const lines: string[] = []; let calls = 0;
  const diagnostics = new GoalDiagnostics(line => lines.push(line), () => {
    if (++calls === 1) throw new Error('private-clock-failure');
    return 100;
  });
  let trace!: ReturnType<GoalDiagnostics['trace']>;
  assert.doesNotThrow(() => { trace = diagnostics.trace('session', undefined, 'recovery'); });
  assert.doesNotThrow(() => trace('owned_terminal_recovered'));
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]!).elapsedMs, 0);
  assert.ok(!lines[0]!.includes('private-clock'));
});

test('invalid Goal clocks neither publish null durations nor bypass observation budgets', () => {
  for (const bad of [NaN, Infinity, -Infinity]) {
    const lines: string[] = []; let now = bad;
    const diagnostics = new GoalDiagnostics(line => lines.push(line), () => now);
    const trace = diagnostics.trace('session', undefined, 'read');
    for (let i = 0; i < 1000; i++) trace('read_joined');
    assert.equal(lines.length, 0);
    now = 100;
    for (let i = 0; i < 1000; i++) trace('read_joined');
    assert.equal(lines.length, 20);
    assert.ok(lines.every(line => JSON.parse(line).elapsedMs === 0));
  }
});

test('Goal recovery diagnostics record bounded identity-only outcome evidence', () => {
  const lines: string[] = [];
  const diagnostics = new GoalDiagnostics(line => lines.push(line));
  diagnostics.trace('private-session', 'private-connection', 'recovery')('owned_terminal_recovered',
    { version: 5, objective: 'SECRET', runId: 'SECRET' } as any);
  const entry = JSON.parse(lines[0]!);
  assert.equal(entry.action, 'recovery');
  assert.equal(entry.event, 'owned_terminal_recovered');
  assert.equal(entry.version, 5);
  assert.ok(!lines[0]!.includes('SECRET'));
  assert.ok(!lines[0]!.includes('private-'));
});

test('cold terminal recovery logs load separately from verified completion without payloads', () => {
  const lines: string[] = [];
  const diagnostics = new GoalDiagnostics(line => lines.push(line));
  const trace = diagnostics.trace('private-session', 'private-connection', 'recovery');
  trace('terminal_load_started', { version: 1, error: 'SECRET' } as any);
  trace('terminal_load_completed', { version: 2, objective: 'SECRET' } as any);
  trace('terminal_recovery_failed', { version: 2, error: 'SECRET' } as any);
  assert.deepEqual(lines.map(line => JSON.parse(line).event), ['terminal_load_started', 'terminal_load_completed', 'terminal_recovery_failed']);
  assert.equal(JSON.parse(lines[0]!).operation, JSON.parse(lines[1]!).operation);
  assert.ok(!lines.join('').includes('SECRET'));
  assert.ok(!lines.join('').includes('private-'));
});

test('readable old terminal logs retained protection separately from execution completion', () => {
  const lines: string[] = [];
  const diagnostics = new GoalDiagnostics(line => lines.push(line));
  diagnostics.trace('private-session', 'private-connection', 'recovery')('terminal_history_readable_protected',
    { version: 7, objective: 'SECRET', runId: 'SECRET' } as any);
  const entry = JSON.parse(lines[0]!);
  assert.equal(entry.event, 'terminal_history_readable_protected');
  assert.equal(entry.action, 'recovery');
  assert.equal(entry.version, 7);
  assert.ok(!lines[0]!.includes('SECRET'));
  assert.ok(!lines[0]!.includes('private-'));
});

test('terminal readability during successor activity has a distinct bounded diagnostic', () => {
  const lines: string[] = [];
  const diagnostics = new GoalDiagnostics(line => lines.push(line));
  diagnostics.trace('private-session', 'private-connection', 'recovery')('terminal_history_readable_during_activity',
    { version: 8, delta: 'SECRET', runId: 'SECRET' } as any);
  assert.equal(JSON.parse(lines[0]!).event, 'terminal_history_readable_during_activity');
  assert.equal(JSON.parse(lines[0]!).version, 8);
  assert.ok(!lines[0]!.includes('SECRET'));
  assert.ok(!lines[0]!.includes('private-'));
});

test('routine Goal control observations cannot consume the recovery fault reserve', () => {
  const lines: string[] = []; let now = 1;
  const diagnostics = new GoalDiagnostics(line => lines.push(line), () => now);
  const trace = diagnostics.trace('private-session', 'private-connection', 'recovery');
  for (let i = 0; i < 1000; i++) trace('terminal_history_readable_during_activity');
  assert.equal(lines.length, 120);
  trace('outcome_unknown'); trace('ack_connection_lost'); trace('terminal_recovery_failed');
  assert.deepEqual(lines.slice(120).map(line => JSON.parse(line).event),
    ['outcome_unknown', 'ack_connection_lost', 'terminal_recovery_failed']);
  assert.ok(lines.slice(120).every(line => JSON.parse(line).suppressed === 0));
  now += 60_000; trace('terminal_history_readable_protected');
  assert.equal(JSON.parse(lines.at(-1)!).suppressed, 880);
  assert.ok(!lines.join('').includes('private-'));
});

test('a reentrant diagnostic clock cannot recursively poll or amplify Goal observations', () => {
  const lines: string[] = []; let calls = 0;
  let diagnostics!: GoalDiagnostics;
  diagnostics = new GoalDiagnostics(line => lines.push(line), () => {
    calls++;
    // Bound the defective fixture itself so the old implementation terminates.
    if (calls < 10) diagnostics.trace('nested-private', undefined, 'read')('read_joined');
    return 100;
  });
  const trace = diagnostics.trace('private-session', undefined, 'pause');
  trace('dispatch_started');
  assert.equal(calls, 2);
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]!).event, 'dispatch_started');
  assert.ok(!lines[0]!.includes('private'));
});
