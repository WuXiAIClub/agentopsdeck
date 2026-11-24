import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { HermesEvent } from '../hermes/protocol.js';
import type { HermesTransport } from '../hermes/runtime.js';
import { HermesRemoteError } from '../hermes/rpc-peer.js';
import { DeckStore } from '../projection/deck-store.js';
import { AsyncHermesRuntime } from './async-hermes-runtime.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { createConnectorOwnerCommands } from './connector-owner-domain.js';
import { registerHermesDeletionHttp } from './hermes-deletion-http.js';
import { registerHermesCreationHttp } from './hermes-creation-http.js';
import { registerHermesMessagesHttp } from './hermes-messages-http.js';
import { AsyncHermesMessages } from './async-hermes-messages.js';

const key = 'hermes:original', authorization = 'Bearer isolated-runtime-token';
const config = { enabled: true, executable: '/isolated/python', sourceDirectory: '/isolated/source',
  homeDirectory: '/isolated/home', workspace: '/isolated/workspace', startupTimeoutMs: 1000 };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(check: () => boolean) {
  for (let i = 0; i < 500; i++) { if (check()) return; await tick(); }
  assert.ok(check(), 'runtime did not reach expected state');
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function fixture(deadlineMs = 10_000) {
  const directory = mkdtempSync(join(tmpdir(), 'async-hermes-runtime-'));
  const tokens = new ConnectorTokenStore(join(directory, 'tokens.json'), 'isolated-runtime-token');
  const actor = tokens.authenticateAuthorization(authorization)!.tokenId;
  const database = new ConnectorUserStore(':memory:', undefined, { runtimeOwner: true });
  database.hermesJournal.save({ key, stored: 'stored', title: 'Original', started: false, messages: [] });
  const command = createConnectorOwnerCommands(database, tokens), owner = { command };
  const store = new DeckStore(), calls: string[] = [], commands: string[] = [], submits: string[] = [], reports: string[] = [];
  const rows: { row_id: number; role: string; text: string; timestamp: number }[] = [];
  let emit!: (event: HermesEvent) => void, lost!: () => void;
  let available = true, factories = 0, sequence = 0, serial = 0, count = 0;
  const hooks: { start?: () => Promise<void>; close?: () => Promise<void>;
    request?: (method: string, params: Record<string, unknown>) => Promise<unknown> | undefined;
    changed?: () => void | Promise<void> } = {};
  owner.command = ((...args: Parameters<typeof command>) => {
    commands.push(args[0]); return command(...args);
  }) as typeof command;
  const native: HermesTransport & { ready: boolean; epoch: string } = {
    ready: false, epoch: 'epoch',
    async start() { calls.push('start'); await hooks.start?.(); native.ready = true; },
    async close() { calls.push('close'); native.ready = false; await hooks.close?.(); },
    async request(method, params) {
      calls.push(method); const parameters = params as Record<string, unknown>;
      if (method === 'prompt.submit') { submits.push(String(parameters.text)); rows.push({ row_id: ++serial, role: 'user', text: String(parameters.text), timestamp: serial }); }
      const replacement = hooks.request?.(method, parameters); if (replacement) return replacement;
      if (method === 'session.create') return { session_id: 'live', stored_session_id: 'stored' };
      if (method === 'session.resume' || method === 'session.activate') return { session_id: 'live', session_key: 'stored', status: 'idle', running: false };
      if (method === 'session.history') return { messages: rows.map(row => ({ ...row })) };
      if (method === 'prompt.submit') return { status: 'streaming' };
      if (method === 'session.close') return { closed: true };
      if (method === 'session.interrupt') return { interrupted: true };
      if (method === 'session.delete') return { deleted: parameters.session_id };
      throw Error('unexpected native operation');
    },
  };
  const runtime = new AsyncHermesRuntime({ owner, config, store, deadlineMs, executionAvailable: () => available,
    queueChanged: async () => { await hooks.changed?.(); }, diagnostics: new PerformanceDiagnostics(line => reports.push(line)) },
  (event, disconnect) => { factories++; emit = event; lost = disconnect; return native; });
  const event = (type: string, payload: Record<string, unknown> = {}, seq = ++sequence) => emit({ type, payload, sessionId: 'live', seq });
  return { database, tokens, actor, owner, command, store, runtime, native, hooks, calls, commands, submits, rows, reports,
    get factories() { return factories; }, gate(value: boolean) { available = value; }, event,
    disconnect() { native.ready = false; lost(); },
    reclaimed() { emit({ type: 'session.reclaimed', payload: { session_id: 'live' }, sessionId: undefined, seq: undefined }); },
    complete(text = 'private reply') { rows.push({ row_id: ++serial, role: 'assistant', text, timestamp: serial }); event('message.complete', { status: 'complete' }); },
    async enqueue(text = 'private input') {
      const result = await command('hermesMessageSend', { key, authorization, commandKey: `input-${++count}`, payloadJson: JSON.stringify({ message: text }) });
      assert.ok('receipt' in result && result.admitted);
    },
    async running() { await runtime.start(); await runtime.wake(); await until(() => database.hermesJournal.current(key)?.phase === 'running'); },
    async close() {
      try { await runtime.close(); }
      finally { command.dispose(); database.close(); rmSync(directory, { recursive: true, force: true }); }
    },
  };
}

function stopRequest(f: ReturnType<typeof fixture>, commandKey = 'stop-original') {
  return { key, authorization, commandKey, payloadJson: JSON.stringify({ message: '/stop', expectedRunId: f.database.hermesJournal.current(key)!.id }) };
}

test('runtime local status uses original execution while maintenance-paused and never calls native', async () => {
  const f = fixture();
  try {
    await f.enqueue(); await f.running(); f.gate(false);
    const original = f.database.hermesJournal.lifecycleSnapshot(key), calls = [...f.calls];
    const input = { key, authorization, commandKey: 'runtime-status', payloadJson: '{"message":"/status"}' };
    const result = await f.runtime.localControl.send(input, { timeoutMs: 5000 });
    assert.ok('report' in result && result.report); assert.match(result.report[1].text, /Active run: yes/);
    const read = await f.runtime.localControl.read({ key, authorization, commandKey: input.commandKey }, { timeoutMs: 5000 });
    assert.deepEqual(read, result); assert.deepEqual(f.calls, calls);
    assert.deepEqual(f.database.hermesJournal.lifecycleSnapshot(key), original);
    assert.ok(f.store.getMessages(key).some(m => m.id === result.report![1].id));
    await f.runtime.close(); await assert.rejects(f.runtime.localControl.send(input, { timeoutMs: 5000 }));
  } finally { await f.close(); }
});

test('original runtime stop is single-effect, does not mark terminal and emits bounded redacted diagnostics', async () => {
  const f = fixture();
  try {
    await f.enqueue(); await f.running(); const input = stopRequest(f);
    const result = await f.runtime.stop.stop(input);
    assert.ok('receipt' in result); assert.equal(result.receipt?.state, 'accepted');
    assert.equal(f.database.hermesJournal.current(key)?.phase, 'running');
    const duplicate = await f.runtime.stop.stop(input);
    assert.ok('receipt' in duplicate); assert.equal(duplicate.receipt?.id, result.receipt?.id);
    assert.equal(f.calls.filter(m => m === 'session.interrupt').length, 1);
    const logs = f.reports.join('\n'); assert.ok(logs.includes('hermes-message-stop'));
    for (const secret of [authorization, key, input.commandKey, 'private input']) assert.equal(logs.includes(secret), false);
  } finally { await f.close(); }
});

test('logical stop timeout never releases terminal successor before late physical ACK', async () => {
  const f = fixture(25), physical = deferred<unknown>();
  try {
    await f.enqueue(); await f.running(); const input = stopRequest(f);
    f.hooks.request = method => method === 'session.interrupt' ? physical.promise : undefined;
    await assert.rejects(f.runtime.stop.stop(input));
    assert.equal(f.database.hermesJournal.interruptPending(key), true);
    f.complete(); await until(() => f.database.hermesJournal.current(key)?.phase === 'completed');
    await f.enqueue('successor'); await f.runtime.wake(); await tick();
    assert.equal(f.submits.length, 1);
    const duplicate = await f.runtime.stop.stop(input);
    assert.ok('receipt' in duplicate); assert.equal(duplicate.receipt?.state, 'outcome_unknown');
    physical.resolve({ interrupted: true });
    await until(() => f.submits.length === 2);
    assert.equal(f.database.hermesJournal.interruptPending(key), false);
    const after = await f.runtime.stop.receipt({ key, authorization, commandKey: input.commandKey }, { timeoutMs: 10_000 });
    assert.ok('receipt' in after); assert.equal(after.receipt?.state, 'accepted');
    assert.equal(f.calls.filter(m => m === 'session.interrupt').length, 1);
  } finally { physical.resolve({ interrupted: true }); await f.close(); }
});

test('lost stop ACK after terminal retains original unknown and blocks queued successor without replay', async () => {
  const f = fixture(), physical = deferred<unknown>();
  try {
    await f.enqueue(); await f.running(); const input = stopRequest(f);
    f.hooks.request = method => method === 'session.interrupt' ? physical.promise : undefined;
    const stopping = f.runtime.stop.stop(input);
    await until(() => f.calls.includes('session.interrupt'));
    f.complete(); await until(() => f.database.hermesJournal.current(key)?.phase === 'completed');
    await f.enqueue('blocked successor'); physical.reject(Error('isolated lost ACK'));
    const r = await stopping; assert.ok('receipt' in r); assert.equal(r.receipt?.state, 'outcome_unknown');
    await f.runtime.wake(); await tick(); assert.equal(f.submits.length, 1);
    const duplicate = await f.runtime.stop.stop(input); assert.ok('execution' in duplicate); assert.equal(duplicate.execution, null);
    assert.equal(f.database.hermesJournal.interruptPending(key), true);
    assert.equal(f.calls.filter(m => m === 'session.interrupt').length, 1);
  } finally { physical.resolve({ interrupted: true }); await f.close(); }
});

test('maintenance queue pause permits original stop; effect-side revoke preserves its durable ACK', async () => {
  const f = fixture();
  try {
    await f.enqueue(); await f.running(); const input = stopRequest(f);
    f.gate(false);
    f.hooks.request = method => { if (method !== 'session.interrupt') return undefined; f.tokens.revoke(f.actor); return Promise.resolve({ interrupted: true }); };
    const r = await f.runtime.stop.stop(input); assert.ok('receipt' in r); assert.equal(r.receipt?.state, 'accepted');
    assert.equal(f.database.hermesJournal.interruptPending(key), false);
    assert.deepEqual(await f.runtime.stop.receipt({ key, authorization, commandKey: input.commandKey }, { timeoutMs: 10_000 }), { error: 401 });
  } finally { await f.close(); }
});

for (const fault of ['revoke', 'terminal', 'truthy-ready', 'disconnect'] as const)
  test(`stop ${fault} during worker preflight never calls native or retains a known-unsent fence`, async () => {
    const f = fixture(), original = f.owner.command;
    try {
      await f.enqueue(); await f.running(); const input = stopRequest(f);
      f.owner.command = (async (...args: Parameters<typeof original>) => {
        if (args[0] === 'hermesStopReady') {
          if (fault === 'revoke') f.tokens.revoke(f.actor);
          if (fault === 'terminal') f.database.hermesJournal.update({ ...f.database.hermesJournal.current(key)!, phase: 'completed' });
          if (fault === 'disconnect') f.disconnect();
        }
        const result = await original(...args);
        return args[0] === 'hermesStopReady' && fault === 'truthy-ready' ? 1 : result;
      }) as typeof original;
      const r = await f.runtime.stop.stop(input); assert.ok('receipt' in r); assert.equal(r.receipt?.state, 'rejected');
      assert.equal(f.calls.includes('session.interrupt'), false);
      assert.equal(f.database.hermesJournal.interruptPending(key), false);
    } finally { f.owner.command = original; await f.close(); }
  });

test('close drains original physical stop after caller timeout without disposing shared owner', async () => {
  const f = fixture(25), physical = deferred<unknown>();
  try {
    await f.enqueue(); await f.running(); const input = stopRequest(f);
    f.hooks.request = method => method === 'session.interrupt' ? physical.promise : undefined;
    await assert.rejects(f.runtime.stop.stop(input));
    let closed = false; const closing = f.runtime.close().then(() => { closed = true; });
    await tick(); assert.equal(closed, false);
    assert.deepEqual(await f.runtime.stop.stop({ ...input, commandKey: 'new-stop' }), { error: 409 });
    physical.resolve({ interrupted: true }); await closing;
    const r = await f.command('hermesStopReceiptRead', { key, authorization, commandKey: input.commandKey }); assert.ok('receipt' in r); assert.equal(r.receipt?.state, 'accepted');
  } finally { physical.resolve({ interrupted: true }); await f.close(); }
});

test('same runtime HTTP stop keeps original wire and read-only recovery, with no synchronous fallback', async () => {
  const f = fixture();
  try {
    await f.enqueue(); await f.running(); const input = stopRequest(f);
    const app = new Hono(); let fallback = 0;
    registerHermesMessagesHttp(app, '/sessions/:sessionKey', { messages: new AsyncHermesMessages(f.owner, () => {}), stop: f.runtime.stop, ready: () => f.runtime.ready });
    app.post('/sessions/:sessionKey/messages', async c => { fallback++; return c.json({ original: await c.req.json() }); });
    const path = `/sessions/${key}/messages`;
    const request = { method: 'POST', headers: { authorization, 'content-type': 'application/json', 'idempotency-key': input.commandKey }, body: input.payloadJson };
    const response = await app.request(path, request); assert.equal(response.status, 200);
    const body = await response.json(); assert.equal(body.status, 'interrupt_requested'); assert.equal(body.command.state, 'accepted');
    assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('x-agentopsdeck-command-key'), input.commandKey);
    const read = await app.request(`/sessions/${key}/commands/${input.commandKey}`, { headers: { authorization } });
    assert.equal(read.status, 200); assert.equal((await read.json()).command.id, body.command.id);
    assert.equal((await app.request(path, request)).status, 200);
    assert.equal(f.calls.filter(m => m === 'session.interrupt').length, 1); assert.equal(fallback, 0);
    const other = await app.request('/sessions/codex:original/messages', request); assert.equal(other.status, 200); assert.equal(fallback, 1);
  } finally { await f.close(); }
});

