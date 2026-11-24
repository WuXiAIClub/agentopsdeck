import { resourceCaption } from './resource-caption.mjs';
// Isolated real UI -> Hub API -> Playwright WebSocket -> Chromium. All website
// content is synthetic, including DENY/frame-ancestors; no production credentials.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { HubStore } from '../../server/src/hub/hub-store.ts';
import { loadConfig } from '../../server/src/config.ts';
import { registerHubRoutes } from '../../server/src/routes/hub.ts';
import { registerHubBrowser } from '../../server/src/routes/hub-workspace-browser.ts';
import { WorkspaceBrowser } from '../../server/src/hub/workspace-browser.ts';
import { presetWorkspace } from '../src/lib/workspace-layout.ts';
import { layoutSnapshot } from '../src/lib/current-layout.ts';
const require = createRequire(new URL('../../server/package.json', import.meta.url));
const { Hono } = require('hono'), { serve } = require('@hono/node-server'), { serveStatic } = require('@hono/node-server/serve-static');
const { chromium } = require('playwright-core');
const directory = await mkdtemp(join(tmpdir(), 'agentopsdeck-browser-card-'));
const hub = new HubStore(join(directory, 'hub.sqlite'), 'synthetic'), principal = { userId: 'default', admin: true };
const launch = { executablePath: process.env.AOD_TEST_CHROMIUM, headless: true };
const runtime = await chromium.launchServer({ ...launch, host: '127.0.0.1', port: 0 });
const remoteBrowsers = [], calls = [], errors = [], forbidden = [];
const service = new WorkspaceBrowser({ endpoint: runtime.wsEndpoint(), users: ['default'], hosts: ['learn.microsoft.com', 'www.bing.com'] }, async endpoint => {
  const browser = await chromium.connect(endpoint); remoteBrowsers.push(browser); return browser;
});
const app = new Hono();
app.use('*', async (c, next) => { if (c.req.path.includes('/workspace/browser')) calls.push(`${c.req.method} ${c.req.path}`); await next(); });
const browsers = registerHubBrowser(app, { service, principal: () => principal, audit: hub.identities.audit });
const routes = registerHubRoutes(app, { config: loadConfig({ HOME: directory, AOD_SERVER_ROLE: 'hub' }), hubStore: hub,
  principal: () => principal, normalizeError: () => 'Synthetic', connectorClient: () => { throw Error('Browser must never contact Connector or chat'); } });
