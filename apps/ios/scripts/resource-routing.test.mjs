import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const code = readFileSync(new URL('../Resources/ResourceRouting.js', import.meta.url), 'utf8');
const context = vm.createContext({ URL });
vm.runInContext(code, context);
const { createRouter } = context.AgentOpsDeckResources;
const publicOrigin = 'https://agentopsdeck.example';
const local = 'http://10.0.0.8:8790';
const otherLocal = 'http://agentopsdeck.local:8790';
const route = createRouter(local, publicOrigin, [local, otherLocal]);

test('known media and downloads follow the active route, retaining query and fragment', () => {
  const paths = ['/api/media/inbound/video.mp4', '/api/artifacts/a0B1',
    '/api/files/gateway/download', '/api/files/agents/agent-1/download',
    `/api/hub/v1/sessions/session-1/messages/message-1/media/${'a'.repeat(64)}`,
    `/api/hub/v1/shared/share-1/sessions/session-1/messages/message-1/media/${'b'.repeat(64)}`];
  for (const path of paths) {
    assert.equal(route(`${publicOrigin}${path}?name=clip.mp4#t=3`), `${local}${path}?name=clip.mp4#t=3`);
    assert.equal(route(otherLocal + path), local + path);
  }
});

test('public fallback reverses the mapping without changing unrelated URLs', () => {
  const fallback = createRouter(publicOrigin, publicOrigin, [local]);
  assert.equal(fallback(`${local}/api/media/inbound/clip.mp4`), `${publicOrigin}/api/media/inbound/clip.mp4`);
  for (const value of ['https://cdn.example/api/media/inbound/clip.mp4', '/api/media/inbound/clip.mp4',
    `${publicOrigin}/api/sessions`, 'blob:https://agentopsdeck.example/id', null]) {
    assert.equal(route(value), value);
  }
});

test('origin and traversal boundaries reject unsafe inputs', () => {
  for (const value of [
    `${publicOrigin}.evil.test/api/media/inbound/clip.mp4`,
    'https://user:password@agentopsdeck.example/api/media/inbound/clip.mp4',
    `${publicOrigin}/api/../api/media/inbound/clip.mp4`,
    `${publicOrigin}/api/media/inbound/%2e%2e`,
    `${publicOrigin}/api/media/inbound/a%2fb`,
    `${publicOrigin}/api/media/inbound/a%5cb`,
    `${publicOrigin}/api/media/inbound/clip.mp4/extra`,
    'http://10.0.0.99:8790/api/media/inbound/clip.mp4'
  ]) assert.equal(route(value), value);
  const unknown = createRouter('http://10.0.0.99:8790', publicOrigin, [local]);
  assert.equal(unknown(`${publicOrigin}/api/media/inbound/clip.mp4`), `${publicOrigin}/api/media/inbound/clip.mp4`);
});

test('installer does not run on an untrusted origin or inside a child frame', () => {
  for (const [origin, topLevel] of [[publicOrigin, true], [local, false]]) {
    const window = {};
    window.top = topLevel ? window : {};
    const sandbox = vm.createContext({ URL, location: { origin }, window });
    vm.runInContext(code, sandbox);
    sandbox.AgentOpsDeckResources.install({ currentOrigin: local, publicOrigin, localOrigins: [local] });
    assert.equal(window.__AGENTOPSDECK_RESOURCE_URL__, undefined);
  }
});

test('installer rewrites media setters, attributes and safe fetches before dispatch', async () => {
  class Element {
    constructor(tagName) { this.tagName = tagName; this.nodeType = 1; this.values = {}; }
    setAttribute(name, value) { this.values[name] = value; }
    getAttribute(name) { return this.values[name] ?? null; }
    matches() { return true; }
    querySelectorAll() { return []; }
  }
  class HTMLAnchorElement extends Element {}
  class HTMLImageElement extends Element {}
  class HTMLMediaElement extends Element {}
  class HTMLSourceElement extends Element {}
  class HTMLVideoElement extends HTMLMediaElement {}
  for (const [type, attribute] of [[HTMLAnchorElement, 'href'], [HTMLImageElement, 'src'],
    [HTMLMediaElement, 'src'], [HTMLSourceElement, 'src'], [HTMLVideoElement, 'poster']]) {
    Object.defineProperty(type.prototype, attribute, { configurable: true,
      get() { return this.getAttribute(attribute); }, set(value) { this.setAttribute(attribute, value); } });
  }
  const calls = [];
  const observers = [];
  const document = { addEventListener() {} };
  const window = { fetch(input, options) { calls.push([input, options]); return Promise.resolve(); } };
  window.top = window;
  const sandbox = vm.createContext({ URL, Element, HTMLAnchorElement, HTMLImageElement, HTMLMediaElement,
    HTMLSourceElement, HTMLVideoElement, document, window, location: { origin: local },
    MutationObserver: class { constructor(callback) { observers.push(callback); } observe() {} } });
  vm.runInContext(code, sandbox);
  sandbox.AgentOpsDeckResources.install({ currentOrigin: local, publicOrigin, localOrigins: [local] });
  const original = `${publicOrigin}/api/media/inbound/clip.mp4`;
  const expected = `${local}/api/media/inbound/clip.mp4`;
  const video = new HTMLVideoElement('VIDEO');
  video.src = original;
  assert.equal(video.src, expected);
  video.setAttribute('poster', original);
  assert.equal(video.getAttribute('poster'), expected);
  const anchor = new HTMLAnchorElement('A');
  anchor.values.href = original;
  observers[0]([{ type: 'childList', addedNodes: [anchor] }]);
  assert.equal(anchor.getAttribute('href'), expected);
  await window.fetch(original);
  assert.equal(calls.at(-1)[0], expected);
  await window.fetch(original, { method: 'POST' });
  assert.equal(calls.at(-1)[0], original);
  await window.fetch(original, { headers: { Authorization: 'test-only' } });
  assert.equal(calls.at(-1)[0], original);
  const request = { url: original };
  await window.fetch(request);
  assert.equal(calls.at(-1)[0], request);
});
