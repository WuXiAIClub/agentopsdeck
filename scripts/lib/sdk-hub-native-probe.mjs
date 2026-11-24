// Isolated authenticated HTTP Hub -> Connector -> pinned native workers.
// All identities, tokens and provider replies are synthetic. No live state.
import assert from 'node:assert/strict';
import { mkdir, writeFile, cp, rename, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { sdkSourceImport as source } from './sdk-source-import.mjs';
import { registerIsolatedProbeGroup } from './isolated-sdk-probe.mjs';

export async function verifySdkHubNative({ root, sdkRoot, base, inferenceCount, observedModel, browserProbe }) {
  assert.equal(process.env.AOD_SDK_PROBE_WORKER, root);
  const load = path => source(`../../apps/server/src/${path}.ts`, import.meta.url);
  const { Hono } = await import('../../apps/server/node_modules/hono/dist/index.js');
  const { serve } = await import('../../apps/server/node_modules/@hono/node-server/dist/index.mjs');
  const { loadConfig } = await load('config');
  const { ConnectorUserStore } = await load('connector/connector-user-store');
  const { ConnectorTokenStore } = await load('auth/connector-token');
  const { DeckStore } = await load('projection/deck-store');
  const { HubStore } = await load('hub/hub-store');
  const { createApplication } = await load('application');
  const { registerConnectorRoutes } = await load('routes/connector');
  const { decodeHubSessionId } = await load('hub/session-id');
  const { ClaudeConnectorRuntime } = await load('claude/connector-runtime');
  const { ClaudeOwnedRuntime } = await load('claude/owned-runtime');
  const { ClaudeWorkerTurn } = await load('claude/worker-turn');
  const { ClaudeWorkerPreflight, ClaudeWorkerDeletion } = await load('claude/worker-preflight');
  const { CopilotConnectorRuntime } = await load('copilot/connector-runtime');
  const { CopilotOwnedRuntime } = await load('copilot/owned-runtime');
  const { CopilotWorkerTurn } = await load('copilot/worker-turn');
  const { CopilotWorkerPreflight, CopilotWorkerDeletion } = await load('copilot/worker-preflight');
  const { SdkCompactWorker } = await load('connector/sdk-compact-worker');
  const { claudeWorkerEnvironment } = await load('claude/worker-environment');
  const { copilotWorkerEnvironment } = await load('copilot/worker-environment');
  const data = join(root, 'hub-native-data'), backup = join(root, 'hub-native-backup');
  await mkdir(data, { mode: 0o700 });
  for (const name of ['claude-home', 'copilot-home', 'workspace']) await mkdir(join(data, name), { mode: 0o700 });
  const key = join(data, 'fixture-key'); await writeFile(key, 'fixture-not-a-secret', { mode: 0o600 });
  const config = loadConfig({ HOME: data, AOD_SERVER_ROLE: 'connector',
    AOD_CONNECTOR_TOKENS_FILE: join(data, 'tokens.json'),
    AOD_CONNECTOR_USERS_DATABASE_FILE: join(data, 'connector.sqlite'),
    AOD_SESSION_TITLES_FILE: join(data, 'titles.json') });
  const common = { workspace: join(data, 'workspace'), startupTimeoutMs: 25_000 };
  config.claude = { ...common, sdkDirectory: await realpath(join(sdkRoot, 'node_modules/@anthropic-ai/claude-agent-sdk')),
    homeDirectory: join(data, 'claude-home'), apiKeyFile: key, baseUrl: base, model: 'claude-sonnet-4-6', modelChoices: ['claude-opus-4-6'] };
  config.copilot = { ...common, sdkDirectory: await realpath(join(sdkRoot, 'node_modules/@github/copilot-sdk')),
    homeDirectory: join(data, 'copilot-home'), model: 'gpt-4.1', modelChoices: ['gpt-4.1-mini'], auth: { mode: 'provider', credentialFile: key,
      providerType: 'openai', wireApi: 'completions', baseUrl: `${base}/v1` } };
  const launch = vendor => ({ entry: join(root, 'compiled-server', vendor, 'worker-main.js'),
    execArgv: [], beforeStart: registerIsolatedProbeGroup });
  const compactWorker = runtime => request => new SdkCompactWorker(request, {
    runtime, workspace: request.config.workspace, timeoutMs: 25000, launch: launch(runtime === 'ghcp' ? 'copilot' : 'claude'),
    env: runtime === 'ghcp' ? copilotWorkerEnvironment(request.config) : claudeWorkerEnvironment(request.config),
  });
  const listen = async (app, port = 0) => {
    const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port });
    if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
    return { origin: `http://127.0.0.1:${server.address().port}`, close: async () => {
      const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      server.closeAllConnections(); await closed;
    } };
  };
  const wait = async (check, label) => {
    for (let i = 0; i < 500; i++) { if (await check()) return; await delay(20); }
    assert.fail(`Isolated Hub timeout: ${label}`);
  };
  let ownerId, login, otherLogin, credential, current, connectorPort;
  const nativeStarts = [], sessions = new Map();
  async function open(paused = false) {
    const users = new ConnectorUserStore(config.connector.usersDatabaseFile, () => true, { runtimeOwner: true });
    users.events.beginEpoch();
    const tokens = new ConnectorTokenStore(config.connector.tokenFile), deck = new DeckStore({
      eventLog: users.events, sessionTitlesFile: config.sessionTitlesFile });
    const authorize = (_key, actor) => tokens.hasScope(actor.actorId, 'messages:send');
    const claude = new ClaudeConnectorRuntime({ store: users, projection: deck, config: config.claude, authorize },
      options => new ClaudeOwnedRuntime(options, (request, project, stream, metrics) => {
        nativeStarts.push({ runtime: 'claude-code', text: request.text });
        return new ClaudeWorkerTurn(request, launch('claude'), project, stream, metrics);
      }, settings => new ClaudeWorkerPreflight(settings, launch('claude')),
      (settings, request) => new ClaudeWorkerDeletion(settings, request, launch('claude')), compactWorker('claude-code')));
    const copilot = new CopilotConnectorRuntime({ store: users, projection: deck, config: config.copilot, authorize },
      options => new CopilotOwnedRuntime(options, (request, projection) => {
        nativeStarts.push({ runtime: 'ghcp', text: request.text });
        return new CopilotWorkerTurn(request, launch('copilot'), projection);
      }, settings => new CopilotWorkerPreflight(settings, launch('copilot')),
      (settings, request) => new CopilotWorkerDeletion(settings, request, launch('copilot')), compactWorker('ghcp')));
    const runtimes = [claude, copilot], pauses = paused ? runtimes.map(r => r.pauseQueueWorker()) : [];
    const connector = new Hono();
    const routes = registerConnectorRoutes(connector, { config, tokens, connectorUsers: users, store: deck, claude, copilot,
      gateway: { request: () => assert.fail('SDK runtime must never fall through to OpenClaw') },
      sessionSnapshotReady: () => true, historySnapshotReady: session => (session.startsWith('ghcp:') ? copilot : claude).isSessionHistoryReady(session),
      refreshSessions: async () => { for (const r of runtimes) r.refreshDirectory(); },
      refreshMessages: (session, options) => (session.startsWith('ghcp:') ? copilot : claude).refreshSession(session, options),
      fallbackAgents: () => runtimes.map(r => ({ id: r.id, label: r.id === 'ghcp' ? 'GitHub Copilot' : 'Claude Code',
        status: r.ready ? 'available' : 'degraded' })),
      isAuthorizedRequest: () => false, normalizeError: () => 'Isolated Connector failure' });
    for (const r of runtimes) r.activate();
    if (paused) await Promise.all(pauses.map(p => p.drained));
    else await wait(() => runtimes.every(r => r.ready), 'native startup');
    const remote = await listen(connector, connectorPort), hub = new HubStore(join(data, 'hub.sqlite'), 'synthetic-vault');
    connectorPort = Number(new URL(remote.origin).port);
    if (!ownerId) {
      ownerId = hub.createUser('SDK fixture owner').id;
      login = hub.identities.issueKey(ownerId).token;
      otherLogin = hub.identities.issueKey(hub.createUser('Unrelated fixture user').id).token;
      credential = tokens.create({ label: 'Fixture owner', scopes: ['agents:read', 'events:read', 'sessions:create', 'sessions:read', 'messages:read', 'messages:send', 'queue:manage', 'models:read'] }).token;
    }
    hub.upsertConnection({ id: 'sdk-fixture', ownerUserId: ownerId, kind: 'remote', label: 'Isolated SDKs',
      capabilities: ['sessions', 'messages', 'events'], connectorUrl: remote.origin, credentialToken: credential }, { skipUnchanged: true });
    hub.close();
    const application = createApplication(loadConfig({ HOME: data, AOD_SERVER_ROLE: 'hub',
      AOD_ACCESS_KEY: 'synthetic-admin-key', AOD_HUB_VAULT_SECRET: 'synthetic-vault',
      AOD_HUB_DATABASE_FILE: join(data, 'hub.sqlite'), AOD_SESSION_TITLES_FILE: join(data, 'titles.json'),
      AOD_PASSKEYS_FILE: join(data, 'passkeys.json'), AOD_AUTH_SESSIONS_FILE: join(data, 'auth-sessions.json') }));
    const http = await listen(application.app);
    const request = (path, method = 'GET', body, token = login, headers = {}) => fetch(`${http.origin}${path.startsWith('/api/') ? path : `/api/hub/v1${path}`}`, {
      method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
    const json = async (path, method = 'GET', body, status = 200) => {
      const response = await request(path, method, body);
      const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value)); return value;
    };
    current = { users, runtimes, json, request, pauses, origin: http.origin, login, close: async () => {
      await http.close(); await application.close(); await remote.close(); routes.close();
      for (const r of runtimes) { const pause = r.pauseQueueWorker(); await pause.drained;
        const facts = r.inspectMaintenance(); assert.equal(facts.unresolvedExecutions, 0); assert.equal(facts.queuedInputs, 0); }
      await Promise.all(runtimes.map(r => r.close())); users.close(); current = undefined;
    } };
    await json('/connections/sdk-fixture/verify', 'POST', {});
    return current;
  }
  async function send(f, runtime, text, id) {
    const sessionId = sessions.get(runtime), path = `/sessions/${encodeURIComponent(sessionId)}`;
    const journal = runtime === 'ghcp' ? f.users.copilotJournal : f.users.claudeJournal;
    const nativeKey = decodeHubSessionId(sessionId).remoteSessionKey;
    const previousExecution = journal.current(nativeKey)?.id;
    const response = await f.json(`${path}/messages`, 'POST', { message: text, idempotencyKey: id });
    assert.equal(response.command.state, 'accepted');
    await f.json(`${path}/messages`, 'POST', { message: text, idempotencyKey: id });
    await wait(() => {
      const execution = journal.current(nativeKey);
      return execution?.id !== previousExecution && execution?.phase === 'completed';
    }, `${runtime} new terminal`);
    await wait(() => f.runtimes.every(r => r.inspectMaintenance().nativeWorkers === 0), 'worker cleanup');
    const history = await f.json(`${path}/messages?limit=200`);
    assert.equal(history.messages.filter(m => m.role === 'user' && m.text === text).length, 1,
      `Synthetic ${runtime} Hub history: ${JSON.stringify(history)}`);
    assert.ok(history.messages.some(m => m.role === 'assistant' && m.text === 'Isolated fixture reply.'));
    assert.equal((await f.json(`${path}/queue`)).items.length, 0);
    assert.equal((await f.request(`${path}/messages`, 'GET', undefined, otherLogin)).status, 404);
    await verifyMetrics(f, runtime, true);
    return history.messages;
  }
  async function verifyMetrics(f, runtime, expectContext) {
    const state = await f.json('/sessions/state');
    const summary = state.groups.flatMap(group => group.sessions).find(session => session.sessionKey === sessions.get(runtime));
    assert.ok(summary, 'Authorized Hub state includes SDK session');
    assert.equal(summary.nativeUsage?.scope, runtime === 'ghcp' ? 'last-call' : 'last-turn');
    assert.ok(summary.nativeUsage.inputTokens >= 20 && summary.nativeUsage.outputTokens >= 5);
    assert.equal(summary.compactionCount, 0);
    if (expectContext) {
      assert.equal(summary.contextSampleBasis, runtime === 'ghcp' ? 'native-context' : 'last-request-input');
      assert.ok(summary.contextUsedTokens >= 0);
      if (runtime === 'ghcp') assert.ok(summary.contextTokens > 0);
      else assert.equal(summary.contextTokens, undefined, 'Do not invent a Claude context window');
    } else {
      assert.equal(summary.contextUsedTokens, undefined, 'Model change invalidates the preceding context sample');
    }
    const denied = await f.request('/sessions/state', 'GET', undefined, otherLogin);
    assert.equal(denied.status, 200);
    assert.equal((await denied.json()).groups.flatMap(group => group.sessions).some(session => session.sessionKey === sessions.get(runtime)), false,
      'Native numeric metrics cannot cross owners');
  }
  const before = inferenceCount(), histories = new Map();
  const alternate = runtime => runtime === 'ghcp' ? 'gpt-4.1-mini' : 'claude-opus-4-6';
  async function changeModel(f, runtime, id, model) {
    const path = `/sessions/${encodeURIComponent(sessions.get(runtime))}`;
    const body = { idempotencyKey: id, model };
    const response = await f.json(`/api${path}`, 'PATCH', body);
    assert.equal(response.command.state, 'accepted');
    assert.equal((await f.json(`/api${path}`, 'PATCH', body)).command.state, 'accepted');
    assert.equal((await f.json(`${path}/settings-commands/${id}`)).command.state, 'accepted');
    return response;
  }
  try {
    let f = await open();
    for (const runtime of ['claude-code', 'ghcp']) {
      const path = `/connections/sdk-fixture/agents/${runtime}/sessions`;
      const body = { title: 'Native HTTP fixture', idempotencyKey: `create-${runtime}` };
      const created = await f.json(path, 'POST', body, 201); sessions.set(runtime, created.key);
      assert.equal((await f.json(path, 'POST', body, 201)).key, created.key);
      assert.equal((await f.json(`/connections/sdk-fixture/models/${runtime}`)).models.length, 2);
      histories.set(runtime, await send(f, runtime, `First ${runtime}`, `first-${runtime}`));
      await changeModel(f, runtime, `model-${runtime}`, alternate(runtime));
    }
    assert.equal(nativeStarts.length, 2);
    await f.close(); await cp(data, backup, { recursive: true, errorOnExist: true, force: false });
    // Reopen paused: durable history is readable without native startup/inference.
    f = await open(true);
    for (const [runtime, sessionId] of sessions) {
      const path = `/sessions/${encodeURIComponent(sessionId)}`;
      const page = await f.json(`${path}/messages?limit=200`);
      assert.deepEqual(page.messages, histories.get(runtime));
      await verifyMetrics(f, runtime, false);
      assert.equal((await f.json(`/api${path}`, 'PATCH', { idempotencyKey: `model-${runtime}`, model: alternate(runtime) })).command.state, 'accepted');
      const rejected = await f.json(`${path}/messages`, 'POST', { message: 'not admitted', idempotencyKey: `pause-${runtime}` }, 409);
      assert.equal(rejected.command.state, 'rejected');
    }
    assert.equal(nativeStarts.length, 2);
    for (const p of f.pauses) assert.equal(p.resume(), true);
    await wait(() => f.runtimes.every(r => r.ready), 'resume startup');
    for (const runtime of sessions.keys()) {
      await send(f, runtime, `Continued ${runtime}`, `continued-${runtime}`);
      assert.equal(observedModel(runtime), alternate(runtime), 'Actual native provider request uses persisted model override');
    }
    assert.equal(nativeStarts.length, 4); await f.close();
    // Exercise a full stopped snapshot restore at its original absolute paths.
    // These are disposable fixture data, never production backup rollback.
    await rename(data, join(root, 'hub-native-after-continuation'));
    await cp(backup, data, { recursive: true, errorOnExist: true, force: false });
    f = await open(true);
    for (const [runtime, sessionId] of sessions) {
      const page = await f.json(`/sessions/${encodeURIComponent(sessionId)}/messages?limit=200`);
      assert.deepEqual(page.messages, histories.get(runtime));
      await verifyMetrics(f, runtime, false);
    }
    for (const p of f.pauses) assert.equal(p.resume(), true);
    await wait(() => f.runtimes.every(r => r.ready), 'restored startup');
    for (const runtime of sessions.keys()) {
      await changeModel(f, runtime, `reset-${runtime}`, null);
      await send(f, runtime, `Restored ${runtime}`, `restored-${runtime}`);
      assert.equal(observedModel(runtime), runtime === 'ghcp' ? 'gpt-4.1' : 'claude-sonnet-4-6');
    }
    assert.equal(nativeStarts.length, 6); assert.equal(inferenceCount() - before, 6, 'Exactly one inference per new input; duplicate receipts never replay');
    console.log('Authenticated HTTP Hub/Connector + both real CLIs: create, send, duplicate receipts, history, owner denial, stopped backup/reopen/restore passed');
    if (browserProbe) {
      await browserProbe(f);
      await wait(() => f.runtimes.every(r => r.inspectMaintenance().nativeWorkers === 0), 'browser worker cleanup');
      assert.equal(nativeStarts.length, 8);
      assert.equal(inferenceCount() - before, 8, 'One inference per browser input');
    }
    const beforeCompact = inferenceCount();
    for (const [runtime, sessionId] of sessions) {
      const path = `/sessions/${encodeURIComponent(sessionId)}`, id = `compact-${runtime}`;
      const journal = runtime === 'ghcp' ? f.users.copilotJournal : f.users.claudeJournal;
      const nativeKey = decodeHubSessionId(sessionId).remoteSessionKey;
      assert.equal((await f.request(`${path}/compact`, 'POST', { idempotencyKey: id }, otherLogin)).status, 404);
      await f.json(`${path}/compact`, 'POST', { idempotencyKey: `${id}-payload`, message: 'not a prompt' }, 400);
      const accepted = await f.json(`${path}/compact`, 'POST', { idempotencyKey: id });
      assert.equal(accepted.command.state, 'accepted'); assert.equal(accepted.status, 'compacting');
      const repeated = await f.json(`${path}/compact`, 'POST', { idempotencyKey: id });
      assert.equal(repeated.runId, accepted.runId);
      assert.equal((await f.json(`${path}/compact-commands/${id}`)).command.state, 'accepted');
      assert.equal((await f.request(`${path}/compact-commands/${id}`, 'GET', undefined, otherLogin)).status, 404);
      await wait(() => journal.current(nativeKey)?.phase === 'completed', `${runtime} compact terminal`);
      await wait(() => f.runtimes.every(r => r.inspectMaintenance().nativeWorkers === 0), 'compact cleanup');
      assert.equal(journal.current(nativeKey).id, accepted.runId);
      assert.equal(journal.session(nativeKey).metrics.compactionCount, 1);
      assert.equal((await f.json(`${path}/queue`)).items.length, 0);
    }
    assert.equal(inferenceCount() - beforeCompact, 2, 'One inference per compact, no duplicate POST execution');
    await f.close(); f = await open(true);
    for (const [runtime, sessionId] of sessions) {
      const path = `/sessions/${encodeURIComponent(sessionId)}`;
      const journal = runtime === 'ghcp' ? f.users.copilotJournal : f.users.claudeJournal;
      const nativeKey = decodeHubSessionId(sessionId).remoteSessionKey;
      assert.equal(journal.current(nativeKey).phase, 'completed');
      assert.equal(journal.current(nativeKey).kind, 'compact');
      assert.equal(journal.canStart(nativeKey), true);
      assert.equal((await f.json(`${path}/compact-commands/compact-${runtime}`)).command.state, 'accepted');
      await f.json(`${path}/messages?limit=200`);
    }
    assert.equal(inferenceCount() - beforeCompact, 2, 'Reopen only reads original compact facts');
    for (const pause of f.pauses) assert.equal(pause.resume(), true);
    // A paused reopen intentionally never started native preflight. Resuming
    // admissions starts that asynchronous check; it is not readiness proof.
    await wait(() => f.runtimes.every(r => r.ready), 'native readiness after compact reopen');
    console.log('Both SDK compact controls: owner API, isolated receipt, duplicate exclusion, native boundary and stopped reopen passed');
    const beforeDeletion = inferenceCount(), startsBeforeDeletion = nativeStarts.length;
    const remove = async (f, path, runtime) => {
      // DELETE receipt keys are headers; unlike POST/PATCH this API ignores bodies.
      const response = await f.request(`/api${path}`, 'DELETE', undefined, login, { 'idempotency-key': `delete-${runtime}` });
      const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body));
      assert.equal(body.command.state, 'accepted');
    };
    for (const [runtime, sessionId] of sessions) {
      const path = `/sessions/${encodeURIComponent(sessionId)}`;
      assert.equal((await f.request(`/api${path}`, 'DELETE', undefined, otherLogin, { 'idempotency-key': `delete-${runtime}` })).status, 404);
      await remove(f, path, runtime); await remove(f, path, runtime);
      assert.equal((await f.request(`/api${path}`, 'DELETE', undefined, login, { 'idempotency-key': `different-delete-${runtime}` })).status, 409);
      assert.equal((await f.json(`${path}/deletion-commands/delete-${runtime}`)).command.state, 'accepted');
      assert.equal((await f.request(`${path}/messages`)).status, 404);
      assert.equal((await f.request(`${path}/state`)).status, 404);
    }
    await f.close(); f = await open(true);
    for (const [runtime, sessionId] of sessions) {
      const path = `/sessions/${encodeURIComponent(sessionId)}`;
      await remove(f, path, runtime);
      assert.equal((await f.request(`${path}/messages`)).status, 404);
      assert.equal((await f.json(`${path}/deletion-commands/delete-${runtime}`)).command.state, 'accepted');
    }
    const directory = await f.json('/sessions/state');
    assert.equal(directory.groups.flatMap(group => group.sessions).some(session => [...sessions.values()].includes(session.sessionKey)), false);
    assert.equal(inferenceCount(), beforeDeletion); assert.equal(nativeStarts.length, startsBeforeDeletion);
    console.log('Both SDK native deletions: owner-only API, durable duplicate/receipt, history denial, stopped reopen and no inference passed');
  } finally { await current?.close(); }
  return { claude: browserProbe ? 5 : 4, copilot: browserProbe ? 5 : 4 };
}
