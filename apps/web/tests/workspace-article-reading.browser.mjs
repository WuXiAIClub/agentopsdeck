// Built application + real isolated Hub HTTP routes + synthetic extraction/AI servers.
// No production data, real search/model requests, or Connector operations.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { HubStore } from '../../server/src/hub/hub-store.ts';
import { loadConfig } from '../../server/src/config.ts';
import { registerHubRoutes } from '../../server/src/routes/hub.ts';
import { resourceCaption } from './resource-caption.mjs';
import { DEFAULT_HUB_NOTEBOOK_LAYOUT } from '../../../packages/shared/src/session-notebook.ts';
import { verifyReadingNotebook } from './reading-notebook.browser.mjs';
const require = createRequire(new URL('../../server/package.json', import.meta.url));
const { Hono } = require('hono'), { serve } = require('@hono/node-server');
const { serveStatic } = require('@hono/node-server/serve-static');
const { chromium } = await import(pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href);
const directory = await mkdtemp(join(tmpdir(), 'agentopsdeck-article-browser-'));
const text = 'Private prefix.\n' + 'Long article context.\n'.repeat(100) + 'Selected 😀 passage. <img src="https://forbidden.example/track">\nPrivate suffix.';
const errors = [], forbidden = [], inputs = [];
let aiMode = 'valid', readerText = text, aiCloses = 0, readCount = 0, nextStatus = 0;
let notebookFailure = false;
const notebookWrites = [];
const provider = createServer(async (req, res) => {
  if (req.url === '/models') {
    assert.equal(req.method, 'GET'); assert.equal(req.headers.authorization, 'Bearer synthetic-ai');
    assert.equal(req.headers.cookie, undefined);
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'fixture-model' }] })); return;
  }
  assert.equal(req.method, 'POST'); assert.equal(req.headers.cookie, undefined);
  let raw = ''; for await (const chunk of req) raw += chunk;
  if (req.url === '/extract') {
    readCount++; const input = JSON.parse(raw); assert.equal(input.redirects, false); assert.equal(input.url, 'https://article.example/a');
    assert.equal(req.headers.authorization, 'Bearer synthetic-reader');
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ url: input.url, text: readerText, truncated: true })); return;
  }
  if (req.url === '/responses') {
    const input = JSON.parse(raw); inputs.push(input); assert.equal(input.store, false); assert.deepEqual(input.tools, []);
    assert.equal(req.headers.authorization, 'Bearer synthetic-ai');
    if (aiMode === 'slow') { res.once('close', () => aiCloses++); res.writeHead(200, { 'content-type': 'application/json' }); res.write('{'); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({ paragraphs: [{ text: 'Article summary. <img src="https://forbidden.example/ai">', citations: [aiMode === 'invalid' ? 'S8' : 'S1'] }], caveat: 'Unverified extracted passage.' }) }] }] })); return;
  }
  assert.equal(req.url, '/search'); res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ results: [{ title: 'Article title', url: 'https://article.example/a', content: 'Search snippet, not the article.' }] }));
});
provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
const hub = new HubStore(join(directory, 'hub.sqlite'), 'synthetic');
const users = ['desktop', 'mobile', 'narrow', 'recovery']; let principal = { userId: users[0], admin: true }, allowed = true;
const app = new Hono();
// Fault injection only for UI recovery cases; normal calls use the actual Hub route/service.
app.use('*', async (c, next) => {
  if (c.req.method === 'PUT' && /^\/api\/hub\/v1\/notebooks\/[^/]+$/.test(c.req.path)) {
    notebookWrites.push(c.req.path);
    if (notebookFailure) return c.json({ error: 'Synthetic storage failure' }, 503);
  }
  if (c.req.path.endsWith('/read/synthesize') && nextStatus) { const code = nextStatus; nextStatus = 0; return c.json({ error: 'synthetic' }, code); }
  await next();
});
const originOfProvider = `http://127.0.0.1:${provider.address().port}`;
const routes = registerHubRoutes(app, { config: loadConfig({ HOME: directory, AOD_SERVER_ROLE: 'hub', AOD_RESEARCH_ENABLED: 'true',
  AOD_RESEARCH_SEARCH_URL: originOfProvider + '/search', AOD_RESEARCH_ALLOW_HTTP: 'true', AOD_RESEARCH_USERS: users.join(','),
  AOD_RESEARCH_READER_ENABLED: 'true', AOD_RESEARCH_READER_URL: originOfProvider + '/extract', AOD_RESEARCH_READER_ALLOW_HTTP: 'true',
  AOD_RESEARCH_READER_USERS: users.join(','), AOD_RESEARCH_READER_TOKEN: 'synthetic-reader', AOD_RESEARCH_READER_SOURCE_ORIGINS: '["https://article.example"]',
  AOD_RESEARCH_AI_ENABLED: 'true', AOD_RESEARCH_AI_RESPONSES_URL: originOfProvider + '/responses', AOD_RESEARCH_AI_ALLOW_HTTP: 'true',
  AOD_RESEARCH_AI_USERS: users.join(','), AOD_RESEARCH_AI_MODEL: 'fixture-model', AOD_RESEARCH_AI_TOKEN: 'synthetic-ai' }),
  hubStore: hub, principal: () => allowed ? principal : undefined, normalizeError: () => 'Synthetic', connectorClient: () => { throw Error('No Connector operations'); } });
