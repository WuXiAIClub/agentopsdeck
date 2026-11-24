import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { WebSocketServer } from 'ws';
import { GatewayWsClient } from '../gateway/ws-client.js';
import { MirrorOutbox, createMirrorDispatcher, type MirrorParams } from '../messages/mirror.js';
import { DeckStore } from '../projection/deck-store.js';
import { OpenClawExecutions } from './executions.js';
import { parseGatewayReply } from './gateway-reply.js';
import { createOpenClawDispatch } from './dispatch.js';

const finalEvent = (text = 'original reply', runId = 'native-one', sequence = 9) => ({ event: 'chat', payload: {
  sessionKey: 'synthetic', runId, seq: sequence, state: 'final', message: { role: 'assistant', content: [{ type: 'text', text }] },
} });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function fixture(context: TestContext, maxBytes?: number) {
  const folder = mkdtempSync(join(tmpdir(), 'gateway-reply-'));
  const file = join(folder, 'connector.sqlite'), db = new DatabaseSync(file);
  const outbox = new MirrorOutbox(db, undefined, maxBytes), store = new DeckStore();
  const executions = new OpenClawExecutions(db, undefined, undefined, undefined, undefined, undefined, outbox);
  store.bindOpenClawExecutions(executions);
  const params: MirrorParams = { actorId: 'original-actor', sessionKey: 'synthetic', after: 1, idempotencyKey: 'one', inputText: 'original input',
    explicitRoute: { originatingChannel: 'synthetic', originatingTo: 'original-target', outboundTarget: 'original-target' } };
  const begin = (id = 'one', connectionId = 'socket-one') => {
    outbox.upsert({ ...params, idempotencyKey: id });
    assert.equal(executions.begin(params.sessionKey, id), true);
    assert.equal(executions.bindGatewayConnection(params.sessionKey, id, connectionId), true);
  };
  const ack = (id = 'one', runId = 'native-one', commit?: (db: DatabaseSync) => void) => executions.acknowledge(params.sessionKey, id, runId, commit);
  const event = (raw: unknown = finalEvent(), connectionId = 'socket-one') => store.ingestGatewayEvent(raw, connectionId);
  const complete = (runId = 'native-one') => event({ event: 'agent', payload: { sessionKey: 'synthetic', runId,
    stream: 'lifecycle', data: { phase: 'end' } } });
  context.after(() => { db.close(); rmSync(folder, { recursive: true, force: true }); });
  return { file, db, outbox, store, executions, params, begin, ack, event, complete };
}

test('Gateway final parser accepts only the explicit chat final text envelope', () => {
  assert.deepEqual(parseGatewayReply(finalEvent()), { text: 'original reply', sequence: 9 });
  assert.deepEqual(parseGatewayReply({ event: 'chat', payload: { ...finalEvent().payload, message: undefined } }), { text: '', sequence: 9 });
  assert.deepEqual(parseGatewayReply({ event: 'chat', payload: { ...finalEvent().payload,
    message: { role: 'assistant', content: 'text content' } } }), { text: 'text content', sequence: 9 });
});

for (const [name, change] of Object.entries({
  delta: { state: 'delta' }, error: { state: 'error' }, aborted: { state: 'aborted' }, missingRun: { runId: undefined },
  missingSession: { sessionKey: undefined }, missingSequence: { seq: undefined }, negativeSequence: { seq: -1 },
  fractionalSequence: { seq: 1.5 }, overflowingSequence: { seq: Number.MAX_SAFE_INTEGER + 1 }, unsafeStop: { stopReason: 'tool_use' },
  errorPayload: { errorMessage: 'failed' }, userMessage: { message: { role: 'user', content: 'private input' } },
  thinking: { message: { role: 'assistant', content: [{ type: 'thinking', text: 'hidden' }] } },
  unknownContent: { message: { role: 'assistant', content: [{ type: 'future', text: 'unknown' }] } },
  malformedText: { message: { role: 'assistant', content: [{ type: 'text', text: 42 }] } },
  textFallback: { message: { role: 'assistant', text: 'unproven fallback' } },
  oversized: { message: { role: 'assistant', content: 'x'.repeat(1024 * 1024 + 1) } },
})) test(`Gateway final parser rejects ${name}`, () => {
  assert.equal(parseGatewayReply({ event: 'chat', payload: { ...finalEvent().payload, ...change } }), undefined);
});

