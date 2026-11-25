import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { TurnQueue } from '../commands/turn-queue.js';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { DeckStore } from '../projection/deck-store.js';
import { CodexAppServer, threadModelFromRollout } from './app-server.js';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { RunControlConflict } from '../commands/run-control.js';
import { TurnAuthorizationError } from '../commands/turn-queue.js';
import { CodexExecutions } from './executions.js';
import { loadConfig } from '../config.js';
import { randomUUID } from 'node:crypto';
import { codexBoardToolSpecs } from './board-tools.js';
import { NativeTokenUsageStore } from '../connector/native-token-usage.js';
import { RuntimeDiagnostics } from './runtime-diagnostics.js';

const persistence = new WeakMap<DeckStore, { turnQueue: TurnQueue; executions: CodexExecutions }>();
function completeCompaction(instance: CodexAppServer, threadId: string, turnId: string) {
  for (const method of ['item/started', 'item/completed']) (instance as any).handleNotification(method, {
    threadId, turnId, item: { type: 'contextCompaction', id: 'compact-item' }, startedAtMs: 1, completedAtMs: 2,
  });
  (instance as any).handleNotification('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } });
}
function memoryPersistence(store: DeckStore) {
  let value = persistence.get(store);
  if (!value) {
    const db = new DatabaseSync(':memory:');
    value = { turnQueue: new TurnQueue(db), executions: new CodexExecutions(db) };
    persistence.set(store, value);
  }
  return value;
}

function fixture() {
  const store = new DeckStore();
  const codex = new CodexAppServer({ authorizeTurn: () => true, ...memoryPersistence(store), enabled: true, command: 'codex', defaultCwd: 'C:\\workspace', defaultModel: 'gpt-5.6-sol', approvalPolicy: 'never', store });
  const threadId = 'thread-1';
  const sessionKey = `codex:${threadId}`;
  store.upsertSession({ sessionKey, agentId: 'codex', title: 'Test', status: 'running' });
  const notify = (method: string, params: unknown) => (codex as any).handleNotification(method, params);
  return { store, codex, threadId, sessionKey, notify };
}

test('committed runtime publication logs effective activity, disconnect and recovery without changing authority', context => {
  const { codex, store, sessionKey } = fixture(); context.after(() => codex.close());
  const runtime = codex as any, lines: string[] = [];
  runtime.runtimeDiagnostics = new RuntimeDiagnostics(line => lines.push(line));
  runtime.connectionId = 'connection';
  const initial = { turnId: 'turn', phase: 'running', threadActivity: 'running', connection: 'connected', sync: 'current', lastEventAt: 1 };
  runtime.publishRun(sessionKey, initial);
  runtime.publishRun(sessionKey, { ...initial, lastEventAt: 2, reason: 'SECRET' });
  assert.equal(lines.length, 1, 'timestamp/text changes are not state transitions');
  runtime.publishThreadActivity(sessionKey, 'unknown');
  runtime.markDisconnected(new Error('SECRET'));
  runtime.publishRun(sessionKey, { ...initial, lastEventAt: 3 }, {}, 'native-snapshot');
  const rows = lines.map(line => JSON.parse(line));
  assert.deepEqual(rows.map(row => row.source), ['runtime', 'native-activity', 'disconnect', 'native-snapshot']);
  assert.equal(rows[2].after.activity, 'unknown', 'log the effective merged projection');
  assert.equal(rows[2].after.connection, 'disconnected');
  assert.equal(lines.join('').includes('SECRET'), false);
  runtime.runtimeDiagnostics = new RuntimeDiagnostics(() => { throw new Error('log failure'); });
  assert.doesNotThrow(() => runtime.publishThreadActivity(sessionKey, 'waiting'));
  assert.equal(store.getSession(sessionKey)?.runtime?.threadActivity, 'waiting');
  assert.equal(runtime.options.executions.get(sessionKey), undefined, 'logs never create execution ownership');
});

test('Codex enrolls tools only at explicit new thread creation, not resume or default configuration', async context => {
  const { codex, store } = fixture(); context.after(() => codex.close());
  const runtime = codex as any, ids = [randomUUID(), randomUUID()], calls: { method: string; params: any }[] = [];
  runtime.ensureStarted = async () => {};
  runtime.request = async (method: string, params: any) => {
    calls.push({ method, params }); return method === 'thread/start' ? { thread: { id: ids.shift() } } : { thread: { id: params.threadId } };
  };
  const legacy = (await codex.createSession({}, () => {}, () => {})).key;
  assert.equal(calls[0]!.params.dynamicTools, undefined); assert.equal(codex.hasBoardTools(legacy), false);
  runtime.options.boardToolsDirectory = '/synthetic/private-grants';
  const created = (await codex.createSession({}, () => {}, () => {})).key;
  assert.deepEqual(calls.filter(c => c.method === 'thread/start').at(-1)!.params.dynamicTools, codexBoardToolSpecs);
  assert.equal(memoryPersistence(store).executions.hasBoardTools(created.slice(6)), true);
  assert.equal(codex.hasBoardTools(legacy), false); assert.equal(codex.hasBoardTools(created), true);
  runtime.loadedThreadIds.clear(); await runtime.ensureThreadLoaded(legacy.slice(6));
  assert.equal(calls.at(-1)!.method, 'thread/resume'); assert.equal(calls.at(-1)!.params.dynamicTools, undefined);
  assert.equal(codex.hasBoardTools(legacy), false);
});

test('concurrent task thread creation reserves capacity before native start and releases failed starts', async context => {
  const { codex } = fixture(); context.after(() => codex.close()); const runtime = codex as any;
  const db = new DatabaseSync(':memory:'); context.after(() => db.close());
  runtime.options.executions = new CodexExecutions(db, undefined, 1);
  runtime.options.boardToolsDirectory = '/synthetic/private-grants';
  runtime.ensureStarted = async () => {};
  let starts = 0, fail!: (error: Error) => void;
  runtime.request = (method: string) => {
    assert.equal(method, 'thread/start'); starts++;
    return new Promise((_resolve, reject) => { fail = reject; });
  };
  const first = codex.createSession({}, () => {}, () => {});
  const failed = assert.rejects(first, /native failed/);
  await Promise.resolve();
  await assert.rejects(codex.createSession({}, () => {}, () => {}), /capacity/);
  assert.equal(starts, 1);
  fail(new Error('native failed')); await failed;
  assert.equal(runtime.pendingBoardThreadStarts, 0);
  runtime.request = async (method: string) => {
    if (method === 'thread/start') { starts++; return { thread: { id: randomUUID() } }; }
    return {};
  };
  await codex.createSession({}, () => {}, () => {});
  assert.equal(starts, 2); assert.equal(runtime.pendingBoardThreadStarts, 0);
  await assert.rejects(codex.createSession({}, () => {}, () => {}), /capacity/);
  assert.equal(starts, 2);
});

test('native board RPC is generation-fenced and remains part of maintenance drain until settled', async context => {
  const { codex } = fixture(); context.after(() => codex.close()); const runtime = codex as any;
  let resolve!: (value: any) => void, pending = 0;
  const responses: unknown[] = [];
  runtime.boardTools = { invoke: () => { pending++; return new Promise(r => { resolve = value => { pending--; r(value); }; }); },
    get inFlight() { return pending; }, reset: () => {}, close: async () => {} };
  runtime.write = (value: unknown) => responses.push(value);
  runtime.receive(JSON.stringify({ id: 'tool-1', method: 'item/tool/call', params: {} }));
  assert.equal((await codex.inspectMaintenance()).inFlightWrites, 1);
  resolve({ success: false, contentItems: [] }); await new Promise(r => setImmediate(r));
  assert.deepEqual(responses, [{ id: 'tool-1', result: { success: false, contentItems: [] } }]);
  assert.equal((await codex.inspectMaintenance()).inFlightWrites, 0);
  runtime.receive(JSON.stringify({ id: 'tool-2', method: 'item/tool/call', params: {} }));
  runtime.connectionId = 'replacement'; resolve({ success: false, contentItems: [] });
  await new Promise(r => setImmediate(r)); assert.equal(responses.length, 1, 'old child result cannot enter replacement RPC');
});

test('admitted native task tools require acknowledged turn and current execution authority', async context => {
  const { codex, store } = fixture(); context.after(() => codex.close()); const runtime = codex as any;
  const thread = randomUUID(), key = `codex:${thread}`, facts = memoryPersistence(store).executions;
  facts.enrollBoardTools(thread); runtime.options.boardToolsDirectory = '/synthetic/private'; runtime.connectionId = 'connection';
  let current!: (turn: string) => boolean, allowed = true, stops = 0;
  runtime.authorized = () => allowed;
  runtime.boardTools = { begin: (id: string, active: typeof current) => { assert.equal(id, thread); current = active; },
    stop: () => { stops++; }, reset: () => {}, close: async () => {} };
  runtime.request = async (method: string) => {
    assert.equal(method, 'turn/start'); assert.equal(current('turn'), false, 'native call before ACK is not authorized');
    return { turn: { id: 'turn' } };
  };
  await runtime.startTurn(key, thread, [], 'command');
  assert.equal(current('turn'), true); assert.equal(current('other'), false);
  allowed = false; assert.equal(current('turn'), false); allowed = true;
  runtime.connectionId = 'replacement'; assert.equal(current('turn'), false); runtime.connectionId = 'connection';
  facts.observe(key, 'connection', 'turn', 'completed'); assert.equal(current('turn'), false);
  assert.equal(stops, 0, 'callback rejects terminal fact independently of notification cleanup');
});

test('maintenance inspection never starts an unused native process and counts unresolved durable work', async context => {
  const { store, codex, sessionKey } = fixture();
  context.after(() => codex.close());
  const runtime = codex as any, { executions, turnQueue } = memoryPersistence(store);
  runtime.ensureStarted = async () => { throw new Error('Maintenance must not start native'); };
  const { assertCurrent, ...initial } = await codex.inspectMaintenance();
  assertCurrent();
  assert.deepEqual(initial, { loadedThreads: 0, activeRuns: 0,
    backgroundTerminals: 0, pendingExecutions: 0, queuedMessages: 0, inFlightWrites: 0 });
  executions.begin(sessionKey, 'unconfirmed', 'old-connection');
  assert.equal((await codex.inspectMaintenance()).pendingExecutions, 1);
  // The queue metadata query must work even when payloads cannot be decoded.
  assert.equal(turnQueue.maintenanceCount('codex'), 0);
  runtime.childLifetimes.set({}, { closed: Promise.resolve(), stopRequested: true });
  await assert.rejects(codex.inspectMaintenance(), /unavailable/);
  runtime.childLifetimes.clear();
});

test('maintenance and ordinary reads never resume or reproject an acknowledged archived terminal', async context => {
  const users = new ConnectorUserStore(':memory:'), store = new DeckStore();
  const key = 'codex:archived', scope = JSON.stringify(['delete', JSON.stringify(['actor', key])]);
  const codex = new CodexAppServer({ authorizeTurn: () => true, turnQueue: users.turns, executions: users.codexExecutions,
    enabled: true, command: 'codex', defaultCwd: '/synthetic', defaultModel: 'synthetic', approvalPolicy: 'never', store });
  context.after(async () => { await codex.close(); users.close(); });
  const facts = users.codexExecutions;
  facts.begin(key, 'send', 'connection');
  facts.acknowledge(key, 'send', 'connection', 'run', () => {});
  facts.observe(key, 'connection', 'run', 'completed');
  (await users.commands.claimAsync(scope, 'delete', {}));
  users.commands.settle(scope, 'delete', { status: 200, body: { ok: true, status: 'delete_accepted' } });
  (codex as any).request = async () => assert.fail('Archived recovery must not issue a native RPC');
  (codex as any).ensureStarted = async () => assert.fail('Archived recovery must not start native');
  const before = facts.get(key);
  let checks = 0;
  await codex.recoverMaintenanceHistory(key, () => { checks++; });
  assert.equal(checks, 1, 'the maintenance authority is checked even for archived history');
  await assert.rejects(codex.refreshSession(key), /deleted/);
  assert.equal(store.getSession(key), undefined);
  assert.deepEqual(facts.get(key), before);
  assert.equal((await codex.inspectMaintenance()).pendingExecutions, 0);
});

test('maintenance native observation rejects notifications, connection ABA and new requests during reads', async context => {
  const { codex } = fixture(), runtime = codex as any;
  context.after(() => { runtime.child = undefined; runtime.childLifetimes.clear(); return codex.close(); });
  const child = {};
  runtime.child = child; runtime.connectionId = 'original';
  runtime.childLifetimes.set(child, { closed: Promise.resolve(), stopRequested: false });
  for (const invalidate of [
    () => runtime.handleNotification('maintenance/test', {}),
    () => { runtime.setConnection('other'); runtime.setConnection('original'); },
    () => { runtime.maintenanceEpoch++; },
  ]) {
    runtime.request = async () => { invalidate(); return { data: [], nextCursor: null }; };
    await assert.rejects(codex.inspectMaintenance(), /changed/);
  }
  runtime.request = async () => ({ data: [], nextCursor: null });
  let authorized = true;
  runtime.request = async () => { authorized = false; return { data: [], nextCursor: null }; };
  await assert.rejects(codex.inspectMaintenance(() => { if (!authorized) throw new Error('revoked'); }), /revoked/);
});

test('async maintenance authority is awaited before native RPCs and durable facts with synchronous final proof', async context => {
  const { codex } = fixture(), runtime = codex as any;
  context.after(() => { runtime.child = undefined; runtime.childLifetimes.clear(); return codex.close(); });
  const child = {}; runtime.child = child; runtime.connectionId = 'original';
  runtime.childLifetimes.set(child, { closed: Promise.resolve(), stopRequested: false });
  const calls: string[] = [];
  runtime.request = async (method: string) => { calls.push(method); return { data: [], nextCursor: null }; };
  const result = await codex.inspectMaintenanceAsync(async () => { await Promise.resolve(); calls.push('authority'); }, () => {});
  assert.equal(result.loadedThreads, 0); assert.equal(result.assertCurrent(), undefined);
  assert.equal(calls.filter(c => c === 'thread/loaded/list').length, 2);
  for (let i = 0; i < calls.length; i++) if (calls[i] !== 'authority') {
    assert.equal(calls[i - 1], 'authority'); assert.equal(calls[i + 1], 'authority');
  }
  runtime.maintenanceEpoch++; assert.throws(result.assertCurrent, /changed/);
});

for (const change of ['connection ABA', 'activity', 'revoke', 'deadline', 'local fence'] as const) {
  test(`async maintenance rejects ${change} during awaited authority before any native RPC`, async context => {
    const { codex } = fixture(), runtime = codex as any;
    context.after(() => { runtime.child = undefined; runtime.childLifetimes.clear(); return codex.close(); });
    const child = {}; runtime.child = child; runtime.connectionId = 'original';
    runtime.childLifetimes.set(child, { closed: Promise.resolve(), stopRequested: false });
    runtime.request = async () => assert.fail('must not issue native RPC after invalidation');
    let local = true;
    await assert.rejects(codex.inspectMaintenanceAsync(async () => {
      await Promise.resolve();
      if (change === 'connection ABA') { runtime.setConnection('other'); runtime.setConnection('original'); }
      if (change === 'activity') runtime.handleNotification('maintenance/test', {});
      if (change === 'revoke') throw Error('revoked');
      if (change === 'local fence') local = false;
    }, () => { if (!local) throw Error('fenced'); }, change === 'deadline' ? Date.now() - 1 : Date.now() + 4000));
  });
}

test('async native inspection rechecks authority after RPC before issuing successor reads', async context => {
  const { codex } = fixture(), runtime = codex as any;
  context.after(() => { runtime.child = undefined; runtime.childLifetimes.clear(); return codex.close(); });
  const child = {}; runtime.child = child; runtime.connectionId = 'original';
  runtime.childLifetimes.set(child, { closed: Promise.resolve(), stopRequested: false });
  let revoked = false, requests = 0;
  runtime.request = async () => { requests++; revoked = true; return { data: ['parent'], nextCursor: null }; };
  await assert.rejects(codex.inspectMaintenanceAsync(async () => {
    await Promise.resolve(); if (revoked) throw Error('revoked after native read');
  }, () => {}), /revoked after native read/);
  assert.equal(requests, 1);
});

test('async maintenance authority wait cannot consume deadline and still dispatch a read', async context => {
  const { codex } = fixture(), runtime = codex as any;
  context.after(() => { runtime.child = undefined; runtime.childLifetimes.clear(); return codex.close(); });
  const child = {}; runtime.child = child; runtime.connectionId = 'original';
  runtime.childLifetimes.set(child, { closed: Promise.resolve(), stopRequested: false });
  const now = Date.now(); let clock = now;
  context.mock.method(Date, 'now', () => clock);
  runtime.request = async () => assert.fail('expired authority must not dispatch native');
  await assert.rejects(codex.inspectMaintenanceAsync(async () => { await Promise.resolve(); clock = now + 4001; }, () => {}, now + 4000), /timed out/);
});

test('native token usage updates project current context without cumulative billing or lifecycle changes', context => {
  const { store, codex, sessionKey, threadId, notify } = fixture();
  context.after(() => codex.close());
  notify('thread/tokenUsage/updated', { threadId, tokenUsage: { last: { totalTokens: 4200 }, total: { totalTokens: 900000 }, modelContextWindow: 128000 } });
  assert.equal(store.getSession(sessionKey)?.contextUsedTokens, 4200);
  assert.equal(store.getSession(sessionKey)?.contextTokens, 128000);
  assert.equal(store.getSession(sessionKey)?.status, 'running');
  const version = (codex as any).projectionVersion(sessionKey);
  notify('thread/tokenUsage/updated', { threadId, tokenUsage: { total: { totalTokens: 910000 } } });
  assert.equal(store.getSession(sessionKey)?.contextUsedTokens, 4200);
  assert.equal((codex as any).projectionVersion(sessionKey), version, 'empty samples do not invalidate a history read');
  notify('thread/tokenUsage/updated', { threadId, tokenUsage: { last: { totalTokens: 0 } } });
  assert.equal(store.getSession(sessionKey)?.contextUsedTokens, 0);
});

test('native token usage ignores stale turns, connections and unacknowledged execution', context => {
  const { store, codex, sessionKey, threadId, notify } = fixture();
  context.after(() => codex.close());
  const runtime = codex as any, facts = memoryPersistence(store).executions;
  runtime.connectionId = 'current-connection';
  facts.begin(sessionKey, 'command-1', 'current-connection');
  const sample = (turnId: string, value: number) => notify('thread/tokenUsage/updated', {
    threadId, turnId, tokenUsage: { last: { totalTokens: value } },
  });
  sample('old-turn', 9000);
  assert.equal(store.getSession(sessionKey)?.contextUsedTokens, undefined);
  facts.acknowledge(sessionKey, 'command-1', 'current-connection', 'current-turn', () => {});
  sample('current-turn', 4200);
  sample('old-turn', 9000);
  assert.equal(store.getSession(sessionKey)?.contextUsedTokens, 4200);
  runtime.connectionId = 'replacement-connection';
  sample('current-turn', 8000);
  assert.equal(store.getSession(sessionKey)?.contextUsedTokens, 4200);
  runtime.connectionId = 'current-connection';
  facts.observe(sessionKey, 'current-connection', 'current-turn', 'completed');
  sample('old-turn', 9000);
  assert.equal(store.getSession(sessionKey)?.contextUsedTokens, 4200);
});

test('native consumption ledger accepts only fenced cumulative deltas, not stale events or context samples', context => {
  const { store, codex, sessionKey, threadId, notify } = fixture();
  const db = new DatabaseSync(':memory:'), ledger = new NativeTokenUsageStore(db, () => 1000);
  context.after(() => { codex.close(); db.close(); });
  const runtime = codex as any, facts = memoryPersistence(store).executions;
  runtime.options.tokenUsage = ledger;
  runtime.connectionId = 'current-connection';
  facts.begin(sessionKey, 'usage-command', 'current-connection');
  const sample = (turnId: string | undefined, inputTokens: number, outputTokens: number) => notify('thread/tokenUsage/updated', {
    threadId, turnId, tokenUsage: { total: { inputTokens, outputTokens }, last: { totalTokens: 7 } },
  });
  sample('old-turn', 9999, 9999);
  facts.acknowledge(sessionKey, 'usage-command', 'current-connection', 'usage-turn', () => {});
  sample('usage-turn', 100, 10); // First authoritative observation is a baseline.
  assert.deepEqual(ledger.range('codex', sessionKey, 0, 3_600_000, 3_600_000).buckets, []);
  sample('old-turn', 9999, 9999);
  sample(undefined, 9999, 9999);
  runtime.connectionId = 'replacement-connection';
  sample('usage-turn', 9999, 9999);
  runtime.connectionId = 'current-connection';
  sample('usage-turn', 150, 20);
  sample('usage-turn', 150, 20);
  notify('thread/tokenUsage/updated', { threadId, turnId: 'usage-turn', tokenUsage: { last: { totalTokens: 900 } } });
  assert.deepEqual(ledger.range('codex', sessionKey, 0, 3_600_000, 3_600_000).buckets,
    [{ at: 0, samples: 1, inputTokens: 50, outputTokens: 10, cacheReadTokens: null, cacheWriteTokens: null,
      models: [{ model: null, samples: 1, inputTokens: 50, outputTokens: 10, cacheReadTokens: null, cacheWriteTokens: null }] }]);
  assert.equal(store.getSession(sessionKey)?.contextUsedTokens, 900, 'context projection remains separate');
  assert.equal(store.getSession(sessionKey)?.inputTokens, 150);
  assert.equal(store.getSession(sessionKey)?.outputTokens, 20, 'summary uses exact cumulative output, not deltas, last or stale samples');
});

test('waiting 2+3 start one native turn after 1; a new arrival waits, and history restores separate identities', async context => {
  const {store,codex,sessionKey,threadId} = fixture(), runtime = codex as any;
  context.after(() => codex.close());
  const {turnQueue:queue,executions:facts} = memoryPersistence(store);
  runtime.connectionId = 'synthetic-connection';
  runtime.ensureStarted = async () => {};
  runtime.ensureThreadLoaded = async () => {};
  runtime.threadRefreshResult.set(sessionKey, {at:Date.now(),available:true});
  const second = await codex.send(sessionKey, '测试2'), third = await codex.send(sessionKey, '测试3');
  let writes = 0, input: any[] = [], release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  runtime.request = async (method: string, params: any) => {
    assert.equal(method, 'turn/start'); writes++; input = params.input;
    await gate;
    return {turn:{id:'combined-run'}};
  };
  await runtime.dispatchQueuedTurn(sessionKey);
  assert.equal(writes,0,'run 1 is still active');
  const dispatchStartedAt = Date.now();
  store.upsertSession({sessionKey,agentId:'codex',title:'Test',status:'idle',hasActiveRun:false});
  const dispatch = runtime.dispatchQueuedTurn(sessionKey);
  for(let i=0;i<20&&!writes;i++) await new Promise(resolve=>setImmediate(resolve));
  assert.equal(writes,1);
  assert.equal(queue.cancel('codex',sessionKey,second.idempotencyKey),false);
  assert.equal(queue.edit('codex',sessionKey,third.idempotencyKey,()=>({text:'late',images:[]})),false);
  const fourth = await codex.send(sessionKey,'测试4');
  release(); await dispatch;
  assert.deepEqual(queue.list('codex',sessionKey).map(row=>row.id),[fourth.idempotencyKey]);
  assert.deepEqual(store.getMessages(sessionKey).filter(row=>row.turnId==='combined-run').map(row=>row.id),[second.idempotencyKey,third.idempotencyKey]);
  const sent = store.getMessages(sessionKey).filter(row => row.turnId === 'combined-run');
  assert.ok(sent.every(row => row.createdAt >= dispatchStartedAt), 'sent time must not be the enqueue time');
  assert.equal(sent[0]!.createdAt, sent[1]!.createdAt, 'one batch shares its dispatch time');
  const batch = facts.batchForRun(sessionKey,'combined-run')!;
  assert.equal(input[0].text, ['测试2','测试3'].join(batch.separator));
  await runtime.dispatchQueuedTurn(sessionKey); assert.equal(writes,1,'no parallel successor');
  runtime.request = async (method: string) => {
    if (method === 'thread/backgroundTerminals/list') return { data: [] };
    assert.equal(method,'thread/read');
    return {thread:{id:threadId,status:{type:'idle'},turns:[{id:'combined-run',status:'completed',items:[
      {id:'native-user',type:'userMessage',content:input},{id:'reply',type:'agentMessage',text:'Both handled in one turn'},
    ]}]}};
  };
  await codex.refreshSession(sessionKey);
  const history = store.getMessages(sessionKey).filter(row=>row.role==='user');
  assert.deepEqual(history.map(row=>[row.id,row.text]),[[second.idempotencyKey,'测试2'],[third.idempotencyKey,'测试3'],[fourth.idempotencyKey,'测试4']]);
  assert.ok(history.slice(0,2).every(row=>row.status==='sent'));
});

for (const failure of ['lost-ack','revoked'] as const) test(`batch ${failure} never silently replays a member`, async context => {
  const {store,codex,sessionKey} = fixture(), runtime = codex as any;
  context.after(() => codex.close());
  const {turnQueue:queue,executions:facts} = memoryPersistence(store);
  runtime.connectionId = 'synthetic-connection'; runtime.ensureStarted = async () => {};
  let authorized = true, writes = 0;
  runtime.options.authorizeTurn = () => authorized;
  runtime.ensureThreadLoaded = async () => { if(failure==='revoked') authorized=false; };
  runtime.threadRefreshResult.set(sessionKey,{at:Date.now(),available:true});
  await codex.send(sessionKey,'2'); await codex.send(sessionKey,'3');
  store.upsertSession({sessionKey,agentId:'codex',title:'Test',status:'idle',hasActiveRun:false});
  runtime.request = async () => { writes++; throw new Error('lost ACK after possible native start'); };
  await runtime.dispatchQueuedTurn(sessionKey);
  assert.equal(writes,failure==='lost-ack'?1:0);
  assert.deepEqual(queue.list('codex',sessionKey).map(row=>row.state),Array(2).fill(failure==='lost-ack'?'outcome_unknown':'blocked'));
  if(failure==='lost-ack') assert.equal(facts.get(sessionKey)?.batch?.members.length,2);
  facts.recoverInterrupted(); queue.recoverInterrupted('codex');
  authorized=true;
  await runtime.dispatchQueuedTurn(sessionKey);
  assert.equal(writes,failure==='lost-ack'?1:0);
});

test('batch native history preserves duplicate text, image-only messages, attachment order and additional user items', async context => {
  const {store,codex,sessionKey,threadId} = fixture(), runtime = codex as any;
  context.after(()=>codex.close());
  runtime.connectionId='synthetic-connection'; runtime.ensureStarted=async()=>{}; runtime.ensureThreadLoaded=async()=>{};
  runtime.threadRefreshResult.set(sessionKey,{at:Date.now(),available:true});
  const image=(name:string)=>({filePath:join(process.env.HOME!,'.local','share','agentopsdeck','media','inbound',name),
    media:{type:'image' as const,url:`/api/media/inbound/${name}`,name}});
  const texts = ['', 'same', 'same', '  indented\n', '', ''];
  const images = [[image('first.png')], [], [], [], [image('middle.png')], [image('last.png')]];
  const rows: Awaited<ReturnType<typeof codex.send>>[] = [];
  for (const [i, text] of texts.entries()) rows.push(await codex.send(sessionKey, text, images[i]));
  let input:any[]=[];
  runtime.request=async(method:string,params:any)=>{assert.equal(method,'turn/start');input=params.input;return {turn:{id:'images-run'}};};
  store.upsertSession({sessionKey,agentId:'codex',title:'Test',status:'idle',hasActiveRun:false});
  await runtime.dispatchQueuedTurn(sessionKey);
  assert.deepEqual(input.filter(part=>part.type==='localImage').map(part=>part.path),images.flat().map(image=>image.filePath));
  runtime.request=async(method:string)=>{
    if (method === 'thread/backgroundTerminals/list') return { data: [] };
    assert.equal(method,'thread/read');
    return {thread:{id:threadId,status:{type:'idle'},turns:[{id:'images-run',status:'completed',items:[
      {id:'native-input',type:'userMessage',content:input},
      {id:'external-input',type:'userMessage',content:[{type:'text',text:'Separate native user item'}]},
      {id:'native-reply',type:'agentMessage',text:'One reply'},
    ]}]}};
  };
  await codex.refreshSession(sessionKey);
  const messages=store.getMessages(sessionKey);
  for(const [i,text] of texts.entries()) {
    const message=messages.find(row=>row.id===rows[i]!.idempotencyKey)!;
    assert.equal(message.text,text); assert.equal(message.turnId,'images-run');
    assert.deepEqual(message.media?.map(media=>media.name)??[],images[i]!.map(image=>image.media.name));
  }
  assert.equal(messages.filter(row=>row.text==='Separate native user item').length,1);
  assert.equal(messages.some(row=>row.text.includes('Queued message boundary')),false);
});

for (const provider of [undefined, '', '  ', ' replacement-provider ']) test(`Codex provider override applies to creation and ordinary resume (${JSON.stringify(provider)})`, async context => {
  const { codex } = fixture();
  context.after(() => codex.close());
  const runtime = codex as any;
  const config = loadConfig({ AOD_CODEX_MODEL_PROVIDER: provider });
  runtime.options.modelProvider = config.codex.modelProvider;
  const expected = provider?.trim() || undefined;
  assert.equal(config.codex.modelProvider, expected);
  runtime.ensureStarted = async () => {};
  const methods: string[] = [];
  runtime.request = async (method: string, params: any) => {
    methods.push(method);
    if (method === 'thread/name/set') return {};
    assert.equal(params.modelProvider, expected);
    if (!expected) assert.equal(Object.hasOwn(params, 'modelProvider'), false);
    return { thread: { id: 'created' } };
  };
  await codex.createSession({ title: 'Provider test' }, () => {}, () => {});
  await runtime.ensureThreadLoaded('restored');
  assert.deepEqual(methods, ['thread/start', 'thread/name/set', 'thread/resume']);
});

test('Codex rejected create identity preserves old runtime state and does not compensate or retry native creation', async () => {
  const { codex, store, threadId, sessionKey } = fixture();
  const calls: string[] = [];
  (codex as any).ensureStarted = async () => {};
  (codex as any).threadModels.set(threadId, 'old-model');
  (codex as any).request = async (method: string) => { calls.push(method); return { thread: { id: threadId } }; };
  const failure = new Error('identity unavailable');
  await assert.rejects(codex.createSession({ title: 'new', model: 'new-model' }, () => assert.fail('unexpected acceptance'), () => {}, key => {
    assert.equal(key, sessionKey); throw failure;
  }), error => error === failure);
  assert.deepEqual(calls, ['thread/start']);
  assert.equal((codex as any).loadedThreadIds.has(threadId), false);
  assert.equal((codex as any).threadModels.get(threadId), 'old-model');
  assert.equal(store.getSession(sessionKey)?.title, 'Test');
});

for (const boundary of ['before-startup', 'during-startup', 'after-write'] as const) {
  test(`Codex create authority boundary: ${boundary}`, async () => {
    const { codex, store } = fixture();
    let allowed = boundary !== 'before-startup', starts = 0, writes = 0, checks = 0;
    (codex as any).ensureStarted = async () => { starts++; if (boundary === 'during-startup') allowed = false; };
    (codex as any).request = async (method: string) => {
      if (method === 'thread/name/set') return {};
      assert.equal(method, 'thread/start'); writes++; allowed = false; return { thread: { id: 'created' } };
    };
    const result = codex.createSession({ title: 'new' }, key => assert.equal(key, 'codex:created'), () => {
      checks++; if (!allowed) throw new TurnAuthorizationError();
    });
    if (boundary === 'after-write') {
      assert.equal((await result).key, 'codex:created');
      assert.equal(store.getSession('codex:created')?.title, 'new');
      assert.equal(writes, 1); assert.equal(checks, 2);
    } else {
      await assert.rejects(result, TurnAuthorizationError);
      assert.equal(starts, boundary === 'before-startup' ? 0 : 1);
      assert.equal(writes, 0); assert.equal(store.getSession('codex:created'), undefined);
    }
  });
}

test('Codex interrupt binds the observed turn and rechecks target and authority after async preparation', async () => {
  const { codex, sessionKey, threadId, store } = fixture();
  const calls: unknown[] = [];
  let preparations = 0, authorized = true, duringPreparation = () => {};
  (codex as any).options.authorizeTurn = (actor: string) => authorized && actor === 'actor';
  (codex as any).activeTurnIds.set(sessionKey, 'old-turn');
  (codex as any).connectionId = "synthetic-connection";
  (codex as any).ensureStarted = async () => { preparations++; duringPreparation(); };
  (codex as any).request = async (method: string, params: unknown) => {
    calls.push({ method, params });
    if (method === 'thread/read') return { thread: { id: threadId, turns: [{ id: 'next-turn', items: [] }] } };
    if (method === 'thread/backgroundTerminals/list') return { data: [] };
    return {};
  };
  try {
    await assert.rejects(codex.interrupt(sessionKey, '', 'actor'), RunControlConflict);
    await assert.rejects(codex.interrupt(sessionKey, 'another-turn', 'actor'), RunControlConflict);
    assert.equal(preparations, 0);
    duringPreparation = () => (codex as any).activeTurnIds.set(sessionKey, 'next-turn');
    await assert.rejects(codex.interrupt(sessionKey, 'old-turn', 'actor'), RunControlConflict);
    assert.equal(calls.length, 0, 'late control never targets the next turn');
    duringPreparation = () => { authorized = false; };
    await assert.rejects(codex.interrupt(sessionKey, 'next-turn', 'actor'), TurnAuthorizationError);
    assert.equal(calls.length, 0, 'revoked control never reaches runtime');
    authorized = true; duringPreparation = () => {};
    await codex.interrupt(sessionKey, 'next-turn', 'actor');
    assert.deepEqual(calls, [{ method: 'turn/interrupt', params: { threadId, turnId: 'next-turn' } },
      { method: 'thread/read', params: { threadId, includeTurns: true } },
      { method: 'thread/backgroundTerminals/list', params: { threadId, limit: 100 } }]);
    assert.equal(store.getSession(sessionKey)?.status, 'running', 'interrupt ACK is not terminal completion');
  } finally { await codex.close(); }
});

for (const scenario of ['accepted', 'revoked-before', 'revoked-preparation', 'revoked-after-write']) {
  test(`Codex archive authorization: ${scenario}`, async () => {
    const { codex, store, sessionKey } = fixture();
    let authorized = scenario !== 'revoked-before', preparations = 0;
    const writes: string[] = [];
    const authorize = () => { if (!authorized) throw new TurnAuthorizationError(); };
    (codex as any).ensureStarted = async () => {
      preparations++;
      if (scenario === 'revoked-preparation') authorized = false;
    };
    (codex as any).request = async (method: string) => {
      writes.push(method);
      if (scenario === 'revoked-after-write') authorized = false;
      return {};
    };
    try {
      const accepted = scenario === 'accepted' || scenario === 'revoked-after-write';
      const pending = codex.remove(sessionKey, authorize);
      if (accepted) await pending;
      else await assert.rejects(pending, TurnAuthorizationError);
      assert.deepEqual(writes, accepted ? ['thread/archive'] : []);
      assert.equal(!!store.getSession(sessionKey), !accepted);
      if (scenario === 'revoked-before') assert.equal(preparations, 0);
    } finally { await codex.close(); }
  });
}

test('Codex session creation explicitly uses the configured default model', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-codex-title-'));
  try {
    const titleFile = join(dir, 'titles.json');
    const store = new DeckStore({ sessionTitlesFile: titleFile });
    const codex = new CodexAppServer({ authorizeTurn: () => true, ...memoryPersistence(store), enabled: true, command: 'codex', defaultCwd: 'C:\\workspace', defaultModel: 'gpt-5.6-sol', approvalPolicy: 'never', store });
    (codex as any).connectionId = "synthetic-connection";
    (codex as any).ensureStarted = async () => undefined;
    (codex as any).request = async (method: string, params: any) => {
      if (method === 'thread/name/set') { assert.deepEqual(params, { threadId: 'thread-sol', name: 'Sol task' }); return {}; }
      assert.equal(method, 'thread/start');
      assert.equal(params.model, 'gpt-5.6-sol');
      assert.match(params.developerInstructions, /at most 2 high-resolution images/);
      return { thread: { id: 'thread-sol' } };
    };

    const created = await codex.createSession({ title: 'Sol task' }, key => assert.equal(key, 'codex:thread-sol'), () => {});

    assert.equal(created.key, 'codex:thread-sol');
    assert.equal(store.getSession(created.key)?.model, 'gpt-5.6-sol');
    assert.equal(JSON.parse(readFileSync(titleFile, 'utf8'))[created.key], 'Sol task');

    const restartedStore = new DeckStore({ sessionTitlesFile: titleFile });
    restartedStore.upsertSession({ sessionKey: created.key, agentId: 'codex', title: 'First input became the Codex thread name', status: 'idle', source: 'codex' });
    assert.equal(restartedStore.getSession(created.key)?.title, 'Sol task');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Codex read timeout does not kill the shared App Server or other runs', async () => {
  const store = new DeckStore();
  const codex = new CodexAppServer({ authorizeTurn: () => true, ...memoryPersistence(store), enabled: true, command: 'codex', defaultCwd: 'C:\\workspace', defaultModel: 'gpt-5.6-sol', approvalPolicy: 'never', store, requestTimeoutMs: 10 });
  let killed = false;
  (codex as any).child = {
    pid: undefined,
    killed: false,
    stdin: { writable: true, write: () => true },
    kill: () => { killed = true; },
  };

  await assert.rejects((codex as any).request('thread/read', {}), /request timed out: thread\/read/);

  assert.ok((codex as any).child);
  assert.equal((codex as any).pending.size, 0);
  assert.equal(killed, false);
});

test('Codex rollout model recovery keeps the last successful model after a failed switch', () => {
  const rollout = [
    { payload: { type: 'thread_settings_applied', thread_settings: { model: 'gpt-5.6-terra' } } },
    { payload: { type: 'task_complete', turn_id: 'turn-terra', error: null } },
    { payload: { type: 'thread_settings_applied', thread_settings: { model: 'gpt-5.6-sol' } } },
    { payload: { type: 'task_complete', turn_id: 'turn-sol', error: { message: 'compact failed' } } },
  ].map((entry) => JSON.stringify(entry)).join('\n');

  assert.equal(threadModelFromRollout(rollout), 'gpt-5.6-terra');
});

test('Codex command lifecycle projects a live tool call and completed result', () => {
  const { store, threadId, sessionKey, notify } = fixture();
  const started = { type: 'commandExecution', id: 'command-1', command: 'Write-Output ok', cwd: 'C:\\workspace', status: 'inProgress', aggregatedOutput: null, exitCode: null, durationMs: null };
  notify('item/started', { threadId, turnId: 'turn-1', item: started, startedAtMs: 1_000 });
  notify('item/commandExecution/outputDelta', { threadId, turnId: 'turn-1', itemId: 'command-1', delta: 'ok\n' });

  const live = store.getMessages(sessionKey);
  assert.equal(live.length, 1);
  assert.equal(live[0]?.role, 'tool');
  assert.equal(live[0]?.toolPhase, 'call');
  assert.equal(live[0]?.status, 'sending');
  assert.match(live[0]?.text ?? '', /Activity: running/);
  assert.match(live[0]?.text ?? '', /Recent output preview.*ok/s);
  assert.equal(store.getEventsSince().filter((event) => event.type === 'tool.started').length, 1);

  notify('item/completed', { threadId, turnId: 'turn-1', completedAtMs: 1_250, item: { ...started, status: 'completed', aggregatedOutput: 'ok\n', exitCode: 0, durationMs: 250 } });
  const completed = store.getMessages(sessionKey);
  assert.equal(completed.length, 2);
  assert.deepEqual(completed.map((message) => message.toolPhase), ['call', 'result']);
  assert.deepEqual(completed.map((message) => message.status), ['sent', 'sent']);
  assert.match(completed[1]?.text ?? '', /"output": "ok\\n"/);
});

test('Codex live tool output keeps only a bounded tail and clears it after final reconciliation', async () => {
  const { store, codex, threadId, sessionKey, notify } = fixture();
  const started = { type: 'commandExecution', id: 'command-large', command: 'large-output', cwd: 'C:\\workspace', status: 'inProgress' };
  notify('item/started', { threadId, turnId: 'turn-large', item: started, startedAtMs: 1_000 });
  notify('item/commandExecution/outputDelta', { threadId, turnId: 'turn-large', itemId: 'command-large', delta: `first-marker\n${'x'.repeat(8 * 1024)}\nlast-marker` });

  const liveText = store.getMessages(sessionKey)[0]?.text ?? '';
  assert.doesNotMatch(liveText, /first-marker/);
  assert.match(liveText, /last-marker/);
  assert.ok((liveText.match(/x/g) ?? []).length <= 2 * 1024);
  const eventTextLength = ((store.getEventsSince().at(-1)?.payload as { text?: string })?.text ?? '').length;
  assert.ok(eventTextLength < 20 * 1024);
  assert.equal((codex as any).toolOutput.size, 1);

  (codex as any).request = async (method: string) => method === 'thread/backgroundTerminals/list' ? { data: [] } : ({ thread: { id: threadId, turns: [{ id: 'turn-large', status: 'completed', items: [] }] } });
  notify('turn/completed', { threadId, turn: { id: 'turn-large', status: 'completed' } });
  assert.equal((codex as any).toolOutput.size, 1);
  await (codex as any).completingTurns.get(sessionKey);
  // The Deck projection remains visible, while transient full-speed stream buffers are gone.
  assert.equal((codex as any).toolOutput.size, 0);
  assert.equal((codex as any).toolCallText.size, 0);
});

test('Codex MCP failures preserve arguments and surface as failed tool results', () => {
  const { store, threadId, sessionKey, notify } = fixture();
  const started = { type: 'mcpToolCall', id: 'mcp-1', server: 'github', tool: 'search', arguments: { query: 'codex' }, status: 'inProgress', result: null, error: null, durationMs: null };
  notify('item/started', { threadId, turnId: 'turn-1', item: started, startedAtMs: 2_000 });
  notify('item/completed', { threadId, turnId: 'turn-1', completedAtMs: 2_100, item: { ...started, status: 'failed', error: { message: 'not authorized' }, durationMs: 100 } });

  const messages = store.getMessages(sessionKey);
  assert.equal(messages[0]?.toolName, 'github/search');
  assert.match(messages[0]?.text ?? '', /"query": "codex"/);
  assert.equal(messages[1]?.status, 'failed');
  assert.match(messages[1]?.failureReason ?? '', /not authorized/);
});

test('Codex failed turns surface the App Server error in the message timeline', () => {
  const { store, threadId, sessionKey, notify } = fixture();

  notify('turn/completed', {
    threadId,
    turn: {
      id: 'turn-failed',
      status: 'failed',
      error: { message: 'stream disconnected before response.completed' },
    },
  });

  const failure = store.getMessages(sessionKey).at(-1);
  assert.equal(store.getSession(sessionKey)?.status, 'failed');
  assert.equal(failure?.status, 'failed');
  assert.equal(failure?.failureReason, 'stream disconnected before response.completed');
  assert.equal(failure?.text, 'stream disconnected before response.completed');
});

test('Codex list restores metadata and explicit history read restores persisted messages', async () => {
  const { store, sessionKey } = fixture();
  store.addMessage({ id: 'foreign-history', sessionKey: 'codex:thread-restored', role: 'assistant', text: 'Message from another thread', status: 'sent', createdAt: 1 });
  const instance = new CodexAppServer({ authorizeTurn: () => true, ...memoryPersistence(store), enabled: true, command: 'codex', defaultCwd: 'C:\\workspace', defaultModel: 'gpt-5.6-sol', approvalPolicy: 'never', store });
  (instance as any).connectionId = "synthetic-connection";
  (instance as any).ensureStarted = async () => undefined;
  (instance as any).request = async (method: string, params: any) => {
    if (method === 'thread/list') {
      assert.deepEqual(params.sourceKinds, ['vscode', 'appServer']);
      assert.deepEqual(params.modelProviders, []);
      return { data: [{ id: 'thread-restored', name: null, preview: 'Review the project', status: { type: 'notLoaded' }, modelProvider: 'copilot_api', createdAt: 10, updatedAt: 20, recencyAt: 21 }], nextCursor: null };
    }
    if (method === 'thread/backgroundTerminals/list') return { data: [] };
    if (method === 'thread/read') return { thread: { id: params.threadId, turns: [{ id: 'turn-1', status: 'completed', startedAt: 20, items: [
      { type: 'userMessage', id: 'user-1', content: [
        { type: 'text', text: 'Review the project' },
        { type: 'localImage', path: join(process.env.HOME ?? '', '.local', 'share', 'agentopsdeck', 'media', 'inbound', 'agentopsdeck-1786243452325-CUaK5WpJ-screen.png') },
      ] },
      { type: 'commandExecution', id: 'tool-1', command: 'git status', cwd: 'C:\\workspace', status: 'completed', aggregatedOutput: 'clean', exitCode: 0, durationMs: 50 },
      { type: 'agentMessage', id: 'assistant-1', text: 'Done' },
    ] }] } };
    throw new Error(`unexpected request: ${method}`);
  };

  await instance.refreshSessions();
  const restoredKey = 'codex:thread-restored';
  assert.equal(store.getSession(restoredKey)?.title, 'Review the project');
  assert.equal(store.getSession(restoredKey)?.lastActiveAt, 21_000);
  assert.equal(store.getSession(restoredKey)?.model, undefined);
  await instance.refreshSession(restoredKey);
  assert.equal(store.getMessages(restoredKey)[0]?.media?.[0]?.url, '/api/media/inbound/agentopsdeck-1786243452325-CUaK5WpJ-screen.png');
  assert.equal(store.getMessages(restoredKey)[0]?.media?.[0]?.name, 'screen.png');
  assert.deepEqual(store.getMessages(restoredKey).map((message) => [message.role, message.toolPhase]), [
    ['user', undefined],
    ['tool', 'call'],
    ['tool', 'result'],
    ['assistant', undefined],
  ]);
  assert.equal(store.getMessages(restoredKey).some((message) => message.id === 'foreign-history'), false);
  assert.equal(store.getSession(sessionKey)?.title, 'Test');
});

for (const kind of ['list', 'thread'] as const) test(`Codex ${kind} refresh failures invalidate freshness and concurrent readers await the current attempt`, async () => {
  const { codex, sessionKey } = fixture();
  (codex as any).connectionId = 'synthetic-connection';
  (codex as any).ensureStarted = async () => {};
  const refresh = (maxAgeMs = 0) => kind === 'list' ? codex.refreshSessions({ maxAgeMs }) : codex.refreshSession(sessionKey, { maxAgeMs });
  const response = kind === 'list' ? { data: [], nextCursor: null } : { thread: { id: 'thread-1', turns: [] } };
  (codex as any).request = async () => response;
  await refresh();
  if (kind === 'list') assert.equal(codex.isSessionListReady(), true);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  (codex as any).request = async () => { await held; throw new Error('synthetic read failure'); };
  const forced = assert.rejects(refresh(), /synthetic read failure/);
  const cached = assert.rejects(refresh(60_000), /synthetic read failure/);
  if (kind === 'list') assert.equal(codex.isSessionListReady(), false, 'an unfinished refresh is not publishable');
  release(); await Promise.all([forced, cached]);
  if (kind === 'list') assert.equal(codex.isSessionListReady(), false, 'failed refresh cannot revive an old readiness proof');
  let retries = 0;
  (codex as any).request = async () => { retries++; return response; };
  if (kind === 'thread') {
    await assert.rejects(refresh(60_000), /snapshot unavailable/, 'failed cooldown is not a successful read');
    assert.equal(retries, 0, 'worker recovery keeps its existing failure cooldown');
    await refresh();
  } else await refresh(60_000);
  await refresh(60_000);
  assert.equal(retries, 1, 'only a successful retry may populate freshness');
  if (kind === 'list') assert.equal(codex.isSessionListReady(), true);
});

for (const response of [null, {}, { data: null }, { data: [null] }, { data: [{}] }, { data: [{ id: 1 }] },
  { data: [], nextCursor: 1 }, { data: [], nextCursor: '' }]) test(`Codex malformed list ${JSON.stringify(response)} cannot be cached as ready`, async () => {
  const { codex } = fixture();
  (codex as any).ensureStarted = async () => {};
  (codex as any).request = async () => response;
  await assert.rejects(codex.refreshSessions({ maxAgeMs: 60_000 }), /Invalid Codex session list/);
  let retries = 0;
  (codex as any).request = async () => { retries++; return { data: [], nextCursor: null }; };
  await codex.refreshSessions({ maxAgeMs: 60_000 });
  assert.equal(retries, 1);
});

test('Codex session listing rejects a repeated pagination cursor and can retry', async () => {
  const { codex } = fixture();
  (codex as any).ensureStarted = async () => {};
  let reads = 0;
  (codex as any).request = async () => {
    if (++reads > 3) throw new Error('test pagination safety bound');
    return { data: [], nextCursor: 'same' };
  };
  await assert.rejects(codex.refreshSessions(), /Invalid Codex session list/);
  assert.equal(reads, 2);
  (codex as any).request = async () => ({ data: [], nextCursor: null });
  await codex.refreshSessions({ maxAgeMs: 60_000 });
});

test('Codex obsolete thread reads do not populate the success cache', async () => {
  const { codex, sessionKey } = fixture();
  (codex as any).connectionId = 'old-connection';
  (codex as any).ensureStarted = async () => {};
  let reads = 0;
  (codex as any).request = async () => {
    reads++;
    (codex as any).connectionId = 'new-connection';
    return { thread: { id: 'thread-1', turns: [] } };
  };
  await assert.rejects(codex.refreshSession(sessionKey), /snapshot obsolete/);
  await codex.refreshSession(sessionKey, { maxAgeMs: 60_000 });
  assert.equal(reads, 2);
});

for (const kind of ['list', 'thread-success', 'thread-failure'] as const) test(`Codex connection replacement invalidates ${kind} cache`, async () => {
  const { codex, sessionKey } = fixture();
  const runtime = codex as any;
  runtime.ensureStarted = async () => {};
  runtime.setConnection('old');
  let reads = 0;
  runtime.request = async () => {
    reads++;
    if (kind === 'thread-failure' && reads === 1) throw new Error('old read outage');
    return kind === 'list' ? { data: [], nextCursor: null } : { thread: { id: 'thread-1', turns: [] } };
  };
  const refresh = () => kind === 'list' ? codex.refreshSessions({ maxAgeMs: 60_000 }) : codex.refreshSession(sessionKey, { maxAgeMs: 60_000 });
  if (kind === 'thread-failure') await assert.rejects(refresh()); else await refresh();
  runtime.setConnection('new');
  await refresh();
  assert.equal(reads, 2, 'no success or failure from the old native connection certifies the replacement');
});

test('Codex list refuses connection replacement before metadata publication', async () => {
  const { codex, store } = fixture();
  const runtime = codex as any;
  runtime.ensureStarted = async () => {};
  runtime.setConnection('old');
  let lists = 0;
  const oldThread = { id: 'retired-thread', name: 'Old metadata' };
  runtime.request = async (method: string) => {
    if (method === 'thread/list') {
      lists++;
      runtime.setConnection('new');
      return { data: [oldThread], nextCursor: null };
    }
    assert.fail('listing never reads histories');
  };
  await assert.rejects(codex.refreshSessions(), /connection changed/);
  assert.equal(store.getSession('codex:retired-thread'), undefined, 'late metadata is not projected');
  runtime.request = async (method: string) => { assert.equal(method, 'thread/list'); lists++; return { data: [], nextCursor: null }; };
  await codex.refreshSessions({ maxAgeMs: 60_000 });
  assert.equal(lists, 2, 'retired read never restores the success cache');
});

test('Codex late failed thread read cannot install a cooldown on a replacement connection', async () => {
  const { codex, sessionKey } = fixture();
  const runtime = codex as any;
  runtime.ensureStarted = async () => {};
  runtime.setConnection('old');
  runtime.request = async () => { runtime.setConnection('new'); throw new Error('old read failed late'); };
  await assert.rejects(codex.refreshSession(sessionKey), /failed late/);
  let reads = 0;
  runtime.request = async () => { reads++; return { thread: { id: 'thread-1', turns: [] } }; };
  await codex.refreshSession(sessionKey, { maxAgeMs: 60_000 });
  assert.equal(reads, 1);
});

test('Codex connection replacement after synchronous projection cannot repopulate the success cache', async () => {
  const { codex, store, sessionKey } = fixture(), runtime = codex as any;
  runtime.ensureStarted = async () => {};
  runtime.setConnection('old');
  let reads = 0;
  runtime.request = async () => { reads++; return { thread: { id: 'thread-1', turns: [] } }; };
  const replace = store.replaceMessages.bind(store);
  store.replaceMessages = (...args) => { replace(...args); queueMicrotask(() => runtime.setConnection('new')); };
  await assert.rejects(codex.refreshSession(sessionKey), /snapshot obsolete/);
  store.replaceMessages = replace;
  await codex.refreshSession(sessionKey, { maxAgeMs: 60_000 });
  assert.equal(reads, 2);
});

test('Codex message refresh reads only the requested thread', async () => {
  const { store } = fixture();
  const sessionKey = 'codex:thread-target';
  store.upsertSession({ sessionKey, agentId: 'codex', title: 'Target', status: 'idle', source: 'codex' });
  const instance = new CodexAppServer({ authorizeTurn: () => true, ...memoryPersistence(store), enabled: true, command: 'codex', defaultCwd: 'C:\\workspace', defaultModel: 'gpt-5.6-sol', approvalPolicy: 'never', store });
  const requests: Array<{ method: string; params: any }> = [];
  (instance as any).connectionId = "synthetic-connection";
  (instance as any).ensureStarted = async () => undefined;
  (instance as any).request = async (method: string, params: any) => {
    requests.push({ method, params });
    return { thread: { id: params.threadId, turns: [{ id: 'turn-target', items: [{ type: 'agentMessage', id: 'reply', text: 'Target reply' }] }] } };
  };

  await instance.refreshSession(sessionKey, { maxAgeMs: 1_500 });
  await instance.refreshSession(sessionKey, { maxAgeMs: 1_500 });

  assert.deepEqual(requests, [{ method: 'thread/read', params: { threadId: 'thread-target', includeTurns: true } }]);
  assert.equal(store.getMessages(sessionKey).at(-1)?.text, 'Target reply');
});

test('Codex message refresh synchronizes the real turn lifecycle', async () => {
  const { store } = fixture();
  const sessionKey = 'codex:thread-lifecycle';
  store.upsertSession({ sessionKey, agentId: 'codex', title: 'Lifecycle', status: 'idle', hasActiveRun: false, source: 'codex' });
  const instance = new CodexAppServer({ authorizeTurn: () => true, ...memoryPersistence(store), enabled: true, command: 'codex', defaultCwd: 'C:\\workspace', defaultModel: 'gpt-5.6-sol', approvalPolicy: 'never', store });
  (instance as any).connectionId = "synthetic-connection";
  (instance as any).ensureStarted = async () => undefined;
  let turnStatus = 'inProgress';
  (instance as any).request = async (method: string) => method === 'thread/backgroundTerminals/list' ? { data: [] } : ({ thread: { id: 'thread-lifecycle', status: { type: turnStatus === 'inProgress' ? 'active' : 'idle' }, turns: [{ id: 'turn-live', status: turnStatus, items: [] }] } });

  await instance.refreshSession(sessionKey);
  assert.equal(store.getSession(sessionKey)?.status, 'running');
  assert.equal(store.getSession(sessionKey)?.hasActiveRun, true);

  turnStatus = 'completed';
  await instance.refreshSession(sessionKey);
  assert.equal(store.getSession(sessionKey)?.runtime?.phase, 'finalizing');
  await (instance as any).completingTurns.get(sessionKey);
  assert.equal(store.getSession(sessionKey)?.status, 'idle');
  assert.equal(store.getSession(sessionKey)?.hasActiveRun, false);
  assert.ok(store.getSession(sessionKey)?.runCompletedAt);
});

test('Codex refresh augments App Server history with custom tools from the rollout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-codex-rollout-'));
  try {
    const rolloutPath = join(dir, 'rollout.jsonl');
    const rollout = [
      { timestamp: '2026-08-15T06:13:35.345Z', type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'call-complete', name: 'exec', input: '{"cmd":"const r = await tools.exec_command({cmd: \'git status\'}); text(r.output);"}', status: 'completed' } },
      { timestamp: '2026-08-15T06:13:36.117Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call-complete', output: [{ type: 'input_text', text: 'clean\n' }] } },
      { timestamp: '2026-08-15T06:13:37.000Z', type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'call-interrupted', name: 'exec', input: 'const results = await Promise.all([tools.view_image({path: "a.png"}), tools.exec_command({cmd: "pnpm test"})]);', status: 'completed' } },
    ].map((entry) => JSON.stringify(entry)).join('\n');
    writeFileSync(rolloutPath, rollout);
    const { store, sessionKey } = fixture();
    const instance = new CodexAppServer({ authorizeTurn: () => true, ...memoryPersistence(store), enabled: true, command: 'codex', defaultCwd: 'C:\\workspace', defaultModel: 'gpt-5.6-sol', approvalPolicy: 'never', store });
    (instance as any).connectionId = "synthetic-connection";
    (instance as any).ensureStarted = async () => undefined;
    (instance as any).request = async (method: string) => method === 'thread/backgroundTerminals/list' ? { data: [] } : ({ thread: { id: 'thread-1', path: rolloutPath, turns: [{ id: 'turn-1', startedAt: 1, items: [{ type: 'fileChange', id: 'patch-1', status: 'completed', changes: [] }] }] } });

    await instance.refreshSession(sessionKey);

    const tools = store.getMessages(sessionKey).filter((message) => message.role === 'tool');
    assert.deepEqual(tools.map((message) => [message.toolName, message.toolCallId, message.toolPhase]), [
      ['fileChange', 'patch-1', 'call'],
      ['fileChange', 'patch-1', 'result'],
      ['exec_command', 'call-complete', 'call'],
      ['exec_command', 'call-complete', 'result'],
      ['view_image + exec_command', 'call-interrupted', 'call'],
    ]);
    assert.match(tools[2]?.text ?? '', /tools\.exec_command/);
    assert.match(tools[3]?.text ?? '', /clean/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Codex refresh restores function tools with arguments, outputs and pending calls', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-codex-function-tools-'));
  try {
    const rolloutPath = join(dir, 'rollout.jsonl');
    writeFileSync(rolloutPath, [
      { type: 'turn_context', payload: { turn_id: 'turn-1' } },
      { timestamp: '2026-09-09T11:00:01Z', type: 'response_item', payload: { type: 'function_call', id: 'function-1', call_id: 'call-1', name: 'exec_command', arguments: '{"cmd":"git status"}' } },
      { timestamp: '2026-09-09T11:00:02Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-1', output: 'clean\n' } },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-2' } },
      { timestamp: '2026-09-09T11:00:03Z', type: 'response_item', payload: { type: 'function_call', call_id: 'call-2', name: 'write_stdin', arguments: '{"session_id":123}' } },
      { timestamp: '2026-09-09T11:00:04Z', type: 'response_item', payload: { type: 'function_call', call_id: 'call-3', name: 'exec_command', arguments: '{incomplete' } },
    ].map((entry) => JSON.stringify(entry)).join('\n'));
    const { store, codex, sessionKey } = fixture();
    (codex as any).connectionId = "synthetic-connection";
    (codex as any).ensureStarted = async () => undefined;
    (codex as any).request = async (method: string) => method === 'thread/backgroundTerminals/list' ? { data: [] } : ({ thread: { id: 'thread-1', path: rolloutPath, turns: [{ id: 'turn-2', status: 'inProgress', items: [] }] } });

    await codex.refreshSession(sessionKey);

    const tools = store.getMessages(sessionKey).filter((message) => message.role === 'tool');
    assert.deepEqual(tools.map((message) => [message.toolName, message.toolCallId, message.toolPhase, message.status, message.turnId]), [
      ['exec_command', 'call-1', 'call', 'sent', 'turn-1'],
      ['exec_command', 'call-1', 'result', 'sent', 'turn-1'],
      ['write_stdin', 'call-2', 'call', 'sending', 'turn-2'],
      ['exec_command', 'call-3', 'call', 'sending', 'turn-2'],
    ]);
    assert.match(tools[0]?.text ?? '', /"cmd": "git status"/);
    assert.match(tools[1]?.text ?? '', /clean/);
    assert.match(tools[2]?.text ?? '', /"session_id": 123/);
    assert.match(tools[3]?.text ?? '', /\{incomplete/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Codex rollout function tools do not duplicate native tools and retain their real timestamps', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-codex-native-tools-'));
  try {
    const rolloutPath = join(dir, 'rollout.jsonl');
    writeFileSync(rolloutPath, [
      { type: 'turn_context', payload: { turn_id: 'turn-1' } },
      { timestamp: '2026-09-09T11:00:01Z', type: 'response_item', payload: { type: 'function_call', id: 'function-1', call_id: 'call-1', name: 'exec_command', arguments: '{"cmd":"git status"}' } },
      { timestamp: '2026-09-09T11:00:02Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-1', output: 'clean' } },
    ].map((entry) => JSON.stringify(entry)).join('\n'));
    const { store, codex, sessionKey } = fixture();
    (codex as any).connectionId = "synthetic-connection";
    (codex as any).ensureStarted = async () => undefined;
    (codex as any).request = async (method: string) => method === 'thread/backgroundTerminals/list' ? { data: [] } : ({ thread: { id: 'thread-1', path: rolloutPath, turns: [{ id: 'turn-1', status: 'completed', items: [
      { type: 'commandExecution', id: 'call-1', command: 'git status', aggregatedOutput: 'clean', status: 'completed', exitCode: 0 },
    ] }] } });

    await codex.refreshSession(sessionKey);

    const tools = store.getMessages(sessionKey).filter((message) => message.role === 'tool');
    assert.equal(tools.length, 2);
    assert.equal(tools[0]?.toolName, 'commandExecution');
    assert.equal(tools[0]?.createdAt, Date.parse('2026-09-09T11:00:01Z'));
    assert.match(tools[1]?.text ?? '', /clean/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Codex completion keeps function tool history before the final response', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-codex-final-tools-'));
  try {
    const rolloutPath = join(dir, 'rollout.jsonl');
    writeFileSync(rolloutPath, [
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
      { timestamp: '2026-09-09T11:00:01Z', type: 'response_item', payload: { type: 'function_call', call_id: 'call-1', name: 'exec_command', arguments: '{"cmd":"git status"}' } },
      { timestamp: '2026-09-09T11:00:02Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-1', output: [{ type: 'input_text', text: 'clean' }] } },
      { timestamp: '2026-09-09T11:00:03Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done' }] } },
    ].map((entry) => JSON.stringify(entry)).join('\n'));
    const { store, codex, sessionKey, threadId, notify } = fixture();
    (codex as any).request = async (method: string) => method === 'thread/backgroundTerminals/list' ? { data: [] } : ({ thread: { id: 'thread-1', path: rolloutPath, turns: [{ id: 'turn-1', status: 'completed', items: [
      { type: 'agentMessage', id: 'final', text: 'Done', phase: 'final_answer' },
    ] }] } });
    notify('turn/started', { threadId, turn: { id: 'turn-1' } });
    store.addMessage({ id: `${sessionKey}:codex-tool-call-1-call`, sessionKey, turnId: 'turn-1', role: 'tool', toolCallId: 'call-1', toolPhase: 'call', text: 'Running', status: 'sending', createdAt: Date.parse('2026-09-09T11:00:01Z') });

    notify('turn/completed', { threadId, turn: { id: 'turn-1', status: 'completed' } });
    await (codex as any).completingTurns.get(sessionKey);

    const messages = store.getMessages(sessionKey);
    assert.deepEqual(messages.map((message) => [message.role, message.toolPhase]), [['tool', 'call'], ['tool', 'result'], ['assistant', undefined]]);
    assert.match(messages[1]?.text ?? '', /clean/);
    assert.equal(store.getSession(sessionKey)?.status, 'idle');
    assert.equal(store.getSession(sessionKey)?.runtime?.sync, 'current');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Codex history interleaves rollout tools with assistant messages by real item time', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-codex-order-'));
  try {
    const rolloutPath = join(dir, 'rollout.jsonl');
    writeFileSync(rolloutPath, [
      { timestamp: '2026-08-15T09:00:01.000Z', type: 'response_item', payload: { type: 'message', id: 'assistant-before' } },
      { timestamp: '2026-08-15T09:00:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'call-1', name: 'exec', input: '{}' } },
      { timestamp: '2026-08-15T09:00:03.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call-1', output: 'ok' } },
      { timestamp: '2026-08-15T09:00:04.000Z', type: 'response_item', payload: { type: 'message', id: 'assistant-after' } },
    ].map((entry) => JSON.stringify(entry)).join('\n'));
    const { store, sessionKey } = fixture();
    const instance = new CodexAppServer({ authorizeTurn: () => true, ...memoryPersistence(store), enabled: true, command: 'codex', defaultCwd: 'C:\\workspace', defaultModel: 'gpt-5.6-sol', approvalPolicy: 'never', store });
    (instance as any).connectionId = "synthetic-connection";
    (instance as any).ensureStarted = async () => undefined;
    (instance as any).request = async (method: string) => method === 'thread/backgroundTerminals/list' ? { data: [] } : ({ thread: { id: 'thread-1', path: rolloutPath, turns: [{ id: 'turn-1', startedAt: '2026-08-15T09:00:00.000Z', status: 'completed', items: [
      { type: 'agentMessage', id: 'assistant-before', text: 'Before tool' },
      { type: 'agentMessage', id: 'assistant-after', text: 'Final response' },
    ] }] } });

    await instance.refreshSession(sessionKey);

    assert.deepEqual(store.getMessages(sessionKey).map((message) => [message.role, message.text.includes('Final response') ? 'final' : message.toolPhase ?? 'message']), [
      ['assistant', 'message'],
      ['tool', 'call'],
      ['tool', 'result'],
      ['assistant', 'final'],
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Codex history preserves tool order when thread and rollout assistant ids differ', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-codex-order-mismatched-ids-'));
  try {
    const rolloutPath = join(dir, 'rollout.jsonl');
    writeFileSync(rolloutPath, [
      { timestamp: '2026-08-15T09:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'rollout-before', content: [{ type: 'output_text', text: 'Before tool' }] } },
      { timestamp: '2026-08-15T09:00:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'call-1', name: 'exec', input: '{}' } },
      { timestamp: '2026-08-15T09:00:03.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call-1', output: 'ok' } },
      { timestamp: '2026-08-15T09:00:04.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'rollout-final', content: [{ type: 'output_text', text: 'Final response' }] } },
    ].map((entry) => JSON.stringify(entry)).join('\n'));
    const { store, sessionKey } = fixture();
    const instance = new CodexAppServer({ authorizeTurn: () => true, ...memoryPersistence(store), enabled: true, command: 'codex', defaultCwd: 'C:\\workspace', defaultModel: 'gpt-5.6-sol', approvalPolicy: 'never', store });
    (instance as any).connectionId = "synthetic-connection";
    (instance as any).ensureStarted = async () => undefined;
    (instance as any).request = async (method: string) => method === 'thread/backgroundTerminals/list' ? { data: [] } : ({ thread: { id: 'thread-1', path: rolloutPath, turns: [{ id: 'turn-1', startedAt: '2026-08-15T09:00:00.000Z', status: 'completed', items: [
      { type: 'agentMessage', id: 'thread-before', text: 'Before tool' },
      { type: 'agentMessage', id: 'thread-final', text: 'Final response' },
    ] }] } });

    await instance.refreshSession(sessionKey);

    assert.deepEqual(store.getMessages(sessionKey).map((message) => [message.role, message.text.includes('Final response') ? 'final' : message.toolPhase ?? 'message']), [
      ['assistant', 'message'],
      ['tool', 'call'],
      ['tool', 'result'],
      ['assistant', 'final'],
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Codex completion stays running until the authoritative final timeline is reconciled', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-codex-completion-'));
  try {
    const rolloutPath = join(dir, 'rollout.jsonl');
    writeFileSync(rolloutPath, [
      { timestamp: '2026-08-15T12:00:01.000Z', type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'call-last', name: 'exec', input: '{}' } },
      { timestamp: '2026-08-15T12:00:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call-last', output: 'ok' } },
      { timestamp: '2026-08-15T12:00:03.000Z', type: 'response_item', payload: { type: 'message', id: 'assistant-final' } },
    ].map((entry) => JSON.stringify(entry)).join('\n'));
    const { store, threadId, sessionKey } = fixture();
    const instance = new CodexAppServer({ authorizeTurn: () => true, ...memoryPersistence(store), enabled: true, command: 'codex', defaultCwd: 'C:\\workspace', defaultModel: 'gpt-5.6-sol', approvalPolicy: 'never', store });
    (instance as any).request = async (method: string) => method === 'thread/backgroundTerminals/list' ? { data: [] } : ({ thread: { id: threadId, path: rolloutPath, turns: [{ id: 'turn-final', status: 'completed', items: [
      { type: 'agentMessage', id: 'assistant-final', text: 'Actual final response' },
    ] }] } });

    (instance as any).handleNotification('turn/completed', { threadId, turn: { id: 'turn-final', status: 'completed' } });
    assert.equal(store.getSession(sessionKey)?.status, 'running');
    await (instance as any).completingTurns.get(sessionKey);

    assert.equal(store.getSession(sessionKey)?.status, 'idle');
    assert.deepEqual(store.getMessages(sessionKey).map((message) => [message.role, message.toolPhase ?? message.text]), [
      ['tool', 'call'],
      ['tool', 'result'],
      ['assistant', 'Actual final response'],
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Codex assistant deltas preserve whitespace between streamed chunks', () => {
  const { store, threadId, sessionKey, notify } = fixture();
  for (const delta of ['Hello', ' ', 'world', '\n\n', '- ready', '\n']) {
    notify('item/agentMessage/delta', { threadId, turnId: 'turn-final', itemId: 'stream-id', delta });
  }
  assert.equal(store.getMessages(sessionKey)[0]?.text, 'Hello world\n\n- ready\n');
});

test('Codex terminal history retires empty search starts with different encrypted IDs', async () => {
  const { store, codex, threadId, sessionKey, notify } = fixture();
  notify('turn/started', { threadId, turn: { id: 'turn-search' } });
  for (const id of ['encrypted-start-one', 'encrypted-start-two']) notify('item/started', { threadId, turnId: 'turn-search', item: { id, type: 'webSearch', query: '', action: { type: 'other' }, results: null } });
  const completedAt = 1_788_955_886;
  (codex as any).request = async (method: string) => method === 'thread/backgroundTerminals/list' ? { data: [] } : ({ thread: { id: threadId, turns: [{ id: 'turn-search', status: 'completed', itemsView: 'full', completedAt, items: [
    ...['search', 'openPage'].map((type, index) => ({ id: `canonical-${index}`, type: 'webSearch', query: 'query', action: { type }, results: [] })),
    { id: 'final', type: 'agentMessage', text: 'Already finished', phase: 'final_answer' },
  ] }] } });
  notify('turn/completed', { threadId, turn: { id: 'turn-search', status: 'completed' } });
  await (codex as any).completingTurns.get(sessionKey);
  assert.equal(store.getSession(sessionKey)?.runtime?.sync, 'current');
  assert.equal(store.getSession(sessionKey)?.status, 'idle');
  assert.equal(store.getSession(sessionKey)?.runCompletedAt, completedAt * 1_000);
  assert.equal(store.getMessages(sessionKey).filter(message => message.status === 'sending').length, 0);
  assert.equal(store.getMessages(sessionKey).filter(message => message.toolPhase === 'call').length, 2);
  assert.equal(store.getActivity(sessionKey).filter(activity => activity.status === 'running').length, 0);
});

test('Codex terminal search reconciliation does not discard real unmatched input or partial coverage', async () => {
  for (const scenario of ['real-input', 'too-few', 'other-turn'] as const) {
    const { store, codex, threadId, sessionKey, notify } = fixture();
    notify('turn/started', { threadId, turn: { id: 'turn-search' } });
    for (const id of scenario === 'too-few' ? ['one', 'two'] : ['one']) notify('item/started', { threadId, turnId: 'turn-search', item: { id, type: 'webSearch', query: scenario === 'real-input' ? 'unmatched important query' : '', action: { type: 'other' }, results: null } });
    const item = { id: 'canonical', type: 'webSearch', query: 'completed query', action: { type: 'search' }, results: [] };
    (codex as any).request = async (method: string) => method === 'thread/backgroundTerminals/list' ? { data: [] } : ({ thread: { id: threadId, turns: [
      { id: 'old-turn', status: 'completed', items: scenario === 'other-turn' ? [item] : [] },
      { id: 'turn-search', status: 'completed', itemsView: 'full', items: scenario === 'other-turn' ? [] : [item] },
    ] } });
    notify('turn/completed', { threadId, turn: { id: 'turn-search', status: 'completed' } });
    await (codex as any).completingTurns.get(sessionKey);
    assert.equal(store.getSession(sessionKey)?.runtime?.sync, 'error', scenario);
    assert.ok(store.getMessages(sessionKey).some(message => message.status === 'sending'), scenario);
  }
});

for (const delta of [undefined, '', ' \n\t']) {
  test(`Codex empty commentary does not block final history (${JSON.stringify(delta)})`, async context => {
    const { store, codex, threadId, sessionKey, notify } = fixture();
    context.after(() => codex.close());
    const turnId = 'empty-commentary';
    notify('turn/started', { threadId, turn: { id: turnId } });
    if (delta !== undefined) notify('item/agentMessage/delta', { threadId, turnId, itemId: 'empty', delta });
    if (delta === '') assert.equal(store.getMessages(sessionKey).length, 0);
    const empty = { type: 'agentMessage', id: 'empty', text: delta ?? '', phase: 'commentary' };
    const reply = { type: 'agentMessage', id: 'reply', text: 'Final response', phase: 'final_answer' };
    notify('item/completed', { threadId, turnId, item: empty });
    notify('item/completed', { threadId, turnId, item: reply });
    const turn = { id: turnId, status: 'completed', items: [empty, reply] };
    (codex as any).request = async (method: string) => method === 'thread/backgroundTerminals/list' ? { data: [] } : ({ thread: { id: threadId, turns: [turn] } });
    notify('turn/completed', { threadId, turn });
    await (codex as any).completingTurns.get(sessionKey);
    assert.equal(store.getSession(sessionKey)?.runtime?.sync, 'current');
    assert.deepEqual(store.getMessages(sessionKey).map(message => message.text), ['Final response']);
    notify('item/agentMessage/delta', { threadId, turnId, itemId: 'empty', delta: 'late' });
    assert.equal(store.getMessages(sessionKey).length, 1);
  });
}

test('Codex empty completion retains actual streamed content', async context => {
  const { store, codex, threadId, sessionKey, notify } = fixture();
  context.after(() => codex.close());
  notify('turn/started', { threadId, turn: { id: 'streamed' } });
  notify('item/agentMessage/delta', { threadId, turnId: 'streamed', itemId: 'reply', delta: 'Actual response' });
  notify('item/completed', { threadId, turnId: 'streamed', item: { type: 'agentMessage', id: 'reply', text: '' } });
  await Promise.all((codex as any).assistantProjections.get(sessionKey));
  assert.deepEqual(store.getMessages(sessionKey).map(message => message.text), ['Actual response']);
});

test('Codex final sync retires a legacy blank alias but never ignores a missing media-only reply', async context => {
  const { store, codex, threadId, sessionKey, notify } = fixture();
  context.after(() => codex.close());
  const turnId = 'legacy-empty';
  notify('turn/started', { threadId, turn: { id: turnId } });
  store.addMessage({ id: 'old-blank-alias', sessionKey, turnId, role: 'assistant', text: ' \n', status: 'sent', createdAt: 1 });
  const turn = { id: turnId, status: 'completed', items: [] };
  (codex as any).request = async (method: string) => method === 'thread/backgroundTerminals/list' ? { data: [] } : ({ thread: { id: threadId, turns: [turn] } });
  notify('turn/completed', { threadId, turn });
  await (codex as any).completingTurns.get(sessionKey);
  assert.equal(store.getSession(sessionKey)?.runtime?.sync, 'current');
  assert.equal(store.getMessages(sessionKey).length, 0);

  const nextTurn = { id: 'media-only', status: 'completed', items: [] };
  notify('turn/started', { threadId, turn: { id: nextTurn.id } });
  store.addMessage({ id: 'attachment', sessionKey, turnId: nextTurn.id, role: 'assistant', text: '', status: 'sent', createdAt: 2,
    media: [{ type: 'image', url: '/synthetic/image.png', name: 'image.png' }] });
  (codex as any).request = async (method: string) => method === 'thread/backgroundTerminals/list' ? { data: [] } : ({ thread: { id: threadId, turns: [nextTurn] } });
  notify('turn/completed', { threadId, turn: nextTurn });
  await (codex as any).completingTurns.get(sessionKey);
  assert.equal(store.getSession(sessionKey)?.runtime?.sync, 'error');
  assert.equal(store.getMessages(sessionKey)[0]?.media?.length, 1);
});

test('Codex retry uses the original completion timestamp even if final history is incomplete', async () => {
  const { store, codex, threadId, sessionKey, notify } = fixture();
  const completedAt = 1_788_955_886;
  notify('turn/started', { threadId, turn: { id: 'turn-search' } });
  notify('item/agentMessage/delta', { threadId, turnId: 'turn-search', itemId: 'missing', delta: 'Important reply' });
  const turn = { id: 'turn-search', status: 'completed', completedAt, items: [] };
  (codex as any).request = async (method: string) => method === 'thread/backgroundTerminals/list' ? { data: [] } : ({ thread: { id: threadId, turns: [turn] } });
  notify('turn/completed', { threadId, turn });
  await (codex as any).completingTurns.get(sessionKey);
  assert.equal(store.getSession(sessionKey)?.runCompletedAt, completedAt * 1_000);
  notify('turn/completed', { threadId, turn: { id: turn.id, status: 'completed' } });
  await (codex as any).completingTurns.get(sessionKey);
  assert.equal(store.getSession(sessionKey)?.runCompletedAt, completedAt * 1_000);
  assert.match(store.getSession(sessionKey)?.runtime?.reason ?? '', /missing 1 assistant items/);
});

test('Codex item completion replaces its delta alias before the turn ends and rejects late deltas', async () => {
  const { store, codex, threadId, sessionKey, notify } = fixture();
  notify('item/agentMessage/delta', { threadId, turnId: 'turn-final', itemId: 'opaque-id', delta: 'Hello world\n\n- ready' });
  const startedAt = store.getMessages(sessionKey)[0]!.createdAt;
  notify('item/completed', { threadId, turnId: 'turn-final', item: { type: 'agentMessage', id: 'item-280', text: 'Hello world\n\n- ready', phase: 'final_answer' } });
  await Promise.all((codex as any).assistantProjections.get(sessionKey));

  assert.equal(store.getMessages(sessionKey).length, 1);
  assert.equal(store.getMessages(sessionKey)[0]?.id, `${sessionKey}:codex-item-280`);
  assert.equal(store.getMessages(sessionKey)[0]?.createdAt, startedAt);
  assert.equal(store.getMessages(sessionKey)[0]?.status, 'sent');
  for (const itemId of ['opaque-id', 'item-280']) {
    notify('item/agentMessage/delta', { threadId, turnId: 'turn-final', itemId, delta: 'late duplicate' });
  }
  assert.deepEqual(store.getMessages(sessionKey).map((message) => message.text), ['Hello world\n\n- ready']);
});

test('Codex item completion absorbs a unique unfinished stream suffix and rejects its late deltas', async context => {
  const { store, codex, threadId, sessionKey, notify } = fixture();
  context.after(() => codex.close());
  notify('item/agentMessage/delta', { threadId, turnId: 'turn-final', itemId: 'opaque-tail', delta: '原始记录完整保留。\n' });
  notify('item/completed', { threadId, turnId: 'turn-final', item: {
    type: 'agentMessage', id: 'item-final', phase: 'commentary', text: '已整理笔记，原始记录完整保留。',
  } });
  await Promise.all((codex as any).assistantProjections.get(sessionKey));
  assert.deepEqual(store.getMessages(sessionKey).map(message => message.id), [`${sessionKey}:codex-item-final`]);
  notify('item/agentMessage/delta', { threadId, turnId: 'turn-final', itemId: 'opaque-tail', delta: 'late' });
  assert.deepEqual(store.getMessages(sessionKey).map(message => message.text), ['已整理笔记，原始记录完整保留。']);
});

test('Codex final reconciliation absorbs a legacy suffix already covered by its completed commentary', async context => {
  const { store, codex, threadId, sessionKey, notify } = fixture();
  context.after(() => codex.close());
  store.addMessage({ id: 'legacy-tail', sessionKey, turnId: 'turn-final', role: 'assistant', text: '原始记录完整保留。\n', createdAt: 1 });
  store.addMessage({ id: `${sessionKey}:codex-item-note`, sessionKey, turnId: 'turn-final', role: 'assistant', phase: 'commentary', status: 'sent', text: '已整理笔记，原始记录完整保留。', createdAt: 2 });
  (codex as any).request = async (method: string) => method === 'thread/backgroundTerminals/list' ? { data: [] } : ({ thread: { id: threadId, turns: [
    { id: 'turn-final', status: 'completed', items: [
      { type: 'agentMessage', id: 'item-note', phase: 'commentary', text: '已整理笔记，原始记录完整保留。' },
      { type: 'agentMessage', id: 'item-final', phase: 'final_answer', text: 'Done' },
    ] },
  ] } });
  notify('turn/completed', { threadId, turn: { id: 'turn-final', status: 'completed' } });
  await (codex as any).completingTurns.get(sessionKey);
  assert.equal(store.getSession(sessionKey)?.runtime?.sync, 'current');
  assert.deepEqual(store.getMessages(sessionKey).map(message => message.text), ['已整理笔记，原始记录完整保留。', 'Done']);
});

test('Codex suffix recovery never collapses ambiguous drafts and still fences missing completed, scoped or substantive evidence', async context => {
  for (const kind of ['two-snapshots', 'two-drafts', 'completed', 'phased', 'sending', 'media', 'other-turn', 'distinct', 'interior'] as const) {
    await context.test(kind, async t => {
      const { store, codex, threadId, sessionKey, notify } = fixture();
      t.after(() => codex.close());
      const draft = { id: 'legacy-tail', sessionKey, turnId: 'turn-final', role: 'assistant' as const, text: kind === 'distinct' ? 'missing content' : 'retained.', createdAt: 1,
        ...(kind === 'completed' ? { status: 'sent' as const, phase: 'commentary' as const } : {}),
        ...(kind === 'phased' ? { phase: 'commentary' as const } : {}),
        ...(kind === 'sending' ? { status: 'sending' as const } : {}),
        ...(kind === 'media' ? { media: [{ type: 'file' as const, name: 'evidence.txt', url: '/evidence.txt' }] } : {}) };
      store.addMessage(draft);
      if (kind === 'two-drafts') store.addMessage({ ...draft, id: 'other-tail' });
      const items = [{ type: 'agentMessage', id: 'item-one', phase: 'commentary', text: kind === 'interior' ? 'Data retained. More follows.' : 'Original data retained.' }];
      if (kind === 'two-snapshots') items.push({ type: 'agentMessage', id: 'item-two', phase: 'commentary', text: 'Backup retained.' });
      (codex as any).request = async (method: string) => method === 'thread/backgroundTerminals/list' ? { data: [] } : ({ thread: { id: threadId, turns: [
        ...(kind === 'other-turn' ? [{ id: 'turn-old', status: 'completed', items }] : []),
        { id: 'turn-final', status: 'completed', items: kind === 'other-turn' ? [] : items },
      ] } });
      notify('turn/completed', { threadId, turn: { id: 'turn-final', status: 'completed' } });
      await (codex as any).completingTurns.get(sessionKey);
      const retained = store.getMessages(sessionKey).find(message => message.id === draft.id);
      assert.ok(retained);
      if (['two-snapshots', 'two-drafts', 'distinct', 'interior'].includes(kind)) {
        assert.equal(store.getSession(sessionKey)?.runtime?.sync, 'current');
        assert.equal(retained.status, 'failed', 'ambiguous drafts remain distinct partial text, not native reply aliases');
        assert.equal(retained.text, draft.text);
        if (kind === 'two-drafts') assert.equal(store.getMessages(sessionKey).find(message => message.id === 'other-tail')?.status, 'failed');
      } else assert.equal(store.getSession(sessionKey)?.runtime?.sync, 'error');
    });
  }
});

test('Codex suffix alias completion is repeatable and preserves the completed attachment', async context => {
  const { store, codex, threadId, sessionKey, notify } = fixture();
  context.after(() => codex.close());
  const raw = 'Report saved: [report](/tmp/report.txt)';
  const media = [{ type: 'file' as const, name: 'report.txt', url: '/report.txt' }];
  (codex as any).options.projectAssistant = async () => ({ text: 'report attachment', media });
  notify('item/agentMessage/delta', { threadId, turnId: 'turn-final', itemId: 'opaque-tail', delta: '[report](/tmp/report.txt)' });
  for (let attempt = 0; attempt < 2; attempt++) {
    notify('item/completed', { threadId, turnId: 'turn-final', item: { type: 'agentMessage', id: 'report', text: raw, phase: 'final_answer' } });
    await Promise.all((codex as any).assistantProjections.get(sessionKey));
    notify('item/agentMessage/delta', { threadId, turnId: 'turn-final', itemId: 'opaque-tail', delta: 'late tail' });
  }
  assert.equal(store.getMessages(sessionKey).length, 1);
  assert.deepEqual(store.getMessages(sessionKey)[0]?.media, media);
  assert.equal(store.getMessages(sessionKey)[0]?.text, 'report attachment');
});

test('Codex item alias matching precedes artifact projection and preserves other turns and completed commentary', async () => {
  const { store, codex, threadId, sessionKey, notify } = fixture();
  const raw = '[report](/tmp/report.txt)';
  (codex as any).options.projectAssistant = async () => ({ text: 'report attachment', media: [] });
  store.addMessage({ id: 'old-turn', sessionKey, turnId: 'turn-old', role: 'assistant', text: raw, createdAt: 1 });
  store.addMessage({ id: 'commentary', sessionKey, turnId: 'turn-final', role: 'assistant', phase: 'commentary', text: raw, createdAt: 2 });
  store.addMessage({ id: 'user-input', sessionKey, turnId: 'turn-final', role: 'user', text: raw, createdAt: 3 });
  notify('item/agentMessage/delta', { threadId, turnId: 'turn-final', itemId: 'opaque-id', delta: raw });
  notify('item/completed', { threadId, turnId: 'turn-final', item: { type: 'agentMessage', id: 'item-280', text: raw, phase: 'final_answer' } });
  await Promise.all((codex as any).assistantProjections.get(sessionKey));

  assert.deepEqual(store.getMessages(sessionKey).map((message) => message.id), ['old-turn', 'commentary', 'user-input', `${sessionKey}:codex-item-280`]);
  assert.equal(store.getMessages(sessionKey).at(-1)?.text, 'report attachment');
});

test('Codex does not guess an item alias when multiple unfinished items match', async () => {
  const { store, codex, threadId, sessionKey, notify } = fixture();
  for (const itemId of ['opaque-one', 'opaque-two']) {
    notify('item/agentMessage/delta', { threadId, turnId: 'turn-final', itemId, delta: 'same text' });
  }
  notify('item/completed', { threadId, turnId: 'turn-final', item: { type: 'agentMessage', id: 'item-280', text: 'same text' } });
  await Promise.all((codex as any).assistantProjections.get(sessionKey));
  assert.equal(store.getMessages(sessionKey).length, 3);
});

test('Codex completion replaces a transient delta ID with the canonical final item', async () => {
  const { store, codex, threadId, sessionKey, notify } = fixture();
  notify('item/agentMessage/delta', { threadId, turnId: 'turn-final', itemId: 'stream-id', delta: 'Hello world\n\n- ready' });
  (codex as any).request = async (method: string) => method === 'thread/backgroundTerminals/list' ? { data: [] } : ({ thread: { id: threadId, turns: [{ id: 'turn-final', status: 'completed', items: [
    { type: 'agentMessage', id: 'item-280', phase: 'final_answer', text: 'Hello world\n\n- ready' },
  ] }] } });

  notify('turn/completed', { threadId, turn: { id: 'turn-final', status: 'completed' } });
  await (codex as any).completingTurns.get(sessionKey);

  assert.equal(store.getSession(sessionKey)?.status, 'idle');
  assert.equal(store.getSession(sessionKey)?.runtime?.sync, 'current');
  assert.deepEqual(store.getMessages(sessionKey).map((message) => message.id), [`${sessionKey}:codex-item-280`]);

  notify('item/agentMessage/delta', { threadId, turnId: 'turn-final', itemId: 'stream-id', delta: 'late duplicate' });
  assert.equal(store.getMessages(sessionKey).length, 1);
});

test('Codex completion recovers legacy whitespace-stripped deltas without duplicating the final reply', async () => {
  const { store, codex, threadId, sessionKey, notify } = fixture();
  store.addMessage({ id: 'legacy-stream-id', sessionKey, turnId: 'turn-final', role: 'assistant', text: 'Helloworld-ready', createdAt: 1 });
  const item = { type: 'agentMessage', id: 'item-280', phase: 'final_answer', text: 'Hello world\n\n- ready' };
  notify('item/completed', { threadId, turnId: 'turn-final', item });
  (codex as any).request = async (method: string) => method === 'thread/backgroundTerminals/list' ? { data: [] } : ({ thread: { id: threadId, turns: [{ id: 'turn-final', status: 'completed', items: [item] }] } });
  notify('turn/completed', { threadId, turn: { id: 'turn-final', status: 'completed' } });
  await (codex as any).completingTurns.get(sessionKey);

  assert.equal(store.getSession(sessionKey)?.status, 'idle');
  assert.equal(store.getSession(sessionKey)?.hasActiveRun, false);
  assert.deepEqual(store.getMessages(sessionKey).map((message) => message.text), [item.text]);
});

test('Codex completion preserves a distinct unfinished stream as failed instead of blocking a durably completed turn', async () => {
  const { store, codex, threadId, sessionKey, notify } = fixture();
  notify('item/agentMessage/delta', { threadId, turnId: 'turn-final', itemId: 'stream-id', delta: 'Important missing content' });
  (codex as any).request = async (method: string) => method === 'thread/backgroundTerminals/list' ? { data: [] } : ({ thread: { id: threadId, turns: [{ id: 'turn-final', status: 'completed', items: [
    { type: 'agentMessage', id: 'item-280', text: 'A different reply' },
  ] }] } });
  notify('turn/completed', { threadId, turn: { id: 'turn-final', status: 'completed' } });
  await (codex as any).completingTurns.get(sessionKey);

  assert.equal(store.getSession(sessionKey)?.runtime?.sync, 'current');
  assert.equal(store.getSession(sessionKey)?.status, 'idle');
  const partial = store.getMessages(sessionKey).find(message => message.text === 'Important missing content');
  assert.equal(partial?.status, 'failed');
  assert.match(partial?.failureReason ?? '', /partial text preserved, not a completed reply/);
  assert.equal(store.getMessages(sessionKey).find(message => message.text === 'A different reply')?.status, 'sent');
  const before = structuredClone(store.getMessages(sessionKey));
  notify('item/agentMessage/delta', { threadId, turnId: 'turn-final', itemId: 'stream-id', delta: 'late continuation' });
  assert.deepEqual(store.getMessages(sessionKey), before, 'late deltas cannot reopen a retired stream');
});

for (const terminalStatus of ['failed', 'interrupted'] as const) {
  test(`Codex ${terminalStatus} turn preserves unfinished stream drafts as failed without blocking history sync`, async () => {
    const { store, codex, threadId, sessionKey, notify } = fixture();
    notify('item/agentMessage/delta', { threadId, turnId: 'turn-aborted', itemId: 'stream-1', delta: 'Partial retry 1' });
    notify('item/agentMessage/delta', { threadId, turnId: 'turn-aborted', itemId: 'stream-2', delta: 'Partial retry 2' });
    const turnPayload = terminalStatus === 'failed'
      ? { id: 'turn-aborted', status: 'failed', error: { message: 'stream disconnected before completion: stream closed before response.completed' }, items: [] }
      : { id: 'turn-aborted', status: 'interrupted', items: [] };
    (codex as any).request = async (method: string) => method === 'thread/backgroundTerminals/list'
      ? { data: [] }
      : ({ thread: { id: threadId, status: { type: 'idle' }, turns: [turnPayload] } });
    notify('turn/completed', { threadId, turn: turnPayload });
    await (codex as any).completingTurns.get(sessionKey);

    assert.equal(store.getSession(sessionKey)?.runtime?.sync, 'current');
    assert.equal(store.getSession(sessionKey)?.runtime?.phase, terminalStatus);
    assert.equal(store.getSession(sessionKey)?.status, terminalStatus === 'failed' ? 'failed' : 'idle');
    assert.equal(store.getSession(sessionKey)?.hasActiveRun, false);
    for (const text of ['Partial retry 1', 'Partial retry 2']) {
      const partial = store.getMessages(sessionKey).find(message => message.text === text);
      assert.equal(partial?.status, 'failed');
      assert.match(partial?.failureReason ?? '', /partial text preserved, not a completed reply/);
    }
    if (terminalStatus === 'failed') {
      const failure = store.getMessages(sessionKey).find(message => message.id.endsWith(':codex-turn-failure-turn-aborted'));
      assert.equal(failure?.status, 'failed');
      assert.match(failure?.text ?? '', /stream disconnected before completion/);
    }
  });
}

for (const evidence of [
  { status: 'sent' as const },
  { phase: 'commentary' as const },
  { media: [{ type: 'image' as const, name: 'evidence.png', url: '/evidence.png' }] },
  { parentToolUseId: 'child-scope' },
]) test(`Codex completion keeps substantive missing assistant evidence fenced: ${Object.keys(evidence)[0]}`, async () => {
  const { store, codex, threadId, sessionKey, notify } = fixture();
  store.addMessage({ id: 'missing', sessionKey, turnId: 'turn-final', role: 'assistant', text: 'Distinct content', createdAt: 1, ...evidence });
  (codex as any).request = async (method: string) => method === 'thread/backgroundTerminals/list' ? { data: [] } : ({ thread: { id: threadId, turns: [
    { id: 'turn-final', status: 'completed', items: [{ type: 'agentMessage', id: 'item-final', text: 'Durable reply' }] },
  ] } });
  notify('turn/completed', { threadId, turn: { id: 'turn-final', status: 'completed' } });
  await (codex as any).completingTurns.get(sessionKey);
  assert.equal(store.getSession(sessionKey)?.runtime?.sync, 'error');
  assert.equal(store.getMessages(sessionKey).find(message => message.id === 'missing')?.text, 'Distinct content');
});

test('Codex unfinished stream recovery survives repeated terminal refresh without deleting or promoting partial text', async () => {
  const { store, codex, threadId, sessionKey } = fixture();
  store.upsertSession({ sessionKey, agentId: 'codex', title: 'Recovery', status: 'unknown', hasActiveRun: true, runtime: {
    turnId: 'turn-final', phase: 'completed', sync: 'error', connection: 'connected', lastEventAt: 1,
  } });
  store.addMessage({ id: 'orphan', sessionKey, turnId: 'turn-final', role: 'assistant', text: 'I will now check `/unfinished', createdAt: 1 });
  (codex as any).completedTurnIds.set(sessionKey, 'turn-final');
  (codex as any).connectionId = 'synthetic-connection';
  (codex as any).ensureStarted = async () => undefined;
  (codex as any).request = async (method: string) => method === 'thread/backgroundTerminals/list' ? { data: [] } : ({ thread: { id: threadId, status: { type: 'idle' }, turns: [
    { id: 'turn-final', status: 'completed', items: [{ type: 'agentMessage', id: 'item-final', text: 'Finished checking configuration.' }] },
  ] } });
  for (let attempt = 0; attempt < 2; attempt++) {
    (codex as any).touchProjection(sessionKey);
    await codex.refreshSession(sessionKey);
    await (codex as any).completingTurns.get(sessionKey);
    assert.equal(store.getSession(sessionKey)?.runtime?.sync, 'current');
    assert.equal(store.getSession(sessionKey)?.hasActiveRun, false);
    const partial = store.getMessages(sessionKey).filter(message => message.id === 'orphan');
    assert.equal(partial.length, 1);
    assert.equal(partial[0]?.status, 'failed');
    assert.equal(partial[0]?.text, 'I will now check `/unfinished');
  }
});

test('Codex completion cannot retire a draft without a durable reply from that same turn', async () => {
  const { store, codex, threadId, sessionKey, notify } = fixture();
  notify('item/agentMessage/delta', { threadId, turnId: 'turn-final', itemId: 'stream-id', delta: 'Unfinished' });
  (codex as any).request = async (method: string) => method === 'thread/backgroundTerminals/list' ? { data: [] } : ({ thread: { id: threadId, turns: [
    { id: 'turn-old', status: 'completed', items: [{ type: 'agentMessage', id: 'old', text: 'Earlier reply' }] },
    { id: 'turn-final', status: 'completed', items: [] },
  ] } });
  notify('turn/completed', { threadId, turn: { id: 'turn-final', status: 'completed' } });
  await (codex as any).completingTurns.get(sessionKey);
  assert.equal(store.getSession(sessionKey)?.runtime?.sync, 'error');
  assert.equal(store.getMessages(sessionKey)[0]?.status, undefined);
});

test('Codex completion cannot match a transient reply against an earlier turn', async () => {
  const { store, codex, threadId, sessionKey, notify } = fixture();
  notify('item/agentMessage/delta', { threadId, turnId: 'turn-final', itemId: 'stream-id', delta: 'Repeated reply' });
  (codex as any).request = async (method: string) => method === 'thread/backgroundTerminals/list' ? { data: [] } : ({ thread: { id: threadId, turns: [
    { id: 'turn-old', status: 'completed', items: [{ type: 'agentMessage', id: 'item-old', text: 'Repeated reply' }] },
    { id: 'turn-final', status: 'completed', items: [] },
  ] } });
  notify('turn/completed', { threadId, turn: { id: 'turn-final', status: 'completed' } });
  await (codex as any).completingTurns.get(sessionKey);

  assert.equal(store.getSession(sessionKey)?.runtime?.sync, 'error');
  assert.equal(store.getMessages(sessionKey)[0]?.text, 'Repeated reply');
});

test('Codex refresh recovers a failed final synchronization with a legacy delta alias', async () => {
  const { store, codex, threadId, sessionKey } = fixture();
  store.upsertSession({ sessionKey, agentId: 'codex', title: 'Recovery', status: 'unknown', hasActiveRun: false, runtime: {
    turnId: 'turn-final', phase: 'completed', sync: 'error', connection: 'connected', lastEventAt: 1,
  } });
  store.addMessage({ id: 'legacy-stream-id', sessionKey, turnId: 'turn-final', role: 'assistant', text: 'Finalreply', createdAt: 1 });
  (codex as any).completedTurnIds.set(sessionKey, 'turn-final');
  (codex as any).connectionId = "synthetic-connection";
  (codex as any).ensureStarted = async () => undefined;
  (codex as any).request = async (method: string) => method === 'thread/backgroundTerminals/list' ? { data: [] } : ({ thread: { id: threadId, status: { type: 'idle' }, turns: [
    { id: 'turn-final', status: 'completed', items: [{ type: 'agentMessage', id: 'item-final', phase: 'final_answer', text: 'Final reply' }] },
  ] } });
  (codex as any).touchProjection(sessionKey);

  await codex.refreshSession(sessionKey);
  await (codex as any).completingTurns.get(sessionKey);

  assert.equal(store.getSession(sessionKey)?.runtime?.sync, 'current');
  assert.equal(store.getSession(sessionKey)?.status, 'idle');
  assert.deepEqual(store.getMessages(sessionKey).map((message) => message.text), ['Final reply']);
});

test('Codex completion does not collapse distinct completed items that differ only by whitespace', async () => {
  const { store, codex, threadId, sessionKey, notify } = fixture();
  store.addMessage({ id: 'live-completed', sessionKey, turnId: 'turn-final', role: 'assistant', phase: 'commentary', status: 'sent', text: 'return value', createdAt: 1 });
  (codex as any).request = async (method: string) => method === 'thread/backgroundTerminals/list' ? { data: [] } : ({ thread: { id: threadId, turns: [
    { id: 'turn-final', status: 'completed', items: [{ type: 'agentMessage', id: 'item-final', phase: 'final_answer', text: 'returnvalue' }] },
  ] } });
  notify('turn/completed', { threadId, turn: { id: 'turn-final', status: 'completed' } });
  await (codex as any).completingTurns.get(sessionKey);

  assert.equal(store.getSession(sessionKey)?.runtime?.sync, 'error');
  assert.equal(store.getMessages(sessionKey)[0]?.text, 'return value');
});

test('Codex messages queue instead of interrupting an active tool run', async () => {
  const { store, sessionKey } = fixture();
  const instance = new CodexAppServer({ authorizeTurn: () => true, ...memoryPersistence(store), enabled: true, command: 'codex', defaultCwd: 'C:\\workspace', defaultModel: 'gpt-5.6-sol', approvalPolicy: 'never', store });
  (instance as any).connectionId = "synthetic-connection";
  (instance as any).ensureStarted = async () => undefined;
  (instance as any).ensureThreadLoaded = async () => undefined;
  let turnStarts = 0;
  (instance as any).request = async (method: string) => {
    if (method === 'turn/start') turnStarts += 1;
    return { turn: { id: 'unexpected' } };
  };

  const result = await instance.send(sessionKey, 'Wait until the current command finishes');

  assert.equal(result.status, 'queued');
  assert.equal(turnStarts, 0);
  assert.equal(store.getMessages(sessionKey).at(-1)?.status, 'queued');
});

test('Codex bridges long opaque tokens through a private temporary file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-codex-secret-'));
  try {
    const store = new DeckStore();
    const sessionKey = 'codex:thread-secret';
    store.upsertSession({ sessionKey, agentId: 'codex', title: 'Secret test', status: 'idle', hasActiveRun: false });
    const instance = new CodexAppServer({ authorizeTurn: () => true, ...memoryPersistence(store), enabled: true, command: 'codex', defaultCwd: dir, defaultModel: 'gpt-5.6-sol', approvalPolicy: 'never', store, queueFile: join(dir, 'queue.json') });
    (instance as any).connectionId = "synthetic-connection";
    (instance as any).ensureStarted = async () => undefined;
    (instance as any).ensureThreadLoaded = async () => undefined;
    const token = `${'AbCd0123+/'.repeat(30)}==`;
    (instance as any).threadRefreshResult.set(sessionKey, { at: Date.now(), available: true });
    let turnParams: any;
    (instance as any).request = async (method: string, params: any) => {
      assert.equal(method, 'turn/start');
      turnParams = params;
      return { turn: { id: 'turn-secret' } };
    };

    await instance.send(sessionKey, `Use this credential:\n${token}`);
    await (instance as any).drainQueuedTurn(sessionKey);

    const serialized = JSON.stringify(turnParams);
    assert.equal(serialized.includes(token), false);
    const prompt = turnParams.input[0].text as string;
    const secretPath = prompt.match(/stored at ([^\]]+)/)?.[1];
    assert.ok(secretPath);
    assert.equal(readFileSync(secretPath, 'utf8'), token);
    if (process.platform === 'win32') {
      const permissions = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', [
        "$ErrorActionPreference = 'Stop'",
        '$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
        '$acl = Get-Acl -LiteralPath (Split-Path -Parent $env:AOD_SECRET_FILE)',
        '$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))',
        '@{ protected = $acl.AreAccessRulesProtected; rules = $rules.Count; currentUserOnly = @($rules | Where-Object { $_.IdentityReference.Value -ne $identity -or $_.AccessControlType -ne "Allow" }).Count -eq 0 } | ConvertTo-Json -Compress',
      ].join('; ')], { encoding: 'utf8', env: { ...process.env, AOD_SECRET_FILE: secretPath }, windowsHide: true, timeout: 10_000 }));
      assert.deepEqual(permissions, { protected: true, rules: 1, currentUserOnly: true });
    } else {
      assert.equal(statSync(secretPath).mode & 0o777, 0o600);
    }
    assert.match(prompt, /Do not print, echo, log/);

    (instance as any).handleNotification('turn/completed', { threadId: 'thread-secret', turn: { id: 'turn-secret', status: 'failed', error: { message: 'test completion' } } });
    await (instance as any).cleanupSecretFiles('codex:thread-secret');
    assert.equal(existsSync(secretPath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Codex leaves ordinary message text unchanged', async () => {
  const store = new DeckStore();
  const sessionKey = 'codex:thread-plain';
  store.upsertSession({ sessionKey, agentId: 'codex', title: 'Plain test', status: 'idle', hasActiveRun: false });
  const instance = new CodexAppServer({ authorizeTurn: () => true, ...memoryPersistence(store), enabled: true, command: 'codex', defaultCwd: '/tmp', defaultModel: 'gpt-5.6-sol', approvalPolicy: 'never', store });
  (instance as any).connectionId = "synthetic-connection";
  (instance as any).ensureStarted = async () => undefined;
  (instance as any).ensureThreadLoaded = async () => undefined;
  let inputText = '';
  (instance as any).threadRefreshResult.set(sessionKey, { at: Date.now(), available: true });
  (instance as any).request = async (_method: string, params: any) => {
    inputText = params.input[0].text;
    return { turn: { id: 'turn-plain' } };
  };

  await instance.send(sessionKey, 'Please inspect the current project.');
  await (instance as any).drainQueuedTurn(sessionKey);
  assert.equal(inputText, 'Please inspect the current project.');
  await instance.close();
});

