import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { WebSocketServer, type WebSocket } from 'ws';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { GatewayWsClient } from '../gateway/ws-client.js';
import { DeckStore } from '../projection/deck-store.js';
import { createOpenClawDispatch } from './dispatch.js';
import { isNormalOpenClawCompletion } from './recovery.js';
import { OpenClawTurnQueue } from './turn-queue.js';

const sessionKey = 'agent:main:dashboard:synthetic-recovery';
const completed = (runId: string) => ({ runId, status: 'ok', startedAt: 1, endedAt: 2 });
const entry = (id: string) => ({ id, sessionKey, createdAt: 1,
  payload: { message: id, media: [], deliveryMode: 'web-only' as const } });
const reconcile = (queue: OpenClawTurnQueue) => (queue as any).reconcile(sessionKey) as Promise<void>;
async function until(condition: () => boolean, timeout = 1000) {
  const deadline = Date.now() + timeout;
  while (!condition() && Date.now() < deadline) await delay(5);
  assert.ok(condition(), 'recovery did not reach expected state');
}

async function fixture(t: test.TestContext, response: (request: any, socket: WebSocket) => unknown | Promise<unknown>,
  history?: (fresh: boolean) => Promise<void>) {
  const db = new ConnectorUserStore(':memory:');
  const store = new DeckStore({ eventLog: db.events });
  store.upsertSession({ sessionKey, agentId: 'main', title: 'Synthetic', status: 'idle' });
  assert.equal(store.getSessionExecution(sessionKey)?.status, 'idle');
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const requests: any[] = [];
  server.on('connection', (socket) => {
    socket.send(JSON.stringify({ type: 'event', event: 'connect.challenge' }));
    socket.on('message', (raw) => {
      const request = JSON.parse(raw.toString());
      if (request.method === 'connect') { socket.send(JSON.stringify({ type: 'res', id: request.id, ok: true })); return; }
      requests.push(request);
      void Promise.resolve().then(() => response(request, socket)).then((payload) => {
        socket.send(JSON.stringify({ type: 'res', id: request.id, ok: true, payload }));
      }).catch(() => socket.close());
    });
  });
  const gateway = new GatewayWsClient({ url: `ws://127.0.0.1:${(server.address() as { port: number }).port}`,
    ownerToken: undefined, password: undefined,
    onEvent: (event, connectionId) => { store.ingestGatewayEvent(event, connectionId); },
    onConnectionChange: () => { store.projectOpenClawConnection(); } });
  let refreshes = 0, sessionRefreshes = 0;
  const dispatch = createOpenClawDispatch({ gateway, store, executions: db.openClawExecutions,
    allowCliFallback: false, authorizeTurn: () => true, message: (text) => text });
  const queue = new OpenClawTurnQueue({ store, turns: db.turns, executions: db.openClawExecutions,
    authorizeTurn: () => true, refreshSessions: async () => { sessionRefreshes++; },
    refreshMessages: async (_key, options) => { refreshes++; await history?.(options?.fresh === true); }, send: dispatch, mirror: async () => {},
    recovery: { connectionId: () => gateway.connectionId(),
      query: async (runId, connectionId) => (await gateway.requestBound('agent.wait', { runId, timeoutMs: 0 }, connectionId)).payload } });
  t.after(async () => { gateway.close(); await queue.close(); await new Promise<void>((resolve) => server.close(() => resolve())); db.close(); });
  return { db, store, gateway, queue, requests, server, refreshes: () => refreshes, sessionRefreshes: () => sessionRefreshes };
}

