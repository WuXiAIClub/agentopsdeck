import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { WebSocketServer, type WebSocket } from 'ws';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';
import { HISTORY_ASYNC_HEADER } from '@agentopsdeck/shared';
import { ConnectorTokenStore, DEFAULT_SCOPES } from '../auth/connector-token.js';
import { DeckStore } from '../projection/deck-store.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { createConnectorOwnerCommands } from './connector-owner-domain.js';
import { AsyncOpenClawApplication, type AsyncOpenClawApplicationOptions } from './async-openclaw-application.js';
import { registerOpenClawMessagesHttp } from './openclaw-messages-http.js';
import { registerOpenClawReadsHttp } from './openclaw-reads-http.js';
import { GatewayWsClient } from '../gateway/ws-client.js';
import { createOpenClawHistory } from '../openclaw/history-projection.js';

const token = 'isolated-openclaw-application-token', authorization = `Bearer ${token}`;
const key = 'agent:main:dashboard:application', wait = { timeoutMs: 10_000 };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
async function until(check: () => boolean | Promise<boolean>) {
  const end = Date.now() + 10_000;
  while (!await check()) { assert.ok(Date.now() < end, 'OpenClaw application did not converge'); await tick(); }
}
type Command = AsyncConnectorOwner['command'];
async function fixture(worker = false, transport?: AsyncOpenClawApplicationOptions['dispatch']['gateway'],
  originalHistory?: (deck: DeckStore, diagnostics: PerformanceDiagnostics) => AsyncOpenClawApplicationOptions['history'],
  mirrorConfig?: { key: string; mirror: NonNullable<AsyncOpenClawApplicationOptions['mirror']> }) {
  const sessionKey = mirrorConfig?.key ?? key;
  const directory = mkdtempSync(join(tmpdir(), 'openclaw-application-'));
  const logs: string[] = [], diagnostics = new PerformanceDiagnostics(line => logs.push(line));
  const files = { file: join(directory, 'connector.sqlite'), tokenFile: join(directory, 'tokens.json'), bootstrapToken: token };
  // Mirror authority is deliberately NOT part of the bootstrap defaults. Give
  // this original caller its explicit scope; never broaden production defaults.
  const fixtureAuthorization = mirrorConfig ? `Bearer ${new ConnectorTokenStore(files.tokenFile, token, diagnostics)
    .create({ label: 'original mirror caller', scopes: [...DEFAULT_SCOPES, 'messages:mirror'] }).token}` : authorization;
  const nativeOwner = worker ? new AsyncConnectorOwner(files, diagnostics) : undefined;
  if (nativeOwner) await nativeOwner.open();
  const tokens = worker ? undefined : new ConnectorTokenStore(files.tokenFile, token, diagnostics);
  const store = worker ? undefined : new ConnectorUserStore(':memory:', id => !!tokens?.delegationHubId(id), { runtimeOwner: true });
  const original = store ? createConnectorOwnerCommands(store, tokens) : undefined;
  const command: Command = nativeOwner ? (kind, input) => nativeOwner.command(kind, input) : original!;
  const commands: string[] = [], sends: { method: string; params: Record<string, unknown>; connection: string }[] = [];
  const hooks: { before?: (kind: string) => Promise<void>; after?: (kind: string) => Promise<void>;
    send?: () => Promise<void>; changed?: () => Promise<void>; history?: () => Promise<void>;
    invalidate?: () => void; discovery?: () => void; historyClose?: () => Promise<void> } = {};
  let connection: string | undefined = 'original-connection', available = true, admission = true, changed = 0;
  const currentConnection = () => transport ? transport.connectionId() : connection;
  let nativeStatus = 'idle', run = 0;
  const port = { command: (async (kind, input) => {
    commands.push(kind); await hooks.before?.(kind);
    const result = await command(kind, input); await hooks.after?.(kind); return result;
  }) as Command };
  const deck = new DeckStore();
  deck.upsertSession({ sessionKey, agentId: 'main', title: 'Original title', status: 'idle', totalTokens: 10, contextTokens: 100 });
  const options: AsyncOpenClawApplicationOptions = { owner: port, deck, defaultAgentId: 'main', diagnostics,
    history: originalHistory?.(deck, diagnostics) ?? { snapshot: capture => capture('original-read-cursor'), historyReady: () => true,
      preparationWaitMs: 5, refresh: async () => { await hooks.history?.(); },
      invalidate: () => hooks.invalidate?.(), close: async () => { await hooks.historyClose?.(); } },
    invalidateDiscovery: () => hooks.discovery?.(),
    admissionAvailable: () => admission, gatewayStatus: () => available ? 'connected' : 'disconnected',
    dispatch: { gateway: transport ?? {
      connectionId: () => connection, prepareWriteConnection: async () => connection!,
      requestBound: async <T>(method: string, params: Record<string, unknown>, expected?: string, before?: () => void) => {
        assert.equal(expected, connection); before?.();
        sends.push({ method, params: structuredClone(params), connection: connection! });
        await hooks.send?.();
        const payload = method === 'chat.abort' ? { ok: true, aborted: true, runIds: [params.runId] }
          : { runId: `native-${++run}`, status: 'started' };
        return { connectionId: connection!, payload: payload as T };
      } }, native: { available: () => available, epoch: () => currentConnection() ?? 'disconnected' },
      allowCliFallback: false, message: text => text },
    recovery: { connectionId: currentConnection, query: async () => ({ status: 'timeout' }) },
    nativeSession: session => session === sessionKey ? { status: nativeStatus, hasActiveRun: nativeStatus === 'running' } : undefined,
    refreshSessions: async () => {}, refreshMessages: async () => {}, retryMs: 10_000,
    queueChanged: async () => { changed++; await hooks.changed?.(); },
    ...(mirrorConfig ? { mirror: mirrorConfig.mirror } : {}),
  };
  const application = new AsyncOpenClawApplication(options), http = application.http.openClawMessages;
  const scope = { key: sessionKey, authorization: fixtureAuthorization, commandKey: 'original-command' };
  const compactScope = { ...scope, operation: 'message' as const };
  const compact = () => http.compact.compact({ ...compactScope, payloadJson: JSON.stringify({ message: '/compact' }) }, wait);
  const app = new Hono(); registerOpenClawMessagesHttp(app, '/sessions/:sessionKey', http);
  registerOpenClawReadsHttp(app, '/sessions/:sessionKey', application.http.openClawReads);
  const request = (suffix: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => app.request(`/sessions/${encodeURIComponent(sessionKey)}${suffix}`, {
    method, headers: { authorization: fixtureAuthorization, 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { directory, files, store, original, nativeOwner, command, port, options, application, deck, http, hooks, commands, sends, logs,
    scope, compactScope, compact, request, changed: () => changed,
    available: (v: boolean) => { available = v; }, admission: (v: boolean) => { admission = v; },
    nativeStatus: (v: string) => { nativeStatus = v; }, connection: (v: string | undefined) => { connection = v; },
    async close() {
      try { await application.close(); }
      finally { original?.dispose(); store?.close(); await nativeOwner?.close(); rmSync(directory, { recursive: true, force: true }); }
    } };
}

for (const worker of [false, true]) for (const mode of ['pause', 'close'])
test(`application original message/native/mirror chain drains ${mode}, worker=${worker}`, async () => {
  const mirrorKey = 'agent:main:feishu:direct:original-recipient';
  const held = deferred<void>(), outbound: { route: unknown; text: string }[] = [];
  const f = await fixture(worker, undefined, undefined, { key: mirrorKey,
    mirror: { localOpenClawCli: true, sendOutbound: async (route, text) => {
      outbound.push({ route, text }); await held.promise;
    } } });
  try {
    await f.application.start();
    const admitted = await f.http.messages.send({ ...f.scope,
      payloadJson: JSON.stringify({ message: 'original mirror input', deliveryMode: 'mirror' }) }, wait);
    assert.ok(!('error' in admitted));
    await until(async () => !!(await f.command('openClawExecutionRead', { sessionKey: mirrorKey }))?.runId);
    const fact = await f.command('openClawExecutionRead', { sessionKey: mirrorKey });
    assert.ok(fact?.runId);
    // Display/terminal history does not supply native reply evidence.
    await f.application.observe({ event: 'run', payload: { sessionKey: mirrorKey, runId: fact.runId,
      status: 'completed' } }, 'original-connection');
    assert.equal(outbound.length, 0);
    await f.application.observe({ event: 'chat', payload: { sessionKey: mirrorKey, runId: fact.runId,
      state: 'final', seq: 9, message: { role: 'assistant', content: 'original mirror output' } } }, 'original-connection');
    await until(() => outbound.length === 1);
    let drained = false;
    const lease = mode === 'pause' ? f.application.pauseQueueWorker() : undefined;
    const draining = (lease?.drained ?? f.application.close()).then(() => { drained = true; });
    await tick(); assert.equal(drained, false);
    assert.equal(f.application.ready, false);
    held.resolve(); await draining;
    assert.ok(f.commands.includes('mirrorDeliveryAck'));
    assert.deepEqual(outbound, [{ route: { originatingChannel: 'feishu', originatingTo: 'original-recipient',
      originatingAccountId: 'main', outboundTarget: 'user:original-recipient' },
    text: 'Input:\noriginal mirror input\n\nOutput:\noriginal mirror output' }]);
    if (lease) { assert.equal(lease.resume(), true); assert.equal(f.application.ready, true); }
    await f.application.close();
    // Original command receipt remains accepted; no second admission or send.
    assert.equal(f.commands.filter(kind => kind === 'openClawMessageCommit').length, 1);
    assert.equal(outbound.length, 1);
    assert.equal(f.logs.some(line => line.includes('original mirror')), false);
  } finally { held.resolve(); await f.close(); }
});

test('application read lifecycle gates startup, permits maintenance and drains original history after 202', async () => {
  const f = await fixture(), held = deferred<void>(); let entered = false, drained = false;
  const reads = f.application.http.openClawReads.reads;
  try {
    assert.equal((await f.request('/state')).status, 503);
    assert.equal(f.commands.length, 0);
    await f.application.start(); f.admission(false); f.available(false);
    await f.application.refreshProjection();
    assert.equal((await f.request('/state')).status, 200);
    f.hooks.history = async () => { entered = true; await held.promise; };
    const pending = await reads.page({ key, authorization, limit: 10, asynchronous: true },
      new Request('http://isolated/messages', { headers: { [HISTORY_ASYNC_HEADER]: '1' } }));
    assert.deepEqual(pending, { pending: true }); assert.equal(entered, true);
    const close = f.application.close().then(() => { drained = true; });
    await tick(); assert.equal(drained, false);
    await assert.rejects(reads.state({ key, authorization }, new Request('http://isolated/state')));
    held.resolve(); await close;
    assert.equal(await f.command('openClawExecutionRead', { sessionKey: key }), null);
  } finally { held.resolve(); await f.close(); }
});

test('connection callback invalidates original history and discovery synchronously before async projection', async () => {
  const f = await fixture(), order: string[] = [], gate = deferred<void>();
  try {
    await f.application.start();
    f.hooks.invalidate = () => { order.push('history'); };
    f.hooks.discovery = () => { order.push('discovery'); };
    f.hooks.before = async kind => { if (kind === 'openClawExecutionRead') { order.push('worker'); await gate.promise; } };
    const work = f.application.connectionChanged();
    assert.deepEqual(order, ['history', 'discovery']); gate.resolve(); await work;
    assert.equal(f.application.ready, true);
  } finally { gate.resolve(); await f.close(); }
});

for (const asyncFailure of [false, true]) test(`invalid original history fence ${asyncFailure ? 'thenable' : 'throw'} latches unavailable without replay`, async () => {
  const f = await fixture();
  try {
    await f.application.start();
    f.hooks.invalidate = asyncFailure ? async () => { throw Error('private invalidation detail'); }
      : () => { throw Error('private invalidation detail'); };
    await assert.rejects(f.application.connectionChanged());
    assert.equal(f.application.ready, false); assert.equal(f.application.status, 'unavailable');
    await assert.rejects(f.application.start()); assert.deepEqual(f.sends, []);
    assert.ok(!f.logs.join('').includes('private invalidation'));
  } finally { await f.close(); }
});

test('application closes original history synchronously and drains non-HTTP native work before releasing projection', async () => {
  const f = await fixture(), gate = deferred<void>(); let called = false, closed = false;
  try {
    await f.application.start();
    f.hooks.historyClose = () => { called = true; return gate.promise; };
    const work = f.application.close(); assert.equal(called, true); assert.equal(f.application.close(), work);
    void work.then(() => { closed = true; }); await tick(); assert.equal(closed, false);
    await assert.rejects(f.application.http.openClawReads.reads.state({ key, authorization }, new Request('http://isolated/state')));
    gate.resolve(); await work;
    assert.equal(await f.command('openClawExecutionRead', { sessionKey: key }), null);
  } finally { gate.resolve(); await f.close(); }
});

test('original history close failure still drains accepted work and closes all application ports', async () => {
  const f = await fixture();
  try {
    await f.application.start(); f.hooks.historyClose = () => { throw Error('private history close'); };
    await assert.rejects(f.application.close()); assert.equal(f.application.ready, false);
    await assert.rejects(f.compact());
    assert.equal(await f.command('openClawExecutionRead', { sessionKey: key }), null, 'shared SQL owner must not be released');
    assert.ok(!f.logs.join('').includes('private history close'));
  } finally { await f.close().catch(() => {}); }
});

test('real Gateway history, original media reader, worker execution and public HTTP share reconnect/close fences', async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
  let observer!: AsyncOpenClawApplication['gatewayObserver'], reads = 0, bridgeEntered = false;
  const media = deferred<void>(); let holdMedia = false;
  server.on('connection', socket => {
    socket.send('{"type":"event","event":"connect.challenge"}');
    socket.on('message', raw => {
      const request = JSON.parse(raw.toString());
      const payload = request.method === 'chat.history' ? { sessionKey: key, messages: [
        { id: 'native-history-row', role: 'assistant', text: 'original Gateway history', createdAt: 100, stopReason: 'stop' },
      ] } : request.method === 'agent' ? { runId: 'native-history-run', status: 'started' } : {};
      if (request.method === 'chat.history') reads++;
      socket.send(JSON.stringify({ type: 'res', id: request.id, ok: true, payload }));
    });
  });
  const gateway = new GatewayWsClient({ url: `ws://127.0.0.1:${(server.address() as { port: number }).port}`,
    ownerToken: undefined, password: undefined, asyncObserver: {
      event: (raw, connectionId) => observer.event(raw, connectionId),
      connectionChanged: id => observer.connectionChanged(id), unavailable: () => observer.unavailable(),
    } });
  let history!: ReturnType<typeof createOpenClawHistory>;
  const f = await fixture(true, gateway, (deck, diagnostics) => {
    history = createOpenClawHistory({ gateway, local: false, readLocal: async () => [], projection: deck, diagnostics,
      bridgeMedia: async () => { bridgeEntered = true; if (holdMedia) await media.promise;
        return { media: [], bridgedReferences: new Set<string>() }; },
      bridgeArtifacts: async () => ({ media: [], bridgedReferences: new Set<string>() }),
    });
    return { snapshot: capture => capture('original-native-history-cursor'), refresh: history,
      historyReady: history.ready, invalidate: history.invalidate, close: history.close, preparationWaitMs: 5 };
  });
  observer = f.application.gatewayObserver;
  t.after(async () => { media.resolve(); await gateway.closeAndDrain(); await f.close();
    await new Promise<void>(resolve => server.close(() => resolve())); });
  await f.application.start(); await gateway.prepareWriteConnection();
  await f.http.messages.send({ ...f.scope, payloadJson: '{"message":"original execution"}' }, wait);
  await until(async () => (await f.command('openClawExecutionRead', { sessionKey: key }))?.runId === 'native-history-run');
  const fact = await f.command('openClawExecutionRead', { sessionKey: key });
  let response = await f.request('/messages'); assert.equal(response.status, 200);
  assert.ok((await response.json()).messages.some((message: { id: string }) => message.id === 'native-history-row'));
  assert.deepEqual(await f.command('openClawExecutionRead', { sessionKey: key }), fact, 'terminal history is not execution-idle proof');
  assert.equal(f.deck.getSession(key)?.hasActiveRun, true); assert.equal(reads, 1);
  // Same connection identity but a new invalidation generation must still read
  // and publish again; an old revision cannot certify this native preparation.
  await f.application.connectionChanged(); holdMedia = true; bridgeEntered = false;
  response = await f.request('/messages', 'GET', undefined, { [HISTORY_ASYNC_HEADER]: '1' });
  assert.equal(response.status, 202); assert.equal(bridgeEntered, true); assert.equal(reads, 2);
  assert.equal(history.ready(key), false);
  let closed = false; const closing = f.application.close(); void closing.then(() => { closed = true; });
  await tick(); assert.equal(closed, false);
  media.resolve(); await closing;
  assert.equal(history.ready(key), false);
  assert.deepEqual(await f.command('openClawExecutionRead', { sessionKey: key }), fact);
});

test('missing original history capability fails before binding the application projection', async () => {
  const f = await fixture();
  try {
    for (const field of ['snapshot', 'refresh', 'historyReady', 'invalidate', 'close'] as const) {
      const deck = new DeckStore();
      assert.throws(() => new AsyncOpenClawApplication({ ...f.options, deck,
        history: { ...f.options.history, [field]: undefined } } as unknown as AsyncOpenClawApplicationOptions), /history and (event snapshot|discovery lifecycle) required/);
      assert.equal(f.commands.length, 0);
      // A second, valid application can still bind this original projection.
      const valid = new AsyncOpenClawApplication({ ...f.options, deck }); await valid.close();
    }
    assert.throws(() => new AsyncOpenClawApplication({ ...f.options, invalidateDiscovery: undefined } as unknown as AsyncOpenClawApplicationOptions),
      /discovery lifecycle required/);
  } finally { await f.close(); }
});

for (const failed of [false, true]) {
  test(`original Gateway async observer with real SQL worker ${failed ? 'latches failed commit without replay' : 'commits before display and drains before owner close'}`, async t => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
    let wire!: WebSocket, observer!: AsyncOpenClawApplication['gatewayObserver'];
    const writes: string[] = [];
    server.on('connection', socket => {
      wire = socket; socket.send('{"type":"event","event":"connect.challenge"}');
      socket.on('message', raw => {
        const request = JSON.parse(raw.toString());
        if (request.method !== 'connect') writes.push(request.method);
        const payload = request.method === 'agent' ? { runId: 'wire-run', status: 'started' }
          : request.method === 'chat.abort' ? { ok: true, aborted: true, runIds: [request.params.runId] } : {};
        socket.send(JSON.stringify({ type: 'res', id: request.id, ok: true, payload }));
      });
    });
    const gateway = new GatewayWsClient({ url: `ws://127.0.0.1:${(server.address() as { port: number }).port}`,
      ownerToken: undefined, password: undefined, asyncObserver: {
        event: (raw, connectionId) => observer.event(raw, connectionId),
        connectionChanged: id => observer.connectionChanged(id), unavailable: () => observer.unavailable(),
      } });
    const f = await fixture(true, gateway), gate = deferred<void>(); let entered = false;
    observer = f.application.gatewayObserver;
    t.after(async () => { gate.resolve(); await gateway.closeAndDrain(); await f.close();
      await new Promise<void>(resolve => server.close(() => resolve())); });
    await f.application.start(); await gateway.prepareWriteConnection();
    const admitted = await f.http.messages.send({ ...f.scope, payloadJson: '{"message":"original message"}' }, wait);
    assert.ok(!('error' in admitted));
    await until(async () => (await f.command('openClawExecutionRead', { sessionKey: key }))?.runId === 'wire-run');
    const original = gateway.connectionId();
    f.hooks.before = async kind => { if (kind === 'openClawExecutionObserve') {
      entered = true; await gate.promise; if (failed) throw Error('private SQL failure');
    } };
    wire.send(JSON.stringify({ type: 'event', event: 'run', payload: { sessionKey: key, runId: 'wire-run', status: 'waiting' } }));
    await until(() => entered);
    assert.equal((await f.command('openClawExecutionRead', { sessionKey: key }))?.phase, 'starting');
    // Exact native control does not wait for the blocked event observation.
    await gateway.requestBound('chat.abort', { sessionKey: key, runId: 'wire-run' }, original);
    if (failed) {
      gate.resolve(); await gateway.drainObservers();
      assert.equal(f.application.ready, false); assert.equal(f.application.status, 'unavailable');
      assert.equal(gateway.status().observerFailed, true);
      await assert.rejects(gateway.requestBound('agent', {}, original));
      await assert.rejects(f.application.start()); assert.equal(f.application.ready, false, 'start cannot reset a failed application');
      assert.equal((await f.command('openClawExecutionRead', { sessionKey: key }))?.phase, 'starting');
    } else {
      let drained = false; const close = gateway.closeAndDrain().then(() => { drained = true; });
      await tick(); assert.equal(drained, false); gate.resolve(); await close;
      const committed = await f.command('openClawExecutionRead', { sessionKey: key });
      assert.equal(committed?.phase, 'waiting'); assert.equal(committed?.gatewayConnectionId, original);
      await f.application.close();
      assert.equal((await f.command('openClawExecutionRead', { sessionKey: key }))?.phase, 'waiting', 'shared SQL owner remains readable');
    }
    assert.deepEqual(writes, ['agent', 'chat.abort']); assert.ok(!f.logs.join('').includes('private SQL'));
  });
}

test('OpenClaw assembly is inert and all control ports share the startup gate', async () => {
  const f = await fixture();
  try {
    assert.equal(f.application.status, 'created'); assert.equal(f.application.ready, false);
    await assert.rejects(f.application.refreshProjection());
    await assert.rejects(f.compact());
    await assert.rejects(f.http.messages.send({ ...f.scope, payloadJson: '{"message":"ordinary"}' }, wait));
    await assert.rejects(f.http.status.send({ ...f.scope, payloadJson: '{"message":"/status"}' }, wait));
    await assert.rejects(f.http.stop.stop({ ...f.scope, payloadJson: '{"message":"/stop","expectedRunId":"original"}' }, wait));
    assert.equal(f.commands.length, 0); assert.deepEqual(f.sends, []);
    const start = f.application.start(); assert.equal(f.application.start(), start); await start;
    assert.equal(f.application.ready, true); assert.equal(f.application.status, 'ready');
    assert.ok(f.commands.indexOf('executionSessionPage') >= 0);
    assert.deepEqual(f.sends, []);
    await f.application.close();
    await assert.rejects(f.application.refreshProjection());
    await assert.rejects(f.application.start()); await assert.rejects(f.compact());
    assert.equal(await f.command('openClawExecutionRead', { sessionKey: key }), null, 'application must not close shared owner');
  } finally { await f.close(); }
});

test('OpenClaw application rejects unbounded deadlines before binding a projection', async () => {
  const f = await fixture();
  try {
    for (const timeoutMs of [0, -1, NaN, Infinity, 2_147_483_648])
      assert.throws(() => new AsyncOpenClawApplication({ ...f.options, deck: new DeckStore(), timeoutMs }), RangeError);
  } finally { await f.close(); }
});

test('close retains an opening projection and cannot start the queue afterward', async () => {
  const f = await fixture(), gate = deferred<void>(); let reached = false, closed = false;
  f.hooks.after = async kind => { if (kind === 'eventProjectionHead' && !reached) { reached = true; await gate.promise; } };
  try {
    const start = f.application.start(); const rejected = assert.rejects(start);
    await until(() => reached);
    const close = f.application.close().then(() => { closed = true; });
    await tick(); assert.equal(closed, false); assert.equal(f.application.ready, false);
    gate.resolve(); await rejected; await close;
    assert.deepEqual(f.sends, []); assert.equal(f.application.status, 'closed');
  } finally { gate.resolve(); await f.close(); }
});

test('bootstrap failure is latched and logged without retrying or replacing the worker', async () => {
  const f = await fixture();
  f.hooks.before = async kind => { if (kind === 'executionSessionPage') throw Error('private opening detail'); };
  try {
    await assert.rejects(f.application.start()); await assert.rejects(f.application.start());
    assert.equal(f.application.ready, false); assert.equal(f.application.status, 'unavailable');
    assert.equal(f.commands.filter(k => k === 'executionSessionPage').length, 1);
    assert.ok(f.logs.some(line => line.includes('openclaw-application')));
    assert.ok(f.logs.every(line => !line.includes(token) && !line.includes('private opening detail') && !line.includes(key)));
  } finally { await f.close(); }
});

test('ordinary HTTP input reaches the same queue, one native send and original durable receipt', async () => {
  const f = await fixture();
  try {
    await f.application.start();
    const response = await f.request('/messages', 'POST', { message: 'original private input', idempotencyKey: f.scope.commandKey });
    assert.equal(response.status, 200);
    await until(async () => (await f.command('openClawExecutionRead', { sessionKey: key }))?.runId !== undefined);
    assert.equal(f.sends.length, 1); assert.equal(f.sends[0]?.params.message, 'original private input'); assert.equal(f.changed(), 1);
    const recovered = await f.request(`/commands/${f.scope.commandKey}`); assert.equal(recovered.status, 200);
    const duplicate = await f.request('/messages', 'POST', { message: 'original private input', idempotencyKey: f.scope.commandKey });
    assert.equal(duplicate.status, 200); assert.equal(f.sends.length, 1);
    assert.ok(f.commands.includes('openClawMessageCommit')); assert.ok(f.commands.includes('openClawDispatchReady'));
  } finally { await f.close(); }
});

test('maintenance vetoes fresh effects but preserves exact stop and status/current receipt recovery', async () => {
  const f = await fixture();
  try {
    await f.application.start(); const result = await f.compact();
    assert.ok(!('error' in result) && result.receipt?.state === 'accepted');
    const original = await f.command('openClawExecutionRead', { sessionKey: key }); assert.ok(original?.commandId);
    assert.equal(f.deck.getSession(key)?.hasActiveRun, true);
    f.admission(false); assert.equal(f.application.ready, false);
    const stop = await f.http.stop.stop({ ...f.scope, commandKey: 'original-stop', payloadJson: JSON.stringify({ message: '/stop', expectedRunId: original.commandId }) }, wait);
    assert.ok(!('error' in stop) && stop.receipt?.state === 'accepted');
    assert.deepEqual(f.sends[1]?.params, { sessionKey: key, runId: original.runId });
    assert.equal((await f.command('openClawExecutionRead', { sessionKey: key }))?.commandId, original.commandId);
    assert.equal((await f.command('openClawExecutionRead', { sessionKey: key }))?.phase, 'starting', 'abort ACK is not terminal proof');
    const status = await f.request('/messages', 'POST', { message: '/status', idempotencyKey: 'original-status' });
    assert.equal(status.status, 200); assert.ok(f.deck.getMessages(key).some(message => message.id.startsWith('local-status:')));
    const read = await f.http.compact.read(f.compactScope, wait); assert.ok(!('error' in read));
    assert.deepEqual(read.receipt, result.receipt); assert.equal(f.sends.length, 2);
    f.available(false);
    const offline = await f.http.messages.readReceipt(f.scope, wait); assert.ok(!('error' in offline));
    assert.equal(f.sends.length, 2);
  } finally { await f.close(); }
});

test('native events are persisted before display; accepted observation drains before projection closes', async () => {
  const f = await fixture(), gate = deferred<void>(); let reached = false, closed = false;
  try {
    await f.application.start(); await f.compact();
    f.hooks.before = async kind => { if (kind === 'openClawExecutionObserve') { reached = true; await gate.promise; } };
    const observation = f.application.observe({ event: 'run', payload: { sessionKey: key, runId: 'native-1', status: 'waiting' } }, 'original-connection');
    await until(() => reached);
    assert.equal(f.store?.openClawExecutions.get(key)?.phase, 'starting');
    const close = f.application.close().then(() => { closed = true; });
    await tick(); assert.equal(closed, false); gate.resolve();
    assert.equal(await observation, true); await close;
    assert.equal(f.store?.openClawExecutions.get(key)?.phase, 'waiting');
    await assert.rejects(f.application.observe({}, 'original-connection'));
  } finally { gate.resolve(); await f.close(); }
});

test('lost native observation disables new effects without clearing the original execution or receipt', async () => {
  const f = await fixture();
  try {
    await f.application.start(); const result = await f.compact();
    f.hooks.before = async kind => { if (kind === 'openClawExecutionObserve') throw Error('private SQL failure'); };
    await assert.rejects(f.application.observe({ event: 'run', payload: { sessionKey: key, runId: 'native-1', status: 'waiting' } }, 'original-connection'));
    assert.equal(f.application.ready, false); assert.equal(f.application.status, 'unavailable');
    assert.equal(f.store?.openClawExecutions.get(key)?.phase, 'starting');
    const read = await f.http.messages.readReceipt(f.scope, wait); assert.ok(!('error' in read) && !('error' in result));
    assert.deepEqual(read.receipt, result.receipt); assert.equal(f.sends.length, 1);
  } finally { await f.close(); }
});

test('caller deadline does not release a physical compact; close waits and never replays', async () => {
  const f = await fixture(), gate = deferred<void>(); let closed = false;
  f.hooks.send = () => gate.promise;
  try {
    await f.application.start();
    const physical = f.http.compact.compact({ ...f.compactScope, payloadJson: '{"message":"/compact"}' }, { timeoutMs: 20 });
    const timedOut = assert.rejects(physical);
    await until(() => f.sends.length === 1); await timedOut;
    const close = f.application.close().then(() => { closed = true; });
    await tick(); assert.equal(closed, false); gate.resolve(); await close;
    assert.equal(f.sends.length, 1); assert.equal(f.store?.openClawExecutions.get(key)?.phase, 'starting');
    const receipt = await f.command('openClawMessageReceiptRead', f.scope);
    assert.ok(!('error' in receipt) && receipt.receipt?.state === 'accepted');
  } finally { gate.resolve(); await f.close(); }
});

test('maintenance pauses fresh effects and drains timed-out native work without blocking exact stop or receipts', async () => {
  const f = await fixture(), gate = deferred<void>(); let drained = false;
  f.hooks.send = () => gate.promise;
  try {
    await f.application.start();
    const timedOut = assert.rejects(f.http.compact.compact({ ...f.compactScope, payloadJson: '{"message":"/compact"}' }, { timeoutMs: 20 }));
    await until(() => f.sends.length === 1); await timedOut;
    const pause = f.application.pauseQueueWorker();
    assert.equal(f.application.pauseQueueWorker(), pause);
    assert.equal(f.application.ready, false); assert.equal(pause.resume(), false);
    const drain = pause.drained.then(() => { drained = true; });
    await tick(); assert.equal(drained, false, 'deadline cannot release physical work');
    const fresh = await f.http.compact.compact({ ...f.compactScope, commandKey: 'fresh-paused', payloadJson: '{"message":"/compact"}' }, wait);
    assert.ok(!('error' in fresh) && fresh.receipt?.state === 'rejected');
    assert.equal(fresh.receipt.result?.status, 409); assert.equal(f.sends.length, 1);
    gate.resolve(); await drain;
    const receipt = await f.http.compact.read(f.compactScope, wait);
    assert.ok(!('error' in receipt) && receipt.receipt?.state === 'accepted');
    const original = await f.command('openClawExecutionRead', { sessionKey: key }); assert.ok(original);
    const stop = await f.http.stop.stop({ ...f.scope, commandKey: 'paused-stop', payloadJson: JSON.stringify({ message: '/stop', expectedRunId: original.commandId }) }, wait);
    assert.ok(!('error' in stop) && stop.receipt?.state === 'accepted');
    assert.equal(f.sends[1]?.method, 'chat.abort'); assert.equal(f.sends[1]?.params.runId, original.runId);
    assert.equal(f.store?.openClawExecutions.get(key)?.phase, 'starting');
    assert.equal(pause.resume(), true); assert.equal(pause.resume(), false); assert.equal(f.application.ready, true);
    await f.application.close(); assert.equal(f.application.pauseQueueWorker().resume(), false);
  } finally { gate.resolve(); await f.close(); }
});

test('maintenance drain retains accepted message notification and close invalidates its lease', async () => {
  const f = await fixture(), gate = deferred<void>(); let drained = false;
  f.hooks.changed = () => gate.promise;
  try {
    await f.application.start();
    const send = f.http.messages.send({ ...f.scope, payloadJson: '{"message":"original"}' }, wait);
    await until(() => f.changed() === 1);
    // The original admitted message may already have dispatched before the
    // notification callback blocks. Maintenance must retain that fact, not
    // pretend it was cancelled; only subsequent dispatches are forbidden.
    const acceptedSends = structuredClone(f.sends);
    const pause = f.application.pauseQueueWorker(), drain = pause.drained.then(() => { drained = true; });
    await tick(); assert.equal(drained, false); assert.equal(pause.resume(), false);
    const fresh = await f.http.messages.send({ ...f.scope, commandKey: 'fresh-paused', payloadJson: '{"message":"new"}' }, wait);
    assert.ok(!('error' in fresh) && fresh.receipt?.state === 'rejected');
    assert.equal(fresh.receipt.result?.status, 409); assert.deepEqual(f.sends, acceptedSends);
    gate.resolve(); const result = await send; await drain;
    assert.ok(!('error' in result) && result.receipt?.state === 'accepted');
    assert.deepEqual(f.sends, acceptedSends);
    await f.application.close(); assert.equal(pause.resume(), false);
  } finally { gate.resolve(); await f.close(); }
});

test('a failed observation cannot be resumed through a completed maintenance lease', async () => {
  const f = await fixture();
  try {
    await f.application.start(); await f.compact();
    const pause = f.application.pauseQueueWorker(); await pause.drained;
    f.hooks.before = async kind => { if (kind === 'openClawExecutionObserve') throw Error('isolated persistence failure'); };
    await assert.rejects(f.application.observe({ event: 'run', payload: { sessionKey: key, runId: 'native-1', status: 'waiting' } }, 'original-connection'));
    assert.equal(pause.resume(), false); assert.equal(f.application.ready, false);
    assert.equal(f.store?.openClawExecutions.get(key)?.phase, 'starting'); assert.equal(f.sends.length, 1);
  } finally { await f.close(); }
});

test('compact accepted projection is a retained physical callback, including during close', async () => {
  const f = await fixture(), gate = deferred<void>(); let reached = false, closed = false;
  try {
    await f.application.start();
    f.hooks.after = async kind => { if (kind === 'openClawExecutionRead' && f.sends.length && !reached) { reached = true; await gate.promise; } };
    const compact = f.compact(); await until(() => reached);
    const close = f.application.close().then(() => { closed = true; }); await tick(); assert.equal(closed, false);
    gate.resolve(); const result = await compact; await close;
    assert.ok(!('error' in result) && result.receipt?.state === 'accepted'); assert.equal(f.sends.length, 1);
    assert.equal(f.deck.getMessages(key).some(message => message.role === 'user'), false, 'closed display must not publish a late echo');
  } finally { gate.resolve(); await f.close(); }
});

test('real worker assembly exposes all migrated controls and recovers original compact across close/reopen', async () => {
  const f = await fixture(true);
  let reopened: AsyncConnectorOwner | undefined, second: AsyncOpenClawApplication | undefined;
  try {
    await f.application.start();
    const response = await f.request('/messages', 'POST', { message: '/compact', idempotencyKey: f.scope.commandKey });
    assert.equal(response.status, 200); assert.equal(f.sends.length, 1);
    const original = await f.http.compact.read(f.compactScope, wait); assert.ok(!('error' in original));
    await f.application.close(); await f.nativeOwner!.close();
    reopened = new AsyncConnectorOwner(f.files, f.options.diagnostics); await reopened.open();
    const deck = new DeckStore(); deck.upsertSession({ sessionKey: key, agentId: 'main', title: 'Reopened', status: 'idle' });
    second = new AsyncOpenClawApplication({ ...f.options, owner: reopened, deck }); await second.start();
    const recovered = await second.http.openClawMessages.compact.read(f.compactScope, wait);
    assert.ok(!('error' in recovered)); assert.deepEqual(recovered.receipt, original.receipt);
    const duplicate = await second.http.openClawMessages.compact.compact({ ...f.compactScope, payloadJson: '{"message":"/compact"}' }, wait);
    assert.ok(!('error' in duplicate)); assert.deepEqual(duplicate.receipt, original.receipt);
    assert.equal(f.sends.length, 1); assert.ok(deck.getMessages(key).some(message => message.id === original.receipt?.id));
  } finally { await second?.close(); await reopened?.close(); await f.close(); }
});
