// Isolated real HTTP Hub mailbox and SQLite; two independent browser devices.
// Synthetic identity/session data only; no production Key, Agent or microphone.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { HubStore } from '../../server/src/hub/hub-store.ts';
import { loadConfig } from '../../server/src/config.ts';
import { registerHubRoutes } from '../../server/src/routes/hub.ts';
import { encodeHubSessionId } from '../../server/src/hub/session-id.ts';
import { presetWorkspace } from '../src/lib/workspace-layout.ts';
import { layoutSnapshot } from '../src/lib/current-layout.ts';
const require = createRequire(new URL('../../server/package.json', import.meta.url));
const { Hono } = require('hono'), { serve } = require('@hono/node-server'), { serveStatic } = require('@hono/node-server/serve-static');
const { chromium } = await import(pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href);
const directory = await mkdtemp(join(tmpdir(), 'agentopsdeck-remote-browser-'));
const hub = new HubStore(join(directory, 'hub.sqlite'), 'synthetic'), principal = { userId: 'default', admin: true };
const app = new Hono(), errors = [], forbidden = [], remoteRequests = [], phoneRequests = [];
const sent = [];
let loseSend = false, receiptAvailable = false, failDirectory = false, directoryFailures = 0;
const receipt = key => ({ id: key, key, state: 'accepted', createdAt: 1, updatedAt: 2, result: { status: 200, body: { ok: true, status: 'queued' } } });
app.use('*', async (c, next) => { if (c.req.path.includes('/workspace/remote/')) remoteRequests.push(`${c.req.method} ${c.req.path}`); await next(); });
const routes = registerHubRoutes(app, { config: loadConfig({ HOME: directory, AOD_SERVER_ROLE: 'hub' }), hubStore: hub,
  principal: () => principal, normalizeError: () => 'Synthetic', connectorClient: () => { throw Error('No real Connector'); } });
