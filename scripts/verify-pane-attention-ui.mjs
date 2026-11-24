// Isolated source-component browser regression. No production API or model calls.
// PLAYWRIGHT_MODULE may point to an existing external Playwright installation.
import assert from 'node:assert/strict';
import { createServer, transformWithEsbuild } from '../apps/web/node_modules/vite/dist/node/index.js';
import { resolve } from 'node:path';

const fixture = `
import React, {useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {SessionWorkspaceView} from '/src/components/SessionWorkspaceView';
import {AnchoredPanel} from '/src/components/AnchoredPanel';
import {PaneActions} from '/src/components/PaneActions';
import {saveCompletionEffect} from '/src/lib/completion-preference';
import '/src/styles.css';
const initial = {sessionKey:'fixture:YQ',title:'Attention fixture',status:'idle'};
const noop = () => {}, dismissed = new Set();
const renderPane = () => <textarea id="draft" defaultValue="preserve draft" />;
function Fixture() {
  const [session, setSession] = useState(initial), [open, setOpen] = useState(false);
  const anchor = useRef(null);
  window.complete = (id, phase = 'completed', sync = 'current') => setSession({...initial, runStartedAt:id*10-1, runCompletedAt:id*10,
    runtime:{turnId:String(id),phase,sync,threadActivity:phase==='running'?'running':'idle',connection:'connected',lastEventAt:id*10}});
  window.effect = saveCompletionEffect;
  return <><div style={{height:600,display:'grid'}}><SessionWorkspaceView selected={session} selectedKey={session.sessionKey}
    sessions={[session]} dismissed={dismissed} emptyState={null} onSelect={noop} onOpenKeys={noop} renderPane={renderPane}/></div>
    <button id="anchor" ref={anchor} onClick={()=>setOpen(v=>!v)}>Panel</button>
    <AnchoredPanel open={open} onClose={()=>setOpen(false)} anchor={anchor} label="Fixture panel"><input id="panel-input" defaultValue="panel draft"/></AnchoredPanel>
    <div id="tools-host" data-font-area="chat" style={{width:500}}><PaneActions><input id="tool-input" defaultValue="tool draft"/></PaneActions></div>
  </>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`;
const server = await createServer({ root: resolve('apps/web'), server: { host: '127.0.0.1', port: 0 },
  plugins: [{ name: 'attention-fixture',
    resolveId(id) { if (id === '/__attention_fixture.tsx') return '\0attention-fixture.tsx'; },
    async load(id) { if (id === '\0attention-fixture.tsx') return transformWithEsbuild(fixture, 'attention-fixture.tsx', { loader: 'tsx', jsx: 'transform' }); },
    configureServer(vite) { vite.middlewares.use(async (req, res, next) => {
      if (req.url !== '/__attention_fixture') return next();
      res.setHeader('Content-Type', 'text/html');
      res.end(await vite.transformIndexHtml('/__attention_fixture', '<html><head></head><body><div id="root"></div><script type="module" src="/__attention_fixture.tsx"></script></body></html>'));
    }); },
  }] });
