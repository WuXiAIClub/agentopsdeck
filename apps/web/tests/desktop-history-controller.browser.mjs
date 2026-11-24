// Lightweight, real-browser controller regression without mounting the app.
// Optional old-source control is bundled in memory, never into web/dist.
import assert from 'node:assert/strict';
import { fenceContext, verifyFence } from './fixtures/browser-network.mjs';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { transformWithEsbuild } from 'vite';
import { checkHistoryLayoutWork, checkHistoryLayoutLifecycle } from './fixtures/history-layout.mjs';

const { chromium } = await import(process.env.AOD_TEST_PLAYWRIGHT
  ? pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href : 'playwright');
const baseline = process.env.AOD_HISTORY_LAYOUT_CONTROLLER;
const path = baseline ?? new URL('../src/lib/desktop-history-layout.ts', import.meta.url);
let source = await readFile(path, 'utf8');
const marker = 'const protectedRow =';
assert.ok(source.includes(marker));
source = source.replace(marker, '(root as any).__historyLayoutVisits = ((root as any).__historyLayoutVisits ?? 0) + 1;\n      ' + marker)
  + '\n(window as any).observeHistoryLayoutForTest = observeDesktopHistoryLayout;';
const { code } = await transformWithEsbuild(source, 'history-controller.ts', { loader: 'ts', format: 'iife' });
const browser = await chromium.launch({ headless: true, executablePath: process.env.AOD_TEST_CHROMIUM });
try {
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 }, serviceWorkers: 'block' });
  const errors = [], denied = await fenceContext(context);
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ content: code });
  await checkHistoryLayoutWork({ page, incremental: !baseline });
  await checkHistoryLayoutLifecycle({ page, incremental: !baseline });
  assert.deepEqual(errors, []); assert.deepEqual(denied, []);
  await verifyFence(page, denied);
  console.log(JSON.stringify({ controllerOnly: true, baseline: !!baseline, errors, denied }));
} finally { await browser.close(); }
