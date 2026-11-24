// Actual React component under StrictMode. No API or external requests permitted.
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
const { chromium } = await import(pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href);
const fixture = `import React from 'react';
import {createRoot} from 'react-dom/client';
import Actions from '/src/components/ResearchSynthesisActions.tsx';
import {setLocale} from '/src/lib/i18n.ts';
import '/src/styles.css';
setLocale(new URLSearchParams(location.search).get('locale')||'en');
const root=createRoot(document.getElementById('root'));
window.renderActions=text=>root.render(React.createElement(React.StrictMode,null,React.createElement(Actions,{key:text,text})));
window.unmountActions=()=>root.unmount();
window.copyCalls=[];
Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:text=>{window.copyCalls.push(text);return new Promise((resolve,reject)=>{window.resolveCopy=resolve;window.rejectCopy=()=>reject(Error('private upstream detail'));});}}});
window.renderActions('First evidence');`;
const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, envFile: false,
  logLevel: 'error', server: { host: '127.0.0.1', port: 0 }, plugins: [react(), {
    name: 'synthesis-actions-fixture', resolveId(id) { if (id === '/actions.js') return '\0actions.js'; },
    load(id) { if (id === '\0actions.js') return fixture; },
    configureServer(vite) { vite.middlewares.use(async (req, res, next) => {
      if (!req.url.startsWith('/actions?')) return next();
      res.setHeader('Content-Type', 'text/html');
      res.end(await vite.transformIndexHtml(req.url, '<!doctype html><html><body style="margin:0"><div id="root"></div><script type="module" src="/actions.js"></script></body></html>'));
    }); },
  }] });
let browser;
try {
  await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.AOD_TEST_CHROMIUM });
  for (const [width, locale] of [[1440, 'en'], [390, 'zh-CN'], [320, 'en']]) for (const mode of ['manual', 'replace-success', 'replace-failure', 'unmount']) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    const page = await context.newPage(), errors = []; page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin || url.pathname.startsWith('/api/')) { errors.push('unexpected request'); return route.abort(); }
      return route.continue();
    });
    await page.goto(`${origin}/actions?locale=${locale}`);
    const copy = page.getByRole('button', { name: locale === 'zh-CN' ? '复制综合结果和引用片段' : 'Copy synthesis and cited snippets', exact: true });
    await copy.click(); await copy.click(); assert.deepEqual(await page.evaluate(() => window.copyCalls), ['First evidence']);
    if (mode === 'manual') {
      await page.evaluate(() => window.rejectCopy());
      const manual = page.getByRole('textbox'); await manual.waitFor(); assert.equal(await manual.inputValue(), 'First evidence');
      assert.ok(!(await page.locator('body').innerText()).includes('private upstream detail'));
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await copy.click(); await page.evaluate(() => window.resolveCopy());
      await manual.waitFor({ state: 'detached' }); await page.getByRole('status').waitFor();
    } else {
      await page.evaluate(mode => { window.oldResolve = window.resolveCopy; window.oldReject = window.rejectCopy;
        if (mode === 'unmount') window.unmountActions(); else window.renderActions('New evidence'); }, mode);
      if (mode === 'unmount') await copy.waitFor({ state: 'detached' });
      else { await copy.click(); assert.deepEqual(await page.evaluate(() => window.copyCalls), ['First evidence', 'New evidence']); }
      await page.evaluate(mode => mode === 'replace-failure' ? window.oldReject() : window.oldResolve(), mode);
      await page.waitForTimeout(80);
      assert.equal(await page.getByRole('status').count(), 0); assert.equal(await page.getByRole('textbox').count(), 0);
      if (mode !== 'unmount') {
        await page.evaluate(() => window.rejectCopy());
        await page.getByRole('textbox').waitFor(); assert.equal(await page.getByRole('textbox').inputValue(), 'New evidence');
      }
    }
    assert.deepEqual(errors, []); await context.close(); console.log(`PASS ${width} ${locale} ${mode}: bounded local copy and stale receipt isolation`);
  }
} finally { await browser?.close(); await server.close(); }
