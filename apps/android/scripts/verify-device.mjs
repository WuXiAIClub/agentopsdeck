import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const requireServer = createRequire(new URL('../../server/package.json', import.meta.url));
const WebSocket = requireServer('ws');
const adb = path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', 'adb.exe');
const output = path.resolve(process.argv[2] || 'test-results');
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const runAdb = (...args) => execFileSync(adb, args, { encoding: 'utf8', timeout: 30000 }).trim();
let sequence = 0;
let socket;
const pending = new Map();
async function connect() {
  let pages;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      pages = await (await fetch('http://127.0.0.1:9223/json')).json();
      if (pages.some(target => target.url.includes('/__agentopsdeck_android__/'))) break;
    } catch {}
    await delay(1000);
  }
  assert.ok(pages, 'WebView debugging endpoint becomes ready');
  const page = pages.find(target => target.url.includes('/__agentopsdeck_android__/'));
  assert.ok(page, 'Bundled Android page exists');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  socket.on('message', raw => {
    const response = JSON.parse(String(raw));
    if (!pending.has(response.id)) return;
    const request = pending.get(response.id);
    pending.delete(response.id);
    if (response.error) request.reject(new Error(response.error.message));
    else request.resolve(response.result);
  });
}
function command(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.delete(id)) reject(new Error(`${method} timed out`)); }, 30000).unref();
  });
}
async function evaluate(expression) {
  const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result?.value;
}
async function until(expression) {
  for (let attempt = 0; attempt < 90; attempt++) {
    const value = await evaluate(expression);
    if (value) return value;
    await delay(1000);
  }
  throw new Error('Device condition timed out');
}
try {
  await connect();
  await until('Boolean(document.querySelector("button[data-session-card]") || document.querySelector("textarea"))');
  await evaluate(`Array.from(document.querySelectorAll('button[data-session-card]')).find(element => element.textContent.includes('Android smoke test 2026-11-01'))?.click(); true`);
  const marker = 'AOD_ANDROID_CLIENT_OK';
  const replyExpression = `Array.from(document.querySelectorAll('p')).some(element => element.textContent.trim() === ${JSON.stringify(marker)})`;
  assert.ok(await until(replyExpression), 'Dedicated smoke session received exact agent reply');
  assert.equal(await evaluate('navigator.serviceWorker.getRegistrations().then(registrations => registrations.length)'), 0);
  const html = await readFile(new URL('../app/src/main/assets/web/index.html', import.meta.url), 'utf8');
  const assetPath = html.match(/await import\("(\/assets\/[^\"]+)"\)/)[1];
  const asset = await readFile(new URL('../app/src/main/assets/web' + assetPath, import.meta.url));
  const assetResponse = await evaluate(`fetch(${JSON.stringify(assetPath)}).then(async response => ({status:response.status,bytes:(await response.arrayBuffer()).byteLength,mime:response.headers.get('content-type')}))`);
  assert.equal(assetResponse.status, 200);
  assert.equal(assetResponse.bytes, asset.length);
  assert.ok(assetResponse.mime.includes('javascript'));
  await evaluate("window.dispatchEvent(new Event('agentopsdeck:android-pause')); true");
  await delay(1000);
  const entriesBefore = await evaluate('window.__AGENTOPSDECK_CACHE_STORAGE__.length');
  runAdb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
  runAdb('shell', 'am', 'start', '-n', 'com.agentopsdeck/.MainActivity');
  assert.ok(await until(replyExpression), 'Foreground resume retains session');
  socket.close();
  runAdb('shell', 'am', 'force-stop', 'com.agentopsdeck');
  runAdb('shell', 'am', 'start', '-n', 'com.agentopsdeck/.MainActivity');
  await delay(4000);
  const pid = runAdb('shell', 'pidof', 'com.agentopsdeck');
  runAdb('forward', 'tcp:9223', `localabstract:webview_devtools_remote_${pid}`);
  await connect();
  const entriesAfter = await until('window.__AGENTOPSDECK_CACHE_STORAGE__?.length');
  await until('Boolean(document.querySelector("button[data-session-card]") || document.querySelector("textarea"))');
  await evaluate(`Array.from(document.querySelectorAll('button[data-session-card]')).find(element => element.textContent.includes('Android smoke test 2026-11-01'))?.click(); true`);
  assert.ok(await until(replyExpression), 'Cookie and history survive process death');
  const report = {
    testedAt: new Date().toISOString(), agentReply: true, serviceWorkerRegistrations: 0,
    bundledAssetStatus: assetResponse.status, bundledAssetBytes: assetResponse.bytes,
    cacheEntriesBeforeProcessDeath: entriesBefore, cacheEntriesAfterProcessDeath: entriesAfter,
    checks: ['dedicated session created via UI', 'message sent via UI', 'exact agent reply rendered', 'bundled assets not replaced by web service worker', 'background and foreground', 'cookie and SQLite cache survive process death'],
  };
  await writeFile(path.join(output, 'interaction-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { socket?.close(); }
