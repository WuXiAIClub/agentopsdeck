import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { PassThrough, Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { jointForwardingDiagnostic, jointForwardingObserver } from './permissions-joint-forwarding.mjs';

test('transport lifecycle observes normal EOF and finish without changing forwarded bytes', async () => {
  const { jointForwardingLifecycle } = await import('./permissions-joint-forwarding.mjs');
  const bytes = Buffer.from('private-response-bytes');
  const source = Readable.from([bytes]), output = [];
  const destination = new Writable({ write(chunk, encoding, callback) { output.push(chunk); callback(); } });
  const lifecycle = jointForwardingLifecycle(destination);
  assert.equal(lifecycle.attachSource(source), source);
  try { await pipeline(source, destination); }
  finally { lifecycle.dispose(); }
  assert.deepEqual(Buffer.concat(output), bytes);
  assert.deepEqual(lifecycle.observation, { sourceAttached: true, upstreamEnded: true,
    upstreamClosed: true, upstreamErrored: false, downstreamFinished: true,
    downstreamClosed: true, downstreamErrored: false, firstAbnormal: null });
  assert.ok(!JSON.stringify(lifecycle.observation).includes(bytes.toString()));
});

test('transport lifecycle distinguishes an upstream error from its downstream propagated error', async () => {
  const { jointForwardingLifecycle } = await import('./permissions-joint-forwarding.mjs');
  const secret = 'private-error-message-and-token';
  const source = Readable.from((async function* () { yield Buffer.from('first'); throw new Error(secret); })());
  const destination = new Writable({ write(chunk, encoding, callback) { callback(); } });
  const lifecycle = jointForwardingLifecycle(destination);
  lifecycle.attachSource(source);
  try { await assert.rejects(pipeline(source, destination)); }
  finally { lifecycle.dispose(); }
  assert.equal(lifecycle.observation.firstAbnormal, 'upstream-error');
  assert.equal(lifecycle.observation.upstreamEnded, false);
  assert.equal(lifecycle.observation.downstreamErrored, true);
  assert.ok(!JSON.stringify(lifecycle.observation).includes(secret));
});

test('transport lifecycle distinguishes downstream premature close from pipeline source destruction', async () => {
  const { jointForwardingLifecycle } = await import('./permissions-joint-forwarding.mjs');
  const source = new PassThrough();
  const destination = new Writable({ write(chunk, encoding, callback) { callback(); this.destroy(); } });
  const lifecycle = jointForwardingLifecycle(destination);
  lifecycle.attachSource(source);
  const forwarding = pipeline(source, destination);
  source.write('first');
  try { await assert.rejects(forwarding, { code: 'ERR_STREAM_PREMATURE_CLOSE' }); }
  finally { lifecycle.dispose(); }
  assert.equal(lifecycle.observation.firstAbnormal, 'downstream-close-before-finish');
  assert.equal(lifecycle.observation.upstreamEnded, false);
  assert.equal(lifecycle.observation.upstreamClosed, true);
  assert.equal(lifecycle.observation.downstreamFinished, false);
});

test('transport lifecycle records an early client close and removes only its own listeners', async () => {
  const { jointForwardingLifecycle } = await import('./permissions-joint-forwarding.mjs');
  const destination = new PassThrough(), source = new PassThrough();
  const existing = () => {};
  destination.on('close', existing);
  const before = destination.eventNames().map(event => [event, destination.listenerCount(event)]);
  const lifecycle = jointForwardingLifecycle(destination);
  destination.destroy();
  await new Promise(resolve => destination.once('close', resolve));
  assert.equal(lifecycle.observation.firstAbnormal, 'downstream-close-before-finish');
  assert.equal(lifecycle.observation.sourceAttached, false);
  lifecycle.attachSource(source);
  lifecycle.dispose(); lifecycle.dispose();
  assert.deepEqual(destination.eventNames().map(event => [event, destination.listenerCount(event)]), before);
  assert.equal(source.listenerCount('end'), 0);
  assert.equal(source.listenerCount('error'), 0);
  assert.equal(source.listenerCount('close'), 0);
  source.destroy();
});

test('real HTTP client cancellation after a terminal frame remains a downstream-first pipeline failure', { timeout: 5000 }, async () => {
  const { jointForwardingLifecycle } = await import('./permissions-joint-forwarding.mjs');
  const terminal = 'data: {"type":"response.completed","response":{"status":"completed"}}\n\n';
  const controller = new AbortController();
  let settle;
  const settled = new Promise(resolve => { settle = resolve; });
  const server = createServer((request, response) => {
    if (request.url === '/upstream') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(terminal); // Deliberately no EOF: terminal is not transport completion.
      return;
    }
    void (async () => {
      const lifecycle = jointForwardingLifecycle(response), protocol = jointForwardingObserver();
      try {
        const upstream = await fetch(origin + '/upstream', { signal: controller.signal });
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        await pipeline(lifecycle.attachSource(Readable.fromWeb(upstream.body)), protocol.stream, response);
        settle({ passed: true });
      } catch (error) {
        settle({ passed: false, code: error.code, transport: { ...lifecycle.observation }, protocol: { ...protocol.observation } });
      } finally { lifecycle.dispose(); }
    })();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  try {
    const response = await fetch(origin + '/proxy', { signal: controller.signal });
    const reader = response.body.getReader();
    assert.equal(Buffer.from((await reader.read()).value).toString(), terminal);
    await reader.cancel();
    const result = await settled;
    assert.equal(result.passed, false);
    assert.equal(result.code, 'ERR_STREAM_PREMATURE_CLOSE');
    assert.equal(result.transport.firstAbnormal, 'downstream-close-before-finish');
    assert.equal(result.transport.upstreamEnded, false);
    assert.equal(result.transport.downstreamFinished, false);
    assert.equal(result.protocol.completedFrames, 1);
    assert.equal(result.protocol.sourceEnded, false);
  } finally {
    controller.abort();
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await closed;
  }
});

async function observe(bytes, cuts = [bytes.length]) {
  const { stream, observation } = jointForwardingObserver();
  const chunks = []; let offset = 0;
  for (const cut of cuts) { chunks.push(bytes.subarray(offset, offset + cut)); offset += cut; }
  if (offset < bytes.length) chunks.push(bytes.subarray(offset));
  const output = [];
  await pipeline(Readable.from(chunks), stream, new Writable({ write(chunk, encoding, callback) { output.push(chunk); callback(); } }));
  assert.deepEqual(Buffer.concat(output), bytes, 'Never alter original forwarded bytes');
  return observation;
}

for (const status of ['completed', 'failed', 'incomplete']) {
  test('bounded observer records valid ' + status + ' SSE across UTF-8/CRLF chunk boundaries without payloads', async () => {
    const secret = 'private-消息-token';
    const bytes = Buffer.from(`event: response.${status}\r\ndata: ${JSON.stringify({ type: `response.${status}`, response: { status, secret } })}\r\n\r\n`);
    const value = await observe(bytes, Array(bytes.length).fill(1));
    assert.equal(value.bytes, bytes.length); assert.equal(value.sourceEnded, true);
    assert.equal(value.completedFrames, status === 'completed' ? 1 : 0);
    assert.equal(value.failedFrames, status === 'failed' ? 1 : 0);
    assert.equal(value.incompleteFrames, status === 'incomplete' ? 1 : 0);
    assert.ok(!JSON.stringify(value).includes(secret));
  });

  test('bounded observer records unnamed data-only ' + status + ' SSE without inventing transport completion', async () => {
    const secret = 'private-unnamed-消息';
    const bytes = Buffer.from(`: heartbeat\nid: private-id\ndata: ${JSON.stringify({ type: `response.${status}`, response: { status, secret } })}\n\n`);
    const value = await observe(bytes, Array(bytes.length).fill(1));
    assert.equal(value.completedFrames, status === 'completed' ? 1 : 0);
    assert.equal(value.failedFrames, status === 'failed' ? 1 : 0);
    assert.equal(value.incompleteFrames, status === 'incomplete' ? 1 : 0);
    assert.equal(value.sourceEnded, true);
    assert.ok(!JSON.stringify(value).includes(secret));
    assert.ok(!JSON.stringify(value).includes('private-id'));
  });
}

test('a header, mismatched status, partial frame or text mentioning completion is not terminal evidence', async () => {
  for (const data of ['event: response.completed\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"status":"failed"}}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}',
    'data: {"text":"response.completed"}\n\n',
    'data: {"type":"response.completed","response":{"status":"failed"}}\n\n',
    'data: {"type":"response.completed","response":{"status":"completed"}}',
    'event: response.failed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
    'event: private-event\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
    'data: null\n\n', 'data: [DONE]\n\n']) {
    assert.equal((await observe(Buffer.from(data))).completedFrames, 0);
  }
});

test('data-only multiline JSON terminal is counted once across adjacent nonterminal frames', async () => {
  const bytes = Buffer.from('data: {"type":"response.output_text.delta","delta":"response.completed"}\n\n'
    + 'data: {"type":"response.completed",\ndata: "response":{"status":"completed"}}\n\n'
    + 'data: [DONE]\n\n');
  const value = await observe(bytes, [13, 29, 47]);
  assert.equal(value.completedFrames, 1);
  assert.equal(value.failedFrames, 0); assert.equal(value.incompleteFrames, 0);
});

test('a complete data-only terminal followed by source failure still rejects the original pipeline', async () => {
  const { stream, observation } = jointForwardingObserver();
  await assert.rejects(pipeline(Readable.from((async function* () {
    yield Buffer.from('data: {"type":"response.completed","response":{"status":"completed"}}\n\n');
    throw new Error('test failure after terminal');
  })()), stream, new Writable({ write(chunk, encoding, callback) { callback(); } })));
  assert.equal(observation.completedFrames, 1);
  assert.equal(observation.sourceEnded, false);
});

test('downstream closing after a terminal frame is still transport failure, not source EOF', async () => {
  for (const prefix of ['', 'event: response.completed\n']) {
    const { stream, observation } = jointForwardingObserver();
    const source = new PassThrough();
    const destination = new Writable({ write(chunk, encoding, callback) {
      callback(); this.destroy();
    } });
    const forwarding = pipeline(source, stream, destination);
    source.write(prefix + 'data: {"type":"response.completed","response":{"status":"completed"}}\n\n');
    await assert.rejects(forwarding, { code: 'ERR_STREAM_PREMATURE_CLOSE' });
    assert.equal(observation.completedFrames, 1);
    assert.equal(observation.sourceEnded, false);
    assert.equal(source.destroyed, true); assert.equal(stream.destroyed, true);
    assert.equal(destination.writableFinished, false);
  }
});

test('oversized frames are bounded and transparent, and the next valid frame is observable', async () => {
  const bytes = Buffer.from('event: response.completed\ndata: ' + 'x'.repeat(100_000) + '\n\n'
    + 'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n');
  const value = await observe(bytes, [40_000, 40_000]);
  assert.equal(value.oversizedFrames, 1); assert.equal(value.completedFrames, 1);
});

test('upstream interruption remains a rejected pipeline, not a successful completed stream', async () => {
  const { stream, observation } = jointForwardingObserver();
  await assert.rejects(pipeline(Readable.from((async function* () {
    yield Buffer.from('event: response.completed\ndata: ');
    throw new Error('test upstream interruption');
  })()), stream, new Writable({ write(chunk, encoding, callback) { callback(); } })));
  assert.equal(observation.sourceEnded, false); assert.equal(observation.completedFrames, 0);
});

test('provider diagnostics retain only bounded transport facts, never provider text or credentials', () => {
  const secret = 'private-provider-body-and-token';
  const value = jointForwardingDiagnostic({ name: secret, code: secret, message: secret,
    stack: secret, cause: { code: secret, message: secret } },
  { ordinal: 5, elapsedMs: 120, status: 200, phase: 'streaming', responseDestroyed: true,
    responseFinished: false, headers: secret, body: secret });
  assert.deepEqual(value, { ordinal: 5, elapsedMs: 120, status: 200, phase: 'streaming',
    responseDestroyed: true, responseFinished: false, name: 'Other', code: null, causeCode: null });
  assert.ok(!JSON.stringify(value).includes(secret));
});

test('known abort/socket failures are distinguishable without arbitrary error serialization', () => {
  assert.deepEqual(jointForwardingDiagnostic({ name: 'TypeError', cause: { code: 'UND_ERR_SOCKET' } },
    { ordinal: Infinity, elapsedMs: -1, status: 700, phase: 'private' }),
  { ordinal: null, elapsedMs: null, status: null, phase: 'unknown', responseDestroyed: false,
    responseFinished: false, name: 'TypeError', code: null, causeCode: 'UND_ERR_SOCKET' });
  assert.equal(jointForwardingDiagnostic({ name: 'TimeoutError' }).name, 'TimeoutError');
  assert.equal(jointForwardingDiagnostic({ code: 'ERR_STREAM_PREMATURE_CLOSE' }).code, 'ERR_STREAM_PREMATURE_CLOSE');
});
