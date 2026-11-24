import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ChatMessage, DeckEvent, SessionSummary } from '@agentopsdeck/shared';
import { DeckStore } from './deck-store.js';
import { ChangeSignal } from '../utils/change-signal.js';

test('async event sink owns batches and forbids synchronous cursor fallbacks', () => {
  const batches: (readonly DeckEvent[])[] = [], changes = new ChangeSignal();
  const projectionEvents = { changes, append: (events: readonly DeckEvent[]) => { batches.push(events); } };
  const store = new DeckStore({ projectionEvents });
  assert.equal(store.changes, changes);
  assert.equal(store.requiresAsyncEvents, true);
  const local = store.append('session.updated', { text: 'local observation only' });
  assert.equal(batches[0]?.[0], local);
  store.replaceSessions([{ sessionKey: 'agent:test:dashboard:a', agentId: 'test', title: 'A', status: 'idle', updatedAt: 1 }]);
  assert.equal(batches.length, 2);
  assert.equal(store.getSession('agent:test:dashboard:a')?.title, 'A');
  for (const read of [() => store.latestEventId(), () => store.hasEvent(local.id), () => store.getEventsSince(local.id),
    () => store.getSessionDirectory()]) assert.throws(read, /awaited owner ports/);
  assert.doesNotThrow(() => store.getSessionDirectory({}, 'durable-owner-cursor'));
  assert.throws(() => new DeckStore({ projectionEvents, eventLog: {} as any }), /owners cannot be mixed/);
});

test('projection wakeup follows successful durable append, never failed persistence', async () => {
  let fail = true;
  const store = new DeckStore({ eventLog: {
    append: event => { if (fail) throw new Error('disk unavailable'); return { ...event, id: 'durable-id' }; },
    appendBatch: () => { throw new Error('unexpected batch'); },
    latestEventId: () => '', hasEvent: () => false, getEventsSince: () => [],
  } });
  const controller = new AbortController();
  const pending = store.changes.wait(store.changes.revision, controller.signal);
  assert.throws(() => store.append('session.updated', {}), /disk unavailable/);
  assert.equal(store.changes.revision, 0);
  assert.equal(store.changes.waiting, 1);
  fail = false;
  assert.equal(store.append('session.updated', {}).id, 'durable-id');
  await pending;
  assert.equal(store.changes.waiting, 0);
  const memory = new DeckStore();
  memory.append('session.updated', {});
  assert.equal(memory.changes.revision, 1);
});

const sessionKey = 'agent:ops-dev:feishu:direct:user-1';
const baseTime = 1_800_000_000_000;

test('unchanged native catalog upserts do not publish events or wake readers', () => {
  const store = new DeckStore();
  const session: SessionSummary = { sessionKey: 'codex:catalog', title: 'Catalog', status: 'idle',
    source: 'codex', lastActiveAt: baseTime, controlCapabilities: { compact: true, attachments: true } };
  store.upsertSession(session);
  const revision = store.changes.revision;
  for (let n = 0; n < 20; n++) store.upsertSession(structuredClone(session));
  assert.equal(store.changes.revision, revision, 'a fresh object is not a new observation');
  // Do not use a partial field comparator: metadata changes must still reach
  // clients, including fields not considered by gateway catalog comparison.
  for (const patch of [{ title: 'Renamed' }, { totalTokensFresh: true }, { pendingSubagentCount: 1 },
    { controlCapabilities: { compact: false } }, { codexGoal: null }]) {
    const before = store.changes.revision;
    const next = { ...session, ...patch };
    store.upsertSession(next);
    assert.equal(store.changes.revision, before + 1);
    store.upsertSession(structuredClone(next));
    assert.equal(store.changes.revision, before + 1);
    store.upsertSession(session);
  }
});

test('file evidence changes publish a delta even when the tool summary is unchanged', () => {
  const store = new DeckStore();
  const message: ChatMessage = { id: 'file-evidence', sessionKey, role: 'tool', toolPhase: 'result', text: 'done', createdAt: baseTime, status: 'sent' };
  store.replaceMessages(sessionKey, [message]);
  const before = store.changes.revision;
  const enriched: ChatMessage = { ...message, sourceFiles: [{ path: '/repo/changed.ts', kind: 'modified' }] };
  store.replaceMessages(sessionKey, [enriched]);
  assert.ok(store.changes.revision > before);
  const unchanged = store.changes.revision;
  store.replaceMessages(sessionKey, [enriched]);
  assert.equal(store.changes.revision, unchanged);
  store.replaceMessages(sessionKey, [message]);
  assert.ok(store.changes.revision > unchanged, 'removing unsupported evidence must also be visible');
});

test('queue version and disposition changes publish deltas even when message text is unchanged', () => {
  const store = new DeckStore();
  const message: ChatMessage = { id: 'queued', sessionKey, role: 'user', text: 'same text', createdAt: baseTime,
    status: 'queued', queueVersion: 'opaque-1', queueDisposition: 'preparing' };
  store.replaceMessages(sessionKey, [message]);
  const revision = store.changes.revision;
  store.replaceMessages(sessionKey, [{ ...message, queueVersion: 'opaque-2' }]);
  assert.ok(store.changes.revision > revision);
  const next = store.changes.revision;
  store.replaceMessages(sessionKey, [{ ...message, queueVersion: 'opaque-2', queueDisposition: 'waiting' }]);
  assert.ok(store.changes.revision > next);
  const unchanged = store.changes.revision;
  store.replaceMessages(sessionKey, [{ ...message, queueVersion: 'opaque-2', queueDisposition: 'waiting' }]);
  assert.equal(store.changes.revision, unchanged);
});

test('session replacement installs all rows before one batch and emits nothing when later mapping fails', () => {
  const batches: DeckEvent[][] = [];
  const store: DeckStore = new DeckStore({ eventLog: {
    append: () => { throw new Error('unexpected per-row append'); },
    appendBatch: events => {
      assert.equal(store.getSession('agent:ops-dev:dashboard:a')?.title, 'A');
      assert.equal(store.getSession('agent:ops-dev:dashboard:b')?.title, 'B');
      assert.equal(store.changes.revision, 0, 'no wake before batch persistence');
      batches.push([...events]);
    },
    latestEventId: () => '', hasEvent: () => false, getEventsSince: () => [],
  } });
  const rows = ['a', 'b'].map(id => ({ sessionKey: `agent:ops-dev:dashboard:${id}`, agentId: 'ops-dev', title: id.toUpperCase(), status: 'idle', updatedAt: baseTime }));
  store.replaceSessions(rows);
  assert.equal(batches.length, 1); assert.equal(batches[0]?.length, 2); assert.equal(store.changes.revision, 1);
  const broken = { ...rows[1], get agentId() { throw new Error('malformed later row'); } };
  assert.throws(() => store.replaceSessions([{ ...rows[0], title: 'Changed' }, broken]), /malformed later row/);
  assert.equal(batches.length, 1); assert.equal(store.getSession(rows[0]!.sessionKey)?.title, 'A');
});

