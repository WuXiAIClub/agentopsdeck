import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DeckStore } from '../projection/deck-store.js';
import { createTestTurnQueue } from './turn-queue.test-fixture.js';
import type { OpenClawQueuedTurn } from './turn-queue.js';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import type { ChatMessage } from '@agentopsdeck/shared';

const entry = (id: string, sessionKey = 'agent:main:dashboard:queue-test'): Omit<OpenClawQueuedTurn, 'state'> => ({ id, sessionKey, createdAt: 1,
  payload: { message: id, deliveryMode: 'web-only', media: [] } });
function state(store: DeckStore, active: boolean, sessionKey = 'agent:main:dashboard:queue-test') {
  store.upsertSession({ sessionKey, title: 'Test', agentId: 'main', status: active ? 'running' : 'idle', hasActiveRun: active,
    runStartedAt: 1, lastActiveAt: 1 });
}

for (const kind of ['assistant', 'failure', 'compaction', 'yield'] as const) test(`OpenClaw queue does not use ${kind} transcript rows as execution completion`, async () => {
  const store = new DeckStore(); state(store, true);
  const turn = entry('queued'), sessionKey = turn.sessionKey;
  const message: ChatMessage = { id: 'transcript', sessionKey, role: 'assistant', text: 'Finished', status: 'sent', createdAt: 10 };
  if (kind === 'failure') { message.status = 'failed'; message.text = 'Assistant turn failed before producing content'; }
  if (kind === 'compaction') { message.role = 'system'; message.text = 'Compaction completed'; }
  if (kind === 'yield') { message.role = 'tool'; message.toolName = 'sessions_yield'; message.toolPhase = 'result'; }
  store.addMessage(message);
  assert.notEqual(store.getSession(sessionKey)?.status, 'running', 'legacy display heuristic reproduces the unsafe input');
  assert.equal(store.getSessionExecution(sessionKey)?.status, 'running');
  let sends = 0;
  const fixture = createTestTurnQueue({ store, send: async () => { sends++; return {}; } });
  try {
    fixture.queue.enqueue(turn);
    await (fixture.queue as any).reconcile(sessionKey);
    assert.equal(sends, 0); assert.equal(fixture.turns.head('openclaw', sessionKey)?.state, 'queued');
    state(store, false);
    await (fixture.queue as any).reconcile(sessionKey);
    assert.equal(sends, 1, 'only the independent execution projection permits dispatch');
    assert.ok(store.getMessages(sessionKey).find(message => message.id === turn.id)!.createdAt > turn.createdAt, 'sent projection uses dispatch time, not admission time');
  } finally { await fixture.close(); }
});

test('OpenClaw rechecks execution rather than display after asynchronous preparation', async () => {
  const store = new DeckStore(); state(store, false);
  const turn = entry('preparing'); let checks = 0, sends = 0;
  const fixture = createTestTurnQueue({ store, authorizeTurn: () => {
    if (++checks === 3) {
      state(store, true);
      store.addMessage({ id: 'commentary', sessionKey: turn.sessionKey, role: 'assistant', text: 'Interim output', status: 'sent', createdAt: 10 });
    }
    return true;
  }, send: async () => { sends++; return {}; } });
  try {
    fixture.queue.enqueue(turn);
    await (fixture.queue as any).reconcile(turn.sessionKey);
    assert.equal(checks, 3); assert.equal(sends, 0);
    assert.equal(fixture.turns.head('openclaw', turn.sessionKey)?.state, 'queued');
    assert.equal(store.getSessionExecution(turn.sessionKey)?.status, 'running');
  } finally { await fixture.close(); }
});

test('OpenClaw missing or unknown execution projection never dispatches queued input', async () => {
  const store = new DeckStore(), turn = entry('unknown'); let sends = 0;
  const fixture = createTestTurnQueue({ store, send: async () => { sends++; return {}; } });
  try {
    fixture.queue.enqueue(turn);
    await (fixture.queue as any).reconcile(turn.sessionKey);
    store.upsertSession({ sessionKey: turn.sessionKey, agentId: 'main', title: 'Unknown', status: 'unknown' });
    await (fixture.queue as any).reconcile(turn.sessionKey);
    assert.equal(sends, 0); assert.equal(fixture.turns.head('openclaw', turn.sessionKey)?.state, 'queued');
  } finally { await fixture.close(); }
});