for (const timing of ['before-prepare', 'during-prepare', 'missing-actor']) {
  test(`Codex revocation ${timing} preserves a blocked request across restart with zero turn starts`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-codex-revocation-'));
    const tokens = new ConnectorTokenStore(join(dir, 'tokens.json'));
    const writer = tokens.create({ label: 'writer', scopes: ['messages:send'] });
    let database = new ConnectorUserStore(join(dir, 'connector.sqlite'));
    const store = new DeckStore(), sessionKey = 'codex:revoked';
    store.upsertSession({ sessionKey, agentId: 'codex', title: 'Revoked', status: 'idle' });
    const options = { enabled: true, command: 'must-not-launch', defaultCwd: dir, defaultModel: 'test', approvalPolicy: 'never' as const,
      authorizeTurn: (actorId: string | undefined) => tokens.hasScope(actorId, 'messages:send') };
    let instance = new CodexAppServer({ ...options, turnQueue: database.turns, executions: database.codexExecutions, store });
    let preparations = 0, starts = 0;
    (instance as any).connectionId = "synthetic-connection";
    (instance as any).ensureStarted = async () => { preparations++; };
    (instance as any).ensureThreadLoaded = async () => { if (timing === 'during-prepare') tokens.revoke(writer.record.id); };
    (instance as any).threadRefreshResult.set(sessionKey, { at: Date.now(), available: true });
    (instance as any).request = async () => { starts++; throw new Error('must not dispatch'); };
    try {
      const result = await instance.send(sessionKey, 'retain this message', [], { actorId: writer.record.id });
      if (timing === 'before-prepare') tokens.revoke(writer.record.id);
      if (timing === 'missing-actor') database.turns.edit<any>('codex', sessionKey, result.idempotencyKey, (payload) => {
        const { actorId: _actorId, ...legacy } = payload;
        return legacy;
      });
      await (instance as any).drainQueuedTurn(sessionKey);
      assert.equal(starts, 0);
      assert.equal(preparations, timing === 'during-prepare' ? 1 : 0);
      assert.equal(database.turns.head('codex', sessionKey)?.state, 'blocked');
      assert.equal(JSON.stringify(database.turns.list('codex')).includes(writer.token), false);
      await instance.close(); database.close();
      database = new ConnectorUserStore(join(dir, 'connector.sqlite'));
      const restored = new DeckStore();
      instance = new CodexAppServer({ ...options, turnQueue: database.turns, executions: database.codexExecutions, store: restored });
      assert.equal(restored.getMessages(sessionKey)[0]?.id, result.idempotencyKey);
      assert.match(restored.getMessages(sessionKey)[0]?.failureReason ?? '', /authorization.*not sent/);
      assert.deepEqual(database.turns.sessionPage('codex'), []);
      await (instance as any).drainQueuedTurn(sessionKey);
      assert.equal(database.turns.head('codex', sessionKey)?.state, 'blocked');
    } finally { await instance.close(); database.close(); }
  });
}