let browser;
try {
  await server.listen();
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'no-preference' });
  const errors = []; page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    assert.equal(route.request().method(), 'GET', 'Fixture must not write through an API');
    await route.fulfill({ json: { items: [], revision: 0, bindings: [], groups: [], sessions: {} } });
  });
  await page.goto(`${origin}/__attention_fixture`);
  const pane = page.locator('.session-workspace-pane');
  await pane.waitFor({ timeout: 10000 }).catch(async error => { console.error((await page.content()).slice(-5000)); throw error; });
  assert.equal(await pane.getAttribute('data-completed'), 'false');
  await page.locator('#draft').fill('edited draft');
  await page.evaluate(() => { window.originalDraft = document.querySelector('#draft'); window.complete(1); });
  await page.waitForFunction(() => document.querySelector('.session-workspace-pane')?.dataset.completed === 'true');
  const sample = () => pane.evaluate(el => {
    const animation = el.getAnimations().find(a => a.animationName === 'pane-heartbeat');
    if (!animation) throw Error('No heartbeat animation');
    animation.pause(); animation.currentTime = 850 * .35;
    return { scale: Number(getComputedStyle(el).scale), width: el.getBoundingClientRect().width,
      layoutWidth: el.offsetWidth, name: animation.animationName };
  });
  const expanded = await sample();
  assert.ok(expanded.scale >= 1.017 && expanded.width > expanded.layoutWidth * 1.017, JSON.stringify(expanded));
  assert.equal(await page.locator('#draft').inputValue(), 'edited draft');
  assert.equal(await page.evaluate(() => document.querySelector('#draft') === window.originalDraft), true);
  const firstSequence = await pane.getAttribute('data-completion-sequence');
  await page.evaluate(() => window.complete(2));
  await page.waitForFunction(first => document.querySelector('.session-workspace-pane').dataset.completionSequence !== first, firstSequence);
  assert.ok((await sample()).scale >= 1.017, 'Consecutive completion restarts heartbeat');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await pane.evaluate(el => getComputedStyle(el).animationName), 'none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(() => window.effect('off'));
  await page.waitForFunction(() => document.querySelector('.session-workspace-pane').dataset.completionEffect === 'off');
  assert.equal(await pane.evaluate(el => el.getAnimations().length), 0);
  await page.evaluate(() => window.effect('glow'));
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.session-workspace-pane')).animationName === 'pane-completed');
  assert.equal(await pane.evaluate(el => getComputedStyle(el).scale), 'none');
  await page.evaluate(() => window.complete(3, 'failed'));
  await page.waitForFunction(() => document.querySelector('.session-workspace-pane').dataset.completed === 'false');

  await page.locator('#anchor').click();
  await page.locator('.caption-popover:popover-open').waitFor();
  await page.locator('#panel-input').fill('changed');
  const measureBurst = selector => page.evaluate(async selector => {
    const el = document.querySelector(selector), original = el.getBoundingClientRect;
    let reads = 0; el.getBoundingClientRect = function() { reads++; return original.call(this); };
    for (let i=0;i<30;i++) window.dispatchEvent(new Event('scroll'));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    el.getBoundingClientRect = original;
    return reads;
  }, selector);
  const anchorReads = await measureBurst('#anchor');
  assert.ok(anchorReads > 0 && anchorReads <= 2, `Anchor scroll burst coalesces: ${anchorReads}`);
  await page.keyboard.press('Escape');
  const trigger = page.locator('#tools-host .pane-tools-trigger');
  await trigger.waitFor(); await trigger.click();
  await page.locator('#tools-host :popover-open').waitFor();
  const toolReads = await measureBurst('#tools-host .pane-tools-trigger');
  assert.ok(toolReads > 0 && toolReads <= 2, `Tool scroll burst coalesces: ${toolReads}`);
  await page.locator('#tool-input').fill('persistent tools');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('#tools-host :popover-open'));
  assert.equal(await measureBurst('#tools-host .pane-tools-trigger'), 0, 'Closed tools do not measure');
  await trigger.click();
  assert.equal(await page.locator('#tool-input').inputValue(), 'persistent tools');
  await page.keyboard.press('Escape');
  await page.locator('#tools-host').evaluate(el => { el.style.width = '900px'; });
  await page.waitForFunction(() => !document.querySelector('#tools-host .pane-tools-trigger'));
  assert.equal(await page.locator('#tool-input').inputValue(), 'persistent tools');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ expanded, scrollBurstEvents: 30, anchorReads, toolReads }));
  console.log('PASS: actual workspace first/rapid completion, measured active-pane expansion, draft/node preservation, reduced-motion/off/glow, expiry, menu burst coalescing/closed idle/resize and draft preservation');
} finally { await browser?.close(); await server.close(); }
