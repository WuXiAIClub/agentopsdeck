import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { WebSocketServer, type WebSocket } from 'ws';
import { GatewayWsClient, type GatewayAsyncObserver, type GatewayWsClientOptions } from './ws-client.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { GatewayRpcError } from './rpc-error.js';
import { shouldUseOpenClawCliFallback } from '../openclaw/cli.js';
import { createHistoryRefresh, gatewayHistoryRows } from '../refresh/history.js';
import { SynchronousEffectAuthorityError } from '../auth/synchronous-effect-authority.js';

async function fixture(t: test.TestContext, respond: (socket: WebSocket, request: any) => void,
  onEvent?: (event: any) => void, onConnectionChange?: (id: string | undefined) => void,
  asyncOptions: Pick<GatewayWsClientOptions, 'asyncObserver' | 'diagnostics'> = {}) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  server.on('connection', (socket) => {
    // Malformed JSON values must not crash either handshake or RPC parsing.
    for (const value of [null, [], 7]) socket.send(JSON.stringify(value));
    socket.send(JSON.stringify({ type: 'event', event: 'connect.challenge' }));
    socket.on('message', (raw) => {
      const request = JSON.parse(raw.toString());
      if (request.method === 'connect') socket.send(JSON.stringify({ type: 'res', id: request.id, ok: true }));
      else respond(socket, request);
    });
  });
  const client = new GatewayWsClient({ url: `ws://127.0.0.1:${(server.address() as { port: number }).port}`,
    ownerToken: undefined, password: undefined, ...asyncOptions,
    ...(onConnectionChange ? { onConnectionChange } : {}), ...(onEvent ? { onEvent } : {}) });
  t.after(async () => { await client.closeAndDrain(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  return client;
}

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function until(check: () => boolean) {
  const deadline = Date.now() + 10_000;
  while (!check()) { assert.ok(Date.now() < deadline, 'Gateway observation did not converge'); await new Promise<void>(r => setImmediate(r)); }
}
const ack = (socket: WebSocket, request: any) => socket.send(JSON.stringify({ type: 'res', id: request.id, ok: true, payload: true }));

test('Gateway rejects mixed and incomplete async observers before opening transport', () => {
  const base = { url: undefined, ownerToken: undefined, password: undefined };
  const asyncObserver: GatewayAsyncObserver = { event: async () => {}, connectionChanged: async () => {}, unavailable: () => {} };
  for (const legacy of [{ onEvent: () => {} }, { onConnectionChange: () => {} }])
    assert.throws(() => new GatewayWsClient({ ...base, ...legacy, asyncObserver }), /cannot be combined/);
  for (const missing of ['event', 'connectionChanged', 'unavailable']) {
    const incomplete = { ...asyncObserver } as any; delete incomplete[missing];
    assert.throws(() => new GatewayWsClient({ ...base, asyncObserver: incomplete }), /Complete/);
  }
});

test('async Gateway connection/event FIFO drains before new effects, while reads and exact stop bypass it', async t => {
  const gate = deferred(), order: string[] = [], writes: string[] = [];
  let wire!: WebSocket, received = false;
  const client = await fixture(t, (socket, request) => { wire = socket; writes.push(request.method); ack(socket, request); }, undefined, undefined,
    { asyncObserver: {
      connectionChanged: async id => { order.push(id ? 'connect' : 'disconnect'); }, unavailable: () => assert.fail('healthy observer'),
      event: async (_event, id) => { received = true; assert.equal(id, client.connectionId()); order.push('event');
        await client.request('chat.history'); await gate.promise; order.push('commit'); },
    } });
  try {
    await client.request('sessions.list'); await client.drainObservers();
    const connection = client.connectionId()!;
    wire.send(JSON.stringify({ type: 'event', event: 'chat', payload: { text: 'private text' } }));
    await until(() => received);
    let sent = false;
    const effect = client.requestBound('agent', {}, connection).then(() => { sent = true; });
    await client.requestBound('chat.abort', { runId: 'original-run' }, connection);
    await client.requestBound('agent.wait', { runId: 'original-run' }, connection);
    assert.equal(sent, false); assert.ok(!writes.includes('agent'));
    gate.resolve(); await effect;
    assert.deepEqual(order, ['connect', 'event', 'commit']); assert.equal(writes.at(-1), 'agent');
    await client.closeAndDrain(); assert.equal(order.at(-1), 'disconnect');
  } finally { gate.resolve(); }
});

test('async Gateway rejects a snapshot-barrier effect when later observations remain pending', async t => {
  const first = deferred(), second = deferred(); let wire!: WebSocket, entered = 0;
  const writes: string[] = [];
  const client = await fixture(t, (socket, request) => { wire = socket; writes.push(request.method); ack(socket, request); }, undefined, undefined,
    { asyncObserver: { connectionChanged: async () => {}, unavailable: () => assert.fail('no observation failure'),
      event: async () => { if (++entered === 1) await first.promise; else await second.promise; } } });
  try {
    await client.request('sessions.list'); await client.drainObservers();
    wire.send('{"type":"event","event":"first"}'); await until(() => entered === 1);
    const denied = assert.rejects(client.requestBound('agent', {}, client.connectionId()), /observations unavailable or pending/);
    wire.send('{"type":"event","event":"second"}'); await until(() => client.status().observerPending === 2);
    first.resolve(); await denied; assert.equal(client.status().observerFailed, false);
    assert.deepEqual(writes, ['sessions.list']);
    second.resolve(); await client.drainObservers(); await client.request('agent');
    assert.deepEqual(writes, ['sessions.list', 'agent']);
  } finally { first.resolve(); second.resolve(); }
});

test('Gateway close synchronously freezes transport and retains original event commit plus disconnect', async t => {
  const gate = deferred(), disconnectGate = deferred(); let wire!: WebSocket, entered = false, disconnected = false;
  const ids: (string | undefined)[] = [];
  const client = await fixture(t, (socket, request) => { wire = socket; ack(socket, request); }, undefined, undefined,
    { asyncObserver: { event: async (_event, id) => { ids.push(id); entered = true; await gate.promise; }, unavailable: () => {},
      connectionChanged: async id => { ids.push(id); if (!id) { disconnected = true; await disconnectGate.promise; } } } });
  try {
    await client.request('sessions.list'); await client.drainObservers(); const original = client.connectionId();
    wire.send('{"type":"event","event":"final"}'); await until(() => entered);
    let closed = false; const close = client.closeAndDrain(); assert.equal(client.closeAndDrain(), close);
    assert.equal(client.close(), undefined, 'legacy synchronous close retains its void result');
    void close.then(() => { closed = true; });
    assert.equal(client.connectionId(), undefined); await assert.rejects(client.request('agent'), /closed/);
    assert.equal(closed, false); gate.resolve(); await until(() => disconnected);
    assert.equal(closed, false); assert.deepEqual(ids, [original, original, undefined]);
    disconnectGate.resolve(); await close; assert.equal(client.status().observerPending, 0);
  } finally { gate.resolve(); disconnectGate.resolve(); }
});

test('Gateway observer can reenter close without stranding the published drain', async t => {
  let wire!: WebSocket, close: Promise<void> | undefined, disconnected = false;
  const client = await fixture(t, (socket, request) => { wire = socket; ack(socket, request); }, undefined, undefined,
    { asyncObserver: { event: async () => { close = client.closeAndDrain(); }, unavailable: () => {},
      connectionChanged: async id => { if (!id) disconnected = true; } } });
  await client.request('sessions.list'); await client.drainObservers();
  wire.send('{"type":"event","event":"close"}'); await until(() => !!close); await close;
  assert.equal(disconnected, true); assert.equal(client.status().observerPending, 0);
});

for (const failure of ['event', 'connection', 'count', 'bytes'] as const) {
  test(`async Gateway ${failure} failure latches a sanitized veto, retains reads/stop, drains accepted work`, async t => {
    const gate = deferred(), logs: string[] = [], writes: string[] = [];
    let wire!: WebSocket, veto = 0, entered = 0;
    const client = await fixture(t, (socket, request) => { wire = socket; writes.push(request.method); ack(socket, request); }, undefined, undefined,
      { diagnostics: new PerformanceDiagnostics(line => logs.push(line)), asyncObserver: {
        connectionChanged: async id => { if (id && failure === 'connection') throw Error('private credential'); },
        event: async () => { entered++; if (failure === 'event') throw Error('private credential'); await gate.promise; },
        unavailable: () => { veto++; throw Error('private callback failure'); },
      } });
    try {
      await client.request('sessions.list'); await client.drainObservers();
      if (failure === 'event') wire.send('{"type":"event","event":"private credential"}');
      if (failure === 'count') {
        for (let i = 0; i < 129; i++) wire.send('{"type":"event","event":"bounded"}');
      }
      if (failure === 'bytes') wire.send(JSON.stringify({ type: 'event', event: 'bounded', data: 'x'.repeat(8 * 1024 * 1024) }));
      await until(() => client.status().observerFailed);
      assert.equal(veto, 1);
      for (const method of ['agent', 'chat.send', 'sessions.create', 'sessions.patch', 'sessions.delete'])
        await assert.rejects(client.request(method), /observations unavailable/);
      await client.requestBound('chat.abort', { runId: 'original-run' }, client.connectionId());
      await client.request('sessions.list');
      assert.deepEqual(writes, ['sessions.list', 'chat.abort', 'sessions.list']);
      assert.ok(client.status().observerPending <= 128);
      gate.resolve(); await client.closeAndDrain(); assert.equal(client.status().observerPending, 0);
      assert.equal(entered, failure === 'count' ? 128 : failure === 'event' ? 1 : 0);
      assert.ok(logs.some(line => line.includes('gateway-observation')));
      assert.ok(!logs.join('').includes('private'));
    } finally { gate.resolve(); }
  });
}

test('prepare write connection sends no agent call, and bound send never reconnects a replaced identity', async t => {
  let writes = 0;
  const client = await fixture(t, (socket, request) => {
    writes++; socket.send(JSON.stringify({ type: 'res', id: request.id, ok: true, payload: { runId: 'run' } }));
  });
  const original = await client.prepareWriteConnection();
  assert.equal(original, client.connectionId()); assert.equal(writes, 0);
  const reply = await client.requestBound('agent', {}, original);
  assert.equal(reply.connectionId, original); assert.equal(writes, 1);
  client.close();
  await assert.rejects(client.requestBound('agent', {}, original));
  await assert.rejects(client.prepareWriteConnection()); assert.equal(writes, 1);
});

test('bound write guard runs after handshake without pending work and cannot poison the connection', async (t) => {
  const writes: string[] = [];
  let connected = false;
  const client = await fixture(t, (socket, request) => {
    writes.push(request.method);
    socket.send(JSON.stringify({ type: 'res', id: request.id, ok: true, payload: true }));
  }, undefined, id => { connected = !!id; });
  const denied = new Error('synthetic authority revoked');
  await assert.rejects(client.requestBound('agent', {}, undefined, () => {
    assert.equal(connected, true);
    assert.equal(client.status().pending, 0);
    throw denied;
  }), error => error === denied);
  assert.equal(client.status().pending, 0);
  assert.equal(client.status().degraded, false);
  await client.request('sessions.list'); // wire barrier: no rejected agent request can be hidden in flight
  assert.deepEqual(writes, ['sessions.list']);
});

for (const bound of [false, true]) {
  for (const kind of ['async', 'promise', 'late-rejection', 'thenable'] as const) {
    test(`${bound ? 'connection-bound' : 'handshaking'} Gateway write denies ${kind} authority without allocating or sending`, async t => {
      const writes: string[] = [];
      const client = await fixture(t, (socket, request) => {
        writes.push(request.method);
        socket.send(JSON.stringify({ type: 'res', id: request.id, ok: true, payload: true }));
      });
      if (bound) await client.request('sessions.list');
      let calls = 0, thenReads = 0, reject!: (error: Error) => void;
      const late = new Promise<void>((_, no) => { reject = no; });
      const guard = kind === 'async' ? async () => { calls++; }
        : () => {
          calls++;
          if (kind === 'promise') return Promise.resolve();
          if (kind === 'late-rejection') return late;
          return { get then() { thenReads++; throw Error('private thenable'); } };
        };
      await assert.rejects(client.requestBound('agent', {}, bound ? client.connectionId() : undefined, guard),
        SynchronousEffectAuthorityError);
      if (kind === 'late-rejection') reject(Error('private delayed authority failure'));
      await client.request('sessions.list'); // Protocol barrier, not a timer.
      assert.deepEqual(writes, bound ? ['sessions.list', 'sessions.list'] : ['sessions.list']);
      assert.equal(calls, kind === 'async' ? 0 : 1);
      assert.equal(thenReads, 0);
      assert.equal(client.status().pending, 0);
      assert.equal(client.status().degraded, false);
    });
  }
}

test('session creation rechecks authority after real Gateway handshake with zero unauthorized writes', async t => {
  let allowed = true;
  const writes: string[] = [];
  const client = await fixture(t, (socket, request) => {
    writes.push(request.method); socket.send(JSON.stringify({ type: 'res', id: request.id, ok: true, payload: {} }));
  }, undefined, id => { if (id) allowed = false; });
  await assert.rejects(client.requestBound('sessions.create', { agentId: 'main' }, undefined, () => {
    if (!allowed) throw new Error('create authority revoked');
  }), /create authority revoked/);
  await client.request('sessions.list');
  assert.deepEqual(writes, ['sessions.list']);
  assert.equal(client.status().pending, 0);
});

test('already-connected unbound dispatch rechecks its guard after the connection await', async (t) => {
  const writes: string[] = [];
  const client = await fixture(t, (socket, request) => {
    writes.push(request.method);
    socket.send(JSON.stringify({ type: 'res', id: request.id, ok: true, payload: true }));
  });
  await client.request('sessions.list');
  let allowed = true;
  const pending = client.requestBound('agent', {}, undefined, () => {
    if (!allowed) throw new Error('revoked during microtask');
  });
  allowed = false;
  await assert.rejects(pending, /revoked during microtask/);
  await client.request('sessions.list');
  assert.deepEqual(writes, ['sessions.list', 'sessions.list']);
  assert.equal(client.status().pending, 0);
});

test('guard closing its captured socket cannot allocate a pending write', async (t) => {
  const client = await fixture(t, () => assert.fail('must not write'));
  await assert.rejects(client.requestBound('agent', {}, undefined, () => client.close()), /connection changed/);
  assert.equal(client.status().pending, 0);
});

test('expected-connection control remains synchronous through guard and native write', async (t) => {
  const client = await fixture(t, (socket, request) => {
    socket.send(JSON.stringify({ type: 'res', id: request.id, ok: true, payload: true }));
  });
  await client.request('sessions.list');
  let guarded = false;
  const pending = client.requestBound('chat.abort', { runId: 'synthetic-run' }, client.connectionId(), () => { guarded = true; });
  assert.equal(guarded, true);
  assert.equal(client.status().pending, 1);
  assert.equal((await pending).payload, true);
});

test('connection observers see authenticated generations and one retirement even when they throw', async (t) => {
  const changes: (string | undefined)[] = [];
  const client = await fixture(t, (socket, request) => {
    socket.send(JSON.stringify({ type: 'res', id: request.id, ok: true, payload: true }));
  }, undefined, (id) => { changes.push(id); throw new Error('synthetic observer failure'); });
  assert.deepEqual(changes, []);
  await client.request('sessions.list');
  const first = client.connectionId();
  assert.ok(first);
  assert.deepEqual(changes, [first]);
  const oldSocket = (client as unknown as { socket: WebSocket }).socket;
  const closed = once(oldSocket, 'close'); oldSocket.terminate(); await closed;
  assert.deepEqual(changes, [first, undefined]);
  await client.request('sessions.list');
  const second = client.connectionId();
  assert.ok(second); assert.notEqual(first, second);
  oldSocket.emit('close', 1006, Buffer.alloc(0));
  oldSocket.emit('error', new Error('retired error'));
  assert.deepEqual(changes, [first, undefined, second]);
  const active = (client as unknown as { socket: WebSocket }).socket;
  active.emit('error', new Error('active error'));
  assert.equal(client.connectionId(), undefined);
  client.close(); client.close();
  assert.deepEqual(changes, [first, undefined, second, undefined]);
  assert.equal(client.status().pending, 0);
});

test('bound replies carry local connection identity and stale queries never reconnect or dispatch', async (t) => {
  const methods: string[] = [];
  const client = await fixture(t, (socket, request) => {
    methods.push(request.method);
    socket.send(JSON.stringify({ type: 'res', id: request.id, ok: true,
      payload: { runId: 'synthetic-run', connectionId: 'untrusted-wire-field' } }));
  });
  await assert.rejects(client.requestBound('agent.wait', { runId: 'synthetic-run', timeoutMs: 0 }, 'stale'), /connection changed/);
  assert.equal(client.connectionId(), undefined);
  const accepted = await client.requestBound<{ runId: string }>('agent', { sessionKey: 'synthetic' });
  assert.ok(accepted.connectionId);
  assert.notEqual(accepted.connectionId, 'untrusted-wire-field');
  assert.equal(accepted.connectionId, client.connectionId());
  const snapshot = await client.requestBound('agent.wait', { runId: accepted.payload.runId, timeoutMs: 0 }, accepted.connectionId);
  assert.equal(snapshot.connectionId, accepted.connectionId);
  const socket = (client as unknown as { socket: WebSocket }).socket;
  const closed = once(socket, 'close'); socket.terminate(); await closed;
  await assert.rejects(client.requestBound('agent.wait', {}, accepted.connectionId), /connection changed/);
  assert.equal(client.connectionId(), undefined);
  await client.request('chat.send', {});
  assert.notEqual(client.connectionId(), accepted.connectionId);
  await assert.rejects(client.requestBound('agent.wait', {}, accepted.connectionId), /connection changed/);
  assert.deepEqual(methods, ['agent', 'agent.wait', 'chat.send']);
});

test('bound query rechecks connection after parameter capture without opening a replacement', async (t) => {
  let calls = 0;
  const client = await fixture(t, (socket, request) => {
    calls++;
    socket.send(JSON.stringify({ type: 'res', id: request.id, ok: true, payload: {} }));
  });
  const accepted = await client.requestBound('agent', {});
  const socket = (client as unknown as { socket: WebSocket }).socket;
  const closed = once(socket, 'close');
  await assert.rejects(client.requestBound('agent.wait', { toJSON() { socket.terminate(); return {}; } }, accepted.connectionId), /disconnected before send/);
  await closed;
  assert.equal(client.connectionId(), undefined);
  assert.equal(calls, 1);
  assert.equal(client.status().pending, 0);
});

test('run-bound abort uses the original socket and cannot reconnect or target its replacement', async (t) => {
  const calls: { method: string; params: unknown }[] = [];
  const client = await fixture(t, (socket, request) => {
    calls.push({ method: request.method, params: request.params });
    socket.send(JSON.stringify({ type: 'res', id: request.id, ok: true, payload: { ok: true, aborted: true, runIds: ['native'] } }));
  });
  const params = { sessionKey: 'synthetic', runId: 'native' };
  await assert.rejects(client.requestBound('chat.abort', params, 'missing'), /connection changed/);
  assert.equal(client.connectionId(), undefined);
  await client.request('sessions.list');
  const connection = client.connectionId()!;
  const result = await client.requestBound('chat.abort', params, connection);
  assert.equal(result.connectionId, connection);
  const socket = (client as unknown as { socket: WebSocket }).socket;
  const closed = once(socket, 'close'); socket.terminate(); await closed;
  await assert.rejects(client.requestBound('chat.abort', params, connection), /connection changed/);
  assert.equal(client.connectionId(), undefined);
  await client.request('sessions.list');
  await assert.rejects(client.requestBound('chat.abort', params, connection), /connection changed/);
  assert.deepEqual(calls.filter(call => call.method === 'chat.abort'), [{ method: 'chat.abort', params }]);
  assert.equal(client.status().pending, 0);
});

test('retired socket close/error/message callbacks cannot affect a replacement connection', async (t) => {
  let reply: (() => void) | undefined;
  let received!: () => void;
  const waiting = new Promise<void>((resolve) => { received = resolve; });
  let events = 0;
  const client = await fixture(t, (socket, request) => {
    if (request.params.hold) {
      reply = () => socket.send(JSON.stringify({ type: 'res', id: request.id, ok: true, payload: 'new' }));
      received();
    } else socket.send(JSON.stringify({ type: 'res', id: request.id, ok: true, payload: 'old' }));
  }, () => { events++; });
  await client.request('chat.send');
  const oldSocket = (client as unknown as { socket: WebSocket }).socket;
  const closed = once(oldSocket, 'close');
  oldSocket.terminate();
  await closed;
  const request = client.request('chat.send', { hold: true });
  const result = assert.doesNotReject(async () => assert.equal(await request, 'new'));
  await waiting;
  oldSocket.emit('close', 1006, Buffer.alloc(0));
  oldSocket.emit('error', new Error('late retired socket error'));
  oldSocket.emit('message', Buffer.from(JSON.stringify({ type: 'event', event: 'agent' })));
  reply!();
  await result;
  assert.equal(client.status().connected, true);
  assert.equal(client.status().pending, 0);
  assert.equal(events, 0);
});

test('active socket error retires pending work without replay before a critical reconnect', async (t) => {
  let received!: () => void;
  const waiting = new Promise<void>((resolve) => { received = resolve; });
  let calls = 0;
  const client = await fixture(t, (socket, request) => {
    calls++;
    if (request.params.hold) received();
    else socket.send(JSON.stringify({ type: 'res', id: request.id, ok: true, payload: 'replacement' }));
  });
  const rejected = assert.rejects(client.request('agent', { hold: true }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /socket error/);
    assert.equal(shouldUseOpenClawCliFallback(error, 'agent'), false);
    return true;
  });
  await waiting;
  const oldSocket = (client as unknown as { socket: WebSocket }).socket;
  oldSocket.emit('error', new Error('synthetic active socket failure'));
  await rejected;
  assert.equal(client.status().pending, 0);
  assert.equal(client.status().connected, false);
  assert.equal(client.status().degraded, true);
  assert.equal(await client.request('chat.send'), 'replacement');
  oldSocket.emit('error', new Error('second late error'));
  oldSocket.emit('close', 1006, Buffer.alloc(0));
  assert.equal(client.status().connected, true);
  assert.equal(calls, 2);
});

test('a completed request late send error cannot reject a later request', async (t) => {
  let reply: (() => void) | undefined;
  let received!: () => void;
  const waiting = new Promise<void>((resolve) => { received = resolve; });
  const client = await fixture(t, (socket, request) => {
    if (request.params.hold) {
      reply = () => socket.send(JSON.stringify({ type: 'res', id: request.id, ok: true, payload: 'later' }));
      received();
    } else socket.send(JSON.stringify({ type: 'res', id: request.id, ok: true, payload: 'done' }));
  });
  await client.request('chat.send');
  const socket = (client as unknown as { socket: WebSocket }).socket;
  const original = socket.send.bind(socket);
  let lateCallback!: (error?: Error) => void;
  socket.send = ((data: string, callback: (error?: Error) => void) => {
    lateCallback = callback;
    original(data);
  }) as typeof socket.send;
  assert.equal(await client.request('chat.send'), 'done');
  socket.send = original;
  const request = client.request('chat.send', { hold: true });
  const result = assert.doesNotReject(async () => assert.equal(await request, 'later'));
  await waiting;
  lateCallback(new Error('late completed write callback'));
  reply!();
  await result;
  assert.equal(client.status().connected, true);
  assert.equal(client.status().degraded, false);
});

test('only a matching negative RPC preserves method/code as Gateway rejection evidence', async (t) => {
  const client = await fixture(t, (socket, request) => socket.send(JSON.stringify({ type: 'res', id: request.id,
    ok: false, error: { code: 'INVALID_REQUEST', message: 'missing scope: operator.write' } })));
  for (const method of ['agent', 'sessions.create'] as const) {
    await assert.rejects(client.request(method), (error: unknown) => {
      assert.ok(error instanceof GatewayRpcError);
      assert.equal(error.method, method);
      assert.equal(error.code, 'INVALID_REQUEST');
      assert.equal(shouldUseOpenClawCliFallback(error, method), true);
      return true;
    });
    assert.equal(client.status().pending, 0);
  }
});

test('event IDs, legacy aliases, unknown responses and malformed values cannot settle an RPC', async (t) => {
  let events = 0;
  const client = await fixture(t, (socket, request) => {
    for (const frame of [null, [], false,
      { type: 'event', event: 'agent', id: request.id, ok: false, error: 'missing scope: operator.write' },
      { kind: 'event', id: request.id, payload: 'event' },
      { type: 'res', id: 'another-request', ok: true, payload: 'unrelated' },
      { id: request.id, ok: true, payload: 'missing-type' },
      { type: 'res', requestId: request.id, ok: true, payload: 'alias' },
    ]) socket.send(JSON.stringify(frame));
    socket.send(JSON.stringify({ type: 'res', id: request.id, ok: true, payload: { runId: 'accepted' } }));
  }, () => { events++; });
  assert.deepEqual(await client.request('agent'), { runId: 'accepted' });
  assert.equal(events, 2);
  assert.equal(client.status().pending, 0);
});

test('malformed and contradictory matching responses fail without fallback evidence', async (t) => {
  const frames = [
    { ok: false, error: 'missing scope: operator.write' },
    { ok: false, error: { message: 'missing scope: operator.write' } },
    { ok: true, error: { code: 'INVALID_REQUEST', message: 'missing scope: operator.write' } },
    { error: { code: 'INVALID_REQUEST', message: 'missing scope: operator.write' } },
    { ok: 'true' }, { ok: false },
  ];
  const client = await fixture(t, (socket, request) => socket.send(JSON.stringify({ type: 'res', id: request.id, ...frames.shift() })));
  while (frames.length) await assert.rejects(client.request('agent'), (error: unknown) => {
    assert.ok(error instanceof Error && !(error instanceof GatewayRpcError));
    assert.equal(shouldUseOpenClawCliFallback(error, 'agent'), false);
    return true;
  });
  assert.equal(client.status().pending, 0);
});

test('disconnect after dispatch remains uncertain, not a scope rejection', async (t) => {
  const client = await fixture(t, (socket) => socket.close(1000, 'missing scope: operator.write'));
  await assert.rejects(client.request('agent'), (error: unknown) => {
    assert.ok(error instanceof Error && !(error instanceof GatewayRpcError));
    assert.equal(shouldUseOpenClawCliFallback(error, 'agent'), false);
    return true;
  });
  assert.equal(client.status().pending, 0);
});

test('concurrent history reads isolate sessions and filters while identical reads share one RPC', async (t) => {
  const inputs = [{ sessionKey: 'session-a', limit: 10 }, { sessionKey: 'session-b', limit: 10 },
    { sessionKey: 'session-a', limit: 20 }, { sessionKey: 'session-a', limit: 10, before: 'older-page' }];
  const received: any[] = [];
  const client = await fixture(t, (socket, request) => {
    received.push(request);
    if (received.length === inputs.length) for (const row of [...received].reverse()) {
      socket.send(JSON.stringify({ type: 'res', id: row.id, ok: true, payload: { historyFor: row.params } }));
    }
  });
  const expected = [...inputs, inputs[0]!];
  const requests = Promise.all(expected.map((params) => client.request('chat.history', params)));
  assert.equal(client.status().inflightReads, inputs.length);
  assert.deepEqual(await requests, expected.map((historyFor) => ({ historyFor })));
  assert.equal(received.length, inputs.length);
  assert.equal(client.status().inflightReads, 0);
  assert.equal(client.status().pending, 0);
});

for (const identityFirst of [false, true]) test(`payload and connection-aware reads share one native request (identity first: ${identityFirst})`, async t => {
  let calls = 0;
  const client = await fixture(t, (socket, request) => {
    calls++;
    socket.send(JSON.stringify({ type: 'res', id: request.id, ok: true, payload: ['synthetic'] }));
  });
  const read = () => client.request('sessions.list', { limit: 100 });
  const identified = () => client.requestWithConnection('sessions.list', { limit: 100 });
  const first = identityFirst ? identified() : read();
  const second = identityFirst ? read() : identified();
  assert.equal(client.status().inflightReads, 1);
  const results = await Promise.all([first, second]);
  assert.deepEqual(results[identityFirst ? 0 : 1], { payload: ['synthetic'], connectionId: client.connectionId() });
  assert.deepEqual(results[identityFirst ? 1 : 0], ['synthetic']);
  assert.equal(calls, 1);
  assert.equal(client.status().pending, 0);
  assert.equal(client.status().inflightReads, 0);
});

test('connection-aware read keeps the sending socket identity across reconnect', async t => {
  const client = await fixture(t, (socket, request) => {
    socket.send(JSON.stringify({ type: 'res', id: request.id, ok: true, payload: [] }));
  });
  const old = await client.requestWithConnection('sessions.list');
  const oldId = client.connectionId();
  const socket = (client as any).socket as WebSocket;
  const closed = once(socket, 'close'); socket.terminate(); await closed;
  const current = await client.requestWithConnection('sessions.list');
  assert.ok(oldId);
  assert.equal(old.connectionId, oldId);
  assert.equal(current.connectionId, client.connectionId());
  assert.notEqual(current.connectionId, old.connectionId);
});

test('mixed read interfaces share rejection and release their capacity for retry', async t => {
  let calls = 0;
  const client = await fixture(t, (socket, request) => {
    calls++;
    socket.send(JSON.stringify({ type: 'res', id: request.id, ok: calls > 1,
      ...(calls > 1 ? { payload: [] } : { error: { code: 'UNAVAILABLE', message: 'synthetic' } }) }));
  });
  await Promise.all([assert.rejects(client.request('sessions.list')), assert.rejects(client.requestWithConnection('sessions.list'))]);
  assert.equal(calls, 1);
  assert.equal(client.status().inflightReads, 0);
  assert.deepEqual((await client.requestWithConnection('sessions.list')).payload, []);
  assert.equal(calls, 2);
});

test('post-terminal history refresh passes both projection and Gateway in-flight coalescing barriers', async (t) => {
  let release!: () => void, started!: () => void;
  const waiting = new Promise<void>((resolve) => { started = resolve; });
  let calls = 0;
  const client = await fixture(t, (socket, request) => {
    const index = ++calls;
    const respond = () => socket.send(JSON.stringify({ type: 'res', id: request.id, ok: true,
      payload: { sessionKey: 'synthetic', messages: [{ role: 'assistant', text: index === 1 ? 'old' : 'final' }] } }));
    if (index === 1) { release = respond; started(); } else respond();
  });
  const projections: string[] = [];
  const refresh = createHistoryRefresh(async (key) => {
    const rows = gatewayHistoryRows(await client.request('chat.history', { sessionKey: key, limit: 400 }), key);
    projections.push(rows[0].text);
  });
  const old = refresh('synthetic'); await waiting;
  const fresh = refresh('synthetic', { fresh: true });
  assert.equal(calls, 1);
  release(); await Promise.all([old, fresh]);
  assert.equal(calls, 2);
  assert.deepEqual(projections, ['old', 'final']);
  assert.equal(client.status().inflightReads, 0);
});

test('read coalescing also isolates other methods and parameters', async (t) => {
  let calls = 0;
  const client = await fixture(t, (socket, request) => {
    calls++;
    socket.send(JSON.stringify({ type: 'res', id: request.id, ok: true, payload: { method: request.method, params: request.params } }));
  });
  const specs = [{ method: 'sessions.list', params: { limit: 10 } }, { method: 'sessions.list', params: { limit: 20 } },
    { method: 'agents.list', params: { limit: 10 } }, { method: 'diagnostics.stability', params: { limit: 10 } }];
  assert.deepEqual(await Promise.all(specs.map(({ method, params }) => client.request(method, params))), specs);
  assert.equal(calls, specs.length);
});

test('parameters are captured before handshake without retaining caller-owned mutable objects', async (t) => {
  let calls = 0;
  const client = await fixture(t, (socket, request) => {
    calls++;
    socket.send(JSON.stringify({ type: 'res', id: request.id, ok: true, payload: request.params }));
  });
  const params = { sessionKey: 'original', filters: { tags: ['one'] } };
  const first = client.request('chat.history', params);
  params.sessionKey = 'changed'; params.filters.tags.push('two');
  const original = { sessionKey: 'original', filters: { tags: ['one'] } };
  const same = client.request('chat.history', original);
  const changed = client.request('chat.history', params);
  assert.deepEqual(await Promise.all([first, same, changed]), [original, original, params]);
  assert.equal(calls, 2);
});

test('writes retain encoded parameters across connect and are never coalesced', async (t) => {
  let calls = 0;
  const client = await fixture(t, (socket, request) => {
    calls++;
    socket.send(JSON.stringify({ type: 'res', id: request.id, ok: true, payload: request.params }));
  });
  const params = { sessionKey: 'synthetic', message: 'quote" slash\\ newline\n 中文', attachments: [{ content: 'dGVzdA==' }] };
  const expected = JSON.parse(JSON.stringify(params));
  const first = client.request('agent', params), second = client.request('agent', params);
  params.message = 'changed'; params.attachments[0]!.content = 'changed';
  assert.deepEqual(await Promise.all([first, second]), [expected, expected]);
  assert.equal(calls, 2);
});

test('unserializable parameters allocate no connection, pending request or dedupe entry', async (t) => {
  const client = await fixture(t, () => assert.fail('invalid request must not be sent'));
  const params: Record<string, unknown> = {}; params.self = params;
  await assert.rejects(client.request('chat.history', params), /circular/i);
  assert.equal(client.status().connected, false);
  assert.equal(client.status().pending, 0);
  assert.equal(client.status().inflightReads, 0);
});

test('a rejected shared read clears its key and the next read makes a fresh request', async (t) => {
  let calls = 0;
  const client = await fixture(t, (socket, request) => {
    calls++;
    socket.send(JSON.stringify(calls === 1 ? { type: 'res', id: request.id, ok: false,
      error: { code: 'UNAVAILABLE', message: 'synthetic read failure' } }
      : { type: 'res', id: request.id, ok: true, payload: 'fresh' }));
  });
  const params = { sessionKey: 'synthetic' };
  const results = await Promise.allSettled([client.request('chat.history', params), client.request('chat.history', params)]);
  assert.ok(results.every((result) => result.status === 'rejected'));
  assert.equal(calls, 1);
  assert.equal(client.status().inflightReads, 0);
  assert.equal(await client.request('chat.history', params), 'fresh');
  assert.equal(calls, 2);
});

test('distinct read admission is bounded, duplicates share full capacity, and slots are reusable', async (t) => {
  let replyImmediately = false, calls = 0;
  const replies: Array<() => void> = [];
  let allReceived!: () => void;
  const received = new Promise<void>((resolve) => { allReceived = resolve; });
  const client = await fixture(t, (socket, request) => {
    calls++;
    const reply = () => socket.send(JSON.stringify({ type: 'res', id: request.id, ok: true, payload: request.params.sessionKey }));
    if (replyImmediately) reply();
    else { replies.push(reply); if (replies.length === 64) allReceived(); }
  });
  const pending = Promise.all(Array.from({ length: 64 }, (_, index) => client.request('chat.history', { sessionKey: String(index) })));
  const duplicate = client.request('chat.history', { sessionKey: '0' });
  await assert.rejects(client.request('chat.history', { sessionKey: 'overflow' }), /read capacity exceeded/);
  await received;
  assert.equal(client.status().pending, 64);
  assert.equal(client.status().inflightReads, 64);
  replies.forEach((reply) => reply());
  assert.deepEqual(await pending, Array.from({ length: 64 }, (_, index) => String(index)));
  assert.equal(await duplicate, '0');
  assert.equal(calls, 64);
  assert.equal(client.status().inflightReads, 0);
  replyImmediately = true;
  assert.equal(await client.request('chat.history', { sessionKey: 'overflow' }), 'overflow');
  assert.equal(calls, 65);
});

test('events before authentication never escape on initial or replacement connections', async (t) => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const events: string[] = [];
  let connections = 0;
  server.on('connection', (socket) => {
    const generation = ++connections;
    const event = (phase: string) => socket.send(JSON.stringify({ type: 'event', event: 'agent', payload: `${generation}:${phase}` }));
    event('before-challenge');
    socket.send(JSON.stringify({ type: 'event', event: 'connect.challenge' }));
    socket.on('message', (raw) => {
      const request = JSON.parse(raw.toString());
      if (request.method === 'connect') {
        event('before-ack');
        socket.send(JSON.stringify({ type: 'res', id: 'wrong-handshake', ok: true }));
        event('after-wrong-ack');
        socket.send(JSON.stringify({ type: 'res', id: request.id, ok: true }));
        event('authenticated');
      } else socket.send(JSON.stringify({ type: 'res', id: request.id, ok: true, payload: generation }));
    });
  });
  const client = new GatewayWsClient({ url: `ws://127.0.0.1:${(server.address() as { port: number }).port}`,
    ownerToken: undefined, password: undefined, onEvent: (event) => events.push(event.payload) });
  t.after(async () => { client.close(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  assert.equal(await client.request('chat.send'), 1);
  const socket = (client as unknown as { socket: WebSocket }).socket;
  const closed = once(socket, 'close'); socket.terminate(); await closed;
  assert.equal(await client.request('chat.send'), 2);
  assert.deepEqual(events, ['1:authenticated', '2:authenticated']);
  assert.equal(client.status().pending, 0);
});

test('handshake only accepts its own response and a boolean success without error', async (t) => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  let sentRequests = 0;
  let events = 0;
  let connectionChanges = 0;
  server.on('connection', (socket) => {
    socket.send(JSON.stringify({ type: 'event', event: 'agent' }));
    socket.send(JSON.stringify({ type: 'res', id: 'before-challenge', ok: true }));
    socket.send(JSON.stringify({ type: 'event', event: 'connect.challenge' }));
    socket.on('message', (raw) => {
      const request = JSON.parse(raw.toString());
      if (request.method !== 'connect') { sentRequests++; return; }
      socket.send(JSON.stringify({ type: 'res', id: 'wrong-id', ok: true }));
      socket.send(JSON.stringify({ type: 'res', id: request.id, ok: 'true' }));
    });
  });
  const client = new GatewayWsClient({ url: `ws://127.0.0.1:${(server.address() as { port: number }).port}`,
    ownerToken: undefined, password: undefined, onEvent: () => { events++; },
    onConnectionChange: () => { connectionChanges++; } });
  t.after(async () => { client.close(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  await assert.rejects(client.request('agent'), /connect failed/);
  assert.equal(sentRequests, 0);
  assert.equal(events, 0);
  assert.equal(connectionChanges, 0);
  assert.equal(client.status().pending, 0);
});

test('close cancels an unfinished Gateway handshake without waiting for its deadline', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address() as { port: number };
  const client = new GatewayWsClient({ url: `ws://127.0.0.1:${address.port}`, ownerToken: undefined, password: undefined });
  try {
    const connected = once(server, 'connection');
    const request = client.request('sessions.list');
    const rejected = assert.rejects(request, /client closed/);
    await connected;
    client.close(); client.close();
    await rejected;
    await assert.rejects(client.request('agent'), /client closed/);
    assert.equal(client.status().inflightReads, 0);
    assert.equal(client.status().pending, 0);
  } finally { client.close(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('close rejects in-flight Gateway writes and frees their timers', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address() as { port: number };
  let admitted!: () => void;
  const received = new Promise<void>((resolve) => { admitted = resolve; });
  server.on('connection', (socket) => {
    socket.send(JSON.stringify({ type: 'event', event: 'connect.challenge' }));
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.method === 'connect') socket.send(JSON.stringify({ type: 'res', id: message.id, ok: true }));
      else admitted();
    });
  });
  const client = new GatewayWsClient({ url: `ws://127.0.0.1:${address.port}`, ownerToken: undefined, password: undefined });
  try {
    const rejected = assert.rejects(client.request('agent'), /client closed/);
    await received;
    assert.equal(client.status().pending, 1);
    client.close();
    await rejected;
    assert.equal(client.status().pending, 0);
  } finally { client.close(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
