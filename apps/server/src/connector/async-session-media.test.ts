import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { projectClaudeMessage } from '../claude/message-projection.js';
import { mediaResourceId } from '../messages/media-resource.js';
import { sourceReferenceMedia } from '../messages/source-preview.js';
import { DeckStore } from '../projection/deck-store.js';
import { AsyncConnectorOwner } from './async-connector-owner.js';
import { AsyncSessionMedia } from './async-session-media.js';
import { registerSessionMediaRoutes } from './session-media-http.js';
import type { SessionMediaInput } from './connector-session-media-domain.js';

const diagnostics = new PerformanceDiagnostics(() => {});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function gate() { let release!: () => void; return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() }; }
const denied = (error: unknown) => error instanceof HTTPException && error.status === 403;

async function fixture(runtime: 'claude-code' | 'ghcp') {
  const root = mkdtempSync(join(tmpdir(), 'async-session-media-'));
  const owner = new AsyncConnectorOwner({ file: join(root, 'connector.sqlite'), tokenFile: join(root, 'tokens.json'),
    bootstrapToken: 'media-bootstrap', sdkModels: { 'claude-code': { model: 'test' }, ghcp: { model: 'test' } } }, diagnostics);
  await owner.open();
  try {
  const token = await owner.command('tokenCreate', { label: 'media reader', scopes: ['messages:read', 'messages:send', 'media:read', 'source:approve', 'sessions:create'] });
  const authorization = `Bearer ${token.token}`;
  const created = await owner.command('sdkSessionCreate', { runtime, authorization, commandKey: 'create', payloadJson: '{}' });
  assert.ok('key' in created && created.key); const key = created.key;
  const bytes = Buffer.alloc(2 * 65536 + 17, 97);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes);
  const sent = await owner.command('sdkMessageSend', { runtime, key, authorization, commandKey: 'input',
    payloadJson: JSON.stringify({ message: 'Input', media: [{ name: 'original.png', mimeType: 'image/png', dataUrl: `data:image/png;base64,${bytes.toString('base64')}` }] }) });
  assert.ok(!('error' in sent));
  assert.equal(sent.admitted, true);
  const plan = await owner.command('sdkDispatchPlan', { runtime, key }); assert.ok(plan && plan !== 'blocked');
  const execution = await owner.command('sdkDispatchClaim', { runtime, key, id: 'execution', epoch: 'epoch', digest: plan.digest }); assert.ok(execution);
  const ref = { key, id: execution.id, epoch: execution.epoch, nativeSessionId: execution.nativeSessionId };
  const file = join(root, 'original.ts'); writeFileSync(file, 'const original = true;');
  const text = `[Original](${file}:1)`;
  const appended = await owner.command('sdkTranscriptAppend', runtime === 'claude-code'
    ? { runtime, ref, rows: projectClaudeMessage({ type: 'assistant', uuid: 'reply', session_id: ref.nativeSessionId,
      parent_tool_use_id: null, message: { role: 'assistant', content: text } }, ref.nativeSessionId) }
    : { runtime, ref, row: { nativeEventId: 'reply-event', messageId: 'reply', role: 'assistant', text, truncated: false, createdAt: 10 }, submittedText: '' });
  assert.equal(appended.applied, true);
  const history = await owner.command('sdkHistoryPage', { runtime, key, authorization, limit: 20 }); assert.ok(!('error' in history));
  const input = history.body.messages.find(row => row.role === 'user')!, reply = history.body.messages.find(row => row.text === text)!;
  assert.ok(input.media?.[0]); assert.ok(reply);
  const resource = sourceReferenceMedia(reply)[0]!; assert.ok(resource);
  const attachment: SessionMediaInput = { authorization, key, messageId: input.id, resourceId: mediaResourceId(input.media[0].url), approval: false };
  const source: SessionMediaInput = { authorization, key, messageId: reply.id, resourceId: mediaResourceId(resource.url), approval: false };
  let port: Pick<AsyncConnectorOwner, 'command'> = owner;
  const media = new AsyncSessionMedia({ command: (kind, value) => port.command(kind, value) }, diagnostics);
  const deck = new DeckStore(); deck.addMessage(reply);
  const sourcePreview = { allowedDirs: [root], approvalDirs: [root] };
  const app = new Hono(); registerSessionMediaRoutes(app, { access: media, store: deck, inboundDir: root,
    artifactConfig: { enabled: false, allowedDirs: [], maxBytes: 65536, indexFile: join(root, 'artifacts.json'), injectCapability: false, allowGatewayClient: false },
    sourcePreview, refreshMessages: async () => { throw Error('Durable media must not refresh Deck'); } });
  const path = (value: SessionMediaInput) => `/api/connector/v1/sessions/${encodeURIComponent(value.key)}/messages/${encodeURIComponent(value.messageId)}/media/${value.resourceId}`;
  const request = (value = attachment, suffix = '', method = 'GET') => app.request(path(value) + suffix, { method, headers: { authorization: value.authorization } });
  return { owner, media, bytes, attachment, source, sourcePreview, request, token, key, ref, root, deck,
    port(value: Pick<AsyncConnectorOwner, 'command'>) { port = value; },
    async close() { try { await media.close(); } finally { await owner.close(); rmSync(root, { recursive: true, force: true }); } } };
  } catch (error) { await owner.close(); rmSync(root, { recursive: true, force: true }); throw error; }
}

