import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { loadConfig, type ServerConfig } from '../config.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { DeckStore } from '../projection/deck-store.js';
import type { HermesTransport } from '../hermes/runtime.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { createAsyncConnectorSurface, type ConnectorSurfaceBinding, type ConnectorSurfaceContext } from './async-connector-surface.js';
import { createAsyncConfiguredBinding, type AsyncConfiguredBindingPorts } from './async-configured-binding.js';

const authorization = 'Bearer configured-binding-fixture', key = 'agent:main:dashboard:configured';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function gate() { let release!: () => void; const promise = new Promise<void>(yes => { release = yes; }); return { promise, release }; }
async function until(check: () => boolean) {
  const end = Date.now() + 10_000;
  while (!check()) { assert.ok(Date.now() < end, 'Configured native chain did not converge'); await tick(); }
}
async function fixture(t: TestContext, enabled = false) {
  const root = await mkdtemp(join(tmpdir(), 'configured-async-binding-'));
  await Promise.all(['claude', 'copilot'].map(name => mkdir(join(root, name), { mode: 0o700 })));
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
  const methods: string[] = [], logs: string[] = [], checks: string[] = [];
  const hooks: { claude?: () => Promise<void>; copilot?: () => Promise<void>; hermes?: () => Promise<void>; catalog?: () => Promise<string[]> } = {};
  server.on('connection', socket => {
    socket.send('{"type":"event","event":"connect.challenge"}');
    socket.on('message', raw => {
      const request = JSON.parse(raw.toString()); methods.push(request.method);
      const payload = request.method === 'sessions.list' ? { sessions: [{ key, label: 'Configured original', status: 'idle' }] } : {};
      socket.send(JSON.stringify({ type: 'res', id: request.id, ok: true, payload }));
    });
  });
  const defaults = loadConfig({ SERVER_ROLE: 'connector', AOD_CODEX_ENABLED: 'false',
    AOD_CONNECTOR_UPDATE_STATE_FILE: join(root, 'update.json') });
  const common = { workspace: root, sdkDirectory: root, startupTimeoutMs: 1_000, model: 'original-model', modelChoices: ['original-model'] };
  const config: ServerConfig = { ...defaults,
    gatewayWsUrl: `ws://127.0.0.1:${(server.address() as { port: number }).port}`, ownerToken: undefined, password: undefined,
    localOpenClawCli: false, codex: { ...defaults.codex, defaultCwd: root, command: 'must-not-launch' },
    ...(enabled ? {
      claude: { ...common, homeDirectory: join(root, 'claude'), apiKeyFile: join(root, 'absent-key'), baseUrl: 'http://127.0.0.1:1' },
      copilot: { ...common, homeDirectory: join(root, 'copilot'), auth: { mode: 'github' as const, credentialFile: join(root, 'absent-key') } },
      hermes: { enabled: true, executable: join(root, 'absent-python'), sourceDirectory: root, homeDirectory: join(root, 'hermes'), workspace: root, startupTimeoutMs: 1_000 },
    } : {}),
    sessionTitlesFile: join(root, 'titles.json'), sessionThinkingOverridesFile: join(root, 'thinking.json'),
    hiddenSessionsFile: join(root, 'hidden.json'), archivedSessionsFile: join(root, 'archived.json'), pinnedSessionsFile: join(root, 'pinned.json'),
    artifactReceiver: { ...defaults.artifactReceiver, enabled: false, indexFile: join(root, 'artifacts.json') },
    mediaBridge: { ...defaults.mediaBridge, enabled: false },
  };
  const diagnostics = new PerformanceDiagnostics(line => logs.push(line));
  const owner = new AsyncConnectorOwner({ file: join(root, 'connector.sqlite'), tokenFile: join(root, 'tokens.json'),
    bootstrapToken: authorization.slice(7), codexBoardTools: false,
    sdkModels: { 'claude-code': { model: common.model, modelChoices: common.modelChoices }, ghcp: { model: common.model, modelChoices: common.modelChoices } } }, diagnostics);
  await owner.open();
  const releases: (() => Promise<unknown>)[] = [];
  t.after(async () => {
    try { for (const release of releases) await release(); }
    finally { await owner.close(); for (const socket of server.clients) socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
  });
  const check = (id: 'claude' | 'copilot') => {
    checks.push(id);
    return { ready: Promise.resolve().then(() => hooks[id]?.()).then(() => true), finished: Promise.resolve(), inspectQuiescence: () => true, close() {} };
  };
  const transport: HermesTransport & { ready: boolean; epoch: string } = { ready: false, epoch: 'original-configured-epoch',
    async start() { checks.push('hermes'); await hooks.hermes?.(); transport.ready = true; },
    async close() { transport.ready = false; }, async request() { throw Error('No native effects expected'); } };
  const ports: AsyncConfiguredBindingPorts = { native: { sdk: {
    claude: { check: value => { assert.equal(value.homeDirectory, config.claude!.homeDirectory); return check('claude'); }, start: () => { throw Error('No native effects expected'); } },
    copilot: { check: value => { assert.equal(value.homeDirectory, config.copilot!.homeDirectory); return check('copilot'); }, start: () => { throw Error('No native effects expected'); } },
  }, hermes: () => transport }, openclaw: { readDiskUsage: async () => new Map() }, registry: () => hooks.catalog?.() ?? Promise.resolve(['original-registry-agent']) };
  const connector = { environmentId: 'configured-original-env', environmentLabel: 'Configured original environment' };
  const sampler = { sample: async () => { throw Error('No metrics requested'); }, close: async () => {} };
  const construct = async (custom = true) => {
    let binding: ConnectorSurfaceBinding | undefined;
    const surface = await createAsyncConnectorSurface({ owner, config, connector, sampler, diagnostics,
      ...(custom ? { bind: async (context: ConnectorSurfaceContext) => binding = await createAsyncConfiguredBinding(config, context, diagnostics, ports) } : {}) });
    releases.push(() => surface.close());
    return { surface, binding: () => { assert.ok(binding); return binding; } };
  };
  return { root, config, owner, logs, methods, hooks, checks, ports, diagnostics, releases, construct, transport };
}

test('surface default binding is inert then serves original Gateway sessions with the sole database owner', async t => {
  const f = await fixture(t), { surface } = await f.construct(false);
  assert.equal(surface.state, 'created'); assert.equal(f.methods.length, 0); assert.equal(f.checks.length, 0);
  await surface.start(); assert.equal(surface.ready, true);
  const response = await surface.app.request('/api/connector/v1/sessions/state', { headers: { authorization } });
  assert.equal(response.status, 200); assert.match(JSON.stringify(await response.json()), /Configured original/);
  assert.ok(f.methods.includes('sessions.list')); assert.equal(f.methods.includes('agent'), false);
  await surface.close(); assert.equal(surface.state, 'closed');
  assert.ok(await f.owner.command('nodeIdentity', {}), 'The surface must not close its startup owner');
});

test('configured SDK and Hermes join actual Gateway startup and original catalog without recursive ready gating', async t => {
  const f = await fixture(t, true), held = gate(); f.hooks.copilot = () => held.promise;
  t.after(() => held.release());
  const { surface, binding } = await f.construct();
  assert.ok(surface.system); assert.equal(surface.system.gateway, binding().system!.gateway);
  assert.equal(surface.system.admin, binding().system!.admin, 'surface borrows the original configured transports');
  assert.equal(f.checks.length, 0); assert.equal(f.methods.length, 0);
  assert.deepEqual(binding().runtimes.sdk.claude, f.config.claude);
  assert.deepEqual(binding().runtimes.sdk.copilot, f.config.copilot);
  assert.deepEqual(binding().runtimes.hermes.config, f.config.hermes);
  assert.equal(binding().runtimes.media!.artifactConfig, f.config.artifactReceiver);
  assert.equal(surface.media, binding().media);
  assert.equal(surface.media!.artifactRegistry, binding().runtimes.media!.artifactRegistry,
    'HTTP and original runtime share the sole asynchronous artifact index');
  assert.equal(binding().runtimes.media!.sourcePreview, f.config.sourcePreview);
  const starting = surface.start();
  await until(() => f.checks.length === 3); assert.equal(surface.ready, false);
  held.release(); await starting; assert.equal(surface.ready, true);
  const agents = await binding().agents();
  for (const id of ['claude-code', 'ghcp', 'hermes']) assert.equal(agents.find(agent => agent.id === id)?.status, 'available', id);
  assert.equal(f.methods.includes('agent'), false);
  await surface.close(); assert.equal(f.transport.ready, false);
  await assert.rejects(Promise.resolve().then(() => binding().agents()));
});

test('configured Codex model and original assistant artifact bridge survive inert binding construction', async t => {
  const f = await fixture(t);
  f.config.codex = { ...f.config.codex, enabled: true, modelChoices: ['original-codex'], defaultModel: 'original-codex', approvalPolicy: 'on-request' };
  const context: ConnectorSurfaceContext = { deck: new DeckStore(), nodeId: await f.owner.command('nodeIdentity', {}),
    snapshot: async capture => capture(undefined), credentials: { token: () => undefined }, workspace: () => undefined };
  const binding = await createAsyncConfiguredBinding(f.config, context, f.diagnostics, f.ports); f.releases.push(() => binding.close());
  assert.equal(binding.runtimes.codex.native.enabled, true);
  assert.equal(binding.runtimes.codex.native.command, 'must-not-launch');
  assert.equal(binding.runtimes.codex.native.approvalPolicy, 'on-request');
  assert.deepEqual(binding.runtimes.codex.modelChoices, ['original-codex']);
  const row = await binding.runtimes.codex.native.projectAssistant!('Original assistant text');
  assert.equal(row.text, 'Original assistant text'); assert.deepEqual(f.methods, []); assert.deepEqual(f.checks, []);
  await assert.rejects(binding.refreshSessions());
});

test('catalog close retains original held registry I/O and rejects all late reads without granting execution', async t => {
  const f = await fixture(t), held = gate(); f.config.localOpenClawCli = true;
  let entered = false; f.hooks.catalog = async () => { entered = true; await held.promise; return ['original-held-agent']; };
  t.after(() => held.release());
  const { surface, binding } = await f.construct(); await surface.start();
  const read = Promise.resolve(binding().agents()), rejected = assert.rejects(read);
  await until(() => entered);
  let closed = false; const closing = surface.close().then(() => { closed = true; });
  await tick(); assert.equal(closed, false);
  await assert.rejects(Promise.resolve().then(() => binding().agents()));
  held.release(); await rejected; await closing;
  assert.equal(surface.state, 'closed'); assert.equal(f.methods.includes('agent'), false);
});

test('attach is one-shot and configured failures cannot replace original native ownership', async t => {
  const f = await fixture(t, true), { surface, binding } = await f.construct();
  assert.throws(() => binding().attach!(surface.runtimes));
  f.hooks.claude = async () => { throw Error('PRIVATE configured credential path'); };
  // Original native startup failure must drain the configured assembly, not
  // erase its configuration or substitute another executor to obtain ready.
  await assert.rejects(surface.start());
  assert.equal(surface.runtimes.ready, false);
  assert.equal(surface.state, 'failed');
  // Cleanup retains the original failed native acknowledgement: no clean
  // idle proof may be manufactured. Account for that exact release once.
  await assert.rejects(surface.close());
  f.releases.pop();
  assert.deepEqual(binding().runtimes.sdk.claude, f.config.claude);
  assert.equal(f.transport.ready, false);
  assert.equal(f.checks.filter(id => id === 'claude').length, 1);
  assert.equal(f.logs.join('\n').includes('PRIVATE'), false);
});

test('close during configured native startup holds physical preflight cleanup and cannot reattach', async t => {
  const f = await fixture(t, true), held = gate(); f.hooks.hermes = () => held.promise;
  t.after(() => held.release());
  const { surface, binding } = await f.construct();
  const starting = surface.start(), rejected = assert.rejects(starting);
  await until(() => f.checks.includes('hermes'));
  let closed = false; const closing = surface.close().then(() => { closed = true; });
  await tick(); assert.equal(closed, false);
  held.release(); await rejected; await closing;
  assert.equal(f.transport.ready, false); assert.throws(() => binding().attach!(surface.runtimes));
  assert.ok(await f.owner.command('nodeIdentity', {}));
});
