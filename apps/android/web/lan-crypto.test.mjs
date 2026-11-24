import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto, createHash } from 'node:crypto';
import { installLanCrypto } from './lan-crypto.mjs';

test('LAN UUID uses cryptographic randomness and correct version/variant', () => {
  const crypto = { getRandomValues: bytes => webcrypto.getRandomValues(bytes) };
  installLanCrypto(crypto, () => {});
  const first = crypto.randomUUID();
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(first, crypto.randomUUID());
});

test('LAN digest bridge respects typed-array slice and correlates responses', async () => {
  const crypto = { getRandomValues: bytes => webcrypto.getRandomValues(bytes) };
  let receive;
  receive = installLanCrypto(crypto, packet => {
    const hash = createHash('sha256').update(Buffer.from(packet.base64, 'base64')).digest('base64');
    queueMicrotask(() => receive({ type: 'crypto.result', id: packet.id, base64: hash }));
  });
  const bytes = new TextEncoder().encode('_abc_');
  const digest = await crypto.subtle.digest('SHA-256', bytes.subarray(1, 4));
  assert.equal(Buffer.from(digest).toString('hex'), createHash('sha256').update('abc').digest('hex'));
  await assert.rejects(crypto.subtle.digest('SHA-1', bytes), /Only SHA-256/);
});

test('HTTPS native crypto is left intact', () => {
  const uuid = () => 'native';
  const subtle = {};
  const crypto = { randomUUID: uuid, subtle };
  installLanCrypto(crypto, () => {});
  assert.equal(crypto.randomUUID, uuid);
  assert.equal(crypto.subtle, subtle);
});