for (const revokedAfter of ['thread/read', 'thread/rollback', 'thread/compact/start']) {
  test(`Codex recovery revalidates permission after ${revokedAfter}`, async () => {
    const database = new ConnectorUserStore(':memory:'), store = new DeckStore(), sessionKey = 'codex:recovery-revoked';
    let authorized = true;
    store.upsertSession({ sessionKey, agentId: 'codex', title: 'Recovery', status: 'idle' });
    store.addMessage({ id: 'failed', sessionKey, role: 'assistant', status: 'failed', text: '413 Payload Too Large', createdAt: 1 });
    const instance = new CodexAppServer({ authorizeTurn: () => authorized, turnQueue: database.turns, executions: database.codexExecutions, store,
      enabled: true, command: 'must-not-launch', defaultCwd: '/tmp', defaultModel: 'test', approvalPolicy: 'never' });
    const calls: string[] = [];
    (instance as any).connectionId = "synthetic-connection";
    (instance as any).ensureStarted = async () => {};
    (instance as any).ensureThreadLoaded = async () => {};
    (instance as any).threadRefreshResult.set(sessionKey, { at: Date.now(), available: true });
    (instance as any).request = async (method: string) => {
      calls.push(method);
      if (method === revokedAfter) authorized = false;
      if (method === 'thread/read') return { thread: { id: 'recovery-revoked', turns: [{ id: 'failed', status: 'failed', error: { message: '413 Payload Too Large' }, items: [] }] } };
      if (method === 'thread/rollback') return {};
      if (method === 'thread/compact/start') {
        queueMicrotask(() => completeCompaction(instance, 'recovery-revoked', 'compact'));
        return {};
      }
      assert.fail('must not start turn after revocation');
    };
    try {
      await instance.send(sessionKey, 'retry', [], { actorId: 'writer' });
      await (instance as any).drainQueuedTurn(sessionKey);
      const sequence = ['thread/read', 'thread/rollback', 'thread/compact/start'];
      assert.deepEqual(calls, sequence.slice(0, sequence.indexOf(revokedAfter) + 1));
      assert.equal(database.turns.head('codex', sessionKey)?.state, revokedAfter === 'thread/read' ? 'blocked' : 'outcome_unknown');
    } finally { await instance.close(); database.close(); }
  });
}

