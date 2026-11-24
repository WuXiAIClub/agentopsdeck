import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { ConnectorClient } from '../hub/connector-client.js';
import { stableGatewayRowsRevision } from '../refresh/signature.js';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { SdkCommands } from '../connector/sdk-commands.js';
import { loadConfig } from '../config.js';
import { DeckStore } from '../projection/deck-store.js';
import { registerConnectorRoutes } from './connector.js';
import type { SdkMessagesHttp } from '../connector/sdk-messages-http.js';
import type { HermesMessagesHttp } from '../connector/hermes-messages-http.js';
import type { HermesDeletionHttp } from '../connector/hermes-deletion-http.js';
import type { HermesQueueHttp } from '../connector/hermes-queue-http.js';
import { AsyncHermesDeletion } from '../connector/async-hermes-deletion.js';
import { AsyncHermesMessages } from '../connector/async-hermes-messages.js';
import type { SdkLocalHttp } from '../connector/sdk-local-http.js';
import type { SdkQueueHttp } from '../connector/sdk-queue-http.js';
import type { SdkDeletionHttp } from '../connector/sdk-deletion-http.js';
import type { SdkCompactHttp } from '../connector/sdk-compact-http.js';
import type { AsyncSdkApplicationHttp } from '../connector/async-sdk-application.js';
import type { AsyncHermesApplicationHttp } from '../connector/async-hermes-application.js';
import { AsyncOpenClawApplication, type AsyncOpenClawApplicationHttp } from '../connector/async-openclaw-application.js';
import { AsyncSdkLocal } from '../connector/async-sdk-local.js';
import { createConnectorOwnerCommands } from '../connector/connector-owner-domain.js';
import { AsyncAutomationConfiguration } from '../connector/async-automation-configuration.js';
import type { AsyncAutomationHttp } from '../connector/async-automation-http.js';
import type { CodexInteractionsHttp } from '../connector/codex-interactions-http.js';
import { AsyncCodexInteractions } from '../connector/async-codex-interactions.js';
import { AsyncCodexCatalog } from '../connector/async-codex-catalog.js';
import type { CodexCatalogHttp } from '../connector/codex-catalog-http.js';
import type { CodexSettingsHttp } from '../connector/codex-settings-http.js';
import type { CodexDeletionHttp } from '../connector/codex-deletion-http.js';
import { AsyncCodexDeletion } from '../connector/async-codex-deletion.js';
import type { CodexPublicUsageHttp } from '../connector/codex-public-usage-http.js';
import { AsyncCodexPublicUsage } from '../connector/async-codex-public-usage.js';
import { AsyncCodexFiles } from '../connector/async-codex-files.js';
import { AsyncConnectorControl } from '../connector/async-connector-control.js';
import type { ConnectorControlHttp } from '../connector/control-http.js';
import type { CodexFilesHttp } from '../connector/codex-files-http.js';
import { AsyncCodexSettings } from '../connector/async-codex-settings.js';
import type { EventReplayRead, EventReplayPage, EventSnapshotRead } from './events.js';
import { OpenClawTurnQueue } from '../openclaw/turn-queue.js';
import { createOpenClawDispatch } from '../openclaw/dispatch.js';
import { EXPECTED_NODE_HEADER, NODE_ID_HEADER } from '../connector/node-identity.js';
import { RunControlConflict } from '../commands/run-control.js';
import { performanceDiagnostics } from '../diagnostics/performance.js';
import { GatewayRpcError } from '../gateway/rpc-error.js';
import { CONNECTOR_PROTOCOL_HEADER, MAX_MESSAGE_CHARS, negotiateConnectorProtocol } from '@agentopsdeck/shared';
import { AsyncConnectorOwner } from '../connector/async-connector-owner.js';
import { AsyncConnectorReadAuthority } from '../connector/read-authority.js';

test('production public reads use original worker credentials after protocol/node gates without synchronous fallback', async t => {
  const f = createConnectorFixture();
  const owner = new AsyncConnectorOwner({ file: join(f.dir, 'public-worker.sqlite'), tokenFile: f.config.connector.tokenFile });
  const authority = new AsyncConnectorReadAuthority(owner);
  const app = new Hono();
  const routes = registerConnectorRoutes(app, { config: f.config, connectorUsers: f.connectorUsers, tokens: f.tokens,
    store: f.store, gateway: f.gateway as any, publicReadAuthority: authority, refreshSessions: async () => {}, refreshMessages: async () => {},
    fallbackAgents: () => [{ id: 'worker-agent' }], isAuthorizedRequest: () => true, normalizeError: () => 'unavailable',
    sessionSnapshotReady: () => true, historySnapshotReady: () => true });
  try {
    await owner.open();
    const token = await owner.command('tokenCreate', { label: 'public', scopes: ['agents:read', 'events:read', 'media:read', 'system:metrics:read'] });
    const headers = { authorization: `Bearer ${token.token}` }, mediaRoot = f.config.inboundMediaDir;
    mkdirSync(mediaRoot, { recursive: true, mode: 0o700 }); chmodSync(mediaRoot, 0o700); writeFileSync(join(mediaRoot, 'public.txt'), 'original bytes', { mode: 0o600 });
    t.mock.method(f.tokens, 'authenticateAuthorization', () => assert.fail('no synchronous authentication'));
    t.mock.method(f.tokens, 'hasScope', () => assert.fail('no synchronous scope lookup'));
    for (const suffix of ['/agents', '/system/metrics', '/media/inbound/public.txt', '/events/stream']) {
      const url = `/api/connector/v1${suffix}`;
      assert.equal((await app.request(url, { headers: { ...headers, [CONNECTOR_PROTOCOL_HEADER]: '0' } })).status, 426);
      assert.equal((await app.request(url, { headers: { ...headers, [EXPECTED_NODE_HEADER]: 'foreign' } })).status, 409);
      const response = await app.request(url, { headers }); assert.equal(response.status, 200);
      assert.equal(response.headers.get(NODE_ID_HEADER), f.connectorUsers.nodeId);
      assert.equal(response.headers.get(CONNECTOR_PROTOCOL_HEADER), '1');
      assert.equal(response.headers.get('cache-control'), 'no-store');
      if (suffix === '/events/stream') await response.body!.cancel();
      else if (suffix.includes('/media/')) assert.equal(await response.text(), 'original bytes');
      else await response.json();
    }
    await owner.command('tokenRevoke', { tokenId: token.record.id });
    assert.equal((await app.request('/api/connector/v1/agents', { headers })).status, 403);
  } finally { await routes.close(); await authority.close(); await owner.close(); await f.cleanup(); }
});

test('owned automation registers on production URLs after protocol/node fences without legacy authorization fallback', async t => {
  let configuration: AsyncAutomationConfiguration;
  const calls: string[] = [];
  const port: AsyncAutomationHttp['configuration'] = {
    authority: input => configuration.authority(input), view: input => configuration.view(input),
    original: input => configuration.original(input), configure: input => configuration.configure(input),
  };
  const f = createConnectorFixture(undefined, false, false, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, port);
  const actor = f.tokens.create({ label: 'owned automation', scopes: ['automation:manage', 'messages:send'] });
  const denied = f.tokens.create({ label: 'no automation', scopes: ['sessions:read'] });
  // Separate authority fixture models the owner boundary. Real worker transaction,
  // reopen and native lifecycle are covered in the same joint acceptance batch.
  const commands = createConnectorOwnerCommands(f.connectorUsers, new ConnectorTokenStore(f.config.connector.tokenFile));
  configuration = new AsyncAutomationConfiguration({ command: (async (kind: any, input: any) => {
    calls.push(kind); return commands(kind, input);
  }) as typeof commands }, f.connectorUsers.nodeId);
  const base = '/api/connector/v1/automation', headers = { authorization: `Bearer ${actor.token}` };
  try {
    t.mock.method(f.tokens, 'authenticateAuthorization', () => assert.fail('No legacy main-thread authentication'));
    t.mock.method(f.tokens, 'hasScope', () => assert.fail('No legacy main-thread scope fallback'));
    assert.equal((await f.app.request(base, { headers: { ...headers, [CONNECTOR_PROTOCOL_HEADER]: '0' } })).status, 426);
    assert.equal((await f.app.request(base, { headers: { ...headers, [EXPECTED_NODE_HEADER]: 'foreign' } })).status, 409);
    assert.equal((await f.app.request(base)).status, 401);
    assert.deepEqual(calls, []);
    assert.equal((await f.app.request(base, { headers })).status, 200);
    const configurationInput = { kind: 'save', rule: { id: 'rule', revision: 1, authorityEpoch: 1,
      target: { ownerId: actor.record.id, connectionId: f.connectorUsers.nodeId, runtime: 'codex', sessionId: 'codex:session' },
      enabled: false, startsAt: 1000, expiresAt: 1_000_000, maxSends: 2, maxPerHour: 2, minIntervalMs: 60_000,
      mode: { kind: 'interval', intervalMs: 60_000 } }, template: 'original', expectedRevision: 0, confirmEnable: false };
    const post = () => f.app.request(`${base}/configuration/original`, { method: 'POST', headers, body: JSON.stringify(configurationInput) });
    const saved = await post(); assert.equal(saved.status, 200); const receipt = await saved.json();
    assert.deepEqual(await (await post()).json(), receipt);
    assert.deepEqual(await (await f.app.request(`${base}/configuration/original`, { headers })).json(), receipt);
    assert.equal((await f.app.request(base, { headers: { authorization: `Bearer ${denied.token}` } })).status, 403);
    await configuration.close();
    assert.equal((await f.app.request(base, { headers })).status, 503);
  } finally { await configuration.close(); await f.cleanup(); }
});

test('production Codex interaction registration preserves protocol/node gates and never falls back to synchronous authority', async t => {
  let interactions: AsyncCodexInteractions;
  const calls: string[] = [];
  const port: CodexInteractionsHttp = { interactions: {
    observe: input => interactions.observe(input), mode: input => interactions.mode(input), answer: input => interactions.answer(input),
  }, ready: () => true };
  const f = createConnectorFixture(undefined, false, false, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, port);
  const actor = f.tokens.create({ label: 'owned interaction', scopes: ['messages:read', 'messages:send'] });
  const commands = createConnectorOwnerCommands(f.connectorUsers, new ConnectorTokenStore(f.config.connector.tokenFile));
  interactions = new AsyncCodexInteractions({ owner: { command: (async (kind: any, input: any) => {
    calls.push(kind); return commands(kind, input);
  }) as typeof commands }, runtime: { stopConnectionId: null, interactionReady: true,
    installOwnedInteractions() { assert.fail('HTTP must not construct a native interaction handle'); } } });
  const base = '/api/connector/v1/sessions/codex:original', headers = { authorization: `Bearer ${actor.token}` };
  try {
    t.mock.method(f.tokens, 'authenticateAuthorization', () => assert.fail('No synchronous token fallback'));
    t.mock.method(f.tokens, 'hasScope', () => assert.fail('No synchronous permission fallback'));
    assert.equal((await f.app.request(`${base}/interactions`, { headers: { ...headers, [CONNECTOR_PROTOCOL_HEADER]: '0' } })).status, 426);
    assert.equal((await f.app.request(`${base}/interactions`, { headers: { ...headers, [EXPECTED_NODE_HEADER]: 'foreign' } })).status, 409);
    assert.equal((await f.app.request(`${base}/interactions`)).status, 401); assert.deepEqual(calls, []);
    const view = await f.app.request(`${base}/interactions`, { headers });
    assert.equal(view.status, 200); assert.equal(view.headers.get('cache-control'), 'no-store');
    assert.equal((await view.json()).version, 1);
    const mode = await f.app.request(`${base}/interaction-mode`, { method: 'PATCH', headers, body: JSON.stringify({ mode: 'interactive' }) });
    assert.equal(mode.status, 200); assert.equal((await mode.json()).mode, 'interactive');
    const answer = await f.app.request(`${base}/interactions/absent/answer`, { method: 'POST', headers,
      body: JSON.stringify({ runId: 'absent', responseId: 'absent', expectedRevision: 1, answer: { kind: 'approval', decision: 'allow-once' } }) });
    assert.equal(answer.status, 404);
    await interactions.close(); const count = calls.length;
    assert.equal((await f.app.request(`${base}/interactions`, { headers })).status, 503);
    assert.equal(calls.length, count);
  } finally { await interactions.close(); await f.cleanup(); }
});

test('production interaction registration rejects a second Codex native owner before resource creation', () => {
  assert.throws(() => registerConnectorRoutes(new Hono(), { codexInteractions: {}, codex: {} } as any), /cannot be mixed/);
});

test('owned settings production URLs keep protocol/node gates and bypass legacy synchronous receipt/auth middleware', async t => {
  let settings: AsyncCodexSettings;
  const port: CodexSettingsHttp = { settings: { change: input => settings.change(input), receipt: input => settings.receipt(input), goal: input => settings.goal(input) } };
  const f = createConnectorFixture(undefined, false, false, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, port);
  const actor = f.tokens.create({ label: 'settings', scopes: ['sessions:create'] });
  const commands = createConnectorOwnerCommands(f.connectorUsers, new ConnectorTokenStore(f.config.connector.tokenFile));
  const calls: string[] = [], key = 'codex:original';
  f.store.upsertSession({ sessionKey: key, agentId: 'codex', title: 'Original', status: 'idle' });
  settings = new AsyncCodexSettings({ owner: { command: (async (kind: any, input: any) => { calls.push(kind); return commands(kind, input); }) as typeof commands },
    deck: f.store, local() {}, writable: () => true,
    runtime: { readGoalControl() { assert.fail('title must not read native'); }, changeGoalOwned() { assert.fail('title must not write native'); },
      updateSessionRuntimeOwned() { assert.fail('title must not change model'); } } });
  const path = `/api/connector/v1/sessions/${key}`, headers = { authorization: `Bearer ${actor.token}`, 'idempotency-key': 'original-settings' };
  const patch = (extra: Record<string, string> = {}) => f.app.request(path, { method: 'PATCH', headers: { ...headers, ...extra }, body: '{"title":"Renamed"}' });
  try {
    t.mock.method(f.tokens, 'authenticateAuthorization', () => assert.fail('no synchronous token fallback'));
    t.mock.method(f.tokens, 'hasScope', () => assert.fail('no synchronous scope fallback'));
    assert.equal((await patch({ [CONNECTOR_PROTOCOL_HEADER]: '0' })).status, 426);
    assert.equal((await patch({ [EXPECTED_NODE_HEADER]: 'foreign' })).status, 409);
    assert.equal((await f.app.request(`${path}/goal`)).status, 403); assert.deepEqual(calls, []);
    assert.equal((await patch()).status, 200); assert.equal(f.store.getSession(key)?.title, 'Renamed');
    const receipt = await f.app.request(`${path}/settings-commands/original-settings`, { headers });
    assert.equal(receipt.status, 200); assert.equal((await receipt.json()).command.state, 'accepted');
    assert.ok((calls as string[]).includes('codexSettingsBegin')); assert.ok((calls as string[]).includes('codexSettingsAccept'));
    await settings.close(); const count = calls.length;
    assert.equal((await patch()).status, 503); assert.equal(calls.length, count);
  } finally { await settings.close(); await f.cleanup(); }
});

test('owned deletion production URLs retain protocol/node guards and never enter synchronous auth or receipt fallback', async t => {
  let deletion: AsyncCodexDeletion;
  const port: CodexDeletionHttp = { ready: () => true, deletion: {
    remove: (...args) => deletion.remove(...args), receipt: (...args) => deletion.receipt(...args) } };
  const f = createConnectorFixture(undefined, false, false, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, port);
  const actor = f.tokens.create({ label: 'original delete', scopes: ['sessions:create'] });
  const commands = createConnectorOwnerCommands(f.connectorUsers, new ConnectorTokenStore(f.config.connector.tokenFile));
  const calls: string[] = []; let archives = 0;
  deletion = new AsyncCodexDeletion({ owner: { command: (async (kind: any, input: any) => {
    calls.push(kind); return commands(kind, input);
  }) as typeof commands }, writable: () => true, local() {},
    runtime: { async removeOwned(_key, local, begin, acknowledge) { local(); await begin(); local(); archives++; await acknowledge(); } } });
  const path = '/api/connector/v1/sessions/codex:original';
  const headers = { authorization: `Bearer ${actor.token}`, 'idempotency-key': 'original-delete' };
  try {
    t.mock.method(f.tokens, 'authenticateAuthorization', () => assert.fail('no synchronous identity fallback'));
    t.mock.method(f.tokens, 'hasScope', () => assert.fail('no synchronous permission fallback'));
    const remove = (extra: Record<string, string> = {}) => f.app.request(path, { method: 'DELETE', headers: { ...headers, ...extra } });
    assert.equal((await remove({ [CONNECTOR_PROTOCOL_HEADER]: '0' })).status, 426);
    assert.equal((await remove({ [EXPECTED_NODE_HEADER]: 'foreign' })).status, 409);
    assert.equal((await f.app.request(path, { method: 'DELETE' })).status, 401); assert.deepEqual(calls, []);
    assert.equal((await remove()).status, 200); assert.equal((await remove()).status, 200); assert.equal(archives, 1);
    const count = calls.length;
    const receipt = await f.app.request(`${path}/deletion-commands/original-delete`, { headers });
    assert.equal(receipt.status, 200); assert.equal((await receipt.json()).command.state, 'accepted');
    assert.deepEqual(calls.slice(count), ['codexDeletionReceipt']);
    await deletion.close();
    assert.equal((await remove()).status, 503); assert.equal(archives, 1);
  } finally { await deletion.close(); await f.cleanup(); }
});

test('owned public usage production URLs retain protocol/node fences without synchronous auth fallback', async t => {
  let usage: AsyncCodexPublicUsage;
  const port: CodexPublicUsageHttp = { usage: {
    range: (...args) => usage.range(...args), export: (...args) => usage.export(...args),
    createSnapshot: (...args) => usage.createSnapshot(...args), readSnapshot: (...args) => usage.readSnapshot(...args) } };
  const f = createConnectorFixture(undefined, false, false, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, port);
  const actor = f.tokens.create({ label: 'usage', scopes: ['messages:read'] }), key = 'codex:original';
  f.store.upsertSession({ sessionKey: key, agentId: 'codex', title: 'Original', status: 'idle' });
  f.connectorUsers.tokenUsage.record('codex', key, 'private-event', { inputTokens: 12, outputTokens: 3 }, undefined, 10);
  const commands = createConnectorOwnerCommands(f.connectorUsers, new ConnectorTokenStore(f.config.connector.tokenFile)), calls: string[] = [];
  usage = new AsyncCodexPublicUsage({ owner: { command: (async (kind: any, input: any) => { calls.push(kind); return commands(kind, input); }) as typeof commands },
    local() {}, sessionExists: session => !!f.store.getSession(session) });
  const path = `/api/connector/v1/sessions/${key}/token-usage`, headers = { authorization: `Bearer ${actor.token}` }, requestId = randomUUID();
  try {
    t.mock.method(f.tokens, 'authenticateAuthorization', () => assert.fail('no synchronous token fallback'));
    t.mock.method(f.tokens, 'hasScope', () => assert.fail('no synchronous scope fallback'));
    assert.equal((await f.app.request(path, { headers: { ...headers, [CONNECTOR_PROTOCOL_HEADER]: '0' } })).status, 426);
    assert.equal((await f.app.request(path, { headers: { ...headers, [EXPECTED_NODE_HEADER]: 'foreign' } })).status, 409);
    assert.deepEqual(calls, []);
    for (const suffix of ['?from=0&to=120000&bucketMs=60000', '/export?from=0&to=120000&bucketMs=60000'])
      assert.equal((await f.app.request(path + suffix, { headers })).status, 200);
    assert.equal((await f.app.request(path + '/snapshots', { method: 'POST', headers, body: JSON.stringify({ from: 0, to: 120000, bucketMs: 60000, requestId }) })).status, 200);
    assert.equal((await f.app.request(path + `/snapshots/${requestId}`, { headers })).status, 200);
    assert.deepEqual(calls, ['codexPublicUsageRange', 'codexPublicUsageDeliver', 'codexPublicUsageExport', 'codexPublicUsageDeliver',
      'codexPublicUsageSnapshotCreate', 'codexPublicUsageDeliver', 'codexPublicUsageSnapshotRead', 'codexPublicUsageDeliver']);
    await usage.close(); const count = calls.length;
    assert.equal((await f.app.request(path + '?from=0&to=120000&bucketMs=60000', { headers })).status, 503); assert.equal(calls.length, count);
  } finally { await usage.close(); await f.cleanup(); }
});

test('production public usage rejects a second native owner before creating resources', () => {
  assert.throws(() => registerConnectorRoutes(new Hono(), { codexPublicUsage: {}, codex: {} } as any), /cannot be mixed/);
});

test('owned file production URLs retain protocol/node fences without synchronous auth fallback', async t => {
  let files: AsyncCodexFiles;
  const port: CodexFilesHttp = { files: { page: (...args) => files.page(...args), start: (...args) => files.start(...args),
    step: (...args) => files.step(...args), cancel: (...args) => files.cancel(...args) } };
  const f = createConnectorFixture(undefined, false, false, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, port);
  const actor = f.tokens.create({ label: 'files', scopes: ['messages:read'] }), key = 'codex:original';
  f.store.upsertSession({ sessionKey: key, agentId: 'codex', title: 'Original', status: 'idle' });
  f.connectorUsers.fileIndex.replaceProjection(key, [{ id: 'tool', sessionKey: key, role: 'tool', toolPhase: 'result', status: 'sent',
    createdAt: 1, text: 'PRIVATE', sourceFiles: [{ path: 'C:\\original\\file.ts', kind: 'modified' }] }]);
  const commands = createConnectorOwnerCommands(f.connectorUsers, new ConnectorTokenStore(f.config.connector.tokenFile)), calls: string[] = [];
  files = new AsyncCodexFiles({ owner: { command: (async (kind: any, input: any) => { calls.push(kind); return commands(kind, input); }) as typeof commands },
    local() {}, sessionExists: session => !!f.store.getSession(session) });
  const path = `/api/connector/v1/sessions/${key}/files`, headers = { authorization: `Bearer ${actor.token}` };
  try {
    t.mock.method(f.tokens, 'authenticateAuthorization', () => assert.fail('no synchronous token fallback'));
    t.mock.method(f.tokens, 'hasScope', () => assert.fail('no synchronous scope fallback'));
    assert.equal((await f.app.request(path, { headers: { ...headers, [CONNECTOR_PROTOCOL_HEADER]: '0' } })).status, 426);
    assert.equal((await f.app.request(path, { headers: { ...headers, [EXPECTED_NODE_HEADER]: 'foreign' } })).status, 409);
    assert.equal((await f.app.request(path, { headers: { ...headers, 'x-agentopsdeck-execution-grant': '' } })).status, 403);
    assert.deepEqual(calls, []);
    const page = await f.app.request(path, { headers }); assert.equal(page.status, 200); assert.equal((await page.json()).entries.length, 1);
    const start = await f.app.request(path + '/rebuild', { method: 'POST', headers }); assert.equal(start.status, 200); const job = await start.json();
    assert.equal((await f.app.request(path + `/rebuild/${job.id}`, { method: 'POST', headers, body: JSON.stringify({ step: 0 }) })).status, 200);
    assert.equal((await f.app.request(path + `/rebuild/${job.id}`, { method: 'DELETE', headers })).status, 200);
    assert.deepEqual(calls, ['codexFilesPage', 'codexFilesDeliver', 'codexFilesStart', 'codexFilesDeliver',
      'codexFilesStep', 'codexFilesDeliver', 'codexFilesCancel', 'codexFilesDeliver']);
    await files.close(); const count = calls.length;
    assert.equal((await f.app.request(path, { headers })).status, 503); assert.equal(calls.length, count);
  } finally { await files.close(); await f.cleanup(); }
});

