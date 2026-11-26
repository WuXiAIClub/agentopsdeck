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
import { AsyncConnectorOwner } from '../connector/async-connector-owner.js';
import { registerSdkCompactHttp } from '../connector/sdk-compact-http.js';
import { AntigravityConnectorRuntime, AntigravityOwnedRuntime, AntigravitySdkTurn, createAsyncAntigravityOwnedRuntime } from './sdk-runtime.js';
import { AntigravityProcessWorker } from './execution-worker.js';

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

async function createConnectorFixture(extraEnv: Record<string, string> = {}, workspaceName = 'workspace') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agentopsdeck-antigravity-connector-')));
  const homeDirectory = join(root, 'private');
  const workspace = join(root, workspaceName);
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

test('antigravitySubagentObservation projects ACP subagent tool calls to CodexSubagentObservation', async () => {
  const { antigravitySubagentObservation } = await import('./sdk-runtime.js');
  assert.deepEqual(
    antigravitySubagentObservation('Run invoke_subagent', 'call_1', 'running', 1000),
    {
      action: 'spawnAgent',
      source: 'live',
      observedAt: 1000,
      agents: [{ id: 'call_1', path: 'Run invoke_subagent', status: 'running' }],
    },
  );
  assert.deepEqual(
    antigravitySubagentObservation('Run invoke_subagent', 'call_1', 'completed', 2000, '  OK  '),
    {
      action: 'spawnAgent',
      source: 'live',
      observedAt: 2000,
      agents: [{ id: 'call_1', path: 'Run invoke_subagent', status: 'completed', latestText: 'OK' }],
    },
  );
  assert.equal(antigravitySubagentObservation('Run send_message', 'call_2', 'running', 3000)?.action, 'sendInput');
  assert.equal(antigravitySubagentObservation('Run manage_subagents', 'call_3', 'errored', 4000)?.action, 'closeAgent');
  assert.equal(antigravitySubagentObservation('Read', 'call_4', 'running', 5000), undefined);
});

test('Antigravity Connector settles clean ACP error after tool calls as failed without wedging session', async () => {
  const fixture = await createConnectorFixture();
  try {
    const created = await fixture.request('/agents/antigravity/sessions', 'POST', { title: 'ACP Error Isolation' }, { 'idempotency-key': 'agy-create-acp-err' });
    assert.equal(created.status, 201);
    const { key } = await created.json() as { key: string };
    const encodedKey = encodeURIComponent(key);

    const failedSend = await fixture.request(`/sessions/${encodedKey}/messages`, 'POST', {
      message: 'acp-error-after-tool',
      idempotencyKey: 'agy-acp-err-1',
    });
    assert.equal(failedSend.status, 200);

    await waitFor(async () => {
      const execution = fixture.users.antigravityJournal.current(key);
      return execution?.phase === 'failed' ? execution : undefined;
    });
    assert.equal(fixture.users.antigravityJournal.canStart(key), true);

    const historyAfterFailure = await fixture.request(`/sessions/${encodedKey}/messages`);
    assert.equal(historyAfterFailure.status, 200);
    const failedPayload = await historyAfterFailure.json() as { messages: Array<{ role: string; text: string; toolPhase?: string }> };
    assert.ok(failedPayload.messages.some(item => item.role === 'tool' && item.toolPhase === 'call'));
    assert.ok(failedPayload.messages.some(item => item.role === 'assistant' && item.text.includes('partial before upstream error')));

    const followUp = await fixture.request(`/sessions/${encodedKey}/messages`, 'POST', {
      message: 'follow up after clean error',
      idempotencyKey: 'agy-acp-err-2',
    });
    assert.equal(followUp.status, 200);
    await waitFor(async () => {
      const response = await fixture.request(`/sessions/${encodedKey}/messages`);
      const payload = await response.json() as { messages: Array<{ role: string; text: string }> };
      return payload.messages.some(item => item.role === 'assistant' && item.text.includes('你好，ACP')) ? true : undefined;
    });
    await waitFor(async () => (fixture.users.antigravityJournal.canStart(key) ? true : undefined));
  } finally {
    await fixture.close();
  }
});