for (const runtime of ['claude-code', 'ghcp'] as const) {
  test(`${runtime}: real worker serves exact durable source and bounded attachment chunks through original HTTP`, async () => {
    const f = await fixture(runtime);
    try {
      const observation = await f.media.observe(f.attachment);
      assert.equal(observation.durable, true); assert.equal(observation.readerId, f.token.record.id);
      assert.equal(observation.nativeSessionId, f.ref.nativeSessionId); assert.equal(observation.attachment?.size, f.bytes.length);
      assert.equal(JSON.stringify(observation).includes(f.bytes.toString('base64')), false);
      const expected = { readerId: observation.readerId, nativeSessionId: observation.nativeSessionId };
      const chunks: Uint8Array[] = [];
      for (let offset = 0; offset < f.bytes.length; offset += 65536) {
        const chunk = await f.media.chunk({ ...f.attachment, expected, offset, size: f.bytes.length });
        assert.ok(chunk.byteLength <= 65536); chunks.push(chunk);
      }
      assert.deepEqual(Buffer.concat(chunks), f.bytes);
      const response = await f.request(); assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-length'), String(f.bytes.length));
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.bytes);
      const preview = await f.request(f.source); assert.equal(preview.status, 200);
      assert.equal((await preview.json()).text, 'const original = true;');
      assert.equal((await f.media.observe({ ...f.source, messageId: 'missing' })).source, null);
      await assert.rejects(f.media.observe({ ...f.source, expected: { ...expected, nativeSessionId: 'rebound' } }), denied);
      await assert.rejects(f.media.observe({ ...f.source, expected: { ...expected, readerId: 'other-reader' } }), denied);
      assert.equal((await f.request({ ...f.attachment, messageId: f.source.messageId })).status, 404);
      f.sourcePreview.allowedDirs = [];
      const unavailable = await f.request(f.source); assert.equal(unavailable.status, 404); await unavailable.arrayBuffer();
      const approved = await f.request(f.source, '/approval', 'POST'); assert.equal(approved.status, 200); await approved.arrayBuffer();
      const temporary = await f.request(f.source); assert.equal(temporary.status, 200); assert.equal((await temporary.json()).temporaryApproval, true);
      const revoked = await f.request(f.source, '/approval', 'DELETE'); assert.equal(revoked.status, 200); await revoked.arrayBuffer();
      const expired = await f.request(f.source); assert.equal(expired.status, 404); await expired.arrayBuffer();
    } finally { await f.close(); }
  });

  test(`${runtime}: current scopes and revocation gate already-open streams, cached Deck cannot revive missing durable members`, async () => {
    const f = await fixture(runtime);
    try {
      const noMedia = await f.owner.command('tokenCreate', { label: 'no media', scopes: ['messages:read'] });
      await assert.rejects(f.media.observe({ ...f.source, authorization: `Bearer ${noMedia.token}` }), denied);
      const noApproval = await f.owner.command('tokenCreate', { label: 'no approval', scopes: ['messages:read', 'media:read'] });
      await assert.rejects(f.media.observe({ ...f.source, approval: true, authorization: `Bearer ${noApproval.token}` }), denied);
      const retained = { ...f.deck.getMessages(f.key)[0]!, id: 'retained-but-not-durable' };
      f.deck.addMessage(retained);
      const missing = await f.request({ ...f.source, messageId: retained.id }); assert.equal(missing.status, 404); await missing.arrayBuffer();
      const response = await f.request(), reader = response.body!.getReader();
      assert.equal((await reader.read()).value!.byteLength, 65536);
      await f.owner.command('tokenRevoke', { tokenId: f.token.record.id });
      await assert.rejects(reader.read(), denied); reader.releaseLock();
      assert.equal((await f.request()).status, 403);
    } finally { await f.close(); }
  });

  test(`${runtime}: deletion fences durable media even while the original reply remains in Deck`, async () => {
    const f = await fixture(runtime);
    try {
      assert.equal(await f.owner.command('sdkExecutionAcknowledge', { runtime, ref: f.ref, nativeRequestId: 'original-ack' }), true);
      assert.equal(await f.owner.command('sdkExecutionTerminal', { runtime, ref: f.ref, outcome: 'completed' }), true);
      assert.equal(await f.owner.command('sdkExecutionSettle', { runtime, ref: f.ref, historyPersisted: true, nativeQuiescent: true }), true);
      const claim = await f.owner.command('sdkDeletionClaim', { runtime, key: f.key, authorization: f.source.authorization, commandKey: 'original-delete' });
      assert.ok('intent' in claim && claim.admitted && claim.intent);
      assert.ok(f.deck.getMessages(f.key).some(row => row.id === f.source.messageId));
      for (const input of [f.source, f.attachment]) {
        const response = await f.request(input); assert.equal(response.status, 404); await response.arrayBuffer();
      }
    } finally { await f.close(); }
  });
}