test('production public control routes precede synchronous authority and retain protocol/node gates', async t => {
  let control!: AsyncConnectorControl;
  const port: ConnectorControlHttp = {
    identity: request => control.identity(request),
    users: { authorize: (request, scope) => control.users.authorize(request, scope), list: request => control.users.list(request),
      create: (request, label) => control.users.create(request, label), update: (request, id, label) => control.users.update(request, id, label) },
    grants: { execute: (kind, request, body) => control.grants.execute(kind, request, body) },
    storage: { execute: (kind, request) => control.storage.execute(kind, request) }, close: () => control.close(),
  };
  const args: Parameters<typeof createConnectorFixture> = []; args[25] = port;
  const f = createConnectorFixture(...args);
  const actor = f.tokens.create({ label: 'public control', scopes: ['users:read', 'users:write', 'messages:send',
    'execution:delegate', 'connector:lifecycle'], delegationHubId: 'original-hub' });
  const commands = createConnectorOwnerCommands(f.connectorUsers, new ConnectorTokenStore(f.config.connector.tokenFile));
  const calls: string[] = [];
  control = new AsyncConnectorControl({ command: (async (kind, input) => {
    calls.push(kind); return commands(kind, input);
  }) as typeof commands });
  const headers = { authorization: `Bearer ${actor.token}`, [EXPECTED_NODE_HEADER]: f.connectorUsers.nodeId, [CONNECTOR_PROTOCOL_HEADER]: '1' };
  const base = '/api/connector/v1';
  try {
    t.mock.method(f.tokens, 'authenticateAuthorization', () => assert.fail('no synchronous token fallback'));
    t.mock.method(f.tokens, 'hasScope', () => assert.fail('no synchronous permission fallback'));
    for (const path of ['/identity', '/users', '/execution-grants/issuer', '/maintenance/storage/recovery']) {
      assert.equal((await f.app.request(base + path, { headers: { ...headers, [CONNECTOR_PROTOCOL_HEADER]: '0' } })).status, 426);
      assert.equal((await f.app.request(base + path, { headers: { ...headers, [EXPECTED_NODE_HEADER]: 'foreign' } })).status, 409);
    }
    assert.equal(calls.length, 0);
    for (const path of ['/identity', '/users', '/execution-grants/issuer', '/maintenance/storage/recovery', '/maintenance/storage']) {
      const response = await f.app.request(base + path, { headers }); assert.equal(response.status, 200, path);
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    assert.equal((await f.app.request(base + '/users', { method: 'POST', headers, body: JSON.stringify({ label: 'Owned' }) })).status, 201);
    assert.ok(calls.includes('authorizedUserCreate')); assert.ok(calls.includes('authorizedStorageStats'));
    await f.routes.close(); const before = calls.length;
    assert.equal((await f.app.request(base + '/identity', { headers })).status, 503);
    assert.equal(calls.length, before);
  } finally { await control.close(); await f.cleanup(); }
});

test('production files rejects a second native owner before creating resources', () => {
  assert.throws(() => registerConnectorRoutes(new Hono(), { codexFiles: {}, codex: {} } as any), /cannot be mixed/);
});

test('async Deck requires both awaited event read ports before constructing Connector resources', () => {
  const store = new DeckStore({ projectionEvents: { changes: new DeckStore().changes, append() {} } });
  for (const ports of [{}, { eventReplay() {} }, { eventSnapshot() {} }]) {
    assert.throws(() => registerConnectorRoutes(new Hono(), { store, ...ports } as any), /complete event replay and snapshot ports/);
  }
});

test('production deletion rejects a second native owner before creating resources', () => {
  assert.throws(() => registerConnectorRoutes(new Hono(), { codexDeletion: {}, codex: {} } as any), /cannot be mixed/);
});

test('production settings rejects a second native owner before creating resources', () => {
  assert.throws(() => registerConnectorRoutes(new Hono(), { codexSettings: {}, codex: {} } as any), /cannot be mixed/);
});

test('owned catalog production URLs retain protocol/node gates and never fall back to synchronous authority', async t => {
  let catalog: AsyncCodexCatalog;
  const port: CodexCatalogHttp = { catalog: { models: input => catalog.models(input), skills: input => catalog.skills(input) } };
  const f = createConnectorFixture(undefined, false, false, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, port);
  const actor = f.tokens.create({ label: 'catalog', scopes: ['models:read', 'messages:read'] });
  const commands = createConnectorOwnerCommands(f.connectorUsers, new ConnectorTokenStore(f.config.connector.tokenFile));
  const calls: string[] = []; let nativeCalls = 0;
  catalog = new AsyncCodexCatalog({ owner: { command: (async (kind: any, input: any) => {
    calls.push(kind); return commands(kind, input);
  }) as typeof commands }, local() {}, sessionExists: () => true, defaultModel: 'default',
    runtime: { enabled: true, async listModels() { nativeCalls++; return [{ id: 'native', label: 'Native' }]; },
      async listSessionSkills() { nativeCalls++; return { skills: [], observedAt: 1, limited: false, discoveryErrors: 0, usage: 'unknown' }; } } });
  const base = '/api/connector/v1', headers = { authorization: `Bearer ${actor.token}` };
  try {
    t.mock.method(f.tokens, 'authenticateAuthorization', () => assert.fail('No synchronous authentication fallback'));
    t.mock.method(f.tokens, 'hasScope', () => assert.fail('No synchronous scope fallback'));
    assert.equal((await f.app.request(`${base}/models/codex`, { headers: { ...headers, [CONNECTOR_PROTOCOL_HEADER]: '0' } })).status, 426);
    assert.equal((await f.app.request(`${base}/models/codex`, { headers: { ...headers, [EXPECTED_NODE_HEADER]: 'foreign' } })).status, 409);
    assert.equal((await f.app.request(`${base}/models/codex`)).status, 403);
    assert.equal((await f.app.request(`${base}/sessions/codex:original/skills`, { headers: { ...headers, 'x-agentopsdeck-execution-grant': 'rejected' } })).status, 403);
    assert.deepEqual(calls, []);
    const models = await f.app.request(`${base}/models/codex`, { headers });
    assert.equal(models.status, 200); assert.equal(models.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await models.json(), { models: [{ id: 'native', label: 'Native' }] });
    const skills = await f.app.request(`${base}/sessions/codex:original/skills`, { headers });
    assert.equal(skills.status, 200); assert.equal((await skills.json()).observedAt, 1);
    assert.deepEqual(calls, ['codexCatalogAuthorize', 'codexCatalogDeliver', 'codexCatalogAuthorize', 'codexCatalogDeliver']);
    assert.equal(await commands('tokenRevoke', { tokenId: actor.record.id }), true);
    assert.equal((await f.app.request(`${base}/models/codex`, { headers })).status, 403);
    assert.equal(nativeCalls, 2);
    await catalog.close(); const count = calls.length;
    assert.equal((await f.app.request(`${base}/models/codex`, { headers })).status, 503);
    assert.equal(calls.length, count);
  } finally { await catalog.close(); await f.cleanup(); }
});

test('production catalog registration rejects a second Codex owner before resource creation', () => {
  assert.throws(() => registerConnectorRoutes(new Hono(), { codexCatalog: {}, codex: {} } as any), /cannot be mixed/);
});

test('production automation registration rejects mixed async configuration and synchronous host before creating resources', () => {
  assert.throws(() => registerConnectorRoutes(new Hono(), {
    automationConfiguration: {}, automation: {},
  } as any), /cannot be mixed with a synchronous automation host/);
});

test('Hermes async deletion follows protocol/node gates without synchronous authority or projection fallback', async t => {
  let f: ReturnType<typeof createConnectorFixture>, command: ReturnType<typeof createConnectorOwnerCommands>, calls = 0;
  let live: string | undefined = 'live'; const nativeCalls: string[] = [];
  const lifecycle = new AsyncHermesDeletion({ owner: { command: (kind, input) => { calls++; return command(kind, input); } },
    native: { available: () => true, epoch: () => 'epoch', live: () => live,
      request: async method => {
        nativeCalls.push(method);
        if (method === 'session.activate') return { session_id: live, session_key: 'stored', status: 'idle', running: false };
        return method === 'session.close' ? { closed: true } : { deleted: 'stored' };
      } }, fence() {}, closed() { live = undefined; }, removed() {} });
  f = createConnectorFixture(undefined, false, false, 'ghcp', undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, { lifecycle, ready: () => true });
  const actor = f.tokens.create({ label: 'Hermes deletion actor', scopes: ['sessions:create'] });
  command = createConnectorOwnerCommands(f.connectorUsers, new ConnectorTokenStore(f.config.connector.tokenFile));
  const key = 'hermes:delete-route', path = `/api/connector/v1/sessions/${key}`;
  f.connectorUsers.hermesJournal.save({ key, stored: 'stored', title: 'Original', started: true, messages: [] });
  const headers = { authorization: `Bearer ${actor.token}`, 'idempotency-key': 'delete-route' };
  try {
    t.mock.method(f.tokens, 'authenticateAuthorization', () => assert.fail('No main-thread authentication fallback'));
    t.mock.method(f.store, 'getSession', () => assert.fail('No projection deletion authority fallback'));
    assert.equal((await f.app.request(path, { method: 'DELETE', headers: { ...headers, [CONNECTOR_PROTOCOL_HEADER]: '0' } })).status, 426);
    assert.equal((await f.app.request(path, { method: 'DELETE', headers: { ...headers, [EXPECTED_NODE_HEADER]: 'foreign' } })).status, 409);
    assert.equal(calls, 0); assert.deepEqual(nativeCalls, []);
    const response = await f.app.request(path, { method: 'DELETE', headers }); assert.equal(response.status, 200);
    assert.equal(response.headers.get(NODE_ID_HEADER), f.connectorUsers.nodeId);
    const receipt = (await response.json()).command;
    assert.equal(receipt.state, 'accepted');
    assert.equal((await (await f.app.request(`${path}/deletion-commands/delete-route`, { headers })).json()).command.id, receipt.id);
    assert.equal((await f.app.request(path, { method: 'DELETE', headers })).status, 200);
    assert.deepEqual(nativeCalls, ['session.activate', 'session.close', 'session.delete']);
  } finally { await lifecycle.close(); command.dispose(); await f.cleanup(); }
});

test('Hermes async message route follows protocol/node gates without old synchronous token or projection admission', async t => {
  let f: ReturnType<typeof createConnectorFixture>, command: ReturnType<typeof createConnectorOwnerCommands>, calls = 0, wakes = 0;
  const messages = new AsyncHermesMessages({ command: (kind, input) => {
    calls++; return command(kind, input);
  } }, () => { wakes++; });
  f = createConnectorFixture(undefined, false, false, 'ghcp', undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, { messages, ready: () => true });
  const credential = f.tokens.create({ label: 'Hermes route actor', scopes: ['messages:send', 'messages:read'] });
  const authority = new ConnectorTokenStore(f.config.connector.tokenFile);
  command = createConnectorOwnerCommands(f.connectorUsers, authority);
  const key = 'hermes:route-original', path = `/api/connector/v1/sessions/${key}`;
  f.connectorUsers.hermesJournal.save({ key, stored: 'native', title: 'Original', started: false, messages: [] });
  const headers = { authorization: `Bearer ${credential.token}` };
  const options = { method: 'POST', headers, body: '{"message":"original","idempotencyKey":"hermes-route"}' };
  try {
    t.mock.method(f.tokens, 'authenticateAuthorization', () => assert.fail('Main-side token authority must not own async message admission'));
    t.mock.method(f.store, 'getSession', () => assert.fail('Main-side projection must not own async message admission'));
    assert.equal((await f.app.request(`${path}/messages`, { ...options, headers: { ...headers, [CONNECTOR_PROTOCOL_HEADER]: '0' } })).status, 426);
    assert.equal((await f.app.request(`${path}/messages`, { ...options, headers: { ...headers, [EXPECTED_NODE_HEADER]: 'foreign' } })).status, 409);
    assert.equal(calls, 0);
    const accepted = await f.app.request(`${path}/messages`, options); assert.equal(accepted.status, 200);
    assert.equal(accepted.headers.get(NODE_ID_HEADER), f.connectorUsers.nodeId); assert.equal(wakes, 1);
    assert.equal((await accepted.json()).command.key, 'hermes-route');
    assert.equal((await f.app.request(`${path}/commands/hermes-route`, { headers })).status, 200);
    assert.equal((await f.app.request(`${path}/commands/hermes-route/queue`, { headers })).status, 200);
    const duplicate = await f.app.request(`${path}/messages`, options); assert.equal(duplicate.status, 200); assert.equal(wakes, 1);
    assert.equal(calls, 8, 'Two probe/write/recheck chains and two read-only recoveries, no legacy claims');
  } finally { command.dispose(); await f.cleanup(); }
});

for (const runtime of ['claude-code', 'ghcp'] as const) test(`${runtime} async local HTTP follows node/protocol gates and bypasses old synchronous admission`, async t => {
  let f: ReturnType<typeof createConnectorFixture>, calls = 0;
  const local = new AsyncSdkLocal({ command: (kind, input) => {
    calls++;
    return createConnectorOwnerCommands(f.connectorUsers, f.tokens, { [runtime]: { model: 'default', modelChoices: ['default', 'alternate'] } })(kind, input);
  } });
  f = createConnectorFixture(undefined, false, false, runtime, undefined, undefined, undefined, undefined, { local, ready: () => true });
  const actor = f.tokens.create({ label: 'Local SDK owner', scopes: ['sessions:create'] });
  try {
    t.mock.method(f.connectorUsers, 'canChangeSettings', () => assert.fail('Old synchronous settings admission must not own async model writes'));
    const createPath = `/api/connector/v1/agents/${runtime}/sessions`;
    const headers = { authorization: `Bearer ${actor.token}`, 'idempotency-key': 'async-create' };
    const options = { method: 'POST', headers, body: '{"title":"Async route"}' };
    const incompatible = await f.app.request(createPath, { ...options, headers: { ...headers, [CONNECTOR_PROTOCOL_HEADER]: '0' } });
    assert.equal(incompatible.status, 426); assert.equal(calls, 0);
    const wrongNode = await f.app.request(createPath, { ...options, headers: { ...headers, [EXPECTED_NODE_HEADER]: 'wrong-node' } });
    assert.equal(wrongNode.status, 409); assert.equal(calls, 0);
    const created = await f.app.request(createPath, options); assert.equal(created.status, 201);
    assert.equal(created.headers.get(NODE_ID_HEADER), f.connectorUsers.nodeId);
    const body = await created.json(); assert.equal(body.command.key, 'async-create');
    const path = `/api/connector/v1/sessions/${encodeURIComponent(body.key)}`;
    const updated = await f.app.request(path, { method: 'PATCH', headers: { ...headers, 'idempotency-key': 'async-model' }, body: '{"model":"alternate"}' });
    assert.equal(updated.status, 200); assert.deepEqual((await updated.json()).settings, { model: 'alternate', modelProvider: null });
    const receipt = await f.app.request(`${path}/settings-commands/async-model`, { headers });
    assert.equal(receipt.status, 200); assert.equal((await receipt.json()).command.state, 'accepted');
    assert.equal(calls, 7, 'Create and model each probe/write/recheck; receipt is one read, without old middleware claims');
  } finally { await f.cleanup(); }
});

test('Connector history emits one timing per phase and admin observes 200/304 without content', async t => {
  const f = createConnectorFixture();
  const reader = f.tokens.createTransient(['messages:read']), updater = f.tokens.createTransient(['connector:update']);
  t.mock.method(f.connectorUsers, 'storageStats', async () => ({ databaseBytes: 1, walBytes: 0, availableBytes: 1000, lowSpace: false, walPressure: false }));
  try {
    const key = 'codex:diagnostic-fixture';
    f.store.addMessage({ id: 'message', sessionKey: key, role: 'assistant', text: 'private fixture text', createdAt: 1 });
    const url = `/api/connector/v1/sessions/${encodeURIComponent(key)}/messages`;
    const response = await f.app.request(url, { headers: { authorization: `Bearer ${reader.token}` } });
    assert.equal(response.status, 200);
    const names = response.headers.get('server-timing')!.split(',').map(value => value.trim().split(';')[0]);
    assert.equal(names.length, new Set(names).size);
    for (const stage of ['app', 'page', 'hydrateWait', 'encode']) assert.ok(names.includes(stage));
    const cached = await f.app.request(url, { headers: { authorization: `Bearer ${reader.token}`, 'if-none-match': response.headers.get('etag')! } });
    assert.equal(cached.status, 304);
    const snapshot = await (await f.app.request('/api/connector/v1/maintenance/storage', { headers: { authorization: `Bearer ${updater.token}` } })).json();
    assert.equal(snapshot.history.total.calls, 2);
    assert.equal(snapshot.history.statuses['200'], 1); assert.equal(snapshot.history.statuses['304'], 1);
    assert.doesNotMatch(JSON.stringify(snapshot), /diagnostic-fixture|private fixture/);
  } finally { reader.dispose(); updater.dispose(); await f.cleanup(); }
});

test('Connector recovery observations preserve node/protocol/Origin/token authority without storage statistics IO', async t => {
  const f = createConnectorFixture(); let reads = 0, writes = 0;
  const reader = f.tokens.createTransient(['messages:read']), updater = f.tokens.createTransient(['connector:update']);
  const lifecycle = f.tokens.createTransient(['connector:lifecycle']);
  t.mock.method(f.connectorUsers, 'storageStats', async () => { reads++; throw Error('private disk failure'); });
  t.mock.method(f.connectorUsers, 'checkpointStorage', () => { writes++; return { deferred: true }; });
  const path = '/api/connector/v1/maintenance/storage/recovery';
  const get = (token: string, headers: Record<string, string> = {}) => f.app.request(path, { headers: { authorization: `Bearer ${token}`, ...headers } });
  const pinned = { [CONNECTOR_PROTOCOL_HEADER]: '1', [EXPECTED_NODE_HEADER]: f.connectorUsers.nodeId };
  try {
    assert.equal((await get(reader.token)).status, 403); assert.equal((await get(lifecycle.token)).status, 403);
    const wrongNode = await get(lifecycle.token, { ...pinned, [EXPECTED_NODE_HEADER]: 'another-node' });
    assert.equal(wrongNode.status, 409);
    assert.deepEqual(await wrongNode.json(), { error: 'Connector identity mismatch' });
    const wrongProtocol = await get(lifecycle.token, { ...pinned, [CONNECTOR_PROTOCOL_HEADER]: '999' });
    assert.equal(wrongProtocol.status, 426);
    assert.equal((await wrongProtocol.json()).error, 'Incompatible Connector protocol');
    assert.equal((await get(lifecycle.token, { ...pinned, Origin: 'https://example.test' })).status, 403);
    const response = await get(lifecycle.token, pinned), body = await response.json();
    assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(body.connection, { state: 'ready', attempts: 0 });
    assert.equal(body.performance.scope, 'process'); assert.equal(body.performance.retention, 'volatile');
    assert.equal((await get(updater.token)).status, 200);
    updater.dispose(); assert.equal((await get(updater.token)).status, 403);
    lifecycle.dispose(); assert.equal((await get(lifecycle.token, pinned)).status, 403);
    assert.equal(reads, 0); assert.equal(writes, 0);
  } finally { reader.dispose(); updater.dispose(); lifecycle.dispose(); await f.cleanup(); }
});

test('Connector storage diagnostics require maintenance authority and pin lifecycle requests to this node', async t => {
  const f = createConnectorFixture(); let reads = 0, writes = 0, revoke = false;
  const reader = f.tokens.createTransient(['messages:read']), updater = f.tokens.createTransient(['connector:update']), lifecycle = f.tokens.createTransient(['connector:lifecycle']);
  t.mock.method(f.connectorUsers, 'storageStats', async () => {
    reads++; if (revoke) updater.dispose();
    return { databaseBytes: 1, walBytes: 0, availableBytes: 1000, lowSpace: true, walPressure: false };
  });
  t.mock.method(f.connectorUsers, 'checkpointStorage', () => { writes++; return { deferred: true }; });
  const path = '/api/connector/v1/maintenance/storage';
  const get = (token: string, headers: Record<string, string> = {}) => f.app.request(path, { headers: { authorization: `Bearer ${token}`, ...headers } });
  try {
    assert.equal((await get(reader.token)).status, 403); assert.equal((await get(lifecycle.token)).status, 403); assert.equal(reads, 0);
    assert.equal((await get(lifecycle.token, { [CONNECTOR_PROTOCOL_HEADER]: '1', [EXPECTED_NODE_HEADER]: f.connectorUsers.nodeId })).status, 200);
    assert.equal((await get(lifecycle.token, { [CONNECTOR_PROTOCOL_HEADER]: '1', [EXPECTED_NODE_HEADER]: f.connectorUsers.nodeId, Origin: 'https://example.test' })).status, 403);
    assert.equal((await get(updater.token)).status, 200); assert.equal(writes, 0);
    const post = () => f.app.request(path + '/checkpoint', { method: 'POST', headers: { authorization: `Bearer ${updater.token}`, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal((await post()).status, 200); assert.equal((await post()).status, 429); assert.equal(writes, 1);
    revoke = true; assert.equal((await get(updater.token)).status, 403); assert.equal(writes, 1);
  } finally { reader.dispose(); updater.dispose(); lifecycle.dispose(); await f.cleanup(); }
});

test('reserved SDK runtimes never fall through to OpenClaw creation, settings, history or execution', async () => {
  const f = createConnectorFixture();
  f.gateway.request = async () => assert.fail('reserved runtime must not dispatch');
  f.gateway.requestBound = async () => assert.fail('reserved runtime must not dispatch');
  const token = f.tokens.createTransient(['sessions:create', 'messages:read', 'messages:send', 'queue:manage']);
  const headers = { authorization: `Bearer ${token.token}`, 'content-type': 'application/json' };
  try {
    for (const runtime of ['claude-code', 'ghcp']) {
      const create = await f.app.request(`/api/connector/v1/agents/${runtime}/sessions`, {
        method: 'POST', headers: { ...headers, 'idempotency-key': `disabled-${runtime}` }, body: '{}' });
      assert.equal(create.status, 409);
      assert.equal((await create.json()).command.state, 'rejected');
      const root = `/api/connector/v1/sessions/${encodeURIComponent(`${runtime}:native`)}`;
      for (const [method, path] of [['POST', '/messages'], ['GET', '/messages'], ['GET', '/state'],
        ['GET', '/queue'], ['PATCH', '/settings'], ['DELETE', ''], ['PATCH', '/archive']] as const) {
        const response = await f.app.request(root + path, { method, headers,
          ...(method === 'GET' ? {} : { body: JSON.stringify({ message: 'hello', idempotencyKey: 'disabled-send' }) }) });
        assert.equal(response.status, 409, `${runtime} ${method} ${path}`);
        assert.equal((await response.json()).error, 'Requested Agent runtime is disabled');
      }
      assert.equal(f.connectorUsers.turns.hasPending('openclaw', `${runtime}:native`), false);
    }
  } finally { await f.cleanup(); }
});

for (const runtime of ['claude-code', 'ghcp'] as const) {
  test(`${runtime}: full HTTP message route awaits durable SDK admission and recovers without resend`, { timeout: 30_000 }, async t => {
    const f = createConnectorFixture(undefined, false, false, runtime);
    const token = f.tokens.createTransient(['messages:send']);
    const journal = runtime === 'ghcp' ? f.connectorUsers.copilotJournal : f.connectorUsers.claudeJournal;
    const key = `${runtime}:async-route`;
    journal.create({ key, nativeSessionId: 'never-started', title: 'Fixture', createdAt: 0 });
    let release!: () => void, entered!: () => void, admissions = 0, settled = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const original = f.connectorUsers.turns.enqueueAsync.bind(f.connectorUsers.turns);
    t.mock.method(f.connectorUsers.turns, 'enqueueAsync', async (...args: Parameters<typeof original>) => {
      admissions++; entered(); await gate; return original(...args);
    });
    const request = () => f.app.request(`/api/connector/v1/sessions/${encodeURIComponent(key)}/messages`, {
      method: 'POST', headers: { authorization: `Bearer ${token.token}`, 'content-type': 'application/json',
        'idempotency-key': 'async-route' }, body: JSON.stringify({ message: 'original message' }),
    });
    try {
      const pending = Promise.resolve(request()).then(response => { settled = true; return response; });
      await waiting;
      assert.equal(settled, false); assert.equal(f.connectorUsers.turns.maintenanceCount(runtime), 0);
      release();
      const response = await pending;
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.ok, true); assert.equal(body.status, 'queued');
      assert.equal(body.queueDisposition, 'preparing'); assert.deepEqual(body.media, []);
      assert.equal(typeof body.idempotencyKey, 'string');
      assert.equal(f.connectorUsers.turns.maintenanceCount(runtime), 1);
      const recovered = await request(); assert.equal(recovered.status, 200);
      assert.deepEqual(await recovered.json(), body);
      assert.equal(admissions, 1, 'same HTTP command returns its original receipt, never sends again');
      assert.equal(journal.session(key)?.nativeState, 'allocated');
    } finally { release(); token.dispose(); await f.cleanup(); }
  });
}

test('full Connector routes install and revoke local binding without ordinary session authority', async () => {
  const sessionId = randomUUID(), id = randomUUID();
  const f = createConnectorFixture({ enabled: true, hasBoardTools: (key: string) => key === `codex:${sessionId}` }, false, true);
  const token = f.tokens.createTransient(['boards:bind'], 'local:boards');
  const endpoint = 'http://127.0.0.1:8791/api/workspace-agent/v1/board';
  const base = `/api/connector/v1/sessions/codex%3A${sessionId}/board-binding`;
  const call = (path: string, method = 'GET', body?: object) => f.app.request(path, {
    method, headers: { authorization: `Bearer ${token.token}` }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  try {
    assert.equal((await call(base)).status, 200);
    const response = await call(base, 'PUT', { id, credential: { endpoint, token: 'aod_board_' + 'a'.repeat(43), expiresAt: Date.now() + 60_000 } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).binding.state, 'installed');
    assert.equal((await call(base.replace('/board-binding', '/messages'))).status, 403);
    assert.equal((await call(`${base}/${id}`, 'DELETE')).status, 200);
    assert.equal((await (await call(base)).json()).binding, null);
  } finally { token.dispose(); await f.cleanup(); }
});

for (const exporting of [false, true]) test(`native token usage${exporting ? ' export' : ''} requires owner read scope and bounded ranges without native execution`, async () => {
  const f = createConnectorFixture({ enabled: true });
  try {
    f.store.upsertSession({ sessionKey: 'codex:usage', agentId: 'codex', title: 'Usage', status: 'idle' });
    f.connectorUsers.tokenUsage.record('codex', 'codex:usage', 'event', { inputTokens: 100, outputTokens: 10 });
    f.connectorUsers.tokenUsage.cumulative('codex:usage', 'baseline', { inputTokens: 2000, outputTokens: 200 });
    const reader = f.tokens.create({ label: 'reader', scopes: ['messages:read'] });
    const denied = f.tokens.create({ label: 'denied', scopes: ['sessions:read'] });
    const delegate = f.tokens.create({ label: 'delegate', scopes: ['messages:read', 'execution:delegate'] });
    const end = Date.now() + 1000, query = `?from=${end - 86_400_000}&to=${end}&bucketMs=3600000`;
    const call = (token: string, key = 'codex:usage', suffix = query, extra = {}) => f.app.request(`/api/connector/v1/sessions/${encodeURIComponent(key)}/token-usage${exporting ? '/export' : ''}${suffix}`, { headers: { authorization: `Bearer ${token}`, ...extra } });
    const response = await call(reader.token); assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json(), data = exporting ? body.usage : body;
    if (exporting) assert.equal(body.observations.length, 1);
    assert.equal(data.buckets[0].inputTokens, 100);
    assert.equal(data.cumulativeCoverage.initialBaseline.inputTokens, 2000);
    assert.equal((await call(denied.token)).status, 403);
    assert.equal((await call(delegate.token)).status, 403);
    assert.equal((await call(reader.token, 'codex:usage', query, { 'x-agentopsdeck-execution-grant': 'fixture' })).status, 403);
    assert.equal((await call(reader.token, 'codex:missing')).status, 404);
    assert.equal((await call(reader.token, 'codex:usage', '?from=0&to=999999999999&bucketMs=1')).status, 400);
    f.tokens.revoke(reader.record.id);
    assert.equal((await call(reader.token)).status, 403);
  } finally { await f.cleanup(); }
});

test('token snapshot HTTP receipts are immutable, owner-only, bounded and explicitly created', async () => {
  const f = createConnectorFixture({ enabled: true });
  try {
    const key = 'codex:snapshots', requestId = randomUUID(), to = Date.now() + 1000;
    f.store.upsertSession({ sessionKey: key, agentId: 'codex', title: 'Snapshot', status: 'idle' });
    f.connectorUsers.tokenUsage.record('codex', key, 'first', { inputTokens: 12, outputTokens: 3 });
    const reader = f.tokens.create({ label: 'owner', scopes: ['messages:read'] });
    const delegate = f.tokens.create({ label: 'delegate', scopes: ['messages:read', 'execution:delegate'] });
    const path = `/api/connector/v1/sessions/${encodeURIComponent(key)}/token-usage/snapshots`;
    const selection = { requestId, from: to - 3600000, to, bucketMs: 60000 };
    const call = (method: string, suffix = '', body?: unknown, token = reader.token) => f.app.request(path + suffix,
      { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal((await call('GET', `/${requestId}`)).status, 404);
    assert.equal((await call('POST', '', selection, delegate.token)).status, 403);
    assert.equal((await call('POST', '', { ...selection, extra: 1 })).status, 400);
    const created = await call('POST', '', selection); assert.equal(created.status, 200, await created.clone().text());
    assert.equal(created.headers.get('cache-control'), 'no-store');
    const snapshot = await created.json(); assert.equal(snapshot.data.observations.length, 1);
    f.connectorUsers.tokenUsage.record('codex', key, 'second', { inputTokens: 99, outputTokens: 4 });
    assert.deepEqual(await (await call('POST', '', selection)).json(), snapshot);
    assert.deepEqual(await (await call('GET', `/${requestId}`)).json(), snapshot);
    assert.equal((await call('POST', '', { ...selection, to: to + 1 })).status, 409);
    assert.equal((await call('GET', '/invalid')).status, 400);
    f.tokens.revoke(reader.record.id);
    assert.equal((await call('GET', `/${requestId}`)).status, 403);
  } finally { await f.cleanup(); }
});

for (const mode of ['revoked', 'deleted', 'postcommit-revoked'] as const) test(`token snapshot HTTP rechecks ${mode} across async admission without exposing receipt`, async t => {
  const f = createConnectorFixture({ enabled: true });
  try {
    const key = 'codex:snapshot-gap', requestId = randomUUID(), to = Date.now() + 1000;
    f.store.upsertSession({ sessionKey: key, agentId: 'codex', title: 'Snapshot', status: 'idle' });
    const reader = f.tokens.create({ label: 'owner', scopes: ['messages:read'] });
    let written = false;
    const originalSnapshot = f.connectorUsers.tokenUsage.snapshotAsync.bind(f.connectorUsers.tokenUsage);
    t.mock.method(f.connectorUsers.tokenUsage, 'snapshotAsync', async (...args: Parameters<typeof f.connectorUsers.tokenUsage.snapshotAsync>) => {
      const [runtime, session, id, from, end, bucket, guard] = args;
      await Promise.resolve();
      if (mode === 'postcommit-revoked') { await originalSnapshot(runtime, session, id, from, end, bucket); written = true; }
      if (mode === 'deleted') t.mock.method(f.store, 'getSession', () => undefined);
      else f.tokens.revoke(reader.record.id);
      guard!(); throw Error('guard must refuse');
    });
    const response = await f.app.request(`/api/connector/v1/sessions/${encodeURIComponent(key)}/token-usage/snapshots`, {
      method: 'POST', headers: { authorization: `Bearer ${reader.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ requestId, from: to - 3600000, to, bucketMs: 60000 }),
    });
    assert.equal(response.status, mode === 'deleted' ? 404 : 403);
    assert.equal(written, mode === 'postcommit-revoked');
    assert.equal(!!f.connectorUsers.tokenUsage.readSnapshot('codex', key, requestId), written);
    assert.doesNotMatch(await response.text(), /memberDigest|observations/);
  } finally { await f.cleanup(); }
});
test('session skills require owned read authority and recheck revocation after native IO', async () => {
  let calls = 0, revoke = () => {};
  const f = createConnectorFixture({ enabled: true, listSessionSkills: async (key: string) => {
    calls++; assert.equal(key, 'codex:skills'); revoke();
    return { skills: [], usage: 'unknown', limited: false, discoveryErrors: 0, observedAt: 1 };
  } });
  try {
    f.store.upsertSession({ sessionKey: 'codex:skills', agentId: 'codex', title: 'Skills', status: 'idle' });
    const reader = f.tokens.create({ label: 'reader', scopes: ['messages:read'] });
    const denied = f.tokens.create({ label: 'denied', scopes: ['sessions:read'] });
    const delegated = f.tokens.create({ label: 'delegate', scopes: ['messages:read', 'execution:delegate'] });
    const request = (token: string, key = 'codex:skills') => f.app.request(`/api/connector/v1/sessions/${encodeURIComponent(key)}/skills`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal((await request(denied.token)).status, 403);
    assert.equal((await request(delegated.token)).status, 403);
    assert.equal((await request(reader.token, 'codex:missing')).status, 404);
    assert.equal(calls, 0);
    assert.equal((await request(reader.token)).status, 200);
    revoke = () => { f.tokens.revoke(reader.record.id); };
    assert.equal((await request(reader.token)).status, 403);
    assert.equal((await request(reader.token)).status, 403);
    assert.equal(calls, 2);
  } finally { await f.cleanup(); }
});

test('file index is gated by message scope, revocation and exact Connector identity', async () => {
  const f = createConnectorFixture();
  try {
    const key = 'codex:file-scope';
    f.store.upsertSession({ sessionKey: key, agentId: 'codex', title: 'Files', status: 'idle' });
    const reader = f.tokens.create({ label: 'reader', scopes: ['messages:read'] });
    const denied = f.tokens.create({ label: 'not-reader', scopes: ['sessions:read'] });
    const url = `/api/connector/v1/sessions/${encodeURIComponent(key)}/files`;
    const request = (token: string, extra = {}) => f.app.request(url, { headers: { authorization: `Bearer ${token}`, ...extra } });
    assert.equal((await request(denied.token)).status, 403);
    assert.equal((await request(reader.token)).status, 200);
    assert.equal((await request(reader.token, { [EXPECTED_NODE_HEADER]: 'wrong-node' })).status, 409);
    f.tokens.revoke(reader.record.id);
    assert.equal((await request(reader.token)).status, 403);
  } finally { await f.cleanup(); }
});

test('Codex file rebuild is explicitly offered for hydrated evidence and uses no native calls', async t => {
  const f = createConnectorFixture();
  try {
    const key = 'codex:file-rebuild';
    f.store.upsertSession({ sessionKey: key, agentId: 'codex', title: 'Files', status: 'idle' });
    t.mock.method(f.gateway, 'request', async () => { throw new Error('Must not call native gateway'); });
    const reader = f.tokens.createTransient(['messages:read']), other = f.tokens.createTransient(['messages:read']);
    const path = `/api/connector/v1/sessions/${encodeURIComponent(key)}/files`;
    const request = (suffix = '', method = 'GET', body?: unknown, token = reader.token) => f.app.request(path + suffix, {
      method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.equal((await (await request()).json()).rebuildAvailable, undefined);
    assert.equal((await request('/rebuild', 'POST')).status, 404, 'cold start must not trigger hydration');
    f.connectorUsers.fileIndex.replaceProjection(key, [{ id: 'tool', sessionKey: key, role: 'tool', toolPhase: 'result',
      status: 'sent', createdAt: 1, text: 'private tool body', sourceFiles: [{ path: '/repo/test.ts', kind: 'modified' }] }]);
    assert.equal((await (await request()).json()).rebuildAvailable, true);
    const job = await (await request('/rebuild', 'POST')).json();
    assert.equal(job.state, 'scanning');
    assert.equal((await request(`/rebuild/${job.id}`, 'POST', { step: 0 }, other.token)).status, 404);
    const result = await request(`/rebuild/${job.id}`, 'POST', { step: 0 });
    assert.equal(result.status, 200); assert.equal((await result.json()).state, 'completed');
    const page = await (await request()).json();
    assert.equal(page.source, 'verified-projection'); assert.equal(page.coverage, 'partial');
    assert.equal(page.entries.length, 1); assert.doesNotMatch(JSON.stringify(page), /private tool body/);
    reader.dispose(); other.dispose();
  } finally { await f.cleanup(); }
});

test('Codex file rebuild rechecks revocation during body I/O before reading or committing evidence', async () => {
  const f = createConnectorFixture();
  try {
    const key = 'codex:file-revoke';
    f.store.upsertSession({ sessionKey: key, agentId: 'codex', title: 'Files', status: 'idle' });
    f.connectorUsers.fileIndex.replaceProjection(key, []);
    const reader = f.tokens.createTransient(['messages:read']);
    const path = `/api/connector/v1/sessions/${encodeURIComponent(key)}/files/rebuild`;
    const headers = { authorization: `Bearer ${reader.token}`, 'content-type': 'application/json' };
    const job = await (await f.app.request(path, { method: 'POST', headers })).json();
    const before = f.connectorUsers.fileIndex.page(key);
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
      reader.dispose(); controller.enqueue(new TextEncoder().encode('{"step":0}')); controller.close();
    } }, { highWaterMark: 0 });
    const response = await f.app.fetch(new Request(`http://connector${path}/${job.id}`, {
      method: 'POST', headers, body, duplex: 'half',
    } as RequestInit));
    assert.equal(response.status, 403); assert.deepEqual(f.connectorUsers.fileIndex.page(key), before);
  } finally { await f.cleanup(); }
});

test('wire protocol compatibility is independent of release version and enforced before side effects', async () => {
  assert.equal(negotiateConnectorProtocol(undefined), 1);
  assert.equal(negotiateConnectorProtocol({ min: 1, max: 2 }), 1);
  for (const range of [null, {}, { min: 2, max: 3 }, { min: 0, max: 1 }, { min: 2, max: 1 }, { min: 1, max: 1.5 }]) assert.equal(negotiateConnectorProtocol(range), undefined);
  const f = createConnectorFixture();
  const token = f.tokens.createTransient(['sessions:read', 'models:read']);
  try {
    for (const version of ['2', 'garbage', '01', '1,2']) {
      const response = await f.app.request('/api/connector/v1/agents/main/sessions', { method: 'POST', headers: { [CONNECTOR_PROTOCOL_HEADER]: version, authorization: `Bearer ${token.token}` }, body: '{}' });
      assert.equal(response.status, 426);
      assert.equal(f.store.getSessionsState().groups.length, 0);
    }
    for (const header of [undefined, '1']) {
      const response = await f.app.request('/api/connector/v1/capabilities', { headers: { authorization: `Bearer ${token.token}`, ...(header ? { [CONNECTOR_PROTOCOL_HEADER]: header } : {}) } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get(CONNECTOR_PROTOCOL_HEADER), '1');
      const body = await response.json();
      assert.deepEqual(body.protocol, { min: 1, max: 1 });
      assert.equal(body.limits.maxMessageChars, MAX_MESSAGE_CHARS);
      assert.equal(body.gateway.modelSet, undefined, 'capabilities do not trigger optional model-set IO');
    }
    const incompatible = new ConnectorClient('http://synthetic', 'synthetic', request => {
      assert.equal(request.headers.get(CONNECTOR_PROTOCOL_HEADER), '1');
      return Response.json({}, { headers: { [CONNECTOR_PROTOCOL_HEADER]: '2' } });
    });
    await assert.rejects(incompatible.json('/info'), /Incompatible Connector protocol/);
  } finally { await f.cleanup(); }
});

test('Codex-only Connector reports native-list readiness independently of OpenClaw', async () => {
  let ready = false;
  const fixture = createConnectorFixture({ enabled: true, isSessionListReady: () => ready });
  fixture.config.localOpenClawCli = false;
  try {
    const pending = await fixture.app.request('/api/connector/v1/health');
    assert.equal((await pending.json()).status, 'degraded');
    ready = true;
    const healthy = await fixture.app.request('/api/connector/v1/health');
    const body = await healthy.json();
    assert.equal(body.status, 'online');
    assert.deepEqual(body.codex, { enabled: true, sessionListReady: true });
    assert.equal(body.gateway.ok, false);
  } finally { await fixture.cleanup(); }
});

test('disabled OpenClaw creation is durably rejected without dispatch or replay', async () => {
  const fixture = createConnectorFixture();
  fixture.config.localOpenClawCli = false;
  fixture.gateway.requestBound = async () => assert.fail('disabled runtime must not dispatch');
  const token = fixture.tokens.createTransient(['sessions:create']);
  const request = { method: 'POST', headers: { authorization: `Bearer ${token.token}`, 'content-type': 'application/json', 'idempotency-key': 'disabled-create' }, body: '{}' };
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fixture.app.request('/api/connector/v1/agents/main/sessions', request);
      assert.equal(response.status, 409);
      assert.equal((await response.json()).command.state, 'rejected');
    }
  } finally { await fixture.cleanup(); }
});

for (const transport of ['local', 'http'] as const) test(`${transport}: disabled updates remain read-only through authorized Connector routes`, async t => {
  const f = createConnectorFixture();
  f.config.connector.updateEnabled = false;
  f.config.connector.updateManifestUrl = 'https://example.test/manifest.json';
  f.config.connector.installRoot = join(f.dir, 'installation');
  f.config.connector.currentSymlink = join(f.config.connector.installRoot, 'current');
  f.config.connector.updateStateFile = join(f.dir, 'update.json');
  const source = JSON.stringify({ supported: true, currentVersion: '1.0.0', state: 'idle', rollbackAvailable: false, updatedAt: 1 });
  writeFileSync(f.config.connector.updateStateFile, source);
  const server = transport === 'http' ? serve({ fetch: f.app.fetch, hostname: '127.0.0.1', port: 0 }) : undefined;
  if (server && !server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
  const origin = server ? `http://127.0.0.1:${(server.address() as { port: number }).port}` : 'http://synthetic-connector';
  const wireFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('disabled updater must not fetch external content'); });
  const read = f.tokens.createTransient(['sessions:read']);
  const update = f.tokens.createTransient(['connector:update']);
  const request = (url: string, token: string, body?: object) => {
    const input = new Request(origin + '/api/connector/v1' + url, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return transport === 'local' ? f.app.fetch(input) : wireFetch(input);
  };
  try {
    const status = await request('/update/status', read.token);
    assert.equal(status.status, 200);
    assert.equal((await status.json()).supported, false);
    for (const operation of ['check', 'commands/apply', 'commands/rollback']) {
      const body = operation === 'commands/apply' ? { version: '2.0.0', manifestSha256: 'synthetic', idempotencyKey: 'disabled' } : { idempotencyKey: 'disabled' };
      const denied = await request(`/update/${operation}`, read.token, body);
      assert.equal(denied.status, 403); await denied.arrayBuffer();
      const disabled = await request(`/update/${operation}`, update.token, body);
      assert.equal(disabled.status, 400);
      assert.match((await disabled.json()).error, /updates are disabled/);
    }
    assert.equal(readFileSync(f.config.connector.updateStateFile, 'utf8'), source);
    assert.equal(existsSync(f.config.connector.installRoot), false);
    assert.equal(existsSync(f.config.connector.updateStateFile + '.lock'), false);
  } finally {
    read.dispose(); update.dispose();
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await f.cleanup();
  }
});

for (const operation of ['check', 'commands/apply', 'commands/rollback'] as const) {
  test(`update ${operation} rejects revoked authority while reading bounded request body`, async t => {
    const f = createUpdateRouteFixture();
    t.mock.method(globalThis, 'fetch', async () => { assert.fail('denied body must not download'); });
    const token = f.tokens.createTransient(['connector:update']);
    try {
      const body = new ReadableStream<Uint8Array>({ pull(controller) {
        token.dispose();
        controller.enqueue(new TextEncoder().encode('{}')); controller.close();
      } }, { highWaterMark: 0 });
      const response = await f.app.fetch(new Request(`http://connector/api/connector/v1/update/${operation}`, {
        method: 'POST', headers: { authorization: `Bearer ${token.token}` }, body, duplex: 'half',
      } as RequestInit));
      assert.equal(response.status, 403);
      assert.equal((await response.json()).error, 'update authorization changed');
      assert.equal(existsSync(f.config.connector.updateStateFile + '.lock'), false);
      assert.equal(existsSync(f.config.connector.installRoot!), false);
    } finally { token.dispose(); await f.cleanup(); }
  });
}

for (const transport of ['local', 'http'] as const) test(`${transport}: update HTTP validates actual body bounds and field allowlists before mutation`, async t => {
  const f = createUpdateRouteFixture();
  const token = f.tokens.createTransient(['connector:update']);
  const server = transport === 'http' ? serve({ fetch: f.app.fetch, hostname: '127.0.0.1', port: 0 }) : undefined;
  if (server && !server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
  const origin = server ? `http://127.0.0.1:${(server.address() as { port: number }).port}` : 'http://connector';
  const wireFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async () => { assert.fail('invalid body must not download'); });
  try {
    for (const [operation, body, expected] of [
      ['check', 'null', 400], ['check', '{', 400], ['check', '[]', 400], ['check', '{"channel":"nightly"}', 400],
      ['check', '{"actor":"other"}', 400], ['commands/rollback', '{"actor":"other","idempotencyKey":"original"}', 400],
      ['commands/apply', '{"version":42,"manifestSha256":"x"}', 400], ['commands/apply', '{"artifactUrl":"https://example.test"}', 400],
      ['commands/apply', JSON.stringify({ version: 'x'.repeat(9000) }), 413],
    ] as const) {
      const request = new Request(`${origin}/api/connector/v1/update/${operation}`, { method: 'POST', headers: { authorization: `Bearer ${token.token}` }, body });
      const response = await (transport === 'local' ? f.app.fetch(request) : wireFetch(request));
      assert.equal(response.status, expected, operation + ':' + body.slice(0, 60));
      assert.equal(response.headers.get('cache-control'), 'no-store');
      await response.arrayBuffer();
      assert.equal(existsSync(f.config.connector.updateStateFile + '.lock'), false);
      assert.equal(existsSync(f.config.connector.installRoot!), false);
    }
  } finally {
    token.dispose();
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await f.cleanup();
  }
});

for (const boundary of ['revoked', 'closed', 'disconnected'] as const) test(`update check ${boundary} during download rechecks authority without discarding admitted results`, async t => {
  const f = createUpdateRouteFixture();
  const token = f.tokens.createTransient(['connector:update']);
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async () => {
    if (boundary === 'revoked') token.dispose();
    if (boundary === 'closed') f.routes.close();
    if (boundary === 'disconnected') controller.abort();
    return Response.json({ releases: [] });
  });
  try {
    const response = await f.app.fetch(new Request('http://connector/api/connector/v1/update/check', {
      method: 'POST', headers: { authorization: `Bearer ${token.token}` }, body: '{}', signal: controller.signal,
    }));
    assert.equal(response.status, boundary === 'disconnected' ? 200 : 403);
    await response.arrayBuffer();
    assert.equal(existsSync(f.config.connector.updateStateFile), boundary === 'disconnected');
  } finally { token.dispose(); await f.cleanup(); }
});

test('ordinary update status readers cannot recover or create mutation locks', async () => {
  const f = createUpdateRouteFixture();
  const token = f.tokens.createTransient(['sessions:read']);
  const source = JSON.stringify({ supported: true, currentVersion: '1.0.0', state: 'installing', rollbackAvailable: false, updatedAt: 1 });
  writeFileSync(f.config.connector.updateStateFile, source);
  try {
    const response = await f.app.request('/api/connector/v1/update/status', { headers: { authorization: `Bearer ${token.token}` } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).state, 'installing');
    assert.equal(readFileSync(f.config.connector.updateStateFile, 'utf8'), source);
    assert.equal(existsSync(f.config.connector.updateStateFile + '.lock'), false);
    assert.equal(existsSync(f.config.connector.installRoot!), false);
  } finally { token.dispose(); await f.cleanup(); }
});

function createUpdateRouteFixture() {
  const f = createConnectorFixture();
  Object.assign(f.config.connector, { updateEnabled: true, updateManifestUrl: 'https://example.test/manifest.json',
    updateStateFile: join(f.dir, 'update.json'), installRoot: join(f.dir, 'installation'), currentSymlink: join(f.dir, 'current') });
  return f;
}

for (const transport of ['local', 'http'] as const) test(`${transport}: retired update writes never parse, download or claim, even with a valid key`, async t => {
  const f = createUpdateRouteFixture(), token = f.tokens.createTransient(['connector:update']);
  const wireFetch = globalThis.fetch;
  const server = transport === 'http' ? serve({ fetch: f.app.fetch, hostname: '127.0.0.1', port: 0 }) : undefined;
  if (server && !server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
  const origin = server ? `http://127.0.0.1:${(server.address() as { port: number }).port}` : 'http://connector';
  t.mock.method(globalThis, 'fetch', async () => assert.fail('retired endpoint must not fetch'));
  try {
    for (const operation of ['apply', 'rollback']) {
      const req = new Request(`${origin}/api/connector/v1/update/${operation}`, { method: 'POST', headers: { authorization: `Bearer ${token.token}` },
        body: JSON.stringify({ idempotencyKey: 'original', version: 'v2', manifestSha256: 'a'.repeat(64) }) });
      const response = await (transport === 'local' ? f.app.fetch(req) : wireFetch(req));
      assert.equal(response.status, 410); assert.equal(response.headers.get('cache-control'), 'no-store'); await response.arrayBuffer();
      const receipt = await f.app.request(`/api/connector/v1/update/commands/${operation}/original`, { headers: { authorization: `Bearer ${token.token}` } });
      assert.equal(receipt.status, 404); await receipt.arrayBuffer();
    }
    assert.equal(existsSync(f.config.connector.updateStateFile), false);
    assert.equal(existsSync(f.config.connector.updateStateFile + '.lock'), false);
    assert.equal(existsSync(f.config.connector.installRoot!), false);
  } finally { token.dispose(); if (server) await new Promise<void>(resolve => server.close(() => resolve())); await f.cleanup(); }
});

for (const transport of ['local', 'http'] as const) {
  test(`${transport}: maintenance command HTTP preserves original outcomes and isolates actors and operations`, async t => {
    const f = createUpdateRouteFixture();
    const token = f.tokens.createTransient(['connector:update']);
    const other = f.tokens.createTransient(['connector:update']);
    const reader = f.tokens.createTransient(['sessions:read']);
    const wireFetch = globalThis.fetch;
    const server = transport === 'http' ? serve({ fetch: f.app.fetch, hostname: '127.0.0.1', port: 0 }) : undefined;
    if (server && !server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
    const origin = server ? `http://127.0.0.1:${(server.address() as { port: number }).port}` : 'http://connector';
    let downloads = 0;
    const manifest = JSON.stringify({ releases: [{ version: f.config.connector.version, artifactUrl: 'https://example.test/artifact', sha256: 'a'.repeat(64) }] });
    t.mock.method(globalThis, 'fetch', async () => { downloads++; return new Response(manifest); });
    const body = { version: f.config.connector.version, manifestSha256: createHash('sha256').update(manifest).digest('hex'), idempotencyKey: 'original' };
    const request = async (path: string, payload?: object, bearer = token.token, node = f.connectorUsers.nodeId) => {
      const req = new Request(`${origin}/api/connector/v1/update/${path}`, {
        method: payload ? 'POST' : 'GET', headers: { authorization: `Bearer ${bearer}`, [EXPECTED_NODE_HEADER]: node },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
      });
      const response = await (transport === 'local' ? f.app.fetch(req) : wireFetch(req));
      assert.equal(response.headers.get('cache-control'), node === f.connectorUsers.nodeId ? 'no-store' : null);
      return { status: response.status, body: await response.json() };
    };
    try {
      const applied = await request('commands/apply', body);
      assert.equal(applied.status, 200);
      assert.equal(applied.body.state, 'succeeded');
      assert.equal(applied.body.command.state, 'accepted');
      const original = await request('commands/apply/original');
      assert.equal(original.body.command.id, applied.body.command.id);
      assert.equal(original.body.command.result.body.state, 'succeeded');
      assert.equal((await request('commands/apply', { ...body, version: 'different' })).status, 409);
      assert.equal((await request('commands/apply', body)).body.command.id, applied.body.command.id);
      assert.equal(downloads, 1, 'duplicate receipt must not fetch or execute');
      assert.equal((await request('commands/apply/original', undefined, other.token)).status, 404);
      assert.equal((await request('commands/apply/original', undefined, reader.token)).status, 403);
      assert.equal((await request('commands/apply/original', undefined, token.token, 'another-node')).status, 409);
      assert.equal((await request('commands/rollback/original')).status, 404);
      const rollback = await request('commands/rollback', { idempotencyKey: 'original' });
      assert.equal(rollback.status, 200);
      assert.equal(rollback.body.state, 'failed', 'accepted receipt is not a successful rollback');
      assert.notEqual(rollback.body.command.id, applied.body.command.id);
      await request('check', {});
      f.config.connector.updateEnabled = false;
      const source = readFileSync(f.config.connector.updateStateFile, 'utf8');
      assert.deepEqual(await request('commands/apply/original'), original);
      assert.equal((await request('commands/apply', body)).status, 400);
      assert.equal(readFileSync(f.config.connector.updateStateFile, 'utf8'), source);
    } finally {
      token.dispose(); other.dispose(); reader.dispose();
      if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await f.cleanup();
    }
  });

  test(`${transport}: maintenance command validates body and key before receipt admission`, async t => {
    const f = createUpdateRouteFixture();
    const token = f.tokens.createTransient(['connector:update']);
    const wireFetch = globalThis.fetch;
    const server = transport === 'http' ? serve({ fetch: f.app.fetch, hostname: '127.0.0.1', port: 0 }) : undefined;
    if (server && !server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
    const origin = server ? `http://127.0.0.1:${(server.address() as { port: number }).port}` : 'http://connector';
    t.mock.method(globalThis, 'fetch', async () => { assert.fail('invalid command must not download'); });
    try {
      for (const operation of ['apply', 'rollback']) for (const [body, status] of [
        ['{}', 400], ['null', 400], ['{', 400], ['[]', 400], ['{"idempotencyKey":42}', 400],
        ['{"idempotencyKey":"x","actor":"other"}', 400], ['{"idempotencyKey":"x","version":' + ' '.repeat(9000) + '"v"}', 413],
      ] as const) {
        const req = new Request(`${origin}/api/connector/v1/update/commands/${operation}`, {
          method: 'POST', headers: { authorization: `Bearer ${token.token}` }, body,
        });
        const response = await (transport === 'local' ? f.app.fetch(req) : wireFetch(req));
        assert.equal(response.status, status); await response.arrayBuffer();
      }
      assert.equal(existsSync(f.config.connector.updateStateFile), false);
      assert.equal(existsSync(f.config.connector.updateStateFile + '.lock'), false);
      assert.equal(existsSync(f.config.connector.installRoot!), false);
    } finally {
      token.dispose();
      if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await f.cleanup();
    }
  });
}

test('maintenance HTTP disconnect and concurrent duplicate retain the one admitted command', async t => {
  const f = createUpdateRouteFixture();
  const token = f.tokens.createTransient(['connector:update']);
  const controller = new AbortController();
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let downloads = 0;
  const manifest = JSON.stringify({ releases: [] });
  t.mock.method(globalThis, 'fetch', async () => { downloads++; enter(); await gate; return new Response(manifest); });
  const body = { version: '2.0.0', manifestSha256: createHash('sha256').update(manifest).digest('hex'), idempotencyKey: 'lost' };
  const request = (payload?: object, signal?: AbortSignal) => f.app.fetch(new Request(`http://connector/api/connector/v1/update/commands/apply${payload ? '' : '/lost'}`, {
    method: payload ? 'POST' : 'GET', headers: { authorization: `Bearer ${token.token}` },
    ...(payload ? { body: JSON.stringify(payload) } : {}), ...(signal ? { signal } : {}),
  }));
  const pending = Promise.resolve(request(body, controller.signal));
  try {
    await Promise.race([entered, pending.then(response => { assert.notEqual(response.status, 404); })]);
    assert.equal(downloads, 1);
    controller.abort();
    const unknown = await request();
    assert.equal(unknown.status, 200);
    const original = (await unknown.json()).command;
    assert.equal(original.state, 'outcome_unknown');
    const duplicate = await request(body);
    assert.equal(duplicate.status, 202);
    assert.equal((await duplicate.json()).command.id, original.id);
    release(); await (await pending).arrayBuffer();
    const outcome = (await (await request()).json()).command;
    assert.equal(outcome.id, original.id);
    assert.equal(outcome.result.body.state, 'failed');
    assert.equal(downloads, 1);
  } finally { release(); await pending; token.dispose(); await f.cleanup(); }
});

test('maintenance original receipt remains queryable after an actual HTTP client disconnects', async t => {
  const f = createUpdateRouteFixture();
  const token = f.tokens.createTransient(['connector:update']);
  const wireFetch = globalThis.fetch;
  const controller = new AbortController();
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let admitted: Promise<Response> | undefined, downloads = 0;
  const server = serve({ hostname: '127.0.0.1', port: 0, fetch: request => {
    const response = Promise.resolve(f.app.fetch(request));
    if (request.method === 'POST') admitted = response;
    return response;
  } });
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const manifest = JSON.stringify({ releases: [] });
  t.mock.method(globalThis, 'fetch', async () => { downloads++; enter(); await gate; return new Response(manifest); });
  const body = { version: '2.0.0', manifestSha256: createHash('sha256').update(manifest).digest('hex'), idempotencyKey: 'lost-network' };
  const pending = wireFetch(`${origin}/api/connector/v1/update/commands/apply`, {
    method: 'POST', headers: { authorization: `Bearer ${token.token}` }, body: JSON.stringify(body), signal: controller.signal,
  });
  const interrupted = assert.rejects(pending, { name: 'AbortError' });
  try {
    await entered;
    controller.abort(); await interrupted;
    release(); await admitted;
    const response = await wireFetch(`${origin}/api/connector/v1/update/commands/apply/lost-network`, { headers: { authorization: `Bearer ${token.token}` } });
    assert.equal(response.status, 200);
    const receipt = (await response.json()).command;
    assert.equal(receipt.state, 'accepted');
    assert.equal(receipt.result.body.state, 'failed');
    assert.equal(downloads, 1);
  } finally {
    release(); controller.abort(); await interrupted; await admitted;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    token.dispose(); await f.cleanup();
  }
});

for (const identity of ['persistent', 'local:maintenance'] as const) test(`fresh maintenance router queries durable receipts with ${identity} identity`, async t => {
  const f = createUpdateRouteFixture();
  const credential = identity === 'persistent' ? f.tokens.create({ label: 'synthetic maintenance', scopes: ['connector:update'] })
    : f.tokens.createTransient(['connector:update'], identity);
  const manifest = JSON.stringify({ releases: [] });
  t.mock.method(globalThis, 'fetch', async () => new Response(manifest));
  let reopened: ConnectorUserStore | undefined;
  let routes: ReturnType<typeof registerConnectorRoutes> | undefined;
  try {
    const response = await f.app.fetch(new Request('http://connector/api/connector/v1/update/commands/apply', {
      method: 'POST', headers: { authorization: `Bearer ${credential.token}` },
      body: JSON.stringify({ version: '2.0.0', manifestSha256: createHash('sha256').update(manifest).digest('hex'), idempotencyKey: 'durable' }),
    }));
    assert.equal(response.status, 200);
    const original = await response.json();
    f.routes.close();
    const tokens = new ConnectorTokenStore(f.config.connector.tokenFile);
    const bearer = identity === 'persistent' ? credential.token : tokens.createTransient(['connector:update'], identity).token;
    if (identity !== 'persistent') assert.notEqual(bearer, credential.token, 'secret rotates while trusted local actor is stable');
    reopened = new ConnectorUserStore(f.config.connector.usersDatabaseFile);
    const app = new Hono();
    routes = registerConnectorRoutes(app, { config: f.config, tokens, connectorUsers: reopened, store: f.store, gateway: f.gateway as any,
      refreshSessions: async () => {}, refreshMessages: async () => {}, sessionSnapshotReady: () => true, historySnapshotReady: () => true,
      fallbackAgents: () => [], isAuthorizedRequest: () => true, normalizeError: error => String(error) });
    const request = () => app.fetch(new Request('http://connector/api/connector/v1/update/commands/apply/durable', { headers: { authorization: `Bearer ${bearer}` } }));
    const found = await request();
    assert.equal(found.status, 200);
    assert.equal((await found.json()).command.id, original.command.id);
    const get = reopened.commands.get.bind(reopened.commands);
    t.mock.method(reopened.commands, 'get', (...args: Parameters<typeof get>) => { const value = get(...args); routes!.close(); return value; });
    const denied = await request();
    assert.equal(denied.status, 403, 'authority must be checked again before returning the original result');
    await denied.arrayBuffer();
  } finally { routes?.close(); reopened?.close(); await f.cleanup(); }
});

for (const runtime of ['openclaw', 'codex', 'cli-display'] as const) {
  for (const transport of ['local', 'http'] as const) test(`${transport} ${runtime} creation ACK survives title persistence failure and retries only read receipts`, async () => {
    let writes = 0, projections = 0;
    const f = createConnectorFixture(runtime === 'codex' ? {
      createSession: async (_params: unknown, accept: (key: string) => void, authorize: () => void) => {
        authorize(); writes++; accept('codex:synthetic-created');
        f.store.persistSessionTitleOverride('codex:synthetic-created', 'new');
        return { key: 'codex:synthetic-created' };
      },
    } : undefined);
    f.gateway.request = async () => {
      writes++;
      if (runtime === 'cli-display') throw new GatewayRpcError('sessions.create', 'INVALID_REQUEST', 'missing scope: operator.write');
      return { key: 'agent:main:dashboard:synthetic-created' };
    };
    f.store.persistSessionTitleOverride = () => { projections++; throw new Error('synthetic title failure'); };
    const server = transport === 'http' ? serve({ fetch: f.app.fetch, hostname: '127.0.0.1', port: 0 }) : undefined;
    if (server && !server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
    try {
      const token = f.tokens.createTransient(['sessions:create']);
      const client = new ConnectorClient(transport === 'http'
        ? `http://127.0.0.1:${(server!.address() as { port: number }).port}` : 'http://synthetic-connector', token.token,
      transport === 'local' ? request => f.app.fetch(request) : undefined);
      const url = `/agents/${runtime === 'codex' ? 'codex' : 'main'}/sessions`;
      const send = () => client.jsonResponse<any>(url, { method: 'POST', headers: { 'idempotency-key': 'synthetic-create', 'content-type': 'application/json' }, body: '{"title":"new"}' });
      const initial = await send();
      assert.equal(initial.status, 201); assert.equal(initial.body.command.state, 'accepted');
      assert.ok(initial.body.key); assert.equal(f.store.getSession(initial.body.key), undefined);
      assert.deepEqual(await send(), initial);
      const recovered = await client.json<any>(`${url}/creation-commands/synthetic-create`);
      assert.equal(recovered.command.result.body.key, initial.body.key);
      assert.equal(writes, 1); assert.equal(projections, 1);
      token.dispose(); await assert.rejects(client.json(`${url}/creation-commands/synthetic-create`), { status: 403 });
    } finally {
      if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await f.cleanup();
    }
  });
}

for (const runtime of ['openclaw', 'codex'] as const) {
  test(`${runtime} create rejects authority revoked while reading request body`, async () => {
    let writes = 0;
    const f = createConnectorFixture(runtime === 'codex' ? { createSession: async () => { writes++; return { key: 'codex:new' }; } } : undefined);
    f.gateway.request = async () => { writes++; return { key: 'agent:main:dashboard:new' }; };
    try {
      const token = f.tokens.createTransient(['sessions:create']);
      const body = new ReadableStream<Uint8Array>({ pull(controller) {
        token.dispose();
        controller.enqueue(new TextEncoder().encode('{"title":"new"}')); controller.close();
      } }, { highWaterMark: 0 });
      const request = new Request(`http://connector/api/connector/v1/agents/${runtime === 'codex' ? 'codex' : 'main'}/sessions`, {
        method: 'POST', headers: { authorization: `Bearer ${token.token}`, 'content-type': 'application/json' }, body, duplex: 'half',
      } as RequestInit);
      const response = await f.app.fetch(request);
      assert.equal(response.status, 403);
      assert.equal((await response.json()).error, 'session authorization changed');
      assert.equal(writes, 0);
    } finally { await f.cleanup(); }
  });
}

for (const boundary of ['connection-revoke', 'connection-abort', 'fallback-revoke', 'ack-revoke'] as const) {
  test(`OpenClaw create authority boundary: ${boundary}`, async () => {
    const f = createConnectorFixture();
    try {
      const token = f.tokens.createTransient(['sessions:create']);
      const controller = new AbortController();
      let writes = 0;
      const original = f.gateway.requestBound;
      f.gateway.requestBound = async (...args) => {
        if (boundary === 'connection-revoke') token.dispose();
        if (boundary === 'connection-abort') controller.abort();
        await Promise.resolve(); return original(...args);
      };
      f.gateway.request = async () => {
        writes++; token.dispose();
        if (boundary === 'fallback-revoke') throw new GatewayRpcError('sessions.create', 'INVALID_REQUEST', 'missing scope: operator.write');
        return { key: 'agent:main:dashboard:new' };
      };
      const response = await f.app.request('/api/connector/v1/agents/main/sessions', {
        method: 'POST', headers: { authorization: `Bearer ${token.token}`, 'content-type': 'application/json' },
        body: '{"title":"new"}', signal: controller.signal,
      });
      assert.equal(response.status, boundary === 'ack-revoke' ? 201 : boundary === 'connection-abort' ? 202 : 403);
      assert.equal(writes, boundary.startsWith('connection') ? 0 : 1);
      assert.equal(f.store.getSessionsState().groups.flatMap(group => group.sessions).length, boundary === 'ack-revoke' ? 1 : 0);
      if (boundary === 'ack-revoke') assert.equal((await response.json()).key, 'agent:main:dashboard:new');
    } finally { await f.cleanup(); }
  });
}

for (const runtime of ['openclaw', 'codex'] as const) {
  for (const state of ['accepted', 'outcome_unknown', 'rejected', 'other-key'] as const) {
    test(`${runtime} create checks returned identity after native ACK: ${state}`, async () => {
      const sessionKey = runtime === 'codex' ? 'codex:reused-thread' : 'agent:main:dashboard:reused-session';
      let creates = 0;
      const f = createConnectorFixture(runtime === 'codex' ? {
        createSession: async (_params: unknown, acceptIdentity: (key: string) => void) => {
          await recordDeletion();
          acceptIdentity(sessionKey);
          f.store.upsertSession({ sessionKey, agentId: runtime, title: 'new', status: 'idle' });
          return { key: sessionKey };
        },
      } : undefined);
      const scope = JSON.stringify(['delete', JSON.stringify(['another-actor', state === 'other-key' ? 'other' : sessionKey])]);
      const recordDeletion = async () => {
        creates++;
        // Simulates deletion settling while native creation is awaited.
        await f.connectorUsers.commands.claimAsync(scope, 'old-deletion', {});
        if (state !== 'outcome_unknown') f.connectorUsers.commands.settle(scope, 'old-deletion', {
          status: state === 'rejected' ? 409 : 200, body: { ok: state !== 'rejected' },
        });
      };
      f.gateway.request = async (method: string) => {
        assert.equal(method, 'sessions.create'); await recordDeletion(); return { key: sessionKey };
      };
      try {
        f.store.upsertSession({ sessionKey, agentId: runtime, title: 'old', status: 'idle', source: 'web' });
        f.store.persistSessionTitleOverride(sessionKey, 'old');
        assert.equal(f.store.getSession(sessionKey)?.title, 'old');
        const before = readFileSync(f.config.sessionTitlesFile, 'utf8');
        const token = f.tokens.createTransient(['sessions:create']).token;
        const response = await f.app.request(`/api/connector/v1/agents/${runtime === 'codex' ? 'codex' : 'main'}/sessions`, {
          method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ title: 'new' }),
        });
        const conflict = state === 'accepted' || state === 'outcome_unknown';
        assert.equal(response.status, conflict ? 409 : 201);
        assert.equal(creates, 1);
        if (conflict) {
          assert.equal((await response.json()).command.state, 'rejected');
          assert.equal(f.store.getSession(sessionKey)?.title, 'old');
          assert.equal(readFileSync(f.config.sessionTitlesFile, 'utf8'), before);
          assert.equal(f.connectorUsers.commands.sessionDeletion(sessionKey), state);
        }
      } finally { await f.cleanup(); }
    });
  }
}

test('Connector identity is authenticated and expected-node mismatch prevents real mutation handlers', async () => {
  const f = createConnectorFixture();
  try {
    const token = f.tokens.create({ label: 'test', scopes: ['users:write'] }).token;
    assert.equal((await f.app.request('/api/connector/v1/identity')).status, 401);
    const client = new ConnectorClient('http://connector', token, (r) => f.app.fetch(r));
    const nodeId = await client.identity();
    const pinned = new ConnectorClient('http://connector', token, (r) => f.app.fetch(r), undefined, undefined, { nodeId });
    const before = f.connectorUsers.listUsers().length;
    const rejected = await f.app.request('/api/connector/v1/users', { method: 'POST',
      headers: { authorization: `Bearer ${token}`, [EXPECTED_NODE_HEADER]: 'wrong-node', 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'must not create' }) });
    assert.equal(rejected.status, 409);
    assert.equal(rejected.headers.get(NODE_ID_HEADER), nodeId);
    assert.equal(f.connectorUsers.listUsers().length, before);
    await pinned.json('/users', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'created' }) });
    assert.equal(f.connectorUsers.listUsers().length, before + 1);
  } finally { await f.cleanup(); }
});

for (const mode of ['local', 'http'] as const) test(`${mode}: Connector directory is scoped, bounded, projection-only and pinned`, async () => {
  let refreshes = 0;
  const f = createConnectorFixture({ refreshSessions: async () => { refreshes++; throw new Error('No runtime refresh'); } });
  const remote = mode === 'http' ? serve({ fetch: r => f.app.fetch(r), hostname: '127.0.0.1', port: 0 }) : undefined;
  if (remote && !remote.listening) await new Promise<void>(resolve => remote.once('listening', resolve));
  try {
    const token = f.tokens.create({ label: 'directory', scopes: ['sessions:read'] });
    const origin = remote ? `http://127.0.0.1:${(remote.address() as { port: number }).port}` : 'http://connector';
    const client = new ConnectorClient(origin, token.token, remote ? undefined : r => f.app.fetch(r), undefined, undefined, { nodeId: f.connectorUsers.nodeId });
    f.store.upsertSession({ sessionKey: 'codex:空 格/#?&', agentId: 'codex', title: 'private', status: 'running' });
    const page = await client.sessionDirectory({ runtime: 'codex', sessionKey: 'codex:空 格/#?&' });
    assert.deepEqual(page.sessions, [{ sessionKey: 'codex:空 格/#?&', runtime: 'codex' }]);
    assert.equal(page.sourceCursor, f.store.latestEventId()); assert.equal(refreshes, 0);
    const result = await f.app.request('/api/connector/v1/sessions/directory', { headers: { authorization: `Bearer ${token.token}` } });
    assert.equal(result.headers.get('cache-control'), 'no-store');
    for (const q of ['runtime=codex&runtime=openclaw', 'agentId=main', 'limit=101']) {
      await assert.rejects(client.json(`/sessions/directory?${q}`), { status: 400 });
    }
    const wrong = new ConnectorClient(origin, token.token, remote ? undefined : r => f.app.fetch(r), undefined, undefined,
      { nodeId: 'node_00000000-0000-4000-8000-000000000099' });
    await assert.rejects(wrong.sessionDirectory(), { status: 502 });
    f.tokens.revoke(token.record.id);
    await assert.rejects(client.sessionDirectory(), { status: 403 });
    assert.equal((await f.app.request('/api/connector/v1/sessions/directory')).status, 403);
    assert.equal(refreshes, 0);
  } finally {
    if (remote) { if ('closeAllConnections' in remote) remote.closeAllConnections(); await new Promise<void>(resolve => remote.close(() => resolve())); }
    await f.cleanup();
  }
});

test('Connector media stops delivery after token revocation', async () => {
  const f = createConnectorFixture();
  try {
    const mediaDir = f.config.inboundMediaDir;
    mkdirSync(mediaDir, { recursive: true, mode: 0o700 }); chmodSync(mediaDir, 0o700);
    writeFileSync(join(mediaDir, 'test.bin'), Buffer.alloc(1024 * 1024, 7), { mode: 0o600 });
    const token = f.tokens.create({ label: 'reader', scopes: ['media:read'] });
    const response = await f.app.request('/api/connector/v1/media/inbound/test.bin', { headers: { authorization: `Bearer ${token.token}` } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const reader = response.body!.getReader();
    try {
      assert.ok((await reader.read()).value!.length > 0);
      f.tokens.revoke(token.record.id);
      await assert.rejects(reader.read(), /authorization changed/);
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  } finally { await f.cleanup(); }
});

test('authorized idle connector stream flushes a heartbeat without a message ID', async () => {
  const fixture = createConnectorFixture();
  const controller = new AbortController();
  try {
    const token = fixture.tokens.create({ label: 'events reader', scopes: ['events:read'] }).token;
    const response = await fixture.app.request('/api/connector/v1/events/stream', { headers: { authorization: `Bearer ${token}` }, signal: controller.signal });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-accel-buffering'), 'no');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const reader = response.body!.getReader();
    const { value } = await reader.read();
    const frame = new TextDecoder().decode(value);
    assert.match(frame, /event: heartbeat/);
    assert.doesNotMatch(frame, /(?:^|\n)id:/);
    controller.abort(); await reader.cancel();
  } finally { controller.abort(); await fixture.cleanup(); }
});

test('connector media endpoint requires media:read and streams scoped inbound media bytes', async () => {
  const fixture = createConnectorFixture();
  try {
    const mediaDir = fixture.config.inboundMediaDir;
    mkdirSync(mediaDir, { recursive: true, mode: 0o700 }); chmodSync(mediaDir, 0o700);
    writeFileSync(join(mediaDir, 'remote.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]), { mode: 0o600 });
    const token = fixture.tokens.create({ label: 'media reader', scopes: ['media:read'] }).token;
    const noScopeToken = fixture.tokens.create({ label: 'sessions reader', scopes: ['sessions:read'] }).token;

    const missingAuth = await fixture.app.request('/api/connector/v1/media/inbound/remote.png');
    assert.equal(missingAuth.status, 403);
    assert.equal((await missingAuth.json() as any).error, 'missing media:read scope');

    const wrongScope = await fixture.app.request('/api/connector/v1/media/inbound/remote.png', {
      headers: { authorization: `Bearer ${noScopeToken}` },
    });
    assert.equal(wrongScope.status, 403);

    const res = await fixture.app.request('/api/connector/v1/media/inbound/remote.png', {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.match(res.headers.get('content-disposition') ?? '', /^inline; filename="remote\.png"$/);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    assert.equal(JSON.stringify([...res.headers]).includes(token), false);
  } finally {
    await fixture.cleanup();
  }
});

test('connector session pin API persists pinned state and requires write scope', async () => {
  const fixture = createConnectorFixture();
  try {
    const readToken = fixture.tokens.create({ label: 'sessions reader', scopes: ['sessions:read'] }).token;
    const writeToken = fixture.tokens.create({ label: 'sessions writer', scopes: ['sessions:create'] }).token;
    const sessionKey = 'agent:connector-dev:dashboard:pin-api';
    fixture.store.replaceSessions([{ sessionKey, agentId: 'connector-dev', label: 'Pin API', status: 'idle', updatedAt: 10 }]);

    const wrongScope = await fixture.app.request(`/api/connector/v1/sessions/${encodeURIComponent(sessionKey)}/pin`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${readToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ pinned: true }),
    });
    assert.equal(wrongScope.status, 403);

    const pinnedRes = await fixture.app.request(`/api/connector/v1/sessions/${encodeURIComponent(sessionKey)}/pin`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${writeToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ pinned: true }),
    });
    assert.equal(pinnedRes.status, 200);
    assert.equal((await pinnedRes.json() as any).pinned, true);

    const stateRes = await fixture.app.request('/api/connector/v1/sessions/state', {
      headers: { authorization: `Bearer ${readToken}` },
    });
    const state = await stateRes.json() as any;
    assert.equal(state.pinnedCount, 1);
    assert.equal(state.groups[0].sessions[0].pinned, true);

    const unpinnedRes = await fixture.app.request(`/api/connector/v1/sessions/${encodeURIComponent(sessionKey)}/pin`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${writeToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ pinned: false }),
    });
    assert.equal(unpinnedRes.status, 200);
    assert.equal((await unpinnedRes.json() as any).pinned, false);
    assert.equal(fixture.store.getSessionsState().pinnedCount, 0);
  } finally {
    await fixture.cleanup();
  }
});

test('connector user API lists creates and renames connector-local records with scoped tokens', async () => {
  const fixture = createConnectorFixture();
  try {
    const readToken = fixture.tokens.create({ label: 'user reader', scopes: ['users:read'] }).token;
    const writeToken = fixture.tokens.create({ label: 'user writer', scopes: ['users:write'] }).token;

    const missingScope = await fixture.app.request('/api/connector/v1/users', {
      headers: { authorization: `Bearer ${writeToken}` },
    });
    assert.equal(missingScope.status, 403);

    const initialRes = await fixture.app.request('/api/connector/v1/users', {
      headers: { authorization: `Bearer ${readToken}` },
    });
    const initial = await initialRes.json() as any;
    assert.equal(initialRes.status, 200);
    assert.deepEqual(initial.users.map((user: any) => ({ id: user.id, label: user.label })), [
      { id: 'default', label: 'Default connector account' },
    ]);

    const createdRes = await fixture.app.request('/api/connector/v1/users', {
      method: 'POST',
      headers: { authorization: `Bearer ${writeToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ label: '  Connector Operator  ' }),
    });
    const created = await createdRes.json() as any;
    assert.equal(createdRes.status, 201);
    assert.match(created.user.id, /^conn_user_/);
    assert.equal(created.user.label, 'Connector Operator');

    const patchRes = await fixture.app.request(`/api/connector/v1/users/${created.user.id}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${writeToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'Connector Admin' }),
    });
    const patched = await patchRes.json() as any;
    assert.equal(patchRes.status, 200);
    assert.equal(patched.user.label, 'Connector Admin');
    assert.equal(JSON.stringify(patched).includes(writeToken), false);
  } finally {
    await fixture.cleanup();
  }
});

test('connector session create requires scope and delegates to Gateway sessions.create', async () => {
  const fixture = createConnectorFixture();
  const calls: any[] = [];
  fixture.gateway.request = async (method: string, params: any) => {
    calls.push({ method, params });
    return { key: 'agent:remote-pm:dashboard:new-session' };
  };
  try {
    const wrongToken = fixture.tokens.create({ label: 'reader', scopes: ['sessions:read'] }).token;
    const createToken = fixture.tokens.create({ label: 'creator', scopes: ['sessions:create'] }).token;

    const wrong = await fixture.app.request('/api/connector/v1/agents/remote-pm/sessions', {
      method: 'POST',
      headers: { authorization: `Bearer ${wrongToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'Remote new' }),
    });
    assert.equal(wrong.status, 403);

    const res = await fixture.app.request('/api/connector/v1/agents/remote-pm/sessions', {
      method: 'POST',
      headers: { authorization: `Bearer ${createToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'Remote new' }),
    });
    const body = await res.json() as any;

    assert.equal(res.status, 201);
    assert.deepEqual(calls, [{ method: 'sessions.create', params: { agentId: 'remote-pm', label: 'Remote new' } }]);
    assert.equal(body.key, 'agent:remote-pm:dashboard:new-session');
    assert.equal(fixture.store.getSession('agent:remote-pm:dashboard:new-session')?.title, 'Remote new');
    assert.equal(JSON.stringify(body).includes(createToken), false);
  } finally {
    await fixture.cleanup();
  }
});

test('connector session create falls back to an isolated display key when Gateway lacks operator.write', async () => {
  const fixture = createConnectorFixture();
  fixture.gateway.request = async () => { throw new GatewayRpcError('sessions.create', 'INVALID_REQUEST', 'missing scope: operator.write'); };
  try {
    const createToken = fixture.tokens.create({ label: 'creator', scopes: ['sessions:create'] }).token;
    const res = await fixture.app.request('/api/connector/v1/agents/remote-pm/sessions', {
      method: 'POST',
      headers: { authorization: `Bearer ${createToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'Remote fallback' }),
    });
    const body = await res.json() as any;

    assert.equal(res.status, 201);
    assert.match(body.key, /^agent:remote-pm:dashboard:agentopsdeck-web-/);
    assert.notEqual(body.key, 'agent:remote-pm:main');
    assert.equal(body.cliSessionKey, body.key);
    assert.equal(body.fallback, 'openclaw-cli');
    assert.equal(fixture.store.getSession(body.key)?.title, 'Remote fallback');
    assert.equal(JSON.parse(readFileSync(fixture.config.sessionTitlesFile, 'utf8'))[body.key], 'Remote fallback');
    fixture.store.replaceSessions([]);
    assert.equal(fixture.store.getSession(body.key)?.title, 'Remote fallback');
    assert.equal(JSON.stringify(body).includes(createToken), false);
  } finally {
    await fixture.cleanup();
  }
});

for (const failure of [new Error('Gateway WS request timed out: sessions.create'), new Error('missing scope: operator.write'),
  new GatewayRpcError('agent', 'INVALID_REQUEST', 'missing scope: operator.write')])
test(`connector session create does not fabricate a second session for ${failure.name}: ${failure.message}`, async () => {
  const fixture = createConnectorFixture();
  fixture.gateway.request = async () => { throw failure; };
  try {
    const createToken = fixture.tokens.create({ label: 'creator', scopes: ['sessions:create'] }).token;
    const res = await fixture.app.request('/api/connector/v1/agents/remote-pm/sessions', {
      method: 'POST',
      headers: { authorization: `Bearer ${createToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'Remote timeout fallback' }),
    });
    const body = await res.json() as any;

    assert.equal(res.status, 202);
    assert.equal(body.command.state, 'outcome_unknown');
    assert.equal(body.key, undefined);
    assert.equal(body.fallback, undefined);
    assert.equal(JSON.stringify(body).includes(createToken), false);
  } finally {
    await fixture.cleanup();
  }
});


test('connector session model reset sends null Gateway params without invalid fields', async () => {
  const fixture = createConnectorFixture();
  try {
    const sessionKey = 'agent:connector-dev:dashboard:model-reset';
    fixture.store.upsertSession({ sessionKey, agentId: 'connector-dev', title: 'Model reset', status: 'idle', model: 'old-model', modelProvider: 'old-provider' });
    const token = fixture.tokens.create({ label: 'session writer', scopes: ['sessions:create'] }).token;
    const gatewayRequests: Array<{ method: string; params: any }> = [];
    fixture.gateway.request = async (method: string, params: any) => {
      gatewayRequests.push({ method, params });
      return { ok: true, key: sessionKey, resolved: {} };
    };

    const response = await fixture.app.request(`/api/connector/v1/sessions/${encodeURIComponent(sessionKey)}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: null, thinking: null }),
    });

    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.equal(body.sessionKey, sessionKey);
    assert.equal(body.model, undefined);
    assert.equal(body.modelProvider, undefined);
    assert.deepEqual(gatewayRequests, [{ method: 'sessions.patch', params: { key: sessionKey, model: null, agentId: 'connector-dev', thinkingLevel: null } }]);
    const patch = gatewayRequests[0];
    assert.ok(patch);
    assert.equal('sessionKey' in patch.params, false);
    assert.equal('overrides' in patch.params, false);
  } finally {
    await fixture.cleanup();
  }
});


test('connector message send uses agent RPC without chat.send backend Sender metadata and preserves user text', async () => {
  const fixture = createConnectorFixture();
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  fixture.gateway.request = async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
    return { runId: 'fake-run-id', status: 'accepted', acceptedAt: Date.now() };
  };

  try {
    const sendToken = fixture.tokens.create({ label: 'sender', scopes: ['messages:send'] }).token;
    const message = 'Keep api_key=fake-key-123 password=fake-password-456 and token=fake-token-789 exactly.';
    const sessionKey = 'agent:remote-pm:dashboard:fake-preservation';
    fixture.store.upsertSession({ sessionKey, agentId: 'remote-pm', title: 'Fake session', status: 'idle' });
    const res = await fixture.app.request(`/api/connector/v1/sessions/${encodeURIComponent(sessionKey)}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${sendToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message, idempotencyKey: 'fake-idempotency-key' }),
    });
    const body = await res.json() as any;

    assert.equal(res.status, 200);
    assert.equal(body.status, 'queued');
    assert.notEqual(body.idempotencyKey, 'fake-idempotency-key', 'runtime identity is not the token-scoped receipt key');
    assert.deepEqual(calls, [], 'HTTP admission cannot dispatch');
    await (fixture.queue as any).reconcile(sessionKey);
    assert.deepEqual(calls, [{
      method: 'agent',
      params: {
        sessionKey,
        message,
        deliver: false,
        idempotencyKey: body.idempotencyKey,
        attachments: [],
      },
    }]);
    assert.equal(JSON.stringify(body).includes(sendToken), false);
  } finally {
    await fixture.cleanup();
  }
});

test('concurrent idle messages share a FIFO and duplicate receipts do not add work', async () => {
  const fixture = createConnectorFixture();
  const sessionKey = 'agent:test:dashboard:concurrent';
  fixture.store.upsertSession({ sessionKey, agentId: 'test', title: 'Concurrent test', status: 'idle' });
  const calls: any[] = [];
  fixture.gateway.request = async (method, params) => { calls.push({ method, params }); return {}; };
  const token = fixture.tokens.create({ label: 'sender', scopes: ['messages:send', 'messages:read'] }).token;
  const send = (key: string, message = key) => fixture.app.request(`/api/connector/v1/sessions/${encodeURIComponent(sessionKey)}/messages`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify({ message }),
  });
  try {
    const responses = await Promise.all([send('first'), send('second'), send('first')]);
    assert.ok(responses.every((response) => [200, 202].includes(response.status)));
    assert.equal(calls.length, 0);
    const queued = fixture.store.getMessages(sessionKey);
    assert.equal(queued.length, 2);
    assert.equal(new Set(queued.map((message) => message.id)).size, 2);
    const repeat = await (await send('first')).json() as any;
    assert.equal(repeat.idempotencyKey, queued.find((message) => message.text === 'first')?.id);
    assert.equal((await send('first', 'different content')).status, 409);
    await (fixture.queue as any).reconcile(sessionKey);
    await (fixture.queue as any).reconcile(sessionKey);
    assert.equal(calls.length, 1, 'ACK of the first run cannot authorize another idle dispatch');
    const stop = await send('control-stop', '/stop');
    assert.equal(stop.status, 409, 'unbound stop cannot interrupt whatever runs next');
    assert.equal(calls.length, 1);
    assert.equal(fixture.store.getMessages(sessionKey).filter((message) => message.status === 'queued').length, 1);
  } finally { await fixture.cleanup(); }
});

test('connector message timeout never invokes a second CLI execution', async () => {
  const fixture = createConnectorFixture();
  let calls = 0;
  fixture.gateway.request = async () => { calls++; throw new Error('Gateway WS request timed out: agent'); };
  try {
    const token = fixture.tokens.create({ label: 'sender', scopes: ['messages:send'] }).token;
    const sessionKey = 'agent:test:dashboard:timeout';
    fixture.store.upsertSession({ sessionKey, agentId: 'test', title: 'Timeout test', status: 'idle' });
    const response = await fixture.app.request(`/api/connector/v1/sessions/${encodeURIComponent(sessionKey)}/messages`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Do not resubmit after a lost acknowledgement' }),
    });
    assert.equal(response.status, 200);
    const receipt = await response.json() as any;
    assert.equal(receipt.command.state, 'accepted', 'durable queue acceptance is distinct from runtime ACK');
    assert.equal(receipt.fallback, undefined);
    await (fixture.queue as any).reconcile(sessionKey);
    await (fixture.queue as any).reconcile(sessionKey);
    assert.equal(fixture.store.getMessages(sessionKey).find((message) => message.id === receipt.idempotencyKey)?.status, 'outcome_unknown');
    assert.equal(calls, 1);
  } finally { await fixture.cleanup(); }
});

