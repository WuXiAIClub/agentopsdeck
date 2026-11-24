import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer, transformWithEsbuild } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const { chromium } = await import(process.env.AOD_TEST_PLAYWRIGHT ? pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href : 'playwright');
// Test-only entry: inject actual render failures, without a production fault hook.
const harness = `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {RenderRecoveryBoundary} from '/src/components/RenderRecoveryBoundary.tsx';
import {useComposerMedia} from '/src/lib/use-composer-media.ts';
import {setRecoveryScope} from '/src/api.ts';
import '/src/styles.css';
setRecoveryScope('a'.repeat(64));
window.recoveryFault = false;
function Content({session}) {
  const [media, setMedia] = useComposerMedia(session);
  if (window.recoveryFault) { const missing = undefined; return missing[0]; }
  return <div><p>Healthy view</p><button onClick={() => {window.lateUpload=()=>setMedia([{type:'file',name:'unsent.txt',dataUrl:'data:text/plain;base64,aGk='}]);window.lateUpload();}}>Attach draft</button><p>{media[0]?.name}</p></div>;
}
function Fixture() {
  const [revision, setRevision] = useState(0);
  const [visible, setVisible] = useState(true);
  const [session, setSession] = useState('fixture');
  return <><button onClick={() => {window.recoveryFault=true;setRevision(x=>x+1)}}>Break render</button>
    <button onClick={() => setVisible(false)}>Unmount boundary</button>
    <button onClick={() => setSession('another')}>Switch session</button>
    <button onClick={() => {setRecoveryScope('b'.repeat(64));setRevision(x=>x+1)}}>Switch account</button>
    {visible && <RenderRecoveryBoundary><Content session={session} revision={revision}/></RenderRecoveryBoundary>}</>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`;
const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false,
  plugins: [{ name: 'recovery-fixture', resolveId(id) { if (id === '/recovery-fixture.tsx') return '\0recovery-fixture.tsx'; },
    async load(id) { if (id === '\0recovery-fixture.tsx') return (await transformWithEsbuild(harness, 'recovery-fixture.tsx', { loader: 'tsx', jsx: 'automatic' })).code; },
    configureServer(server) { server.middlewares.use(async (req, res, next) => {
      if (req.url !== '/recovery-fixture.html') return next();
      res.setHeader('Content-Type', 'text/html');
      res.end(await server.transformIndexHtml(req.url, '<html><head></head><body><div id="root"></div><script type="module" src="/recovery-fixture.tsx"></script></body></html>'));
    }); } }, react(), tailwindcss()], server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
