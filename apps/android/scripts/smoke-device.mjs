import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const requireServer = createRequire(new URL('../../server/package.json', import.meta.url));
const WebSocket = requireServer('ws');
const endpoint = process.env.AOD_CDP_URL || 'http://127.0.0.1:9223';
const output = path.resolve(process.argv[2] || 'test-results');
await mkdir(output, { recursive: true });
const pages = await (await fetch(endpoint + '/json')).json();
const target = pages.find(page => page.url.includes('/__agentopsdeck_android__/'));
assert.ok(target, 'Android WebView debugging target must be available');
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
let sequence = 0;
const pending = new Map();
const network = [];
const errors = [];
socket.on('message', raw => {
  const message = JSON.parse(String(raw));
  if (message.id) {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  }
  if (message.method === 'Network.requestWillBeSent') {
    const url = new URL(message.params.request.url);
    network.push({ path: url.pathname, method: message.params.request.method, at: Date.now() });
  }
  if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
});
function command(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.delete(id)) reject(new Error(`${method} timed out`)); }, 45000).unref();
  });
}
async function evaluate(expression) {
  const response = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
  return response.result?.value;
}
async function until(expression, timeout = 90000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await evaluate(expression);
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 750));
  }
  throw new Error('UI condition timed out');
}
async function screenshot(name) {
  const shot = await command('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(output, name), Buffer.from(shot.data, 'base64'));
}
try {
  await command('Runtime.enable');
  await command('Network.enable');
  await command('Page.enable');
  assert.equal(await until('Boolean(window.__AGENTOPSDECK_CACHE_STORAGE__)'), true);
  assert.ok(await until('document.querySelector("#root")?.childElementCount > 0'));
  const key = process.env.AOD_ACCESS_KEY || process.env.AOD_ACCESS_KEY;
  assert.ok(key, 'Use the authorized local environment access key, never hardcode it');
  const auth = await evaluate(`fetch('/api/auth/login', {method:'POST',credentials:'include',headers:{'content-type':'application/json'},body:JSON.stringify({accessKey:${JSON.stringify(key)}})}).then(async response=>({status:response.status,ok:response.ok}))`);
  assert.equal(auth.status, 200);
  await command('Page.reload');
  await until('Boolean(document.querySelector("[data-session-card]") || document.querySelector("textarea"))');
  await evaluate(`document.querySelector('button[aria-label="\\u8fd4\\u56de\\u4f1a\\u8bdd"]')?.click(); true`);
  const count = await until('document.querySelectorAll("button[data-session-card]").length');
  await screenshot('sessions.png');
  await evaluate('document.querySelector("button[data-session-card]").click(); true');
  await until('Boolean(document.querySelector("[data-session-pane]") || document.querySelector("textarea"))');
  await until('Array.from({length:window.__AGENTOPSDECK_CACHE_STORAGE__.length},(_,index)=>window.__AGENTOPSDECK_CACHE_STORAGE__.key(index)).some(key=>key.includes(".messages."))');
  const cached = await evaluate('Array.from({length:window.__AGENTOPSDECK_CACHE_STORAGE__.length},(_,index)=>window.__AGENTOPSDECK_CACHE_STORAGE__.key(index)).filter(key=>key.startsWith("agentopsdeck.cache.")).length');
  await screenshot('session.png');
  await evaluate("window.dispatchEvent(new Event('agentopsdeck:android-pause'))");
  await new Promise(resolve => setTimeout(resolve, 500));
  await command('Page.reload');
  assert.ok(await until('window.__AGENTOPSDECK_CACHE_STORAGE__?.length > 0'));
  await until('Boolean(document.querySelector("[data-session-pane]") || document.querySelector("[data-session-card]"))');
  const restored = await evaluate('window.__AGENTOPSDECK_CACHE_STORAGE__.length');
  const report = {
    testedAt: new Date().toISOString(), authStatus: auth.status,
    visibleSessions: count, cacheEntriesBeforeReload: cached, cacheEntriesAfterReload: restored,
    runtimeErrors: errors,
    apiRequests: network.filter(request => request.path.startsWith('/api/')).length,
    bundledAssetRequests: network.filter(request => request.path.startsWith('/assets/')).length,
    checks: ['bundled frontend boot', 'native cache hydration', 'existing access-key login', 'session list render', 'open existing session', 'native cache persists across reload'],
  };
  await writeFile(path.join(output, 'smoke-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  assert.deepEqual(errors, [], 'No uncaught JavaScript exceptions');
} finally {
  socket.close();
}