test('connector message send fallback keeps display session key after definitive scope rejection', async () => {
  const fixture = createConnectorFixture();
  const previousPath = process.env.PATH;
  const previousArgsFile = process.env.AOD_TEST_OPENCLAW_ARGS_FILE;
  const previousLocalCli = process.env.AOD_LOCAL_OPENCLAW_CLI;
  const previousCliHome = process.env.AOD_OPENCLAW_HOME;
  const previousCliPath = process.env.AOD_OPENCLAW_CLI_PATH;
  const binDir = join(fixture.dir, 'bin');
  const cliHome = join(fixture.dir, 'openclaw-home');
  const argsFile = join(fixture.dir, 'openclaw-args.txt');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(cliHome, { mode: 0o700 });
  const openclawBin = join(binDir, 'openclaw');
  writeFileSync(openclawBin, `#!/bin/sh\nprintf "%s\\n" "$@" > ${JSON.stringify(argsFile)}\nprintf '{"result":{"meta":{"finalAssistantVisibleText":"assistant ok"}}}\\n'\n`);
  chmodSync(openclawBin, 0o755);
  process.env.PATH = `${binDir}:${previousPath ?? ''}`;
  process.env.AOD_TEST_OPENCLAW_ARGS_FILE = argsFile;
  process.env.AOD_LOCAL_OPENCLAW_CLI = 'true';
  process.env.AOD_OPENCLAW_HOME = cliHome;
  process.env.AOD_OPENCLAW_CLI_PATH = openclawBin;

  fixture.gateway.request = async () => { throw new GatewayRpcError('agent', 'INVALID_REQUEST', 'missing scope: operator.write'); };
  fixture.store.upsertSession({
    sessionKey: 'agent:remote-pm:dashboard:deadbeef',
    agentId: 'remote-pm',
    title: 'Remote dashboard',
    recent: '',
    status: 'idle',
    source: 'web',
    lastActiveAt: Date.now(),
  });

  try {
    const sendToken = fixture.tokens.create({ label: 'sender', scopes: ['messages:send'] }).token;
    const res = await fixture.app.request('/api/connector/v1/sessions/agent%3Aremote-pm%3Adashboard%3Adeadbeef/messages', {
      method: 'POST',
      headers: { authorization: `Bearer ${sendToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello remote' }),
    });
    const body = await res.json() as any;

    assert.equal(res.status, 200);
    assert.equal(body.status, 'queued');
    await (fixture.queue as any).reconcile('agent:remote-pm:dashboard:deadbeef');
    assert.ok(fixture.store.getMessages('agent:remote-pm:dashboard:deadbeef').some((message) => message.text === 'hello remote'));
    assert.equal(JSON.stringify(body).includes(sendToken), false);

    await waitForFile(argsFile);
    assert.deepEqual(readFileSync(argsFile, 'utf8').trim().split('\n'), [
      'agent',
      '--agent',
      'remote-pm',
      '--session-id',
      'main',
      '--message',
      'hello remote',
      '--json',
    ]);
    await waitForMessage(fixture.store, 'agent:remote-pm:dashboard:deadbeef', 'assistant ok');
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousArgsFile === undefined) delete process.env.AOD_TEST_OPENCLAW_ARGS_FILE;
    else process.env.AOD_TEST_OPENCLAW_ARGS_FILE = previousArgsFile;
    if (previousLocalCli === undefined) delete process.env.AOD_LOCAL_OPENCLAW_CLI;
    else process.env.AOD_LOCAL_OPENCLAW_CLI = previousLocalCli;
    if (previousCliHome === undefined) delete process.env.AOD_OPENCLAW_HOME;
    else process.env.AOD_OPENCLAW_HOME = previousCliHome;
    if (previousCliPath === undefined) delete process.env.AOD_OPENCLAW_CLI_PATH;
    else process.env.AOD_OPENCLAW_CLI_PATH = previousCliPath;
    await fixture.cleanup();
  }
});


test('connector message send fallback keeps synthetic web sessions isolated from CLI main', async () => {
  const fixture = createConnectorFixture();
  const previousPath = process.env.PATH;
  const previousArgsFile = process.env.AOD_TEST_OPENCLAW_ARGS_FILE;
  const previousLocalCli = process.env.AOD_LOCAL_OPENCLAW_CLI;
  const previousCliHome = process.env.AOD_OPENCLAW_HOME;
  const previousCliPath = process.env.AOD_OPENCLAW_CLI_PATH;
  const binDir = join(fixture.dir, 'bin');
  const cliHome = join(fixture.dir, 'openclaw-synthetic-home');
  const argsFile = join(fixture.dir, 'openclaw-synthetic-args.txt');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(cliHome, { mode: 0o700 });
  const openclawBin = join(binDir, 'openclaw');
  writeFileSync(openclawBin, `#!/bin/sh\nprintf "%s\\n" "$@" > ${JSON.stringify(argsFile)}\nprintf '{"result":{"meta":{"finalAssistantVisibleText":"synthetic ok"}}}\\n'\n`);
  chmodSync(openclawBin, 0o755);
  process.env.PATH = `${binDir}:${previousPath ?? ''}`;
  process.env.AOD_TEST_OPENCLAW_ARGS_FILE = argsFile;
  process.env.AOD_LOCAL_OPENCLAW_CLI = 'true';
  process.env.AOD_OPENCLAW_HOME = cliHome;
  process.env.AOD_OPENCLAW_CLI_PATH = openclawBin;

  fixture.gateway.request = async () => { throw new GatewayRpcError('agent', 'INVALID_REQUEST', 'missing scope: operator.write'); };
  fixture.store.upsertSession({
    sessionKey: 'agent:remote-pm:dashboard:agentopsdeck-web-abc123',
    agentId: 'remote-pm',
    title: 'Synthetic web',
    recent: '',
    status: 'idle',
    source: 'web',
    lastActiveAt: Date.now(),
  });

  try {
    const sendToken = fixture.tokens.create({ label: 'sender', scopes: ['messages:send'] }).token;
    const res = await fixture.app.request('/api/connector/v1/sessions/agent%3Aremote-pm%3Adashboard%3Aagentopsdeck-web-abc123/messages', {
      method: 'POST',
      headers: { authorization: `Bearer ${sendToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello synthetic' }),
    });
    const body = await res.json() as any;

    assert.equal(res.status, 200);
    assert.equal(body.status, 'queued');
    await (fixture.queue as any).reconcile('agent:remote-pm:dashboard:agentopsdeck-web-abc123');
    await waitForFile(argsFile);
    assert.deepEqual(readFileSync(argsFile, 'utf8').trim().split('\n'), [
      'agent',
      '--agent',
      'remote-pm',
      '--session-id',
      'agentopsdeck-web-abc123',
      '--message',
      'hello synthetic',
      '--json',
    ]);
    await waitForMessage(fixture.store, 'agent:remote-pm:dashboard:agentopsdeck-web-abc123', 'synthetic ok');
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousArgsFile === undefined) delete process.env.AOD_TEST_OPENCLAW_ARGS_FILE;
    else process.env.AOD_TEST_OPENCLAW_ARGS_FILE = previousArgsFile;
    if (previousLocalCli === undefined) delete process.env.AOD_LOCAL_OPENCLAW_CLI;
    else process.env.AOD_LOCAL_OPENCLAW_CLI = previousLocalCli;
    if (previousCliHome === undefined) delete process.env.AOD_OPENCLAW_HOME;
    else process.env.AOD_OPENCLAW_HOME = previousCliHome;
    if (previousCliPath === undefined) delete process.env.AOD_OPENCLAW_CLI_PATH;
    else process.env.AOD_OPENCLAW_CLI_PATH = previousCliPath;
    await fixture.cleanup();
  }
});


test('connector media endpoint rejects unsafe names and does not serve missing files', async () => {
  const fixture = createConnectorFixture();
  try {
    const token = fixture.tokens.create({ label: 'media reader', scopes: ['media:read'] }).token;
    const traversal = await fixture.app.request('/api/connector/v1/media/inbound/%2E%2E%2Fsecret.txt', {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(traversal.status, 400);
    assert.equal((await traversal.json() as any).error, 'invalid media name');

    const missing = await fixture.app.request('/api/connector/v1/media/inbound/missing.txt', {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json() as any).error, 'media not found');
  } finally {
    await fixture.cleanup();
  }
});

async function waitForFile(path: string) {
  for (let i = 0; i < 20; i += 1) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`expected file to exist: ${path}`);
}

async function waitForMessage(store: DeckStore, sessionKey: string, text: string) {
  for (let i = 0; i < 20; i += 1) {
    if (store.getMessages(sessionKey).some((message) => message.text === text)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`expected message in ${sessionKey}: ${text}`);
}

for (const transport of ['local', 'http'] as const) {
  test(`${transport}: Connector owns Codex create, rename, runtime patch and delete with scoped auth`, async () => {
    const calls: string[] = [];
    const sessionKey = 'codex/session:with/slash..and 空格';
    const fixture = createConnectorFixture({
      owns: (key: string) => key === sessionKey,
      createSession: async ({ title }: { title: string }) => {
        calls.push('create');
        fixture.store.upsertSession({ sessionKey, agentId: 'codex', title, status: 'idle', source: 'web', lastActiveAt: 1 });
        return { key: sessionKey };
      },
      updateSessionRuntime: (_key: string, patch: { model: string }, ack: (session: any) => void) => {
        calls.push('patch'); const session = { ...fixture.store.getSession(sessionKey), ...patch }; ack(session); return session;
      },
      remove: async () => { calls.push('delete'); fixture.store.removeSession(sessionKey); },
    });
    fixture.gateway.request = async () => { throw new Error('Codex must not use Gateway'); };
    const server = transport === 'http' ? serve({ fetch: fixture.app.fetch, hostname: '127.0.0.1', port: 0 }) : undefined;
    if (server && !server.listening) await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server?.address();
    const origin = address && typeof address !== 'string' ? `http://127.0.0.1:${address.port}` : 'http://connector.example.invalid';
    const dispatch = transport === 'local' ? (request: Request) => fixture.app.fetch(request) : (request: Request) => fetch(request);
    try {
      const token = fixture.tokens.createTransient(['sessions:create']);
      const client = new ConnectorClient(origin, token.token, dispatch);
      const rpc = (method: string, body?: unknown): RequestInit => ({ method, ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
      const created = await client.jsonResponse<{ key: string }>('/agents/codex/sessions', rpc('POST', { title: 'Persistent title' }));
      assert.equal(created.status, 201); assert.equal(created.body.key, sessionKey);
      const route = `/sessions/${encodeURIComponent(sessionKey)}`;
      assert.equal((await client.json<any>(route, rpc('PATCH', { title: 'Renamed' }))).settings.title, 'Renamed');
      assert.equal((await client.json<any>(route, rpc('PATCH', { model: 'gpt-6-astra', thinking: null }))).settings.model, 'gpt-6-astra');
      assert.equal((await client.json<any>(route, rpc('PATCH', { model: 'provider/custom-model' }))).settings.model, 'provider/custom-model');
      await assert.rejects(client.json(route, rpc('PATCH', { model: ' ' })), { status: 400 });
      const reader = fixture.tokens.createTransient(['sessions:read']);
      await assert.rejects(new ConnectorClient(origin, reader.token, dispatch).json(route, rpc('DELETE')), { status: 403 });
      assert.deepEqual(calls, ['create', 'patch', 'patch']);
      await client.json(route, rpc('DELETE'));
      assert.deepEqual(calls, ['create', 'patch', 'patch', 'delete']);
    } finally {
      if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await fixture.cleanup();
    }
  });
}

for (const transport of ['local', 'http'] as const) {
  for (const failure of ['cleanup', 'successor'] as const) test(`${transport}: acknowledged Codex stop survives later ${failure} without redispatch`, async () => {
    let calls = 0;
    const fixture = createConnectorFixture({
      interrupt: async (_key: string, _expected: string, _actor: string, _grant: unknown, acknowledge?: () => void) => {
        calls++;
        acknowledge?.(); // Native ACK, not terminal completion or cleanup proof.
        if (failure === 'successor') throw new RunControlConflict();
        throw new Error('Synthetic post-ACK cleanup pending');
      },
    });
    const token = fixture.tokens.create({ label: 'synthetic controller', scopes: ['messages:send', 'messages:read'] });
    const server = transport === 'http' ? serve({ fetch: fixture.app.fetch, hostname: '127.0.0.1', port: 0 }) : undefined;
    if (server && !server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server?.address();
    const origin = address && typeof address !== 'string' ? `http://127.0.0.1:${address.port}` : 'http://connector.example.invalid';
    const client = new ConnectorClient(origin, token.token, transport === 'local' ? request => fixture.app.fetch(request) : fetch);
    const route = '/sessions/codex%3Asynthetic';
    const send = (expectedRunId = 'turn-1') => client.json<any>(`${route}/messages`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: '/stop', expectedRunId, idempotencyKey: 'ack-stop' }) });
    try {
      const ack = await send();
      assert.equal(ack.command.state, 'accepted');
      assert.equal(ack.status, 'interrupt_requested');
      assert.equal(ack.runId, 'turn-1');
      assert.deepEqual(await send(), ack);
      const recovered = await client.json<any>(`${route}/commands/ack-stop`);
      assert.equal(recovered.command.state, 'accepted');
      assert.equal(recovered.command.result.body.status, 'interrupt_requested');
      assert.equal(recovered.command.result.body.runId, 'turn-1');
      await assert.rejects(send('turn-2'), { status: 409 });
      assert.equal(calls, 1, 'ACK receipt recovery cannot repeat or retarget the original native effect');
    } finally {
      if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await fixture.cleanup();
    }
  });

  test(`${transport}: OpenClaw stop maps observed commands to bound native runs without redispatch`, async () => {
    const f = createConnectorFixture();
    const server = transport === 'http' ? serve({ fetch: f.app.fetch, hostname: '127.0.0.1', port: 0 }) : undefined;
    if (server && !server.listening) await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server?.address();
    const origin = address && typeof address !== 'string' ? `http://127.0.0.1:${address.port}` : 'http://connector.example.invalid';
    const token = f.tokens.create({ label: 'synthetic control', scopes: ['messages:send', 'messages:read'] });
    const client = new ConnectorClient(origin, token.token, transport === 'local' ? (request) => f.app.fetch(request) : fetch);
    const sessionKey = 'agent:test:dashboard:bound-stop';
    f.store.upsertSession({ sessionKey, agentId: 'test', title: 'Synthetic bound stop', status: 'running' });
    const route = `/sessions/${encodeURIComponent(sessionKey)}`;
    const runs = f.connectorUsers.openClawExecutions;
    const calls: any[] = [];
    let connection: string | undefined = 'synthetic-connection', loseReply = false;
    f.gateway.connectionId = () => connection;
    f.gateway.request = async () => { throw new Error('Stop must not invoke agent or use unbound RPC'); };
    f.gateway.requestBound = async (method, params, expected) => {
      calls.push({ method, params, expected });
      if (loseReply) throw new Error('Synthetic lost abort ACK');
      return { connectionId: connection, payload: { ok: true, aborted: true, runIds: [params.runId] } };
    };
    const send = (idempotencyKey: string, expectedRunId?: string, media: unknown[] = []) => client.json<any>(`${route}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '/stop', idempotencyKey, expectedRunId, media }),
    });
    const begin = (command: string, runId: string) => {
      runs.begin(sessionKey, command);
      runs.bindGatewayConnection(sessionKey, command, 'synthetic-connection');
      runs.acknowledge(sessionKey, command, runId);
      runs.observe(sessionKey, { runId, phase: 'running', gatewayConnectionId: 'synthetic-connection' });
    };
    try {
      begin('command-one', 'native-one');
      await assert.rejects(send('missing'), { status: 409 });
      await assert.rejects(send('raw-native', 'native-one'), { status: 409 });
      await assert.rejects(send('media', 'command-one', [{ dataUrl: 'data:image/png;base64,YQ==', mimeType: 'image/png' }]), { status: 400 });
      assert.equal(calls.length, 0);
      const ack = await send('first', 'command-one');
      assert.equal(ack.status, 'interrupt_requested');
      assert.equal(ack.runId, 'command-one', 'response keeps the public execution identity');
      assert.equal(ack.command.state, 'accepted');
      assert.deepEqual(calls, [{ method: 'chat.abort', params: { sessionKey, runId: 'native-one' }, expected: 'synthetic-connection' }]);
      assert.equal(runs.get(sessionKey)?.phase, 'running', 'abort ACK is not execution completion');
      runs.observe(sessionKey, { runId: 'native-one', phase: 'completed', gatewayConnectionId: 'synthetic-connection' });
      await assert.rejects(send('terminal', 'command-one'), { status: 409 });
      begin('command-two', 'native-two');
      assert.deepEqual(await send('first', 'command-one'), ack);
      await assert.rejects(send('first', 'command-two'), { status: 409 });
      await assert.rejects(send('stale', 'command-one'), { status: 409 });
      connection = undefined;
      await assert.rejects(send('offline', 'command-two'), { status: 409 });
      connection = 'replacement';
      await assert.rejects(send('reconnected', 'command-two'), { status: 409 });
      assert.equal(calls.length, 1);
      connection = 'synthetic-connection'; loseReply = true;
      const unknown = await send('lost', 'command-two');
      assert.equal(unknown.command.state, 'outcome_unknown');
      await send('lost', 'command-two');
      const recovered = await client.json<any>(`${route}/commands/lost`);
      assert.equal(recovered.command.state, 'outcome_unknown');
      assert.equal(calls.length, 2, 'unknown POST and GET never repeat abort');
      assert.equal(runs.get(sessionKey)?.phase, 'running');
      f.tokens.revoke(token.record.id);
      await assert.rejects(send('revoked', 'command-two'), { status: 403 });
      assert.equal(calls.length, 2);
    } finally {
      if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await f.cleanup();
    }
  });

  test(`${transport}: run-bound stop receipts never retarget or redispatch unknown controls`, async () => {
    let calls = 0, current = 'turn-1', loseReply = false;
    const fixture = createConnectorFixture({
      interrupt: async (key: string, expected: string, actor: string) => {
        assert.equal(key, 'codex:synthetic');
        assert.equal(actor, token.record.id);
        if (expected !== current) throw new RunControlConflict();
        calls++;
        if (loseReply) throw new Error('Synthetic acknowledgement lost');
      },
    });
    const token = fixture.tokens.create({ label: 'synthetic controller', scopes: ['messages:send', 'messages:read'] });
    const server = transport === 'http' ? serve({ fetch: fixture.app.fetch, hostname: '127.0.0.1', port: 0 }) : undefined;
    if (server && !server.listening) await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server?.address();
    const origin = address && typeof address !== 'string' ? `http://127.0.0.1:${address.port}` : 'http://connector.example.invalid';
    const dispatch = transport === 'local' ? (request: Request) => fixture.app.fetch(request) : (request: Request) => fetch(request);
    const client = new ConnectorClient(origin, token.token, dispatch);
    const route = '/sessions/codex%3Asynthetic';
    const send = (key: string, expectedRunId?: string) => client.json<any>(`${route}/messages`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: '/stop', idempotencyKey: key, expectedRunId }) });
    try {
      await assert.rejects(send('missing'), { status: 409 });
      assert.equal(calls, 0);
      const ack = await send('stop-1', 'turn-1');
      assert.equal(ack.status, 'interrupt_requested');
      assert.equal(ack.command.state, 'accepted');
      assert.equal(ack.runId, 'turn-1');
      current = 'turn-2';
      assert.deepEqual(await send('stop-1', 'turn-1'), ack, 'same receipt survives subsequent turns');
      await assert.rejects(send('stop-1', 'turn-2'), { status: 409 });
      await assert.rejects(send('late-stop', 'turn-1'), { status: 409 });
      assert.equal(calls, 1);
      loseReply = true;
      const unknown = await send('lost-stop', 'turn-2');
      assert.equal(unknown.command.state, 'outcome_unknown');
      await send('lost-stop', 'turn-2');
      const recovered = await client.json<any>(`${route}/commands/lost-stop`);
      assert.equal(recovered.command.state, 'outcome_unknown');
      assert.equal(calls, 2, 'neither POST retry nor GET recovery repeats uncertain interrupt');
    } finally {
      if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await fixture.cleanup();
    }
  });

  test(`${transport}: durable projection stream catches up across pages, reconnects, resets and revokes`, { timeout: 15_000 }, async () => {
    const fixture = createConnectorFixture(undefined, true);
    const server = transport === 'http' ? serve({ fetch: fixture.app.fetch, hostname: '127.0.0.1', port: 0 }) : undefined;
    if (server && !server.listening) await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server?.address();
    const origin = address && typeof address !== 'string' ? `http://127.0.0.1:${address.port}` : 'http://connector.example.invalid';
    const dispatch = transport === 'local' ? (request: Request) => fixture.app.fetch(request) : (request: Request) => fetch(request);
    const controller = new AbortController();
    const token = fixture.tokens.create({ label: 'synthetic stream', scopes: ['sessions:read', 'messages:read', 'events:read'] });
    const client = new ConnectorClient(origin, token.token, dispatch);
    const key = 'codex:journal';
    const nextData = async (iterator: ReturnType<ConnectorClient['events']>) => {
      for (;;) { const frame = await iterator.next(); if (frame.done || frame.value.event !== 'heartbeat') return frame; }
    };
    try {
      fixture.store.upsertSession({ sessionKey: key, agentId: 'codex', source: 'codex', title: 'Synthetic', status: 'running', lastActiveAt: 1 });
      const snapshot = await client.sessions();
      assert.match(snapshot.sourceCursor!, /^ce1_/);
      const expected: string[] = [];
      // Four pages must drain without a two-second sleep per page.
      for (let i = 0; i < 193; i++) {
        fixture.store.addMessage({ id: `m${i}`, sessionKey: key, role: 'assistant', text: `Synthetic ${i}`, createdAt: i + 2 });
        expected.push(fixture.store.latestEventId()!);
      }
      const replay = client.events(AbortSignal.any([controller.signal, AbortSignal.timeout(3_000)]), snapshot.sourceCursor);
      const received: string[] = [];
      try {
        for (let i = 0; i < expected.length; i++) {
          const frame = await nextData(replay);
          assert.equal(frame.done, false);
          received.push(frame.value!.id!);
          assert.equal(JSON.parse(frame.value!.data).payload.invalidation, true);
        }
      } finally { await replay.return(undefined); }
      assert.deepEqual(received, expected);
      const page = await client.messages(key);
      assert.equal(page.sourceCursor, expected.at(-1));
      assert.equal(page.messages.at(-1)?.text, 'Synthetic 192');
      fixture.store.addMessage({ id: 'final', sessionKey: key, role: 'assistant', text: 'Final', createdAt: 999 });
      const tail = client.events(controller.signal, received.at(-1));
      const final = await nextData(tail);
      assert.equal(JSON.parse(final.value!.data).payload.id, 'final', 'reconnect does not duplicate delivered messages');
      const finalCursor = final.value!.id!;
      await tail.return(undefined);

      fixture.connectorUsers.events.beginEpoch();
      const reset = client.events(controller.signal, finalCursor);
      const frame = await nextData(reset);
      assert.equal(frame.value!.event, 'stream.reset');
      assert.equal(JSON.parse(frame.value!.data).payload.reason, 'cursor_expired');
      assert.equal(frame.value!.id, fixture.store.latestEventId());
      await reset.return(undefined);

      const active = client.events(AbortSignal.any([controller.signal, AbortSignal.timeout(1_500)]), fixture.store.latestEventId());
      assert.equal((await active.next()).value!.event, 'heartbeat');
      await waitForCondition(() => fixture.store.changes.waiting === 1);
      fixture.store.append('session.updated', { title: 'Immediate live event' }, { sessionKey: key });
      assert.equal(JSON.parse((await nextData(active)).value!.data).payload.title, 'Immediate live event');
      await waitForCondition(() => fixture.store.changes.waiting === 1);
      fixture.tokens.revoke(token.record.id);
      assert.equal((await nextData(active)).done, true, 'idle revocation closes without waiting for another event or heartbeat');
      assert.equal(fixture.store.changes.waiting + fixture.tokens.changes.waiting, 0);
      await assert.rejects(client.sessions(), { status: 403 });
    } finally {
      controller.abort();
      if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await fixture.cleanup();
    }
  });
}

for (const transport of ['local', 'http'] as const) test(`${transport}: resumed SSE recovers an optional journal outage before any snapshot read`, { timeout: 10_000 }, async () => {
  const f = createConnectorFixture(undefined, true);
  const db = (f.connectorUsers as unknown as { db: DatabaseSync }).db;
  const server = transport === 'http' ? serve({ fetch: f.app.fetch, hostname: '127.0.0.1', port: 0 }) : undefined;
  if (server && !server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server?.address();
  const origin = address && typeof address !== 'string' ? `http://127.0.0.1:${address.port}` : 'http://connector.example.invalid';
  const token = f.tokens.create({ label: 'synthetic recovery', scopes: ['sessions:read', 'messages:read', 'events:read'] });
  const client = new ConnectorClient(origin, token.token, transport === 'local' ? request => f.app.fetch(request) : request => fetch(request));
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]);
  const streams: ReturnType<ConnectorClient['events']>[] = [];
  const nextData = async (iterator: ReturnType<ConnectorClient['events']>) => {
    for (;;) { const frame = await iterator.next(); if (frame.done || frame.value.event !== 'heartbeat') return frame; }
  };
  let nativeCalls = 0;
  f.gateway.request = async () => { nativeCalls++; throw new Error('Recovery must not execute native work'); };
  const session = { sessionKey: 'codex:recovery', agentId: 'codex', source: 'codex' as const,
    title: 'Before', status: 'running' as const, hasActiveRun: true, lastActiveAt: 1 };
  try {
    f.store.upsertSession(session);
    const before = (await client.sessions()).sourceCursor!;
    db.exec("CREATE TRIGGER reject_projection BEFORE INSERT ON connector_events BEGIN SELECT RAISE(ABORT, 'synthetic'); END");
    f.store.upsertSession({ ...session, title: 'During outage' });
    f.store.addMessage({ id: 'latest', sessionKey: session.sessionKey, role: 'assistant', text: 'Current reply', createdAt: 2 });
    await assert.rejects(client.sessions(), { status: 503 });
    const unavailable = client.events(signal, before); streams.push(unavailable);
    assert.equal((await nextData(unavailable)).done, true, 'failed journal must not serve a stale cursor as current');
    db.exec('DROP TRIGGER reject_projection');

    // Resume first: hasEvent, not a preceding snapshot request, must heal the gap.
    const resumed = client.events(signal, before); streams.push(resumed);
    const reset = (await nextData(resumed)).value!;
    assert.equal(reset.event, 'stream.reset');
    assert.notEqual(reset.id, before);
    assert.match(reset.id!, /^ce1_.*:0$/);
    const snapshot = await client.sessions();
    const page = await client.messages(session.sessionKey);
    assert.equal(snapshot.sourceCursor, reset.id);
    assert.equal(page.sourceCursor, reset.id);
    assert.equal(snapshot.groups.flatMap(group => group.sessions).find(value => value.sessionKey === session.sessionKey)?.title, 'During outage');
    assert.equal(f.store.getSession(session.sessionKey)?.status, 'running');
    assert.equal(page.messages.at(-1)?.text, 'Current reply');
    f.store.addMessage({ id: 'next', sessionKey: session.sessionKey, role: 'assistant', text: 'After recovery', createdAt: 3 });
    const next = (await nextData(resumed)).value!;
    assert.equal(next.id, reset.id!.replace(/:0$/, ':1'));
    assert.equal(JSON.parse(next.data).payload.id, 'next');
    await waitForCondition(() => f.store.changes.waiting === 1);
    f.tokens.revoke(token.record.id);
    assert.equal((await nextData(resumed)).done, true, 'recovery preserves revocation and leaves no duplicate event');
    assert.equal(nativeCalls, 0);
    assert.equal(f.store.changes.waiting + f.tokens.changes.waiting, 0);
  } finally {
    controller.abort();
    for (const stream of streams) await stream.return(undefined);
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await f.cleanup();
  }
});

async function waitForCondition(condition: () => boolean) {
  const deadline = Date.now() + 1_000;
  while (!condition() && Date.now() < deadline) await new Promise<void>(resolve => setImmediate(resolve));
  assert.ok(condition(), 'stream reaches expected wait/cleanup state');
}

test('Connector event admission is bounded and cancelled/disposed connections release all waits', { timeout: 10_000 }, async () => {
  const fixture = createConnectorFixture(undefined, true);
  const transient = fixture.tokens.createTransient(['events:read']);
  const streams: Array<{ controller: AbortController; reader: ReadableStreamDefaultReader<Uint8Array> }> = [];
  const open = async () => {
    const controller = new AbortController();
    const response = await fixture.app.request('/api/connector/v1/events/stream', {
      signal: controller.signal, headers: { authorization: `Bearer ${transient.token}` },
    });
    return { controller, response };
  };
  try {
    for (let i = 0; i < 128; i++) {
      const { controller, response } = await open();
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('x-accel-buffering'), 'no');
      const reader = response.body!.getReader();
      streams.push({ controller, reader });
      await reader.read();
    }
    await waitForCondition(() => fixture.store.changes.waiting === 128);
    const rejected = await open();
    assert.equal(rejected.response.status, 503);
    await rejected.response.text();
    streams[0]!.controller.abort();
    await waitForCondition(() => fixture.store.changes.waiting === 127);
    // Abort removes waits synchronously; the stream finally releases admission
    // on the ensuing microtask, after its loop has actually stopped.
    await new Promise<void>(resolve => setImmediate(resolve));
    const replacement = await open();
    assert.equal(replacement.response.status, 200);
    const reader = replacement.response.body!.getReader();
    streams.push({ controller: replacement.controller, reader });
    await reader.read();
    await waitForCondition(() => fixture.store.changes.waiting === 128);
    transient.dispose();
    await waitForCondition(() => fixture.store.changes.waiting + fixture.tokens.changes.waiting === 0);
    for (const stream of streams.slice(1)) assert.equal((await stream.reader.read()).done, true);
  } finally {
    for (const stream of streams) { stream.controller.abort(); await stream.reader.cancel(); }
    await fixture.cleanup();
  }
});

for (const backpressured of [false, true]) {
test(`Connector shutdown cancels ${backpressured ? 'backpressured' : 'idle'} persistent-token streams before storage closes`, { timeout: 5_000 }, async () => {
  const f = createConnectorFixture(undefined, true);
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  try {
    const token = f.tokens.create({ label: 'persistent events', scopes: ['events:read'] }).token;
    const open = () => f.app.request('/api/connector/v1/events/stream', { headers: { authorization: `Bearer ${token}` } });
    const idle = (await open()).body!.getReader(); readers.push(idle);
    await idle.read();
    await waitForCondition(() => f.store.changes.waiting === 1);
    const slow = (await open()).body!.getReader(); readers.push(slow);
    await waitForCondition(() => f.store.changes.waiting === 2);
    if (backpressured) {
      for (let i = 0; i < 10; i++) f.store.append('session.updated', { i }, { sessionKey: 'synthetic' });
      // Both streams stop reading: no journal wait while their bounded writes block.
      await waitForCondition(() => f.store.changes.waiting === 0);
    }
    f.routes.close(); f.routes.close();
    let storageReads = 0;
    f.store.latestEventId = () => { storageReads++; throw new Error('closed storage'); };
    for (const reader of readers) while (!(await reader.read()).done) { /* Drain only already-buffered frames. */ }
    assert.equal(storageReads, 0);
    assert.equal(f.store.changes.waiting + f.tokens.changes.waiting, 0);
    assert.equal((await open()).status, 503);
  } finally { for (const reader of readers) await reader.cancel(); await f.cleanup(); }
});
}

test('Connector storage read failure ends a stream and releases admission without an error payload', async () => {
  const f = createConnectorFixture(undefined, true);
  try {
    const token = f.tokens.create({ label: 'reader', scopes: ['events:read'] }).token;
    const latest = f.store.latestEventId.bind(f.store);
    f.store.latestEventId = () => { throw new Error('private database error'); };
    const open = () => f.app.request('/api/connector/v1/events/stream', { headers: { authorization: `Bearer ${token}` } });
    for (let i = 0; i < 130; i++) {
      const response = await open();
      assert.equal(response.status, 200);
      assert.equal(await response.text(), '');
    }
    f.store.latestEventId = latest;
    const reader = (await open()).body!.getReader();
    assert.equal((await reader.read()).done, false);
    await reader.cancel();
    await waitForCondition(() => f.store.changes.waiting + f.tokens.changes.waiting === 0);
  } finally { await f.cleanup(); }
});

// This includes filesystem-backed fixture setup and 256 authenticated opens.
// Budget those separately from the unchanged production 10-second write timer.
test('Connector slow writes time out and release every occupied admission slot', { timeout: 30_000 }, async t => {
  const started = performance.now();
  // Observe original trace calls without expanding the production 128-entry
  // ring or bypassing its log rate limit to accommodate this saturation test.
  const observations: { sequence: number; phase: string; failed?: boolean; [key: string]: unknown }[] = [];
  const originalStart = performanceDiagnostics.start.bind(performanceDiagnostics);
  let nextSequence = 0;
  t.mock.method(performanceDiagnostics, 'start', (operation: Parameters<typeof originalStart>[0]) => {
    const trace = originalStart(operation);
    if (operation !== 'connector-event-stream') return trace;
    const sequence = ++nextSequence, values: Record<string, number> = {};
    return {
      add(key: Parameters<typeof trace.add>[0], value: number) {
        values[key] = (values[key] ?? 0) + value; trace.add(key, value);
      },
      reportPending(snapshot: Parameters<typeof trace.reportPending>[0]) {
        observations.push({ sequence, phase: 'pending', ...values, ...snapshot }); trace.reportPending(snapshot);
      },
      finish(failed = false) {
        observations.push({ sequence, phase: 'finished', ...values, failed }); trace.finish(failed);
      },
    };
  });
  const f = createConnectorFixture(undefined, true);
  const responses: Response[] = [];
  try {
    const token = f.tokens.create({ label: 'slow readers', scopes: ['events:read'] }).token;
    const open = () => f.app.request('/api/connector/v1/events/stream', { headers: { authorization: `Bearer ${token}` } });
    for (let i = 0; i < 128; i++) responses.push(await open());
    t.diagnostic(`initial admission elapsedMs=${Math.round(performance.now() - started)}`);
    await waitForCondition(() => f.store.changes.waiting === 128);
    for (let i = 0; i < 10; i++) f.store.append('session.updated', { i }, { sessionKey: 'synthetic' });
    await waitForCondition(() => f.store.changes.waiting === 0);
    assert.equal((await open()).status, 503);
    await new Promise(resolve => setTimeout(resolve, 10_200));
    for (const response of responses) {
      const text = await response.text();
      assert.ok(text.includes('heartbeat'));
      assert.ok(!text.includes('"i":9'), 'a blocked reader cannot accumulate all journal frames');
    }
    assert.equal(f.store.changes.waiting + f.tokens.changes.waiting, 0);
    const finished = observations.filter(event => event.phase === 'finished' && event.step === 3);
    assert.equal(finished.length, 128, 'all original streams record release, not only timeout request');
    assert.ok(finished.every(event => event.settled === 1 && event.timedOut === 1 && event.failed === true));
    const pending = observations.find(event => event.phase === 'pending');
    assert.ok(pending); assert.equal(pending.step, 1); assert.equal(pending.settled, undefined);
    assert.ok(finished.some(event => event.sequence === pending.sequence));
    assert.doesNotMatch(JSON.stringify(observations), /slow readers|synthetic|Bearer/);
    t.diagnostic(`all original blocked streams settled elapsedMs=${Math.round(performance.now() - started)}`);
    // Refill the entire bound, not just one recovered slot.
    for (let i = 0; i < 128; i++) {
      const response = await open(); responses.push(response);
      assert.equal(response.status, 200);
    }
    t.diagnostic(`all admission slots refilled elapsedMs=${Math.round(performance.now() - started)}`);
  } finally {
    f.routes.close();
    for (const response of responses) if (!response.bodyUsed) await response.body?.cancel();
    await f.cleanup();
  }
});

for (const transport of ['local', 'http'] as const) test(`${transport}: canonical mirror requires explicit target permission and preserves atomic original intent`, async () => {
  const setup = createConnectorFixture();
  const server = transport === 'http' ? serve({ fetch: setup.app.fetch, hostname: '127.0.0.1', port: 0 }) : undefined;
  if (server && !server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
  const origin = server ? `http://127.0.0.1:${(server.address() as { port: number }).port}` : 'http://connector';
  const sessionKey = 'agent:main:feishu:direct:original-user';
  setup.store.upsertSession({ sessionKey, agentId: 'main', title: 'Synthetic', status: 'idle' });
  const writer = setup.tokens.create({ label: 'writer', scopes: ['messages:send', 'messages:read'] });
  const mirror = setup.tokens.create({ label: 'mirror', scopes: ['messages:send', 'messages:read', 'messages:mirror'] });
  const request = (token: string, key: string, body: object, target = sessionKey) => {
    const input = new Request(`${origin}/api/connector/v1/sessions/${encodeURIComponent(target)}/messages`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'idempotency-key': key, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return server ? fetch(input) : setup.app.fetch(input);
  };
  try {
    let native = 0;
    setup.gateway.request = async () => { native += 1; return {}; };
    const payload = { message: 'original input', deliveryMode: 'mirror' };
    const media = [{ name: 'synthetic.txt', mimeType: 'text/plain', dataUrl: 'data:text/plain;base64,b3JpZ2luYWw=' }];
    assert.equal((await request(writer.token, 'denied', { ...payload, media })).status, 403);
    assert.equal(existsSync(join(setup.home, '.openclaw', 'media', 'inbound')), false);
    for (const message of ['/status', '/compact', '/stop']) {
      assert.equal((await request(mirror.token, message.slice(1), { ...payload, message })).status, 409);
    }
    assert.equal((await request(mirror.token, 'codex', payload, 'codex:synthetic')).status, 409);
    assert.equal((await request(mirror.token, 'dashboard', payload, 'agent:main:dashboard')).status, 400);
    assert.deepEqual(setup.connectorUsers.mirrorOutbox.list(), []);
    const accepted = await request(mirror.token, 'original', payload);
    assert.equal(accepted.status, 200);
    const result = await accepted.json() as { idempotencyKey: string };
    const intent = setup.connectorUsers.mirrorOutbox.get(result.idempotencyKey); assert.ok(intent);
    assert.equal(intent.actorId, mirror.record.id);
    assert.equal(intent.sessionKey, sessionKey);
    assert.deepEqual(intent.explicitRoute, { originatingChannel: 'feishu', originatingTo: 'original-user',
      originatingAccountId: 'main', outboundTarget: 'user:original-user' });
    assert.equal(intent.deliveryState, 'pending');
    assert.equal((await request(mirror.token, 'original', payload)).status, 200);
    assert.equal((await request(mirror.token, 'original', { ...payload, deliveryMode: 'web-only' })).status, 409);
    assert.equal(setup.connectorUsers.turns.list('openclaw').length, 1);
    assert.equal(setup.connectorUsers.mirrorOutbox.list().length, 1);
    assert.equal(native, 0);
  } finally {
    if (server) {
      if ('closeAllConnections' in server) server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    await setup.cleanup();
  }
});

test('model catalog requires scope, preserves provider choices and fences in-flight revocation', async () => {
  let release: (() => void) | undefined;
  let calls = 0;
  const f = createConnectorFixture({ enabled: true, listModels: async () => { calls++; await new Promise<void>(resolve => { release = resolve; }); return [{ id: 'native', label: 'Native' }]; } });
  const token = f.tokens.createTransient(['models:read']);
  const request = () => f.app.request('/api/connector/v1/models/codex', { headers: { authorization: `Bearer ${token.token}` } });
  try {
    assert.equal((await f.app.request('/api/connector/v1/models/codex')).status, 403);
    f.config.codex.modelProvider = 'custom-provider'; f.config.codex.defaultModel = 'custom-model';
    f.config.codex.modelChoices = ['model-b'];
    assert.deepEqual((await (await request()).json()).models, [{ id: 'model-b', label: 'model-b' }, { id: 'custom-model', label: 'custom-model' }]);
    assert.equal(calls, 0, 'custom provider never inherits unrelated native models');
    f.config.codex.modelProvider = undefined; f.config.codex.modelChoices = [];
    const pending = request();
    while (!release) await new Promise(resolve => setImmediate(resolve));
    token.dispose(); release();
    assert.equal((await pending).status, 403);
  } finally { release?.(); await f.cleanup(); }
});

test('message list summarizes large tools; detail retains exact text behind session scope', async () => {
  const f = createConnectorFixture();
  const token = f.tokens.createTransient(['messages:read']);
  const key = 'agent:main:test';
  f.store.upsertSession({ sessionKey: key, agentId: 'main', title: 'Test', status: 'idle' });
  const text = 'tool output\n'.repeat(10000);
  f.store.addMessage({ id: 'large-tool', sessionKey: key, role: 'tool', text, createdAt: 1 });
  const path = `/api/connector/v1/sessions/${encodeURIComponent(key)}/messages`;
  const headers = { authorization: `Bearer ${token.token}` };
  try {
    const response = await f.app.request(path, { headers });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.messages[0].text.length, 1000);
    assert.equal(body.messages[0].toolDetailAvailable, true);
    assert.equal(body.revision, stableGatewayRowsRevision(body.messages), 'list revision hashes the bounded representation');
    const detail = await f.app.request(`${path}/large-tool`, { headers });
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).message.text, text);
    token.dispose();
    assert.equal((await f.app.request(`${path}/large-tool`, { headers })).status, 403);
  } finally { await f.cleanup(); }
});

for (const outcome of ['resolve', 'reject'] as const) test(`Connector close drains original async event read after cancellation, late ${outcome}`, { timeout: 5000 }, async () => {
  let settle!: (page: EventReplayPage) => void, fail!: (error: unknown) => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const original = new Promise<EventReplayPage>((resolve, reject) => { settle = resolve; fail = reject; });
  let calls = 0;
  const f = createConnectorFixture(undefined, false, false, undefined, () => { calls++; entered(); return original; });
  const token = f.tokens.createTransient(['events:read']);
  const controller = new AbortController();
  const reader = (await f.app.request('/api/connector/v1/events/stream?lastEventId=anchor', {
    signal: controller.signal, headers: { authorization: `Bearer ${token.token}` },
  })).body!.getReader();
  try {
    await started; controller.abort(); await reader.cancel();
    let done = false; const close = f.routes.close(); void close.then(() => { done = true; });
    assert.equal(close, f.routes.close());
    await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(done, false); assert.equal(calls, 1);
    if (outcome === 'resolve') settle({ cursor: 'anchor', known: true, events: [] }); else fail(Error('PRIVATE DATABASE DETAILS'));
    await close; assert.equal(done, true); assert.equal(calls, 1);
    assert.equal(f.store.changes.waiting + f.tokens.changes.waiting, 0);
  } finally { settle({ cursor: 'anchor', known: true, events: [] }); token.dispose(); await reader.cancel(); await f.cleanup(); }
});

test('Connector async event read rechecks revocation before heartbeat or private frame', { timeout: 5000 }, async () => {
  let settle!: (page: EventReplayPage) => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const original = new Promise<EventReplayPage>(resolve => { settle = resolve; });
  const f = createConnectorFixture(undefined, false, false, undefined, () => { entered(); return original; });
  const token = f.tokens.createTransient(['events:read']);
  const reader = (await f.app.request('/api/connector/v1/events/stream?lastEventId=old', { headers: { authorization: `Bearer ${token.token}` } })).body!.getReader();
  try {
    await started; token.dispose();
    settle({ cursor: 'new', known: true, events: [{ id: 'new', type: 'session.updated', ts: 1, payload: 'PRIVATE' }] });
    assert.equal((await reader.read()).done, true);
  } finally { settle({ cursor: 'old', known: true, events: [] }); await reader.cancel(); await f.cleanup(); }
});

test('Connector async event pages preserve wire metadata and last delivered cursor without sync fallback', { timeout: 5000 }, async () => {
  const requested: (string | null)[] = [];
  const f = createConnectorFixture(undefined, false, false, undefined, async after => {
    requested.push(after);
    return { cursor: 'two', known: true, events: [{ id: after === 'anchor' ? 'one' : 'two', type: 'session.updated', ts: 1, payload: { visible: true } }] };
  });
  f.store.latestEventId = () => { throw Error('sync fallback'); };
  f.store.hasEvent = () => { throw Error('sync fallback'); };
  f.store.getEventsSince = () => { throw Error('sync fallback'); };
  const token = f.tokens.createTransient(['events:read']);
  const reader = (await f.app.request('/api/connector/v1/events/stream?lastEventId=anchor', { headers: { authorization: `Bearer ${token.token}` } })).body!.getReader();
  try {
    const decode = (value: ReadableStreamReadResult<Uint8Array>) => new TextDecoder().decode(value.value);
    assert.match(decode(await reader.read()), /heartbeat/);
    const first = decode(await reader.read()), second = decode(await reader.read());
    assert.match(first, /id: one/); assert.match(second, /id: two/); assert.match(first, /"connector":/);
    assert.deepEqual(requested, ['anchor', 'one']);
  } finally { token.dispose(); await reader.cancel(); await f.cleanup(); }
});

test('Connector non-progressing async event page closes once without polling or replay', { timeout: 5000 }, async () => {
  let calls = 0;
  const f = createConnectorFixture(undefined, false, false, undefined, async () => { calls++; return { cursor: 'new', known: true, events: [] }; });
  const token = f.tokens.createTransient(['events:read']);
  try {
    const response = await f.app.request('/api/connector/v1/events/stream?lastEventId=old', { headers: { authorization: `Bearer ${token.token}` } });
    assert.equal(await response.text(), ''); assert.equal(calls, 1);
  } finally { token.dispose(); await f.cleanup(); }
});

for (const outcome of ['resolve', 'reject'] as const) test(`Connector snapshot timeout retains original ${outcome} without late capture or release`, { timeout: 5000 }, async () => {
  let enter!: () => void, settle!: () => void, fail!: (error: Error) => void, calls = 0, captures = 0;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>((resolve, reject) => { settle = resolve; fail = reject; });
  const f = createConnectorFixture(undefined, false, false, undefined, undefined,
    async capture => { calls++; enter(); await gate; return capture('PRIVATE-LATE-CURSOR'); }, 80);
  const originalCapture = f.store.getSessionDirectory.bind(f.store);
  f.store.getSessionDirectory = (...args) => { captures++; return originalCapture(...args); };
  const token = f.tokens.createTransient(['sessions:read']);
  let close: Promise<void> | undefined;
  try {
    const request = f.app.request('/api/connector/v1/sessions/directory', { headers: { authorization: `Bearer ${token.token}` } });
    await entered; const response = await request;
    assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /PRIVATE|sourceCursor/);
    let drained = false; close = f.routes.close().then(() => { drained = true; });
    await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(drained, false); assert.equal(calls, 1);
    if (outcome === 'resolve') settle(); else fail(Error('PRIVATE SQL FAILURE'));
    await close; assert.equal(drained, true); assert.equal(captures, 0); assert.equal(calls, 1);
  } finally { settle(); token.dispose(); await (close ?? f.routes.close()); await f.cleanup(); }
});

test('Connector timed-out snapshot reads retain all 64 admissions until original settlement then recover', { timeout: 10000 }, async () => {
  let settle!: () => void, calls = 0, bodies = 0;
  const gate = new Promise<void>(resolve => { settle = resolve; });
  const f = createConnectorFixture(undefined, false, false, undefined, undefined,
    async capture => { calls++; await gate; const value = capture('recovered-cursor'); bodies++; return value; }, 1000);
  const token = f.tokens.createTransient(['sessions:read']);
  const request = () => f.app.request('/api/connector/v1/sessions/directory', { headers: { authorization: `Bearer ${token.token}` } });
  try {
    const accepted = Array.from({ length: 64 }, request);
    await waitForCondition(() => calls === 64);
    assert.ok((await Promise.all(accepted)).every(response => response.status === 503));
    assert.equal((await request()).status, 503); assert.equal(calls, 64); assert.equal(bodies, 0);
    settle(); await new Promise<void>(resolve => setImmediate(resolve));
    const recovered = await request(); assert.equal(recovered.status, 200);
    assert.equal((await recovered.json()).sourceCursor, 'recovered-cursor');
    assert.equal(calls, 65); assert.equal(bodies, 1, 'timed-out captures never publish a body');
  } finally { settle(); token.dispose(); await f.cleanup(); }
});

for (const outcome of ['resolve', 'reject'] as const) test(`Connector event replay timeout ends delivery but close drains original ${outcome}`, { timeout: 5000 }, async () => {
  let enter!: () => void, settle!: (page: EventReplayPage) => void, fail!: (error: Error) => void, calls = 0;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const original = new Promise<EventReplayPage>((resolve, reject) => { settle = resolve; fail = reject; });
  const f = createConnectorFixture(undefined, false, false, undefined, () => { calls++; enter(); return original; }, undefined, 80);
  const token = f.tokens.createTransient(['events:read']);
  const reader = (await f.app.request('/api/connector/v1/events/stream?lastEventId=old', { headers: { authorization: `Bearer ${token.token}` } })).body!.getReader();
  let close: Promise<void> | undefined;
  try {
    await entered; assert.equal((await reader.read()).done, true);
    let drained = false; close = f.routes.close().then(() => { drained = true; });
    await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(drained, false); assert.equal(calls, 1);
    if (outcome === 'resolve') settle({ cursor: 'new', known: true, events: [{ id: 'new', type: 'session.updated', ts: 1, payload: 'PRIVATE' }] });
    else fail(Error('PRIVATE DATABASE FAILURE'));
    await close; assert.equal(drained, true); assert.equal(calls, 1);
    assert.equal(f.store.changes.waiting + f.tokens.changes.waiting, 0);
  } finally { settle({ cursor: 'old', known: true, events: [] }); await reader.cancel(); token.dispose(); await (close ?? f.routes.close()); await f.cleanup(); }
});

for (const suffix of ['directory', 'state', 'codex:snapshot/state', 'codex:snapshot/messages', 'codex:snapshot/messages/message']) test(`Connector ${suffix} captures after the original async cursor without sync fallback`, async () => {
  let enter!: () => void, settle!: () => void, calls = 0;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { settle = resolve; });
  const f = createConnectorFixture(undefined, false, false, undefined, undefined, async capture => {
    calls++; enter(); await gate; return capture('async-snapshot-cursor');
  });
  const token = f.tokens.createTransient(['sessions:read', 'messages:read']);
  try {
    f.store.upsertSession({ sessionKey: 'codex:snapshot', agentId: 'codex', title: 'before', status: 'idle' });
    f.store.addMessage({ id: 'message', sessionKey: 'codex:snapshot', role: 'assistant', text: 'before', createdAt: 1 });
    const request = f.app.request(`/api/connector/v1/sessions/${suffix}`, { headers: { authorization: `Bearer ${token.token}` } });
    await entered;
    f.store.upsertSession({ sessionKey: 'codex:snapshot', agentId: 'codex', title: 'after', status: 'running' });
    // Mutation still uses the existing memory API; only a hidden read fallback
    // after the cursor await is forbidden by this test.
    f.store.latestEventId = () => { throw Error('synchronous cursor fallback'); };
    settle();
    const response = await request;
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.sourceCursor, 'async-snapshot-cursor'); assert.equal(calls, 1);
    if (suffix === 'codex:snapshot/state') assert.equal(body.status, 'running');
  } finally { settle(); token.dispose(); await f.cleanup(); }
});

