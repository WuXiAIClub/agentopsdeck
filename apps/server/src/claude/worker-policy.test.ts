import assert from 'node:assert/strict';
import test from 'node:test';
import { assertClaudeWorkerPolicy, claudeWorkerSettings } from './worker-policy.js';

test('Claude private worker accepts only the empty host settings cascade', () => {
  assertClaudeWorkerPolicy({ effective: {}, provenance: {}, sources: [] });
  assertClaudeWorkerPolicy({ effective: {}, provenance: {}, sources: [{ source: 'managed', settings: {} }] });
  assert.equal(claudeWorkerSettings.disableAllHooks, true);
  assert.equal(claudeWorkerSettings.crossSessionInbound, 'refuse');
});

test('Claude private worker rejects effective and shadowed executable policy without exposing values', () => {
  for (const settings of [{ policyHelper: 'PRIVATE' }, { hooks: { SessionStart: ['PRIVATE'] } },
    { env: { ANTHROPIC_API_KEY: 'PRIVATE' } }, { apiKeyHelper: 'PRIVATE' }, { model: 'PRIVATE' }]) {
    for (const effective of [{}, settings]) {
      assert.throws(() => assertClaudeWorkerPolicy({ effective, provenance: {},
        sources: [{ source: 'managed', settings }] }), error =>
        error instanceof Error && error.message.includes('unsupported') && !error.message.includes('PRIVATE'));
    }
  }
});

test('Claude private worker fails closed on malformed resolver output', () => {
  for (const resolved of [null, {}, { effective: [], provenance: {}, sources: [] },
    { effective: {}, provenance: {}, sources: [{}] }, { effective: {}, provenance: {}, sources: null },
    { effective: {}, provenance: { hooks: 'managed' }, sources: [] }]) {
    assert.throws(() => assertClaudeWorkerPolicy(resolved));
  }
});
