import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { verifyCandidateRelease } from '../../../scripts/stage-candidate-release.mjs';

const root = process.env.AOD_TEST_CANDIDATE_ROOT ?? fileURLToPath(new URL('../../../', import.meta.url));
assert.ok(isAbsolute(root), 'Candidate root must be an absolute path');
const candidate = process.env.AOD_TEST_CANDIDATE_ROOT ? await verifyCandidateRelease(root) : undefined;
const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-codex-multinode-browser-'));
console.log('EVIDENCE', directory);
const require = createRequire(join(root, 'apps/server/package.json'));
const { serve } = require('@hono/node-server');
const { createProcessApplication } = await import(join(root, 'apps/server/dist/application-process.js'));
const { loadConfig } = await import(join(root, 'apps/server/dist/config.js'));
const { ConnectorTokenStore } = await import(join(root, 'apps/server/dist/auth/connector-token.js'));
const { chromium } = await import(process.env.AOD_TEST_PLAYWRIGHT ?? 'playwright');
const browserExecutable = process.env.AOD_TEST_CHROMIUM ?? chromium.executablePath();
const simulator = `
  const fs = require('node:fs');
  const file = process.argv[1];
  const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { requests: [], thread: null };
  const persist = () => { fs.writeFileSync(file + '.next', JSON.stringify(state)); fs.renameSync(file + '.next', file); };
  const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
  require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
    const request = JSON.parse(line); state.requests.push(request);
    let result = {};
    if (request.method === 'thread/start') {
      if (state.thread) throw new Error('duplicate thread');
      // Real thread/list metadata is stable between native effects. Omitting
      // timestamps makes the runtime's defensive Date.now() fallback change
      // every catalog read, so a causal snapshot can never reach a fixed head.
      const now = Math.floor(Date.now() / 1000);
      state.thread = { id: 'synthetic-thread', createdAt: now, updatedAt: now,
        status: { type: 'idle' }, canAcceptDirectInput: true, turns: [] };
      result = { thread: state.thread };
    } else if (request.method === 'thread/name/set') {
      if (!state.thread || request.params.threadId !== state.thread.id || typeof request.params.name !== 'string') throw new Error('Invalid thread name command');
      state.thread.name = request.params.name;
    } else if (request.method === 'thread/list') result = { data: state.thread ? [state.thread] : [], nextCursor: null };
    else if (request.method === 'thread/read' && request.params.includeTurns && !state.thread.turns.length) {
      persist(); emit({ id: request.id, error: { code: -32600, message: 'thread synthetic-thread is not materialized yet; includeTurns is unavailable before first user message' } }); return;
    } else if (['thread/read', 'thread/resume'].includes(request.method)) result = { thread: state.thread };
    else if (request.method === 'thread/backgroundTerminals/list') result = { data: [], nextCursor: null };
    else if (request.method === 'thread/goal/get') result = { goal: null };
    else if (request.method === 'turn/start') {
      const turn = { id: 'native-turn-' + (state.thread.turns.length + 1), status: 'inProgress',
        items: [{ id: 'user-' + state.thread.turns.length, type: 'userMessage', clientId: request.params.clientUserMessageId, content: request.params.input }] };
      state.thread.turns.push(turn); state.thread.updatedAt++;
      state.thread.status = { type: 'active', activeFlags: [] };
      state.thread.canAcceptDirectInput = false; result = { turn };
    } else if (request.method === 'fixture/complete') {
      const turn = state.thread.turns.at(-1); turn.status = 'completed'; state.thread.updatedAt++;
      // Terminal history alone is not execution permission. Model the native
      // direct-input capability explicitly, without weakening production proof.
      state.thread.status = { type: 'idle' }; state.thread.canAcceptDirectInput = true;
      const item = { id: 'reply-' + turn.id, type: 'agentMessage', text: request.params.text };
      turn.items.push(item); persist();
      emit({ method: 'item/completed', params: { threadId: state.thread.id, turnId: turn.id, item } });
      emit({ method: 'turn/completed', params: { threadId: state.thread.id, turn } });
    } else if (!['initialize', 'initialized'].includes(request.method)) throw new Error('Unexpected method ' + request.method);
    persist(); if (request.id != null) emit({ id: request.id, result });
  });
`;
const configuration = (home, role) => loadConfig({ HOME: home, AOD_SERVER_ROLE: role,
  AOD_ACCESS_KEY: 'synthetic-access-key', AOD_HUB_VAULT_SECRET: 'synthetic-vault',
  AOD_HUB_DATABASE_FILE: join(home, 'hub.sqlite'), AOD_SESSION_TITLES_FILE: join(home, 'titles.json'),
  AOD_PASSKEYS_FILE: join(home, 'passkeys.json'), AOD_AUTH_SESSIONS_FILE: join(home, 'auth.json'),
  AOD_CONNECTOR_USERS_DATABASE_FILE: join(home, 'connector.sqlite'), AOD_CONNECTOR_TOKENS_FILE: join(home, 'tokens.json'),
  AOD_CONNECTOR_BOOTSTRAP_TOKEN: 'synthetic-connector-token', AOD_CONNECTOR_UPDATE_STATE_FILE: join(home, 'update.json'),
  AOD_CONNECTOR_UPDATE_ENABLED: 'false', AOD_LOCAL_OPENCLAW_CLI: 'false',
  AOD_QUEUE_FILE: join(home, 'queue.json'), AOD_MIRROR_OUTBOX_FILE: join(home, 'mirror.json'),
  AOD_ARTIFACT_INDEX_FILE: join(home, 'artifacts.json'), AOD_MEDIA_BRIDGE_ENABLED: 'false',
  AOD_ARTIFACT_RECEIVER_ENABLED: 'false', AOD_CODEX_ENABLED: role === 'hub' ? 'false' : 'true',
  AOD_CODEX_COMMAND: 'synthetic-codex-process-only', AOD_CODEX_DEFAULT_CWD: home,
  AOD_CODEX_HOME: join(home, 'native-home'),
  AOD_CODEX_DEFAULT_MODEL: 'synthetic-model', AOD_CODEX_APPROVAL_POLICY: 'never' });