for (const outcome of ['resolve', 'reject'] as const) test(`Connector snapshot close waits for original ${outcome} and refuses the late body`, async () => {
  let enter!: () => void, settle!: () => void, fail!: (error: Error) => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>((resolve, reject) => { settle = resolve; fail = reject; });
  const f = createConnectorFixture(undefined, false, false, undefined, undefined, async capture => { enter(); await gate; return capture('late'); });
  const token = f.tokens.createTransient(['sessions:read']);
  try {
    const request = f.app.request('/api/connector/v1/sessions/directory', { headers: { authorization: `Bearer ${token.token}` } });
    await entered; let drained = false;
    const close = f.routes.close().then(() => { drained = true; });
    await Promise.resolve(); await Promise.resolve(); assert.equal(drained, false);
    if (outcome === 'resolve') settle(); else fail(Error('PRIVATE DATABASE DETAILS'));
    const response = await request; assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /PRIVATE|late/);
    await close; assert.equal(drained, true);
    assert.equal((await f.app.request('/api/connector/v1/sessions/directory', { headers: { authorization: `Bearer ${token.token}` } })).status, 503);
  } finally { settle(); token.dispose(); await f.cleanup(); }
});

for (const interruption of ['revoke', 'abort'] as const) test(`Connector snapshot rechecks ${interruption} after awaited cursor`, async () => {
  let enter!: () => void, settle!: () => void, captures = 0;
  const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { settle = resolve; });
  const f = createConnectorFixture(undefined, false, false, undefined, undefined, async capture => { enter(); await gate; captures++; return capture('late'); });
  const token = f.tokens.createTransient(['sessions:read']), controller = new AbortController();
  try {
    const request = f.app.request('/api/connector/v1/sessions/directory', { headers: { authorization: `Bearer ${token.token}` }, signal: controller.signal });
    await entered; if (interruption === 'revoke') token.dispose(); else controller.abort(); settle();
    const response = await request; assert.equal(response.status, interruption === 'revoke' ? 403 : 408);
    assert.equal(captures, 1); assert.doesNotMatch(await response.text(), /sourceCursor|late/);
  } finally { settle(); token.dispose(); await f.cleanup(); }
});