test('Codex admission and receipt commit together without process startup; rollback leaves no projection', async () => {
  const database = new ConnectorUserStore(':memory:'), store = new DeckStore();
  const sessionKey = 'codex:atomic';
  store.upsertSession({ sessionKey, agentId: 'codex', title: 'Atomic', status: 'idle' });
  const instance = new CodexAppServer({ authorizeTurn: () => true, turnQueue: database.turns, executions: database.codexExecutions, enabled: true, command: 'must-not-launch', defaultCwd: '/tmp', defaultModel: 'test', approvalPolicy: 'never', store });
  (instance as any).connectionId = "synthetic-connection";
  (instance as any).ensureStarted = async () => { assert.fail('durable admission cannot start runtime'); };
  (await database.commands.claimAsync('actor/session', 'one', { text: 'one' }));
  try {
    await assert.rejects(instance.send(sessionKey, 'one', [], { accept: (result) => (db) => {
      database.commands.queueCommit('actor/session', 'one', { status: 200, body: result })(db);
      throw new Error('injected rollback');
    } }), /injected rollback/);
    assert.equal(database.turns.list('codex').length, 0);
    assert.equal(store.getMessages(sessionKey).length, 0);
    assert.equal(database.commands.get('actor/session', 'one')?.state, 'outcome_unknown');
    const result = await instance.send(sessionKey, 'one', [], { accept: (value) => database.commands.queueCommit('actor/session', 'one', { status: 200, body: value }) });
    assert.equal(database.commands.get('actor/session', 'one')?.state, 'accepted');
    assert.equal(database.turns.head('codex', sessionKey)?.id, result.idempotencyKey);
    assert.equal(store.getMessages(sessionKey)[0]?.status, 'queued');
    assert.equal(result.status, 'queued');
    assert.equal(result.admission?.disposition, 'preparing');
    assert.equal(result.admission?.queueVersion, database.turns.version('codex', sessionKey, result.idempotencyKey));
    assert.deepEqual(database.commands.get('actor/session', 'one')?.result?.body.admission, result.admission);
    assert.deepEqual(store.getMessages(sessionKey)[0]?.queueVersion, result.admission?.queueVersion);
    const second = await instance.send(sessionKey, 'two');
    assert.equal(second.admission?.disposition, 'waiting', 'an older admission is a blocker even before a run starts');
  } finally { await instance.close(); database.close(); }
});

