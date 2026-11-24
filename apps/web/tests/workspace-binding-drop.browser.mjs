// Actual lazy card dialog + private consent + binding transport; synthetic APIs only.
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
const { chromium } = await import(process.env.AOD_TEST_PLAYWRIGHT ? pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href : 'playwright');
const uuid = '030a734a-e7d6-4a92-90bc-6af5b1a893ad';
const entry = `import React,{useRef,useState}from'react';import{createRoot}from'react-dom/client';
import Overlay from'/src/components/WorkspaceBindingLines.tsx';import Scope from'/src/components/WorkspaceFileCardScope.tsx';
import{PaneToolbarScope}from'/src/components/PaneToolbar.tsx';import{useFileCardGuard}from'/src/lib/workspace-file-card-context.ts';
import{setRecoveryScope}from'/src/api.ts';import'/src/styles.css';
setRecoveryScope('a'.repeat(64));
function Editor(){const[dirty,setDirty]=useState(false);window.dirty=setDirty;useFileCardGuard(()=>!dirty);return <textarea aria-label="Note"/>}
function Fixture(){const host=useRef(null),[scope,owner]=useState('a'.repeat(64));window.owner=value=>{setRecoveryScope(value);owner(value)};
const panes=[...['codex','claude-code','ghcp','unsupported'].map(id=>({id,sessionKey:'connector:'+id})),{id:'note',kind:'notebook',target:'hub',resourceId:'${uuid}'}];
return <div ref={host} className="session-workspace-surface" style={{width:1100,height:700}}><Overlay surface={host} scope={scope} panes={panes}/>
{panes.slice(0,4).map((p,i)=><div key={p.id} data-workspace-pane data-remote-pane={p.id} className="session-workspace-pane" style={{left:10,top:20+i*130,width:280,height:110}}><button draggable data-binding-drag>{p.id}</button></div>)}
<div data-workspace-pane data-remote-pane="note" className="session-workspace-pane" style={{left:450,top:20,width:450,height:400}}><PaneToolbarScope>{slot=><>{slot}<Scope key={scope} pane={panes[4]} scope={scope}><Editor/></Scope></>}</PaneToolbarScope></div></div>}
createRoot(document.getElementById('root')).render(<React.StrictMode><Fixture/></React.StrictMode>);`;
const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, envFile: false, logLevel: 'error',
  plugins: [{ name: 'binding-dialog-fixture', resolveId: id => id === '/fixture-entry.tsx' ? id : undefined, load: id => id === '/fixture-entry.tsx' ? entry : undefined,
    configureServer(vite) { vite.middlewares.use(async (req, res, next) => { if (req.url !== '/fixture') return next();
      res.setHeader('Content-Type', 'text/html'); res.end(await vite.transformIndexHtml('/fixture', '<html><body><div id="root"></div><script type="module" src="/fixture-entry.tsx"></script></body></html>')); }); } }, react(), tailwindcss()], server: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  await server.listen(); browser = await chromium.launch({ headless: true, executablePath: process.env.AOD_TEST_CHROMIUM });
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } }); page.setDefaultTimeout(10000);
  const writes = [], errors = []; let binding = null;
  page.on('pageerror', error => { errors.push(String(error)); console.error(error); });
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === '/api/hub/v1/sessions/state') return route.fulfill({ json: { groups: [{ sessions: ['codex', 'claude-code', 'ghcp', 'unsupported'].map(id => ({ sessionKey: 'connector:' + id, title: id, sessionRef: { runtimeId: id } })) }] } });
    assert.ok(path.includes('/workspace/file-cards/'), `No commands/history/messages: ${path}`);
    if (path.endsWith('/capabilities')) return route.fulfill({ json: { writable: true } });
    if (path.endsWith('/file-binding')) {
      if (request.method() === 'POST') { const intent = request.postDataJSON(); writes.push(intent); binding = { bindingId: intent.requestId, resourceId: decodeURIComponent(path.split('/').at(-2)), sessionId: intent.sessionId, state: 'active', problem: null }; }
      else assert.equal(request.method(), 'GET');
      return route.fulfill({ json: { enabled: true, binding } });
    }
    assert.equal(request.method(), 'GET'); return route.fulfill({ json: { kind: 'notebook', content: { title: 'Private note', text: 'Unchanged text' }, revision: 7 } });
  });
  const open = async () => { binding = null; await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/fixture`); await page.getByRole('button', { name: 'Card file sync', exact: true }).waitFor({ timeout: 30000 }).catch(async error => { console.error(await page.locator('body').innerHTML()); throw error; }); };
  const drop = async (agent, reverse = false) => page.evaluate(({ agent, reverse }) => {
    const from = document.querySelector(`[data-remote-pane="${reverse ? 'note' : agent}"] [data-binding-drag]`);
    const to = document.querySelector(`[data-remote-pane="${reverse ? agent : 'note'}"]`), transfer = new DataTransfer();
    from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer }));
    to.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    from.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: transfer }));
  }, { agent, reverse });
  for (const [index, agent] of ['codex', 'claude-code', 'ghcp'].entries()) {
    await open(); const before = writes.length; await drop(agent, index === 1);
    const consent = page.getByRole('checkbox', { name: 'Allow the selected Agent to read and edit this private note.' });
    await consent.waitFor(); assert.equal(await consent.isChecked(), false); assert.equal(writes.length, before);
    assert.equal(await page.getByRole('button', { name: 'Link card to session', exact: true }).isDisabled(), true);
    await consent.check(); const select = page.getByRole('combobox', { name: 'Session', exact: true });
    await page.waitForFunction(agent => document.querySelector('select[aria-label="Session"]')?.value === 'connector:' + agent, agent);
    // Repeated drop cannot change an already open confirmation.
    await drop(agent === 'codex' ? 'ghcp' : 'codex'); assert.equal(await select.inputValue(), 'connector:' + agent);
    assert.equal(await select.locator('option').count(), 4, 'unsupported runtime is not offered');
    assert.equal(writes.length, before); await page.getByRole('button', { name: 'Link card to session', exact: true }).click();
    await page.getByText('Linked · file-synced card', { exact: true }).waitFor();
    assert.equal(writes.length, before + 1); assert.equal(writes.at(-1).sessionId, 'connector:' + agent); assert.equal(writes.at(-1).revision, 7);
  }
  await open(); const before = writes.length;
  await page.evaluate(() => window.dirty(true)); await drop('codex');
  await page.getByText('Unsaved changes', { exact: true }).waitFor(); assert.equal(await page.getByRole('dialog').count(), 0);
  await page.evaluate(() => window.dirty(false)); await drop('unsupported');
  await page.getByRole('checkbox').check(); await page.getByRole('combobox', { name: 'Session', exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('select[aria-label="Session"] option').length === 4);
  assert.equal(await page.getByRole('button', { name: 'Link card to session', exact: true }).isDisabled(), true);
  await page.evaluate(() => window.owner('b'.repeat(64))); await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
  assert.equal(writes.length, before); assert.deepEqual(errors, []);
  console.log('PASS: Codex/CC/GHCP both drag directions, private consent, explicit single bind, no messages, dirty guard, ineligible target, repeated-drop and owner fencing');
} finally { await browser?.close(); await server.close(); }
