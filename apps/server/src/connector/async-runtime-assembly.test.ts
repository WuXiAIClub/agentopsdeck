import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { CONNECTOR_PROTOCOL_HEADER } from '@agentopsdeck/shared';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { DeckStore } from '../projection/deck-store.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { createAsyncRuntimeAssembly, type AsyncRuntimeAssemblyOptions, type AsyncRuntimeAssemblyPorts } from './async-runtime-assembly.js';
import { registerAsyncRuntimeHttp } from './async-runtime-http.js';
import { EXPECTED_NODE_HEADER } from './node-identity.js';
import type { HermesTransport } from '../hermes/runtime.js';
import { AsyncMaintenanceLifecycle } from './async-maintenance-lifecycle.js';

const diagnostics = new PerformanceDiagnostics(() => {}), authorization = 'Bearer assembly-fixture';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function until(check: () => boolean) {
  const end = Date.now() + 5000;
  while (!check()) { assert.ok(Date.now() < end, 'Assembly did not converge'); await tick(); }
}
async function fixture(t: TestContext, configured = true, codexEnabled = false) {
  const root = mkdtempSync(join(tmpdir(), 'runtime-assembly-'));
  const owner = new AsyncConnectorOwner({ file: join(root, 'connector.sqlite'), tokenFile: join(root, 'tokens.json'),
    bootstrapToken: authorization.slice(7), codexBoardTools: false,
    sdkModels: { 'claude-code': { model: 'default', modelChoices: ['default'] }, ghcp: { model: 'default', modelChoices: ['default'] } } }, diagnostics);
  await owner.open();
  let assembly: Awaited<ReturnType<typeof createAsyncRuntimeAssembly>> | undefined;
  t.after(async () => { try { await assembly?.close(); } finally { await owner.close(); rmSync(root, { recursive: true, force: true }); } });
  const nodeId = await owner.command('nodeIdentity', {}), deck = new DeckStore({ sessionTitlesFile: join(root, 'titles.json') });
  const snapshot: AsyncRuntimeAssemblyOptions['snapshot'] = capture => capture(undefined);
  const counts = { claude: 0, copilot: 0, hermes: 0, historyClose: 0, historyInvalidation: 0, discoveryInvalidation: 0 };
  const hooks: { claude?: () => Promise<void>; copilot?: () => Promise<void>; hermes?: () => Promise<void>; historyClose?: () => Promise<void> } = {};
  const claudeHome = join(root, 'claude'), copilotHome = join(root, 'copilot');
  mkdirSync(claudeHome, { mode: 0o700 }); mkdirSync(copilotHome, { mode: 0o700 });
  const common = { workspace: root, sdkDirectory: root, startupTimeoutMs: 1000, model: 'default', modelChoices: ['default'] };
  const options: AsyncRuntimeAssemblyOptions = {
    owner, deck, nodeId, snapshot, diagnostics,
    media: { inboundDir: root, artifactConfig: { enabled: false, allowedDirs: [], maxBytes: 65536, indexFile: join(root, 'artifacts.json'),
      injectCapability: false, allowGatewayClient: false }, refreshMessages: async () => {} },
    codex: { native: { enabled: codexEnabled, command: 'must-not-launch', defaultCwd: root, defaultModel: 'default', approvalPolicy: 'never' } },
    sdk: {
      ...(configured ? { claude: { ...common, homeDirectory: claudeHome, apiKeyFile: join(root, 'absent-key'), baseUrl: 'http://127.0.0.1:1' },
        copilot: { ...common, homeDirectory: copilotHome, auth: { mode: 'github', credentialFile: join(root, 'absent-key') } } } : {}),
    },
    hermes: { config: { enabled: configured, executable: join(root, 'absent-python'), sourceDirectory: root,
      homeDirectory: join(root, 'hermes'), workspace: root, startupTimeoutMs: 1000 },
      executionAvailable: () => true, queueChanged: () => {} },
    openclaw: {
      history: { snapshot, refresh: async () => {}, historyReady: () => true,
        invalidate: () => { counts.historyInvalidation++; },
        close: async () => { counts.historyClose++; await hooks.historyClose?.(); } },
      invalidateDiscovery: () => { counts.discoveryInvalidation++; },
      dispatch: { gateway: { connectionId: () => 'original-connection', prepareWriteConnection: async () => 'original-connection',
        requestBound: async () => { throw Error('No effect expected'); } },
        native: { available: () => true, epoch: () => 'original-connection' }, allowCliFallback: false, message: text => text },
      recovery: { connectionId: () => 'original-connection', query: async () => ({ status: 'timeout' }) },
      refreshSessions: async () => {}, refreshMessages: async () => {}, nativeSession: () => undefined,
      defaultAgentId: 'main', admissionAvailable: () => true, gatewayStatus: () => 'connected', retryMs: 10_000,
    },
  };
  const check = (id: 'claude' | 'copilot') => {
    counts[id]++;
    return { ready: Promise.resolve().then(() => hooks[id]?.()).then(() => true), finished: Promise.resolve(), inspectQuiescence: () => true, close() {} };
  };
  const transport: HermesTransport & { ready: boolean; epoch: string } = {
    ready: false, epoch: 'original-hermes',
    async start() { counts.hermes++; await hooks.hermes?.(); transport.ready = true; },
    async close() { transport.ready = false; },
    async request() { throw Error('No effect expected'); },
  };
  const ports: AsyncRuntimeAssemblyPorts = {
    sdk: { claude: { check: () => check('claude'), start: () => { throw Error('No effect expected'); } },
      copilot: { check: () => check('copilot'), start: () => { throw Error('No effect expected'); } } },
    hermes: () => transport,
  };
  assembly = await createAsyncRuntimeAssembly(options, ports);
  const app = new Hono(); registerAsyncRuntimeHttp(app, nodeId, assembly.http);
  const request = (path: string, headers: Record<string, string> = {}) => app.request(`/api/connector/v1${path}`, {
    headers: { authorization, ...headers },
  });
  return { root, owner, nodeId, deck, options, ports, assembly, counts, hooks, request, transport };
}

