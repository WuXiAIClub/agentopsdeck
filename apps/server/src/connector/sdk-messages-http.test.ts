import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { createConnectorOwnerCommands } from './connector-owner-domain.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { AsyncSdkMessages } from './async-sdk-messages.js';
import { AsyncSdkDispatch } from './async-sdk-dispatch.js';
import type { SdkExecution } from './sdk-execution-journal.js';
import { registerSdkMessagesHttp, type SdkMessagesHttp } from './sdk-messages-http.js';

const token = 'isolated-sdk-http-token', authorization = `Bearer ${token}`;
const base = '/sessions', path = `${base}/ghcp:original`, catalogs = { ghcp: { model: 'default' } };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-sdk-http-'));
  const tokens = new ConnectorTokenStore(join(directory, 'tokens.json'), token);
  const store = new ConnectorUserStore(':memory:', undefined, { runtimeOwner: true });
  store.copilotJournal.create({ key: 'ghcp:original', title: 'Original', nativeSessionId: 'original-native', createdAt: 1 });
  const command = createConnectorOwnerCommands(store, tokens, catalogs);
  let wakes = 0, ready = true, fallback = 0;
  const messages = new AsyncSdkMessages({ command }, () => { wakes++; });
  const lines: string[] = [], diagnostics = new PerformanceDiagnostics(line => { lines.push(line); });
  const app = new Hono();
  const deps: SdkMessagesHttp = { messages, ready: () => ready, diagnostics };
  registerSdkMessagesHttp(app, `${base}/:sessionKey`, deps);
  app.post(`${base}/:sessionKey/messages`, async c => { fallback++; return c.json({ control: await c.req.json() }); });
  app.get(`${base}/:sessionKey/commands/:commandKey`, c => { fallback++; return c.json({ legacy: true }); });
  const post = (body: unknown, headers: Record<string, string> = {}) => app.request(`${path}/messages`, {
    method: 'POST', headers: { authorization, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  const get = (key: string, credential = authorization, queue = false) => app.request(`${path}/commands/${key}${queue ? '/queue' : ''}`, { headers: { authorization: credential } });
  return { app, deps, store, tokens, messages, post, get, lines, command,
    ready: (value: boolean) => { ready = value; }, wakes: () => wakes, fallback: () => fallback,
    close: () => { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('HTTP ordinary message retains original wire/key/fingerprint and read-only recovery survives runtime unready', async () => {
  const f = fixture();
  try {
    const payload = { message: '  original  ', metadata: 'original raw fingerprint', idempotencyKey: 'original-key' };
    const first = await f.post(payload); assert.equal(first.status, 200);
    assert.equal(first.headers.get('cache-control'), 'no-store'); assert.equal(first.headers.get('x-agentopsdeck-command-key'), 'original-key');
    const body = await first.json(); assert.equal(body.ok, true); assert.equal(body.status, 'queued'); assert.equal(body.command.key, 'original-key');
    assert.equal(f.wakes(), 1); assert.equal(f.fallback(), 0);
    f.ready(false);
    const duplicate = await f.post(payload); assert.equal(duplicate.status, 200); assert.deepEqual(await duplicate.json(), body); assert.equal(f.wakes(), 1);
    const read = await f.get('original-key'); assert.equal(read.status, 200); assert.equal((await read.json()).command.result.body.idempotencyKey, body.idempotencyKey);
    const queue = await f.get('original-key', authorization, true); assert.equal(queue.status, 200); assert.equal((await queue.json()).queue.presence, 'present');
    const conflict = await f.post({ ...payload, metadata: 'changed' }); assert.equal(conflict.status, 409); assert.equal(f.wakes(), 1);
    const denied = await f.post({ message: 'new', idempotencyKey: 'unready-new' }); assert.equal(denied.status, 409);
    assert.equal((await denied.json()).command.state, 'rejected'); assert.equal(f.wakes(), 1);
    assert.doesNotMatch(f.lines.join('\n'), /original raw fingerprint|isolated-sdk-http-token|ghcp:original/);
    assert.match(f.lines.join('\n'), /sdk-message-http/);
  } finally { f.close(); }
});

test('HTTP header/body key validation and generated keys do not alter original payload identity', async () => {
  const f = fixture();
  try {
    for (const [body, headers] of [
      [{ message: 'original', idempotencyKey: 'body' }, { 'idempotency-key': 'header' }],
      [{ message: 'original', idempotencyKey: 1 }, {}],
      [{ message: 'original', idempotencyKey: 'invalid key' }, {}],
      [null, {}], [[], {}],
    ] as const) assert.equal((await f.post(body, headers)).status, 400);
    assert.equal(f.wakes(), 0);
    const generated = await f.post({ message: 'original' }); assert.equal(generated.status, 200);
    const body = await generated.json(); assert.equal(generated.headers.get('x-agentopsdeck-command-key'), body.command.key);
    assert.equal((await f.get(body.command.key)).status, 200);
    const header = await f.post({ message: 'original' }, { 'idempotency-key': 'header-only' }); assert.equal(header.status, 200);
    assert.equal((await header.json()).command.key, 'header-only');
    assert.equal((await f.get('invalid%20key')).status, 400);
    const missing = await f.get('missing'); assert.equal(missing.status, 404); assert.equal(missing.headers.get('cache-control'), 'no-store');
  } finally { f.close(); }
});

for (const control of ['/stop', '/status', '/compact', ' /compact ']) test(`HTTP ${JSON.stringify(control)} uses original control body exactly once`, async () => {
  const f = fixture();
  try {
    const body = { message: control, expectedRunId: 'original-run', idempotencyKey: 'control-key', metadata: 'unchanged' };
    const response = await f.post(body); assert.equal(response.status, 200); assert.deepEqual((await response.json()).control, body);
    assert.equal(f.fallback(), 1); assert.equal(f.wakes(), 0);
    assert.equal(f.store.commands.get(JSON.stringify([f.tokens.authenticateAuthorization(authorization)!.tokenId, 'ghcp:original']), 'control-key'), undefined);
  } finally { f.close(); }
});

test('HTTP non-SDK messages and receipts remain on original lane', async () => {
  const f = fixture();
  try {
    const response = await f.app.request('/sessions/codex:original/messages', { method: 'POST', body: JSON.stringify({ message: 'original' }) });
    assert.equal(response.status, 200); assert.equal(f.fallback(), 1);
    assert.equal((await f.app.request('/sessions/codex:original/commands/original')).status, 200);
    assert.equal(f.fallback(), 2); assert.equal(f.wakes(), 0);
  } finally { f.close(); }
});

test('HTTP SDK messages and receipt reads reject even empty execution grants before any authority or fallback', async t => {
  const f = fixture();
  try {
    let calls = 0;
    for (const method of ['send', 'readReceipt', 'readSendReceipt'] as const) {
      t.mock.method(f.messages, method, async () => { calls++; throw Error('grant reached owner'); });
    }
    f.deps.stop = async () => { calls++; throw Error('grant reached native driver'); };
    for (const grant of ['', 'untrusted-grant']) {
      const headers = { 'x-agentopsdeck-execution-grant': grant };
      for (const message of ['ordinary', '/stop', '/status', '/compact']) {
        assert.equal((await f.post({ message, expectedRunId: 'original', idempotencyKey: 'grant-key' }, headers)).status, 403);
      }
      for (const suffix of ['', '/queue']) {
        assert.equal((await f.app.request(`${path}/commands/grant-key${suffix}`, { headers: { authorization, ...headers } })).status, 403);
      }
    }
    assert.equal(calls, 0); assert.equal(f.fallback(), 0); assert.equal(f.wakes(), 0);
    assert.doesNotMatch(f.lines.join('\n'), /untrusted-grant|isolated-sdk-http-token/);
  } finally { f.close(); }
});

test('HTTP send-only may receive original POST receipt but cannot use public receipt GET', async () => {
  const f = fixture();
  try {
    const sendOnly = f.tokens.create({ label: 'send only', scopes: ['messages:send'] });
    const credential = `Bearer ${sendOnly.token}`;
    const response = await f.post({ message: 'original', idempotencyKey: 'send-only' }, { authorization: credential });
    assert.equal(response.status, 200); assert.equal(f.wakes(), 1);
    assert.equal((await f.get('send-only', credential)).status, 403);
    const readOnly = f.tokens.create({ label: 'read only', scopes: ['messages:read'] });
    assert.equal((await f.post({ message: 'original' }, { authorization: `Bearer ${readOnly.token}` })).status, 403);
    assert.equal((await f.get('send-only', authorization)).status, 404, 'receipt scope never crosses actors');
    assert.equal((await f.post({ message: 'original' }, { authorization: '' })).status, 401);
  } finally { f.close(); }
});

test('HTTP ACK delivery rechecks current token without undoing original admission or leaking the ACK', async () => {
  const f = fixture();
  try {
    const credential = f.tokens.create({ label: 'revoke after ACK', scopes: ['messages:send', 'messages:read'] });
    const original = f.messages.send.bind(f.messages);
    f.messages.send = async (...args) => { const result = await original(...args); f.tokens.revoke(credential.record.id); return result; };
    const response = await f.post({ message: 'original', idempotencyKey: 'ack-revoked' }, { authorization: `Bearer ${credential.token}` });
    assert.equal(response.status, 401); assert.equal(f.wakes(), 1);
    assert.equal(f.store.commands.get(JSON.stringify([credential.record.id, 'ghcp:original']), 'ack-revoked')?.state, 'accepted');
    assert.equal(f.store.turns.maintenanceCount(), 1);
    assert.doesNotMatch(await response.text(), /idempotencyKey|queueDisposition/);
  } finally { f.close(); }
});

test('HTTP upload revoke is checked again inside worker admission after body wait', async () => {
  const f = fixture();
  try {
    const credential = f.tokens.create({ label: 'body revoke', scopes: ['messages:send'] });
    let finish!: (part: Uint8Array) => void;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { finish = part => { controller.enqueue(part); controller.close(); }; } });
    const request = new Request(`http://localhost${path}/messages`, { method: 'POST', headers: { authorization: `Bearer ${credential.token}` }, body: stream, duplex: 'half' } as RequestInit);
    const response = f.app.fetch(request); await tick();
    f.tokens.revoke(credential.record.id); finish(Buffer.from(JSON.stringify({ message: 'original', idempotencyKey: 'body-revoked' })));
    assert.equal((await response).status, 401); assert.equal(f.wakes(), 0); assert.equal(f.store.turns.maintenanceCount(), 0);
  } finally { f.close(); }
});

test('HTTP old stop/status receipts are read without retiring original owner', async () => {
  const f = fixture();
  try {
    const scope = JSON.stringify([f.tokens.authenticateAuthorization(authorization)!.tokenId, 'ghcp:original']);
    const bodies = [
      { ok: true, status: 'interrupt_requested', runId: 'original-run', idempotencyKey: 'stop-key', media: [] },
      { status: 'ok', idempotencyKey: 'original-report-id', deliveryMode: 'web-only', deliver: false, media: [] },
    ];
    for (const [index, body] of bodies.entries()) {
      const key = `old-control-${index}`; f.store.commands.claim(scope, key, { message: 'control' });
      f.store.commands.settle(scope, key, { status: 200, body });
      const response = await f.get(key); assert.equal(response.status, 200); assert.deepEqual((await response.json()).command.result.body, body);
      assert.equal((await f.get(key, authorization, true)).status, 200);
    }
    assert.equal(f.wakes(), 0);
  } finally { f.close(); }
});

test('HTTP deadline returns original key/unknown; late physical commit is recovered only by GET', async () => {
  const f = fixture();
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  try {
    let sends = 0;
    const messages = new AsyncSdkMessages({ command: async (kind, input) => {
      if (kind === 'sdkMessageSend') { sends++; await pending; }
      return f.command(kind, input);
    } }, () => {});
    const app = new Hono(); registerSdkMessagesHttp(app, `${base}/:sessionKey`, { messages, ready: () => true, timeoutMs: 20 });
    const response = await app.request(`${path}/messages`, { method: 'POST', headers: { authorization }, body: JSON.stringify({ message: 'original', idempotencyKey: 'late-original' }) });
    assert.equal(response.status, 503); assert.equal(response.headers.get('x-agentopsdeck-command-key'), 'late-original');
    assert.equal((await response.json()).status, 'outcome_unknown'); assert.equal(sends, 1);
    release(); await tick();
    const recovered = await app.request(`${path}/commands/late-original`, { headers: { authorization } });
    assert.equal(recovered.status, 200); assert.equal((await recovered.json()).command.state, 'accepted'); assert.equal(sends, 1);
  } finally { release(); await tick(); f.close(); }
});

test('HTTP assembly pressure is bounded and recovers without rejecting read-only receipt queries', async () => {
  const f = fixture(), finish: Array<() => void> = [], pending: Array<Promise<Response>> = [];
  try {
    for (let index = 0; index < 2; index++) {
      const stream = new ReadableStream<Uint8Array>({ start(controller) { finish.push(() => {
        controller.enqueue(Buffer.from(JSON.stringify({ message: 'original', idempotencyKey: `bounded-${index}` }))); controller.close();
      }); } });
      pending.push(Promise.resolve(f.app.fetch(new Request(`http://localhost${path}/messages`, { method: 'POST', headers: { authorization }, body: stream, duplex: 'half' } as RequestInit))));
    }
    await tick();
    assert.equal((await f.post({ message: 'overflow' })).status, 503);
    assert.equal((await f.get('missing')).status, 404);
    assert.equal(f.wakes(), 0);
    for (const complete of finish) complete();
    for (const response of await Promise.all(pending)) assert.equal(response.status, 200);
    assert.equal((await f.post({ message: 'after pressure', idempotencyKey: 'after-pressure' })).status, 200);
    assert.equal(f.wakes(), 3);
  } finally { await Promise.all(pending); f.close(); }
});

test('HTTP Promise-like readiness cannot grant fresh admission and cannot hide a saved receipt', async () => {
  const f = fixture();
  try {
    const accepted = await f.post({ message: 'original', idempotencyKey: 'original-ready' }); assert.equal(accepted.status, 200);
    f.deps.ready = (() => Promise.resolve(true)) as unknown as SdkMessagesHttp['ready'];
    assert.equal((await f.post({ message: 'original', idempotencyKey: 'original-ready' })).status, 200);
    assert.equal((await f.post({ message: 'new', idempotencyKey: 'promise-ready' })).status, 409);
    assert.equal(f.wakes(), 1);
  } finally { f.close(); }
});

for (const runtime of ['claude-code', 'ghcp'] as const) test(`${runtime}: real HTTP→worker→one original executor→settlement and disabled-runtime recovery`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-sdk-http-worker-'));
  const owner = new AsyncConnectorOwner({ file: join(directory, 'connector.sqlite'), tokenFile: join(directory, 'tokens.json'), bootstrapToken: token,
    sdkModels: { [runtime]: { model: 'default' } } }, new PerformanceDiagnostics(() => {}));
  let sends = 0, work: Promise<unknown> | undefined, execution: SdkExecution | undefined, ready = true;
  const dispatch = new AsyncSdkDispatch({ owner, runtime, deadlineMs: 10_000, adapter: {
    epoch: 'original-http-epoch', ready: true, send: async (ref, text) => { sends++; execution = ref; assert.equal(text, 'original HTTP input'); return { nativeRequestId: 'original-http-request' }; },
    interrupt: async () => { throw Error('not a control'); }, inspectSettlement: async ref => ({ ...ref, historyPersisted: true, nativeQuiescent: true }),
  } });
  const messages = new AsyncSdkMessages(owner, (_runtime, key) => { work = dispatch.dispatch(key); });
  const app = new Hono(); registerSdkMessagesHttp(app, `${base}/:sessionKey`, { messages, ready: () => ready });
  try {
    await owner.open();
    const allocated = await owner.command('sdkSessionCreate', { runtime, authorization, commandKey: 'allocate-http', payloadJson: '{}' });
    assert.ok('receipt' in allocated && allocated.key);
    const url = `${base}/${allocated.key}`, body = JSON.stringify({ message: 'original HTTP input', idempotencyKey: 'original-http' });
    const post = () => app.request(`${url}/messages`, { method: 'POST', headers: { authorization }, body });
    const response = await post(); assert.equal(response.status, 200); const original = await response.json();
    assert.equal(await work, 'accepted'); assert.equal(sends, 1); assert.ok(execution);
    assert.equal(await dispatch.terminal(execution, 'completed'), true); assert.equal(await dispatch.settle(execution), true);
    ready = false;
    const duplicate = await post(); assert.equal(duplicate.status, 200); assert.deepEqual(await duplicate.json(), original); assert.equal(sends, 1);
    const recovered = await app.request(`${url}/commands/original-http`, { headers: { authorization } });
    assert.equal(recovered.status, 200); assert.equal((await recovered.json()).command.state, 'accepted');
    assert.equal(await dispatch.dispatch(allocated.key), 'not_started'); assert.equal(sends, 1);
  } finally { await work; await owner.close(); rmSync(directory, { recursive: true, force: true }); }
});
