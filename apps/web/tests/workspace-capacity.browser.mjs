// Restored 12+4 workspace, resource quota, visibility subscriptions and drafts.
// Synthetic read-only Hub; no live service or production messages.
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
const { chromium } = await import(process.env.AOD_TEST_PLAYWRIGHT
  ? pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href : 'playwright');
const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, envFile: false,
  plugins: [react(), tailwindcss()], logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.AOD_TEST_CHROMIUM });
  const context = await browser.newContext({ viewport: { width: 2560, height: 1600 }, serviceWorkers: 'block' });
  const sessions = Array.from({ length: 17 }, (_, i) => ({ sessionKey: `local:${btoa(`codex:capacity-${i}`)}`, title: `Capacity ${i}`,
    agentId: 'codex', source: 'codex', envConnectionId: 'local', status: 'idle', messageCount: 900, lastActiveAt: i + 1 }));
  const panes = sessions.slice(0, 16).map((s, i) => ({ id: `pane-${i}`, sessionKey: s.sessionKey }));
  panes.push({ id: 'note', kind: 'notebook', target: 'session', resourceId: sessions[0].sessionKey });
  const split = (ids, axis) => ids.length === 1 ? { kind: 'pane', id: ids[0] } : { kind: 'split', axis,
    ratio: 1 / ids.length, first: { kind: 'pane', id: ids[0] }, second: split(ids.slice(1), axis) };
  const rows = [0, 4, 8].map(start => split(panes.slice(start, start + 4).map(p => p.id), 'horizontal'));
  const dock = { kind: 'split', axis: 'vertical', ratio: 1 / 3, first: rows[0], second: { kind: 'split', axis: 'vertical', ratio: .5, first: rows[1], second: rows[2] } };
  const floating = panes.slice(12).map((p, i) => ({ id: p.id, x: .07 + .07 * i, y: .05 + .07 * i, width: .25, height: .3 }));
  const snapshot = { id: 'current', name: 'Current', workspace: { version: 2, panes, dock, floating, active: 'pane-0' }, collapsedKeys: [] };
  const storageKey = `agentopsdeck.current-layout.v2:${'a'.repeat(64)}`;
  const reads = [], errors = [];
  let revision = 1;
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url()); assert.equal(url.origin, origin);
    if (!url.pathname.startsWith('/api/')) return route.continue();
    assert.equal(req.method(), 'GET', `Unexpected write: ${url.pathname}`);
    const json = body => route.fulfill({ json: body });
    if (url.pathname === '/api/auth/status') return json({ authenticated: true, recoveryScope: 'a'.repeat(64), passkeys: { available: false, count: 0 } });
    if (url.pathname.endsWith('/sessions/state')) return json({ revision: String(revision), groups: [{ agentId: 'codex', sessions }], sourceStates: [{ connectionId: 'local', authority: 1, state: 'ready' }] });
    if (url.pathname.endsWith('/messages')) {
      const key = decodeURIComponent(url.pathname.split('/').at(-2)); reads.push({ key, limit: url.searchParams.get('limit') });
      return json({ messages: [{ id: key, sessionKey: key, role: 'assistant', text: `Snapshot ${revision}`, createdAt: 1 }],
        revision: `${key}:${revision}`, updatedAt: revision, totalCount: 900, hiddenCount: 0, limits: { maxMessageChars: 100000 } });
    }
    if (url.pathname.endsWith('/notebook')) return json({ resourceId: 'fixture-note', text: 'A resource, not a chat slot', revision: 1, updatedAt: 1 });
    if (url.pathname.endsWith('/notebooks')) return json({ items: [], nextCursor: null });
    if (url.pathname.endsWith('/queue')) return json({ items: [], nextCursor: null });
    if (url.pathname === '/api/agents') return json({ agents: [{ id: 'codex', name: 'Codex' }] });
    if (url.pathname === '/api/gateway/status') return json({ connected: true });
    return route.fulfill({ status: 404, json: {} });
  });
  await context.addInitScript(({ storageKey, snapshot }) => {
    localStorage.setItem('agentopsdeck.locale', 'en');
    if (!localStorage.getItem(storageKey)) localStorage.setItem(storageKey, JSON.stringify(snapshot));
    const streams = [];
    window.EventSource = class extends EventTarget {
      readyState = 1; static OPEN = 1;
      constructor() { super(); streams.push(this); queueMicrotask(() => this.onopen?.(new Event('open'))); }
      close() { this.readyState = 2; }
    };
    window.fixtureStreams = () => streams.filter(s => s.readyState === 1).length;
    window.fixtureEvent = event => { for (const s of streams) if (s.readyState === 1) s.dispatchEvent(new MessageEvent(event.type, { data: JSON.stringify(event) })); };
  }, { storageKey, snapshot });
  const page = await context.newPage(); page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  const pane = i => page.locator(`[data-session-pane="${sessions[i].sessionKey}"]`);
  const host = i => page.locator('[data-workspace-pane]').filter({ has: pane(i) });
  const keyButton = async (i, name) => { const button = host(i).getByRole('button', { name, exact: true }); await button.focus(); await button.press('Enter'); };
  const waitUntil = predicate => page.waitForFunction(predicate);
  const historyCount = i => reads.filter(r => r.key === sessions[i].sessionKey && r.limit === '200').length;
  await page.clock.install();
  const advance = async ms => {
    for (let elapsed = 0; elapsed < ms; elapsed += 500) {
      await page.clock.runFor(Math.min(500, ms - elapsed)); await pause(20);
    }
  };
  await page.goto(origin);
  await page.waitForFunction(() => document.querySelectorAll('[data-session-pane]').length === 16);
  assert.equal(await page.locator('[data-workspace-pane]').count(), 17, 'notebook does not consume the 12+4 chat quota');
  assert.equal(await page.locator('[data-workspace-pane]:visible').count(), 17, 'all desktop panes remain visible');
  assert.equal(await page.evaluate(() => window.fixtureStreams()), 1);
  await waitUntil(() => [...document.querySelectorAll('[data-session-pane]')].every(el => el.textContent.includes('Snapshot 1')));
  await page.setViewportSize({ width: 1400, height: 900 });
  await advance(500);
  assert.equal(await page.locator('[data-workspace-pane]:visible').count(), 17, 'small desktop cells must not hide the 12+4 workspace');
  const narrowReads = historyCount(0); revision++;
  await page.evaluate(sessionKey => window.fixtureEvent({ type: 'message.created', sessionKey }), sessions[0].sessionKey);
  await advance(5000);
  assert.ok(historyCount(0) > narrowReads, 'narrow non-selected panes remain subscribed');
  await page.setViewportSize({ width: 2560, height: 1600 });
  await advance(500);
  await keyButton(12, 'Collapse floating pane');
  assert.equal(await host(12).getAttribute('data-collapsed'), 'true');
  // Synthetic time advances timers without a minute-long blocking wait.
  const collapsedReads = historyCount(12), visibleReads = historyCount(0); revision++;
  await page.evaluate(keys => keys.forEach(sessionKey => window.fixtureEvent({ type: 'message.created', sessionKey })), [sessions[12].sessionKey, sessions[0].sessionKey]);
  await advance(5000);
  assert.equal(historyCount(12), collapsedReads, 'collapsed panel ignores history events');
  assert.ok(historyCount(0) > visibleReads, 'visible peer still catches up');
  await keyButton(12, 'Expand floating pane');
  await host(12).getByRole('button', { name: 'Collapse floating pane', exact: true }).waitFor();
  await advance(5000);
  assert.ok(historyCount(12) > collapsedReads, `restore revalidates events missed while hidden: ${JSON.stringify({ collapsedReads, now: historyCount(12), reads: reads.slice(-8) })}`);
  await keyButton(0, 'Maximize pane'); await advance(5000);
  const peerReads = historyCount(1), focusedReads = historyCount(0); revision++;
  await page.evaluate(keys => keys.forEach(sessionKey => window.fixtureEvent({ type: 'message.created', sessionKey })), [sessions[1].sessionKey, sessions[0].sessionKey]);
  await advance(5000);
  assert.equal(historyCount(1), peerReads, 'occluded panel suspends history');
  assert.ok(historyCount(0) > focusedReads);
  const composer = pane(0).locator('textarea').last();
  if (!await composer.isVisible()) await pane(0).locator('.composer-reveal').press('Enter');
  await composer.fill('retained across maximize');
  await keyButton(0, 'Restore pane'); await advance(5000);
  assert.equal(await composer.inputValue(), 'retained across maximize');
  assert.ok(historyCount(1) > peerReads, 'restored peers revalidate');
  await keyButton(15, 'Close pane'); await advance(5000);
  assert.equal(await page.locator('[data-session-pane]').count(), 15);
  const closedReads = historyCount(15);
  await page.evaluate(sessionKey => window.fixtureEvent({ type: 'message.created', sessionKey }), sessions[15].sessionKey);
  await advance(5000); assert.equal(historyCount(15), closedReads, 'closed panel has no history subscriber');
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('[data-session-pane]').length === 15);
  assert.equal(await page.locator('[data-workspace-pane]').count(), 16);
  assert.equal(await page.evaluate(() => window.fixtureStreams()), 1);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'passed', docked: 12, floating: 4, additionalNotebooks: 1,
    scenarios: ['capacity-restore', 'collapsed-suspension', 'maximize-suspension', 'draft-preserved', 'close-unsubscribe', 'reload', 'singleton-stream'] }));
  await context.close();
} finally { await browser?.close(); await server.close(); }
