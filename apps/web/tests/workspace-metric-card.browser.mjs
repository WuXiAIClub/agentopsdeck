import { resourceCaption } from './resource-caption.mjs';
// Real isolated Hub store and browser; synthetic identity, no Agent/model calls.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { HubStore } from '../../server/src/hub/hub-store.ts';
import { loadConfig } from '../../server/src/config.ts';
import { registerHubRoutes } from '../../server/src/routes/hub.ts';
import { presetWorkspace } from '../src/lib/workspace-layout.ts';
import { layoutSnapshot } from '../src/lib/current-layout.ts';
const require = createRequire(new URL('../../server/package.json', import.meta.url));
const { Hono } = require('hono'), { serve } = require('@hono/node-server'), { serveStatic } = require('@hono/node-server/serve-static');
const { chromium } = await import(pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href);
const directory = await mkdtemp(join(tmpdir(), 'agentopsdeck-cards-browser-'));
const hub = new HubStore(join(directory, 'hub.sqlite'), 'synthetic'), principal = { userId: 'default', admin: true };
const id = randomUUID(), calls = [], errors = [], forbidden = [], mutations = [];
const app = new Hono();
app.use('*', async (c, next) => { if (c.req.path.includes('/workspace/cards')) calls.push(`${c.req.method} ${c.req.path}`); await next(); });
const routes = registerHubRoutes(app, { config: loadConfig({ HOME: directory, AOD_SERVER_ROLE: 'hub' }), hubStore: hub,
  principal: () => principal, normalizeError: () => 'Synthetic', connectorClient: () => { throw Error('No Connector access'); } });
