import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { DeckStore } from '../projection/deck-store.js';
import { createOpenClawDispatch } from './dispatch.js';
import { OpenClawTurnQueue } from './turn-queue.js';
import { GatewayRpcError } from '../gateway/rpc-error.js';
import { MirrorDeliveryUnknown } from '../messages/mirror.js';

const sessionKey = 'agent:main:dashboard:execution-wiring';
const entry = (id: string) => ({ id, sessionKey, createdAt: Date.now(), payload: { message: id, media: [], deliveryMode: 'web-only' as const } });
function setup(file = ':memory:') {
  const db = new ConnectorUserStore(file);
  const store = new DeckStore({ eventLog: db.events });
  store.upsertSession({ sessionKey, agentId: 'main', title: 'Synthetic', status: 'idle' });
  return { db, store };
}
function queueFor(db: ConnectorUserStore, store: DeckStore, send: ConstructorParameters<typeof OpenClawTurnQueue>[0]['send']) {
  return new OpenClawTurnQueue({ store, turns: db.turns, executions: db.openClawExecutions, authorizeTurn: () => true,
    refreshSessions: async () => {}, refreshMessages: async () => {}, send, mirror: async () => {} });
}
const reconcile = (queue: OpenClawTurnQueue) => (queue as any).reconcile(sessionKey) as Promise<void>;
function event(store: DeckStore, phase: 'running' | 'completed' | 'failed', runId?: string) {
  return store.ingestGatewayEvent({ event: `run.${phase}`, payload: { sessionKey, ...(runId ? { runId } : {}) } });
}

for (const unknown of [true, false]) test(`mirror outer catch preserves original acceptance and reports only known failure (${unknown})`, async t => {
  const { db, store } = setup();
  const append = t.mock.method(store, 'append');
  let sends = 0, mirrors = 0;
  const queue = new OpenClawTurnQueue({ store, turns: db.turns, executions: db.openClawExecutions, mirrorOutbox: db.mirrorOutbox, authorizeTurn: () => true,
    refreshSessions: async () => {}, refreshMessages: async () => {},
    send: async () => { sends += 1; return { runId: 'synthetic-run' }; },
    mirror: async () => { mirrors += 1; throw unknown ? new MirrorDeliveryUnknown() : new Error('synthetic pre-send failure'); } });
  try {
    queue.enqueue({ ...entry('one'), payload: { ...entry('one').payload, actorId: 'synthetic-actor', deliveryMode: 'mirror', explicitRoute: {
      originatingChannel: 'synthetic', originatingTo: 'original', outboundTarget: 'original',
    } } });
    await reconcile(queue);
    await new Promise(resolve => setImmediate(resolve));
    const failures = append.mock.calls.filter(call => call.arguments[0] === 'queued_message.failed');
    assert.equal(failures.length, unknown ? 0 : 1);
    assert.equal(sends, 1); assert.equal(mirrors, 1);
    assert.equal(db.openClawExecutions.get(sessionKey)?.phase, 'starting', 'ACK is not a runtime started event');
    assert.equal(db.openClawExecutions.get(sessionKey)?.runId, 'synthetic-run');
    await reconcile(queue);
    assert.equal(sends, 1); assert.equal(mirrors, 1);
  } finally { await queue.close(); db.close(); }
});

