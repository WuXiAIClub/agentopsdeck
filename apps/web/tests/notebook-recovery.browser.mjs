import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer, transformWithEsbuild } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const { chromium } = await import(process.env.AOD_TEST_PLAYWRIGHT ? pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href : 'playwright');
const initial = '# Original note\n\n手机草稿 **unchanged**';
const harness = `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {GlobalNotebookProvider, SessionNotebook} from '/src/components/SessionNotebook.tsx';
import {RenderRecoveryBoundary} from '/src/components/RenderRecoveryBoundary.tsx';
import WorkspaceFileCardScope from '/src/components/WorkspaceFileCardScope.tsx';
import {api, setRecoveryScope} from '/src/api.ts';
import '/src/styles.css';
setRecoveryScope('a'.repeat(64));
window.saved = {resourceId:'fixture-notebook',text:${JSON.stringify(initial)},revision:1,updatedAt:1};
window.writes = [];
api.hubNotebooks = async () => ({items:[],nextCursor:null});
api.sessionNotebook = async () => ({...window.saved});
api.saveSessionNotebook = async (_,value) => {
  window.writes.push(value);
  if (window.conflict) { const error = new Error('conflict'); error.status = 409; throw error; }
  window.saved = {...window.saved,...value,revision:window.writes.length+1};
  return {...window.saved};
};
api.notebookArchive = async () => ({...window.saved,resourceId:'fixture-archive',text:'Archived text'});
function WorkspaceFixture() {
  const [open,setOpen] = useState(true);
  return <><button onClick={()=>setOpen(false)}>Close pane</button><button onClick={()=>{window.navigated=true}}>Navigate away</button>
    {open&&<WorkspaceFileCardScope pane={{id:'fixture',kind:'notebook',target:'hub',resourceId:'fixture'}} scope={'a'.repeat(64)}><p>Native notebook</p></WorkspaceFileCardScope>}</>;
}
createRoot(document.getElementById('root')).render(<RenderRecoveryBoundary><GlobalNotebookProvider>
  {location.search.includes('workspace')?<WorkspaceFixture/>:<><button onClick={()=>{window.navigated=true}}>Navigate away</button>
  <SessionNotebook sessionKey="fixture-session" title="Fixture"/>
  </>}
</GlobalNotebookProvider></RenderRecoveryBoundary>);
`;
const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, envFile: false,
  plugins: [{ name: 'notebook-recovery-fixture', resolveId(id) { if (id === '/notebook-recovery-fixture.tsx') return '\0notebook-recovery-fixture.tsx'; },
    async load(id) { if (id === '\0notebook-recovery-fixture.tsx') return (await transformWithEsbuild(harness, 'notebook-recovery-fixture.tsx', { loader: 'tsx', jsx: 'automatic' })).code; },
    configureServer(server) { server.middlewares.use(async (req, res, next) => {
      if (req.url?.split('?')[0] !== '/notebook-recovery-fixture.html') return next();
      res.setHeader('Content-Type', 'text/html');
      res.end(await server.transformIndexHtml(req.url, '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/notebook-recovery-fixture.tsx"></script></body></html>'));
    }); } }, react(), tailwindcss()], server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
