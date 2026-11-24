import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentRuntime } from '@agentopsdeck/shared';
import { RuntimeDiagnostics } from './runtime-diagnostics.js';

const base: AgentRuntime = { turnId: 'SECRET-TURN', phase: 'running', threadActivity: 'running',
  connection: 'connected', sync: 'current', lastEventAt: Date.now(), reason: 'SECRET-MESSAGE' };

test('runtime logs correlate allowlisted state transitions without supplied content or raw identities', () => {
  const lines: string[] = [];
  const diagnostic = new RuntimeDiagnostics(line => lines.push(line), () => 10);
  diagnostic.transition('SECRET-SESSION', 'SECRET-CONNECTION', base, { ...base, threadActivity: 'unknown',
    executionProtection: { state: 'blocked', nativeTurnId: 'SECRET-NATIVE', reason: 'SECRET-PROTECTION' } }, 'native-activity',
  { commandId: 'SECRET-COMMAND', runId: 'SECRET-OWNED', revision: 7 });
  const row = JSON.parse(lines[0]!);
  assert.equal(row.component, 'codex-runtime');
  assert.equal(row.source, 'native-activity');
  assert.equal(row.before.activity, 'running');
  assert.equal(row.after.activity, 'unknown');
  assert.equal(row.after.protection, 'blocked');
  assert.equal(row.after.protectionReason, 'unknown');
  assert.equal(row.revision, 7);
  for (const hash of [row.session, row.connection, row.command, row.ownedTurn, row.after.turn, row.after.nativeTurn]) {
    assert.match(hash, /^[a-f0-9]{16}$/);
  }
  assert.equal(lines.join('').includes('SECRET'), false);
  assert.ok(row.eventAgeMs >= 0);
});

test('timestamp and text-only publications produce no logs, while recovery and successor identity changes do', () => {
  const lines: string[] = [];
  const diagnostic = new RuntimeDiagnostics(line => lines.push(line));
  diagnostic.transition('s', undefined, base, { ...base, lastEventAt: base.lastEventAt + 100, reason: 'different text' });
  assert.equal(lines.length, 0);
  const unknown = { ...base, phase: 'unknown' as const, threadActivity: 'unknown' as const, sync: 'error' as const };
  diagnostic.transition('s', 'c', base, unknown, 'final-history-error');
  diagnostic.transition('s', 'c', unknown, base, 'native-snapshot');
  diagnostic.transition('s', 'c', base, { ...base, turnId: 'successor' });
  assert.equal(lines.length, 3);
  const rows = lines.map(line => JSON.parse(line));
  assert.equal(rows[0].instance, rows[1].instance);
  assert.equal(rows[1].after.sync, 'current');
  assert.notEqual(rows[2].before.turn, rows[2].after.turn);
  assert.deepEqual(rows.map(row => row.sequence), [1, 2, 3]);
});

test('runtime logging is globally bounded and reports suppression on the next window', () => {
  let now = 0;
  const lines: string[] = [];
  const diagnostic = new RuntimeDiagnostics(line => lines.push(line), () => now);
  for (let i = 0; i < 125; i++) diagnostic.transition(`session-${i}`, 'c', base, { ...base, sync: 'error' });
  assert.equal(lines.length, 120);
  now = 60_000;
  diagnostic.transition('s', 'c', base, { ...base, sync: 'error' });
  assert.equal(JSON.parse(lines.at(-1)!).suppressed, 5);
  now = 1;
  diagnostic.transition('s', 'c', base, { ...base, sync: 'error' });
  assert.equal(JSON.parse(lines.at(-1)!).suppressed, 0);
});

test('missing activity differs from explicit unknown, invalid fields are sanitized and sink failures are inert', () => {
  const lines: string[] = [];
  const diagnostic = new RuntimeDiagnostics(line => lines.push(line));
  const { threadActivity: _activity, ...missing } = base;
  diagnostic.transition('s', undefined, missing, { ...base, threadActivity: 'unknown' });
  assert.equal(JSON.parse(lines[0]!).before.activity, 'missing');
  diagnostic.transition('s', undefined, base, { ...base, phase: 'SECRET' as any, operation: 'SECRET' as any,
    lastEventAt: NaN, sync: 'SECRET' as any }, 'SECRET' as any, { commandId: 'id', revision: -1 });
  const invalid = JSON.parse(lines[1]!);
  assert.equal(invalid.after.phase, 'unknown');
  assert.equal(invalid.source, 'unknown');
  assert.equal(invalid.revision, undefined);
  assert.equal(invalid.eventAgeMs, undefined);
  assert.equal(lines.join('').includes('SECRET'), false);
  assert.doesNotThrow(() => new RuntimeDiagnostics(() => { throw new Error('sink unavailable'); })
    .transition('s', 'c', base, { ...base, sync: 'error' }));
});