test('busy Codex admission returns a versioned waiting observation before native history is ready', async () => {
  const { codex, store, sessionKey } = fixture();
  try {
    (codex as any).ensureStarted = async () => { assert.fail('admission must not wait for history'); };
    assert.equal(codex.isSessionHistoryReady(sessionKey), false);
    const response = await codex.send(sessionKey, 'queued during run');
    assert.equal(response.admission?.disposition, 'waiting');
    assert.ok(response.admission?.queueVersion);
    assert.equal(store.getMessages(sessionKey)[0]?.queueDisposition, 'waiting');
  } finally { await codex.close(); }
});

test('Codex cold queue recovers without a browser and history reads alone never dispatch', async () => {
  const database = new ConnectorUserStore(':memory:');
  const sessionKey = 'codex:cold-queue';
  database.turns.enqueue('codex', { id: 'cold', sessionKey, createdAt: 1, payload: { text: 'resume pending', images: [] } });
  const store = new DeckStore();
  const instance = new CodexAppServer({ authorizeTurn: () => true, turnQueue: database.turns, executions: database.codexExecutions, enabled: true, command: 'must-not-launch', defaultCwd: '/tmp', defaultModel: 'test', approvalPolicy: 'never', store });
  (instance as any).connectionId = "synthetic-connection";
  (instance as any).ensureStarted = async () => undefined;
  (instance as any).ensureThreadLoaded = async () => undefined;
  const sent: string[] = [];
  (instance as any).request = async (method: string, params: any) => {
    if (method === 'turn/start') {
      sent.push(params.input[0].text);
      return { turn: { id: 'native-cold' } };
    }
    assert.equal(method, 'thread/read');
    return { thread: { id: 'cold-queue', status: { type: 'idle' }, turns: [] } };
  };
  try {
    await instance.refreshSession(sessionKey);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sent.length, 0, 'read model hydration must not execute pending work');
    assert.equal(store.getSession(sessionKey)?.runtime?.phase, 'completed');
    // Simulate a cold projection; the lifecycle worker hydrates only this
    // queued session instead of enumerating every Codex thread.
    store.removeSession(sessionKey);
    instance.startQueueWorker();
    for (let i = 0; i < 100 && !sent.length; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(sent, ['resume pending']);
    assert.equal(database.turns.head('codex', sessionKey), undefined);
  } finally { await instance.close(); database.close(); }
});

