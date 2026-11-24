import assert from 'node:assert/strict';
import test from 'node:test';
import { createCompletionDiagnostics } from './completion-diagnostics.js';

test('completion diagnostics are bounded, redacted, copied and clearable', () => {
  const diagnostics = createCompletionDiagnostics(3);
  for (let i = 0; i < 5; i++) diagnostics.record('private-session-key', 'sample', { scale: i });
  const entries = diagnostics.read();
  assert.equal(entries.length, 3);
  assert.ok(entries[0]);
  assert.equal(entries[0].facts.scale, 2);
  assert.ok(entries.every(entry => entry.pane === 1));
  assert.ok(!JSON.stringify(entries).includes('private-session-key'));
  entries[0].facts.scale = 100;
  assert.equal(diagnostics.read()[0]?.facts.scale, 2);
  diagnostics.clear(); assert.deepEqual(diagnostics.read(), []);
  assert.equal(diagnostics.record('new-account-key', 'observe').pane, 1);
});

test('evicted diagnostic aliases are not reused for a different session', () => {
  const diagnostics = createCompletionDiagnostics();
  for (let i = 0; i < 200; i++) diagnostics.record(`session-${i}`, 'observe');
  const entry = diagnostics.record('session-0', 'observe');
  assert.equal(entry.pane, 201);
  assert.equal(diagnostics.read().length, 160);
});
