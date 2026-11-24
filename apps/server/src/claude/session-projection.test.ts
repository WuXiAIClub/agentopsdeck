import test from 'node:test';
import assert from 'node:assert/strict';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { DeckStore } from '../projection/deck-store.js';
import { ClaudeSessionProjection } from './session-projection.js';
import { projectClaudeMessage } from './message-projection.js';
import { claudeHistoryPage } from './history.js';

function fixture() {
  const source = new ConnectorUserStore(':memory:', () => true);
  const target = new DeckStore(), projection = new ClaudeSessionProjection(source, target);
  const key = 'claude-code:fixture', ref = { id: 'run', key, epoch: 'epoch' };
  source.claudeJournal.create({ key, nativeSessionId: 'native', title: 'Fixture', createdAt: 10 });
  const start = () => {
    source.turns.enqueue('claude-code', { id: 'input', sessionKey: key, createdAt: 20, payload: { text: 'Fixture input' } });
    source.claudeJournal.begin(ref, ['input'], source.turns);
  };
  const append = (uuid = 'message') => source.claudeTranscript.append(ref,
    projectClaudeMessage({ type: 'assistant', session_id: 'native', uuid,
      parent_tool_use_id: null, message: { role: 'assistant', content: 'Fixture reply' } }, 'native'));
  return { source, target, projection, key, ref, start, append };
}

test('Claude durable changes reach DeckStore without polling native history or manufacturing metrics', () => {
  const f = fixture();
  try {
    f.projection.publish(f.key, false);
    assert.equal(f.target.getSession(f.key)?.status, 'unknown');
    f.start(); f.append(); f.projection.publish(f.key, true);
    assert.equal(f.target.getSession(f.key)?.runtime?.phase, 'starting');
    assert.equal(f.target.getMessages(f.key)[0]?.text, 'Fixture reply');
    assert.equal(f.target.getSession(f.key)?.totalTokens, undefined);
    assert.equal(f.target.getSession(f.key)?.contextUsedTokens, undefined);
    const revision = f.target.changes.revision;
    f.projection.publish(f.key, true);
    assert.equal(f.target.changes.revision, revision, 'identical refresh must not create an SSE loop');
    f.source.claudeJournal.observeTerminal(f.ref, 'completed', f.source.turns);
    f.projection.publish(f.key, true);
    assert.equal(f.target.getSession(f.key)?.runtime?.phase, 'finalizing');
    assert.equal(f.target.getSession(f.key)?.hasActiveRun, true);
    f.source.claudeJournal.confirmSettled(f.ref); f.projection.publish(f.key, true);
    assert.equal(f.target.getSession(f.key)?.runtime?.phase, 'completed');
  } finally { f.source.close(); }
});

test('Gateway refresh/outage/events cannot replace or terminate an SDK-owned session', () => {
  const f = fixture();
  try {
    f.start(); f.append(); f.projection.publish(f.key, true);
    const before = f.target.getSession(f.key);
    f.target.replaceSessions([{ sessionKey: f.key, agentId: 'openclaw', title: 'Wrong', status: 'idle' }]);
    f.target.replaceSessions([]);
    assert.equal(f.target.ingestGatewayEvent({ event: 'chat', payload: { sessionKey: f.key,
      state: 'final', message: { role: 'assistant', content: 'Wrong reply' } } }), false);
    f.target.invalidateOpenClawExecutionFacts();
    assert.deepEqual(f.target.getSession(f.key), before);
    assert.equal(f.target.getMessages(f.key).length, 2);
  } finally { f.source.close(); }
});

test('SDK transcript terminal-looking text cannot end an in-progress turn', () => {
  const f = fixture();
  try {
    f.start(); f.projection.publish(f.key, true);
    f.target.replaceMessages(f.key, [{ id: 'child', sessionKey: f.key, role: 'assistant', status: 'sent',
      parentToolUseId: 'parent', text: 'Done', createdAt: Date.now() + 1000 }]);
    assert.equal(f.target.getSession(f.key)?.runtime?.phase, 'starting');
    assert.equal(f.target.getSession(f.key)?.status, 'running');
  } finally { f.source.close(); }
});