test('Codex deferred preparation preserves the unclaimed version and queued text', async () => {
  const database = new ConnectorUserStore(':memory:'), sessionKey = 'codex:deferred-version', store = new DeckStore();
  const instance = new CodexAppServer({ authorizeTurn: () => true, turnQueue: database.turns, executions: database.codexExecutions, enabled: true,
    command: 'must-not-launch', defaultCwd: '/tmp', defaultModel: 'test', approvalPolicy: 'never', store });
  store.upsertSession({ sessionKey, title: 'Synthetic deferred', agentId: 'codex', status: 'idle', hasActiveRun: false });
  (instance as any).sendQueued = async () => ({ status: 'queued' });
  try {
    const accepted = await instance.send(sessionKey, 'pending text');
    const before = store.getMessages(sessionKey)[0]!.queueVersion!;
    await (instance as any).dispatchQueuedTurn(sessionKey);
    const projected = store.getMessages(sessionKey)[0]!;
    assert.equal(projected.text, 'pending text'); assert.equal(projected.status, 'queued');
    assert.equal(projected.queueVersion, before);
    assert.equal(projected.queueVersion, database.turns.version('codex', sessionKey, accepted.idempotencyKey));
    assert.equal(instance.cancelQueued(sessionKey, accepted.idempotencyKey, projected.queueVersion), true);
  } finally { await instance.close(); database.close(); }
});