test('actual worker assembly persists four-runtime title PATCH and recovers original receipts without replay', async t => {
  const f = await fixture(t, false);
  await f.assembly.start();
  const app = new Hono(); registerAsyncRuntimeHttp(app, f.nodeId, f.assembly.http);
  for (const runtime of ['openclaw', 'hermes', 'claude-code', 'ghcp']) {
    const key = runtime === 'openclaw' ? 'agent:main:dashboard:original' : `${runtime}:original`;
    f.deck.upsertSession({ sessionKey: key, title: 'Original', agentId: runtime, status: 'idle',
      ...(runtime === 'openclaw' ? {} : { source: runtime as 'hermes' | 'claude-code' | 'ghcp' }) });
    const path = `/api/connector/v1/sessions/${encodeURIComponent(key)}`;
    const headers = { authorization, 'content-type': 'application/json', 'idempotency-key': `title-${runtime}` };
    const first = await app.request(path, { method: 'PATCH', headers, body: JSON.stringify({ title: 'Renamed' }) });
    assert.equal(first.status, 200, await first.text());
    const persisted = readFileSync(join(f.root, 'titles.json'), 'utf8');
    assert.equal(f.deck.getSession(key)?.title, 'Renamed');
    assert.equal((await app.request(path, { method: 'PATCH', headers, body: JSON.stringify({ title: 'Renamed' }) })).status, 200);
    assert.equal((await app.request(`${path}/settings-commands/title-${runtime}`, { headers: { authorization } })).status, 200);
    assert.equal(readFileSync(join(f.root, 'titles.json'), 'utf8'), persisted);
  }
});

