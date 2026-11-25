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

async function createConnectorFixture() {
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
