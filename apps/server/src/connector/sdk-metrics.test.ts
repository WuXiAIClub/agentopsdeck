import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TurnQueue } from '../commands/turn-queue.js';
import { SdkExecutionJournal, type SdkAgentId } from './sdk-execution-journal.js';
import { validateSdkMetricSample } from './sdk-metrics.js';
import { sdkSessionView } from './sdk-session-view.js';
import { claudeMetricSample } from '../claude/metrics.js';
import { copilotMetricSample } from '../copilot/metrics.js';

const claude = (data: Record<string, unknown>) => ({ uuid: 'event', session_id: 'native', parent_tool_use_id: null, ...data });
const copilot = (type: string, data: Record<string, unknown>, extra = {}) => ({ id: 'event', type, data, ...extra });
const context = { used: 123, limit: 1000, basis: 'native-context' as const };
test('Claude usage keeps per-turn scope and drops cumulative multi-model totals and private payloads', () => {
  const sample = claudeMetricSample(claude({ type: 'result', usage: { input_tokens: 12, output_tokens: 8,
    cache_read_input_tokens: 100, cache_creation_input_tokens: 20, secret: 'PRIVATE' },
    modelUsage: { privateModel: { inputTokens: 900000, contextWindow: 200000 } }, total_cost_usd: 123 }), 'native', 1);
  assert.deepEqual(sample, { eventId: 'event', sequence: 1, usage: { scope: 'last-turn', inputTokens: 12,
    outputTokens: 8, cacheReadTokens: 100, cacheWriteTokens: 20 } });
  assert.equal(claudeMetricSample(claude({ type: 'result', usage: { input_tokens: NaN, output_tokens: 1 } }), 'native', 1), undefined);
  assert.equal(claudeMetricSample(claude({ type: 'result', usage: { input_tokens: 1, output_tokens: 1 }, parent_tool_use_id: 'child' }), 'native', 1), undefined);
});
test('Claude distinguishes native context report from last request input, never invents cache tokens or window', () => {
  const event = claude({ type: 'assistant', message: { usage: { input_tokens: 12, output_tokens: 5000,
    cache_read_input_tokens: 100, cache_creation_input_tokens: 20 } } });
  assert.deepEqual(claudeMetricSample(event, 'native', 1)?.context, { used: 132, basis: 'last-request-input' });
  assert.equal(claudeMetricSample(event, 'foreign', 1), undefined);
  assert.equal(claudeMetricSample({ ...event, message: { usage: { input_tokens: 12 } } }, 'native', 1), undefined);
  assert.deepEqual(claudeMetricSample({ ...event, context_usage: { total_tokens: 240, raw_max_tokens: 1000, memory_files: ['PRIVATE'] } }, 'native', 1)?.context,
    { used: 240, limit: 1000, basis: 'native-context' });
});
test('Claude compaction invalidates old context unless native reports post_tokens', () => {
  const event = claude({ type: 'system', subtype: 'compact_boundary', compact_metadata: { pre_tokens: 5000 } });
  assert.deepEqual(claudeMetricSample(event, 'native', 1), { eventId: 'event', sequence: 1, compacted: true,
    context: { used: null, basis: 'post-compaction' } });
  assert.equal(claudeMetricSample({ ...event, compact_metadata: { post_tokens: 7 } }, 'native', 1)?.context?.used, 7);
});
test('Copilot separates context snapshots and latest root API usage, not cumulative or child usage', () => {
  assert.deepEqual(copilotMetricSample(copilot('session.usage_info', { currentTokens: 123, tokenLimit: 1000, messagesLength: 10, private: 'PRIVATE' }), 1)?.context, context);
  const event = copilot('assistant.usage', { inputTokens: 99, outputTokens: 5, cacheReadTokens: 80, interactionType: 'conversation-agent' });
  assert.deepEqual(copilotMetricSample(event, 1)?.usage, { scope: 'last-call', inputTokens: 99, outputTokens: 5, cacheReadTokens: 80 });
  assert.deepEqual(copilotMetricSample({ ...event, data: { ...event.data, initiator: 'user' } }, 1)?.usage, copilotMetricSample(event, 1)?.usage);
  for (const extra of [{ agentId: 'child' }, { data: { ...event.data, parentToolCallId: 'tool' } },
    { data: { ...event.data, initiator: 'sub-agent' } }, { data: { ...event.data, initiator: 'unknown' } },
    { data: { ...event.data, initiator: 'user', interactionType: 'conversation-compaction' } }]) {
    assert.equal(copilotMetricSample({ ...event, ...extra }, 1), undefined);
  }
  assert.equal(copilotMetricSample(copilot('assistant.usage', { inputTokens: 2 }), 1), undefined);
});
test('Copilot counts successful compaction only; missing new size means unknown', () => {
  assert.equal(copilotMetricSample(copilot('session.compaction_complete', { success: false, error: 'PRIVATE' }), 1), undefined);
  assert.deepEqual(copilotMetricSample(copilot('session.compaction_complete', { success: true, preCompactionTokens: 1000 }), 1),
    { eventId: 'event', sequence: 1, compacted: true, context: { used: null, basis: 'post-compaction' } });
  assert.equal(copilotMetricSample(copilot('session.compaction_complete', { success: true, postCompactionTokens: 0 }), 1)?.context?.used, 0);
});
test('metrics IPC rejects unbounded IDs, unknown fields, negative/fractional/nonfinite numbers and false compactions', () => {
  const valid = { eventId: 'event', sequence: 1, context };
  assert.deepEqual(validateSdkMetricSample(valid), valid);
  for (const value of [null, [], {}, { ...valid, eventId: 'x'.repeat(513) }, { ...valid, sequence: 0 }, { ...valid, private: 'secret' },
    { ...valid, context: { ...context, private: 'secret' } }, { ...valid, compacted: false },
    ...[-1, NaN, Infinity, 1.1, Number.MAX_SAFE_INTEGER + 1].map(used => ({ ...valid, context: { ...context, used } })),
    { ...valid, usage: { scope: 'cumulative', inputTokens: 1, outputTokens: 1 } }]) assert.throws(() => validateSdkMetricSample(value));
});

