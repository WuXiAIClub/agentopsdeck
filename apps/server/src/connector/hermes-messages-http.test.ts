import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { AsyncHermesMessages } from './async-hermes-messages.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { createConnectorOwnerCommands } from './connector-owner-domain.js';
import { HERMES_MESSAGE_PAYLOAD_BYTES } from './connector-hermes-message-domain.js';
import { registerHermesMessagesHttp, type HermesMessagesHttp } from './hermes-messages-http.js';

const token = 'isolated-hermes-http-token', authorization = `Bearer ${token}`, key = 'hermes:original';
const path = `/sessions/${key}`, route = '/sessions/:sessionKey';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-hermes-http-'));
  const tokens = new ConnectorTokenStore(join(directory, 'tokens.json'), token);
  const store = new ConnectorUserStore(':memory:', undefined, { runtimeOwner: true });
  store.hermesJournal.save({ key, stored: 'native', title: 'Original', started: false, messages: [] });
  const command = createConnectorOwnerCommands(store, tokens);
  let wakes = 0, ready = true, fallback = 0;
  const messages = new AsyncHermesMessages({ command }, () => { wakes++; });
  const lines: string[] = [], diagnostics = new PerformanceDiagnostics(line => { lines.push(line); });
  const deps: HermesMessagesHttp = { messages, ready: () => ready, diagnostics };
  const app = new Hono(); registerHermesMessagesHttp(app, route, deps);
  app.post(`${route}/messages`, async c => { fallback++; return c.json({ control: await c.req.json() }); });
  app.get(`${route}/commands/:commandKey`, c => { fallback++; return c.json({ legacy: true }); });
  const post = (body: unknown, headers: Record<string, string> = {}) => app.request(`${path}/messages`, {
    method: 'POST', headers: { authorization, ...headers }, body: JSON.stringify(body),
  });
  const get = (commandKey: string, credential = authorization, queue = false) => app.request(`${path}/commands/${commandKey}${queue ? '/queue' : ''}`, {
    headers: { authorization: credential },
  });
  return { app, deps, store, tokens, messages, post, get, lines, command,
    ready: (value: boolean) => { ready = value; }, wakes: () => wakes, fallback: () => fallback,
    close() { command.dispose(); store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('Hermes HTTP original fingerprint/wire/queue survive duplicate, maintenance and runtime unready', async () => {
  const f = fixture();
  try {
    const payload = { message: '  original  ', metadata: 'private original fingerprint', idempotencyKey: 'original-key' };
    const first = await f.post(payload); assert.equal(first.status, 200);
    const body = await first.json(); assert.equal(body.ok, true); assert.equal(body.status, 'queued'); assert.equal(body.command.key, 'original-key');
    assert.equal(first.headers.get('cache-control'), 'no-store'); assert.equal(first.headers.get('x-agentopsdeck-command-key'), 'original-key');
    assert.equal(f.wakes(), 1); assert.equal(f.fallback(), 0);
    f.ready(false); f.store.pauseTurnStarts();
    const duplicate = await f.post(payload); assert.equal(duplicate.status, 200); assert.deepEqual(await duplicate.json(), body);
    assert.equal(f.wakes(), 1); assert.equal((await f.get('original-key')).status, 200);
    const queue = await f.get('original-key', authorization, true); assert.equal(queue.status, 200);
    assert.equal((await queue.json()).queue.presence, 'present');
    assert.equal((await f.post({ ...payload, metadata: 'changed fingerprint' })).status, 409);
    assert.equal((await f.post({ message: 'fresh', idempotencyKey: 'unready' })).status, 409);
    assert.equal(f.wakes(), 1); assert.equal(f.store.turns.maintenanceCount(), 1);
    assert.doesNotMatch(f.lines.join('\n'), /private original fingerprint|isolated-hermes-http-token|hermes:original/);
    assert.match(f.lines.join('\n'), /hermes-message-http/);
  } finally { f.close(); }
});

test('Hermes HTTP validates command keys and JSON, preserves header-only and generated keys', async () => {
  const f = fixture();
  try {
    for (const [body, headers] of [
      [{ message: 'original', idempotencyKey: 'body' }, { 'idempotency-key': 'header' }],
      [{ message: 'original', idempotencyKey: 'body' }, { 'idempotency-key': '' }],
      [{ message: 'original', idempotencyKey: 1 }, {}], [{ message: 'original', idempotencyKey: 'invalid key' }, {}],
      [null, {}], [[], {}],
    ] as const) assert.equal((await f.post(body, headers)).status, 400);
    assert.equal(f.wakes(), 0);
    const generated = await f.post({ message: 'original' }); assert.equal(generated.status, 200);
    assert.equal(generated.headers.get('x-agentopsdeck-command-key'), (await generated.json()).command.key);
    const header = await f.post({ message: 'original' }, { 'idempotency-key': 'header-only' }); assert.equal(header.status, 200);
    assert.equal((await header.json()).command.key, 'header-only');
    assert.equal((await f.get('missing')).status, 404); assert.equal((await f.get('invalid%20key')).status, 400);
    const malformed = await f.app.request(`${path}/messages`, { method: 'POST', headers: { authorization }, body: '{' });
    assert.equal(malformed.status, 400); assert.equal(malformed.headers.get('cache-control'), 'no-store');
  } finally { f.close(); }
});

for (const control of ['/stop', '/status', '/compact', ' /compact ']) test(`Hermes HTTP ${JSON.stringify(control)} keeps original body/control lane`, async () => {
  const f = fixture();
  try {
    const body = { message: control, expectedRunId: 'original-run', idempotencyKey: 'control-key', metadata: 'unchanged' };
    const response = await f.post(body); assert.equal(response.status, 200); assert.deepEqual((await response.json()).control, body);
    assert.equal(f.fallback(), 1); assert.equal(f.wakes(), 0); assert.equal(f.store.turns.maintenanceCount(), 0);
    const scope = JSON.stringify([f.tokens.authenticateAuthorization(authorization)!.tokenId, key]);
    assert.equal(f.store.commands.get(scope, 'control-key'), undefined);
  } finally { f.close(); }
});

test('Hermes HTTP non-Hermes traffic stays on its original lane; all grant headers fail before authority access', async t => {
  const f = fixture(); let calls = 0;
  try {
    assert.equal((await f.app.request('/sessions/codex:original/messages', { method: 'POST', body: '{}' })).status, 200);
    assert.equal((await f.app.request('/sessions/ghcp:original/commands/original')).status, 200); assert.equal(f.fallback(), 2);
    for (const method of ['send', 'readReceipt', 'readSendReceipt'] as const)
      t.mock.method(f.messages, method, async () => { calls++; throw Error('grant reached owner'); });
    for (const grant of ['', 'untrusted-grant']) {
      const headers = { authorization, 'x-agentopsdeck-execution-grant': grant };
      for (const message of ['ordinary', '/stop', '/status', '/compact']) assert.equal((await f.post({ message }, headers)).status, 403);
      for (const suffix of ['', '/queue']) assert.equal((await f.app.request(`${path}/commands/original${suffix}`, { headers })).status, 403);
    }
    assert.equal(calls, 0); assert.equal(f.fallback(), 2); assert.equal(f.wakes(), 0);
  } finally { f.close(); }
});

test('Hermes HTTP send-only receives its POST ACK but cannot read commands; actors remain isolated', async () => {
  const f = fixture();
  try {
    const sender = f.tokens.create({ label: 'sender', scopes: ['messages:send'] }), credential = `Bearer ${sender.token}`;
    assert.equal((await f.post({ message: 'original', idempotencyKey: 'send-only' }, { authorization: credential })).status, 200);
    assert.equal((await f.get('send-only', credential)).status, 403);
    assert.equal((await f.get('send-only', credential, true)).status, 403);
    assert.equal((await f.get('send-only')).status, 404);
    const reader = f.tokens.create({ label: 'reader', scopes: ['messages:read'] });
    assert.equal((await f.post({ message: 'original' }, { authorization: `Bearer ${reader.token}` })).status, 403);
    assert.equal((await f.post({ message: 'original' }, { authorization: '' })).status, 401); assert.equal(f.wakes(), 1);
  } finally { f.close(); }
});

test('Hermes HTTP ACK delivery reauthenticates without rolling back or leaking committed admission', async () => {
  const f = fixture();
  try {
    const sender = f.tokens.create({ label: 'revoked ACK', scopes: ['messages:send', 'messages:read'] });
    const original = f.messages.send.bind(f.messages);
    f.messages.send = async (...args) => { const result = await original(...args); f.tokens.revoke(sender.record.id); return result; };
    const response = await f.post({ message: 'private text', idempotencyKey: 'ack-revoked' }, { authorization: `Bearer ${sender.token}` });
    assert.equal(response.status, 401); assert.equal(f.wakes(), 1); assert.doesNotMatch(await response.text(), /idempotencyKey|queueDisposition|private text/);
    assert.equal(f.store.commands.get(JSON.stringify([sender.record.id, key]), 'ack-revoked')?.state, 'accepted');
    assert.equal(f.store.turns.maintenanceCount(), 1);
  } finally { f.close(); }
});

test('Hermes HTTP slow body revoke is checked by original transaction after upload', async () => {
  const f = fixture(); let finish!: () => void;
  try {
    const sender = f.tokens.create({ label: 'body revoke', scopes: ['messages:send'] });
    const stream = new ReadableStream<Uint8Array>({ start(controller) { finish = () => {
      controller.enqueue(Buffer.from('{"message":"private","idempotencyKey":"body-revoked"}')); controller.close();
    }; } });
    const response = f.app.fetch(new Request(`http://localhost${path}/messages`, { method: 'POST',
      headers: { authorization: `Bearer ${sender.token}` }, body: stream, duplex: 'half' } as RequestInit));
    await tick(); f.tokens.revoke(sender.record.id); finish();
    assert.equal((await response).status, 401); assert.equal(f.wakes(), 0); assert.equal(f.store.turns.maintenanceCount(), 0);
  } finally { f.close(); }
});

test('Hermes HTTP original stop/status and unknown receipts recover without a new queue or wake', async () => {
  const f = fixture();
  try {
    const scope = JSON.stringify([f.tokens.authenticateAuthorization(authorization)!.tokenId, key]);
    const bodies = [
      { ok: true, status: 'interrupt_requested', runId: 'original-run', idempotencyKey: 'stop-key', media: [] },
      { status: 'ok', idempotencyKey: 'original-report-id', deliveryMode: 'web-only', deliver: false, media: [] },
    ];
    for (const [index, body] of bodies.entries()) {
      const commandKey = `control-${index}`; f.store.commands.claim(scope, commandKey, { message: 'control' });
      f.store.commands.settle(scope, commandKey, { status: 200, body });
      const response = await f.get(commandKey); assert.equal(response.status, 200); assert.deepEqual((await response.json()).command.result.body, body);
      assert.equal((await f.get(commandKey, authorization, true)).status, 200);
    }
    f.store.commands.claim(scope, 'uncertain', { message: 'uncertain' });
    const unknown = await f.get('uncertain'); assert.equal(unknown.status, 200); assert.equal((await unknown.json()).command.state, 'outcome_unknown');
    assert.equal(f.wakes(), 0); assert.equal(f.store.turns.maintenanceCount(), 0);
  } finally { f.close(); }
});

test('Hermes HTTP deadline preserves original key and late physical commit is recovered read-only', async () => {
  const f = fixture(); let release!: () => void, sends = 0, wakes = 0;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const messages = new AsyncHermesMessages({ command: async (kind, input) => {
    if (kind === 'hermesMessageSend') { sends++; await pending; } return f.command(kind, input);
  } }, () => { wakes++; });
  const app = new Hono(); registerHermesMessagesHttp(app, route, { messages, ready: () => true, timeoutMs: 30 });
  try {
    const response = await app.request(`${path}/messages`, { method: 'POST', headers: { authorization }, body: '{"message":"original","idempotencyKey":"late-original"}' });
    assert.equal(response.status, 503); assert.equal(response.headers.get('x-agentopsdeck-command-key'), 'late-original');
    assert.equal((await response.json()).status, 'outcome_unknown'); assert.equal(sends, 1); assert.equal(wakes, 0);
    release(); await tick();
    const recovered = await app.request(`${path}/commands/late-original`, { headers: { authorization } });
    assert.equal(recovered.status, 200); assert.equal((await recovered.json()).command.state, 'accepted'); assert.equal(sends, 1); assert.equal(wakes, 1);
  } finally { release(); await tick(); f.close(); }
});

test('Hermes HTTP bounded uploads leave receipt recovery available and free capacity after timeout/oversize', async () => {
  const f = fixture(), complete: Array<() => void> = [], pending: Array<Promise<Response>> = [];
  try {
    for (let index = 0; index < 2; index++) {
      const stream = new ReadableStream<Uint8Array>({ start(controller) { complete.push(() => {
        controller.enqueue(Buffer.from(JSON.stringify({ message: 'original', idempotencyKey: `bounded-${index}` }))); controller.close();
      }); } });
      pending.push(Promise.resolve(f.app.fetch(new Request(`http://localhost${path}/messages`, {
        method: 'POST', headers: { authorization }, body: stream, duplex: 'half',
      } as RequestInit))));
    }
    await tick(); assert.equal((await f.post({ message: 'over capacity' })).status, 503);
    assert.equal((await f.get('missing')).status, 404); assert.equal(f.wakes(), 0);
    complete.forEach(finish => finish()); assert.ok((await Promise.all(pending)).every(response => response.status === 200));
    const oversized = await f.app.request(`${path}/messages`, { method: 'POST', headers: { authorization }, body: ' '.repeat(HERMES_MESSAGE_PAYLOAD_BYTES + 1) });
    assert.equal(oversized.status, 413); assert.equal((await f.post({ message: 'after pressure' })).status, 200);
    const app = new Hono(); registerHermesMessagesHttp(app, route, { messages: f.messages, ready: () => true, timeoutMs: 15 });
    let cancelled = false;
    const stream = new ReadableStream({ cancel() { cancelled = true; } });
    const timed = await app.fetch(new Request(`http://localhost${path}/messages`, {
      method: 'POST', headers: { authorization }, body: stream, duplex: 'half',
    } as RequestInit));
    assert.equal(timed.status, 408); assert.equal(cancelled, true);
    assert.equal((await app.request(`${path}/messages`, { method: 'POST', headers: { authorization }, body: '{"message":"after timeout"}' })).status, 200);
  } finally { complete.forEach(finish => { try { finish(); } catch {} }); await Promise.all(pending); f.close(); }
});

test('Hermes HTTP asynchronous readiness cannot authorize fresh work or hide a saved receipt', async () => {
  const f = fixture();
  try {
    const body = { message: 'original', idempotencyKey: 'ready-key' }; assert.equal((await f.post(body)).status, 200);
    f.deps.ready = (() => Promise.resolve(true)) as unknown as HermesMessagesHttp['ready'];
    assert.equal((await f.post(body)).status, 200); assert.equal((await f.post({ message: 'fresh' })).status, 409); assert.equal(f.wakes(), 1);
  } finally { f.close(); }
});

test('Hermes HTTP real worker closes/reopens with original receipts and queue, no replay or new writer', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hermes-http-worker-'));
  const config = { file: join(directory, 'connector.sqlite'), tokenFile: join(directory, 'tokens.json'), bootstrapToken: token };
  const source = new ConnectorUserStore(config.file);
  source.hermesJournal.save({ key, stored: 'native', title: 'Original', started: false, messages: [] }); source.close();
  const diagnostics = new PerformanceDiagnostics(() => {});
  let owner = new AsyncConnectorOwner(config, diagnostics), ready = true, wakes = 0;
  const build = () => {
    const messages = new AsyncHermesMessages(owner, () => { wakes++; });
    const app = new Hono(); registerHermesMessagesHttp(app, route, { messages, ready: () => ready, diagnostics }); return app;
  };
  try {
    await owner.open(); let app = build();
    const post = () => app.request(`${path}/messages`, { method: 'POST', headers: { authorization }, body: '{"message":"original","idempotencyKey":"saved-key"}' });
    const first = await post(); assert.equal(first.status, 200); const body = await first.json(); assert.equal(wakes, 1);
    await owner.close(); owner = new AsyncConnectorOwner(config, diagnostics); await owner.open(); ready = false; app = build();
    const duplicate = await post(); assert.equal(duplicate.status, 200); assert.deepEqual(await duplicate.json(), body); assert.equal(wakes, 1);
    const recovered = await app.request(`${path}/commands/saved-key/queue`, { headers: { authorization } });
    assert.equal(recovered.status, 200); assert.equal((await recovered.json()).queue.presence, 'present');
    assert.equal(await owner.command('turnMaintenanceCount', { runtime: 'hermes' }), 1);
  } finally { await owner.close(); rmSync(directory, { recursive: true, force: true }); }
});
