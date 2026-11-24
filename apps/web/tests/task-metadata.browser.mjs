import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
const { chromium } = await import(pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href);
const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, envFile: false,
  plugins: [react(), tailwindcss(), { name: 'metadata-fixture', configureServer(instance) { instance.middlewares.use(async (req, res, next) => {
    if (req.url !== '/__metadata') return next();
    res.setHeader('content-type', 'text/html'); res.end(await server.transformIndexHtml(req.url,
      '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/task-metadata.fixture.tsx"></script></body></html>'));
  }); } }], server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
let browser;
try {
  await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.AOD_TEST_CHROMIUM });
  for (const width of [320, 390, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } }), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem('agentopsdeck.locale', 'en'));
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.goto(`${origin}/__metadata`);
    const editor = page.getByRole('dialog'), save = editor.getByRole('button', { name: 'Save', exact: true });
    await editor.getByLabel('Task priority', { exact: true }).selectOption('high');
    await editor.getByLabel('Due date', { exact: true }).fill('2028-02-29');
    for (let i = 1; i <= 8; i++) {
      await editor.getByRole('button', { name: 'Add tag', exact: true }).click();
      assert.equal(await save.isDisabled(), true);
      await editor.getByLabel(`Task tag ${i}`, { exact: true }).fill(`标签${i}`);
    }
    assert.equal(await editor.getByRole('button', { name: 'Add tag', exact: true }).isDisabled(), true);
    assert.equal(await save.isEnabled(), true);
    await editor.getByLabel('Task tag 8', { exact: true }).fill('标签1');
    assert.equal(await save.isDisabled(), true, 'duplicate tags block saving');
    await editor.getByLabel('Task tag 8', { exact: true }).fill('LongUnbrokenTagText123456789012345');
    assert.equal(await save.isEnabled(), true);
    assert.equal(await editor.evaluate(node => node.scrollWidth > node.clientWidth), false);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await editor.getByRole('button', { name: 'Toggle lock' }).click();
    assert.equal(await editor.getByLabel('Task priority', { exact: true }).isDisabled(), true);
    assert.equal(await editor.getByLabel('Due date', { exact: true }).evaluate(node => node.readOnly), true);
    assert.equal(await editor.getByRole('button', { name: 'Remove tag 1', exact: true }).isDisabled(), true);
    assert.deepEqual(errors, []);
    console.log(`task metadata ${width}px: tags/max/duplicates/priority/date/read-only/overflow passed`);
    await page.close();
  }
} finally { await browser?.close(); await server.close(); }
