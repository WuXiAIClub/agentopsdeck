import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { loadConfig } from '../config.js';
import { createConnectorRuntime } from './runtime.js';
import { CONNECTOR_PROTOCOL_HEADER } from '@agentopsdeck/shared';
import { EXPECTED_NODE_HEADER, NODE_ID_HEADER } from './node-identity.js';
import { serve } from '@hono/node-server';
import { MaintenanceConnectorClient } from '../lifecycle/maintenance-connector-client.js';
import { newMaintenanceJob } from '../lifecycle/connector-maintenance.js';
import { recordStoppedCodexRecovery } from '../codex/stopped-recovery.js';
import { projectClaudeMessage } from '../claude/message-projection.js';
import { projectCopilotMessage } from '../copilot/message-projection.js';
import { CodexAppServer } from '../codex/app-server.js';
import { asyncVolumeAdmission } from '../storage/async-volume-admission.js';
import { StorageAdmissionDeferred } from '../storage/work-admission.js';
import { ConnectorUpdateService } from './update-service.js';


for (const change of ['native', 'authority', 'shutdown'] as const) {
  test(`final maintenance status await cannot publish stale ${change} proof`, async context => {
    const setup = fixture(context), runtime = setup.runtime;
    let current = true, calls = 0;
    let entered!: () => void, finish!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { finish = resolve; });
    context.mock.method(runtime.codex, 'inspectMaintenance', async () => ({
      activeRuns: 0, backgroundTerminals: 0, inFlightWrites: 0,
      assertCurrent() { if (!current) throw Error('PRIVATE_STALE_NATIVE'); },
    }));
    const original = ConnectorUpdateService.prototype.maintenanceStatus;
    context.mock.method(ConnectorUpdateService.prototype, 'maintenanceStatus', async function(this: ConnectorUpdateService, authorize?: () => void) {
      const result = await original.call(this, authorize);
      if (++calls === 2) { entered(); await held; }
      return result;
    });
    const response = setup.inspect();
    try {
      await started;
      if (change === 'native') current = false;
      else if (change === 'shutdown') void runtime.stopAdmissions();
      else {
        const tokens = new ConnectorTokenStore(setup.config.connector.tokenFile);
        const principal = tokens.authenticate(new Request('http://local.test', { headers: { authorization: `Bearer ${setup.lifecycle}` } }))!;
        tokens.revoke(principal.tokenId);
      }
    } finally { finish(); }
    const result = await response;
    assert.equal(result.status, change === 'authority' ? 403 : 503);
    assert.doesNotMatch(await result.text(), /nativeVerified|PRIVATE/);
  });
}

function fixture(context: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-maintenance-runtime-'));
  const config = loadConfig({ AOD_SERVER_ROLE: 'connector', AOD_CODEX_ENABLED: 'false', AOD_LOCAL_OPENCLAW_CLI: 'false',
    AOD_CONNECTOR_USERS_DATABASE_FILE: join(directory, 'connector.sqlite'), AOD_CONNECTOR_TOKENS_FILE: join(directory, 'tokens.json'),
    AOD_SESSION_TITLES_FILE: join(directory, 'titles.json'), AOD_QUEUE_FILE: join(directory, 'queue.json'),
    AOD_MIRROR_OUTBOX_FILE: join(directory, 'mirror.json'), AOD_ARTIFACT_INDEX_FILE: join(directory, 'artifacts.json'),
    AOD_CONNECTOR_UPDATE_STATE_FILE: join(directory, 'update.json'), AOD_CONNECTOR_UPDATE_ENABLED: 'false' });
  const tokens = new ConnectorTokenStore(config.connector.tokenFile);
  const alice = tokens.create({ label: 'synthetic alice', scopes: ['connector:update'] }).token;
  const bob = tokens.create({ label: 'synthetic bob', scopes: ['connector:update'] }).token;
  const lifecycle = tokens.create({ label: 'synthetic lifecycle', scopes: ['connector:lifecycle'] }).token;
  const lifecycleOther = tokens.create({ label: 'other lifecycle', scopes: ['connector:lifecycle'] }).token;
  let runtime = createConnectorRuntime(config, () => false);
  const install = () => {
    runtime.app.post('/synthetic-write', context => context.text('written'));
    runtime.app.get('/synthetic-read', context => context.text('read'));
  };
  install();
  context.after(async () => { await runtime.close(); rmSync(directory, { recursive: true, force: true }); });
  const request = async (path: string, body?: unknown, token = alice) => runtime.app.request(`/api/connector/v1/maintenance/${path}`,
    { ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), headers: { authorization: `Bearer ${token}` } });
  const reopen = async () => { await runtime.close(); runtime = createConnectorRuntime(config, () => false); install(); return runtime; };
  const inspect = () => runtime.app.request('/api/connector/v1/maintenance/inspection', { headers: {
    authorization: `Bearer ${lifecycle}`, [CONNECTOR_PROTOCOL_HEADER]: '1', [EXPECTED_NODE_HEADER]: runtime.connectorUsers.nodeId,
  } });
  return { config, request, reopen, inspect, alice, bob, lifecycle, lifecycleOther, get runtime() { return runtime; } };
}

for (const operation of ['maintenance/commands/pause', 'update/commands/rollback'] as const) {
  test(`${operation} deferred receipt admission returns sanitized retryable 503`, async context => {
    const setup = fixture(context);
    setup.config.connector.updateEnabled = true;
    context.mock.method(asyncVolumeAdmission, 'run', async () => {
      throw new StorageAdmissionDeferred('PRIVATE_COORDINATOR_DETAIL');
    });
    const response = await setup.runtime.app.request(`/api/connector/v1/${operation}`, {
      method: 'POST', body: JSON.stringify({ idempotencyKey: 'deferred' }),
      headers: { authorization: `Bearer ${setup.alice}` },
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'Command storage admission unavailable' });
    const actor = new ConnectorTokenStore(setup.config.connector.tokenFile).authenticate(
      new Request('http://synthetic.test', { headers: { authorization: `Bearer ${setup.alice}` } }))!.tokenId;
    const scope = JSON.stringify([operation.startsWith('maintenance') ? 'maintenance' : 'update',
      JSON.stringify([setup.runtime.connectorUsers.nodeId, actor, operation.endsWith('pause') ? 'pause' : 'rollback'])]);
    assert.equal(setup.runtime.connectorUsers.commands.get(scope, 'deferred'), undefined);
    assert.equal((await setup.request('status')).status, 200, 'status remains available after deferred admission');
  });
}

