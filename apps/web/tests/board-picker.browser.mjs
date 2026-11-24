import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { preview } from 'vite';
import { presetWorkspace } from '../src/lib/workspace-layout.ts';
import { layoutSnapshot } from '../src/lib/current-layout.ts';
import { assertOverflowStable } from './caption-overflow-stability.mjs';

const { chromium } = await import(pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href);
const webDist = process.env.AOD_TEST_WEB_DIST ? resolve(process.env.AOD_TEST_WEB_DIST) : fileURLToPath(new URL('../dist', import.meta.url));
await access(join(webDist, 'index.html'));
const server = await preview({ root: webDist, configFile: false, envFile: false, logLevel: 'error', build: { outDir: webDist }, preview: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.AOD_TEST_CHROMIUM });
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block',
      ...(width < 700 ? { userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Safari/604.1', hasTouch: true } : {}) });
    const scope = 'a'.repeat(64), sessionKey = `local:${btoa('codex:picker')}`;
    const boardId = '11111111-1111-4111-8111-111111111111', secondId = '22222222-2222-4222-8222-222222222222', bindingId = '33333333-3333-4333-8333-333333333333';
    const title = 'AgentOpsDeck 开发任务板 · 较长名称用于验证完整换行和点击区域';
    const session = { sessionKey, source: 'codex', agentId: 'codex', envConnectionId: 'local', title: 'AgentOpsDeck 修复会话', status: 'idle', sessionRef: { runtimeId: 'codex', nativeSessionId: 'picker' } };
    const binding = { bindingId, resourceId: boardId, sessionId: sessionKey, state: 'active', problem: null };
    const boards = [boardId, secondId].map((resourceId, index) => ({ resourceId, title, revision: 2, updatedAt: 1791241200000 + index * 1000,
      tasks: [{ id: resourceId, title: index ? '第二块板：独立验收任务' : '第一块板：修复任务板选择器', detail: '', status: 'doing' }], ...(index ? {} : { fileBinding: binding }) }));
    const errors = [], forbidden = [];
    let catalogReads = 0;
    await context.addInitScript(({ scope, snapshot }) => {
      localStorage.setItem('agentopsdeck.locale', 'zh-CN');
      localStorage.setItem(`agentopsdeck.current-layout.v2:${scope}`, JSON.stringify(snapshot));
      window.EventSource = class extends EventTarget { readyState = 1; static OPEN = 1; constructor() { super(); queueMicrotask(() => this.onopen?.(new Event('open'))); } close() { this.readyState = 2; } };
    }, { scope, snapshot: layoutSnapshot(presetWorkspace([{ id: 'session-pane', sessionKey }], 'single'), new Set()) });
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin || request.method() !== 'GET') { forbidden.push(`${request.method()} ${url.pathname}`); return route.abort(); }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const json = body => route.fulfill({ json: body });
      if (url.pathname === '/api/auth/status') return json({ authenticated: true, recoveryScope: scope, passkeys: { available: false, count: 0 } });
      if (url.pathname.endsWith('/sessions/state')) return json({ revision: '1', groups: [{ agentId: 'codex', sessions: [session] }] });
      if (url.pathname.endsWith('/messages')) return json({ revision: '1', totalCount: 0, hiddenCount: 0, messages: [] });
      if (url.pathname.endsWith('/queue')) return json({ items: [] });
      if (url.pathname.endsWith('/notebooks')) return json({ items: [] });
      if (url.pathname === '/api/agents') return json({ agents: [] });
      if (url.pathname === '/api/gateway/status') return json({ connected: true });
      if (url.pathname === '/api/hub/v1/workspace/boards') { catalogReads++; return json({ boards: boards.map(({ tasks, fileBinding, ...board }) => ({ ...board, counts: { todo: 0, doing: 1, done: 0 } })) }); }
      for (const board of boards) {
        const path = `/api/hub/v1/workspace/boards/${board.resourceId}`;
        if (url.pathname === path) return json(board);
        if (url.pathname === `${path}/file-binding`) return json({ enabled: true, binding: board.fileBinding ?? null });
        if (url.pathname === `${path}/file-binding/capabilities`) return json({ writable: true });
      }
      return route.fulfill({ status: 404, json: {} });
    });
    const page = await context.newPage(); page.setDefaultTimeout(12000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    const directory = page.getByRole('button', { name: '任务板目录', exact: true });
    await directory.click();
    const dialog = page.getByRole('dialog', { name: '任务板目录' });
    await dialog.waitFor();
    assert.equal(await dialog.evaluate(node => node.parentElement === document.body), true);
    const search = dialog.getByRole('searchbox', { name: '搜索任务板' });
    await search.fill('不存在');
    await dialog.getByText('没有匹配的任务板', { exact: true }).waitFor();
    await search.fill('AgentOpsDeck');
    const choices = dialog.locator('.workspace-board-picker-list > button');
    assert.equal(await choices.count(), 2);
    for (const choice of await choices.all()) {
      assert.ok((await choice.boundingBox()).height >= 70);
      assert.equal(await choice.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
    }
    await choices.nth(1).click();
    await dialog.getByText('第二块板：独立验收任务', { exact: true }).waitFor();
    await choices.first().click();
    await dialog.getByText('第一块板：修复任务板选择器', { exact: true }).waitFor();
    const rect = await dialog.boundingBox(); assert.ok(rect.x >= 0 && rect.x + rect.width <= width);
    if (process.env.AOD_PICKER_SCREENSHOT_DIR && width !== 320) await page.screenshot({ path: join(process.env.AOD_PICKER_SCREENSHOT_DIR, `picker-${width}.png`) });
    await dialog.getByRole('button', { name: '打开到当前布局', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    const boardPane = page.locator('[data-workspace-pane]').filter({ has: page.locator('.workspace-taskboard') });
    await boardPane.locator('.workspace-taskboard[data-board-ready="true"]').waitFor();
    async function tool(name) {
      const button = boardPane.getByRole('button', { name, exact: true });
      if (!await button.isVisible()) await boardPane.getByRole('button', { name: '面板工具', exact: true }).click();
      await button.click();
    }
    await tool('任务板目录');
    await dialog.waitFor();
    await dialog.getByRole('searchbox').fill('AgentOpsDeck');
    await dialog.locator('.workspace-board-picker-list > button').first().click();
    await dialog.getByText('第一块板：修复任务板选择器', { exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    await tool('关联整个面板');
    const file = boardPane.locator('.workspace-file-board-binding');
    await file.getByText(session.title, { exact: true }).waitFor();
    await file.getByText(`${bindingId}/tasks.json`, { exact: true }).waitFor();
    assert.equal(await file.getByText(`${boardId}/tasks.json`, { exact: true }).count(), 0);
    assert.ok((await file.innerText()).includes('不需要你选择已有文件或填写 ID'));
    if (width < 700) {
      const caption = boardPane.locator('.session-pane-caption'), trigger = caption.locator('.caption-overflow > button');
      if (await trigger.getAttribute('aria-expanded') === 'true') await trigger.click();
      await assertOverflowStable(caption, trigger);
    }
    if (width === 1440) {
      await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
      await boardPane.evaluate(el => {
        window.originalBoardTools = el.querySelector('.resource-card-tools');
        window.originalBoard = el.querySelector('.workspace-taskboard');
      });
      const geometry = [];
      for (const paneWidth of [1200, 640, 480, 360, 280, 240, 1200]) {
        await boardPane.evaluate((el, value) => el.style.setProperty('width', `${value}px`, 'important'), paneWidth);
        await page.waitForTimeout(150);
        const result = await boardPane.locator('.session-pane-caption').evaluate(el => ({
          width: el.clientWidth, scrollWidth: el.scrollWidth, titleWidth: el.querySelector('.session-pane-drag-title').getBoundingClientRect().width,
          collapsed: el.querySelector('.caption-overflow').dataset.collapsed,
          inlineButtons: [...el.querySelectorAll('.resource-card-tools button')].filter(button => button.checkVisibility({ visibilityProperty: true })).length,
          sameTools: window.originalBoardTools === el.querySelector('.resource-card-tools'),
          priorities: [...el.querySelectorAll('.resource-card-tools > *')].filter(item => item.getBoundingClientRect().width > 0).map(item => ({
            priority: Number(item.dataset.captionPriority ?? 50), hidden: item.hasAttribute('data-caption-hidden'),
          })),
        }));
        assert.ok(result.scrollWidth <= result.width + 1, JSON.stringify(result));
        assert.ok(result.titleWidth >= 64, JSON.stringify(result));
        assert.equal(result.sameTools, true);
        for (const hidden of result.priorities.filter(item => item.hidden)) {
          for (const inline of result.priorities.filter(item => !item.hidden)) assert.ok(inline.priority >= hidden.priority, `priority inversion: ${JSON.stringify(result)}`);
        }
        if (result.collapsed === 'true' && result.inlineButtons > 0) assert.equal(await boardPane.locator('.session-pane-caption').getByRole('button', { name: '保存', exact: true }).isVisible(), true, 'save survives lower-priority board controls');
        assert.equal(await boardPane.evaluate(el => window.originalBoard === el.querySelector('.workspace-taskboard')), true);
        geometry.push(result);
        if (result.collapsed === 'true') {
          const caption = boardPane.locator('.session-pane-caption');
          await assertOverflowStable(caption, caption.locator('.caption-overflow > button'));
        }
      }
      assert.equal(geometry[0].collapsed, 'false');
      assert.equal(geometry.at(-1).collapsed, 'false');
      assert.ok(geometry.some(item => item.collapsed === 'true' && item.inlineButtons > 0 && item.inlineButtons < geometry[0].inlineButtons), JSON.stringify(geometry));
      console.log('Progressive resource caption widths', JSON.stringify(geometry));
    }
    assert.equal(catalogReads, 2, 'catalog only reads on explicit opening');
    assert.deepEqual(forbidden, [], 'opening, searching and previewing never write or send');
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`PASS board directory ${width}: long/duplicate titles, search, preview, restore, caption overflow, Escape, correct managed filename/session, no writes`);
  }
} finally { await browser?.close(); await server.close(); }