test('creation shares original transport, journal, durable 201 and read-only receipt; duplicate never creates', async () => {
  const f = fixture();
  try {
    await f.runtime.start();
    const input = { authorization, commandKey: 'create-original', payloadJson: '{"title":"  New original  "}' };
    const r = await f.runtime.creation.create(input);
    assert.ok('receipt' in r); assert.equal(r.receipt.state, 'accepted');
    const created = r.receipt.result!.body;
    assert.equal(created.title, 'New original'); assert.equal(created.agentId, 'hermes');
    assert.equal(f.database.hermesJournal.session(String(created.key))?.stored, 'stored');
    assert.equal(f.store.getSession(String(created.key))?.title, 'New original');
    const duplicate = await f.runtime.creation.create(input);
    assert.ok('receipt' in duplicate); assert.deepEqual(duplicate.receipt, r.receipt); assert.equal(duplicate.admitted, false);
    assert.equal(f.calls.filter(m => m === 'session.create').length, 1); assert.equal(f.factories, 1);
    const logs = f.reports.join('\n');
    assert.ok(logs.includes('hermes-session-creation'));
    for (const secret of [authorization, 'New original', String(created.key)]) assert.equal(logs.includes(secret), false);
  } finally { await f.close(); }
});

for (const outcome of ['original', 'missing', 'foreign', 'busy'] as const)
  test(`new empty creation reopens only its original native identity: ${outcome}`, async () => {
    const f = fixture(); let reopened: AsyncHermesRuntime | undefined;
    try {
      await f.runtime.start();
      const input = { authorization, commandKey: 'empty-restart', payloadJson: '{}' };
      const created = await f.runtime.creation.create(input);
      assert.ok('receipt' in created); assert.equal(created.receipt.state, 'accepted');
      const newKey = String(created.receipt.result!.body.key);
      assert.equal(f.database.hermesJournal.session(newKey)?.started, false);
      assert.equal(f.database.hermesJournal.session(newKey)?.nativeAllocated, true);
      await f.runtime.close();
      f.hooks.request = (method, params) => {
        if (method !== 'session.resume') return undefined;
        assert.equal(params.session_id, 'stored');
        if (outcome === 'missing') return Promise.reject(new HermesRemoteError(4007));
        return Promise.resolve({ session_id: 'restored-live', session_key: outcome === 'foreign' ? 'foreign' : 'stored',
          running: outcome === 'busy', status: outcome === 'busy' ? 'running' : 'idle' });
      };
      reopened = new AsyncHermesRuntime({ owner: f.owner, config, store: new DeckStore(), deadlineMs: 10_000,
        executionAvailable: () => true, queueChanged: () => {} }, () => f.native);
      await reopened.start();
      if (outcome === 'original') {
        await reopened.refreshSession(newKey);
        assert.equal(reopened.isSessionHistoryReady(newKey), true);
        // Even after attachment the first prompt has not run.
        assert.equal(f.database.hermesJournal.session(newKey)?.started, false);
      } else {
        await assert.rejects(reopened.refreshSession(newKey));
        await assert.rejects(reopened.refreshSession(newKey));
        assert.equal(reopened.isSessionHistoryReady(newKey), false);
      }
      assert.equal(f.database.hermesJournal.session(newKey)?.stored, 'stored');
      assert.equal(f.calls.filter(m => m === 'session.create').length, 1);
      assert.equal(f.calls.filter(m => m === 'session.resume').length, 1);
      const receipt = await reopened.creation.receipt(authorization, input.commandKey);
      assert.ok('receipt' in receipt); assert.deepEqual(receipt.receipt, created.receipt);
    } finally { await reopened?.close(); await f.close(); }
  });

