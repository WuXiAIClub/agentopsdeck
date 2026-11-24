import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatMessage, SessionSummary } from '@agentopsdeck/shared';
import { DeckStore } from './deck-store.js';

function session(sessionKey: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionKey,
    agentId: sessionKey.startsWith('codex:') ? 'codex' : 'main',
    source: sessionKey.startsWith('codex:') ? 'codex' : 'openclaw',
    title: sessionKey,
    status: 'idle',
    lastActiveAt: 1_000,
    ...overrides,
  } as SessionSummary;
}

function msg(sessionKey: string, id: string, text: string, createdAt: number, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    sessionKey,
    role: 'assistant',
    text,
    createdAt,
    ...overrides,
  };
}

test('DeckStore evicts oldest cold policy-eligible transcripts and preserves sidebar metrics', () => {
  let clock = 10_000;
  const store = new DeckStore({
    maxResidentMessageSessions: 2,
    maxResidentMessageBytes: 10 * 1024 * 1024,
    minResidentIdleMs: 1_000,
    now: () => clock,
  });
  store.bindMessageEvictionPolicy(key => key.startsWith('codex:'));

  store.upsertSession(session('codex:s1', { lastActiveAt: 1_000 }));
  store.upsertSession(session('codex:s2', { lastActiveAt: 2_000 }));
  store.upsertSession(session('codex:s3', { lastActiveAt: 3_000 }));

  store.replaceMessages('codex:s1', [
    msg('codex:s1', 'm1', 'hello from s1', 5_000, { role: 'user' }),
    msg('codex:s1', 'm2', 'reply from s1 with extra tokens', 6_000),
  ]);
  const beforeEvict = store.getSession('codex:s1')!;
  assert.equal(beforeEvict.messageCount, 2);
  assert.equal(beforeEvict.lastActiveAt, 6_000);
  assert.ok((beforeEvict.estimatedTokens ?? 0) > 0);

  clock += 500;
  store.replaceMessages('codex:s2', [msg('codex:s2', 'm3', 'hello from s2', 7_000)]);

  // Advance beyond minResidentIdleMs for s1 & s2; touch s1 via getMessages so s2 becomes oldest.
  clock += 2_000;
  assert.equal(store.getMessages('codex:s1').length, 2);
  clock += 100;
  store.replaceMessages('codex:s3', [msg('codex:s3', 'm4', 'hello from s3', 8_000)]);

  assert.equal(store.hasMessages('codex:s1'), true, 'recently read transcript stays resident');
  assert.equal(store.hasMessages('codex:s2'), false, 'oldest cold transcript is evicted');
  assert.equal(store.hasMessages('codex:s3'), true);

  // Now let s1 go cold too and add s4 so s1 is evicted; verify s1 metrics remain intact.
  clock += 2_000;
  store.upsertSession(session('codex:s4', { lastActiveAt: 4_000 }));
  store.replaceMessages('codex:s4', [msg('codex:s4', 'm5', 'hello from s4', 9_000)]);
  assert.equal(store.hasMessages('codex:s1'), false);

  const afterEvict = store.getSession('codex:s1')!;
  assert.equal(afterEvict.messageCount, beforeEvict.messageCount);
  assert.equal(afterEvict.estimatedTokens, beforeEvict.estimatedTokens);
  assert.equal(afterEvict.lastActiveAt, beforeEvict.lastActiveAt);

  const stats = store.memoryStats();
  assert.equal(stats.residentMessageSessions, 2);
  assert.equal(stats.evictedMessageSessions, 2);
  assert.equal(stats.evictedTranscriptsTotal, 2);

  // Rehydrating s1 restores full messages and clears its evicted metrics entry.
  store.replaceMessages('codex:s1', [
    msg('codex:s1', 'm1', 'hello from s1', 5_000, { role: 'user' }),
    msg('codex:s1', 'm2', 'reply from s1 with extra tokens', 6_000),
  ]);
  assert.equal(store.hasMessages('codex:s1'), true);
  assert.equal(store.getMessages('codex:s1').length, 2);
});

test('DeckStore never evicts non-policy, running, recent, or fenced local-row sessions even under byte pressure', () => {
  let clock = 50_000;
  const store = new DeckStore({
    maxResidentMessageSessions: 1,
    maxResidentMessageBytes: 200,
    minResidentIdleMs: 1_000,
    now: () => clock,
  });
  store.bindMessageEvictionPolicy(key => key.startsWith('codex:'));

  store.upsertSession(session('agent:main:dashboard:openclaw-1'));
  store.upsertSession(session('codex:running', { status: 'running', hasActiveRun: true }));
  store.upsertSession(session('codex:queued'));
  store.upsertSession(session('codex:unknown'));
  store.upsertSession(session('codex:local-status'));

  store.replaceMessages('agent:main:dashboard:openclaw-1', [
    msg('agent:main:dashboard:openclaw-1', 'oc1', 'x'.repeat(400), 1_000),
  ]);
  store.replaceMessages('codex:running', [
    msg('codex:running', 'r1', 'x'.repeat(400), 1_000),
  ]);
  store.replaceMessages('codex:queued', [
    msg('codex:queued', 'q1', 'x'.repeat(400), 1_000, { role: 'user', status: 'queued' }),
  ]);
  store.replaceMessages('codex:unknown', [
    msg('codex:unknown', 'u1', 'x'.repeat(400), 1_000, { role: 'user', status: 'outcome_unknown' }),
  ]);
  store.replaceMessages('codex:local-status', [
    msg('codex:local-status', 'local-status:1', 'x'.repeat(400), 1_000),
  ]);

  clock += 10_000;
  store.upsertSession(session('codex:fresh'));
  store.replaceMessages('codex:fresh', [msg('codex:fresh', 'f1', 'x'.repeat(400), 2_000)]);

  assert.equal(store.hasMessages('agent:main:dashboard:openclaw-1'), true);
  assert.equal(store.hasMessages('codex:running'), true);
  assert.equal(store.hasMessages('codex:queued'), true);
  assert.equal(store.hasMessages('codex:unknown'), true);
  assert.equal(store.hasMessages('codex:local-status'), true);
  assert.equal(store.memoryStats().evictedTranscriptsTotal, 0);
});