for (const failedIndex of [0, 1]) test(`startup recovery isolates terminal failure at index ${failedIndex}`, async context => {
  const setup = fixture(context);
  const keys = ['codex:startup-a', 'codex:startup-b', 'codex:startup-c'];
  for (const key of keys) {
    const facts = setup.runtime.connectorUsers.codexExecutions;
    facts.begin(key, key, 'old');
    facts.acknowledge(key, key, 'old', key, () => {});
    facts.observe(key, 'old', key, 'failed');
    facts.settleHistory({ sessionKey: key, commandId: key, runId: key }, 'error');
    await setup.runtime.connectorUsers.turns.enqueueAsync('codex', { id: `${key}:queued`, sessionKey: key,
      createdAt: 1, payload: { text: 'private queued input', images: [] } });
  }
  const recovered: string[] = [], warnings: unknown[][] = [];
  let workerStarts = 0;
  let finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  context.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args); });
  context.mock.method(CodexAppServer.prototype, 'recoverMaintenanceHistory', async (key: string, check: () => void) => {
    check();
    recovered.push(key);
    if (key === keys[failedIndex]) throw new Error('PRIVATE_NATIVE_TRANSCRIPT');
  });
  context.mock.method(CodexAppServer.prototype, 'startQueueWorker', () => { workerStarts++; finish(); });
  const runtime = await setup.reopen();
  await finished;
  assert.deepEqual(recovered, keys, 'failed native proof does not skip later sessions');
  assert.equal(workerStarts, 1);
  assert.equal(warnings.length, 1);
  assert.equal(JSON.stringify(warnings).includes('PRIVATE'), false);
  assert.equal(JSON.stringify(warnings).includes(keys[failedIndex]!), false);
  assert.deepEqual(warnings[0], ['[codex-startup-history-recovery-pending]', { phase: 'failed' }]);
  for (const key of keys) {
    const fact = runtime.connectorUsers.codexExecutions.get(key)!;
    assert.equal(fact.sync, 'error', 'only native recovery may settle history');
    assert.equal(fact.commandId, key);
    assert.equal(fact.runId, key);
    assert.equal(runtime.connectorUsers.turns.head('codex', key)?.id, `${key}:queued`);
    assert.equal(runtime.connectorUsers.turns.head('codex', key)?.state, 'queued');
  }
});

test('early interrupted history needs exact stopped proof, not a fabricated assistant reply', async context => {
  const setup = fixture(context), runtime = setup.runtime, sessionKey = 'codex:early-stop';
  setup.config.connector.revision = 'a'.repeat(40);
  const facts = runtime.connectorUsers.codexExecutions;
  facts.begin(sessionKey, 'original', 'connection');
  facts.acknowledge(sessionKey, 'original', 'connection', 'run', () => {});
  assert.equal(facts.observe(sessionKey, 'connection', 'run', 'interrupted'), true);
  facts.settleHistory(facts.get(sessionKey)!, 'error');
  const run = facts.maintenanceRecoveryRuns()![0]!;
  // Synthetic OS proof only: actual stopped-service writing is covered by the
  // node adapter tests. This fixture never starts an Agent or stops a service.
  const db = (runtime.connectorUsers as unknown as { db: DatabaseSync }).db;
  db.exec('PRAGMA synchronous=FULL');
  context.mock.getter(runtime.codex, 'enabled', () => true);
  context.mock.method(runtime.codex, 'refreshSessions', async () => {
    runtime.store.upsertSession({ sessionKey, agentId: 'codex', title: 'Synthetic', status: 'idle', hasActiveRun: false,
      runtime: { phase: 'interrupted', sync: 'current', connection: 'connected', lastEventAt: 1 } });
  });
  context.mock.method(runtime.codex, 'isSessionListReady', () => true);
  context.mock.method(runtime.codex, 'isSessionHistoryReady', () => true);
  const hydrate = async () => {
    facts.settleHistory(facts.get(sessionKey)!, 'current');
    runtime.store.addMessage({ sessionKey, id: 'user', role: 'user', text: 'private original input', createdAt: 1 });
  };
  context.mock.method(runtime.codex, 'recoverMaintenanceHistory', hydrate);
  context.mock.method(runtime.codex, 'refreshSession', hydrate);
  const headers = { authorization: `Bearer ${setup.lifecycle}`, [EXPECTED_NODE_HEADER]: runtime.connectorUsers.nodeId,
    [CONNECTOR_PROTOCOL_HEADER]: '1', 'Content-Type': 'application/json' };
  const paused = await runtime.app.request('/api/connector/v1/maintenance/commands/pause', {
    method: 'POST', headers, body: JSON.stringify({ idempotencyKey: 'early-stop-fence' }),
  });
  const { fenceId } = await paused.json();
  const probe = () => runtime.app.request('/api/connector/v1/maintenance/readiness', {
    method: 'POST', headers, body: JSON.stringify({ sessionKey, fenceId }),
  });
  assert.equal((await probe()).status, 503, 'projected interrupted/idle is not stopped proof');
  facts.settleHistory(facts.get(sessionKey)!, 'error');
  recordStoppedCodexRecovery(db, [run], { nodeId: runtime.connectorUsers.nodeId, jobId: 'synthetic-stop',
    fenceId, backupId: 'synthetic-backup', verifiedAt: Date.now() });
  const response = await probe(), proof = await response.json();
  assert.equal(response.status, 200);
  assert.equal(proof.recoveredRunId, 'run');
  assert.equal(proof.messageCount, 1);
  assert.equal(JSON.stringify(proof).includes('private original'), false);
  assert.deepEqual(runtime.store.getMessages(sessionKey).map(message => message.role), ['user']);
  assert.equal((await runtime.app.request('/synthetic-write', { method: 'POST' })).status, 503);
});

