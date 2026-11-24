// Compare the compact footer icon to the installed Lucide reference. No APIs.
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const { chromium } = await import(pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href);
const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false,
  envFile: false, plugins: [react()], logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [], denied = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { denied.push(url.href); return route.abort(); }
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
    return route.continue();
  });
  await page.goto(origin);
  const result = await page.evaluate(async () => {
    const { render, unmount } = await import('/tests/message-focus-icon.fixture.tsx');
    const comparisons = [];
    async function raster(svg, size, scale) {
      const image = new Image();
      image.src = 'data:image/svg+xml,' + encodeURIComponent(new XMLSerializer().serializeToString(svg));
      await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = size * scale;
      const context = canvas.getContext('2d');
      // Compare visible composited pixels; RGB in fully transparent pixels is
      // undefined and would incorrectly score a near-transparent edge as 255.
      context.fillStyle = svg.getAttribute('stroke') === '#ffffff' ? '#2563eb' : '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      return context.getImageData(0, 0, canvas.width, canvas.height).data;
    }
    for (const size of [13, 16, 24]) for (const scale of [1, 2, 3]) for (const color of ['#ffffff', '#64748b']) {
      render(size, color);
      const [before, after] = document.querySelectorAll('svg');
      const attrs = el => JSON.stringify([...el.attributes].map(a => [a.name, a.value]).sort());
      if (attrs(before) !== attrs(after)) throw new Error('SVG attributes changed');
      if (before.childElementCount !== 4 || after.childElementCount !== 2) throw new Error('Expected 4 → 2 paths');
      const a = await raster(before, size, scale), b = await raster(after, size, scale);
      let changed = 0, maxDelta = 0, delta = 0;
      for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); changed += Number(d > 0); maxDelta = Math.max(maxDelta, d); delta += d; }
      comparisons.push({ size, scale, color, changedChannels: changed, maxDelta, meanDelta: delta / a.length });
    }
    unmount();
    return comparisons;
  });
  console.log(JSON.stringify({ comparisons: result, cases: result.length, removedElementsPerIcon: 2 }));
  for (const item of result) {
    if (item.size === 13 && item.scale <= 2) assert.equal(item.maxDelta, 0, JSON.stringify(item));
    // Scaled raster rounding: below 0.02 out of 255 on average, at most 6
    // levels in any channel. The production 13px icon at 3x differs by <= 2.
    assert.ok(item.meanDelta < 0.02 && item.maxDelta <= (item.size === 13 ? 2 : 6), JSON.stringify(item));
  }
  assert.deepEqual(errors, []); assert.deepEqual(denied, []);
} finally { await browser?.close(); await server.close(); }
