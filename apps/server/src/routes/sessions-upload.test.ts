import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Hono } from 'hono';
import { DeckStore } from '../projection/deck-store.js';
import { registerSessionRoutes } from './sessions.js';
import { createTestTurnQueue } from '../openclaw/turn-queue.test-fixture.js';
import type { OpenClawTurnQueue } from '../openclaw/turn-queue.js';

function zipUpload(name = 'YorozuyaDesktopPet- test-20260625.zip') {
  const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 1, 2, 3]);
  return {
    type: 'file',
    name,
    mimeType: 'application/zip',
    size: bytes.length,
    dataUrl: `data:application/zip;base64,${bytes.toString('base64')}`,
  };
}

async function withSessionApp(
  fn: (ctx: { app: Hono; store: DeckStore; queue: OpenClawTurnQueue; gatewayRequests: Array<{ method: string; params: any }> }) => Promise<void>,
  options: { refreshMessages?: (store: DeckStore, sessionKey: string) => Promise<void> | void } = {},
) {
  const previousHome = process.env.HOME;
  const home = await mkdtemp(join(tmpdir(), 'dashboard:cod087-upload-'));
  process.env.HOME = home;
  const gatewayRequests: Array<{ method: string; params: any }> = [];
  const store = new DeckStore({ sessionTitlesFile: join(home, 'titles.json') });
  store.upsertSession({ sessionKey: 'dashboard:cod087', agentId: 'main', title: 'COD-087', status: 'idle', hasActiveRun: false, source: 'web' });
  const gateway = {
    request: async (method: string, params: any) => {
      gatewayRequests.push({ method, params });
      if (method === 'chat.send') return { runId: `run-${gatewayRequests.length}`, status: 'started' };
      return {};
    },
  } as any;
  const app = new Hono();
  const turns = createTestTurnQueue({ store, refreshMessages: async (key) => { await options.refreshMessages?.(store, key); },
    send: (turn, attachments) => gateway.request('agent', { sessionKey: turn.sessionKey, message: turn.payload.message,
      idempotencyKey: turn.id, deliver: false, attachments }) });
  registerSessionRoutes(app, { commands: turns.commands, deletionAdmission: key => turns.canDeleteSession(key), settingsAdmission: key => turns.canChangeSettings(key), queueActor: () => 'test-actor',
    store,
    gateway,
    refreshSessions: async () => undefined,
    refreshMessages: async (sessionKey: string) => { await options.refreshMessages?.(store, sessionKey); },
    resolveExplicitChannelRoute: () => undefined,
    mirrorAssistantReplyToChannel: async () => undefined,
    normalizeError: (error) => error instanceof Error ? error.message : String(error),
    queue: turns.queue,
  });
  try {
    await fn({ app, store, queue: turns.queue, gatewayRequests });
  } finally {
    await turns.close();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
}

test('idle ZIP upload enters the worker and sends original Gateway attachment bytes', async () => {
  await withSessionApp(async ({ app, queue, gatewayRequests }) => {
    const response = await app.request('/api/sessions/dashboard:cod087/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'please inspect', deliveryMode: 'web-only', media: [zipUpload()] }),
    });

    assert.equal(response.status, 200);
    assert.equal((await response.json() as any).status, 'queued');
    assert.equal(gatewayRequests.length, 0);
    await (queue as any).reconcile('dashboard:cod087');
    const send = gatewayRequests.find((request) => request.method === 'agent');
    assert.ok(send, 'worker called agent');
    assert.equal(send.params.message, 'please inspect');
    assert.equal(send.params.agentId, undefined);
    assert.doesNotMatch(send.params.message, /MEDIA:|media unavailable|local file/i);
    assert.equal(send.params.attachments.length, 1);
    assert.equal(send.params.attachments[0].fileName, 'YorozuyaDesktopPet--test-20260625.zip');
    assert.equal(send.params.attachments[0].mimeType, 'application/zip');
    assert.equal(Buffer.from(send.params.attachments[0].content, 'base64').subarray(0, 4).toString('hex'), '504b0304');
  });
});

