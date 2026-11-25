import assert from 'node:assert/strict';
import test from 'node:test';
import { HistoryDiagnostics } from './history-diagnostics.js';

test('both legacy history event tags retain allowlisted diagnostics with hashed identities only', () => {
  const rows: Record<string, unknown>[] = [], tags: string[] = [];
  const diagnostic = new HistoryDiagnostics((tag, row) => { tags.push(tag); rows.push(row); });
  for (const kind of ['final', 'refresh'] as const) diagnostic.failure(kind, 'SECRET-SESSION', 'SECRET-CONNECTION', 'SECRET-TURN', {
    stage: 'native-read', fault: 'background-terminals', outcome: 'failed', attempts: 5,
    ownership: { total: 3, owned: 2, unattributed: 1 },
    lifecycle: { declaredTemporary: 0, declaredService: 0, undeclaredOwned: 2, unattributed: 1 },
  });
  assert.deepEqual(tags, ['[codex-final-history-failed]', '[codex-history-refresh-failed]']);
  assert.equal(rows[0]!.instance, rows[1]!.instance);
  assert.deepEqual(rows.map(row => row.sequence), [1, 2]);
  assert.equal(rows[0]!.session, rows[1]!.session);
  for (const name of ['session', 'connection', 'turn']) assert.match(rows[0]![name] as string, /^[a-f0-9]{16}$/);
  assert.equal(rows[0]!.stage, 'native-read'); assert.equal(rows[0]!.attempts, 5);
  assert.deepEqual(rows[0]!.ownership, { total: 3, owned: 2, unattributed: 1 });
  assert.doesNotMatch(JSON.stringify(rows), /SECRET/);
});

test('history failure input rejects arbitrary text, extra fields and invalid numbers', () => {
  const rows: Record<string, unknown>[] = [];
  const diagnostic = new HistoryDiagnostics((_tag, row) => rows.push(row));
  diagnostic.failure('final', 's', undefined, undefined, { stage: 'SECRET-STAGE', fault: 'SECRET-FAULT', outcome: 'SECRET-OUTCOME',
    attempts: Infinity, reason: 'SECRET-REASON', ownership: { total: -1, owned: NaN, unattributed: 1, secret: 'SECRET-COUNT' } } as any);
  assert.equal(rows[0]!.stage, 'unknown'); assert.equal(rows[0]!.fault, 'unknown'); assert.equal(rows[0]!.outcome, 'unknown');
  assert.equal(rows[0]!.attempts, undefined); assert.equal(rows[0]!.turn, null);
  assert.deepEqual(rows[0]!.ownership, { unattributed: 1 });
  assert.doesNotMatch(JSON.stringify(rows), /SECRET/);
});

test('terminal recovery gates use fixed allowlists, hashed identities and the shared budget', () => {
  const rows: Record<string, unknown>[] = [], tags: string[] = [];
  const diagnostic = new HistoryDiagnostics((tag, row) => { tags.push(tag); rows.push(row); }, () => 0);
  const gates = ['eligibility', 'single-attempt', 'path', 'goal', 'rollout', 'journal-prepare', 'journal-begin',
    'unsubscribe', 'resume', 'resume-ack', 'archive', 'unarchive', 'journal-finish', 'confirm',
    'confirm-status', 'confirm-history', 'confirm-goal', 'recovered'];
  for (const gate of [...gates, 'SECRET-GATE']) {
    diagnostic.failure('recovery', 'SECRET-SESSION', 'SECRET-CONNECTION', 'SECRET-TURN',
      { stage: 'terminal-reload', fault: gate === 'recovered' ? 'recovered' : 'protected', gate });
  }
  assert.ok(tags.every(tag => tag === '[codex-terminal-recovery]'));
  assert.ok(rows.every(row => row.event === 'terminal_recovery_observed'));
  assert.deepEqual(rows.slice(0, -1).map(row => row.gate), gates);
  assert.equal(rows.at(-1)!.gate, 'unknown');
  assert.equal(rows.at(-2)!.fault, 'recovered');
  assert.doesNotMatch(JSON.stringify(rows), /SECRET/);
  for (let i = 0; i < 120; i++) diagnostic.failure('final', 's', undefined, undefined,
    { stage: 'native-read', fault: 'unavailable' });
  assert.equal(rows.length, 120, 'recovery does not get a separate unbounded log budget');
});

test('recovery and storage boundaries have distinct fixed diagnostics without raw failure text', () => {
  const rows: Record<string, unknown>[] = [];
  const diagnostic = new HistoryDiagnostics((_tag, row) => rows.push(row));
  const stages = ['cold-recovery-goal', 'cold-recovery-recheck', 'cold-recovery-resume',
    'cold-recovery-confirm', 'history-storage-read', 'history-ownership', 'history-completeness'];
  for (const stage of stages) diagnostic.failure('refresh', 'private-session', undefined, undefined,
    { stage, fault: 'authority-changed' });
  assert.deepEqual(rows.map(row => row.stage), stages);
  assert.doesNotMatch(JSON.stringify(rows), /private-session/);
});

test('both history paths share a bounded budget with suppression and backwards clock handling', () => {
  let now = 0;
  const rows: Record<string, unknown>[] = [];
  const diagnostic = new HistoryDiagnostics((_tag, row) => rows.push(row), () => now);
  for (let i = 0; i < 125; i++) diagnostic.failure(i % 2 ? 'final' : 'refresh', `s-${i}`, undefined, undefined, { stage: 'native-read', fault: 'unavailable' });
  assert.equal(rows.length, 120);
  now = 60_000; diagnostic.failure('final', 's', undefined, undefined, { stage: 'native-read', fault: 'unavailable' });
  assert.equal(rows.at(-1)!.suppressed, 5);
  now = 1; diagnostic.failure('refresh', 's', undefined, undefined, { stage: 'native-read', fault: 'unavailable' });
  assert.equal(rows.at(-1)!.suppressed, 0);
});

test('throwing, reentrant and invalid observation clocks or sinks stay inert and recover', () => {
  const fields = { stage: 'native-read', fault: 'unavailable' };
  const rows: Record<string, unknown>[] = [];
  let broken = true;
  const diagnostic = new HistoryDiagnostics((_tag, row) => { rows.push(row); diagnostic.failure('final', 's', undefined, undefined, fields); if (broken) throw Error('SECRET'); });
  assert.doesNotThrow(() => diagnostic.failure('final', 's', undefined, undefined, fields));
  assert.equal(rows.length, 1); broken = false;
  diagnostic.failure('refresh', 's', undefined, undefined, fields);
  assert.equal(rows.length, 2); assert.equal(rows[1]!.suppressed, 1);
  const clock = new HistoryDiagnostics(() => { throw Error('must not be reached'); }, () => { throw Error('SECRET'); });
  assert.doesNotThrow(() => clock.failure('final', 's', undefined, undefined, fields));
  const invalid = new HistoryDiagnostics(() => assert.fail('invalid clock logged'), () => NaN);
  invalid.failure('final', 's', undefined, undefined, fields);
});