for (const suffix of ['state', 'codex:snapshot/messages'] as const) test(`Connector ${suffix} refuses readiness invalidated after capture`, async () => {
  let f!: ReturnType<typeof createConnectorFixture>;
  f = createConnectorFixture(undefined, false, false, undefined, undefined, async capture => {
    const body = capture('current');
    // Simulates reconciliation entering between capture and HTTP publication.
    f.readiness.sessions = false; f.readiness.history = false; return body;
  });
  const token = f.tokens.createTransient(['sessions:read', 'messages:read']);
  try {
    f.store.addMessage({ id: 'message', sessionKey: 'codex:snapshot', role: 'assistant', text: 'PRIVATE', createdAt: 1 });
    const response = await f.app.request(`/api/connector/v1/sessions/${suffix}`, { headers: { authorization: `Bearer ${token.token}` } });
    assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /PRIVATE|sourceCursor/);
  } finally { token.dispose(); await f.cleanup(); }
});

test('Connector async history preserves conditional ETag while fencing the cursor on every read', async () => {
  let reads = 0;
  const f = createConnectorFixture(undefined, false, false, undefined, undefined, async capture => capture(`cursor-${++reads}`));
  const token = f.tokens.createTransient(['messages:read']);
  try {
    f.store.addMessage({ id: 'message', sessionKey: 'codex:etag', role: 'assistant', text: 'unchanged', createdAt: 1 });
    const url = '/api/connector/v1/sessions/codex:etag/messages', headers = { authorization: `Bearer ${token.token}` };
    const first = await f.app.request(url, { headers }); assert.equal(first.status, 200);
    const cached = await f.app.request(url, { headers: { ...headers, 'if-none-match': first.headers.get('etag')! } });
    assert.equal(cached.status, 304); assert.equal(reads, 2); assert.equal(await cached.text(), '');
  } finally { token.dispose(); await f.cleanup(); }
});