for (const timing of ['before-refresh', 'during-refresh', 'missing-actor']) {
  test(`OpenClaw revocation ${timing} blocks durably without dispatch or losing the message`, async () => {
    const tokens = new ConnectorTokenStore(join(mkdtempSync(join(tmpdir(), 'agentopsdeck-revoked-turn-')), 'tokens.json'));
    const writer = tokens.create({ label: 'writer', scopes: ['messages:send'] });
    const store = new DeckStore(); state(store, false);
    let reads = 0, sends = 0;
    const fixture = createTestTurnQueue({ store, authorizeTurn: (actorId) => tokens.hasScope(actorId, 'messages:send'),
      refreshSessions: async () => { reads++; if (timing === 'during-refresh') tokens.revoke(writer.record.id); },
      send: async () => { sends++; return {}; } });
    const turn = entry('denied'); turn.payload.actorId = writer.record.id;
    try {
      fixture.queue.enqueue(turn);
      assert.equal(JSON.stringify(fixture.turns.list('openclaw')).includes(writer.token), false);
      if (timing === 'before-refresh') tokens.revoke(writer.record.id);
      if (timing === 'missing-actor') fixture.turns.edit<any>('openclaw', turn.sessionKey, turn.id, (payload) => {
        const { actorId: _actorId, ...legacy } = payload;
        return legacy;
      });
      await (fixture.queue as any).reconcile(turn.sessionKey);
      assert.equal(sends, 0);
      assert.equal(reads, timing === 'during-refresh' ? 1 : 0);
      assert.equal(fixture.turns.head('openclaw', turn.sessionKey)?.state, 'blocked');
      assert.equal(store.getMessages(turn.sessionKey)[0]?.status, 'failed');
      assert.match(store.getMessages(turn.sessionKey)[0]?.failureReason ?? '', /authorization.*not sent/);
      store.replaceMessages(turn.sessionKey, [], { authoritative: true });
      assert.equal(store.getMessages(turn.sessionKey)[0]?.id, 'denied');
      await (fixture.queue as any).reconcile(turn.sessionKey);
      assert.equal(reads, timing === 'during-refresh' ? 1 : 0, 'blocked work does not perform more reads');
      assert.equal(fixture.queue.cancel(turn.sessionKey, turn.id), true);
    } finally { await fixture.close(); }
  });
}

test('OpenClaw drains one identity at a time, unknown dispatch blocks only its session', async () => {
  const store = new DeckStore(); state(store, true); state(store, false, 'agent:main:dashboard:other-test');
  const sent: string[] = [];
  const fixture = createTestTurnQueue({ store, send: async (turn) => { sent.push(turn.id); if (turn.id === 'second') throw new Error('ACK lost'); return { runId: `run-${turn.id}` }; } });
  const reconcile = (key = 'agent:main:dashboard:queue-test') => (fixture.queue as any).reconcile(key);
  try {
    fixture.queue.enqueue(entry('first')); fixture.queue.enqueue(entry('second')); fixture.queue.enqueue(entry('third'));
    fixture.queue.enqueue(entry('independent', 'agent:main:dashboard:other-test'));
    await reconcile(); assert.deepEqual(sent, [], 'elapsed run time cannot authorize dispatch');
    state(store, false);
    await reconcile(); assert.deepEqual(sent, ['first']);
    assert.equal(store.getSession('agent:main:dashboard:queue-test')?.hasActiveRun, true);
    assert.deepEqual(fixture.turns.list('openclaw', 'agent:main:dashboard:queue-test').map((turn) => turn.id), ['second', 'third']);
    await reconcile(); assert.deepEqual(sent, ['first']);
    state(store, false);
    await reconcile(); assert.deepEqual(sent, ['first'], 'summary idle cannot end a command-bound run');
    store.ingestGatewayEvent({ event: 'run.completed', payload: { sessionKey: entry('first').sessionKey, runId: 'run-first' } });
    await reconcile(); assert.deepEqual(sent, ['first', 'second']);
    await reconcile(); assert.deepEqual(sent, ['first', 'second'], 'uncertain ACK is never retried');
    assert.equal(fixture.turns.head('openclaw', 'agent:main:dashboard:queue-test')?.state, 'outcome_unknown');
    assert.equal(store.getMessages('agent:main:dashboard:queue-test').find((message) => message.id === 'second')?.status, 'outcome_unknown');
    await reconcile('agent:main:dashboard:other-test'); assert.deepEqual(sent, ['first', 'second', 'independent']);
  } finally { await fixture.close(); }
});

