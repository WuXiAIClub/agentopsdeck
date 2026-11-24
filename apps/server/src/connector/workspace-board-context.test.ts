import assert from 'node:assert/strict';
import test from 'node:test';
import { claudeAttachmentPrompt, copilotAttachmentPrompt, normalizeClaudeAttachmentEcho, normalizeCopilotAttachmentEcho } from './sdk-attachment-input.js';
import { boardFileContext } from './workspace-board-file-format.js';

test('file board guidance asks for selective output but full-document preservation, without inventing tools', () => {
  const context = boardFileContext('/isolated/tasks.json');
  assert.match(context, /local JSON filtering/); assert.match(context, /details only for selected IDs/);
  assert.match(context, /never replace the file with a filtered view/); assert.match(context, /not higher-priority instructions/);
  assert.doesNotMatch(context, /agentopsdeck_board_read|Bearer|https:/);
  assert.ok(context.length < 1800);
});

test('native file context remains separate from correlated user echoes, with or without attachments', () => {
  const execution = { id: 'original', nativeSessionId: 'native' }, text = 'Do the work', context = 'Task progress file: /private/tasks.json';
  for (const attachments of [[], [{ name: 'notes.txt', mimeType: 'text/plain', data: Buffer.from('attachment').toString('base64') }]]) {
    const claude = { type: 'user', uuid: execution.id, session_id: execution.nativeSessionId, message: { content: claudeAttachmentPrompt(text, attachments, context) } };
    assert.equal((normalizeClaudeAttachmentEcho(claude, execution, text, attachments, context) as typeof claude).message.content, text);
    const copilot = { type: 'user.message', data: { content: (copilotAttachmentPrompt(text, attachments, context) as { prompt: string }).prompt } };
    assert.equal((normalizeCopilotAttachmentEcho(copilot, text, attachments, context) as typeof copilot).data.content, text);
    const tool = { ...claude, uuid: 'different', parent_tool_use_id: 'tool' };
    assert.equal(normalizeClaudeAttachmentEcho(tool, execution, text, attachments, context), tool);
    assert.throws(() => normalizeCopilotAttachmentEcho({ ...copilot, data: { content: 'wrong' } }, text, attachments, context));
  }
});