test('actual five-runtime assembly awaits original preflights and uses the original shared HTTP registrar', async t => {
  const f = await fixture(t), held = gate(); f.hooks.copilot = () => held.promise;
  assert.equal(f.assembly.state, 'new'); assert.equal(f.assembly.ready, false);
  assert.deepEqual([f.counts.claude, f.counts.copilot, f.counts.hermes], [0, 0, 0]);
  const starting = f.assembly.start(); let started = false; void starting.then(() => { started = true; });
  await until(() => f.counts.claude === 1 && f.counts.copilot === 1 && f.counts.hermes === 1);
  await tick(); assert.equal(started, false); assert.equal(f.assembly.ready, false);
  held.release(); await starting; assert.equal(f.assembly.state, 'ready');
  assert.equal(f.assembly.ready, true);
  assert.ok(f.assembly.media); assert.ok(f.assembly.http.sessionMedia);
  const missingMedia = await f.request(`/sessions/codex:original/messages/missing/media/${'0'.repeat(64)}`);
  assert.equal(missingMedia.status, 404, 'shared media route preserves original bootstrap read scope and missing membership');
  await missingMedia.arrayBuffer();
  for (const prefix of ['codex', 'hermes', 'claude-code', 'ghcp']) assert.equal(f.assembly.agents.forSession(`${prefix}:original`)?.id, prefix);
  assert.equal(f.assembly.agents.forSession('agent:main:original'), undefined);
  assert.equal((await f.request('/models/claude-code')).status, 403, 'bootstrap does not gain model authority');
  const reader = await f.owner.command('tokenCreate', { label: 'assembly catalog reader', scopes: ['models:read'] });
  const readerHeaders = { authorization: `Bearer ${reader.token}` };
  assert.equal((await f.request('/models/claude-code', readerHeaders)).status, 200);
  assert.equal((await f.request('/models/ghcp', readerHeaders)).status, 200);
  const badNode = { [EXPECTED_NODE_HEADER]: 'wrong-node' }, badProtocol = { [CONNECTOR_PROTOCOL_HEADER]: '999' };
  for (const path of ['/models/claude-code', '/models/ghcp', '/sessions/hermes%3Aoriginal/messages',
    '/sessions/codex%3Aoriginal/messages', '/sessions/agent%3Amain%3Aoriginal/messages']) {
    assert.equal((await f.request(path, badNode)).status, 409, path);
    assert.equal((await f.request(path, badProtocol)).status, 426, path);
  }
  await f.assembly.gatewayObserver.connectionChanged(undefined);
  assert.equal(f.counts.historyInvalidation, 1); assert.equal(f.counts.discoveryInvalidation, 1);
  const pause = f.assembly.pauseQueueWorkers(); await pause.drained;
  assert.equal(f.assembly.ready, false); assert.equal(pause.resume(), true); assert.equal(pause.resume(), false);
  await f.assembly.close(); assert.equal(f.assembly.state, 'closed'); assert.equal(f.counts.historyClose, 1);
  assert.equal(await f.owner.command('nodeIdentity', {}), f.nodeId, 'shared SQL owner closes only in the root');
});

for (const codexEnabled of [false, true]) test(`restored maintenance prepares every original runtime before release, Codex=${codexEnabled}`, async t => {
  const f = await fixture(t, true, codexEnabled);
  const lifecycle = new AsyncMaintenanceLifecycle(f.owner, [() => f.assembly.pauseQueueWorkers()], diagnostics);
  const pause = lifecycle.pause();
  assert.equal(f.assembly.state, 'new'); assert.equal(f.assembly.ready, false);
  assert.deepEqual([f.counts.claude, f.counts.copilot, f.counts.hermes], [0, 0, 0]);
  await f.assembly.start(); await pause.drained;
  assert.equal(f.assembly.state, 'ready'); assert.equal(f.assembly.ready, false);
  assert.deepEqual([f.counts.claude, f.counts.copilot, f.counts.hermes], [0, 0, 1]);
  assert.equal((await f.owner.command('maintenanceSnapshot', {})).commandAdmissionOpen, false);
  await f.assembly.refreshProjection(); f.assembly.assertProjectionCurrent();
  assert.equal((await f.assembly.sdk.claude!.inspectMaintenance()).startupWorkers, 0);
  assert.equal((await f.assembly.sdk.copilot!.inspectMaintenance()).startupWorkers, 0);
  if (!codexEnabled) {
    assert.equal(await pause.resume(async () => {}, () => {}), true);
    await until(() => f.assembly.sdk.claude!.ready && f.assembly.sdk.copilot!.ready);
    assert.deepEqual([f.counts.claude, f.counts.copilot, f.counts.hermes], [1, 1, 1]);
    assert.equal(await pause.resume(async () => {}, () => {}), false);
  }
  // Enabled Codex uses an intentionally absent executable. Its preparation and
  // shutdown must never launch it while the original pause is held.
  await lifecycle.close(); await f.assembly.close();
  assert.equal(await f.owner.command('nodeIdentity', {}), f.nodeId);
});

test('a maintenance pause during original preflight prepares but never admits execution', async t => {
  const f = await fixture(t), held = gate(); f.hooks.claude = () => held.promise;
  const starting = f.assembly.start();
  await until(() => f.counts.claude === 1);
  const pause = f.assembly.pauseQueueWorkers(); held.release();
  await starting; await pause.drained;
  assert.equal(f.assembly.state, 'ready'); assert.equal(f.assembly.ready, false);
  assert.equal(pause.resume(), true);
  await until(() => f.assembly.ready);
  assert.deepEqual([f.counts.claude, f.counts.copilot, f.counts.hermes], [1, 1, 1]);
});

