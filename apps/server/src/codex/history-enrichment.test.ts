import assert from 'node:assert/strict';
import test from 'node:test';
import { historicalMessages, historicalProjection, threadModelFromRollout } from './app-server.js';
import { RolloutProjectionBuilder, type RolloutSource } from './rollout-projection.js';
import { codexRolloutUsage, createRolloutUsageAccumulator } from './usage.js';

const record = (type: string, payload?: unknown) => ({ type, payload });
const context = (model: unknown) => record('turn_context', { model });
const complete = (error?: unknown) => record('event_msg', { type: 'task_complete', error });
const tokens = (used: unknown, limit: unknown = 32000) => record('event_msg', {
  type: 'token_count', info: { last_token_usage: { total_tokens: used }, model_context_window: limit },
});
const jsonl = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const turns = [{ id: 'turn', status: 'completed', items: [{ id: 'reply', type: 'agentMessage', text: 'answer' }] }];

const cases = [
  { name: 'empty/malformed has no model or authoritative usage', rows: [null, [], {}, 1], model: undefined, usage: {} },
  { name: 'missing session meta does not claim usage', rows: [context(' active '), tokens(42), record('compacted')], model: 'active', usage: {} },
  { name: 'failed/pending model does not overwrite successful model', rows: [record('session_meta'), context('first'), complete(), context('second'), complete('failed'), context('pending'), tokens(42)], model: 'first', usage: { compactionCount: 0, contextUsedTokens: 42, contextTokens: 32000 } },
  { name: 'successful updated model wins and blanks are ignored', rows: [record('session_meta'), context('first'), complete(), record('event_msg', { type: 'thread_settings_applied', thread_settings: { model: ' second ' } }), complete(), context(' '), context(42)], model: 'second', usage: { compactionCount: 0 } },
  { name: 'payload turn context and error-free completion retain legacy rules', rows: [record('event_msg', { type: 'turn_context', model: 'payload-model' }), complete(false), context('pending')], model: 'payload-model', usage: {} },
  { name: 'compaction invalidates usage and invalid sample cannot revive it', rows: [record('session_meta'), tokens(400), record('compacted'), tokens(-1, 0), tokens(1.5, -1)], model: undefined, usage: { compactionCount: 1, contextUsedTokens: null, contextTokens: 32000 } },
  { name: 'latest sample after compaction including zero is retained', rows: [tokens(400), record('compacted'), record('session_meta'), record('compacted'), tokens(0, 64000)], model: undefined, usage: { compactionCount: 2, contextUsedTokens: 0, contextTokens: 64000 } },
];

for (const mode of ['string', 'memory', 'disk'] as const) test(`combined facts preserve model and usage semantics (${mode})`, async () => {
  for (const fixture of cases) {
    const text = '\n{malformed\n' + jsonl(fixture.rows) + '{partial';
    const builder = new RolloutProjectionBuilder(mode === 'disk' ? 0 : 1024 * 1024);
    let source: RolloutSource = text;
    let scans = 0;
    try {
      if (mode !== 'string') {
        for (const line of text.split('\n')) await builder.add(line + '\n');
        source = await builder.finish();
        const iterate = source[Symbol.asyncIterator].bind(source);
        source[Symbol.asyncIterator] = async function* () { scans++; yield* iterate(); };
      }
      const combined = await historicalProjection('codex:one', turns, undefined, source);
      assert.equal(combined.model, fixture.model, fixture.name);
      assert.deepEqual(combined.usage, fixture.usage, fixture.name);
      if (mode !== 'string') assert.equal(scans, 1, 'all enrichment is collected in one pass');
      assert.deepEqual(combined.messages, await historicalMessages('codex:one', turns, undefined, text));
      assert.equal(await threadModelFromRollout(source), combined.model);
      assert.deepEqual(await codexRolloutUsage(source), combined.usage);
      // Legacy string interfaces must remain synchronous.
      assert.equal(threadModelFromRollout(text), fixture.model);
      assert.deepEqual(codexRolloutUsage(text), fixture.usage);
    } finally { if (typeof source !== 'string') await source.dispose(); await builder.abort(); }
  }
});

test('appended projections and concurrent sessions do not share metadata or mutable results', async () => {
  const headBuilder = new RolloutProjectionBuilder(0), tailBuilder = new RolloutProjectionBuilder(0);
  for (const row of [record('session_meta'), context('first'), complete(), tokens(400)]) await headBuilder.add(jsonl([row]));
  for (const row of [record('compacted'), context('second'), complete(), tokens(12)]) await tailBuilder.add(jsonl([row]));
  const head = await headBuilder.finish(), tail = await tailBuilder.finish(), appended = head.append(tail);
  await tail.dispose();
  try {
    const [original, next, concurrent] = await Promise.all([
      historicalProjection('codex:original', turns, undefined, head),
      historicalProjection('codex:next', turns, undefined, appended),
      historicalProjection('codex:concurrent', turns, undefined, appended),
    ]);
    assert.equal(original.model, 'first');
    assert.deepEqual(original.usage, { compactionCount: 0, contextUsedTokens: 400, contextTokens: 32000 });
    assert.equal(next.model, 'second');
    assert.deepEqual(next.usage, { compactionCount: 1, contextUsedTokens: 12, contextTokens: 32000 });
    assert.deepEqual(next.usage, concurrent.usage);
    next.usage.compactionCount = 99;
    assert.equal(concurrent.usage.compactionCount, 1);
    assert.equal((await historicalProjection('codex:next', turns, undefined, appended)).usage.compactionCount, 1);
    assert.notEqual(next.messages[0]!.id, concurrent.messages[0]!.id);
  } finally { await head.dispose(); await appended.dispose(); }
});

test('failed projection returns no partial metadata and releases its iterator', async () => {
  const builder = new RolloutProjectionBuilder(0);
  await builder.add(jsonl([record('session_meta')]));
  const projection = await builder.finish();
  const iterate = projection[Symbol.asyncIterator].bind(projection);
  let released = false;
  projection[Symbol.asyncIterator] = async function* () {
    try { for await (const line of iterate()) { yield line; throw Error('synthetic read error'); } }
    finally { released = true; }
  };
  try {
    await assert.rejects(historicalProjection('codex:one', turns, undefined, projection), /synthetic read error/);
    assert.equal(released, true);
    await assert.rejects(async () => threadModelFromRollout(projection), /synthetic read error/);
    await assert.rejects(async () => codexRolloutUsage(projection), /synthetic read error/);
  } finally { await projection.dispose(); }
});

test('usage accumulator snapshots cannot alter later results', () => {
  const usage = createRolloutUsageAccumulator();
  usage.accept(record('session_meta'));
  const first = usage.result(); first.compactionCount = 99;
  usage.accept(record('compacted'));
  assert.deepEqual(usage.result(), { compactionCount: 1, contextUsedTokens: null });
});
