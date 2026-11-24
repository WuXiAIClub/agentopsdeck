// C closeout: isolated HTTP/stream fixtures, no production requests or commands.
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
const { chromium } = await import(process.env.AOD_TEST_PLAYWRIGHT ? pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href : 'playwright');
const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, envFile: false,
  plugins: [react(), tailwindcss()], logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.AOD_TEST_CHROMIUM });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: 'block' });
  const sessions = [0, 1].map(i => ({ sessionKey: `local:${btoa(`codex:polish-${i}`)}`, title: `Polish ${i}`, source: 'codex', agentId: 'codex', envConnectionId: 'local', envConnectionLabel: 'Fixture environment',
    status: 'idle', lastActiveAt: 20, runCompletedAt: 20, messageCount: 500,
    runtime: { phase: 'completed', turnId: `turn-${i}`, sync: 'current', threadActivity: 'idle', connection: 'connected', lastEventAt: 20 } }));
  const scope = 'c'.repeat(64), errors = [], writes = [], external = [];
  let toolReads = 0;
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin !== origin) { external.push(url.origin); return route.abort(); }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    if (req.method() !== 'GET') { writes.push(url.pathname); return route.fulfill({ status: 403, json: {} }); }
    const json = value => route.fulfill({ json: value });
    if (url.pathname === '/api/auth/status') return json({ authenticated: true, recoveryScope: scope, passkeys: { available: false, count: 0 } });
    if (url.pathname.endsWith('/sessions/state')) return json({ groups: [{ agentId: 'codex', sessions }], updatedAt: Date.now() });
    if (url.pathname.endsWith('/messages')) {
      const key = decodeURIComponent(url.pathname.split('/').at(-2));
      const messages = Array.from({ length: 16 }, (_, i) => ({ id: `m${i}`, sessionKey: key, role: i % 2 ? 'assistant' : 'user', text: i === 15 ? 'hi' : `Message ${i}\n\n${'Readable text. '.repeat(30)}`, createdAt: i + 1 }));
      for (let i = 0; i < (key === sessions[0].sessionKey ? 2 : 1); i++) messages.push({ id: `t${i}`, sessionKey: key, role: 'tool', text: 'tool: exec_command\noutput: done', toolName: 'exec_command', toolCallId: `tool${i}`, toolPhase: 'result', toolDetailAvailable: true, createdAt: 17 + i });
      messages.push({ id: 'final', sessionKey: key, role: 'assistant', text: 'OK', createdAt: 20, turnId: sessions[0].runtime.turnId, phase: 'final_answer' });
      return json({ messages, totalCount: 500, hiddenCount: 0, updatedAt: 1 });
    }
    if (url.pathname.includes('/tools/')) { toolReads++; return json({ text: 'Detailed tool output' }); }
    if (url.pathname.endsWith('/collaborators')) return json({ collaborators: [], candidates: [] });
    if (url.pathname.endsWith('/queue')) return json({ items: [], nextCursor: null });
    if (url.pathname.endsWith('/skills')) return json({ skills: [], usage: 'unknown', observedAt: 1 });
    if (url.pathname === '/api/agents') return json({ agents: [{ id: 'codex', name: 'Codex' }] });
    if (url.pathname === '/api/gateway/status') return json({ connected: true });
    if (url.pathname.endsWith('/models/codex')) return json({ models: [] });
    return route.fulfill({ status: 404, json: {} });
  });
  await context.addInitScript(({ scope, sessions }) => {
    localStorage.setItem('agentopsdeck.locale', 'en');
    localStorage.setItem(`agentopsdeck.current-layout.v2:${scope}`, JSON.stringify({ id: 'current', name: 'Current', collapsedKeys: [], workspace: { version: 2,
      panes: sessions.map((s, i) => ({ id: `pane-${i}`, sessionKey: s.sessionKey })), dock: { kind: 'split', axis: 'horizontal', ratio: .5, first: { kind: 'pane', id: 'pane-0' }, second: { kind: 'pane', id: 'pane-1' } }, floating: [], active: 'pane-0' } }));
    const streams = [];
    window.EventSource = class extends EventTarget { readyState = 1; static OPEN = 1;
      constructor() { super(); streams.push(this); queueMicrotask(() => this.onopen?.(new Event('open'))); } close() { this.readyState = 2; } };
    window.fixtureEvent = event => { for (const s of streams) if (s.readyState === 1) s.dispatchEvent(new MessageEvent(event.type, { data: JSON.stringify(event) })); };
  }, { scope, sessions });
  const page = await context.newPage(); page.setDefaultTimeout(12000); page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  const pane = i => page.locator('[data-workspace-pane]').filter({ has: page.locator(`[data-session-pane="${sessions[i].sessionKey}"]`) });
  await pane(0).getByText('OK', { exact: true }).waitFor(); await pane(1).getByText('OK', { exact: true }).waitFor();
  const transcript = pane(0).locator('.message-selection-surface');
  const input = pane(0).locator('.desktop-composer-textarea');
  await pane(0).locator('.session-pane-drag-title').click();
  await page.waitForFunction(() => document.querySelector('[data-workspace-pane][data-active="true"] .session-state-header')?.dataset.sessionState === 'completed');
  assert.equal(await pane(0).evaluate(el => getComputedStyle(el).borderColor), 'rgb(5, 150, 105)', 'completed selection is green');
  for (const i of [0, 1]) {
    assert.equal(await pane(i).locator('.session-pane-caption').evaluate(el => el.offsetHeight), 32);
    assert.equal(await pane(i).locator('.desktop-tool-chip').count(), i ? 1 : 2);
    assert.equal(await pane(i).locator('.desktop-tool-label:visible').count(), 0, 'even one tool is minimal');
    assert.ok(await pane(i).locator('.desktop-tool-step').first().evaluate(el => el.offsetWidth === el.offsetHeight && parseFloat(getComputedStyle(el).borderRadius) >= el.offsetWidth / 2), 'original colored circle retained');
    const footer = pane(i).locator('.message-footer').last();
    const boxes = await footer.locator('button,time').evaluateAll(elements => elements.map(el => el.getBoundingClientRect().toJSON()));
    assert.ok(Math.max(...boxes.map(b => b.y + b.height / 2)) - Math.min(...boxes.map(b => b.y + b.height / 2)) < 3, 'short reply actions/time stay on one row');
  }
  assert.equal(toolReads, 0, 'compact display never downloads tool bodies');
  // Exercise all caption actions inline; narrow overflow has its own built-app
  // regression. Retain the compact viewport for the tool layout checks above.
  await page.setViewportSize({ width: 2800, height: 1000 });
  await page.waitForFunction(() => [...document.querySelectorAll('.caption-overflow')].every(el => el.dataset.collapsed === 'false'));
  assert.equal(await pane(0).locator('.session-pane-caption h2').innerText(), 'Polish 0');
  assert.equal(await pane(0).locator('[data-desktop-chat-toolbar] h2').count(), 0, 'no duplicated second-row title');
  const files = pane(0).getByRole('button', { name: 'Session files', exact: true });
  const notes = pane(0).getByRole('button', { name: 'Session notebook', exact: true });
  const skills = pane(0).getByRole('button', { name: 'Session skills', exact: true });
  for (const button of [files, notes, skills]) {
    assert.ok(await button.evaluate(el => !!el.closest('.session-pane-caption')), 'files/notes live in first row');
    assert.equal(await button.innerText(), '', 'caption actions are icons only');
    assert.equal(await button.getAttribute('title'), null, 'no delayed duplicate native tooltip');
  }
  assert.equal(await files.locator('svg.lucide-folder-open').count(), 1);
  assert.equal(await notes.locator('svg.lucide-sticky-note').count(), 1);
  assert.equal(await skills.locator('svg.lucide-book-open').count(), 1);
  assert.equal(await pane(0).locator('[data-desktop-chat-toolbar] .session-skills-trigger').count(), 0);
  assert.equal(await pane(0).locator('.desktop-pane-identity').count(), 0);
  assert.equal(await pane(0).locator('[data-desktop-chat-toolbar]').count(), 0, 'no reserved second toolbar row');
  assert.equal((await pane(0).locator('.session-pane-caption').boundingBox()).height, 32);
  assert.equal(await pane(0).locator('.session-pane-caption h2').evaluate(el => getComputedStyle(el).fontSize), '14px');
  for (const name of ['Session model', 'Rename session', 'Search messages']) {
    const button = pane(0).getByRole('button', { name, exact: true });
    assert.ok(await button.evaluate(el => !!el.closest('.session-pane-caption')));
    assert.equal(await button.getAttribute('title'), null, 'quick hint instead of delayed native tooltip');
  }
  const modelButton = pane(0).getByRole('button', { name: 'Session model', exact: true });
  await modelButton.click();
  const modelPanel = page.getByRole('region', { name: 'Session model', exact: true });
  await modelPanel.getByRole('combobox', { name: 'Session model', exact: true }).selectOption('__custom_model__');
  await modelPanel.getByRole('textbox', { name: 'Custom model ID' }).fill('draft-model');
  await page.keyboard.press('Escape');
  await modelPanel.waitFor({ state: 'hidden' });
  await modelButton.click();
  assert.equal(await modelPanel.getByRole('textbox', { name: 'Custom model ID' }).inputValue(), 'draft-model', 'closing panel preserves draft/controller');
  await modelPanel.getByRole('combobox', { name: 'Session model', exact: true }).selectOption('');
  await page.keyboard.press('Escape');
  assert.equal(await pane(0).getByRole('button', { name: 'More session actions', exact: true }).count(), 0);
  const deleteButton = pane(0).getByRole('button', { name: 'Delete session…', exact: true });
  if (!await deleteButton.isVisible()) await pane(0).getByRole('button', { name: 'Pane tools', exact: true }).click();
  await deleteButton.click();
  await page.getByRole('dialog', { name: 'Delete session?', exact: true }).getByRole('button', { name: 'Cancel', exact: true }).click();
  await pane(0).getByRole('button', { name: 'Session status', exact: true }).click();
  await page.locator('.caption-popover .pane-context-identity').first().waitFor();
  assert.match(await page.locator('.pane-context-identity').first().innerText(), /Fixture environment/);
  assert.match(await page.locator('.pane-context-identity').first().innerText(), /codex/i);
  await page.keyboard.press('Escape');
  await skills.hover();
  await page.getByRole('tooltip', { name: 'Session skills', exact: true }).waitFor({ timeout: 500 });
  // Native popover reentrancy must never take the whole app into recovery.
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    const original = HTMLElement.prototype.showPopover;
    window.tooltipReentrancyTested = false;
    HTMLElement.prototype.showPopover = function (...args) {
      if (this.getAttribute('role') === 'tooltip') {
        HTMLElement.prototype.showPopover = original;
        window.tooltipReentrancyTested = true;
        throw new DOMException('Synthetic nested native popover', 'InvalidStateError');
      }
      return original.apply(this, args);
    };
  });
  await skills.focus();
  await page.waitForFunction(() => window.tooltipReentrancyTested);
  await page.getByRole('tooltip', { name: 'Session skills', exact: true }).waitFor({ state: 'hidden' });
  await skills.blur(); await skills.focus();
  await page.getByRole('tooltip', { name: 'Session skills', exact: true }).waitFor();
  await skills.focus(); await page.keyboard.press('Enter');
  await page.locator('.session-skills-dialog').waitFor();
  await page.keyboard.press('Escape');
  await page.locator('.session-skills-dialog').waitFor({ state: 'hidden' });
  assert.ok(await skills.evaluate(el => document.activeElement === el), 'skills restores trigger focus');
  await files.hover();
  await page.getByRole('tooltip', { name: 'Session files', exact: true }).waitFor({ timeout: 500 });
  await notes.hover();
  await page.getByRole('tooltip', { name: 'Session notebook', exact: true }).waitFor({ timeout: 500 });
  assert.equal(await page.getByRole('tooltip').count(), 1, 'moving icons replaces the hint');
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('tooltip').count(), 0);
  await files.focus();
  await page.getByRole('tooltip', { name: 'Session files', exact: true }).waitFor({ timeout: 250 });
  await page.keyboard.press('Enter');
  await page.locator('.session-files-dialog').waitFor();
  assert.equal(await page.getByRole('tooltip').count(), 0, 'hint closes when opening files');
  await page.keyboard.press('Escape');
  await page.locator('.session-files-dialog').waitFor({ state: 'hidden' });
  assert.ok(await files.evaluate(el => document.activeElement === el), 'file dialog restores trigger focus');
  await notes.click();
  await page.locator('.session-notebook').waitFor();
  assert.equal(await notes.getAttribute('aria-expanded'), 'true');
  await notes.click();
  await page.locator('.session-notebook').waitFor({ state: 'hidden' });
  await pane(0).locator('.session-pane-caption h2').dblclick();
  await pane(0).getByRole('textbox', { name: 'Rename chat', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await pane(0).getByRole('textbox', { name: 'Rename chat', exact: true }).count(), 0);
  await pane(0).getByRole('button', { name: 'Share session', exact: true }).click();
  await page.locator('.caption-popover:popover-open').getByText('Invite someone to this session', { exact: true }).waitFor();
  const popoverBox = await page.locator('.caption-popover:popover-open').boundingBox();
  assert.ok(popoverBox.x >= 8 && popoverBox.x + popoverBox.width <= 2792);
  await page.keyboard.press('Escape'); await page.locator('.caption-popover:popover-open').waitFor({ state: 'hidden' });
  await pane(0).getByRole('button', { name: 'Share session', exact: true }).click();
  await page.locator('.caption-popover:popover-open').waitFor();
  await pane(1).getByText('OK', { exact: true }).click(); await page.locator('.caption-popover:popover-open').waitFor({ state: 'hidden' });
  await pane(0).getByRole('button', { name: 'Maximize pane', exact: true }).click();
  const focus = await pane(0).boundingBox(), surface = await page.locator('.session-workspace-surface').boundingBox();
  assert.ok(focus.width * focus.height / (surface.width * surface.height) < .6);
  await page.mouse.click(surface.x + 10, surface.y + surface.height / 2);
  await page.locator('.pane-maximize-scrim').waitFor({ state: 'hidden' });
  await transcript.dispatchEvent('wheel', { deltaY: -100 });
  await page.waitForFunction(() => document.querySelector('[data-composer-reading="true"]'));
  assert.equal(await input.isVisible(), false);
  const r = await transcript.boundingBox(); await page.mouse.move(r.x + 40, r.y + 40); await page.waitForTimeout(160);
  assert.equal(await input.isVisible(), false, 'hover does not undo reading intent');
  await page.keyboard.type('x'); assert.equal(await input.inputValue(), 'x', 'typing reveals input and retains first character');
  await input.dispatchEvent('compositionstart', { data: '' });
  await transcript.dispatchEvent('wheel', { deltaY: -100 });
  assert.equal(await input.isVisible(), true, 'IME composition is not collapsed');
  await input.dispatchEvent('compositionend', { data: '中' });
  await input.fill('draft kept');
  await transcript.dispatchEvent('wheel', { deltaY: -100 });
  await transcript.evaluate(el => { const node = el.querySelector('[data-message-bubble]'); const range = document.createRange(); range.selectNodeContents(node); getSelection().removeAllRanges(); getSelection().addRange(range); });
  await page.keyboard.type('q'); assert.equal(await input.isVisible(), false, 'selection is not stolen');
  await page.evaluate(() => getSelection().removeAllRanges());
  await page.keyboard.type('z'); assert.equal(await input.inputValue(), 'draft keptz');
  // Fault injection replaces only the isolated read, preserving controller/gate/render paths.
  await page.evaluate(async () => { const { api } = await import('/src/api.ts'); const read = api.sessionMessages;
    window.readFault = undefined; window.readAttempts = 0;
    api.sessionMessages = (...args) => { window.readAttempts++; if (window.readFault) return Promise.reject(window.readFault === 'abort' ? new DOMException('Mode changed', 'AbortError') : new Error('Synthetic timeout')); return read(...args); };
  });
  const trigger = async fault => { await page.evaluate(({ key, fault }) => { window.readFault = fault; window.fixtureEvent({ type: 'message.updated', sessionKey: key, createdAt: Date.now() }); }, { key: sessions[0].sessionKey, fault }); };
  await trigger('abort'); await page.waitForFunction(() => window.readAttempts >= 1);
  await page.waitForTimeout(100); assert.equal(await pane(0).locator('.session-state-header').getAttribute('data-session-state'), 'completed', 'cancel is not red');
  await trigger('timeout'); await pane(0).locator('.pane-status-indicator[data-state="warning"]').waitFor();
  assert.equal(await pane(0).locator('.session-state-header').getAttribute('data-session-state'), 'completed', 'first background failure retains execution state');
  await trigger('timeout'); await page.waitForFunction(() => document.querySelector('.session-state-header[data-session-state="error"]'));
  assert.equal(await pane(0).evaluate(el => getComputedStyle(el).borderColor), 'rgb(225, 29, 72)');
  await trigger(undefined); await pane(0).locator('.pane-status-indicator[data-state="warning"]').waitFor({ state: 'hidden' });
  await page.waitForFunction(() => !document.querySelector('.session-state-header[data-session-state="error"]'));
  // Server-reported sync fault is real even with HTTP 200; do not hide it.
  sessions[0].runtime.sync = 'error';
  await page.evaluate(key => window.fixtureEvent({ type: 'run.updated', sessionKey: key, createdAt: Date.now() }), sessions[0].sessionKey);
  await page.waitForFunction(() => document.querySelector('.session-state-header[data-session-state="error"]'));
  await pane(0).getByRole('button', { name: 'Session status', exact: true }).click();
  await page.getByLabel('History sync interrupted', { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  // Constrained pane geometry does not overflow caption or message controls.
  for (const width of [400, 300]) {
    await pane(0).evaluate((el, width) => { el.style.width = `${width}px`; }, width);
    await page.waitForTimeout(150);
    if (!(await files.isVisible()) || !(await pane(0).locator('.session-skills-trigger').isVisible())) await pane(0).getByRole('button', { name: 'Pane tools', exact: true }).click();
    await pane(0).locator('.session-files-trigger').waitFor();
    await pane(0).locator('.session-skills-trigger').waitFor();
    await page.mouse.move(0, 0);
    await page.waitForTimeout(200);
    await files.blur();
    const hint = page.getByRole('tooltip', { name: 'Session files', exact: true });
    await files.focus();
    await hint.waitFor({ timeout: 2000 });
    assert.ok(await hint.evaluate(el => el.matches(':popover-open')), 'hint uses top layer');
    const hintBox = await hint.boundingBox();
    assert.ok(hintBox.x >= 8 && hintBox.x + hintBox.width <= 2792, 'hint fits viewport outside narrow pane');
    const toolbar = pane(0).locator('.session-pane-caption');
    const beforeSearch = await toolbar.boundingBox();
    await pane(0).getByRole('button', { name: 'Search messages', exact: true }).click();
    const search = page.getByRole('region', { name: 'Search messages', exact: true });
    await search.getByRole('textbox', { name: 'Search messages' }).fill('Readable');
    assert.equal((await toolbar.boundingBox()).height, beforeSearch.height, 'search never changes toolbar height');
    assert.ok(await toolbar.evaluate(el => el.scrollWidth <= el.clientWidth + 1), `toolbar fits ${width}px`);
    const searchBox = await search.boundingBox();
    assert.ok(searchBox.x >= 8 && searchBox.x + searchBox.width <= 2792, 'search escapes pane clipping');
    assert.ok(await search.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'search contents fit popover');
    await page.keyboard.press('Escape'); await search.waitFor({ state: 'hidden' });
    const geometry = await pane(0).locator('.session-pane-caption').evaluate(el => ({ width: el.clientWidth, scroll: el.scrollWidth }));
    assert.ok(geometry.scroll <= geometry.width + 1, `caption fits ${width}px`);
    const titleWidth = (await pane(0).locator('.session-pane-drag-title').boundingBox()).width;
    assert.ok(titleWidth >= 48, `title remains identifiable at ${width}px (actual ${titleWidth})`);
    const footer = pane(0).locator('.message-footer').last();
    const boxes = await footer.locator('button,time').evaluateAll(elements => elements.map(el => el.getBoundingClientRect().toJSON()));
    assert.ok(Math.max(...boxes.map(b => b.y + b.height / 2)) - Math.min(...boxes.map(b => b.y + b.height / 2)) < 3, `footer remains one line at ${width}px`);
    assert.ok(await footer.evaluate(el => el.scrollWidth <= el.clientWidth + 1), `footer does not clip at ${width}px`);
    // Short messages, enlarged text and touch-sized controls are where the
    // old hard-coded bubble minimum hid controls despite a nowrap footer.
    for (const fontScale of [1, 1.3]) {
      await pane(0).evaluate((el, scale) => el.style.setProperty('--agentopsdeck-chat-font-scale', String(scale)), fontScale);
      assert.ok(await footer.evaluate(el => {
        const parent = el.closest('article').getBoundingClientRect();
        return [...el.querySelectorAll('button,time')].every(control => {
          const b = control.getBoundingClientRect(); return b.left >= parent.left && b.right <= parent.right;
        });
      }), `footer stays inside its bubble at ${width}px / font ${fontScale}`);
    }
  }
  // A witnessed completion pulses three times; old Done does not animate.
  assert.equal(await pane(0).getAttribute('data-completed'), 'false');
  sessions[0].status = 'running'; sessions[0].runtime.phase = 'running'; sessions[0].runtime.threadActivity = 'running'; sessions[0].runtime.sync = 'current';
  await page.evaluate(key => window.fixtureEvent({ type: 'run.updated', sessionKey: key, createdAt: Date.now() }), sessions[0].sessionKey);
  await page.waitForFunction(() => document.querySelector('.session-state-header[data-session-state="running"]'));
  assert.equal(await pane(0).getAttribute('data-running'), 'true');
  const ring = await pane(0).evaluate(async el => {
    const read = () => getComputedStyle(el.querySelector('.session-running-trail'));
    const first = read().strokeDashoffset;
    await new Promise(resolve => setTimeout(resolve, 160));
    return { first, next: read().strokeDashoffset, events: read().pointerEvents };
  });
  assert.notEqual(ring.first, ring.next, 'highlight travels along the SVG perimeter');
  assert.equal(ring.events, 'none');
  sessions[0].runtime.sync = 'error';
  await page.evaluate(key => window.fixtureEvent({ type: 'run.updated', sessionKey: key, createdAt: Date.now() }), sessions[0].sessionKey);
  await pane(0).locator('.session-state-header[data-session-state="error"]').waitFor({ state: 'attached' });
  assert.equal(await pane(0).locator('.session-running-trail').evaluate(el => getComputedStyle(el).animationName), 'session-running-border', 'sync warning must not erase an authoritative running indicator');
  await pane(1).locator('.session-pane-drag-title').click();
  assert.equal(await pane(0).getAttribute('data-active'), 'false');
  assert.equal(await pane(0).locator('.session-running-trail').evaluate(el => getComputedStyle(el).animationName), 'session-running-border', 'unselected running card still animates');
  await pane(0).locator('.session-pane-drag-title').click();
  sessions[0].runtime.sync = 'current';
  sessions[0].status = 'idle'; sessions[0].runtime.phase = 'completed'; sessions[0].runtime.threadActivity = 'idle';
  await page.evaluate(key => window.fixtureEvent({ type: 'run.updated', sessionKey: key, createdAt: Date.now() }), sessions[0].sessionKey);
  await pane(0).locator('css=:scope[data-completed="true"]').waitFor();
  assert.equal(await pane(0).locator('.session-running-ring').count(), 0, 'runner removed when the run ends');
  const flash = await pane(0).evaluate(el => { const s = getComputedStyle(el), overlay = getComputedStyle(el, '::before'); return { name: s.animationName, count: s.animationIterationCount, duration: s.animationDuration, overlay: overlay.animationName, pointer: overlay.pointerEvents, inset: overlay.inset }; });
  assert.deepEqual(flash, { name: 'pane-flash-border', count: '3', duration: '0.85s', overlay: 'pane-flash-overlay', pointer: 'none', inset: '0px' });
  const naturalFlash = await pane(0).evaluate(async el => {
    const samples = [];
    for (let i = 0; i < 18; i++) { samples.push({ opacity: Number(getComputedStyle(el, '::before').opacity), width: el.getBoundingClientRect().width }); await new Promise(resolve => setTimeout(resolve, 50)); }
    return samples;
  });
  assert.ok(Math.max(...naturalFlash.map(s => s.opacity)) > .9 && Math.min(...naturalFlash.map(s => s.opacity)) < .2, 'natural playback visibly changes overlay without seeking');
  assert.ok(Math.max(...naturalFlash.map(s => s.width)) - Math.min(...naturalFlash.map(s => s.width)) < 1, 'flash does not shift layout');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await pane(0).evaluate(el => getComputedStyle(el, '::before').animationName), 'none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(async () => (await import('/src/lib/completion-preference.ts')).saveCompletionEffect('heartbeat'));
  const pulse = await pane(0).evaluate(el => { const s = getComputedStyle(el); return { name: s.animationName, count: s.animationIterationCount, duration: s.animationDuration, scale: s.getPropertyValue('--completion-scale').trim() }; });
  assert.deepEqual(pulse, { name: 'pane-heartbeat', count: '3', duration: '0.85s', scale: '1.04' });
  const geometryPulse = await pane(0).evaluate(async el => {
    const animation = el.getAnimations().find(item => item.animationName === 'pane-heartbeat');
    animation.pause();
    const at = async time => { animation.currentTime = time; await new Promise(requestAnimationFrame); return el.getBoundingClientRect().width; };
    const base = await at(0), focusedPeak = await at(850 * .35), focusedLow = await at(850 * .18);
    el.dataset.active = 'false';
    const peak = await at(850 * .35), low = await at(850 * .18);
    el.dataset.active = 'true'; animation.cancel(); animation.play();
    return { base, focusedPeak, focusedLow, peak, low };
  });
  assert.ok(geometryPulse.focusedPeak > geometryPulse.base && geometryPulse.focusedLow < geometryPulse.base, 'focused whole pane actually expands AND contracts');
  assert.ok(geometryPulse.focusedPeak / geometryPulse.base > 1.034, 'focused whole-card expansion is visible, not a subpixel accent');
  assert.ok(geometryPulse.peak > geometryPulse.focusedPeak, 'unfocused heartbeat is stronger');
  assert.ok(geometryPulse.low < geometryPulse.focusedLow, 'unfocused contraction is stronger');
  await page.evaluate(async () => (await import('/src/lib/completion-preference.ts')).saveCompletionEffect('off'));
  assert.equal(await pane(0).evaluate(el => getComputedStyle(el).animationName), 'none');
  // Verify the setting at the event, independently of later recovery checks.
  assert.ok(await page.evaluate(() => window.__agentopsdeckCompletionDiagnostics.read()
    .some(e => e.stage === 'render' && e.facts.effect === 'off' && e.facts.animation === 'none')));
  await page.evaluate(async () => (await import('/src/lib/completion-preference.ts')).saveCompletionEffect('glow'));
  assert.equal(await pane(0).evaluate(el => getComputedStyle(el).animationName), 'pane-completed');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await pane(0).evaluate(el => getComputedStyle(el).animationName), 'none');
  await pane(0).locator('css=:scope[data-completed="false"]').waitFor();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(async () => (await import('/src/lib/completion-preference.ts')).saveCompletionEffect('heartbeat'));
  sessions[0].runtime.turnId = 'fast-turn'; sessions[0].runCompletedAt = 99;
  await page.evaluate(key => window.fixtureEvent({ type: 'run.updated', sessionKey: key, createdAt: Date.now() }), sessions[0].sessionKey);
  await pane(0).locator('css=:scope[data-completed="true"]').waitFor();
  const firstSequence = await pane(0).getAttribute('data-completion-sequence');
  await pane(0).evaluate(el => { el.getAnimations().find(item => item.animationName === 'pane-heartbeat').currentTime = 1800; });
  sessions[0].runtime.turnId = 'another-fast-turn'; sessions[0].runCompletedAt = 100;
  await page.evaluate(key => window.fixtureEvent({ type: 'run.updated', sessionKey: key, createdAt: Date.now() }), sessions[0].sessionKey);
  await page.waitForFunction(sequence => {
    const next = document.querySelector('[data-completed="true"]')?.dataset.completionSequence;
    return next !== undefined && next !== sequence;
  }, firstSequence);
  assert.ok(await pane(0).evaluate(el => el.getAnimations().find(item => item.animationName === 'pane-heartbeat').currentTime < 1000), 'second completion restarts animation without remount');
  await pane(0).locator('css=:scope[data-completed="false"]').waitFor();
  await page.evaluate(key => window.fixtureEvent({ type: 'run.updated', sessionKey: key, createdAt: Date.now() }), sessions[0].sessionKey);
  await page.waitForTimeout(300);
  assert.equal(await pane(0).getAttribute('data-completed'), 'false', 'history refresh does not replay old completion');
  // A real-time, unmodified animation test: no pause/currentTime/seek. Keep
  // the page hidden longer than the old 2.7s lifetime, then come back.
  sessions[0].runtime.turnId = 'natural-hidden'; sessions[0].runCompletedAt = 110;
  await page.evaluate(key => window.fixtureEvent({ type: 'run.updated', sessionKey: key, createdAt: Date.now() }), sessions[0].sessionKey);
  await pane(0).locator('css=:scope[data-completed="true"]').waitFor();
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await pane(0).locator('css=:scope[data-completed="false"]').waitFor();
  await page.waitForTimeout(2900);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await pane(0).locator('css=:scope[data-completed="true"]').waitFor();
  const natural = await pane(0).evaluate(async el => {
    const widths = [], scales = [], started = performance.now();
    while (performance.now() - started < 1900) {
      widths.push(el.getBoundingClientRect().width / el.offsetWidth);
      scales.push(Number.parseFloat(getComputedStyle(el).scale));
      await new Promise(resolve => setTimeout(resolve, 32));
    }
    return { min: Math.min(...widths), max: Math.max(...widths), minScale: Math.min(...scales), maxScale: Math.max(...scales) };
  });
  assert.ok(natural.min < .98 && natural.max > 1.025, `natural whole card contracts and expands: ${JSON.stringify(natural)}`);
  await pane(0).locator('css=:scope[data-completed="false"]').waitFor();
  const diagnostics = await page.evaluate(() => window.__agentopsdeckCompletionDiagnostics.read());
  assert.ok(diagnostics.some(e => e.stage === 'deferred-hidden'));
  assert.ok(diagnostics.some(e => e.stage === 'animationstart'));
  assert.ok(diagnostics.some(e => e.stage === 'animationend'));
  assert.ok(diagnostics.some(e => e.stage === 'playback-sample' && e.facts.playing && e.facts.widthRatio < .99));
  assert.ok(!JSON.stringify(diagnostics).includes(sessions[0].sessionKey));
  assert.ok(!JSON.stringify(diagnostics).includes('natural-hidden'));
  console.log('Natural animation/hidden-tab diagnostics PASS', natural, { entries: diagnostics.length, first: diagnostics[0]?.at });
  await page.evaluate(async () => (await import('/src/lib/completion-preference.ts')).saveCompletionEffect('off'));
  sessions[0].runtime.turnId = 'off-completion'; sessions[0].runCompletedAt = 120;
  await page.evaluate(key => window.fixtureEvent({ type: 'run.updated', sessionKey: key, createdAt: Date.now() }), sessions[0].sessionKey);
  await pane(0).locator('css=:scope[data-completed="true"]').waitFor();
  assert.equal(await pane(0).evaluate(el => getComputedStyle(el).animationName), 'none');
  assert.ok(await page.evaluate(() => window.__agentopsdeckCompletionDiagnostics.read()
    .some(e => e.stage === 'render' && e.facts.effect === 'off' && e.facts.animation === 'none')));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(async () => (await import('/src/lib/completion-preference.ts')).saveCompletionEffect('heartbeat'));
  sessions[0].runtime.turnId = 'reduced-completion'; sessions[0].runCompletedAt = 130;
  await page.evaluate(key => window.fixtureEvent({ type: 'run.updated', sessionKey: key, createdAt: Date.now() }), sessions[0].sessionKey);
  await page.waitForFunction(() => window.__agentopsdeckCompletionDiagnostics.read()
    .some(e => e.stage === 'render' && e.facts.reducedMotion && e.facts.animation === 'none'));
  console.log('Off and reduced-motion completion diagnostics PASS');
  // Replay an old terminal snapshot after witnessing a newer running turn.
  // Observe the actual hook/diagnostic decision before checking lack of motion.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  Object.assign(sessions[0], { status: 'running', runStartedAt: 200, runCompletedAt: undefined });
  Object.assign(sessions[0].runtime, { phase: 'running', threadActivity: 'running', turnId: 'new-observed-run' });
  await page.evaluate(key => window.fixtureEvent({ type: 'run.updated', sessionKey: key, createdAt: Date.now() }), sessions[0].sessionKey);
  await pane(0).locator('css=:scope[data-running="true"][data-completed="false"]').waitFor();
  Object.assign(sessions[0], { status: 'idle', runStartedAt: 100, runCompletedAt: 150 });
  Object.assign(sessions[0].runtime, { phase: 'completed', threadActivity: 'idle', turnId: 'late-old-run' });
  await page.evaluate(key => window.fixtureEvent({ type: 'run.updated', sessionKey: key, createdAt: Date.now() }), sessions[0].sessionKey);
  await page.waitForFunction(() => window.__agentopsdeckCompletionDiagnostics.read()
    .some(e => e.stage === 'observe' && e.facts.reason === 'stale-terminal-before-run'));
  assert.equal(await pane(0).getAttribute('data-completed'), 'false', 'late old terminal cannot celebrate');
  assert.equal(await pane(0).evaluate(el => getComputedStyle(el).animationName), 'none');
  Object.assign(sessions[0], { runStartedAt: 200, runCompletedAt: 250 });
  sessions[0].runtime.turnId = 'new-observed-run';
  await page.evaluate(key => window.fixtureEvent({ type: 'run.updated', sessionKey: key, createdAt: Date.now() }), sessions[0].sessionKey);
  await pane(0).locator('css=:scope[data-completed="true"]').waitFor();
  assert.equal(await pane(0).evaluate(el => getComputedStyle(el).animationName), 'pane-heartbeat', 'real completion still gets attention');
  console.log('Stale terminal / witnessed run completion PASS');
  await page.screenshot({ path: '/tmp/agentopsdeck-232-c-polish.png', fullPage: true });
  assert.deepEqual(errors, []); assert.deepEqual(writes, []); assert.deepEqual(external, []);
  console.log('C polish PASS: state borders, half-area focus/backdrop, caption popovers, narrow tool circles, one-line footer, scroll/type/selection, cancellation/degradation/recovery/HTTP200 sync error; zero writes/tool reads/external requests.');
  await context.close();
} finally { await browser?.close(); await server.close(); }
