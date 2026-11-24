// Real React/SVG/ResizeObserver with synthetic metadata; never sends model turns.
import assert from 'node:assert/strict';
import { fenceContext, verifyFence } from './fixtures/browser-network.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';
import { serveFixture } from './fixtures/static-assets.mjs';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
const { chromium } = await import(process.env.AOD_TEST_PLAYWRIGHT ? pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href : 'playwright');
const kinds = ['taskboard', 'statuscard', 'notebook', 'report', 'metric-card', 'drawing', 'native-drawio', 'website', 'browser', 'research', 'terminal', 'media', 'dashboard'];
const uuid = '030a734a-e7d6-4a92-90bc-6af5b1a893ad';
const entry = `import React,{useRef,useState}from'react';import{createRoot}from'react-dom/client';
import Overlay from'/src/components/WorkspaceBindingLines.tsx';import{setRecoveryScope}from'/src/api.ts';
import{RunningPaneBorder}from'/src/components/RunningPaneBorder.tsx';
import{workspaceResourceEvents}from'/src/lib/workspace-resource-events.ts';import'/src/styles.css';
const kinds=${JSON.stringify(kinds)};setRecoveryScope('a'.repeat(64));
function Fixture(){const host=useRef(null),[scope,owner]=useState('a'.repeat(64)),[on,mount]=useState(true),[single,select]=useState('notebook'),[session,showSession]=useState(true);
window.showSession=showSession;
window.owner=value=>{setRecoveryScope(value);owner(value)};window.mount=mount;window.select=select;window.event=frame=>workspaceResourceEvents.receive(scope,frame);
const panes=[...(session?[{id:'agent',sessionKey:'connector:session'}]:[]),...kinds.map(kind=>({id:kind,kind,resourceId:${JSON.stringify(uuid)},...(kind==='notebook'?{target:'hub'}:{})}))];
return <><button id="outside">Outside</button><div ref={host} className="session-workspace-surface" style={{width:1000,height:650}}>
{on&&<Overlay key={scope} surface={host} scope={scope} panes={panes}/>}
<div data-workspace-pane data-running="true" data-remote-pane="agent" className="session-workspace-pane" style={{left:15,top:20,width:300,height:240,zIndex:1}}><RunningPaneBorder/><button data-binding-drag draggable>Agent</button><span className="session-state-header" data-session-state="running"/><textarea aria-label="Message"/></div>
<div data-workspace-pane data-remote-pane="unrelated" className="session-workspace-pane" style={{left:15,top:340,width:300,height:140,zIndex:1}}><button>Unrelated</button><textarea aria-label="Unrelated message"/></div>
{kinds.map(kind=><div key={kind} data-workspace-pane data-remote-pane={kind} className="session-workspace-pane" style={{left:390,top:40,width:300,height:240,zIndex:1,display:single===kind?'flex':'none'}}><button>{kind}</button></div>)}
</div></>};createRoot(document.getElementById('root')).render(<React.StrictMode><Fixture/></React.StrictMode>);`;
// Vite 6 injects a connecting /@vite/client even with server.hmr:false.
// Build the same real component/CSS instead; keep development React/StrictMode.
const bundle = await build({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, envFile: false, logLevel: 'error',
  mode: 'development', define: { 'process.env.NODE_ENV': JSON.stringify('development') },
  plugins: [{ name: 'binding-fixture', resolveId: id => id === '/binding-fixture.tsx' ? id : undefined, load: id => id === '/binding-fixture.tsx' ? entry : undefined }, react(), tailwindcss()],
  build: { write: false, minify: false, rollupOptions: { input: '/binding-fixture.tsx' } } });
