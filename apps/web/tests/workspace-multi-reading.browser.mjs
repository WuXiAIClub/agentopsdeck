// Real built UI + isolated Hub routes. Providers and session inventory are synthetic.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { HubStore } from '../../server/src/hub/hub-store.ts';
import { registerHubResearchRoutes } from '../../server/src/routes/hub-workspace-research.ts';
import { WorkspaceResearch } from '../../server/src/hub/workspace-research.ts';
import { WorkspaceReader } from '../../server/src/hub/workspace-reader.ts';
import { WorkspaceSynthesis } from '../../server/src/hub/workspace-synthesis.ts';
import { WorkspaceArticleSnapshots } from '../../server/src/hub/workspace-article-snapshots.ts';
import { AuthAuditLog } from '../../server/src/auth/security.ts';
import { resourceCaption } from './resource-caption.mjs';
const require = createRequire(new URL('../../server/package.json', import.meta.url));
const { Hono } = require('hono'), { serve } = require('@hono/node-server'), { serveStatic } = require('@hono/node-server/serve-static');
const { chromium } = await import(pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href);
const directory = await mkdtemp(join(tmpdir(), 'agentopsdeck-multi-reading-'));
const store = new HubStore(join(directory, 'hub.sqlite'), 'synthetic');
const app = new Hono(), users = ['wide', 'small', 'tiny', 'errors', 'cancel', 'auth', 'pagehide'];
let userId = users[0], clock = 1000, reads = 0, fault = 0, slow = false, aborted = false, forged = false;
const calls = [], errors = [], forbidden = [], requests = [];
const bodyText = ['Private before. Selected 😀 passage. Private after.', 'Second article text. <img src="https://forbidden.example/test">'];
const search = new WorkspaceResearch({ searchUrl: 'https://search.example/', users,
  reader: { url: 'https://reader.example/', users, sourceOrigins: ['https://article.example'] }, synthesis: { url: 'https://ai.example/', users, model: 'fixture', token: 'synthetic-only' } },
  async () => Response.json({ results: bodyText.map((_, i) => ({ title: `Article ${i + 1}`, url: `https://article.example/${i}`, content: 'Snippet must not be sent' })) }), () => clock);
