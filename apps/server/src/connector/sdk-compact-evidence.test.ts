import assert from 'node:assert/strict';
import test from 'node:test';
import { ClaudeCompactEvidence } from '../claude/compact-evidence.js';
import { copilotManualCompactId } from '../copilot/compact-evidence.js';
import { sdkCompactTimeout } from './sdk-compact-config.js';

test('Claude requires exact manual stream boundary, correlated result and root persisted identity', () => {
  const boundary = { type: 'system', subtype: 'compact_boundary', session_id: 'session', uuid: 'boundary', compact_metadata: { trigger: 'manual' } };
  const result = { type: 'result', session_id: 'session', is_error: false, user_message_uuid: 'request' };
  const row = { type: 'system', session_id: 'session', uuid: 'boundary', parent_tool_use_id: null, parent_agent_id: null };
  const evidence = new ClaudeCompactEvidence('session', 'request');
  assert.throws(() => evidence.persisted([row]));
  assert.throws(() => evidence.observe(result));
  evidence.observe(boundary);
  assert.throws(() => evidence.observe({ ...result, user_message_uuid: 'other' }));
  evidence.observe(result);
  for (const invalid of [{ ...row, session_id: 'other' }, { ...row, type: 'assistant' }, { ...row, uuid: 'other' }, { ...row, parent_tool_use_id: 'child' }]) {
    assert.throws(() => evidence.persisted([invalid]));
  }
  assert.equal(evidence.persisted([row]), 'boundary');
  assert.throws(() => new ClaudeCompactEvidence('session', 'request').observe({ ...boundary, compact_metadata: { trigger: 'auto' } }));
});
test('Copilot only accepts root successful manual compaction boundaries', () => {
  const event = { type: 'session.compaction_complete', id: 'boundary', data: { success: true, trigger: 'manual' } };
  assert.equal(copilotManualCompactId(event), 'boundary');
  for (const invalid of [{ ...event, agentId: 'child' }, { ...event, data: { ...event.data, parentToolCallId: 'child' } },
    { ...event, data: { success: false, trigger: 'manual' } }, { ...event, data: { success: true, trigger: 'auto' } }, { type: 'session.idle' }]) {
    assert.equal(copilotManualCompactId(invalid), undefined);
  }
});
test('compact timeout is independently configured with strict safe bounds', () => {
  for (const prefix of ['AOD_CLAUDE_', 'AOD_COPILOT_']) {
    assert.equal(sdkCompactTimeout({}, prefix), 600000);
    assert.equal(sdkCompactTimeout({ [`${prefix}COMPACT_TIMEOUT_MS`]: '300000' }, prefix), 300000);
    for (const raw of ['', '-1', '100', '1800001', 'NaN', '1000ms', '1e4']) assert.throws(() => sdkCompactTimeout({ [`${prefix}COMPACT_TIMEOUT_MS`]: raw }, prefix));
  }
});