test('execution inventory opens before sibling startup producers can move its causal head', async t => {
  const f = await fixture(t, false), entered = gate(), held = gate();
  const open = f.assembly.openclaw.start.bind(f.assembly.openclaw);
  let codexStarted = false;
  const startCodex = f.assembly.codex.startWorkers.bind(f.assembly.codex);
  t.mock.method(f.assembly.openclaw, 'start', async () => { entered.release(); await held.promise; await open(); });
  t.mock.method(f.assembly.codex, 'startWorkers', async () => { codexStarted = true; await startCodex(); });
  const work = f.assembly.start();
  try {
    await entered.promise; await tick();
    assert.equal(codexStarted, false, 'native startup must not invalidate the opening inventory');
    assert.equal(f.assembly.ready, false);
  } finally { held.release(); await work; }
  assert.equal(codexStarted, true); assert.equal(f.assembly.ready, true);
});

test('close during initial inventory never starts sibling native producers', async t => {
  const f = await fixture(t, false), entered = gate(), held = gate();
  const open = f.assembly.openclaw.start.bind(f.assembly.openclaw);
  let codexStarted = false;
  t.mock.method(f.assembly.openclaw, 'start', async () => { entered.release(); await held.promise; await open(); });
  t.mock.method(f.assembly.codex, 'startWorkers', async () => { codexStarted = true; });
  const work = f.assembly.start(), failed = assert.rejects(work);
  await entered.promise;
  const closing = f.assembly.close(); held.release();
  await failed; await closing;
  assert.equal(codexStarted, false); assert.equal(f.assembly.ready, false);
  assert.equal(await f.owner.command('nodeIdentity', {}), f.nodeId);
});

test('disabled runtime keys remain reserved; read-only Codex projection participates without native launch', async t => {
  const f = await fixture(t, false); await f.assembly.start();
  assert.equal(f.assembly.agents.forSession('codex:old')?.id, 'codex');
  for (const prefix of ['hermes', 'claude-code', 'ghcp']) assert.throws(() => f.assembly.agents.forSession(`${prefix}:old`), /disabled/);
  assert.deepEqual([f.counts.claude, f.counts.copilot, f.counts.hermes], [0, 0, 0]);
  await f.assembly.refreshProjection(); f.assembly.assertProjectionCurrent();
});

for (const synchronous of [false, true]) test(`global projection retains every runtime after ${synchronous ? 'synchronous throw' : 'rejection'}`, async t => {
  const f = await fixture(t); await f.assembly.start();
  const entered = gate(), held = gate(), called: string[] = [];
  t.mock.method(f.assembly.codex, 'refreshProjection', () => {
    called.push('codex'); if (synchronous) throw Error('PRIVATE native failure'); return Promise.reject(Error('PRIVATE native failure'));
  });
  t.mock.method(f.assembly.sdk, 'refreshProjection', async () => { called.push('sdk'); entered.release(); await held.promise; });
  t.mock.method(f.assembly.hermes, 'refreshProjection', async () => { called.push('hermes'); });
  t.mock.method(f.assembly.openclaw, 'refreshProjection', async () => { called.push('openclaw'); });
  let settled = false; const work = f.assembly.refreshProjection(); const rejected = assert.rejects(work, /Runtime projection/);
  void work.then(() => { settled = true; }, () => { settled = true; });
  await entered.promise; await tick(); assert.equal(settled, false);
  assert.deepEqual(called, ['codex', 'sdk', 'hermes', 'openclaw']);
  let closed = false; const closing = f.assembly.close().then(() => { closed = true; });
  await tick(); assert.equal(closed, false); held.release(); await rejected; await closing;
});

test('close during physical startup freezes every child and awaits late native readiness/history cleanup', async t => {
  const f = await fixture(t), held = gate(), cleanup = gate(); f.hooks.hermes = () => held.promise;
  f.hooks.historyClose = () => cleanup.promise;
  const starting = f.assembly.start(), failed = assert.rejects(starting);
  await until(() => f.counts.hermes === 1);
  let closed = false; const closing = f.assembly.close().then(() => { closed = true; });
  assert.equal(f.assembly.ready, false); await assert.rejects(f.assembly.start());
  await tick(); assert.equal(closed, false); held.release(); await tick(); assert.equal(closed, false);
  cleanup.release(); await failed; await closing; assert.equal(f.transport.ready, false);
  assert.equal(await f.owner.command('nodeIdentity', {}), f.nodeId);
});