const reader = new WorkspaceReader({ url: 'https://reader.example/', users, sourceOrigins: ['https://article.example'] }, async (_url, init) => {
  const { url } = JSON.parse(init.body); reads++; return Response.json({ url, text: bodyText[Number(new URL(url).pathname.slice(1))], truncated: true });
}, () => clock);
const synthesis = new WorkspaceSynthesis({ url: 'https://ai.example/', users, model: 'fixture', token: 'synthetic-only' }, async (_url, init) => {
  const input = JSON.parse(init.body); calls.push(input);
  if (slow) return new Promise((_r, reject) => init.signal.addEventListener('abort', () => { aborted = true; reject(init.signal.reason); }, { once: true }));
  return Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({ paragraphs: [{ text: 'Combined summary', citations: ['S1', 'S2'] }], caveat: 'Unverified fixture' }) }] }] });
}, () => clock);
app.use('*', async (c, next) => {
  if (c.req.path.endsWith('/synthesize-many') && fault) { const code = fault; fault = 0; return c.json({ error: 'synthetic' }, code); }
  await next();
  if (forged && c.req.path.endsWith('/synthesize-many') && c.res.status === 200) { const value = await c.res.json(); value.evidence[0].start++; c.res = new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } }); }
});
const routes = registerHubResearchRoutes(app, { service: search, reader, synthesis, articles: new WorkspaceArticleSnapshots(() => clock), audit: new AuthAuditLog(), principal: () => ({ userId, admin: false }) });
app.use('/*', serveStatic({ root: resolve('apps/web/dist') }));
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }); if (!server.listening) await once(server, 'listening');
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.AOD_TEST_CHROMIUM });
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const [i, width] of [1440, 390, 240, 390, 390, 390, 390].entries()) {
    userId = users[i]; clock += 60001; slow = false; forged = false; fault = 0; aborted = false;
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
    await context.addInitScript(() => {
      localStorage.setItem('agentopsdeck.locale', 'en');
      window.EventSource = class extends EventTarget { readyState = 1; static OPEN = 1; constructor() { super(); queueMicrotask(() => this.onopen?.(new Event('open'))); } close() { this.readyState = 2; } };
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw Error('denied'); } } });
    });
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin !== origin) { forbidden.push(url.origin); return route.abort(); }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      requests.push(url.pathname);
      if (url.pathname.startsWith('/api/hub/v1/workspace/research')) return route.continue();
      const json = value => route.fulfill({ json: value });
      if (url.pathname === '/api/auth/status') return json({ authenticated: true, recoveryScope: store.identities.recoveryScope({ userId, admin: false }), passkeys: { available: false, count: 0 } });
      if (url.pathname.endsWith('/sessions/state')) return json({ revision: '1', groups: [] });
      if (url.pathname === '/api/agents') return json({ agents: [] });
      if (url.pathname === '/api/gateway/status') return json({ connected: true });
      if (url.pathname === '/api/hub/v1/connections') return json({ connections: [] });
      if (req.method() !== 'GET' && !url.pathname.includes('/workspace/layouts/') && !url.pathname.endsWith('/workspace/preferences')) forbidden.push(req.method() + url.pathname);
      return route.fulfill({ status: 404, json: {} });
    });
    const page = await context.newPage(); page.setDefaultTimeout(12000); page.on('pageerror', e => errors.push(e.message));
    await page.goto(origin); await page.getByLabel('Layout presets', { exact: true }).click();
    await page.getByRole('button', { name: 'Search and sources · Preview', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Search and sources · Preview', exact: true });
    const caption = await resourceCaption(panel), dock = caption.getByRole('button', { name: 'Dock pane', exact: true }); if (await dock.count()) await dock.click();
    const pane = panel.locator('xpath=ancestor::*[@data-workspace-pane][1]');
    if (width !== 1440) await pane.evaluate((el, w) => { el.style.width = `${w}px`; }, width);
    await panel.getByRole('checkbox', { name: 'Auto answer', exact: true }).uncheck();
    await panel.getByRole('textbox', { name: 'Search query', exact: true }).fill('Reading question');
    await panel.getByRole('button', { name: 'Search', exact: true }).click();
    await panel.getByRole('button', { name: 'Adjust sources', exact: true }).click();
    await panel.getByLabel('Select source S1', { exact: true }).check(); await panel.getByLabel('Select source S2', { exact: true }).check();
    const before = reads, beforeAi = calls.length;
    await panel.getByRole('button', { name: 'Read multiple articles', exact: true }).click();
    const multi = panel.getByRole('region', { name: 'Read multiple articles', exact: true });
    assert.equal(reads, before); assert.equal(calls.length, beforeAi);
    await multi.getByRole('button', { name: 'Read selected articles', exact: true }).click();
    const first = multi.getByLabel('Extracted article text S1', { exact: true }); await first.waitFor();
    assert.equal(reads, before + 2); assert.equal(calls.length, beforeAi);
    await first.evaluate(el => { const start = el.value.indexOf('Selected'), end = el.value.indexOf(' Private after'); el.focus(); el.setSelectionRange(start, end); el.dispatchEvent(new Event('select')); });
    await page.waitForFunction(() => document.querySelector('select[aria-label="Reading scope S1"]')?.value === 'selection');
    const send = multi.getByRole('button', { name: 'Summarize selected articles', exact: true });
    assert.equal(await send.isDisabled(), false); assert.equal(await multi.getByRole('checkbox').count(), 0);
    if (i >= 4) slow = true;
    await send.click();
    if (i >= 4) {
      await page.waitForTimeout(100); assert.equal(calls.length, beforeAi + 1);
      if (i === 4) await multi.getByRole('button', { name: 'Close article', exact: true }).click();
      else await page.evaluate(name => window.dispatchEvent(new Event(name)), i === 5 ? 'agentopsdeck:auth-required' : 'pagehide');
      for (let n = 0; n < 40 && !aborted; n++) await page.waitForTimeout(25);
      assert.equal(aborted, true); assert.equal(await panel.getByText('Combined summary', { exact: true }).count(), 0);
      if (i !== 4) assert.equal(await panel.getByLabel('Extracted article text S1', { exact: true }).count(), 0);
    } else {
      await multi.getByText('Combined summary', { exact: false }).waitFor();
      const input = JSON.parse(calls.at(-1).input[0].content); assert.deepEqual(input.sources.map(s => s.text), ['Selected 😀 passage.', bodyText[1]]);
      assert.ok(!JSON.stringify(calls.at(-1)).includes('Private before')); assert.ok(!JSON.stringify(calls.at(-1)).includes('Snippet must not be sent'));
      await multi.locator('.workspace-research-answer').getByRole('button', { name: 'S2', exact: true }).click();
      await page.waitForTimeout(80); assert.equal(await multi.locator('.workspace-research-answer').count(), 1);
      await multi.getByRole('button', { name: 'Copy synthesis and cited snippets', exact: true }).click();
      const copied = JSON.parse(await multi.getByLabel('Source text for manual copy', { exact: true }).inputValue());
      assert.deepEqual(copied.sources.map(s => s.text), ['Selected 😀 passage.', bodyText[1]]); assert.equal(copied.summary.verified, false);
      assert.equal(await multi.locator('img,script,iframe').count(), 0);
      assert.equal(await multi.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, `overflow at ${width}`);
      await page.screenshot({ path: join(directory, `multi-${i}-${width}.png`) });
      if (i === 3) {
        for (const code of [429, 413, 409]) {
          fault = code; await send.click();
          await multi.getByRole('status').filter({ hasText: code === 429 ? 'budget' : code === 413 ? 'too large' : 'expired' }).waitFor();
          assert.equal(calls.length, beforeAi + 1); assert.equal(await send.isDisabled(), code === 409);
        }
        clock += 60001; await multi.getByRole('button', { name: 'Read selected articles', exact: true }).click(); await first.waitFor();
        forged = true; await send.click(); await multi.getByText('AI reading failed. No automatic retry; you can try again manually.').waitFor();
        assert.equal(await multi.locator('.workspace-research-answer').count(), 0); forged = false;
        fault = 404; await send.click(); await multi.getByText('AI reading unavailable. Check permissions and refresh the card.').waitFor();
        assert.equal(await multi.getByRole('button', { name: 'Read selected articles', exact: true }).isDisabled(), true);
        assert.equal(await first.count(), 0);
      }
    }
    await context.close(); console.log(`multi reading ${users[i]} width=${width} passed`);
  }
  assert.deepEqual(errors, []); assert.deepEqual(forbidden, []); console.log(`Multi-reading browser passed; screenshots ${directory}`);
} finally {
  await browser?.close(); routes.close(); await new Promise(r => server.close(r)); store.close();
  for (const file of ['hub.sqlite', 'hub.sqlite-wal', 'hub.sqlite-shm']) await rm(join(directory, file), { force: true });
}
