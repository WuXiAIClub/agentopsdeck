import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Hono } from 'hono';
import { DeckStore } from '../projection/deck-store.js';
import { encodeHubSessionId } from './hub.js';
import { registerSessionRoutes } from './sessions.js';
import { createTestTurnQueue } from '../openclaw/turn-queue.test-fixture.js';
import type { CommandReceipts } from '../commands/receipts.js';

async function withCreateSessionApp(fn: (ctx: {
  app: Hono;
  store: DeckStore;
  titleFile: string;
  calls: Array<{ method: string; params: any }>;
  commands: CommandReceipts;
}) => Promise<void>, options: { actor?: () => string | undefined; beforeSend?: () => void } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dashboard-create-title-'));
  const titleFile = join(home, 'titles.json');
  const calls: Array<{ method: string; params: any }> = [];
  const store = new DeckStore({ sessionTitlesFile: titleFile });
  const app = new Hono();
  const turns = createTestTurnQueue({ store });
  registerSessionRoutes(app, { commands: turns.commands, deletionAdmission: key => turns.canDeleteSession(key), settingsAdmission: key => turns.canChangeSettings(key), queueActor: options.actor ?? (() => 'test-actor'),
    store,
    gateway: {
      requestBound: async (method: string, params: any, _connection: unknown, beforeSend: () => void) => {
        options.beforeSend?.();
        beforeSend(); calls.push({ method, params });
        return { payload: { key: 'agent:ops-pm:dashboard:created-title' }, connectionId: 'synthetic' };
      },
      request: async (method: string, params: any) => {
        calls.push({ method, params });
        if (method === 'sessions.create') return { key: 'agent:ops-pm:dashboard:created-title' };
        return {};
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
    await fn({ app, store, titleFile, calls, commands: turns.commands });
  } finally {
    await turns.close();
    await rm(home, { recursive: true, force: true });
  }
}

for (const boundary of ['missing', 'revoke', 'switch', 'abort'] as const) {
  test(`legacy create rejects ${boundary} before native write`, async () => {
    let actor: string | undefined = boundary === 'missing' ? undefined : 'original';
    const controller = new AbortController();
    await withCreateSessionApp(async ({ app, calls, store }) => {
      const response = await app.request('/api/agents/ops-pm/sessions', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"label":"new"}', signal: controller.signal,
      });
      assert.equal(response.status, boundary === 'abort' ? 202 : 403);
      assert.equal(calls.length, 0);
      assert.equal(store.getSessionsState().groups.length, 0);
    }, { actor: () => actor, beforeSend: () => {
      if (boundary === 'abort') controller.abort();
      else actor = boundary === 'switch' ? 'replacement' : undefined;
    } });
  });
}

test('legacy creation persists ACK before title failure and shares the retry identity', async () => {
  await withCreateSessionApp(async ({ app, store, calls }) => {
    store.persistSessionTitleOverride = () => { throw new Error('synthetic title failure'); };
    const send = () => app.request('/api/agents/ops-pm/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'synthetic-create' }, body: '{"label":"new"}',
    });
    const response = await send(), initial = await response.json() as any;
    assert.equal(response.status, 200); assert.equal(initial.command.state, 'accepted');
    assert.equal(initial.key, 'agent:ops-pm:dashboard:created-title');
    assert.deepEqual(await (await send()).json(), initial); assert.equal(calls.length, 1);
    const recovered = await (await app.request('/api/agents/ops-pm/sessions/creation-commands/synthetic-create')).json() as any;
    assert.equal(recovered.command.result.body.key, initial.key);
  });
});