app.use('/*', serveStatic({ root: 'apps/web/dist' }));
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }); if (!server.listening) await once(server, 'listening');
let browser;
const until = async condition => { for (let i = 0; i < 100 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 25)); assert.ok(condition()); };
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.AOD_TEST_CHROMIUM });
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const [index, width] of [1440, 390, 320, 390].entries()) {
    principal = { userId: users[index], admin: true }; aiMode = 'valid'; readerText = text;
    const notebookIds = ['00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000102'];
    const originalNote = '# Existing notes\n\n- [x] Preserve **formatting**  \n\n';
    for (const id of notebookIds) {
      hub.notebooks.save(principal.userId, { resourceId: JSON.stringify(['hub-notebook-layout', 1, id]), revision: 0,
        text: JSON.stringify({ ...DEFAULT_HUB_NOTEBOOK_LAYOUT, title: 'Reading notebook' }) });
      hub.notebooks.save(principal.userId, { resourceId: JSON.stringify(['hub-notebook', 1, id]), revision: 0, text: originalNote });
    }
    // Create a workspace card through the desktop picker, then exercise its narrow-card layout.
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
    await context.addInitScript(() => {
      localStorage.setItem('agentopsdeck.locale', 'en');
      // Controlled browser APIs only; no microphone or external upload is used.
      window.SpeechRecognition = class {
        constructor() { window.testRecognition = this; }
        start() {}
        stop() { this.onend?.(); }
        abort() { this.onend?.(); }
      };
      const NativeReader = window.FileReader;
      window.FileReader = class extends NativeReader {
        readAsDataURL(file) {
          if (window.testHoldFileRead) window.testReleaseFileRead = () => super.readAsDataURL(file);
          else super.readAsDataURL(file);
        }
      };
      window.EventSource = class extends EventTarget { readyState = 1; static OPEN = 1; constructor() { super(); queueMicrotask(() => this.onopen?.(new Event('open'))); } close() { this.readyState = 2; } };
      // Simulate denied clipboard access to exercise the recoverable, inert manual-copy path.
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw Error('denied'); } } });
    });
    const sessionKeys = ['local:reading-a', 'local:reading-b'];
    let sessionLimit = 100000;
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin !== origin) { forbidden.push(url.origin); return route.abort(); }
      if (!url.pathname.startsWith('/api/') || url.pathname.startsWith('/api/hub/v1/workspace/research')) return route.continue();
      if (url.pathname.startsWith('/api/hub/v1/workspace/layouts/') || url.pathname === '/api/hub/v1/workspace/preferences' || url.pathname.startsWith('/api/hub/v1/notebooks')) {
        const response = await app.request(url.pathname, { method: req.method(), headers: req.headers(), ...(req.postData() ? { body: req.postData() } : {}) });
        return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
      }
      // Read-only completion lookup uses POST for its bounded session-key list; it cannot send a message.
      if (url.pathname === '/api/hub/v1/completions/summary' && req.method() === 'POST') {
        const body = req.postDataJSON(); assert.deepEqual(Object.keys(body), ['sessions']);
        assert.ok(Array.isArray(body.sessions) && body.sessions.every(key => sessionKeys.includes(key)));
        return route.fulfill({ json: { items: [] } });
      }
      if (req.method() !== 'GET') { forbidden.push(req.method() + ' ' + url.pathname); return route.abort(); }
      const json = body => route.fulfill({ json: body });
      if (url.pathname === '/api/auth/status') return json({ authenticated: allowed, recoveryScope: hub.identities.recoveryScope(principal), passkeys: { available: false, count: 0 } });
      if (url.pathname.endsWith('/sessions/state')) return json({ revision: '1', groups: index < 3 ? [{ agentId: 'codex', sessions: sessionKeys.map((sessionKey, n) => ({ sessionKey,
        envConnectionId: 'local', source: 'codex', agentId: 'codex', title: 'Same reading target', status: 'idle', hasActiveRun: false })) }] : [] });
      if (url.pathname.endsWith('/messages')) return json({ limits: { maxMessageChars: sessionLimit }, revision: String(sessionLimit), totalCount: 0, hiddenCount: 0, messages: [] });
      if (url.pathname.endsWith('/queue')) return json({ items: [], nextCursor: null });
      if (url.pathname === '/api/agents') return json({ agents: [{ id: 'codex', name: 'Codex' }] });
      if (url.pathname === '/api/gateway/status') return json({ connected: true });
      if (url.pathname === '/api/hub/v1/connections') return json({ connections: [] });
      return route.fulfill({ status: 404, json: {} });
    });
    const page = await context.newPage(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    if (index < 3) {
      for (const key of sessionKeys) {
        await page.locator(`[data-session-card="${key}"]`).click();
        const caption = await resourceCaption(page.locator(`[data-session-pane="${key}"]`));
        const dock = caption.getByRole('button', { name: 'Dock pane', exact: true });
        if (await dock.count()) await dock.click();
      }
      await page.locator('.desktop-composer-textarea').first().waitFor({ state: 'attached' });
    }
    await page.getByLabel('Layout presets', { exact: true }).click();
    await page.getByRole('button', { name: 'Search and sources · Preview', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Search and sources · Preview', exact: true });
    await panel.waitFor();
    const panelCaption = await resourceCaption(panel);
    const dockPanel = panelCaption.getByRole('button', { name: 'Dock pane', exact: true });
    if (await dockPanel.count()) await dockPanel.click();
    if (width !== 1440) await panel.locator('xpath=ancestor::*[@data-workspace-pane][1]').evaluate((element, width) => { element.style.width = width + 'px'; }, width);
    await panel.getByRole('checkbox', { name: 'Auto answer', exact: true }).uncheck();
    await panel.getByRole('textbox', { name: 'Search query', exact: true }).fill('Article question');
    await panel.getByRole('button', { name: 'Search', exact: true }).click();
    await panel.getByRole('button', { name: 'Open article reader', exact: true }).click();
    const article = panel.getByRole('region', { name: 'Article reader', exact: true });
    const before = inputs.length, beforeReads = readCount;
    await article.getByRole('button', { name: 'Read this article', exact: true }).click();
    const content = article.getByRole('textbox', { name: 'Extracted article text', exact: true }); await content.waitFor();
    assert.equal(inputs.length, before); assert.equal(readCount, beforeReads + 1);
    await article.getByRole('button', { name: 'AI article reading', exact: true }).click();
    const controls = article.getByRole('region', { name: 'AI article reading', exact: true });
    const send = controls.getByRole('button', { name: 'Summarize text', exact: true });
    assert.equal(await send.isDisabled(), false); assert.equal(await controls.getByRole('checkbox').count(), 0);
    if (index < 3) {
      await send.click(); await article.getByRole('region', { name: 'Article summary', exact: true }).waitFor();
      assert.equal(JSON.parse(inputs.at(-1).input[0].content).sources[0].text, text.trim());
      const start = text.indexOf('Selected'), end = text.indexOf('\nPrivate suffix');
      // Real keyboard selection drives the same events as users; no synthetic application state hooks.
      await content.focus(); await page.keyboard.press('Control+End'); await page.keyboard.press('Home');
      await page.keyboard.press('ArrowLeft'); await page.keyboard.press('Shift+Home');
      await page.waitForFunction(() => document.querySelector('[aria-label="Reading scope"]').value === 'selection');
      await send.click();
      const summary = article.getByRole('region', { name: 'Article summary', exact: true }); await summary.waitFor();
      assert.equal(JSON.parse(inputs.at(-1).input[0].content).sources[0].text, text.slice(start, end));
      await content.evaluate(element => { element.scrollTop = 0; });
      await summary.getByRole('button', { name: 'Locate cited passage', exact: true }).click();
      assert.equal(await content.evaluate(element => element.value.slice(element.selectionStart, element.selectionEnd)), text.slice(start, end));
      assert.ok(await content.evaluate(element => element.scrollTop > element.clientHeight), 'deep citation must scroll within the article, not merely focus it');
      await summary.getByRole('button', { name: 'Copy summary and cited text', exact: true }).click();
      const manual = article.getByRole('textbox', { name: 'Source text for manual copy', exact: true });
      const copied = JSON.parse(await manual.inputValue());
      assert.equal(copied.source.text, text.slice(start, end)); assert.equal(copied.source.url, 'https://article.example/a');
      assert.equal(copied.source.scope, 'selection'); assert.equal(copied.summary.verified, false);
      assert.ok(!(await manual.inputValue()).includes('Private prefix')); assert.equal(inputs.length, before + 2);
      await article.getByRole('button', { name: 'Close', exact: true }).click();
      await verifyReadingNotebook({ page, summary, copied, notebookIds, originalNote, width, index,
        read: id => hub.notebooks.get(principal.userId, JSON.stringify(['hub-notebook', 1, id])),
        writes: () => notebookWrites.length, failure: value => { notebookFailure = value; } });
      assert.equal(inputs.length, before + 2, 'notebook transfer never calls AI');
      // Reading -> explicitly selected live session composer. No message route is permitted.
      const urlBefore = page.url();
      await summary.getByRole('button', { name: 'Place reading in a session draft', exact: true }).click();
      const transfer = summary.getByRole('region', { name: 'Place reading in a session draft', exact: true });
      const target = transfer.getByRole('combobox', { name: 'Target session', exact: true });
      const confirm = transfer.getByRole('button', { name: 'Confirm: place in session draft', exact: true });
      const options = await target.locator('option').evaluateAll(nodes => nodes.filter(node => node.value).map(node => ({ id: node.value, title: node.textContent })));
      assert.equal(options.length, 2); assert.equal(await confirm.isDisabled(), true);
      assert.ok(options.every(option => /^#\d+ · Same reading target · codex$/.test(option.title)));
      assert.notEqual(options[0].title, options[1].title);
      const preview = await transfer.getByRole('textbox', { name: 'Reading draft preview', exact: true }).inputValue();
      assert.deepEqual(JSON.parse(preview), copied);
      const editors = page.locator('.desktop-composer-textarea');
      if (index === 0) {
        // Exercise the actual composer listener twice before React can commit.
        const results = await editors.nth(0).evaluate(input => {
          const first = { text: 'First synchronous draft', result: 'unavailable' };
          const second = { text: 'Do not overwrite', result: 'unavailable' };
          input.dispatchEvent(new CustomEvent('agentopsdeck:remote-draft', { detail: first }));
          input.dispatchEvent(new CustomEvent('agentopsdeck:remote-draft', { detail: second }));
          return [first.result, second.result, input.value];
        });
        assert.deepEqual(results, ['applied', 'occupied', 'First synchronous draft']);
      }
      // DOM order is stable across activation; preserve the first target's existing text.
      await editors.nth(0).evaluate(el => { el.closest('[data-workspace-pane]').dataset.hoverComposer = 'true'; });
      await editors.nth(0).fill('Existing user draft');
      await target.selectOption(options[0].id); await confirm.click();
      await transfer.getByText('The target already has text or attachments. Its draft was not changed.', { exact: true }).waitFor();
      assert.equal(await editors.nth(0).inputValue(), 'Existing user draft'); assert.equal(await editors.nth(1).inputValue(), '');
      if (index === 0) {
        await editors.nth(0).fill('');
        const firstSession = page.locator(`[data-session-pane="${sessionKeys[0]}"]`);
        const unavailable = transfer.getByText('Target unavailable. Select an open session and try again.', { exact: true });
        await firstSession.getByRole('button', { name: 'Start voice input', exact: true }).click();
        await firstSession.getByRole('button', { name: 'Stop voice input', exact: true }).waitFor();
        await confirm.click(); await unavailable.waitFor();
        assert.equal(await editors.nth(0).inputValue(), '');
        // Error resets the visible state before the recognizer releases its callbacks.
        await page.evaluate(() => window.testRecognition.onerror({ error: 'no-speech' }));
        await firstSession.getByRole('button', { name: 'Start voice input', exact: true }).waitFor();
        await confirm.click(); await unavailable.waitFor();
        assert.equal(await editors.nth(0).inputValue(), '');
        await page.evaluate(() => window.testRecognition.onend());
        await confirm.click();
        await transfer.getByText('Draft placed. Review it in the target session before sending.', { exact: true }).waitFor();
        await page.evaluate(() => window.testRecognition.onresult({ results: [[{ transcript: 'Late voice overwrite' }]] }));
        assert.equal(await editors.nth(0).inputValue(), preview);
        await editors.nth(0).fill('');
        await summary.getByRole('button', { name: 'Place reading in a session draft', exact: true }).click();
        await summary.getByRole('button', { name: 'Place reading in a session draft', exact: true }).click();
        await target.selectOption(options[0].id);
        // Inject a disabled DOM control, without claiming a server-side grant change.
        await editors.nth(0).evaluate(input => { input.disabled = true; });
        await confirm.click(); await unavailable.waitFor();
        assert.equal(await editors.nth(0).inputValue(), '');
        await editors.nth(0).evaluate(input => { input.disabled = false; });
        await page.evaluate(() => { window.testHoldFileRead = true; });
        await firstSession.locator('input[type="file"]').setInputFiles({ name: 'kept.txt', mimeType: 'text/plain', buffer: Buffer.from('Retain attachment') });
        await firstSession.getByText('Preparing attachments…', { exact: true }).waitFor();
        await confirm.click(); await unavailable.waitFor();
        assert.equal(await editors.nth(0).inputValue(), '');
        await page.evaluate(() => { window.testHoldFileRead = false; window.testReleaseFileRead(); });
        await firstSession.getByLabel('Pending attachments', { exact: true }).waitFor();
        await confirm.click();
        await transfer.getByText('The target already has text or attachments. Its draft was not changed.', { exact: true }).waitFor();
        assert.equal(await editors.nth(0).inputValue(), '');
        await firstSession.getByRole('button', { name: 'Remove kept.txt', exact: true }).click();
        await editors.nth(0).fill('Existing user draft');
        sessionLimit = 50;
        const secondCaption = await resourceCaption(page.locator(`[data-session-pane="${sessionKeys[1]}"]`));
        await secondCaption.getByRole('button', { name: 'Force refresh messages', exact: true }).click();
        await page.getByText('This Connector currently allows 50 characters. Upgrade it to support longer messages.', { exact: true }).first().waitFor();
        await target.selectOption(options[1].id); await confirm.click();
        await transfer.getByText('Reading exceeds this session’s message limit. Summarize a shorter passage or copy manually.', { exact: true }).waitFor();
        assert.equal(await editors.nth(1).inputValue(), '');
        sessionLimit = 100000;
        await (await resourceCaption(page.locator(`[data-session-pane="${sessionKeys[1]}"]`))).getByRole('button', { name: 'Force refresh messages', exact: true }).click();
        await page.locator(`[data-session-pane="${sessionKeys[1]}"]`).getByText('This Connector currently allows 50 characters. Upgrade it to support longer messages.', { exact: true }).waitFor({ state: 'hidden' });
      }
      await target.selectOption(options[1].id); await confirm.click();
      await transfer.getByText('Draft placed. Review it in the target session before sending.', { exact: true }).waitFor();
      assert.equal(await editors.nth(1).inputValue(), preview); assert.equal(await confirm.isDisabled(), true);
      assert.equal(page.url(), urlBefore); assert.equal(inputs.length, before + 2);
      // Closing/reopening the transfer form cannot bypass the target's occupied guard.
      await summary.getByRole('button', { name: 'Place reading in a session draft', exact: true }).click();
      await summary.getByRole('button', { name: 'Place reading in a session draft', exact: true }).click();
      assert.equal(await target.inputValue(), '');
      await target.selectOption(options[1].id); await confirm.click();
      await transfer.getByText('The target already has text or attachments. Its draft was not changed.', { exact: true }).waitFor();
      assert.equal(await editors.nth(1).inputValue(), preview);
      if (index === 0) {
        await target.selectOption(options[0].id);
        const firstCaption = await resourceCaption(page.locator(`[data-session-pane="${sessionKeys[0]}"]`));
        await firstCaption.getByRole('button', { name: 'Close pane', exact: true }).click();
        assert.equal(await confirm.isDisabled(), true);
        assert.equal(await target.inputValue(), '');
        assert.equal(await editors.inputValue(), preview);
      }
      assert.ok(await transfer.evaluate(el => el.scrollWidth <= el.clientWidth));
      await page.screenshot({ path: join(directory, `reading-transfer-${width}.png`) });
      await summary.getByRole('button', { name: 'Place reading in a session draft', exact: true }).click();
      if (index === 0) {
        await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.testCopiedReading = text; } } }));
        await summary.getByRole('button', { name: 'Copy summary and cited text', exact: true }).click();
        await article.getByText('Source copied', { exact: true }).waitFor();
        assert.deepEqual(JSON.parse(await page.evaluate(() => window.testCopiedReading)), copied);
        assert.equal(await manual.count(), 0);
      }
      assert.equal(await article.locator('img,script,iframe').count(), 0);
      assert.ok(await article.evaluate(element => element.scrollWidth <= element.clientWidth));
      assert.ok(await panel.evaluate(element => element.scrollWidth <= element.clientWidth));
      await page.screenshot({ path: join(directory, `article-${width}.png`), fullPage: true });
      if (index === 0) {
        aiMode = 'slow'; await send.click(); await until(() => inputs.length === before + 3);
        // While in flight, a different physical selection must not alter that submitted request.
        await content.focus(); await page.keyboard.press('Control+Home'); await page.keyboard.down('Shift');
        for (let i = 0; i < 7; i++) await page.keyboard.press('ArrowRight'); await page.keyboard.up('Shift');
        assert.equal(await content.evaluate(element => element.value.slice(element.selectionStart, element.selectionEnd)), 'Private');
        const closed = aiCloses; await controls.getByRole('button', { name: 'Cancel AI synthesis', exact: true }).click(); await until(() => aiCloses === closed + 1);
        await page.waitForFunction(() => document.querySelector('.workspace-reading-controls p')?.textContent === 'Private').catch(async error => {
          console.log(await content.evaluate(element => ({ start: element.selectionStart, end: element.selectionEnd, preview: document.querySelector('.workspace-reading-controls')?.textContent })));
          throw error;
        });
        assert.equal(await summary.count(), 0); await page.waitForTimeout(100); assert.equal(inputs.length, before + 3);
      }
    } else {
      // Response-side failures require an explicit retry, never silently resubmit or use stale results.
      nextStatus = 409; await send.click();
      await article.getByText('Article snapshot expired. Read the article again before sending.', { exact: true }).waitFor();
      assert.equal(await send.isDisabled(), true); await controls.getByRole('button', { name: 'Read this article', exact: true }).click();
      await page.waitForFunction(() => !document.body.textContent.includes('Article snapshot expired.'));
      aiMode = 'invalid'; await send.click();
      await article.getByText('AI reading failed. No automatic retry; you can try again manually.', { exact: true }).waitFor();
      assert.equal(await article.getByRole('region', { name: 'Article summary', exact: true }).count(), 0);
      nextStatus = 429; await send.click();
      await article.getByText('AI reading budget reached. Wait a minute before retrying.', { exact: true }).waitFor();
      nextStatus = 413; await send.click();
      await article.getByText('Selected text is too large. Select a shorter passage.', { exact: true }).waitFor();
      nextStatus = 403; await send.click();
      await article.getByText('AI reading unavailable. Check permissions and refresh the card.', { exact: true }).waitFor(); assert.equal(await send.isDisabled(), true);
      await article.getByRole('button', { name: 'Close article', exact: true }).click();
      readerText = '中'.repeat(11000); await panel.getByRole('button', { name: 'Open article reader', exact: true }).click();
      await article.getByRole('button', { name: 'Read this article', exact: true }).click(); await content.waitFor();
      await article.getByRole('button', { name: 'AI article reading', exact: true }).click();
      assert.equal(await send.isDisabled(), true);
      await content.focus(); await page.keyboard.press('Control+Home'); await page.keyboard.down('Shift');
      for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowRight'); await page.keyboard.up('Shift');
      await page.waitForFunction(() => document.querySelector('[aria-label="Reading scope"]').value === 'selection');
      aiMode = 'slow'; const count = inputs.length, closed = aiCloses; await send.click(); await until(() => inputs.length === count + 1);
      // Closing during a request aborts transport and leaves no late article state.
      await article.getByRole('button', { name: 'Close article', exact: true }).click(); await until(() => aiCloses === closed + 1); assert.equal(await article.count(), 0);
    }
    console.log(JSON.stringify({ width, scenario: index === 0 ? 'full-selection-citation-cancel' : index < 3 ? 'full-selection-citation' : 'expiry-errors-oversize-close', providerCalls: inputs.length - before }));
    if (index < 3) {
      const drafts = await page.locator('.desktop-composer-textarea').evaluateAll(nodes => nodes.map(node => node.value));
      await page.reload(); await page.locator('.desktop-composer-textarea').first().waitFor({ state: 'attached' });
      assert.deepEqual(await page.locator('.desktop-composer-textarea').evaluateAll(nodes => nodes.map(node => node.value)), drafts);
      if (index === 0) {
        const owner = principal;
        principal = { userId: 'reading-other-account', admin: true };
        await page.reload();
        // A new account has its own empty layout: explicitly open the same keys.
        for (const key of sessionKeys) await page.locator(`[data-session-card="${key}"]`).click();
        await page.locator('.desktop-composer-textarea').first().waitFor({ state: 'attached' });
        assert.ok((await page.locator('.desktop-composer-textarea').evaluateAll(nodes => nodes.map(node => node.value))).every(value => value === ''));
        principal = owner;
        await page.reload(); await page.locator('.desktop-composer-textarea').first().waitFor({ state: 'attached' });
        assert.deepEqual(await page.locator('.desktop-composer-textarea').evaluateAll(nodes => nodes.map(node => node.value)), drafts);
      }
    }
    await context.close();
  }
  assert.deepEqual(errors, []); assert.deepEqual(forbidden, []); console.log('Built browser article reading passed; no external requests or page errors. Screenshots: ' + directory);
} finally {
  await browser?.close(); routes.close(); await new Promise(resolve => server.close(resolve)); hub.close();
  provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
  // Keep only screenshots; SQLite fixtures are synthetic and removed individually.
  for (const file of ['hub.sqlite', 'hub.sqlite-wal', 'hub.sqlite-shm']) await rm(join(directory, file), { force: true });
}