test('connection and history projections preserve evidence without duplicate completion or stale CLI runtime', () => {
  const { db, store } = setup();
  let connection: string | undefined = 'original';
  const runs = db.openClawExecutions;
  store.bindOpenClawExecutions(runs, () => connection);
  try {
    runs.begin(sessionKey, 'one'); runs.bindGatewayConnection(sessionKey, 'one', 'original');
    runs.acknowledge(sessionKey, 'one', 'native-one');
    runs.observe(sessionKey, { runId: 'native-one', phase: 'running', gatewayConnectionId: 'original' });
    store.projectOpenClawExecution(sessionKey);
    assert.equal(store.getSessionExecution(sessionKey)?.runtime?.phase, 'running');
    const cursor = store.latestEventId()!;
    connection = undefined; store.projectOpenClawConnection();
    assert.equal(store.getSessionExecution(sessionKey)?.runtime?.phase, 'unknown');
    assert.equal(store.getSessionExecution(sessionKey)?.runtime?.connection, 'disconnected');
    assert.equal(runs.get(sessionKey)?.phase, 'running');
    assert.ok(store.getEventsSince(cursor).some((e) => e.type === 'run.updated'));
    connection = 'replacement'; store.projectOpenClawConnection();
    assert.equal(store.getSessionExecution(sessionKey)?.runtime?.phase, 'unknown');
    assert.equal(store.getSessionExecution(sessionKey)?.runtime?.connection, 'connected');
    assert.equal(store.ingestGatewayEvent({ event: 'run.completed', payload: { sessionKey, runId: 'native-one' } }, 'replacement'), false);
    store.ingestGatewayEvent({ event: 'run.completed', payload: { sessionKey, runId: 'native-one' } }, 'original');
    assert.equal(store.getSessionExecution(sessionKey)?.runtime?.phase, 'completed');
    assert.equal(store.getSessionExecution(sessionKey)?.runtime?.sync, 'syncing');
    const completions = () => store.getEventsSince(cursor).filter((e) => e.type === 'run.completed').length;
    assert.equal(completions(), 1);
    const revision = runs.get(sessionKey)!.historySync!.revision;
    runs.setHistorySync(sessionKey, revision, 'error'); store.projectOpenClawExecution(sessionKey);
    assert.equal(store.getSessionExecution(sessionKey)?.runtime?.sync, 'error');
    assert.equal(store.getSessionExecution(sessionKey)?.status, 'idle');
    connection = undefined; store.projectOpenClawConnection();
    assert.equal(store.getSessionExecution(sessionKey)?.runtime?.phase, 'completed');
    runs.setHistorySync(sessionKey, revision, 'current'); store.projectOpenClawExecution(sessionKey);
    assert.equal(completions(), 1);
    runs.begin(sessionKey, 'two'); store.projectOpenClawExecution(sessionKey);
    runs.useCli(sessionKey, 'two'); runs.acknowledgeCli(sessionKey, 'two'); store.projectOpenClawExecution(sessionKey);
    assert.equal(store.getSessionExecution(sessionKey)?.runtime, undefined);
    assert.equal(store.getSessionExecution(sessionKey)?.status, 'running');
  } finally { db.close(); }
});

test('a foreign connection cannot append a failure message into a same-named failed execution', async () => {
  const { db, store } = setup();
  const queue = queueFor(db, store, async () => ({}));
  try {
    const runs = db.openClawExecutions;
    runs.begin(sessionKey, 'one'); runs.bindGatewayConnection(sessionKey, 'one', 'original');
    runs.acknowledge(sessionKey, 'one', 'owned');
    const fail = (source: string, text: string) => store.ingestGatewayEvent({ event: 'run.failed',
      payload: { sessionKey, runId: 'owned', error: text, gatewayConnectionId: 'original' } }, source);
    fail('original', 'original failure');
    const messages = structuredClone(store.getMessages(sessionKey));
    assert.ok(messages.some((message) => message.failureReason === 'original failure'));
    fail('replacement', 'unrelated failure');
    assert.deepEqual(store.getMessages(sessionKey), messages);
    assert.equal(runs.get(sessionKey)?.phase, 'failed');
  } finally { await queue.close(); db.close(); }
});

