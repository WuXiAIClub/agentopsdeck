import assert from 'node:assert/strict';
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http';
import test from 'node:test';
import { createToolImageCompatibilityRelay, rewriteGeminiToolImages, toolImageCompatibilityArguments } from './tool-image-compat.js';
import { loadConfig, redactedConfig } from '../config.js';

const image = { type: 'input_image', image_url: 'data:image/png;base64,c3ludGhldGlj', detail: 'high' };
function fixture(model = 'gemini-4-carbon') {
  return { model, stream: true, store: false, input: [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Synthetic prompt' }] },
    { type: 'reasoning', id: 'synthetic-reasoning', encrypted_content: 'synthetic-encrypted' },
    { type: 'function_call', id: 'synthetic-item', call_id: 'synthetic-call', name: 'view_image', arguments: '{"path":"/synthetic.png"}' },
    { type: 'function_call_output', id: 'synthetic-output', call_id: 'synthetic-call', output: [
      { type: 'input_text', text: 'Before image' }, image, { type: 'input_text', text: 'After image' },
    ] },
  ] };
}

test('tool images are lifted without mutating history, IDs, reasoning, image bytes, text or call pairing', () => {
  const body = fixture();
  const snapshot = JSON.stringify(body);
  const result = rewriteGeminiToolImages(body) as typeof body;
  assert.notEqual(result, body);
  assert.equal(JSON.stringify(body), snapshot);
  assert.equal(result.input.length, 5);
  for (const index of [0, 1, 2]) assert.equal(result.input[index], body.input[index]);
  const output = result.input[3]!;
  assert.equal(output.id, 'synthetic-output');
  assert.equal(output.call_id, 'synthetic-call');
  assert.deepEqual(output.output?.map(part => 'text' in part ? part.text : undefined), [
    'Before image', 'Image included in the following user message for this tool call.', 'After image',
  ]);
  const message = result.input[4]!;
  assert.equal(message.role, 'user');
  assert.match(message.content?.[0]?.text ?? '', /synthetic-call/);
  assert.equal(message.content?.[1], image);
  assert.equal(rewriteGeminiToolImages(result), result);
});

test('other models and unsupported/ambiguous outputs pass through unchanged', () => {
  for (const model of ['gpt-6.1-sol', 'gemini-4-argon', 'gemini-4-carbon-other']) {
    const body = fixture(model); assert.equal(rewriteGeminiToolImages(body), body);
  }
  for (const output of ['text only', [], [{ type: 'input_file', file_id: 'synthetic-file' }, image], [image, 7],
    [{ type: 'input_image', file_id: 'synthetic-file' }], [{ type: 'input_text', text: 'text' }]]) {
    const body = fixture() as any; body.input[3].output = output;
    assert.equal(rewriteGeminiToolImages(body), body);
  }
  for (const mutate of [
    (body: any) => { body.input[2].name = 'other_tool'; },
    (body: any) => { body.input[3].call_id = 'unpaired'; },
    (body: any) => { body.input.push(body.input[2]); },
    (body: any) => { body.input.push(body.input[3]); },
    (body: any) => { [body.input[2], body.input[3]] = [body.input[3], body.input[2]]; },
  ]) {
    const body = fixture(); mutate(body); assert.equal(rewriteGeminiToolImages(body), body);
  }
  for (const body of [null, 'text', { model: 'gemini-4-carbon', input: 'text' }]) assert.equal(rewriteGeminiToolImages(body), body);
});

test('parallel calls retain a contiguous output group before lifted images and preserve following items', () => {
  const body = fixture() as any;
  body.input.splice(3, 0, { ...body.input[2], call_id: 'second-call' });
  body.input.push({ ...body.input[4], call_id: 'second-call', output: [image, { ...image, detail: 'low' }] });
  const following = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'After tools' }] };
  body.input.push(following);
  const result = rewriteGeminiToolImages(body) as any;
  assert.deepEqual(result.input.map((item: any) => item.type), [
    'message', 'reasoning', 'function_call', 'function_call', 'function_call_output', 'function_call_output',
    'message', 'message', 'message',
  ]);
  assert.equal(result.input[7].content.length, 3);
  assert.equal(result.input.at(-1), following);
});