test('Gateway parser does not accept presentation aliases as native evidence', () => {
  for (const raw of [{ type: 'chat', payload: finalEvent().payload }, { event: 'chat.final', payload: finalEvent().payload },
    { event: 'chat', data: finalEvent().payload }]) assert.equal(parseGatewayReply(raw), undefined);
});

for (const early of [false, true]) test(`Gateway original reply binds atomically with final ${early ? 'before' : 'after'} ACK without inventing completion`, context => {
  const setup = fixture(context);
  setup.begin();
  if (!early) setup.ack();
  setup.event();
  if (early) {
    assert.equal(setup.outbox.get('one')?.nativeReply, undefined);
    setup.ack();
  }
  assert.equal(setup.executions.get('synthetic')?.phase, 'starting');
  assert.equal(setup.outbox.get('one')?.gatewayRun?.state, 'pending');
  setup.complete();
  assert.equal(setup.executions.get('synthetic')?.phase, 'completed');
  assert.deepEqual(setup.outbox.get('one')?.nativeReply, { source: 'gateway', commandId: 'one', text: 'original reply',
    runId: 'native-one', connectionId: 'socket-one', sequence: 9 });
  const reader = new DatabaseSync(setup.file);
  try { assert.deepEqual(new MirrorOutbox(reader).get('one'), setup.outbox.get('one')); } finally { reader.close(); }
});

for (const early of [false, true]) test(`Gateway lifecycle completion before final preserves reply with ${early ? 'early' : 'bound'} run`, context => {
  const setup = fixture(context);
  setup.begin();
  if (!early) setup.ack();
  setup.event({ event: 'agent', payload: { sessionKey: 'synthetic', runId: 'native-one', stream: 'lifecycle', data: { phase: 'end' } } });
  setup.event();
  if (early) setup.ack();
  assert.equal(setup.outbox.get('one')?.nativeReply?.text, 'original reply');
});

test('late original final after successor admission resolves only its persisted Gateway binding', context => {
  const setup = fixture(context);
  setup.begin(); setup.ack();
  setup.event({ event: 'agent', payload: { sessionKey: 'synthetic', runId: 'native-one', stream: 'lifecycle', data: { phase: 'end' } } });
  setup.begin('two'); setup.ack('two', 'native-two');
  setup.event();
  assert.equal(setup.outbox.get('one')?.nativeReply?.text, 'original reply');
  assert.equal(setup.outbox.get('two')?.nativeReply, undefined);
  assert.equal(setup.executions.get('synthetic')?.commandId, 'two');
  assert.equal(setup.executions.get('synthetic')?.phase, 'starting');
  setup.event(finalEvent('second reply', 'native-two'));
  assert.equal(setup.outbox.get('two')?.nativeReply?.text, 'second reply');
});

for (const mismatch of ['connection', 'run', 'session', 'wire-connection']) test(`Gateway final cannot cross original ${mismatch} identity`, context => {
  const setup = fixture(context);
  setup.begin(); setup.ack();
  const raw = finalEvent();
  if (mismatch === 'run') raw.payload.runId = 'native-other';
  if (mismatch === 'session') raw.payload.sessionKey = 'other-session';
  if (mismatch === 'wire-connection') Object.assign(raw.payload, { gatewayConnectionId: 'socket-one', connectionId: 'socket-one' });
  setup.event(raw, mismatch === 'connection' || mismatch === 'wire-connection' ? 'socket-other' : 'socket-one');
  assert.equal(setup.outbox.get('one')?.nativeReply, undefined);
  assert.equal(setup.executions.get('synthetic')?.phase, 'starting');
});