assert.equal(existsSync(join(directory, 'admitted.json')), false, 'Use a fresh evidence directory');
const evidence = { startedAt: new Date().toISOString(), provider: 'deterministic-native-protocol-simulator', paidRequests: 0,
  ...(candidate ? { candidate: { root, ...candidate } } : {}),
  checks: [], errors: [], passed: false, childrenClosed: false, requests: [], sharedReadSamples: [], stateReadRefusals: 0 };
const save = () => writeFileSync(join(directory, 'result.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
const record = check => { evidence.checks.push(check); save(); console.log('CHECK', check); };
const eventually = async (predicate, label) => {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(50); }
  throw new Error('Timeout: ' + label);
};
const nodes = ['alice', 'bob'].map(label => {
  const home = join(directory, label); mkdirSync(home, { mode: 0o700 });
  return { label, home, file: join(home, 'native.json'), config: configuration(home, 'connector') };
});
const children = [], contexts = [], errors = [];
let activeSend;
const nativeSpawn = childProcess.spawn;
let hub, server, browser, origin;
childProcess.spawn = (command, args, options) => {
  if (command !== 'synthetic-codex-process-only') {
    assert.equal(command, browserExecutable, 'Only the browser or synthetic native child may start');
    return nativeSpawn(command, args, options);
  }
  const node = nodes.find(node => node.home === options.cwd); assert.ok(node);
  assert.equal(options.env.CODEX_HOME, join(node.home, 'native-home'));
  const child = nativeSpawn(process.execPath, ['-e', simulator, node.file], {
    // Preserve the real runtime's Linux process-group ownership. A replacement
    // child in the harness group cannot be stopped by the production -pid
    // signal, and would counterfeit a stuck shutdown rather than test drain.
    cwd: node.home, detached: options.detached, stdio: ['pipe', 'pipe', 'pipe'],
    env: { HOME: node.home, PATH: '/usr/bin:/bin', NODE_ENV: 'test' } });
  node.child = child; children.push({ child, closed: once(child, 'close') }); return child;
};
syncBuiltinESMExports();
const start = async () => {
  for (const node of nodes) {
    if (!node.queueManager) node.queueManager = new ConnectorTokenStore(node.config.connector.tokenFile, 'synthetic-connector-token')
      .create({ label: 'Synthetic queue observer', scopes: ['queue:manage'] }).token;
    node.application = await createProcessApplication(node.config);
    node.server ??= serve({ hostname: '127.0.0.1', port: 0, fetch: request => node.application?.app.fetch(request) ?? new Response(null, { status: 503 }) });
    if (!node.server.listening) await once(node.server, 'listening');
    node.origin = 'http://127.0.0.1:' + node.server.address().port;
  }
  hub = await createProcessApplication(configuration(join(directory, 'hub'), 'hub'));
  server ??= serve({ hostname: '127.0.0.1', port: 0, fetch: request => hub?.app.fetch(request) ?? new Response(null, { status: 503 }) });
  if (!server.listening) await once(server, 'listening');
  origin = 'http://127.0.0.1:' + server.address().port;
};
const stop = async () => {
  const previous = hub; hub = undefined; await previous?.close();
  for (const node of nodes) { const previous = node.application; node.application = undefined; await previous?.close(); }
};
const request = async (path, token = 'synthetic-access-key', body, expected = 200, method = body === undefined ? 'GET' : 'POST') => {
  const response = await fetch(origin + '/api/hub/v1' + path, { method, signal: AbortSignal.timeout(30000),
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text(); assert.equal(response.status, expected, `${method} ${path}: ${text}`);
  return response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text;
};
const starts = node => existsSync(node.file) ? JSON.parse(readFileSync(node.file, 'utf8')).requests.filter(request => request.method === 'turn/start') : [];
// Public projections, not an in-process legacy store: the production factory
// owns worker databases and deliberately does not expose synchronous getters.
const runtime = async node => {
  const response = await fetch(origin + '/api/hub/v1/sessions/state', {
    headers: { authorization: 'Bearer ' + node.token }, signal: AbortSignal.timeout(30000),
  });
  const state = await response.json();
  // Concurrent public snapshots share a bounded result budget with other
  // readers. A documented refusal is not terminal state and authorizes no
  // effect: only this GET probe can wait within eventually's original 30s
  // deadline. Every other status/body remains a hard failure, as do writes.
  if (response.status === 503) {
    assert.deepEqual(state, { error: 'hub_sessions_unavailable' });
    evidence.stateReadRefusals++; save(); return undefined;
  }
  assert.equal(response.status, 200);
  node.lastPublicState = state;
  return state.groups.flatMap(group => group.sessions).find(session => session.key === node.sessionKey || session.sessionKey === node.sessionKey)?.runtime;
};
const blockedQueue = async node => {
  // The Hub owner's actor-only page must not expose another actor's shared
  // commands. Observe the durable block via the existing Connector manager
  // capability, not a legacy store or a widened shared/owner read permission.
  const response = await fetch(node.origin + `/api/connector/v1/sessions/${encodeURIComponent(node.remoteSessionKey)}/queue`, {
    headers: { authorization: 'Bearer ' + node.queueManager }, signal: AbortSignal.timeout(30000),
  });
  assert.equal(response.status, 200);
  return (await response.json()).items.some(item => item.state === 'blocked');
};
const complete = async (node, text) => {
  node.child.stdin.write(JSON.stringify({ method: 'fixture/complete', params: { text } }) + '\n');
  await eventually(async () => {
    const execution = await runtime(node);
    return execution?.phase === 'completed' && execution.sync === 'current';
  }, node.label + ' terminal');
};
const sharedPath = node => `/shared/${node.userId}/sessions/${encodeURIComponent(node.sessionKey)}`;
const sharedHash = node => '#/session/' + encodeURIComponent(JSON.stringify(['shared-session-v1', node.userId, node.sessionKey]));
const openPage = async (recipient, resource, width) => {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: 'block' }); contexts.push(context);
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await context.addInitScript(base => { window.__AGENTOPSDECK_API_BASE_URL__ = base; }, origin);
  await context.addInitScript(() => {
    window.__sharedInvalidationSamples = [];
    const OriginalEventSource = window.EventSource;
    window.EventSource = class extends OriginalEventSource {
      constructor(...args) {
        super(...args);
        for (const type of ['session.invalidated', 'stream.reset', 'stream.status']) this.addEventListener(type, event => {
          try {
            const value = JSON.parse(event.data);
            window.__sharedInvalidationSamples.push({ at: Date.now(), type, sourceCursor: value.sourceCursor });
            if (window.__sharedInvalidationSamples.length > 100) window.__sharedInvalidationSamples.shift();
          } catch { /* Diagnostics do not participate in stream delivery. */ }
        });
      }
    };
  });
  assert.equal((await context.request.post(origin + '/api/auth/login', { data: { accessKey: recipient.token } })).status(), 200);
  for (const suffix of ['/state', '/messages']) {
    const response = await context.request.get(origin + '/api/hub/v1' + sharedPath(resource) + suffix);
    assert.equal(response.status(), 200, `Cookie shared ${suffix}: ${await response.text()}`);
  }
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/hub/v1/')) evidence.requests.push({ recipient: recipient.label, width, method: request.method(), path: url.pathname });
  });
  page.on('response', response => {
    const request = response.request(), path = new URL(response.url()).pathname;
    if (request.method() !== 'GET' || !path.startsWith('/api/hub/v1/shared/') || !/\/(messages|state)$/.test(path)) return;
    // Bounded structural diagnostics only: never retain credentials, model text,
    // private response bodies or headers, and never affect the original read.
    const sample = { recipient: recipient.label, resource: resource.label, width,
      lane: path.endsWith('/messages') ? 'history' : 'execution', status: response.status(),
      startedAt: request.timing().startTime, observedAt: Date.now() };
    evidence.sharedReadSamples.push(sample);
    if (evidence.sharedReadSamples.length > 100) evidence.sharedReadSamples.shift();
    try {
      const meta = JSON.parse(response.headers()['x-agentopsdeck-history-meta'] ?? 'null');
      if (meta) sample.validatedCursor = meta.sourceCursor;
    } catch { /* A malformed response is still handled by the real client. */ }
    void response.json().then(value => {
      const metadata = value.historyDelta === 1 ? value.metadata : value;
      Object.assign(sample, { parsedAt: Date.now(), sourceCursor: metadata?.sourceCursor,
        historyStatus: metadata?.historyStatus, messageCount: value.messages?.length ?? value.slots?.length,
        phase: value.runtime?.phase, sync: value.runtime?.sync });
    }).catch(() => { sample.bodyUnavailable = true; });
  });
  await page.goto(origin + '/' + sharedHash(resource), { waitUntil: 'domcontentloaded' });
  await page.getByRole('main', { name: 'Shared session', exact: true }).waitFor();
  await eventually(async () => (await page.getByRole('main').innerText()).includes('Messages: ready'), 'browser history');
  return { page, context, resource, recipient, width };
};
try {
  await start();
  for (const node of nodes) {
    const { user } = await request('/users', undefined, { label: node.label }, 201); node.userId = user.id;
    const key = await request(`/users/${node.userId}/login-keys`, undefined, {}, 201); node.token = key.token;
    await request('/connections', node.token, { id: 'same', label: node.label, connectorUrl: node.origin,
      token: 'synthetic-connector-token', ownerUserId: 'default' }, 201);
    node.nodeId = (await request('/connections/same/verify', node.token, {})).connection.nodeId;
    const created = await request('/connections/same/agents/codex/sessions', node.token,
      { title: `${node.label} private session`, idempotencyKey: 'identical-create-key' }, 201);
    node.sessionKey = created.key; node.remoteSessionKey = created.remoteSessionKey;
    writeFileSync(join(directory, 'admitted.json'), JSON.stringify({ synthetic: true }), { mode: 0o600 });
    await request(`/sessions/${encodeURIComponent(node.sessionKey)}/messages`, node.token,
      { message: `${node.label} private input`, idempotencyKey: 'identical-private-key' });
    await eventually(async () => starts(node).length === 1 && (await runtime(node))?.turnId === 'native-turn-1', 'initial ACK');
    await complete(node, `${node.label} original reply`);
    const { hubId } = await request('/connections/same/execution-issuer', node.token);
    node.issuer = new ConnectorTokenStore(node.config.connector.tokenFile).create({ label: 'Synthetic delegation', delegationHubId: hubId,
      scopes: ['execution:delegate', 'messages:send', 'messages:read', 'events:read'] }).token;
  }
  const [alice, bob] = nodes; assert.notEqual(alice.nodeId, bob.nodeId); assert.equal(alice.sessionKey, bob.sessionKey);
  await stop(); await start();
  for (const node of nodes) {
    const recipient = node === alice ? bob : alice;
    await request('/connections/same/execution-issuer', node.token, { token: node.issuer }, 200, 'PUT');
    const { nodeVersion } = await request('/connections/same/grants', node.token);
    node.grant = (await request('/connections/same/grants', node.token, { userId: recipient.userId, nodeVersion,
      policy: { runtime: 'codex', sessionKey: node.remoteSessionKey, actions: ['messages:read', 'messages:send', 'events:read'] } }, 201)).grant;
  }
  // Exercise the same public reads before opening Chromium so a production
  // authority/transport failure is reported as HTTP, not a vague UI timeout.
  for (const node of nodes) {
    const recipient = node === alice ? bob : alice;
    await request(sharedPath(node) + '/state', recipient.token);
    await request(sharedPath(node) + '/messages', recipient.token);
  }
  browser = await chromium.launch({ executablePath: browserExecutable, headless: true, args: ['--no-sandbox'] });
  const views = [];
  for (const width of [1440, 390]) {
    views.push(await openPage(bob, alice, width)); views.push(await openPage(alice, bob, width));
  }
  for (const view of views) {
    const text = await view.page.getByRole('main').innerText();
    assert.ok(text.includes(`${view.resource.label} original reply`)); assert.ok(!text.includes(`${view.recipient.label} original reply`));
    assert.equal(await view.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false);
  }
  record('desktop-mobile-two-users-two-nodes-with-colliding-session-identities-and-real-auth-http-sqlite');
  const admitted = [];
  for (const view of views) {
    activeSend = { recipient: view.recipient.label, resource: view.resource.label, width: view.width };
    const message = `${view.recipient.label} browser ${view.width} on ${view.resource.label}`;
    await view.page.getByRole('textbox', { name: 'Shared message', exact: true }).fill(message);
    const responsePromise = view.page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/messages'));
    // Click can fail before the response waiter is awaited. Attach a handler
    // immediately so its later timeout cannot abort diagnostics or cleanup;
    // awaiting the original promise still preserves every response assertion.
    void responsePromise.catch(() => {});
    await view.page.getByRole('button', { name: 'Send', exact: true }).click();
    const response = await responsePromise; assert.equal(response.status(), 200);
    const payload = response.request().postDataJSON(), result = await response.json();
    admitted.push({ view, payload, result });
    assert.equal((await request(sharedPath(view.resource) + '/messages', view.recipient.token, payload)).runId, result.runId);
    await eventually(() => starts(view.resource).length === 2, 'shared native dispatch');
  }
  for (const node of nodes) assert.equal(starts(node).length, 2);
  for (const view of views) {
    await view.page.getByRole('button', { name: 'My queue', exact: true }).click();
    await eventually(async () => (await view.page.getByRole('main').innerText()).includes('queued'), 'browser queue');
  }
  record('four-browser-sends-original-receipts-idempotency-and-shared-queue');
  await request(`/connections/same/grants/${alice.grant.id}`, alice.token, { version: alice.grant.version }, 200, 'DELETE');
  for (const view of views.filter(view => view.resource === alice)) {
    await view.page.getByRole('alert').filter({ hasText: 'Shared access is no longer available' }).waitFor({ timeout: 30000 });
    assert.equal(await view.page.getByRole('textbox', { name: 'Shared message', exact: true }).isDisabled(), true);
    assert.equal(await view.page.getByText('My queued commands', { exact: true }).count(), 0);
    assert.equal(await view.page.getByRole('button', { name: 'Cancel queued command', exact: true }).count(), 0);
    assert.ok(!(await view.page.getByRole('main').innerText()).includes('alice original reply'));
  }
  await eventually(() => blockedQueue(alice), 'revoked queued execution');
  await request(sharedPath(alice) + '/messages', bob.token, undefined, 404);
  await request(sharedPath(alice) + '/messages', bob.token, { message: 'denied', idempotencyKey: 'revoked' }, 404);
  await complete(alice, 'alice admitted predecessor finished');
  bob.child.stdin.write(JSON.stringify({ method: 'fixture/complete', params: { text: 'bob first shared reply' } }) + '\n');
  await eventually(async () => starts(bob).length === 3 && (await runtime(bob))?.turnId === 'native-turn-3', 'unrevoked successor');
  await complete(bob, 'bob second shared reply');
  for (const view of views.filter(view => view.resource === bob)) {
    await view.page.getByText('bob second shared reply', { exact: true }).waitFor({ timeout: 30000 });
    assert.equal(await view.page.getByRole('textbox', { name: 'Shared message', exact: true }).isDisabled(), false);
  }
  assert.equal(starts(alice).length, 2); assert.equal(starts(bob).length, 3);
  record('live-revocation-clears-two-browser-snapshots-blocks-successor-and-preserves-other-node-sse');
  await stop(); await start();
  for (const view of views) {
    await view.page.reload({ waitUntil: 'domcontentloaded' });
    if (view.resource === alice) await view.page.getByRole('alert').filter({ hasText: 'Shared access is no longer available' }).waitFor({ timeout: 30000 });
    else await view.page.getByText('bob second shared reply', { exact: true }).waitFor({ timeout: 30000 });
  }
  for (const entry of admitted.filter(entry => entry.view.resource === bob)) {
    const duplicate = await request(sharedPath(bob) + '/messages', alice.token, entry.payload);
    assert.equal(duplicate.runId, entry.result.runId);
    assert.equal(duplicate.command.id, entry.result.command.id);
  }
  assert.equal(await blockedQueue(alice), true);
  assert.equal(starts(alice).length, 2); assert.equal(starts(bob).length, 3);
  assert.deepEqual(errors, []);
  assert.ok(!evidence.requests.some(request => /^\/api\/hub\/v1\/(sessions|connections)(\/|$)/.test(request.path)), 'shared views must not fall back to owner catalog');
  record('same-data-hub-and-connectors-restart-browser-reload-revocation-and-original-receipts-without-replay');
  evidence.passed = true;
} catch (error) {
  evidence.errors.push(error.stack ?? String(error)); console.error(error); process.exitCode = 1;
  evidence.activeSend = activeSend;
  evidence.browserReadiness = [];
  for (const node of nodes) if (node.lastPublicState) writeFileSync(join(node.home, 'last-public-state.json'), JSON.stringify(node.lastPublicState, null, 2), { mode: 0o600 });
  for (let index = 0; index < contexts.length; index++) {
    const page = contexts[index].pages()[0];
    if (page && !page.isClosed()) {
      evidence.browserReadiness.push({ index,
        status: await page.getByLabel('Shared session status', { exact: true }).innerText().catch(() => 'unavailable'),
        sendDisabled: await page.getByRole('button', { name: 'Send', exact: true }).isDisabled().catch(() => null),
        inputDisabled: await page.getByRole('textbox', { name: 'Shared message', exact: true }).isDisabled().catch(() => null),
        inputLength: await page.getByRole('textbox', { name: 'Shared message', exact: true }).inputValue().then(value => value.length).catch(() => null),
      });
      writeFileSync(join(directory, `browser-${index}.txt`), await page.locator('body').innerText().catch(() => ''), { mode: 0o600 });
    }
  }
} finally {
  evidence.invalidationSamples = [];
  for (let index = 0; index < contexts.length; index++) {
    const page = contexts[index].pages()[0];
    if (page && !page.isClosed()) evidence.invalidationSamples.push({ index,
      samples: await page.evaluate(() => window.__sharedInvalidationSamples ?? []).catch(() => []),
    });
  }
  const cleanup = async operation => {
    try { await operation(); }
    catch (error) { evidence.errors.push(error.stack ?? String(error)); evidence.passed = false; process.exitCode = 1; }
  };
  await cleanup(() => browser?.close());
  await cleanup(stop);
  for (const listener of [server, ...nodes.map(node => node.server)].filter(Boolean)) {
    await cleanup(async () => {
      const closing = new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
      listener.closeAllConnections?.(); await closing;
    });
  }
  evidence.childrenClosed = children.every(({ child }) => child.exitCode !== null || child.signalCode !== null);
  for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await Promise.all(children.map(child => child.closed));
  childProcess.spawn = nativeSpawn; syncBuiltinESMExports();
  if (!evidence.childrenClosed) { evidence.passed = false; process.exitCode = 1; }
  if (candidate) await cleanup(async () => {
    assert.deepEqual(await verifyCandidateRelease(root), candidate);
    evidence.candidateUnchanged = true;
  });
  evidence.finishedAt = new Date().toISOString(); save();
}
