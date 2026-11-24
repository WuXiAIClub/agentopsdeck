// Native compaction on disposable fixture sessions only. Never treat an
// ordinary assistant reply or a summary prompt as compaction confirmation.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export async function verifyClaudeCompact({ query, getSessionMessages, root, env, sessionId, expectedReply }) {
  const id = randomUUID();
  async function* prompt() {
    yield { type: 'user', uuid: id, session_id: sessionId, parent_tool_use_id: null,
      message: { role: 'user', content: '/compact' } };
  }
  const events = [], stream = query({ prompt: prompt(), options: {
    cwd: root, env, settingSources: [], tools: [], permissionMode: 'default',
    canUseTool: async () => ({ behavior: 'deny', message: 'Fixture denies all tools' }),
    model: 'claude-sonnet-4-6', systemPrompt: 'Return a brief reply.',
    resume: sessionId, extraArgs: { 'replay-user-messages': null },
  } });
  try { for await (const event of stream) events.push(event); }
  finally { stream.close(); }
  const boundary = events.find(e => e.type === 'system' && e.subtype === 'compact_boundary');
  const result = events.find(e => e.type === 'result');
  // Only enumerated facts/identities leave the fixture; no raw provider data.
  console.log('Claude compact POC', JSON.stringify({ boundary: !!boundary,
    nativeIdentity: boundary?.session_id === sessionId,
    trigger: boundary?.compact_metadata?.trigger,
    result: !!result, error: result?.is_error,
    resultCorrelated: result?.user_message_uuid === id,
    replayedUser: events.some(e => e.type === 'user' && e.uuid === id),
    eventKinds: [...new Set(events.map(e => `${e.type}:${e.subtype ?? ''}`))],
  }));
  assert.ok(boundary, 'Native compact boundary required, not a textual summary');
  assert.equal(boundary.session_id, sessionId);
  assert.equal(boundary.compact_metadata.trigger, 'manual');
  assert.equal(result?.is_error, false);
  assert.equal(result.user_message_uuid, id, 'Result must confirm this compact request');
  const persisted = await getSessionMessages(sessionId, { dir: root, includeSystemMessages: true });
  assert.ok(persisted.some(e => e.uuid === boundary.uuid), 'Native compact boundary must persist');
  const followup = query({ prompt: 'Fixture explicit follow-up after compact', options: {
    cwd: root, env, settingSources: [], tools: [], permissionMode: 'default',
    canUseTool: async () => ({ behavior: 'deny', message: 'Fixture denies all tools' }),
    model: 'claude-sonnet-4-6', systemPrompt: 'Return a brief reply.', maxTurns: 1, resume: sessionId,
  } });
  const resumed = [];
  try { for await (const event of followup) resumed.push(event); }
  finally { followup.close(); }
  const final = resumed.find(e => e.type === 'result');
  assert.equal(final?.session_id, sessionId);
  assert.equal(final?.is_error, false);
  assert.equal(final?.result, expectedReply);
  const finalHistory = await getSessionMessages(sessionId, { dir: root, includeSystemMessages: true });
  assert.ok(finalHistory.some(e => e.uuid === boundary.uuid));
  assert.ok(finalHistory.some(e => e.uuid === resumed.find(e => e.type === 'assistant')?.uuid));
  console.log('Claude compact POC: persisted boundary, fresh-process follow-up and history passed');
}

export async function verifyCopilotCompact(session) {
  assert.equal(typeof session.rpc.history.compact, 'function');
  const events = [], unsubscribe = session.on(e => events.push(e));
  let result;
  try { result = await session.rpc.history.compact({ trigger: 'manual' }); }
  finally { unsubscribe(); }
  const complete = events.find(e => e.type === 'session.compaction_complete');
  console.log('Copilot compact POC', JSON.stringify({ success: result.success,
    tokensRemoved: result.tokensRemoved, messagesRemoved: result.messagesRemoved,
    start: events.some(e => e.type === 'session.compaction_start'),
    complete: !!complete, eventSuccess: complete?.data.success,
    trigger: complete?.data.trigger,
    userMessage: events.some(e => e.type === 'user.message'),
    idle: events.some(e => e.type === 'session.idle'),
  }));
  assert.equal(result.success, true);
  assert.ok(Number.isSafeInteger(result.tokensRemoved) && result.tokensRemoved >= 0);
  assert.ok(Number.isSafeInteger(result.messagesRemoved) && result.messagesRemoved >= 0);
  assert.equal(complete?.data.success, true);
  assert.equal(complete.data.trigger, 'manual');
  assert.equal(events.some(e => e.type === 'user.message'), false);
  const persisted = await session.getEvents();
  assert.ok(persisted.some(e => e.id === complete.id), 'Native successful compaction must persist');
  return complete.id;
}

export async function verifyCopilotAfterCompact(session, compactId, expectedReply) {
  const history = await session.getEvents();
  assert.ok(history.some(e => e.id === compactId && e.type === 'session.compaction_complete' && e.data.success));
  const events = [];
  let done, fail;
  const finished = new Promise((resolve, reject) => { done = resolve; fail = reject; });
  finished.catch(() => {});
  const unsubscribe = session.on(e => {
    events.push(e);
    if (e.type === 'session.idle') done();
    if (e.type === 'session.error') fail(new Error('Native post-compact follow-up failed'));
  });
  try { await session.send('Fixture explicit follow-up after compact'); await finished; }
  finally { unsubscribe(); }
  const assistant = events.find(e => e.type === 'assistant.message' && e.data.content === expectedReply);
  assert.ok(assistant);
  assert.equal(events.filter(e => e.type === 'user.message').length, 1);
  const after = await session.getEvents();
  assert.ok(after.some(e => e.id === compactId));
  assert.ok(after.some(e => e.id === assistant.id));
  console.log('Copilot compact POC: fresh-process persisted boundary, follow-up and history passed');
}