const keys = ['one', 'two'].map(id => encodeHubSessionId('local', `codex:${id}`));
hub.layouts.save('default', 'current', { revision: 0, content: JSON.stringify(layoutSnapshot(presetWorkspace(keys.map((sessionKey, i) => ({ id: `pane-${i}`, sessionKey })), 'columns'), new Set())) });
app.use('/*', serveStatic({ root: 'apps/web/dist' }));
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
if (!server.listening) await once(server, 'listening');
let browser;
try {
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.AOD_TEST_CHROMIUM, headless: true });
  async function device(phone = false) {
    const context = await browser.newContext({ viewport: phone ? { width: 390, height: 844 } : { width: 1600, height: 1000 }, serviceWorkers: 'block' });
    await context.addInitScript(() => {
      localStorage.setItem('agentopsdeck.locale', 'en');
      window.EventSource = class extends EventTarget { readyState = 1; static OPEN = 1; constructor() { super(); queueMicrotask(() => this.onopen?.(new Event('open'))); } close() { this.readyState = 2; } };
    });
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin !== origin) { forbidden.push(req.url()); return route.abort(); }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      if (phone) phoneRequests.push(url.pathname);
      if (phone && failDirectory && url.pathname === '/api/hub/v1/workspace/remote/devices') {
        directoryFailures++; return route.fulfill({ status: 503, json: { error: 'Synthetic directory outage' } });
      }
      if (url.pathname.startsWith('/api/hub/v1/workspace/') || url.pathname.startsWith('/api/hub/v1/notebooks')) return route.continue();
      if (!phone && req.method() === 'POST' && url.pathname.endsWith('/messages')) {
        sent.push(req.postDataJSON());
        const key = req.postDataJSON().idempotencyKey;
        if (loseSend) return route.fulfill({ status: 503, json: { error: 'Synthetic uncertain delivery' } });
        const body = { ok: true, status: 'queued' };
        return route.fulfill({ json: { ...body, command: receipt(key) } });
      }
      if (!phone && req.method() === 'POST' && url.pathname === '/api/hub/v1/completions/summary') return route.fulfill({ json: { items: [] } });
      if (req.method() !== 'GET') { forbidden.push(`${req.method()} ${url.pathname}`); return route.abort(); }
      const json = value => route.fulfill({ json: value });
      if (url.pathname.includes('/commands/')) return receiptAvailable ? json({ command: receipt(decodeURIComponent(url.pathname.split('/').at(-1))) }) : route.fulfill({ status: 404, json: {} });
      if (url.pathname === '/api/auth/status') return json({ authenticated: true, recoveryScope: hub.identities.recoveryScope(principal), passkeys: { available: false, count: 0 } });
      if (url.pathname.endsWith('/sessions/state')) return json({ revision: '1', groups: [{ agentId: 'codex', sessions: keys.map((sessionKey, i) => ({ sessionKey, envConnectionId: 'local', source: 'codex', agentId: 'codex', title: `Session ${i + 1}`, status: 'idle' })) }] });
      if (url.pathname.endsWith('/messages')) return json({ limits: { maxMessageChars: 100000 }, revision: '1', totalCount: 1, hiddenCount: 0, messages: [{ id: 'm', role: 'assistant', text: 'Synthetic history', createdAt: 1, status: 'sent' }] });
      if (url.pathname.endsWith('/queue')) return json({ items: [], nextCursor: null });
      if (url.pathname === '/api/agents') return json({ agents: [] });
      if (url.pathname === '/api/gateway/status') return json({ connected: true });
      if (url.pathname === '/api/hub/v1/connections') return json({ connections: [] });
      return route.fulfill({ status: 404, json: {} });
    });
    const page = await context.newPage(); page.setDefaultTimeout(12000); page.on('pageerror', e => errors.push(e.message));
    await page.goto(origin + (phone ? '/#/remote' : '/')); return page;
  }
  const desktop = await device(); await desktop.locator('[data-remote-pane="pane-0"] .desktop-composer-textarea').waitFor({ state: 'attached' });
  assert.equal(remoteRequests.length, 0, 'disabled remote does not poll');
  await desktop.getByLabel('Phone remote', { exact: true }).click();
  await desktop.getByRole('button', { name: 'Enable remote control', exact: true }).click();
  await desktop.getByText('Remote ready', { exact: true }).waitFor();
  const phone = await device(true);
  try { await phone.getByLabel('Desktop device', { exact: true }).selectOption({ label: 'Desktop' }); }
  catch (error) { console.error({ url: phone.url(), body: await phone.locator('body').innerText(), errors, phoneRequests }); throw error; }
  await phone.getByRole('button', { name: 'Choose a panel', exact: true }).click();
  await phone.getByRole('textbox', { name: 'Search panels', exact: true }).fill('Session 2');
  await phone.locator('.remote-target-picker button').filter({ hasText: 'Session 2' }).click();
  await phone.getByText('Applied on desktop. Nothing sent to the Agent.', { exact: true }).waitFor();
  await desktop.waitForFunction(() => document.querySelector('[data-remote-pane="pane-1"]')?.getAttribute('data-active') === 'true');
  const draft = phone.getByRole('textbox', { name: 'Draft for selected panel', exact: true });
  const transfer = phone.getByRole('button', { name: 'Transfer draft', exact: true });
  await draft.fill('Phone draft, not an Agent command'); await transfer.click();
  await desktop.waitForFunction(() => document.querySelector('[data-remote-pane="pane-1"] .desktop-composer-textarea')?.value === 'Phone draft, not an Agent command');
  await phone.waitForFunction(() => document.querySelector('.workspace-phone-remote textarea')?.value === '');
  await draft.fill('Do not overwrite'); await transfer.click();
  await phone.getByText('Desktop input already has a draft. Nothing overwritten.', { exact: true }).waitFor();
  assert.equal(await desktop.locator('[data-remote-pane="pane-1"] .desktop-composer-textarea').inputValue(), 'Phone draft, not an Agent command');
  const send = phone.getByRole('button', { name: 'Send', exact: true });
  await send.click();
  await phone.getByText('Desktop input already has a draft. Nothing overwritten.', { exact: true }).waitFor();
  assert.equal(sent.length, 0);
  await desktop.locator('[data-remote-pane="pane-1"] .desktop-composer-textarea').fill('');
  failDirectory = true;
  await draft.fill('Send through normal admission'); await send.click();
  await phone.getByText('Message accepted. It may be queued while the Agent is busy.', { exact: true }).waitFor();
  assert.equal(sent.length, 1);
  assert.equal(await draft.inputValue(), '');
  await phone.waitForFunction(() => !document.querySelector('.remote-device-row button')?.disabled);
  assert.ok(directoryFailures > 0);
  await phone.getByText('Message accepted. It may be queued while the Agent is busy.', { exact: true }).waitFor();
  failDirectory = false;
  await phone.getByRole('button', { name: 'Refresh devices', exact: true }).click();
  for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 568 }, { width: 390, height: 420 }]) {
    await phone.setViewportSize(viewport);
    await phone.waitForFunction(() => document.querySelector('.workspace-phone-remote')?.getBoundingClientRect().height <= innerHeight);
    for (const control of [send, transfer, phone.getByRole('button', { name: 'Next panel', exact: true })]) {
      const box = await control.boundingBox();
      assert.ok(box && box.y >= 0 && box.y + box.height <= viewport.height, `control reachable at ${JSON.stringify(viewport)}: ${JSON.stringify(box)}`);
    }
  }
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.screenshot({ path: '/tmp/agentopsdeck-phone-remote-send.png' });
  // Unknown delivery never POSTs again without explicit confirmation.
  loseSend = true;
  await draft.fill('Synthetic unknown message'); await send.click();
  await phone.getByText('Result unconfirmed. Check the desktop; do not resend automatically.', { exact: true }).waitFor();
  assert.equal(sent.length, 2);
  const retry = desktop.locator('[data-remote-pane="pane-1"] article').getByRole('button', { name: 'Resend message', exact: true });
  await retry.click();
  await desktop.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(sent.length, 2, 'cancel never resends');
  await retry.click(); loseSend = false;
  await desktop.getByRole('dialog').getByRole('button', { name: 'Resend message', exact: true }).click();
  await desktop.waitForFunction(() => !document.querySelector('[data-remote-pane="pane-1"] article .message-resend-control'));
  assert.equal(sent.length, 3);
  assert.notEqual(sent[1].idempotencyKey, sent[2].idempotencyKey);
  const { idempotencyKey: oldKey, ...oldPayload } = sent[1], { idempotencyKey: nextKey, ...newPayload } = sent[2];
  assert.deepEqual(oldPayload, newPayload, 'manual resend preserves the exact message and delivery mode');
  // A settled receipt is recovered without creating another message.
  loseSend = true;
  const composer = desktop.locator('[data-remote-pane="pane-1"] .desktop-composer-textarea');
  await composer.fill('Synthetic settled delivery'); await composer.press('Enter');
  await retry.waitFor(); assert.equal(sent.length, 4);
  receiptAvailable = true; await retry.click();
  await desktop.waitForFunction(() => !document.querySelector('[data-remote-pane="pane-1"] article .message-resend-control'));
  assert.equal(sent.length, 4, 'confirmed original is not resent');
  loseSend = false;
  await desktop.getByRole('button', { name: 'Global notebook', exact: true }).click();
  await desktop.getByRole('button', { name: 'New notebook', exact: true }).click();
  await desktop.locator('[data-remote-notebook] .tiptap').waitFor();
  await desktop.waitForTimeout(350);
  await phone.getByRole('button', { name: 'Refresh devices', exact: true }).click();
  await phone.getByRole('button', { name: 'Choose a panel', exact: true }).click();
  await phone.locator('.remote-target-picker button').filter({ hasText: 'Notebook' }).first().click();
  await phone.getByText('Applied on desktop. Nothing sent to the Agent.', { exact: true }).waitFor();
  await draft.fill('<script>literal</script>\nSecond line'); await transfer.click();
  await desktop.locator('[data-remote-notebook] .tiptap').getByText('<script>literal</script>', { exact: true }).waitFor();
  assert.equal(await desktop.locator('[data-remote-notebook] .tiptap script').count(), 0);
  assert.ok(!phoneRequests.some(path => /sessions|notebooks|preferences|layouts/.test(path)), 'remote-only phone has no workspace/session polling');
  if (!await desktop.locator('.workspace-remote-host').evaluate(el => el.open)) await desktop.getByLabel('Phone remote', { exact: true }).click();
  await desktop.getByRole('button', { name: 'Disable remote control', exact: true }).click();
  await desktop.getByText('Remote control is off', { exact: true }).waitFor();
  await phone.getByRole('button', { name: 'Refresh devices', exact: true }).click();
  await phone.waitForFunction(() => document.querySelector('.remote-device-row select')?.options.length === 1);
  const count = remoteRequests.length; await desktop.waitForTimeout(800); assert.equal(remoteRequests.length, count);
  assert.deepEqual(errors, []); assert.deepEqual(forbidden, []);
  console.log(JSON.stringify({ verified: true, devices: 2, focus: true, draftNoSend: true, syntheticMessagePosts: sent.length, resendCancelNoPost: true, resendNewKey: true, settledNoDuplicate: true, acceptedDespiteDirectoryFailure: true, compactViewports: 3, occupiedPreserved: true, notebookLiteralText: true, disabledNoPoll: true, phoneNoSessionReads: true, remoteRequests: count }));
} finally { await browser?.close(); routes.close(); hub.close(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); }
