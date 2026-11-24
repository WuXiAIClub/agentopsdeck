import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Hono } from 'hono';
import { DeckStore } from '../projection/deck-store.js';
import { registerSessionRoutes } from './sessions.js';
import { createTestTurnQueue } from '../openclaw/turn-queue.test-fixture.js';

test('legacy queue cannot be replayed by GET, elapsed time or a later idle projection', async () => {
  const previousThreshold = process.env.AOD_STALE_ACTIVE_RUN_MS;
  process.env.AOD_STALE_ACTIVE_RUN_MS = String(60 * 60 * 1000);
  const home = await mkdtemp(join(tmpdir(), 'dashboard-stale-queue-'));
  const queueFile = join(home, 'queue.json');
  const now = Date.now();
  const sessionKey = 'agent:ops-pm:dashboard:stale-run';
  const queuedId = 'queued-stale-message';
  await writeFile(queueFile, `${JSON.stringify({
    queues: {
      [sessionKey]: [{
        id: queuedId,
        sessionKey,
        message: '做完了吗',
        deliveryMode: 'web-only',
        media: [],
        createdAt: now,
      }],
    },
  }, null, 2)}\n`);

  const store = new DeckStore({ sessionTitlesFile: join(home, 'titles.json') });
  store.upsertSession({
    sessionKey,
    agentId: 'ops-pm',
    title: 'Stale run',
    status: 'running',
    hasActiveRun: true,
    source: 'web',
    runStartedAt: now - (2 * 60 * 60 * 1000),
    lastActiveAt: now - (2 * 60 * 60 * 1000),
  });
  const calls: Array<{ method: string; params: any }> = [];
  const app = new Hono();
  const source = await readFile(queueFile, 'utf8');
  const turns = createTestTurnQueue({ store, queueFile, send: async (turn) => {
    calls.push({ method: 'agent', params: { sessionKey: turn.sessionKey, idempotencyKey: turn.id, message: turn.payload.message } });
    return { runId: 'sent-run' };
  } });
  registerSessionRoutes(app, { commands: turns.commands, deletionAdmission: key => turns.canDeleteSession(key), settingsAdmission: key => turns.canChangeSettings(key), queueActor: () => 'test-actor',
    store,
    gateway: {
      request: async (method: string, params: any) => {
        calls.push({ method, params });
        return { runId: 'sent-run' };
      },
    } as any,
    refreshSessions: async () => undefined,
    refreshMessages: async () => undefined,
    resolveExplicitChannelRoute: () => undefined,
    mirrorAssistantReplyToChannel: async () => undefined,
    normalizeError: (error) => error instanceof Error ? error.message : String(error),
    queue: turns.queue,
  });

  try {
    const legacyStop = await app.request(`/api/sessions/${sessionKey}/stop`, { method: 'POST' });
    assert.equal(legacyStop.status, 410, 'legacy stop cannot bypass the run-bound command receipt');
    for (const media of [[], [{ dataUrl: 'data:image/png;base64,YQ==', mimeType: 'image/png' }]]) {
      const messageStop = await app.request(`/api/sessions/${sessionKey}/messages`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: ' /stop ', expectedRunId: 'old-run', media }) });
      assert.equal(messageStop.status, 410, 'message-style stop cannot bypass control binding, even with media');
    }
    assert.equal(calls.length, 0);
    for (const message of ['/status', '/compact']) {
      const response = await app.request(`/api/sessions/${sessionKey}/messages`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message, deliveryMode: 'mirror' }) });
      assert.equal(response.status, 409, 'local controls cannot create mirror intent after native dispatch');
    }
    assert.equal(calls.length, 0);
    for (const method of ['PATCH', 'DELETE']) {
      const retired = await app.request(`/api/sessions/${sessionKey}/queue/${queuedId}`, { method,
        headers: { 'if-match': '"1:1"' }, ...(method === 'PATCH' ? { body: JSON.stringify({ message: 'bypass' }) } : {}) });
      assert.equal(retired.status, 410, 'legacy mutation cannot bypass actor/version checks');
    }
    const response = await app.request(`/api/sessions/${sessionKey}/messages`);
    assert.equal(response.status, 200);
    assert.equal(calls.length, 0, 'reads must not dispatch');
    turns.queue.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls.length, 0, 'silence and elapsed time must not grant execution');
    assert.equal(store.getSession(sessionKey)?.hasActiveRun, true);
    store.upsertSession({ ...store.getSession(sessionKey)!, status: 'idle', hasActiveRun: false });
    // Trigger the next scheduled reconciliation without waiting its normal 5s.
    const worker = (turns.queue as any).worker;
    clearTimeout(worker.timer); worker.timer = undefined; worker.wake();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls.length, 0, 'old inFlight=false may still have been sent before a timeout');
    assert.equal(turns.turns.head('openclaw', sessionKey)?.state, 'outcome_unknown');
    assert.equal(store.getMessages(sessionKey).find((message) => message.id === queuedId)?.status, 'outcome_unknown');
    assert.equal(turns.queue.edit(sessionKey, queuedId, 'replace uncertain'), false);
    assert.equal(turns.queue.cancel(sessionKey, queuedId), false);
    assert.equal(await readFile(queueFile, 'utf8'), source, 'legacy backup must remain unchanged');
  } finally {
    await turns.close();
    if (previousThreshold === undefined) delete process.env.AOD_STALE_ACTIVE_RUN_MS;
    else process.env.AOD_STALE_ACTIVE_RUN_MS = previousThreshold;
    await rm(home, { recursive: true, force: true });
  }
});