for (const wire of ['run', 'agent'] as const) test(`${wire} terminal before ACK cannot be revived by ACK, sticky summaries, usage, transcript or an older run`, async () => {
  const { db, store } = setup();
  const sent: string[] = [];
  const queue = queueFor(db, store, async (turn) => {
    sent.push(turn.id);
    if (turn.id === 'one') {
      if (wire === 'agent') store.ingestGatewayEvent({ event: 'agent', payload: { sessionKey, runId: 'remote-one', stream: 'lifecycle', data: { phase: 'end' } } });
      else event(store, 'completed', 'remote-one');
      assert.equal(store.getSessionExecution(sessionKey)?.status, 'running', 'unbound early evidence waits for the ACK');
    }
    return { runId: `remote-${turn.id}`, status: 'accepted' };
  });
  try {
    queue.enqueue(entry('one')); queue.enqueue(entry('two'));
    await reconcile(queue);
    assert.equal(store.getSessionExecution(sessionKey)?.status, 'idle');
    assert.equal(store.getSession(sessionKey)?.status, 'idle');
    const completedAt = store.getSessionExecution(sessionKey)?.runCompletedAt;
    assert.ok(completedAt);
    store.replaceSessions([{ key: sessionKey, status: 'running', hasActiveRun: true, lastRun: { status: 'running' } }]);
    store.applySessionUsage(new Map([[sessionKey, { status: 'running', hasActiveRun: true }]]));
    store.addMessage({ id: 'tool', sessionKey, role: 'tool', toolName: 'exec', text: 'still executing?', status: 'sent', createdAt: Date.now() });
    assert.equal(store.getSessionExecution(sessionKey)?.status, 'idle');
    assert.equal(store.getSessionsState().groups[0]?.sessions[0]?.status, 'idle');
    assert.equal(store.getSessionExecution(sessionKey)?.runCompletedAt, completedAt);
    await reconcile(queue);
    assert.deepEqual(sent, ['one', 'two']);
    assert.equal(store.getSessionExecution(sessionKey)?.runCompletedAt, undefined);
    assert.equal(event(store, 'failed', 'remote-one'), false);
    assert.equal(event(store, 'completed'), false);
    assert.equal(store.getSessionExecution(sessionKey)?.status, 'running');
    assert.equal(event(store, 'completed', 'remote-two'), true);
    assert.equal(store.getSessionExecution(sessionKey)?.status, 'idle');
  } finally { await queue.close(); db.close(); }
});

for (const ack of ['missing-id', 'lost'] as const) test(`${ack} ACK cannot be repaired by user transcript or a default-idle refresh`, async () => {
  const { db, store } = setup(); let calls = 0;
  const queue = queueFor(db, store, async () => { calls++; if (ack === 'lost') throw new Error('synthetic lost ACK'); return {}; });
  try {
    queue.enqueue(entry('one')); queue.enqueue(entry('two'));
    await reconcile(queue);
    store.replaceSessions([{ key: sessionKey }]);
    store.replaceMessages(sessionKey, [{ id: 'one', sessionKey, role: 'user', text: 'one', status: 'sent', createdAt: 1 }]);
    store.addMessage({ id: 'assistant', sessionKey, role: 'assistant', text: 'Done', status: 'sent', createdAt: 2 });
    event(store, 'completed', 'unbound-remote');
    await reconcile(queue);
    assert.equal(calls, 1);
    assert.equal(store.getSession(sessionKey)?.status, 'unknown');
    assert.equal(store.getSessionExecution(sessionKey)?.status, 'unknown');
    assert.deepEqual(db.turns.list('openclaw', sessionKey).map((turn) => turn.id), ack === 'lost' ? ['one', 'two'] : ['two']);
    if (ack === 'lost') assert.equal(db.turns.head('openclaw', sessionKey)?.state, 'outcome_unknown');
  } finally { await queue.close(); db.close(); }
});