test('empty-queue live completion retries durable history work without browser activity or agent replay', async (t) => {
  let fail = true;
  const f = await fixture(t, () => ({ runId: 'native-one', status: 'accepted' }), async (fresh) => {
    if (fresh && fail) throw new Error('Synthetic history failure');
  });
  f.queue.enqueue(entry('one')); await reconcile(f.queue);
  for (const peer of f.server.clients) peer.send(JSON.stringify({ type: 'event', event: 'run.completed',
    payload: { sessionKey, runId: 'native-one' } }));
  await f.gateway.request('sessions.list');
  assert.equal(f.db.turns.list('openclaw').length, 0);
  assert.equal(f.db.openClawExecutions.get(sessionKey)?.historySync?.state, 'pending');
  f.queue.start();
  await until(() => f.db.openClawExecutions.get(sessionKey)?.historySync?.state === 'error');
  assert.equal(f.db.openClawExecutions.get(sessionKey)?.phase, 'completed');
  assert.equal(f.store.getSessionExecution(sessionKey)?.status, 'idle');
  assert.equal(f.store.getSessionExecution(sessionKey)?.runtime?.sync, 'error');
  fail = false; // Original 5s worker retry, without a browser/wake callback.
  await until(() => f.db.openClawExecutions.get(sessionKey)?.historySync?.state === 'current', 6500);
  await until(() => !(f.queue as any).worker.inflight);
  assert.equal(f.store.getSessionExecution(sessionKey)?.runtime?.sync, 'current');
  assert.equal((f.queue as any).worker.timer, undefined);
  assert.equal(f.requests.filter((request) => request.method === 'agent').length, 1);
  assert.equal(f.requests.filter((request) => request.method === 'agent.wait').length, 0);
  assert.deepEqual(f.db.openClawExecutions.historyPage(), []);
});

test('disconnect and replacement publish uncertainty and retain queued input without replay', async (t) => {
  const f = await fixture(t, () => ({ runId: 'native-one', status: 'accepted' }));
  f.queue.enqueue(entry('one')); await reconcile(f.queue);
  for (const peer of f.server.clients) peer.send(JSON.stringify({ type: 'event', event: 'run.running',
    payload: { sessionKey, runId: 'native-one' } }));
  await f.gateway.request('sessions.list');
  assert.equal(f.store.getSessionExecution(sessionKey)?.runtime?.phase, 'running');
  f.queue.enqueue(entry('two'));
  const original = f.gateway.connectionId();
  const cursor = f.store.latestEventId()!;
  const socket = (f.gateway as unknown as { socket: WebSocket }).socket;
  const closed = once(socket, 'close'); socket.terminate(); await closed;
  assert.equal(f.store.getSessionExecution(sessionKey)?.status, 'unknown');
  assert.ok(f.store.getEventsSince(cursor).some((e) => e.type === 'run.updated'));
  await reconcile(f.queue);
  await f.gateway.request('sessions.list');
  assert.notEqual(f.gateway.connectionId(), original);
  assert.equal(f.store.getSessionExecution(sessionKey)?.runtime?.connection, 'connected');
  assert.equal(f.store.getSessionExecution(sessionKey)?.status, 'unknown');
  await reconcile(f.queue);
  assert.deepEqual(f.db.turns.list('openclaw').map((turn) => turn.id), ['two']);
  assert.equal(f.db.openClawExecutions.get(sessionKey)?.phase, 'running');
  assert.equal(f.requests.filter((request) => request.method === 'agent').length, 1);
  assert.equal(f.requests.filter((request) => request.method === 'agent.wait').length, 0);
});

test('history failure after wait recovery does not prevent a successor or erase the pending sync generation', async (t) => {
  const f = await fixture(t, (request) => request.method === 'agent'
    ? { runId: `native-${request.params.idempotencyKey}` } : completed(request.params.runId), async (fresh) => {
    if (fresh) throw new Error('Synthetic history failure');
  });
  f.queue.enqueue(entry('one')); f.queue.enqueue(entry('two'));
  await reconcile(f.queue); await reconcile(f.queue);
  assert.equal(f.db.openClawExecutions.get(sessionKey)?.commandId, 'two');
  assert.equal(f.db.openClawExecutions.get(sessionKey)?.historySync?.state, 'error');
  assert.equal(f.requests.filter((request) => request.method === 'agent').length, 2);
  await reconcile(f.queue);
  assert.equal(f.db.openClawExecutions.get(sessionKey)?.phase, 'completed');
  assert.equal(f.db.openClawExecutions.get(sessionKey)?.historySync?.revision, 2);
  assert.equal(f.requests.filter((request) => request.method === 'agent').length, 2);
});