test('Gateway ACK selection cannot claim another early final', context => {
  const setup = fixture(context);
  setup.begin(); setup.event(finalEvent('other output', 'other-run')); setup.ack();
  assert.equal(setup.outbox.get('one')?.nativeReply, undefined);
  setup.event();
  assert.equal(setup.outbox.get('one')?.nativeReply?.text, 'original reply');
});

for (const early of [false, true]) test(`Gateway conflicting final bodies ${early ? 'before' : 'after'} ACK block sending`, context => {
  const setup = fixture(context);
  setup.begin();
  if (!early) setup.ack();
  setup.event(); setup.event(finalEvent('conflicting reply'));
  if (early) setup.ack();
  assert.equal(setup.outbox.get('one')?.gatewayRun?.state, 'blocked');
  if (early) assert.equal(setup.outbox.get('one')?.nativeReply, undefined);
  else assert.equal(setup.outbox.get('one')?.nativeReply?.text, 'original reply');
});

test('Gateway final cannot override definitive failure or unowned execution', context => {
  for (const phase of ['failed', 'running'] as const) {
    const setup = fixture(context);
    setup.begin(); setup.ack();
    setup.executions.observe('synthetic', { runId: phase === 'failed' ? 'native-one' : 'other-run', gatewayConnectionId: 'socket-one', phase });
    setup.event();
    assert.equal(setup.outbox.get('one')?.nativeReply, undefined);
    assert.equal(setup.outbox.get('one')?.gatewayRun?.state, 'blocked');
  }
});

test('Gateway early reply and ACK removal roll back together on receipt failure', context => {
  const setup = fixture(context);
  setup.begin(); setup.event();
  const before = setup.executions.get('synthetic');
  assert.throws(() => setup.ack('one', 'native-one', () => { throw new Error('receipt failure'); }), /receipt failure/);
  assert.deepEqual(setup.executions.get('synthetic'), before);
  assert.equal(setup.outbox.get('one')?.nativeReply, undefined);
  assert.equal(setup.outbox.get('one')?.gatewayRun, undefined);
  setup.ack();
  assert.equal(setup.outbox.get('one')?.nativeReply?.text, 'original reply');
});

test('Gateway outbox capacity failure rolls back the original completion and accounting', context => {
  const setup = fixture(context, 2048);
  setup.begin(); setup.ack();
  const before = setup.executions.get('synthetic');
  const usage = setup.db.prepare('SELECT * FROM connector_mirror_usage').get();
  assert.throws(() => setup.executions.observe('synthetic', { phase: 'completed', runId: 'native-one', gatewayConnectionId: 'socket-one',
    reply: { text: 'x'.repeat(2048), sequence: 9 } }), /capacity/);
  assert.deepEqual(setup.executions.get('synthetic'), before);
  assert.deepEqual(setup.db.prepare('SELECT * FROM connector_mirror_usage').get(), usage);
  assert.equal(setup.outbox.get('one')?.nativeReply, undefined);
});

test('Gateway duplicate binding cannot alias a successor command', context => {
  const setup = fixture(context);
  setup.begin(); setup.ack(); setup.event(); setup.complete(); setup.begin('two');
  assert.throws(() => setup.ack('two'), /UNIQUE/);
  assert.equal(setup.executions.get('synthetic')?.runId, undefined);
  assert.equal(setup.outbox.get('two')?.gatewayRun, undefined);
});

test('Gateway restart quarantines unfinished correlation but preserves already persisted replies', context => {
  const setup = fixture(context);
  setup.begin(); setup.ack(); setup.event(); setup.complete();
  setup.begin('two'); setup.ack('two', 'native-two');
  setup.executions.recoverInterrupted();
  setup.event(finalEvent('late owner', 'native-two'));
  assert.equal(setup.outbox.get('one')?.gatewayRun?.state, 'completed');
  assert.equal(setup.outbox.get('one')?.nativeReply?.text, 'original reply');
  assert.equal(setup.outbox.get('two')?.gatewayRun?.state, 'blocked');
  assert.equal(setup.outbox.get('two')?.nativeReply, undefined);
});