test('ambiguous scope-looking failure stays queued unknown and never switches transport or retries', async () => {
  const { db, store } = setup(); let gatewayCalls = 0, cliCalls = 0;
  const dispatch = createOpenClawDispatch({ store, executions: db.openClawExecutions, authorizeTurn: () => true,
    gateway: { requestBound: async () => { gatewayCalls++; throw new Error('missing scope: operator.write'); } } as any,
    allowCliFallback: true, message: (text) => text, startCli: async () => { cliCalls++; return { ok: true }; } });
  const queue = queueFor(db, store, dispatch);
  try {
    queue.enqueue(entry('one')); queue.enqueue(entry('two'));
    await reconcile(queue);
    store.replaceSessions([{ key: sessionKey }]);
    await reconcile(queue);
    assert.equal(gatewayCalls, 1);
    assert.equal(cliCalls, 0);
    assert.equal(db.openClawExecutions.get(sessionKey)?.origin, 'gateway');
    assert.equal(store.getSessionExecution(sessionKey)?.status, 'unknown');
    assert.deepEqual(db.turns.list('openclaw', sessionKey).map(({ id, state }) => ({ id, state })),
      [{ id: 'one', state: 'outcome_unknown' }, { id: 'two', state: 'queued' }]);
  } finally { await queue.close(); db.close(); }
});

for (const early of [false, true]) test(`native retryable lifecycle cannot finish a run (${early ? 'before' : 'after'} ACK)`, async () => {
  const observations = [
    { phase: 'error', error: 'temporary provider failure' },
    { phase: 'end', aborted: true },
    { phase: 'end', yielded: true },
    { phase: 'error', livenessState: 'blocked' },
    { phase: 'end', aborted: 'false' },
    { phase: 'end', yielded: 'false' },
    { phase: 'end', stopReason: 'timeout' },
    { phase: 'end', stopReason: 'restart' },
    { phase: 'end', livenessState: 'future-state' },
    { phase: 'end', error: 'contradictory completion' },
  ];
  for (const data of observations) {
    const { db, store } = setup(); let sent = 0;
    const emit = (data: Record<string, unknown>) => store.ingestGatewayEvent({ event: 'agent',
      payload: { sessionKey, runId: 'owned', stream: 'lifecycle', data } });
    const queue = queueFor(db, store, async () => { sent++; if (early && sent === 1) emit(data); return { runId: `owned${sent === 1 ? '' : '-two'}` }; });
    try {
      queue.enqueue(entry('one')); queue.enqueue(entry('two')); await reconcile(queue);
      if (!early) emit(data);
      assert.ok(['unknown', 'waiting'].includes(store.getSessionExecution(sessionKey)!.status), JSON.stringify(data));
      assert.equal(db.openClawExecutions.get(sessionKey)?.completedAt, undefined);
      assert.equal(store.getMessages(sessionKey).some((message) => message.role === 'assistant'), false);
      await reconcile(queue); assert.equal(sent, 1);
      emit({ phase: 'start' });
      assert.equal(store.getSessionExecution(sessionKey)?.status, 'running');
      emit({ phase: 'finishing', endedAt: Date.now() });
      await reconcile(queue); assert.equal(sent, 1);
      emit({ phase: 'end', aborted: false, stopReason: 'end_turn' });
      assert.equal(store.getSessionExecution(sessionKey)?.status, 'idle');
      await reconcile(queue); assert.equal(sent, 2);
    } finally { await queue.close(); db.close(); }
  }
});

test('explicit fallback exhaustion may fail the matching run, unlike a transient error', async () => {
  const { db, store } = setup();
  const queue = queueFor(db, store, async () => ({ runId: 'owned' }));
  try {
    queue.enqueue(entry('one')); await reconcile(queue);
    store.ingestGatewayEvent({ event: 'agent', payload: { sessionKey, runId: 'owned', stream: 'lifecycle',
      data: { phase: 'error', fallbackExhaustedFailure: true, error: 'all providers exhausted' } } });
    assert.equal(store.getSessionExecution(sessionKey)?.status, 'failed');
    assert.ok(db.openClawExecutions.get(sessionKey)?.completedAt);
  } finally { await queue.close(); db.close(); }
});

