import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConnectorUserStore } from './connector-user-store.js';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { createConnectorOwnerCommands } from './connector-owner-domain.js';
import { validConnectorExecutionInput, executeConnectorExecution } from './connector-execution-domain.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { AsyncOpenClawTurnQueue } from './async-openclaw-turn-queue.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { OpenClawQueuedPayload } from '../openclaw/turn-queue.js';
import type { GatewayWsClient } from '../gateway/ws-client.js';

const key = 'agent:main:queue-original', token = 'test-isolated-openclaw-queue';
const silent = new PerformanceDiagnostics(() => {});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
type Options = ConstructorParameters<typeof AsyncOpenClawTurnQueue>[0];
const normal = (runId = 'run') => ({ runId, status: 'ok', startedAt: 1, endedAt: 2 });
const end = (sessionKey = key, runId = 'run') => ({ event: 'agent', payload: {
  sessionKey, runId, stream: 'lifecycle', data: { phase: 'end', stopReason: 'end_turn' },
} });
const reply = (text = 'original private reply') => ({ event: 'chat', payload: {
  sessionKey: key, runId: 'run', state: 'final', seq: 1, message: { role: 'assistant', content: text },
} });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'openclaw-consumer-'));
  const tokens = new ConnectorTokenStore(join(directory, 'tokens.json'), token, silent);
  const actorId = tokens.authenticateAuthorization(`Bearer ${token}`)!.tokenId;
  const store = new ConnectorUserStore(':memory:', undefined, { runtimeOwner: true });
  const command = createConnectorOwnerCommands(store, tokens);
  const calls: string[] = [], projected: unknown[] = [];
  let connection = 'connection', sends = 0, queries = 0, invalidated = 0;
  const gateway: Options['dispatch']['gateway'] = {
    connectionId: () => connection, prepareWriteConnection: async () => connection,
    requestBound: async <T>(_m: Parameters<GatewayWsClient['requestBound']>[0], _p: Record<string, unknown>, _c?: string, before?: () => void) => {
      before?.(); sends++; calls.push('send'); return { connectionId: connection, payload: { runId: 'run' } as T };
    },
  };
  const queues: AsyncOpenClawTurnQueue[] = [];
  return { directory, store, command, calls, projected, tokens, actorId,
    get sends() { return sends; }, get queries() { return queries; }, get invalidated() { return invalidated; },
    replace() { connection = 'replacement'; },
    async enqueue(id = 'queued', sessionKey = key) {
      await store.turns.enqueueAsync<OpenClawQueuedPayload>('openclaw', { sessionKey, id, createdAt: 1,
        payload: { actorId, message: 'original private input', deliveryMode: 'web-only', media: [] } });
    },
    begin(sessionKey = key, commandId = 'accepted', runId = 'run') {
      assert.equal(store.openClawExecutions.begin(sessionKey, commandId), true);
      assert.equal(store.openClawExecutions.bindGatewayConnection(sessionKey, commandId, connection), true);
      assert.equal(store.openClawExecutions.acknowledge(sessionKey, commandId, runId), true);
    },
    queue(overrides: Partial<Options> = {}) {
      const q = new AsyncOpenClawTurnQueue({ owner: { command },
        dispatch: { gateway, native: { available: () => true, epoch: () => 'epoch' }, allowCliFallback: false, message: t => t, diagnostics: silent },
        recovery: { connectionId: () => connection, query: async () => { queries++; calls.push('query'); return { status: 'timeout' }; } },
        refreshSessions: async () => { calls.push('sessions'); },
        refreshMessages: async (_k, options) => { calls.push(options?.fresh ? 'history' : 'messages'); },
        nativeSession: () => ({ status: 'idle', hasActiveRun: false }),
        project: (k, fact) => { projected.push({ k, fact }); }, invalidate: () => { invalidated++; },
        ...overrides,
      });
      queues.push(q); return q;
    },
    async close() { await Promise.all(queues.map(q => q.close())); command.dispose(); store.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

test('fixed recovery candidate uses hidden original fence and exact transport, never public snapshot inference', async () => {
  const f = fixture();
  try {
    f.begin();
    assert.equal(validConnectorExecutionInput('openClawRecoveryCandidate', { sessionKey: key, connectionId: 'c'.repeat(512) }), true);
    for (const patch of [{ authorized: true }, { connectionId: '' }, { connectionId: 'c'.repeat(513) }, { sessionKey: '' }])
      assert.equal(validConnectorExecutionInput('openClawRecoveryCandidate', { sessionKey: key, connectionId: 'connection', ...patch }), false);
    assert.equal(executeConnectorExecution('openClawRecoveryCandidate', { sessionKey: key, connectionId: null }, f.store), null);
    assert.equal(executeConnectorExecution('openClawRecoveryCandidate', { sessionKey: key, connectionId: 'other' }, f.store), null);
    assert.equal(executeConnectorExecution('openClawRecoveryCandidate', { sessionKey: key, connectionId: 'connection' }, f.store)?.runId, 'run');
    f.store.openClawExecutions.unownedActivity(key);
    assert.equal(f.store.openClawExecutions.get(key)?.phase, 'unknown');
    assert.equal(executeConnectorExecution('openClawRecoveryCandidate', { sessionKey: key, connectionId: 'connection' }, f.store), null);
  } finally { await f.close(); }
});

test('original mirror → read-only recovery → history → native refresh → worker-authorized successor', async () => {
  const f = fixture();
  try {
    f.begin(); await f.enqueue();
    const q = f.queue({ reconcileMirror: async () => { f.calls.push('mirror'); },
      recovery: { connectionId: () => 'connection', query: async () => { f.calls.push('query'); return normal(); } },
      refreshMessages: async () => { f.calls.push('history'); throw Error('private history read failure'); },
    });
    await q.reconcile(key);
    assert.deepEqual(f.calls, ['mirror', 'query', 'history', 'sessions', 'send']);
    assert.equal(f.sends, 1); assert.equal(f.store.turns.list('openclaw', key).length, 0);
    assert.equal(f.store.openClawExecutions.get(key)?.commandId, 'queued');
    assert.equal(f.store.openClawExecutions.get(key)?.phase, 'starting');
  } finally { await f.close(); }
});

test('history error remains separate from committed completion; later read-only pass clears only its revision', async () => {
  const f = fixture();
  try {
    f.begin(); let fail = true;
    const q = f.queue({ refreshMessages: async () => { if (fail) throw Error('private'); } });
    assert.equal(await q.observe(end(), 'connection'), true);
    await q.reconcile(key);
    assert.equal(f.store.openClawExecutions.get(key)?.phase, 'completed');
    assert.equal(f.store.openClawExecutions.get(key)?.historySync?.state, 'error');
    fail = false; await q.reconcile(key);
    assert.equal(f.store.openClawExecutions.get(key)?.historySync?.state, 'current');
    assert.equal(f.sends, 0);
  } finally { await f.close(); }
});

for (const scenario of ['reconnect', 'revision', 'wrong-run', 'timeout', 'query-failure'] as const)
  test(`late agent.wait proof cannot complete/replay after ${scenario}`, async () => {
    const f = fixture();
    try {
      f.begin(); await f.enqueue(); const entered = deferred<void>(), read = deferred<unknown>();
      const q = f.queue({ recovery: { connectionId: () => scenario === 'reconnect' && changed ? 'replacement' : 'connection',
        query: async () => { entered.resolve(); return read.promise; } } });
      let changed = false;
      const pending = q.reconcile(key); await entered.promise;
      if (scenario === 'revision') await q.observe({ event: 'run', payload: { sessionKey: key, runId: 'run', state: 'waiting' } }, 'connection');
      changed = true;
      if (scenario === 'query-failure') read.resolve(Promise.reject(Error('private transport failure')));
      else read.resolve(scenario === 'wrong-run' ? normal('other') : scenario === 'timeout' ? { status: 'timeout' } : normal());
      await pending;
      assert.notEqual(f.store.openClawExecutions.get(key)?.phase, 'completed');
      assert.equal(f.sends, 0); assert.equal(f.store.turns.list('openclaw', key)[0]?.state, 'queued');
    } finally { await f.close(); }
  });

test('trusted connection only, no-runId activity fences original run and never unlocks successor', async () => {
  const f = fixture();
  try {
    f.begin(); await f.enqueue(); const q = f.queue();
    const forged = end(); Object.assign(forged.payload, { connectionId: 'connection' });
    assert.equal(await q.observe(forged, 'replacement'), false);
    assert.equal(f.store.openClawExecutions.get(key)?.phase, 'starting');
    assert.equal(await q.observe({ event: 'run.running', payload: { sessionKey: key } }, 'connection'), true);
    await q.reconcile(key); assert.equal(f.queries, 0); assert.equal(f.sends, 0);
    assert.equal(f.store.openClawExecutions.get(key)?.reason, 'unowned_run');
  } finally { await f.close(); }
});

test('event proof is copied before await and projects only after its worker transaction; chat alone cannot complete', async () => {
  const f = fixture();
  try {
    f.begin(); const q = f.queue(); const raw = end();
    const pending = q.observe(raw, 'connection'); raw.payload.runId = 'mutated';
    await pending; assert.equal(f.store.openClawExecutions.get(key)?.phase, 'completed');
    assert.equal((f.projected[0] as any).fact.phase, 'completed');
    assert.equal(await q.observe(reply('x'.repeat(40_000)), 'connection'), true);
    assert.equal(f.store.openClawExecutions.get(key)?.phase, 'completed');
  } finally { await f.close(); }
  const g = fixture();
  try {
    g.begin(); const q = g.queue(); await q.observe(reply(), 'connection');
    assert.equal(g.store.openClawExecutions.get(key)?.phase, 'starting');
  } finally { await g.close(); }
});

test('early final lifecycle and reply retain original mirror transaction across late ACK', async () => {
  const f = fixture();
  try {
    f.store.mirrorOutbox.upsert({ actorId: f.actorId, sessionKey: key, after: 1, inputText: 'private',
      idempotencyKey: 'accepted', explicitRoute: { originatingChannel: 'test', originatingTo: 'original', outboundTarget: 'original' } });
    f.store.openClawExecutions.begin(key, 'accepted'); f.store.openClawExecutions.bindGatewayConnection(key, 'accepted', 'connection');
    const q = f.queue(); await q.observe(end(), 'connection'); await q.observe(reply(), 'connection');
    f.store.openClawExecutions.acknowledge(key, 'accepted', 'run');
    assert.equal(f.store.openClawExecutions.get(key)?.phase, 'completed');
    assert.equal(f.store.mirrorOutbox.get('accepted')?.nativeReply?.text, 'original private reply');
  } finally { await f.close(); }
});

test('same-key reconcile coalesces physical refresh; pause waits original work, terminal observation remains accepted', async () => {
  const f = fixture();
  try {
    await f.enqueue(); const entered = deferred<void>(), refresh = deferred<void>();
    const q = f.queue({ refreshSessions: async () => { entered.resolve(); await refresh.promise; } });
    const a = q.reconcile(key), b = q.reconcile(key); assert.equal(a, b); await entered.promise;
    const lease = q.pause(); assert.equal(q.pause(), lease); assert.equal(lease.resume(), false);
    let drained = false; void lease.drained.then(() => { drained = true; }); await tick(); assert.equal(drained, false);
    refresh.resolve(); await a; await lease.drained; assert.equal(f.sends, 0);
    assert.equal(lease.resume(), true); assert.equal(lease.resume(), false);
    await q.reconcile(key); assert.equal(f.sends, 1);
    const next = q.pause(); assert.equal(await q.observe(end(), 'connection'), true); await next.drained;
    assert.equal(f.store.openClawExecutions.get(key)?.phase, 'completed');
  } finally { await f.close(); }
});

test('close retains late read-only query settlement but never starts history or successor', async () => {
  const f = fixture();
  try {
    f.begin(); await f.enqueue(); const entered = deferred<void>(), query = deferred<unknown>();
    const q = f.queue({ recovery: { connectionId: () => 'connection', query: async () => { entered.resolve(); return query.promise; } } });
    const work = q.reconcile(key); await entered.promise;
    const close = q.close(); assert.equal(q.close(), close); let done = false; void close.then(() => { done = true; });
    await tick(); assert.equal(done, false); assert.equal(await q.observe(end(), 'connection'), false);
    query.resolve(normal()); await work; await close;
    assert.equal(f.store.openClawExecutions.get(key)?.phase, 'completed');
    assert.equal(f.store.openClawExecutions.get(key)?.historySync?.state, 'pending');
    assert.equal(f.sends, 0); assert.equal(f.calls.includes('history'), false);
  } finally { await f.close(); }
});

test('close retains accepted event → DB → projection through late callback', async () => {
  const f = fixture();
  try {
    f.begin(); const entered = deferred<void>(), projection = deferred<void>();
    const q = f.queue({ project: async () => { entered.resolve(); await projection.promise; } });
    const event = q.observe(end(), 'connection'); await entered.promise;
    const close = q.close(); let done = false; void close.then(() => { done = true; });
    await tick(); assert.equal(done, false);
    projection.resolve(); await event; await close; assert.equal(done, true);
    assert.equal(f.store.openClawExecutions.get(key)?.phase, 'completed');
  } finally { await f.close(); }
});

test('lost observation or projection fails closed even when invalidate/diagnostic throws', async () => {
  const f = fixture();
  try {
    await f.enqueue(); const q = f.queue({ invalidate: () => { throw Error('private'); }, diagnostic: () => { throw Error('private'); } });
    let getters = 0;
    await assert.rejects(q.observe({ get payload() { getters++; throw Error('private'); } }, 'connection'));
    assert.equal(getters, 0); await q.reconcile(key); assert.equal(f.sends, 0);
  } finally { await f.close(); }
  const g = fixture();
  try {
    g.begin(); await g.enqueue(); const q = g.queue({ project: () => { throw Error('private'); } });
    await q.observe(end(), 'connection'); await q.reconcile(key);
    assert.equal(g.store.openClawExecutions.get(key)?.phase, 'completed'); assert.equal(g.sends, 0);
    assert.ok(g.invalidated > 0);
  } finally { await g.close(); }
});

test('event envelopes have bounded retained work, overflow never grants native readiness', async () => {
  const f = fixture();
  try {
    f.begin(); const entered = deferred<void>(), projection = deferred<void>();
    const q = f.queue({ project: async () => { entered.resolve(); await projection.promise; } });
    const events = Array.from({ length: 128 }, () => q.observe(reply(), 'connection'));
    await entered.promise; await assert.rejects(q.observe(reply(), 'connection'));
    projection.resolve(); await Promise.all(events); assert.equal(f.invalidated, 1); assert.equal(f.sends, 0);
  } finally { await f.close(); }
});

test('original TurnWorker recovers ACKed session without queue rows, via async recovery paging', async () => {
  const f = fixture();
  try {
    f.begin(); const synced = deferred<void>();
    const q = f.queue({ recovery: { connectionId: () => 'connection', query: async () => normal() },
      refreshMessages: async () => { synced.resolve(); } });
    const keepAlive = setInterval(() => {}, 1000);
    try { q.start(); await synced.promise; } finally { clearInterval(keepAlive); }
    await q.close();
    assert.equal(f.store.openClawExecutions.get(key)?.phase, 'completed');
    assert.equal(f.store.openClawExecutions.get(key)?.historySync?.state, 'current'); assert.equal(f.sends, 0);
  } finally { await f.close(); }
});

for (const status of ['running', 'waiting', 'unknown', 'idle-active'] as const)
  test(`fresh native ${status} evidence cannot be overridden by an idle display`, async () => {
    const f = fixture();
    try {
      await f.enqueue();
      const q = f.queue({ nativeSession: () => ({ status: status === 'idle-active' ? 'idle' : status,
        hasActiveRun: status === 'idle-active' }) });
      await q.reconcile(key);
      assert.equal(f.sends, 0); assert.equal(f.store.turns.list('openclaw', key)[0]?.state, 'queued');
    } finally { await f.close(); }
  });

test('late history settlement cannot mark a successor terminal revision current', async () => {
  const f = fixture();
  try {
    f.begin(); const entered = deferred<void>(), history = deferred<void>();
    const q = f.queue({ refreshMessages: async () => { entered.resolve(); await history.promise; } });
    await q.observe(end(), 'connection');
    const work = q.reconcile(key); await entered.promise;
    f.begin(key, 'successor', 'next-run');
    await q.observe(end(key, 'next-run'), 'connection');
    const revision = f.store.openClawExecutions.get(key)?.historySync?.revision;
    history.resolve(); await work;
    const fact = f.store.openClawExecutions.get(key);
    assert.equal(fact?.commandId, 'successor'); assert.equal(fact?.historySync?.revision, revision);
    assert.equal(fact?.historySync?.state, 'pending'); assert.equal(f.sends, 0);
  } finally { await f.close(); }
});

test('reply with conflicting active evidence preserves original rejection and cannot complete', async () => {
  const f = fixture();
  try {
    f.begin(); const q = f.queue(), event = reply();
    Object.assign(event.payload, { activeRun: { runId: 'run', status: 'running' } });
    assert.equal(await q.observe(event, 'connection'), false);
    assert.equal(f.store.openClawExecutions.get(key)?.phase, 'starting');
    assert.equal(f.invalidated, 0);
  } finally { await f.close(); }
});

test('retained native text byte limit fails closed without dropping already accepted evidence', async () => {
  const f = fixture();
  try {
    f.begin(); const entered = deferred<void>(), projection = deferred<void>();
    const q = f.queue({ project: async () => { entered.resolve(); await projection.promise; } });
    const events = Array.from({ length: 7 }, () => q.observe(reply('x'.repeat(1024 * 1024)), 'connection'));
    await entered.promise;
    await assert.rejects(q.observe(reply('x'.repeat(1024 * 1024)), 'connection'));
    projection.resolve(); await Promise.all(events);
    assert.equal(f.invalidated, 1); assert.equal(f.store.openClawExecutions.get(key)?.phase, 'starting');
    await f.enqueue(); await q.reconcile(key); assert.equal(f.sends, 0);
  } finally { await f.close(); }
});

test('single real worker owns queued send → observed terminal → history sync → successor and reopen', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openclaw-consumer-worker-')), file = join(root, 'original.sqlite'), tokenFile = join(root, 'tokens.json');
  const tokens = new ConnectorTokenStore(tokenFile, token, silent), actorId = tokens.authenticateAuthorization(`Bearer ${token}`)!.tokenId;
  const seed = new ConnectorUserStore(file);
  for (const id of ['first', 'second']) await seed.turns.enqueueAsync('openclaw', { id, sessionKey: key, createdAt: 1,
    payload: { actorId, message: 'original private input', deliveryMode: 'web-only', media: [] } });
  seed.close(); let owner = new AsyncConnectorOwner({ file, tokenFile, bootstrapToken: token }, silent);
  let q: AsyncOpenClawTurnQueue | undefined;
  try {
    await owner.open(); let sends = 0;
    q = new AsyncOpenClawTurnQueue({ owner,
      dispatch: { gateway: { connectionId: () => 'connection', prepareWriteConnection: async () => 'connection',
        requestBound: async <T>(_m: Parameters<GatewayWsClient['requestBound']>[0], _p: Record<string, unknown>, _c?: string, before?: () => void) => {
          before?.(); sends++; return { connectionId: 'connection', payload: { runId: sends === 1 ? 'run' : 'run2' } as T };
        } }, native: { available: () => true, epoch: () => 'epoch' }, allowCliFallback: false, message: t => t, diagnostics: silent },
      recovery: { connectionId: () => 'connection', query: async () => ({ status: 'timeout' }) },
      refreshSessions: async () => {}, refreshMessages: async () => {}, nativeSession: () => ({ status: 'idle' }),
      project: () => {}, invalidate: () => { assert.fail('unexpected invalidation'); },
    });
    await q.reconcile(key); assert.equal(sends, 1);
    await q.observe(end(), 'connection'); await q.reconcile(key); assert.equal(sends, 2);
    const beforeRestart = await owner.command('openClawExecutionRead', { sessionKey: key });
    assert.equal(beforeRestart?.commandId, 'second'); assert.equal(beforeRestart?.phase, 'starting');
    assert.equal(beforeRestart?.runId, 'run2');
    await q.close(); await owner.close();
    owner = new AsyncConnectorOwner({ file, tokenFile, bootstrapToken: token }, silent); await owner.open();
    const fact = await owner.command('openClawExecutionRead', { sessionKey: key });
    assert.equal(fact?.commandId, 'second'); assert.equal(fact?.phase, 'unknown');
    assert.equal(fact?.reason, 'restarted'); assert.equal(fact?.runId, 'run2');
    assert.equal(fact?.gatewayConnectionId, beforeRestart?.gatewayConnectionId);
    assert.equal(fact?.revision, beforeRestart!.revision! + 1);
    assert.equal(await owner.command('turnQueuePending', { runtime: 'openclaw', sessionKey: key }), false);
    assert.equal(await owner.command('openClawRecoveryCandidate', { sessionKey: key, connectionId: 'connection' }), null);
    assert.equal(await owner.command('openClawExecutionAcknowledge', { sessionKey: key, commandId: 'second',
      transport: 'gateway', runId: 'run2', connectionId: 'connection' }), false);
    assert.deepEqual(await owner.command('openClawExecutionRead', { sessionKey: key }), fact);
    assert.equal(sends, 2, 'restart must not replay either original message');
  } finally { await q?.close(); await owner.closeForShutdown(); rmSync(root, { recursive: true, force: true }); }
});