test('independent supervisor transport uses lifecycle-only credential over HTTP and preserves its fence across Connector restart', async context => {
  const setup = fixture(context);
  let server!: ReturnType<typeof serve>;
  const address = await new Promise<{ port: number }>(resolve => {
    server = serve({ fetch: request => setup.runtime.app.fetch(request), hostname: '127.0.0.1', port: 0 }, resolve);
  });
  context.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  let authorized = true;
  const client = new MaintenanceConnectorClient({ connectorUrl: `http://127.0.0.1:${address.port}`,
    nodeId: setup.runtime.connectorUsers.nodeId, credential: () => setup.lifecycle,
    authorize: () => { if (!authorized) throw new Error('revoked'); } });
  const createdAt = Date.now();
  const job = newMaintenanceJob({ id: 'job:transport', nodeId: setup.runtime.connectorUsers.nodeId,
    actorId: 'synthetic-supervisor-actor', operation: 'restart', createdAt, deadline: createdAt + 60_000 });
  assert.equal((await client.inspect(job)).nativeVerified, true);
  const fence = await client.fence(job);
  const fenced = { ...job, fenceId: fence.fenceId };
  assert.equal((await setup.runtime.app.request('/synthetic-write', { method: 'POST' })).status, 503);
  assert.equal((await client.inspect(fenced)).fenceId, fence.fenceId);
  await setup.reopen();
  assert.equal((await client.inspect(fenced)).fenceId, fence.fenceId);
  assert.equal((await client.releaseFence(fenced)).released, true);
  assert.equal((await setup.runtime.app.request('/synthetic-write', { method: 'POST' })).status, 200);
  authorized = false;
  await assert.rejects(client.fence({ ...job, revision: 2 }), /unverified/);
  assert.equal((await setup.runtime.app.request('/synthetic-write', { method: 'POST' })).status, 200);
});

test('fenced business probe requires lifecycle authority and an existing completed business history', async context => {
  const setup = fixture(context), runtime = setup.runtime;
  const headers = { authorization: `Bearer ${setup.lifecycle}`, [EXPECTED_NODE_HEADER]: runtime.connectorUsers.nodeId,
    [CONNECTOR_PROTOCOL_HEADER]: '1', 'Content-Type': 'application/json' };
  const sessionKey = 'codex:business-probe';
  const send = (body: unknown, extra = {}) => runtime.app.request('/api/connector/v1/maintenance/readiness', {
    method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body),
  });
  const pause = await runtime.app.request('/api/connector/v1/maintenance/commands/pause', {
    method: 'POST', headers, body: JSON.stringify({ idempotencyKey: 'business-fence' }),
  });
  assert.equal(pause.status, 200);
  const { fenceId } = await pause.json(), body = { fenceId, sessionKey };
  assert.equal((await send(body, { authorization: `Bearer ${setup.alice}` })).status, 403);
  assert.equal((await send(body, { Origin: 'https://synthetic.test' })).status, 403);
  assert.equal((await send(body, { [CONNECTOR_PROTOCOL_HEADER]: '' })).status, 426);
  assert.equal((await send(body, { [EXPECTED_NODE_HEADER]: 'other-node' })).status, 409);
  for (const invalid of [null, { ...body, shell: 'ignored' }, { ...body, sessionKey: '../file' }]) {
    assert.equal((await send(invalid)).status, 400);
  }
  assert.equal((await send(body)).status, 503, 'disabled native runtime must not certify an empty projection');

  // This exercises actual runtime fences, routes, stores and receipts with a
  // synthetic native projection. It does not launch or certify a real Agent.
  setup.config.connector.revision = 'a'.repeat(40);
  context.mock.getter(runtime.codex, 'enabled', () => true);
  context.mock.method(runtime.codex, 'refreshSessions', async () => {
    runtime.store.upsertSession({ sessionKey, agentId: 'codex', title: 'Synthetic', status: 'idle', hasActiveRun: false,
      runtime: { phase: 'completed', sync: 'current', connection: 'connected', lastEventAt: 1 } });
  });
  context.mock.method(runtime.codex, 'isSessionListReady', () => true);
  context.mock.method(runtime.codex, 'isSessionHistoryReady', () => true);
  let withHistory = false;
  context.mock.method(runtime.codex, 'refreshSession', async () => {
    if (!withHistory) return;
    runtime.store.addMessage({ sessionKey, id: 'probe:user', role: 'user', text: 'private question', createdAt: 1 });
    runtime.store.addMessage({ sessionKey, id: 'probe:reply', role: 'assistant', text: 'private answer', createdAt: 2 });
  });
  assert.equal((await send(body)).status, 503, 'healthy empty projection is not successful history verification');
  withHistory = true;
  const response = await send(body), proof = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual({ ...proof, observedAt: 1 }, { nodeId: runtime.connectorUsers.nodeId, fenceId, observedAt: 1,
    revision: 'a'.repeat(40), sessionKey, messageCount: 2, projectionVerified: true, businessReadVerified: true,
    preservation: { queueSha256: createHash('sha256').update('[]').digest('hex') } });
  assert.equal(JSON.stringify(proof).includes('private'), false, 'lifecycle scope does not expose transcript contents');
  assert.equal((await runtime.app.request('/synthetic-write', { method: 'POST' })).status, 503);
  assert.equal((await runtime.app.request(`/api/connector/v1/sessions/${sessionKey}/messages`, { headers })).status, 503);
  assert.equal((await send(body, { authorization: `Bearer ${setup.lifecycleOther}` })).status, 409, 'fence is actor-bound');
  assert.equal((await send({ ...body, fenceId: '11111111-1111-4111-8111-111111111111' })).status, 409);
});

