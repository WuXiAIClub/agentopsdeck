import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { PassThrough, Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { jointCompletionEofFence } from './permissions-joint-eof-fence.mjs';
import { jointForwardingLifecycle } from './permissions-joint-forwarding.mjs';

const event = (type, response = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, response })}\n\n`;
const delta = event('response.output_text.delta', { text: 'not persisted' });
const completed = event('response.completed', { status: 'completed' });
const sink = output => new Writable({ write(chunk, encoding, callback) { output.push(Buffer.from(chunk)); callback(); } });

test('EOF fence streams nonterminal frames but releases the exact terminal bytes only after source EOF', async () => {
  const source = new PassThrough(), output = [], fence = jointCompletionEofFence();
  const running = pipeline(source, fence.stream, sink(output));
  source.write(delta); assert.equal(Buffer.concat(output).toString(), delta);
  source.write(completed); assert.equal(Buffer.concat(output).toString(), delta);
  assert.equal(fence.observation.sourceEnded, false);
  source.end(': keepalive\r\n\r\ndata: [DONE]\n\n');
  await running;
  assert.equal(Buffer.concat(output).toString(), delta + completed + ': keepalive\r\n\r\ndata: [DONE]\n\n');
  assert.deepEqual(fence.observation, { sourceEnded: true, completedFrames: 1, terminalReleased: true,
    peakBufferedBytes: Buffer.byteLength(completed + ': keepalive\r\n\r\ndata: [DONE]\n\n') });
});

test('EOF fence preserves bytes across single-byte chunks, CRLF, UTF8, multiline and data-only events', async () => {
  const value = 'data: {"type":"response.completed",\r\ndata: "response":{"status":"completed","text":"中文"}}\r\n\r\n';
  const bytes = Buffer.from(': heartbeat\n\n' + value), output = [];
  await pipeline(Readable.from([...bytes].map(byte => Buffer.from([byte]))), jointCompletionEofFence().stream, sink(output));
  assert.deepEqual(Buffer.concat(output), bytes);
});

test('EOF fence withholds terminal on upstream failure and preserves pipeline rejection', async () => {
  const output = [], fence = jointCompletionEofFence();
  const source = Readable.from((async function* () { yield Buffer.from(delta + completed); throw new Error('test-only-secret'); })());
  await assert.rejects(pipeline(source, fence.stream, sink(output)), /test-only-secret/);
  assert.equal(Buffer.concat(output).toString(), delta);
  assert.equal(fence.observation.sourceEnded, false);
  assert.equal(fence.observation.terminalReleased, false);
  assert.ok(!JSON.stringify(fence.observation).includes('test-only-secret'));
});

for (const [label, body] of [
  ['missing terminal', delta],
  ['partial terminal', completed.slice(0, -1)],
  ['failed terminal', event('response.failed', { status: 'failed' })],
  ['incomplete terminal', event('response.incomplete', { status: 'incomplete' })],
  ['mismatched type', 'event: response.completed\ndata: {"type":"response.failed","response":{"status":"failed"}}\n\n'],
  ['mismatched status', event('response.completed', { status: 'in_progress' })],
  ['duplicate terminal', completed + completed],
  ['post-terminal output', completed + delta],
  ['post-terminal partial', completed + 'data: secret'],
  ['malformed JSON', 'data: {"type":"response.completed"\n\n'],
]) test(`EOF fence rejects ${label} without releasing terminal`, async () => {
  const output = [], fence = jointCompletionEofFence();
  await assert.rejects(pipeline(Readable.from([Buffer.from(body)]), fence.stream, sink(output)));
  assert.equal(fence.observation.terminalReleased, false);
  assert.ok(!Buffer.concat(output).toString().includes('"status":"completed"'));
});

test('EOF fence rejects oversized frames and terminal tails with bounded retained bytes', async () => {
  for (const body of ['data: ' + 'x'.repeat(70_000), completed + ': ' + 'x'.repeat(70_000)]) {
    const fence = jointCompletionEofFence();
    await assert.rejects(pipeline(Readable.from([Buffer.from(body)]), fence.stream, sink([])));
    assert.ok(fence.observation.peakBufferedBytes <= 65_536);
    assert.equal(fence.observation.terminalReleased, false);
  }
});

test('EOF fence cannot convert cancellation or timeout before upstream EOF into success', async () => {
  for (const mode of ['cancel', 'timeout']) {
    const source = new PassThrough(), output = [], fence = jointCompletionEofFence();
    const controller = new AbortController();
    const running = pipeline(source, fence.stream, sink(output), { signal: controller.signal });
    const rejected = assert.rejects(running, { name: 'AbortError' });
    source.write(delta + completed);
    if (mode === 'timeout') await new Promise(resolve => setTimeout(resolve, 10));
    controller.abort(); await rejected;
    assert.equal(fence.observation.sourceEnded, false);
    assert.equal(fence.observation.terminalReleased, false);
    assert.equal(Buffer.concat(output).toString(), delta);
  }
});

test('real HTTP cancellation after terminal cannot precede original EOF through the fence', { timeout: 5000 }, async () => {
  const source = new PassThrough(), fence = jointCompletionEofFence();
  let settle;
  const settled = new Promise(resolve => { settle = resolve; });
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const lifecycle = jointForwardingLifecycle(response);
    pipeline(lifecycle.attachSource(source), fence.stream, response).then(
      () => settle({ passed: true, lifecycle: lifecycle.observation }),
      error => settle({ passed: false, code: error.code, lifecycle: lifecycle.observation }),
    ).finally(() => lifecycle.dispose());
    source.write(delta + completed);
    setTimeout(() => source.end(), 100);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
    const reader = response.body.getReader(); let received = '';
    while (!received.includes('response.completed')) {
      const { value, done } = await reader.read(); assert.equal(done, false);
      received += Buffer.from(value).toString();
    }
    await reader.cancel();
    const result = await settled;
    assert.equal(result.passed, true);
    assert.equal(result.lifecycle.upstreamEnded, true);
    assert.equal(result.lifecycle.downstreamFinished, true);
    assert.equal(result.lifecycle.firstAbnormal, null);
    assert.equal(fence.observation.terminalReleased, true);
    assert.equal(received, delta + completed);
  } finally { source.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
