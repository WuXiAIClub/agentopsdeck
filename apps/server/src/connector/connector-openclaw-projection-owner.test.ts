import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AsyncOpenClawProjection } from './async-openclaw-projection.js';
import { AsyncOpenClawTurnQueue } from './async-openclaw-turn-queue.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { createConnectorOwnerCommands } from './connector-owner-domain.js';
import { DeckStore, type DeckStoreOptions } from '../projection/deck-store.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { GatewayWsClient } from '../gateway/ws-client.js';

const key = 'agent:main:dashboard:projection', token = 'isolated-projection-fixture';
const silent = new PerformanceDiagnostics(() => {});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
type Command = AsyncConnectorOwner['command'];
const event = (phase: string, runId = 'run', sessionKey = key) => ({ event: `run.${phase}`, payload: { sessionKey, runId } });
function fixture(options: { wrap?: (command: Command) => Command; deck?: DeckStoreOptions; maxFacts?: number;
  observe?: (raw: unknown, connectionId: string | undefined) => Promise<boolean>; diagnostics?: PerformanceDiagnostics } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'openclaw-projection-'));
  const store = new ConnectorUserStore(':memory:', undefined, { runtimeOwner: true });
  const tokens = new ConnectorTokenStore(join(root, 'tokens.json'), token, silent);
  const command = createConnectorOwnerCommands(store, tokens);
  const owner = { command: options.wrap?.(command) ?? command };
  let connection: string | undefined = 'connection';
  const deck = new DeckStore(options.deck);
  let queue: AsyncOpenClawTurnQueue;
  const projection = new AsyncOpenClawProjection({ owner, deck, connectionId: () => connection,
    observe: (raw, bound) => options.observe ? options.observe(raw, bound) : queue.observe(raw, bound),
    diagnostics: options.diagnostics ?? silent, ...(options.maxFacts ? { maxFacts: options.maxFacts } : {}),
  });
  queue = new AsyncOpenClawTurnQueue({ owner,
    dispatch: { gateway: { connectionId: () => connection, prepareWriteConnection: async () => connection!,
      requestBound: async <T>() => { throw Error('unexpected native dispatch'); } },
    native: { available: () => false, epoch: () => 'epoch' }, allowCliFallback: false, message: text => text, diagnostics: silent },
    recovery: { connectionId: () => connection, query: async () => ({ status: 'timeout' }) },
    refreshSessions: async () => {}, refreshMessages: async () => {}, nativeSession: () => ({ status: 'running' }),
    project: (k, fact) => projection.project(k, fact), invalidate: () => deck.invalidateOpenClawExecutionFacts(),
  });
  return { root, store, owner, command, deck, projection, queue,
    connection(value: string | undefined) { connection = value; },
    begin(sessionKey = key, commandId = 'command', runId = 'run') {
      assert.equal(store.openClawExecutions.begin(sessionKey, commandId), true);
      assert.equal(store.openClawExecutions.bindGatewayConnection(sessionKey, commandId, connection!), true);
      assert.equal(store.openClawExecutions.acknowledge(sessionKey, commandId, runId), true);
    },
    show(sessionKey = key) { deck.upsertSession({ sessionKey, agentId: 'main', title: 'Original title', status: 'idle' }); },
    async close() { await queue.close(); await projection.close(); command.dispose(); store.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

test('worker projection is exclusive, unavailable before bootstrap, and never reads SQL on synchronous Deck reads', async () => {
  let commandsAllowed = true;
  const f = fixture({ wrap: command => ((kind, input) => {
    assert.equal(commandsAllowed, true, 'Deck getter attempted worker/SQL access'); return command(kind, input);
  }) as Command });
  try {
    f.begin(); assert.throws(() => f.show());
    assert.throws(() => f.deck.bindOpenClawExecutions(f.store.openClawExecutions));
    await f.projection.open(); f.show(); commandsAllowed = false;
    assert.equal(f.deck.getSession(key)?.runtime?.phase, 'starting');
    assert.equal(f.deck.getSession(key)?.status, 'running');
    assert.equal(f.deck.getSessionsState().groups[0]?.sessions[0]?.runtime?.phase, 'starting');
    assert.equal(f.deck.getSessionDirectory().sessions[0]?.sessionKey, key);
    assert.throws(() => f.deck.ingestGatewayEvent(event('completed'), 'connection'));
  } finally { commandsAllowed = true; await f.close(); }
});

test('legacy owner cannot later acquire an async projection', async () => {
  const f = fixture();
  try {
    const deck = new DeckStore(); deck.bindOpenClawExecutions(f.store.openClawExecutions);
    assert.throws(() => new AsyncOpenClawProjection({ owner: f.owner, deck, connectionId: () => 'connection', observe: async () => false }));
  } finally { await f.close(); }
});

test('discovery omissions retain managed rows and busy hints cannot change worker facts', async () => {
  const f = fixture();
  try {
    f.begin(); await f.projection.open(); f.show();
    f.deck.replaceSessions([]);
    assert.equal(f.deck.getSession(key)?.runtime?.phase, 'starting');
    await f.projection.observe(event('completed'), 'connection');
    const original = f.store.openClawExecutions.get(key);
    f.deck.markSessionBusy(key);
    assert.equal(f.deck.getSession(key)?.status, 'idle');
    assert.deepEqual(f.store.openClawExecutions.get(key), original);
    f.deck.replaceSessions([]);
    assert.equal(f.deck.getSession(key)?.runtime?.phase, 'completed');
  } finally { await f.close(); }
});

test('accepted original event transaction precedes final projection; native idle cannot override managed running', async () => {
  const f = fixture();
  try {
    f.begin(); await f.projection.open(); f.show();
    assert.equal(await f.projection.observe(event('running'), 'connection'), true);
    assert.equal(f.deck.getSession(key)?.runtime?.phase, 'running');
    f.deck.replaceSessions([{ key, status: 'idle', label: 'Original title' }]);
    assert.equal(f.deck.getSession(key)?.status, 'running');
    assert.equal(await f.projection.observe(event('completed'), 'connection'), true);
    assert.equal(f.store.openClawExecutions.get(key)?.phase, 'completed');
    assert.equal(f.deck.getSession(key)?.status, 'idle');
    assert.equal(f.deck.getSession(key)?.runtime?.sync, 'syncing');
  } finally { await f.close(); }
});

test('old history error remains independent of successor execution and late caller snapshot', async () => {
  const f = fixture();
  try {
    f.begin(); await f.projection.open(); f.show();
    await f.projection.observe(event('completed'), 'connection');
    const old = f.store.openClawExecutions.get(key)!;
    f.store.openClawExecutions.setHistorySync(key, old.historySync!.revision, 'error');
    f.begin(key, 'successor', 'next-run');
    await f.projection.project(key, old);
    assert.equal(f.deck.getSession(key)?.runtime?.turnId, 'successor');
    assert.equal(f.deck.getSession(key)?.runtime?.phase, 'starting');
    assert.equal(f.deck.getSession(key)?.runtime?.sync, 'error');
    assert.equal(f.deck.getSession(key)?.status, 'running');
  } finally { await f.close(); }
});

test('connection changes reproject observations without worker/SQL or history calls', async () => {
  let reads = 0;
  const f = fixture({ wrap: command => ((kind, input) => { reads++; return command(kind, input); }) as Command });
  try {
    f.begin(); await f.projection.open(); f.show(); const before = reads;
    f.connection(undefined); await f.projection.connectionChanged();
    assert.equal(f.deck.getSession(key)?.runtime?.phase, 'unknown');
    assert.equal(f.deck.getSession(key)?.runtime?.reason, 'connection_lost');
    f.connection('replacement'); await f.projection.connectionChanged();
    assert.equal(f.deck.getSession(key)?.runtime?.reason, 'connection_replaced'); assert.equal(reads, before);
    assert.equal(f.store.openClawExecutions.get(key)?.phase, 'starting');
  } finally { await f.close(); }
});

test('failed managed observation shows original failure once; rejected old connection cannot inject failure text', async () => {
  const f = fixture();
  try {
    f.begin(); await f.projection.open(); f.show();
    await f.projection.observe({ ...event('failed'), payload: { ...event('failed').payload, error: 'accepted original failure' } }, 'connection');
    assert.equal(f.deck.getSession(key)?.status, 'failed');
    assert.equal(f.deck.getMessages(key).length, 1);
    await f.projection.observe({ ...event('failed'), payload: { ...event('failed').payload, error: 'forged late failure' } }, 'wrong-connection');
    assert.equal(f.deck.getMessages(key).length, 1);
    assert.equal(JSON.stringify(f.deck.getMessages(key)).includes('forged late failure'), false);
  } finally { await f.close(); }
});

test('deleted display still settles original execution, without resurrecting rows or failure messages', async () => {
  let deleted = false;
  const f = fixture({ deck: { sessionDeleted: () => deleted } });
  try {
    f.begin(); await f.projection.open(); f.show(); deleted = true;
    await f.projection.observe(event('completed'), 'connection');
    assert.equal(f.store.openClawExecutions.get(key)?.phase, 'completed');
    assert.equal(f.deck.getSession(key), undefined); assert.deepEqual(f.deck.getMessages(key), []);
    assert.equal(f.deck.getSessionsState().groups.length, 0);
  } finally { await f.close(); }
});

test('Gateway envelope copied before await; close retains original persistence and presentation', async () => {
  const entered = deferred<void>(), gate = deferred<void>();
  const f = fixture({ observe: async () => { entered.resolve(); await gate.promise; return false; } });
  try {
    await f.projection.open(); f.show();
    const raw = { event: 'tool.started', payload: { sessionKey: key, toolCallId: 'original', name: 'read' } };
    const work = f.projection.observe(raw, 'connection'); await entered.promise;
    raw.payload.toolCallId = 'mutated';
    let closed = false; const closing = f.projection.close().then(() => { closed = true; });
    await tick(); assert.equal(closed, false);
    await assert.rejects(f.projection.observe(raw, 'connection'));
    gate.resolve(); await work; await closing;
    assert.equal(f.deck.getActivity(key)[0]?.toolCallId, 'original'); assert.equal(closed, true);
  } finally { gate.resolve(); await f.close(); }
});

for (const failure of ['read', 'project', 'copy', 'head', 'page'] as const)
  test(`projection ${failure} failure latches unavailable with no retry/fallback`, async () => {
    let broken = false, calls = 0;
    const f = fixture({ wrap: command => (async (kind, input) => {
      calls++;
      if (broken && ((failure === 'read' && kind === 'openClawExecutionRead') || (failure === 'head' && kind === 'eventProjectionHead'))) throw Error('isolated failure');
      if (broken && failure === 'page' && kind === 'executionSessionPage') return [key, key];
      return command(kind, input);
    }) as Command });
    try {
      f.begin();
      if (failure === 'head' || failure === 'page') { broken = true; await assert.rejects(f.projection.open()); }
      else {
        await f.projection.open(); f.show(); broken = true;
        if (failure === 'project') f.deck.projectOpenClawExecution = () => { throw Error('isolated presentation failure'); };
        if (failure === 'copy') {
          const raw = Object.defineProperty({}, 'payload', { enumerable: true, get() { throw Error('must not run accessor'); } });
          await assert.rejects(f.projection.observe(raw, 'connection'));
        } else await assert.rejects(f.projection.project(key));
        assert.throws(() => f.deck.getSession(key));
      }
      assert.equal(f.projection.status().unavailable, true);
      const before = calls; await assert.rejects(f.projection.project(key)); assert.equal(calls, before);
    } finally { await f.close(); }
  });

test('startup snapshot retries concurrent journal mutation before publishing a complete map', async () => {
  let heads = 0;
  const f = fixture({ wrap: command => (async (kind, input) => {
    const value = await command(kind, input);
    if (kind === 'eventProjectionHead' && ++heads === 2) return { ...(value as object), version: 'cv1_00000000-0000-4000-8000-000000000000:2' };
    return value;
  }) as Command });
  try {
    f.begin(); await f.projection.open();
    assert.equal(heads, 4); assert.equal(f.projection.status().ready, true);
    assert.equal(f.projection.status().unavailable, false); assert.equal(f.projection.status().facts, 1);
    f.show(); assert.equal(f.deck.getSession(key)?.status, 'running');
  }
  finally { await f.close(); }
});

test('startup snapshot churn is bounded and never publishes partial execution facts', async () => {
  let heads = 0;
  const f = fixture({ wrap: command => (async (kind, input) => {
    const value = await command(kind, input);
    return kind === 'eventProjectionHead' ? { ...(value as object), version: `cv1_00000000-0000-4000-8000-000000000000:${++heads}` } : value;
  }) as Command });
  try {
    f.begin(); await assert.rejects(f.projection.open());
    assert.equal(heads, 8); assert.equal(f.projection.status().ready, false);
    assert.equal(f.projection.status().facts, 0); assert.throws(() => f.show());
  } finally { await f.close(); }
});

test('startup page uses original SQLite UTF8 ordering and installs a bounded complete snapshot', async () => {
  const f = fixture();
  try {
    const keys = Array.from({ length: 67 }, (_, i) => `agent:main:dashboard:${String(i).padStart(3, '0')}`)
      .concat(['agent:main:dashboard:\ue000', 'agent:main:dashboard:😀']);
    keys.forEach(k => f.begin(k)); await f.projection.open(); keys.forEach(k => f.show(k));
    assert.equal(f.projection.status().facts, keys.length);
    f.connection(undefined); await f.projection.connectionChanged();
    assert.equal(f.deck.getSessionsState().groups[0]?.sessions.filter(s => s.status === 'unknown').length, keys.length);
  } finally { await f.close(); }
});

test('fact capacity fails closed instead of evicting protected execution observations', async () => {
  const f = fixture({ maxFacts: 1 });
  try {
    f.begin(); await f.projection.open(); f.show(); f.begin('agent:main:second');
    await assert.rejects(f.projection.project('agent:main:second'));
    assert.equal(f.projection.status().facts, 1); assert.throws(() => f.deck.getSession(key));
  } finally { await f.close(); }
});

test('128 retained public events bound input; overflow cannot unlock existing observations', async () => {
  const gate = deferred<void>();
  const f = fixture({ observe: async () => { await gate.promise; return false; } });
  try {
    await f.projection.open(); f.show();
    const work = Array.from({ length: 128 }, () => f.projection.observe(event('running'), 'connection'));
    await assert.rejects(f.projection.observe(event('running'), 'connection'));
    assert.equal(f.projection.status().unavailable, true); gate.resolve();
    await Promise.allSettled(work); await f.projection.close(); assert.equal(f.projection.status().eventBytes, 0);
  } finally { gate.resolve(); await f.close(); }
});

test('bounded sanitized diagnostics cannot change execution facts or strand close', async () => {
  const diagnostics = { start() { throw Error('broken log sink'); } } as unknown as PerformanceDiagnostics;
  const f = fixture({ diagnostics });
  try {
    f.begin(); await f.projection.open(); f.show();
    await assert.rejects(f.projection.observe(Object.defineProperty({}, 'payload', { get() {} }), 'connection'));
    assert.equal(f.store.openClawExecutions.get(key)?.phase, 'starting');
    await f.projection.close(); assert.equal(f.projection.status().pending, 0);
  } finally { await f.close(); }
});

test('real sole worker dispatch → terminal → successor updates original Deck without legacy owner binding', async () => {
  const root = mkdtempSync(join(tmpdir(), 'openclaw-projection-worker-')), file = join(root, 'original.sqlite'), tokenFile = join(root, 'tokens.json');
  const tokens = new ConnectorTokenStore(tokenFile, token, silent), actorId = tokens.authenticateAuthorization(`Bearer ${token}`)!.tokenId;
  const seed = new ConnectorUserStore(file);
  for (const id of ['first', 'successor']) await seed.turns.enqueueAsync('openclaw', { id, sessionKey: key, createdAt: 1,
    payload: { actorId, message: 'isolated private input', deliveryMode: 'web-only', media: [] } });
  seed.close();
  const owner = new AsyncConnectorOwner({ file, tokenFile, bootstrapToken: token }, silent), deck = new DeckStore();
  let queue: AsyncOpenClawTurnQueue | undefined;
  const projection = new AsyncOpenClawProjection({ owner, deck, connectionId: () => 'connection',
    observe: (raw, bound) => queue!.observe(raw, bound), diagnostics: silent });
  try {
    await owner.open(); await projection.open(); deck.upsertSession({ sessionKey: key, agentId: 'main', title: 'Original', status: 'idle' });
    let sends = 0;
    queue = new AsyncOpenClawTurnQueue({ owner,
      dispatch: { gateway: { connectionId: () => 'connection', prepareWriteConnection: async () => 'connection',
        requestBound: async <T>(_m: Parameters<GatewayWsClient['requestBound']>[0], _p: Record<string, unknown>, _c?: string, before?: () => void) => {
          before?.(); sends++; return { connectionId: 'connection', payload: { runId: sends === 1 ? 'run' : 'next' } as T };
        } }, native: { available: () => true, epoch: () => 'epoch' }, allowCliFallback: false, message: text => text, diagnostics: silent },
      recovery: { connectionId: () => 'connection', query: async () => ({ status: 'timeout' }) },
      refreshSessions: async () => {}, refreshMessages: async () => {}, nativeSession: () => ({ status: 'idle' }),
      project: (k, fact) => projection.project(k, fact), invalidate: () => deck.invalidateOpenClawExecutionFacts(),
    });
    await queue.reconcile(key); assert.equal(deck.getSession(key)?.runtime?.turnId, 'first');
    await projection.observe(event('completed'), 'connection');
    assert.equal(deck.getSession(key)?.runtime?.sync, 'syncing');
    await queue.reconcile(key);
    assert.equal(sends, 2); assert.equal(deck.getSession(key)?.runtime?.turnId, 'successor');
    assert.equal(deck.getSession(key)?.runtime?.phase, 'starting');
    assert.equal(deck.getSession(key)?.runtime?.sync, 'current');
  } finally { await queue?.close(); await projection.close(); await owner.close(); rmSync(root, { recursive: true, force: true }); }
});
