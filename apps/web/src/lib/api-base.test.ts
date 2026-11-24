import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveApiBaseUrl } from './api-base.js';

for (const hostname of ['localhost', '127.0.0.1', '[::1]', '10.0.0.2', '192.168.1.2', '172.16.0.2', 'deck.example.com']) {
  test(`${hostname} defaults to same-origin without guessing another instance port`, () => {
    assert.equal(resolveApiBaseUrl({ hostname, protocol: 'http:' }), '');
    assert.equal(resolveApiBaseUrl({ hostname, protocol: 'https:' }), '');
  });
}

test('explicit local split-backend override remains supported', () => {
  const location = { hostname: '127.0.0.1', protocol: 'http:' };
  assert.equal(resolveApiBaseUrl(location, ' http://127.0.0.1:8792 ', 'http://127.0.0.1:8793'), 'http://127.0.0.1:8792');
  assert.equal(resolveApiBaseUrl(location, ' ', ' http://127.0.0.1:8793 '), 'http://127.0.0.1:8793');
  assert.equal(resolveApiBaseUrl(location, ' ', {}), '');
});

test('public HTTPS preserves same-origin despite overrides', () => {
  assert.equal(resolveApiBaseUrl({ hostname: 'deck.example.com', protocol: 'https:' }, 'http://127.0.0.1:8790', 'http://localhost:8790'), '');
});

test('explicit HTTPS split origins are honored, including deployment fallback', () => {
  const location = { hostname: 'deck.example.com', protocol: 'https:' };
  assert.equal(resolveApiBaseUrl(location, ' https://api.example.com/ '), 'https://api.example.com');
  assert.equal(resolveApiBaseUrl(location, 'http://localhost:8790', 'https://api.example.com'), 'https://api.example.com');
  for (const invalid of ['javascript:alert(1)', 'https://user:secret@api.example.com', 'https://api.example.com/?secret=x', 'invalid']) {
    assert.equal(resolveApiBaseUrl(location, invalid), '');
  }
});
