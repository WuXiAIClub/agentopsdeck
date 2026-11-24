import assert from 'node:assert/strict';
import test from 'node:test';
import { isVideoAttachment } from './message-video.js';

const item = { type: 'file' as const, name: '演示 video.MP4', url: '/api/artifacts/a123' };
test('video attachments accept existing artifact, owned and shared session media routes', () => {
  for (const url of [item.url, `/api/hub/v1/sessions/c%3As/messages/m/media/${'a'.repeat(64)}`,
    `/api/hub/v1/shared/view/sessions/c%3As/messages/m/media/${'b'.repeat(64)}`]) {
    assert.equal(isVideoAttachment({ ...item, url }), true);
    assert.equal(isVideoAttachment({ ...item, url, name: 'no-extension', mimeType: 'video/webm' }), true);
  }
  assert.equal(isVideoAttachment({ ...item, name: 'C:\\work\\clip.webm' }), true);
  assert.equal(isVideoAttachment({ ...item, name: 'clip.ogv' }), true);
});
test('do not fetch arbitrary URLs or mistake JSON source previews and non-video files for videos', () => {
  for (const url of ['https://other.test/a.mp4', '//other.test/a.mp4', 'file:///work/a.mp4', 'C:\\work\\a.mp4',
    '/api/artifacts/abc/other', '/api/artifacts/abc?redirect=https://other.test', '/api/auth/status',
    `/api/hub/v1/sessions/%2e%2e/messages/m/media/${'a'.repeat(64)}`]) {
    assert.equal(isVideoAttachment({ ...item, url }), false, url);
  }
  assert.equal(isVideoAttachment({ ...item, name: 'report.txt', mimeType: 'text/plain' }), false);
  assert.equal(isVideoAttachment({ ...item, sourceReference: { path: '/work/movie.mp4', line: 1, href: '/work/movie.mp4' } }), false);
});