for (const agent of ['claude-code', 'ghcp'] as const)
for (const mode of ['alone', 'mixed', 'unknown']) test(`paused ${agent} restart verifies bounded history: ${mode}`, async context => {
  const unknownExecution = mode === 'unknown';
  const setup = fixture(context), initial = setup.runtime;
  const homeDirectory = join(initial.connectorUsers.runtimeOwnerFile!, '..', `${agent}-home`);
  mkdirSync(homeDirectory, { mode: 0o700 });
  const key = `${agent}:business`, ref = { key, id: 'original', epoch: 'fixture' };
  const journal = agent === 'ghcp' ? initial.connectorUsers.copilotJournal : initial.connectorUsers.claudeJournal;
  const { claudeTranscript: transcript, turns } = initial.connectorUsers;
  journal.create({ key, nativeSessionId: 'native', title: 'Fixture', createdAt: 1 });
  await turns.enqueueAsync(agent, { id: 'input', sessionKey: key, createdAt: 1, payload: { text: 'PRIVATE_QUESTION' } });
  journal.begin(ref, ['input'], turns);
  for (const type of ['user', 'assistant']) {
    const content = type === 'user' ? 'PRIVATE_QUESTION' : 'PRIVATE_ANSWER';
    if (agent === 'claude-code') transcript.append(ref, projectClaudeMessage({ type,
      uuid: type === 'user' ? ref.id : 'reply', session_id: 'native', parent_tool_use_id: null,
      message: { role: type, content } }, 'native'));
    else initial.connectorUsers.copilotTranscript.append(ref, projectCopilotMessage({ id: type,
      type: `${type}.message`, timestamp: new Date(1).toISOString(), data: { messageId: type, content } })!, 'PRIVATE_QUESTION');
  }
  journal.observeTerminal(ref, 'completed', turns); journal.confirmSettled(ref);
  if (unknownExecution) {
    const other = `${agent}:unconfirmed`;
    journal.create({ key: other, nativeSessionId: 'other', title: '', createdAt: 2 });
    await turns.enqueueAsync(agent, { id: 'pending', sessionKey: other, createdAt: 2, payload: {} });
    assert.ok(journal.begin({ key: other, id: 'other', epoch: 'epoch' }, ['pending'], turns));
  }
  const headers = { authorization: `Bearer ${setup.lifecycle}`, [CONNECTOR_PROTOCOL_HEADER]: '1',
    [EXPECTED_NODE_HEADER]: initial.connectorUsers.nodeId, 'content-type': 'application/json' };
  const pause = await initial.app.request('/api/connector/v1/maintenance/commands/pause', {
    method: 'POST', headers, body: JSON.stringify({ idempotencyKey: 'claude-fence' }),
  });
  assert.equal(pause.status, 200); const { fenceId } = await pause.json();
  setup.config.connector.revision = 'a'.repeat(40);
  if (agent === 'claude-code') setup.config.claude = { homeDirectory, workspace: join(homeDirectory, '..', 'workspace'),
    apiKeyFile: join(homeDirectory, 'ABSENT_KEY'), sdkDirectory: join(homeDirectory, '..', 'ABSENT_SDK'),
    baseUrl: 'http://127.0.0.1:1', model: 'fixture', startupTimeoutMs: 1000 };
  else setup.config.copilot = { homeDirectory, workspace: join(homeDirectory, '..', 'workspace'),
    auth: { mode: 'github', credentialFile: join(homeDirectory, 'ABSENT_KEY') },
    sdkDirectory: join(homeDirectory, '..', 'ABSENT_SDK'), model: 'fixture', startupTimeoutMs: 1000 };
  const runtime = await setup.reopen();
  const owned = agent === 'ghcp' ? runtime.copilot! : runtime.claude!;
  const reopenedJournal = agent === 'ghcp' ? runtime.connectorUsers.copilotJournal : runtime.connectorUsers.claudeJournal;
  let codexRecovered = false;
  if (mode === 'mixed') {
    context.mock.getter(runtime.codex, 'enabled', () => true);
    context.mock.method(runtime.codex, 'refreshSessions', async () => {});
    context.mock.method(runtime.codex, 'isSessionListReady', () => true);
    context.mock.method(runtime.connectorUsers.codexExecutions, 'maintenanceHistorySessions', () => ['codex:old']);
    context.mock.method(runtime.codex, 'recoverMaintenanceHistory', async () => { codexRecovered = true; });
  }
  const probe = (sessionKey = key, patch = {}) => runtime.app.request('/api/connector/v1/maintenance/readiness', {
    method: 'POST', headers: { ...headers, ...patch }, body: JSON.stringify({ fenceId, sessionKey }),
  });
  assert.equal(owned.inspectMaintenance().startupState, 'pending');
  const response = await probe(), proof = await response.json();
  if (unknownExecution) {
    assert.equal(response.status, 503, 'unresolved execution in any SDK session prevents whole-runtime proof');
    assert.equal(reopenedJournal.current(`${agent}:unconfirmed`)?.id, 'other');
    return;
  }
  assert.equal(response.status, 200); assert.equal(proof.messageCount, 2); assert.equal(proof.businessReadVerified, true);
  if (mode === 'mixed') assert.equal(codexRecovered, true, 'Claude proof still recovers all Codex terminal histories');
  assert.equal(JSON.stringify(proof).includes('PRIVATE'), false);
  assert.equal(owned.inspectMaintenance().startupState, 'pending', 'readiness must not need the absent SDK/key');
  assert.equal((await probe(`${agent}:missing`)).status, 503);
  assert.equal((await probe(key, { authorization: `Bearer ${setup.alice}` })).status, 403);
  assert.equal((await runtime.app.request(`/api/connector/v1/sessions/${key}/messages`, { headers })).status, 503);
  const pendingKey = `${agent}:unconfirmed`;
  reopenedJournal.create({ key: pendingKey, nativeSessionId: 'other', title: '', createdAt: 2 });
  await runtime.connectorUsers.turns.enqueueAsync(agent, { id: 'pending', sessionKey: pendingKey, createdAt: 2, payload: {} });
  assert.equal(reopenedJournal.begin({ key: pendingKey, id: 'other', epoch: 'epoch' }, ['pending'], runtime.connectorUsers.turns), undefined);
  assert.equal((await probe()).status, 200, 'paused unsent inputs are preserved, not mistaken for native execution');
  assert.equal(runtime.connectorUsers.turns.head(agent, pendingKey)?.state, 'queued');
});