test('closing drains the active history read without clearing durable work for the next runtime', async (t) => {
  let release!: () => void, started!: () => void;
  const waiting = new Promise<void>((resolve) => { started = resolve; });
  const reading = new Promise<void>((resolve) => { release = resolve; });
  const f = await fixture(t, () => ({ runId: 'native-one' }), async (fresh) => {
    if (fresh) { started(); await reading; }
  });
  f.queue.enqueue(entry('one')); await reconcile(f.queue);
  f.db.openClawExecutions.observe(sessionKey, { runId: 'native-one', phase: 'completed', gatewayConnectionId: f.gateway.connectionId() });
  f.queue.start(); await waiting;
  let closed = false;
  const closing = f.queue.close().then(() => { closed = true; });
  assert.equal(closed, false);
  release(); await closing;
  assert.equal(f.db.openClawExecutions.get(sessionKey)?.historySync?.state, 'pending');
  assert.equal((f.queue as any).worker.timer, undefined);
  assert.equal(f.requests.filter((request) => request.method === 'agent').length, 1);
});

test('live terminal before ACK uses authenticated connection metadata, not the event payload source', async (t) => {
  const f = await fixture(t, (request, socket) => {
    if (request.method === 'agent') {
      socket.send(JSON.stringify({ type: 'event', event: 'run.completed', connectionId: 'forged',
        payload: { sessionKey, runId: 'native-one', gatewayConnectionId: 'forged' } }));
      return { runId: 'native-one', status: 'accepted' };
    }
    return {};
  });
  f.queue.enqueue(entry('one')); await reconcile(f.queue);
  assert.equal(f.db.openClawExecutions.get(sessionKey)?.phase, 'completed');
  assert.equal(f.db.openClawExecutions.get(sessionKey)?.gatewayConnectionId, f.gateway.connectionId());
  assert.equal(f.store.getSessionExecution(sessionKey)?.status, 'idle');
  assert.deepEqual(f.requests.map((request) => request.method), ['agent']);
});

test('replacement connection same-run terminal cannot complete the predecessor or release its successor', async (t) => {
  const f = await fixture(t, (request) => request.method === 'agent' ? { runId: 'native-one', status: 'accepted' } : {});
  f.queue.enqueue(entry('one')); f.queue.enqueue(entry('two')); await reconcile(f.queue);
  const accepted = f.db.openClawExecutions.get(sessionKey);
  const socket = (f.gateway as unknown as { socket: WebSocket }).socket;
  const closed = once(socket, 'close'); socket.terminate(); await closed;
  await f.gateway.request('sessions.list');
  assert.notEqual(f.gateway.connectionId(), accepted?.gatewayConnectionId);
  const emit = async (phase: string) => {
    for (const peer of f.server.clients) peer.send(JSON.stringify({ type: 'event', event: `run.${phase}`,
      gatewayConnectionId: accepted?.gatewayConnectionId,
      payload: { sessionKey, runId: 'native-one', gatewayConnectionId: accepted?.gatewayConnectionId } }));
    await f.gateway.request('sessions.list'); // Ordered response barriers, no timing assumptions.
  };
  await emit('completed');
  assert.deepEqual(f.db.openClawExecutions.get(sessionKey), accepted);
  await reconcile(f.queue);
  assert.equal(f.requests.filter((request) => request.method === 'agent').length, 1);
  assert.equal(f.requests.filter((request) => request.method === 'agent.wait').length, 0);
  await emit('running');
  assert.equal(f.db.openClawExecutions.get(sessionKey)?.phase, 'unknown');
  assert.equal(f.store.getSessionExecution(sessionKey)?.status, 'unknown');
  await emit('completed'); await reconcile(f.queue);
  assert.equal(f.requests.filter((request) => request.method === 'agent').length, 1);
});

