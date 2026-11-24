// Real built React UI; isolated endpoints, no production filesystem or provider.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, preview } from 'vite';
const { chromium } = await import(pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href);
const root = fileURLToPath(new URL('..', import.meta.url)), output = await mkdtemp(join(tmpdir(), 'agentopsdeck-file-browser-'));
let server, browser;
try {
  await build({ root, configFile: join(root, 'vite.config.ts'), logLevel: 'error', build: { outDir: output, rollupOptions: { input: join(root, 'tests/fixtures/file-cards.html') } } });
  server = await preview({ root, configFile: false, envFile: false, logLevel: 'error', build: { outDir: output }, preview: { host: '127.0.0.1', port: 0 } });
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.AOD_TEST_CHROMIUM, headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  await context.addInitScript(() => localStorage.setItem('agentopsdeck.locale', 'en'));
  const page = await context.newPage(), calls = [], errors = [], denied = [];
  page.setDefaultTimeout(10000); page.on('pageerror', e => errors.push(e.message));
  let changed = false, fail = false;
  const folder = (name, path = name) => ({ name, path, kind: 'directory' });
  const file = (name, path = name) => ({ name, path, kind: 'file', canPreview: true, size: 1234 });
  const listing = path => path === 'docs' ? [folder('nested', 'docs/nested'), file(changed ? 'updated.md' : 'inside.md', 'docs/inside.md')]
    : path === 'docs/nested' ? [file('deep.md', 'docs/nested/deep.md')]
      : path === 'slow' ? [file('stale.md', 'slow/stale.md')]
        : [folder('docs'), folder('slow'), { ...folder('locked'), protected: true }, ...Array.from({ length: 245 }, (_, i) => file(`note-${i}.md`))];
  await page.route('**/*', async route => {
    const url = new URL(route.request().url()), path = url.pathname, at = url.searchParams.get('path') ?? '';
    if (url.origin !== origin) { denied.push(url.origin); return route.abort(); }
    if (!path.startsWith('/api/')) return route.continue();
    calls.push(`${path}?${at}`);
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/hub/v1/connections') return json({ connections: [{ id: 'local', label: 'Desktop Connector' }, { id: 'other', label: 'Remote Connector' }] });
    if (path.endsWith('/files/roots')) return json({ roots: [{ agentId: 'codex', label: 'Project workspace' }, { agentId: 'other', label: 'Another environment' }] });
    if (/\/files\/agents\//.test(path)) {
      if (at === 'slow') await new Promise(resolve => setTimeout(resolve, 450));
      if (fail) return json({ error: 'Directory unavailable' }, 403);
      return json({ entries: listing(at), path: at });
    }
    if (path === '/api/media-library') return json({ enabled: true, roots: [{ id: 'video', label: 'My videos' }], root: 'video', path: at, entries: at ? [{ name: 'movie.mp4', path: `${at}/movie.mp4`, kind: 'video', playable: true }] : [folder('Movies')], updatedAt: 1 });
    denied.push(path); return route.abort();
  });
  await page.goto(`${origin}/tests/fixtures/file-cards.html`);
  const card = page.locator('[data-pane=p0]');
  await card.getByRole('button', { name: 'docs', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Comfortable', exact: true }).click();
  const firstEntry = await card.getByRole('button', { name: 'docs', exact: true }).boundingBox();
  for (const control of [card.getByRole('combobox', { name: 'Select Connector' }), card.getByRole('combobox', { name: 'Workspace folder' }), card.getByRole('button', { name: 'Refresh', exact: true }), card.getByRole('button', { name: 'Media library', exact: true })]) {
    const bounds = await control.boundingBox(); assert.ok(bounds.y + bounds.height < firstEntry.y, 'controls stay above directory content');
  }
  const directories = () => calls.filter(call => call.includes('/files/agents/')).length;
  const metadata = () => calls.filter(call => call.includes('/files/roots') || call.startsWith('/api/hub/v1/connections?')).length;
  assert.equal(directories(), 1, 'one initial listing');
  assert.equal(await card.locator('.workspace-files-entry').count(), 200, 'bounded initial DOM');
  await card.getByRole('button', { name: /Show more/ }).click();
  assert.equal(await card.locator('.workspace-files-entry').count(), 248);
  assert.ok(await card.getByRole('button', { name: 'locked', exact: true }).isDisabled());
  const count = directories();
  await card.getByRole('button', { name: 'Explorer view' }).click();
  assert.equal(await card.locator('.workspace-files-explorer').count(), 1);
  await card.getByRole('button', { name: 'Tree view' }).click();
  assert.equal(directories(), count, 'mode switches do not read directories');
  await card.getByRole('button', { name: 'Expand folder: docs', exact: true }).click();
  await card.getByRole('button', { name: 'inside.md', exact: true }).waitFor();
  assert.equal(directories(), count + 1, 'only expanded folder loaded');
  await card.getByRole('button', { name: 'Expand folder: nested', exact: true }).click();
  await card.getByRole('button', { name: 'deep.md', exact: true }).waitFor();
  await card.getByRole('button', { name: 'List view' }).click();
  await card.getByRole('button', { name: 'docs', exact: true }).click();
  await card.getByRole('button', { name: 'inside.md', exact: true }).waitFor();
  assert.equal(directories(), count + 2, 'expanded folder reused for navigation');
  assert.equal(await card.getByRole('button', { name: 'Parent folder' }).textContent(), '…');
  changed = true;
  const meta = metadata();
  await card.getByRole('button', { name: 'Refresh', exact: true }).click();
  await card.getByRole('button', { name: 'updated.md', exact: true }).waitFor();
  assert.equal(metadata(), meta, 'refresh does not reload connector/environment catalog');
  await card.getByRole('button', { name: 'Parent folder' }).click();
  await card.getByRole('button', { name: 'slow', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-pane=p0] .workspace-files-path')?.textContent === 'slow');
  await card.getByRole('button', { name: 'Parent folder' }).click();
  await card.getByRole('button', { name: 'docs', exact: true }).waitFor();
  await page.waitForTimeout(550);
  assert.equal(await card.getByRole('button', { name: 'stale.md', exact: true }).count(), 0, 'late response cannot replace current directory');
  await card.getByRole('combobox', { name: 'Workspace folder', exact: true }).selectOption('other');
  await page.waitForFunction(() => document.querySelector('[data-pane=p0] .workspace-files-entry') !== null);
  assert.ok(calls.some(call => call.includes('/files/agents/other?')));
  await card.getByRole('combobox', { name: 'Select Connector' }).selectOption('other');
  await card.getByRole('button', { name: 'docs', exact: true }).waitFor();
  assert.ok(calls.some(call => call.includes('/connections/other/files/agents/')));
  fail = true;
  await card.getByRole('button', { name: 'Refresh', exact: true }).click();
  await card.getByRole('alert').waitFor();
  assert.equal(await card.locator('.workspace-files-entry').count(), 0, 'failed refresh clears cached listing');
  fail = false;
  await card.getByRole('button', { name: 'Refresh', exact: true }).click();
  await card.getByRole('button', { name: 'docs', exact: true }).waitFor();
  await card.getByRole('button', { name: 'Media library', exact: true }).click();
  await card.getByRole('button', { name: 'Movies', exact: true }).click();
  await card.getByRole('button', { name: 'movie.mp4', exact: true }).waitFor();
  await card.getByRole('button', { name: 'Explorer view' }).click();
  await card.getByRole('button', { name: 'Parent folder' }).click();
  await card.getByRole('button', { name: 'Movies', exact: true }).waitFor();
  await card.getByRole('button', { name: 'Workspace folder', exact: true }).click();
  await card.getByRole('button', { name: 'docs', exact: true }).waitFor();
  const idle = calls.length; await page.waitForTimeout(300); assert.equal(calls.length, idle, 'no background polling');
  await card.screenshot({ path: '/tmp/agentopsdeck-file-browser-explorer.png' });
  await card.getByRole('button', { name: 'Tree view' }).click();
  await card.getByRole('button', { name: 'Expand folder: docs', exact: true }).click();
  await card.getByRole('button', { name: 'updated.md', exact: true }).waitFor();
  await card.screenshot({ path: '/tmp/agentopsdeck-file-browser-tree.png' });
  await page.getByRole('button', { name: 'Narrow', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  for (const mode of ['Tree view', 'List view', 'Explorer view']) {
    await card.getByRole('button', { name: mode }).click();
    assert.ok(await card.evaluate(el => el.scrollWidth <= el.clientWidth + 1), `${mode} fits 240px legacy card`);
  }
  const prior = directories();
  await page.getByRole('button', { name: 'Change account' }).click();
  await card.getByRole('button', { name: 'docs', exact: true }).waitFor();
  assert.ok(directories() > prior, 'account recovery never reuses cached directories');
  // Exercise the real single-level caption overflow at 240 x 240 on desktop,
  // not merely a narrow phone viewport or a tall legacy fixture.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${origin}/tests/fixtures/file-cards.html?caption`);
  await card.getByRole('button', { name: 'docs', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Compact', exact: true }).click();
  const compactReads = directories();
  for (const mode of ['Tree view', 'List view', 'Explorer view']) {
    await card.getByRole('button', { name: 'Pane tools', exact: true }).click();
    await card.getByRole('button', { name: mode }).click();
    await page.keyboard.press('Escape');
    const bounds = await card.evaluate(el => {
      const list = el.querySelector('.workspace-files-list');
      return { width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height, fits: el.scrollWidth <= el.clientWidth + 1, listHeight: list.clientHeight, listFits: list.scrollWidth <= list.clientWidth + 1 };
    });
    assert.equal(bounds.width, 240); assert.equal(bounds.height, 240);
    assert.ok(bounds.fits && bounds.listFits && bounds.listHeight > 100, `${mode}: ${JSON.stringify(bounds)}`);
  }
  assert.equal(directories(), compactReads, 'resizing and compact view switching do not read directories');
  await card.getByRole('button', { name: 'docs', exact: true }).click();
  await card.getByRole('button', { name: 'updated.md', exact: true }).waitFor();
  await card.getByRole('button', { name: 'Parent folder' }).click();
  await card.getByRole('button', { name: 'docs', exact: true }).waitFor();
  await card.screenshot({ path: '/tmp/agentopsdeck-file-browser-compact.png' });
  assert.deepEqual(errors, []); assert.deepEqual(denied, []);
  console.log('PASS file browser: list/tree/Explorer, lazy subtree, bounded DOM, cache reuse/refresh, no metadata amplification, stale request abort, environment/Connector/account isolation, errors/retry, media folders, narrow layouts, no polling');
} finally { await browser?.close(); await server?.close(); await rm(output, { recursive: true, force: true }); }
