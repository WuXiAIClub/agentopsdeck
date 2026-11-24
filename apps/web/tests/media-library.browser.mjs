import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const require = createRequire(new URL('../package.json', import.meta.url));
const { createServer } = require('vite');
const { chromium } = await import(process.env.AOD_TEST_PLAYWRIGHT || 'playwright');
const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, envFile: false,
  plugins: [react(), tailwindcss(), { name: 'media-fixture', configureServer(instance) {
    instance.middlewares.use(async (req, res, next) => {
      if (!req.url?.startsWith('/__media')) return next();
      res.setHeader('content-type', 'text/html');
      res.end(await server.transformIndexHtml(req.url, '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/media-library.fixture.tsx"></script></body></html>'));
    });
  } }], server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
const roots = [{ id: 'one', label: 'Films' }, { id: 'two', label: 'Clips' }];
const listing = (path = '') => ({ enabled: true, roots, path, entries: path ? [] : [
  { kind: 'directory', name: 'Folder', path: 'folder' },
  { kind: 'video', name: 'demo.mp4', path: 'demo.mp4', size: 4096, playable: true, playbackUrl: '/api/media-library/playback/demo' },
  { kind: 'video', name: 'archive.mkv', path: 'archive.mkv', playable: false },
], truncated: false });
let browser;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.AOD_TEST_CHROMIUM ? { executablePath: process.env.AOD_TEST_CHROMIUM } : {}) });
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, locale: 'en-US', serviceWorkers: 'block' });
    const errors = [], unexpected = [];
    let disabled = true, hold = false, pending, fail = false;
    const mediaRequests = [];
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin || route.request().method() !== 'GET') { unexpected.push(url.href); return route.abort(); }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      if (url.pathname === '/api/media-library/playback/demo') return route.fulfill({ contentType: 'video/mp4', body: '' });
      if (url.pathname !== '/api/media-library') { unexpected.push(url.href); return route.abort(); }
      mediaRequests.push(url.search);
      if (hold) { pending = route; return; }
      if (fail) return route.fulfill({ status: 503, json: { error: 'fixture unavailable' } });
      // Configured folders can still be explicitly disabled by the operator.
      return route.fulfill({ json: disabled ? { enabled: false, roots, entries: [], path: '' } : listing(url.searchParams.get('path') || '') });
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/__media`);
    await page.getByRole('heading', { name: 'Private media library', exact: true }).waitFor();
    assert.equal(await page.getByText('No media directory is configured.', { exact: false }).count(), 0);
    await page.getByText('Administrator setup', { exact: true }).click();
    await page.getByText('AOD_MEDIA_LIBRARY_DIRS=/srv/agentopsdeck/videos', { exact: true }).waitFor();
    assert.deepEqual(mediaRequests, [''], 'disabled library must not fetch configured roots');
    await page.getByRole('combobox', { name: 'Language' }).selectOption('zh-CN');
    await page.getByText('多个文件夹请使用逗号分隔的绝对路径。', { exact: true }).waitFor();
    await page.getByText('AOD_MEDIA_LIBRARY_DIRS=D:\\AgentOpsDeck\\Videos', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    disabled = false;
    await page.getByRole('button', { name: '重新检查配置', exact: true }).click();
    const video = () => page.getByRole('button').filter({ hasText: 'demo.mp4' });
    await video().waitFor();
    await page.getByRole('combobox', { name: 'Language' }).selectOption('en');
    await page.getByText('Unknown size · Transcoding required', { exact: true }).waitFor();
    await video().click();
    await page.locator('video').waitFor();
    assert.equal(await video().count(), 0, 'playback replaces the catalogue');
    assert.equal(await page.getByRole('button', { name: 'Folder folder', exact: true }).count(), 0);
    assert.equal(await page.getByRole('heading', { name: 'Private media', exact: true }).count(), 0, 'no redundant player heading');
    for (const size of [{ width: 230, height: 160 }, { width: 320, height: 600 }, { width: 320, height: 200 }]) {
      await page.evaluate(size => window.mediaFixture.setPaneSize(size), size);
      await page.waitForFunction(size => document.getElementById('media-mount').clientHeight === size.height, size);
      const geometry = await page.evaluate(() => {
        const mount = document.getElementById('media-mount'), video = document.querySelector('video');
        const rect = video.getBoundingClientRect(), frame = mount.getBoundingClientRect();
        return { overflow: mount.scrollHeight > mount.clientHeight || mount.scrollWidth > mount.clientWidth,
          width: rect.width, height: rect.height, frameWidth: frame.width, frameHeight: frame.height,
          fit: getComputedStyle(video).objectFit };
      });
      assert.equal(geometry.overflow, false, `no player scrolling at ${size.width}x${size.height}`);
      assert.equal(geometry.width, geometry.frameWidth);
      assert.equal(geometry.height, geometry.frameHeight);
      assert.equal(geometry.fit, 'contain', 'portrait and landscape preserve aspect without cropping');
      assert.ok(await page.getByRole('button', { name: 'Close player', exact: true }).isVisible());
    }
    await page.evaluate(() => window.mediaFixture.setPaneSize(undefined));
    await page.getByText('This video codec is not supported by the browser, or the playback link expired. Refresh and try again.', { exact: true }).waitFor();
    // Storage denial must never turn media events into a React/render failure.
    await page.evaluate(() => {
      const originals = new Map();
      for (const method of ['setItem', 'getItem', 'removeItem']) {
        const original = Storage.prototype[method];
        originals.set(method, original);
        Storage.prototype[method] = function (key, ...args) {
          if (key.startsWith('agentopsdeck.media.resume.')) throw new Error('storage denied');
          return original.call(this, key, ...args);
        };
      }
      const media = document.querySelector('video');
      Object.defineProperty(media, 'currentTime', { value: 10 });
      for (const event of ['loadedmetadata', 'timeupdate', 'ended', 'waiting']) media.dispatchEvent(new Event(event));
      for (const [method, original] of originals) Storage.prototype[method] = original;
    });
    await page.getByText('Buffering…', { exact: true }).waitFor();
    await page.getByRole('combobox', { name: 'Language' }).selectOption('zh-CN');
    await page.getByText('正在缓冲…', { exact: true }).waitFor();
    await page.getByRole('combobox', { name: 'Language' }).selectOption('en');
    await page.getByRole('button', { name: 'Close player', exact: true }).click();
    assert.equal(await page.locator('video').count(), 0);
    // Closing returns to the same catalogue without a redundant list request.
    await video().waitFor();
    // A failed folder navigation clears the prior listing.
    fail = true;
    await page.getByRole('button', { name: 'Folder folder', exact: true }).click();
    await page.getByText('fixture unavailable', { exact: true }).waitFor();
    assert.equal(await page.locator('video').count(), 0);
    assert.equal(await video().count(), 0);
    fail = false;
    await page.getByRole('button', { name: 'Refresh media', exact: true }).click();
    await video().waitFor();
    // Scope changes clear already displayed data/player, not only late responses.
    await video().click();
    await page.locator('video').waitFor();
    await page.evaluate(() => {
      const media = document.querySelector('video');
      Object.defineProperty(media, 'currentTime', { value: 45 });
      media.dispatchEvent(new Event('timeupdate'));
    });
    assert.equal(await page.evaluate(() => localStorage.getItem(`agentopsdeck.media.resume.${'a'.repeat(64)}.one.demo.mp4`)), '45');
    hold = true;
    await Promise.all([
      page.waitForRequest(request => new URL(request.url()).pathname === '/api/media-library'),
      page.evaluate(() => window.mediaFixture.setRecoveryScope('b'.repeat(64))),
    ]);
    await page.getByText('Loading media…', { exact: true }).waitFor();
    assert.equal(await video().count(), 0);
    assert.equal(await page.locator('video').count(), 0);
    assert.equal(await page.getByRole('combobox', { name: 'Media directory' }).count(), 0);
    hold = false;
    await pending.fulfill({ json: listing() });
    await video().waitFor();
    await video().click();
    assert.equal(await page.evaluate(() => {
      const media = document.querySelector('video');
      Object.defineProperties(media, { duration: { value: 120 }, currentTime: { value: 0, writable: true } });
      media.dispatchEvent(new Event('loadedmetadata'));
      return media.currentTime;
    }), 0, 'account B must not resume account A playback');
    await page.evaluate(() => {
      const media = document.querySelector('video'); media.currentTime = 10; media.dispatchEvent(new Event('timeupdate'));
    });
    assert.deepEqual(await page.evaluate(() => ['a', 'b'].map(scope => localStorage.getItem(`agentopsdeck.media.resume.${scope.repeat(64)}.one.demo.mp4`))), ['45', '10']);
    await page.getByRole('button', { name: 'Close player', exact: true }).click();
    // Late unauthorized response from an earlier B epoch must not expire B → A → B.
    hold = true;
    await page.evaluate(() => { window.authEvents = 0; window.addEventListener('agentopsdeck:auth-required', () => window.authEvents++); });
    await Promise.all([page.waitForRequest(request => new URL(request.url()).pathname === '/api/media-library'), page.getByRole('button', { name: 'Refresh media', exact: true }).click()]);
    assert.ok(pending);
    const oldPending = pending;
    await Promise.all([
      page.waitForRequest(request => new URL(request.url()).pathname === '/api/media-library'),
      page.evaluate(() => { window.mediaFixture.setRecoveryScope('a'.repeat(64)); window.mediaFixture.setRecoveryScope('b'.repeat(64)); }),
    ]);
    assert.equal(await video().count(), 0, 'B → A → B must not reuse the original listing');
    await oldPending.fulfill({ status: 401, json: { error: 'old unauthorized' } });
    hold = false;
    await pending.fulfill({ json: listing() });
    await video().waitFor();
    assert.equal(await page.evaluate(() => window.authEvents), 0);
    // Unmount cancels the network read; remount gets its own fresh request.
    hold = true;
    await Promise.all([page.waitForRequest(request => new URL(request.url()).pathname === '/api/media-library'), page.getByRole('button', { name: 'Refresh media', exact: true }).click()]);
    const unmountedPending = pending;
    const cancelledRead = page.waitForEvent('requestfailed', { predicate: request => new URL(request.url()).pathname === '/api/media-library' });
    await page.evaluate(() => window.mediaFixture.setVisible(false));
    await cancelledRead;
    hold = false;
    await unmountedPending.fulfill({ json: listing() });
    await page.evaluate(() => window.mediaFixture.setVisible(true));
    await video().waitFor();
    // Auth loss during a load invalidates all late data and closes playback.
    hold = true;
    await Promise.all([page.waitForRequest(request => new URL(request.url()).pathname === '/api/media-library'), page.getByRole('button', { name: 'Refresh media', exact: true }).click()]);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('agentopsdeck:auth-required')));
    await pending.fulfill({ json: listing() });
    await page.getByRole('button', { name: 'Refresh media', exact: true }).click();
    assert.equal(await video().count(), 0);
    assert.equal(await page.locator('video').count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
    console.log(JSON.stringify({ viewport, passed: true }));
    await context.close();
  }
} finally { await browser?.close(); await server.close(); }
