import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionSummary } from '@agentopsdeck/shared';
import { sessionTokenMetrics } from './session-token-metrics.js';
const session: SessionSummary = { sessionKey: 's', agentId: 'codex', title: 'Test', status: 'idle' };
test('Codex native counters retain exact output precision and distinguish missing from zero', () => {
  assert.deepEqual(sessionTokenMetrics({ ...session, inputTokens: 1234567, outputTokens: 23456 }), { scope: 'Native cumulative', input: (1234567).toLocaleString(), output: (23456).toLocaleString() });
  assert.equal(sessionTokenMetrics(session).output, '—');
  assert.equal(sessionTokenMetrics({ ...session, outputTokens: 0 }).output, '0');
  for (const outputTokens of [null, '', false, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(sessionTokenMetrics({ ...session, outputTokens } as SessionSummary).output, '—');
  }
});
test('CC and GHCP last-use counters cannot be mistaken for or filled from cumulative totals', () => {
  for (const scope of ['last-turn', 'last-call'] as const) {
    const row = { ...session, inputTokens: 90000, outputTokens: 50000, nativeUsage: { scope, inputTokens: 100, outputTokens: 2 } };
    assert.deepEqual(sessionTokenMetrics(row), { scope: scope === 'last-turn' ? 'Last turn' : 'Last call', input: '100', output: '2' });
    assert.equal(sessionTokenMetrics({ ...row, nativeUsage: { ...row.nativeUsage, outputTokens: undefined } } as unknown as SessionSummary).output, '—');
  }
});
