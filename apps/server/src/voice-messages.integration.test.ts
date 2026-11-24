import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { registerVoiceMessages } from './voice-messages.js';

test('real local Chinese transcription reaches bound message route and retry reuses receipt',
  { skip: !process.env.AOD_VOICE_TEST_WAV, timeout: 150_000 }, async context => {
    const directory = await mkdtemp(join(tmpdir(), 'voice-model-integration-'));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const app = new Hono();
    registerVoiceMessages(app, { directory });
    const ledger = new Map<string, string>();
    app.use('/api/*', async (current, next) => current.req.header('authorization') === 'Bearer isolated-test'
      ? next() : current.json({ error: 'unauthorized' }, 401));
    app.get('/api/hub/v1/sessions/video-test/messages', current => current.json({ messages: [] }));
    app.post('/api/hub/v1/sessions/video-test/messages', async current => {
      const body = await current.req.json() as { message: string; idempotencyKey: string };
      const previous = ledger.get(body.idempotencyKey);
      if (previous !== undefined) assert.equal(previous, body.message);
      ledger.set(body.idempotencyKey, body.message);
      return current.json({ status: 'queued', idempotencyKey: body.idempotencyKey });
    });
    const audio = await readFile(process.env.AOD_VOICE_TEST_WAV!);
    const request = () => app.request('/api/hub/v1/sessions/video-test/voice', { method: 'POST',
      headers: { authorization: 'Bearer isolated-test', 'content-type': 'application/json' },
      body: JSON.stringify({ audio: { mimeType: 'audio/wav', contentBase64: audio.toString('base64') },
        idempotencyKey: 'isolated-voice-test', deliveryMode: 'web-only' }) });
    assert.equal((await request()).status, 200);
    assert.match(ledger.get('isolated-voice-test')!, /剪辑这段视频/);
    assert.equal((await request()).status, 200);
    assert.equal(ledger.size, 1);
    console.log('Local Chinese transcript:', ledger.get('isolated-voice-test'));
  });
