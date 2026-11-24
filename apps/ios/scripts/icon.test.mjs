import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { inflateSync } from 'node:zlib';

test('App Store placeholder icon is an opaque RGB 1024px PNG with complete pixel data', () => {
  const image = readFileSync(new URL('../Resources/Assets.xcassets/AppIcon.appiconset/AppIcon.png', import.meta.url));
  assert.deepEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(image.readUInt32BE(16), 1024);
  assert.equal(image.readUInt32BE(20), 1024);
  assert.equal(image[24], 8);
  assert.equal(image[25], 2);
  const compressed = [];
  let offset = 8;
  let ended = false;
  while (offset < image.length) {
    const length = image.readUInt32BE(offset);
    const type = image.toString('ascii', offset + 4, offset + 8);
    assert.ok(offset + length + 12 <= image.length);
    if (type === 'IDAT') compressed.push(image.subarray(offset + 8, offset + 8 + length));
    if (type === 'IEND') ended = true;
    offset += length + 12;
  }
  assert.equal(offset, image.length);
  assert.equal(ended, true);
  const pixels = inflateSync(Buffer.concat(compressed));
  assert.equal(pixels.length, (1024 * 3 + 1) * 1024);
  for (let row = 0; row < 1024; row += 1) assert.equal(pixels[row * (1024 * 3 + 1)], 0);
});
