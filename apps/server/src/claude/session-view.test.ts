import test from 'node:test';
import assert from 'node:assert/strict';
import type { SdkExecution, SdkSession } from '../connector/sdk-execution-journal.js';
import { claudeChatMessages, claudeSessionView } from './session-view.js';
import type { ClaudeStoredMessage } from './transcript-store.js';

const session: SdkSession = { key: 'claude-code:fixture', nativeSessionId: 'native', title: 'Fixture', createdAt: 10, nativeState: 'ready' };
const execution = (phase: SdkExecution['phase']): SdkExecution => ({ id: 'run', key: session.key,
  epoch: 'epoch', nativeSessionId: session.nativeSessionId, members: ['input'], nativeMode: 'resume',
  phase, stopRequested: false, createdAt: 20, updatedAt: 30 });
const message = (parentToolUseId: string | null = null): ClaudeStoredMessage => ({ sessionKey: session.key,
  cursor: '1', executionId: 'run', nativeMessageId: 'message', createdAt: 25,
  rows: [{ nativeMessageId: 'message', blockIndex: 0, parentToolUseId, role: 'assistant',
    text: 'Fixture reply', truncated: false, detailAvailable: false }] });

test('Claude views keep dispatch/running/settlement busy and only proven terminal phases complete', () => {
  for (const [native, phase] of [['dispatching', 'starting'], ['running', 'running'], ['settling', 'finalizing']] as const) {
    const view = claudeSessionView(session, execution(native), true);
    assert.equal(view.runtime?.phase, phase); assert.equal(view.status, 'running');
    assert.equal(view.hasActiveRun, true); assert.equal(view.runCompletedAt, undefined);
  }
  for (const phase of ['completed', 'failed', 'interrupted'] as const) {
    const view = claudeSessionView(session, execution(phase), true);
    assert.equal(view.runtime?.phase, phase); assert.equal(view.hasActiveRun, false);
    assert.equal(view.runCompletedAt, 30); assert.equal(view.status, phase === 'failed' ? 'failed' : 'idle');
  }
});

test('Claude new sessions never manufacture Done; unknown materialization cannot advertise idle', () => {
  const allocated = { ...session, nativeState: 'allocated' as const };
  assert.equal(claudeSessionView(allocated, undefined, true).runtime, undefined);
  assert.equal(claudeSessionView(allocated, undefined, true).status, 'idle');
  assert.equal(claudeSessionView(allocated, undefined, false).status, 'unknown');
  for (const nativeState of ['unknown', 'starting'] as const) {
    assert.equal(claudeSessionView({ ...session, nativeState }, undefined, true).status, 'unknown');
  }
  const view = claudeSessionView({ ...session, nativeState: 'unknown' }, execution('completed'), true);
  assert.equal(view.runtime?.phase, 'unknown'); assert.equal(view.runCompletedAt, undefined);
});

test('Claude transport outage does not rewrite durable outcome or pretend active work has stopped', () => {
  for (const phase of ['running', 'completed', 'interrupted', 'unknown'] as const) {
    const view = claudeSessionView(session, execution(phase), false);
    assert.equal(view.runtime?.phase, phase); assert.equal(view.runtime?.connection, 'disconnected');
    assert.equal(view.runtime?.sync, 'current');
    assert.equal(view.hasActiveRun, phase === 'running');
  }
  assert.equal(claudeSessionView(session, execution('unknown'), true).status, 'unknown');
});

test('Claude session and message projections reject cross-session identity', () => {
  assert.throws(() => claudeSessionView(session, { ...execution('running'), key: 'claude-code:other' }, true));
  assert.throws(() => claudeSessionView(session, { ...execution('running'), nativeSessionId: 'other' }, true));
  assert.throws(() => claudeChatMessages('claude-code:other', [message()]));
  assert.throws(() => claudeChatMessages('codex:fixture', []));
  assert.throws(() => claudeChatMessages(session.key, [{ ...message(), nativeMessageId: 'other' }]));
});

test('Claude message identity/order/timestamps remain stable without inventing final answer or usage', () => {
  const stored = message();
  stored.rows.push({ ...stored.rows[0]!, blockIndex: 2, text: 'Second block' });
  const first = claudeChatMessages(session.key, [stored]);
  assert.deepEqual(claudeChatMessages(session.key, [structuredClone(stored)]), first);
  assert.notEqual(first[0]!.id, first[1]!.id); assert.equal(first[0]!.createdAt, 25);
  assert.equal(first[0]!.turnId, 'run'); assert.equal(first[0]!.phase, undefined);
  assert.equal(first[0]!.totalTokens, undefined); assert.equal(first[0]!.parentToolUseId, undefined);
});

test('Claude tool IDs are paired within root/child scope, never across child workers', () => {
  const call = message();
  call.rows[0] = { ...call.rows[0]!, role: 'tool', text: 'Read', toolName: 'Read', toolCallId: 'tool',
    toolPhase: 'call', detailAvailable: true };
  const result = message(); result.nativeMessageId = 'result';
  result.rows[0] = { ...call.rows[0], nativeMessageId: 'result', toolPhase: 'result', text: 'Denied', toolError: true };
  const child = structuredClone(call); child.rows[0]!.parentToolUseId = 'tool';
  const [rootCall, rootResult, childCall] = claudeChatMessages(session.key, [call, result, child]);
  assert.equal(rootCall!.toolCallId, rootResult!.toolCallId);
  assert.notEqual(rootCall!.toolCallId, childCall!.toolCallId);
  assert.equal(childCall!.parentToolUseId, 'tool');
  assert.equal(rootResult!.status, 'failed'); assert.equal(rootCall!.toolDetailAvailable, false);
  assert.notEqual(rootCall!.id, childCall!.id);
});

test('Claude truncation is explicit; child assistant is not promoted to root final answer', () => {
  const stored = message('parent'); stored.rows[0]!.truncated = true;
  const [row] = claudeChatMessages(session.key, [stored]);
  assert.equal(row!.contentTruncated, true); assert.ok(row!.parentToolUseId);
  assert.equal(row!.phase, undefined);
  stored.rows[0]!.role = 'user';
  assert.equal(claudeChatMessages(session.key, [stored])[0]!.status, 'sent');
});
