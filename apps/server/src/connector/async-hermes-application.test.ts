import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { AsyncHermesApplication } from './async-hermes-application.js';
import { DeckStore } from '../projection/deck-store.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { HermesTransport } from '../hermes/runtime.js';
import type { HermesEvent } from '../hermes/protocol.js';
import { registerHermesCreationHttp } from './hermes-creation-http.js';
import { registerHermesMessagesHttp } from './hermes-messages-http.js';
import { registerHermesDeletionHttp } from './hermes-deletion-http.js';
import { registerHermesQueueHttp } from './hermes-queue-http.js';
import { registerHermesReadsHttp } from './hermes-reads-http.js';

const authorization = 'Bearer isolated-hermes-application';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function until(check: () => boolean | Promise<boolean>) {
  const end = Date.now() + 5000;
  while (!await check()) { assert.ok(Date.now() < end, 'Hermes application did not converge'); await tick(); }
}
async function fixture(options: { disabled?: boolean; start?: () => Promise<void> } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-hermes-app-'));
  const logs: string[] = [], diagnostics = new PerformanceDiagnostics(line => logs.push(line));
  const owner = new AsyncConnectorOwner({ file: join(root, 'connector.sqlite'), tokenFile: join(root, 'tokens.json'),
    bootstrapToken: authorization.slice(7) }, diagnostics);
  await owner.open();
  const calls: string[] = [], commands: string[] = [], submitted: string[] = [];
  const rows: { row_id: number; role: string; text: string; timestamp: number }[] = [];
  let factories = 0, serial = 0, sequence = 0, available: unknown = true;
  let emit!: (event: HermesEvent) => void;
  const hooks: { command?: (kind: string) => Promise<void>; changed?: () => Promise<void>; close?: () => Promise<void> } = {};
  const port: Pick<AsyncConnectorOwner, 'command'> = { command: async (kind, input) => {
    commands.push(kind); const output = await owner.command(kind, input); await hooks.command?.(kind); return output;
  } };
  const native: HermesTransport & { ready: boolean; epoch: string } = {
    ready: false, epoch: 'original-epoch',
    async start() { calls.push('start'); await options.start?.(); native.ready = true; },
    async close() { calls.push('close'); native.ready = false; await hooks.close?.(); },
    async request(method, params) {
      calls.push(method); const input = params as Record<string, unknown>;
      if (method === 'session.create') return { session_id: 'live', stored_session_id: 'stored' };
      if (method === 'session.activate' || method === 'session.resume') return { session_id: 'live', session_key: 'stored', status: 'idle', running: false };
      if (method === 'session.history') return { messages: rows.map(row => ({ ...row })) };
      if (method === 'prompt.submit') { submitted.push(String(input.text)); rows.push({ row_id: ++serial, role: 'user', text: String(input.text), timestamp: serial }); return { status: 'streaming' }; }
      if (method === 'session.interrupt') return { interrupted: true };
      if (method === 'session.close') return { closed: true };
      if (method === 'session.delete') return { deleted: input.session_id };
      throw Error('Unexpected fake native method');
    },
  };
  const deck = new DeckStore();
  const application = new AsyncHermesApplication({ owner: port, projection: deck, eventSnapshot: capture => capture(`fixture:${sequence}`),
    config: { enabled: !options.disabled, executable: join(root, 'python'), sourceDirectory: root, homeDirectory: root, workspace: root, startupTimeoutMs: 1000 },
    executionAvailable: () => available as boolean, queueChanged: async () => { await hooks.changed?.(); }, diagnostics },
  event => { factories++; emit = event; return native; });
  const app = new Hono(), base = '/api/connector/v1', path = `${base}/sessions/:sessionKey`;
  registerHermesCreationHttp(app, base, application.http.hermesCreation);
  registerHermesMessagesHttp(app, path, application.http.hermesMessages);
  registerHermesDeletionHttp(app, path, application.http.hermesDeletion);
  registerHermesQueueHttp(app, path, application.http.hermesQueue);
  registerHermesReadsHttp(app, path, application.http.hermesReads);
  const request = (path: string, method = 'GET', body?: unknown) => app.request(`${base}${path}`, {
    method, headers: { authorization, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const create = async () => {
    const response = await request('/agents/hermes/sessions', 'POST', { title: 'Original application', idempotencyKey: 'original-create' });
    assert.equal(response.status, 201); const body = await response.json() as { key: string }; assert.ok(body.key); return body.key;
  };
  const finish = () => { rows.push({ row_id: ++serial, role: 'assistant', text: 'Original answer', timestamp: serial });
    emit({ type: 'message.complete', payload: { status: 'complete' }, sessionId: 'live', seq: ++sequence }); };
  return { owner, application, deck, request, create, calls, commands, submitted, logs, hooks, finish,
    factories: () => factories, nativeReady: () => native.ready, setAvailable: (value: unknown) => { available = value; },
    close: async () => { try { await application.close(); } finally { await owner.close(); rmSync(root, { recursive: true, force: true }); } } };
}

test('Hermes application is inert, disabled and finite; close never owns the shared database', async () => {
  const f = await fixture({ disabled: true });
  try {
    assert.equal(f.application.status, 'disabled'); assert.deepEqual(f.application.agents, []);
    await f.application.start(); await f.application.refreshProjection();
    assert.equal(f.application.ready, false); assert.equal(f.factories(), 0); assert.deepEqual(f.commands, []);
    await f.application.close(); assert.equal(f.application.status, 'closed');
    await assert.rejects(f.application.start());
    await f.owner.command('hermesExecutionPage', { after: '', limit: 1 });
    for (const timeoutMs of [0, NaN, Infinity, 0.5, 2 ** 31]) assert.throws(() => new AsyncHermesApplication({
      owner: f.owner, projection: f.deck, eventSnapshot: capture => capture('fixture'),
      executionAvailable: () => true, queueChanged() {}, timeoutMs }), /deadline/);
  } finally { await f.close(); }
});

test('Hermes application starts one original runtime only after recovery and native ready', async () => {
  const startup = gate(), entered = gate();
  const f = await fixture({ start: async () => { entered.release(); await startup.promise; } });
  try {
    assert.deepEqual(f.commands, []); assert.equal(f.factories(), 0);
    await assert.rejects(f.application.refreshProjection());
    const first = f.application.start(); assert.equal(first, f.application.start());
    await entered.promise; assert.equal(f.application.ready, false); assert.equal(f.application.status, 'starting');
    startup.release(); await first;
    assert.equal(f.application.ready, true); assert.equal(f.factories(), 1);
    const before = f.calls.length; await f.application.refreshProjection();
    assert.equal(f.calls.length, before); assert.equal(f.factories(), 1);
    await f.application.start(); assert.equal(f.factories(), 1);
  } finally { startup.release(); await f.close(); }
});

test('Hermes application complete HTTP chain preserves original receipts, controls, maintenance and deletion', async () => {
  const f = await fixture();
  try {
    await f.application.start(); const key = await f.create();
    const send = (commandKey: string, message: string, extra = {}) => f.request(`/sessions/${key}/messages`, 'POST', { message, idempotencyKey: commandKey, ...extra });
    assert.equal((await send('first-input', 'Private original input')).status, 200);
    await until(() => f.submitted.length === 1);
    await until(async () => (await f.owner.command('hermesExecutionRead', { sessionKey: key }))?.phase === 'running');
    const running = await f.owner.command('hermesExecutionRead', { sessionKey: key }); assert.ok(running);
    assert.equal((await send('status-input', '/status')).status, 200);
    assert.equal((await send('first-input', 'Private original input')).status, 200);
    assert.equal((await send('first-input', 'Changed fingerprint')).status, 409);
    assert.equal(f.submitted.length, 1);
    assert.equal((await f.request(`/sessions/${key}/queue`)).status, 200);
    assert.equal((await send('stop-input', '/stop', { expectedRunId: running.id })).status, 200);
    assert.equal(f.calls.filter(call => call === 'session.interrupt').length, 1);
    assert.equal((await send('stop-input', '/stop', { expectedRunId: running.id })).status, 200);
    assert.equal(f.calls.filter(call => call === 'session.interrupt').length, 1);
    const pause = f.application.pauseQueueWorker(); await pause.drained;
    assert.equal((await send('next-input', 'Original successor')).status, 200);
    f.finish();
    await until(async () => (await f.owner.command('hermesExecutionRead', { sessionKey: key }))?.phase === 'completed');
    assert.equal(f.submitted.length, 1); assert.equal((await send('paused-status', '/status')).status, 200);
    pause.resume(); await until(() => f.submitted.length === 2);
    await until(async () => (await f.owner.command('hermesExecutionRead', { sessionKey: key }))?.phase === 'running');
    f.finish(); await until(async () => (await f.owner.command('hermesExecutionRead', { sessionKey: key }))?.phase === 'completed');
    assert.equal((await f.request(`/sessions/${key}`, 'DELETE', { idempotencyKey: 'delete-original' })).status, 200);
    assert.equal(f.calls.filter(call => call === 'session.delete').length, 1);
    const logs = f.logs.join('\n');
    assert.ok(logs.includes('hermes-session-creation'));
    for (const secret of [authorization, key, 'Private original input', 'Original successor']) assert.equal(logs.includes(secret), false);
  } finally { await f.close(); }
});

test('Hermes application requires strict execution readiness and resumes only the original queued input', async () => {
  const f = await fixture();
  try {
    await f.application.start(); const key = await f.create(); f.setAvailable(1);
    assert.equal(f.application.status, 'maintenance');
    assert.equal((await f.request(`/sessions/${key}/messages`, 'POST', { message: 'Original waiting input', idempotencyKey: 'strict-ready' })).status, 200);
    await f.application.refreshProjection(); assert.equal(f.submitted.length, 0);
    f.setAvailable(true); const pause = f.application.pauseQueueWorker(); await pause.drained; pause.resume();
    await until(() => f.submitted.length === 1); assert.equal(f.submitted[0], 'Original waiting input');
  } finally { await f.close(); }
});

test('Hermes complete application reads original history and current state through its sole owner and transport', async () => {
  const f = await fixture();
  try {
    await f.application.start(); const key = await f.create();
    assert.equal((await f.request(`/sessions/${key}/state`)).status, 200);
    assert.equal((await f.request(`/sessions/${key}/messages`, 'POST', { message: 'Read original input', idempotencyKey: 'read-original' })).status, 200);
    await until(() => f.submitted.length === 1); f.finish();
    await until(async () => (await f.owner.command('hermesExecutionRead', { sessionKey: key }))?.phase === 'completed');
    const response = await f.request(`/sessions/${key}/messages`); assert.equal(response.status, 200);
    const body = await response.json() as { messages: { id: string; text: string }[]; sourceCursor: string };
    assert.ok(body.messages.some(m => m.text === 'Original answer')); assert.match(body.sourceCursor, /^fixture:/);
    const message = body.messages.find(m => m.text === 'Original answer')!;
    const detail = await f.request(`/sessions/${key}/messages/${encodeURIComponent(message.id)}`); assert.equal(detail.status, 200);
    assert.equal((await detail.json() as { message: { text: string } }).message.text, 'Original answer');
    assert.equal(f.factories(), 1); assert.equal(f.submitted.length, 1);
    assert.ok(f.commands.includes('hermesReadDeliver'));
    await f.application.close(); assert.equal((await f.request(`/sessions/${key}/state`)).status, 503);
  } finally { await f.close(); }
});

test('Hermes application close freezes ingress and drains lost message ACK and publication without closing shared owner', async () => {
  const ack = gate(), entered = gate(); const f = await fixture();
  try {
    await f.application.start(); const key = await f.create();
    f.hooks.command = async kind => { if (kind === 'hermesMessageSend') { entered.release(); await ack.promise; } };
    const input = { key, authorization, commandKey: 'lost-ack', payloadJson: '{"message":"Original late commit"}' };
    const pending = f.application.http.hermesMessages.messages.send(input, { timeoutMs: 10 });
    const rejected = assert.rejects(pending); await entered.promise; await rejected;
    let closed = false; const closing = f.application.close().then(() => { closed = true; });
    assert.equal(f.application.ready, false); await tick(); assert.equal(closed, false);
    await assert.rejects(f.application.http.hermesMessages.messages.send({ ...input, commandKey: 'after-close' }, { timeoutMs: 1000 }));
    ack.release(); await closing;
    const receipt = await f.owner.command('hermesMessageSendReceiptRead', { key, authorization, commandKey: 'lost-ack' });
    assert.ok('receipt' in receipt && receipt.receipt); assert.equal(f.submitted.length, 0);
    assert.deepEqual(await f.owner.command('hermesExecutionPage', { after: '', limit: 1 }), [key]);
  } finally { ack.release(); await f.close(); }
});

test('Hermes application startup failure stays failed without a replacement native owner', async () => {
  const f = await fixture({ start: async () => { throw Error('private native failure'); } });
  try {
    await assert.rejects(f.application.start()); assert.equal(f.application.status, 'failed'); assert.equal(f.application.ready, false);
    await assert.rejects(f.application.start()); f.application.activate(); await tick(); assert.equal(f.factories(), 1);
    await f.application.close(); assert.equal(f.calls.filter(call => call === 'close').length, 1);
    assert.equal(f.logs.join('\n').includes('private native failure'), false);
  } finally { await f.close(); }
});

test('Hermes application close before activation starts no native effects', async () => {
  const f = await fixture();
  try {
    await f.application.close(); f.application.activate(); await assert.rejects(f.application.start());
    assert.equal(f.factories(), 0); assert.deepEqual(f.calls, []);
  } finally { await f.close(); }
});

test('Hermes application close during native startup waits and retires the same native owner', async () => {
  const startup = gate(), entered = gate();
  const f = await fixture({ start: async () => { entered.release(); await startup.promise; } });
  try {
    const starting = assert.rejects(f.application.start()); await entered.promise;
    let closed = false; const closing = f.application.close().then(() => { closed = true; });
    await tick(); assert.equal(closed, false); assert.equal(f.application.ready, false);
    startup.release(); await starting; await closing;
    assert.deepEqual(f.calls, ['start', 'close']); assert.equal(f.factories(), 1); assert.equal(f.nativeReady(), false);
  } finally { startup.release(); await f.close(); }
});

test('Hermes application failed native close still drains physical message publication', async () => {
  const publication = gate(), entered = gate(); const f = await fixture();
  try {
    await f.application.start(); const key = await f.create(); f.setAvailable(false);
    f.hooks.changed = async () => { entered.release(); await publication.promise; };
    f.hooks.close = async () => { throw Error('private close failure'); };
    const pending = f.application.http.hermesMessages.messages.send({ key, authorization, commandKey: 'publish-drain',
      payloadJson: '{"message":"Original publication"}' }, { timeoutMs: 10_000 });
    await entered.promise; let closed = false;
    const closing = assert.rejects(f.application.close()).then(() => { closed = true; });
    await tick(); assert.equal(closed, false); publication.release(); await pending; await closing;
    assert.equal(f.logs.join('\n').includes('private close failure'), false);
    assert.ok(await f.owner.command('hermesMessageSendReceiptRead', { key, authorization, commandKey: 'publish-drain' }));
  } finally { publication.release(); await f.close().catch(() => {}); }
});
