import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { CodexNativeObservations, codexRpcNeedsObservationBarrier } from './native-observations.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { DeckStore } from '../projection/deck-store.js';
import { CodexAppServer } from './app-server.js';
import { consumeCodexOutput } from './native-output.js';

function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((ok, no) => { resolve = ok; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const quiet = () => new PerformanceDiagnostics(() => {}, () => 0);
const MAX_OBSERVATIONS = 128, MAX_OBSERVATION_BYTES = 8 * 1024 * 1024;

test('Codex streaming bursts retain exact text with bounded physical observations', async () => {
  const owner = new CodexNativeObservations({ unavailable: () => assert.fail('unexpected veto'), diagnostics: quiet() });
  const hold = deferred(), seen: string[] = [];
  owner.accept(() => hold.promise, 10, 1);
  const chunks = Array.from({ length: 5000 }, (_, index) => `${index}:你好 `);
  for (const text of chunks) assert.equal(owner.acceptText('same-item', text, Buffer.byteLength(text), combined => { seen.push(combined); }), true);
  assert.deepEqual(owner.status(), { pending: 2, bytes: 10 + Buffer.byteLength(chunks.join('')), failed: false, closed: false });
  hold.resolve(); await owner.drain();
  assert.deepEqual(seen, [chunks.join('')]);
  assert.deepEqual(owner.status(), { pending: 0, bytes: 0, failed: false, closed: false });
  await owner.close();
});

test('Codex streaming batches never cross lifecycle, identity or physical-start boundaries', async () => {
  const owner = new CodexNativeObservations({ unavailable: () => assert.fail('unexpected veto'), diagnostics: quiet() });
  const first = deferred(), second = deferred(), seen: string[] = [];
  owner.acceptText('same', 'started', 1, text => { seen.push(text); return first.promise; });
  owner.acceptText('same', 'next', 2, text => { seen.push(text); return second.promise; });
  owner.acceptText('same', '-joined', 3, () => assert.fail('not a separate task'));
  owner.accept(() => { seen.push('lifecycle'); }, 4, 1);
  owner.acceptText('same', 'after', 5, text => { seen.push(text); });
  owner.acceptText('other', 'other', 6, text => { seen.push(text); });
  assert.deepEqual(seen, ['started']);
  first.resolve(); await tick();
  assert.deepEqual(seen, ['started', 'next-joined']); assert.equal(owner.status().bytes, 20);
  second.resolve(); await owner.drain();
  assert.deepEqual(seen, ['started', 'next-joined', 'lifecycle', 'after', 'other']);
  assert.equal(owner.status().bytes, 0); await owner.close();
});

test('Codex streaming byte limit still vetoes and retains the physical owner', async () => {
  let veto = 0;
  const owner = new CodexNativeObservations({ unavailable: () => { veto++; }, diagnostics: quiet() });
  const hold = deferred();
  owner.accept(() => hold.promise, 0, 1);
  owner.acceptText('same', 'text', MAX_OBSERVATION_BYTES, () => assert.fail('vetoed batch'));
  assert.equal(owner.acceptText('same', 'overflow', 1, () => assert.fail('overflow')), false);
  assert.equal(veto, 1); assert.equal(owner.status().pending, 2);
  assert.equal(owner.acceptText('same', 'rejected', 0, () => {}), false);
  hold.resolve(); await owner.close(); assert.equal(owner.status().bytes, 0);
});

test('Codex observation idle lane preserves synchronous original semantics and reentrant FIFO', async () => {
  const owner = new CodexNativeObservations({ unavailable: () => assert.fail('unexpected veto'), diagnostics: quiet() });
  const order: number[] = [];
  owner.accept(() => {
    order.push(1);
    owner.accept(() => { order.push(3); }, 2, 1);
    order.push(2);
  }, 1, 1);
  assert.deepEqual(order, [1, 2]);
  await owner.drain();
  assert.deepEqual(order, [1, 2, 3]);
  assert.equal(owner.status().pending, 0);
  owner.accept(() => { order.push(4); }, 0, 2);
  assert.deepEqual(order, [1, 2, 3, 4]);
  owner.assertEffectAllowed();
  await owner.close();
});

test('Codex observation owns physical async work and serializes notification/connection observations', async () => {
  const owner = new CodexNativeObservations({ unavailable: () => assert.fail('unexpected veto'), diagnostics: quiet() });
  const first = deferred(), second = deferred(), order: string[] = [];
  owner.accept(async () => { order.push('notification'); await first.promise; order.push('persisted'); }, 12, 1);
  owner.accept(async () => { order.push('connection'); await second.promise; }, 3, 2);
  assert.deepEqual(owner.status(), { pending: 2, bytes: 15, failed: false, closed: false });
  assert.throws(() => owner.assertEffectAllowed(), /pending/);
  let done = false;
  const closed = owner.close().then(() => { done = true; });
  assert.equal(owner.close(), owner.close());
  assert.equal(owner.accept(() => assert.fail('closed admission'), 0, 1), false);
  await tick(); assert.equal(done, false);
  first.resolve(); await tick();
  assert.deepEqual(order, ['notification', 'persisted', 'connection']);
  assert.equal(done, false); assert.equal(owner.status().bytes, 3);
  second.resolve(); await closed;
  assert.equal(owner.status().pending, 0);
  assert.throws(() => owner.assertEffectAllowed(), /unavailable/);
});

test('Codex effect barrier waits one finite snapshot instead of chasing continuing Goal ingress', async () => {
  const owner = new CodexNativeObservations({ unavailable: () => {}, diagnostics: quiet() });
  const first = deferred(), next = deferred();
  owner.accept(() => first.promise, 1, 1);
  const refused = assert.rejects(owner.beforeEffect(), /pending/);
  owner.accept(() => next.promise, 1, 1);
  first.resolve();
  await refused;
  assert.equal(owner.status().pending, 1);
  next.resolve(); await owner.beforeEffect();
  await owner.close();
});

for (const hidden of ['undefined', 'throwing'] as const) for (const outcome of ['resolve', 'reject'] as const) {
  test(`Codex physical native Promise drains with ${hidden} then and late ${outcome}`, async () => {
    const hold = deferred(), owner = new CodexNativeObservations({ unavailable: () => {}, diagnostics: quiet() });
    Object.defineProperty(hold.promise, 'then', hidden === 'undefined' ? { value: undefined }
      : { get() { throw Error('public then must not be inspected'); } });
    owner.accept(() => hold.promise, 7, 1);
    let closed = false;
    const drain = owner.close().then(() => { closed = true; });
    await tick(); assert.equal(closed, false); assert.equal(owner.status().pending, 1);
    if (outcome === 'reject') hold.reject(Error('late private rejection')); else hold.resolve();
    await drain;
    assert.equal(owner.status().pending, 0); assert.equal(owner.status().failed, outcome === 'reject');
  });
}

for (const failure of ['throw', 'reject', 'then-getter', 'foreign-thenable'] as const) {
  test(`Codex observation ${failure} latches veto without replays or unhandled rejection`, async () => {
    let veto = 0, calls = 0;
    const owner = new CodexNativeObservations({ unavailable: () => { veto++; throw Error('private veto'); }, diagnostics: quiet() });
    const hold = deferred();
    owner.accept(() => hold.promise, 5, 1);
    owner.accept(() => {
      calls++;
      if (failure === 'throw') throw Error('private failure');
      if (failure === 'reject') return Promise.reject(Error('private failure'));
      if (failure === 'then-getter') return Object.defineProperty({}, 'then', { get() { throw Error('private getter'); } });
      return { then(_resolve: unknown, reject: (error: Error) => void) { reject(Error('private foreign')); } };
    }, 5, 1);
    owner.accept(() => assert.fail('queued work cannot write after owner failure'), 5, 2);
    hold.resolve(); await owner.drain();
    assert.equal(veto, 1); assert.equal(calls, 1);
    assert.deepEqual(owner.status(), { pending: 0, bytes: 0, failed: true, closed: false });
    assert.equal(owner.accept(() => assert.fail('no recovery by replay'), 0, 1), false);
    await assert.rejects(owner.beforeEffect(), /unavailable/);
    await owner.close();
  });
}

for (const capacity of ['count', 'bytes', 'invalid-bytes'] as const) {
  test(`Codex observation ${capacity} overflow retains already running physical task`, async () => {
    let veto = 0;
    const owner = new CodexNativeObservations({ unavailable: () => { veto++; }, diagnostics: quiet() });
    const hold = deferred();
    owner.accept(() => hold.promise, capacity === 'bytes' ? MAX_OBSERVATION_BYTES : 0, 1);
    if (capacity === 'count') for (let i = 1; i < MAX_OBSERVATIONS; i++)
      assert.equal(owner.accept(() => assert.fail('not started after capacity failure'), 0, 1), true);
    assert.equal(owner.accept(() => assert.fail('overflow work'), capacity === 'invalid-bytes' ? -1 : 1, 1), false);
    assert.equal(veto, 1);
    let closed = false;
    const drain = owner.close().then(() => { closed = true; });
    await tick(); assert.equal(closed, false);
    hold.resolve(); await drain;
    assert.equal(owner.status().pending, 0); assert.equal(owner.status().bytes, 0);
  });
}

test('Codex observation logs fixed metrics only, broken clocks/sinks cannot alter ownership', async () => {
  for (const broken of [false, true]) {
    const lines: string[] = [];
    const diagnostics = new PerformanceDiagnostics(line => { if (broken) throw Error('PRIVATE sink'); lines.push(line); }, () => 0);
    const owner = new CodexNativeObservations({ unavailable: () => {}, diagnostics });
    owner.accept(() => { throw Error('PRIVATE token /path message'); }, 17, 1);
    await owner.close();
    const events = diagnostics.snapshot().events.filter(row => row.operation === 'codex-native-observation');
    assert.ok(events.length > 0); assert.ok(events.some(row => row.sourceBytes === 17));
    assert.doesNotMatch(JSON.stringify({ lines, events }), /PRIVATE|\/path/);
  }
  const owner = new CodexNativeObservations({ unavailable: () => {}, diagnostics: { start() { throw Error('PRIVATE clock'); } } as unknown as PerformanceDiagnostics });
  owner.accept(() => Promise.resolve(), 1, 1);
  await owner.close(); assert.equal(owner.status().failed, false);
});

test('Codex unknown RPCs are fenced; original read-only/handshake/exact interrupt methods are not', () => {
  for (const method of ['turn/start', 'thread/start', 'thread/resume', 'thread/rollback', 'thread/compact/start',
    'thread/archive', 'thread/name/set', 'thread/goal/set', 'thread/goal/clear', 'future/native-effect'])
    assert.equal(codexRpcNeedsObservationBarrier(method), true, method);
  for (const method of ['initialize', 'thread/read', 'thread/list', 'thread/loaded/list', 'model/list', 'skills/list',
    'thread/goal/get', 'thread/backgroundTerminals/list', 'turn/interrupt'])
    assert.equal(codexRpcNeedsObservationBarrier(method), false, method);
});

function fixture() {
  const database = new ConnectorUserStore(':memory:'), store = new DeckStore(), sessionKey = 'codex:synthetic';
  store.upsertSession({ sessionKey, agentId: 'codex', title: 'original ingress', status: 'idle' });
  const codex = new CodexAppServer({ enabled: true, command: 'must-not-launch', defaultCwd: '.', defaultModel: 'test',
    approvalPolicy: 'never', store, turnQueue: database.turns, executions: database.codexExecutions,
    authorizeTurn: () => true, requestTimeoutMs: 1000 });
  const runtime = codex as any, writes: any[] = [];
  runtime.setConnection('original');
  runtime.child = { stdin: { writable: true, write(line: string) {
    const message = JSON.parse(line); writes.push(message);
    if (typeof message.id === 'number') queueMicrotask(() => runtime.receive(JSON.stringify({ id: message.id, result: {} })));
    return true;
  } } };
  const notification = (method = 'turn/started', turnId = 'native') => runtime.receive(JSON.stringify({ method,
    params: { threadId: 'synthetic', turn: { id: turnId, status: 'inProgress' } } }));
  const cleanup = async () => { await codex.close(); database.close(); };
  return { database, store, sessionKey, codex, runtime, writes, notification, cleanup };
}

test('Original Codex transport preserves mixed lifecycle bursts through physical journal settlement', async () => {
  const f = fixture(), hold = deferred();
  const settle = f.runtime.settleNativeNotification.bind(f.runtime);
  const seen: string[] = [];
  f.runtime.settleNativeNotification = async (event: any) => {
    await hold.promise;
    seen.push(event.tool?.id ?? event.kind);
    return settle(event);
  };
  const events = Array.from({ length: MAX_OBSERVATIONS }, (_, index) => ({
    method: index % 2 ? 'item/completed' : 'item/started',
    params: { threadId: 'synthetic', turnId: 'native', item: {
      id: `tool-${index}`, type: 'commandExecution', command: 'synthetic', status: index % 2 ? 'completed' : 'inProgress',
    } },
  }));
  const stream = consumeCodexOutput(Readable.from([events.map(event => JSON.stringify(event)).join('\n') + '\n']), {
    receive: line => f.runtime.receive(line),
    holdIngress: () => f.runtime.nativeObservations.holdIngress(),
    pressure: () => f.runtime.nativeObservations.pressure(),
  });
  try {
    await tick();
    assert.equal(f.runtime.nativeObservations.status().pending, MAX_OBSERVATIONS / 2);
    assert.equal(f.runtime.executionUnavailable, false);
    assert.throws(() => f.runtime.nativeObservations.assertEffectAllowed(), /pending/);
    hold.resolve();
    await stream;
    await f.runtime.nativeObservations.drain();
    assert.deepEqual(seen, events.map(event => event.params.item.id));
    assert.equal(f.runtime.executionUnavailable, false);
    assert.doesNotThrow(() => f.store.getSessionsState());
    f.runtime.nativeObservations.assertEffectAllowed();
  } finally { hold.resolve(); await stream; await f.cleanup(); }
});

for (const method of ['item/agentMessage/delta', 'item/commandExecution/outputDelta', 'item/reasoning/textDelta', 'item/reasoning/summaryTextDelta']) {
  test(`Original Codex ${method} burst preserves ingress guards and journal settlement`, async () => {
    const f = fixture(), hold = deferred(), original = f.runtime.settleNativeNotification.bind(f.runtime);
    const seen: { method: string; params: any }[] = [];
    const projection = f.runtime.projectSettledNotification.bind(f.runtime);
    f.runtime.settleNativeNotification = async (event: unknown) => { await hold.promise; return original(event); };
    f.runtime.projectSettledNotification = (name: string, params: any, result: unknown) => { seen.push({ method: name, params }); return projection(name, params, result); };
    try {
      const guard = f.runtime.nativeHistoryActivityGuard('synthetic');
      f.runtime.handleNotification('item/started', { threadId: 'synthetic', turnId: 'native', item: { id: 'item', type: 'agentMessage' } });
      const chunks = Array.from({ length: 1000 }, (_, index) => `${index}你好 `);
      for (const delta of chunks) f.runtime.handleNotification(method, { threadId: 'synthetic', turnId: 'native', itemId: 'item', delta });
      f.runtime.handleNotification('item/started', { threadId: 'synthetic', turnId: 'native', item: { id: 'next', type: 'agentMessage' } });
      assert.equal(guard.current(), false);
      assert.equal(f.runtime.nativeObservations.status().pending, 3);
      assert.equal(f.runtime.nativeObservations.status().failed, false);
      hold.resolve(); await f.runtime.nativeObservations.drain();
      assert.deepEqual(seen.map(value => value.method), ['item/started', method, 'item/started']);
      assert.equal(seen[1]!.params.delta, chunks.join(''));
      assert.equal(f.runtime.nativeObservations.status().bytes, 0);
      assert.equal(f.runtime.executionUnavailable, false);
      assert.doesNotThrow(() => f.store.getSessionsState());
    } finally { hold.resolve(); await f.cleanup(); }
  });
}

test('Original Codex stream identity and connection changes never combine observations', async () => {
  const f = fixture(), hold = deferred(), seen: any[] = [];
  f.runtime.projectNotification = (_method: string, params: any) => { seen.push(params); return seen.length === 1 ? hold.promise : undefined; };
  try {
    f.notification();
    for (const turnId of ['first', 'second']) f.runtime.handleNotification('item/agentMessage/delta', { threadId: 'synthetic', turnId, itemId: 'item', delta: turnId });
    assert.equal(f.runtime.nativeObservations.status().pending, 3);
    f.runtime.setConnection('replacement');
    f.runtime.handleNotification('item/agentMessage/delta', { threadId: 'synthetic', turnId: 'second', itemId: 'item', delta: 'new-connection' });
    hold.resolve(); await f.runtime.nativeObservations.drain();
    assert.equal(seen.length, 2); assert.equal(seen[1].delta, 'new-connection');
  } finally { hold.resolve(); await f.cleanup(); }
});

test('Original Codex ingress invalidates history immediately while original journal observation waits', async () => {
  const f = fixture(), hold = deferred(), original = f.runtime.projectNotification.bind(f.runtime);
  f.database.codexExecutions.begin(f.sessionKey, 'command', 'original');
  const revision = f.database.codexExecutions.get(f.sessionKey)!.revision;
  const guard = f.runtime.nativeHistoryActivityGuard('synthetic');
  f.runtime.projectNotification = async (...args: unknown[]) => { await hold.promise; original(...args); };
  try {
    f.notification();
    assert.equal(guard.current(), false);
    assert.equal(f.database.codexExecutions.get(f.sessionKey)!.revision, revision);
    hold.resolve(); await f.runtime.nativeObservations.drain();
    assert.ok(f.database.codexExecutions.get(f.sessionKey)!.revision > revision);
    assert.equal(f.database.codexExecutions.get(f.sessionKey)!.phase, 'starting', 'early notification is not an ACK');
  } finally { hold.resolve(); await f.cleanup(); }
});

test('Original Codex RPC gates effects while keeping reads, exact stop, and replies usable', async () => {
  const f = fixture(), hold = deferred();
  f.runtime.projectNotification = () => hold.promise;
  try {
    f.notification();
    let checks = 0;
    const effect = f.runtime.request('turn/start', { threadId: 'synthetic' }, undefined, undefined, () => { checks++; });
    await f.runtime.request('thread/read', { threadId: 'synthetic', includeTurns: true });
    await f.runtime.request('turn/interrupt', { threadId: 'synthetic', turnId: 'native' });
    assert.deepEqual(f.writes.map(row => row.method), ['thread/read', 'turn/interrupt']);
    hold.resolve(); await effect;
    assert.equal(checks, 1);
    assert.deepEqual(f.writes.map(row => row.method), ['thread/read', 'turn/interrupt', 'turn/start']);
  } finally { hold.resolve(); await f.cleanup(); }
});

test('Original Codex sustained ingress refuses one effect without waiting for later Goal observations', async () => {
  const f = fixture(), first = deferred(), next = deferred();
  let calls = 0;
  f.runtime.projectNotification = () => (++calls === 1 ? first.promise : next.promise);
  try {
    f.notification();
    const refused = assert.rejects(f.runtime.request('thread/resume', { threadId: 'synthetic' }, undefined, undefined, () => {}), /pending/);
    f.notification('turn/started', 'successor');
    first.resolve(); await refused;
    assert.equal(f.writes.length, 0); assert.equal(f.runtime.nativeObservations.status().pending, 1);
  } finally { first.resolve(); next.resolve(); await f.cleanup(); }
});

test('Original Codex connection ABA invalidates queued events and refuses pre-replacement effects', async () => {
  const f = fixture(), hold = deferred(), seen: string[] = [];
  f.runtime.projectNotification = (_method: string, params: any) => {
    seen.push(params.turn.id); return params.turn.id === 'native' ? hold.promise : undefined;
  };
  try {
    f.notification();
    const effect = assert.rejects(f.runtime.request('turn/start', { threadId: 'synthetic' }, undefined, undefined, () => {}), /pending|connection changed/);
    f.notification('turn/started', 'queued-old');
    f.runtime.setConnection('replacement'); f.runtime.setConnection('original');
    hold.resolve(); await effect; await f.runtime.nativeObservations.drain();
    assert.deepEqual(seen, ['native']); assert.equal(f.writes.length, 0);
    f.notification('turn/started', 'new'); assert.deepEqual(seen, ['native', 'new']);
  } finally { hold.resolve(); await f.cleanup(); }
});

test('Original Codex unguarded pending effects refuse rather than carrying stale authority across await', async () => {
  const f = fixture(), hold = deferred();
  f.runtime.projectNotification = () => hold.promise;
  try {
    f.notification();
    await assert.rejects(f.runtime.request('thread/resume', {}), /pending/);
    assert.equal(f.writes.length, 0); assert.equal(f.runtime.nativeObservations.status().pending, 1);
  } finally { hold.resolve(); await f.cleanup(); }
});

test('Original Codex guarded effect rechecks revocation after physical observation', async () => {
  const f = fixture(), hold = deferred();
  f.runtime.projectNotification = () => hold.promise;
  let revoked = false, checks = 0;
  try {
    f.notification();
    const effect = assert.rejects(f.runtime.request('turn/start', {}, undefined, undefined, () => {
      checks++; if (revoked) throw Error('original authority revoked');
    }), /revoked/);
    revoked = true; hold.resolve(); await effect;
    assert.equal(checks, 1); assert.equal(f.writes.length, 0); assert.equal(f.runtime.pending.size, 0);
  } finally { hold.resolve(); await f.cleanup(); }
});

test('Original Codex refuses async final authority without executing its body', async () => {
  const f = fixture(); let calls = 0;
  try {
    await assert.rejects(f.runtime.request('turn/start', {}, undefined, undefined, async () => { calls++; }), /authorization/);
    assert.equal(calls, 0); assert.equal(f.writes.length, 0);
  } finally { await f.cleanup(); }
});

test('Original Codex ordinary start rechecks original actor authority after pending native settlement', async () => {
  const f = fixture(), hold = deferred(); let allowed = true;
  f.runtime.projectNotification = () => hold.promise;
  f.runtime.options.authorizeTurn = () => allowed;
  try {
    f.notification();
    const result = assert.rejects(f.runtime.startTurn(f.sessionKey, 'synthetic', [], 'command', 'actor'), /authoriz/i);
    assert.equal(f.database.codexExecutions.get(f.sessionKey)?.phase, 'starting');
    allowed = false; hold.resolve(); await result;
    assert.equal(f.writes.length, 0);
  } finally { hold.resolve(); await f.cleanup(); }
});

test('Original Codex archive keeps existing session when authority is revoked during settlement', async () => {
  const f = fixture(), hold = deferred(); let allowed = true;
  f.runtime.projectNotification = () => hold.promise;
  f.runtime.ensureStarted = async () => {};
  try {
    f.notification();
    const result = assert.rejects(f.codex.remove(f.sessionKey, () => {
      if (!allowed) throw Error('original archive revoked');
    }), /revoked/);
    await tick(); allowed = false; hold.resolve(); await result;
    assert.equal(f.writes.length, 0); assert.ok(f.store.getSession(f.sessionKey));
  } finally { hold.resolve(); await f.cleanup(); }
});

test('Original Codex connection settlement failure latches native effect veto', async () => {
  const f = fixture();
  f.database.codexExecutions.sessionPage = () => { throw Error('private connection SQL'); };
  try {
    f.runtime.setConnection('replacement');
    assert.equal(f.runtime.nativeObservations.status().failed, true);
    await assert.rejects(f.runtime.request('thread/start', {}), /unavailable/);
    await f.runtime.request('thread/read', {});
    assert.deepEqual(f.writes.map(row => row.method), ['thread/read']);
  } finally { await f.cleanup(); }
});

for (const failure of ['resolve', 'reject'] as const) {
  test(`Original Codex close retains physical ${failure} observation and final disconnect settlement`, async () => {
    const f = fixture(), hold = deferred();
    let ended = false, calls = 0;
    f.runtime.projectNotification = () => { calls++; return hold.promise; };
    f.notification();
    const closed = f.codex.close().then(() => { ended = true; });
    assert.equal(f.codex.close(), f.codex.close());
    f.notification('turn/started', 'after-close');
    await tick(); assert.equal(ended, false); assert.equal(calls, 1);
    if (failure === 'resolve') hold.resolve(); else hold.reject(Error('private failure'));
    await closed;
    assert.equal(f.runtime.nativeObservations.status().pending, 0);
    assert.equal(f.runtime.nativeObservations.status().closed, true);
    assert.equal(f.runtime.executionUnavailable, failure === 'reject');
    f.database.close();
  });
}

test('Original Codex observer failure prevents effects but preserves read-only recovery', async () => {
  const f = fixture();
  f.runtime.projectNotification = () => Promise.reject(Error('private SQL failure'));
  try {
    f.notification(); await f.runtime.nativeObservations.drain();
    assert.equal(f.runtime.executionUnavailable, true);
    await assert.rejects(f.runtime.request('turn/start', {}), /observations unavailable/);
    await f.runtime.request('thread/read', { threadId: 'synthetic' });
    assert.deepEqual(f.writes.map(row => row.method), ['thread/read']);
  } finally { await f.cleanup(); }
});

test('Original Codex final write fence refuses notifications that arrive during serialization', async () => {
  const f = fixture(), hold = deferred();
  f.runtime.projectNotification = () => hold.promise;
  const params = { toJSON() { f.notification(); return { threadId: 'synthetic' }; } };
  try {
    await assert.rejects(f.runtime.request('turn/start', params), /pending/);
    assert.equal(f.writes.length, 0); assert.equal(f.runtime.pending.size, 0);
  } finally { hold.resolve(); await f.cleanup(); }
});

test('Original Goal durable beforeWrite and stdin write remain one synchronous fenced boundary', async () => {
  const f = fixture(), hold = deferred();
  let begins = 0;
  f.runtime.projectNotification = () => hold.promise;
  try {
    await assert.rejects(f.runtime.request('thread/goal/set', {}, undefined, {
      beforeWrite() { begins++; f.notification(); }, acknowledge() {},
    }), /pending/);
    assert.equal(begins, 1); assert.equal(f.writes.length, 0);
    assert.equal(f.runtime.pending.size, 0); assert.equal(f.runtime.goalWriteReceipts.size, 0);
    hold.resolve(); await f.runtime.nativeObservations.drain();
    const order: string[] = [];
    const effect = f.runtime.request('thread/goal/set', {}, undefined, {
      beforeWrite() { order.push('begin'); }, acknowledge() {},
    });
    order.push('returned');
    assert.equal(f.writes.length, 1); assert.deepEqual(order, ['begin', 'returned']);
    await effect;
  } finally { hold.resolve(); await f.cleanup(); }
});

for (const replacement of ['beforeWrite', 'trace'] as const) {
  test(`Original Goal final write refuses connection ABA introduced by ${replacement}`, async () => {
    const f = fixture();
    const replace = () => { f.runtime.setConnection('replacement'); f.runtime.setConnection('original'); };
    try {
      await assert.rejects(f.runtime.request('thread/goal/set', {}, undefined, {
        beforeWrite() { if (replacement === 'beforeWrite') replace(); }, acknowledge() {},
        trace(event: string) { if (replacement === 'trace' && event === 'dispatch_started') replace(); },
      }), /connection changed/);
      assert.equal(f.writes.length, 0); assert.equal(f.runtime.pending.size, 0);
    } finally { await f.cleanup(); }
  });
}