test('compatibility is opt-in and overrides only the explicitly selected provider', () => {
  assert.equal(loadConfig({}).codex.toolImageCompatibility, undefined);
  const config = loadConfig({ AOD_CODEX_MODEL_PROVIDER: 'litellm', AOD_CODEX_GEMINI_TOOL_IMAGE_UPSTREAM: 'http://localhost/v1' });
  assert.deepEqual(config.codex.toolImageCompatibility, { provider: 'litellm', upstreamBaseUrl: 'http://localhost/v1' });
  assert.deepEqual(redactedConfig(config).codex.toolImageCompatibility, { enabled: true, provider: 'litellm' });
  assert.equal(JSON.stringify(redactedConfig(config)).includes('http://localhost/v1'), false);
  assert.deepEqual(toolImageCompatibilityArguments(config.codex.toolImageCompatibility!, 'http://127.0.0.1:1234/private'), [
    '-c', 'model_providers.litellm.base_url="http://127.0.0.1:1234/private"',
  ]);
  assert.throws(() => toolImageCompatibilityArguments({ provider: 'bad.path', upstreamBaseUrl: '' }, ''), /Invalid/);
});

async function harness(handler: (incoming: IncomingMessage, outgoing: ServerResponse) => void,
  limits?: { bodyBytes: number; concurrent: number; timeoutMs: number }) {
  const upstream = createServer(handler);
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  const relay = await createToolImageCompatibilityRelay({ provider: 'litellm', upstreamBaseUrl: `http://127.0.0.1:${address.port}/v1` }, limits);
  return { relay, async close() {
    await relay.close();
    const closing = new Promise<void>(resolve => upstream.close(() => resolve()));
    upstream.closeAllConnections(); await closing;
  } };
}

test('relay scopes its endpoint, preserves auth and SSE bytes, and forwards model catalogs', async () => {
  const seen: { url?: string; body: string; authorization?: string }[] = [];
  const stream = 'event: response.completed\ndata: {"type":"response.completed"}\n\n';
  const owned = await harness(async (incoming, outgoing) => {
    let body = ''; for await (const chunk of incoming) body += chunk;
    seen.push({ ...(incoming.url ? { url: incoming.url } : {}), body,
      ...(incoming.headers.authorization ? { authorization: incoming.headers.authorization } : {}) });
    outgoing.writeHead(200, { 'content-type': incoming.method === 'GET' ? 'application/json' : 'text/event-stream' });
    outgoing.write(incoming.method === 'GET' ? '{"data":[]}' : stream.slice(0, 15));
    if (incoming.method !== 'GET') outgoing.write(stream.slice(15));
    outgoing.end();
  });
  try {
    assert.equal((await fetch(`${new URL(owned.relay.baseUrl).origin}/responses`, { method: 'POST' })).status, 404);
    assert.equal((await fetch(`${owned.relay.baseUrl}/responses/extra`, { method: 'POST' })).status, 404);
    assert.equal((await fetch(`${owned.relay.baseUrl}/responses`)).status, 404);
    const response = await fetch(`${owned.relay.baseUrl}/responses`, { method: 'POST', headers: {
      authorization: 'Bearer synthetic-only', 'content-type': 'application/json',
    }, body: JSON.stringify(fixture()) });
    assert.equal(response.status, 200); assert.equal(await response.text(), stream);
    assert.deepEqual(JSON.parse(seen[0]!.body), rewriteGeminiToolImages(fixture()));
    assert.equal(seen[0]!.authorization, 'Bearer synthetic-only'); assert.equal(seen[0]!.url, '/v1/responses');
    assert.equal(await (await fetch(`${owned.relay.baseUrl}/models`)).text(), '{"data":[]}');
    assert.equal(seen[1]!.url, '/v1/models');
  } finally { await owned.close(); }
});

test('unaffected model payload bytes and upstream 400 bodies are passed through without retry', async () => {
  let count = 0;
  const raw = JSON.stringify(fixture('gpt-6.1-sol'), null, 2);
  const owned = await harness(async (incoming, outgoing) => {
    count++; let body = ''; for await (const chunk of incoming) body += chunk;
    assert.equal(body, raw); outgoing.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"synthetic"}');
  });
  try {
    const response = await fetch(`${owned.relay.baseUrl}/responses`, { method: 'POST', body: raw });
    assert.equal(response.status, 400); assert.equal(await response.text(), '{"error":"synthetic"}'); assert.equal(count, 1);
  } finally { await owned.close(); }
});