test('Connector refuses scope revoked after snapshot capture before publishing the body', async () => {
  let token!: ReturnType<ConnectorTokenStore['createTransient']>;
  const f = createConnectorFixture(undefined, false, false, undefined, undefined, async capture => {
    const body = capture('PRIVATE-CURSOR'); token.dispose(); return body;
  });
  token = f.tokens.createTransient(['sessions:read']);
  try {
    const response = await f.app.request('/api/connector/v1/sessions/directory', { headers: { authorization: `Bearer ${token.token}` } });
    assert.equal(response.status, 403); assert.doesNotMatch(await response.text(), /PRIVATE|sourceCursor/);
  } finally { token.dispose(); await f.cleanup(); }
});

for (const runtime of ['claude-code', 'ghcp'] as const) test(`${runtime} snapshot refuses a session deleted after capture`, async () => {
  let f!: ReturnType<typeof createConnectorFixture>;
  f = createConnectorFixture(undefined, false, false, runtime, undefined, async capture => {
    const body = capture('PRIVATE-CURSOR');
    const journal = runtime === 'ghcp' ? f.connectorUsers.copilotJournal : f.connectorUsers.claudeJournal;
    journal.beginDeletion(`${runtime}:snapshot`, 'delete-after-capture'); return body;
  });
  const journal = runtime === 'ghcp' ? f.connectorUsers.copilotJournal : f.connectorUsers.claudeJournal;
  journal.create({ key: `${runtime}:snapshot`, nativeSessionId: 'snapshot', title: 'Fixture', createdAt: 0 });
  const token = f.tokens.createTransient(['messages:read']);
  try {
    const response = await f.app.request(`/api/connector/v1/sessions/${runtime}:snapshot/messages`, { headers: { authorization: `Bearer ${token.token}` } });
    assert.equal(response.status, 404); assert.doesNotMatch(await response.text(), /PRIVATE|sourceCursor/);
  } finally { token.dispose(); await f.cleanup(); }
});