test('Codex close waits for admitted queue bookkeeping and refuses new sends', async () => {
  const database = new ConnectorUserStore(':memory:');
  const sessionKey = 'codex:close-race';
  const store = new DeckStore();
  database.turns.enqueue('codex', { id: 'pending', sessionKey, createdAt: 1, payload: { text: 'keep identity', images: [] } });
  const instance = new CodexAppServer({ authorizeTurn: () => true, turnQueue: database.turns, executions: database.codexExecutions, enabled: true, command: 'must-not-launch', defaultCwd: '/tmp', defaultModel: 'test', approvalPolicy: 'never', store });
  store.upsertSession({ sessionKey, title: 'Close race', agentId: 'codex', status: 'idle', hasActiveRun: false });
  (instance as any).connectionId = "synthetic-connection";
  (instance as any).ensureStarted = async () => undefined;
  (instance as any).ensureThreadLoaded = async () => undefined;
  let release!: () => void;
  (instance as any).threadRefreshResult.set(sessionKey, { at: Date.now(), available: true });
  const pending = new Promise<void>((resolve) => { release = resolve; });
  (instance as any).recoverPayloadTooLargeThread = () => pending;
  let starts = 0;
  (instance as any).request = async () => { starts++; throw new Error('closed preparation must not start a native turn'); };
  const drain = (instance as any).drainQueuedTurn(sessionKey);
  await new Promise((resolve) => setImmediate(resolve));
  let closed = false;
  const closing = instance.close().then(() => { closed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false, 'database owner must wait for dispatch bookkeeping');
  await assert.rejects(instance.send(sessionKey, 'late'), /closed/);
  release();
  await Promise.all([drain, closing]);
  assert.equal(starts, 0);
  assert.equal(database.codexExecutions.get(sessionKey), undefined);
  assert.equal(database.turns.head('codex', sessionKey)?.id, 'pending');
  assert.equal(database.turns.head('codex', sessionKey)?.state, 'queued', 'shutdown before any native mutation can safely preserve the original queued command');
  database.close();
  await (instance as any).drainQueuedTurn(sessionKey);
  await instance.close();
});

test('Codex queued messages survive an app restart and drain from disk', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-codex-queue-'));
  let database = new ConnectorUserStore(join(dir, 'connector.sqlite'));
  try {
    const queueFile = join(dir, 'codex-queue.json');
    const first = { store: new DeckStore(), threadId: 'thread-1', sessionKey: 'codex:thread-1' };
    first.store.upsertSession({ sessionKey: first.sessionKey, agentId: 'codex', title: 'Synthetic queue', status: 'running' });
    const writer = new CodexAppServer({ authorizeTurn: () => true, turnQueue: database.turns, executions: database.codexExecutions, enabled: true, command: 'codex', defaultCwd: 'C:\\workspace', defaultModel: 'gpt-5.6-sol', approvalPolicy: 'never', store: first.store, queueFile });
    (writer as any).connectionId = "synthetic-connection";
    (writer as any).ensureStarted = async () => undefined;
    (writer as any).ensureThreadLoaded = async () => undefined;
    (writer as any).request = async (method: string) => method === 'thread/backgroundTerminals/list' ? { data: [] } : ({ thread: { id: first.threadId } });
    const queued = await writer.send(first.sessionKey, 'persist this queued request');
    assert.equal(queued.status, 'queued');
    assert.equal(existsSync(queueFile), false, 'new queue admission must not write the legacy JSON');
    assert.equal(statSync(join(dir, 'connector.sqlite')).mode & 0o777, 0o600);
    await writer.close();
    database.close();
    database = new ConnectorUserStore(join(dir, 'connector.sqlite'));

    const restoredStore = new DeckStore();
    const restored = new CodexAppServer({ authorizeTurn: () => true, turnQueue: database.turns, executions: database.codexExecutions, enabled: true, command: 'codex', defaultCwd: 'C:\\workspace', defaultModel: 'gpt-5.6-sol', approvalPolicy: 'never', store: restoredStore, queueFile });
    assert.equal(restoredStore.getMessages(first.sessionKey).at(-1)?.status, 'queued');
    restoredStore.upsertSession({ sessionKey: first.sessionKey, agentId: 'codex', title: 'Restored', status: 'idle', hasActiveRun: false });
    const delivered: string[] = [];
    (restored as any).connectionId = 'synthetic-restored';
    (restored as any).ensureStarted = async () => {};
    (restored as any).ensureThreadLoaded = async () => {};
    (restored as any).threadRefreshResult.set(first.sessionKey, { at: Date.now(), available: true });
    (restored as any).request = async (method: string, params: any) => {
      assert.equal(method, 'turn/start'); delivered.push(params.input[0].text);
      return { turn: { id: 'native-restored' } };
    };
    await (restored as any).drainQueuedTurn(first.sessionKey);

    assert.deepEqual(delivered, ['persist this queued request']);
    assert.equal(database.turns.list('codex').length, 0);
    await restored.close();
  } finally {
    database.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('legacy Codex dispatch ambiguity survives migration and cannot be bypassed by a new send', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-codex-import-'));
  const queueFile = join(dir, 'legacy.json');
  const sessionKey = 'codex:legacy';
  const source = JSON.stringify({ queues: { [sessionKey]: [{ id: 'uncertain', text: 'possibly delivered', images: [], createdAt: 1, dispatchState: 'dispatching' }] } });
  writeFileSync(queueFile, source);
  const database = new ConnectorUserStore(join(dir, 'connector.sqlite'));
  try {
    const store = new DeckStore();
    const instance = new CodexAppServer({ authorizeTurn: () => true, turnQueue: database.turns, executions: database.codexExecutions, enabled: true, command: 'codex', defaultCwd: dir, defaultModel: 'test', approvalPolicy: 'never', store, queueFile });
    assert.equal(store.getMessages(sessionKey)[0]?.status, 'outcome_unknown');
    store.upsertSession({ sessionKey, agentId: 'codex', title: 'Migration test', status: 'idle', hasActiveRun: false });
    (instance as any).connectionId = "synthetic-connection";
    (instance as any).ensureStarted = async () => {};
    (instance as any).ensureThreadLoaded = async () => {};
    (instance as any).request = async () => { assert.fail('uncertain head must not be resent or bypassed'); };
    assert.equal((await instance.send(sessionKey, 'new request')).status, 'queued');
    await (instance as any).drainQueuedTurn(sessionKey);
    assert.deepEqual(database.turns.list('codex').map(({ state }) => state), ['outcome_unknown', 'queued']);
    assert.equal(readFileSync(queueFile, 'utf8'), source, 'legacy backup remains intact');
  } finally { database.close(); }
});

test('Codex projects assistant artifacts for restored history and live completions', async () => {
  const { store, sessionKey } = fixture();
  const artifactMedia = { type: 'file' as const, url: '/api/artifacts/artifact-id', name: 'report.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
  const projectAssistant = async (text: string) => ({ text: text.replace(/\s*\/workspace\/report\.xlsx/, ''), media: [artifactMedia] });
  const instance = new CodexAppServer({ authorizeTurn: () => true, ...memoryPersistence(store), enabled: true, command: 'codex', defaultCwd: 'C:\\workspace', defaultModel: 'gpt-5.6-sol', approvalPolicy: 'never', store, projectAssistant });
  (instance as any).connectionId = "synthetic-connection";
  (instance as any).ensureStarted = async () => undefined;
  (instance as any).request = async (method: string) => method === 'thread/backgroundTerminals/list' ? { data: [] } : ({ thread: { id: 'thread-1', turns: [{ id: 'turn-history', items: [{ type: 'agentMessage', id: 'history-artifact', text: 'History file /workspace/report.xlsx' }] }] } });

  await instance.refreshSession(sessionKey);
  assert.equal(store.getMessages(sessionKey).at(-1)?.text, 'History file');
  assert.deepEqual(store.getMessages(sessionKey).at(-1)?.media, [artifactMedia]);

  (instance as any).handleNotification('item/completed', {
    threadId: 'thread-1',
    item: { type: 'agentMessage', id: 'live-artifact', text: 'Live file /workspace/report.xlsx' },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(store.getMessages(sessionKey).at(-1)?.text, 'Live file');
  assert.deepEqual(store.getMessages(sessionKey).at(-1)?.media, [artifactMedia]);
});

test('Codex message ids are scoped to their session when threads reuse item ids', async () => {
  const store = new DeckStore();
  const instance = new CodexAppServer({ authorizeTurn: () => true, ...memoryPersistence(store), enabled: true, command: 'codex', defaultCwd: 'C:\\workspace', defaultModel: 'gpt-5.6-sol', approvalPolicy: 'never', store });
  (instance as any).connectionId = "synthetic-connection";
  (instance as any).ensureStarted = async () => undefined;
  (instance as any).request = async (method: string, params: any) => {
    if (method === 'thread/list') return { data: [{ id: 'thread-a' }, { id: 'thread-b' }], nextCursor: null };
    if (method === 'thread/read') return { thread: { id: params.threadId, turns: [{ id: `turn-${params.threadId}`, items: [
      { type: 'userMessage', id: 'item-1', content: [{ type: 'text', text: params.threadId }] },
      { type: 'commandExecution', id: 'tool-1', command: 'echo ok', status: 'completed', aggregatedOutput: 'ok' },
    ] }] } };
    throw new Error(`unexpected method ${method}`);
  };

  await instance.refreshSessions();

  await Promise.all(['codex:thread-a', 'codex:thread-b'].map(key => instance.refreshSession(key)));
  const idsA = new Set(store.getMessages('codex:thread-a').map((message) => message.id));
  const idsB = new Set(store.getMessages('codex:thread-b').map((message) => message.id));
  assert.equal([...idsA].some((id) => idsB.has(id)), false);
  assert.ok([...idsA].every((id) => id.startsWith('codex:thread-a:')));
  assert.ok([...idsB].every((id) => id.startsWith('codex:thread-b:')));
});

test('Codex send resumes a restored unloaded thread before starting a turn', async () => {
  const { store } = fixture();
  const sessionKey = 'codex:thread-restored';
  store.upsertSession({ sessionKey, agentId: 'codex', title: 'Restored', status: 'idle', source: 'codex', model: 'gpt-5.6-terra' });
  const instance = new CodexAppServer({ authorizeTurn: () => true, ...memoryPersistence(store), enabled: true, command: 'codex', defaultCwd: 'C:\\workspace', defaultModel: 'gpt-5.6-sol', approvalPolicy: 'never', store });
  (instance as any).threadModels.set('thread-restored', 'gpt-5.6-terra');
  (instance as any).threadRefreshResult.set(sessionKey, { at: Date.now(), available: true });
  const methods: string[] = [];
  (instance as any).connectionId = "synthetic-connection";
  (instance as any).ensureStarted = async () => undefined;
  (instance as any).request = async (method: string, params: any) => {
    methods.push(method);
    if (method === 'thread/resume') {
      assert.equal(params.excludeTurns, undefined);
      assert.equal(params.model, 'gpt-5.6-terra');
      assert.match(params.developerInstructions, /file paths and concise text summaries/);
      return { thread: { id: 'thread-restored' } };
    }
    if (method === 'turn/start') return { turn: { id: 'turn-new' } };
    throw new Error(`unexpected request: ${method}`);
  };

  await instance.send(sessionKey, 'Continue');
  await (instance as any).drainQueuedTurn(sessionKey);
  assert.deepEqual(methods, ['thread/resume', 'turn/start']);
});

test('Codex runtime override applies model and effort to the next turn', async () => {
  const { store, sessionKey } = fixture();
  store.upsertSession({ ...store.getSession(sessionKey)!, status: 'idle', model: 'gpt-5.6-sol' });
  const instance = new CodexAppServer({ authorizeTurn: () => true, ...memoryPersistence(store), enabled: true, command: 'codex', defaultCwd: '/workspace', defaultModel: 'gpt-6-astra', approvalPolicy: 'never', store });
  (instance as any).loadedThreadIds.add(sessionKey.replace('codex:', ''));
  (instance as any).connectionId = "synthetic-connection";
  (instance as any).ensureStarted = async () => undefined;
  (instance as any).request = async (method: string, params: any) => {
    assert.equal(method, 'turn/start');
    assert.equal(params.model, 'gpt-6-astra');
    assert.equal(params.effort, 'high');
    return { turn: { id: 'turn-overridden' } };
  };

  const updated = instance.updateSessionRuntime(sessionKey, { model: 'gpt-6-astra', thinking: 'high' });
  assert.equal(updated.model, 'gpt-6-astra');
  assert.equal(updated.thinkingLevel, 'high');
  await instance.send(sessionKey, 'Use the override');
});

for (const model of ['provider/custom-model', '']) test(`Codex runtime model override survives refresh and process restart (${model || 'native default'})`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-codex-runtime-'));
  const runtimeOverridesFile = join(dir, 'runtime.json');
  const first = fixture();
  const defaultModel = model ? 'configured-default' : '';
  const writer = new CodexAppServer({ authorizeTurn: () => true, ...memoryPersistence(first.store), enabled: true, command: 'codex', defaultCwd: '/workspace', defaultModel, approvalPolicy: 'never', store: first.store, runtimeOverridesFile });
  writer.updateSessionRuntime(first.sessionKey, { model: model || null });

  const restored = fixture();
  const reader = new CodexAppServer({ authorizeTurn: () => true, ...memoryPersistence(restored.store), enabled: true, command: 'codex', defaultCwd: '/workspace', defaultModel, approvalPolicy: 'never', store: restored.store, runtimeOverridesFile });
  (reader as any).request = async (method: string) => method === 'thread/read'
    ? { thread: { id: 'thread-1', turns: [] } }
    : undefined;
  (reader as any).connectionId = "synthetic-connection";
  (reader as any).ensureStarted = async () => undefined;
  await (reader as any).restoreThread({ id: 'thread-1', path: join(dir, 'missing-rollout.jsonl') });

  assert.equal(restored.store.getSession(restored.sessionKey)?.model, model);
  rmSync(dir, { recursive: true, force: true });
});

test('Codex async admission retains original actor, grant and commit callback during the space wait', async context => {
  const { store, sessionKey } = fixture();
  const db = new DatabaseSync(':memory:');
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const queue = new TurnQueue(db, undefined, undefined, undefined, undefined, undefined,
    async (_bytes, write) => { await waiting; await write(); });
  const checked: unknown[] = [];
  const instance = new CodexAppServer({ ...memoryPersistence(store), turnQueue: queue,
    authorizeTurn: (actor, _target, _action, grant) => {
      checked.push({ actor, grant: grant && { ...grant } }); return true;
    }, enabled: true, command: 'codex', defaultCwd: '/workspace', defaultModel: '', approvalPolicy: 'never', store });
  context.after(() => { instance.close(); db.close(); });
  let originalCommits = 0, replacementCommits = 0;
  const admission = { actorId: 'original-actor', executionGrant: {
    id: 'original-grant', actorId: 'original-actor', issuerTokenId: 'original-issuer',
  }, accept: () => () => { originalCommits++; } };
  const pending = instance.send(sessionKey, 'original payload', [], admission);
  assert.equal(db.isTransaction, false); assert.equal(queue.maintenanceCount(), 0);
  admission.actorId = 'replacement-actor'; admission.executionGrant.id = 'replacement-grant';
  admission.executionGrant.actorId = 'replacement-actor'; admission.executionGrant.issuerTokenId = 'replacement-issuer';
  admission.accept = () => () => { replacementCommits++; };
  release(); await pending;
  assert.ok(checked.length >= 3);
  assert.ok(checked.every(value => JSON.stringify(value) === JSON.stringify({ actor: 'original-actor', grant: {
    id: 'original-grant', actorId: 'original-actor', issuerTokenId: 'original-issuer',
  } })));
  assert.equal(originalCommits, 1); assert.equal(replacementCommits, 0);
  assert.deepEqual(queue.head<any>('codex', sessionKey)?.payload.executionGrant, {
    id: 'original-grant', actorId: 'original-actor', issuerTokenId: 'original-issuer',
  });
  assert.equal(queue.head<any>('codex', sessionKey)?.payload.actorId, 'original-actor');
});

test('Codex admission rejects an unknown session without runtime hydration or side effects', async () => {
  const store = new DeckStore();
  const sessionKey = 'codex:thread-before-restart';
  const instance = new CodexAppServer({ authorizeTurn: () => true, ...memoryPersistence(store), enabled: true, command: 'codex', defaultCwd: 'C:\\workspace', defaultModel: 'gpt-5.6-sol', approvalPolicy: 'never', store });
  const methods: string[] = [];
  (instance as any).connectionId = "synthetic-connection";
  (instance as any).ensureStarted = async () => undefined;
  (instance as any).request = async (method: string) => {
    methods.push(method);
    if (method === 'thread/resume') return { thread: { id: 'thread-before-restart' } };
    if (method === 'turn/start') return { turn: { id: 'turn-after-restart' } };
    throw new Error(`unexpected request: ${method}`);
  };

  await assert.rejects(instance.send(sessionKey, 'Continue after restart'), /session not found/);
  assert.equal(store.getSession(sessionKey), undefined);
  assert.equal((instance as any).options.turnQueue.list('codex').length, 0);
  assert.deepEqual(methods, []);
});

test('Codex send includes local images and supports an image-only turn', async () => {
  const { store, sessionKey } = fixture();
  store.upsertSession({ ...store.getSession(sessionKey)!, status: 'idle', hasActiveRun: false });
  const instance = new CodexAppServer({ authorizeTurn: () => true, ...memoryPersistence(store), enabled: true, command: 'codex', defaultCwd: 'C:\\workspace', defaultModel: 'gpt-5.6-sol', approvalPolicy: 'never', store });
  const requests: Array<{ method: string; params: any }> = [];
  (instance as any).connectionId = "synthetic-connection";
  (instance as any).ensureStarted = async () => undefined;
  (instance as any).loadedThreadIds.add('thread-1');
  (instance as any).threadRefreshResult.set(sessionKey, { at: Date.now(), available: true });
  (instance as any).request = async (method: string, params: any) => {
    requests.push({ method, params });
    return { turn: { id: 'turn-image' } };
  };

  const image = {
    filePath: 'C:\\media\\screenshot.png',
    media: { type: 'image' as const, url: '/api/media/inbound/screenshot.png', name: 'screenshot.png', mimeType: 'image/png' },
  };
  const result = await instance.send(sessionKey, '', [image]);
  await (instance as any).drainQueuedTurn(sessionKey);

  assert.deepEqual(requests, [{
    method: 'turn/start',
    params: {
      threadId: 'thread-1',
      input: [{ type: 'localImage', path: 'C:\\media\\screenshot.png' }],
      clientUserMessageId: result.idempotencyKey,
      cwd: 'C:\\workspace',
      model: 'gpt-5.6-sol',
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
    },
  }]);
  assert.deepEqual(store.getMessages(sessionKey).at(-1)?.media, [image.media]);
  assert.deepEqual(result.media, [image.media]);
});

test('Codex send rolls back trailing 413 turns before starting the next turn', async () => {
  const { store, sessionKey } = fixture();
  store.upsertSession({ ...store.getSession(sessionKey)!, status: 'idle', hasActiveRun: false });
  store.addMessage({
    id: 'failed-413',
    sessionKey,
    role: 'assistant',
    text: 'unexpected status 413 Payload Too Large',
    status: 'failed',
    failureReason: 'unexpected status 413 Payload Too Large',
    createdAt: 10,
  });
  const instance = new CodexAppServer({ authorizeTurn: () => true, ...memoryPersistence(store), enabled: true, command: 'codex', defaultCwd: 'C:\\workspace', defaultModel: 'gpt-5.6-sol', approvalPolicy: 'never', store });
  const requests: Array<{ method: string; params: any }> = [];
  (instance as any).connectionId = "synthetic-connection";
  (instance as any).ensureStarted = async () => undefined;
  (instance as any).loadedThreadIds.add('thread-1');
  (instance as any).threadRefreshResult.set(sessionKey, { at: Date.now(), available: true });
  (instance as any).request = async (method: string, params: any) => {
    requests.push({ method, params });
    if (method === 'thread/read') return { thread: { id: 'thread-1', turns: [
      { id: 'turn-ok', status: 'completed', startedAt: 1, items: [{ type: 'agentMessage', id: 'ok', text: 'Done' }] },
      { id: 'turn-large', status: 'completed', items: Array.from({ length: 9 }, (_, index) => ({ type: 'imageView', id: `image-${index}`, path: `C:\\media\\${index}.png` })) },
      { id: 'turn-failed', status: 'failed', error: { message: 'unexpected status 413 Payload Too Large' }, items: [] },
      { id: 'turn-retry', status: 'failed', error: { message: 'unexpected status 413 Payload Too Large' }, items: [] },
    ] } };
    if (method === 'thread/rollback') return {};
    if (method === 'thread/compact/start') {
      queueMicrotask(() => completeCompaction(instance, 'thread-1', 'turn-compact'));
      return {};
    }
    if (method === 'turn/start') return { turn: { id: 'turn-new' } };
    throw new Error(`unexpected request: ${method}`);
  };

  await instance.send(sessionKey, 'Try again');
  await (instance as any).drainQueuedTurn(sessionKey);

  assert.deepEqual(requests.map(({ method }) => method), ['thread/read', 'thread/rollback', 'thread/compact/start', 'turn/start']);
  assert.deepEqual(requests[1]?.params, { threadId: 'thread-1', numTurns: 3 });
  assert.deepEqual(requests[2]?.params, { threadId: 'thread-1' });
  assert.match(requests[3]?.params.input[0].text, /Recovered context.*Done.*Current request.*Try again/s);
  assert.equal(store.getMessages(sessionKey).some((message) => message.failureReason?.includes('413')), false);
  assert.equal(store.getMessages(sessionKey).at(-1)?.text, 'Try again');
});

for (const beforeAck of [false, true]) test(`Codex never replays an admitted turn after a 413 (failure before ACK: ${beforeAck})`, async t => {
  const { store, sessionKey } = fixture();
  store.upsertSession({ ...store.getSession(sessionKey)!, status: 'idle', hasActiveRun: false });
  const instance = new CodexAppServer({ authorizeTurn: () => true, ...memoryPersistence(store), enabled: true, command: 'codex', defaultCwd: 'C:\\workspace', defaultModel: 'gpt-5.6-sol', approvalPolicy: 'never', store });
  const requests: Array<{ method: string; params: any }> = [];
  let turnStarts = 0;
  const failure = { threadId: 'thread-1',
    turn: { id: 'turn-1', status: 'failed', error: { message: 'unexpected status 413 Payload Too Large' }, items: [] } };
  t.after(() => instance.close());
  (instance as any).connectionId = "synthetic-connection";
  (instance as any).ensureStarted = async () => undefined;
  (instance as any).loadedThreadIds.add('thread-1');
  (instance as any).threadRefreshResult.set(sessionKey, { at: Date.now(), available: true });
  (instance as any).request = async (method: string, params: any) => {
    requests.push({ method, params });
    if (method === 'turn/start') {
      // Model a side effect completed before the failed turn's final response.
      turnStarts++;
      if (beforeAck && turnStarts === 1) (instance as any).handleNotification('turn/completed', failure);
      return { turn: { id: `turn-${turnStarts}` } };
    }
    if (method === 'thread/read') return { thread: { id: 'thread-1', turns: [
      { id: 'turn-ok', status: 'completed', items: [{ type: 'agentMessage', id: 'progress', text: 'Keep the completed edits' }] },
      { id: 'turn-1', status: 'failed', error: { message: 'unexpected status 413 Payload Too Large' }, items: [] },
    ] } };
    if (method === 'thread/rollback') return {};
    if (method === 'thread/compact/start') {
      queueMicrotask(() => completeCompaction(instance, 'thread-1', 'turn-compact'));
      return {};
    }
    throw new Error(`unexpected request: ${method}`);
  };

  const admitted = await instance.send(sessionKey, 'Finish the hand pose');
  await (instance as any).drainQueuedTurn(sessionKey);
  if (!beforeAck) (instance as any).handleNotification('turn/completed', failure);
  await new Promise<void>(resolve => setImmediate(resolve));
  (instance as any).handleNotification('turn/completed', failure);
  await new Promise<void>(resolve => setImmediate(resolve));

  assert.deepEqual(requests.map(({ method }) => method), ['turn/start']);
  assert.equal(turnStarts, 1, 'failed execution is not proof that no side effect occurred');
  assert.equal(requests[0]?.params.clientUserMessageId, admitted.runId);
  assert.equal(store.getMessages(sessionKey).filter(message => message.failureReason?.includes('413')).length, 1);
  assert.equal(store.getSession(sessionKey)?.status, 'failed');
});
