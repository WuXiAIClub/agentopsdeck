import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { CopilotStreamDelivery } from './stream-delivery.js';
import { CopilotTextStreams, validateCopilotStream } from './stream-projection.js';
import { COPILOT_MESSAGE_TEXT_LIMIT, copilotMessageId } from './message-projection.js';
import type { CopilotWorkerReply } from './worker-protocol.js';
const event = (type: string, data: Record<string, unknown>, id = 'e') => ({ id, type, data, timestamp: '2026-09-23T00:00:00.000Z' });
const delta = (content: string, id = 'msg') => event('assistant.message_delta', { messageId: id, deltaContent: content });

test('Copilot serializes native numeric metrics with their root lifecycle identity, without raw provider data', async () => {
  const output: CopilotWorkerReply[] = [];
  const delivery = new CopilotStreamDelivery(async row => { await delay(1); output.push(row); }, () => assert.fail(), 5, 'native');
  delivery.send(event('session.usage_info', { currentTokens: 20, tokenLimit: 100, private: 'PRIVATE' }, 'context'));
  delivery.send(event('assistant.usage', { inputTokens: 20, outputTokens: 5, initiator: 'user', interactionType: 'conversation-agent', private: 'PRIVATE' }, 'usage'));
  delivery.send({ ...event('assistant.usage', { inputTokens: 200, outputTokens: 50 }, 'child'), agentId: 'child' });
  await delivery.finish();
  assert.deepEqual(output.map(row => row.kind), ['event', 'metrics', 'event', 'metrics']);
  const metrics = output.filter(row => row.kind === 'metrics');
  assert.deepEqual(metrics.map(row => [row.nativeSessionId, row.sample.eventId, row.sample.sequence]), [['native', 'context', 1], ['native', 'usage', 2]]);
  assert.equal(JSON.stringify(output).includes('PRIVATE'), false);
});

test('Copilot text accumulates within a budget, separates child scope and rejects late deltas', () => {
  const streams = new CopilotTextStreams();
  streams.accept(delta('x'.repeat(COPILOT_MESSAGE_TEXT_LIMIT + 10)));
  streams.accept({ ...delta('child'), agentId: 'child' });
  const rows = streams.drain();
  assert.equal(rows.length, 2); assert.equal(rows[0]!.text.length, COPILOT_MESSAGE_TEXT_LIMIT); assert.equal(rows[0]!.truncated, true);
  assert.equal(rows[1]!.text, 'child'); assert.equal(streams.hasPending, false);
  streams.accept(event('assistant.message', { messageId: 'msg', content: 'final' }));
  assert.throws(() => streams.accept(delta('too late')));
  assert.throws(() => validateCopilotStream({ messageId: 'x', text: '', truncated: false, parentToolCallId: null }));
});
test('Copilot delivery coalesces tiny tokens, uses stable final IDs and does not emit raw deltas', async () => {
  const output: CopilotWorkerReply[] = [];
  const delivery = new CopilotStreamDelivery(async row => { output.push(row); }, () => assert.fail('stream failed'), 5);
  for (let i = 0; i < 1000; i++) delivery.send(delta('x'));
  await delay(20);
  delivery.send(event('assistant.message', { messageId: 'msg', content: 'x'.repeat(1000) }, 'final'));
  delivery.send(event('session.idle', {})); await delivery.finish();
  const streams = output.filter(row => row.kind === 'stream'), finals = output.filter(row => row.kind === 'projection');
  assert.equal(streams.length, 1); assert.equal(finals.length, 1);
  assert.equal(streams[0]!.snapshot.text.length, 1000);
  const final = finals[0]!.row;
  assert.equal(copilotMessageId('ghcp:test', streams[0]!.snapshot, 'assistant', 'msg'),
    copilotMessageId('ghcp:test', final, final.role, final.messageId!));
  assert.equal(output.filter(row => row.kind === 'event').length, 2);
});
test('Copilot final replaces an unflushed delta; interruption flushes partial without faking final', async () => {
  for (const complete of [true, false]) {
    const output: CopilotWorkerReply[] = [];
    const delivery = new CopilotStreamDelivery(async row => { output.push(row); }, () => assert.fail(), 1000);
    delivery.send(delta('partial'));
    if (complete) delivery.send(event('assistant.message', { messageId: 'msg', content: 'final' }));
    delivery.send(event('session.idle', { aborted: !complete }));
    await delivery.finish();
    assert.equal(output.filter(row => row.kind === 'stream').length, complete ? 0 : 1);
    assert.equal(output.filter(row => row.kind === 'projection').length, complete ? 1 : 0);
  }
});
test('Copilot IPC failure fences delivery and drains without unhandled private errors', async () => {
  let failures = 0;
  const delivery = new CopilotStreamDelivery(async () => { throw new Error('PRIVATE'); }, () => { failures++; throw new Error('PRIVATE'); });
  delivery.send(event('user.message', { messageId: 'user', content: 'prompt' }));
  await assert.rejects(delivery.finish(), /Copilot stream delivery failed/);
  assert.ok(failures > 0); assert.throws(() => delivery.send(delta('late'))); delivery.dispose();
});