test('in-flight business probe blocks resume and idle proof, then preserves the original fence on failure', async context => {
  const setup = fixture(context), runtime = setup.runtime;
  setup.config.connector.revision = 'a'.repeat(40);
  context.mock.getter(runtime.codex, 'enabled', () => true);
  const headers = { authorization: `Bearer ${setup.lifecycle}`, [EXPECTED_NODE_HEADER]: runtime.connectorUsers.nodeId,
    [CONNECTOR_PROTOCOL_HEADER]: '1', 'Content-Type': 'application/json' };
  const post = (suffix: string, body: unknown) => runtime.app.request(`/api/connector/v1/maintenance/${suffix}`, {
    method: 'POST', headers, body: JSON.stringify(body),
  });
  const paused = await post('commands/pause', { idempotencyKey: 'probe-fence' });
  const { fenceId } = await paused.json();
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { finish = resolve; });
  context.mock.method(runtime.codex, 'refreshSessions', async () => { entered(); await held; throw new Error('private native diagnostic'); });
  const pending = post('readiness', { fenceId, sessionKey: 'codex:probe' });
  try {
    await started;
    const inspection = await setup.inspect();
    assert.equal(inspection.status, 200);
    assert.equal((await inspection.json()).inFlightWrites, 1, 'stop recheck cannot mistake a hydration request for idle');
    const resume = await post('commands/resume', { idempotencyKey: 'while-probing', fenceId });
    assert.notEqual(resume.status, 200, 'probe holds the update/fence lock');
    assert.equal((await runtime.app.request('/synthetic-write', { method: 'POST' })).status, 503);
  } finally { finish(); }
  const result = await pending;
  assert.equal(result.status, 503);
  assert.deepEqual(await result.json(), { error: 'Business readiness unavailable; execution remains fenced' });
  assert.equal((await setup.inspect()).status, 200);
  assert.equal((await (await setup.inspect()).json()).inFlightWrites, 0);
  const resume = await post('commands/resume', { idempotencyKey: 'after-probe', fenceId });
  assert.equal(resume.status, 200);
  assert.equal((await runtime.app.request('/synthetic-write', { method: 'POST' })).status, 200);
});

test('lifecycle admission requires node/protocol and no Origin; it does not grant artifact update authority', async context => {
  const setup = fixture(context);
  const headers = { authorization: `Bearer ${setup.lifecycle}`, [EXPECTED_NODE_HEADER]: setup.runtime.connectorUsers.nodeId,
    [CONNECTOR_PROTOCOL_HEADER]: '1' };
  const base = '/api/connector/v1/';
  for (const invalid of [{ authorization: headers.authorization }, { ...headers, Origin: 'https://hub.test' }]) {
    const response = await setup.runtime.app.request(`${base}maintenance/commands/pause`, {
      method: 'POST', headers: invalid, body: JSON.stringify({ idempotencyKey: 'unauthorized' }) });
    assert.equal(response.status, 403);
    assert.equal((await setup.runtime.app.request('/synthetic-write', { method: 'POST' })).status, 200);
  }
  const update = await setup.runtime.app.request(`${base}update/commands/apply`, {
    method: 'POST', headers, body: JSON.stringify({ idempotencyKey: 'unauthorized-update' }) });
  assert.equal(update.status, 403);
});

test('readiness refuses live native or durable work before any history recovery', async context => {
  const setup = fixture(context), runtime = setup.runtime;
  setup.config.connector.revision = 'a'.repeat(40);
  context.mock.getter(runtime.codex, 'enabled', () => true);
  let hydration = 0;
  context.mock.method(runtime.codex, 'refreshSession', async () => { hydration++; });
  context.mock.method(runtime.codex, 'refreshSessions', async () => { hydration++; });
  const headers = { authorization: `Bearer ${setup.lifecycle}`, [EXPECTED_NODE_HEADER]: runtime.connectorUsers.nodeId,
    [CONNECTOR_PROTOCOL_HEADER]: '1', 'Content-Type': 'application/json' };
  const pause = await runtime.app.request('/api/connector/v1/maintenance/commands/pause', {
    method: 'POST', headers, body: JSON.stringify({ idempotencyKey: 'before-hydrate' }),
  });
  const { fenceId } = await pause.json();
  const probe = () => runtime.app.request('/api/connector/v1/maintenance/readiness', {
    method: 'POST', headers, body: JSON.stringify({ fenceId, sessionKey: 'codex:history' }),
  });
  for (const field of ['activeRuns', 'backgroundTerminals', 'inFlightWrites'] as const) {
    const mock = context.mock.method(runtime.codex, 'inspectMaintenance', async () => ({
      activeRuns: 0, backgroundTerminals: 0, inFlightWrites: 0, assertCurrent() {}, [field]: 1,
    }));
    assert.equal((await probe()).status, 503, field);
    assert.equal(hydration, 0);
    mock.mock.restore();
  }
  // New executions cannot be admitted after pause. Simulate a persisted pending
  // observation here; the next test covers actual journal rows across restart.
  context.mock.method(runtime.connectorUsers.codexExecutions, 'maintenancePending', () => 1);
  assert.equal((await probe()).status, 503);
  assert.equal(hydration, 0);
  assert.equal((await (await setup.inspect()).json()).inFlightWrites, 0);
  assert.equal((await runtime.app.request('/synthetic-write', { method: 'POST' })).status, 503);
});

