import assert from 'node:assert/strict';
import test from 'node:test';
import { COPILOT_TOOL_DETAIL_CHARS, projectCopilotToolDetail, validateCopilotToolDetail } from './tool-details.js';
import { projectCopilotMessage } from './message-projection.js';
import { CopilotStreamDelivery } from './stream-delivery.js';
import type { CopilotWorkerReply } from './worker-protocol.js';
const event = (type: string, data: Record<string, unknown>) => ({ id: 'event', type, data, timestamp: '2026-09-23T00:00:00.000Z' });

test('Copilot details bound input traversal/text and omit native binary/metadata', () => {
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  const start = event('tool.execution_start', { toolCallId: 'call', toolName: 'view', arguments: {
    path: 'file.txt', image: 'PRIVATE_BINARY', nested: cycle, text: 'x'.repeat(100_000), later: 'omit',
  } });
  const detail = projectCopilotToolDetail(start, projectCopilotMessage(start))!;
  assert.ok(detail.text.length <= COPILOT_TOOL_DETAIL_CHARS); assert.equal(detail.truncated, true);
  assert.ok(!detail.text.includes('PRIVATE_BINARY')); assert.ok(detail.text.includes('file.txt'));
  const complete = event('tool.execution_complete', { toolCallId: 'call', success: true,
    result: { content: 'concise', detailedContent: 'full', binaryResultsForLlm: [{ data: 'PRIVATE_BINARY' }], contents: [{ data: 'PRIVATE_BINARY' }] } });
  assert.deepEqual(projectCopilotToolDetail(complete, projectCopilotMessage(complete)), { text: 'full', truncated: true });
  const fail = event('tool.execution_complete', { toolCallId: 'call', success: false, error: { message: 'denied', metadata: 'PRIVATE' } });
  assert.deepEqual(projectCopilotToolDetail(fail, projectCopilotMessage(fail)), { text: 'denied', truncated: false });
  assert.deepEqual(validateCopilotToolDetail({ text: 'x', truncated: false, extra: 'omitted' }, { role: 'tool' }), { text: 'x', truncated: false });
  for (const value of [null, {}, { text: 'x', truncated: 1 }, { text: 'x'.repeat(64_001), truncated: true }]) {
    assert.throws(() => validateCopilotToolDetail(value, { role: 'tool' }));
  }
  assert.throws(() => validateCopilotToolDetail(detail, { role: 'assistant' }));
});

test('Copilot IPC sends detail adjacent to summary, never in lifecycle or eager row', async () => {
  const output: CopilotWorkerReply[] = [];
  const delivery = new CopilotStreamDelivery(async reply => { output.push(reply); }, () => assert.fail('delivery'));
  delivery.send(event('tool.execution_start', { toolCallId: 'call', toolName: 'view', arguments: { path: 'LAZY_PATH' } }));
  await delivery.finish();
  assert.equal(output.length, 2);
  assert.equal(output[0]?.kind, 'event'); assert.ok(!JSON.stringify(output[0]).includes('LAZY_PATH'));
  const projection = output[1]; assert.equal(projection?.kind, 'projection');
  if (projection?.kind !== 'projection') assert.fail('missing projection');
  assert.ok(!JSON.stringify(projection.row).includes('LAZY_PATH')); assert.ok(projection.detail?.text.includes('LAZY_PATH'));
});
