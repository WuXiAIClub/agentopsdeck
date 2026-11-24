import { resourceCaption } from './resource-caption.mjs';
// Real Hub routes + isolated SQLite; synthetic session metadata, no Agent calls.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createServer, preview } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { verifyTaskboardDrag } from './workspace-taskboard-drag.fixture.mjs';
import { verifyTaskboardView } from './workspace-taskboard-view.fixture.mjs';
import { verifyTaskMetadata } from './workspace-task-metadata.fixture.mjs';
import { HubStore } from '../../server/src/hub/hub-store.ts';
import { loadConfig } from '../../server/src/config.ts';
import { registerHubRoutes } from '../../server/src/routes/hub.ts';
const require = createRequire(new URL('../../server/package.json', import.meta.url));
const { Hono } = require('hono');
const { chromium } = await import(pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href);
const directory = await mkdtemp(join(tmpdir(), 'agentopsdeck-taskboard-browser-'));
const hub = new HubStore(join(directory, 'hub.sqlite'), 'synthetic');
const principal = { userId: 'default', admin: true }, app = new Hono();
const routes = registerHubRoutes(app, { config: loadConfig({ HOME: directory, AOD_SERVER_ROLE: 'hub' }), hubStore: hub,
  connectorClient: () => { throw Error('Task board must not call Connector'); }, normalizeError: () => 'Synthetic', principal: () => principal });