test('in-memory batch fallback retains only 500 events and wakes once per replacement', () => {
  const store = new DeckStore();
  const messages = Array.from({ length: 600 }, (_, n) => ({ id: String(n), sessionKey, role: 'assistant' as const, text: String(n), createdAt: n }));
  store.replaceMessages(sessionKey, messages);
  assert.equal(store.changes.revision, 1);
  assert.equal((store as unknown as { events: DeckEvent[] }).events.length, 500);
  const floor = store.getEventsSince().at(0)!;
  assert.equal(store.getEventsSince(floor.id).length, 49);
  assert.equal(store.hasEvent(floor.id), true);
  assert.equal(store.getMessages(sessionKey).length, 600, 'event retention does not discard history');
});

function mediaMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'message-' + Math.random().toString(36).slice(2),
    sessionKey,
    role: 'user',
    text: '',
    media: [{ type: 'image', url: '/api/media/local/screenshot.png', name: 'screenshot.png', mimeType: 'image/png' }],
    createdAt: baseTime,
    ...overrides,
  };
}

test('replaceMessages merges local text+media echo into matching Gateway text-only row', () => {
  const store = new DeckStore();
  const local = mediaMessage({ id: 'local-upload', status: 'sent', text: 'see screenshot', createdAt: baseTime });
  const gateway: ChatMessage = {
    id: 'gateway-history',
    sessionKey,
    role: 'user',
    text: 'see screenshot',
    createdAt: baseTime + 1_000,
  };

  store.addMessage(local);
  store.replaceMessages(sessionKey, [gateway]);

  const messages = store.getMessages(sessionKey);
  assert.deepEqual(messages.map((message) => message.id), ['gateway-history']);
  assert.equal(messages[0]?.media?.[0]?.name, 'screenshot.png');
});

test('replaceMessages removes a local text echo when Gateway history has OpenClaw timestamp envelope nearby', () => {
  const store = new DeckStore();
  const local: ChatMessage = {
    id: 'local-text-echo',
    sessionKey,
    role: 'user',
    text: '飞书先等等， 先占位， DNS是腾讯云，可以先占位， 或者我去做',
    createdAt: baseTime,
    status: 'sent',
  };
  const gateway: ChatMessage = {
    id: 'gateway-transcript-row',
    sessionKey,
    role: 'user',
    text: '[Mon 2026-07-06 02:58 UTC] 飞书先等等， 先占位， DNS是腾讯云，可以先占位， 或者我去做',
    createdAt: baseTime + 11_000,
  };

  store.addMessage(local);
  store.replaceMessages(sessionKey, [gateway]);

  const messages = store.getMessages(sessionKey);
  assert.deepEqual(messages.map((message) => message.id), ['gateway-transcript-row']);
  assert.equal(messages[0]?.text, gateway.text);
});

test('replaceMessages removes a local media echo when Gateway history has matching media metadata nearby', () => {
  const store = new DeckStore();
  const local = mediaMessage({ id: 'local-upload', status: 'sent', createdAt: baseTime });
  const gateway = mediaMessage({
    id: 'gateway-history',
    media: [{ type: 'image', url: '/api/media/inbound/screenshot.png', name: 'screenshot.png', mimeType: 'image/png' }],
    createdAt: baseTime + 1_000,
  });

  store.addMessage(local);
  store.replaceMessages(sessionKey, [gateway]);

  assert.deepEqual(store.getMessages(sessionKey).map((message) => message.id), ['gateway-history']);
});

test('replaceMessages preserves repeated media sends outside the local echo window', () => {
  const store = new DeckStore();
  const local = mediaMessage({ id: 'local-second-send', status: 'sent', createdAt: baseTime + 180_000 });
  const gateway = mediaMessage({
    id: 'gateway-first-send',
    media: [{ type: 'image', url: '/api/media/inbound/screenshot.png', name: 'screenshot.png', mimeType: 'image/png' }],
    createdAt: baseTime,
  });

  store.addMessage(local);
  store.replaceMessages(sessionKey, [gateway]);

  assert.deepEqual(store.getMessages(sessionKey).map((message) => message.id), ['gateway-first-send', 'local-second-send']);
});

test('replaceMessages consumes each Gateway media match once so a second pending repeat remains visible', () => {
  const store = new DeckStore();
  const firstLocal = mediaMessage({ id: 'local-first-send', status: 'sent', createdAt: baseTime });
  const secondLocal = mediaMessage({ id: 'local-second-send', status: 'sending', createdAt: baseTime + 5_000 });
  const gateway = mediaMessage({
    id: 'gateway-first-send',
    media: [{ type: 'image', url: '/api/media/inbound/screenshot.png', name: 'screenshot.png', mimeType: 'image/png' }],
    createdAt: baseTime + 1_000,
  });

  store.addMessage(firstLocal);
  store.addMessage(secondLocal);
  store.replaceMessages(sessionKey, [gateway]);

  assert.deepEqual(store.getMessages(sessionKey).map((message) => message.id), ['gateway-first-send', 'local-second-send']);
});

test('replaceMessages preserves prior transcript rows when Gateway returns a short history window', () => {
  const store = new DeckStore();
  store.replaceMessages(sessionKey, [
    { id: 'old-user', sessionKey, role: 'user', text: 'older prompt', createdAt: baseTime },
    { id: 'old-assistant', sessionKey, role: 'assistant', text: 'older answer', createdAt: baseTime + 1_000 },
  ]);

  store.replaceMessages(sessionKey, [
    { id: 'new-assistant', sessionKey, role: 'assistant', text: 'latest answer', createdAt: baseTime + 2_000 },
  ]);

  assert.deepEqual(store.getMessages(sessionKey).map((message) => message.id), ['old-user', 'old-assistant', 'new-assistant']);
});

test('replaceMessages ignores an empty history refresh instead of clearing visible history', () => {
  const store = new DeckStore();
  store.replaceMessages(sessionKey, [
    { id: 'existing', sessionKey, role: 'assistant', text: 'still visible', createdAt: baseTime },
  ]);

  store.replaceMessages(sessionKey, []);

  assert.deepEqual(store.getMessages(sessionKey).map((message) => message.id), ['existing']);
});

test('replaceMessages authoritative refresh removes stale history but preserves pending sends', () => {
  const store = new DeckStore();
  store.replaceMessages(sessionKey, [
    { id: 'stale', sessionKey, role: 'assistant', text: 'wrong thread', status: 'sent', createdAt: baseTime },
    { id: 'pending', sessionKey, role: 'user', text: 'sending now', status: 'sending', createdAt: baseTime + 1 },
  ]);

  store.replaceMessages(sessionKey, [
    { id: 'correct', sessionKey, role: 'assistant', text: 'correct thread', status: 'sent', createdAt: baseTime + 2 },
  ], { authoritative: true });

  assert.deepEqual(store.getMessages(sessionKey).map((message) => message.id), ['pending', 'correct']);
});

test('history cannot discard an uncertain send or acknowledge it by matching text', () => {
  for (const authoritative of [false, true]) {
    const store = new DeckStore();
    const uncertain = { id: 'uncertain', sessionKey, role: 'user' as const, text: 'same input', status: 'outcome_unknown' as const, createdAt: baseTime };
    store.addMessage(uncertain);
    store.replaceMessages(sessionKey, [{ ...uncertain, id: 'other-send', status: 'sent' }], { authoritative });
    assert.equal(store.getMessages(sessionKey).find((message) => message.id === 'uncertain')?.status, 'outcome_unknown');
    store.replaceMessages(sessionKey, [{ ...uncertain, status: 'sent' }], { authoritative });
    assert.equal(store.getMessages(sessionKey).find((message) => message.id === 'uncertain')?.status, 'sent');
  }
});

