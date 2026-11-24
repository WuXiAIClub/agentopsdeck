import assert from 'node:assert/strict';
import test from 'node:test';
import { projectClaudeMessage } from './message-projection.js';
import { CLAUDE_TOOL_DETAIL_CHARS as limit, projectClaudeToolDetails, validateClaudeToolDetails } from './tool-details.js';

const event = (content: unknown[], type = 'assistant') => ({ type, uuid: 'message', session_id: 'native',
  parent_tool_use_id: null, message: { role: type, content } });
const call = (input: unknown, id = 'tool') => ({ type: 'tool_use', id, name: 'Read', input });

test('tool detail bounds traversal, serialized escaping and the entire envelope', () => {
  for (const input of ['中'.repeat(100_000), '\u0000'.repeat(100_000), Array(10000).fill({ nested: 'data' })]) {
    const details = projectClaudeToolDetails(event([call(input), call(input, 'second')]), 'native');
    assert.ok(details.reduce((sum, row) => sum + row.text.length, 0) <= limit);
    assert.equal(details[0]!.truncated, true);
  }
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  assert.equal(projectClaudeToolDetails(event([call(cycle)]), 'native')[0]!.truncated, true);
  let deep: unknown = 'deep-secret';
  for (let i = 0; i < 100; i++) deep = { nested: deep };
  assert.equal(projectClaudeToolDetails(event([call(deep)]), 'native')[0]!.text.includes('deep-secret'), false);
});

test('tool detail excludes binary blocks, thinking and known embedded binary fields', () => {
  const details = projectClaudeToolDetails(event([call({ path: '/workspace/file', image: 'PRIVATE_IMAGE',
    source: 'data:image/png;base64,PRIVATE_DATA' }), { type: 'thinking', thinking: 'PRIVATE_THINKING' }]), 'native');
  assert.match(details[0]!.text, /workspace/);
  assert.equal(JSON.stringify(details).includes('PRIVATE'), false);
  const result = projectClaudeToolDetails(event([{ type: 'tool_result', tool_use_id: 'tool', content: [
    { type: 'text', text: 'visible' }, { type: 'image', source: { data: 'PRIVATE_IMAGE' } },
  ] }], 'user'), 'native');
  assert.deepEqual(result, [{ blockIndex: 0, text: 'visible', truncated: true }]);
});

test('tool IPC details require matching tool blocks and reject malformed or excessive data', () => {
  const native = event([call({ path: 'file' }), { type: 'text', text: 'reply' }]);
  const rows = projectClaudeMessage(native, 'native');
  const good = { blockIndex: 0, text: 'input', truncated: false };
  assert.deepEqual(validateClaudeToolDetails([{ ...good, privateField: 'omitted' }], rows), [good]);
  for (const input of [null, [good, good], [{ ...good, blockIndex: 1 }], [{ ...good, blockIndex: -1 }],
    [{ ...good, truncated: 'false' }], [{ ...good, text: 'x'.repeat(limit + 1) }]]) {
    assert.throws(() => validateClaudeToolDetails(input, rows));
  }
  assert.throws(() => projectClaudeToolDetails(native, 'foreign'));
});
