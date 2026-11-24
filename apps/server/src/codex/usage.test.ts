import assert from 'node:assert/strict';
import test from 'node:test';
import { codexContextUsage, codexCumulativeUsage, codexRolloutUsage } from './usage.js';

test('native output is copied exactly across live and rollout formats, never inferred from reasoning or last', () => {
  assert.deepEqual(codexCumulativeUsage({ total: { inputTokens: 120, outputTokens: 30, reasoningOutputTokens: 20 } }), { inputTokens: 120, outputTokens: 30 });
  assert.deepEqual(codexCumulativeUsage({ total_token_usage: { input_tokens: 120, output_tokens: 30, cached_input_tokens: 100, reasoning_output_tokens: 20 } }), { inputTokens: 120, outputTokens: 30, cacheReadTokens: 100 });
  for (const value of [{ last: { inputTokens: 120, outputTokens: 30 } }, { total: { inputTokens: 120 } }, { total: { inputTokens: 120, outputTokens: -1 } }]) assert.equal(codexCumulativeUsage(value), undefined);
});

test('rollout cumulative output survives duplicate samples and compaction without summing snapshots', () => {
  const sample = { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 120, output_tokens: 30 }, last_token_usage: { total_tokens: 70 } } } };
  const rows = [{ type: 'session_meta' }, sample, sample, { type: 'compacted' }, { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: 10 } } } }];
  assert.deepEqual(codexRolloutUsage(rows.map(row => JSON.stringify(row)).join('\n')), { compactionCount: 1, inputTokens: 120, outputTokens: 30, contextUsedTokens: 10 });
  assert.deepEqual(codexRolloutUsage(JSON.stringify(sample)), {}, 'unverified history supplies no counters');
});

test('current context uses native last sample, never lifetime total', () => {
  assert.deepEqual(codexContextUsage({ last: { totalTokens: 4200 }, total: { totalTokens: 900000 }, modelContextWindow: 128000 }), { contextUsedTokens: 4200, contextTokens: 128000 });
  for (const value of [undefined, null, {}, { total: { totalTokens: 9999 } }, { last: { totalTokens: -1 }, modelContextWindow: null }]) assert.deepEqual(codexContextUsage(value), {});
  assert.deepEqual(codexContextUsage({ last: { totalTokens: 0 } }), { contextUsedTokens: 0 });
});

test('rollout metrics survive refresh and invalidate stale context after compaction', () => {
  const lines = [{ type: 'session_meta' }, { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: 90000 }, total_token_usage: { total_tokens: 900000 }, model_context_window: 128000 } } }, { type: 'compacted' }];
  const jsonl = (values: unknown[]) => values.map(value => JSON.stringify(value)).join('\n');
  assert.deepEqual(codexRolloutUsage(jsonl(lines)), { contextUsedTokens: null, contextTokens: 128000, compactionCount: 1 });
  lines.push({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: 10000 }, total_token_usage: { total_tokens: 910000 }, model_context_window: 128000 } } });
  assert.deepEqual(codexRolloutUsage(jsonl(lines) + '\n{partial'), { contextUsedTokens: 10000, contextTokens: 128000, compactionCount: 1 });
  assert.deepEqual(codexRolloutUsage(jsonl(lines)), codexRolloutUsage(jsonl(lines)), 'refresh does not increment a counter');
  assert.deepEqual(codexRolloutUsage(''), {});
  assert.deepEqual(codexRolloutUsage('{broken'), {});
  assert.deepEqual(codexRolloutUsage('{"type":"compacted"}'), {}, 'incomplete history does not claim an authoritative count');
});

test('tracks per-turn compaction counts across turn boundaries without conflating turns', () => {
  const rows = [
    { type: 'session_meta' },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
    { type: 'compacted' },
    { type: 'compacted' },
    { type: 'turn_context', payload: { turn_id: 'turn-1', model: 'gpt-5.6-sol' } },
    { type: 'compacted' },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-2' } },
    { type: 'compacted' },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-3' } },
  ];
  assert.deepEqual(codexRolloutUsage(rows.map(row => JSON.stringify(row)).join('\n')), {
    compactionCount: 4,
    contextUsedTokens: null,
    lastTurnCompactions: 0,
    maxTurnCompactions: 3,
  });
});
