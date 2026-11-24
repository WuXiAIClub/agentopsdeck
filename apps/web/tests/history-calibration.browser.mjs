// Exercise the real browser API/cache/transport against an isolated fake Hub.
// No production credentials, Agent calls, or user messages.
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';

const { chromium } = await import(process.env.AOD_TEST_PLAYWRIGHT
  ? pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href : 'playwright');
const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, envFile: false,
  logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const keys = Array.from({ length: 16 }, (_, n) => `local:${btoa(`codex:calibration-${n}`)}`);
  const versions = new Map(keys.map(key => [key, 1]));
  const requests = [], errors = [];
  let mode = 'normal', held, notifyHeld, pendingOnce = false;
  const etag = key => `W/"history-${versions.get(key).toString(16).padStart(64, '0')}"`;
  const history = key => ({ messages: [{ id: key, sessionKey: key, role: 'assistant',
    text: `${key} revision ${versions.get(key)} ${'fixture '.repeat(4096)}`, createdAt: 1 }],
    revision: `${key}:${versions.get(key)}`, updatedAt: versions.get(key), totalCount: 900, hiddenCount: 899 });
  const metadata = key => ({ etag: etag(key), 'x-agentopsdeck-history-meta': JSON.stringify({ updatedAt: versions.get(key), sourceCursor: null }) });
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    assert.equal(url.origin, origin, 'fixture must not contact another host');
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Calibration fixture</title>' });
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const record = { path: url.pathname, method: req.method(), bytes: 0 }; requests.push(record);
    if (url.pathname.endsWith('/workspace/check') || url.pathname.endsWith('/workspace/sync')) {
      assert.equal(req.method(), 'POST');
      if (mode === 'unsupported') return route.fulfill({ status: 404, json: {} });
      const { items } = req.postDataJSON(); assert.ok(items.length <= 8); record.items = items.length;
      if (mode === 'held') { notifyHeld?.(); await new Promise(resolve => { held = resolve; }); }
      const frames = items.map(item => {
        if (mode === 'failure' && item.sessionKey === keys[0]) return { sessionKey: item.sessionKey, status: 503, body: { error: 'Fixture unavailable' } };
        if (mode === 'preparing' && item.sessionKey === keys[0] && !pendingOnce) {
          pendingOnce = true; return { sessionKey: item.sessionKey, status: 202, body: { code: 'history_preparing', retryAfterMs: 250 } };
        }
        const unchanged = item.etag === etag(item.sessionKey), check = url.pathname.endsWith('/check');
        return { sessionKey: item.sessionKey, status: unchanged ? 304 : 200,
          headers: { ...metadata(item.sessionKey), ...(!unchanged && check ? { 'x-agentopsdeck-history-check': 'changed' } : {}) },
          ...(!unchanged ? { body: check ? { changed: true } : history(item.sessionKey) } : {}) };
      });
      const body = frames.map(frame => JSON.stringify(frame)).join('\n') + '\n'; record.bytes = Buffer.byteLength(body);
      return route.fulfill({ body, headers: { 'content-type': 'application/x-ndjson', 'x-agentopsdeck-workspace-sync': '1' } });
    }
    const match = /\/sessions\/([^/]+)\/messages$/.exec(url.pathname);
    assert.ok(match, `Unexpected API ${url.pathname}`); assert.equal(req.method(), 'GET');
    const key = decodeURIComponent(match[1]); assert.ok(versions.has(key));
    if (req.headers()['if-none-match'] === etag(key)) return route.fulfill({ status: 304, headers: metadata(key) });
    const body = JSON.stringify(history(key)); record.bytes = Buffer.byteLength(body);
    return route.fulfill({ body, headers: { 'content-type': 'application/json', ...metadata(key) } });
  });
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin);
  await page.evaluate(async () => {
    localStorage.setItem('agentopsdeck.apiBaseUrl', location.origin);
    window.fixtureApi = await import('/src/api.ts');
    window.fixturePreference = await import('/src/lib/workspace-sync-preference.ts');
    window.fixtureApi.setRecoveryScope('a'.repeat(64));
  });
  const read = (selected, calibration = false) => page.evaluate(async ({ selected, calibration }) =>
    Promise.allSettled(selected.map(key => window.fixtureApi.api.sessionMessages(key, 200, undefined, undefined, calibration)))
      .then(results => results.map(result => result.status === 'fulfilled'
        ? { status: result.status, revision: result.value.revision, count: result.value.totalCount, text: result.value.messages[0]?.text.slice(0, 100) }
        : { status: result.status, error: result.reason.message })), { selected, calibration });
  const mark = () => requests.length;
  const summary = since => ({ requests: requests.length - since, bytes: requests.slice(since).reduce((n, r) => n + r.bytes, 0),
    batches: requests.slice(since).filter(r => r.path.endsWith('/check')).length,
    reads: requests.slice(since).filter(r => r.method === 'GET').length });
  assert.ok((await read(keys)).every(result => result.status === 'fulfilled' && result.count === 900));
  const warm = summary(0); assert.equal(warm.reads, 16);
  let since = mark();
  assert.ok((await read(keys.slice(0, 6), true)).every(result => result.status === 'fulfilled'));
  const six = summary(since); assert.equal(six.batches, 1); assert.equal(six.reads, 0); assert.ok(six.bytes < 4096);
  since = mark(); await read(keys, true);
  const sixteen = summary(since); assert.equal(sixteen.batches, 2); assert.equal(sixteen.reads, 0); assert.ok(sixteen.bytes < 8192);
  versions.set(keys[3], 2); since = mark();
  const changed = await read(keys.slice(0, 6), true);
  assert.equal(changed[3].revision, `${keys[3]}:2`); assert.equal(summary(since).reads, 1);
  mode = 'failure';
  const failed = await read(keys.slice(0, 6), true);
  assert.equal(failed[0].status, 'rejected'); assert.match(failed[0].error, /unavailable/i);
  assert.ok(failed.slice(1).every(result => result.status === 'fulfilled'));
  mode = 'normal'; await read([keys[0]]); // Warm the invalidated entry honestly.
  mode = 'preparing'; assert.ok((await read(keys.slice(0, 6), true)).every(result => result.status === 'fulfilled'));
  mode = 'normal';
  await page.evaluate(() => window.fixturePreference.setWorkspaceSyncEnabled(true));
  await read(keys.slice(0, 6)); // Changing transport deliberately invalidates validators.
  since = mark(); await read(keys.slice(0, 6), true);
  assert.equal(summary(since).batches, 1); assert.equal(summary(since).reads, 0);
  assert.equal(await page.evaluate(() => window.fixturePreference.workspaceSyncPreference().enabled), true);
  // An in-flight response must never populate another account's caches.
  mode = 'held'; const arrived = new Promise(resolve => { notifyHeld = resolve; });
  const revoked = read(keys.slice(0, 6), true); await arrived;
  await page.evaluate(() => window.fixtureApi.setRecoveryScope('b'.repeat(64)));
  mode = 'normal'; held();
  assert.ok((await revoked).every(result => result.status === 'rejected'));
  since = mark(); await read(keys.slice(0, 6), true); assert.equal(summary(since).reads, 6);
  // Old Hubs fall back once, preserving the user's separate Preview preference.
  mode = 'unsupported'; since = mark(); await read(keys.slice(0, 6), true);
  assert.equal(summary(since).batches, 1); assert.equal(summary(since).reads, 6);
  versions.set(keys[2], 3); since = mark();
  const legacy = await read(keys.slice(0, 6), true);
  assert.equal(summary(since).batches, 0); assert.equal(summary(since).reads, 6); assert.equal(legacy[2].revision, `${keys[2]}:3`);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'passed', warm, sixUnchanged: six, sixteenUnchanged: sixteen,
    scenarios: ['changed-only-fetch', 'per-item-503', '202-preparation', 'preview-independent', 'scope-revocation', 'legacy-fallback'] }));
  await context.close();
} finally { await browser?.close(); await server.close(); }
