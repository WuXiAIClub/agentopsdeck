import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import {
  createToolImageCompatibilityRelay,
  normalizeResponsesInput,
  normalizeResponsesTools,
  rewriteGeminiToolImages,
} from './tool-image-compat.js';

const image = { type: 'input_image', image_url: 'data:image/png;base64,c3ludGhldGlj', detail: 'high' };

test('relay normalizes orphan goal_objective outputs, supports gemini-4-neon tool images, and retries invalid_request_body once', async () => {
  const normalized = normalizeResponsesInput({
    model: 'gemini-4-neon',
    input: [
      { type: 'function_call_output', id: 'fco-goal', name: 'goal_objective', namespace: 'agent', output: 'Deliver episode cut' },
      { type: 'function_call_output', id: 'fco-paired', call_id: 'call-1', name: 'exec_command', namespace: 'shell', output: 'ok' },
    ],
  }) as any;
  assert.deepEqual(normalized.input, [
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '[goal_objective]\nDeliver episode cut' }] },
    { type: 'function_call_output', id: 'fco-paired', call_id: 'call-1', output: 'ok' },
  ]);

  const bodyWithImage = {
    model: 'gemini-4-neon',
    stream: true,
    store: false,
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Synthetic prompt' }] },
      { type: 'reasoning', id: 'synthetic-reasoning', encrypted_content: 'synthetic-encrypted' },
      { type: 'function_call', id: 'synthetic-item', call_id: 'synthetic-call', name: 'view_image', arguments: '{"path":"/synthetic.png"}' },
      { type: 'function_call_output', id: 'synthetic-output', call_id: 'synthetic-call', output: [
        { type: 'input_text', text: 'Before image' }, image, { type: 'input_text', text: 'After image' },
      ] },
    ],
  };
  const liftedNeon = rewriteGeminiToolImages(bodyWithImage) as any;
  assert.equal(liftedNeon.input.length, 5);

  const seen: any[] = [];
  const stream = 'event: response.completed\ndata: {"type":"response.completed"}\n\n';
  const upstream = createServer(async (incoming, outgoing) => {
    let raw = ''; for await (const chunk of incoming) raw += chunk;
    seen.push(JSON.parse(raw));
    if (seen.length === 1) {
      outgoing.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({
        error: { code: null, message: 'upstream error (400): invalid request body (code=invalid_request_body)', param: null, type: 'invalid_request_error' },
      }));
      return;
    }
    outgoing.writeHead(200, { 'content-type': 'text/event-stream' }).end(stream);
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  const relay = await createToolImageCompatibilityRelay({
    provider: 'vekil',
    upstreamBaseUrl: `http://127.0.0.1:${address.port}/v1`,
    retryStaleConnectionItems: true,
  });
  try {
    const body = {
      ...bodyWithImage,
      input: [
        ...bodyWithImage.input,
        { type: 'function_call_output', id: 'fco-goal', name: 'goal_objective', namespace: 'agent', output: 'Objective text' },
      ],
    };
    const response = await fetch(`${relay.baseUrl}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), stream);
    assert.equal(seen.length, 2);
    assert.equal(seen[0].input.at(-1).role, 'developer');
    assert.equal('encrypted_content' in seen[1].input[1], false);
    assert.equal('id' in seen[1].input[2], false);
  } finally {
    await relay.close();
    const closing = new Promise<void>(resolve => upstream.close(() => resolve()));
    upstream.closeAllConnections();
    await closing;
  }
});

test('normalizeResponsesTools repairs bare arrays, prefixItems tuples, and empty root objects across function and MCP namespace tools', () => {
  const validBody = {
    model: 'gemini-4-neon',
    tools: [{
      type: 'function',
      name: 'exec_command',
      parameters: { type: 'object', properties: { cmd: { type: 'string' } } },
    }],
    input: [],
  };
  assert.equal(normalizeResponsesTools(validBody), validBody);

  const rawBody = {
    model: 'gemini-4-neon',
    tools: [
      {
        type: 'function',
        name: 'no_props_tool',
        parameters: { type: 'object' },
      },
      {
        type: 'namespace',
        name: 'mcp__libtv',
        tools: [
          {
            type: 'function',
            name: 'edit_timeline',
            parameters: {
              type: 'object',
              $defs: {
                Clip: {
                  type: 'object',
                  properties: { tags: { type: 'array' } },
                },
              },
              properties: {
                bareList: { type: 'array' },
                nullableList: { anyOf: [{ type: 'array' }, { type: 'null' }] },
                unionTypeList: { type: ['array', 'null'] },
                rangeTuple: { type: 'array', prefixItems: [{ type: 'number' }, { type: 'string' }], minItems: 2, maxItems: 2 },
                draft7Tuple: { type: 'array', items: [{ type: 'number' }] },
                hybridNullableAssets: {
                  description: 'Asset metadata',
                  properties: { characters: { type: 'array' } },
                  additionalProperties: false,
                  anyOf: [
                    { type: 'object', properties: {}, additionalProperties: { type: 'string' } },
                    { type: 'null' },
                  ],
                },
              },
            },
          },
        ],
      },
    ],
    input: [],
  };

  const normalized = normalizeResponsesTools(rawBody) as any;
  assert.deepEqual(normalized.tools[0].parameters, { type: 'object', properties: {} });
  const subParams = normalized.tools[1].tools[0].parameters;
  assert.deepEqual(subParams.$defs.Clip.properties.tags, { type: 'array', items: {} });
  assert.deepEqual(subParams.properties.bareList, { type: 'array', items: {} });
  assert.deepEqual(subParams.properties.nullableList, { anyOf: [{ type: 'array', items: {} }, { type: 'null' }] });
  assert.deepEqual(subParams.properties.unionTypeList, { type: ['array', 'null'], items: {} });
  assert.deepEqual(subParams.properties.rangeTuple, {
    type: 'array',
    items: { anyOf: [{ type: 'number' }, { type: 'string' }] },
    minItems: 2,
    maxItems: 2,
  });
  assert.equal('prefixItems' in subParams.properties.rangeTuple, false);
  assert.deepEqual(subParams.properties.draft7Tuple, { type: 'array', items: { type: 'number' } });
  assert.deepEqual(subParams.properties.hybridNullableAssets, {
    description: 'Asset metadata',
    anyOf: [
      {
        type: 'object',
        properties: { characters: { type: 'array', items: {} } },
        additionalProperties: false,
      },
      { type: 'null' },
    ],
  });
});