test('bounded creation waiter expires but original late native identity still settles without replay', async () => {
  const f = fixture(15), physical = deferred<unknown>();
  try {
    await f.runtime.start();
    f.hooks.request = method => method === 'session.create' ? physical.promise : undefined;
    const input = { authorization, commandKey: 'late-create', payloadJson: '{}' };
    await assert.rejects(f.runtime.creation.create(input));
    const before = await f.runtime.creation.receipt(authorization, input.commandKey);
    assert.ok('receipt' in before); assert.equal(before.receipt?.state, 'outcome_unknown');
    const duplicate = await f.runtime.creation.create(input); assert.ok('receipt' in duplicate); assert.equal(duplicate.admitted, false);
    physical.resolve({ session_id: 'late-live', stored_session_id: 'late-stored' });
    await until(() => f.database.hermesJournal.sessions().some(s => s.stored === 'late-stored'));
    const after = await f.runtime.creation.receipt(authorization, input.commandKey);
    assert.ok('receipt' in after); assert.equal(after.receipt?.state, 'accepted');
    assert.equal(f.calls.filter(m => m === 'session.create').length, 1);
  } finally { physical.resolve({ session_id: 'late-live', stored_session_id: 'late-stored' }); await f.close(); }
});

for (const reason of ['revoked', 'epoch', 'disconnected', 'projection', 'invalid-identity', 'lost-ack'] as const)
  test(`original creation ${reason} preserves exact durable outcome without new native effect`, async () => {
    const f = fixture(), upsert = f.store.upsertSession.bind(f.store);
    try {
      await f.runtime.start();
      f.hooks.request = method => {
        if (method !== 'session.create') return undefined;
        if (reason === 'revoked') f.tokens.revoke(f.actor);
        if (reason === 'epoch') f.native.epoch = 'foreign';
        if (reason === 'disconnected') f.disconnect();
        if (reason === 'projection') f.store.upsertSession = () => { throw Error('projection failed'); };
        if (reason === 'lost-ack') return Promise.reject(Error('lost original ACK'));
        return Promise.resolve(reason === 'invalid-identity' ? { session_id: 'bad' } : { session_id: 'new-live', stored_session_id: 'new-stored' });
      };
      const input = { authorization, commandKey: 'fault-create', payloadJson: '{}' }, r = await f.runtime.creation.create(input);
      assert.ok('receipt' in r); assert.equal(r.receipt.state, ['invalid-identity', 'lost-ack'].includes(reason) ? 'outcome_unknown' : 'accepted');
      assert.equal(f.database.hermesJournal.sessions().some(s => s.stored === 'new-stored'), r.receipt.state === 'accepted');
      const duplicate = await f.runtime.creation.create(input);
      if (reason === 'revoked') assert.deepEqual(duplicate, { error: 401 });
      else { assert.ok('receipt' in duplicate); assert.equal(duplicate.admitted, false); }
      assert.equal(f.calls.filter(m => m === 'session.create').length, 1);
    } finally { f.store.upsertSession = upsert; await f.close(); }
  });