for (const when of ['before-ack', 'after-ack', 'cli', 'missing-id'] as const)
test(`unresolved external lifecycle fences the current execution (${when})`, async () => {
  const { db, store } = setup(); let cliCalls = 0;
  const emit = () => store.ingestGatewayEvent({ event: 'agent', payload: { sessionKey,
    ...(when === 'missing-id' ? {} : { runId: 'external' }), stream: 'lifecycle', data: { phase: 'error', error: 'retrying' } } }, 'synthetic-connection');
  const dispatch = createOpenClawDispatch({ store, executions: db.openClawExecutions, authorizeTurn: () => true,
    gateway: { requestBound: async () => {
      if (when === 'before-ack' || when === 'cli') emit();
      if (when === 'cli') throw new GatewayRpcError('agent', 'INVALID_REQUEST', 'missing scope: operator.write');
      return { payload: { runId: 'owned' }, connectionId: 'synthetic-connection' };
    } } as any, allowCliFallback: true, message: (text) => text,
    startCli: async () => { cliCalls++; return { ok: true }; } });
  const queue = queueFor(db, store, dispatch);
  try {
    queue.enqueue(entry('one')); queue.enqueue(entry('two')); await reconcile(queue);
    if (when === 'after-ack' || when === 'missing-id') emit();
    event(store, 'completed', 'owned');
    assert.equal(store.getSessionExecution(sessionKey)?.status, 'unknown');
    assert.equal(cliCalls, 0);
    await reconcile(queue);
    assert.ok(db.turns.list('openclaw', sessionKey).some((turn) => turn.id === 'two'));
  } finally { await queue.close(); db.close(); }
});

test('CLI completion before launch ACK stays terminal; a previous command callback cannot append into the next run', async () => {
  const { db, store } = setup();
  type Complete = NonNullable<Parameters<NonNullable<Parameters<typeof createOpenClawDispatch>[0]['startCli']>>[5]>;
  const callbacks: Complete[] = [];
  const dispatch = createOpenClawDispatch({ store, executions: db.openClawExecutions, authorizeTurn: () => true,
    gateway: { requestBound: async () => { throw new GatewayRpcError('agent', 'INVALID_REQUEST', 'missing scope: operator.write'); } } as any,
    allowCliFallback: true, message: (text) => text, startCli: async (_key, _agent, _display, _message, _id, complete) => {
      assert.ok(complete); callbacks.push(complete);
      if (callbacks.length === 1) complete({ ok: true, text: 'first final', messages: [] });
      return { ok: true };
    } });
  const queue = queueFor(db, store, dispatch);
  try {
    queue.enqueue(entry('one')); queue.enqueue(entry('two'));
    await reconcile(queue);
    assert.equal(db.openClawExecutions.get(sessionKey)?.runId, undefined);
    assert.equal(store.getSessionExecution(sessionKey)?.status, 'idle');
    assert.equal(store.getMessages(sessionKey).filter((message) => message.role === 'assistant').length, 1);
    const completedMessages = store.getMessages(sessionKey);
    callbacks[0]!({ ok: true, text: 'duplicate must not replace final', messages: [] });
    assert.deepEqual(store.getMessages(sessionKey), completedMessages);
    await reconcile(queue);
    assert.equal(store.getSessionExecution(sessionKey)?.status, 'running');
    const messages = store.getMessages(sessionKey);
    callbacks[0]!({ ok: false, error: 'stale failure from previous command' });
    assert.deepEqual(store.getMessages(sessionKey), messages);
    assert.equal(store.getSessionExecution(sessionKey)?.status, 'running');
    callbacks[1]!({ ok: true, text: 'second final', messages: [] });
    assert.equal(store.getSessionExecution(sessionKey)?.status, 'idle');
    assert.deepEqual(store.getMessages(sessionKey).filter((message) => message.role === 'assistant').map((message) => message.text), ['first final', 'second final']);
  } finally { await queue.close(); db.close(); }
});

