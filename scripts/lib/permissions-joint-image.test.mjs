import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inflateSync } from 'node:zlib';
import { jointImageBytes } from './permissions-joint-image.mjs';

test('joint attachment is a complete decodable PNG with valid chunk checksums', () => {
  const bytes = jointImageBytes();
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const names = [], compressed = [];
  let offset = 8;
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    assert.ok(offset + length + 12 <= bytes.length);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    names.push(type);
    let crc = 0xffffffff;
    for (const byte of bytes.subarray(offset + 4, offset + 8 + length)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    assert.equal((crc ^ 0xffffffff) >>> 0, bytes.readUInt32BE(offset + 8 + length), type + ' checksum');
    if (type === 'IHDR') {
      assert.equal(length, 13);
      assert.equal(bytes.readUInt32BE(offset + 8), 1);
      assert.equal(bytes.readUInt32BE(offset + 12), 1);
      assert.equal(bytes[offset + 16], 8); // grayscale + alpha, one scanline
      assert.equal(bytes[offset + 17], 4);
    }
    if (type === 'IDAT') compressed.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  assert.equal(offset, bytes.length);
  assert.deepEqual(names, ['IHDR', 'IDAT', 'IEND']);
  const pixels = inflateSync(Buffer.concat(compressed));
  assert.equal(pixels.length, 3);
  assert.ok(pixels[0] <= 4, 'Valid scanline filter');
});

test('each call gets independent attachment bytes', () => {
  const first = jointImageBytes(); first.fill(0);
  assert.equal(jointImageBytes()[0], 137);
});
