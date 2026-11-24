import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { loadConfig, type ServerConfig } from '../config.js';
import { GatewayWsClient, type GatewayAsyncObserver } from '../gateway/ws-client.js';
import { DeckStore } from '../projection/deck-store.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { AsyncOpenClawApplication } from './async-openclaw-application.js';
import { createAsyncOpenClawBinding, type AsyncOpenClawBindingOptions, type AsyncOpenClawBindingPorts } from './async-openclaw-binding.js';
import { createAsyncConnectorSurface } from './async-connector-surface.js';

const key = 'agent:main:dashboard:original-binding', authorization = 'Bearer isolated-original-binding';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function gate() { let release!: () => void; const promise = new Promise<void>(yes => { release = yes; }); return { promise, release }; }
async function until(check: () => boolean | Promise<boolean>) {
  const end = Date.now() + 10_000;
  while (!await check()) { assert.ok(Date.now() < end, 'Original binding did not converge'); await tick(); }
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'async-openclaw-binding-'));
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
  const methods: string[] = [], sockets: WebSocket[] = [], logs: string[] = [];
  const hooks: { history?: () => Promise<void>; historyRows?: any[] } = {};
  server.on('connection', socket => {
    sockets.push(socket); socket.send('{"type":"event","event":"connect.challenge"}');
    socket.on('message', raw => {
      const request = JSON.parse(raw.toString()); methods.push(request.method);
      void (async () => {
        if (request.method === 'chat.history') await hooks.history?.();
        const payload = request.method === 'sessions.list' ? { sessions: [{ key, status: 'idle', label: 'Original native session' }] }
          : request.method === 'chat.history' ? { sessionKey: key, messages: hooks.historyRows ?? [
            { id: 'native-original-answer', role: 'assistant', text: 'Original completed turn', createdAt: 100, stopReason: 'stop' },
          ] } : request.method === 'agent' ? { runId: 'original-run', status: 'started' }
            : request.method === 'agent.wait' ? { status: 'timeout' } : {};
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: 'res', id: request.id, ok: true, payload }));
      })().catch(() => socket.close());
    });
  });
  const defaults = loadConfig({ SERVER_ROLE: 'connector' });
  const config: ServerConfig = { ...defaults, gatewayWsUrl: `ws://127.0.0.1:${(server.address() as { port: number }).port}`,
    ownerToken: undefined, password: undefined, localOpenClawCli: false,
    sessionTitlesFile: join(root, 'titles.json'), sessionThinkingOverridesFile: join(root, 'thinking.json'),
    hiddenSessionsFile: join(root, 'hidden.json'), archivedSessionsFile: join(root, 'archived.json'), pinnedSessionsFile: join(root, 'pinned.json'),
    artifactReceiver: { ...defaults.artifactReceiver, enabled: false, indexFile: join(root, 'artifacts.json') },
    mediaBridge: { ...defaults.mediaBridge, enabled: false } };
  const diagnostics = new PerformanceDiagnostics(line => logs.push(line));
  const owner = new AsyncConnectorOwner({ file: join(root, 'connector.sqlite'), tokenFile: join(root, 'tokens.json'),
    bootstrapToken: authorization.slice(7), codexBoardTools: false }, diagnostics);
  await owner.open();
  const releases: (() => Promise<unknown>)[] = [];
  t.after(async () => {
    try { for (const release of releases) await release(); }
    finally {
      await owner.close();
      for (const socket of sockets) socket.terminate();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
  const deck = new DeckStore();
  const options: AsyncOpenClawBindingOptions = { config, deck, snapshot: capture => capture('original-cursor'),
    refreshDirectories: async () => {}, admissionAvailable: () => true, diagnostics };
  const ports: AsyncOpenClawBindingPorts = { readDiskUsage: async () => new Map(), source: () => ({
    readSessions: async () => [], readTranscript: async () => [], close: async () => {},
  }) };
  return { root, owner, config, deck, options, ports, methods, sockets, hooks, logs, releases };
}

test('original config binding is inert; attach once, then cold discovery and history use one real connection', async t => {
  const f = await fixture(t);
  const binding = await createAsyncOpenClawBinding(f.options, f.ports);
  f.releases.push(() => binding.close());
  assert.equal(binding.current, false); assert.deepEqual(f.methods, []); assert.equal(f.sockets.length, 0);
  await assert.rejects(binding.refreshSessions()); await assert.rejects(binding.refreshMessages(key));
  const app = new AsyncOpenClawApplication({ ...binding.runtimes, deck: f.deck, owner: f.owner });
  f.releases.unshift(() => app.close());
  binding.attach(app); assert.throws(() => binding.attach(app));
  await app.start(); await binding.refreshSessions();
  assert.equal(binding.current, true); assert.equal(f.deck.getSession(key)?.title, 'Original native session');
  await binding.refreshMessages(key, { fresh: true });
  assert.equal(binding.runtimes.history.historyReady(key), true);
  assert.equal(f.deck.getMessages(key)[0]?.text, 'Original completed turn');
  assert.equal(f.sockets.length, 1); assert.deepEqual(f.methods, ['connect', 'sessions.list', 'chat.history']);
  await app.close(); await binding.close();
  assert.equal(binding.current, false); await assert.rejects(binding.refreshMessages(key));
  assert.ok(await f.owner.command('nodeIdentity', {}), 'Binding does not own or close the SQL worker');
  assert.doesNotMatch(f.logs.join('\n'), /isolated-original-binding|Original completed turn|ws:\/\//);
});

test('fresh history during active native execution is read-only; exact wire observations still settle through the worker', async t => {
  const f = await fixture(t), binding = await createAsyncOpenClawBinding(f.options, f.ports);
  f.releases.push(() => binding.close());
  const app = new AsyncOpenClawApplication({ ...binding.runtimes, deck: f.deck, owner: f.owner });
  f.releases.unshift(() => app.close()); binding.attach(app); await app.start(); await binding.refreshSessions();
  const scope = { authorization, key, commandKey: 'original-binding-send' };
  await app.http.openClawMessages.messages.send({ ...scope, payloadJson: '{"message":"original native input"}' }, { timeoutMs: 10_000 });
  await until(async () => (await f.owner.command('openClawExecutionRead', { sessionKey: key }))?.runId === 'original-run');
  const before = await f.owner.command('openClawExecutionRead', { sessionKey: key });
  await binding.refreshMessages(key, { fresh: true });
  assert.deepEqual(await f.owner.command('openClawExecutionRead', { sessionKey: key }), before);
  assert.equal(binding.runtimes.history.historyReady(key), true, 'History readiness must not wait for the next native Goal turn');
  f.sockets[0]!.send(JSON.stringify({ type: 'event', event: 'run', payload: { sessionKey: key, runId: 'original-run', status: 'waiting' } }));
  await until(async () => (await f.owner.command('openClawExecutionRead', { sessionKey: key }))?.phase === 'waiting');
  assert.equal(f.methods.filter(method => method === 'agent').length, 1, 'Read and observation must not resend');
  assert.equal(f.methods.filter(method => method === 'chat.send').length, 0);
});

test('close fences new history synchronously but retains accepted physical reads before source/transport release', async t => {
  const f = await fixture(t), held = gate(); let entered = false, sourceClosed = false;
  f.ports.source = () => ({ readSessions: async () => [], readTranscript: async () => [], close: async () => { sourceClosed = true; } });
  const binding = await createAsyncOpenClawBinding(f.options, f.ports);
  const app = new AsyncOpenClawApplication({ ...binding.runtimes, deck: f.deck, owner: f.owner });
  f.releases.push(async () => { held.release(); await app.close(); await binding.close(); });
  binding.attach(app); await app.start(); await binding.refreshSessions();
  f.hooks.history = async () => { entered = true; await held.promise; };
  const reading = binding.refreshMessages(key, { fresh: true }), rejected = assert.rejects(reading);
  await until(() => entered);
  let closed = false; const closing = binding.close(); assert.equal(binding.close(), closing);
  void closing.then(() => { closed = true; });
  await assert.rejects(binding.refreshMessages(key)); await assert.rejects(binding.refreshSessions());
  await tick(); assert.equal(closed, false); assert.equal(sourceClosed, false); assert.ok(binding.gateway.connectionId());
  held.release(); await rejected; await closing;
  assert.equal(sourceClosed, true); assert.equal(binding.gateway.connectionId(), undefined);
});

test('a reconnect supersedes held history rather than publishing a stale final snapshot', async t => {
  const f = await fixture(t), held = gate(); let entered = false;
  const binding = await createAsyncOpenClawBinding(f.options, f.ports);
  const app = new AsyncOpenClawApplication({ ...binding.runtimes, deck: f.deck, owner: f.owner });
  f.releases.push(async () => { held.release(); await app.close(); await binding.close(); });
  binding.attach(app); await app.start(); await binding.refreshSessions(); await binding.refreshMessages(key, { fresh: true });
  f.hooks.historyRows = [{ id: 'stale-answer', role: 'assistant', text: 'Must not publish', createdAt: 101 }];
  f.hooks.history = async () => { entered = true; await held.promise; };
  const reading = binding.refreshMessages(key, { fresh: true }), rejected = assert.rejects(reading);
  await until(() => entered); f.sockets[0]!.close();
  await until(() => binding.gateway.connectionId() === undefined); await binding.gateway.drainObservers();
  held.release(); await rejected;
  assert.equal(binding.runtimes.history.historyReady(key), false); assert.equal(binding.current, false);
  assert.equal(f.deck.getMessages(key)[0]?.text, 'Original completed turn');
  delete f.hooks.history;
  await binding.refreshSessions(); await binding.refreshMessages(key, { fresh: true });
  assert.equal(binding.runtimes.history.historyReady(key), true); assert.equal(f.sockets.length, 2);
  assert.equal(f.methods.filter(method => method === 'agent').length, 0);
});

test('the original registry and transcript source remain usable without Gateway or a native executor', async t => {
  const f = await fixture(t), home = join(f.root, '.openclaw'), sessions = join(home, 'agents/main/sessions');
  await mkdir(sessions, { recursive: true, mode: 0o700 });
  const transcript = join(sessions, 'original-local.jsonl');
  await writeFile(join(sessions, 'sessions.json'), JSON.stringify({ [key]: { sessionId: 'original-local', sessionFile: transcript, label: 'Local original' } }));
  await writeFile(transcript, JSON.stringify({ type: 'message', timestamp: 100, message: { role: 'assistant', content: [{ type: 'text', text: 'Original local transcript' }] } }) + '\n');
  const binding = await createAsyncOpenClawBinding({ ...f.options, config: { ...f.config, gatewayWsUrl: undefined, localOpenClawCli: true,
    nativeFileRoots: { ...f.config.nativeFileRoots, home, configFile: join(home, 'openclaw.json') } } },
    { readDiskUsage: async () => new Map() });
  const app = new AsyncOpenClawApplication({ ...binding.runtimes, deck: f.deck, owner: f.owner });
  f.releases.push(async () => { await app.close(); await binding.close(); });
  binding.attach(app); await app.start(); await binding.refreshSessions(); await binding.refreshMessages(key);
  assert.equal(f.deck.getSession(key)?.title, 'Local original');
  assert.equal(f.deck.getMessages(key)[0]?.text, 'Original local transcript');
  assert.deepEqual(f.methods, []); assert.equal(f.sockets.length, 0);
  await assert.rejects(binding.refreshMessages(key, { fresh: true }), 'Fresh authoritative history cannot pretend the offline local fallback is current');
});

test('surface attaches the actual binding before activation, refreshes SDK directories and drains the original binding last', async t => {
  const f = await fixture(t); let binding!: Awaited<ReturnType<typeof createAsyncOpenClawBinding>>, directories = 0, attached = 0;
  const surface = await createAsyncConnectorSurface({ owner: f.owner, config: f.config,
    connector: { environmentId: 'original-binding-env', environmentLabel: 'Original binding environment' },
    sampler: { sample: async () => { throw Error('Not sampled'); }, close: async () => {} },
    bind: async context => {
      let assembly: Parameters<NonNullable<import('./async-connector-surface.js').ConnectorSurfaceBinding['attach']>>[0] | undefined;
      binding = await createAsyncOpenClawBinding({ ...f.options, ...context, refreshDirectories: async () => {
        assert.ok(assembly); directories++; await assembly.sdk.refreshDirectories();
      } }, f.ports);
      return { attach: value => { assert.equal(value.state, 'new'); attached++; assembly = value; binding.attach(value); },
        close: binding.close, refreshSessions: binding.refreshSessions, agents: () => [],
        runtimes: { openclaw: binding.runtimes, sdk: {}, hermes: { executionAvailable: () => true, queueChanged: () => {} },
          codex: { native: { enabled: false, command: 'must-not-launch', defaultCwd: f.root, defaultModel: 'default', approvalPolicy: 'never' } } } };
    } });
  f.releases.push(() => surface.close());
  assert.equal(attached, 1); assert.equal(directories, 0); assert.deepEqual(f.methods, []);
  await surface.start(); assert.equal(surface.ready, true); assert.ok(directories > 0);
  const response = await surface.app.request('/api/connector/v1/sessions/state', { headers: { authorization } });
  assert.equal(response.status, 200); assert.match(JSON.stringify(await response.json()), /Original native session/);
  await surface.close(); assert.equal(surface.state, 'closed'); assert.equal(binding.gateway.connectionId(), undefined);
  assert.ok(await f.owner.command('nodeIdentity', {}), 'Surface must retain the sole startup SQL owner');
});

test('partial construction waits physical cleanup and redacts failures before rejecting', async t => {
  const f = await fixture(t), held = gate(); let entered = false, returned = false;
  const constructing = createAsyncOpenClawBinding(f.options, { gateway: settings => {
    const gateway = new GatewayWsClient(settings), close = gateway.closeAndDrain.bind(gateway);
    gateway.closeAndDrain = async () => { entered = true; await held.promise; await close(); };
    return gateway;
  }, source: () => { throw Error('PRIVATE construction detail'); } });
  const rejection = assert.rejects(constructing, error => error instanceof Error && !error.message.includes('PRIVATE'));
  void rejection.then(() => { returned = true; });
  await until(() => entered); await tick(); assert.equal(returned, false);
  held.release(); await rejection; assert.equal(f.sockets.length, 0);
  assert.doesNotMatch(f.logs.join('\n'), /PRIVATE/);
});

test('early transport observation fails closed without direct Deck ingestion or a replacement observer', async t => {
  const f = await fixture(t); let observer!: GatewayAsyncObserver;
  const binding = await createAsyncOpenClawBinding(f.options, { ...f.ports, gateway: settings => {
    observer = settings.asyncObserver!; return new GatewayWsClient(settings);
  } });
  f.releases.push(() => binding.close());
  await assert.rejects(observer.event({ event: 'chat', payload: { sessionKey: key, text: 'Unowned event' } }, 'unowned-connection'));
  observer.unavailable();
  assert.equal(f.deck.getSession(key), undefined); assert.deepEqual(f.deck.getMessages(key), []);
  assert.throws(() => binding.attach({ gatewayObserver: observer }));
  await assert.rejects(binding.refreshSessions()); assert.deepEqual(f.methods, []);
});