test('a configured startup failure is visible and all original runtime owners are closed', async t => {
  const f = await fixture(t); f.hooks.hermes = async () => { throw Error('PRIVATE native path'); };
  await assert.rejects(f.assembly.start(), error => error instanceof Error && !error.message.includes('PRIVATE'));
  assert.equal(f.assembly.state, 'failed'); assert.equal(f.assembly.ready, false);
  assert.equal(f.assembly.sdk.claude?.status, 'closed'); assert.equal(f.assembly.sdk.copilot?.status, 'closed');
  assert.equal(f.assembly.codex.status().state, 'closed'); assert.equal(f.transport.ready, false);
  assert.equal(f.counts.historyClose, 1);
});

test('a failed startup freezes sibling admission before a slow original preflight finishes', async t => {
  const f = await fixture(t), held = gate(), entered = gate();
  f.hooks.copilot = async () => { entered.release(); await held.promise; };
  f.hooks.hermes = async () => { await entered.promise; throw Error('native startup refused'); };
  const work = f.assembly.start(), failed = assert.rejects(work);
  let settled = false; void work.then(() => { settled = true; }, () => { settled = true; });
  try {
    await until(() => f.assembly.state === 'failed'
      && f.assembly.sdk.claude?.status === 'closed'
      && f.assembly.sdk.copilot?.status === 'closed'
      && f.assembly.codex.status().state === 'closed');
    assert.equal(f.assembly.sdk.claude?.status, 'closed');
    assert.equal(f.assembly.sdk.copilot?.status, 'closed');
    assert.equal(f.assembly.codex.status().state, 'closed');
    assert.equal(f.assembly.ready, false); assert.equal(settled, false);
  } finally { held.release(); await failed; }
  assert.equal(await f.owner.command('nodeIdentity', {}), f.nodeId);
});

test('construction failure closes previously created original executors without touching the shared owner', async t => {
  const f = await fixture(t, false); await f.assembly.close();
  const options = { ...f.options, openclaw: { ...f.options.openclaw, timeoutMs: 0 } };
  await assert.rejects(createAsyncRuntimeAssembly(options, f.ports));
  assert.equal(await f.owner.command('nodeIdentity', {}), f.nodeId);
});

test('maintenance pause attempts OpenClaw even when an earlier runtime fails, without reopening peers', async t => {
  const f = await fixture(t); await f.assembly.start(); let openclaw = 0;
  t.mock.method(f.assembly.agents, 'pauseQueueWorkers', () => { throw Error('private failure'); });
  const original = f.assembly.openclaw.pauseQueueWorker.bind(f.assembly.openclaw);
  t.mock.method(f.assembly.openclaw, 'pauseQueueWorker', () => { openclaw++; return original(); });
  assert.throws(() => f.assembly.pauseQueueWorkers()); assert.equal(openclaw, 1);
  assert.equal(f.assembly.state, 'failed'); assert.equal(f.assembly.ready, false); assert.equal(f.assembly.openclaw.ready, false);
});

for (const synchronous of [false, true]) test(`SDK sibling refresh owns its full physical lifetime after ${synchronous ? 'throw' : 'reject'}`, async t => {
  const f = await fixture(t); await f.assembly.start();
  const held = gate(), entered = gate(); let calls = 0, settled = false;
  t.mock.method(f.assembly.sdk.claude!, 'refreshProjection', () => {
    if (synchronous) throw Error('PRIVATE peer failure'); return Promise.reject(Error('PRIVATE peer failure'));
  });
  t.mock.method(f.assembly.sdk.copilot!, 'refreshProjection', async () => { calls++; entered.release(); await held.promise; });
  const work = f.assembly.sdk.refreshProjection(), failed = assert.rejects(work, /SDK application unavailable/);
  void work.then(() => { settled = true; }, () => { settled = true; });
  await entered.promise; await tick(); assert.equal(calls, 1); assert.equal(settled, false);
  let closed = false; const closing = f.assembly.close().then(() => { closed = true; });
  await tick(); assert.equal(closed, false); held.release(); await failed; await closing;
});