test('wait success requires exact run identity, timestamps and unambiguous normal completion metadata', () => {
  assert.equal(isNormalOpenClawCompletion(completed('r'), 'r'), true);
  assert.equal(isNormalOpenClawCompletion({ ...completed('r'), stopReason: 'end_turn', yielded: false, pendingError: false, providerStarted: true }, 'r'), true);
  for (const value of [null, [], 'ok', {}, { ...completed('r'), runId: 'other' },
    ...['timeout', 'pending', 'error', 'completed'].map((status) => ({ ...completed('r'), status })),
    ...['yielded', 'pendingError', 'aborted'].flatMap((field) => [true, 'false', null].map((v) => ({ ...completed('r'), [field]: v }))),
    ...['error', 'livenessState', 'timeoutPhase'].flatMap((field) => ['blocked', {}, false, null].map((v) => ({ ...completed('r'), [field]: v }))),
    ...['stop', 'rpc', 'tool_use', null].map((stopReason) => ({ ...completed('r'), stopReason })),
    ...[undefined, -1, NaN, Infinity, '1', 3].map((startedAt) => ({ ...completed('r'), startedAt })),
    ...[undefined, 0, NaN, Infinity, '2'].map((endedAt) => ({ ...completed('r'), endedAt })),
    { ...completed('r'), providerStarted: false },
  ]) assert.equal(isNormalOpenClawCompletion(value, 'r'), false, JSON.stringify(value));
});

test('worker recovers a missed normal end after the last queue entry was accepted without browser reads', async (t) => {
  const f = await fixture(t, (request) => request.method === 'agent'
    ? { runId: 'native-one', status: 'accepted' } : completed(request.params.runId));
  f.queue.enqueue(entry('one')); f.queue.start();
  await until(() => f.db.openClawExecutions.get(sessionKey)?.phase === 'completed', 6500);
  assert.deepEqual(f.requests.map((request) => request.method), ['agent', 'agent.wait']);
  assert.deepEqual(f.requests[1].params, { runId: 'native-one', timeoutMs: 0 });
  assert.equal(f.db.turns.list('openclaw', sessionKey).length, 0);
  assert.equal(f.store.getSessionExecution(sessionKey)?.status, 'idle');
  assert.equal(f.sessionRefreshes(), 1, 'recovery-only work does not enumerate all native sessions');
  assert.equal(f.refreshes(), 2, 'recovery refreshes this session history once');
  await until(() => !(f.queue as any).worker.inflight);
  assert.equal((f.queue as any).worker.timer, undefined);
  assert.equal(f.db.openClawExecutions.recoveryPage(f.gateway.connectionId()).length, 0);
});

test('nonterminal/malformed snapshots retain the predecessor barrier; normal completion permits only the queued successor', async (t) => {
  let snapshot: unknown;
  const f = await fixture(t, (request) => request.method === 'agent'
    ? { runId: `native-${request.params.idempotencyKey}`, status: 'accepted' } : snapshot);
  f.queue.enqueue(entry('one')); f.queue.enqueue(entry('two')); await reconcile(f.queue);
  for (const value of [{ runId: 'native-one', status: 'timeout', timeoutPhase: 'queue', providerStarted: false },
    { ...completed('native-one'), pendingError: true }, { ...completed('native-one'), livenessState: 'blocked' },
    { ...completed('native-one'), yielded: true }, { ...completed('native-one'), status: 'error' }, completed('wrong-run')]) {
    snapshot = value; await reconcile(f.queue);
    assert.equal(f.requests.filter((request) => request.method === 'agent').length, 1);
    assert.equal(f.store.getSessionExecution(sessionKey)?.status, 'running');
  }
  snapshot = completed('native-one'); await reconcile(f.queue);
  assert.deepEqual(f.requests.filter((request) => request.method === 'agent').map((request) => request.params.idempotencyKey), ['one', 'two']);
  assert.equal(f.db.openClawExecutions.get(sessionKey)?.runId, 'native-two');
  assert.equal(f.store.getSessionExecution(sessionKey)?.status, 'running');
});

