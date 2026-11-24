import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { registerVoiceMessages } from './voice-messages.js';

async function fixture(context: TestContext, transcribe?: (audio: Buffer, mime: string, signal: AbortSignal) => Promise<string>) {
  const directory = await mkdtemp(join(tmpdir(), 'voice-tests-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  let allowed = true, count = 0;
  const messages: { path: string; body: { message: string; idempotencyKey: string } }[] = [];
  const create = () => {
    const app = new Hono();
    registerVoiceMessages(app, { directory, transcribe: async (...args) => { count++; return transcribe ? transcribe(...args) : '请帮我剪辑这段视频。'; } });
    app.use('/api/*', async (current, next) => {
      if (!allowed || current.req.header('authorization') !== 'Bearer test') return current.json({ error: 'unauthorized' }, 401);
      return next();
    });
    app.get('/api/hub/v1/sessions/:id/messages', current => current.json({ messages: [] }));
    app.post('/api/hub/v1/sessions/:id/messages', async current => {
      messages.push({ path: current.req.path, body: await current.req.json() });
      return current.json({ status: 'queued', idempotencyKey: messages.at(-1)!.body.idempotencyKey });
    });
    return app;
  };
  const body = { audio: { contentBase64: Buffer.alloc(128, 7).toString('base64'), mimeType: 'audio/mp4' },
    idempotencyKey: 'voice-recording-123', deliveryMode: 'web-only' };
  const request = (app: Hono, override: object = {}, authorization = 'Bearer test', signal?: AbortSignal) =>
    app.request('/api/hub/v1/sessions/original-session/voice', { method: 'POST',
      headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify({ ...body, ...override }),
      ...(signal ? { signal } : {}) });
  return { app: create(), create, request, body, messages, revoke: () => { allowed = false; }, get count() { return count; } };
}

test('transcribes and sends through the original bound session and command key', async context => {
  const state = await fixture(context);
  const response = await state.request(state.app);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'queued');
  assert.deepEqual(state.messages[0], { path: '/api/hub/v1/sessions/original-session/messages',
    body: { message: '请帮我剪辑这段视频。', deliveryMode: 'web-only', media: [], idempotencyKey: 'voice-recording-123' } });
});

test('unauthorized uploads cannot run the model', async context => {
  const state = await fixture(context);
  assert.equal((await state.request(state.app, {}, 'Bearer invalid')).status, 401);
  assert.equal(state.count, 0);
  assert.equal(state.messages.length, 0);
});

test('retry and process recreation reuse durable transcription and original key', async context => {
  const state = await fixture(context);
  await state.request(state.app);
  await state.request(state.app);
  await state.request(state.create());
  assert.equal(state.count, 1);
  assert.equal(state.messages.length, 3);
  assert.ok(state.messages.every(item => item.body.idempotencyKey === 'voice-recording-123'));
});

test('same key with changed audio or delivery mode is a conflict', async context => {
  const state = await fixture(context);
  await state.request(state.app);
  assert.equal((await state.request(state.app, { deliveryMode: 'mirror' })).status, 409);
  assert.equal((await state.request(state.app, { audio: { ...state.body.audio, contentBase64: Buffer.alloc(128, 8).toString('base64') } })).status, 409);
  assert.equal(state.messages.length, 1);
});

test('empty transcription and slash controls are never submitted', async context => {
  for (const text of ['', '/stop']) {
    const state = await fixture(context, async () => text);
    assert.equal((await state.request(state.app)).status, 422);
    assert.equal(state.messages.length, 0);
  }
});

test('authority is rechecked after transcription', async context => {
  let revoke = () => {};
  const state = await fixture(context, async () => { revoke(); return '不能发送'; });
  revoke = state.revoke;
  assert.equal((await state.request(state.app)).status, 401);
  assert.equal(state.messages.length, 0);
});

test('cancellation before message dispatch cannot send', async context => {
  const controller = new AbortController();
  const state = await fixture(context, async () => { controller.abort(); return '取消的消息'; });
  assert.equal((await state.request(state.app, {}, 'Bearer test', controller.signal)).status, 408);
  assert.equal(state.messages.length, 0);
});

test('invalid base64, mime, size and command key are rejected', async context => {
  const state = await fixture(context);
  for (const override of [{ idempotencyKey: '' }, { audio: { ...state.body.audio, mimeType: 'text/html' } },
    { audio: { ...state.body.audio, contentBase64: 'not-base64' } }, { audio: { ...state.body.audio, contentBase64: '' } }])
    assert.equal((await state.request(state.app, override)).status, 400);
  assert.equal(state.count, 0);
});

test('parallel retry cannot start a second transcription', async context => {
  let release = () => {}, ready = () => {};
  const entered = new Promise<void>(resolve => { ready = resolve; });
  const pending = new Promise<string>(resolve => { release = () => resolve('只转写一次'); });
  const state = await fixture(context, async () => { ready(); return pending; });
  const first = state.request(state.app);
  await entered;
  assert.equal((await state.request(state.app)).status, 409);
  release();
  assert.equal((await first).status, 200);
  assert.equal(state.count, 1);
});