test('Legacy usage refresh cannot overwrite either SDK runtime state or invent token metrics', () => {
  const target = new DeckStore();
  for (const id of ['claude-code', 'ghcp'] as const) {
    const key = `${id}:fixture`;
    target.upsertSession({ sessionKey: key, agentId: id, source: id, title: id, status: 'running', hasActiveRun: true });
    const before = target.getSession(key), revision = target.changes.revision;
    target.applySessionUsage(new Map([[key, { status: 'idle', hasActiveRun: false, totalTokens: 999,
      contextUsedTokens: 500, title: 'Wrong runtime', source: 'openclaw' }]]));
    assert.deepEqual(target.getSession(key), before);
    assert.equal(target.changes.revision, revision);
  }
  target.upsertSession({ sessionKey: 'agent:main:dashboard:fixture', agentId: 'main', title: 'Main', status: 'idle', source: 'openclaw' });
  target.applySessionUsage(new Map([['agent:main:dashboard:fixture', { totalTokens: 42 }]]));
  assert.equal(target.getSession('agent:main:dashboard:fixture')?.totalTokens, 42, 'Existing usage feed remains supported');
});

test('Claude latest projection stays bounded while older native messages remain pageable', () => {
  const f = fixture();
  try {
    f.start();
    for (let i = 0; i < 201; i++) f.append(`m${i}`);
    const first = f.projection.publish(f.key, true);
    assert.ok(first);
    assert.equal(first.hiddenCount, 2); assert.equal(f.target.getMessages(f.key).length, 200);
    f.append('new'); f.projection.publish(f.key, true);
    assert.equal(f.target.getMessages(f.key).length, 200);
    assert.equal(claudeHistoryPage(f.source, f.key, 200, first.messages[0]!.id)!.messages.length, 2);
  } finally { f.source.close(); }
});

test('Claude projection failure is retryable from durable truth, never remembered as success', () => {
  const f = fixture(); let fail = true, sessions = 0;
  const projection = new ClaudeSessionProjection(f.source, {
    removeSession: key => f.target.removeSession(key),
    upsertSession: summary => { sessions++; f.target.upsertSession(summary); },
    replaceMessages: (key, rows, options) => {
      if (fail) throw new Error('fixture unavailable');
      f.target.replaceMessages(key, rows, options);
    },
  });
  try {
    f.start(); f.append(); assert.throws(() => projection.publish(f.key, true));
    fail = false; projection.publish(f.key, true);
    assert.equal(sessions, 2); assert.equal(f.target.getMessages(f.key).length, 2);
    assert.throws(() => projection.publish('claude-code:other', true));
  } finally { f.source.close(); }
});

test('Child message scope changes emit an update and never consume a root echo', () => {
  const target = new DeckStore(), key = 'claude-code:fixture';
  const root = { id: 'root', sessionKey: key, role: 'user' as const, status: 'sent' as const,
    text: 'Same text', createdAt: 10 };
  target.replaceMessages(key, [root]);
  target.replaceMessages(key, [{ ...root, id: 'child', parentToolUseId: 'native-parent' }]);
  assert.equal(target.getMessages(key).length, 2);
  const revision = target.changes.revision;
  target.replaceMessages(key, [{ ...root, id: 'child', parentToolUseId: 'other-parent', contentTruncated: true }]);
  assert.ok(target.changes.revision > revision);
});

test('Both SDK runtimes survive Gateway replacement without enabling their discovery', () => {
  const target = new DeckStore();
  for (const id of ['claude-code', 'ghcp']) target.upsertSession({ sessionKey: `${id}:fixture`, agentId: id,
    source: id, title: id, status: 'running', hasActiveRun: true });
  target.replaceSessions([]);
  for (const id of ['claude-code', 'ghcp']) assert.equal(target.getSession(`${id}:fixture`)?.status, 'running');
  target.replaceSessions([{ sessionKey: 'ghcp:foreign', agentId: 'ghcp', source: 'ghcp', status: 'idle' }]);
  assert.equal(target.getSession('ghcp:foreign'), undefined);
});
