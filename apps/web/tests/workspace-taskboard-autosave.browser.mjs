// Production frontend + isolated real Hub storage. File-Connector receipts are
// explicit synthetic boundaries; no real sessions, models or service actions.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { preview } from 'vite';
import { resourceCaption } from './resource-caption.mjs';
import { HubStore } from '../../server/src/hub/hub-store.ts';
import { loadConfig } from '../../server/src/config.ts';
import { registerHubRoutes } from '../../server/src/routes/hub.ts';
const require = createRequire(new URL('../../server/package.json', import.meta.url));
const { Hono } = require('hono');
const { chromium } = await import(pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href);
const directory = await mkdtemp(join(tmpdir(), 'agentopsdeck-board-autosave-'));
const hub = new HubStore(join(directory, 'hub.sqlite'), 'synthetic');
const principal = { userId: 'default', admin: true }, app = new Hono();
const routes = registerHubRoutes(app, { config: loadConfig({ HOME: directory, AOD_SERVER_ROLE: 'hub' }), hubStore: hub,
  connectorClient: () => { throw Error('No real Connector calls'); }, normalizeError: () => 'Synthetic', principal: () => principal });
const server = await preview({ root: process.env.AOD_TEST_WEB_ROOT, configFile: false, envFile: false,
  build: { outDir: process.env.AOD_TEST_WEB_ROOT }, logLevel: 'error', preview: { host: '127.0.0.1', port: 0 } });
