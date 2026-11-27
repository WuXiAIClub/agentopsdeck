import test from 'node:test';
import assert from 'node:assert/strict';
import { createResourceRouter, installResourceRouting } from './resource-routing.mjs';

const publicOrigin = 'https://deck.example.invalid';
const lanOrigins = ['http://192.0.2.24:8790', 'http://192.0.2.82:8790'];
const lan = lanOrigins[1];
const route = createResourceRouter(lan, publicOrigin, lanOrigins);

test('public resources use selected LAN, preserving filename, query and fragment', () => {
  for (const path of ['/api/media/inbound/demo.mp4', '/api/artifacts/abc123',
    '/api/files/gateway/download?path=C%3A%5Cvideo.mp4&name=a%20b#preview',
    '/api/files/agents/agent-1/download?path=test.zip',
    `/api/hub/v1/sessions/session-1/messages/message-1/media/${'a'.repeat(64)}`,
    `/api/hub/v1/shared/share-1/sessions/session-1/messages/message-1/media/${'b'.repeat(64)}`]) {
    assert.equal(route(publicOrigin + path), lan + path);
  }
});

test('old LAN resources follow selected LAN or public route', () => {
  const path = '/api/media/inbound/example.png';
  assert.equal(route(lanOrigins[0] + path), lan + path);
  assert.equal(createResourceRouter(publicOrigin, publicOrigin, lanOrigins)(lan + path), publicOrigin + path);
});

test('untrusted sites, credentials, non-resource endpoints and relative URLs stay unchanged', () => {
  for (const value of ['https://other.example/api/media/inbound/test.mp4',
    'https://deck.example.invalid.evil.test/api/artifacts/abc', 'https://user@deck.example.invalid/api/artifacts/abc',
    'http://deck.example.invalid/api/artifacts/abc', 'https://deck.example.invalid:444/api/artifacts/abc',
    publicOrigin + '/api/auth/login', publicOrigin + '/api/media/publish', publicOrigin + '/',
    publicOrigin + '/api/files/gateway/upload', '/api/media/inbound/test.mp4', 'blob:abc', 'javascript:alert(1)', null]) {
    assert.equal(route(value), value);
  }
});

test('path traversal, backslashes and encoded path separators are not rewritten', () => {
  for (const path of ['/api/files/agents/../download', '/api/files/agents/%2e%2e/download',
    '/api/files/agents/a%2fb/download', '/api/files/agents/a%5cb/download', '/api/media/inbound/../file.mp4',
    '/api/media/inbound\\test.mp4']) assert.equal(route(publicOrigin + path), publicOrigin + path);
});

test('configured public origin and trusted destination are enforced', () => {
  const custom = 'https://custom.example';
  const path = '/api/artifacts/abc';
  assert.equal(createResourceRouter(lan, custom, lanOrigins)(custom + path), lan + path);
  assert.equal(createResourceRouter(lan, custom, lanOrigins)(publicOrigin + path), publicOrigin + path);
  assert.equal(createResourceRouter('http://192.0.2.99:8790', custom, lanOrigins)(custom + path), custom + path);
});

test('a user-selected private LAN origin is trusted exactly, not its subnet', () => {
  const selected = 'http://10.1.2.3:8890';
  const other = 'http://10.1.2.4:8890';
  const path = '/api/artifacts/abc123';
  const configured = createResourceRouter(selected, publicOrigin, [selected]);
  assert.equal(configured(publicOrigin + path), selected + path);
  assert.equal(configured(other + path), other + path);
  assert.equal(configured('http://10.1.2.3:8891' + path), 'http://10.1.2.3:8891' + path);
  assert.equal(createResourceRouter(other, publicOrigin, [selected])(publicOrigin + path), publicOrigin + path);
});

test('DOM adapter rewrites added resources and click targets without touching unrelated links', () => {
  let observe;
  let click;
  const attributes = new Map([['href', publicOrigin + '/api/media/inbound/demo.mp4']]);
  const anchor = {
    nodeType: 1, tagName: 'A', matches: () => true, querySelectorAll: () => [],
    getAttribute: name => attributes.get(name) ?? null,
    setAttribute: (name, value) => attributes.set(name, value),
  };
  const window = {
    location: { origin: lan },
    MutationObserver: class {
      constructor(callback) { observe = callback; }
      observe() {}
    },
  };
  const document = {
    documentElement: { nodeType: 1, matches: () => false, querySelectorAll: () => [] },
    addEventListener: (name, callback) => { if (name === 'click') click = callback; },
  };
  installResourceRouting(window, document, publicOrigin, lanOrigins);
  observe([{ type: 'childList', addedNodes: [anchor] }]);
  assert.equal(attributes.get('href'), lan + '/api/media/inbound/demo.mp4');
  attributes.set('href', publicOrigin + '/api/artifacts/abc');
  click({ target: { closest: () => anchor } });
  assert.equal(attributes.get('href'), lan + '/api/artifacts/abc');
  attributes.set('href', 'https://other.example/api/artifacts/abc');
  observe([{ type: 'attributes', target: anchor }]);
  assert.equal(attributes.get('href'), 'https://other.example/api/artifacts/abc');
});
