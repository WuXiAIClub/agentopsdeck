import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeExternalMirrorText, resolveExplicitChannelRoute } from './mirror.js';

test('normalizeExternalMirrorText filters legacy tool-output-only replies', () => {
  assert.equal(normalizeExternalMirrorText('[tool output]'), undefined);
  assert.equal(normalizeExternalMirrorText('{"type":"thinking","thinking":""}\n\n[tool output]'), undefined);
});

test('normalizeExternalMirrorText filters normalized tool transcripts', () => {
  const text = [
    '[tool exec]',
    '',
    'tool input:',
    '```json',
    '{"command":"echo hi","token":"***"}',
    '```',
    '',
    '[tool output]',
  ].join('\n');
  assert.equal(normalizeExternalMirrorText(text), undefined);
});

test('normalizeExternalMirrorText keeps normal assistant replies', () => {
  assert.equal(normalizeExternalMirrorText('COD-042 smoke ok'), 'COD-042 smoke ok');
  assert.equal(normalizeExternalMirrorText('{"type":"thinking","thinking":""}\n\n正常回复'), '正常回复');
});

test('resolveExplicitChannelRoute supports non-Feishu channels without requiring account id', () => {
  assert.deepEqual(resolveExplicitChannelRoute('agent:agentopsdeck-pm:feishu:direct:ou_1', 'default'), {
    originatingChannel: 'feishu',
    originatingTo: 'ou_1',
    originatingAccountId: 'agentopsdeck-pm',
    outboundTarget: 'user:ou_1',
  });
  assert.deepEqual(resolveExplicitChannelRoute('agent:agentopsdeck-pm:openclaw-weixin:direct:wx_user', 'default'), {
    originatingChannel: 'openclaw-weixin',
    originatingTo: 'wx_user',
    outboundTarget: 'wx_user',
  });
});
