import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { createConnectorOwnerCommands } from './connector-owner-domain.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { AsyncSdkQueue } from './async-sdk-queue.js';
import { registerSdkQueueHttp, type SdkQueueHttp } from './sdk-queue-http.js';
import { validConnectorSdkQueueInput } from './connector-sdk-queue-domain.js';
import type { SdkAgentId } from './sdk-execution-journal.js';

const token = 'isolated-sdk-queue-http', authorization = `Bearer ${token}`;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(runtime: SdkAgentId) {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-sdk-queue-http-'));
  const tokenFile = join(root, 'tokens.json'), tokens = new ConnectorTokenStore(tokenFile, token);
  const actorId = tokens.authenticateAuthorization(authorization)!.tokenId;
  const store = new ConnectorUserStore(':memory:', undefined, { runtimeOwner: true });
  const key = `${runtime}:original`, path = `/api/connector/v1/sessions/${key}`;
  const journal = runtime === 'ghcp' ? store.copilotJournal : store.claudeJournal;
  journal.create({ key, nativeSessionId: 'native', title: 'Original', createdAt: 0 });
  const queue = new AsyncSdkQueue({ command: createConnectorOwnerCommands(store, tokens) });
  let ready = true, fallbacks = 0;
  const lines: string[] = [], diagnostics = new PerformanceDiagnostics(line => { lines.push(line); });
  const deps: SdkQueueHttp = { queue, ready: () => ready, diagnostics };
  const app = new Hono(); registerSdkQueueHttp(app, '/api/connector/v1/sessions/:sessionKey', deps);
  app.all('/api/connector/v1/sessions/:sessionKey/*', async c => { fallbacks++; return c.json({ legacy: c.req.method === 'PATCH' ? await c.req.json() : true }); });
  const enqueue = (id = 'message', actor = actorId) => {
    store.turns.enqueue(runtime, { id, sessionKey: key, createdAt: 0, payload: { actorId: actor, text: 'Original', images: [] } });
    return store.turns.version(runtime, key, id)!;
  };
  const request = (suffix: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => app.request(`${path}${suffix}`, {
    method, headers: { authorization, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const close = () => { store.close(); rmSync(root, { recursive: true, force: true }); };
  return { root, tokenFile, tokens, actorId, store, key, path, queue, deps, app, request, enqueue, lines,
    setReady: (v: boolean) => { ready = v; }, fallbacks: () => fallbacks, close };
}
for (const runtime of ['claude-code', 'ghcp'] as const) {
  test(`${runtime}: queue HTTP original lists, edit/cancel CAS, duplicate receipts and command addresses`, async () => {
    const f = fixture(runtime);
    try {
      const version = f.enqueue();
      f.store.commands.claim(JSON.stringify([f.actorId, f.key]), 'original-send', { text: 'Original' });
      f.store.commands.settle(JSON.stringify([f.actorId, f.key]), 'original-send', { status: 200, body: { idempotencyKey: 'message' } });
      const raw = await f.request('/queue'); assert.equal(raw.status, 200); assert.equal((await raw.json()).items[0].id, 'message');
      const commands = await f.request('/queue/commands'); assert.equal((await commands.json()).items[0].commandKey, 'original-send');
      const headers = { 'if-match': `"${version}"`, 'idempotency-key': 'edit' };
      const edit = await f.request('/commands/original-send/queue', 'PATCH', { message: '  Updated  ' }, headers);
      assert.equal(edit.status, 200); const saved = await edit.json(); assert.equal(saved.ok, true); assert.equal(saved.command.key, 'edit');
      assert.equal(f.store.turns.head<{ text: string }>(runtime, f.key)!.payload.text, 'Updated');
      f.setReady(false);
      const duplicate = await f.request('/queue/message', 'PATCH', { message: 'Updated' }, headers);
      assert.equal(duplicate.status, 200); assert.deepEqual(await duplicate.json(), saved);
      assert.equal((await f.request('/queue/message', 'PATCH', { message: 'Other' }, headers)).status, 409);
      assert.equal((await f.request('/queue/message', 'PATCH', { message: 'Fresh' }, { ...headers, 'idempotency-key': 'fresh' })).status, 409);
      f.setReady(true);
      assert.equal((await f.request('/queue/message', 'PATCH', { message: 'Stale' }, { ...headers, 'idempotency-key': 'stale' })).status, 412);
      const current = f.store.turns.version(runtime, f.key, 'message')!;
      const cancel = await f.request('/queue/message', 'DELETE', undefined, { 'if-match': `"${current}"`, 'idempotency-key': 'cancel' });
      assert.equal(cancel.status, 200); const canceled = await cancel.json();
      assert.equal((await f.request('/queue')).status, 200); assert.equal(f.store.turns.head(runtime, f.key), undefined);
      for (const suffix of ['/queue/message/commands/cancel', '/commands/original-send/queue/commands/cancel']) {
        const read = await f.request(suffix); assert.equal(read.status, 200); assert.equal((await read.json()).command.id, canceled.command.id);
      }
      assert.equal(f.fallbacks(), 0);
      assert.doesNotMatch(f.lines.join('\n'), /isolated-sdk|Updated|Bearer|original-send/);
    } finally { f.close(); }
  });
  test(`${runtime}: legacy unkeyed response stays bare and exposes original recovery key; send-only authority remains valid`, async () => {
    const f = fixture(runtime), sender = f.tokens.createTransient(['messages:send']);
    try {
      const actor = f.tokens.authenticateAuthorization(`Bearer ${sender.token}`)!.tokenId;
      const version = f.enqueue('message', actor);
      const result = await f.request('/queue/message', 'PATCH', { message: 'Updated' }, { authorization: `Bearer ${sender.token}`, 'if-match': `"${version}"` });
      assert.equal(result.status, 200); assert.deepEqual(await result.json(), { ok: true });
      assert.ok(result.headers.get('x-agentopsdeck-command-key'));
      assert.equal((await f.request(`/queue/message/commands/${result.headers.get('x-agentopsdeck-command-key')}`, 'GET', undefined,
        { authorization: `Bearer ${sender.token}` })).status, 403);
      assert.equal((await f.request('/commands/send/queue', 'DELETE', undefined, { 'if-match': `"${version}"` })).status, 400);
    } finally { sender.dispose(); f.close(); }
  });
  test(`${runtime}: actor isolation, maintenance receipts, scope revocation and compact rejection`, async () => {
    const f = fixture(runtime), foreign = f.tokens.createTransient(['messages:read', 'messages:send']);
    try {
      const version = f.enqueue();
      assert.equal((await f.request('/queue/message', 'DELETE', undefined, { authorization: `Bearer ${foreign.token}`, 'if-match': `"${version}"`, 'idempotency-key': 'foreign' })).status, 404);
      assert.equal((await f.request('/queue/message', 'PATCH', { message: '/compact' }, { 'if-match': `"${version}"`, 'idempotency-key': 'compact' })).status, 409);
      const result = await f.request('/queue/message', 'DELETE', undefined, { 'if-match': `"${version}"`, 'idempotency-key': 'cancel' });
      assert.equal(result.status, 200);
      f.store.pauseTurnStarts(); f.setReady(false);
      assert.equal((await f.request('/queue/message/commands/cancel')).status, 200);
      foreign.dispose();
      assert.equal((await f.request('/queue', 'GET', undefined, { authorization: `Bearer ${foreign.token}` })).status, 401);
    } finally { foreign.dispose(); f.close(); }
  });
  test(`${runtime}: queue/receipt/event share one transaction and duplicate emits no second event`, async t => {
    const f = fixture(runtime);
    try {
      const version = f.enqueue(), cursor = f.store.events.latestEventId();
      const headers = { 'if-match': `"${version}"`, 'idempotency-key': 'edit' };
      assert.equal((await f.request('/queue/message', 'PATCH', { message: 'Updated' }, headers)).status, 200);
      assert.equal((await f.request('/queue/message', 'PATCH', { message: 'Updated' }, headers)).status, 200);
      const events = f.store.events.getEventsSince(cursor); assert.equal(events.length, 1);
      assert.equal(events[0]!.type, 'queued_message.created');
      assert.deepEqual(events[0]!.payload, { sessionKey: f.key, idempotencyKey: 'message', edited: true });
      const current = f.store.turns.version(runtime, f.key, 'message')!;
      t.mock.method(f.store.events, 'appendInTransaction', () => { throw Error('private-event-failure'); });
      const failed = await f.request('/queue/message', 'DELETE', undefined, { 'if-match': `"${current}"`, 'idempotency-key': 'atomic' });
      assert.equal(failed.status, 503); assert.doesNotMatch(await failed.text(), /private-event/);
      assert.equal(f.store.turns.head(runtime, f.key)!.id, 'message');
      assert.equal(f.store.commands.get(JSON.stringify(['queue-mutation-v1', f.actorId, f.key, 'message']), 'atomic')!.state, 'outcome_unknown');
    } finally { f.close(); }
  });
  test(`${runtime}: real worker HTTP commits, closes and recovers original receipts without redoing mutation`, async () => {
    const f = fixture(runtime), file = join(f.root, 'persistent.sqlite');
    let owner: AsyncConnectorOwner | undefined;
    try {
      const setup = new ConnectorUserStore(file, undefined, { runtimeOwner: true });
      (runtime === 'ghcp' ? setup.copilotJournal : setup.claudeJournal).create({ key: f.key, nativeSessionId: 'native', title: 'Original', createdAt: 0 });
      await setup.turns.enqueueAsync(runtime, { id: 'message', sessionKey: f.key, createdAt: 0, payload: { actorId: f.actorId, text: 'Original', images: [] } });
      const version = setup.turns.version(runtime, f.key, 'message')!; setup.close();
      owner = new AsyncConnectorOwner({ file, tokenFile: f.tokenFile }, f.deps.diagnostics); await owner.open();
      f.deps.queue = new AsyncSdkQueue(owner);
      const edit = await f.request('/queue/message', 'PATCH', { message: 'Persistent' }, { 'if-match': `"${version}"`, 'idempotency-key': 'edit' });
      assert.equal(edit.status, 200); const receipt = (await edit.json()).command;
      await owner.closeForShutdown();
      owner = new AsyncConnectorOwner({ file, tokenFile: f.tokenFile }, f.deps.diagnostics); await owner.open();
      f.deps.queue = new AsyncSdkQueue(owner); f.setReady(false);
      const read = await f.request('/queue/message/commands/edit'); assert.equal(read.status, 200); assert.equal((await read.json()).command.id, receipt.id);
      const duplicate = await f.request('/queue/message', 'PATCH', { message: 'Persistent' }, { 'if-match': `"${version}"`, 'idempotency-key': 'edit' });
      assert.equal(duplicate.status, 200); assert.equal((await duplicate.json()).command.id, receipt.id);
      await owner.closeForShutdown();
      const verify = new ConnectorUserStore(file);
      try { assert.equal(verify.turns.head<{ text: string }>(runtime, f.key)!.payload.text, 'Persistent'); }
      finally { verify.close(); }
    } finally { await owner?.closeForShutdown(); f.close(); }
  });
}

test('SDK queue HTTP validates cursor, versions, auth, grants and body without legacy fallback', async () => {
  const f = fixture('ghcp');
  try {
    const version = f.enqueue(), headers = { 'if-match': `"${version}"`, 'idempotency-key': 'edit' };
    for (const cursor of ['-1', '1.2', '9007199254740992', '12345678901234567']) assert.equal((await f.request(`/queue?cursor=${cursor}`)).status, 400);
    assert.equal((await f.request('/queue/message', 'PATCH', { message: 'x' })).status, 428);
    for (const value of ['1:1', '"0:1"', '"1:0"', '*']) assert.equal((await f.request('/queue/message', 'DELETE', undefined, { 'if-match': value })).status, 400);
    for (const body of [null, {}, { message: '' }, { message: '   ' }, { message: 1 }]) assert.equal((await f.request('/queue/message', 'PATCH', body, headers)).status, 400);
    assert.equal((await f.request('/queue/message', 'PATCH', { message: 'x' }, { ...headers, 'idempotency-key': '' })).status, 400);
    assert.equal((await f.request('/queue', 'GET', undefined, { authorization: '' })).status, 401);
    assert.equal((await f.request('/queue', 'GET', undefined, { 'x-agentopsdeck-execution-grant': 'denied' })).status, 403);
    const legacy = await f.app.request('/api/connector/v1/sessions/codex:old/queue/message', { method: 'PATCH', body: JSON.stringify({ message: 'old' }) });
    assert.deepEqual(await legacy.json(), { legacy: { message: 'old' } }); assert.equal(f.fallbacks(), 1);
  } finally { f.close(); }
});

test('SDK queue HTTP deadline leaves late original commit recoverable, never submits twice', async () => {
  const f = fixture('ghcp');
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  try {
    const version = f.enqueue(), original = f.queue.edit.bind(f.queue); let writes = 0;
    f.deps.timeoutMs = 10;
    // Registration snapshots the finite deadline, so create this app after it.
    const app = new Hono(); registerSdkQueueHttp(app, '/sessions/:sessionKey', f.deps);
    f.queue.edit = async input => { writes++; entered(); await gate; return original(input); };
    const pending = app.request(`/sessions/${f.key}/queue/message`, { method: 'PATCH', headers: { authorization, 'if-match': `"${version}"`, 'idempotency-key': 'late' }, body: JSON.stringify({ message: 'Late' }) });
    await started; const result = await pending; assert.equal(result.status, 503); assert.equal((await result.json()).commandKey, 'late');
    release(); await tick(); await tick();
    const read = await f.request('/queue/message/commands/late'); assert.equal(read.status, 200); assert.equal((await read.json()).command.state, 'accepted'); assert.equal(writes, 1);
  } finally { release(); f.close(); }
});

test('SDK queue HTTP hides committed ACK after revoke instead of publishing cached success', async () => {
  const f = fixture('ghcp'), sender = f.tokens.createTransient(['messages:send', 'messages:read']);
  try {
    const auth = `Bearer ${sender.token}`, actor = f.tokens.authenticateAuthorization(auth)!.tokenId;
    const version = f.enqueue('message', actor), original = f.queue.cancel.bind(f.queue);
    f.queue.cancel = async input => { const result = await original(input); sender.dispose(); return result; };
    const result = await f.request('/queue/message', 'DELETE', undefined, { authorization: auth, 'if-match': `"${version}"`, 'idempotency-key': 'revoked' });
    assert.equal(result.status, 401); assert.doesNotMatch(await result.text(), /"ok"|"accepted"/);
    assert.equal(f.store.commands.get(JSON.stringify(['queue-mutation-v1', actor, f.key, 'message']), 'revoked')!.state, 'accepted');
  } finally { sender.dispose(); f.close(); }
});

test('SDK queue protocol admits only literal veto / mutation-read action; no boolean authority', () => {
  const scope = { runtime: 'ghcp', key: 'ghcp:original', authorization, target: { messageId: 'message' }, mutationKey: 'edit' };
  assert.equal(validConnectorSdkQueueInput('sdkQueueReceiptRead', { ...scope, purpose: 'mutation' }), true);
  assert.equal(validConnectorSdkQueueInput('sdkQueuedEdit', { ...scope, version: '1:1', text: 'Updated', rejectFresh: 'runtime_unavailable' }), true);
  for (const purpose of [undefined, true, 'read', 'authorized']) assert.equal(validConnectorSdkQueueInput('sdkQueueReceiptRead', { ...scope, purpose }), false);
  for (const rejectFresh of [undefined, true, 'authorized']) assert.equal(validConnectorSdkQueueInput('sdkQueuedCancel', { ...scope, version: '1:1', rejectFresh }), false);
});

test('SDK queue HTTP bounds concurrent body readers without blocking read-only recovery', async () => {
  const f = fixture('ghcp');
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const pending: Promise<Response>[] = [];
  const encoder = new TextEncoder();
  try {
    const version = f.enqueue();
    for (let i = 0; i < 2; i++) {
      const body = new ReadableStream<Uint8Array>({ start(controller) { streams.push(controller); controller.enqueue(encoder.encode('{"message":"')); } });
      const request = new Request(`http://localhost${f.path}/queue/message`, { method: 'PATCH',
        headers: { authorization, 'if-match': `"${version}"`, 'idempotency-key': `slow-${i}` }, body, duplex: 'half' } as RequestInit);
      pending.push(Promise.resolve(f.app.request(request)));
    }
    await tick(); await tick();
    const full = await f.request('/queue/message', 'PATCH', { message: 'Third' }, { 'if-match': `"${version}"`, 'idempotency-key': 'full' });
    assert.equal(full.status, 503); assert.equal((await f.request('/queue')).status, 200);
    assert.equal((await f.request('/queue/message/commands/full')).status, 404);
    for (const stream of streams) { stream.enqueue(encoder.encode('Updated"}')); stream.close(); }
    const settled = await Promise.all(pending); assert.ok(settled.every(response => [200, 412].includes(response.status)));
  } finally {
    for (const stream of streams) { try { stream.close(); } catch {} }
    await Promise.allSettled(pending); f.close();
  }
});