test('OpenClaw prepare phase excludes edits/cancellation and closing waits for admitted send', async () => {
  const store = new DeckStore(); state(store, false);
  let release!: () => void, started = false;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const fixture = createTestTurnQueue({ store, send: async () => { started = true; await gate; throw new Error('closing during send'); } });
  try {
    fixture.queue.enqueue(entry('first'));
    assert.equal(fixture.queue.edit('agent:main:dashboard:other-test', 'first', 'wrong'), false);
    assert.equal(fixture.queue.edit('agent:main:dashboard:queue-test', 'first', 'edited'), true);
    fixture.queue.start();
    for (let i = 0; i < 100 && !started; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(started, true);
    assert.equal(fixture.queue.edit('agent:main:dashboard:queue-test', 'first', 'too late'), false);
    assert.equal(fixture.queue.cancel('agent:main:dashboard:queue-test', 'first'), false);
    let closed = false;
    const closing = fixture.queue.close().then(() => { closed = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closed, false, 'shutdown waits for admitted send bookkeeping');
    release(); await closing;
    assert.equal(fixture.turns.head<OpenClawQueuedTurn['payload']>('openclaw', 'agent:main:dashboard:queue-test')?.payload.message, 'edited');
    assert.equal(fixture.turns.head('openclaw', 'agent:main:dashboard:queue-test')?.state, 'outcome_unknown');
  } finally { release(); await fixture.close(); }
});

test('new OpenClaw attachments store references and preserve multi-MiB bytes at dispatch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-turn-file-')), filePath = join(dir, 'large.zip');
  const bytes = Buffer.alloc(2 * 1024 * 1024, 7); writeFileSync(filePath, bytes);
  const store = new DeckStore(); state(store, false);
  let received: any[] = [];
  const fixture = createTestTurnQueue({ store, send: async (_turn, attachments) => { received = attachments; return {}; } });
  try {
    const turn = entry('file');
    turn.payload.media = [{ filePath, media: { type: 'file', name: 'large.zip', mimeType: 'application/zip', size: bytes.length, url: '/api/media/inbound/large.zip' } }];
    fixture.queue.enqueue(turn);
    assert.ok(JSON.stringify(fixture.turns.head('openclaw', 'agent:main:dashboard:queue-test')).length < 1024, 'queue does not duplicate base64');
    await (fixture.queue as any).reconcile('agent:main:dashboard:queue-test');
    assert.equal(received[0].fileName, 'large.zip');
    assert.deepEqual(Buffer.from(received[0].content, 'base64'), bytes);
    assert.equal(fixture.turns.hasPending('openclaw', 'agent:main:dashboard:queue-test'), false);
  } finally { await fixture.close(); }
});

test('missing attachment is a known pre-dispatch failure, not an uncertain send', async () => {
  const store = new DeckStore(); state(store, false);
  const fixture = createTestTurnQueue({ store });
  try {
    const turn = entry('missing');
    turn.payload.media = [{ filePath: join(mkdtempSync(join(tmpdir(), 'agentopsdeck-missing-')), 'missing.zip'), media: { type: 'file', name: 'missing.zip', url: '/missing' } }];
    fixture.queue.enqueue(turn);
    const observed = store.getMessages(turn.sessionKey).find((message) => message.id === turn.id)!.queueVersion!;
    await (fixture.queue as any).reconcile('agent:main:dashboard:queue-test');
    assert.equal(fixture.turns.head('openclaw', 'agent:main:dashboard:queue-test')?.state, 'queued');
    const refreshed = store.getMessages(turn.sessionKey).find((message) => message.id === turn.id)!.queueVersion!;
    assert.notEqual(refreshed, observed);
    assert.equal(refreshed, fixture.turns.version('openclaw', turn.sessionKey, turn.id));
    assert.equal(fixture.queue.cancel(turn.sessionKey, turn.id, observed), false);
    assert.equal(fixture.queue.cancel(turn.sessionKey, turn.id, refreshed), true);
  } finally { await fixture.close(); }
});