test('Gateway evidence cannot enter through ordinary admission, save, CLI reply, edit or remove', context => {
  const setup = fixture(context);
  setup.begin(); setup.ack();
  const job = setup.outbox.get('one'); assert.ok(job);
  assert.throws(() => setup.outbox.upsert({ ...setup.params, ...{ gatewayRun: job.gatewayRun } }), /separate native evidence/);
  assert.throws(() => setup.outbox.saveJob({ ...job, gatewayRun: { ...job.gatewayRun!, state: 'completed' } }), /Gateway run conflict/);
  assert.throws(() => setup.outbox.remove('one'), /cannot be removed/);
  setup.db.exec('BEGIN IMMEDIATE');
  assert.throws(() => setup.outbox.editInputInTransaction(setup.db, 'synthetic', 'one', 'forged'), /conflict/);
  assert.throws(() => setup.outbox.recordCliReplyInTransaction(setup.db, setup.params, 'forged'), /conflict/);
  setup.db.exec('ROLLBACK');
  assert.deepEqual(setup.outbox.get('one'), job);
});

test('Gateway original run lookup uses its unique bounded SQLite index', context => {
  const setup = fixture(context);
  const plan = setup.db.prepare(`EXPLAIN QUERY PLAN SELECT id, session_key, job FROM connector_mirror_outbox
    WHERE session_key = ? AND json_extract(job, '$.gatewayRun.connectionId') = ? AND json_extract(job, '$.gatewayRun.runId') = ?
      AND json_extract(job, '$.gatewayRun') IS NOT NULL`).all('synthetic', 'socket-one', 'native-one');
  assert.match(JSON.stringify(plan), /USING INDEX connector_mirror_gateway_run/);
});

test('Gateway early final evidence remains bounded by the execution store budget', context => {
  const setup = fixture(context);
  const executions = new OpenClawExecutions(setup.db, 16, 2048, undefined, undefined, undefined, setup.outbox);
  setup.begin();
  const before = executions.get('synthetic');
  assert.throws(() => executions.observe('synthetic', { runId: 'native-one', gatewayConnectionId: 'socket-one', phase: 'completed',
    reply: { sequence: 9, text: 'x'.repeat(2048) } }), /Execution capacity/);
  assert.deepEqual(executions.get('synthetic'), before);
  assert.equal(setup.outbox.get('one')?.nativeReply, undefined);
});

