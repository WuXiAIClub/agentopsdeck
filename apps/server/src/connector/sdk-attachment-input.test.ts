import assert from 'node:assert/strict';
import test from 'node:test';
import { validateSdkAttachments, prepareSdkAttachments, claudeAttachmentPrompt, copilotAttachmentPrompt,
  normalizeClaudeAttachmentEcho, normalizeCopilotAttachmentEcho, SDK_ATTACHMENT_MAX_BYTES } from './sdk-attachment-input.js';

const text = { name: 'notes.md', mimeType: 'text/markdown', data: Buffer.from('- [ ] task').toString('base64') };
test('SDK attachment validation rejects paths, remote URLs, executable/HTML/binary text, corrupt base64 and MIME mismatches', () => {
  assert.doesNotThrow(() => validateSdkAttachments([text]));
  for (const item of [{ ...text, name: '../notes.md' }, { ...text, path: '/etc/passwd' }, { ...text, url: 'https://example.test' },
    { ...text, mimeType: 'text/html' }, { ...text, data: 'a===' }, { ...text, data: 'YWJ=' },
    { ...text, data: '/w==' }, { ...text, data: 'AA==' }, { ...text, mimeType: 'image/png' }]) {
    assert.throws(() => validateSdkAttachments([item]), /invalid SDK attachment/);
  }
  assert.throws(() => prepareSdkAttachments([{ type: 'file', name: 'test', mimeType: 'image/png', dataUrl: `data:text/plain;base64,${text.data}` }]));
  assert.throws(() => prepareSdkAttachments([{ type: 'file', name: 'test', size: 99, dataUrl: `data:text/plain;base64,${text.data}` }]));
  assert.throws(() => validateSdkAttachments(Array(9).fill(text)));
});
test('large base64 does not overflow regex stack; text and image byte bounds apply independently', () => {
  const bytes = Buffer.alloc(SDK_ATTACHMENT_MAX_BYTES, 1); bytes.set(Buffer.from('89504e470d0a1a0a', 'hex'));
  const image = { name: 'large.png', mimeType: 'image/png', data: bytes.toString('base64') };
  assert.doesNotThrow(() => validateSdkAttachments([image]));
  assert.throws(() => validateSdkAttachments(Array(5).fill(image)));
  assert.throws(() => validateSdkAttachments([{ ...text, data: Buffer.alloc(100_001, 65).toString('base64') }]));
});
test('native prompt conversions preserve text-only behavior and reject mismatched native echoes', () => {
  assert.equal(claudeAttachmentPrompt('hello'), 'hello'); assert.equal(copilotAttachmentPrompt('hello'), 'hello');
  const identity = { id: 'run', nativeSessionId: 'native' };
  const claude = { type: 'user', uuid: 'run', session_id: 'native', parent_tool_use_id: null, message: { content: claudeAttachmentPrompt('hello', [text]) } };
  assert.equal((normalizeClaudeAttachmentEcho(claude, identity, 'hello', [text]) as typeof claude).message.content, 'hello');
  const notice = { ...claude, uuid: 'other', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } };
  assert.equal(normalizeClaudeAttachmentEcho(notice, identity, 'hello', [text]), notice);
  assert.throws(() => normalizeClaudeAttachmentEcho({ ...claude, session_id: 'foreign' }, identity, 'hello', [text]));
  assert.throws(() => normalizeClaudeAttachmentEcho(claude, identity, 'different', [text]));
  const prompt = copilotAttachmentPrompt('hello', [text]); assert.notEqual(typeof prompt, 'string');
  const copilot = { type: 'user.message', data: { content: typeof prompt === 'string' ? prompt : prompt.prompt } };
  assert.equal((normalizeCopilotAttachmentEcho(copilot, 'hello', [text]) as typeof copilot).data.content, 'hello');
  assert.throws(() => normalizeCopilotAttachmentEcho(copilot, 'different', [text]));
});
