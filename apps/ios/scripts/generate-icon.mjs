import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const width = 1024;
const height = 1024;
const pixels = Buffer.alloc((width * 3 + 1) * height);

for (let row = 0; row < height; row += 1) {
  for (let column = 0; column < width; column += 1) {
    const horizontal = column - 480;
    const vertical = row - 512;
    const radius = Math.hypot(horizontal, vertical);
    const ring = radius > 195 && radius < 300 && !(horizontal > 110 && Math.abs(vertical) < 160);
    const dot = Math.hypot(column - 745, row - 512) < 60;
    const offset = row * (width * 3 + 1) + 1 + column * 3;
    const mark = ring || dot;
    pixels[offset] = mark ? 244 : Math.round(25 + row / 60);
    pixels[offset + 1] = mark ? 250 : Math.round(76 + column / 25);
    pixels[offset + 2] = mark ? 255 : Math.round(156 + row / 20);
  }
}

function crc32(bytes) {
  let checksum = 0xffffffff;
  for (const byte of bytes) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      checksum = (checksum >>> 1) ^ ((checksum & 1) ? 0xedb88320 : 0);
    }
  }
  return (checksum ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length);
  const footer = Buffer.alloc(4);
  footer.writeUInt32BE(crc32(body));
  return Buffer.concat([header, body, footer]);
}

const header = Buffer.alloc(13);
header.writeUInt32BE(width, 0);
header.writeUInt32BE(height, 4);
header[8] = 8;
header[9] = 2;
const output = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(pixels)),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(fileURLToPath(new URL('../Resources/Assets.xcassets/AppIcon.appiconset/AppIcon.png', import.meta.url)), output);
console.log(`Generated opaque ${width}x${height} placeholder app icon.`);
