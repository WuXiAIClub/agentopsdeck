// Synthetic native endpoint for the version-pinned SDK contract probe. This is
// not a CLI emulator, model/provider test, or production transport.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

const kind = process.argv[2];
const scenario = process.argv[3];
const sessionId = '11111111-1111-4111-8111-111111111111';
const wire = value => {
  const json = JSON.stringify(value);
  process.stdout.write(kind === 'claude' ? `${json}\n` : `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
};
const result = (id, data) => wire({ jsonrpc: '2.0', id, result: data });
let sends = 0;
let permissionDenied = false;
let activeSession = sessionId;
const events = [];
const event = (type, data) => {
  const value = { id: randomUUID(), timestamp: new Date().toISOString(), parentId: null, type, data };
  events.push(value);
  wire({ jsonrpc: '2.0', method: 'session.event', params: { sessionId: activeSession, event: value } });
};

function claude(message) {
  if (message.type === 'control_request') {
    const { subtype } = message.request;
    if (subtype === 'initialize') {
      wire({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id,
        response: { commands: [], models: [{ value: 'fixture', displayName: 'Fixture', description: 'Not a model' }], account: {} } } });
    } else if (subtype === 'interrupt') {
      wire({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } });
    } else throw new Error(`Unexpected Claude control: ${subtype}`);
  } else if (message.type === 'user') {
    sends++;
    assert.equal(sends, 1, 'must not silently replay a send');
    wire({ type: 'system', subtype: 'init', session_id: sessionId, uuid: randomUUID(), tools: [], model: 'fixture' });
    wire({ type: 'control_request', request_id: 'permission-fixture', request: {
      subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'must-not-execute' }, tool_use_id: 'tool-fixture' } });
  } else if (message.type === 'control_response' && message.response.request_id === 'permission-fixture') {
    assert.equal(message.response.response.behavior, 'deny');
    permissionDenied = true;
    wire({ type: 'stream_event', session_id: sessionId, uuid: randomUUID(), parent_tool_use_id: null,
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'fixture reply' } } });
    wire({ type: 'assistant', session_id: sessionId, uuid: randomUUID(), parent_tool_use_id: null,
      message: { id: 'assistant-fixture', role: 'assistant', content: [{ type: 'text', text: 'fixture reply' }] } });
    wire({ type: 'result', subtype: 'success', session_id: sessionId, uuid: randomUUID(), is_error: false,
      result: 'fixture reply', num_turns: 1, duration_ms: 1, duration_api_ms: 0, total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 2 }, modelUsage: {}, permission_denials: [],
      fixture: { sends, permissionDenied } });
  }
}

function copilot(message) {
  const p = message.params ?? {};
  switch (message.method) {
    case 'connect': result(message.id, { protocolVersion: scenario === 'incompatible' ? 0 : 3 }); break;
    case 'ping': result(message.id, { protocolVersion: 3, message: 'fixture' }); break;
    case 'session.create':
      assert.deepEqual(p.availableTools, []);
      assert.equal(p.toolFilterPrecedence, 'excluded');
      activeSession = p.sessionId;
      result(message.id, { sessionId: activeSession }); break;
    case 'session.resume':
      assert.deepEqual(p.availableTools, []);
      activeSession = p.sessionId;
      result(message.id, { sessionId: activeSession }); break;
    case 'session.send':
      sends++;
      assert.equal(sends, 1, 'must not silently replay a send');
      if (scenario === 'lost-send') { process.exit(0); }
      result(message.id, { messageId: 'user-fixture' });
      event('assistant.turn_start', { turnId: 'turn-fixture' });
      event('permission.requested', { requestId: 'permission-fixture',
        permissionRequest: { kind: 'shell', fullCommandText: 'must-not-execute', toolCallId: 'tool-fixture' } });
      break;
    case 'session.permissions.handlePendingPermissionRequest':
      assert.equal(p.result.kind, 'reject');
      permissionDenied = true;
      result(message.id, {});
      event('assistant.message_delta', { messageId: 'assistant-fixture', deltaContent: 'fixture reply' });
      event('assistant.message', { messageId: 'assistant-fixture', content: 'fixture reply' });
      event('assistant.turn_end', { turnId: 'turn-fixture' });
      event('session.idle', {});
      break;
    case 'session.getMessages': result(message.id, { events }); break;
    case 'session.abort': result(message.id, {}); break;
    case 'session.destroy': result(message.id, {}); break;
    case 'session.disconnect': result(message.id, {}); break;
    case 'session.detach': result(message.id, { success: true }); break;
    case 'runtime.shutdown': result(message.id, {}); break;
    case 'session.options.update': result(message.id, {}); break;
    default:
      if (message.id !== undefined) wire({ jsonrpc: '2.0', id: message.id,
        error: { code: -32601, message: `Unsupported fixture method: ${message.method}` } });
  }
}

if (kind === 'claude') {
  createInterface({ input: process.stdin }).on('line', line => claude(JSON.parse(line)));
} else if (kind === 'copilot') {
  let buffer = Buffer.alloc(0);
  process.stdin.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) break;
      const length = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString())?.[1]);
      assert.ok(Number.isSafeInteger(length) && length >= 0 && length <= 1_000_000);
      if (buffer.length < end + 4 + length) break;
      const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString());
      buffer = buffer.subarray(end + 4 + length);
      copilot(message);
    }
  });
} else throw new Error('Explicit fixture runtime required');
process.stdin.on('end', () => process.exit(0));
