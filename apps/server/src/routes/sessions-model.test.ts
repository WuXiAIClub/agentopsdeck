import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Hono } from 'hono';
import { DeckStore } from '../projection/deck-store.js';
import { registerSessionRoutes } from './sessions.js';
import { createTestTurnQueue } from '../openclaw/turn-queue.test-fixture.js';

// Regression guard for COD-093: the Gateway sessions.patch schema enforces
// additionalProperties:false. Sending sessionKey/overrides causes a hard
// validation rejection, so the per-session model override must send only
// schema-valid fields (key + model, optional agentId) and reflect the
// Gateway-resolved canonical model back to the client.
async function withModelPatchApp(
  gatewayImpl: (method: string, params: any) => Promise<any>,
  fn: (ctx: { app: Hono; store: DeckStore; calls: Array<{ method: string; params: any }> }) => Promise<void>,
) {
  const previousHome = process.env.HOME;
  const home = await mkdtemp(join(tmpdir(), 'dashboard-cod093-model-'));
  process.env.HOME = home;
  const calls: Array<{ method: string; params: any }> = [];
  const store = new DeckStore({ sessionTitlesFile: join(home, 'titles.json'), sessionThinkingOverridesFile: join(home, 'thinking.json') });
  store.upsertSession({ sessionKey: 'agent:ops-pm:dashboard:s1', agentId: 'ops-pm', title: 'S1', status: 'idle', hasActiveRun: false, source: 'web' });
  const gateway = {
    requestBound: async (method: string, params: any, _connection: unknown, authorize: () => void) => {
      authorize();
      calls.push({ method, params });
      return { payload: await gatewayImpl(method, params), connectionId: 'synthetic-connection' };
    },
  } as any;
  const app = new Hono();
  const turns = createTestTurnQueue({ store });
  registerSessionRoutes(app, { commands: turns.commands, deletionAdmission: key => turns.canDeleteSession(key), settingsAdmission: key => turns.canChangeSettings(key), queueActor: () => 'test-actor',
    store,
    gateway,
    refreshSessions: async () => undefined,
    refreshMessages: async () => undefined,
    resolveExplicitChannelRoute: () => undefined,
    mirrorAssistantReplyToChannel: async () => undefined,
    normalizeError: (error) => error instanceof Error ? error.message : String(error),
    queue: turns.queue,
  });
  try {
    await fn({ app, store, calls });
  } finally {
    await turns.close();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
}

test('per-session model override sends only schema-valid sessions.patch fields', async () => {
  await withModelPatchApp(
    async (method) => {
      if (method === 'sessions.patch') {
        return { ok: true, key: 'agent:ops-pm:dashboard:s1', resolved: { modelProvider: 'github-copilot', model: 'gpt-5.5' } };
      }
      return {};
    },
    async ({ app, store, calls }) => {
      const response = await app.request('/api/sessions/agent:ops-pm:dashboard:s1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'github-copilot/gpt-5.5', thinking: 'high' }),
      });
      assert.equal(response.status, 200);
      const patch = calls.find((call) => call.method === 'sessions.patch');
      assert.ok(patch, 'sessions.patch was called');
      assert.equal(patch.params.key, 'agent:ops-pm:dashboard:s1');
      assert.equal(patch.params.model, 'github-copilot/gpt-5.5');
      assert.equal(patch.params.agentId, 'ops-pm');
      assert.equal(patch.params.thinkingLevel, 'high');
      assert.equal('thinking' in patch.params, false);
      // Illegal fields would be rejected by the Gateway schema.
      assert.equal('sessionKey' in patch.params, false);
      assert.equal('overrides' in patch.params, false);
      // No bogus session.patch fallback method.
      assert.equal(calls.some((call) => call.method === 'session.patch'), false);

      const { settings: body } = await response.json() as { settings: { model?: string; modelProvider?: string; thinkingLevel?: string } };
      assert.equal(body.model, 'gpt-5.5');
      assert.equal(body.modelProvider, 'github-copilot');
      assert.equal(body.thinkingLevel, 'high');
      assert.equal(store.getSessionsState().groups[0]?.sessions[0]?.thinkingLevel, 'high');
    },
  );
});

test('per-session model override keeps errors after native write unknown', async () => {
  await withModelPatchApp(
    async (method) => {
      if (method === 'sessions.patch') {
        throw new Error("invalid sessions.patch params: at root: unexpected property 'sessionKey'");
      }
      return {};
    },
    async ({ app }) => {
      const response = await app.request('/api/sessions/agent:ops-pm:dashboard:s1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'github-copilot/gpt-5.5' }),
      });
      assert.equal(response.status, 202);
      const body = await response.json() as { command: { state: string } };
      assert.equal(body.command.state, 'outcome_unknown');
    },
  );
});

test('blank model override is rejected before hitting the Gateway', async () => {
  await withModelPatchApp(
    async () => ({}),
    async ({ app, calls }) => {
      const response = await app.request('/api/sessions/agent:ops-pm:dashboard:s1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: '   ' }),
      });
      assert.equal(response.status, 400);
      assert.equal(calls.some((call) => call.method === 'sessions.patch'), false);
    },
  );
});

test('per-session model reset sends null override without leaking invalid Gateway fields', async () => {
  await withModelPatchApp(
    async (method) => {
      if (method === 'sessions.patch') {
        return { ok: true, key: 'agent:ops-pm:dashboard:s1', resolved: {} };
      }
      return {};
    },
    async ({ app, calls }) => {
      const response = await app.request('/api/sessions/agent:ops-pm:dashboard:s1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: null }),
      });
      assert.equal(response.status, 200);
      const patch = calls.find((call) => call.method === 'sessions.patch');
      assert.ok(patch, 'sessions.patch was called');
      assert.equal(patch.params.key, 'agent:ops-pm:dashboard:s1');
      assert.equal(patch.params.model, null);
      assert.equal(patch.params.agentId, 'ops-pm');
      assert.equal('sessionKey' in patch.params, false);
      assert.equal('overrides' in patch.params, false);

      const { settings: body } = await response.json() as { settings: { model?: string | null; modelProvider?: string | null; thinkingLevel?: string } };
      assert.equal(body.model, null);
      assert.equal(body.modelProvider, null);
      assert.equal(body.thinkingLevel, undefined);
    },
  );
});

test('per-session thinking reset clears locally persisted thinking projection', async () => {
  await withModelPatchApp(
    async (method) => {
      if (method === 'sessions.patch') return { ok: true, key: 'agent:ops-pm:dashboard:s1', resolved: {} };
      return {};
    },
    async ({ app, store }) => {
      store.persistSessionThinkingOverride('agent:ops-pm:dashboard:s1', 'medium');
      assert.equal(store.getSessionsState().groups[0]?.sessions[0]?.thinkingLevel, 'medium');

      const response = await app.request('/api/sessions/agent:ops-pm:dashboard:s1', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: null, thinking: null }),
      });

      assert.equal(response.status, 200);
      const { settings: body } = await response.json() as { settings: { thinkingLevel?: string | null } };
      assert.equal(body.thinkingLevel, null);
      assert.equal(store.getSessionsState().groups[0]?.sessions[0]?.thinkingLevel, undefined);
    },
  );
});
