import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ClaudeStreamDelivery } from './stream-delivery.js';
import type { ClaudeWorkerReply } from './worker-protocol.js';

const event = (event: unknown) => ({ type: 'stream_event', session_id: 'native', parent_tool_use_id: null, event });
const start = event({ type: 'message_start', message: { id: 'provider', role: 'assistant' } });
const block = (index: number) => event({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
const delta = (index: number, text: string) => event({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } });
const final = (uuid: string, text: string) => ({ type: 'assistant', session_id: 'native', parent_tool_use_id: null,
  uuid, message: { id: 'provider', role: 'assistant', content: [{ type: 'text', text }] } });

test('delivery reconciles repeated native blocks only at the result envelope', async () => {
  const replies: ClaudeWorkerReply[] = [];
  const delivery = new ClaudeStreamDelivery('native', async row => { replies.push(row); }, () => assert.fail());
  try {
    for (let i = 1; i <= 2; i++) {
      const reply = final(`block-${i}`, 'fixture');
      await delivery.send({ ...reply, message: { ...reply.message, model: 'native-model', usage: { input_tokens: 10, output_tokens: i } } });
    }
    assert.equal(replies.filter(row => row.kind === 'metrics').length, 0, 'partial usage is not charged');
    await delivery.send({ type: 'result', session_id: 'native', uuid: 'result', usage: { input_tokens: 10, output_tokens: 2 } });
    const samples = replies.filter(row => row.kind === 'metrics');
    assert.equal(samples.length, 1);
    assert.deepEqual(samples[0]!.sample.reconciledCalls, [{ id: 'provider', model: 'native-model', inputTokens: 10, outputTokens: 2 }]);
    assert.equal(replies[replies.indexOf(samples[0]!) - 1]?.kind, 'event');
  } finally { await delivery.finish(); }
});

test('Claude emits numeric samples after the matching root envelope, with monotonic sequence and no provider metadata', async () => {
  const replies: ClaudeWorkerReply[] = [];
  const delivery = new ClaudeStreamDelivery('native', async row => { await delay(1); replies.push(row); }, () => assert.fail());
  const reply = final('assistant-id', 'fixture');
  await delivery.send({ ...reply, message: { ...reply.message, usage: { input_tokens: 20, cache_read_input_tokens: 10, cache_creation_input_tokens: 5, private: 'PRIVATE' } } });
  await delivery.send({ type: 'result', session_id: 'native', uuid: 'result-id', subtype: 'success',
    usage: { input_tokens: 20, output_tokens: 5 }, modelUsage: { private: 'PRIVATE' } });
  await delivery.finish();
  const metrics = replies.filter(row => row.kind === 'metrics');
  assert.deepEqual(metrics.map(row => [row.nativeSessionId, row.sample.eventId, row.sample.sequence]), [['native', 'assistant-id', 1], ['native', 'result-id', 2]]);
  assert.equal(metrics[0]!.sample.context?.used, 35);
  assert.equal(metrics[1]!.sample.usage?.scope, 'last-turn');
  assert.equal(JSON.stringify(replies).includes('PRIVATE'), false);
  assert.equal(replies[replies.indexOf(metrics[0]!) - 1]?.kind, 'projection');
  assert.equal(replies[replies.indexOf(metrics[1]!) - 1]?.kind, 'event');
});

test('stream delivery coalesces tiny deltas and flushes BEFORE final native envelopes, with local-to-wire indexes', async () => {
  const replies: ClaudeWorkerReply[] = [];
  const delivery = new ClaudeStreamDelivery('native', async event => { replies.push(event); }, () => assert.fail(), 60_000);
  try {
    await delivery.send(start); await delivery.send(block(0));
    for (let i = 0; i < 200; i++) await delivery.send(delta(0, 'x'));
    assert.equal(replies.filter(row => row.kind === 'stream').length, 0);
    await delivery.send(final('uuid-0', 'x'.repeat(200)));
    await delivery.send(event({ type: 'content_block_stop', index: 0 }));
    await delivery.send(block(1)); await delivery.send(delta(1, 'second'));
    await delivery.send(final('uuid-1', 'second'));
    await delivery.send(event({ type: 'content_block_stop', index: 1 }));
    await delivery.send(event({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }));
    await delivery.send(event({ type: 'message_stop' }));
    const snapshots = replies.filter(row => row.kind === 'stream');
    assert.equal(snapshots.length, 2);
    assert.deepEqual(snapshots[1]!.snapshot.blocks, [{ blockIndex: 1, text: 'second', truncated: false }]);
    const projections = replies.filter(row => row.kind === 'projection');
    assert.deepEqual(projections.map(row => row.stream?.blockIndexes), [[0], [1]]);
    for (const projection of projections) assert.equal(replies[replies.indexOf(projection) - 2]?.kind, 'stream');
  } finally { await delivery.finish(); }
});

test('a paused native stream still publishes on its single scheduled flush; finishing cancels subsequent output', async () => {
  const replies: ClaudeWorkerReply[] = [];
  const delivery = new ClaudeStreamDelivery('native', async event => { replies.push(event); }, () => assert.fail(), 5);
  await delivery.send(start); await delivery.send(block(0)); await delivery.send(delta(0, 'visible'));
  await delay(30);
  assert.equal(replies.filter(row => row.kind === 'stream').length, 1);
  await delivery.finish();
  const count = replies.length;
  await delay(15); assert.equal(replies.length, count);
  await assert.rejects(delivery.send(delta(0, 'late')), /closed/);
});

test('tool followed by an omitted empty text envelope delivers the next real reply without fencing the worker', async () => {
  const replies: ClaudeWorkerReply[] = [];
  const delivery = new ClaudeStreamDelivery('native', async row => { replies.push(row); }, () => assert.fail(), 60_000);
  try {
    await delivery.send(start);
    await delivery.send(event({ type: 'content_block_start', index: 0,
      content_block: { type: 'tool_use', id: 'file-edit', name: 'Edit', input: {} } }));
    await delivery.send({ ...final('tool-envelope', ''), message: { id: 'provider', role: 'assistant',
      content: [{ type: 'tool_use', id: 'file-edit', name: 'Edit', input: {} }] } });
    await delivery.send(event({ type: 'content_block_stop', index: 0 }));
    await delivery.send(block(1));
    await delivery.send(event({ type: 'content_block_stop', index: 1 }));
    await delivery.send(event({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }));
    await delivery.send(event({ type: 'message_stop' }));
    await delivery.send({ type: 'user', session_id: 'native', parent_tool_use_id: null, uuid: 'tool-result',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'file-edit', content: 'updated' }] } });
    await delivery.send(event({ type: 'message_start', message: { id: 'reply', role: 'assistant' } }));
    await delivery.send(block(0)); await delivery.send(delta(0, 'FILE_BOARD_OK'));
    await delivery.send({ ...final('reply-envelope', 'FILE_BOARD_OK'), message: { id: 'reply', role: 'assistant',
      content: [{ type: 'text', text: 'FILE_BOARD_OK' }] } });
    await delivery.send(event({ type: 'content_block_stop', index: 0 }));
    await delivery.send(event({ type: 'message_stop' }));
    await delivery.send({ type: 'result', session_id: 'native', uuid: 'result', subtype: 'success' });
    assert.equal(replies.filter(row => row.kind === 'stream').length, 1);
    const projections = replies.filter(row => row.kind === 'projection');
    assert.equal(projections.length, 3);
    assert.equal(projections.at(-1)?.stream?.messageId, 'reply');
    assert.deepEqual(projections.at(-1)?.stream?.blockIndexes, [0]);
  } finally { await delivery.finish(); }
});

test('failed stream delivery closes the native query, does not replay a snapshot and reports failure at finish', async () => {
  let closed = 0;
  const delivery = new ClaudeStreamDelivery('native', async event => {
    if (event.kind === 'stream') throw new Error('transport failed');
  }, () => { closed++; }, 60_000);
  await delivery.send(start); await delivery.send(block(0)); await delivery.send(delta(0, 'pending'));
  await assert.rejects(delivery.send(final('uuid', 'pending')));
  await assert.rejects(delivery.finish());
  assert.ok(closed > 0);
});
