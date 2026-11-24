import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer, preview } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fontScaleCss } from '../src/lib/font-scale-css.ts';
import { MIN_PANE_WIDTH } from '../src/lib/workspace-layout.ts';

const { chromium } = await import(process.env.AOD_TEST_PLAYWRIGHT ? pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href : 'playwright');
const cacheDir = await mkdtemp(join(tmpdir(), 'agentopsdeck-multipane-vite-'));
const server = process.env.AOD_TEST_WEB_ROOT
  ? await preview({ root: process.env.AOD_TEST_WEB_ROOT, configFile: false, envFile: false, build: { outDir: process.env.AOD_TEST_WEB_ROOT }, logLevel: 'error', preview: { host: '127.0.0.1', port: 0 } })
  : await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, envFile: false,
    plugins: [react(), tailwindcss()], css: { postcss: { plugins: [fontScaleCss()] } }, cacheDir, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
let browser;
try {
  if ('listen' in server) await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.AOD_TEST_CHROMIUM ? { executablePath: process.env.AOD_TEST_CHROMIUM } : {}) });
  for (const width of [1600, 1100]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: 'block' });
    const sessions = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta'].map((title, i) => ({ sessionKey: `${i === 1 ? 'remote' : 'local'}:${Buffer.from(title).toString('base64url')}`,
      title, agentId: 'main', source: 'openclaw', envConnectionId: i === 1 ? 'remote' : 'local', status: 'running', hasActiveRun: true, lastActiveAt: i + 1,
      runtime: { phase: 'running', turnId: `turn-${title}`, sync: 'ready' } }));
    const [a, b, c, d, e, f] = sessions;
    const messages = new Map(sessions.map(s => [s.sessionKey, Array.from({ length: 24 }, (_, i) => ({
      id: `message-${i}`, sessionKey: s.sessionKey, role: 'assistant', text: `${s.title} answer ${i}\n\n${'Body paragraph. '.repeat(30)}`, createdAt: i + 1, status: 'sent' }))]));
    const posts = [], mutations = [], reads = [], errors = [];
    let revision = 1, heldSend, delaySend = false, holdKey, heldRead, remoteDenied = false;
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin !== origin) return route.abort();
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const json = body => route.fulfill({ json: body });
      const match = url.pathname.match(/\/sessions\/([^/]+)\/(messages|queue)(?:\/(.*))?$/);
      const key = match ? decodeURIComponent(match[1]) : undefined;
      if (url.pathname === '/api/auth/status') return json({ authenticated: true, recoveryScope: 'a'.repeat(64), passkeys: { available: false, count: 0 } });
      if (url.pathname.endsWith('/sessions/state')) return json({ revision: String(revision), groups: [{ agentId: 'main', sessions: sessions.filter(s => !remoteDenied || s !== b) }],
        sourceStates: [{ connectionId: 'local', authority: 1, state: 'ready' }, { connectionId: 'remote', authority: 1, state: remoteDenied ? 'denied' : 'ready' }] });
      if (match?.[2] === 'messages' && req.method() === 'POST') {
        const body = req.postDataJSON(); posts.push({ key, body });
        if (delaySend) { heldSend = route; return; }
        return json({ status: 'sent', idempotencyKey: body.idempotencyKey });
      }
      if (match?.[2] === 'messages') {
        reads.push({ key, limit: url.searchParams.get('limit') });
        if (remoteDenied && key === b.sessionKey) return route.fulfill({ status: 403, json: { error: 'Access revoked' } });
        if (holdKey === key && url.searchParams.get('limit') !== '8') { heldRead = route; return; }
        return json({ revision: `${key}:${revision}`, messages: messages.get(key), hiddenCount: 0, limits: { maxMessageChars: 100000 } });
      }
      if (match?.[2] === 'queue' && req.method() !== 'GET') {
        mutations.push({ key, id: match[3], method: req.method(), body: req.postDataJSON() });
        messages.set(key, req.method() === 'PATCH' ? messages.get(key).map(m => m.id === match[3] ? { ...m, text: req.postDataJSON().message, queueVersion: 'v2' } : m) : messages.get(key).filter(m => m.id !== match[3])); revision++;
        return json({ ok: true, command: { id: 'queue-receipt', key: req.headers()['idempotency-key'], state: 'accepted', createdAt: 1, updatedAt: 2, result: { status: 200, body: { ok: true } } } });
      }
      if (match?.[2] === 'queue') return json({ items: messages.get(key)?.filter(m => m.status === 'queued').map(m => ({ ...m, messageId: m.id, version: m.queueVersion, state: 'queued' })) ?? [], nextCursor: null });
      if (url.pathname === '/api/agents') return json({ agents: [{ id: 'main', name: 'Main' }] });
      if (url.pathname === '/api/gateway/status') return json({ connected: true });
      if (req.method() !== 'GET') throw Error(`Unexpected write ${req.method()} ${url.pathname}`);
      return route.fulfill({ status: 404, json: {} });
    });
    await context.addInitScript(() => {
      localStorage.setItem('agentopsdeck.locale', 'en'); localStorage.setItem('agentopsdeck.apiBaseUrl', location.origin);
      const streams = [];
      window.EventSource = class extends EventTarget {
        readyState = 1; static OPEN = 1; static CONNECTING = 0; static CLOSED = 2;
        constructor() { super(); streams.push(this); queueMicrotask(() => this.onopen?.(new Event('open'))); this.heartbeat = setInterval(() => this.dispatchEvent(new MessageEvent('heartbeat', { data: '{}' })), 10000); }
        close() { this.readyState = 2; clearInterval(this.heartbeat); }
      };
      window.fixtureStreams = () => streams.filter(s => s.readyState === 1).length;
      window.fixtureEvent = event => { for (const s of streams) if (s.readyState === 1) s.dispatchEvent(new MessageEvent(event.type, { data: JSON.stringify(event), lastEventId: event.id })); };
    });
    const page = await context.newPage(); page.setDefaultTimeout(12000); page.on('pageerror', e => errors.push(e.message));
    await page.goto(origin);
    await page.locator(`[data-session-card="${a.sessionKey}"]`).click();
    const pane = key => page.locator(`[data-session-pane="${key}"]`);
    const composer = key => pane(key).locator('textarea').last();
    const revealComposer = async key => {
      if (!await composer(key).isVisible()) await pane(key).locator('.composer-reveal').press('Enter');
      await composer(key).waitFor({ state: 'visible' });
    };
    const host = key => page.locator('[data-workspace-pane]').filter({ has: pane(key) });
    const preset = async name => { await page.locator('summary[aria-label="Layout presets"]').click(); await page.getByRole('button', { name, exact: true }).click(); };
    const beginDrag = async (key, x, y) => {
      // Unmodified caption drag translates freely; Shift explicitly docks/swaps.
      await page.keyboard.down('Shift');
      const title = await host(key).locator('.session-pane-drag').boundingBox();
      await page.mouse.move(title.x + Math.min(65, title.width / 2), title.y + title.height / 2);
      await page.mouse.down(); await page.mouse.move(x, y, { steps: 6 });
    };
    const beginCardDrag = async (key, x, y) => {
      await page.keyboard.up('Shift');
      const card = page.locator(`[data-session-card="${key}"]`);
      await card.scrollIntoViewIfNeeded();
      const box = await card.boundingBox();
      await page.mouse.move(box.x + 45, box.y + box.height / 2);
      await page.mouse.down(); await page.mouse.move(box.x + 58, box.y + box.height / 2, { steps: 4 });
      await page.mouse.move(x, y, { steps: 12 }); await page.mouse.move(x + 1, y);
    };
    const addByDrag = async (key, floating = false, below) => {
      const surface = await page.locator('.session-workspace-surface').boundingBox();
      const target = below || floating ? await host(below ?? a.sessionKey).boundingBox() : surface;
      await beginCardDrag(key, target.x + (below || floating ? target.width / 2 : target.width - 10), target.y + (below ? target.height - 40 : floating ? target.height / 2 : 150));
      await page.mouse.up();
      await pane(key).waitFor();
    };
    const sameBox = (left, right, label) => { for (const field of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(left[field] - right[field]) < 2, `${label}: ${field}: ${JSON.stringify({ left, right })}`); };
    // Running panes intentionally reconcile even with healthy SSE. Bound the
    // independent safety reads while geometry/identity checks catch remounts.
    const readCheckpoint = () => ({ time: Date.now(), counts: new Map(sessions.map(s => [s.sessionKey, reads.filter(r => r.key === s.sessionKey && r.limit === '200').length])) });
    const assertOnlySafetyReads = (checkpoint, keys, label) => {
      const allowance = Math.ceil((Date.now() - checkpoint.time) / 5000);
      for (const key of keys) assert.ok(reads.filter(r => r.key === key && r.limit === '200').length - checkpoint.counts.get(key) <= allowance, label);
    };
    await pane(a.sessionKey).getByText('Alpha answer 23', { exact: false }).waitFor();
    // Sidebar geometry is local UI state: never remount chat or emit commands.
    const rail = page.locator('#desktop-session-list');
    const divider = page.getByRole('separator', { name: 'Resize session list', exact: true });
    const railWidth = async () => Math.round((await rail.boundingBox()).width);
    const startWidth = await railWidth();
    await composer(a.sessionKey).fill('sidebar draft');
    await composer(a.sessionKey).evaluate(el => { window.railEditor = el; });
    const dividerBox = await divider.boundingBox();
    const surfaceBefore = await page.locator('.session-workspace-surface').boundingBox();
    await page.mouse.move(dividerBox.x + dividerBox.width / 2, 220); await page.mouse.down();
    await page.mouse.move(dividerBox.x + dividerBox.width / 2 + 70, 220, { steps: 8 }); await page.mouse.up();
    assert.equal(await railWidth(), startWidth + 70);
    assert.ok((await page.locator('.session-workspace-surface').boundingBox()).width < surfaceBefore.width);
    await page.getByRole('button', { name: 'Collapse session list', exact: true }).click();
    assert.equal(await rail.getAttribute('inert'), '');
    assert.ok((await page.locator('.session-workspace-surface').boundingBox()).width > surfaceBefore.width);
    await page.getByRole('button', { name: 'Expand session list', exact: true }).click();
    assert.equal(await railWidth(), startWidth + 70);
    assert.ok(await composer(a.sessionKey).evaluate(el => el === window.railEditor));
    assert.equal(await composer(a.sessionKey).inputValue(), 'sidebar draft');
    await page.reload(); await divider.waitFor(); await composer(a.sessionKey).waitFor();
    assert.equal(await railWidth(), startWidth + 70, 'width restores after reload');
    await page.getByRole('button', { name: 'Collapse session list', exact: true }).click();
    await page.reload(); await page.getByRole('button', { name: 'Expand session list', exact: true }).waitFor();
    assert.equal(await divider.count(), 0, 'collapsed state restores after reload');
    await page.getByRole('button', { name: 'Expand session list', exact: true }).click();
    await divider.press('End'); assert.equal(await railWidth(), 480);
    await page.setViewportSize({ width: 800, height: 1000 });
    await page.waitForFunction(() => document.querySelector('[aria-controls="desktop-session-list"][role="separator"]')?.getAttribute('aria-valuenow') === '384');
    assert.equal(await railWidth(), 384, '800px viewport reserves 56px navigation and 360px main content');
    await page.setViewportSize({ width, height: 1000 });
    await page.waitForFunction(() => document.querySelector('[aria-controls="desktop-session-list"][role="separator"]')?.getAttribute('aria-valuenow') === '480');
    assert.equal(await railWidth(), 480, 'temporary clamp does not overwrite saved preference');
    await divider.press('Home'); assert.equal(await railWidth(), 160);
    await divider.press('ArrowRight'); assert.equal(await railWidth(), 170);
    const cancelBox = await divider.boundingBox();
    await page.mouse.move(cancelBox.x + cancelBox.width / 2, 220); await page.mouse.down();
    await page.mouse.move(cancelBox.x + 100, 220, { steps: 5 }); await page.keyboard.press('Escape'); await page.mouse.up();
    assert.equal(await railWidth(), 170, 'Escape discards transient resize');
    await divider.dblclick(); assert.equal(await railWidth(), startWidth, 'double-click resets responsive default');
    assert.equal(posts.length + mutations.length, 0);
    assert.equal(await page.evaluate(() => window.fixtureStreams()), 1);
    await composer(a.sessionKey).fill('draft alpha');
    const initialSurface = await page.locator('.session-workspace-surface').boundingBox();
    const newDockX = initialSurface.x + initialSurface.width - 10, newDockY = initialSurface.y + 150;
    await beginCardDrag(b.sessionKey, newDockX, newDockY);
    await page.locator('.session-workspace-drop-preview[data-drop-kind="right"]').waitFor();
    assert.equal(await page.locator('[data-session-pane]').count(), 1, 'sidebar preview does not open history before release');
    assert.equal(reads.filter(read => read.key === b.sessionKey && read.limit === '200').length, 0);
    await page.mouse.up();
    await pane(b.sessionKey).getByText('Beta answer 23', { exact: false }).waitFor();
    assert.equal(await page.locator('[data-session-pane]').count(), 2);
    assert.equal(await composer(a.sessionKey).inputValue(), 'draft alpha');
    // Transcript movement activates the pane without opening its composer.
    // Ordinary session selection opens a float. Arrange both hosts explicitly
    // before exercising docked resizing and center-swap transactions below.
    await host(a.sessionKey).getByRole('button', { name: 'Dock pane', exact: true }).click();
    await preset('Side by side');
    for (const key of [a.sessionKey, b.sessionKey]) assert.equal(await host(key).getAttribute('data-floating'), 'false');
    // Selecting text or editing a title must still win over hover.
    const hoverTranscript = async key => {
      const box = await host(key).boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height * .45, { steps: 4 });
      await page.waitForTimeout(180);
    };
    await hoverTranscript(b.sessionKey);
    await revealComposer(b.sessionKey);
    await composer(b.sessionKey).fill('draft beta');
    await hoverTranscript(a.sessionKey);
    assert.equal(await host(a.sessionKey).getAttribute('data-active'), 'true', 'transcript movement activates the pane');
    assert.equal(await composer(b.sessionKey).evaluate(el => el === document.activeElement), false, 'reading A releases keyboard targeting B');
    await revealComposer(a.sessionKey);
    await composer(a.sessionKey).evaluate(input => {
      const text = input.closest('[data-workspace-pane]').querySelector('.markdown-body');
      const range = document.createRange(); range.selectNodeContents(text);
      window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
    });
    await hoverTranscript(b.sessionKey); await page.waitForTimeout(200);
    assert.equal(await host(a.sessionKey).getAttribute('data-active'), 'true', 'transcript selection prevents focus theft');
    await page.evaluate(() => window.getSelection().removeAllRanges());
    await hoverTranscript(a.sessionKey); await hoverTranscript(b.sessionKey);
    assert.equal(await host(b.sessionKey).getAttribute('data-active'), 'true');
    await revealComposer(b.sessionKey);
    // Enlarging is a presentation override, never a replacement of the tree or
    // editor. Per-cell resizing can leave blank space independently of peers.
    const alphaBefore = await host(a.sessionKey).boundingBox();
    const betaBefore = await host(b.sessionKey).boundingBox();
    await composer(b.sessionKey).evaluate(el => { window.maximizeEditor = el; });
    const readsBeforeRefresh = reads.filter(read => read.key === b.sessionKey).length;
    await host(b.sessionKey).getByRole('button', { name: 'Force refresh messages', exact: true }).click();
    await page.waitForTimeout(250);
    assert.ok(reads.filter(read => read.key === b.sessionKey).length > readsBeforeRefresh);
    await host(b.sessionKey).getByRole('button', { name: 'Maximize pane', exact: true }).click();
    assert.ok((await host(b.sessionKey).boundingBox()).width > betaBefore.width);
    assert.equal(await page.locator('.pane-maximize-scrim').evaluate(el => getComputedStyle(el).backdropFilter), 'blur(3px)');
    assert.ok(await composer(b.sessionKey).evaluate(el => el === window.maximizeEditor));
    assert.equal(await composer(b.sessionKey).inputValue(), 'draft beta');
    assert.equal(await host(b.sessionKey).getByRole('button', { name: 'Float pane', exact: true }).isDisabled(), true);
    await host(b.sessionKey).getByRole('button', { name: 'Move pane', exact: true }).press('Alt+ArrowLeft');
    await page.keyboard.press('Escape');
    sameBox(await host(b.sessionKey).boundingBox(), betaBefore, 'maximize restore preserves geometry');
    await host(b.sessionKey).locator('[role="separator"][data-edge="bottom"]').press('ArrowUp');
    assert.equal(Math.round((await host(b.sessionKey).boundingBox()).height), Math.round(betaBefore.height - 10));
    sameBox(await host(a.sessionKey).boundingBox(), alphaBefore, 'free height resize leaves neighbor unchanged');
    await host(b.sessionKey).locator('[role="separator"][data-edge="bottom"]').press('ArrowDown');
    sameBox(await host(b.sessionKey).boundingBox(), betaBefore, 'height can expand to its cell again');
    // The stationary-pointer timeout must not collapse the composer during text
    // selection. Clearing selection permits collapse without losing a draft.
    await hoverTranscript(b.sessionKey);
    await revealComposer(b.sessionKey);
    await composer(b.sessionKey).evaluate(input => {
      const range = document.createRange(); range.selectNodeContents(input.closest('[data-workspace-pane]').querySelector('.markdown-body'));
      window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
    });
    await page.waitForTimeout(8250);
    assert.equal(await composer(b.sessionKey).isVisible(), true, 'idle timeout preserves selection geometry');
    await page.evaluate(() => window.getSelection().removeAllRanges());
    await composer(b.sessionKey).waitFor({ state: 'hidden', timeout: 11000 });
    assert.equal(await composer(b.sessionKey).inputValue(), 'draft beta');
    await hoverTranscript(a.sessionKey); await hoverTranscript(b.sessionKey);
    await revealComposer(b.sessionKey);
    // Sidebar float is also transactional; cancellation cannot leak an editor.
    const betaBox = await host(b.sessionKey).boundingBox();
    await beginCardDrag(sessions[2].sessionKey, betaBox.x + betaBox.width / 2, betaBox.y + betaBox.height / 2);
    await page.locator('.session-workspace-drop-preview[data-drop-kind="float"]').waitFor();
    await page.keyboard.press('Escape'); await page.mouse.up();
    assert.equal(await page.locator('[data-session-pane]').count(), 2);
    assert.equal(await page.locator('.session-workspace-drop-preview').count(), 0);
    await beginCardDrag(sessions[2].sessionKey, betaBox.x + betaBox.width / 2, betaBox.y + betaBox.height / 2);
    await page.locator('.session-workspace-drop-preview[data-drop-kind="float"]').waitFor();
    await page.mouse.up();
    await host(sessions[2].sessionKey).locator('.session-pane-caption').waitFor();
    assert.equal(await host(sessions[2].sessionKey).getAttribute('data-floating'), 'true');
    assert.equal(await composer(a.sessionKey).inputValue(), 'draft alpha');
    await host(sessions[2].sessionKey).getByRole('button', { name: 'Close pane', exact: true }).click();
    // Moving an already-open card must retain the exact editor and its draft.
    await composer(a.sessionKey).evaluate(el => { window.sidebarOriginalEditor = el; });
    await beginCardDrag(a.sessionKey, betaBox.x + betaBox.width / 2, betaBox.y + betaBox.height / 2);
    await page.locator('.session-workspace-drop-preview[data-drop-kind="center"]').waitFor();
    await page.mouse.up();
    assert.equal(await page.locator('[data-session-pane]').count(), 2);
    assert.ok(await composer(a.sessionKey).evaluate(el => el === window.sidebarOriginalEditor));
    assert.equal(await composer(a.sessionKey).inputValue(), 'draft alpha');
    // Arbitrary external payloads cannot open a session through the drop target.
    await page.locator('.session-workspace-surface').evaluate((el, key) => {
      const dataTransfer = new DataTransfer(); dataTransfer.setData('application/x-agentopsdeck-session', key);
      el.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer }));
    }, sessions[2].sessionKey);
    assert.equal(await page.locator('[data-session-pane]').count(), 2);
    assert.equal(posts.length, 0); assert.equal(mutations.length, 0);
    await composer(a.sessionKey).evaluate(el => { el.dataset.identity = 'original-alpha'; });
    const alphaScroll = pane(a.sessionKey).locator('.message-selection-surface');
    const readsBeforeLayout = readCheckpoint();
    await preset('Top and bottom');
    for (const key of [a.sessionKey, b.sessionKey]) assert.ok(await pane(key).locator('.message-selection-surface').evaluate(el => el.clientHeight) > 90, 'stacked chat stays readable');
    await page.screenshot({ path: `/tmp/agentopsdeck-dualpane-rows-${width}.png` });
    assert.equal(await composer(a.sessionKey).getAttribute('data-identity'), 'original-alpha', 'axis changes do not remount');
    assert.equal(await composer(b.sessionKey).inputValue(), 'draft beta');
    await page.getByRole('separator', { name: 'Resize panes' }).press('ArrowDown');
    assert.equal(await page.getByRole('separator', { name: 'Resize panes' }).getAttribute('aria-valuenow'), '55');
    await preset('Side by side');
    assertOnlySafetyReads(readsBeforeLayout, [a.sessionKey, b.sessionKey], 'layout changes stay within running reconciliation budget');
    await page.screenshot({ path: `/tmp/agentopsdeck-dualpane-${width}.png` });
    assert.equal(await page.evaluate(() => window.fixtureStreams()), 1, 'one SSE transport');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no document overflow');
    for (const key of [a.sessionKey, b.sessionKey]) {
      const height = await pane(key).locator('.message-selection-surface').evaluate(el => el.clientHeight);
      assert.ok(height > 100, `readable chat height ${height}`);
    }
    // Drag transactions preview without moving/reparenting live controllers.
    const dragReads = readCheckpoint(), dragWrites = posts.length + mutations.length;
    const aBox = await host(a.sessionKey).boundingBox(), bBox = await host(b.sessionKey).boundingBox();
    await beginDrag(a.sessionKey, bBox.x + bBox.width / 2, bBox.y + bBox.height / 2);
    const preview = page.locator('.session-workspace-drop-preview');
    assert.equal(await preview.getAttribute('data-drop-kind'), 'center');
    sameBox(await host(a.sessionKey).boundingBox(), aBox, 'preview is not committed early');
    await page.screenshot({ path: `/tmp/agentopsdeck-drag-swap-${width}.png` });
    await page.mouse.up();
    sameBox(await host(a.sessionKey).boundingBox(), bBox, 'center swaps geometry');
    sameBox(await host(b.sessionKey).boundingBox(), aBox, 'other host swaps geometry');
    assert.equal(await composer(a.sessionKey).getAttribute('data-identity'), 'original-alpha');
    assert.equal(await composer(b.sessionKey).inputValue(), 'draft beta');
    // Tiny movements don't detach a pane; Escape and outside release do not commit.
    const grip = await host(a.sessionKey).getByRole('button', { name: 'Move pane', exact: true }).boundingBox();
    await page.mouse.move(grip.x + 5, grip.y + 5); await page.mouse.down();
    await page.mouse.move(grip.x + 7, grip.y + 7); await page.mouse.up();
    assert.equal(await host(a.sessionKey).getAttribute('data-floating'), 'false');
    let before = await host(a.sessionKey).boundingBox();
    await beginDrag(a.sessionKey, before.x + before.width / 2, before.y + before.height / 2);
    assert.equal(await preview.getAttribute('data-drop-kind'), 'float');
    await page.keyboard.press('Escape'); await page.mouse.up();
    assert.equal(await preview.count(), 0); sameBox(await host(a.sessionKey).boundingBox(), before, 'escape cancellation');
    await beginDrag(a.sessionKey, 2, 2); await page.mouse.up();
    sameBox(await host(a.sessionKey).boundingBox(), before, 'outside cancellation');
    await beginDrag(a.sessionKey, before.x + before.width / 2, before.y + before.height / 2);
    await host(a.sessionKey).locator('.session-pane-drag-title').dispatchEvent('pointercancel'); await page.mouse.up();
    sameBox(await host(a.sessionKey).boundingBox(), before, 'pointer cancellation');
    await beginDrag(a.sessionKey, before.x + before.width / 2, before.y + before.height / 2);
    await page.evaluate(() => window.dispatchEvent(new Event('blur'))); await page.mouse.up();
    sameBox(await host(a.sessionKey).boundingBox(), before, 'window focus loss cancels');
    // Local edge docking projects the exact resulting rect, then float and rim dock.
    const target = await host(b.sessionKey).boundingBox();
    await beginDrag(a.sessionKey, target.x + target.width / 2, target.y + 42);
    assert.equal(await preview.getAttribute('data-drop-kind'), 'top');
    const proposed = await preview.boundingBox(); await page.mouse.up();
    sameBox(await host(a.sessionKey).boundingBox(), proposed, 'edge preview matches placement');
    assert.ok((await host(a.sessionKey).boundingBox()).y < (await host(b.sessionKey).boundingBox()).y);
    before = await host(a.sessionKey).boundingBox();
    await beginDrag(a.sessionKey, before.x + before.width / 2, before.y + before.height / 2);
    assert.equal(await preview.getAttribute('data-drop-kind'), 'float');
    const floated = await preview.boundingBox(); await page.mouse.up();
    assert.equal(await host(a.sessionKey).getAttribute('data-floating'), 'true');
    sameBox(await host(a.sessionKey).boundingBox(), floated, 'float preview matches placement');
    const surface = await page.locator('.session-workspace-surface').boundingBox();
    await beginDrag(a.sessionKey, surface.x + 8, surface.y + surface.height / 2);
    assert.equal(await preview.getAttribute('data-drop-kind'), 'left'); await page.mouse.up();
    assert.equal(await host(a.sessionKey).getAttribute('data-floating'), 'false');
    assert.equal(await composer(a.sessionKey).getAttribute('data-identity'), 'original-alpha');
    await page.keyboard.up('Shift');
    assert.equal(await composer(a.sessionKey).inputValue(), 'draft alpha');
    assertOnlySafetyReads(dragReads, [a.sessionKey, b.sessionKey], 'drags stay within running reconciliation budget');
    assert.equal(posts.length + mutations.length, dragWrites, 'drags do not issue business commands');
    assert.equal(await page.evaluate(() => window.fixtureStreams()), 1);
    await host(a.sessionKey).getByRole('button', { name: 'Move pane', exact: true }).press('Alt+ArrowDown');
    assert.ok((await host(a.sessionKey).boundingBox()).y > (await host(b.sessionKey).boundingBox()).y, 'keyboard docking equivalent');
    await host(a.sessionKey).getByRole('button', { name: 'Move pane', exact: true }).press('Alt+ArrowLeft');
    await page.locator('summary[aria-label="Layout presets"]').click();
    await page.getByRole('button', { name: 'Grid layout', exact: true }).press('Escape');
    assert.equal(await page.locator('.session-workspace-presets:not(.saved-layouts)').getAttribute('open'), null, 'preset menu dismisses with Escape');
    // Pausing one pane must not disable following in its sibling. A targeted
    // event reads only the target, not every open history.
    await alphaScroll.hover(); await page.mouse.wheel(0, -700); await page.waitForTimeout(300);
    const pausedTop = await alphaScroll.evaluate(el => el.scrollTop);
    const alphaReads = readCheckpoint();
    messages.get(b.sessionKey).push({ id: 'stream-beta', sessionKey: b.sessionKey, role: 'assistant', text: 'Beta streaming continuation', createdAt: 60, status: 'sent' }); revision++;
    await page.evaluate(key => window.fixtureEvent({ type: 'message.created', id: 'event-beta', sessionKey: key }), b.sessionKey);
    await pane(b.sessionKey).getByText('Beta streaming continuation', { exact: true }).waitFor();
    assertOnlySafetyReads(alphaReads, [a.sessionKey], 'B event does not exceed A safety budget');
    assert.ok(Math.abs(await alphaScroll.evaluate(el => el.scrollTop) - pausedTop) < 3, 'A reading position stays fixed');
    // Identical message IDs in both panes must not send search scrolling to A.
    const betaTools = host(b.sessionKey).getByRole('button', { name: 'Pane tools', exact: true });
    if (await betaTools.isVisible()) await betaTools.click();
    await host(b.sessionKey).getByRole('button', { name: 'Search messages', exact: true }).click();
    const search = page.getByRole('region', { name: 'Search messages', exact: true });
    await search.getByRole('textbox', { name: 'Search messages', exact: true }).fill('Beta answer 4');
    await search.getByText('1/1', { exact: true }).waitFor();
    await page.waitForFunction(key => {
      const el = document.querySelector(`[data-session-pane="${key}"] [data-message-search-id="message-4"]`);
      if (!el) return false;
      const rect = el.getBoundingClientRect(), container = el.closest('.message-selection-surface').getBoundingClientRect();
      return rect.bottom > container.top && rect.top < container.bottom;
    }, b.sessionKey);
    assert.ok(Math.abs(await alphaScroll.evaluate(el => el.scrollTop) - pausedTop) < 3, 'search in B does not scroll A');
    await search.getByRole('button', { name: 'Clear message search' }).click();
    await page.keyboard.press('Escape');
    // An ACK arriving for A cannot focus A while the user is typing in B.
    delaySend = true;
    await hoverTranscript(a.sessionKey);
    await revealComposer(a.sessionKey);
    await pane(a.sessionKey).getByRole('button', { name: 'Send message', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-session-pane]') !== null);
    for (let i = 0; !heldSend && i < 100; i++) await page.waitForTimeout(20);
    assert.ok(heldSend);
    await hoverTranscript(b.sessionKey);
    await revealComposer(b.sessionKey);
    await composer(b.sessionKey).fill('beta during alpha send');
    await heldSend.fulfill({ json: { status: 'sent', idempotencyKey: posts.at(-1).body.idempotencyKey } }); delaySend = false;
    await page.waitForTimeout(300);
    assert.equal(await composer(b.sessionKey).evaluate(el => el === document.activeElement), true, 'late ACK must not steal focus');
    assert.equal(posts[0].key, a.sessionKey); assert.equal(posts[0].body.message, 'draft alpha');
    await host(b.sessionKey).getByRole('button', { name: 'Stop current run', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Stop current run', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
    for (let i = 0; posts.at(-1)?.body.message !== '/stop' && i < 100; i++) await page.waitForTimeout(20);
    assert.equal(posts.at(-1).key, b.sessionKey); assert.equal(posts.at(-1).body.message, '/stop');
    assert.equal(posts.at(-1).body.expectedRunId, 'turn-Beta');
    // Both panes intentionally use the same message IDs; DOM IDs must stay unique.
    assert.equal(await page.evaluate(() => { const ids = [...document.querySelectorAll('[id]')].map(el => el.id); return ids.length === new Set(ids).size; }), true, 'unique DOM IDs');
    const queued = { id: 'queue-alpha', sessionKey: a.sessionKey, role: 'user', text: 'queued only in alpha', createdAt: Date.now(), status: 'queued', queueDisposition: 'waiting', queueVersion: 'v1' };
    messages.get(a.sessionKey).push(queued); revision++;
    messages.get(b.sessionKey).push({ ...queued, sessionKey: b.sessionKey, text: 'queued only in beta' });
    await page.evaluate(key => window.fixtureEvent({ type: 'message.created', id: 'queue-created', sessionKey: key }), a.sessionKey);
    await pane(a.sessionKey).getByText('queued only in alpha', { exact: true }).waitFor();
    await pane(a.sessionKey).getByRole('button', { name: 'Edit', exact: true }).click();
    await pane(a.sessionKey).getByRole('textbox', { name: 'Edit queued message' }).fill('edited alpha queue');
    await pane(a.sessionKey).getByRole('button', { name: 'Save changes' }).click();
    await pane(a.sessionKey).getByText('edited alpha queue', { exact: true }).waitFor();
    assert.equal(mutations.at(-1).key, a.sessionKey); assert.equal(mutations.at(-1).method, 'PATCH');
    assert.equal(messages.get(b.sessionKey).at(-1).text, 'queued only in beta');
    await pane(a.sessionKey).getByRole('button', { name: 'Cancel delivery', exact: true }).click();
    await pane(a.sessionKey).getByRole('button', { name: /Confirm cancel/ }).click();
    assert.equal(mutations.at(-1).key, a.sessionKey); assert.equal(mutations.at(-1).id, queued.id);
    // Selection opens another float without replacing a pane; late responses
    // stay scoped to their original session.
    holdKey = b.sessionKey;
    await page.evaluate(key => window.fixtureEvent({ type: 'message.updated', id: 'hold-beta', sessionKey: key }), b.sessionKey);
    for (let i = 0; !heldRead && i < 100; i++) await page.waitForTimeout(20);
    await hoverTranscript(b.sessionKey);
    await revealComposer(b.sessionKey);
    await composer(b.sessionKey).focus();
    await page.locator(`[data-session-card="${c.sessionKey}"]`).click();
    await pane(c.sessionKey).getByText('Gamma answer 23', { exact: false }).waitFor();
    if (heldRead) await heldRead.fulfill({ json: { revision: 'late', messages: [{ id: 'late', sessionKey: b.sessionKey, role: 'assistant', text: 'BETA LATE RESPONSE', createdAt: 999 }] } });
    holdKey = undefined;
    assert.equal(await pane(c.sessionKey).getByText('BETA LATE RESPONSE').count(), 0);
    assert.equal(await composer(a.sessionKey).getAttribute('data-identity'), 'original-alpha');
    const writes = posts.length + mutations.length;
    await page.locator('[data-workspace-pane]').filter({ has: pane(c.sessionKey) }).getByRole('button', { name: 'Close pane', exact: true }).click();
    assert.equal(await page.locator('[data-session-pane]').count(), 2);
    await host(b.sessionKey).getByRole('button', { name: 'Close pane', exact: true }).click();
    assert.equal(await page.locator('[data-session-pane]').count(), 1);
    assert.equal(posts.length + mutations.length, writes, 'closing a view never stops/deletes a session');
    await addByDrag(b.sessionKey);
    assert.equal(await composer(b.sessionKey).inputValue(), 'beta during alpha send', 'closed pane draft survives reopening');
    await hoverTranscript(a.sessionKey);
    await revealComposer(a.sessionKey);
    await composer(a.sessionKey).focus();
    holdKey = b.sessionKey; heldRead = undefined;
    await page.evaluate(key => window.fixtureEvent({ type: 'message.updated', id: 'hold-beta-reopened', sessionKey: key }), b.sessionKey);
    for (let i = 0; !heldRead && i < 100; i++) await page.waitForTimeout(20);
    remoteDenied = true; revision++;
    await page.evaluate(key => window.fixtureEvent({ type: 'session.updated', id: 'remote-revoked', sessionKey: key }), b.sessionKey);
    await pane(b.sessionKey).waitFor({ state: 'detached' });
    if (heldRead) await heldRead.fulfill({ json: { revision: 'revoked-late', messages: [{ id: 'secret', sessionKey: b.sessionKey, role: 'assistant', text: 'REVOKED LATE BODY', createdAt: 999 }] } });
    assert.equal(await composer(a.sessionKey).getAttribute('data-identity'), 'original-alpha', 'revoking background node preserves other controller');
    assert.equal(await page.getByText('REVOKED LATE BODY').count(), 0);
    // Four real controllers, two optional floating hosts, and all preset changes
    // retain the exact DOM/editor instances. Fixtures never touch live sessions.
    holdKey = undefined;
    await addByDrag(c.sessionKey);
    await addByDrag(d.sessionKey, false, a.sessionKey);
    await addByDrag(e.sessionKey, false, c.sessionKey);
    for (const session of [a, c, d, e]) {
      await pane(session.sessionKey).getByText(`${session.title} answer 23`, { exact: false }).waitFor();
      await hoverTranscript(session.sessionKey);
      await revealComposer(session.sessionKey);
      await composer(session.sessionKey).fill(`grid draft ${session.title}`);
      await composer(session.sessionKey).evaluate(el => { el.dataset.gridIdentity = 'stable'; });
    }
    assert.equal(await page.locator('[data-session-pane]').count(), 4);
    assert.equal(await page.getByRole('combobox', { name: 'Add session pane' }).count(), 0);
    await preset('Grid layout');
    for (const session of [a, c, d, e]) assert.ok(await pane(session.sessionKey).locator('.message-selection-surface').evaluate(el => el.clientHeight) >= 100, 'four-grid leaves readable history, not only controls');
    const boxes = await Promise.all([a, c, d, e].map(s => host(s.sessionKey).boundingBox()));
    for (const box of boxes) {
      assert.ok(box.width > 300 && box.height > 300, 'four-grid has usable pane geometry');
      for (const other of boxes) if (box !== other) assert.ok(box.x + box.width <= other.x + 1 || other.x + other.width <= box.x + 1 || box.y + box.height <= other.y + 1 || other.y + other.height <= box.y + 1, 'docked panes never overlap');
    }
    await page.screenshot({ path: `/tmp/agentopsdeck-four-grid-${width}.png` });
    // Subtree minimums now rebalance ratios: three rows fit at 1000px.
    // Use a genuinely insufficient viewport for the rejected-split contract.
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(100);
    const blockedBefore = await host(d.sessionKey).boundingBox();
    const blockedTarget = (await Promise.all([a, c, e].map(session => host(session.sessionKey).boundingBox()))).find(box => Math.abs(box.x - blockedBefore.x) > 10);
    await beginDrag(d.sessionKey, blockedTarget.x + blockedTarget.width / 2, blockedTarget.y + 42);
    assert.equal(await preview.getAttribute('data-drop-kind'), 'blocked', 'cannot split a half-height grid cell below its minimum');
    await page.screenshot({ path: `/tmp/agentopsdeck-drag-blocked-${width}.png` });
    await page.mouse.up(); sameBox(await host(d.sessionKey).boundingBox(), blockedBefore, 'invalid geometry leaves tree unchanged');
    await page.keyboard.up('Shift');
    await page.setViewportSize({ width, height: 1000 });
    await page.waitForTimeout(100);
    const gridReads = reads.filter(read => read.limit === '200').length;
    const gridWrites = posts.length + mutations.length;
    await host(d.sessionKey).getByRole('button', { name: 'Float pane', exact: true }).click();
    await preset('Left and stacked right');
    assert.equal(await host(d.sessionKey).getAttribute('data-floating'), 'true');
    // One global chat preference updates every docked/floating pane without
    // remounting composers, changing their drafts or scaling panel geometry.
    const typographyBaseline = await page.locator('[data-workspace-pane]').evaluateAll(elements => elements.map(element => {
      const editor = element.querySelector('.desktop-composer-textarea');
      window.fontTestEditors ??= []; window.fontTestEditors.push(editor);
      return { size: parseFloat(getComputedStyle(editor).fontSize), width: element.getBoundingClientRect().width, text: editor.value };
    }));
    for (const scale of [80, 110, 100]) {
      await page.evaluate(scale => {
        const key = `agentopsdeck.font-preferences.v1:${'a'.repeat(64)}`;
        localStorage.setItem(key, JSON.stringify({ version: 1, sessions: 100, chat: scale, notebooks: 100 }));
        window.dispatchEvent(new StorageEvent('storage', { key }));
      }, scale);
      await page.waitForFunction(scale => document.documentElement.style.getPropertyValue('--agentopsdeck-chat-font-scale') === String(scale / 100), scale);
      const actual = await page.locator('[data-workspace-pane]').evaluateAll(elements => elements.map((element, i) => {
        const editor = element.querySelector('.desktop-composer-textarea');
        return { size: parseFloat(getComputedStyle(editor).fontSize), width: element.getBoundingClientRect().width, text: editor.value, same: editor === window.fontTestEditors[i] };
      }));
      actual.forEach((entry, i) => {
        assert.ok(Math.abs(entry.size - typographyBaseline[i].size * scale / 100) < .03, 'docked and floating composers share the scale');
        assert.equal(entry.width, typographyBaseline[i].width); assert.equal(entry.text, typographyBaseline[i].text); assert.equal(entry.same, true);
      });
    }
    assert.equal(await composer(d.sessionKey).getAttribute('data-grid-identity'), 'stable');
    const move = host(d.sessionKey).getByRole('button', { name: 'Move floating pane', exact: true });
    const initialFloat = await host(d.sessionKey).boundingBox();
    await move.press('ArrowRight'); await move.press('ArrowDown');
    const keyboardFloat = await host(d.sessionKey).boundingBox();
    assert.ok(keyboardFloat.x > initialFloat.x + 8 && keyboardFloat.y > initialFloat.y + 8, 'keyboard move');
    const dragBox = await move.boundingBox();
    await page.mouse.move(dragBox.x + 7, dragBox.y + 7); await page.mouse.down();
    await page.mouse.move(dragBox.x + 42, dragBox.y + 32, { steps: 5 }); await page.mouse.up();
    assert.ok((await host(d.sessionKey).boundingBox()).x > keyboardFloat.x + 25, 'pointer drag');
    const beforeResize = await host(d.sessionKey).boundingBox();
    await host(d.sessionKey).getByRole('button', { name: 'Resize floating pane', exact: true }).press('ArrowRight');
    assert.ok((await host(d.sessionKey).boundingBox()).width > beforeResize.width + 8, 'keyboard resize');
    for (const edge of ['right', 'bottom']) {
      const before = await host(d.sessionKey).boundingBox();
      const grip = await host(d.sessionKey).locator(`[data-edge=${edge}]`).boundingBox();
      await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2); await page.mouse.down();
      await page.mouse.move(grip.x + grip.width / 2 - (edge === 'right' ? 30 : 0), grip.y + grip.height / 2 - (edge === 'bottom' ? 30 : 0), { steps: 5 }); await page.mouse.up();
      const after = await host(d.sessionKey).boundingBox();
      assert.ok((edge === 'right' ? before.width - after.width : before.height - after.height) > 25, `pointer ${edge} resize`);
      assert.equal(await composer(d.sessionKey).getAttribute('data-grid-identity'), 'stable');
    }
    await page.evaluate(key => window.dispatchEvent(new CustomEvent('agentopsdeck:session-completed-preview', { detail: { key, tag: 'visible-floating' } })), d.sessionKey);
    assert.equal(await page.getByRole('dialog', { name: 'Session finished', exact: true }).count(), 0, 'visible floating chat does not toast');
    await revealComposer(a.sessionKey); await composer(a.sessionKey).focus();
    await page.waitForFunction(key => Number(getComputedStyle(document.querySelector(`[data-session-pane="${key}"]`).closest('[data-workspace-pane]')).opacity) === .5, d.sessionKey);
    await revealComposer(d.sessionKey); await composer(d.sessionKey).focus();
    await page.waitForFunction(key => Number(getComputedStyle(document.querySelector(`[data-session-pane="${key}"]`).closest('[data-workspace-pane]')).opacity) === 1, d.sessionKey);
    await composer(d.sessionKey).fill('retain collapsed draft');
    const expandedSize = await host(d.sessionKey).boundingBox();
    await host(d.sessionKey).getByRole('button', { name: 'Collapse floating pane', exact: true }).click();
    assert.equal(await host(d.sessionKey).getAttribute('data-floating'), 'true');
    assert.equal(await host(d.sessionKey).getAttribute('data-collapsed'), 'true');
    assert.equal(Math.round((await host(d.sessionKey).boundingBox()).height), 34);
    assert.equal(await composer(d.sessionKey).isVisible(), false);
    assert.equal(await host(d.sessionKey).getByRole('button', { name: 'Resize floating pane', exact: true }).count(), 0);
    await move.press('ArrowLeft');
    assert.ok((await host(d.sessionKey).boundingBox()).x < expandedSize.x - 8, 'collapsed header remains movable');
    await page.evaluate(session => window.dispatchEvent(new CustomEvent('agentopsdeck:session-completed-preview', { detail: { key: session.sessionKey, tag: 'collapsed-completion', session } })), d);
    const collapsedToast = page.getByRole('dialog', { name: 'Session finished', exact: true });
    await collapsedToast.waitFor();
    await host(d.sessionKey).getByRole('button', { name: 'Expand floating pane', exact: true }).click();
    await collapsedToast.waitFor({ state: 'detached' });
    assert.equal(await composer(d.sessionKey).inputValue(), 'retain collapsed draft');
    assert.equal(await composer(d.sessionKey).getAttribute('data-grid-identity'), 'stable');
    const restoredSize = await host(d.sessionKey).boundingBox();
    assert.ok(Math.abs(restoredSize.width - expandedSize.width) < 1 && Math.abs(restoredSize.height - expandedSize.height) < 1, 'expand restores resized dimensions');
    await revealComposer(d.sessionKey); await composer(d.sessionKey).fill('floating delta send');
    await pane(d.sessionKey).getByRole('button', { name: 'Send message', exact: true }).click();
    assert.equal(posts.at(-1).key, d.sessionKey); assert.equal(posts.at(-1).body.message, 'floating delta send');
    await host(d.sessionKey).getByRole('button', { name: 'Dock pane', exact: true }).click();
    assert.equal(await host(d.sessionKey).getAttribute('data-floating'), 'false');
    await preset('Grid layout');
    assert.equal(await composer(d.sessionKey).getAttribute('data-grid-identity'), 'stable', 'float/dock does not remount');
    await addByDrag(f.sessionKey, true);
    await pane(f.sessionKey).getByText('Zeta answer 23', { exact: false }).waitFor();
    assert.equal(await page.locator('[data-session-pane]').count(), 5, 'four docked plus floating chat');
    assert.equal(await host(f.sessionKey).getByRole('button', { name: 'Dock pane', exact: true }).isDisabled(), false, 'five sessions no longer exhaust dock budget');
    const capacityBefore = await host(f.sessionKey).boundingBox();
    const fullSurface = await page.locator('.session-workspace-surface').boundingBox();
    await beginDrag(f.sessionKey, fullSurface.x + 8, fullSurface.y + fullSurface.height / 2);
    assert.equal(await preview.getAttribute('data-drop-kind'), fullSurface.width >= 3 * MIN_PANE_WIDTH + 20 ? 'left' : 'blocked', 'pixel budget determines whether three columns fit');
    await page.keyboard.press('Escape'); await page.mouse.up(); sameBox(await host(f.sessionKey).boundingBox(), capacityBefore, 'cancelled preview leaves float unchanged');
    await revealComposer(f.sessionKey); await composer(f.sessionKey).fill('floating zeta retained');
    await composer(f.sessionKey).evaluate(el => { el.dataset.gridIdentity = 'stable'; });
    await page.screenshot({ path: `/tmp/agentopsdeck-grid-floating-${width}.png` });
    // A floating host may cover this docked header in a custom arrangement;
    // keyboard access remains available without forcibly clicking through it.
    await host(d.sessionKey).getByRole('button', { name: 'Float pane', exact: true }).press('Enter');
    assert.equal(await page.locator('[data-floating="true"]').count(), 2);
    const fullFloatBefore = await host(a.sessionKey).boundingBox();
    await beginDrag(a.sessionKey, fullFloatBefore.x + fullFloatBefore.width / 2, fullFloatBefore.y + fullFloatBefore.height / 2);
    assert.equal(await preview.getAttribute('data-drop-kind'), 'float', 'third floating session is allowed');
    await page.mouse.up();
    assert.equal(await page.locator('[data-floating="true"]').count(), 3);
    await page.keyboard.up('Shift');
    await host(a.sessionKey).getByRole('button', { name: 'Dock pane', exact: true }).press('Enter');
    await page.locator(`[data-session-card="${f.sessionKey}"]`).click();
    assert.ok(Number(await host(f.sessionKey).evaluate(el => getComputedStyle(el).zIndex)) > Number(await host(d.sessionKey).evaluate(el => getComputedStyle(el).zIndex)), 'selecting a floating session brings it forward');
    await page.locator(`[data-session-card="${a.sessionKey}"]`).click();
    assert.ok(Number(await host(f.sessionKey).evaluate(el => getComputedStyle(el).zIndex)) > Number(await host(d.sessionKey).evaluate(el => getComputedStyle(el).zIndex)), 'z-order persists after dock focus');
    await page.locator(`[data-session-card="${d.sessionKey}"]`).click();
    await host(d.sessionKey).getByRole('button', { name: 'Dock pane', exact: true }).click();
    // The free-card workspace no longer replaces short viewports with a tab
    // switcher. Every host remains mounted and reachable across resizing.
    await page.setViewportSize({ width, height: 600 });
    await page.waitForTimeout(100);
    assert.equal(await page.getByRole('tablist', { name: 'Session panes' }).count(), 0);
    await page.locator(`[data-session-card="${a.sessionKey}"]`).click();
    await revealComposer(a.sessionKey);
    assert.equal(await composer(a.sessionKey).isVisible(), true);
    for (const session of [a, c, d, e, f]) assert.equal(await host(session.sessionKey).isVisible(), true);
    await page.locator(`[data-session-card="${f.sessionKey}"]`).click();
    assert.equal(await composer(f.sessionKey).inputValue(), 'floating zeta retained');
    await page.setViewportSize({ width, height: 1000 });
    await page.waitForTimeout(100);
    for (const session of [a, c, d, e, f]) assert.equal(await composer(session.sessionKey).getAttribute('data-grid-identity'), 'stable', 'viewport changes retain controllers');
    const savedLayouts = page.locator('.saved-layouts');
    await savedLayouts.locator(':scope > summary').click();
    await savedLayouts.getByRole('button', { name: 'Save current layout', exact: true }).click();
    await page.getByRole('textbox', { name: 'Layout name', exact: true }).fill('Grid and floating');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await page.getByRole('dialog', { name: 'Layout name' }).waitFor({ state: 'detached' });
    await host(f.sessionKey).getByRole('button', { name: 'Close pane', exact: true }).click();
    for (const session of [a, c, e]) assert.equal(await composer(session.sessionKey).inputValue(), `grid draft ${session.title}`);
    assert.equal(posts.length + mutations.length, gridWrites + 1, 'layout operations do not mutate session/run');
    assert.equal(await page.evaluate(() => window.fixtureStreams()), 1, 'five panes still share one SSE');
    // Sending refreshes only Delta; geometry changes themselves do not fetch histories.
    for (const session of [a, c, e]) assert.equal(await composer(session.sessionKey).getAttribute('data-grid-identity'), 'stable');
    assert.ok(reads.filter(read => read.limit === '200').length >= gridReads, 'new explicit floating target is loaded');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const restoreWrites = posts.length + mutations.length;
    await savedLayouts.locator(':scope > summary').click();
    await savedLayouts.getByRole('button', { name: 'Grid and floating 5', exact: true }).click();
    await host(f.sessionKey).waitFor();
    assert.equal(await host(f.sessionKey).getAttribute('data-floating'), 'true', 'saved layout restores floating geometry');
    for (const session of [a, c, d, e]) assert.equal(await composer(session.sessionKey).getAttribute('data-grid-identity'), 'stable', 'restoring layout retains existing DOM/controller identity');
    for (const session of [a, c, e]) assert.equal(await composer(session.sessionKey).inputValue(), `grid draft ${session.title}`);
    assert.equal(posts.length + mutations.length, restoreWrites, 'restoring a layout never sends/creates/mutates sessions');
    await savedLayouts.locator(':scope > summary').click();
    await savedLayouts.getByRole('button', { name: 'Rename Grid and floating', exact: true }).click();
    await page.getByRole('textbox', { name: 'Layout name', exact: true }).fill('Review workspace');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await page.getByRole('dialog', { name: 'Layout name' }).waitFor({ state: 'detached' });
    await page.reload();
    await page.locator('.saved-layouts > summary').click();
    await page.locator('.saved-layouts').getByRole('button', { name: 'Review workspace 5', exact: true }).waitFor();
    await page.locator('.saved-layouts').getByRole('button', { name: 'Delete Review workspace', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.locator('.saved-layouts > summary').click();
    await page.locator('.saved-layouts').getByRole('button', { name: 'Review workspace 5', exact: true }).waitFor();
    assert.deepEqual(errors, []);
    console.log(`Workspace ${width}px: drag edge docking/center swap/float, preview geometry, Esc/cancel/blur/outside, minimums and capacity, keyboard presets/docking, dual/four-grid/left-stack, resize/z-order, saved layout save/rename/reload/restore, short viewport, retained controllers/drafts, singleton SSE, send/stop/edit/cancel routing, late responses and revocation passed`);
    await context.close();
  }
} finally { await browser?.close(); await server.close(); await rm(cacheDir, { recursive: true, force: true }); }
