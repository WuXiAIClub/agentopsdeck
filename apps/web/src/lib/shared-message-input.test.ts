import test from 'node:test';
import assert from 'node:assert/strict';
import { copySharedMessageInput, SHARED_ATTACHMENT_MAX_BYTES } from '@agentopsdeck/shared';

const image = () => {
  const raw = '\x89PNG\r\n\x1a\n' + '\0'.repeat(16);
  return { type: 'image', name: 'input.png', mimeType: 'image/png', size: raw.length, dataUrl: `data:image/png;base64,${btoa(raw)}` };
};
test('shared input owns exact message and attachments, including attachment-only input', () => {
  const input = { message: ' ', media: [image()] }, captured = copySharedMessageInput(input, 'codex');
  input.media[0]!.name = 'changed';
  assert.equal(captured.media![0]!.name, 'input.png');
  assert.equal(captured.message, ' ');
  assert.equal(captured.deliveryMode, 'web-only');
});
test('attachment metadata, canonical base64, content signature and unknown fields fail closed', () => {
  for (const patch of [{ name: '../input.png' }, { name: 'a\n' }, { name: '' }, { size: 1 }, { size: SHARED_ATTACHMENT_MAX_BYTES + 1 },
    { type: 'file' }, { mimeType: 'text/html' }, { dataUrl: 'https://host/file' }, { dataUrl: 'data:image/png;base64,AAAA' }, { filePath: '/tmp/private' }]) {
    assert.throws(() => copySharedMessageInput({ message: 'a', media: [{ ...image(), ...patch }] }));
  }
  for (const value of [{ message: 'a', actorId: 'owner' }, { message: 'a', deliveryMode: ['mirror'] }, { message: '/stop', media: [image()] },
    { message: 'a', media: Array.from({ length: 9 }, image) }]) assert.throws(() => copySharedMessageInput(value));
});
test('native text attachments require UTF8 without NUL; Codex remains image only', () => {
  const text = { type: 'file', name: 'input.txt', mimeType: 'text/plain', size: 2, dataUrl: 'data:text/plain;base64,aGk=' };
  assert.ok(copySharedMessageInput({ message: '', media: [text] }, 'claude').media);
  assert.throws(() => copySharedMessageInput({ message: '', media: [text] }, 'codex'));
  for (const data of ['AP8=', 'aGl=']) assert.throws(() => copySharedMessageInput({ message: '', media: [{ ...text, dataUrl: `data:text/plain;base64,${data}` }] }));
});
