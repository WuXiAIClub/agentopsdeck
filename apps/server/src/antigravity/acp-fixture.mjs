#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';

const mode = basename(process.cwd());
const sessionId = 'synthetic-native-session';
const inputs = createInterface({ input: process.stdin });
let promptId;
const write = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const response = (id, result) => write({ jsonrpc: '2.0', id, result });
const update = (text, target = sessionId) => write({ jsonrpc: '2.0', method: 'session/update',
  params: { sessionId: target, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });

inputs.on('line', line => {
  const input = JSON.parse(line);
  appendFileSync(join(process.cwd(), 'requests.ndjson'), `${line}\n`);
  if (input.method === 'initialize') {
    if (mode === 'timeout') return;
    if (mode === 'auth') {
      write({ jsonrpc: '2.0', id: input.id, error: { code: -32000, message: 'synthetic-private-provider-error', data: 'synthetic-private-data' } });
      return;
    }
    response(input.id, { protocolVersion: mode === 'wrong-version' ? 99 : 1,
      agentCapabilities: mode === 'no-resume' ? {} : { sessionCapabilities: { resume: {} } } });
  } else if (input.method === 'session/new') {
    if (mode === 'setup-timeout') return;
    setTimeout(() => response(input.id, { sessionId }), 10);
  } else if (input.method === 'session/resume') {
    update('historical synthetic text');
    response(input.id, {});
  } else if (input.method === 'session/set_model') {
    response(input.id, {});
  } else if (input.method === 'session/prompt') {
    const text = input.params.prompt[0].text;
    promptId = input.id;
    if (text === 'disconnect') { process.exit(1); }
    if (text === 'hang-after-response') {
      setInterval(() => {}, 10_000);
      response(input.id, { stopReason: 'end_turn' });
      return;
    }
    if (text === 'lingering-descendant') {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 10000)'], {
        stdio: 'ignore',
      });
      child.unref();
      response(input.id, { stopReason: 'end_turn' });
      return;
    }
    if (text === 'oversize') { process.stdout.write('x'.repeat(1_048_577)); return; }
    if (text === 'invalid-utf8') { process.stdout.write(Buffer.from([255, 10])); return; }
    if (text === 'foreign') { update('foreign text', 'foreign-session'); return; }
    if (text === 'malformed') { process.stdout.write('{not json}\n'); return; }
    if (text === 'duplicate-response') { response(input.id + 123, {}); return; }
    if (text === 'cancel') { update('waiting'); return; }
    if (text === 'unsolicited-cancel') { response(input.id, { stopReason: 'cancelled' }); return; }
    if (text === 'bad-stop') { response(input.id, { stopReason: 'finished' }); return; }
    if (text === 'array-stop') { response(input.id, { stopReason: ['end_turn'] }); return; }
    if (text === 'bad-update') {
      write({ jsonrpc: '2.0', method: 'session/update', params: {
        sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ['synthetic'] } },
      } });
      return;
    }
    if (text === 'update-count-limit') {
      for (let count = 0; count < 4097; count++) update('synthetic');
      response(input.id, { stopReason: 'end_turn' });
      return;
    }
    if (text === 'update-byte-limit') {
      for (let count = 0; count < 9; count++) update('x'.repeat(500_000));
      response(input.id, { stopReason: 'end_turn' });
      return;
    }
    if (text === 'private-update') {
      for (const nativeUpdate of [
        { sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'synthetic-native-body', mimeType: 'image/png' } },
        { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'synthetic-private-thought' } },
        { sessionUpdate: 'tool_call', toolCallId: 'synthetic-tool', title: 'Read', status: 'completed', kind: 'read',
          rawInput: { secret: 'synthetic-private-input' }, rawOutput: 'synthetic-private-output',
          content: [{ type: 'text', text: 'synthetic-native-tool-body' }], _meta: { secret: 'synthetic-private-meta' } },
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'synthetic-visible-text',
          _meta: { secret: 'synthetic-private-content-meta' } }, _meta: { secret: 'synthetic-private-meta' } },
      ]) write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: nativeUpdate } });
      response(input.id, { stopReason: 'end_turn' });
      return;
    }
    if (text === 'permission') {
      write({ jsonrpc: '2.0', id: 'permission-1', method: 'session/request_permission', params: {
        sessionId, toolCall: { toolCallId: 'synthetic-tool' }, options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow' }],
      } });
      return;
    }
    if (text === 'unsupported-client-tool') {
      write({ jsonrpc: '2.0', id: 'terminal-1', method: 'terminal/create', params: { sessionId, command: 'synthetic' } });
      return;
    }
    const bytes = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {
      sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '你好，ACP' } },
    } })}\n`);
    for (const byte of bytes) process.stdout.write(Buffer.from([byte]));
    response(input.id, { stopReason: 'end_turn' });
  } else if (input.method === 'session/cancel') {
    response(promptId, { stopReason: 'cancelled' });
  } else if (input.id === 'permission-1' || input.id === 'terminal-1') {
    update('denied');
    response(promptId, { stopReason: 'end_turn' });
  }
});