for (const accepted of [false, true]) test(`legacy create rejects reused ${accepted ? 'deleted' : 'unresolved'} identity`, async () => {
  await withCreateSessionApp(async ({ app, store, calls, commands }) => {
    const key = 'agent:ops-pm:dashboard:created-title';
    const scope = JSON.stringify(['delete', JSON.stringify(['another-actor', key])]);
    commands.claim(scope, 'delete', {});
    if (accepted) commands.settle(scope, 'delete', { status: 200, body: { ok: true } });
    const response = await app.request('/api/agents/ops-pm/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'new' }),
    });
    assert.equal(response.status, 409);
    assert.equal(store.getSession(key), undefined);
    assert.equal(calls.length, 1);
    assert.equal(commands.sessionDeletion(key), accepted ? 'accepted' : 'outcome_unknown');
  });
});

test('creating a session with a custom label persists a local title override', async () => {
  await withCreateSessionApp(async ({ app, store, titleFile, calls }) => {
    const response = await app.request('/api/agents/ops-pm/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'Custom planning room' }),
    });

    assert.equal(response.status, 200);
    const created = await response.json() as any;
    assert.equal(created.key, 'agent:ops-pm:dashboard:created-title');
    assert.equal(created.command.state, 'accepted');
    const createCall = calls.find((call) => call.method === 'sessions.create');
    assert.equal(createCall?.params.label, 'Custom planning room');
    assert.equal(store.getSession('agent:ops-pm:dashboard:created-title')?.title, 'Custom planning room');

    const persisted = JSON.parse(await readFile(titleFile, 'utf8')) as Record<string, string>;
    assert.equal(persisted['agent:ops-pm:dashboard:created-title'], 'Custom planning room');
  });
});

test('created custom label survives a later Gateway refresh without label or subject', async () => {
  await withCreateSessionApp(async ({ app, titleFile }) => {
    await app.request('/api/agents/ops-pm/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'Durable dashboard title' }),
    });

    const restartedStore = new DeckStore({ sessionTitlesFile: titleFile });
    restartedStore.replaceSessions([{
      sessionKey: 'agent:ops-pm:dashboard:created-title',
      agentId: 'ops-pm',
      status: 'idle',
      updatedAt: 1_800_000_000_000,
    }]);

    assert.equal(restartedStore.getSession('agent:ops-pm:dashboard:created-title')?.title, 'Durable dashboard title');
  });
});

test('renaming a session still persists a local title override', async () => {
  await withCreateSessionApp(async ({ store, titleFile }) => {
    const sessionKey = 'agent:ops-pm:dashboard:rename-title';
    store.upsertSession({ sessionKey, agentId: 'ops-pm', title: 'Before rename', status: 'idle', source: 'web' });

    const renamed = store.renameSession(sessionKey, 'After rename');

    assert.equal(renamed?.title, 'After rename');
    const persisted = JSON.parse(await readFile(titleFile, 'utf8')) as Record<string, string>;
    assert.equal(persisted[sessionKey], 'After rename');
  });
});

test('renaming a wrapped Hub session persists the override on the remote session key', async () => {
  await withCreateSessionApp(async ({ app, store, titleFile }) => {
    const remoteSessionKey = 'agent:ops-pm:dashboard:01901ed1-b997-470b-a76f-87ba65700deb';
    const hubSessionKey = encodeHubSessionId('local', remoteSessionKey);
    store.upsertSession({ sessionKey: remoteSessionKey, agentId: 'ops-pm', title: 'Before rename', status: 'idle', source: 'web' });

    const response = await app.request(`/api/sessions/${encodeURIComponent(hubSessionKey)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Renamed planning room' }),
    });

    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.equal(body.sessionKey, hubSessionKey);
    assert.equal(body.settings.title, 'Renamed planning room');
    assert.equal(body.command.state, 'accepted');
    assert.equal(body.status, undefined, 'settings ACK is not a runtime snapshot');
    assert.equal(store.getSession(remoteSessionKey)?.title, 'Renamed planning room');

    const persisted = JSON.parse(await readFile(titleFile, 'utf8')) as Record<string, string>;
    assert.equal(persisted[remoteSessionKey], 'Renamed planning room');
    assert.equal(persisted[hubSessionKey], undefined);
  });
});