test('runtime close drains original physical create after logical timeout and preserves its late identity', async () => {
  const f = fixture(15), physical = deferred<unknown>();
  try {
    await f.runtime.start(); f.hooks.request = method => method === 'session.create' ? physical.promise : undefined;
    await assert.rejects(f.runtime.creation.create({ authorization, commandKey: 'close-create', payloadJson: '{}' }));
    let closed = false; const closing = f.runtime.close().then(() => { closed = true; });
    await tick(); assert.equal(closed, false);
    assert.deepEqual(await f.runtime.creation.create({ authorization, commandKey: 'new-create', payloadJson: '{}' }), { error: 409 });
    physical.resolve({ session_id: 'late-live', stored_session_id: 'late-close-stored' });
    await closing; assert.equal(closed, true);
    assert.ok(f.database.hermesJournal.sessions().some(s => s.stored === 'late-close-stored'));
    assert.equal(f.calls.filter(m => m === 'session.create').length, 1);
  } finally { physical.resolve({ session_id: 'late-live', stored_session_id: 'late-close-stored' }); await f.close(); }
});

test('Hermes creation HTTP preserves legacy 201 and recovery wire on same runtime; other agents untouched', async () => {
  const f = fixture();
  try {
    await f.runtime.start(); const app = new Hono();
    registerHermesCreationHttp(app, '', { creation: f.runtime.creation, ready: () => f.runtime.ready });
    app.post('/agents/:agentId/sessions', async c => c.json({ original: await c.req.json() }));
    const path = '/agents/hermes/sessions';
    const request = { method: 'POST', headers: { authorization, 'content-type': 'application/json', 'idempotency-key': 'http-create' }, body: '{"title":"HTTP title"}' };
    const response = await app.request(path, request); assert.equal(response.status, 201);
    const body = await response.json(); assert.equal(body.agentId, 'hermes'); assert.equal(body.title, 'HTTP title'); assert.equal(body.command.state, 'accepted');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const read = await app.request(`${path}/creation-commands/http-create`, { headers: { authorization } });
    assert.equal(read.status, 200); assert.equal((await read.json()).command.id, body.command.id);
    const duplicate = await app.request(path, request); assert.equal(duplicate.status, 201);
    assert.equal(f.calls.filter(m => m === 'session.create').length, 1);
    const original = await app.request('/agents/codex/sessions', { ...request, body: '{"native":"untouched"}' });
    assert.deepEqual(await original.json(), { original: { native: 'untouched' } });
    const denied = await app.request(path, { ...request, headers: { ...request.headers, 'x-agentopsdeck-execution-grant': 'untrusted' } });
    assert.equal(denied.status, 403); assert.equal(f.calls.filter(m => m === 'session.create').length, 1);
  } finally { await f.close(); }
});

test('HTTP timeout does not cancel original create, and revoked caller cannot receive late identity', async () => {
  const f = fixture(), physical = deferred<unknown>();
  try {
    await f.runtime.start(); f.hooks.request = method => method === 'session.create' ? physical.promise : undefined;
    const app = new Hono(); registerHermesCreationHttp(app, '', { creation: f.runtime.creation, ready: () => f.runtime.ready, timeoutMs: 15 });
    const path = '/agents/hermes/sessions';
    const response = await app.request(path, { method: 'POST', headers: { authorization, 'idempotency-key': 'http-late' }, body: '{}' });
    assert.equal(response.status, 503); assert.equal((await response.json()).status, 'outcome_unknown');
    f.tokens.revoke(f.actor); physical.resolve({ session_id: 'late-live', stored_session_id: 'http-late-stored' });
    await until(() => f.database.hermesJournal.sessions().some(s => s.stored === 'http-late-stored'));
    const read = await app.request(`${path}/creation-commands/http-late`, { headers: { authorization } });
    assert.equal(read.status, 401); assert.equal(f.calls.filter(m => m === 'session.create').length, 1);
  } finally { physical.resolve({ session_id: 'late-live', stored_session_id: 'http-late-stored' }); await f.close(); }
});

test('constructor has no effects; recovery precedes sole native start; start/close are single-flight', async () => {
  const f = fixture();
  try {
    assert.equal(f.factories, 0); assert.deepEqual(f.commands, []); assert.equal(f.runtime.ready, false);
    await f.enqueue(); const input = f.database.turns.head('hermes', key)!;
    f.database.turns.startBatch('hermes', key, [input.id]);
    f.database.hermesJournal.update({ key, id: 'old', live: 'old-live', epoch: 'old-epoch', phase: 'starting', members: [input.id], at: 1, updated: 1 });
    f.hooks.start = async () => { assert.equal(f.database.hermesJournal.current(key)?.phase, 'unknown'); assert.equal(f.store.getSession(key)?.status, 'unknown'); };
    const start = f.runtime.start(); assert.equal(f.runtime.start(), start); await start;
    assert.equal(f.factories, 1); assert.equal(f.runtime.ready, true); assert.equal(f.submits.length, 0);
    const close = f.runtime.close(); assert.equal(f.runtime.close(), close); await close;
    assert.equal(f.runtime.ready, false); assert.equal(f.calls.filter(call => call === 'close').length, 1);
    await assert.rejects(f.runtime.start());
  } finally { await f.close(); }
});

test('original receipt/FIFO → submit once → terminal history → next queued input', async () => {
  const f = fixture();
  try {
    await f.enqueue('first'); await f.enqueue('second'); await f.running();
    assert.equal(f.submits.length, 1); const first = f.database.hermesJournal.current(key)!;
    assert.equal(first.members.length, 2); assert.ok(f.submits[0]!.includes('first')); assert.ok(f.submits[0]!.includes('second'));
    await f.enqueue('third'); await f.runtime.wake(); assert.equal(f.submits.length, 1);
    f.complete(); await until(() => f.submits.length === 2);
    await until(() => f.database.hermesJournal.current(key)?.phase === 'running');
    assert.equal(f.submits[1], 'third'); assert.notEqual(f.database.hermesJournal.current(key)?.id, first.id);
    f.complete('second reply'); await until(() => f.database.hermesJournal.current(key)?.phase === 'completed');
    await until(() => f.store.getMessages(key).some(message => message.text === 'second reply'));
    assert.equal(f.store.getSession(key)?.hasActiveRun, false); assert.equal(f.submits.length, 2);
  } finally { await f.close(); }
});

test('terminal event before admission IPC completes is buffered and settled exactly once', async () => {
  const f = fixture();
  try {
    f.hooks.request = method => { if (method === 'prompt.submit') { f.complete(); return Promise.resolve({ status: 'streaming' }); } };
    await f.enqueue(); await f.runtime.start(); await f.runtime.wake();
    await until(() => f.database.hermesJournal.current(key)?.phase === 'completed');
    await f.runtime.wake(); assert.equal(f.submits.length, 1);
    assert.ok(f.store.getMessages(key).some(message => message.text === 'private reply'));
  } finally { await f.close(); }
});