test('Antigravity Connector recovers unknown session in-process via POST /recovery and returns 409 before recovery', async () => {
  const fixture = await createConnectorFixture();
  try {
    const created = await fixture.request('/agents/antigravity/sessions', 'POST', { title: 'ACP Recovery' }, { 'idempotency-key': 'agy-create-recover' });
    assert.equal(created.status, 201);
    const { key } = await created.json() as { key: string };
    const encodedKey = encodeURIComponent(key);

    // Establish an initial completed turn so native session binding exists.
    const first = await fixture.request(`/sessions/${encodedKey}/messages`, 'POST', {
      message: 'hello before disconnect',
      idempotencyKey: 'agy-rec-1',
    });
    assert.equal(first.status, 200);
    await waitFor(async () => (fixture.users.antigravityJournal.canStart(key) ? true : undefined));

    // Trigger hard mid-turn process disconnect -> enters unknown phase.
    const crashed = await fixture.request(`/sessions/${encodedKey}/messages`, 'POST', {
      message: 'disconnect',
      idempotencyKey: 'agy-rec-2',
    });
    assert.equal(crashed.status, 200);
    const unknownRunId = await waitFor(async () => {
      const execution = fixture.users.antigravityJournal.current(key);
      return execution?.phase === 'unknown' ? execution.id : undefined;
    });

    // Sending while unknown returns clean 409 Conflict instead of 503.
    const blockedSend = await fixture.request(`/sessions/${encodedKey}/messages`, 'POST', {
      message: 'blocked while unknown',
      idempotencyKey: 'agy-rec-blocked',
    });
    assert.equal(blockedSend.status, 409);

    // Explicit owner-authorized in-process recovery unblocks the session.
    const recovered = await waitFor(async () => {
      const response = await fixture.request(`/sessions/${encodedKey}/recovery`, 'POST', { expectedRunId: unknownRunId });
      return response.status === 200 ? response : undefined;
    });
    assert.deepEqual(await recovered.json(), { requested: true });
    assert.equal(fixture.users.antigravityJournal.canStart(key), true);

    // Subsequent turn dispatches and completes cleanly without restarting the connector.
    const resumed = await fixture.request(`/sessions/${encodedKey}/messages`, 'POST', {
      message: 'hello after recovery',
      idempotencyKey: 'agy-rec-3',
    });
    assert.equal(resumed.status, 200);
    await waitFor(async () => {
      const execution = fixture.users.antigravityJournal.current(key);
      return execution?.phase === 'completed' && fixture.users.antigravityJournal.canStart(key) ? true : undefined;
    });
  } finally {
    await fixture.close();
  }
});