test('readiness recovers all restarted terminal histories before releasing strict idle proof', async context => {
  const setup = fixture(context);
  setup.config.connector.revision = 'a'.repeat(40);
  const keys = ['codex:probe', 'codex:other'];
  for (const key of keys) {
    const facts = setup.runtime.connectorUsers.codexExecutions;
    facts.begin(key, key, 'old'); facts.acknowledge(key, key, 'old', key, () => {});
    facts.observe(key, 'old', key, 'completed');
    facts.settleHistory({ sessionKey: key, commandId: key, runId: key }, 'current');
  }
  const pause = await setup.runtime.app.request('/api/connector/v1/maintenance/commands/pause', {
    method: 'POST', headers: { authorization: `Bearer ${setup.lifecycle}`,
      [EXPECTED_NODE_HEADER]: setup.runtime.connectorUsers.nodeId, [CONNECTOR_PROTOCOL_HEADER]: '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ idempotencyKey: 'recover-terminals' }),
  });
  assert.equal(pause.status, 200);
  const { fenceId } = await pause.json();
  const runtime = await setup.reopen(), facts = runtime.connectorUsers.codexExecutions;
  assert.equal(facts.maintenancePending(), 2);
  assert.equal((await (await setup.inspect()).json()).pendingExecutions, 2);
  context.mock.getter(runtime.codex, 'enabled', () => true);
  context.mock.method(runtime.codex, 'refreshSessions', async () => {
    for (const sessionKey of keys) runtime.store.upsertSession({ sessionKey, agentId: 'codex', title: 'Synthetic',
      status: 'idle', hasActiveRun: false,
      runtime: { phase: 'completed', sync: 'current', connection: 'connected', lastEventAt: 1 } });
  });
  context.mock.method(runtime.codex, 'isSessionListReady', () => true);
  context.mock.method(runtime.codex, 'isSessionHistoryReady', () => true);
  let settle = false;
  const hydrated: string[] = [];
  context.mock.method(runtime.codex, 'recoverMaintenanceHistory', async (sessionKey: string, check: () => void) => {
    check();
    hydrated.push(sessionKey);
    if (settle) facts.settleHistory({ sessionKey, commandId: sessionKey, runId: sessionKey }, 'current');
    runtime.store.addMessage({ sessionKey, id: `${sessionKey}:user`, role: 'user', text: 'question', createdAt: 1 });
    runtime.store.addMessage({ sessionKey, id: `${sessionKey}:reply`, role: 'assistant', text: 'reply', createdAt: 2 });
  });
  const headers = { authorization: `Bearer ${setup.lifecycle}`, [EXPECTED_NODE_HEADER]: runtime.connectorUsers.nodeId,
    [CONNECTOR_PROTOCOL_HEADER]: '1', 'Content-Type': 'application/json' };
  const probe = () => runtime.app.request('/api/connector/v1/maintenance/readiness', {
    method: 'POST', headers, body: JSON.stringify({ fenceId, sessionKey: keys[0] }),
  });
  assert.equal((await probe()).status, 503, 'hydration alone is not proof of settled history');
  assert.deepEqual(hydrated, ['codex:other', 'codex:probe']);
  assert.equal(facts.maintenancePending(), 2);
  settle = true;
  assert.equal((await probe()).status, 200);
  assert.equal(facts.maintenancePending(), 0);
  assert.equal((await (await setup.inspect()).json()).fenceId, fenceId);
  assert.equal((await runtime.app.request('/synthetic-write', { method: 'POST' })).status, 503,
    'readiness never opens admissions by itself');
});

test('historical unfinished tools do not veto a different proven terminal; current and unbound work still blocks readiness', async context => {
  const setup = fixture(context), runtime = setup.runtime, sessionKey = 'codex:history';
  setup.config.connector.revision = 'a'.repeat(40);
  const facts = runtime.connectorUsers.codexExecutions;
  facts.begin(sessionKey, 'command', 'connection');
  facts.acknowledge(sessionKey, 'command', 'connection', 'current-turn', () => {});
  facts.observe(sessionKey, 'connection', 'current-turn', 'completed');
  facts.settleHistory(facts.get(sessionKey)!, 'current');
  context.mock.getter(runtime.codex, 'enabled', () => true);
  context.mock.method(runtime.codex, 'refreshSessions', async () => {
    runtime.store.upsertSession({ sessionKey, agentId: 'codex', title: 'Synthetic', status: 'idle', hasActiveRun: false,
      runtime: { turnId: 'current-turn', phase: 'completed', sync: 'current', connection: 'connected', lastEventAt: 1 } });
  });
  context.mock.method(runtime.codex, 'refreshSession', async () => {});
  context.mock.method(runtime.codex, 'isSessionListReady', () => true);
  context.mock.method(runtime.codex, 'isSessionHistoryReady', () => true);
  runtime.store.addMessage({ sessionKey, id: 'user', role: 'user', text: 'question', createdAt: 1 });
  runtime.store.addMessage({ sessionKey, id: 'reply', role: 'assistant', text: 'answer', createdAt: 2 });
  const headers = { authorization: `Bearer ${setup.lifecycle}`, [EXPECTED_NODE_HEADER]: runtime.connectorUsers.nodeId,
    [CONNECTOR_PROTOCOL_HEADER]: '1', 'Content-Type': 'application/json' };
  const paused = await runtime.app.request('/api/connector/v1/maintenance/commands/pause', {
    method: 'POST', headers, body: JSON.stringify({ idempotencyKey: 'historical-tools' }),
  });
  const { fenceId } = await paused.json();
  const probe = () => runtime.app.request('/api/connector/v1/maintenance/readiness', {
    method: 'POST', headers, body: JSON.stringify({ fenceId, sessionKey }),
  });
  for (const pending of [
    { role: 'tool' as const, turnId: 'old-turn', expected: 200 },
    { role: 'tool' as const, turnId: 'current-turn', expected: 503 },
    { role: 'tool' as const, expected: 503 },
    { role: 'user' as const, turnId: 'old-turn', expected: 503 },
    { role: 'assistant' as const, turnId: 'old-turn', expected: 503 },
  ]) {
    runtime.store.removeMessage(sessionKey, 'pending');
    runtime.store.addMessage({ sessionKey, id: 'pending', role: pending.role,
      ...('turnId' in pending ? { turnId: pending.turnId } : {}), status: 'sending', text: 'unconfirmed', createdAt: 1 });
    assert.equal((await probe()).status, pending.expected);
    assert.equal(runtime.store.getMessages(sessionKey).find(message => message.id === 'pending')?.status, 'sending');
  }
  const blocked = await runtime.app.request('/api/connector/v1/sessions/state', { headers });
  assert.equal(blocked.status, 503);
  assert.equal(blocked.headers.get(NODE_ID_HEADER), runtime.connectorUsers.nodeId);
  assert.equal(blocked.headers.get(CONNECTOR_PROTOCOL_HEADER), '1');
  assert.deepEqual(await blocked.json(), { error: 'connector_maintenance' });
  assert.equal((await (await setup.inspect()).json()).fenceId, fenceId);
});

test('real runtime inspection is available during pause, includes durable cross-runtime work and never starts native', async context => {
  const setup = fixture(context), users = setup.runtime.connectorUsers;
  users.codexExecutions.begin('codex:pending', 'unconfirmed', 'old-connection');
  users.openClawExecutions.begin('agent:pending', 'openclaw-unconfirmed');
  users.hermesJournal.beginDeletion('hermes:pending');
  await users.turns.enqueueAsync('codex', { id: 'queued', sessionKey: 'codex:pending', createdAt: 1,
    payload: { text: 'synthetic pending message', images: [] } });
  const initial = await setup.inspect();
  assert.equal(initial.status, 200);
  const proof = await initial.json();
  assert.equal(proof.nativeVerified, true); assert.equal(proof.activeRuns, 0);
  assert.equal(proof.pendingExecutions, 3); assert.equal(proof.queuedMessages, 1);
  assert.equal(proof.inFlightWrites, 0, 'inspection itself is not a business writer');
  assert.equal(proof.fenceId, undefined);
  const pause = await setup.request('commands/pause', { idempotencyKey: 'inspection-fence' });
  const fence = await pause.json(); assert.equal(pause.status, 200);
  const paused = await setup.inspect(); assert.equal(paused.status, 200);
  assert.equal((await paused.json()).fenceId, fence.fenceId);
  await setup.reopen();
  const restored = await setup.inspect(); assert.equal(restored.status, 200);
  const after = await restored.json();
  assert.equal(after.fenceId, fence.fenceId); assert.equal(after.pendingExecutions, 3); assert.equal(after.queuedMessages, 1);
  setup.config.localOpenClawCli = true;
  assert.equal((await setup.inspect()).status, 503, 'unsupported native runtime cannot assert idle');
});

test('maintenance queue fingerprint requires paused ownership and detects complete payload changes without exposing content', async context => {
  const setup = fixture(context), users = setup.runtime.connectorUsers;
  assert.throws(() => users.maintenanceQueueSha256(), /paused runtime ownership/);
  const pause = await setup.request('commands/pause', { idempotencyKey: 'queue-fingerprint' });
  const { fenceId } = await pause.json(); assert.equal(pause.status, 200);
  const empty = users.maintenanceQueueSha256();
  assert.equal(empty, createHash('sha256').update('[]').digest('hex'));
  await users.turns.enqueueAsync('codex', { id: 'queued-private', sessionKey: 'codex:probe', createdAt: 1,
    payload: { text: 'private queued message', images: [] } });
  const queued = users.maintenanceQueueSha256();
  assert.match(queued, /^[a-f0-9]{64}$/); assert.notEqual(queued, empty);
  assert.equal(users.maintenanceQueueSha256(), queued);
  const db = (users as unknown as { db: DatabaseSync }).db;
  db.prepare("UPDATE connector_turns SET payload = ? WHERE id = ?")
    .run(JSON.stringify({ text: 'changed private queued message', images: [] }), 'queued-private');
  assert.notEqual(users.maintenanceQueueSha256(), queued, 'even a payload change without a revision change is detected');
  const resumed = await setup.request('commands/resume', { idempotencyKey: 'queue-fingerprint-resume', fenceId });
  assert.equal(resumed.status, 200);
  assert.throws(() => users.maintenanceQueueSha256(), /paused runtime ownership/);
});

test('runtime restores original maintenance before either worker starts and requires the original actor to resume', async context => {
  const setup = fixture(context);
  const response = await setup.request('commands/pause', { idempotencyKey: 'original' });
  assert.equal(response.status, 200);
  const paused = await response.json();
  assert.equal(paused.state, 'paused');
  assert.equal(paused.nativeQuiescent, false);
  const runtime = await setup.reopen();
  const users = runtime.connectorUsers;
  await users.turns.enqueueAsync('codex', { id: 'queued', sessionKey: 'codex:synthetic', createdAt: 1, payload: {} });
  assert.equal(users.turns.start('codex', 'codex:synthetic', 'queued'), false);
  assert.equal(users.codexExecutions.begin('codex:synthetic', 'queued', 'synthetic'), false);
  assert.equal(users.openClawExecutions.begin('agent:synthetic', 'queued-openclaw'), false);
  await delay(10);
  assert.equal(users.turns.head('codex', 'codex:synthetic')?.state, 'queued');
  assert.equal((await runtime.app.request('/synthetic-write', { method: 'POST' })).status, 503);
  assert.equal((await runtime.app.request('/synthetic-read')).status, 200);
  assert.equal((await setup.request('status')).status, 200);
  const unknown = await setup.request('commands/pause/missing');
  assert.equal(unknown.status, 404);
  const unauthenticated = await runtime.app.request('/api/connector/v1/maintenance/commands/resume', { method: 'POST',
    body: JSON.stringify({ idempotencyKey: 'unauthorized', fenceId: paused.fenceId }) });
  assert.equal(unauthenticated.status, 403);
  assert.equal((await setup.request('commands/resume', { idempotencyKey: 'other', fenceId: paused.fenceId }, setup.bob)).status, 409);
  assert.equal((await setup.request('commands/pause/original', undefined, setup.bob)).status, 404);
  const original = await setup.request('commands/pause/original');
  assert.equal((await original.json()).command.id, paused.command.id);
  users.turns.cancel('codex', 'codex:synthetic', 'queued');
  const resumed = await setup.request('commands/resume', { idempotencyKey: 'resume', fenceId: paused.fenceId });
  assert.equal(resumed.status, 200);
  assert.equal((await resumed.json()).state, 'released');
  assert.equal((await runtime.app.request('/synthetic-write', { method: 'POST' })).status, 200);
  await setup.reopen();
  assert.equal((await setup.runtime.app.request('/synthetic-write', { method: 'POST' })).status, 200);
});

test('runtime restores a visible release with unknown receipt as fenced before either native start', async context => {
  const setup = fixture(context);
  const paused = await setup.request('commands/pause', { idempotencyKey: 'original' });
  assert.equal(paused.status, 200);
  const state = JSON.parse(readFileSync(setup.config.connector.updateStateFile, 'utf8'));
  const scope = JSON.stringify(['maintenance', JSON.stringify([state.maintenance.nodeId, state.maintenance.actorId, 'resume'])]);
  const original = (await setup.runtime.connectorUsers.commands.claimAsync(scope, 'interrupted-resume', { fenceId: state.maintenance.id })).receipt;
  state.maintenance.state = 'released';
  state.maintenance.command = { scope, key: original.key, id: original.id, operation: 'resume' };
  writeFileSync(setup.config.connector.updateStateFile, JSON.stringify(state));
  const runtime = await setup.reopen();
  assert.equal(runtime.connectorUsers.codexExecutions.begin('codex:synthetic', 'blocked-codex', 'synthetic'), false);
  assert.equal(runtime.connectorUsers.openClawExecutions.begin('agent:synthetic', 'blocked-openclaw'), false);
  assert.equal((await runtime.app.request('/synthetic-write', { method: 'POST' })).status, 503);
  assert.equal((await (await setup.request('status')).json()).state, 'resuming');
  const reconciled = await setup.request('commands/resume/interrupted-resume');
  assert.equal(reconciled.status, 200);
  const result = (await reconciled.json()).command;
  assert.equal(result.id, original.id);
  assert.equal(result.result.body.state, 'paused');
  assert.equal(result.result.body.resumeInterrupted, true);
  assert.equal((await runtime.app.request('/synthetic-write', { method: 'POST' })).status, 503);
  await setup.reopen();
  assert.equal((await setup.runtime.app.request('/synthetic-write', { method: 'POST' })).status, 503);
  const resumed = await setup.request('commands/resume', { idempotencyKey: 'explicit-resume', fenceId: state.maintenance.id });
  assert.equal(resumed.status, 200);
  assert.equal((await resumed.json()).state, 'released');
});

test('runtime pause retains admitted disconnected handlers and only bypasses admission for exact authenticated control routes', async context => {
  const setup = fixture(context);
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  setup.runtime.app.post('/held-write', async context => { entered(); await held; return context.text('finished'); });
  const controller = new AbortController();
  const original = setup.runtime.app.request('/held-write', { method: 'POST', signal: controller.signal });
  await started;
  let finished = false;
  const pausing = setup.request('commands/pause', { idempotencyKey: 'original' }).then(response => { finished = true; return response; });
  try {
    for (let attempt = 0; attempt < 200; attempt++) {
      if ((await setup.runtime.app.request('/synthetic-write', { method: 'POST' })).status === 503) break;
      await delay(5);
    }
    assert.equal((await setup.runtime.app.request('/synthetic-write', { method: 'POST' })).status, 503);
    controller.abort(); await delay(10);
    assert.equal(finished, false);
    assert.equal((await setup.runtime.app.request('/synthetic-read')).status, 200);
    for (const path of ['pause/extra', 'resume/extra', 'other']) {
      assert.equal((await setup.request(`commands/${path}`, {})).status, 503);
    }
  } finally { release(); await original; }
  const response = await pausing;
  assert.equal(response.status, 200);
  assert.equal((await response.json()).state, 'paused');
});

test('shutdown wins over an in-flight maintenance resume and restart retains its original fence', async context => {
  const setup = fixture(context);
  const response = await setup.request('commands/pause', { idempotencyKey: 'original' });
  const paused = await response.json();
  let release!: () => void;
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    release = () => { controller.enqueue(new TextEncoder().encode(JSON.stringify({ idempotencyKey: 'resume', fenceId: paused.fenceId }))); controller.close(); };
  } });
  const request = new Request('http://connector/api/connector/v1/maintenance/commands/resume', {
    method: 'POST', headers: { authorization: `Bearer ${setup.alice}` }, body, duplex: 'half',
  } as RequestInit);
  const pending = setup.runtime.app.fetch(request);
  await delay(10);
  const closing = setup.runtime.close();
  release();
  assert.notEqual((await pending).status, 200);
  await closing;
  await setup.reopen();
  assert.equal((await setup.runtime.app.request('/synthetic-write', { method: 'POST' })).status, 503);
});

test('invalid maintenance journal fails before credential access or native construction', async context => {
  const setup = fixture(context);
  await setup.runtime.close();
  writeFileSync(setup.config.connector.updateStateFile, '{broken');
  Object.defineProperty(setup.config.connector, 'tokenFile', { get() { throw new Error('credentials must not be accessed'); } });
  assert.throws(() => createConnectorRuntime(setup.config, () => false), /invalid maintenance journal before startup/);
});