for (const change of ['same-run-event', 'external-conflict', 'replacement-command', 'connection', 'close'] as const)
test(`a delayed read cannot overwrite changed recovery identity (${change})`, async (t) => {
  let release!: (snapshot: unknown) => void;
  const waiting = new Promise<unknown>((resolve) => { release = resolve; });
  const f = await fixture(t, (request) => request.method === 'agent' ? { runId: 'native-one', status: 'accepted' } : waiting);
  f.queue.enqueue(entry('one')); await reconcile(f.queue);
  const recovering = reconcile(f.queue);
  await until(() => f.requests.some((request) => request.method === 'agent.wait'));
  const runs = f.db.openClawExecutions;
  let closing: Promise<void> | undefined;
  if (change === 'same-run-event') runs.observe(sessionKey, { runId: 'native-one', phase: 'running', gatewayConnectionId: f.gateway.connectionId() });
  if (change === 'external-conflict') runs.unownedActivity(sessionKey);
  if (change === 'replacement-command') {
    runs.observe(sessionKey, { runId: 'native-one', phase: 'completed', gatewayConnectionId: f.gateway.connectionId() });
    assert.equal(runs.begin(sessionKey, 'replacement'), true);
  }
  if (change === 'connection') f.gateway.close();
  if (change === 'close') closing = f.queue.close();
  release(completed('native-one')); await recovering; await closing;
  assert.notEqual(runs.get(sessionKey)?.phase, 'completed');
  assert.equal(f.refreshes(), change === 'replacement-command' ? 2 : 1,
    'only the independently accepted live terminal creates history work, never the discarded query');
  if (change === 'replacement-command') {
    assert.equal(runs.get(sessionKey)?.commandId, 'replacement');
    assert.equal(runs.get(sessionKey)?.phase, 'starting');
    assert.equal(runs.get(sessionKey)?.historySync?.state, 'current');
  }
  assert.equal(f.requests.filter((request) => request.method === 'agent').length, 1);
});

test('equal run/session/command strings on two Gateway nodes cannot exchange recovery evidence', async (t) => {
  const first = await fixture(t, (request) => request.method === 'agent'
    ? { runId: 'same-run', status: 'accepted' } : completed('same-run'));
  const second = await fixture(t, (request) => request.method === 'agent'
    ? { runId: 'same-run', status: 'accepted' } : { runId: 'same-run', status: 'timeout' });
  for (const f of [first, second]) { f.queue.enqueue(entry('same-command')); await reconcile(f.queue); }
  const firstCandidate = first.db.openClawExecutions.recoveryCandidate(sessionKey, first.gateway.connectionId())!;
  assert.notEqual(first.gateway.connectionId(), second.gateway.connectionId());
  assert.equal(second.db.openClawExecutions.completeFromQuery(firstCandidate), false);
  await assert.rejects(second.gateway.requestBound('agent.wait', { runId: 'same-run', timeoutMs: 0 }, first.gateway.connectionId()), /connection changed/);
  assert.equal(second.requests.length, 1);
  await reconcile(first.queue); await reconcile(second.queue);
  assert.equal(first.store.getSessionExecution(sessionKey)?.status, 'idle');
  assert.equal(second.store.getSessionExecution(sessionKey)?.status, 'running');
  assert.equal(second.requests.filter((request) => request.method === 'agent').length, 1);
});

test('missing ACK run or lost query connection never guesses an identity or resends agent', async (t) => {
  let failRead = false;
  const f = await fixture(t, (request) => {
    if (request.method === 'agent') return { status: 'accepted' };
    if (failRead) throw new Error('synthetic lost query response');
    return completed(request.params.runId);
  });
  f.queue.enqueue(entry('one')); await reconcile(f.queue); await reconcile(f.queue);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.db.openClawExecutions.recoveryPage(f.gateway.connectionId()), []);
  f.db.openClawExecutions.acknowledge(sessionKey, 'one', 'native-one');
  failRead = true; await reconcile(f.queue);
  assert.equal(f.gateway.connectionId(), undefined);
  assert.equal(f.db.openClawExecutions.get(sessionKey)?.phase, 'starting', 'ACK alone is not evidence of runtime start');
  assert.equal(f.store.getSessionExecution(sessionKey)?.status, 'unknown');
  assert.equal(f.store.getSessionExecution(sessionKey)?.runtime?.connection, 'disconnected');
  await reconcile(f.queue);
  assert.equal(f.requests.filter((request) => request.method === 'agent').length, 1);
  assert.equal(f.requests.filter((request) => request.method === 'agent.wait').length, 1);
});