for (const suffix of ['state', 'messages', 'messages/message'] as const) for (const boundary of ['before', 'after'] as const)
test(`native ${suffix} refuses deletion ${boundary} snapshot capture`, async t => {
  let deleted = false;
  const f = createConnectorFixture(undefined, false, false, undefined, undefined, async capture => {
    if (boundary === 'before') deleted = true;
    const body = capture('PRIVATE-CURSOR'); deleted = true; return body;
  });
  const token = f.tokens.createTransient(['messages:read']);
  try {
    f.store.upsertSession({ sessionKey: 'codex:snapshot', agentId: 'codex', title: 'Fixture', status: 'idle' });
    f.store.addMessage({ id: 'message', sessionKey: 'codex:snapshot', role: 'assistant', text: 'PRIVATE-BODY', createdAt: 1 });
    t.mock.method(f.connectorUsers.commands, 'sessionDeletion', () => deleted ? 'accepted' : undefined);
    const response = await f.app.request(`/api/connector/v1/sessions/codex:snapshot/${suffix}`, { headers: { authorization: `Bearer ${token.token}` } });
    assert.equal(response.status, suffix === 'messages/message' ? 409 : 404);
    assert.doesNotMatch(await response.text(), /PRIVATE|sourceCursor/);
  } finally { token.dispose(); await f.cleanup(); }
});

test('Connector snapshot admission is bounded and never cancels or replays accepted reads', async () => {
  let calls = 0, full!: () => void, settle!: () => void;
  const entered = new Promise<void>(resolve => { full = resolve; }), gate = new Promise<void>(resolve => { settle = resolve; });
  const f = createConnectorFixture(undefined, false, false, undefined, undefined, async capture => { if (++calls === 64) full(); await gate; return capture('current'); });
  const token = f.tokens.createTransient(['sessions:read']);
  try {
    const read = () => f.app.request('/api/connector/v1/sessions/directory', { headers: { authorization: `Bearer ${token.token}` } });
    const pending = Array.from({ length: 64 }, read); await entered;
    assert.equal((await read()).status, 503); assert.equal(calls, 64);
    settle(); assert.ok((await Promise.all(pending)).every(response => response.status === 200)); assert.equal(calls, 64);
  } finally { settle(); token.dispose(); await f.cleanup(); }
});

test('OpenClaw application rejects mixed writers and incomplete controls before registering any routes', () => {
  for (const name of ['openclawQueue', 'openclawMessages']) {
    const app = new Hono();
    assert.throws(() => registerConnectorRoutes(app, { openclawApplication: {}, [name]: {} } as unknown as Parameters<typeof registerConnectorRoutes>[1]), /cannot be mixed/);
    assert.equal(app.routes.length, 0);
  }
  for (const ports of [undefined, {}, { ready() {}, messages: {} }, { ready() {}, messages: {}, stop: {}, status: {}, compact: {} }]) {
    const app = new Hono();
    assert.throws(() => registerConnectorRoutes(app, { openclawApplication: { openClawMessages: ports } } as unknown as Parameters<typeof registerConnectorRoutes>[1]), /requires complete/);
    assert.equal(app.routes.length, 0);
  }
});

