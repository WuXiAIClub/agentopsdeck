// Synthetic, loopback-only baseline. Never accepts production URLs or files.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { CodexRolloutReader } from '../src/codex/rollout-reader.js';
import { historyTransfer } from '../src/messages/history-transfer.js';

assert.equal(process.argv.length, 2, 'This benchmark takes no arguments or production paths');
const fixture = await mkdtemp(join(tmpdir(), 'agentopsdeck-history-benchmark-'));
const round = (value: number) => Number(value.toFixed(2));
const row = (type: string, payload: unknown) => JSON.stringify({ type, payload }) + '\n';
try {
  const file = join(fixture, 'synthetic.jsonl');
  await writeFile(file, row('turn_context', { turn_id: 'first', model: 'fixture' }));
  const reasoning = row('response_item', { type: 'reasoning', encrypted_content: 'x'.repeat(1024 * 1024) });
  for (let index = 0; index < 64; index++) await appendFile(file, reasoning);
  const reader = new CodexRolloutReader();
  const timedRead = async () => {
    const start = performance.now();
    const projection = await reader.read(file);
    return { ms: round(performance.now() - start), projection };
  };
  const cold = await timedRead();
  assert.match(cold.projection, /fixture/);
  const warm: number[] = [];
  for (let index = 0; index < 5; index++) {
    const result = await timedRead();
    assert.equal(result.projection, cold.projection);
    warm.push(result.ms);
  }
  await appendFile(file, row('event_msg', { type: 'task_complete', turn_id: 'first' }));
  const appended = await timedRead();
  assert.ok(appended.projection.startsWith(cold.projection));
  assert.match(appended.projection, /task_complete/);
  const projection = { sourceBytes: (await stat(file)).size, projectedBytes: Buffer.byteLength(appended.projection),
    coldMs: cold.ms, warmMs: warm, appendWithPrefixValidationMs: appended.ms };

  // This is HTTP transfer, not a benchmark of Hub database or remote pagination.
  const messages = Array.from({ length: 200 }, (_, index) => ({ id: `fixture:${index}`, role: index % 2 ? 'assistant' : 'user',
    text: Array.from({ length: 32 }, (_, part) => createHash('sha256').update(`${index}:${part}`).digest('hex')).join('\n') }));
  const payload = { messages, totalCount: 200, hiddenCount: 0, updatedAt: 1 };
  const json = JSON.stringify(payload);
  const app = new Hono();
  app.use('*', historyTransfer);
  app.get('/api/hub/v1/sessions/fixture/messages', context => context.json(payload));
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  try {
    if (!server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}/api/hub/v1/sessions/fixture/messages?limit=200`;
    const transfer = async (encoding: 'identity' | 'gzip') => new Promise<Record<string, unknown>>((resolve, reject) => {
      const started = performance.now();
      const request = get(url, { headers: { 'accept-encoding': encoding }, agent: false }, response => {
        const headersMs = performance.now() - started;
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(Buffer.from(chunk)));
        response.on('error', reject);
        response.on('end', () => {
          try {
            const totalMs = performance.now() - started;
            const body = Buffer.concat(chunks);
            assert.equal(response.statusCode, 200);
            assert.equal(response.headers['content-encoding'], encoding === 'gzip' ? 'gzip' : undefined);
            assert.equal((encoding === 'gzip' ? gunzipSync(body) : body).toString(), json);
            resolve({ encoding, encodedBytes: body.length, decodedBytes: Buffer.byteLength(json),
              headersMs: round(headersMs), totalMs: round(totalMs), serverTiming: response.headers['server-timing'] });
          } catch (error) { reject(error); }
        });
      });
      request.setTimeout(5000, () => request.destroy(new Error('Loopback history benchmark timed out')));
      request.on('error', reject);
    });
    const samples = [];
    for (let index = 0; index < 3; index++) samples.push(await transfer('identity'), await transfer('gzip'));
    console.log(JSON.stringify({ synthetic: true, node: process.version, projection, samples,
      scope: 'Projection and loopback transfer only; not remote provider, pagination, public network or RUM acceptance' }, null, 2));
  } finally {
    if ('closeAllConnections' in server) server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
} finally { await rm(fixture, { recursive: true, force: true }); }