for (const ok of [true, false]) test(`restarted CLI callback (${ok ? 'success' : 'failure'}) cannot publish a reply or release the successor`, async () => {
  const { db, store } = setup();
  type Complete = NonNullable<Parameters<NonNullable<Parameters<typeof createOpenClawDispatch>[0]['startCli']>>[5]>;
  let callback: Complete | undefined;
  let launches = 0;
  const dispatch = createOpenClawDispatch({ store, executions: db.openClawExecutions, authorizeTurn: () => true,
    gateway: { requestBound: async () => { throw new GatewayRpcError('agent', 'INVALID_REQUEST', 'missing scope: operator.write'); } } as any,
    allowCliFallback: true, message: (text) => text, startCli: async (_key, _agent, _display, _message, _id, complete) => {
      launches++; callback = complete; return { ok: true };
    } });
  let queue = queueFor(db, store, dispatch);
  try {
    queue.enqueue(entry('one')); queue.enqueue(entry('two')); await reconcile(queue);
    assert.ok(callback);
    await queue.close();
    queue = queueFor(db, store, dispatch); // owner recovery with the old callback retained as an adversarial input
    store.projectOpenClawExecution(sessionKey);
    const before = db.openClawExecutions.get(sessionKey);
    const messages = store.getMessages(sessionKey);
    callback(ok ? { ok: true, text: 'old final', messages: [] } : { ok: false, error: 'old failure' });
    assert.deepEqual(db.openClawExecutions.get(sessionKey), before);
    assert.deepEqual(store.getMessages(sessionKey), messages);
    assert.equal(store.getSessionExecution(sessionKey)?.status, 'unknown');
    await reconcile(queue);
    assert.equal(launches, 1);
    assert.equal(db.turns.head('openclaw', sessionKey)?.id, 'two');
    assert.equal(db.turns.head('openclaw', sessionKey)?.state, 'queued');
  } finally { await queue.close(); db.close(); }
});

