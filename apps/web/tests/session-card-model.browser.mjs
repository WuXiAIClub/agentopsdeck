// Built UI with isolated synthetic API: no production sessions or Agent calls.
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import { presetWorkspace } from '../src/lib/workspace-layout.ts';
import { layoutSnapshot } from '../src/lib/current-layout.ts';
const { chromium } = await import(pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href);
const server = await createServer({ root: fileURLToPath(new URL('../dist', import.meta.url)), configFile: false, envFile: false,
  logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.AOD_TEST_CHROMIUM });
  for (const runtime of ['codex', 'claude-code', 'ghcp']) {
    const context = await browser.newContext({ viewport: { width: 1800, height: 1000 }, serviceWorkers: 'block' });
    const scope = 'c'.repeat(64), sessionKey = `local:${btoa(`${runtime}:model-menu-target`)}`;
    let session = { sessionKey, source: runtime, agentId: runtime, envConnectionId: 'local', title: `${runtime} target`, status: 'idle', model: 'fixture-old' };
    const other = { ...session, sessionKey: `local:${btoa(`${runtime}:other`)}`, title: 'Other open session' };
    const writes = [], errors = [], forbidden = [], catalogs = [];
    let revision = 1, reject = false, lastReceipt;
    await context.addInitScript(({ scope, snapshot }) => {
      localStorage.setItem('agentopsdeck.locale', 'en');
      localStorage.setItem(`agentopsdeck.current-layout.v2:${scope}`, JSON.stringify(snapshot));
      window.EventSource = class extends EventTarget { readyState = 1; static OPEN = 1; constructor() { super(); queueMicrotask(() => this.onopen?.(new Event('open'))); } close() { this.readyState = 2; } };
    }, { scope, snapshot: layoutSnapshot(presetWorkspace([{ id: 'other-pane', sessionKey: other.sessionKey }], 'single'), new Set()) });
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url()), json = body => route.fulfill({ json: body });
      if (url.origin !== origin) { forbidden.push(url.origin); return route.abort(); }
      if (req.method() === 'PATCH' && url.pathname === `/api/sessions/${encodeURIComponent(sessionKey)}`) {
        const payload = req.postDataJSON(), key = req.headers()['idempotency-key'];
        assert.ok(key, 'normal recovery command key required'); writes.push({ payload, key });
        const result = { sessionKey, settings: { model: payload.model, ...('thinking' in payload ? { thinkingLevel: payload.thinking } : {}) } }, status = reject ? 400 : 200;
        if (!reject) { session = { ...session, model: payload.model }; revision++; }
        lastReceipt = {
          id: key, key, state: reject ? 'rejected' : 'accepted', createdAt: 1, updatedAt: 2,
          result: { status, body: reject ? { error: 'Synthetic denied model' } : result },
        };
        return route.fulfill({ status, json: { ...(reject ? { error: 'Synthetic denied model' } : result), command: lastReceipt } });
      }
      if (req.method() !== 'GET') { forbidden.push(`${req.method()} ${url.pathname}`); return route.abort(); }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      if (lastReceipt && url.pathname.endsWith(`/settings-commands/${encodeURIComponent(lastReceipt.key)}`)) return json({ command: lastReceipt });
      if (url.pathname === '/api/auth/status') return json({ authenticated: true, recoveryScope: scope, passkeys: { available: false, count: 0 } });
      if (url.pathname.endsWith('/sessions/state')) return json({ revision: String(revision), updatedAt: revision, groups: [{ agentId: runtime, sessions: [other, session] }] });
      if (url.pathname.includes('/models/')) { catalogs.push(url.pathname); return json({ models: [{ id: 'fixture-old', label: 'Old model' }, { id: 'fixture-new', label: 'New model' }] }); }
      if (url.pathname.endsWith('/messages')) return json({ messages: [], totalCount: 0, revision: '1' });
      if (url.pathname.endsWith('/queue')) return json({ items: [] });
      if (url.pathname === '/api/agents') return json({ agents: [] });
      if (url.pathname === '/api/gateway/status') return json({ connected: true });
      return route.fulfill({ status: 404, json: {} });
    });
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    const card = page.locator('[data-session-card]').filter({ hasText: `${runtime} target` });
    await card.waitFor(); await page.locator('[data-workspace-pane]').waitFor();
    const beforeLayout = await page.evaluate(scope => localStorage.getItem(`agentopsdeck.current-layout.v2:${scope}`), scope);
    const open = async () => {
      await card.click({ button: 'right' });
      await page.getByRole('menu').getByRole('menuitem', { name: 'Session model', exact: true }).click();
      return page.getByRole('dialog', { name: 'Session model', exact: true });
    };
    let dialog = await open();
    const picker = () => dialog.getByRole('combobox', { name: 'Session model', exact: true });
    await picker().selectOption('fixture-new');
    assert.equal(writes.length, 0, 'selection alone must not mutate settings');
    await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
    await dialog.getByRole('status').filter({ hasText: 'Settings change accepted' }).waitFor();
    // The ACK is a patch, not authoritative session state; await the ordered refresh.
    await dialog.getByRole('button', { name: 'Apply', exact: true }).waitFor({ state: 'hidden' });
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].payload, runtime === 'codex' ? { model: 'fixture-new', thinking: null } : { model: 'fixture-new' });
    assert.ok(catalogs.every(path => path.endsWith(`/models/${runtime}`)), 'runtime-specific catalog only');
    assert.equal(await page.locator('[data-workspace-pane]').count(), 1, 'editing another card never opens a workspace pane');
    assert.equal(await page.evaluate(scope => localStorage.getItem(`agentopsdeck.current-layout.v2:${scope}`), scope), beforeLayout);
    await page.keyboard.press('Escape');
    dialog = await open(); await picker().selectOption('fixture-old'); reject = true;
    await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
    await dialog.getByRole('status').filter({ hasText: 'Update unavailable' }).waitFor();
    assert.equal(writes.length, 2); assert.equal(await picker().inputValue(), 'fixture-old', 'failed save preserves draft');
    assert.notEqual(writes[0].key, writes[1].key);
    await page.evaluate(() => window.dispatchEvent(new Event('agentopsdeck:auth-required')));
    await dialog.waitFor({ state: 'detached' });
    assert.deepEqual(errors, []); assert.deepEqual(forbidden, []);
    await context.close();
  }
  console.log(JSON.stringify({ verified: true, runtimes: ['codex', 'claude-code', 'ghcp'], listCard: true,
    explicitApply: true, correctTarget: true, unchangedLayout: true, rejectedSave: true, authClose: true }));
} finally { await browser?.close(); await server.close(); }