let browser, release;
try {
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.AOD_TEST_CHROMIUM });
  // Tablet mode retains the workspace at 390px; the phone shell deliberately
  // shows only chat. This is Chromium layout coverage, not real Safari testing.
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block', hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Safari/604.1' });
  const errors = [], writes = [], forbidden = [];
  let mode = 'normal', binding = null, writable = true, reads = 0;
  await context.addInitScript(() => {
    if (location.protocol === 'http:') localStorage.setItem('agentopsdeck.locale', 'en');
    window.EventSource = class extends EventTarget { readyState = 1; static OPEN = 1;
      constructor() { super(); queueMicrotask(() => this.onopen?.(new Event('open'))); } close() { this.readyState = 2; } };
  });
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin !== origin) { forbidden.push(url.origin); return route.abort(); }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const json = body => route.fulfill({ json: body });
    const boardPath = '/api/hub/v1/workspace/boards/default';
    if (url.pathname === boardPath && req.method() === 'GET') {
      reads++; return json({ ...hub.boards.get('default', 'default'), fileBinding: binding });
    }
    if (url.pathname === `${boardPath}/file-binding/capabilities`) return json({ writable });
    const fileWrite = url.pathname === `${boardPath}/file-binding/${binding?.bindingId}/writes`;
    if ((url.pathname === boardPath && req.method() === 'PUT') || fileWrite) {
      const value = req.postDataJSON(), currentMode = mode;
      mode = 'normal'; writes.push({ method: req.method(), value });
      if (currentMode === 'drop-before') return route.abort('failed');
      const response = await app.request(boardPath, { method: 'PUT', headers: req.headers(), body: JSON.stringify(value) });
      if (currentMode === 'hold') await new Promise(resolve => { release = resolve; });
      if (currentMode === 'drop-after') return route.abort('failed');
      if (fileWrite) return json({ receipt: { mutationId: value.mutationId, state: response.status === 409 ? 'conflict' : 'saved' } });
      return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
    }
    if (url.pathname.startsWith('/api/hub/v1/workspace/') || url.pathname.startsWith('/api/hub/v1/notebooks')) {
      // Selecting a workspace preset and restoring it persists its two layout
      // documents. Allow only those exact writes to this isolated Hub fixture.
      const layoutWrite = req.method() === 'PUT' && ['/api/hub/v1/workspace/layouts/current', '/api/hub/v1/workspace/layouts/saved'].includes(url.pathname);
      if (req.method() !== 'GET' && !layoutWrite) { forbidden.push(`${req.method()} ${url.pathname}`); return route.abort(); }
      const response = await app.request(url.pathname + url.search, { method: req.method(), headers: req.headers(), ...(layoutWrite ? { body: req.postData() } : {}) });
      return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
    }
    if (req.method() !== 'GET') { forbidden.push(`${req.method()} ${url.pathname}`); return route.abort(); }
    if (url.pathname === '/api/auth/status') return json({ authenticated: true, recoveryScope: hub.identities.recoveryScope(principal), passkeys: { available: false, count: 0 } });
    if (url.pathname.endsWith('/sessions/state')) return json({ revision: '1', groups: [] });
    if (url.pathname.endsWith('/messages')) forbidden.push('message read');
    if (url.pathname === '/api/agents') return json({ agents: [] });
    if (url.pathname === '/api/gateway/status') return json({ connected: true });
    return route.fulfill({ status: 404, json: {} });
  });
  const page = await context.newPage(); page.setDefaultTimeout(12000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await page.getByLabel('Layout presets', { exact: true }).click();
  await page.getByRole('button', { name: 'Task board · Preview', exact: true }).click();
  const board = page.getByRole('region', { name: 'Task board', exact: true });
  const title = page.getByRole('textbox', { name: 'Board title', exact: true });
  const ready = () => board.locator('xpath=self::*[@data-board-ready="true"]').waitFor();
  const button = async name => (await resourceCaption(board)).getByRole('button', { name, exact: true });
  const draft = () => page.evaluate(() => Object.entries(sessionStorage).filter(([key]) => key.startsWith('agentopsdeck.board-draft.v1:')).map(([, value]) => JSON.parse(value)));
  const idle = () => page.waitForTimeout(1550);
  await ready(); await idle(); assert.equal(writes.length, 0, 'opening is read-only');

  await title.fill('Debounce first'); await page.waitForTimeout(700);
  await title.fill('Debounce last'); await page.waitForTimeout(700);
  assert.equal(writes.length, 0, 'editing resets debounce');
  await ready(); assert.equal(writes.length, 1); assert.equal(writes[0].value.title, 'Debounce last');
  assert.deepEqual(await draft(), []); await idle(); assert.equal(writes.length, 1, 'clean board does not loop');
  const idleReads = reads; await idle(); assert.equal(reads, idleReads, 'no polling');

  await title.fill(''); await idle(); assert.equal(writes.length, 1, 'invalid title stays local');
  await title.fill('Debounce last'); await idle(); assert.equal(writes.length, 1, 'reverting to saved content is a no-op');
  await title.dispatchEvent('compositionstart'); await title.fill('中文输入');
  await idle(); assert.equal(writes.length, 1, 'IME composition is not saved halfway');
  await title.dispatchEvent('compositionend'); await ready(); assert.equal(writes.length, 2);
  assert.equal(writes.at(-1).value.title, '中文输入');

  await board.getByRole('button', { name: 'Add task', exact: true }).first().click();
  const taskTitle = board.getByRole('textbox', { name: 'Task title', exact: true });
  await taskTitle.fill('Auto task'); await board.getByRole('textbox', { name: 'Task details', exact: true }).fill('Details saved automatically');
  await ready(); assert.equal(writes.length, 3);
  assert.equal(await taskTitle.evaluate(input => document.activeElement === input), false); // detail owns focus
  assert.equal(await board.getByRole('textbox', { name: 'Task details', exact: true }).evaluate(input => document.activeElement === input), true, 'save retains editor focus');
  await board.getByRole('combobox', { name: 'Task status', exact: true }).selectOption('done');
  await ready(); assert.equal(hub.boards.get('default', 'default').tasks[0].status, 'done');
  await board.getByRole('button', { name: 'Auto task', exact: true }).click();
  await board.getByRole('button', { name: 'Remove task', exact: true }).click();
  await ready(); assert.equal(hub.boards.get('default', 'default').tasks.length, 0);

  let count = writes.length;
  await title.fill('Manual save'); await (await button('Save')).click(); await ready();
  await idle(); assert.equal(writes.length, count + 1, 'manual save cancels delayed duplicate');
  count = writes.length; mode = 'hold'; await title.fill('Slow response');
  await board.getByText('Saving…', { exact: true }).waitFor(); await idle();
  assert.equal(writes.length, count + 1, 'only one save in flight');
  assert.equal(await title.evaluate(input => input.readOnly), true, 'existing edit lock protects in-flight snapshot without losing focus');
  release(); release = undefined; await ready();

  count = writes.length; mode = 'drop-after'; await title.fill('Reply lost');
  await board.getByRole('alert').filter({ hasText: 'Save outcome unconfirmed' }).waitFor();
  const uncertain = writes.at(-1).value, uncertainRevision = hub.boards.get('default', 'default').revision;
  await idle(); assert.equal(writes.length, count + 1, 'unknown outcomes never auto-retry');
  assert.deepEqual((await draft())[0], uncertain);
  await (await button('Retry same save')).click(); await ready();
  assert.deepEqual(writes.at(-1).value, uncertain, 'manual retry retains exact mutation');
  assert.equal(hub.boards.get('default', 'default').revision, uncertainRevision, 'lost reply retry is idempotent');

  mode = 'drop-before'; await title.fill('Offline draft');
  await board.getByRole('alert').filter({ hasText: 'Save outcome unconfirmed' }).waitFor();
  const offline = (await draft())[0]; count = writes.length;
  await page.reload(); await title.waitFor(); await idle();
  assert.equal(await title.inputValue(), 'Offline draft'); assert.equal(writes.length, count, 'recovered unconfirmed draft is never replayed');
  assert.deepEqual((await draft())[0], offline);
  await (await button('Save')).click(); await ready(); assert.deepEqual(writes.at(-1).value, offline);

  const current = hub.boards.get('default', 'default');
  hub.boards.save('default', 'default', { title: 'Another writer', tasks: current.tasks, revision: current.revision, mutationId: crypto.randomUUID() });
  await title.fill('Local conflicting draft');
  await board.getByRole('alert').filter({ hasText: 'Board changed elsewhere' }).waitFor();
  count = writes.length; await title.fill('Preserved after conflict'); await idle();
  assert.equal(writes.length, count); assert.equal(hub.boards.get('default', 'default').title, 'Another writer');
  await page.reload(); await title.waitFor(); await idle(); assert.equal(await title.inputValue(), 'Preserved after conflict');
  assert.equal(writes.length, count, 'conflict survives reload without automatic overwrite');
  await (await button('Refresh task board')).click();
  await board.getByRole('button', { name: 'Discard and reload', exact: true }).click(); await ready();

  count = writes.length; await title.fill('Do not save during discard confirmation');
  await (await button('Refresh task board')).click(); await idle(); assert.equal(writes.length, count);
  await board.getByRole('button', { name: 'Cancel', exact: true }).click(); await ready(); assert.equal(writes.length, count + 1);

  // A bound board uses only its explicit file-write/receipt route, not Hub PUT.
  binding = { bindingId: '00000000-0000-4000-8000-000000000010', resourceId: 'default', sessionId: 'synthetic', state: 'active', problem: null };
  writable = false; await page.reload(); await ready(); await idle();
  assert.equal(await title.isDisabled(), true); count = writes.length;
  await title.evaluate(input => { input.value = 'Read-only'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  await idle(); assert.equal(writes.length, count, 'read-only Connector does not autosave');
  writable = true; await page.reload(); await ready();
  await title.fill('File autosave'); await ready(); assert.equal(writes.at(-1).method, 'POST');
  assert.equal(hub.boards.get('default', 'default').title, 'File autosave');
  mode = 'drop-after'; await title.fill('File reply lost');
  await board.getByRole('alert').filter({ hasText: 'Save outcome unconfirmed' }).waitFor();
  const fileRequest = writes.at(-1); count = writes.length; await idle(); assert.equal(writes.length, count);
  await (await button('Check file save')).click(); await ready(); assert.deepEqual(writes.at(-1), fileRequest);
  await page.setViewportSize({ width: 390, height: 844 });
  await title.fill('Narrow autosave'); await ready();
  assert.equal(await board.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);

  mode = 'hold'; await title.fill('Auth lost while file write is pending');
  await board.getByText('Saving…', { exact: true }).waitFor();
  const pendingDraft = await draft(), pendingReads = reads;
  count = writes.length;
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('agentopsdeck:auth-required')));
  release(); release = undefined;
  await board.getByRole('alert').filter({ hasText: 'Save outcome unconfirmed' }).waitFor();
  await idle();
  assert.equal(reads, pendingReads, 'late file receipt does not start a confirmation read after auth loss');
  assert.deepEqual(await draft(), pendingDraft, 'late receipt cannot discard the unconfirmed recovery draft');
  assert.equal(writes.length, count, 'late receipt does not trigger a replay');
  await page.reload(); await ready();

  count = writes.length; await title.fill('Canceled on unmount'); await page.reload(); await title.waitFor();
  await idle(); assert.equal(writes.length, count, 'unmount cancels pending timer; recovered draft stays local');
  await title.fill('Canceled on auth change');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('agentopsdeck:auth-required')));
  await idle(); assert.equal(writes.length, count, 'auth loss cancels pending autosave');
  const lockedDraft = await draft();
  const outcome = await board.evaluate(element => {
    const detail = { task: { id: crypto.randomUUID(), title: 'Late source import after auth lock', detail: '', status: 'todo' }, outcome: 'pending' };
    element.dispatchEvent(new CustomEvent('agentopsdeck:source-task', { detail })); return detail.outcome;
  });
  assert.equal(outcome, 'unavailable', 'same-scope lock rejects source imports synchronously');
  assert.deepEqual(await draft(), lockedDraft, 'locked source event cannot persist a draft');
  await page.reload(); await title.waitFor();
  await title.fill('Same scope unlocked after reload'); await ready();
  assert.equal(hub.boards.get('default', 'default').title, 'Same scope unlocked after reload');
  assert.deepEqual(errors, []); assert.deepEqual(forbidden, []);
  console.log(JSON.stringify({ passed: true, writes: writes.length, reads, nativeCalls: 0, checks: ['debounce/coalescing', 'no idle polling', 'invalid/no-op', 'IME', 'task edit/status/remove', 'editor focus', 'manual save', 'serialized slow response', 'lost reply idempotency', 'offline draft recovery without replay', 'conflict without overwrite', 'discard confirmation', 'read-only file binding', 'file receipt route and retry', '390px', 'auth loss during pending file write', 'unmount/auth cancellation'] }));
} finally {
  release?.(); await browser?.close(); await server.close(); routes?.close(); hub.close(); await rm(directory, { recursive: true, force: true });
}