let browser;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.AOD_TEST_CHROMIUM ? { executablePath: process.env.AOD_TEST_CHROMIUM } : {}) });
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
    const page = await context.newPage(); page.setDefaultTimeout(10_000);
    const caught = [], writes = [];
    page.on('console', message => { if (message.text().includes('AgentOpsDeck render failure')) caught.push(message.text()); });
    await context.route('**/*', route => {
      if (route.request().method() !== 'GET') { writes.push(route.request().url()); return route.abort(); }
      return route.continue();
    });
    await page.goto(`${origin}/recovery-fixture.html`);
    await page.getByText('Healthy view', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Attach draft' }).click();
    await page.getByText('unsent.txt', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Break render' }).click();
    await page.getByText('Restoring view…', { exact: true }).waitFor();
    await page.evaluate(() => { window.recoveryFault = false; });
    await page.getByText('Healthy view', { exact: true }).waitFor();
    await page.getByText('unsent.txt', { exact: true }).waitFor();
    assert.equal(caught.length, 1, 'transient error recovered without navigation');
    // A second error in the same incident must not trigger an endless retry.
    await page.getByRole('button', { name: 'Break render' }).click();
    await page.getByRole('button', { name: 'Try again' }).waitFor();
    await page.waitForTimeout(1300);
    assert.equal(caught.length, 2, 'retry budget survives child remount');
    assert.equal(await page.getByText(/Cannot read properties/).isVisible(), false, 'technical error is collapsed');
    await page.getByText('Technical details', { exact: true }).click();
    await page.getByText("Cannot read properties of undefined (reading '0')", { exact: true }).waitFor();
    await page.evaluate(() => { window.recoveryFault = false; });
    await page.getByRole('button', { name: 'Try again' }).click();
    await page.getByText('Healthy view', { exact: true }).waitFor();
    await page.getByText('unsent.txt', { exact: true }).waitFor();
    assert.equal(page.url(), `${origin}/recovery-fixture.html`);
    assert.deepEqual(writes, []);
    await page.getByRole('button', { name: 'Switch session' }).click();
    await page.evaluate(() => window.lateUpload());
    assert.equal(await page.getByText('unsent.txt', { exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Attach draft' }).click();
    await page.getByRole('button', { name: 'Switch account' }).click();
    await page.evaluate(() => window.lateUpload());
    assert.equal(await page.getByText('unsent.txt', { exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Attach draft' }).click();
    await page.evaluate(() => { window.dispatchEvent(new Event('agentopsdeck:auth-required')); window.lateUpload(); });
    assert.equal(await page.getByText('unsent.txt', { exact: true }).count(), 0);
    // Fresh boundary: a persistent failure gets one retry, then stops.
    await page.reload();
    await page.getByText('Healthy view', { exact: true }).waitFor();
    await page.clock.install();
    await page.getByRole('button', { name: 'Break render' }).click();
    await page.getByText('Restoring view…', { exact: true }).waitFor();
    await page.clock.runFor(700);
    await page.getByRole('button', { name: 'Try again' }).waitFor();
    const persistentCount = caught.length;
    await page.clock.runFor(65_000);
    assert.equal(caught.length, persistentCount);
    await page.evaluate(() => { window.recoveryFault = false; });
    await page.getByRole('button', { name: 'Try again' }).click();
    await page.getByText('Healthy view', { exact: true }).waitFor();
    await page.clock.runFor(60_100);
    await page.getByRole('button', { name: 'Break render' }).click();
    await page.getByText('Restoring view…', { exact: true }).waitFor();
    // Simulate parent teardown, not a user clicking behind the recovery overlay.
    await page.getByRole('button', { name: 'Unmount boundary' }).evaluate(button => button.click());
    const unmountedCount = caught.length;
    await page.clock.runFor(1000);
    assert.equal(caught.length, unmountedCount);
    assert.equal(await page.getByRole('region', { name: 'Application recovery' }).count(), 0);
    assert.deepEqual(writes, []);
    console.log(JSON.stringify({ viewport, appTransientRecovery: true, boundedRetries: true, persistentFailureStops: true, healthyRearm: true, unmountCleanup: true,
      manualRetry: true, unsentAttachmentPreserved: true, attachmentScopeIsolation: true, noAutomaticReloadOrWrites: true }));
    await context.close();

    // Actual application: malformed rich content must not unmount the composer,
    // other messages, session list, or SSE subscription.
    const appContext = await browser.newContext({ viewport, serviceWorkers: 'block' });
    const sessionKey = 'local:cmVjb3Zlcnk=';
    const session = { sessionKey, envConnectionId: 'local', title: 'Recovery test', agentId: 'main', source: 'openclaw', status: 'idle', lastActiveAt: 1 };
    let revision = 1, broken = false;
    const rejected = [];
    await appContext.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin === origin && request.method() === 'POST' && url.pathname === '/api/hub/v1/completions/summary') return route.fulfill({ json: { items: [] } });
      if (url.origin !== origin || request.method() !== 'GET') { rejected.push(request.url()); return route.abort(); }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const json = body => route.fulfill({ json: body });
      if (url.pathname === '/api/auth/status') return json({ authenticated: true, recoveryScope: 'a'.repeat(64), passkeys: { available: false, count: 0 } });
      if (url.pathname.endsWith('/sessions/state')) return json({ groups: [{ agentId: 'main', sessions: [session] }], revision: String(revision) });
      if (url.pathname.endsWith('/messages')) return json({ messages: [
        { id: 'good', sessionKey, role: 'assistant', text: 'Other messages still work', createdAt: 1 },
        { id: 'bad', sessionKey, role: 'assistant', text: 'Original message remains readable', createdAt: 2, media: broken ? [null] : [] },
      ], hiddenCount: 0, revision: String(revision) });
      if (url.pathname.endsWith('/queue')) return json({ items: [], nextCursor: null });
      if (url.pathname === '/api/agents') return json({ agents: [{ id: 'main', name: 'Main' }] });
      if (url.pathname === '/api/gateway/status') return json({ connected: true });
      return route.fulfill({ status: 404, json: { error: 'Outside fixture' } });
    });
    await appContext.addInitScript(() => {
      const streams = [];
      window.EventSource = class extends EventTarget {
        readyState = 1; static OPEN = 1; static CONNECTING = 0; static CLOSED = 2;
        constructor() { super(); streams.push(this); queueMicrotask(() => this.onopen?.(new Event('open'))); }
        close() { this.readyState = 2; }
      };
      window.recoveryEvent = event => { for (const stream of streams) if (stream.readyState === 1)
        stream.dispatchEvent(new MessageEvent(event.type, { data: JSON.stringify(event), lastEventId: event.id })); };
    });
    const app = await appContext.newPage(); app.setDefaultTimeout(10_000);
    await app.goto(origin);
    await app.locator(`[data-session-card="${sessionKey}"]`).focus();
    await app.locator(`[data-session-card="${sessionKey}"]`).press('Enter');
    await app.getByText('Original message remains readable', { exact: true }).waitFor();
    const composer = app.locator('textarea:visible').last();
    await composer.fill('Do not lose or send this draft');
    await composer.evaluate(el => { window.originalComposer = el; });
    broken = true; revision++;
    const update = () => app.evaluate(({ sessionKey, revision }) => window.recoveryEvent({ id: `recovery-${revision}`, type: 'message.updated', sessionKey, ts: revision, payload: {} }), { sessionKey, revision });
    await update();
    await app.getByText('Simplified view', { exact: true }).waitFor();
    assert.equal(await app.getByRole('region', { name: 'Application recovery' }).count(), 0);
    await app.getByText('Other messages still work', { exact: true }).waitFor();
    await app.getByText('Original message remains readable', { exact: true }).waitFor();
    assert.equal(await composer.inputValue(), 'Do not lose or send this draft');
    assert.equal(await composer.evaluate(el => el === window.originalComposer), true);
    assert.ok(await app.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    // New snapshot is retained; explicit retry uses current data, never replays a send.
    broken = false; revision++;
    const correctedSnapshot = app.waitForResponse(response => response.url().includes('/messages?') && response.status() === 200);
    await update();
    await correctedSnapshot;
    // Let the response's state update reach React before retrying the subtree.
    await app.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await app.getByRole('button', { name: 'Try again', exact: true }).click();
    await app.waitForFunction(() => !document.querySelector('.render-recovery'));
    assert.equal(await composer.inputValue(), 'Do not lose or send this draft');
    assert.deepEqual(rejected, []);
    console.log(JSON.stringify({ viewport, messageIsolation: true, plainTextFallback: true, composerDomAndDraftPreserved: true, currentSnapshotRetry: true, noWrites: true }));
    await appContext.close();
  }
} finally { await browser?.close(); await server.close(); }