test('accepted execution survives queue deletion and restart; fresh idle summary cannot dispatch the next admission', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-wiring-reopen-'));
  const file = join(dir, 'connector.sqlite');
  let { db, store } = setup(file); let sent = 0;
  let queue = queueFor(db, store, async () => { sent++; return { runId: 'before-restart' }; });
  try {
    await queue.enqueueAsync(entry('one')); await queue.enqueueAsync(entry('two'));
    await reconcile(queue);
    assert.equal(db.turns.head('openclaw', sessionKey)?.id, 'two');
    await queue.close(); db.close();
    ({ db, store } = setup(file));
    queue = queueFor(db, store, async () => { sent++; return { runId: 'after-restart' }; });
    assert.equal(store.getSessionExecution(sessionKey)?.status, 'unknown');
    await reconcile(queue); assert.equal(sent, 1);
    event(store, 'completed', 'before-restart');
    await reconcile(queue); assert.equal(sent, 1);
    assert.equal(db.openClawExecutions.get(sessionKey)?.commandId, 'one');
    assert.equal(db.openClawExecutions.get(sessionKey)?.reason, 'restarted');
    assert.equal(db.turns.head('openclaw', sessionKey)?.id, 'two');
    assert.equal(db.turns.head('openclaw', sessionKey)?.state, 'queued');
  } finally { await queue.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('unowned active events and legacy busy controls cannot reuse a completed execution to dispatch', async () => {
  for (const source of ['foreign-run', 'missing-id', 'legacy-control'] as const) {
    const { db, store } = setup(); let sent = 0;
    const queue = queueFor(db, store, async () => { sent++; return { runId: 'owned' }; });
    try {
      queue.enqueue(entry('one')); queue.enqueue(entry('two'));
      await reconcile(queue); event(store, 'completed', 'owned');
      if (source === 'legacy-control') store.markSessionBusy(sessionKey);
      else event(store, 'running', source === 'foreign-run' ? 'external' : undefined);
      assert.equal(store.getSessionExecution(sessionKey)?.status, 'unknown');
      await reconcile(queue); assert.equal(sent, 1);
    } finally { await queue.close(); db.close(); }
  }
});

test('lifecycle persistence failure makes snapshots unavailable instead of serving an older idle projection', async () => {
  const { db, store } = setup(); let sent = 0;
  const queue = queueFor(db, store, async () => { sent++; return { runId: 'owned' }; });
  try {
    queue.enqueue(entry('one')); queue.enqueue(entry('two'));
    await reconcile(queue); event(store, 'completed', 'owned');
    db.openClawExecutions.observe = () => { throw new Error('synthetic SQLite write failure'); };
    assert.doesNotThrow(() => event(store, 'running', 'external'));
    assert.throws(() => store.getSessionExecution(sessionKey), /unavailable/);
    assert.throws(() => store.getSession(sessionKey), /unavailable/);
    await assert.rejects(reconcile(queue), /unavailable/);
    assert.equal(sent, 1);
  } finally { await queue.close(); db.close(); }
});

test('a correlated Gateway completion wakes the actual queue worker before its five-second retry', async () => {
  const { db, store } = setup(); const sent: string[] = [];
  const queue = queueFor(db, store, async (turn) => { sent.push(turn.id); return { runId: `remote-${turn.id}` }; });
  const waitFor = async (condition: () => boolean) => {
    const until = Date.now() + 1000;
    while (!condition() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(condition(), 'expected worker progress inside the synthetic one-second window');
  };
  try {
    queue.enqueue(entry('one')); queue.enqueue(entry('two')); queue.start();
    await waitFor(() => sent.length === 1);
    if (event(store, 'completed', 'remote-one')) queue.wake(); // same wiring as Connector runtime
    await waitFor(() => sent.length === 2);
    assert.deepEqual(sent, ['one', 'two']);
  } finally { await queue.close(); db.close(); }
});

test('active foreign evidence before ACK cannot be discarded when selecting the accepted run', async () => {
  const { db, store } = setup(); let sent = 0;
  const queue = queueFor(db, store, async () => {
    sent++;
    event(store, 'running', 'external');
    event(store, 'completed', 'owned');
    return { runId: 'owned' };
  });
  try {
    queue.enqueue(entry('one')); queue.enqueue(entry('two'));
    await reconcile(queue);
    assert.equal(db.openClawExecutions.get(sessionKey)?.reason, 'unowned_run');
    assert.equal(db.turns.head('openclaw', sessionKey)?.id, 'two');
    await reconcile(queue);
    assert.equal(sent, 1);
  } finally { await queue.close(); db.close(); }
});

for (const phase of ['start', 'error'] as const)
test(`CLI completion cannot clear an uncorrelated Gateway ${phase} or append a final reply`, async () => {
  const { db, store } = setup();
  let complete!: NonNullable<Parameters<NonNullable<Parameters<typeof createOpenClawDispatch>[0]['startCli']>>[5]>;
  let launches = 0;
  const dispatch = createOpenClawDispatch({ store, executions: db.openClawExecutions, allowCliFallback: true,
    gateway: { requestBound: async () => { throw new GatewayRpcError('agent', 'INVALID_REQUEST', 'missing scope: operator.write'); } } as any,
    message: (text) => text, authorizeTurn: () => true,
    startCli: async (_key, _agent, _session, _message, _id, callback) => { launches++; complete = callback!; return { ok: true }; } });
  const queue = queueFor(db, store, dispatch);
  try {
    queue.enqueue(entry('one')); queue.enqueue(entry('two'));
    await reconcile(queue);
    store.ingestGatewayEvent({ event: 'agent', payload: { sessionKey, runId: 'uncorrelated', stream: 'lifecycle', data: { phase } } });
    complete({ ok: true, text: 'cannot prove session complete', messages: [] });
    assert.equal(store.getSessionExecution(sessionKey)?.status, 'unknown');
    assert.equal(store.getMessages(sessionKey).filter((message) => message.role === 'assistant').length, 0);
    await reconcile(queue);
    assert.equal(launches, 1);
  } finally { await queue.close(); db.close(); }
});

test('projection failure after atomic ACK cannot restore or mark the accepted queue entry uncertain', async () => {
  const { db, store } = setup(); let sent = 0;
  const queue = queueFor(db, store, async () => {
    sent++;
    store.projectOpenClawExecution = () => { throw new Error('synthetic projection failure after send'); };
    return { runId: 'owned' };
  });
  try {
    queue.enqueue(entry('one')); queue.enqueue(entry('two'));
    await reconcile(queue);
    assert.equal(db.openClawExecutions.get(sessionKey)?.runId, 'owned');
    assert.equal(db.openClawExecutions.get(sessionKey)?.phase, 'starting');
    assert.deepEqual(db.turns.list('openclaw', sessionKey).map((turn) => turn.id), ['two']);
    await assert.rejects(reconcile(queue), /unavailable/);
    assert.equal(sent, 1);
  } finally { await queue.close(); db.close(); }
});

test('revocation after a definitive Gateway rejection blocks the command without starting CLI', async () => {
  const { db, store } = setup(); let authorized = true; let calls = 0;
  const dispatch = createOpenClawDispatch({ store, executions: db.openClawExecutions, allowCliFallback: true,
    gateway: { requestBound: async () => { calls++; authorized = false; throw new GatewayRpcError('agent', 'INVALID_REQUEST', 'missing scope: operator.write'); } } as any,
    message: (text) => text, authorizeTurn: () => authorized,
    startCli: async () => { assert.fail('revoked actor must not launch CLI'); } });
  const queue = queueFor(db, store, dispatch);
  try {
    queue.enqueue(entry('one')); queue.enqueue(entry('two'));
    await reconcile(queue);
    assert.equal(db.openClawExecutions.get(sessionKey)?.phase, 'failed');
    assert.equal(db.openClawExecutions.get(sessionKey)?.runId, undefined);
    assert.equal(db.turns.head('openclaw', sessionKey)?.state, 'blocked');
    await reconcile(queue);
    assert.equal(calls, 1);
  } finally { await queue.close(); db.close(); }
});

test('conflicting identity and generic tool/chat payloads cannot complete a managed execution', async () => {
  const { db, store } = setup();
  const queue = queueFor(db, store, async () => ({ runId: 'owned' }));
  try {
    queue.enqueue(entry('one')); await reconcile(queue);
    for (const envelope of [
      { event: 'run.completed', payload: { sessionKey, runId: 'owned', run: { id: 'other', status: 'completed' } } },
      { event: 'run.completed', payload: { sessionKey, id: 'owned' } },
      { event: 'tool', payload: { sessionKey, runId: 'owned', status: 'error' } },
      { event: 'chat', payload: { sessionKey, runId: 'owned', state: 'final' } },
      { event: 'agent', payload: { sessionKey, runId: 'owned', stream: 'tool', data: { phase: 'end' } } },
    ]) {
      store.ingestGatewayEvent(envelope);
      assert.equal(db.openClawExecutions.get(sessionKey)?.phase, 'starting');
    }
    event(store, 'completed', 'owned');
    assert.equal(store.getSessionExecution(sessionKey)?.status, 'idle');
  } finally { await queue.close(); db.close(); }
});

test('legacy busy persistence failure cannot leave the previous completed execution admissible', async () => {
  const { db, store } = setup(); let sent = 0;
  const queue = queueFor(db, store, async () => { sent++; return { runId: 'owned' }; });
  try {
    queue.enqueue(entry('one')); queue.enqueue(entry('two'));
    await reconcile(queue); event(store, 'completed', 'owned');
    db.openClawExecutions.unownedActivity = () => { throw new Error('synthetic control persistence failure'); };
    assert.throws(() => store.markSessionBusy(sessionKey), /persistence failure/);
    assert.throws(() => store.getSessionExecution(sessionKey), /unavailable/);
    await assert.rejects(reconcile(queue), /unavailable/);
    assert.equal(sent, 1);
  } finally { await queue.close(); db.close(); }
});