const pane = { id: 'browser-pane', kind: 'browser', resourceId: '78c84d16-5689-4210-81ed-c2d48ff55f3d' };
hub.layouts.save('default', 'current', { revision: 0, content: JSON.stringify(layoutSnapshot(presetWorkspace([pane], 'single'), new Set())) });
app.use('/*', serveStatic({ root: 'apps/web/dist' }));
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }); if (!server.listening) await once(server, 'listening');
let ui;
let configReply = { status: 404, json: {} };
try {
  const origin = `http://127.0.0.1:${server.address().port}`;
  ui = await chromium.launch(launch);
  const context = await ui.newContext({ viewport: { width: 1280, height: 960 } });
  await context.addInitScript(() => {
    localStorage.setItem('agentopsdeck.locale', 'en');
    window.EventSource = class extends EventTarget { readyState = 1; static OPEN = 1; constructor() { super(); queueMicrotask(() => this.onopen?.(new Event('open'))); } close() { this.readyState = 2; } };
  });
  await context.route('**/*', route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin !== origin) { forbidden.push(url.href); return route.abort(); }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    if (url.pathname === '/api/hub/v1/workspace/browser/config' && configReply) return route.fulfill(configReply);
    if (url.pathname.startsWith('/api/hub/v1/workspace/') || url.pathname.startsWith('/api/hub/v1/notebooks')) return route.continue();
    const json = value => route.fulfill({ json: value });
    if (req.method() !== 'GET') { forbidden.push(`${req.method()} ${url.pathname}`); return route.abort(); }
    if (url.pathname === '/api/auth/status') return json({ authenticated: true, recoveryScope: hub.identities.recoveryScope(principal), passkeys: { available: false, count: 0 } });
    if (url.pathname.endsWith('/sessions/state')) return json({ revision: '1', groups: [] });
    if (url.pathname === '/api/agents') return json({ agents: [] });
    if (url.pathname === '/api/gateway/status') return json({ connected: true });
    if (url.pathname === '/api/hub/v1/connections') return json({ connections: [] });
    return route.fulfill({ status: 404, json: {} });
  });
  const page = await context.newPage(); page.setDefaultTimeout(20_000); page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin);
  const panel = page.getByRole('region', { name: 'Browser card', exact: true }); await panel.waitFor();
  for (const [reply, message] of [
    [{ status: 404, json: {} }, 'This Hub version does not provide the browser service yet. Update the Hub backend, then retry.'],
    [{ status: 403, json: {} }, 'Browser access is not authorized for this account. Ask the Hub operator to grant access.'],
    [{ status: 503, json: {} }, 'Browser configuration could not be loaded. Check the connection and retry; no browser was started.'],
    [{ status: 200, json: {} }, 'Browser configuration could not be loaded. Check the connection and retry; no browser was started.'],
    [{ status: 200, json: { enabled: false, hosts: [] } }, 'The card is ready, but browser runtime or account access has not been enabled on this Hub.'],
  ]) {
    configReply = reply;
    await panel.getByRole('button', { name: 'Retry', exact: true }).click();
    await panel.getByText(message, { exact: true }).waitFor();
    assert.equal(await panel.getByText('Loading…', { exact: true }).count(), 0, 'failed config must stop loading');
    assert.equal(remoteBrowsers.length, 0, 'config retry never starts a browser');
  }
  const colors = await panel.evaluate(node => ({
    background: getComputedStyle(node).backgroundColor, color: getComputedStyle(node).color,
    hostBackground: getComputedStyle(node.closest('[data-workspace-pane]')).backgroundColor,
  }));
  assert.equal(colors.background, 'rgb(255, 254, 250)', 'opaque themed browser background');
  assert.equal(colors.hostBackground, colors.background, 'all resource hosts have a solid backing');
  assert.notEqual(colors.color, 'rgb(226, 232, 240)', 'not pale text on a light surface');
  configReply = undefined;
  await panel.getByText('Browser setup required', { exact: true }).waitFor();
  await panel.getByText('An operator must connect an isolated browser runtime and configure allowed users and websites. Refreshing this card cannot enable the service.').waitFor();
  await panel.getByRole('button', { name: 'Check configuration again', exact: true }).click();
  assert.equal(remoteBrowsers.length, 0, 'layout restoration cannot start a browser');
  await panel.getByRole('button', { name: 'Start browser', exact: true }).click();
  await panel.getByRole('img', { name: 'Interactive browser page' }).waitFor();
  assert.equal(remoteBrowsers.length, 1);
  const remote = remoteBrowsers[0], remoteContext = remote.contexts()[0], remotePage = remoteContext.pages()[0];
  await remoteContext.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'learn.microsoft.com' || url.hostname === 'www.bing.com') return route.fulfill({ contentType: 'text/html', headers: { 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'" }, body: `<!doctype html><html><head><title>${url.hostname === 'www.bing.com' ? 'Search fixture' : 'Learn fixture'}</title></head><body style="margin:0;font:18px sans-serif;background:white;color:black;height:2400px"><input aria-label="Query" style="position:absolute;left:20px;top:20px;width:400px;height:40px"><button style="position:absolute;left:20px;top:90px;width:120px;height:40px" onclick="document.title='Clicked'">Click test</button><a style="position:absolute;left:20px;top:160px" href="https://www.bing.com/search?q=fixture">Search fixture</a><script>document.querySelector('input').addEventListener('keydown',e=>{if(e.key==='Enter') document.title='Entered:'+e.target.value;});</script></body></html>` });
    return route.fallback();
  });
  const address = (await resourceCaption(panel)).getByRole('textbox', { name: 'Website address', exact: true });
  await address.fill('learn.microsoft.com'); await (await resourceCaption(panel)).getByRole('button', { name: 'Go to website' }).click();
  await remotePage.waitForURL('https://learn.microsoft.com/'); await panel.getByText('Learn fixture', { exact: true }).waitFor();
  const image = panel.getByRole('img', { name: 'Interactive browser page' });
  const clickRemote = async (x, y) => { const r = await image.boundingBox(); await image.click({ position: { x: x / 1024 * r.width, y: y / 720 * r.height } }); };
  await clickRemote(80, 40);
  // Rapid direct keyboard events must serialize, not disappear while a frame or
  // earlier input is in flight. The explicit IME field then replaces selection.
  await page.keyboard.type('abc');
  await remotePage.waitForFunction(() => document.querySelector('input').value === 'abc');
  await page.keyboard.press('Control+A');
  const text = panel.getByRole('textbox', { name: 'Type into website' });
  await text.fill('中文 BROWSER_VERIFIED'); await panel.getByRole('button', { name: 'Insert text' }).click();
  await remotePage.waitForFunction(() => document.querySelector('input').value === '中文 BROWSER_VERIFIED');
  await panel.getByRole('button', { name: '↵', exact: true }).click();
  await remotePage.waitForFunction(() => document.title === 'Entered:中文 BROWSER_VERIFIED');
  await clickRemote(60, 110); await remotePage.waitForFunction(() => document.title === 'Clicked');
  await clickRemote(70, 169); await remotePage.waitForURL('https://www.bing.com/search?q=fixture');
  await page.waitForFunction(() => document.querySelector('input[aria-label="Website address"]').value === 'https://www.bing.com/search?q=fixture');
  await (await resourceCaption(panel)).getByRole('button', { name: 'Back', exact: true }).click(); await remotePage.waitForURL('https://learn.microsoft.com/');
  await (await resourceCaption(panel)).getByRole('button', { name: 'Forward', exact: true }).click(); await remotePage.waitForURL('https://www.bing.com/search?q=fixture');
  await panel.getByRole('button', { name: 'Scroll page down' }).click(); await remotePage.waitForFunction(() => window.scrollY > 0);
  await (await resourceCaption(panel)).getByRole('button', { name: 'Refresh website' }).click(); await remotePage.waitForFunction(() => document.title === 'Search fixture');
  const denied = await remotePage.evaluate(() => fetch('https://127.0.0.1/private').then(() => false, () => true)); assert.equal(denied, true);
  // Page popups never become unowned browsing contexts.
  await remotePage.evaluate(() => { window.open('https://learn.microsoft.com/popup'); });
  await page.waitForTimeout(200); assert.equal(remoteContext.pages().length, 1);
  const card = panel.locator('..').locator('..');
  await card.getByRole('button', { name: 'Float pane', exact: true }).click();
  assert.equal(remoteBrowsers.length, 1, 'floating keeps the exact browser context');
  await card.getByRole('button', { name: 'Dock pane', exact: true }).click();
  // The existing mobile shell does not render workspace cards. Exercise a narrow
  // desktop card without claiming mobile workspace support.
  await panel.evaluate(node => { node.style.width = '300px'; });
  const overflow = await panel.evaluate(node => node.scrollWidth > node.clientWidth + 2); assert.equal(overflow, false, 'narrow card has no horizontal overflow');
  await panel.evaluate(node => { node.style.removeProperty('width'); });
  const storage = await page.evaluate(() => JSON.stringify({ ...localStorage }));
  assert.ok(!storage.includes('BROWSER_VERIFIED')); assert.ok(!storage.includes('search?q=fixture'));
  await (await resourceCaption(panel)).getByRole('button', { name: 'Close browser', exact: true }).click();
  await panel.getByRole('button', { name: 'Start browser', exact: true }).waitFor();
  await page.waitForTimeout(300); assert.equal(remote.isConnected(), false);
  const count = calls.length; await page.waitForTimeout(1500); assert.equal(calls.length, count, 'closed browser has no polling');
  await page.reload(); await panel.waitFor(); assert.equal(remoteBrowsers.length, 1, 'refresh cannot replay start/navigation/input');
  await panel.getByRole('button', { name: 'Start browser', exact: true }).click();
  await panel.getByRole('img', { name: 'Interactive browser page' }).waitFor();
  const mobileClosed = remoteBrowsers[1];
  await page.setViewportSize({ width: 390, height: 800 });
  await panel.waitFor({ state: 'detached' }); await page.waitForTimeout(300);
  assert.equal(mobileClosed.isConnected(), false, 'leaving the desktop workspace releases its browser');
  await page.setViewportSize({ width: 1280, height: 960 }); await panel.waitFor();
  assert.equal(remoteBrowsers.length, 2, 'returning to desktop cannot silently restart a browser');
  assert.deepEqual(errors, []); assert.deepEqual(forbidden, []);
  console.log(JSON.stringify({ verified: true, realRemoteChromium: true, syntheticWebsites: true, iframeDeny: true, chineseInput: true, navigation: true, privateLiteralRequestBlocked: true, cleanup: true, noReplay: true, noChatWrites: true, calls: calls.length }));
} finally {
  await ui?.close(); browsers.close(); await service.close(); routes.close(); await runtime.close();
  await new Promise(resolve => server.close(resolve)); hub.close(); await rm(directory, { recursive: true, force: true });
}