const server = await serveFixture(bundle.output);
let browser;
try {
  const { origin } = server;
  browser = await chromium.launch({ headless: true, executablePath: process.env.AOD_TEST_CHROMIUM });
  const context = await browser.newContext({ viewport: { width: 1100, height: 800 }, serviceWorkers: 'block' });
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  const errors = [], resources = new Set(); let reads = 0, state = 'active', blocked = false, release;
  page.on('pageerror', error => errors.push(String(error)));
  const denied = await fenceContext(context, { origin, api: async route => {
    const request = route.request(), url = new URL(request.url());
    assert.equal(request.method(), 'GET'); assert.ok(url.pathname.endsWith('/file-binding'), `No unrelated API: ${url.pathname}`);
    reads++; const resource = decodeURIComponent(url.pathname.split('/').at(-2));
    if (url.pathname.includes('/file-cards/')) resources.add(resource);
    const captured = state;
    if (blocked) await new Promise(resolve => { release = resolve; });
    await route.fulfill({ json: { enabled: true, binding: { bindingId: uuid, resourceId: resource, sessionId: 'connector:session', state: captured, problem: null } } });
  } });
  await page.goto(`${origin}/fixture`);
  const hover = kind => page.locator(`[data-remote-pane="${kind}"]`).hover();
  const toggle = kind => page.locator(`[data-remote-pane="${kind}"]`).dispatchEvent('agentopsdeck:binding-lines', { bubbles: true });
  const count = n => page.waitForFunction(n => document.querySelectorAll('.binding-line-flow').length === n, n);
  await page.waitForSelector('[data-binding-drag]');
  const running = page.locator('[data-remote-pane="agent"]');
  const trail = running.locator('.session-running-trail');
  assert.equal(await trail.evaluate(node => getComputedStyle(node).animationName), 'session-running-border');
  assert.equal(await trail.evaluate(node => getComputedStyle(node).pointerEvents), 'none');
  await running.evaluate(node => { node.dataset.completionEffect = 'off'; });
  assert.equal(await trail.evaluate(node => getComputedStyle(node).animationName), 'session-running-border', 'Completion preference does not disable the independent running indicator');
  await running.evaluate(node => { delete node.dataset.completionEffect; });
  assert.equal(await trail.evaluate(node => getComputedStyle(node).animationName), 'session-running-border');
  await page.evaluate(() => {
    window.bindingDrops = []; document.addEventListener('agentopsdeck:binding-drop', event => window.bindingDrops.push(event.detail));
    const source = document.querySelector('[data-binding-drag]'), target = document.querySelector('[data-remote-pane="notebook"]');
    const dataTransfer = new DataTransfer();
    source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer }));
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
  });
  assert.deepEqual(await page.evaluate(() => window.bindingDrops), [{ paneId: 'notebook', sessionKey: 'connector:session', scope: 'a'.repeat(64) }]);
  assert.equal(await page.locator('[data-binding-drop]').count(), 0);
  assert.equal(reads, 0, 'Dragging only opens a confirmation; no binding write or history read');
  await page.evaluate(() => {
    const target = document.querySelector('[data-remote-pane="notebook"]'), dataTransfer = new DataTransfer();
    dataTransfer.setData('application/x-agentopsdeck-binding', 'agent');
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
  });
  assert.equal(await page.evaluate(() => window.bindingDrops.length), 1, 'External forged drag is ignored');
  await hover('notebook');
  await count(0); assert.equal(reads, 0, 'Hover must neither activate links nor fetch metadata');
  await toggle('notebook');
  try { await count(1); } catch (error) { console.error({ errors, reads, resources: [...resources], dom: await page.locator('#root').innerHTML() }); throw error; }
  for (const kind of kinds) { await page.evaluate(kind => window.select(kind), kind); await toggle(kind); await count(1); }
  assert.equal(resources.size, 13);
  await page.evaluate(() => window.select('notebook')); await toggle('notebook'); await count(1);
  await page.waitForFunction(() => document.querySelector('[data-remote-pane="unrelated"]').dataset.bindingMuted === 'true');
  const muted = await page.locator('[data-remote-pane="unrelated"]').evaluate(node => ({ opacity: getComputedStyle(node).opacity, filter: getComputedStyle(node).filter, events: getComputedStyle(node).pointerEvents }));
  assert.equal(muted.opacity, '0.24'); assert.match(muted.filter, /blur/); assert.notEqual(muted.events, 'none');
  assert.equal(await page.locator('[data-remote-pane="notebook"][data-binding-muted]').count(), 0);
  assert.equal(await page.locator('.binding-line-halo').count(), 1);
  assert.match(await page.locator('.binding-line-flow').evaluate(node => getComputedStyle(node).stroke), /url\(/, 'Gradient rather than flat line');
  assert.equal(await page.locator('.workspace-binding-lines linearGradient').getAttribute('gradientUnits'), 'userSpaceOnUse', 'Aligned links must not have a degenerate gradient');
  if (process.env.AOD_BINDING_SCREENSHOT) await page.screenshot({ path: process.env.AOD_BINDING_SCREENSHOT });
  await page.locator('.session-workspace-surface').evaluate(node => { node.dataset.hasMaximized = 'true'; }); await count(0);
  assert.equal(await page.locator('[data-binding-muted]').count(), 0, 'Maximize clears dimming');
  await page.locator('.session-workspace-surface').evaluate(node => { delete node.dataset.hasMaximized; }); await count(1);
  await page.getByRole('textbox', { name: 'Unrelated message', exact: true }).fill('Still editable'); await count(1);
  await page.keyboard.press('Escape'); await count(0);
  assert.equal(await page.locator('[data-binding-muted]').count(), 0, 'Escape clears dimming');
  // fill() changes focus without moving the pointer; physically re-enter.
  await hover('unrelated');
  await hover('notebook'); await count(0); await toggle('notebook'); await count(1);
  await page.locator('[data-remote-pane="notebook"]').dispatchEvent('dragstart', { bubbles: true }); await count(0);
  assert.equal(await page.locator('[data-binding-muted]').count(), 0, 'Dragging clears dimming');
  await hover('agent'); await count(0); await toggle('notebook'); await count(1);
  await page.waitForTimeout(100);
  const baseline = reads;
  for (let i = 0; i < 20; i++) { await hover('agent'); await hover('notebook'); }
  assert.equal(reads, baseline, 'Hover never fetches');
  const line = page.locator('.binding-line-flow'); const before = await line.getAttribute('d');
  await page.locator('[data-remote-pane="notebook"]').evaluate(node => { node.style.left = '500px'; node.style.height = '300px'; });
  await page.waitForFunction(before => document.querySelector('.binding-line-flow')?.getAttribute('d') !== before, before);
  assert.equal(reads, baseline, 'Moving/resizing never fetches');
  await page.evaluate(() => window.showSession(false)); await count(0);
  await page.evaluate(() => window.showSession(true)); await count(1);
  assert.equal(reads, baseline, 'Opening/closing session panes keeps card metadata subscriptions');
  assert.equal(await page.locator('.workspace-binding-lines').evaluate(node => getComputedStyle(node).pointerEvents), 'none');
  assert.equal(await page.locator('.workspace-binding-lines').getAttribute('data-top-layer'), 'true');
  assert.equal(await page.locator('.workspace-binding-lines').evaluate(node => getComputedStyle(node).zIndex), '145');
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Typing is not intercepted');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await trail.evaluate(node => getComputedStyle(node).animationName), 'none');
  assert.equal(await line.evaluate(node => getComputedStyle(node).animationName), 'none');
  assert.equal(await page.locator('.binding-line-halo').evaluate(node => getComputedStyle(node).animationName), 'none');
  await page.getByRole('button', { name: 'Outside', exact: true }).focus(); await count(1);
  await page.getByRole('button', { name: 'Outside', exact: true }).hover();
  await hover('notebook'); await count(1);
  const note = [...resources].find(resource => JSON.parse(resource)[0] === 'notebook');
  assert.ok(note);
  // Revision-driven revocation, no polling; unrelated bindings stay intact.
  state = 'revoked';
  await page.evaluate(resource => window.event({ type: 'workspace.revisions', resourceType: 'card-file-binding', resources: [{ resourceId: resource, revision: 1 }] }), note);
  await count(0); assert.equal(reads, baseline + 1);
  // Binding events arriving during a read coalesce into one successor.
  state = 'active'; blocked = true;
  await page.evaluate(resource => window.event({ type: 'workspace.revisions', resourceType: 'card-file-binding', resources: [{ resourceId: resource, revision: 2 }] }), note);
  const deadline = Date.now() + 5000;
  while (!release) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 10)); }
  state = 'revoked';
  await page.evaluate(resource => window.event({ type: 'workspace.revisions', resourceType: 'card-file-binding', resources: [{ resourceId: resource, revision: 3 }] }), note);
  const refreshed = page.waitForResponse(response => response.url().includes(encodeURIComponent(note)) && response.request().method() === 'GET' && reads >= baseline + 3);
  blocked = false; release(); await refreshed;
  await count(0);
  state = 'active'; await page.evaluate(() => window.owner('b'.repeat(64)));
  await hover('notebook'); await count(0); await toggle('notebook'); await count(1);
  await toggle('notebook'); await count(0);
  await toggle('notebook'); await count(1);
  await page.evaluate(() => window.mount(false)); await count(0);
  assert.equal(await page.locator('[data-binding-linked]').count(), 0, 'unmount clears decorations');
  assert.equal(await page.locator('[data-binding-muted]').count(), 0, 'unmount clears dimming');
  const stopped = reads;
  await page.evaluate(resource => window.event({ type: 'workspace.revisions', resourceType: 'card-file-binding', resources: [{ resourceId: resource, revision: 20 }] }), note);
  await hover('agent'); await hover('notebook'); assert.equal(reads, stopped, 'unmount releases subscriptions');
  assert.deepEqual(errors, []);
  await verifyFence(page, denied);
  console.log('PASS: 13 card kinds, explicit activation, no hover reads/links, move/resize, reduced motion, Escape/drag cleanup, revoke/inflight SSE, account switch, disposal and network fence');
} finally { await browser?.close(); await server.close(); }
