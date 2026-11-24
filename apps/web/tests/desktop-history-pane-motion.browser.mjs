// Synthetic desktop-only controller A/B. No application/account/network access.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { transformWithEsbuild } from 'vite';

const { chromium } = await import(process.env.AOD_TEST_PLAYWRIGHT
  ? pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href : 'playwright');
const baseline = process.env.AOD_PANE_MOTION_BASELINE;
let source = await readFile(baseline ?? new URL('../src/lib/desktop-history-layout.ts', import.meta.url), 'utf8');
const marker = 'dirty.add(row); waiting.delete(row);';
assert.ok(source.includes(marker));
source = source.replace(marker, '(root as any).__invalidations = ((root as any).__invalidations ?? 0) + 1; ' + marker)
  + '\n(window as any).observeHistoryLayoutForTest = observeDesktopHistoryLayout;';
const { code } = await transformWithEsbuild(source, 'history-controller.ts', { loader: 'ts', format: 'iife' });
const browser = await chromium.launch({ headless: true, executablePath: process.env.AOD_TEST_CHROMIUM });
try {
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 }, serviceWorkers: 'block' });
  const denied = [], errors = [];
  await context.route('**/*', route => { denied.push(route.request().url()); return route.abort(); });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ content: code });
  for (const size of [200, 2000]) {
    const result = await page.evaluate(async ({ size, baseline }) => {
      const check = (value, label) => { if (!value) throw new Error(label); };
      const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
      const settle = async () => { await frame(); await frame(); };
      const host = document.createElement('div');
      host.className = 'session-workspace-pane'; host.dataset.workspacePane = '';
      host.style.cssText = 'position:absolute;left:10px;top:10px;width:350px;height:300px;z-index:1';
      const wrapper = document.createElement('div'); wrapper.className = 'desktop-session-frame';
      const root = document.createElement('div'); root.style.cssText = 'height:300px;overflow:auto';
      const rows = Array.from({ length: size }, (_, i) => {
        const row = document.createElement('div'); row.className = 'desktop-message-with-tools';
        row.textContent = `Motion history ${i}. `.repeat(20); root.append(row); return row;
      });
      wrapper.append(root); host.append(wrapper); document.body.append(host);
      const stop = window.observeHistoryLayoutForTest(root);
      const waitCold = async () => {
        const deadline = performance.now() + 8000;
        while (root.querySelectorAll('[data-history-layout="auto"]').length < size - 35) {
          check(performance.now() < deadline, 'idle timeout'); await frame();
        }
        await settle();
      };
      const invalidations = () => root.__invalidations ?? 0;
      try {
        await waitCold();
        const initial = { height: root.scrollHeight, count: root.querySelectorAll('*').length, row: rows[100] };
        const scenarios = {};
        for (const kind of ['activation', 'move']) {
          await waitCold(); const before = invalidations();
          for (let i = 0; i < 12; i++) {
            if (kind === 'activation') host.style.zIndex = `${2 + i % 2}`;
            else { host.style.left = `${11 + i}px`; host.style.top = `${11 + i}px`; }
            await settle();
          }
          scenarios[kind] = invalidations() - before;
          if (!baseline) check(rows[100].dataset.historyLayout === 'auto', `${kind} must retain measured rows`);
        }
        check(root.scrollHeight === initial.height && root.querySelectorAll('*').length === initial.count
          && rows[100] === initial.row, 'motion preserves geometry and DOM identity');
        // All other ancestor changes stay conservative, including mixed style
        // deliveries, transient changes, CSS variables and inherited classes.
        const guards = {};
        for (const [name, change] of [
          ['width', () => { host.style.width = '320px'; }],
          ['fontAndMotion', () => { host.style.left = '30px'; host.style.fontSize = '19px'; }],
          ['transientFont', () => { host.style.fontSize = '21px'; host.style.fontSize = '19px'; }],
          ['customProperty', () => { host.style.setProperty('--chat-font', '20px'); }],
          ['class', () => { host.classList.add('different-theme'); }],
          ['direction', () => { host.dir = 'rtl'; }],
          ['height', () => { host.style.height = '290px'; }],
          ['nonHostPosition', () => { wrapper.style.left = '1px'; }],
          ['hide', () => { host.style.display = 'none'; }],
        ]) {
          await waitCold(); const before = invalidations(); change(); await settle();
          guards[name] = invalidations() - before;
          check(guards[name] >= size, `${name} must invalidate history`);
        }
        host.style.removeProperty('display'); await waitCold();
        host.style.width = 'auto'; await settle(); await waitCold();
        const beforeAuto = invalidations(); host.style.left = '32px'; await settle();
        guards.autoWidthPlacement = invalidations() - beforeAuto;
        check(guards.autoWidthPlacement >= size, 'non-pixel-sized hosts stay conservative');
        host.style.width = '320px'; await settle(); await waitCold();
        check(window.find('Motion history 100.', false, false, true), 'native find still sees retained history');
        await settle();
        check(root.querySelectorAll('[data-history-layout="auto"]').length === 0, 'selection protects history');
        window.getSelection().removeAllRanges(); await waitCold();
        return { size, scenarios, guards, nativeFind: true, selection: true, stableDOM: true };
      } finally {
        stop();
        check(rows.every(row => !row.style.contentVisibility && !row.style.containIntrinsicBlockSize), 'cleanup releases styles');
        host.remove();
      }
    }, { size, baseline: !!baseline });
    for (const count of Object.values(result.scenarios)) {
      if (baseline) assert.ok(count >= size * 12, JSON.stringify(result));
      else assert.equal(count, 0, JSON.stringify(result));
    }
    console.log(JSON.stringify({ paneMotion: result, baseline: !!baseline }));
  }
  assert.deepEqual(denied, []); assert.deepEqual(errors, []);
} finally { await browser.close(); }
