// Component/API scope boundaries. All requests terminate at the local fixture.
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
const { chromium } = await import(pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href);
const fixture = `import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserSettings } from '/src/components/BrowserSettings.tsx';
import { api, setRecoveryScope } from '/src/api.ts';
localStorage.setItem('agentopsdeck.locale','en');
setRecoveryScope('a'.repeat(64));
window.fixtureApi=api;
window.rotateScope=cycle=>{setRecoveryScope('b'.repeat(64));if(cycle)setRecoveryScope('a'.repeat(64));};
const root=createRoot(document.getElementById('root'));
window.unmountSettings=()=>root.unmount();
root.render(React.createElement(React.StrictMode,null,React.createElement(BrowserSettings)));
window.authEvents=0;window.addEventListener('agentopsdeck:auth-required',()=>window.authEvents++);`;
const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, envFile: false,
  logLevel: 'error', server: { host: '127.0.0.1', port: 0 }, plugins: [react(), {
    name: 'passkey-scope-fixture',
    resolveId(id) { if (id === '/scope-fixture.js') return '\0scope-fixture.js'; },
    load(id) { if (id === '\0scope-fixture.js') return fixture; },
    configureServer(vite) { vite.middlewares.use(async (req, res, next) => {
      if (req.url !== '/scope-fixture') return next();
      res.setHeader('Content-Type', 'text/html');
      res.end(await vite.transformIndexHtml(req.url, '<!doctype html><html><body><div id="root"></div><script type="module" src="/scope-fixture.js"></script></body></html>'));
    }); },
  }] });
let browser;
try {
  await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.AOD_TEST_CHROMIUM });
  for (const cycle of [false, true]) for (const method of ['passkeys', 'passkeyRegistrationOptions', 'verifyPasskeyRegistration', 'revokePasskey']) for (const status of [200, 401]) {
    const context = await browser.newContext({ serviceWorkers: 'block' }), page = await context.newPage();
    const errors = []; let held, requests = 0;
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) { errors.push('external request'); return route.abort(); }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      requests++; held = route;
    });
    await page.goto(origin + '/scope-fixture');
    await page.waitForFunction(() => window.fixtureApi);
    await page.evaluate(method => {
      const api = window.fixtureApi;
      const request = method === 'revokePasskey' ? api.revokePasskey('fixture') : method === 'verifyPasskeyRegistration'
        ? api.verifyPasskeyRegistration({}, 'Fixture') : api[method]();
      window.result = request.then(() => 'unexpected success', error => error.name);
    }, method);
    await waitFor(() => held);
    await page.evaluate(cycle => window.rotateScope(cycle), cycle);
    await held.fulfill({ status, json: status === 401 ? { error: 'unauthorized' } : { ok: true, passkeys: [] } });
    assert.equal(await page.evaluate(() => window.result), 'AuthRequiredError');
    assert.equal(await page.evaluate(() => window.authEvents), 0, 'stale 401 must not log out the new scope');
    assert.equal(requests, 1, 'no automatic repeat of a management operation');
    assert.deepEqual(errors, []); await context.close();
    console.log(`PASS ${cycle ? 'A-B-A' : 'A-B'} ${method} ${status}: old scope receipt ignored`);
  }
  for (const boundary of ['scope', 'cycle', 'unmount']) for (const stage of ['list', 'confirm']) {
    const context = await browser.newContext({ serviceWorkers: 'block' }), page = await context.newPage();
    const errors = []; let held, writes = 0;
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', route => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin !== origin) { errors.push('external request'); return route.abort(); }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      if (req.method() !== 'GET') { writes++; return route.abort(); }
      if (url.pathname !== '/api/auth/passkeys') return route.fulfill({ status: 404, json: {} });
      if (stage === 'list') { held = route; return; }
      return route.fulfill({ json: { passkeys: [{ id: 'fixture', label: 'Device', createdAt: 1, transports: [] }] } });
    });
    await page.goto(origin + '/scope-fixture');
    await page.getByRole('button', { name: 'Browser and sign-in settings', exact: true }).click();
    if (stage === 'list') await waitFor(() => held);
    else {
      await page.getByRole('button', { name: 'Remove', exact: true }).click();
      await page.getByRole('button', { name: 'Remove passkey', exact: true }).waitFor();
    }
    await page.evaluate(boundary => boundary === 'unmount' ? window.unmountSettings() : window.rotateScope(boundary === 'cycle'), boundary);
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    if (held) await held.fulfill({ json: { passkeys: [{ id: 'late', label: 'Late key', createdAt: 1 }] } });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.getByText('Late key', { exact: true }).count(), 0);
    assert.equal(writes, 0); assert.deepEqual(errors, []); await context.close();
    console.log(`PASS ${boundary} ${stage}: dialog/confirmation released without writes`);
  }
} finally { await browser?.close(); await server.close(); }
async function waitFor(predicate) {
  const end = Date.now() + 10_000;
  while (!predicate()) { if (Date.now() > end) throw Error('Fixture request not reached'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
