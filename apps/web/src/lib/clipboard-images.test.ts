import assert from 'node:assert/strict';
import test from 'node:test';
import { clipboardImages } from './clipboard-images.js';

const file = (name = 'shot.png', type = 'image/png') => new File(['image'], name, { type });
const transfer = (items: (File | null)[], files: File[] = []) => ({
  items: items.map(value => ({ kind: 'file', getAsFile: () => value })), files,
}) as unknown as DataTransfer;

test('captures image items once without duplicating fallback files', () => {
  const shot = file(); assert.deepEqual(clipboardImages(transfer([shot, null], [shot])), [shot]);
});
test('falls back to clipboard files and recognizes missing MIME by image filename', () => {
  const shots = [file('screen.PNG', ''), file('screen.jpg', 'application/octet-stream')];
  assert.deepEqual(clipboardImages(transfer([], shots)), shots);
});
test('ordinary text/HTML/URLs and nonimage files are not intercepted', () => {
  assert.deepEqual(clipboardImages(transfer([file('report.txt', 'text/plain')])), []);
  assert.deepEqual(clipboardImages(transfer([])), []);
  assert.deepEqual(clipboardImages(transfer([file('unknown', '')])), []);
});
