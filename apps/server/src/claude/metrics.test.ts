import assert from 'node:assert/strict';
import test from 'node:test';
import { ClaudeReconciledMetrics } from './metrics.js';
import { validateSdkMetricSample } from '../connector/sdk-metrics.js';

const usage = (input = 10, output = 2) => ({ input_tokens: input, output_tokens: output,
  cache_read_input_tokens: 3, cache_creation_input_tokens: 1 });
const assistant = (id = 'call-a', model = 'model-a', data = usage()) => ({ type: 'assistant', uuid: `envelope-${id}`,
  session_id: 'native', parent_tool_use_id: null, message: { id, model, role: 'assistant', usage: data,
    content: [{ type: 'text', text: 'PRIVATE' }] } });
const result = (data = usage()) => ({ type: 'result', uuid: 'result', session_id: 'native', usage: data,
  modelUsage: { forbidden: { inputTokens: 900_000 } }, total_cost_usd: 123 });

test('Claude attributes only exactly reconciled native call IDs/models; content blocks are not calls', () => {
  const metrics = new ClaudeReconciledMetrics();
  metrics.sample(assistant('call-a', 'model-a', usage(10, 1)), 'native', 1);
  metrics.sample({ ...assistant(), uuid: 'second-block' }, 'native', 2);
  metrics.sample(assistant('call-b', 'model-b', usage(20, 4)), 'native', 3);
  const sample = metrics.sample(result({ input_tokens: 30, output_tokens: 6, cache_read_input_tokens: 6, cache_creation_input_tokens: 2 }), 'native', 4)!;
  assert.deepEqual(sample.reconciledCalls, [
    { id: 'call-a', model: 'model-a', inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 1 },
    { id: 'call-b', model: 'model-b', inputTokens: 20, outputTokens: 4, cacheReadTokens: 3, cacheWriteTokens: 1 },
  ]);
  assert.equal(sample.usage?.inputTokens, 30);
  assert.equal(JSON.stringify(sample).includes('PRIVATE'), false);
  assert.equal(JSON.stringify(sample).includes('forbidden'), false);
  assert.deepEqual(validateSdkMetricSample(sample), sample);
  assert.equal(metrics.sample(result(), 'native', 5)?.reconciledCalls, undefined, 'result clears call state');
});

for (const reason of ['unfinished', 'cache-unknown', 'cache-disagrees', 'model-change', 'decreasing', 'missing-id', 'missing-model', 'malformed-cache']) {
  test(`Claude keeps authoritative aggregate model unknown: ${reason}`, () => {
    const metrics = new ClaudeReconciledMetrics();
    const event = assistant();
    metrics.sample(event, 'native', 1);
    if (reason === 'model-change') metrics.sample(assistant('call-a', 'different'), 'native', 2);
    if (reason === 'decreasing') metrics.sample(assistant('call-a', 'model-a', usage(10, 1)), 'native', 2);
    if (reason === 'missing-id') metrics.sample({ ...event, message: { ...event.message, id: undefined } }, 'native', 2);
    if (reason === 'missing-model') metrics.sample({ ...event, message: { ...event.message, model: undefined } }, 'native', 2);
    if (reason === 'malformed-cache') metrics.sample({ ...event, message: { ...event.message, usage: { ...usage(), cache_read_input_tokens: -1 } } }, 'native', 2);
    const totals = result(reason === 'unfinished' ? usage(10, 3) : usage());
    if (reason === 'cache-unknown') Reflect.deleteProperty(totals.usage, 'cache_read_input_tokens');
    if (reason === 'cache-disagrees') totals.usage.cache_read_input_tokens = 4;
    const sample = metrics.sample(totals, 'native', 3)!;
    assert.equal(sample.reconciledCalls, undefined);
    assert.equal(sample.usage?.inputTokens, 10);
    assert.equal(sample.model, undefined);
  });
}

test('Claude ignores child/foreign telemetry and clears invalid results and interrupted state', () => {
  const metrics = new ClaudeReconciledMetrics();
  metrics.sample(assistant(), 'native', 1);
  metrics.sample({ ...assistant('child'), parent_tool_use_id: 'tool' }, 'native', 2);
  metrics.sample({ ...assistant('foreign'), session_id: 'foreign' }, 'native', 3);
  metrics.sample({ ...result(), parent_tool_use_id: 'tool' }, 'native', 4);
  assert.equal(metrics.sample(result(), 'native', 5)?.reconciledCalls?.length, 1);
  metrics.sample(assistant(), 'native', 6);
  assert.equal(metrics.sample({ ...result(), usage: {} }, 'native', 7), undefined);
  assert.equal(metrics.sample(result(), 'native', 8)?.reconciledCalls, undefined);
  metrics.sample(assistant(), 'native', 9);
  metrics.close();
  assert.equal(metrics.sample(result(), 'native', 10)?.reconciledCalls, undefined);
});

test('Claude exact unknown cache semantics, numeric overflow and bounded call collection', () => {
  const metrics = new ClaudeReconciledMetrics();
  const event = assistant();
  Reflect.deleteProperty(event.message.usage, 'cache_read_input_tokens');
  Reflect.deleteProperty(event.message.usage, 'cache_creation_input_tokens');
  metrics.sample(event, 'native', 1);
  assert.equal(metrics.sample({ ...result(), usage: { input_tokens: 10, output_tokens: 2 } }, 'native', 2)?.reconciledCalls?.length, 1);
  for (let i = 0; i < 257; i++) metrics.sample(assistant(`call-${i}`), 'native', i + 3);
  assert.equal(metrics.sample(result({ input_tokens: 2570, output_tokens: 514, cache_read_input_tokens: 771, cache_creation_input_tokens: 257 }), 'native', 300)?.reconciledCalls, undefined);
  metrics.sample(assistant(), 'native', 301);
  assert.equal(metrics.sample(result(), 'native', 302)?.reconciledCalls?.length, 1, 'next turn recovers');
  for (let i = 0; i < 2; i++) metrics.sample(assistant(`huge-${i}`, 'model', usage(Number.MAX_SAFE_INTEGER, 2)), 'native', 303 + i);
  assert.equal(metrics.sample(result(usage(Number.MAX_SAFE_INTEGER, 4)), 'native', 305)?.reconciledCalls, undefined);
});

test('metrics IPC rejects forged/duplicate/unreconciled call allocations and private payloads', () => {
  const metrics = new ClaudeReconciledMetrics(); metrics.sample(assistant(), 'native', 1);
  const sample = metrics.sample(result(), 'native', 2)!;
  const call = sample.reconciledCalls![0]!;
  for (const bad of [
    { ...sample, usage: undefined }, { ...sample, model: 'ui-selected' },
    { ...sample, compacted: true }, { ...sample, context: { used: 1, basis: 'last-request-input' } },
    { ...sample, usage: { ...sample.usage, scope: 'last-call' } },
    ...[[], [call, call], [{ ...call, model: '' }], [{ ...call, id: 'bad id' }],
      [{ ...call, inputTokens: 11 }], [{ ...call, cacheReadTokens: undefined }],
      [{ ...call, outputTokens: Infinity }], [{ ...call, private: 'PRIVATE' }], Array(257).fill(call)]
      .map(reconciledCalls => ({ ...sample, reconciledCalls })),
  ]) assert.throws(() => validateSdkMetricSample(bad));
});