for (const beforeAck of [true, false]) test(`actual Gateway adapter carries socket-owned reply ${beforeAck ? 'before' : 'after'} agent ACK`, async context => {
  const setup = fixture(context), server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  let deliver: (() => void) | undefined;
  let observed!: () => void;
  const observation = new Promise<void>(resolve => { observed = resolve; });
  server.on('connection', socket => {
    socket.send(JSON.stringify({ type: 'event', event: 'connect.challenge' }));
    socket.on('message', bytes => {
      const request = JSON.parse(bytes.toString());
      if (request.method === 'connect') { socket.send(JSON.stringify({ type: 'res', id: request.id, ok: true })); return; }
      assert.equal(request.method, 'agent');
      assert.equal(request.params.idempotencyKey, 'one');
      assert.equal(request.params.deliver, false);
      deliver = () => socket.send(JSON.stringify({ type: 'event', ...finalEvent(), connectionId: 'forged-wire-identity' }));
      if (beforeAck) deliver();
      socket.send(JSON.stringify({ type: 'res', id: request.id, ok: true, payload: { runId: 'native-one', status: 'accepted' } }));
    });
  });
  const gateway = new GatewayWsClient({ url: `ws://127.0.0.1:${(server.address() as { port: number }).port}`,
    ownerToken: undefined, password: undefined, onEvent: (raw, connectionId) => {
      setup.store.ingestGatewayEvent(raw, connectionId);
      if (raw.event === 'chat') observed();
    } });
  const dispatch = createOpenClawDispatch({ gateway, store: setup.store, executions: setup.executions, mirrorOutbox: setup.outbox,
    allowCliFallback: false, authorizeTurn: () => true, message: text => text });
  try {
    setup.outbox.upsert(setup.params);
    setup.executions.begin('synthetic', 'one');
    const response = await dispatch({ id: 'one', sessionKey: 'synthetic', createdAt: 1, state: 'dispatching', payload: {
      actorId: setup.params.actorId, message: setup.params.inputText, deliveryMode: 'mirror', explicitRoute: setup.params.explicitRoute, media: [],
    } }, []) as { runId: string };
    const connectionId = gateway.connectionId(); assert.ok(connectionId);
    assert.equal(setup.outbox.get('one')?.nativeReply, undefined);
    setup.ack('one', response.runId);
    if (!beforeAck) { assert.ok(deliver); deliver(); }
    await observation;
    const reply = setup.outbox.get('one')?.nativeReply;
    assert.equal(reply?.source, 'gateway');
    assert.equal(reply?.source === 'gateway' && reply.connectionId, connectionId);
    assert.notEqual(connectionId, 'forged-wire-identity');
    assert.equal(reply?.text, 'original reply');
    assert.equal(setup.executions.get('synthetic')?.phase, 'starting');
    assert.equal(setup.outbox.get('one')?.gatewayRun?.state, 'pending');
  } finally { await dispatch.close(); gateway.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('Gateway final reaches only the original channel through the existing dispatcher', async context => {
  const setup = fixture(context), sent: string[] = [];
  setup.begin(); setup.ack(); setup.event(); setup.complete();
  context.mock.timers.enable({ apis: ['setTimeout'] });
  context.mock.method(console, 'log', () => {});
  const dispatcher = createMirrorDispatcher(setup.outbox, { store: setup.store, normalizeError: String,
    authorizeTarget: params => params.actorId === setup.params.actorId,
    sendOutbound: async (route, text) => { assert.deepEqual(route, setup.params.explicitRoute); sent.push(text); } });
  try {
    const sending = dispatcher.mirrorAssistantReplyToChannel(setup.params);
    await tick(); context.mock.timers.tick(3000); await tick(); await sending;
    assert.deepEqual(sent, ['Input:\noriginal input\n\nOutput:\noriginal reply']);
    assert.equal(setup.outbox.get('one')?.selectedMessageId, 'gateway:socket-one:native-one:9');
    assert.equal(setup.outbox.get('one')?.deliveryState, 'sent');
    setup.event();
    await dispatcher.mirrorAssistantReplyToChannel(setup.params);
    assert.equal(sent.length, 1);
  } finally { await dispatcher.close(); context.mock.timers.reset(); }
});

for (const early of [true, false]) test(`Gateway yielded lifecycle plus final ${early ? 'before' : 'after'} ACK cannot finish or start a successor`, context => {
  const setup = fixture(context);
  setup.begin();
  if (!early) setup.ack();
  setup.event({ event: 'agent', payload: { sessionKey: 'synthetic', runId: 'native-one', stream: 'lifecycle', data: { phase: 'end', yielded: true } } });
  setup.event();
  if (early) setup.ack();
  assert.equal(setup.executions.get('synthetic')?.phase, 'waiting');
  assert.equal(setup.outbox.get('one')?.gatewayRun?.state, 'pending');
  assert.equal(setup.executions.begin('synthetic', 'two'), false);
});

test('Gateway completed query can settle the original saved reply without history inference', context => {
  const setup = fixture(context);
  setup.begin(); setup.ack(); setup.event();
  const expected = setup.executions.get('synthetic'); assert.ok(expected);
  assert.equal(setup.executions.completeFromQuery(expected), true);
  assert.equal(setup.outbox.get('one')?.gatewayRun?.state, 'completed');
  assert.equal(setup.outbox.get('one')?.nativeReply?.text, 'original reply');
});
