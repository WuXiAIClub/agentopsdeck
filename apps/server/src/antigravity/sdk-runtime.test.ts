import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { Hono } from 'hono';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { loadConfig } from '../config.js';
import { DeckStore } from '../projection/deck-store.js';
import { registerConnectorRoutes } from '../routes/connector.js';
import { AntigravityConnectorRuntime, AntigravityOwnedRuntime } from './sdk-runtime.js';

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), 'acp-fixture.mjs');

function createExecutableWrapper(root: string): string {
  const wrapper = join(root, 'agy');
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${fixturePath}" "$@"\n`, { mode: 0o755 });
  chmodSync(wrapper, 0o755);
  return wrapper;
}

async function waitFor<T>(check: () => Promise<T | undefined>, timeoutMs = 8_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value !== undefined) return value;
    await delay(30);
  }
  throw new Error('Timed out waiting for Antigravity connector state');
}

async function createConnectorFixture(extraEnv: Record<string, string> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agentopsdeck-antigravity-connector-')));
  const homeDirectory = join(root, 'private');
  const workspace = join(root, 'workspace');
  mkdirSync(homeDirectory, { mode: 0o700 });
  for (const name of ['config', 'cache', 'data', 'tmp']) {
    mkdirSync(join(homeDirectory, name), { mode: 0o700 });
  }
  mkdirSync(workspace, { mode: 0o700 });
  const command = createExecutableWrapper(root);
  const config = loadConfig({
    AOD_CONNECTOR_TOKENS_FILE: join(root, 'tokens.json'),
    AOD_CONNECTOR_USERS_DATABASE_FILE: join(root, 'connector.sqlite'),
    AOD_SESSION_TITLES_FILE: join(root, 'titles.json'),
    AOD_ANTIGRAVITY_ENABLED: 'true',
    AOD_ANTIGRAVITY_DEDICATED: 'true',
    AOD_ANTIGRAVITY_HOME: homeDirectory,
    AOD_ANTIGRAVITY_WORKSPACE: workspace,
    AOD_ANTIGRAVITY_COMMAND: command,
    AOD_ANTIGRAVITY_STARTUP_TIMEOUT_MS: '5000',
    ...extraEnv,
  });
  assert.ok(config.antigravity);
  const users = new ConnectorUserStore(config.connector.usersDatabaseFile, () => true, { runtimeOwner: true });
  const tokens = new ConnectorTokenStore(config.connector.tokenFile);
  const deck = new DeckStore({ sessionTitlesFile: config.sessionTitlesFile });
  let owned: AntigravityOwnedRuntime | undefined;
  const antigravity = new AntigravityConnectorRuntime({
    store: users,
    config: config.antigravity,
    projection: deck,
    authorize: (_key, actor) => tokens.hasScope(actor.actorId, 'messages:send'),
  }, options => {
    owned = new AntigravityOwnedRuntime(options);
    return owned;
  });
  const app = new Hono();
  const routes = registerConnectorRoutes(app, {
    config,
    tokens,
    connectorUsers: users,
    store: deck,
    antigravity,
    gateway: { request: () => assert.fail('Antigravity must never fall through to OpenClaw') } as never,
    sessionSnapshotReady: () => true,
    historySnapshotReady: key => antigravity.isSessionHistoryReady(key),
    refreshSessions: async () => antigravity.refreshDirectory(),
    refreshMessages: key => antigravity.refreshSession(key),
    fallbackAgents: () => [],
    isAuthorizedRequest: () => true,
    normalizeError: () => 'Unavailable',
  });
  antigravity.activate();
  assert.ok(owned);
  assert.equal(await owned.initialize(), true);
  const token = tokens.createTransient([
    'sessions:create',
    'sessions:read',
    'messages:read',
    'messages:send',
    'queue:manage',
    'models:read',
  ]);
  const headers = { authorization: `Bearer ${token.token}`, 'content-type': 'application/json' };
  const request = (path: string, method = 'GET', body?: unknown, extra: Record<string, string> = {}) =>
    app.request(`/api/connector/v1${path}`, {
      method,
      headers: { ...headers, ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return {
    root,
    workspace,
    users,
    deck,
    antigravity,
    request,
    close: async () => {
      routes.close();
      await antigravity.close();
      users.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('Antigravity Connector creates session, sends and resumes turns, reads history, and deletes session', async () => {
  const fixture = await createConnectorFixture();
  try {
    const created = await fixture.request('/agents/antigravity/sessions', 'POST', { title: 'ACP E2E' }, { 'idempotency-key': 'agy-create-1' });
    assert.equal(created.status, 201);
    const createdBody = await created.json() as { key: string };
    assert.match(createdBody.key, /^antigravity:/);

    const encodedKey = encodeURIComponent(createdBody.key);
    const firstSend = await fixture.request(`/sessions/${encodedKey}/messages`, 'POST', {
      message: 'hello antigravity',
      idempotencyKey: 'agy-msg-1',
    });
    assert.equal(firstSend.status, 200);

    const firstHistory = await waitFor(async () => {
      const response = await fixture.request(`/sessions/${encodedKey}/messages`);
      assert.equal(response.status, 200);
      const payload = await response.json() as { messages: Array<{ role: string; text: string }> };
      const hasAssistant = payload.messages.some(item => item.role === 'assistant' && item.text.includes('你好，ACP'));
      return hasAssistant ? payload.messages : undefined;
    });
    assert.ok(firstHistory.some(item => item.role === 'user' && item.text === 'hello antigravity'));
    assert.ok(firstHistory.some(item => item.role === 'assistant' && item.text.includes('你好，ACP')));

    await waitFor(async () => (fixture.users.antigravityJournal.canStart(createdBody.key) ? true : undefined));

    const secondSend = await fixture.request(`/sessions/${encodedKey}/messages`, 'POST', {
      message: 'private-update',
      idempotencyKey: 'agy-msg-2',
    });
    assert.equal(secondSend.status, 200);

    const resumedHistory = await waitFor(async () => {
      const response = await fixture.request(`/sessions/${encodedKey}/messages`);
      assert.equal(response.status, 200);
      const payload = await response.json() as { messages: Array<{ role: string; text: string; toolPhase?: string }> };
      const hasVisible = payload.messages.some(item => item.role === 'assistant' && item.text.includes('synthetic-visible-text'));
      return hasVisible ? payload.messages : undefined;
    });
    assert.ok(resumedHistory.some(item => item.role === 'tool' && item.toolPhase === 'call'));
    assert.ok(resumedHistory.some(item => item.role === 'tool' && item.toolPhase === 'result'));
    assert.equal(resumedHistory.some(item => item.text.includes('synthetic-private-thought')), false);
    assert.equal(resumedHistory.some(item => item.text.includes('synthetic-private-input')), false);

    const rpcLog = readFileSync(join(fixture.workspace, 'requests.ndjson'), 'utf8');
    assert.match(rpcLog, /"method":"session\/new"/);
    assert.match(rpcLog, /"method":"session\/resume"/);

    await waitFor(async () => (fixture.users.antigravityJournal.canStart(createdBody.key) ? true : undefined));

    const deleted = await fixture.request(`/sessions/${encodedKey}`, 'DELETE', undefined, { 'idempotency-key': 'agy-del-1' });
    assert.equal(deleted.status, 200);
    await waitFor(async () => {
      const afterDelete = await fixture.request(`/sessions/${encodedKey}/messages`);
      return afterDelete.status === 404 ? true : undefined;
    });
  } finally {
    await fixture.close();
  }
});

test('Antigravity Connector interrupts an active turn via /stop and rejects unsupported capabilities with 409', async () => {
  const fixture = await createConnectorFixture();
  try {
    const created = await fixture.request('/agents/antigravity/sessions', 'POST', { title: 'ACP Control' }, { 'idempotency-key': 'agy-create-2' });
    assert.equal(created.status, 201);
    const { key } = await created.json() as { key: string };
    const encodedKey = encodeURIComponent(key);

    const compactResponse = await fixture.request(`/sessions/${encodedKey}/messages`, 'POST', {
      message: '/compact',
      idempotencyKey: 'agy-compact-1',
    });
    assert.equal(compactResponse.status, 409);

    const modelResponse = await fixture.request(`/sessions/${encodedKey}/settings`, 'PATCH', {
      model: 'custom-model',
    });
    assert.equal(modelResponse.status, 409);

    const sendCancel = await fixture.request(`/sessions/${encodedKey}/messages`, 'POST', {
      message: 'cancel',
      idempotencyKey: 'agy-cancel-turn',
    });
    assert.equal(sendCancel.status, 200);

    const runId = await waitFor(async () => {
      const execution = fixture.users.antigravityJournal.current(key);
      return execution && execution.phase === 'running' ? execution.id : undefined;
    });

    const stopResponse = await fixture.request(`/sessions/${encodedKey}/messages`, 'POST', {
      message: '/stop',
      expectedRunId: runId,
      idempotencyKey: 'agy-stop-1',
    });
    assert.equal(stopResponse.status, 200);

    await waitFor(async () => (fixture.users.antigravityJournal.canStart(key) ? true : undefined));

    const rpcLog = readFileSync(join(fixture.workspace, 'requests.ndjson'), 'utf8');
    assert.match(rpcLog, /"method":"session\/cancel"/);
  } finally {
    await fixture.close();
  }
});

test('Antigravity Connector exposes configured model catalog and applies per-session model overrides via session/set_model', async () => {
  const fixture = await createConnectorFixture({
    AOD_ANTIGRAVITY_MODEL: 'gemini-4-neon-high',
    AOD_ANTIGRAVITY_MODEL_CHOICES: 'gemini-4-neon-high,gemini-4-neon-xhigh',
  });
  try {
    const modelsResponse = await fixture.request('/models/antigravity');
    assert.equal(modelsResponse.status, 200);
    assert.deepEqual(await modelsResponse.json(), {
      models: [
        { id: 'gemini-4-neon-high', label: 'gemini-4-neon-high' },
        { id: 'gemini-4-neon-xhigh', label: 'gemini-4-neon-xhigh' },
      ],
    });

    const created = await fixture.request('/agents/antigravity/sessions', 'POST', { title: 'ACP Model Override' }, { 'idempotency-key': 'agy-create-model' });
    assert.equal(created.status, 201);
    const { key } = await created.json() as { key: string };
    const encodedKey = encodeURIComponent(key);

    const invalidModel = await fixture.request(`/sessions/${encodedKey}`, 'PATCH', { model: 'unconfigured-model', idempotencyKey: 'agy-model-invalid' });
    assert.equal(invalidModel.status, 400);

    const unsupportedThinking = await fixture.request(`/sessions/${encodedKey}`, 'PATCH', { model: 'gemini-4-neon-xhigh', thinking: 'high', idempotencyKey: 'agy-thinking-invalid' });
    assert.equal(unsupportedThinking.status, 400);

    const updated = await fixture.request(`/sessions/${encodedKey}`, 'PATCH', { model: 'gemini-4-neon-xhigh', idempotencyKey: 'agy-model-set' });
    assert.equal(updated.status, 200);
    assert.deepEqual((await updated.json()).settings, { model: 'gemini-4-neon-xhigh', modelProvider: null });
    assert.equal(fixture.users.antigravityJournal.session(key)?.model, 'gemini-4-neon-xhigh');

    const sent = await fixture.request(`/sessions/${encodedKey}/messages`, 'POST', {
      message: 'hello model override',
      idempotencyKey: 'agy-model-msg-1',
    });
    assert.equal(sent.status, 200);
    await waitFor(async () => {
      const response = await fixture.request(`/sessions/${encodedKey}/messages`);
      if (response.status !== 200) return undefined;
      const payload = await response.json() as { messages: Array<{ role: string; text: string }> };
      return payload.messages.some(item => item.role === 'assistant' && item.text.includes('你好，ACP')) ? true : undefined;
    });
    await waitFor(async () => (fixture.users.antigravityJournal.canStart(key) ? true : undefined));

    const rpcLog = readFileSync(join(fixture.workspace, 'requests.ndjson'), 'utf8');
    assert.match(rpcLog, /"method":"session\/set_model".*"modelId":"gemini-4-neon-xhigh"/);

    const reset = await fixture.request(`/sessions/${encodedKey}`, 'PATCH', { model: null, idempotencyKey: 'agy-model-reset' });
    assert.equal(reset.status, 200);
    assert.deepEqual((await reset.json()).settings, { model: 'gemini-4-neon-high', modelProvider: null });
    assert.equal(fixture.users.antigravityJournal.session(key)?.model, undefined);
  } finally {
    await fixture.close();
  }
});

test('Antigravity Connector dynamically discovers models (including Claude) via agy models when MODEL_CHOICES is omitted', async () => {
  const fixture = await createConnectorFixture({
    AOD_ANTIGRAVITY_MODEL: 'gemini-4-neon-high',
  });
  try {
    const modelsResponse = await fixture.request('/models/antigravity');
    assert.equal(modelsResponse.status, 200);
    assert.deepEqual(await modelsResponse.json(), {
      models: [
        { id: 'gemini-4-neon-high', label: 'Gemini 4 Neon (High)' },
        { id: 'gemini-4-neon-xhigh', label: 'Gemini 4 Neon (XHigh)' },
        { id: 'claude-opus-5-5-high', label: 'Claude Opus 5.5 (High)' },
        { id: 'claude-sonnet-5-5-high', label: 'Claude Sonnet 5.5 (High)' },
      ],
    });

    const created = await fixture.request('/agents/antigravity/sessions', 'POST', { title: 'ACP Dynamic Claude' }, { 'idempotency-key': 'agy-create-dynamic-claude' });
    assert.equal(created.status, 201);
    const { key } = await created.json() as { key: string };
    const encodedKey = encodeURIComponent(key);

    const updated = await fixture.request(`/sessions/${encodedKey}`, 'PATCH', { model: 'claude-opus-5-5-high', idempotencyKey: 'agy-dynamic-claude-set' });
    assert.equal(updated.status, 200);
    assert.deepEqual((await updated.json()).settings, { model: 'claude-opus-5-5-high', modelProvider: null });
    assert.equal(fixture.users.antigravityJournal.session(key)?.model, 'claude-opus-5-5-high');

    const sent = await fixture.request(`/sessions/${encodedKey}/messages`, 'POST', {
      message: 'hello dynamic claude',
      idempotencyKey: 'agy-dynamic-claude-msg-1',
    });
    assert.equal(sent.status, 200);
    await waitFor(async () => {
      const response = await fixture.request(`/sessions/${encodedKey}/messages`);
      if (response.status !== 200) return undefined;
      const payload = await response.json() as { messages: Array<{ role: string; text: string }> };
      return payload.messages.some(item => item.role === 'assistant' && item.text.includes('你好，ACP')) ? true : undefined;
    });
    await waitFor(async () => (fixture.users.antigravityJournal.canStart(key) ? true : undefined));

    const rpcLog = readFileSync(join(fixture.workspace, 'requests.ndjson'), 'utf8');
    assert.match(rpcLog, /"method":"session\/set_model".*"modelId":"claude-opus-5-5-high"/);
  } finally {
    await fixture.close();
  }
});
