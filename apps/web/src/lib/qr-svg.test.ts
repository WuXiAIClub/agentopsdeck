import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeQrMatrix, buildQrSvgPath } from './qr-svg.js';

test('encodeQrMatrix and buildQrSvgPath produce deterministic valid QR matrices across URL lengths', () => {
  const shortMatrix = encodeQrMatrix('https://agentopsdeck.local/?remoteDevice=dev-1');
  assert.ok(shortMatrix);
  assert.ok(shortMatrix.length >= 21 && shortMatrix.length <= 57);
  assert.equal(shortMatrix[0]?.length, shortMatrix.length);
  // Finder pattern corners (0,0), (0,6), (6,0) must be dark (true)
  assert.equal(shortMatrix[0]?.[0], true);
  assert.equal(shortMatrix[0]?.[6], true);
  assert.equal(shortMatrix[6]?.[0], true);

  const medMatrix = encodeQrMatrix('https://deck.example.invalid/?remoteDevice=device_1234567890abcdef');
  assert.ok(medMatrix);
  const svg = buildQrSvgPath(medMatrix);
  assert.equal(svg.size, medMatrix.length + 4);
  assert.match(svg.path, /^M\d+,\d+h1v1h-1z/);

  // Oversized payload beyond Version 10 capacity clamps gracefully to Version 10 (57x57)
  const clampedMatrix = encodeQrMatrix('x'.repeat(300));
  assert.equal(clampedMatrix.length, 57);
});
