// Production components, isolated synthetic documents and authorized metadata.
// Caption resize must preserve the report writer; overview never reads messages.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, preview } from 'vite';
import { resourceCaption } from './resource-caption.mjs';
const { chromium } = await import(pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href);
const root = fileURLToPath(new URL('..', import.meta.url)), output = await mkdtemp(join(tmpdir(), 'agentopsdeck-resource-content-'));
let server, browser;
try {
  await build({ root, configFile: join(root, 'vite.config.ts'), logLevel: 'error', build: { outDir: output, rollupOptions: { input: join(root, 'tests/fixtures/resource-content.html') } } });
  server = await preview({ root, configFile: false, envFile: false, logLevel: 'error', build: { outDir: output }, preview: { host: '127.0.0.1', port: 0 } });
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.AOD_TEST_CHROMIUM, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(12000);
  await page.addInitScript(() => localStorage.setItem('agentopsdeck.locale', 'en'));
  const errors = [], denied = [], calls = []; let saves = 0;
  let document = { kind: 'report', content: { title: 'Release report', text: 'Original report' }, revision: 0 };
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => {
    const req = route.request(), url = new URL(req.url()), path = url.pathname;
    if (url.origin !== origin) { denied.push(url.origin); return route.abort(); }
    if (!path.startsWith('/api/')) return route.continue();
    calls.push(`${req.method()} ${path}`);
    const json = body => route.fulfill({ json: body });
    if (path.startsWith('/api/hub/v1/workspace/file-cards/')) {
      if (req.method() === 'GET' && path.endsWith('/file-binding')) return json({ enabled: true, binding: null });
      if (req.method() === 'GET') return json(document);
      if (req.method() === 'PUT' && path.endsWith('/document')) {
        const input = req.postDataJSON();
        assert.equal(req.headers()['x-agentopsdeck-file-binding'], 'none');
        assert.equal(input.revision, document.revision); assert.match(input.mutationId, /^[a-f0-9-]{36}$/);
        saves++; document = { kind: input.kind, content: input.content, revision: document.revision + 1 };
        return json(document);
      }
    }
    denied.push(`${req.method()} ${path}`); return route.abort();
  });
  await page.goto(`${origin}/tests/fixtures/resource-content.html`);
  const report = page.getByRole('region', { name: 'Report', exact: true });
  const dashboard = page.getByRole('region', { name: 'Workspace overview', exact: true });
  const editor = report.getByRole('textbox', { name: 'Report', exact: true });
  const title = (await resourceCaption(report)).getByRole('textbox', { name: 'Card title', exact: true });
  await title.fill('Updated report');
  await editor.fill('Draft survives resizing');
  await editor.focus(); await editor.evaluate(el => { window.__reportEditor = el; });
  const reads = calls.length;
  await page.getByRole('button', { name: 'Narrow', exact: true }).evaluate(el => el.click());
  await page.locator('[data-pane=dashboard] .caption-overflow[data-collapsed=true]').waitFor();
  assert.equal(await editor.evaluate(el => el === window.__reportEditor && el === document.activeElement), true);
  assert.equal(await editor.textContent(), 'Draft survives resizing');
  assert.equal(calls.length, reads, 'resize must not save or reload the report');
  // A blur and explicit save in one event turn must share one writer.
  await editor.evaluate(el => {
    el.blur();
    document.querySelector('[data-pane=report] button[aria-label=Save]')?.click();
  });
  await page.waitForFunction(() => !document.querySelector('[data-pane=report] [role=status]') && document.querySelector('[data-pane=report] button[aria-label=Save]')?.disabled);
  assert.equal(saves, 1);
  await editor.focus(); await editor.evaluate(el => el.blur());
  const savedReads = calls.length;
  const dashboardCaption = await resourceCaption(dashboard);
  const search = dashboardCaption.getByRole('searchbox', { name: 'Search sessions', exact: true });
  assert.equal(await dashboard.locator('.workspace-dashboard-session').count(), 30);
  await search.fill('Session 64');
  assert.equal(await dashboard.locator('.workspace-dashboard-session').count(), 1);
  await dashboard.locator('.workspace-dashboard-session').click();
  assert.equal(await page.getByLabel('Selected session').textContent(), 's64');
  await (await resourceCaption(dashboard)).getByRole('searchbox').fill('');
  await page.keyboard.press('Escape');
  await dashboard.getByRole('button', { name: 'Next', exact: true }).click();
  assert.equal(await dashboard.locator('.workspace-dashboard-session').count(), 30);
  await dashboard.getByRole('button', { name: 'Next', exact: true }).click();
  assert.equal(await dashboard.locator('.workspace-dashboard-session').count(), 5);
  assert.equal(await dashboard.getByText('Hidden session', { exact: true }).count(), 0);
  assert.equal(await dashboard.getByText('Archived session', { exact: true }).count(), 0);
  await dashboard.locator('.workspace-dashboard-counts button[data-state=run]').click();
  await dashboard.getByText('No sessions match this view.', { exact: true }).waitFor();
  await dashboard.locator('.workspace-dashboard-counts button[data-state=run]').click();
  await page.waitForTimeout(1200);
  assert.equal(calls.length, savedReads, 'clean blur/filter/paging/selection do not read documents or messages');
  assert.equal(saves, 1); assert.equal(document.content.title, 'Updated report');
  assert.ok(document.content.text.includes('Draft survives resizing'));
  assert.equal(await editor.evaluate(el => el === window.__reportEditor), true);
  await page.reload();
  await editor.waitFor(); assert.equal(await editor.textContent(), 'Draft survives resizing');
  assert.equal(await (await resourceCaption(report)).getByRole('textbox', { name: 'Card title' }).inputValue(), 'Updated report');
  assert.equal(saves, 1, 'reload must not replay the write');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Narrow', exact: true }).click();
  await resourceCaption(dashboard);
  assert.equal(await page.locator('.caption-overflow-content:popover-open').evaluate(el => {
    const rect = el.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth && el.scrollWidth <= el.clientWidth + 1;
  }), true);
  await page.screenshot({ path: '/tmp/agentopsdeck-resource-content-narrow.png', fullPage: true });
  assert.deepEqual(errors, []); assert.deepEqual(denied, []);
  console.log('PASS report/dashboard: caption, stable report DOM/focus/draft, one revisioned save/reload, 65-session bounded pagination/filter/select, no layout or dashboard requests, 240px/390px overflow');
} finally {
  await browser?.close(); await server?.close(); await rm(output, { recursive: true, force: true });
}