for (const guard of ['pause', 'maintenance'] as const) test(`${guard} stops new admission but drains original tools and terminal facts`, async () => {
  const f = fixture();
  try {
    await f.enqueue(); await f.running(); await f.enqueue('later');
    const pause = guard === 'pause' ? f.runtime.pauseQueueWorker() : undefined;
    if (guard === 'maintenance') f.gate(false);
    await pause?.drained; assert.equal(f.runtime.ready, true);
    f.event('tool.start', { tool_id: 'tool-one', name: 'private-tool' });
    f.event('tool.complete', { tool_id: 'tool-one', name: 'private-tool', result: 'private-output' });
    f.complete(); await until(() => f.database.hermesJournal.current(key)?.phase === 'completed');
    await f.runtime.wake(); assert.equal(f.submits.length, 1);
    assert.equal(f.database.hermesJournal.session(key)?.messages.filter(message => message.toolPhase === 'result').length, 1);
    if (pause) assert.equal(pause.resume(), true); else { f.gate(true); await f.runtime.wake(); }
    await until(() => f.submits.length === 2);
  } finally { await f.close(); }
});

for (const fault of ['gap', 'invalid-seq', 'disconnect', 'reclaim'] as const) test(`${fault} protects original execution and never replays native input`, async () => {
  const f = fixture();
  try {
    await f.enqueue(); await f.running(); f.event('message.delta', { text: 'partial' });
    if (fault === 'gap') f.event('message.delta', { text: 'ignored' }, 20);
    if (fault === 'invalid-seq') f.event('message.delta', { text: 'ignored' }, NaN);
    if (fault === 'disconnect') f.disconnect();
    if (fault === 'reclaim') f.reclaimed();
    await until(() => f.database.hermesJournal.current(key)?.phase === 'unknown');
    await until(() => f.store.getSession(key)?.runtime?.phase === 'unknown');
    f.complete('late'); await f.runtime.wake(); await tick(); assert.equal(f.submits.length, 1);
    assert.equal(f.database.hermesJournal.current(key)?.phase, 'unknown');
    assert.ok(!f.store.getMessages(key).some(message => message.text === 'late'));
  } finally { await f.close(); }
});

test('terminal commit remains terminal when subsequent history projection fails; next input is not stranded', async () => {
  const f = fixture();
  try {
    await f.enqueue(); await f.running(); const first = f.database.hermesJournal.current(key)!;
    const original = f.owner.command;
    f.owner.command = ((...args: Parameters<typeof original>) => {
      if (args[0] === 'hermesHistoryProjection' && f.database.hermesJournal.current(key)?.id === first.id
        && f.database.hermesJournal.current(key)?.phase === 'completed') return Promise.reject(Error('private projection failure'));
      return original(...args);
    }) as typeof original;
    await f.enqueue('next'); f.complete(); await until(() => f.submits.length === 2);
    await until(() => f.database.hermesJournal.current(key)?.phase === 'running');
    assert.equal(f.submits[1], 'next'); assert.notEqual(f.database.hermesJournal.current(key)?.id, first.id);
    assert.equal(f.commands.filter(command => command === 'hermesExecutionUnknown').length, 0);
  } finally { await f.close(); }
});

test('preparation failure blocks only the original queued head durably, with no submit/retry spin', async () => {
  const f = fixture();
  try {
    f.hooks.request = method => method === 'session.create' ? Promise.reject(Error('private preparation failure')) : undefined;
    await f.enqueue(); await f.runtime.start(); await f.runtime.wake();
    await until(() => f.database.turns.head('hermes', key)?.state === 'blocked');
    const calls = f.calls.length; await f.runtime.wake(); await f.runtime.wake();
    assert.equal(f.calls.length, calls); assert.equal(f.submits.length, 0);
    assert.equal(f.database.hermesJournal.current(key), undefined);
  } finally { await f.close(); }
});

for (const denial of ['revoked', 'deletion'] as const) test(`${denial} denies queued input before native effect`, async () => {
  const f = fixture();
  try {
    await f.enqueue(); if (denial === 'revoked') f.tokens.revoke(f.actor); else f.database.hermesJournal.beginDeletion(key);
    await f.runtime.start(); await f.runtime.wake(); assert.equal(f.submits.length, 0);
    assert.equal(f.calls.includes('session.create'), false);
  } finally { await f.close(); }
});

test('close retains physical submit after caller deadline and never closes shared owner', async () => {
  const f = fixture(25), entered = deferred<void>(), release = deferred<unknown>();
  try {
    f.hooks.request = method => { if (method === 'prompt.submit') { entered.resolve(); return release.promise; } };
    await f.enqueue(); await f.runtime.start(); await entered.promise;
    await until(() => f.submits.length === 1);
    // The caller may time out, but the original transport promise still owns
    // physical drain. A close cannot report completion before it resolves.
    await new Promise(resolve => setTimeout(resolve, 40));
    let closed = false; const closing = f.runtime.close().then(() => { closed = true; });
    await tick(); assert.equal(closed, false); release.resolve({ status: 'streaming' }); await closing;
    assert.equal(f.database.hermesJournal.current(key)?.phase, 'unknown');
    assert.ok(await f.command('hermesExecutionRead', { sessionKey: key }));
    assert.equal(f.submits.length, 1);
  } finally { release.resolve({ status: 'streaming' }); await f.close(); }
});

test('startup failure latches; no implicit native restart; close before start has no effects', async () => {
  const f = fixture(), unopened = fixture();
  try {
    f.hooks.start = async () => { throw Error('private native startup'); };
    const first = f.runtime.start(); await assert.rejects(first); assert.equal(f.runtime.start(), first);
    await assert.rejects(f.runtime.start()); assert.equal(f.factories, 1); assert.equal(f.runtime.status, 'startup_failed');
    await unopened.runtime.close(); await assert.rejects(unopened.runtime.start()); assert.equal(unopened.factories, 0);
  } finally { await f.close(); await unopened.close(); }
});

test('early tools are serialized through original owner before terminal history settlement', async () => {
  const f = fixture(), entered = deferred<void>(), release = deferred<void>();
  try {
    const original = f.owner.command; let held = false;
    f.owner.command = (async (...args: Parameters<typeof original>) => {
      if (args[0] === 'hermesExecutionTool' && !held) { held = true; entered.resolve(); await release.promise; }
      return original(...args);
    }) as typeof original;
    f.hooks.request = method => {
      if (method === 'prompt.submit') {
        f.event('tool.start', { tool_id: 'early', name: 'original-tool' });
        f.event('tool.complete', { tool_id: 'early', name: 'original-tool' });
        f.complete(); return Promise.resolve({ status: 'streaming' });
      }
    };
    await f.enqueue(); await f.runtime.start(); await entered.promise;
    await tick(); assert.notEqual(f.database.hermesJournal.current(key)?.phase, 'completed');
    release.resolve(); await f.runtime.wake();
    await until(() => f.database.hermesJournal.current(key)?.phase === 'completed');
    const tools = f.database.hermesJournal.session(key)!.messages.filter(message => message.toolCallId?.endsWith(':early'));
    assert.deepEqual(tools.map(message => message.toolPhase), ['call', 'result']); assert.equal(f.submits.length, 1);
  } finally { release.resolve(); await f.close(); }
});

