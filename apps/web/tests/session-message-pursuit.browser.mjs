// Real app, isolated API/connected-but-silent EventSource; never sends a model turn.
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer, preview } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { verifyRunningBorder } from './fixtures/running-pane-border.mjs';
const { chromium } = await import(process.env.AOD_TEST_PLAYWRIGHT ? pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href : 'playwright');
const server = process.env.AOD_TEST_WEB_ROOT
  ? await preview({ root: process.env.AOD_TEST_WEB_ROOT, configFile: false, envFile: false, build: { outDir: process.env.AOD_TEST_WEB_ROOT }, logLevel: 'error', preview: { host: '127.0.0.1', port: 0 } })
  : await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, envFile: false,
    plugins: [react(), tailwindcss()], logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  if ('listen' in server) await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.AOD_TEST_CHROMIUM });
  for (const width of [1600, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: 'block' });
    const scope = 'd'.repeat(64);
    const sessions = [0, 1].map(i => ({ sessionKey: `local:${btoa(`codex:pursuit-${i}`)}`, title: `Pursuit ${i}`,
      source: 'codex', agentId: 'codex', envConnectionId: 'local', status: 'idle', messageCount: 0,
      runtime: { phase: 'completed', sync: 'current', threadActivity: 'idle', connection: 'connected', lastEventAt: 1 } }));
    const reads = [], errors = [], unexpectedWrites = [], external = [];
    let sentAt = 0, posts = 0;
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url()), json = value => route.fulfill({ json: value });
      if (url.origin !== origin) { external.push(url.origin); return route.abort(); }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      if (url.pathname.endsWith('/messages') && req.method() === 'POST') {
        assert.equal(decodeURIComponent(url.pathname.split('/').at(-2)), sessions[0].sessionKey);
        posts++; sentAt = Date.now(); return json({ status: 'sent', idempotencyKey: req.postDataJSON().idempotencyKey });
      }
      if (req.method() !== 'GET') { unexpectedWrites.push(url.pathname); return route.fulfill({ status: 403, json: {} }); }
      if (url.pathname === '/api/auth/status') return json({ authenticated: true, recoveryScope: scope, passkeys: { available: false, count: 0 } });
      if (url.pathname.endsWith('/sessions/state')) {
        // Fast run: start/finish falls between reads; no SSE invalidation sent.
        if (sentAt && Date.now() - sentAt >= 500) Object.assign(sessions[0], { messageCount: 2, runCompletedAt: sentAt + 500,
          runtime: { ...sessions[0].runtime, turnId: 'fast-first-turn', lastEventAt: sentAt + 500 } });
        return json({ groups: [{ agentId: 'codex', sessions }], updatedAt: Date.now() });
      }
      if (url.pathname.endsWith('/messages')) {
        const key = decodeURIComponent(url.pathname.split('/').at(-2));
        reads.push({ key, at: Date.now(), limit: Number(url.searchParams.get('limit')) });
        // The Connector projection deliberately lags even the completion fact.
        const ready = key === sessions[0].sessionKey && sentAt && Date.now() - sentAt >= 2100;
        const messages = ready ? [{ id: 'answer', role: 'assistant', text: 'Visible without SSE', createdAt: sentAt + 2100, phase: 'final_answer' }] : [];
        return json({ revision: ready ? '2' : '1', messages, totalCount: messages.length, hiddenCount: 0 });
      }
      if (url.pathname.endsWith('/queue')) return json({ items: [], nextCursor: null });
      if (url.pathname.endsWith('/collaborators')) return json({ collaborators: [], candidates: [] });
      if (url.pathname.endsWith('/skills')) return json({ skills: [], usage: 'unknown' });
      if (url.pathname === '/api/agents') return json({ agents: [{ id: 'codex', name: 'Codex' }] });
      if (url.pathname === '/api/gateway/status') return json({ connected: true });
      if (url.pathname.endsWith('/models/codex')) return json({ models: [] });
      return route.fulfill({ status: 404, json: {} });
    });
    await context.addInitScript(({ scope, sessions }) => {
      localStorage.setItem('agentopsdeck.locale', 'en');
      localStorage.setItem(`agentopsdeck.current-layout.v2:${scope}`, JSON.stringify({ id: 'current', name: 'Current', collapsedKeys: [], workspace: { version: 2,
        panes: sessions.map((s, i) => ({ id: `pane-${i}`, sessionKey: s.sessionKey })), dock: { kind: 'split', axis: 'horizontal', ratio: .5, first: { kind: 'pane', id: 'pane-0' }, second: { kind: 'pane', id: 'pane-1' } }, floating: [], active: 'pane-0' } }));
      window.EventSource = class extends EventTarget { readyState = 1; static OPEN = 1;
        constructor() { super(); queueMicrotask(() => this.onopen?.(new Event('open'))); } close() { this.readyState = 2; } };
    }, { scope, sessions });
    const page = await context.newPage(); page.setDefaultTimeout(12000); page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${origin}/#/tab/sessions`);
    const originalUrl = page.url();
    const card = i => page.locator(`[data-session-card="${sessions[i].sessionKey}"]`);
    const pane = i => page.locator('[data-workspace-pane]').filter({ has: page.locator(`[data-session-pane="${sessions[i].sessionKey}"]`) });
    await card(1).click(); assert.equal(page.url(), originalUrl, 'sidebar/list selection is not navigation');
    if (width < 700) await page.getByRole('button', { name: 'Back to sessions', exact: true }).click();
    await card(0).click(); assert.equal(page.url(), originalUrl);
    if (width > 700) {
      await pane(0).getByRole('button', { name: 'Maximize pane', exact: true }).click();
      assert.equal(page.url(), originalUrl, 'focus is not navigation');
      assert.equal(await page.locator('.pane-maximize-scrim').evaluate(el => getComputedStyle(el).backdropFilter), 'blur(3px)', 'production CSS preserves focus backdrop');
      await pane(0).getByRole('button', { name: 'Restore pane', exact: true }).click();
    }
    const input = width > 700 ? pane(0).locator('.desktop-composer-textarea') : page.locator('textarea').first();
    if (width > 700 && !await input.isVisible()) await pane(0).getByRole('button', { name: 'Write a message', exact: true }).click();
    await input.fill('hi');
    // Ignore initial sidebar preview warmup; assert only real history windows.
    await page.waitForTimeout(1200);
    const idleBefore = reads.filter(r => r.key === sessions[1].sessionKey && r.limit > 8).length;
    const observationStarted = Date.now();
    if (width > 700) await input.press('Enter');
    else await page.getByRole('button', { name: 'Send message', exact: true }).click();
    if (width > 700) {
      await pane(0).locator('css=:scope[data-completed="true"]').waitFor({ timeout: 6000 });
      assert.equal(await pane(0).evaluate(el => getComputedStyle(el).animationName), 'pane-flash-border', 'first fast turn with authoritative empty runtime triggers real animation');
      const motion = await pane(0).evaluate(async el => {
        const opacities = [], widths = [], start = performance.now();
        // Observe real playback, without seeking or pausing the animation.
        while (performance.now() - start < 1100) {
          opacities.push(Number(getComputedStyle(el, '::before').opacity));
          widths.push(el.getBoundingClientRect().width);
          await new Promise(resolve => setTimeout(resolve, 24));
        }
        return { min: Math.min(...opacities), max: Math.max(...opacities), shift: Math.max(...widths) - Math.min(...widths) };
      });
      assert.ok(motion.min < .2 && motion.max > .9 && motion.shift < 1, `production natural flash without layout shift: ${JSON.stringify(motion)}`);
      console.log('Production natural completion', motion);
    }
    await page.getByText('Visible without SSE', { exact: true }).waitFor({ timeout: 6500 });
    const elapsed = Date.now() - sentAt;
    assert.ok(elapsed < 6500, `silent-stream reply arrived in ${elapsed}ms`);
    assert.equal(posts, 1, 'refresh never resends the command');
    const extraIdleReads = reads.filter(r => r.key === sessions[1].sessionKey && r.limit > 8).slice(idleBefore);
    // Idle panes retain their aligned minute calibration. A test crossing that
    // boundary may see one legitimate read, but never the target's 1s pursuit.
    const crossedMinute = Math.floor(Date.now() / 60_000) > Math.floor(observationStarted / 60_000);
    assert.ok(extraIdleReads.length <= (crossedMinute ? 1 : 0)
      && extraIdleReads.every(r => r.at % 60_000 < 2500), `unrelated idle pane is not polled faster: ${JSON.stringify(reads.map(r => ({ ...r, at: r.at - sentAt })))}`);
    assert.equal(page.url(), originalUrl, 'refresh and completion do not rewrite URL');
    if (width > 700) {
      // Probe the actual production stylesheet too, not only a dev fixture.
      Object.assign(sessions[1], { status: 'running', runtime: { ...sessions[1].runtime, phase: 'running', turnId: 'ring-probe' } });
      await pane(1).locator('css=:scope[data-running="true"]').waitFor();
      assert.equal(await pane(1).getAttribute('data-active'), 'false');
      await verifyRunningBorder(page, pane(1));
      await page.screenshot({ path: '/tmp/agentopsdeck-animation-running-production.png', fullPage: true });
    }
    assert.deepEqual(errors, []); assert.deepEqual(unexpectedWrites, []); assert.deepEqual(external, []);
    console.log(`PASS ${width}px: silent connected stream, fast completion, delayed history visible in ${elapsed}ms, one send, idle pane not boosted, stable URL`);
    await context.close();
  }
} finally { await browser?.close(); await server.close(); }
