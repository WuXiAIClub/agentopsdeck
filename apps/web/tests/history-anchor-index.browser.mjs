// Real Chromium geometry, no app/server/business traffic.
import assert from 'node:assert/strict';
import { fenceContext, verifyFence } from './fixtures/browser-network.mjs';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { transformWithEsbuild } from 'vite';

const { chromium } = await import(process.env.AOD_TEST_PLAYWRIGHT ? pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href : 'playwright');
const source = await readFile(new URL('../src/lib/history-anchor-index.ts', import.meta.url), 'utf8');
const { code } = await transformWithEsbuild(source + '\nwindow.anchorIndexForTest = createHistoryAnchorIndex;', 'anchor-index.ts', { loader: 'ts', format: 'iife' });
const browser = await chromium.launch({ headless: true, executablePath: process.env.AOD_TEST_CHROMIUM });
try {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 }, serviceWorkers: 'block' });
  const denied = await fenceContext(context), errors = [];
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.setContent('<button id="outside">outside</button>');
  await page.addScriptTag({ content: code });
  const results = await page.evaluate(() => {
    const check = (condition, label) => { if (!condition) throw new Error(label); };
    const results = [];
    for (const size of [200, 2000]) {
      const wrapper = document.createElement('div'); wrapper.className = 'desktop-session-frame';
      const root = document.createElement('div'); root.style.cssText = 'height:300px;overflow:auto;overflow-anchor:none';
      wrapper.append(root); document.body.append(wrapper);
      let reads = 0, scans = 0;
      const nodes = Array.from({ length: size }, (_, i) => {
        const node = document.createElement('div'); node.dataset.messageSearchId = `row-${i}`;
        node.style.cssText = `height:${20 + i % 9}px`; node.textContent = `Message ${i}`;
        const rect = node.getBoundingClientRect.bind(node);
        node.getBoundingClientRect = () => { reads++; return rect(); };
        root.append(node); return node;
      });
      const query = root.querySelectorAll.bind(root);
      root.querySelectorAll = selector => { scans++; return query(selector); };
      const index = window.anchorIndexForTest(root);
      root.scrollTop = root.scrollHeight * .7;
      const top = root.getBoundingClientRect().top;
      const reference = nodes.find(node => node.getBoundingClientRect().bottom > top);
      const linearReads = reads; reads = 0;
      const saved = index.capture();
      check(saved.id === reference.dataset.messageSearchId, 'same first visible row');
      check(saved.top === reference.getBoundingClientRect().top, 'same top');
      const binaryReads = reads - 1;
      check(binaryReads <= Math.ceil(Math.log2(size)) + 1, 'logarithmic geometry reads');
      check(scans === 1, 'first capture builds index once');
      for (let n = 0; n < 40; n++) { nodes.at(-1).firstChild.textContent = `stream ${n}`; index.capture(); }
      check(scans === 1, 'text streaming does not rebuild wrapper index');
      reads = 0;
      check(index.get(saved.id) === reference && reads === 0, 'id lookup has no geometry reads');
      const extra = document.createElement('div'); extra.dataset.messageSearchId = 'older'; extra.style.height = '80px'; extra.textContent = 'older';
      root.prepend(extra);
      // No microtask/observer delivery: must consume takeRecords now.
      const anchor = index.get(saved.id);
      root.scrollTop += anchor.getBoundingClientRect().top - saved.top;
      check(anchor.getBoundingClientRect().top === saved.top, 'prepend restores exact anchor');
      check(index.get('older') === extra, 'same-task insertion indexed');
      extra.dataset.messageSearchId = 'renamed';
      check(index.get('older') === undefined && index.get('renamed') === extra, 'identity edit indexed');
      extra.remove(); check(index.get('renamed') === undefined, 'removed nodes released');
      const currentDesktop = index.capture();
      wrapper.className = '';
      check(index.capture().id === currentDesktop.id, 'mobile fallback matches desktop');
      wrapper.style.display = 'none';
      check(index.capture() === undefined, 'hidden pane has no anchor');
      index.dispose(); wrapper.remove();
      results.push({ size, linearReads, binaryReads, streamScans: 1, prepend: true, synchronousMutations: true, mobile: true, hidden: true });
    }
    return results;
  });
  assert.deepEqual(denied, []); assert.deepEqual(errors, []);
  await verifyFence(page, denied);
  console.log(JSON.stringify({ anchorIndex: results, errors, denied }));
} finally { await browser.close(); }
