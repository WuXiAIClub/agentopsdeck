// Native EventSource mechanism acceptance, not full-app/native-agent acceptance.
// Own loopback listener only; no account, model, credential or business writes.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { transformWithEsbuild } from 'vite';

const sourceFile = new URL('../src/lib/event-stream.ts', import.meta.url);
const source = await readFile(sourceFile, 'utf8');
const sourceSha256 = createHash('sha256').update(source).digest('hex');
const diagnosticsFile = new URL('../src/lib/browser-diagnostics.ts', import.meta.url);
const diagnosticsSource = await readFile(diagnosticsFile, 'utf8');
const diagnosticsSha256 = createHash('sha256').update(diagnosticsSource).digest('hex');
// Run both actual modules in this single-file native EventSource fixture.
const diagnosticImport = "import { browserDiagnostics } from './browser-diagnostics.js';\n";
assert.ok(source.startsWith(diagnosticImport));
const { code } = await transformWithEsbuild(diagnosticsSource + '\n' + source.slice(diagnosticImport.length)
  + '\n(window as any).createRecoveryFixture = createReconnectingEventStream;',
  'event-stream.ts', { loader: 'ts', format: 'iife' });
const require = createRequire(new URL('../../server/package.json', import.meta.url));
const playwright = process.env.AOD_TEST_PLAYWRIGHT
  ?? require.resolve('playwright-core').replace(/index\.js$/, 'index.mjs');
const { chromium } = await import(pathToFileURL(playwright).href);
const records = new Map(), sockets = new Set();
let closedResponses = 0, browser;
const server = createServer((request, response) => {
  if (request.method !== 'GET') { response.writeHead(405).end(); return; }
  const url = new URL(request.url, 'http://127.0.0.1');
  if (url.pathname === '/') {
    response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    response.end('<!doctype html><title>Isolated reconnect fixture</title>'); return;
  }
  if (!['/recover', '/unstable', '/silent'].includes(url.pathname)) { response.writeHead(404).end(); return; }
  const rows = records.get(url.pathname) ?? []; records.set(url.pathname, rows);
  rows.push({ at: performance.now(), cursor: url.searchParams.get('lastEventId') });
  if (url.pathname === '/recover' && rows.length === 1) { response.writeHead(503).end(); return; }
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store, no-transform' });
  response.write(`id: fixture-${rows.length}\ndata: {}\n\n`);
  let timer;
  if (url.pathname === '/unstable' && rows.length <= 3) timer = setTimeout(() => response.end(), 100);
  response.once('close', () => { clearTimeout(timer); closedResponses++; });
});
server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
const deadline = setTimeout(() => {
  for (const socket of sockets) socket.destroy();
  void browser?.close();
}, 110_000);
deadline.unref();
const checks = [], errors = [], denied = [];
try {
  await new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.AOD_TEST_CHROMIUM });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.route('**/*', route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === origin && request.method() === 'GET'
      && ['/', '/favicon.ico', '/recover', '/unstable', '/silent'].includes(url.pathname)) return route.continue();
    denied.push('external-or-unexpected-request'); return route.abort('blockedbyclient');
  });
  const page = await context.newPage();
  page.on('pageerror', () => errors.push('pageerror'));
  await page.goto(origin); await page.addScriptTag({ content: code });
  const start = (path, failUrl = false) => page.evaluate(({ path, failUrl }) => {
    window.fixture?.stop(); window.__agentopsdeckEventStreamDiagnostics.clear();
    window.fixtureMessages = 0; let calls = 0;
    window.fixture = window.createRecoveryFixture({
      url: () => { if (failUrl && calls++ === 0) throw Error('fixture-private-error'); return path; },
      eventTypes: [], onConnection() {}, onOpen() {}, onMessage() { window.fixtureMessages++; },
    });
    window.fixture.start();
  }, { path, failUrl });
  const waitMessages = count => page.waitForFunction(count => window.fixtureMessages >= count, count, { timeout: 75_000 });
  const diagnostics = () => page.evaluate(() => window.__agentopsdeckEventStreamDiagnostics.read());
  const stop = () => page.evaluate(() => window.fixture.stop());

  await start('/recover', true); await waitMessages(1);
  assert.equal(records.get('/recover').length, 2);
  let rows = await diagnostics();
  assert.deepEqual(rows.filter(row => row.retryMs).map(row => [row.reason, row.retryMs]), [['url', 1000], ['error', 2000]]);
  await stop(); checks.push('native-eventsource-url-failure-and-http-503-automatic-recovery');

  await start('/unstable'); await waitMessages(4);
  const attempts = records.get('/unstable'); assert.equal(attempts.length, 4);
  for (let index = 1; index < attempts.length; index++) {
    assert.ok(attempts[index].at - attempts[index - 1].at >= 750 * 2 ** (index - 1), 'Open must not erase exponential backoff');
    assert.equal(attempts[index].cursor, `fixture-${index}`, 'Retry must retain original synthetic cursor');
  }
  assert.deepEqual((await diagnostics()).filter(row => row.retryMs).map(row => row.retryMs), [1000, 2000, 4000]);
  await stop(); checks.push('native-open-drop-loops-retain-bounded-backoff-and-cursor');

  await start('/silent'); await waitMessages(2);
  const silent = records.get('/silent'); assert.equal(silent.length, 2);
  assert.ok(silent[1].at - silent[0].at >= 44_000, 'Do not shorten the production silent deadline for acceptance');
  assert.equal(silent[1].cursor, 'fixture-1');
  rows = await diagnostics(); assert.ok(rows.some(row => row.reason === 'silent' && row.retryMs === 1000));
  await stop(); checks.push('real-monotonic-silent-deadline-recovers-without-user-unlock');
  await page.waitForTimeout(1200);
  assert.equal(records.get('/silent').length, 2, 'Stopped scope must not orphan a retry');
  assert.ok(closedResponses >= 7, 'Stopping/failing scopes must release owned HTTP streams');
  assert.doesNotMatch(JSON.stringify(rows), /fixture-|127\.0\.0\.1|lastEventId|private/);
  assert.deepEqual(errors, []); assert.deepEqual(denied, []);
  assert.equal(createHash('sha256').update(await readFile(sourceFile, 'utf8')).digest('hex'), sourceSha256,
    'Concurrent controller edits invalidate browser acceptance');
  assert.equal(createHash('sha256').update(await readFile(diagnosticsFile, 'utf8')).digest('hex'), diagnosticsSha256);
  console.log(JSON.stringify({ eventStreamRecovery: true, nativeEventSource: true, controllerOnly: true,
    sourceSha256, diagnosticsSha256, checks, denied, errors, closedResponses,
    requests: Object.fromEntries([...records].map(([path, rows]) => [path, rows.length])),
    modelRequests: 0, productBrowserAcceptance: false, windowsAcceptance: false }));
} finally {
  clearTimeout(deadline);
  await browser?.close();
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => server.close(resolve));
}
