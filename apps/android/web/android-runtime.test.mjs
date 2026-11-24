import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = (await readFile(new URL('./android-runtime.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '');

async function fixture() {
  const window = new EventTarget(), document = new EventTarget(), sent = [], timers = new Map();
  let now = 0, sequence = 0, flushed = 0;
  document.hidden = false; document.visibilityState = 'visible';
  window.localStorage = { getItem: () => 'zh-CN' };
  window.AgentOpsDeckNative = { postMessage: value => sent.push(JSON.parse(value)) };
  window.fetch = async () => ({ status: 304, ok: false });
  class Anchor { click() {} }
  await vm.runInNewContext(`(async () => { ${source}\n })()`, {
    window, document, navigator: {}, location: { protocol: 'https:', origin: 'https://test.example', href: 'https://test.example/' },
    performance: { now: () => now }, URL, Event, DOMException, HTMLAnchorElement: Anchor,
    publicOrigin: 'https://test.example', lanOrigins: [],
    createCacheStorage: () => ({ metrics: { reads: 0 }, receive() {}, flush() { flushed++; } }),
    installResourceRouting() {}, installVoiceRecording: () => () => {}, installLanCrypto: () => () => {},
    setTimeout: callback => { timers.set(++sequence, callback); return sequence; }, clearTimeout: id => timers.delete(id),
  });
  return { window, document, sent, timers, tick: value => { now = value; }, get flushed() { return flushed; },
    runTimers() { for (const [id, callback] of [...timers]) { timers.delete(id); callback(); } } };
}

test('startup does not request or await a native full-cache snapshot', async () => {
  const { window, sent, tick } = await fixture();
  assert.ok(window.__AGENTOPSDECK_CACHE_STORAGE__);
  assert.equal(sent.length, 0);
  tick(125); window.__AGENTOPSDECK_ANDROID_READY__();
  assert.equal(sent[0].type, 'client.ready');
  assert.equal(sent[1].metrics.moduleReadyMs, 125);
});

test('resume refresh is coalesced with real focus and suppressed in background', async () => {
  const state = await fixture();
  let focused = 0;
  state.window.addEventListener('focus', () => focused++);
  state.tick(1000); state.window.dispatchEvent(new Event('focus'));
  state.window.dispatchEvent(new Event('agentopsdeck:android-resume')); state.tick(1200); state.runTimers();
  assert.equal(focused, 1);
  state.tick(3000); state.window.dispatchEvent(new Event('agentopsdeck:android-resume')); state.runTimers();
  assert.equal(focused, 2);
  state.document.hidden = true; state.tick(5000);
  state.window.dispatchEvent(new Event('agentopsdeck:android-resume')); state.runTimers();
  assert.equal(focused, 2);
  state.window.dispatchEvent(new Event('agentopsdeck:android-pause'));
  assert.equal(state.flushed, 1);
});

test('metrics count same-origin API reads and 304 without recording URLs', async () => {
  const { window, sent } = await fixture();
  await window.fetch('/api/example'); await window.fetch('https://outside.example/api/example');
  await window.fetch('/api/example', { method: 'POST' });
  window.dispatchEvent(new Event('agentopsdeck:android-metrics'));
  assert.equal(sent.at(-1).metrics.apiReads, 1);
  assert.equal(sent.at(-1).metrics.notModified, 1);
  assert.equal(sent.at(-1).metrics.failures, 0);
  assert.equal(JSON.stringify(sent).includes('/api/example'), false);
});
