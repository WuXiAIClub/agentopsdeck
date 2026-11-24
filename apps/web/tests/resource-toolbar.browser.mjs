// Real resource controls in the same caption/overflow primitive as Session Chat.
// Isolated API fixtures: no production files, remote agents or paid providers.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, preview } from 'vite';
const { chromium } = await import(pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href);
const root = fileURLToPath(new URL('..', import.meta.url)), output = await mkdtemp(join(tmpdir(), 'agentopsdeck-resource-tools-'));
let server, browser;
try {
  await build({ root, configFile: join(root, 'vite.config.ts'), logLevel: 'error', build: { outDir: output, rollupOptions: { input: join(root, 'tests/fixtures/file-cards.html') } } });
  server = await preview({ root, configFile: false, envFile: false, logLevel: 'error', build: { outDir: output }, preview: { host: '127.0.0.1', port: 0 } });
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.AOD_TEST_CHROMIUM, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.addInitScript(() => localStorage.setItem('agentopsdeck.locale', 'en'));
  const errors = [], denied = [], calls = []; let saves = 0;
  page.on('pageerror', e => errors.push(e.message)); page.setDefaultTimeout(12000);
  await page.route('**/*', route => {
    const req = route.request(), url = new URL(req.url()), path = url.pathname;
    if (url.origin !== origin) { denied.push(url.origin); return route.abort(); }
    if (!path.startsWith('/api/')) return route.continue();
    calls.push(path);
    const json = body => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/hub/v1/connections') return json({ connections: [{ id: 'local', label: 'Development Connector' }] });
    if (path.endsWith('/files/roots')) return json({ roots: [{ agentId: 'codex', label: 'Project environment' }] });
    if (path.endsWith('/files/agents/codex')) return json({ path: '', entries: [{ name: 'notes.md', path: 'notes.md', kind: 'file', mimeType: 'text/markdown', size: 24, canPreview: true }] });
    if (path.endsWith('/preview')) return json({ kind: 'text', name: 'notes.md', text: 'Original', canEdit: true, revision: 'a'.repeat(64) });
    if (path.endsWith('/text')) { saves++; return json({ revision: 'b'.repeat(64) }); }
    if (path === '/api/media-library') return json({ enabled: true, roots: [{ id: 'media', label: 'Videos' }], root: 'media', path: '', entries: [], updatedAt: 1 });
    denied.push(path); return route.abort();
  });
  await page.goto(`${origin}/tests/fixtures/file-cards.html?caption`);
  const files = page.locator('[data-pane=p0]'), editor = page.locator('[data-pane=p1]');
  await files.getByRole('button', { name: 'notes.md', exact: true }).waitFor();
  const caption = files.locator('.session-pane-caption');
  assert.equal(await caption.getByRole('combobox').count(), 2);
  assert.equal(await files.locator('.session-pane-content .resource-card-toolbar').count(), 0);
  await files.locator('.caption-overflow[data-collapsed=false]').waitFor();
  const centers = [];
  for (const label of ['Link file cards', 'Toggle card connections', 'Refresh']) {
    const button = caption.getByRole('button', { name: label, exact: true });
    const rect = await button.boundingBox(), icon = await button.locator('svg').boundingBox();
    assert.equal(icon.width, 15, `${label} uses the shared icon size`);
    centers.push(rect.y + rect.height / 2);
  }
  assert.ok(Math.max(...centers) - Math.min(...centers) < 1, 'connection icons align with other caption actions');
  await files.getByRole('button', { name: 'Link file cards', exact: true }).click();
  await page.getByRole('dialog').getByRole('checkbox').first().check();
  await page.keyboard.press('Escape');
  await files.getByRole('button', { name: 'notes.md', exact: true }).click();
  const text = editor.getByRole('textbox', { name: 'File content' });
  await text.fill('Draft survives caption resize');
  // Resize without stealing focus; counters prove there are no hidden re-reads.
  const before = calls.length;
  await text.evaluate(el => { window.__editor = el; });
  await page.getByRole('button', { name: 'Narrow', exact: true }).evaluate(el => el.click());
  await files.locator('.caption-overflow[data-collapsed=true]').waitFor();
  assert.equal(await text.evaluate(el => el === window.__editor && el === document.activeElement), true);
  assert.equal(await text.inputValue(), 'Draft survives caption resize');
  await caption.getByRole('button', { name: 'Pane tools', exact: true }).click();
  const popup = files.locator('.caption-overflow-content:popover-open');
  await popup.waitFor();
  await page.screenshot({ path: '/tmp/agentopsdeck-resource-toolbar-narrow.png', fullPage: true });
  assert.equal(await popup.getByRole('combobox').count(), 2);
  assert.equal(await popup.getByRole('button', { name: 'Pane tools', exact: true }).count(), 0);
  assert.equal(await popup.evaluate(el => {
    const r = el.getBoundingClientRect();
    return r.left >= 0 && r.right <= innerWidth && el.scrollWidth <= el.clientWidth + 1;
  }), true, 'one level popup must fit viewport without horizontal clipping');
  // Escape closes popover; editor and its unsaved content still exist.
  await page.keyboard.press('Escape'); await popup.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Wide', exact: true }).evaluate(el => el.click());
  await files.locator('.caption-overflow[data-collapsed=false]').waitFor();
  assert.equal(await text.evaluate(el => el === window.__editor), true);
  assert.equal(calls.length, before, 'layout/menu operations must not reload directory or preview');
  await editor.locator('.session-pane-caption').getByRole('button', { name: 'Save', exact: true }).click();
  await editor.getByRole('status').locator('[aria-label="Saved"]').waitFor(); assert.equal(saves, 1);
  await page.getByRole('button', { name: 'Compact', exact: true }).click();
  await editor.locator('.caption-overflow[data-collapsed=true]').waitFor();
  assert.ok(await text.evaluate(el => el.clientHeight >= 100), '240px card preserves usable document space');
  assert.ok(await editor.evaluate(el => el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1), 'compact editor fits both axes');
  await editor.screenshot({ path: '/tmp/agentopsdeck-editor-ui-compact.png' });
  assert.deepEqual(errors, []); assert.deepEqual(denied, []);
  await page.screenshot({ path: join(output, 'resource-caption.png'), fullPage: true });
  console.log('PASS resource caption: wide/narrow, one-level popover, keyboard, linked editor, stable DOM/focus/draft, zero resize reads, single save');
} finally {
  await browser?.close(); await server?.close(); await rm(output, { recursive: true, force: true });
}
