// Actual production React app, isolated API fault injection. No live endpoints,
// business sends, native execution or production state are involved.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { build, preview } from 'vite';

const { chromium } = await import(pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href);
const root = fileURLToPath(new URL('..', import.meta.url));
const output = await mkdtemp(join(tmpdir(), 'agentopsdeck-session-isolation-'));
const scope = 'a'.repeat(64), cursor = seq => `ce1_00000000-0000-4000-8000-000000000001:${seq}`;
const sessions = ['a', 'b'].map(id => ({ sessionKey: `remote-${id}:fixture`, envConnectionId: `remote-${id}`,
  title: `Isolated session ${id}`, source: 'codex', agentId: 'codex', status: 'idle', lastActiveAt: 1 }));
const layout = { id: 'current', name: 'Current', collapsedKeys: [], workspace: { version: 2,
  panes: sessions.map((s, i) => ({ id: `chat-${i}`, sessionKey: s.sessionKey })), floating: [], active: 'chat-0',
  dock: { kind: 'split', axis: 'horizontal', ratio: .5, first: { kind: 'pane', id: 'chat-0' }, second: { kind: 'pane', id: 'chat-1' } } } };
let browser, server;
try {
  await build({ root, configFile: join(root, 'vite.config.ts'), logLevel: 'error', build: { outDir: output, emptyOutDir: true } });
  server = await preview({ root: output, configFile: false, envFile: false, logLevel: 'error', build: { outDir: output },
    preview: { host: '127.0.0.1', port: 0 } });
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.AOD_TEST_CHROMIUM });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: 'block' });
  const page = await context.newPage(), errors = [], forbidden = [], layouts = new Map();
  let failure = false, denied = false, metadataFailure = false, directoryFailure = false, cachedMode = false;
  let sequence = 1, directoryReads = 0, historyFailures = 0, metadataFailures = 0;
  page.on('pageerror', error => errors.push(error.message));
  await context.addInitScript(({ scope, layout }) => {
    localStorage.setItem('agentopsdeck.locale', 'en');
    localStorage.setItem(`agentopsdeck.current-layout.v2:${scope}`, JSON.stringify(layout));
  }, { scope, layout });
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url()), path = url.pathname;
    const json = body => route.fulfill({ json: body });
    if (url.origin !== origin) { forbidden.push(req.url()); return route.abort(); }
    if (!path.startsWith('/api/')) return route.continue();
    if (path.endsWith('/completions/summary') && req.method() === 'POST') return json({ items: [] });
    if (/\/workspace\/layouts\/(current|saved)$/.test(path)) {
      const previous = layouts.get(path) ?? { revision: 0, content: null };
      if (req.method() === 'PUT') layouts.set(path, { revision: previous.revision + 1, content: req.postDataJSON().content });
      else if (req.method() !== 'GET') { forbidden.push(req.method() + path); return route.abort(); }
      return json(layouts.get(path) ?? previous);
    }
    if (req.method() !== 'GET') { forbidden.push(req.method() + path); return route.abort(); }
    if (path === '/api/auth/status') return json({ authenticated: true, recoveryScope: scope, passkeys: { available: false, count: 0 } });
    if (path.endsWith('/sessions/state')) {
      directoryReads++;
      if (directoryFailure) return route.fulfill({ status: 503, json: { error: 'Temporary directory unavailable' } });
      return json({ revision: `directory-${sequence}-${failure}-${denied}`, viewKey: 'default', updatedAt: Date.now(),
        groups: [{ agentId: 'codex', sessions: sessions.filter(s => s.envConnectionId !== 'remote-a' || !failure && !denied) }],
        sourceStates: ['a', 'b'].map(id => ({ connectionId: `remote-${id}`, authority: 1,
          state: id === 'a' && denied ? 'denied' : id === 'a' && failure ? 'unavailable' : 'ready',
          ...(id === 'a' && (failure || denied) ? {} : { cursor: cursor(sequence) }), hiddenCount: 0, archivedCount: 0, pinnedCount: 0 })) });
    }
    if (path.endsWith('/messages')) {
      const key = decodeURIComponent(path.split('/').at(-2));
      if (key === sessions[0].sessionKey && failure) { historyFailures++; return route.fulfill({ status: 503, json: { error: 'Temporary upstream unavailable' } }); }
      return json({ messages: [{ id: `message-${sequence}`, sessionKey: key, role: 'assistant', createdAt: sequence,
        text: `${key} reply ${sequence}`, status: 'sent' }], totalCount: 1, hiddenCount: 0,
        ...(cachedMode ? { historyStatus: 'cached' } : { sourceCursor: cursor(sequence) }),
        revision: `${cachedMode ? 'cached:' : ''}history-${sequence}`, updatedAt: Date.now() });
    }
    if (path.endsWith('/queue') || path.endsWith('/notebooks')) return json({ items: [], nextCursor: null });
    if (path === '/api/agents' || path === '/api/gateway/status') {
      if (metadataFailure) { metadataFailures++; return route.fulfill({ status: 503, json: { error: 'Temporary metadata unavailable' } }); }
      return json(path === '/api/agents' ? { agents: [{ id: 'codex', name: 'Codex' }] } : { connected: true });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  // Keep the selected route stable: an empty-route hashchange intentionally
  // closes chat panes and is not a history-return/revalidation scenario.
  await page.goto(`${origin}/#/session/${encodeURIComponent(sessions[0].sessionKey)}`);
  for (const s of sessions) {
    await page.locator(`[data-session-card="${s.sessionKey}"]`).waitFor();
    await page.getByText(`${s.sessionKey} reply 1`, { exact: true }).waitFor();
    await page.locator(`[data-session-pane="${s.sessionKey}"]`).waitFor();
  }
  const refreshDirectory = async (status = 200) => {
    const before = directoryReads;
    // Correlate with a request started by this refresh. An already in-flight
    // response after reload must not satisfy a new-refresh assertion.
    const requested = page.waitForRequest(r => r.url().endsWith('/sessions/state'));
    await page.evaluate(() => window.dispatchEvent(new HashChangeEvent('hashchange')));
    const response = await (await requested).response();
    assert.equal(response?.status(), status);
    assert.ok(directoryReads > before);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  failure = true;
  for (let attempt = 0; attempt < 3; attempt++) {
    await refreshDirectory();
    for (const s of sessions) assert.equal(await page.locator(`[data-session-card="${s.sessionKey}"]`).count(), 1, 'transient node failure must not erase accepted rows');
  }
  await delay(300); // A real return, outside the duplicate-focus suppression window.
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  for (let attempt = 0; attempt < 100 && !historyFailures; attempt++) await delay(50);
  assert.ok(historyFailures > 0, `exercise a real 503 through the mounted history component; ${JSON.stringify(await page.locator('[data-session-pane]').evaluateAll(nodes => nodes.map(node => ({ key: node.dataset.sessionPane, rect: node.getBoundingClientRect().toJSON() }))))}`);
  assert.equal(await page.getByText(`${sessions[0].sessionKey} reply 1`, { exact: true }).count(), 1, 'history error preserves last visible messages');
  assert.equal(await page.getByText(`${sessions[1].sessionKey} reply 1`, { exact: true }).count(), 1);
  failure = false; sequence = 2;
  await refreshDirectory();
  await delay(300);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.getByText(`${sessions[0].sessionKey} reply 2`, { exact: true }).waitFor({ timeout: 20_000 });
  await page.getByText(`${sessions[1].sessionKey} reply 2`, { exact: true }).waitFor({ timeout: 20_000 });
  metadataFailure = true;
  // Reload exercises optional metadata reads even if their in-memory TTL has
  // not expired. Persisted layout/messages remain in the same authority scope.
  const reloadedDirectory = page.waitForResponse(r => r.url().endsWith('/sessions/state'));
  await page.reload();
  await reloadedDirectory;
  for (const s of sessions) await page.locator(`[data-session-pane="${s.sessionKey}"]`).waitFor();
  await refreshDirectory();
  assert.ok(metadataFailures > 0, 'the optional metadata failure was actually observed');
  directoryFailure = true;
  await refreshDirectory(503);
  for (const s of sessions) {
    assert.equal(await page.locator(`[data-session-card="${s.sessionKey}"]`).count(), 1, 'directory/optional metadata errors preserve accepted rows');
    assert.equal(await page.locator(`[data-session-pane="${s.sessionKey}"]`).count(), 1);
  }
  metadataFailure = directoryFailure = false;
  // Also cover first-load cached display, where no canonical history has yet
  // been accepted, then ensure a later authoritative read replaces it.
  cachedMode = true; sequence = 3;
  await page.reload();
  for (const s of sessions) await page.getByText(`${s.sessionKey} reply 3`, { exact: true }).waitFor();
  await page.locator('.pane-status-indicator[title="Latest messages temporarily unavailable"]').first().click();
  // Warning details are intentionally collapsed to keep the transcript usable.
  await page.locator('.history-sync-issue > summary').first().waitFor({ timeout: 5_000 }).catch(async error => {
    throw new Error(`${error.message}; panes=${await page.locator('[data-session-pane]').allTextContents()}`);
  });
  await page.locator('.history-sync-issue > summary').first().click();
  await page.getByText('Showing saved messages while history is verified.', { exact: true }).first().waitFor();
  cachedMode = false; sequence = 4;
  await delay(300);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  for (const s of sessions) await page.getByText(`${s.sessionKey} reply 4`, { exact: true }).waitFor();
  denied = true;
  await refreshDirectory();
  assert.equal(await page.locator(`[data-session-card="${sessions[0].sessionKey}"]`).count(), 0, 'explicit revocation still removes private rows');
  assert.equal(await page.locator(`[data-session-card="${sessions[1].sessionKey}"]`).count(), 1, 'another node remains available after revocation');
  assert.deepEqual(errors, []); assert.deepEqual(forbidden, []);
  console.log(JSON.stringify({ passed: true, directoryReads, historyFailures, metadataFailures, cases: ['repeated-unavailable', 'history-503-retention', 'healthy-node-isolation', 'automatic-recovery', 'directory-503-retention', 'optional-metadata-failure', 'cold-cached-display', 'cached-to-authoritative', 'explicit-revocation'] }));
  await context.close();
} finally { await browser?.close(); await server?.close(); await rm(output, { recursive: true, force: true }); }