test('OpenClaw complete application reaches original owner behind real protocol/node gates without old queue or Gateway', async t => {
  let command!: ReturnType<typeof createConnectorOwnerCommands>;
  const key = 'agent:main:dashboard:application-route', calls: string[] = [], sends: { method: string; params: Record<string, unknown> }[] = [];
  const projection = new DeckStore(); projection.upsertSession({ sessionKey: key, agentId: 'main', title: 'Original', status: 'idle' });
  projection.addMessage({ id: 'original-detail', sessionKey: key, role: 'assistant', text: 'Original history', createdAt: 1 });
  const application = new AsyncOpenClawApplication({ owner: { command: (kind, input) => { calls.push(kind); return command(kind, input); } },
    history: { snapshot: capture => capture('original-route-cursor'), historyReady: () => true, refresh: async () => {},
      invalidate: () => {}, close: async () => {} }, invalidateDiscovery: () => {},
    deck: projection, defaultAgentId: 'main', admissionAvailable: () => true, gatewayStatus: () => 'connected',
    dispatch: { gateway: { connectionId: () => 'original-route', prepareWriteConnection: async () => 'original-route',
      requestBound: async <T>(method: string, params: Record<string, unknown>, connection?: string, before?: () => void) => {
        assert.equal(connection, 'original-route'); before?.(); sends.push({ method, params });
        return { connectionId: 'original-route', payload: (method === 'chat.abort' ? { ok: true, aborted: true, runIds: [params.runId] } : { runId: 'original-native', status: 'started' }) as T };
      } }, native: { available: () => true, epoch: () => 'original-route' }, allowCliFallback: false, message: text => text },
    recovery: { connectionId: () => 'original-route', query: async () => ({ status: 'timeout' }) },
    nativeSession: session => session === key ? { status: 'idle', hasActiveRun: false } : undefined,
    refreshSessions: async () => {}, refreshMessages: async () => {}, retryMs: 10_000 });
  const f = createConnectorFixture(undefined, false, false, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, application.http);
  command = createConnectorOwnerCommands(f.connectorUsers, f.tokens);
  const actor = f.tokens.createTransient(['messages:send', 'messages:read']);
  const path = `/api/connector/v1/sessions/${encodeURIComponent(key)}`, headers = { authorization: `Bearer ${actor.token}`, 'content-type': 'application/json' };
  const post = (body: unknown, extra = {}) => f.app.request(`${path}/messages`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  try {
    for (const field of ['state', 'page', 'message'] as const) {
      const incomplete = new Hono();
      assert.throws(() => registerConnectorRoutes(incomplete, { openclawApplication: {
        ...application.http, openClawReads: { reads: { ...application.http.openClawReads.reads, [field]: undefined } },
      } } as unknown as Parameters<typeof registerConnectorRoutes>[1]), /requires complete/);
      assert.equal(incomplete.routes.length, 0, 'incomplete JS application fails before exposing any endpoint');
    }
    t.mock.method(f.queue, 'enqueueAsync', () => assert.fail('Old queue cannot receive async application input'));
    t.mock.method(f.gateway, 'request', async () => assert.fail('Old Gateway cannot receive async application input'));
    assert.equal((await post({ message: '/compact' }, { [EXPECTED_NODE_HEADER]: 'another-node' })).status, 409);
    assert.equal((await post({ message: '/compact' }, { [CONNECTOR_PROTOCOL_HEADER]: '99999' })).status, 426);
    assert.equal(calls.length, 0);
    assert.equal((await post({ message: '/compact' })).status, 503); assert.equal(calls.length, 0);
    for (const suffix of ['/state', '/messages', '/messages/original-detail']) {
      assert.equal((await f.app.request(`${path}${suffix}`, { headers: { ...headers, [EXPECTED_NODE_HEADER]: 'another-node' } })).status, 409);
      assert.equal((await f.app.request(`${path}${suffix}`, { headers })).status, 503);
    }
    assert.equal(calls.length, 0);
    await application.start();
    const oldState = t.mock.method(f.store, 'getSessionExecution', () => assert.fail('Old synchronous state cannot serve async reads'));
    const oldHistory = t.mock.method(f.store, 'getMessages', () => assert.fail('Old synchronous history cannot serve async reads'));
    const oldScope = t.mock.method(f.tokens, 'requireScope', () => assert.fail('Old synchronous scope cannot authorize async reads'));
    try {
      for (const suffix of ['/state', '/messages', '/messages/original-detail']) {
        const response = await f.app.request(`${path}${suffix}`, { headers });
        assert.equal(response.status, 200); assert.equal(response.headers.get(NODE_ID_HEADER), f.connectorUsers.nodeId);
        assert.equal((await response.json()).sourceCursor, 'original-route-cursor');
      }
      assert.ok(calls.includes('openClawReadAuthorize')); assert.ok(calls.includes('openClawReadDeliver'));
    } finally { oldState.mock.restore(); oldHistory.mock.restore(); oldScope.mock.restore(); }
    assert.equal((await post({ message: '/status', idempotencyKey: 'route-status' })).status, 200);
    const compact = await post({ message: '/compact', idempotencyKey: 'route-compact' });
    assert.equal(compact.status, 200); assert.equal(compact.headers.get(NODE_ID_HEADER), f.connectorUsers.nodeId);
    const original = await command('openClawExecutionRead', { sessionKey: key }); assert.ok(original);
    const pause = application.pauseQueueWorker(); await pause.drained;
    assert.equal((await post({ message: '/stop', expectedRunId: original.commandId, idempotencyKey: 'route-stop' })).status, 200);
    assert.equal((await f.app.request(`${path}/commands/route-compact`, { headers })).status, 200);
    assert.equal((await f.app.request(`${path}/commands/route-compact/queue`, { headers })).status, 200);
    assert.equal((await post({ message: '/compact', idempotencyKey: 'route-compact' })).status, 200);
    assert.deepEqual(sends.map(send => send.method), ['chat.send', 'chat.abort']);
    assert.equal(sends[1]?.params.runId, 'original-native'); assert.equal(f.connectorUsers.openClawExecutions.get(key)?.phase, 'starting');
    assert.equal((await post({ message: 'paused ordinary', idempotencyKey: 'route-paused' })).status, 409);
    assert.equal(pause.resume(), true);
    assert.equal((await post({ message: 'ordinary', idempotencyKey: 'route-ordinary' })).status, 200);
    assert.equal(sends.length, 2, 'Original starting fact still blocks a successor');
    assert.ok(calls.includes('openClawMessageCommit')); assert.ok(calls.includes('openClawCompactClaim')); assert.ok(calls.includes('openClawStopClaim'));
  } finally { await application.close(); command.dispose(); actor.dispose(); await f.cleanup(); }
});

test('Hermes application bundle rejects a second runtime or partial individual assembly before registering routes', () => {
  for (const name of ['hermes', 'hermesMessages', 'hermesCreation', 'hermesDeletion', 'hermesQueue', 'hermesReads']) {
    assert.throws(() => registerConnectorRoutes(new Hono(), { hermesApplication: {}, [name]: {} } as unknown as Parameters<typeof registerConnectorRoutes>[1]), /cannot be mixed/);
  }
});

test('Hermes complete application bundle owns control HTTP lanes after node/protocol guards without legacy authority', async t => {
  const calls: string[] = [];
  const missing = async (lane: string) => { calls.push(lane); return { error: 401 as const }; };
  const application: AsyncHermesApplicationHttp = {
    hermesReads: { reads: { state: () => missing('state'), page: () => missing('history'), message: () => missing('detail') } },
    hermesMessages: { ready: () => true, messages: { send: () => missing('send'), readReceipt: () => missing('messageReceipt'), readSendReceipt: () => missing('sendReceipt') },
      stop: { stop: () => missing('stop'), receipt: () => missing('stopReceipt') },
      localControl: { send: () => missing('local'), read: () => missing('status') } },
    hermesCreation: { ready: () => true, creation: { create: () => missing('create'), receipt: () => missing('creationReceipt') } },
    hermesDeletion: { ready: () => true, lifecycle: { remove: () => missing('delete'), receipt: () => missing('deletionReceipt') } },
    hermesQueue: { ready: () => true, queue: { page: () => missing('queue'), commandPage: () => missing('queueCommands'),
      edit: () => missing('edit'), cancel: () => missing('cancel'), readReceipt: () => missing('mutationReceipt') } },
  };
  const f = createConnectorFixture(undefined, false, false, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, application);
  try {
    t.mock.method(f.tokens, 'authenticate', () => assert.fail('Legacy authentication must not own Hermes application lanes'));
    t.mock.method(f.connectorUsers.commands, 'get', () => assert.fail('Legacy receipts must not own Hermes application lanes'));
    const session = '/api/connector/v1/sessions/hermes:original', headers = { authorization: 'Bearer original-bundle' };
    for (const [header, value, status] of [[CONNECTOR_PROTOCOL_HEADER, '999', 426], [EXPECTED_NODE_HEADER, 'wrong', 409]] as const)
      assert.equal((await f.app.request(`${session}/queue`, { headers: { ...headers, [header]: value } })).status, status);
    assert.equal(calls.length, 0);
    for (const suffix of ['/commands/original', '/commands/original/status', '/queue', '/queue/commands',
      '/queue/message/commands/edit', '/deletion-commands/original', '/state', '/messages', '/messages/original']) {
      const response = await f.app.request(`${session}${suffix}`, { headers }); assert.equal(response.status, 401, suffix);
      assert.equal(response.headers.get(NODE_ID_HEADER), f.connectorUsers.nodeId);
    }
    for (const [path, method, body] of [
      [`${session}/messages`, 'POST', { message: '/stop' }],
      [`${session}/messages`, 'POST', { message: '/status' }],
      [session, 'DELETE', { idempotencyKey: 'delete-original' }],
      ['/api/connector/v1/agents/hermes/sessions', 'POST', { title: 'Original' }],
    ] as const) {
      assert.equal((await f.app.request(path, { method, headers, body: JSON.stringify(body) })).status, 401, path);
    }
    assert.deepEqual(calls, ['messageReceipt', 'status', 'queue', 'queueCommands', 'mutationReceipt', 'deletionReceipt',
      'state', 'history', 'detail',
      'sendReceipt', 'sendReceipt', 'deletionReceipt', 'creationReceipt']);
  } finally { await f.cleanup(); }
});

test('SDK application bundle rejects partial legacy mixing before registering any routes', () => {
  for (const name of ['sdkMessages', 'sdkLocal', 'sdkQueue', 'sdkDeletion', 'sdkCompact', 'sdkInteractions', 'sdkHistory', 'sdkUsage', 'sdkFiles', 'sdkMetadata']) {
    assert.throws(() => registerConnectorRoutes(new Hono(), { sdkApplication: {}, [name]: {} } as unknown as Parameters<typeof registerConnectorRoutes>[1]), /cannot be mixed/);
  }
});

test('SDK complete application bundle preserves node/protocol guards and owns every migrated HTTP lane', async t => {
  const calls: string[] = [];
  const missing = async (lane: string) => { calls.push(lane); return { error: 401 as const }; };
  const application: AsyncSdkApplicationHttp = {
    sdkMetadata: { ready: () => true, configured: () => true, metadata: { state: () => missing('state'), models: () => missing('models') } },
    sdkFiles: { files: { page: () => missing('files'), start: () => missing('filesStart'), step: () => missing('filesStep'), cancel: () => missing('filesCancel') } },
    sdkUsage: { usage: { range: () => missing('usage'), export: () => missing('usageExport'),
      readSnapshot: () => missing('snapshotRead'), createSnapshot: () => missing('snapshotCreate') } },
    sdkHistory: { history: { page: () => missing('history'), message: () => missing('historyMessage') } },
    sdkInteractions: { ready: () => true, interactions: { observe: async () => { calls.push('interactions'); return { ok: false, error: 401 }; },
      mode: async () => assert.fail('Read-only interaction route must not mutate mode'), answer: async () => assert.fail('Read-only interaction route must not answer') } },
    sdkMessages: { ready: () => true,
      messages: { send: () => missing('send'), readSendReceipt: () => missing('messages'), readReceipt: () => missing('messageReceipt') },
      status: { send: () => missing('status'), read: () => missing('statusRead') }, stop: () => missing('stop') },
    sdkLocal: { ready: () => true, local: { create: () => missing('create'), updateModel: () => missing('model'), readReceipt: () => missing('local') } },
    sdkQueue: { ready: () => true, queue: { page: () => missing('queue'), commandPage: () => missing('queueCommands'),
      cancel: () => missing('cancel'), edit: () => missing('edit'), readReceipt: () => missing('queueReceipt') } },
    sdkDeletion: { ready: () => true, owner: { command: (() => missing('deletion')) as AsyncSdkApplicationHttp['sdkDeletion']['owner']['command'] }, remove: () => missing('remove') },
    sdkCompact: { ready: () => true, owner: { command: (() => missing('compact')) as AsyncSdkApplicationHttp['sdkCompact']['owner']['command'] }, compact: async () => assert.fail('Read-only route must not dispatch compaction') },
  };
  const f = createConnectorFixture(undefined, false, false, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, application);
  try {
    t.mock.method(f.tokens, 'authenticate', () => assert.fail('Legacy synchronous authority must not handle the unified bundle'));
    t.mock.method(f.connectorUsers.commands, 'get', () => assert.fail('Legacy receipt access must not handle the unified bundle'));
    const session = '/api/connector/v1/sessions/ghcp:original', headers = { authorization: 'Bearer original-bundle' };
    assert.equal((await f.app.request(`${session}/queue`, { headers: { ...headers, [CONNECTOR_PROTOCOL_HEADER]: '999' } })).status, 426);
    assert.equal((await f.app.request(`${session}/queue`, { headers: { ...headers, [EXPECTED_NODE_HEADER]: 'wrong' } })).status, 409);
    assert.equal(calls.length, 0);
    for (const path of [`${session}/commands/original`, `${session}/commands/original/status`, `${session}/queue`,
      `${session}/settings-commands/original`, `${session}/deletion-commands/original`, `${session}/compact-commands/original`, `${session}/interactions`, `${session}/messages`, `${session}/messages/original`,
      `${session}/token-usage?from=0&to=60000&bucketMs=60000`, `${session}/token-usage/export?from=0&to=60000&bucketMs=60000`,
      `${session}/token-usage/snapshots/00112233-4455-4677-8899-aabbccddeeff`, `${session}/files`, `${session}/state`, '/api/connector/v1/models/ghcp']) {
      const response = await f.app.request(path, { headers }); assert.equal(response.status, 401, path);
      assert.equal(response.headers.get(NODE_ID_HEADER), f.connectorUsers.nodeId);
    }
    const snapshot = await f.app.request(`${session}/token-usage/snapshots`, { method: 'POST', headers, body: JSON.stringify({
      requestId: '00112233-4455-4677-8899-aabbccddeeff', from: 0, to: 60000, bucketMs: 60000 }) });
    assert.equal(snapshot.status, 401);
    for (const [method, suffix, body] of [['POST', '/rebuild', undefined], ['POST', '/rebuild/00112233-4455-4677-8899-aabbccddeeff', { step: 0 }],
      ['DELETE', '/rebuild/00112233-4455-4677-8899-aabbccddeeff', undefined]] as const) {
      const result = await f.app.request(`${session}/files${suffix}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
      assert.equal(result.status, 401);
    }
    assert.deepEqual(calls, ['messageReceipt', 'statusRead', 'queue', 'local', 'deletion', 'compact', 'interactions', 'history', 'historyMessage',
      'usage', 'usageExport', 'snapshotRead', 'files', 'state', 'models', 'snapshotCreate', 'filesStart', 'filesStep', 'filesCancel']);
  } finally { await f.cleanup(); }
});

test('SDK async message route takes ownership after protocol/node guards, before old sync authority and receipts', async t => {
  let sends = 0, reads = 0;
  const receipt = { id: 'original-message-receipt', key: 'original-http', state: 'accepted' as const, createdAt: 1, updatedAt: 1,
    result: { status: 200, body: { ok: true, status: 'queued', queueDisposition: 'waiting', idempotencyKey: 'original-turn', media: [] } } };
  const observed = { runtime: 'ghcp' as const, key: 'ghcp:original', commandKey: 'original-http', receipt, queue: { presence: 'absent' as const } };
  const f = createConnectorFixture(undefined, false, false, undefined, undefined, undefined, undefined, {
    ready: () => true,
    messages: { send: async input => { sends++; assert.equal(input.authorization, 'Bearer original-http-authority'); return { ...observed, admitted: true }; },
      readSendReceipt: async () => { reads++; return observed; }, readReceipt: async () => { reads++; return observed; } },
  });
  try {
    t.mock.method(f.tokens, 'authenticate', () => { throw Error('old synchronous request authority'); });
    t.mock.method(f.connectorUsers.commands, 'get', () => { throw Error('old synchronous receipt store'); });
    const path = '/api/connector/v1/sessions/ghcp:original';
    const post = (headers: Record<string, string> = {}) => f.app.request(`${path}/messages`, { method: 'POST', headers: {
      authorization: 'Bearer original-http-authority', ...headers }, body: JSON.stringify({ message: 'original', idempotencyKey: 'original-http' }) });
    assert.equal((await post({ [CONNECTOR_PROTOCOL_HEADER]: '999' })).status, 426);
    assert.equal((await post({ [EXPECTED_NODE_HEADER]: 'wrong-node' })).status, 409);
    assert.equal(sends + reads, 0);
    const response = await post(); assert.equal(response.status, 200); assert.equal(response.headers.get(NODE_ID_HEADER), f.connectorUsers.nodeId);
    assert.equal((await response.json()).command.id, receipt.id); assert.equal(sends, 1); assert.equal(reads, 2);
    const read = await f.app.request(`${path}/commands/original-http`, { headers: { authorization: 'Bearer original-http-authority' } });
    assert.equal(read.status, 200); assert.equal((await read.json()).command.id, receipt.id); assert.equal(sends, 1); assert.equal(reads, 3);
  } finally { await f.cleanup(); }
});

test('SDK stop route carries original authority after node guards without synchronous store access', async t => {
  let stops = 0, reads = 0;
  const receipt = { id: 'original-stop-receipt', key: 'http-stop', state: 'accepted' as const, createdAt: 1, updatedAt: 1,
    result: { status: 200, body: { ok: true, status: 'interrupt_requested', runId: 'original-run', idempotencyKey: 'http-stop', media: [] } } };
  const observed = { runtime: 'ghcp' as const, key: 'ghcp:original', commandKey: 'http-stop', receipt, queue: { presence: 'absent' as const } };
  const f = createConnectorFixture(undefined, false, false, undefined, undefined, undefined, undefined, {
    ready: () => false,
    stop: async input => { stops++; assert.equal(input.authorization, 'Bearer original-stop-authority');
      assert.deepEqual(JSON.parse(input.payloadJson), { message: '/stop', expectedRunId: 'original-run' });
      return { runtime: 'ghcp', key: observed.key, commandKey: 'http-stop', receipt, execution: null }; },
    messages: { send: async () => { throw Error('stop entered send queue'); },
      readSendReceipt: async () => { reads++; return observed; }, readReceipt: async () => observed },
  });
  try {
    t.mock.method(f.tokens, 'authenticate', () => { throw Error('old synchronous stop authority'); });
    t.mock.method(f.connectorUsers.commands, 'get', () => { throw Error('old synchronous stop receipt'); });
    const post = (headers: Record<string, string> = {}) => f.app.request('/api/connector/v1/sessions/ghcp:original/messages', {
      method: 'POST', headers: { authorization: 'Bearer original-stop-authority', ...headers },
      body: JSON.stringify({ message: '/stop', expectedRunId: 'original-run', idempotencyKey: 'http-stop' }),
    });
    assert.equal((await post({ [CONNECTOR_PROTOCOL_HEADER]: '999' })).status, 426);
    assert.equal((await post({ [EXPECTED_NODE_HEADER]: 'wrong-node' })).status, 409); assert.equal(stops + reads, 0);
    assert.equal((await post({ 'x-agentopsdeck-execution-grant': '' })).status, 403); assert.equal(stops + reads, 0);
    const response = await post(); assert.equal(response.status, 200);
    assert.equal((await response.json()).command.id, receipt.id); assert.equal(stops, 1); assert.equal(reads, 2);
  } finally { await f.cleanup(); }
});

for (const runtime of ['claude-code', 'ghcp'] as const) test(`${runtime}: async queue routes obey node/protocol gate and never enter old authority or queue`, async t => {
  let calls = 0;
  const key = `${runtime}:original`, receipt = { id: 'original-mutation', key: 'edit', state: 'accepted' as const, createdAt: 1, updatedAt: 1,
    result: { status: 200, body: { ok: true } } };
  const view = { key, targetId: 'message', receipt };
  const record = () => { calls++; };
  const f = createConnectorFixture(undefined, false, false, undefined, undefined, undefined, undefined, undefined, undefined, {
    ready: () => true,
    queue: { page: async input => { record(); assert.equal(input.authorization, 'Bearer original-http'); return { key, page: { items: [], nextCursor: null } }; },
      commandPage: async () => { record(); return { key, page: { items: [], nextCursor: null } }; },
      readReceipt: async () => { record(); return view; },
      edit: async input => { record(); assert.equal(input.text, 'Updated'); return { ...view, changed: true }; },
      cancel: async () => { record(); return { ...view, changed: true }; } },
  });
  try {
    t.mock.method(f.tokens, 'authenticate', () => { throw Error('old synchronous authority'); });
    t.mock.method(f.connectorUsers.commands, 'get', () => { throw Error('old synchronous receipts'); });
    t.mock.method(f.connectorUsers.turns, 'summaryPage', () => { throw Error('old synchronous queue'); });
    const path = `/api/connector/v1/sessions/${key}`;
    const request = (suffix: string, headers: Record<string, string> = {}, patch = false) => f.app.request(`${path}${suffix}`, { method: patch ? 'PATCH' : 'GET',
      headers: { authorization: 'Bearer original-http', ...headers }, ...(patch ? { body: JSON.stringify({ message: '  Updated  ' }) } : {}) });
    assert.equal((await request('/queue', { [CONNECTOR_PROTOCOL_HEADER]: '0' })).status, 426);
    assert.equal((await request('/queue', { [EXPECTED_NODE_HEADER]: 'wrong-node' })).status, 409); assert.equal(calls, 0);
    for (const suffix of ['/queue', '/queue/commands', '/queue/message/commands/edit', '/commands/original-send/queue/commands/edit']) {
      const result = await request(suffix); assert.equal(result.status, 200); assert.equal(result.headers.get(NODE_ID_HEADER), f.connectorUsers.nodeId);
    }
    const edit = await request('/queue/message', { 'if-match': '"1:1"', 'idempotency-key': 'edit' }, true);
    assert.equal(edit.status, 200); assert.equal((await edit.json()).command.id, receipt.id); assert.equal(calls, 7);
  } finally { await f.cleanup(); }
});

for (const runtime of ['claude-code', 'ghcp'] as const) test(`${runtime}: async deletion and recovery bypass legacy authority after node/protocol gates`, async t => {
  let reads = 0, removals = 0, committed = false;
  const key = `${runtime}:original`, authorization = 'Bearer original-delete-authority';
  const receipt = { id: 'original-deletion', key: 'delete', state: 'accepted' as const, createdAt: 1, updatedAt: 1,
    result: { status: 200, body: { ok: true, status: 'delete_accepted' } } };
  const sdkDeletion: SdkDeletionHttp = {
    owner: { command: async (kind, input) => {
      reads++; assert.equal(kind, 'sdkDeletionReceiptRead');
      assert.deepEqual(input, { runtime, key, authorization, commandKey: 'delete' });
      return { runtime, key, commandKey: 'delete', receipt: committed ? receipt : null };
    } } as SdkDeletionHttp['owner'],
    ready: () => true,
    remove: async (actualRuntime, actualKey, commandKey, actualAuthorization) => {
      assert.deepEqual([actualRuntime, actualKey, commandKey, actualAuthorization], [runtime, key, 'delete', authorization]);
      removals++; committed = true; return { runtime, key, receipt, intent: null, admitted: false, nativeRequired: false };
    },
  };
  const f = createConnectorFixture(undefined, false, false, undefined, undefined, undefined, undefined, undefined, undefined, undefined, sdkDeletion);
  try {
    t.mock.method(f.tokens, 'authenticate', () => assert.fail('Legacy synchronous authority must not handle owned deletion'));
    t.mock.method(f.connectorUsers.commands, 'get', () => assert.fail('Legacy synchronous receipts must not handle owned deletion'));
    const path = `/api/connector/v1/sessions/${key}`;
    const remove = (headers: Record<string, string> = {}) => f.app.request(path, { method: 'DELETE',
      headers: { authorization, 'idempotency-key': 'delete', ...headers } });
    assert.equal((await remove({ [CONNECTOR_PROTOCOL_HEADER]: '0' })).status, 426);
    assert.equal((await remove({ [EXPECTED_NODE_HEADER]: 'wrong-node' })).status, 409);
    assert.equal(reads + removals, 0);
    const result = await remove(); assert.equal(result.status, 200);
    assert.equal(result.headers.get(NODE_ID_HEADER), f.connectorUsers.nodeId);
    assert.equal((await result.json()).command.id, receipt.id);
    const recovered = await f.app.request(`${path}/deletion-commands/delete`, { headers: { authorization } });
    assert.equal(recovered.status, 200); assert.equal((await recovered.json()).command.id, receipt.id);
    assert.equal((await remove()).status, 200); assert.equal(removals, 1); assert.equal(reads, 4);
  } finally { await f.cleanup(); }
});

for (const runtime of ['claude-code', 'ghcp'] as const) test(`${runtime}: async compact and recovery bypass synchronous guards after node/protocol gates`, async t => {
  const key = `${runtime}:original`, authorization = 'Bearer original-compact-authority';
  let reads = 0, compactions = 0, committed = false;
  const receipt = { id: 'original-compact', key: 'compact', state: 'accepted' as const, createdAt: 1, updatedAt: 1,
    result: { status: 200, body: { ok: true, status: 'compacting', runId: 'run' } } };
  const sdkCompact: SdkCompactHttp = { owner: { command: async (kind: string, raw: unknown) => {
    const input = raw as { runtime: string; key: string; authorization: string; purpose: string; commandKey: string };
    reads++; assert.equal(kind, 'sdkCompactReceiptRead');
    assert.equal(input.runtime, runtime); assert.equal(input.key, key); assert.equal(input.authorization, authorization);
    assert.ok(['read', 'mutation'].includes(input.purpose));
    return { runtime, key, commandKey: input.commandKey, receipt: committed && input.commandKey === 'compact' ? receipt : null };
  } } as SdkCompactHttp['owner'], ready: () => true,
  compact: async (actualRuntime, actualKey, commandKey, actualAuthorization) => {
    assert.deepEqual([actualRuntime, actualKey, commandKey, actualAuthorization], [runtime, key, 'compact', authorization]);
    compactions++; committed = true; return 'accepted';
  } };
  const f = createConnectorFixture(undefined, false, false, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, sdkCompact);
  try {
    t.mock.method(f.tokens, 'authenticate', () => assert.fail('No legacy authority for async compact'));
    t.mock.method(f.connectorUsers.commands, 'get', () => assert.fail('No legacy compact receipt'));
    const path = `/api/connector/v1/sessions/${key}`;
    const request = (headers: Record<string, string> = {}) => f.app.request(`${path}/compact`, { method: 'POST',
      headers: { authorization, 'idempotency-key': 'compact', ...headers }, body: '{}' });
    assert.equal((await request({ [CONNECTOR_PROTOCOL_HEADER]: '0' })).status, 426);
    assert.equal((await request({ [EXPECTED_NODE_HEADER]: 'wrong-node' })).status, 409); assert.equal(reads + compactions, 0);
    const first = await request(); assert.equal(first.status, 200); assert.equal((await first.json()).command.id, receipt.id);
    assert.equal(first.headers.get(NODE_ID_HEADER), f.connectorUsers.nodeId);
    const recovered = await f.app.request(`${path}/compact-commands/compact`, { headers: { authorization } });
    assert.equal(recovered.status, 200); assert.equal((await recovered.json()).command.id, receipt.id);
    assert.equal((await request()).status, 200); assert.equal(compactions, 1); assert.equal(reads, 6);
  } finally { await f.cleanup(); }
});

test('Hermes queue routes preserve node/protocol gates and never call legacy synchronous authority', async t => {
  const key = 'hermes:original'; let calls = 0;
  const receipt = { id: 'original-mutation', key: 'edit', state: 'accepted' as const, createdAt: 1, updatedAt: 1,
    result: { status: 200, body: { ok: true } } };
  const view = { key, targetId: 'message', receipt };
  const f = createConnectorFixture(undefined, false, false, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, {
      ready: () => true,
      queue: { page: async input => { calls++; assert.equal(input.authorization, 'Bearer original-http'); return { key, page: { items: [], nextCursor: null } }; },
        commandPage: async () => { calls++; return { key, page: { items: [], nextCursor: null } }; },
        readReceipt: async () => { calls++; return view; },
        edit: async input => { calls++; assert.equal(input.text, 'Updated'); return { ...view, changed: true }; },
        cancel: async () => { calls++; return { ...view, changed: true }; } },
    });
  try {
    t.mock.method(f.tokens, 'authenticate', () => { throw Error('legacy synchronous authority'); });
    t.mock.method(f.connectorUsers.commands, 'get', () => { throw Error('legacy synchronous receipts'); });
    t.mock.method(f.connectorUsers.turns, 'summaryPage', () => { throw Error('legacy synchronous queue'); });
    const path = `/api/connector/v1/sessions/${key}`;
    for (const [header, value, status] of [[CONNECTOR_PROTOCOL_HEADER, '0', 426], [EXPECTED_NODE_HEADER, 'wrong-node', 409]] as const)
      assert.equal((await f.app.request(`${path}/queue`, { headers: { authorization: 'Bearer original-http', [header]: value } })).status, status);
    assert.equal(calls, 0);
    for (const suffix of ['/queue', '/queue/commands', '/queue/message/commands/edit', '/commands/send/queue/commands/edit']) {
      const r = await f.app.request(`${path}${suffix}`, { headers: { authorization: 'Bearer original-http' } });
      assert.equal(r.status, 200); assert.equal(r.headers.get(NODE_ID_HEADER), f.connectorUsers.nodeId);
    }
    const edited = await f.app.request(`${path}/queue/message`, { method: 'PATCH', headers: {
      authorization: 'Bearer original-http', 'if-match': '"1:1"', 'idempotency-key': 'edit' }, body: JSON.stringify({ message: ' Updated ' }) });
    assert.equal(edited.status, 200); assert.equal(calls, 7);
  } finally { await f.cleanup(); }
});

function createConnectorFixture(codex?: any, durableEvents = false, boards = false, sdkRuntime?: 'claude-code' | 'ghcp', eventReplay?: EventReplayRead, eventSnapshot?: EventSnapshotRead, eventReadWaitMs?: number, sdkMessages?: SdkMessagesHttp, sdkLocal?: SdkLocalHttp, sdkQueue?: SdkQueueHttp, sdkDeletion?: SdkDeletionHttp, sdkCompact?: SdkCompactHttp, sdkApplication?: AsyncSdkApplicationHttp, hermesMessages?: HermesMessagesHttp, hermesDeletion?: HermesDeletionHttp, hermesQueue?: HermesQueueHttp, hermesApplication?: AsyncHermesApplicationHttp, openclawApplication?: AsyncOpenClawApplicationHttp, automationConfiguration?: AsyncAutomationHttp['configuration'], codexInteractions?: CodexInteractionsHttp, codexCatalog?: CodexCatalogHttp, codexSettings?: CodexSettingsHttp, codexDeletion?: CodexDeletionHttp, codexPublicUsage?: CodexPublicUsageHttp, codexFiles?: CodexFilesHttp, control?: ConnectorControlHttp) {

  const previousHome = process.env.HOME;
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-connector-test-'));
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  const config = loadConfig({
    AOD_CONNECTOR_TOKENS_FILE: join(dir, 'tokens.json'),
    AOD_CONNECTOR_USERS_DATABASE_FILE: join(dir, 'connector-users.sqlite'),
    AOD_SESSION_TITLES_FILE: join(dir, 'titles.json'),
    AOD_CONNECTOR_ENV_ID: 'connector-env',
    AOD_CONNECTOR_ENV_LABEL: 'Connector Env',
    AOD_LOCAL_OPENCLAW_CLI: 'true',
  } as NodeJS.ProcessEnv);
  if (boards) {
    const directory = join(dir, 'private-boards');
    mkdirSync(directory, { mode: 0o700 });
    config.codex.boardToolsDirectory = directory;
    config.boardBindingPolicies = [{ owner: 'local:boards', runtime: 'codex', endpoint: 'http://127.0.0.1:8791/api/workspace-agent/v1/board' }];
  }
  const app = new Hono();
  const tokens = new ConnectorTokenStore(config.connector.tokenFile);
  const connectorUsers = new ConnectorUserStore(config.connector.usersDatabaseFile, undefined, { runtimeOwner: !!sdkRuntime || !!openclawApplication || !!automationConfiguration || !!codexInteractions || !!codexCatalog || !!codexSettings || !!codexDeletion || !!codexPublicUsage || !!codexFiles });
  const store = new DeckStore({ sessionTitlesFile: config.sessionTitlesFile, ...(durableEvents ? { eventLog: connectorUsers.events } : {}) });
  const gateway: { request: (...args: any[]) => Promise<any>; requestBound: (...args: any[]) => Promise<any>; connectionId: () => string | undefined } = {
    request: async () => ({ runId: 'test-run', status: 'started' }),
    requestBound: async (...args) => { args[3]?.(); return { payload: await gateway.request(...args), connectionId: 'synthetic-connection' }; },
    connectionId: () => 'synthetic-connection',
  };
  const queue = new OpenClawTurnQueue({ authorizeTurn: () => true, turns: connectorUsers.turns, executions: connectorUsers.openClawExecutions, store,
    mirrorOutbox: connectorUsers.mirrorOutbox,
    refreshSessions: async () => undefined, refreshMessages: async () => undefined, mirror: async () => undefined,
    send: createOpenClawDispatch({ authorizeTurn: () => true, executions: connectorUsers.openClawExecutions, gateway: gateway as any, store, allowCliFallback: config.localOpenClawCli, message: (text) => text }) });
  const sdk = sdkRuntime ? { ready: true, owns: (key: string) => key.startsWith(sdkRuntime + ':'),
    commands: new SdkCommands({ runtime: sdkRuntime, store: connectorUsers,
      journal: sdkRuntime === 'ghcp' ? connectorUsers.copilotJournal : connectorUsers.claudeJournal,
      driver: { wake: async () => {}, interrupt: async () => 'not_started' },
      assertAvailable: () => {}, authorize: () => true, changed: () => {}, models: { model: 'fixture' } }),
  } : undefined;
  const readiness = { sessions: true, history: true };
  const routes = registerConnectorRoutes(app, {
    sessionSnapshotReady: () => readiness.sessions, historySnapshotReady: () => readiness.history,
    config,
    tokens,
    ...(control ? { control } : {}),
    ...(sdkMessages ? { sdkMessages } : {}),
    ...(hermesMessages ? { hermesMessages } : {}),
    ...(hermesDeletion ? { hermesDeletion } : {}),
    ...(hermesQueue ? { hermesQueue } : {}),
    ...(hermesApplication ? { hermesApplication } : {}),
    ...(sdkLocal ? { sdkLocal } : {}),
    ...(sdkQueue ? { sdkQueue } : {}),
    ...(sdkDeletion ? { sdkDeletion } : {}),
    ...(sdkCompact ? { sdkCompact } : {}),
    ...(sdkApplication ? { sdkApplication } : {}),
    ...(openclawApplication ? { openclawApplication } : {}),
    ...(automationConfiguration ? { automationConfiguration } : {}),
    ...(codexInteractions ? { codexInteractions } : {}),
    ...(codexCatalog ? { codexCatalog } : {}),
    ...(codexSettings ? { codexSettings } : {}),
    ...(codexDeletion ? { codexDeletion } : {}),
    ...(codexPublicUsage ? { codexPublicUsage } : {}),
    ...(codexFiles ? { codexFiles } : {}),
    ...(eventReplay ? { eventReplay } : {}),
    ...(eventSnapshot ? { eventSnapshot } : {}),
    ...(eventReadWaitMs === undefined ? {} : { eventReadWaitMs }),
    connectorUsers,
    store,
    gateway: gateway as any,
    ...(!openclawApplication ? { openclawQueue: queue } : {}),
    ...(codex ? { codex } : {}),
    ...(sdkRuntime === 'claude-code' ? { claude: sdk as any } : sdkRuntime === 'ghcp' ? { copilot: sdk as any } : {}),
    refreshSessions: async () => undefined,
    refreshMessages: async () => undefined,
    fallbackAgents: () => [],
    isAuthorizedRequest: () => true,
    normalizeError: (error) => error instanceof Error ? error.message : String(error),
  });
  return {
    readiness,
    routes,
    app,
    tokens,
    store,
    connectorUsers,
    gateway,
    queue,
    config,
    home,
    dir,
    cleanup: async () => {
      await routes.close();
      await queue.close();
      connectorUsers.close();
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