let browser;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.AOD_TEST_CHROMIUM ? { executablePath: process.env.AOD_TEST_CHROMIUM } : {}) });
  for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 568 }, { width: 844, height: 390 }]) {
    for (const failure of ['editor-import', 'archive-import', 'editor-render', 'workspace-import']) {
      const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
      const page = await context.newPage(); page.setDefaultTimeout(20_000);
      const unexpected = [], caught = [];
      page.on('console', message => { if (message.text().includes('AgentOpsDeck render failure')) caught.push(message.text()); });
      await context.route('**/*', route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== origin || request.method() !== 'GET' || url.pathname.startsWith('/api/')) {
          unexpected.push(`${request.method()} ${url.pathname}`); return route.abort();
        }
        const editor = url.pathname === '/src/components/NotebookEditor.tsx';
        const archive = url.pathname === '/src/components/NotebookArchive.tsx';
        if (url.pathname === '/src/components/WorkspaceSharedContent.tsx' && failure === 'workspace-import') return route.abort('failed');
        if ((editor && failure === 'editor-import') || (archive && failure === 'archive-import')) return route.abort('failed');
        if (editor && failure === 'editor-render') return route.fulfill({ contentType: 'text/javascript', body: 'export default function NotebookEditor(){throw new Error("Synthetic editor render failure")}' });
        return route.continue();
      });
      await page.goto(`${origin}/notebook-recovery-fixture.html${failure === 'workspace-import' ? '?workspace' : ''}`);
      if (failure === 'workspace-import') {
        await page.getByRole('region', { name: 'Content recovery', exact: true }).waitFor();
        assert.equal(await page.locator('.render-recovery-app').count(), 0);
        await page.getByRole('button', { name: 'Close pane', exact: true }).tap();
        assert.equal(await page.getByRole('region', { name: 'Content recovery', exact: true }).count(), 0);
        await page.getByRole('button', { name: 'Navigate away', exact: true }).tap();
        assert.equal(await page.evaluate(() => window.navigated), true);
        assert.deepEqual(unexpected, []);
        console.log(`Notebook recovery passed: ${viewport.width}x${viewport.height} ${failure}`);
        await context.close();
        continue;
      }
      await page.getByRole('button', { name: 'Session notebook', exact: true }).tap();
      const note = page.getByRole('dialog', { name: 'Session notebook', exact: true });
      if (failure === 'archive-import') await note.locator('.notebook-archive-toggle > summary').tap();
      if (process.env.AOD_EXPECT_NOTEBOOK_TRAP === '1') {
        await page.locator('.render-recovery-app').waitFor();
        assert.equal(await page.getByRole('button', { name: 'Close notebook' }).count(), 0);
        console.log(`Reproduced root failure and missing close: ${viewport.width} ${failure}`);
        await context.close();
        continue;
      }
      await note.getByRole('region', { name: 'Content recovery', exact: true }).waitFor();
      assert.equal(await page.locator('.render-recovery-app').count(), 0);
      assert.equal(await note.getByRole('button', { name: 'Reload page' }).count(), 0);
      const close = note.getByRole('button', { name: 'Close notebook', exact: true });
      let expectedText = initial + '\nFallback edit';
      const bounds = await close.boundingBox();
      assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width && bounds.y + bounds.height <= viewport.height);
      if (failure !== 'archive-import') {
        const editor = note.getByRole('textbox', { name: 'Session notes', exact: true });
        await editor.waitFor();
        assert.equal(await editor.inputValue(), initial);
        await editor.fill(initial + '\nFallback edit');
        await page.waitForFunction(() => window.saved.text.endsWith('Fallback edit'));
        assert.equal(await editor.inputValue(), initial + '\nFallback edit');
        if (failure === 'editor-import') {
          await page.evaluate(() => { window.conflict = true; window.saved = {...window.saved,text:'Remote change',revision:100}; });
          await editor.fill(initial + '\nUnsaved local change');
          await note.getByText('Another tab saved this note. Compare before choosing which version to keep.', { exact: true }).waitFor();
          assert.equal(await editor.isDisabled(), true);
          assert.equal(await editor.inputValue(), initial + '\nUnsaved local change');
          assert.equal(await page.evaluate(() => window.saved.text), 'Remote change');
          await note.getByRole('button', { name: 'Use saved version', exact: true }).tap();
          expectedText = 'Remote change';
          assert.equal(await editor.inputValue(), expectedText);
          assert.equal(await editor.isDisabled(), false);
        }
      } else {
        await note.locator('.notebook-archive-toggle > summary').tap();
        assert.equal(await note.locator('.notebook-archive-toggle').getAttribute('open'), null);
      }
      await page.waitForTimeout(900);
      assert.equal(caught.length, 1, 'no automatic editor remount while editing');
      await close.tap();
      assert.equal(await note.count(), 0);
      await page.getByRole('button', { name: 'Navigate away', exact: true }).tap();
      assert.equal(await page.evaluate(() => window.navigated), true);
      await page.getByRole('button', { name: 'Session notebook', exact: true }).tap();
      await note.waitFor();
      if (failure !== 'archive-import') assert.equal(await note.getByRole('textbox', { name: 'Session notes' }).inputValue(), expectedText);
      assert.deepEqual(unexpected, []);
      console.log(`Notebook recovery passed: ${viewport.width}x${viewport.height} ${failure}`);
      await context.close();
    }
  }
} finally { await browser?.close(); await server.close(); }
