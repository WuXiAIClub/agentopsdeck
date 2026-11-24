import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { installRandomUUID } from './crypto-compat.js';

test('HTTP crypto without randomUUID gains secure RFC 4122 version 4 UUIDs', () => {
  const crypto = { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) } as Crypto;
  installRandomUUID(crypto);
  const values = new Set(Array.from({ length: 1000 }, () => crypto.randomUUID()));
  assert.equal(values.size, 1000);
  for (const value of values) assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('fallback preserves random bytes except UUID version and variant bits', () => {
  for (const fill of [0, 255]) {
    let calls = 0;
    const crypto = { getRandomValues(bytes: Uint8Array) { calls++; assert.equal(bytes.length, 16); return bytes.fill(fill); } } as Crypto;
    installRandomUUID(crypto);
    assert.equal(crypto.randomUUID(), fill === 0 ? '00000000-0000-4000-8000-000000000000' : 'ffffffff-ffff-4fff-bfff-ffffffffffff');
    assert.equal(calls, 1);
  }
});

test('native randomUUID remains unchanged and installation is idempotent', () => {
  const crypto = { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) } as Crypto;
  installRandomUUID(crypto);
  const uuid = crypto.randomUUID;
  installRandomUUID(crypto);
  assert.equal(crypto.randomUUID, uuid);
  const native = globalThis.crypto.randomUUID;
  installRandomUUID(globalThis.crypto);
  assert.equal(globalThis.crypto.randomUUID, native);
});

test('entropy failures propagate instead of creating insecure IDs', () => {
  const crypto = { getRandomValues() { throw new Error('Entropy unavailable'); } } as unknown as Crypto;
  installRandomUUID(crypto);
  assert.throws(() => crypto.randomUUID(), /Entropy unavailable/);
});

test('compatibility installs before application dependencies execute', () => {
  const main = readFileSync(new URL('src/main.tsx', `file://${process.cwd()}/`), 'utf8');
  assert.ok(main.startsWith("import './lib/crypto-compat';"));
});