const server = process.env.AOD_TEST_WEB_ROOT
  ? await preview({ root: process.env.AOD_TEST_WEB_ROOT, configFile: false, envFile: false, build: { outDir: process.env.AOD_TEST_WEB_ROOT }, logLevel: 'error', preview: { host: '127.0.0.1', port: 0 } })
  : await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, envFile: false,
  plugins: [react(), tailwindcss()], logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  if ('listen' in server) await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.AOD_TEST_CHROMIUM });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, hasTouch: true, serviceWorkers: 'block' });
  const errors = [], reads = [], writes = [], forbidden = [];
  let loseReply = false, loseGrant = false, loseRevoke = false, failGrantRead = false, failBoardRead = false;
  const accessRequests = [];
  await context.addInitScript(() => {
    if (location.protocol === 'http:') localStorage.setItem('agentopsdeck.locale', 'en');
    // Isolated clipboard sink; never use the operator's OS clipboard in tests.
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.testCopiedGrant = text; } } });
    window.testEventSources = [];
    window.EventSource = class extends EventTarget { readyState = 1; static OPEN = 1;
      constructor() { super(); window.testEventSources.push(this); queueMicrotask(() => this.onopen?.(new Event('open')));
        this.heartbeat = setInterval(() => this.dispatchEvent(new Event('heartbeat')), 10000); }
      close() { this.readyState = 2; clearInterval(this.heartbeat); } };
  });
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin !== origin) { forbidden.push(url.origin); return route.abort(); }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const json = body => route.fulfill({ json: body });
    if (url.pathname.startsWith('/api/hub/v1/workspace/') || url.pathname.startsWith('/api/hub/v1/notebooks')) {
      if (failBoardRead && req.method() === 'GET' && /\/boards\/[^/]+$/.test(url.pathname)) { failBoardRead = false; return route.abort('failed'); }
      if (/\/(capabilities|audit)(\/|$)/.test(url.pathname)) accessRequests.push(`${req.method()} ${url.pathname}${url.search}`);
      if (failGrantRead && req.method() === 'GET' && url.pathname.endsWith('/capabilities')) { failGrantRead = false; return route.abort('failed'); }
      if (url.pathname.includes('/boards/')) (req.method() === 'GET' ? reads : writes).push(req.postDataJSON?.() ?? null);
      const response = await app.request(url.pathname + url.search, { method: req.method(), headers: req.headers(), ...(req.postData() ? { body: req.postData() } : {}) });
      if (loseReply && req.method() === 'PUT' && url.pathname.includes('/boards/')) { loseReply = false; return route.abort('failed'); }
      if (loseGrant && req.method() === 'POST' && url.pathname.endsWith('/capabilities')) { loseGrant = false; return route.abort('failed'); }
      if (loseRevoke && req.method() === 'DELETE' && url.pathname.includes('/capabilities/')) { loseRevoke = false; return route.abort('failed'); }
      return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
    }
    if (req.method() !== 'GET') { forbidden.push(`${req.method()} ${url.pathname}`); return route.abort(); }
    if (url.pathname === '/api/auth/status') return json({ authenticated: true, recoveryScope: hub.identities.recoveryScope(principal), passkeys: { available: false, count: 0 } });
    if (url.pathname.endsWith('/sessions/state')) return json({ revision: '1', groups: [] });
    if (url.pathname.endsWith('/messages')) { forbidden.push('message read'); return json({ messages: [] }); }
    if (url.pathname === '/api/agents') return json({ agents: [] });
    if (url.pathname === '/api/gateway/status') return json({ connected: true });
    return route.fulfill({ status: 404, json: {} });
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) errors.push(message.text()); });
  page.setDefaultTimeout(12000);
  await page.goto(origin);
  await page.getByLabel('Layout presets', { exact: true }).click();
  await page.getByRole('button', { name: 'Task board · Preview', exact: true }).click();
  let board = page.getByRole('region', { name: 'Task board', exact: true });
  await (await resourceCaption(board)).getByRole('textbox', { name: 'Board title', exact: true }).fill('Release plan');
  await board.getByRole('button', { name: 'Add task', exact: true }).first().click();
  const newTaskDialog = board.getByRole('dialog', { name: 'Task details', exact: true });
  await newTaskDialog.waitFor();
  assert.equal(await newTaskDialog.getByRole('textbox', { name: 'Task title', exact: true }).evaluate(input =>
    document.activeElement === input && input.selectionStart === 0 && input.selectionEnd === input.value.length), true,
  'new task opens directly with its placeholder selected');
  assert.equal(await board.locator('[data-board-task]').count(), 1, 'opening editor creates exactly one task');
  const newTaskId = await board.locator('[data-board-task]').getAttribute('data-board-task');
  await page.keyboard.press('Escape');
  await newTaskDialog.waitFor({ state: 'detached' });
  assert.equal(await board.getByRole('button', { name: 'New task', exact: true }).evaluate(button => document.activeElement === button), true);
  await board.getByRole('button', { name: 'New task', exact: true }).click();
  await board.getByRole('textbox', { name: 'Task title', exact: true }).fill('Isolated acceptance');
  await board.getByRole('textbox', { name: 'Task details', exact: true }).fill('<script>must stay text</script>');
  await newTaskDialog.getByRole('combobox', { name: 'Task priority', exact: true }).selectOption('urgent');
  await newTaskDialog.getByLabel('Due date', { exact: true }).fill('2028-02-29');
  await newTaskDialog.getByRole('button', { name: 'Add tag', exact: true }).click();
  assert.equal(await board.locator('xpath=ancestor::*[@data-workspace-pane][1]').locator('.session-pane-caption').getByRole('button', { name: 'Save', exact: true, includeHidden: true }).isDisabled(), true, 'unfinished tags block saves without closing the editor');
  await newTaskDialog.getByRole('textbox', { name: 'Task tag 1', exact: true }).fill('前端');
  await board.getByRole('combobox', { name: 'Task status', exact: true }).selectOption('doing');
  assert.equal(await board.locator('[data-board-task]').getAttribute('data-board-task'), newTaskId);
  assert.equal(await newTaskDialog.count(), 0, 'moving the task does not replay the creation editor request');
  await page.getByRole('button', { name: 'Refresh and release resources', exact: true }).click();
  await page.locator('.global-refresh-blocked').waitFor();
  assert.equal(await page.getByRole('dialog', { name: 'Refresh and release resources', exact: true }).count(), 0);
  assert.equal(await board.getByRole('button', { name: 'Isolated acceptance', exact: true }).count(), 1);
  await page.locator('.global-refresh-blocked').getByRole('button', { name: 'Close', exact: true }).click();
  await (await resourceCaption(board)).getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForFunction(() => Boolean(document.querySelector('.workspace-taskboard[data-board-ready="true"]')));
  assert.equal(await board.locator('.workspace-board-status').count(), 0, 'saved board has no permanent status row');
  await page.getByRole('button', { name: 'Refresh and release resources', exact: true }).click();
  await page.getByRole('dialog', { name: 'Refresh and release resources', exact: true }).getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(hub.boards.get('default', 'default').tasks[0].status, 'doing');
  assert.equal(hub.boards.get('default', 'default').tasks[0].priority, 'urgent');
  assert.equal(hub.boards.get('default', 'default').tasks[0].dueDate, '2028-02-29');
  assert.deepEqual(hub.boards.get('default', 'default').tasks[0].tags, ['前端']);
  await verifyTaskMetadata({ page, board, hub });
  assert.equal(await (await resourceCaption(board)).getByRole('button', { name: 'Link whole board', exact: true }).count(), 0, 'wrapped taskboard has one file sync entry');
  assert.equal(hub.boards.get('another-user', 'default').revision, 0);
  // Hover/focus never opens details; right click and keyboard expose actions.
  const compactTraffic = { reads: reads.length, writes: writes.length };
  const summary = board.getByRole('button', { name: 'Isolated acceptance', exact: true });
  assert.equal(await board.getByRole('textbox', { name: 'Task details' }).count(), 0);
  assert.ok((await summary.boundingBox()).height < 70);
  await summary.hover();
  await page.waitForTimeout(400);
  assert.equal(await board.locator('.workspace-task-popover').count(), 0);
  assert.equal(await board.locator('script').count(), 0);
  await summary.click({ button: 'right' });
  await board.getByRole('menu', { name: 'Task actions' }).waitFor();
  assert.equal(await page.locator('.workspace-context-menu').count(), 0, 'task menu does not open the workspace menu');
  await page.screenshot({ path: '/tmp/agentopsdeck-taskboard-actions.png' });
  await page.keyboard.press('End');
  assert.equal(await board.getByRole('menuitem', { name: 'Edit task properties' }).evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('Enter');
  await board.getByRole('dialog', { name: 'Task details' }).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await summary.evaluate(el => el === document.activeElement), true);
  await summary.blur(); await summary.focus();
  assert.equal(await board.locator('.workspace-task-popover').count(), 0);
  await summary.press('Shift+F10');
  await board.getByRole('menu', { name: 'Task actions' }).waitFor();
  await page.keyboard.press('Escape');
  await summary.press('Enter');
  await board.getByRole('dialog', { name: 'Task details' }).waitFor();
  await page.keyboard.press('Escape');
  await summary.tap();
  await board.getByRole('textbox', { name: 'Task details' }).waitFor();
  await page.keyboard.press('Escape');
  assert.deepEqual({ reads: reads.length, writes: writes.length }, compactTraffic);
  await verifyTaskboardView({ page, board, hub, reads, writes });
  await verifyTaskboardDrag({ page, context, board, reads, writes });
  const counts = { reads: reads.length, writes: writes.length };
  const pane = page.locator('[data-workspace-pane]').filter({ has: board });
  if (await pane.getByRole('button', { name: 'Dock pane', exact: true }).isVisible()) await pane.getByRole('button', { name: 'Dock pane', exact: true }).click();
  await pane.getByRole('button', { name: 'Float pane', exact: true }).click();
  await pane.getByRole('button', { name: 'Dock pane', exact: true }).click();
  await page.waitForTimeout(350);
  assert.deepEqual({ reads: reads.length, writes: writes.length }, counts, 'float/dock does not refetch or rewrite');
  await page.reload();
  await page.waitForFunction(() => document.querySelector('[aria-label="Board title"]')?.value === 'Release plan');
  assert.equal(reads.length, counts.reads + 1, 'layout restore reads one board');
  await board.getByRole('button', { name: 'Isolated acceptance', exact: true }).click();
  await board.getByRole('textbox', { name: 'Task title', exact: true }).fill('Local conflict draft');
  const remote = hub.boards.get('default', 'default');
  hub.boards.save('default', 'default', { title: 'Other tab', tasks: remote.tasks, revision: remote.revision, mutationId: crypto.randomUUID() });
  await (await resourceCaption(board)).getByRole('button', { name: 'Save', exact: true }).click();
  await board.getByRole('alert').filter({ hasText: 'Board changed elsewhere' }).waitFor();
  await page.reload();
  await board.getByRole('alert').filter({ hasText: 'Board changed elsewhere' }).waitFor();
  assert.equal(await board.getByRole('button', { name: 'Local conflict draft', exact: true }).count(), 1);
  await (await resourceCaption(board)).getByRole('button', { name: 'Refresh task board', exact: true }).click();
  await board.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await board.getByRole('button', { name: 'Local conflict draft', exact: true }).count(), 1);
  await (await resourceCaption(board)).getByRole('button', { name: 'Refresh task board', exact: true }).click();
  await board.getByRole('button', { name: 'Discard and reload', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Board title"]')?.value === 'Other tab');
  await (await resourceCaption(board)).getByRole('textbox', { name: 'Board title', exact: true }).fill('Lost reply');
  loseReply = true;
  await (await resourceCaption(board)).getByRole('button', { name: 'Save', exact: true }).click();
  await board.getByRole('alert').filter({ hasText: 'Save outcome unconfirmed' }).waitFor();
  const appliedRevision = hub.boards.get('default', 'default').revision;
  await (await resourceCaption(board)).getByRole('button', { name: 'Retry same save', exact: true }).click();
  await page.waitForFunction(() => Boolean(document.querySelector('.workspace-taskboard[data-board-ready="true"]')));
  assert.equal(hub.boards.get('default', 'default').revision, appliedRevision, 'retry must not apply twice');
  assert.equal(writes.at(-1).mutationId, writes.at(-2).mutationId);
  // A second tab must not overwrite this tab's unsaved draft on reload.
  const secondPage = await context.newPage();
  secondPage.on('pageerror', error => errors.push(error.message));
  await secondPage.goto(origin);
  const secondBoard = secondPage.getByRole('region', { name: 'Task board', exact: true });
  await secondPage.waitForFunction(() => document.querySelector('[aria-label="Board title"]')?.value === 'Lost reply');
  // Reload immediately after each edit, before debounce. Recovered drafts are
  // deliberately not auto-replayed; tab isolation is independent of autosave.
  await (await resourceCaption(board)).getByRole('textbox', { name: 'Board title', exact: true }).fill('First tab draft');
  await page.reload();
  await page.waitForFunction(() => document.querySelector('[aria-label="Board title"]')?.value === 'First tab draft');
  await (await resourceCaption(secondBoard)).getByRole('textbox', { name: 'Board title', exact: true }).fill('Second tab draft');
  await secondPage.reload();
  await secondPage.waitForFunction(() => document.querySelector('[aria-label="Board title"]')?.value === 'Second tab draft');
  assert.equal(hub.boards.get('default', 'default').title, 'Lost reply');
  await secondPage.close();
  const after = reads.length; await page.waitForTimeout(1200); assert.equal(reads.length, after, 'no per-board polling');
  // A narrow desktop pane stacks columns instead of horizontal overflow.
  await page.setViewportSize({ width: 800, height: 900 });
  const dimensions = await board.evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth }));
  assert.ok(dimensions.scroll <= dimensions.width + 1, 'narrow panel must not overflow');
  const narrowTraffic = { reads: reads.length, writes: writes.length };
  const narrowTasks = await board.locator('[data-board-task]').count();
  for (const status of ['todo', 'doing', 'done']) {
    const column = board.locator(`[data-board-column="${status}"]`);
    await column.getByRole('button', { name: 'Add task', exact: true }).click();
    const editor = board.getByRole('dialog', { name: 'Task details', exact: true });
    await editor.waitFor();
    assert.equal(await editor.getByRole('combobox', { name: 'Task status', exact: true }).inputValue(), status);
    assert.equal(await editor.getByRole('textbox', { name: 'Task title', exact: true }).evaluate(node => document.activeElement === node), true);
    const rect = await editor.boundingBox();
    assert.ok(rect.x >= 8 && rect.x + rect.width <= 792 && rect.y >= 8 && rect.y + rect.height <= 892, 'new editor stays inside narrow viewport');
    await editor.getByRole('textbox', { name: 'Task title', exact: true }).fill(`Temporary ${status}`);
    await editor.getByRole('button', { name: 'Remove task', exact: true }).click();
    await editor.waitFor({ state: 'detached' });
    assert.equal(await board.locator('[data-board-task]').count(), narrowTasks);
  }
  assert.deepEqual({ reads: reads.length, writes: writes.length }, narrowTraffic, 'new task editing uses local draft, without hidden network writes');
  console.log('PASS immediate new-task editor: all three statuses, narrow viewport, focus, one task, local changes before debounce');
  // Keep this deliberately unsaved first-board draft for the later revision
  // conflict test, without racing its timer against unrelated board creation.
  await page.reload();
  await page.waitForFunction(() => document.querySelector('[aria-label="Board title"]')?.value === 'First tab draft');
  await page.setViewportSize({ width: 1600, height: 1000 });
  await (await resourceCaption(board)).getByRole('button', { name: 'Task boards', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Task boards', exact: true });
  await picker.getByRole('button', { name: 'New task board', exact: true }).click();
  board = page.getByRole('region', { name: 'Task board', exact: true }).nth(1);
  await (await resourceCaption(board)).getByRole('textbox', { name: 'Board title', exact: true }).fill('Independent board');
  await board.getByRole('button', { name: 'Add task', exact: true }).first().click();
  await board.getByRole('button', { name: 'New task', exact: true }).click();
  await board.getByRole('textbox', { name: 'Task title', exact: true }).fill('Private detail stays on board');
  await (await resourceCaption(board)).getByRole('button', { name: 'Save', exact: true }).click();
  await board.locator('xpath=self::*[@data-board-ready="true"]').waitFor();
  assert.equal(hub.boards.list('default').length, 2);
  const secondId = hub.boards.list('default').find(item => item.title === 'Independent board').resourceId;
  assert.notEqual(secondId, 'default');
  await (await resourceCaption(board)).getByRole('button', { name: 'Open status card', exact: true }).click();
  let card = page.getByRole('region', { name: 'Task status card', exact: true });
  await (await resourceCaption(card)).getByRole('heading', { name: 'Independent board' }).waitFor();
  assert.equal(await card.locator('[data-status="todo"] strong').textContent(), '1');
  const readCount = reads.length;
  // Keyboard focus brings the board above the newly opened floating status card.
  await board.getByRole('button', { name: 'Private detail stays on board', exact: true }).focus();
  await board.getByRole('button', { name: 'Private detail stays on board', exact: true }).click();
  await board.getByRole('combobox', { name: 'Task status', exact: true }).selectOption('done');
  assert.equal(await card.locator('[data-status="done"] strong').textContent(), '0', 'card shows saved state, not unsaved draft');
  await (await resourceCaption(board)).getByRole('button', { name: 'Save', exact: true }).click();
  await card.locator('[data-status="done"] strong').filter({ hasText: '1' }).waitFor();
  assert.equal(reads.length, readCount, 'same-page save updates summary without another read');
  const cardPane = page.locator('[data-workspace-pane]').filter({ has: card });
  // Saving the board activates that floating pane. Keyboard focus raises the
  // status card again before pointer-testing its window actions.
  await cardPane.getByRole('button', { name: 'Close pane', exact: true }).focus();
  if (await cardPane.getByRole('button', { name: 'Dock pane', exact: true }).isVisible()) await cardPane.getByRole('button', { name: 'Dock pane', exact: true }).click();
  await cardPane.getByRole('button', { name: 'Float pane', exact: true }).click();
  await cardPane.getByRole('button', { name: 'Dock pane', exact: true }).click();
  assert.equal(reads.length, readCount, 'status float/dock does not reread');
  await page.reload();
  card = page.getByRole('region', { name: 'Task status card', exact: true });
  await card.locator('[data-status="done"] strong').filter({ hasText: '1' }).waitFor();
  assert.equal(await page.getByRole('region', { name: 'Task board', exact: true }).count(), 2);
  assert.equal(await page.getByRole('textbox', { name: 'Board title', exact: true }).first().inputValue(), 'First tab draft', 'other board draft preserved');
  const idleReads = reads.length;
  await page.waitForTimeout(1200); assert.equal(reads.length, idleReads, 'multiple boards/cards introduce no polling');

  // Real SQLite updates; inject metadata frames through the browser's existing
  // SSE transport. Actual two-client stream framing/authorization is tested in
  // workspace-resource-stream.test.ts, not mocked as HTTP polling here.
  const snapshot = async target => target.evaluate(resources => {
    const live = window.testEventSources.filter(source => source.readyState === 1);
    if (live.length !== 1) throw new Error(`expected shared stream, got ${live.length}`);
    live[0].dispatchEvent(new MessageEvent('workspace.revisions', { data: JSON.stringify({ type: 'workspace.revisions', resourceType: 'taskboard', resources }) }));
  }, hub.boards.revisions('default'));
  const peer = await context.newPage();
  peer.on('pageerror', error => errors.push(error.message));
  await peer.goto(origin);
  await (await resourceCaption(peer.getByRole('region', { name: 'Task status card', exact: true }))).getByRole('heading', { name: 'Independent board' }).waitFor();
  const originBoard = page.getByRole('region', { name: 'Task board', exact: true }).nth(1);
  const originGrip = originBoard.getByRole('button', { name: 'Drag task to move or reorder' });
  const beginGesture = async () => {
    await originGrip.scrollIntoViewIfNeeded(); const r = await originGrip.boundingBox();
    await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2); await page.mouse.down();
  };
  // A task may not be silently copied/moved into another board's authority scope.
  await beginGesture();
  const other = await page.getByRole('region', { name: 'Task board', exact: true }).first().locator('[data-board-column="todo"] h3').boundingBox();
  const writesBeforeForeignDrop = writes.length;
  await page.mouse.move(other.x + 10, other.y + 5, { steps: 8 }); await page.mouse.up();
  assert.equal(writes.length, writesBeforeForeignDrop);
  assert.equal(await (await resourceCaption(originBoard)).getByRole('button', { name: 'Save', exact: true }).isDisabled(), true);
  // A new revision while the pointer is down cancels the stale drag. It must
  // not persist the old document over a newer remote title on pointer release.
  await beginGesture();
  const own = await originBoard.locator('[data-board-column="todo"] h3').boundingBox();
  await page.mouse.move(own.x + 10, own.y + 5, { steps: 8 });
  await originBoard.locator('[data-task-dragging="true"]').waitFor();
  const updated = hub.boards.get('default', secondId);
  hub.boards.save('default', secondId, { tasks: updated.tasks, title: 'Updated across devices', revision: updated.revision, mutationId: crypto.randomUUID() });
  await snapshot(page); await snapshot(peer);
  for (const target of [page, peer]) {
    await (await resourceCaption(target.getByRole('region', { name: 'Task status card', exact: true }))).getByRole('heading', { name: 'Updated across devices' }).waitFor();
    await target.waitForFunction(() => [...document.querySelectorAll('[aria-label="Board title"]')].some(input => input.value === 'Updated across devices'));
  }
  await page.mouse.up();
  assert.equal(await originBoard.locator('[data-task-dragging="true"]').count(), 0);
  assert.equal(await originBoard.locator('[data-board-task][data-status="done"]').count(), 1);
  assert.equal(await (await resourceCaption(originBoard)).getByRole('button', { name: 'Save', exact: true }).isDisabled(), true);
  const once = reads.length;
  for (let i = 0; i < 10; i++) { await snapshot(page); await snapshot(peer); }
  await page.waitForTimeout(350); assert.equal(reads.length, once, 'duplicate/reconnect versions do not fetch again');
  const beforeDisconnect = hub.boards.get('default', secondId);
  hub.boards.save('default', secondId, { title: 'Recovered after reconnect', tasks: beforeDisconnect.tasks, revision: beforeDisconnect.revision, mutationId: crypto.randomUUID() });
  failBoardRead = true; await snapshot(page);
  const syncingBoard = page.getByRole('region', { name: 'Task board', exact: true }).nth(1);
  await syncingBoard.getByRole('alert').filter({ hasText: 'Unable to load task board' }).waitFor();
  const sourceCount = await page.evaluate(() => {
    const count = window.testEventSources.length;
    window.testEventSources.find(source => source.readyState === 1).onerror?.(new Event('error'));
    return count;
  });
  await page.waitForFunction(count => window.testEventSources.length > count && window.testEventSources.at(-1).readyState === 1, sourceCount);
  await snapshot(page);
  await page.waitForFunction(() => [...document.querySelectorAll('[aria-label="Board title"]')].some(input => input.value === 'Recovered after reconnect'));
  assert.equal(await syncingBoard.getByRole('alert').count(), 0, 'reconnect retries failed metadata-triggered read');
  const currentDefault = hub.boards.get('default', 'default');
  hub.boards.save('default', 'default', { title: 'Remote title must not overwrite draft', tasks: currentDefault.tasks, revision: currentDefault.revision, mutationId: crypto.randomUUID() });
  await snapshot(page);
  await page.getByRole('region', { name: 'Task board', exact: true }).first().getByRole('alert').filter({ hasText: 'Board changed elsewhere' }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: 'Board title', exact: true }).first().inputValue(), 'First tab draft');
  await peer.close();
  assert.equal(accessRequests.length, 0, 'authorization and audit are lazy');
  const openAuthorization = async target => {
    await (await resourceCaption(target)).getByRole('button', { name: 'Advanced task permissions', exact: true }).click();
  };
  // B2: actual owner routes + SQLite, lost mutation responses, secret lifecycle.
  // A docked pane intentionally remains below floating windows. Dock remaining
  // windows using keyboard controls before testing the first board's form.
  for (const button of await page.locator('[data-workspace-pane][data-floating=true]').getByRole('button', { name: 'Dock pane', exact: true }).all()) {
    await button.focus(); await button.press('Enter');
  }
  board = page.getByRole('region', { name: 'Task board', exact: true }).first();
  await board.locator('xpath=ancestor::*[@data-workspace-pane][1]').getByRole('button', { name: 'Close pane', exact: true }).focus();
  await board.getByRole('button', { name: 'Add task', exact: true }).first().click();
  await board.getByRole('button', { name: 'New task', exact: true }).click();
  await board.getByRole('textbox', { name: 'Task title', exact: true }).first().fill('Unsaved task must not be granted');
  await openAuthorization(board);
  const access = page.getByRole('dialog', { name: 'Agent authorization', exact: true });
  await access.getByRole('checkbox', { name: 'Isolated acceptance', exact: true }).check();
  assert.equal(await access.getByRole('checkbox', { name: 'Unsaved task must not be granted' }).count(), 0);
  assert.equal(await access.getByRole('checkbox', { name: 'Also allow reading and updating task details' }).isChecked(), false);
  assert.equal(accessRequests.filter(path => path.includes('/audit')).length, 0, 'audit only loads on demand');
  const beforeIssue = hub.boardCapabilities.list('default', 'default').length;
  // Two synchronous click events must still produce only one mutation.
  await access.getByRole('button', { name: 'Issue selected task grant' }).evaluate(button => { button.click(); button.click(); });
  await access.getByRole('region', { name: 'Once-only credential' }).waitFor();
  assert.equal(hub.boardCapabilities.list('default', 'default').length, beforeIssue + 1);
  let grant = hub.boardCapabilities.list('default', 'default')[0];
  assert.deepEqual(grant.fields, ['status']); assert.equal(grant.taskIds.length, 1);
  await access.getByRole('button', { name: 'Copy grant token' }).click();
  await access.getByRole('status').filter({ hasText: 'Copied' }).waitFor();
  assert.ok(await page.evaluate(() => /^aod_board_/.test(window.testCopiedGrant)));
  const assertNoSecretStorage = async () => assert.equal(await page.evaluate(() => {
    const token = window.testCopiedGrant;
    return [JSON.stringify(localStorage), JSON.stringify(sessionStorage), location.href, document.body.innerHTML].some(value => /aod_board_/.test(value) || (token && value.includes(token)));
  }), false, 'grant token must not enter persistence, URLs or rendered HTML');
  await assertNoSecretStorage();
  await access.getByRole('button', { name: 'Load audit', exact: true }).click();
  await access.locator('.workspace-access-audit').filter({ hasText: 'Grant issued' }).waitFor();
  const quietAccess = accessRequests.length;
  await page.waitForTimeout(1100); assert.equal(accessRequests.length, quietAccess, 'authorization panel adds no polling');
  // Keep the desktop workspace mounted; test the dialog itself at a phone's
  // content width (the host app switches workspaces at its mobile breakpoint).
  await page.setViewportSize({ width: 800, height: 844 });
  await access.evaluate(element => { element.style.width = '366px'; });
  const accessBounds = await access.evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth, right: element.getBoundingClientRect().right, screen: innerWidth }));
  assert.ok(accessBounds.scroll <= accessBounds.width + 1 && accessBounds.right <= accessBounds.screen, 'phone-width authorization has no horizontal overflow');
  if (process.env.AOD_TEST_BOARD_SCREENSHOT) await access.screenshot({ path: process.env.AOD_TEST_BOARD_SCREENSHOT });
  await page.keyboard.press('Escape'); await access.waitFor({ state: 'hidden' });
  await page.setViewportSize({ width: 1600, height: 1000 });
  assert.equal(await (await resourceCaption(board)).getByRole('textbox', { name: 'Board title', exact: true }).inputValue(), 'First tab draft', 'opening grant panel preserves draft');
  assert.equal(await board.getByRole('button', { name: 'Unsaved task must not be granted', exact: true }).count(), 1);
  await openAuthorization(board);
  await access.getByRole('button', { name: 'Revoke grant', exact: true }).waitFor();
  assert.equal(await access.getByRole('region', { name: 'Once-only credential' }).count(), 0, 'closed credential cannot be recovered');
  assert.equal(await access.getByRole('checkbox', { name: 'Isolated acceptance', exact: true }).isChecked(), false);
  // Lost revoke response is not optimistically presented as revoked.
  await access.getByRole('button', { name: 'Revoke grant', exact: true }).click();
  loseRevoke = true;
  await access.getByRole('button', { name: 'Confirm revoke', exact: true }).click();
  await access.getByRole('alert').filter({ hasText: 'Revocation unconfirmed' }).waitFor();
  assert.equal(await access.locator('[data-grant-state="active"]').count(), 1);
  assert.ok(hub.boardCapabilities.list('default', 'default')[0].revokedAt);
  await access.getByRole('button', { name: 'Refresh grants' }).click();
  await access.locator('[data-grant-state="revoked"]').waitFor();
  // Issue executed on server, but reply lost: no automatic POST retries.
  await access.getByRole('checkbox', { name: 'Isolated acceptance', exact: true }).check();
  await access.getByRole('checkbox', { name: 'Also allow reading and updating task details' }).check();
  loseGrant = true;
  await access.getByRole('button', { name: 'Issue selected task grant' }).click();
  await access.getByRole('alert').filter({ hasText: 'Grant outcome unconfirmed' }).waitFor();
  assert.equal(await access.getByRole('button', { name: 'Issue selected task grant' }).isDisabled(), true);
  await access.getByRole('button', { name: 'Load audit', exact: true }).click();
  await access.locator('.workspace-access-audit').first().waitFor();
  await access.getByRole('alert').filter({ hasText: 'Grant outcome unconfirmed' }).waitFor();
  const postCount = accessRequests.filter(path => path.startsWith('POST')).length;
  await page.waitForTimeout(1100); assert.equal(accessRequests.filter(path => path.startsWith('POST')).length, postCount);
  assert.equal(await access.count(), 1, `authorization remains mounted after audit: ${JSON.stringify(errors)}`);
  failGrantRead = true;
  await access.getByRole('button', { name: 'Refresh grants' }).click();
  await access.getByRole('alert').filter({ hasText: 'Unable to load grants' }).waitFor();
  assert.equal(await access.getByRole('button', { name: 'Issue selected task grant' }).isDisabled(), true);
  await access.getByRole('button', { name: 'Refresh grants' }).click();
  await access.locator('[data-grant-state="active"]').waitFor();
  assert.equal(await access.getByRole('region', { name: 'Once-only credential' }).count(), 0);
  grant = hub.boardCapabilities.list('default', 'default').find(item => item.revokedAt === null);
  assert.deepEqual([...grant.fields].sort(), ['detail', 'status']);
  await access.getByRole('button', { name: 'Revoke grant', exact: true }).click();
  await access.getByRole('button', { name: 'Confirm revoke', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-grant-state="revoked"]').length === 2);
  // Expiry updates from a local timer, without a new HTTP read.
  hub.boardCapabilities.issue('default', 'default', { taskIds: grant.taskIds, fields: ['status'], expiresAt: Date.now() + 1600 });
  await access.getByRole('button', { name: 'Refresh grants' }).click();
  await access.locator('[data-grant-state="active"]').waitFor();
  const expiryReads = accessRequests.length;
  await access.locator('[data-grant-state="expired"]').waitFor();
  assert.equal(accessRequests.length, expiryReads);
  // Cursor pagination with real metadata, never body or token.
  for (let i = 0; i < 101; i++) hub.boardCapabilities.issue('default', 'default', { taskIds: grant.taskIds, fields: ['status'], expiresAt: Date.now() + 60_000 });
  await access.getByRole('button', { name: 'Refresh audit', exact: true }).click();
  await access.getByRole('button', { name: 'Older audit events' }).waitFor();
  assert.equal(await access.locator('.workspace-access-audit').count(), 100);
  await access.getByRole('button', { name: 'Older audit events' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.workspace-access-audit').length > 100);
  const sequences = await access.locator('.workspace-access-audit small').allTextContents();
  assert.equal(new Set(sequences).size, sequences.length);
  await access.getByRole('button', { name: 'Close', exact: true }).click();
  await openAuthorization(page.getByRole('region', { name: 'Task board', exact: true }).nth(1));
  await access.getByRole('checkbox', { name: 'Private detail stays on board', exact: true }).waitFor();
  assert.equal(await access.getByRole('checkbox', { name: 'Isolated acceptance', exact: true }).count(), 0);
  assert.equal(await access.getByRole('region', { name: 'Once-only credential' }).count(), 0);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('agentopsdeck:auth-required')));
  await access.waitFor({ state: 'hidden' });
  await assertNoSecretStorage();
  assert.deepEqual(errors, []); assert.deepEqual(forbidden, []);
  console.log(JSON.stringify({ passed: true, boardReads: reads.length, boardWrites: writes.length, nativeCalls: 0,
    checks: ['actual Hub SQLite', 'state edit/save', 'float/dock no reads', 'layout restore', 'conflict draft survives reload', 'lost response idempotency', 'tab-local drafts', 'narrow layout', 'no chat polling', 'grant/copy/revoke', 'saved tasks only', 'duplicate issue click', 'lost grant/revoke responses', 'no credential persistence', 'expiry without polling', 'audit pagination', 'board and auth isolation', 'two-client resource updates', 'single stream per browser', 'duplicate metadata no reads', 'dirty board preserved', 'reconnect recovers failed read'] }));
} finally {
  await browser?.close(); await server.close(); routes?.close(); hub.close(); await rm(directory, { recursive: true, force: true });
}