test('failed durable unknown keeps a local fence and never publishes running again', async () => {
  const f = fixture();
  try {
    await f.enqueue(); await f.running(); const original = f.owner.command;
    f.owner.command = ((...args: Parameters<typeof original>) => args[0] === 'hermesExecutionUnknown'
      ? Promise.reject(Error('private journal failure')) : original(...args)) as typeof original;
    f.event('message.delta', { text: 'first' }); f.event('message.delta', { text: 'gap' }, 100); await tick();
    await until(() => f.store.getSession(key)?.runtime?.phase === 'unknown');
    assert.equal(f.database.hermesJournal.current(key)?.phase, 'running');
    const histories = f.calls.filter(call => call === 'session.history').length;
    await f.runtime.refreshSession(key); assert.equal(f.store.getSession(key)?.runtime?.phase, 'unknown');
    assert.equal(f.calls.filter(call => call === 'session.history').length, histories); assert.equal(f.runtime.isSessionHistoryReady(key), false);
    f.complete('late'); await f.runtime.wake(); assert.equal(f.submits.length, 1);
    const lines = f.reports.join('\n'); assert.ok(!lines.includes('private journal failure')); assert.ok(!lines.includes('private input'));
  } finally { await f.close(); }
});

for (const mismatch of ['id', 'row', 'members', 'epoch'] as const) test(`terminal receipt ${mismatch} mismatch cannot release the original fence`, async () => {
  const f = fixture();
  try {
    await f.enqueue(); await f.running(); const original = f.owner.command;
    f.owner.command = (async (...args: Parameters<typeof original>) => {
      const result = await original(...args);
      if (args[0] === 'hermesExecutionRead' && result && typeof result === 'object' && 'phase' in result && result.phase === 'completed') {
        return { ...result, [mismatch]: mismatch === 'row' ? 999 : mismatch === 'members' ? ['other'] : 'other' };
      }
      return result;
    }) as typeof original;
    await f.enqueue('next'); f.complete();
    await until(() => f.store.getSession(key)?.runtime?.phase === 'unknown');
    await f.runtime.wake(); assert.equal(f.submits.length, 1);
    assert.equal(f.database.hermesJournal.current(key)?.phase, 'completed');
  } finally { await f.close(); }
});

test('more than four immediate terminal successors are not dropped by coalesced wake', async () => {
  const f = fixture(); let remaining = 7;
  try {
    f.hooks.request = method => {
      if (method === 'prompt.submit') { f.complete(); return Promise.resolve({ status: 'streaming' }); }
    };
    f.hooks.changed = async () => {
      if (f.database.hermesJournal.current(key)?.phase === 'completed' && remaining-- > 0) await f.enqueue(`successor-${remaining}`);
    };
    await f.enqueue(); await f.runtime.start(); await f.runtime.wake();
    await until(() => f.submits.length === 8); await until(() => f.database.hermesJournal.current(key)?.phase === 'completed');
    assert.equal(f.database.turns.head('hermes', key), undefined);
  } finally { await f.close(); }
});

test('close waits for an already entered owner tool write and isolates native close failure', async () => {
  const f = fixture(), entered = deferred<void>(), release = deferred<void>();
  try {
    await f.enqueue(); await f.running(); const original = f.owner.command;
    f.owner.command = (async (...args: Parameters<typeof original>) => {
      if (args[0] === 'hermesExecutionTool') { entered.resolve(); await release.promise; }
      return original(...args);
    }) as typeof original;
    f.event('tool.start', { tool_id: 'drain', name: 'original' }); await entered.promise;
    f.hooks.close = async () => { throw Error('isolated close failure'); };
    let done = false; const closing = f.runtime.close(); const observed = assert.rejects(closing, /isolated close failure/).then(() => { done = true; });
    await tick(); assert.equal(done, false); release.resolve(); await observed;
    assert.equal(f.database.hermesJournal.current(key)?.phase, 'unknown');
    assert.ok(await f.command('hermesExecutionRead', { sessionKey: key }));
  } finally { release.resolve(); await f.close().catch(() => {}); }
});

test('close during native startup drains the original start and never opens dispatch admission', async () => {
  const f = fixture(), entered = deferred<void>(), release = deferred<void>();
  try {
    f.hooks.start = async () => { entered.resolve(); await release.promise; };
    await f.enqueue(); const starting = assert.rejects(f.runtime.start()); await entered.promise;
    let done = false; const closing = f.runtime.close().then(() => { done = true; });
    await tick(); assert.equal(done, false); assert.equal(f.runtime.ready, false);
    release.resolve(); await starting; await closing; await f.runtime.wake();
    assert.equal(f.runtime.ready, false); assert.equal(f.submits.length, 0);
    assert.equal(f.database.turns.head('hermes', key)?.state, 'queued');
    assert.equal(f.calls.filter(call => call === 'close').length, 1);
  } finally { release.resolve(); await f.close(); }
});

test('reentrant close from queue projection commits terminal before shutdown and does not resubmit', async () => {
  const f = fixture(); let closing: Promise<void> | undefined;
  try {
    await f.enqueue(); await f.running(); await f.enqueue('next');
    f.hooks.changed = () => { if (f.database.hermesJournal.current(key)?.phase === 'completed') closing = f.runtime.close(); };
    f.complete(); await until(() => !!closing); await closing;
    assert.equal(f.database.hermesJournal.current(key)?.phase, 'completed'); assert.equal(f.submits.length, 1);
  } finally { await f.close(); }
});

test('tool arriving between admission history snapshot and commit cannot invalidate its own row ACK', async () => {
  const f = fixture();
  try {
    const original = f.owner.command; let injected = false;
    f.owner.command = (async (...args: Parameters<typeof original>) => {
      const result = await original(...args);
      if (!injected && args[0] === 'hermesHistorySnapshot' && f.database.hermesJournal.current(key)?.phase === 'running') {
        injected = true; f.event('tool.start', { tool_id: 'interleaved', name: 'original' });
      }
      return result;
    }) as typeof original;
    await f.enqueue(); await f.running(); await until(() => injected);
    await until(() => f.database.hermesJournal.session(key)!.messages.some(message => message.toolPhase === 'call'));
    assert.equal(f.database.hermesJournal.current(key)?.phase, 'running');
    f.complete(); await until(() => f.database.hermesJournal.current(key)?.phase === 'completed'); assert.equal(f.submits.length, 1);
  } finally { await f.close(); }
});