function fixture(runtime: SdkAgentId, path = ':memory:') {
  const db = new DatabaseSync(path), turns = new TurnQueue(db), journal = new SdkExecutionJournal(db, runtime, () => 1000);
  const key = `${runtime}:session`;
  if (!journal.session(key)) journal.create({ key, nativeSessionId: 'native', title: 'Fixture', createdAt: 1 });
  const begin = (id: string) => {
    turns.enqueue(runtime, { id, sessionKey: key, createdAt: 1000, payload: { text: 'private', actorId: 'owner' } });
    return journal.begin({ key, id: `execution-${id}`, epoch: 'epoch' }, [id], turns)!;
  };
  return { db, turns, journal, key, begin };
}
for (const runtime of ['claude-code', 'ghcp'] as const) {
  test(`${runtime}: metrics bind exact execution/epoch/native identity, dedupe, reject reordered/late events`, () => {
    const f = fixture(runtime);
    try {
      const execution = f.begin('first'), sample = { eventId: 'metric', sequence: 2, context, compacted: true };
      for (const ref of [{ ...execution, epoch: 'wrong' }, { ...execution, nativeSessionId: 'wrong' },
        { ...execution, key: `${runtime}:other` }, { ...execution, id: 'wrong' }]) assert.equal(f.journal.recordMetrics(ref, sample), false);
      assert.equal(f.journal.recordMetrics(execution, sample), true);
      assert.equal(f.journal.recordMetrics(execution, { ...sample, sequence: 3 }), false, 'duplicate event with a newer transport sequence');
      assert.equal(f.journal.recordMetrics(execution, { ...sample, eventId: 'older', sequence: 1 }), false);
      let summary = sdkSessionView(runtime, f.journal.session(f.key)!, f.journal.current(f.key), true);
      assert.equal(summary.compactionCount, 1); assert.equal(summary.contextUsedTokens, 123);
      assert.equal(summary.status, 'running'); assert.equal(f.journal.current(f.key)?.phase, 'dispatching');
      f.journal.observeTerminal(execution, 'completed', f.turns); f.journal.confirmSettled(execution);
      assert.equal(f.journal.recordMetrics(execution, { ...sample, eventId: 'late', sequence: 3 }), false);
      const next = f.begin('second');
      assert.equal(f.journal.recordMetrics(execution, { ...sample, eventId: 'old-turn', sequence: 4 }), false);
      assert.equal(f.journal.recordMetrics(next, { ...sample, sequence: 1 }), false, 'native replay across workers');
      assert.equal(f.journal.recordMetrics(next, { eventId: 'compact2', sequence: 2, compacted: true }), true);
      summary = sdkSessionView(runtime, f.journal.session(f.key)!, f.journal.current(f.key), true);
      assert.equal(summary.compactionCount, 2); assert.equal(summary.contextUsedTokens, null);
      assert.equal(summary.contextTokens, undefined); assert.equal(summary.totalTokens, undefined);
    } finally { f.db.close(); }
  });
  test(`${runtime}: persisted telemetry survives restart, does not change outcome, old counts remain unknown`, () => {
    const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-sdk-metrics-')), path = join(root, 'store.sqlite');
    let f = fixture(runtime, path);
    try {
      const execution = f.begin('first');
      assert.equal(f.journal.recordMetrics(execution, { eventId: 'usage', sequence: 1,
        usage: { scope: runtime === 'ghcp' ? 'last-call' : 'last-turn', inputTokens: 50, outputTokens: 3 } }), true);
      f.journal.observeTerminal(execution, 'completed', f.turns); f.journal.confirmSettled(execution);
      const original = sdkSessionView(runtime, f.journal.session(f.key)!, f.journal.current(f.key), true);
      f.db.close(); f = fixture(runtime, path); f.journal.recover(f.turns);
      assert.deepEqual(sdkSessionView(runtime, f.journal.session(f.key)!, f.journal.current(f.key), true), original);
      f.journal.updateModel(f.key, 'new-model', () => {});
      assert.equal(f.journal.session(f.key)?.metrics?.context, undefined);
      // Pre-feature session: never pretend prior native compaction count is 0.
      f.db.prepare("UPDATE sdk_agent_sessions SET data = json_remove(data, '$.metrics') WHERE session_key = ?").run(f.key);
      const next = f.begin('second');
      f.journal.recordMetrics(next, { eventId: 'compact', sequence: 1, compacted: true });
      assert.equal(sdkSessionView(runtime, f.journal.session(f.key)!, f.journal.current(f.key), true).compactionCount, undefined);
    } finally { f.db.close(); rmSync(root, { recursive: true, force: true }); }
  });
}