hub.layouts.save('default', 'current', { revision: 0, content: JSON.stringify(layoutSnapshot(presetWorkspace([{ id: 'card-pane', kind: 'metric-card', resourceId: id }], 'single'), new Set())) });
app.use('/*', serveStatic({ root: 'apps/web/dist' }));
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }); if (!server.listening) await once(server, 'listening');
let browser, loseSave = false, rejectSave = false;
try {
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.AOD_TEST_CHROMIUM, headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, serviceWorkers: 'block' });
  await context.addInitScript(() => {
    localStorage.setItem('agentopsdeck.locale', 'en'); window.testEventSources = [];
    window.EventSource = class extends EventTarget { readyState = 1; static OPEN = 1; constructor() { super(); window.testEventSources.push(this); queueMicrotask(() => this.onopen?.(new Event('open'))); } close() { this.readyState = 2; } };
  });
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin !== origin) { forbidden.push(req.url()); return route.abort(); }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    if (url.pathname.includes('/workspace/cards') && req.method() === 'PUT') {
      mutations.push(req.postDataJSON().mutationId);
      if (rejectSave) { rejectSave = false; return route.fulfill({ status: 429, json: { error: 'limit' } }); }
      if (loseSave) { loseSave = false; await route.fetch(); return route.abort('failed'); }
    }
    if (url.pathname.startsWith('/api/hub/v1/workspace/') || url.pathname.startsWith('/api/hub/v1/notebooks')) return route.continue();
    const json = value => route.fulfill({ json: value });
    if (req.method() !== 'GET' || url.pathname.endsWith('/messages')) { forbidden.push(`${req.method()} ${url.pathname}`); return route.abort(); }
    if (url.pathname === '/api/auth/status') return json({ authenticated: true, recoveryScope: hub.identities.recoveryScope(principal), passkeys: { available: false, count: 0 } });
    if (url.pathname.endsWith('/sessions/state')) return json({ revision: '1', groups: [] });
    if (url.pathname === '/api/agents') return json({ agents: [] });
    if (url.pathname === '/api/gateway/status') return json({ connected: true });
    if (url.pathname === '/api/hub/v1/connections') return json({ connections: [] });
    return route.fulfill({ status: 404, json: {} });
  });
  const page = await context.newPage(); page.setDefaultTimeout(12000); page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', dialog => dialog.accept());
  const notify = () => page.evaluate(resources => { for (const source of window.testEventSources.filter(s => s.readyState === 1)) source.dispatchEvent(new MessageEvent('workspace.revisions', { data: JSON.stringify({ type: 'workspace.revisions', resourceType: 'metric-card', resources }) })); }, hub.cards.revisions('default'));
  await page.goto(origin); const panel = page.getByRole('region', { name: 'Custom status card', exact: true }); await panel.waitFor();
  // Check actual production CSS, including color-mix alpha and inherited text.
  const assertReadable = async () => {
    const samples = await panel.evaluate(root => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const rgba = color => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data]; };
      const luminance = rgb => rgb.slice(0, 3).map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }).reduce((s, v, i) => s + v * [.2126, .7152, .0722][i], 0);
      return [root, ...root.querySelectorAll('input:not([type="checkbox"]):not([type="range"]), textarea, button:not(:disabled), .metric-card-value, .metric-card-detail, [role="alert"]')].map(el => {
        const css = getComputedStyle(el), foreground = rgba(css.color), ownBackground = rgba(css.backgroundColor);
        const background = ownBackground[3] === 0 ? rgba(getComputedStyle(root).backgroundColor) : ownBackground;
        const a = luminance(foreground), b = luminance(background);
        return { element: el.tagName + '.' + el.className, alpha: background[3], textAlpha: foreground[3], contrast: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) };
      });
    });
    for (const sample of samples) {
      assert.equal(sample.alpha, 255, `opaque card/control surface: ${JSON.stringify(sample)}`);
      assert.equal(sample.textAlpha, 255);
      assert.ok(sample.contrast >= 4.5, `readable card text: ${JSON.stringify(sample)}`);
    }
  };
  await panel.getByLabel('Card title', { exact: true }).fill('Release readiness');
  await panel.getByLabel('Card value', { exact: true }).fill('7 / 10');
  await panel.getByLabel('Card description', { exact: true }).fill('<img src=x onerror=alert(1)> literal, no HTML');
  for (const colorScheme of ['light', 'dark']) {
    // The app currently has a light theme; OS dark preference must not break it.
    await page.emulateMedia({ colorScheme });
    for (const name of ['Neutral', 'Blue', 'Green', 'Yellow', 'Red', 'Purple']) {
      const choice = panel.getByRole('button', { name, exact: true }); await choice.click();
      assert.equal(await choice.getAttribute('aria-pressed'), 'true');
      await assertReadable();
    }
  }
  await panel.getByRole('button', { name: 'Green', exact: true }).click(); await panel.getByLabel('Show progress').check();
  await panel.getByLabel('Progress', { exact: true }).fill('70');
  await page.reload(); await panel.getByLabel('Card title', { exact: true }).waitFor();
  assert.equal(await panel.getByLabel('Card title', { exact: true }).inputValue(), 'Release readiness', 'draft restored on reload');
  await (await resourceCaption(panel)).getByRole('button', { name: 'Save card', exact: true }).click(); await panel.locator('.metric-card-value').waitFor();
  assert.equal(hub.cards.get('default', id).progress, 70); assert.equal(await panel.locator('img').count(), 0);
  await assertReadable();
  if (process.env.AOD_TEST_SCREENSHOT) await page.screenshot({ path: process.env.AOD_TEST_SCREENSHOT });
  const firstReads = calls.length; await page.waitForTimeout(2200); assert.equal(calls.length, firstReads, 'idle card never polls');
  await (await resourceCaption(panel)).getByRole('button', { name: 'Edit', exact: true }).click(); await panel.getByLabel('Card value', { exact: true }).fill('Local unsaved');
  const write = value => { const old = hub.cards.get('default', id); const { title, detail, tone, progress, revision } = old; assert.equal(hub.cards.save('default', id, { title, value, detail, tone, progress, revision, mutationId: randomUUID() }).status, 'saved'); };
  write('Other device'); await notify(); await panel.getByText('This card changed elsewhere. Your draft is preserved.', { exact: true }).waitFor();
  assert.equal(await panel.getByLabel('Card value', { exact: true }).inputValue(), 'Local unsaved');
  await (await resourceCaption(panel)).getByRole('button', { name: 'Save card', exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-resource-card] .session-pane-caption button')].some(b => b.getAttribute('aria-label') === 'Save card' && b.disabled));
  assert.equal(hub.cards.get('default', id).value, 'Other device');
  await (await resourceCaption(panel)).getByRole('button', { name: 'Discard changes', exact: true }).click(); await panel.getByRole('button', { name: 'Discard and reload', exact: true }).click();
  await panel.getByText('Other device', { exact: true }).waitFor();
  await (await resourceCaption(panel)).getByRole('button', { name: 'Edit', exact: true }).click(); await panel.getByLabel('Card value', { exact: true }).fill('Uncertain but saved');
  loseSave = true; await (await resourceCaption(panel)).getByRole('button', { name: 'Save card', exact: true }).click(); await (await resourceCaption(panel)).getByRole('button', { name: 'Retry same save', exact: true }).waitFor();
  const savedRevision = hub.cards.get('default', id).revision;
  await (await resourceCaption(panel)).getByRole('button', { name: 'Retry same save', exact: true }).click(); await panel.getByText('Uncertain but saved', { exact: true }).waitFor();
  assert.equal(mutations.at(-1), mutations.at(-2)); assert.equal(hub.cards.get('default', id).revision, savedRevision);
  await (await resourceCaption(panel)).getByRole('button', { name: 'Edit', exact: true }).click(); await panel.getByLabel('Card value', { exact: true }).fill('Quota rejection');
  rejectSave = true; await (await resourceCaption(panel)).getByRole('button', { name: 'Save card', exact: true }).click(); await panel.getByText('Card save was rejected. Your draft is preserved.', { exact: true }).waitFor();
  await assertReadable();
  assert.equal(await panel.getByLabel('Card value', { exact: true }).isEnabled(), true); await panel.getByLabel('Card value', { exact: true }).fill('Editable again');
  await (await resourceCaption(panel)).getByRole('button', { name: 'Save card', exact: true }).click(); await panel.getByText('Editable again', { exact: true }).waitFor();
  write('Remote automatic'); await notify(); await panel.getByText('Remote automatic', { exact: true }).waitFor();
  await page.reload(); await panel.getByText('Remote automatic', { exact: true }).waitFor();
  assert.deepEqual(errors, []); assert.deepEqual(forbidden, []);
  assert.ok(!(await page.evaluate(() => JSON.stringify({ ...localStorage }))).includes('literal, no HTML'));
  console.log(JSON.stringify({ verified: true, requests: calls.length, writes: mutations.length, readableTones: 6, systemColorSchemes: 2, opaqueSurfaces: true, minimumTextContrast: 4.5, draftReload: true, conflict: true, idempotentRetry: true, noIdlePoll: true, metadataRefresh: true, noChatReads: true }));
} finally { await browser?.close(); routes.close(); await new Promise(resolve => server.close(resolve)); hub.close(); await rm(directory, { recursive: true, force: true }); }