test('admission projection failure does not convert a proven running execution to unknown', async () => {
  const f = fixture();
  try {
    const original = f.owner.command;
    f.owner.command = ((...args: Parameters<typeof original>) => args[0] === 'hermesLifecycleRead'
      && f.database.hermesJournal.current(key)?.phase === 'running'
      ? Promise.reject(Error('private lifecycle projection')) : original(...args)) as typeof original;
    await f.enqueue(); await f.running(); await tick(); assert.equal(f.database.hermesJournal.current(key)?.phase, 'running');
    assert.equal(f.commands.filter(command => command === 'hermesExecutionUnknown').length, 0);
    f.complete(); await until(() => f.database.hermesJournal.current(key)?.phase === 'completed'); assert.equal(f.submits.length, 1);
  } finally { await f.close(); }
});

test('preparation denial never blocks a replacement head, deletion or unknown execution', async () => {
  const f = fixture();
  try {
    await f.enqueue(); const head = f.database.turns.head('hermes', key)!;
    assert.equal(await f.command('hermesDispatchPreparationFailed', { key, head: 'replacement' }), false);
    f.database.hermesJournal.beginDeletion(key);
    assert.equal(await f.command('hermesDispatchPreparationFailed', { key, head: head.id }), false);
    assert.equal(f.database.turns.head('hermes', key)?.state, 'queued');
  } finally { await f.close(); }
});

test('runtime deletion without live identity never attaches, and duplicates only observe the original receipt', async () => {
  const f = fixture();
  try {
    await f.runtime.start(); await f.runtime.wake();
    const result = await f.runtime.deletion.remove(key, 'original-delete', authorization);
    assert.ok('receipt' in result && result.receipt.state === 'accepted');
    assert.deepEqual(f.calls, ['start', 'session.delete']);
    assert.equal(f.database.hermesJournal.session(key), undefined);
    const duplicate = await f.runtime.deletion.remove(key, 'original-delete', authorization);
    assert.ok('receipt' in duplicate && duplicate.receipt.id === result.receipt.id && !duplicate.admitted);
    const read = await f.runtime.deletion.receipt(key, 'original-delete', authorization);
    assert.ok('receipt' in read && read.receipt?.id === result.receipt.id);
    assert.deepEqual(f.calls, ['start', 'session.delete']); assert.equal(f.factories, 1);
    assert.doesNotMatch(f.reports.join('\n'), /Bearer|isolated-runtime|hermes:original|original-delete|stored/);
  } finally { await f.close(); }
});

test('runtime deletion shares the original live identity, invalidates history-ready and removes its projection', async () => {
  const f = fixture();
  try {
    await f.runtime.start(); await f.runtime.refreshSession(key);
    assert.equal(f.runtime.isSessionHistoryReady(key), true);
    const previous = f.calls.length;
    const result = await f.runtime.deletion.remove(key, 'original-delete', authorization);
    assert.ok('receipt' in result && result.receipt.state === 'accepted');
    assert.deepEqual(f.calls.slice(previous), ['session.activate', 'session.close', 'session.delete']);
    assert.equal(f.runtime.isSessionHistoryReady(key), false); assert.equal(f.store.getSession(key), undefined);
    await assert.rejects(f.runtime.refreshSession(key)); await f.runtime.wake(); assert.equal(f.submits.length, 0);
  } finally { await f.close(); }
});

for (const phase of ['queued', 'running', 'unknown'] as const) test(`runtime deletion cannot bypass original ${phase} execution`, async () => {
  const f = fixture();
  try {
    if (phase === 'queued') { f.gate(false); await f.enqueue(); await f.runtime.start(); }
    else { await f.enqueue(); await f.running(); if (phase === 'unknown') { f.event('message.delta', {}, 9); f.event('message.delta', {}, 11); await until(() => f.database.hermesJournal.current(key)?.phase === 'unknown'); } }
    const calls = [...f.calls];
    const result = await f.runtime.deletion.remove(key, 'original-delete', authorization);
    assert.ok('receipt' in result && !result.admitted && result.receipt.state === 'rejected');
    assert.equal(result.receipt.result?.status, 409);
    assert.equal(f.database.hermesJournal.deletion(key), undefined); assert.deepEqual(f.calls, calls);
  } finally { await f.close(); }
});

test('runtime deletion drains timed-out physical history, not merely the expired refresh waiter', async () => {
  const f = fixture(25), release = deferred<unknown>();
  try {
    await f.runtime.start(); await f.runtime.refreshSession(key);
    f.hooks.request = method => method === 'session.history' ? release.promise : undefined;
    await assert.rejects(f.runtime.refreshSession(key));
    let done = false;
    const deletion = f.runtime.deletion.remove(key, 'original-delete', authorization).then(result => { done = true; return result; });
    await until(() => f.database.hermesJournal.deletion(key) === 'pending'); await tick();
    assert.equal(done, false); assert.equal(f.calls.includes('session.delete'), false);
    await assert.rejects(f.runtime.refreshSession(key));
    release.resolve({ messages: [] });
    const result = await deletion; assert.ok('receipt' in result && result.receipt.state === 'accepted');
    assert.equal(f.calls.filter(call => call === 'session.close').length, 1);
  } finally { release.resolve({ messages: [] }); await f.close(); }
});

for (const method of ['session.create', 'session.resume'] as const)
  test(`runtime deletion never uses the old stored id after a late uncommitted ${method}`, async () => {
    const f = fixture(25), release = deferred<unknown>();
    try {
      if (method === 'session.resume') f.database.hermesJournal.save({ key, stored: 'stored', title: 'Original', started: true, messages: [] });
      await f.runtime.start(); f.hooks.request = invoked => invoked === method ? release.promise : undefined;
      await assert.rejects(f.runtime.refreshSession(key));
      let done = false;
      const deletion = f.runtime.deletion.remove(key, 'original-delete', authorization).then(result => { done = true; return result; });
      await until(() => f.database.hermesJournal.deletion(key) === 'pending'); await tick();
      assert.equal(done, false); assert.equal(f.calls.includes('session.delete'), false);
      release.resolve({ session_id: 'late-live', stored_session_id: 'late-stored', session_key: 'stored' });
      const result = await deletion; assert.ok('receipt' in result && result.receipt.state === 'outcome_unknown');
      assert.equal(f.calls.includes('session.close'), false); assert.equal(f.calls.includes('session.delete'), false);
      await assert.rejects(f.runtime.refreshSession(key));
      const duplicate = await f.runtime.deletion.remove(key, 'original-delete', authorization);
      assert.ok('receipt' in duplicate && !duplicate.admitted && duplicate.receipt.id === result.receipt.id);
      assert.equal(f.calls.filter(call => call === method).length, 1);
    } finally { release.resolve({}); await f.close(); }
  });