test('replaceMessages rejects rows belonging to another session', () => {
  const store = new DeckStore();
  assert.throws(() => store.replaceMessages(sessionKey, [
    { id: 'foreign', sessionKey: 'codex:other-thread', role: 'assistant', text: 'wrong thread', createdAt: baseTime },
  ]), /belongs to codex:other-thread/);
});

test('getSessionsState preserves connector context limit when local message estimate is available', () => {
  const store = new DeckStore();
  const key = 'agent:project-manager:feishu:direct:user-1';
  store.replaceSessions([{ sessionKey: key, agentId: 'project-manager', label: 'Lia direct', status: 'idle', updatedAt: baseTime, contextTokens: 900_000 }]);
  store.replaceMessages(key, [
    { id: 'm1', sessionKey: key, role: 'assistant', text: 'hello from lia', createdAt: baseTime },
  ]);

  const session = store.getSessionsState().groups[0]?.sessions[0];
  assert.equal(session?.contextTokens, 900_000);
  assert.equal(session?.messageCount, 1);
  assert.equal(typeof session?.totalTokens, 'number');
  assert.equal(typeof session?.estimatedTokens, 'number');
});

test('replaceSessions repairs UTF-8-as-Latin-1 mojibake session titles at projection boundary', () => {
  const store = new DeckStore();
  const key = 'agent:ops-pm:dashboard:mojibake-1';

  store.replaceSessions([{ sessionKey: key, agentId: 'ops-pm', label: 'æµ\u008bè¯\u0095 session', status: 'idle', updatedAt: baseTime }]);

  assert.equal(store.getSession(key)?.title, '测试 session');
});

test('replaceSessions preserves normal ASCII and Unicode session titles', () => {
  const store = new DeckStore();
  const asciiKey = 'agent:ops-pm:dashboard:ascii-title';
  const unicodeKey = 'agent:ops-pm:dashboard:unicode-title';

  store.replaceSessions([
    { sessionKey: asciiKey, agentId: 'ops-pm', label: 'COD-131 session title mojibake', status: 'idle', updatedAt: baseTime },
    { sessionKey: unicodeKey, agentId: 'ops-pm', label: 'Claw Pool 新版 – Café', status: 'idle', updatedAt: baseTime + 1 },
  ]);

  assert.equal(store.getSession(asciiKey)?.title, 'COD-131 session title mojibake');
  assert.equal(store.getSession(unicodeKey)?.title, 'Claw Pool 新版 – Café');
});

