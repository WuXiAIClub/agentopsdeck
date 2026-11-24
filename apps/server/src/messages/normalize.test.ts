import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeMessageMedia, normalizeMessageText } from './normalize.js';

test('normalizeMessageText shows tool name and markdown-visible redacted input', () => {
  const result = normalizeMessageText({
    payload: {
      type: 'toolCall',
      name: 'executeCommand',
      args: {
        command: 'ls -la',
        token: 'secret-token-123',
        nested: {
          apiKey: 'super-secret',
          safeValue: 'keep-me',
        },
      },
    },
  });

  assert.match(result, /^\[tool executeCommand\]/);
  assert.match(result, /tool input:\n```json\n/);
  assert.match(result, /"command":"ls -la"/);
  assert.match(result, /"safeValue":"keep-me"/);
  assert.match(result, /"token":"\*\*\*REDACTED\*\*\*"/);
  assert.match(result, /"apiKey":"\*\*\*REDACTED\*\*\*"/);
  assert.doesNotMatch(result, /secret-token-123|super-secret/);
  assert.doesNotMatch(result, /<tool_input>/);
});

test('normalizeMessageText truncates long tool inputs', () => {
  const result = normalizeMessageText({
    payload: {
      type: 'toolCall',
      name: 'longTool',
      args: { data: 'a'.repeat(500) },
    },
  });

  assert.ok(result.length < 380, result);
  assert.match(result, /\.\.\./);
});

test('normalizeMessageText hides AgentOpsDeck client capability blocks', () => {
  const result = normalizeMessageText({ content: '<agentopsdeck_client_capability>\nsecret hint\n</agentopsdeck_client_capability>\n\nhello' });
  assert.equal(result, 'hello');
});

test('normalizeMessageText includes status, error, and output/result fields when available', () => {
  const result = normalizeMessageText({
    payload: {
      type: 'toolResult',
      name: 'fetchData',
      args: { id: 1 },
      status: 'error',
      error: 'Network timeout',
      result: { message: 'Partial data received' },
    },
  });

  assert.match(result, /^\[tool fetchData\]/);
  assert.match(result, /status: error/);
  assert.match(result, /error: Network timeout/);
  assert.match(result, /output:\n\{"message":"Partial data received"\}/);
});

test('normalizeMessageText falls back to alternate content fields when text is blank', () => {
  const result = normalizeMessageText({
    text: '',
    response: { content: [{ type: 'output_text', text: 'Recovered assistant content' }] },
  });

  assert.equal(result, 'Recovered assistant content');
});

test('normalizeMessageText redacts secret assignments in non-JSON tool inputs', () => {
  const result = normalizeMessageText({
    payload: {
      type: 'functionCall',
      function: { name: 'legacyTool', arguments: 'path=/tmp/report.txt token=raw-token password=hunter2' },
    },
  });

  assert.match(result, /path=\/tmp\/report\.txt/);
  assert.match(result, /token=\*\*\*REDACTED\*\*\*/);
  assert.match(result, /password=\*\*\*REDACTED\*\*\*/);
  assert.doesNotMatch(result, /raw-token|hunter2/);
});

test('normalizeMessageText strips OpenClaw/Feishu metadata envelope and keeps user content', () => {
  const result = normalizeMessageText({
    content: 'Conversation info (untrusted metadata):\n```json\n{\n  "message_id": "om_x",\n  "timestamp": "Mon 2026-07-06 11:02 GMT+8"\n}\n```\n\nSender (untrusted metadata):\n```json\n{\n  "label": "gateway-client",\n  "id": "gateway-client"\n}\n```\n\n[message_id: om_x]\nou_3eb5db41f77f4c947942266a9a79d660: 我只是给你发重复消息长的样子， 部署让你关心DNS/飞书',
  });

  assert.equal(result, '我只是给你发重复消息长的样子， 部署让你关心DNS/飞书');
});

test('normalizeMessageText strips OpenClaw timestamp-only envelope from direct messages', () => {
  const result = normalizeMessageText({ content: '[Mon 2026-07-06 02:58 UTC] 飞书先等等， 先占位， DNS是腾讯云，可以先占位， 或者我去做' });

  assert.equal(result, '飞书先等等， 先占位， DNS是腾讯云，可以先占位， 或者我去做');
});

test('normalizeMessageText hides runtime internal context blocks from display text', () => {
  const result = normalizeMessageText({
    content: '[Sat 2026-07-04 08:41 UTC] <<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nOpenClaw runtime context (internal):\nsecret runtime details\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>',
  });

  assert.equal(result, '');
});

test('normalizes Gateway media arrays from browser ZIP uploads and suppresses matching raw MEDIA placeholder', () => {
  const row = {
    role: 'user',
    content: 'MEDIA:YorozuyaDesktopPet- test-20260625.zip',
    media: [{
      url: '/api/media/inbound/agentopsdeck-123-YorozuyaDesktopPet--test-20260625.zip',
      contentType: 'application/zip',
      size: 8,
    }],
  };

  assert.equal(normalizeMessageText(row), '');
  assert.deepEqual(normalizeMessageMedia(row), [{
    type: 'file',
    url: '/api/media/inbound/agentopsdeck-123-YorozuyaDesktopPet--test-20260625.zip',
    name: 'agentopsdeck-123-YorozuyaDesktopPet--test-20260625.zip',
    mimeType: 'application/zip',
    size: 8,
  }]);
});

test('keeps unavailable placeholder for user-authored local MEDIA without structured upload media', () => {
  const result = normalizeMessageText({ content: 'MEDIA:YorozuyaDesktopPet- test-20260625.zip' });

  assert.match(result, /media unavailable: local file/);
  assert.match(result, /Ask the sender to attach or upload the file/);
});

test('normalizes OpenClaw inbound attachment transcript markers into media', () => {
  const row = {
    role: 'user',
    content: [{
      type: 'text',
      text: '[media attached: /home/example-user/.openclaw/media/inbound/19d43a7e-5149-487f-8ba5-886bc2f7ef03.webp (image/webp) | /home/example-user/.openclaw/media/inbound/19d43a7e-5149-487f-8ba5-886bc2f7ef03.webp]\ncaption',
    }],
  };

  assert.deepEqual(normalizeMessageMedia(row), [{
    type: 'image',
    url: '/api/media/inbound/19d43a7e-5149-487f-8ba5-886bc2f7ef03.webp',
    name: '19d43a7e-5149-487f-8ba5-886bc2f7ef03.webp',
    mimeType: 'image/webp',
  }]);
});