test('runtime deletion does not wait for unrelated-session physical work', async () => {
  const f = fixture(), release = deferred<unknown>(), other = 'hermes:other';
  try {
    await f.runtime.start(); await f.runtime.refreshSession(key);
    f.database.hermesJournal.save({ key: other, stored: 'other-stored', title: 'Other', started: false, messages: [] });
    f.hooks.request = (method, params) => method === 'session.create'
      ? Promise.resolve({ session_id: 'other-live', stored_session_id: 'other-stored' })
      : method === 'session.history' && params.session_id === 'other-live' ? release.promise : undefined;
    const refresh = f.runtime.refreshSession(other);
    await until(() => f.calls.filter(call => call === 'session.history').length === 2);
    const result = await f.runtime.deletion.remove(key, 'original-delete', authorization);
    assert.ok('receipt' in result && result.receipt.state === 'accepted');
    release.resolve({ messages: [] }); await refresh;
    assert.equal(f.runtime.isSessionHistoryReady(other), true);
  } finally { release.resolve({ messages: [] }); await f.close(); }
});

for (const fault of ['revoked', 'epoch', 'close-ack', 'delete-ack', 'typed-absence', 'untyped-absence'] as const)
  test(`sole runtime deletion retains original protection for ${fault}`, async () => {
    const f = fixture();
    try {
      await f.runtime.start(); await f.runtime.refreshSession(key);
      f.hooks.request = async method => {
        if (method === 'session.close') {
          if (fault === 'revoked') f.tokens.revoke(f.actor);
          if (fault === 'epoch') f.native.epoch = 'replacement';
          return { closed: fault !== 'close-ack' };
        }
        if (method === 'session.delete') {
          if (fault === 'typed-absence') throw new HermesRemoteError(4007);
          if (fault === 'untyped-absence') throw { code: 4007, message: 'untrusted absent' };
          return { deleted: fault === 'delete-ack' ? 'foreign' : 'stored' };
        }
        return { session_id: 'live', session_key: 'stored', status: 'idle', running: false };
      };
      const result = await f.runtime.deletion.remove(key, 'original-delete', authorization);
      assert.ok('receipt' in result && result.receipt.state === (fault === 'typed-absence' ? 'accepted' : 'outcome_unknown'));
      assert.equal(f.calls.filter(call => call === 'session.close').length, 1);
      assert.equal(f.calls.includes('session.delete'), !['revoked', 'epoch', 'close-ack'].includes(fault));
      assert.equal(f.runtime.isSessionHistoryReady(key), false);
      await assert.rejects(f.runtime.refreshSession(key));
    } finally { await f.close(); }
  });

test('runtime close drains original deletion physical ACK after its bounded wait expired', async () => {
  const f = fixture(25), release = deferred<unknown>();
  try {
    await f.runtime.start();
    f.hooks.request = method => method === 'session.delete' ? release.promise : undefined;
    const result = await f.runtime.deletion.remove(key, 'original-delete', authorization);
    assert.ok('receipt' in result && result.receipt.state === 'outcome_unknown');
    let done = false; const closing = f.runtime.close().then(() => { done = true; });
    await tick(); assert.equal(done, false);
    assert.deepEqual(await f.runtime.deletion.remove(key, 'later-delete', authorization), { error: 409 });
    release.resolve({ deleted: 'stored' }); await closing;
    assert.equal(f.database.hermesJournal.deletion(key), 'pending');
    assert.equal(f.calls.filter(call => call === 'session.delete').length, 1);
  } finally { release.resolve({ deleted: 'stored' }); await f.close(); }
});

test('late typed native absence cannot replace an already reported unknown deletion outcome', async () => {
  const f = fixture(25), release = deferred<unknown>();
  try {
    await f.runtime.start();
    f.hooks.request = method => method === 'session.delete' ? release.promise : undefined;
    const result = await f.runtime.deletion.remove(key, 'original-delete', authorization);
    assert.ok('receipt' in result && result.receipt.state === 'outcome_unknown');
    release.reject(new HermesRemoteError(4007)); await tick();
    const read = await f.runtime.deletion.receipt(key, 'original-delete', authorization);
    assert.ok('receipt' in read && read.receipt?.state === 'outcome_unknown');
    assert.equal(f.database.hermesJournal.deletion(key), 'pending');
    const duplicate = await f.runtime.deletion.remove(key, 'original-delete', authorization);
    assert.ok('receipt' in duplicate && !duplicate.admitted && duplicate.receipt.id === result.receipt.id);
    assert.equal(f.calls.filter(call => call === 'session.delete').length, 1);
  } finally { release.resolve({}); await f.close(); }
});

test('runtime shutdown during deletion inspection permits no later close/delete effect', async () => {
  const f = fixture(), release = deferred<unknown>();
  try {
    await f.runtime.start(); await f.runtime.refreshSession(key);
    f.hooks.request = method => method === 'session.activate' ? release.promise : undefined;
    const deletion = f.runtime.deletion.remove(key, 'original-delete', authorization);
    await until(() => f.calls.includes('session.activate'));
    const closing = f.runtime.close();
    release.resolve({ session_id: 'live', session_key: 'stored', status: 'idle', running: false });
    const result = await deletion; await closing;
    assert.ok('receipt' in result && result.receipt.state === 'outcome_unknown');
    assert.equal(f.calls.includes('session.close'), false); assert.equal(f.calls.includes('session.delete'), false);
  } finally { release.resolve({}); await f.close(); }
});

test('runtime projection failure cannot undo accepted deletion or authorize another native attempt', async () => {
  const f = fixture();
  try {
    await f.runtime.start();
    f.store.removeSession = () => { throw Error('isolated projection'); };
    const result = await f.runtime.deletion.remove(key, 'original-delete', authorization);
    assert.ok('receipt' in result && result.receipt.state === 'accepted');
    assert.equal(f.database.hermesJournal.session(key), undefined);
    const duplicate = await f.runtime.deletion.remove(key, 'original-delete', authorization);
    assert.ok('receipt' in duplicate && duplicate.receipt.id === result.receipt.id);
    assert.equal(f.calls.filter(call => call === 'session.delete').length, 1);
  } finally { await f.close(); }
});

test('original Hermes HTTP deletion port uses the same execution loop and preserves accepted receipt wire', async () => {
  const f = fixture();
  try {
    await f.runtime.start();
    const app = new Hono(), path = `/sessions/${key}`;
    registerHermesDeletionHttp(app, '/sessions/:sessionKey', { lifecycle: f.runtime.deletion, ready: () => f.runtime.ready });
    const response = await app.request(path, { method: 'DELETE', headers: { authorization, 'idempotency-key': 'original-delete' } });
    assert.equal(response.status, 200);
    const body = await response.json(); assert.equal(body.ok, true); assert.equal(body.status, 'delete_accepted');
    assert.equal(body.command.state, 'accepted'); assert.equal(response.headers.get('cache-control'), 'no-store');
    const read = await app.request(`${path}/deletion-commands/original-delete`, { headers: { authorization } });
    assert.equal(read.status, 200); assert.equal((await read.json()).command.id, body.command.id);
    assert.equal(f.calls.filter(call => call === 'session.delete').length, 1); assert.equal(f.factories, 1);
  } finally { await f.close(); }
});