test('replaceSessions prefers explicit title override over all Gateway title candidates', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-title-override-test-'));
  try {
    const titleFile = join(dir, 'titles.json');
    const store = new DeckStore({ sessionTitlesFile: titleFile });
    const key = 'agent:ops-pm:dashboard:01901ed1-b997-470b-a76f-87ba65700deb';

    store.replaceSessions([{ sessionKey: key, agentId: 'ops-pm', label: 'Manual label', derivedTitle: 'Gateway title', status: 'idle', updatedAt: baseTime }]);
    store.renameSession(key, 'Persisted override');
    store.replaceSessions([{ sessionKey: key, agentId: 'ops-pm', label: 'Manual label changed', derivedTitle: 'Gateway title changed', status: 'idle', updatedAt: baseTime + 1 }]);

    assert.equal(store.getSession(key)?.title, 'Persisted override');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('replaceSessions prefers manual label before derived/display title metadata', () => {
  const store = new DeckStore();
  const key = 'agent:ops-pm:dashboard:01901ed1-b997-470b-a76f-87ba65700deb';

  store.replaceSessions([{ sessionKey: key, agentId: 'ops-pm', label: 'Manual label', derivedTitle: 'Derived title', displayName: 'Display name', status: 'idle', updatedAt: baseTime }]);

  assert.equal(store.getSession(key)?.title, 'Manual label');
});

test('replaceSessions uses OpenClaw derived/display title metadata for unlabeled dashboard rows', () => {
  const store = new DeckStore();
  const derivedKey = 'agent:ops-pm:dashboard:01901ed1-b997-470b-a76f-87ba65700deb';
  const displayKey = 'agent:ops-pm:dashboard:6eec1af2-1111-4222-8333-0123456789ab';

  store.replaceSessions([
    { sessionKey: derivedKey, agentId: 'ops-pm', derivedTitle: 'Recent user request', displayName: 'Display should lose', status: 'idle', updatedAt: baseTime },
    { sessionKey: displayKey, agentId: 'ops-pm', displayName: 'Display fallback', status: 'idle', updatedAt: baseTime + 1 },
  ]);

  assert.equal(store.getSession(derivedKey)?.title, 'Recent user request');
  assert.equal(store.getSession(displayKey)?.title, 'Display fallback');
});

test('replaceSessions recovers unlabeled dashboard title from first transcript user message', () => {
  const store = new DeckStore();
  const key = 'agent:ops-pm:dashboard:01901ed1-b997-470b-a76f-87ba65700deb';

  store.replaceSessions([{
    sessionKey: key,
    agentId: 'ops-pm',
    status: 'idle',
    updatedAt: baseTime,
    transcript: [
      { role: 'system', text: 'System prompt' },
      { role: 'user', text: '[Sun 2026-07-12 14:21 GMT+8] 最近很多session名字又变回去了 Dashboarddxxxxxuuid' },
    ],
  }]);

  assert.equal(store.getSession(key)?.title, '最近很多session名字又变回去了 Dashboarddxxxxxuuid');
});

test('replaceSessions bounds recovered transcript titles', () => {
  const store = new DeckStore();
  const key = 'agent:ops-pm:dashboard:6eec1af2-1111-4222-8333-0123456789ab';
  const long = '请分析这个很长的 dashboard session 标题回归问题，并且给出完整修复方案、测试方案、回滚方案、风险说明、灰度策略、用户影响和后续监控项，谢谢，并附排查记录';

  store.replaceSessions([{ sessionKey: key, agentId: 'ops-pm', status: 'idle', updatedAt: baseTime, messages: [{ role: 'user', content: long }] }]);

  const title = store.getSession(key)?.title ?? '';
  assert.equal(title.length, 78);
  assert.equal(title.length <= 80, true);
  assert.match(title, /…$/);
});

test('replaceSessions falls back dashboard session keys to readable dashboard titles', () => {
  const store = new DeckStore();
  const key = 'agent:ops-pm:dashboard:01901ed1-b997-470b-a76f-87ba65700deb';

  store.replaceSessions([{ sessionKey: key, agentId: 'ops-pm', status: 'idle', updatedAt: baseTime }]);

  assert.equal(store.getSession(key)?.title, 'Dashboard · 01901ED1 B997 470B A76F 87BA65700DEB');
});

test('getSessionsState hides and restores sessions from persisted local visibility state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-hidden-test-'));
  try {
    const hiddenFile = join(dir, 'hidden.json');
    const key = 'agent:ops-dev:dashboard:hidden-1';
    const store = new DeckStore({ hiddenSessionsFile: hiddenFile });
    store.replaceSessions([{ sessionKey: key, agentId: 'ops-dev', label: 'Hidden candidate', status: 'idle', updatedAt: baseTime }]);

    assert.equal(store.getSessionsState().groups[0]?.sessions.length, 1);
    store.hideSession(key);
    assert.equal(store.getSessionsState().hiddenCount, 1);
    assert.equal(store.getSessionsState().groups.length, 0);
    assert.equal(store.getSessionsState({ includeHidden: true }).groups[0]?.sessions[0]?.hidden, true);

    const restarted = new DeckStore({ hiddenSessionsFile: hiddenFile });
    restarted.replaceSessions([{ sessionKey: key, agentId: 'ops-dev', label: 'Hidden candidate', status: 'idle', updatedAt: baseTime }]);
    assert.equal(restarted.getSessionsState().groups.length, 0);
    restarted.unhideSession(key);
    assert.equal(restarted.getSessionsState().groups[0]?.sessions[0]?.sessionKey, key);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test('getSessionsState archives and restores sessions from persisted local archive state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-archive-test-'));
  try {
    const archivedFile = join(dir, 'archived.json');
    const key = 'agent:ops-dev:dashboard:archived-1';
    const store = new DeckStore({ archivedSessionsFile: archivedFile });
    store.replaceSessions([{ sessionKey: key, agentId: 'ops-dev', label: 'Archive candidate', status: 'idle', updatedAt: baseTime }]);

    assert.equal(store.getSessionsState().groups[0]?.sessions.length, 1);
    store.archiveSession(key);
    assert.equal(store.getSessionsState().archivedCount, 1);
    assert.equal(store.getSessionsState().groups.length, 0);
    assert.equal(store.getSessionsState({ includeArchived: true }).groups[0]?.sessions[0]?.archived, true);

    const restarted = new DeckStore({ archivedSessionsFile: archivedFile });
    restarted.replaceSessions([{ sessionKey: key, agentId: 'ops-dev', label: 'Archive candidate', status: 'idle', updatedAt: baseTime }]);
    assert.equal(restarted.getSessionsState().groups.length, 0);
    restarted.unarchiveSession(key);
    assert.equal(restarted.getSessionsState().groups[0]?.sessions[0]?.sessionKey, key);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('getSessionsState pins sessions persistently and orders pinned sessions before activity-sorted unpinned sessions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-pin-test-'));
  try {
    const pinnedFile = join(dir, 'pinned.json');
    const oldPinned = 'agent:ops-dev:dashboard:pinned-old';
    const newPinned = 'agent:ops-dev:dashboard:pinned-new';
    const newestUnpinned = 'agent:ops-dev:dashboard:unpinned-newest';
    const oldUnpinned = 'agent:ops-dev:dashboard:unpinned-old';
    const rows = [
      { sessionKey: oldPinned, agentId: 'ops-dev', label: 'Old pinned', status: 'idle', updatedAt: baseTime + 10 },
      { sessionKey: newPinned, agentId: 'ops-dev', label: 'New pinned', status: 'idle', updatedAt: baseTime + 30 },
      { sessionKey: newestUnpinned, agentId: 'ops-dev', label: 'Newest unpinned', status: 'idle', updatedAt: baseTime + 40 },
      { sessionKey: oldUnpinned, agentId: 'ops-dev', label: 'Old unpinned', status: 'idle', updatedAt: baseTime + 20 },
    ];
    const store = new DeckStore({ pinnedSessionsFile: pinnedFile });
    store.replaceSessions(rows);

    store.pinSession(oldPinned);
    store.pinSession(newPinned);

    assert.equal(store.getSessionsState().pinnedCount, 2);
    assert.deepEqual(store.getSessionsState().groups[0]?.sessions.map((session) => session.sessionKey), [
      newPinned,
      oldPinned,
      newestUnpinned,
      oldUnpinned,
    ]);

    const restarted = new DeckStore({ pinnedSessionsFile: pinnedFile });
    restarted.replaceSessions(rows);
    assert.equal(restarted.getSessionsState().groups[0]?.sessions[0]?.pinned, true);
    restarted.unpinSession(newPinned);
    assert.equal(restarted.getSessionsState().pinnedCount, 1);
    assert.equal(restarted.getSessionsState().groups[0]?.sessions[0]?.sessionKey, oldPinned);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('markSessionBusy keeps a locally compacting session running across idle refreshes', () => {
  const store = new DeckStore();
  const key = 'agent:ops-pm:dashboard:compact-1';
  store.replaceSessions([{ sessionKey: key, agentId: 'ops-pm', label: 'Compact me', status: 'idle', updatedAt: baseTime }]);

  store.markSessionBusy(key, 60_000);
  assert.equal(store.getSession(key)?.status, 'running');
  assert.equal(store.getSession(key)?.hasActiveRun, true);

  store.replaceSessions([{ sessionKey: key, agentId: 'ops-pm', label: 'Compact me', status: 'idle', updatedAt: baseTime + 1 }]);
  assert.equal(store.getSession(key)?.status, 'running');
  assert.equal(store.getSession(key)?.hasActiveRun, true);
});

test('markSessionBusy synchronizes legacy and structured running status', () => {
  const store = new DeckStore();
  const key = 'agent:ops-pm:dashboard:busy-sync-1';
  store.replaceSessions([{ sessionKey: key, agentId: 'ops-pm', label: 'Busy sync', status: 'idle', updatedAt: baseTime }]);

  store.markSessionBusy(key, 60_000);

  const session = store.getSession(key);
  assert.equal(session?.status, 'running');
  assert.equal(session?.hasActiveRun, true);
  assert.deepEqual(session?.structuredStatus, {
    runState: 'running',
    childState: 'idle',
    pendingSubagentCount: 0,
    hasActiveRun: true,
    displayStatus: 'running',
  });
});

test('gateway run completion synchronizes structured status after local busy state', () => {
  const store = new DeckStore();
  const key = 'agent:ops-pm:dashboard:run-complete-sync-1';
  store.replaceSessions([{ sessionKey: key, agentId: 'ops-pm', label: 'Run sync', status: 'idle', updatedAt: baseTime }]);
  store.markSessionBusy(key, 60_000);

  store.ingestGatewayEvent({ event: 'run.completed', payload: { sessionKey: key, status: 'done', updatedAt: baseTime + 5_000 } });

  const session = store.getSession(key);
  assert.equal(session?.status, 'idle');
  assert.equal(session?.hasActiveRun, false);
  assert.equal(session?.structuredStatus?.runState, 'idle');
  assert.equal(session?.structuredStatus?.displayStatus, 'idle');
});

test('terminal transcript row synchronizes structured status from running to idle', () => {
  const store = new DeckStore();
  const key = 'agent:ops-pm:dashboard:terminal-sync-1';
  store.replaceSessions([{ sessionKey: key, agentId: 'ops-pm', label: 'Terminal sync', status: 'running', updatedAt: baseTime }]);

  store.replaceMessages(key, [{ id: 'assistant-done', sessionKey: key, role: 'assistant', text: 'Done', status: 'sent', createdAt: baseTime + 10_000 }]);

  const session = store.getSession(key);
  assert.equal(session?.status, 'idle');
  assert.equal(session?.hasActiveRun, false);
  assert.equal(session?.structuredStatus?.runState, 'idle');
  assert.equal(session?.structuredStatus?.displayStatus, 'idle');
});

test('sessions_yield tool result synchronizes structured status from running to waiting', () => {
  const store = new DeckStore();
  const key = 'agent:ops-pm:dashboard:yield-sync-1';
  store.replaceSessions([{ sessionKey: key, agentId: 'ops-pm', label: 'Yield sync', status: 'running', updatedAt: baseTime }]);

  store.replaceMessages(key, [{
    id: 'yield-result',
    sessionKey: key,
    role: 'tool',
    toolName: 'sessions_yield',
    toolPhase: 'result',
    text: '{"status":"yielded","message":"waiting for child"}',
    createdAt: baseTime + 10_000,
  }]);

  const session = store.getSession(key);
  assert.equal(session?.status, 'waiting');
  assert.equal(session?.hasActiveRun, false);
  assert.equal(session?.structuredStatus?.runState, 'waiting');
  assert.equal(session?.structuredStatus?.displayStatus, 'waiting');
});

test('chat error event synchronizes structured failed status', () => {
  const store = new DeckStore();
  const key = 'agent:ops-pm:dashboard:chat-error-sync-1';
  store.replaceSessions([{ sessionKey: key, agentId: 'ops-pm', label: 'Error sync', status: 'running', updatedAt: baseTime }]);

  store.ingestGatewayEvent({ event: 'chat.updated', payload: { sessionKey: key, state: 'error', errorMessage: 'boom', updatedAt: baseTime + 2_000 } });

  const session = store.getSession(key);
  assert.equal(session?.status, 'failed');
  assert.equal(session?.hasActiveRun, false);
  assert.equal(session?.structuredStatus?.runState, 'failed');
  assert.equal(session?.structuredStatus?.displayStatus, 'failed');
});

test('replaceSessions marks a visible parent as pending_subagent while a hidden subagent child is active', () => {
  const store = new DeckStore();
  const parentKey = 'agent:ops-pm:dashboard:parent-1';

  store.replaceSessions([
    {
      sessionKey: parentKey,
      agentId: 'ops-pm',
      label: 'Ops parent',
      status: 'idle',
      updatedAt: baseTime,
    },
    {
      sessionKey: 'agent:ops-dev:subagent:child-1',
      agentId: 'ops-dev',
      label: 'dev child',
      status: 'running',
      requesterSessionKey: parentKey,
      updatedAt: baseTime + 1,
    },
  ]);

  const parent = store.getSession(parentKey);
  assert.equal(parent?.status, 'pending_subagent');
  assert.equal(parent?.pendingSubagentCount, 1);
  assert.deepEqual(parent?.structuredStatus, {
    runState: 'idle',
    childState: 'pending',
    pendingSubagentCount: 1,
    hasActiveRun: false,
    displayStatus: 'pending_subagent',
  });
  assert.deepEqual(store.getSessionsState().groups.flatMap((group) => group.sessions).map((session) => session.sessionKey), [parentKey]);
});

test('replaceSessions infers pending_subagent for legacy child rows without parent metadata when there is one nearby visible parent', () => {
  const store = new DeckStore();
  const parentKey = 'agent:project-manager:feishu:direct:ou_2a447fe5e2c047cfa7e33239183405da';

  store.replaceSessions([
    { sessionKey: parentKey, agentId: 'project-manager', label: '了了-PM', status: 'idle', updatedAt: baseTime + 2_000 },
    { sessionKey: 'agent:project-manager:feishu:group:oc_old', agentId: 'project-manager', label: 'old group', status: 'idle', updatedAt: baseTime - 3_600_000 },
    { sessionKey: 'agent:devops:subagent:a8fef3ed', agentId: 'devops', status: 'running', updatedAt: baseTime + 1_000 },
  ]);

  const parent = store.getSession(parentKey);
  assert.equal(parent?.status, 'pending_subagent');
  assert.equal(parent?.pendingSubagentCount, 1);
});

test('replaceSessions projects canonical thinkingLevel from Gateway rows', () => {
  const store = new DeckStore();
  const key = 'agent:ops-pm:dashboard:thinking-1';

  store.replaceSessions([{ sessionKey: key, agentId: 'ops-pm', label: 'Thinking', status: 'idle', thinkingLevel: 'high', updatedAt: baseTime }]);

  assert.equal(store.getSession(key)?.thinkingLevel, 'high');
});

test('session thinking override survives Gateway rows that omit thinkingLevel and clears on reset', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dashboard-thinking-'));
  const thinkingFile = join(dir, 'thinking.json');
  try {
    const key = 'agent:ops-pm:dashboard:thinking-persist';
    const store = new DeckStore({ sessionThinkingOverridesFile: thinkingFile });
    store.replaceSessions([{ sessionKey: key, agentId: 'ops-pm', label: 'Thinking persist', status: 'idle', updatedAt: baseTime }]);

    store.persistSessionThinkingOverride(key, 'high');
    store.replaceSessions([{ sessionKey: key, agentId: 'ops-pm', label: 'Thinking persist', status: 'idle', updatedAt: baseTime + 1 }]);

    assert.equal(store.getSession(key)?.thinkingLevel, 'high');
    assert.equal(store.getSessionsState().groups[0]?.sessions[0]?.thinkingLevel, 'high');

    const restarted = new DeckStore({ sessionThinkingOverridesFile: thinkingFile });
    restarted.replaceSessions([{ sessionKey: key, agentId: 'ops-pm', label: 'Thinking persist', status: 'idle', updatedAt: baseTime + 2 }]);
    assert.equal(restarted.getSession(key)?.thinkingLevel, 'high');

    restarted.persistSessionThinkingOverride(key, null);
    restarted.replaceSessions([{ sessionKey: key, agentId: 'ops-pm', label: 'Thinking persist', status: 'idle', updatedAt: baseTime + 3 }]);
    assert.equal(restarted.getSession(key)?.thinkingLevel, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('replaceSessions does not infer pending_subagent for orphan child rows when nearby parent is ambiguous', () => {
  const store = new DeckStore();
  const firstParentKey = 'agent:project-manager:feishu:direct:ou_1';
  const secondParentKey = 'agent:project-manager:feishu:direct:ou_2';

  store.replaceSessions([
    { sessionKey: firstParentKey, agentId: 'project-manager', label: 'first', status: 'idle', updatedAt: baseTime + 2_000 },
    { sessionKey: secondParentKey, agentId: 'project-manager', label: 'second', status: 'idle', updatedAt: baseTime + 3_000 },
    { sessionKey: 'agent:devops:subagent:a8fef3ed', agentId: 'devops', status: 'running', updatedAt: baseTime + 1_000 },
  ]);

  assert.equal(store.getSession(firstParentKey)?.status, 'idle');
  assert.equal(store.getSession(secondParentKey)?.status, 'idle');
});

test('replaceSessions returns parent status to idle after subagent child completes', () => {
  const store = new DeckStore();
  const parentKey = 'agent:ops-pm:dashboard:parent-1';

  store.replaceSessions([
    { sessionKey: parentKey, agentId: 'ops-pm', label: 'Ops parent', status: 'idle', updatedAt: baseTime },
    { sessionKey: 'agent:ops-dev:subagent:child-1', agentId: 'ops-dev', status: 'running', requesterSessionKey: parentKey, updatedAt: baseTime + 1 },
  ]);
  store.replaceSessions([
    { sessionKey: parentKey, agentId: 'ops-pm', label: 'Ops parent', status: 'idle', updatedAt: baseTime + 2 },
    { sessionKey: 'agent:ops-dev:subagent:child-1', agentId: 'ops-dev', status: 'done', requesterSessionKey: parentKey, updatedAt: baseTime + 3 },
  ]);

  const parent = store.getSession(parentKey);
  assert.equal(parent?.status, 'idle');
  assert.equal(parent?.pendingSubagentCount, undefined);
});

test('replaceSessions does not keep a parent pending when a subagent timed out', () => {
  const store = new DeckStore();
  const parentKey = 'agent:ops-pm:dashboard:parent-timeout';

  store.replaceSessions([
    { sessionKey: parentKey, agentId: 'ops-pm', label: 'Ops parent', status: 'done', updatedAt: baseTime },
    {
      sessionKey: 'agent:ops-dev:subagent:child-timeout',
      agentId: 'ops-dev',
      status: 'timeout',
      activeRun: { status: 'timeout' },
      requesterSessionKey: parentKey,
      updatedAt: baseTime + 1,
    },
  ]);

  const parent = store.getSession(parentKey);
  assert.equal(parent?.status, 'idle');
  assert.equal(parent?.pendingSubagentCount, undefined);
});

test('replaceSessions treats an aborted last run as terminal instead of stale running', () => {
  const store = new DeckStore();
  const key = 'agent:ops-pm:dashboard:aborted-run';

  store.replaceSessions([{
    sessionKey: key,
    agentId: 'ops-pm',
    label: 'Aborted run',
    status: 'running',
    hasActiveRun: true,
    abortedLastRun: true,
    updatedAt: baseTime,
  }]);

  const session = store.getSession(key);
  assert.equal(session?.status, 'failed');
  assert.equal(session?.hasActiveRun, false);
});

test('replaceSessions exposes run duration and completion timestamps', () => {
  const store = new DeckStore();
  const key = 'agent:ops-pm:dashboard:run-1';

  store.replaceSessions([{ sessionKey: key, agentId: 'ops-pm', label: 'Run me', status: 'running', runStartedAt: baseTime, updatedAt: baseTime + 60_000 }]);
  const running = store.getSession(key);
  assert.equal(running?.status, 'running');
  assert.equal(running?.runStartedAt, baseTime);

  store.replaceSessions([{ sessionKey: key, agentId: 'ops-pm', label: 'Run me', status: 'done', updatedAt: baseTime + 180_000 }]);
  const completed = store.getSession(key);
  assert.equal(completed?.status, 'idle');
  assert.equal(completed?.runStartedAt, baseTime);
  assert.equal(completed?.runCompletedAt, baseTime + 180_000);
});

test('partial and unfamiliar Gateway run events cannot imply completion', () => {
  const key = 'agent:main:dashboard:partial-run';
  for (const observation of [
    { event: 'run.updated', payload: {} },
    { event: 'run.updated', payload: { run: {} } },
    { event: 'run.updated', payload: { lastRun: { status: 'completed' }, abortedLastRun: true } },
    { event: 'run.updated', payload: { status: 'not_completed' } },
    { event: 'run.updated', payload: { status: 'future_status', phase: 'done' } },
    { event: 'run.updated', payload: { status: { toString: () => 'done' } } },
    { event: 'prune.completed', payload: { status: 'done' } },
    { event: 'tool.run.completed', payload: { status: 'done' } },
    { event: 'tool.updated', payload: { state: 'error' } },
  ]) {
    const store = new DeckStore();
    store.replaceSessions([{ sessionKey: key, status: 'running', runStartedAt: baseTime }]);
    const before = store.getSessionExecution(key);
    store.ingestGatewayEvent({ ...observation, payload: { sessionKey: key, ...observation.payload } });
    assert.deepEqual({ ...store.getSessionExecution(key), sourceCursor: before?.sourceCursor }, before, JSON.stringify(observation));
    assert.equal(store.getEventsSince(before?.sourceCursor).some((event) => event.type.startsWith('run.')), false);
    assert.equal(store.getMessages(key).length, 0);
  }
});

test('explicit Gateway lifecycle names work without redundant payload status', () => {
  const key = 'agent:main:dashboard:named-run', store = new DeckStore();
  store.replaceSessions([{ sessionKey: key, status: 'idle' }]);
  store.ingestGatewayEvent({ event: 'run.started', payload: { sessionKey: key, runStartedAt: baseTime } });
  assert.equal(store.getSessionExecution(key)?.status, 'running');
  store.ingestGatewayEvent({ event: 'run.completed', payload: { sessionKey: key, updatedAt: baseTime + 1_000 } });
  assert.equal(store.getSessionExecution(key)?.status, 'idle');
  assert.equal(store.getSessionExecution(key)?.runCompletedAt, baseTime + 1_000);
  store.ingestGatewayEvent({ event: 'run.started', payload: { sessionKey: key, runStartedAt: baseTime + 2_000 } });
  assert.equal(store.getSessionExecution(key)?.runCompletedAt, undefined, 'new active run cannot expose the preceding completion timestamp');
  store.ingestGatewayEvent({ event: 'run.failed', payload: { sessionKey: key, runId: 'named-failure', error: 'test failure' } });
  assert.equal(store.getSessionExecution(key)?.status, 'failed');
  assert.equal(store.getMessages(key).at(-1)?.id, 'assistant-failed:named-failure');
});

test('waiting and unknown Gateway observations are updates, not completed runs', () => {
  const key = 'agent:main:dashboard:non-terminal';
  for (const status of ['waiting', 'unknown']) {
    const store = new DeckStore();
    store.replaceSessions([{ sessionKey: key, status: 'running', runStartedAt: baseTime }]);
    const cursor = store.latestEventId();
    store.ingestGatewayEvent({ event: 'run.updated', payload: { sessionKey: key, status, updatedAt: baseTime + 1_000 } });
    assert.equal(store.getSessionExecution(key)?.status, status);
    assert.equal(store.getSessionExecution(key)?.runStartedAt, baseTime);
    assert.equal(store.getSessionExecution(key)?.runCompletedAt, undefined);
    assert.deepEqual(store.getEventsSince(cursor).map((event) => event.type), ['run.updated']);
  }
});

test('current active evidence wins over terminal labels and historical run fields', () => {
  const key = 'agent:main:dashboard:active-evidence';
  for (const payload of [
    { status: 'done', hasActiveRun: true },
    { state: 'error', hasActiveRun: true },
    { status: 'done', phase: 'running' },
    { activeRun: { status: 'running' }, run: { status: 'done' } },
    { currentRun: { status: 'running' }, lastRun: { status: 'failed' } },
  ]) {
    const store = new DeckStore();
    store.replaceSessions([{ sessionKey: key, status: 'running', runStartedAt: baseTime }]);
    const cursor = store.latestEventId();
    store.ingestGatewayEvent({ event: 'run.completed', payload: { sessionKey: key, ...payload } });
    assert.equal(store.getSessionExecution(key)?.status, 'running');
    assert.deepEqual(store.getEventsSince(cursor).map((event) => event.type), ['run.updated']);
  }
});

test('ingestGatewayEvent adds an assistant failure row immediately when a run fails', () => {
  const store = new DeckStore();
  const key = 'agent:ops-pm:dashboard:fail-1';
  store.replaceSessions([{ sessionKey: key, agentId: 'ops-pm', label: 'Fail me', status: 'running', startedAt: baseTime, updatedAt: baseTime + 1 }]);

  store.ingestGatewayEvent({
    event: 'run.failed',
    payload: { sessionKey: key, runId: 'run-42', status: 'failed', error: 'provider timeout', updatedAt: baseTime + 2_000 },
  });

  const failure = store.getMessages(key).find((message) => message.id === 'assistant-failed:run-42');
  assert.equal(store.getSession(key)?.status, 'failed');
  assert.equal(failure?.role, 'assistant');
  assert.equal(failure?.status, 'failed');
  assert.equal(failure?.failureReason, 'provider timeout');
});

test('ingestGatewayEvent surfaces a failure row for a Gateway chat state:error event', () => {
  const store = new DeckStore();
  const key = 'agent:ops-pm:dashboard:fail-2';
  store.replaceSessions([{ sessionKey: key, agentId: 'ops-pm', label: 'Chat error', status: 'running', startedAt: baseTime, updatedAt: baseTime + 1 }]);

  // Real Gateway chat-stream failure: state:"error" with errorKind, not a run.* event.
  store.ingestGatewayEvent({
    event: 'chat',
    payload: { sessionKey: key, runId: 'run-77', state: 'error', errorKind: 'timeout', seq: 3, updatedAt: baseTime + 2_000 },
  });

  const failure = store.getMessages(key).find((message) => message.id === 'assistant-failed:run-77');
  assert.equal(store.getSession(key)?.status, 'failed');
  assert.equal(failure?.status, 'failed');
  assert.equal(failure?.failureReason, 'provider timeout');
});

test('ingestGatewayEvent does not duplicate failure rows across run and chat error events for the same run', () => {
  const store = new DeckStore();
  const key = 'agent:ops-pm:dashboard:fail-3';
  store.replaceSessions([{ sessionKey: key, agentId: 'ops-pm', label: 'Dedup', status: 'running', startedAt: baseTime, updatedAt: baseTime + 1 }]);

  store.ingestGatewayEvent({ event: 'chat', payload: { sessionKey: key, runId: 'run-88', state: 'error', errorMessage: 'boom', seq: 1, updatedAt: baseTime + 2_000 } });
  store.ingestGatewayEvent({ event: 'run.failed', payload: { sessionKey: key, runId: 'run-88', status: 'failed', error: 'boom', updatedAt: baseTime + 2_500 } });

  const failures = store.getMessages(key).filter((message) => message.id === 'assistant-failed:run-88');
  assert.equal(failures.length, 1);
});

test('ingestGatewayEvent marks an aborted assistant turn distinctly', () => {
  const store = new DeckStore();
  const key = 'agent:ops-pm:dashboard:abort-1';
  store.replaceSessions([{ sessionKey: key, agentId: 'ops-pm', label: 'Abort', status: 'running', startedAt: baseTime, updatedAt: baseTime + 1 }]);

  store.ingestGatewayEvent({ event: 'chat', payload: { sessionKey: key, runId: 'run-99', state: 'aborted', seq: 2, updatedAt: baseTime + 2_000 } });

  const failure = store.getMessages(key).find((message) => message.id === 'assistant-failed:run-99');
  assert.equal(failure?.status, 'failed');
  assert.match(failure?.text ?? '', /stopped/i);
});

test('getSessionsState reconciles a terminal assistant failure row out of running state after refresh', () => {
  const store = new DeckStore();
  const key = 'agent:ops-pm:dashboard:stale-running';
  store.replaceSessions([{ sessionKey: key, agentId: 'ops-pm', label: 'Stale', status: 'running', startedAt: baseTime, updatedAt: baseTime + 1_000 }]);
  store.addMessage({
    id: 'assistant-failed:run-stale',
    sessionKey: key,
    role: 'assistant',
    text: 'Assistant turn failed before producing content.',
    status: 'failed',
    createdAt: baseTime + 5_000,
    updatedAt: baseTime + 5_000,
  });

  const session = store.getSessionsState().groups.flatMap((group) => group.sessions).find((item) => item.sessionKey === key);
  assert.equal(session?.status, 'failed');
  assert.equal(session?.hasActiveRun, false);
  assert.equal(session?.runCompletedAt, baseTime + 5_000);
});

test('getSessionsState reconciles a successful assistant final row out of stale running state even with queued input after it', () => {
  const store = new DeckStore();
  const key = 'agent:ops-pm:dashboard:stale-running-success';
  store.replaceSessions([{ sessionKey: key, agentId: 'ops-pm', label: 'Stale success', status: 'running', startedAt: baseTime, updatedAt: baseTime + 1_000 }]);
  store.addMessage({
    id: 'assistant-final:run-stale',
    sessionKey: key,
    role: 'assistant',
    text: 'Done.',
    status: 'sent',
    createdAt: baseTime + 5_000,
    updatedAt: baseTime + 5_000,
  });
  store.addMessage({
    id: 'queued-after-final',
    sessionKey: key,
    role: 'user',
    text: 'next request',
    status: 'queued',
    createdAt: baseTime + 10_000,
    updatedAt: baseTime + 10_000,
  });

  const session = store.getSessionsState().groups.flatMap((group) => group.sessions).find((item) => item.sessionKey === key);
  assert.equal(session?.status, 'idle');
  assert.equal(session?.hasActiveRun, false);
  assert.equal(session?.runCompletedAt, baseTime + 5_000);
  assert.equal(session?.lastActiveAt, baseTime + 10_000);
});

test('getSessionsState clears failed session summary when a later assistant final row exists', () => {
  const store = new DeckStore();
  const key = 'agent:ops-pm:dashboard:failed-then-sent';
  store.replaceSessions([{ sessionKey: key, agentId: 'ops-pm', label: 'Recovered', status: 'failed', startedAt: baseTime, completedAt: baseTime + 4_000, updatedAt: baseTime + 4_000 }]);
  store.replaceMessages(key, [
    {
      id: 'assistant-failed:older-run',
      sessionKey: key,
      role: 'assistant',
      text: 'Assistant turn failed before producing content.',
      status: 'failed',
      createdAt: baseTime + 5_000,
      updatedAt: baseTime + 5_000,
    },
    {
      id: 'assistant-final:newer-run',
      sessionKey: key,
      role: 'assistant',
      text: 'Recovered final answer.',
      status: 'sent',
      createdAt: baseTime + 10_000,
      updatedAt: baseTime + 10_000,
    },
  ]);

  const session = store.getSessionsState().groups.flatMap((group) => group.sessions).find((item) => item.sessionKey === key);
  assert.equal(session?.status, 'idle');
  assert.equal(session?.hasActiveRun, false);
  assert.equal(session?.runCompletedAt, baseTime + 10_000);
});

test('getSessionsState ignores stale failed tool rows once a later assistant final row exists', () => {
  const store = new DeckStore();
  const key = 'agent:ops-pm:dashboard:failed-tool-then-sent';
  store.replaceSessions([{ sessionKey: key, agentId: 'ops-pm', label: 'Recovered from tool failure', status: 'failed', startedAt: baseTime, completedAt: baseTime + 4_000, updatedAt: baseTime + 4_000 }]);
  store.replaceMessages(key, [
    {
      id: 'tool-edit-failed',
      sessionKey: key,
      role: 'tool',
      toolName: 'edit',
      text: 'Tool call failed: invalid arguments',
      status: 'failed',
      createdAt: baseTime + 5_000,
      updatedAt: baseTime + 5_000,
    },
    {
      id: 'assistant-final:newer-run-after-tool-failure',
      sessionKey: key,
      role: 'assistant',
      text: 'Recovered final answer after using another tool.',
      status: 'sent',
      createdAt: baseTime + 10_000,
      updatedAt: baseTime + 10_000,
    },
  ]);

  const session = store.getSessionsState().groups.flatMap((group) => group.sessions).find((item) => item.sessionKey === key);
  assert.equal(session?.status, 'idle');
  assert.equal(session?.hasActiveRun, false);
  assert.equal(session?.runCompletedAt, baseTime + 10_000);
});


test('getSessionsState keeps a legitimate newer run running after an older assistant failure row', () => {
  const store = new DeckStore();
  const key = 'agent:ops-pm:dashboard:newer-run';
  store.addMessage({
    id: 'assistant-failed:run-old',
    sessionKey: key,
    role: 'assistant',
    text: 'Assistant turn failed before producing content.',
    status: 'failed',
    createdAt: baseTime + 5_000,
    updatedAt: baseTime + 5_000,
  });
  store.replaceSessions([{ sessionKey: key, agentId: 'ops-pm', label: 'Newer', status: 'running', runStartedAt: baseTime + 10_000, updatedAt: baseTime + 11_000 }]);

  const session = store.getSessionsState().groups.flatMap((group) => group.sessions).find((item) => item.sessionKey === key);
  assert.equal(session?.status, 'running');
  assert.equal(session?.hasActiveRun, true);
});

test('getSessionsState does not expose stale runCompletedAt from a previous run while a newer run is running', () => {
  const store = new DeckStore();
  const key = 'agent:ops-pm:dashboard:stale-completed';
  store.replaceSessions([{ sessionKey: key, agentId: 'ops-pm', label: 'Done', status: 'idle', runStartedAt: baseTime, completedAt: baseTime + 5_000, updatedAt: baseTime + 5_000 }]);
  store.replaceSessions([{ sessionKey: key, agentId: 'ops-pm', label: 'Running again', status: 'running', runStartedAt: baseTime + 60_000, updatedAt: baseTime + 61_000 }]);

  const session = store.getSessionsState().groups.flatMap((group) => group.sessions).find((item) => item.sessionKey === key);
  assert.equal(session?.status, 'running');
  assert.equal(session?.runStartedAt, baseTime + 60_000);
  assert.equal(session?.runCompletedAt, undefined);
});

test('getSessionsState does not reuse session startedAt or a completed run start as current running age', () => {
  const store = new DeckStore();
  const key = 'agent:ops-pm:dashboard:old-session-new-run';
  store.replaceSessions([{
    sessionKey: key,
    agentId: 'ops-pm',
    label: 'Old session',
    status: 'idle',
    startedAt: baseTime,
    lastRun: { startedAt: baseTime + 1_000, completedAt: baseTime + 2_000 },
    updatedAt: baseTime + 2_000,
  }]);
  const before = Date.now();
  store.replaceSessions([{
    sessionKey: key,
    agentId: 'ops-pm',
    label: 'Running now',
    status: 'running',
    startedAt: baseTime,
    lastRun: { startedAt: baseTime + 1_000, completedAt: baseTime + 2_000 },
    updatedAt: before,
  }]);

  const session = store.getSessionsState().groups.flatMap((group) => group.sessions).find((item) => item.sessionKey === key);
  assert.equal(session?.status, 'running');
  assert.ok((session?.runStartedAt ?? 0) >= before);
  assert.ok((session?.runStartedAt ?? Number.MAX_SAFE_INTEGER) <= Date.now());
});

test('getSessionsState advances lastActiveAt from recent message/tool output', () => {
  const store = new DeckStore();
  const key = 'agent:ops-pm:dashboard:message-activity';
  store.replaceSessions([{ sessionKey: key, agentId: 'ops-pm', label: 'Activity', status: 'running', startedAt: baseTime, updatedAt: baseTime + 1_000 }]);
  store.addMessage({
    id: 'tool-output-late',
    sessionKey: key,
    role: 'tool',
    text: '[tool exec]\noutput:\nprogress',
    createdAt: baseTime + 90_000,
  });

  const session = store.getSessionsState().groups.flatMap((group) => group.sessions).find((item) => item.sessionKey === key);
  assert.equal(session?.status, 'running');
  assert.equal(session?.lastActiveAt, baseTime + 90_000);
  assert.equal(session?.messageCount, 1);
});

test('getSessionsState treats a compact completion system row as terminal so queues can drain', () => {
  const store = new DeckStore();
  const key = 'agent:ops-pm:dashboard:compact-done';
  store.replaceSessions([{ sessionKey: key, agentId: 'ops-pm', label: 'Compact', status: 'running', startedAt: baseTime, updatedAt: baseTime + 1_000 }]);
  store.addMessage({
    id: 'system-compaction-done',
    sessionKey: key,
    role: 'system',
    text: 'Compaction',
    createdAt: baseTime + 60_000,
  });

  const session = store.getSessionsState().groups.flatMap((group) => group.sessions).find((item) => item.sessionKey === key);
  assert.equal(session?.status, 'idle');
  assert.equal(session?.hasActiveRun, false);
  assert.equal(session?.runCompletedAt, baseTime + 60_000);
});

test('getSessionsState keeps a newer run running after an older compact completion row', () => {
  const store = new DeckStore();
  const key = 'agent:ops-pm:dashboard:compact-then-run';
  store.addMessage({
    id: 'system-compaction-old',
    sessionKey: key,
    role: 'system',
    text: 'Compaction',
    createdAt: baseTime + 60_000,
  });
  store.replaceSessions([{ sessionKey: key, agentId: 'ops-pm', label: 'New run', status: 'running', runStartedAt: baseTime + 120_000, updatedAt: baseTime + 121_000 }]);

  const session = store.getSessionsState().groups.flatMap((group) => group.sessions).find((item) => item.sessionKey === key);
  assert.equal(session?.status, 'running');
  assert.equal(session?.hasActiveRun, true);
});