test('async original non-SDK file path retains verified transport, membership and current token fences', async () => {
  const f = await fixture('ghcp');
  try {
    const key = 'codex:original', messageId = 'original-file', url = '/api/media/inbound/original.bin';
    writeFileSync(join(f.root, 'original.bin'), f.bytes);
    f.deck.addMessage({ id: messageId, sessionKey: key, role: 'assistant', text: '', createdAt: 1,
      media: [{ type: 'file', name: 'original.bin', url }] });
    const input = { ...f.attachment, key, messageId, resourceId: mediaResourceId(url) };
    const response = await f.request(input); assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.bytes);
    const retained = await f.request(input); assert.equal(retained.status, 200);
    await f.owner.command('tokenRevoke', { tokenId: f.token.record.id });
    await assert.rejects(retained.arrayBuffer(), denied);
    const blocked = await f.request(input); assert.equal(blocked.status, 403); await blocked.arrayBuffer();
  } finally { await f.close(); }
});

test('normal EOF releases media body slots; retained bodies enforce bounded admission', async () => {
  const media = new AsyncSessionMedia({ command: (async () => { throw Error('No SQL expected'); }) as AsyncConnectorOwner['command'] }, diagnostics);
  const request = new Request('http://local/media');
  try {
    for (let i = 0; i < 40; i++) {
      const response = await media.run(request, async () => new Response('original'));
      assert.equal(await response.text(), 'original');
    }
    const retained = [];
    for (let i = 0; i < 32; i++) retained.push(await media.run(request, async () => new Response('original')));
    let started = false;
    await assert.rejects(media.run(request, async () => { started = true; return new Response(); }), error => error instanceof HTTPException && error.status === 503);
    assert.equal(started, false);
    for (const response of retained) await response.body!.cancel();
    assert.equal(await (await media.run(request, async () => new Response('released'))).text(), 'released');
  } finally { await media.close(); }
});

test('media close retains the original physical worker response and does not replay a cancelled request', async () => {
  const f = await fixture('ghcp'), held = gate(), entered = gate(); let calls = 0;
  try {
    f.port({ command: async (kind, input) => {
      const result = await f.owner.command(kind, input); calls++; entered.release(); await held.promise; return result;
    } });
    const pending = f.media.observe(f.attachment), rejected = assert.rejects(pending, error => error instanceof HTTPException && error.status === 503);
    await entered.promise; let drained = false; const closing = f.media.close().then(() => { drained = true; });
    await tick(); assert.equal(drained, false);
    await assert.rejects(f.media.observe(f.attachment)); held.release(); await rejected; await closing;
    assert.equal(calls, 1); assert.equal(drained, true);
  } finally { held.release(); await f.close(); }
});

test('media validates echoed request scope rather than trusting a well-shaped worker response', async () => {
  const f = await fixture('ghcp');
  try {
    const original = await f.media.observe(f.source);
    for (const mutation of [{ key: 'ghcp:other' }, { messageId: 'other' }, { resourceId: '0'.repeat(64), source: null }]) {
      f.port({ command: (async () => ({ ...original, ...mutation })) as AsyncConnectorOwner['command'] });
      await assert.rejects(f.media.observe(f.source), /storage_unavailable/);
    }
  } finally { await f.close(); }
});

test('idle media streams are cancelled on close and physical cancellation acknowledgement is retained', async () => {
  const held = gate(), started = gate(); let calls = 0;
  const media = new AsyncSessionMedia({ command: (async () => { throw Error('No SQL expected'); }) as AsyncConnectorOwner['command'] }, diagnostics);
  try {
    const response = await media.run(new Request('http://local/media'), async () => new Response(new ReadableStream({
      cancel: async () => { calls++; started.release(); await held.promise; },
    })));
    let drained = false; const closing = media.close().then(() => { drained = true; });
    await started.promise; await tick(); assert.equal(drained, false);
    held.release(); await closing; assert.equal(calls, 1); assert.equal(drained, true);
    await assert.rejects(response.arrayBuffer());
    await assert.rejects(media.run(new Request('http://local/media'), async () => new Response()));
  } finally { held.release(); await media.close(); }
});
