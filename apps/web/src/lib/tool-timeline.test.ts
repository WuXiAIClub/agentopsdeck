import assert from 'node:assert/strict';
import test from 'node:test';
import { compactToolEntryCount, groupedToolElapsedMs, isToolExecuting, toolVariantFromLabel } from './tool-timeline.js';

test('only an active unpaired tool call is shown as executing', () => {
  assert.equal(isToolExecuting({ status: 'sending' }), true);
  assert.equal(isToolExecuting({ status: 'sent' }), false);
  assert.equal(isToolExecuting({ status: 'failed' }), false);
  assert.equal(isToolExecuting({ status: 'sending' }, { status: 'sent' }), false);
});

test('grouped tool elapsed time uses the call-to-result duration', () => {
  assert.equal(groupedToolElapsedMs({ createdAt: 1_000 }, { createdAt: 2_375 }, { createdAt: 2_375 }), 1_375);
});

test('grouped tool elapsed time falls back to the next message for an unpaired call', () => {
  assert.equal(groupedToolElapsedMs({ createdAt: 1_000 }, undefined, { createdAt: 1_250 }), 250);
  assert.equal(groupedToolElapsedMs({ createdAt: 1_000 }), undefined);
});

test('Codex nested and native tool names retain their visual categories', () => {
  assert.equal(toolVariantFromLabel('Tool: exec_command'), 'exec');
  assert.equal(toolVariantFromLabel('exec_command'), 'exec');
  assert.equal(toolVariantFromLabel('view_image'), 'media');
  assert.equal(toolVariantFromLabel('functions.apply_patch'), 'file');
  assert.equal(toolVariantFromLabel('spawn_agent + send_message'), 'subagent');
  assert.equal(toolVariantFromLabel('wait_agent'), 'subagent');
  assert.equal(toolVariantFromLabel('multi_agent_v1__wait_agent'), 'subagent');
  assert.equal(toolVariantFromLabel('multi_agent_v1__close_agent'), 'subagent');
  assert.equal(toolVariantFromLabel('multi_agent_v1__send_input'), 'agent-call');
  assert.equal(toolVariantFromLabel('update_plan'), 'server');
  assert.equal(toolVariantFromLabel('agentopsdeck_board_read'), 'server');
  assert.equal(toolVariantFromLabel('custom_unknown_tool'), undefined);
});

test('older entries compact beyond the recent six-chip window', () => {
  assert.equal(compactToolEntryCount(0), 0);
  assert.equal(compactToolEntryCount(6), 0);
  assert.equal(compactToolEntryCount(8), 2);
});