test('queued ZIP upload preserves attachment bytes without GET-driven dispatch', async () => {
  await withSessionApp(async ({ app, store, queue, gatewayRequests }) => {
    store.upsertSession({ sessionKey: 'dashboard:cod087', agentId: 'main', title: 'COD-087', status: 'running', hasActiveRun: true, source: 'web' });
    const queued = await app.request('/api/sessions/dashboard:cod087/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'first file', deliveryMode: 'web-only', media: [zipUpload()] }),
    });

    assert.equal(queued.status, 200);
    assert.equal((await queued.json() as any).status, 'queued');
    assert.equal(gatewayRequests.filter((request) => request.method === 'chat.send').length, 0);

    store.upsertSession({ sessionKey: 'dashboard:cod087', agentId: 'main', title: 'COD-087', status: 'idle', hasActiveRun: false, source: 'web' });
    await app.request('/api/sessions/dashboard:cod087/messages');
    assert.equal(gatewayRequests.length, 0, 'history read cannot dispatch');
    queue.start();
    for (let i = 0; i < 100 && !gatewayRequests.length; i++) await new Promise((resolve) => setTimeout(resolve, 5));

    const send = gatewayRequests.find((request) => request.method === 'agent');
    assert.ok(send, 'lifecycle worker sent queued attachment');
    assert.equal(send.params.agentId, undefined);
    assert.equal(send.params.message, 'first file');
    assert.doesNotMatch(send.params.message, /MEDIA:|media unavailable|local file/i);
    assert.equal(send.params.attachments.length, 1);
    assert.equal(send.params.attachments[0].fileName, 'YorozuyaDesktopPet--test-20260625.zip');
    assert.equal(send.params.attachments[0].mimeType, 'application/zip');
    assert.equal(Buffer.from(send.params.attachments[0].content, 'base64').subarray(0, 4).toString('hex'), '504b0304');
  });
});

test('send path history failure cannot unblock a still-running execution', async () => {
  await withSessionApp(async ({ app, store, queue, gatewayRequests }) => {
    store.upsertSession({ sessionKey: 'dashboard:cod087', agentId: 'main', title: 'COD-102', status: 'running', hasActiveRun: true, source: 'web', runStartedAt: 1_000, lastActiveAt: 1_000 });

    const response = await app.request('/api/sessions/dashboard:cod087/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'send after failed turn', deliveryMode: 'web-only' }),
    });

    assert.equal(response.status, 200);
    assert.equal((await response.json() as any).status, 'queued');
    await (queue as any).reconcile('dashboard:cod087');
    assert.ok(store.getMessages('dashboard:cod087').some((message) => message.id === 'assistant-failed:cod102'));
    assert.equal(gatewayRequests.length, 0, 'transcript failure is not execution completion');
    store.upsertSession({ sessionKey: 'dashboard:cod087', agentId: 'main', title: 'COD-102', status: 'failed', hasActiveRun: false, source: 'web' });
    await (queue as any).reconcile('dashboard:cod087');
    const send = gatewayRequests.find((request) => request.method === 'agent');
    assert.ok(send, 'worker dispatches after independent execution completion');
    assert.equal(send.params.message, 'send after failed turn');
  }, {
    refreshMessages: (store, sessionKey) => {
      store.addMessage({
        id: 'assistant-failed:cod102',
        sessionKey,
        role: 'assistant',
        text: 'Assistant turn failed before producing content.',
        status: 'failed',
        createdAt: 2_000,
      });
    },
  });
});

test('queue worker refreshes history independently but waits for execution completion', async () => {
  let refreshCount = 0;
  await withSessionApp(async ({ app, store, queue, gatewayRequests }) => {
    store.upsertSession({ sessionKey: 'dashboard:cod087', agentId: 'main', title: 'COD-102', status: 'running', hasActiveRun: true, source: 'web', runStartedAt: 1_000, lastActiveAt: 1_000 });
    const queued = await app.request('/api/sessions/dashboard:cod087/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'queued while running', deliveryMode: 'web-only' }),
    });
    assert.equal((await queued.json() as any).status, 'queued');

    await app.request('/api/sessions/state');
    assert.equal(gatewayRequests.length, 0, 'session list read cannot dispatch');
    queue.start();
    for (let i = 0; i < 100 && refreshCount < 2; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(refreshCount >= 2, 'lifecycle worker independently refreshed history');
    assert.ok(store.getMessages('dashboard:cod087').some((message) => message.id === 'assistant-failed:cod102-state'));
    assert.equal(gatewayRequests.length, 0, 'refreshed terminal text cannot complete the active run');
    store.upsertSession({ sessionKey: 'dashboard:cod087', agentId: 'main', title: 'COD-102', status: 'idle', hasActiveRun: false, source: 'web' });
    // Exercise the next pass without waiting for the production five-second retry.
    await (queue as any).reconcile('dashboard:cod087');

    const send = gatewayRequests.find((request) => request.method === 'agent');
    assert.ok(send, 'worker dispatches once execution completion is independently known');
    assert.equal(send.params.message, 'queued while running');
  }, {
    refreshMessages: (store, sessionKey) => {
      refreshCount += 1;
      if (refreshCount < 2) return;
      store.addMessage({
        id: 'assistant-failed:cod102-state',
        sessionKey,
        role: 'assistant',
        text: 'Assistant turn failed before producing content.',
        status: 'failed',
        createdAt: 2_000,
      });
    },
  });
});