test('AntigravitySdkTurn settles completed turn when forced cleanup empties lingering descendant process group', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agentopsdeck-antigravity-lingering-')));
  try {
    const homeDirectory = join(root, 'private');
    const workspace = join(root, 'workspace');
    mkdirSync(homeDirectory, { mode: 0o700 });
    for (const name of ['config', 'cache', 'data', 'tmp']) mkdirSync(join(homeDirectory, name), { mode: 0o700 });
    mkdirSync(workspace, { mode: 0o700 });
    const command = createExecutableWrapper(root);
    const config = { command, homeDirectory, workspace, startupTimeoutMs: 5_000 };
    const execution = {
      id: 'exec-lingering-1',
      key: 'antigravity:lingering-test',
      epoch: 'epoch-1',
      kind: 'message' as const,
      nativeSessionId: '11111111-1111-4111-8111-111111111111',
      nativeMode: 'create' as const,
      phase: 'running' as const,
      members: ['cmd-1'],
      stopRequested: false,
      createdAt: 1,
      updatedAt: 1,
    };
    const turn = new AntigravitySdkTurn({
      config,
      execution,
      text: 'lingering-descendant',
      projection: { project: () => {}, stream: () => {} },
      assertOwnership: () => {},
      createWorker: options => new AntigravityProcessWorker({ ...options, drainGraceMs: 120, drainKillMs: 500 }),
    });
    await turn.admitted;
    await turn.finished;
    assert.equal(turn.terminalOutcome(), 'completed');
    assert.equal(await turn.inspectCleaned(), true);
    assert.deepEqual(await turn.inspectSettlement(), { historyPersisted: true, nativeQuiescent: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Antigravity Connector supports dedicated manual compaction, metrics update, and idempotent receipts', async () => {
  const fixture = await createConnectorFixture();
  try {
    const capabilitiesRes = await fixture.request('/capabilities');
    assert.equal(capabilitiesRes.status, 200);
    const capabilities = await capabilitiesRes.json() as { runtimes: { antigravity: { features: { compact: boolean } } } };
    assert.equal(capabilities.runtimes.antigravity.features.compact, true);

    const created = await fixture.request('/agents/antigravity/sessions', 'POST', { title: 'ACP Compact' }, { 'idempotency-key': 'agy-create-compact' });
    assert.equal(created.status, 201);
    const { key } = await created.json() as { key: string };
    const encodedKey = encodeURIComponent(key);

    // Unmaterialized (allocated) session cannot compact yet.
    const earlyCompact = await fixture.request(`/sessions/${encodedKey}/compact`, 'POST', {}, { 'idempotency-key': 'agy-compact-early' });
    assert.equal(earlyCompact.status, 409);

    // First chat turn materializes the native session binding.
    const firstTurn = await fixture.request(`/sessions/${encodedKey}/messages`, 'POST', {
      message: 'initial message before compact',
      idempotencyKey: 'agy-compact-msg-1',
    });
    assert.equal(firstTurn.status, 200);
    await waitFor(async () => (fixture.users.antigravityJournal.canStart(key) && fixture.users.antigravityJournal.session(key)?.nativeState === 'ready' ? true : undefined));

    const beforeMessages = (await (await fixture.request(`/sessions/${encodedKey}/messages`)).json() as { messages: Array<{ id: string }> }).messages;

    // Explicit dedicated compact control succeeds and runs ACP /compact via session/resume.
    const compactRes = await fixture.request(`/sessions/${encodedKey}/compact`, 'POST', {}, { 'idempotency-key': 'agy-compact-run-1' });
    assert.equal(compactRes.status, 200);
    const compactBody = await compactRes.json() as { ok: boolean; status: string; runId: string };
    assert.equal(compactBody.ok, true);
    assert.equal(compactBody.status, 'compacting');
    assert.ok(compactBody.runId);

    // Receipt lookup returns the accepted command.
    const receiptRes = await fixture.request(`/sessions/${encodedKey}/compact-commands/agy-compact-run-1`);
    assert.equal(receiptRes.status, 200);
    const receiptBody = await receiptRes.json() as { command: { state: string } };
    assert.equal(receiptBody.command.state, 'accepted');

    // Wait for compaction to settle cleanly.
    await waitFor(async () => {
      const execution = fixture.users.antigravityJournal.current(key);
      return execution?.kind === 'compact' && execution.id === compactBody.runId && execution.phase === 'completed'
        && fixture.users.antigravityJournal.canStart(key) ? execution : undefined;
    });

    const sessionAfter = fixture.users.antigravityJournal.session(key)!;
    assert.equal(sessionAfter.nativeState, 'ready');
    assert.equal(sessionAfter.metrics?.compactionCount, 1);
    assert.equal(sessionAfter.metrics?.context?.basis, 'post-compaction');

    // Compaction does not inject spurious /compact user/assistant chat messages.
    const afterMessages = (await (await fixture.request(`/sessions/${encodedKey}/messages`)).json() as { messages: Array<{ id: string; text: string }> }).messages;
    assert.equal(afterMessages.length, beforeMessages.length);
    assert.equal(afterMessages.some(item => item.text.includes('/compact')), false);

    const rpcLog = readFileSync(join(fixture.workspace, 'requests.ndjson'), 'utf8');
    assert.match(rpcLog, /"method":"session\/resume"/);
    assert.match(rpcLog, /"text":"\/compact"/);

    // Subsequent chat turn runs cleanly after compaction.
    const nextTurn = await fixture.request(`/sessions/${encodedKey}/messages`, 'POST', {
      message: 'follow up after compaction',
      idempotencyKey: 'agy-compact-msg-2',
    });
    assert.equal(nextTurn.status, 200);
    await waitFor(async () => {
      const execution = fixture.users.antigravityJournal.current(key);
      return execution?.kind === 'message' && execution.phase === 'completed' && fixture.users.antigravityJournal.canStart(key) ? true : undefined;
    });
  } finally {
    await fixture.close();
  }
});

test('Antigravity Connector settles clean ACP compact error as failed and supports /stop cancellation during compact', async () => {
  // 1) Clean AntigravityAcpError during /compact settles as failed without wedging.
  const errFixture = await createConnectorFixture({}, 'compact-error');
  try {
    const created = await errFixture.request('/agents/antigravity/sessions', 'POST', { title: 'Compact Error' }, { 'idempotency-key': 'agy-ce-create' });
    assert.equal(created.status, 201);
    const { key } = await created.json() as { key: string };
    const encodedKey = encodeURIComponent(key);

    assert.equal((await errFixture.request(`/sessions/${encodedKey}/messages`, 'POST', { message: 'seed', idempotencyKey: 'agy-ce-1' })).status, 200);
    await waitFor(async () => (errFixture.users.antigravityJournal.canStart(key) ? true : undefined));

    const compactRes = await errFixture.request(`/sessions/${encodedKey}/compact`, 'POST', {}, { 'idempotency-key': 'agy-ce-compact' });
    assert.equal(compactRes.status, 200);
    const { runId } = await compactRes.json() as { runId: string };

    await waitFor(async () => {
      const execution = errFixture.users.antigravityJournal.current(key);
      return execution?.kind === 'compact' && execution.id === runId && execution.phase === 'failed'
        && errFixture.users.antigravityJournal.canStart(key) ? execution : undefined;
    });
    assert.equal(errFixture.users.antigravityJournal.session(key)?.metrics?.compactionCount, 0);
  } finally {
    await errFixture.close();
  }

  // 2) /stop interrupts an in-flight Antigravity compaction via session/cancel without wedging.
  const cancelFixture = await createConnectorFixture({}, 'compact-cancel');
  try {
    const created = await cancelFixture.request('/agents/antigravity/sessions', 'POST', { title: 'Compact Cancel' }, { 'idempotency-key': 'agy-cc-create' });
    assert.equal(created.status, 201);
    const { key } = await created.json() as { key: string };
    const encodedKey = encodeURIComponent(key);

    assert.equal((await cancelFixture.request(`/sessions/${encodedKey}/messages`, 'POST', { message: 'seed', idempotencyKey: 'agy-cc-1' })).status, 200);
    await waitFor(async () => (cancelFixture.users.antigravityJournal.canStart(key) ? true : undefined));

    const compactRes = await cancelFixture.request(`/sessions/${encodedKey}/compact`, 'POST', {}, { 'idempotency-key': 'agy-cc-compact' });
    assert.equal(compactRes.status, 200);
    const { runId } = await compactRes.json() as { runId: string };

    await waitFor(async () => {
      const log = readFileSync(join(cancelFixture.workspace, 'requests.ndjson'), 'utf8');
      return log.includes('"text":"/compact"') ? true : undefined;
    });

    const stopRes = await cancelFixture.request(`/sessions/${encodedKey}/messages`, 'POST', {
      message: '/stop',
      expectedRunId: runId,
      idempotencyKey: 'agy-cc-stop',
    });
    assert.equal(stopRes.status, 200);

    await waitFor(async () => {
      const execution = cancelFixture.users.antigravityJournal.current(key);
      return execution?.kind === 'compact' && execution.id === runId && execution.phase === 'interrupted'
        && cancelFixture.users.antigravityJournal.canStart(key) ? execution : undefined;
    });
    assert.match(readFileSync(join(cancelFixture.workspace, 'requests.ndjson'), 'utf8'), /"method":"session\/cancel"/);
  } finally {
    await cancelFixture.close();
  }
});

test('Async Antigravity owned runtime runs manual compaction with dynamic model overrides over ACP', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agentopsdeck-antigravity-async-compact-')));
  const homeDirectory = join(root, 'private');
  const workspace = join(root, 'workspace');
  mkdirSync(homeDirectory, { mode: 0o700 });
  for (const name of ['config', 'cache', 'data', 'tmp']) mkdirSync(join(homeDirectory, name), { mode: 0o700 });
  mkdirSync(workspace, { mode: 0o700 });
  const command = createExecutableWrapper(root);
  const tokenFile = join(root, 'tokens.json');
  const dbFile = join(root, 'connector.sqlite');
  const tokens = new ConnectorTokenStore(tokenFile);
  const ownerToken = tokens.create({ label: 'async-compact-owner', scopes: ['sessions:create', 'sessions:read', 'messages:read', 'messages:send'] }).token;
  const authorization = `Bearer ${ownerToken}`;

  const owner = new AsyncConnectorOwner({
    file: dbFile,
    tokenFile,
    sdkModels: { antigravity: { model: 'default', dynamicModels: true } },
  });
  await owner.open();
  const runtime = await createAsyncAntigravityOwnedRuntime({
    owner,
    config: { command, homeDirectory, workspace, startupTimeoutMs: 5_000, compactTimeoutMs: 10_000 },
  });
  const app = new Hono();
  registerSdkCompactHttp(app, '/api/connector/v1/sessions/:sessionKey', {
    owner,
    ready: () => runtime.ready,
    compact: (_runtime, key, commandKey, auth, signal) => runtime.driver.compact(key, commandKey, auth, signal),
  });

  try {
    assert.equal(await runtime.initialize(), true);
    const created = await owner.command('sdkSessionCreate', {
      runtime: 'antigravity',
      authorization,
      commandKey: 'async-create-1',
      payloadJson: JSON.stringify({ title: 'Async Compact' }),
    });
    assert.ok(!('error' in created) && created.key);
    const key = created.key;

    // Select a dynamically discovered model (not in any static modelChoices list).
    const modelUpdated = await owner.command('sdkModelUpdate', {
      runtime: 'antigravity',
      key,
      authorization,
      commandKey: 'async-model-1',
      payloadJson: JSON.stringify({ model: 'claude-opus-5-5-high' }),
    });
    assert.ok(!('error' in modelUpdated) && modelUpdated.receipt.state === 'accepted');

    // Send an initial turn to materialize the session binding.
    const sent = await owner.command('sdkMessageSend', {
      runtime: 'antigravity',
      key,
      authorization,
      commandKey: 'async-msg-1',
      payloadJson: JSON.stringify({ message: 'seed async session' }),
    });
    assert.ok(!('error' in sent));
    await runtime.driver.wake(key);
    await waitFor(async () => {
      const snap = await owner.command('sdkSnapshotRead', { runtime: 'antigravity', key });
      return snap.canStart && snap.session?.nativeState === 'ready' ? snap : undefined;
    });

    // Trigger manual compaction through registerSdkCompactHttp.
    const res = await app.request(`/api/connector/v1/sessions/${encodeURIComponent(key)}/compact`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json', 'idempotency-key': 'async-compact-1' },
      body: '{}',
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { ok: boolean; status: string; runId: string };
    assert.equal(body.ok, true);
    assert.equal(body.status, 'compacting');

    const finalSnap = await waitFor(async () => {
      const snap = await owner.command('sdkSnapshotRead', { runtime: 'antigravity', key });
      return snap.execution?.kind === 'compact' && snap.execution.id === body.runId && snap.execution.phase === 'completed'
        && snap.canStart ? snap : undefined;
    });
    assert.equal(finalSnap.session?.metrics?.compactionCount, 1);
    assert.equal(finalSnap.session?.metrics?.context?.basis, 'post-compaction');

    const rpcLog = readFileSync(join(workspace, 'requests.ndjson'), 'utf8');
    assert.match(rpcLog, /"modelId":"claude-opus-5-5-high"/);
    assert.match(rpcLog, /"text":"\/compact"/);
  } finally {
    await runtime.close().catch(() => {});
    await owner.closeForShutdown().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});