test('malformed, oversized and encoded requests never reach upstream', async () => {
  let count = 0;
  const owned = await harness((_incoming, outgoing) => { count++; outgoing.end(); }, { bodyBytes: 128, concurrent: 2, timeoutMs: 1000 });
  try {
    for (const [body, headers, expected] of [
      ['not json', {}, 400], ['"' + 'x'.repeat(150) + '"', {}, 413], ['{}', { 'content-encoding': 'gzip' }, 415],
    ] as const) {
      const response = await fetch(`${owned.relay.baseUrl}/responses`, { method: 'POST', body, headers });
      assert.equal(response.status, expected); await response.text();
    }
    assert.equal(count, 0);
  } finally { await owned.close(); }
});

test('close cancels active streams, closes its listener, and is idempotent', async () => {
  let ended!: () => void;
  const disconnected = new Promise<void>(resolve => { ended = resolve; });
  const owned = await harness((_incoming, outgoing) => {
    outgoing.on('close', ended); outgoing.writeHead(200, { 'content-type': 'text/event-stream' }); outgoing.write('data: synthetic\n\n');
  });
  try {
    const response = await fetch(`${owned.relay.baseUrl}/responses`, { method: 'POST', body: '{}' });
    const reader = response.body!.getReader(); await reader.read();
    const pending = reader.read();
    await owned.relay.close(); await assert.rejects(pending); await disconnected;
    await owned.relay.close();
    await assert.rejects(fetch(`${owned.relay.baseUrl}/models`));
  } finally { await owned.close(); }
});

test('client cancellation, concurrency and deadline bound upstream work without retries', async () => {
  let count = 0;
  let disconnected!: () => void;
  let closed = new Promise<void>(resolve => { disconnected = resolve; });
  const owned = await harness((_incoming, outgoing) => {
    count++; outgoing.on('close', disconnected); outgoing.writeHead(200); outgoing.write('synthetic');
  }, { bodyBytes: 4096, concurrent: 1, timeoutMs: 250 });
  try {
    const controller = new AbortController();
    const first = await fetch(`${owned.relay.baseUrl}/responses`, { method: 'POST', body: '{}', signal: controller.signal });
    assert.equal((await fetch(`${owned.relay.baseUrl}/models`)).status, 503);
    controller.abort(); await first.body!.cancel().catch(() => {}); await closed;
    closed = new Promise<void>(resolve => { disconnected = resolve; });
    const second = await fetch(`${owned.relay.baseUrl}/responses`, { method: 'POST', body: '{}' });
    await assert.rejects(second.text()); await closed; assert.equal(count, 2);
  } finally { await owned.close(); }
});

test('hop-by-hop headers and redirects cannot forward credentials to a second endpoint', async () => {
  let count = 0;
  const owned = await harness((incoming, outgoing) => {
    count++; assert.equal(incoming.headers['x-synthetic-hop'], undefined);
    outgoing.writeHead(307, { location: 'http://127.0.0.1:1/no-follow', connection: 'close' }).end();
  });
  try {
    const status = await new Promise<number>(resolve => {
      const client = request(`${owned.relay.baseUrl}/responses`, { method: 'POST', headers: {
        connection: 'x-synthetic-hop, close', 'x-synthetic-hop': 'not-forwarded', authorization: 'Bearer synthetic',
      } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode!)); });
      client.end('{}');
    });
    assert.equal(status, 502); assert.equal(count, 1);
  } finally { await owned.close(); }
});

test('native compaction requests retain their original bytes without image rewriting', async () => {
  const raw = JSON.stringify(fixture(), null, 2);
  const owned = await harness(async (incoming, outgoing) => {
    assert.equal(incoming.url, '/v1/responses/compact');
    let body = ''; for await (const chunk of incoming) body += chunk;
    assert.equal(body, raw); outgoing.end('synthetic compact response');
  });
  try {
    const response = await fetch(`${owned.relay.baseUrl}/responses/compact`, { method: 'POST', body: raw });
    assert.equal(await response.text(), 'synthetic compact response');
  } finally { await owned.close(); }
});

test('upstream URLs cannot contain credentials, queries or unsupported schemes', async () => {
  for (const upstreamBaseUrl of ['file:///tmp/private', 'http://user:password@localhost/v1', 'http://localhost/v1?token=synthetic', 'not a URL']) {
    await assert.rejects(createToolImageCompatibilityRelay({ provider: 'litellm', upstreamBaseUrl }), /^Error: Invalid tool image compatibility upstream$/);
  }
});
