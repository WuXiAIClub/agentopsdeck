// Isolated skills/discrete evidence acceptance. No live services, model turns or credentials.
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const { chromium } = await import(process.env.AOD_TEST_PLAYWRIGHT
  ? pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href : 'playwright');
const fixture = `import React from 'react';
import {createRoot} from 'react-dom/client';
import {SessionSkills} from '/src/components/SessionSkills.tsx';
import {SessionFiles} from '/src/components/SessionFiles.tsx';
import {setRecoveryScope} from '/src/api.ts';
import '/src/styles.css';
setRecoveryScope('b'.repeat(64));
window.rotateScope = () => setRecoveryScope('c'.repeat(64));
const messages = [{id:'edit',sessionKey:'s',role:'tool',toolPhase:'result',status:'sent',text:'',createdAt:1,
  sourceFiles:[{path:'/repo/edit.ts',kind:'modified'}]},
  {id:'deleted',sessionKey:'s',role:'tool',toolPhase:'result',status:'sent',text:'',createdAt:2,
  sourceFiles:[{path:'/repo/deleted.ts',kind:'deleted'}]}];
createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,
  React.createElement(SessionSkills,{sessionKey:'s'}),React.createElement(SessionFiles,{sessionKey:'s',messages})));`;
const server = await createServer({root:fileURLToPath(new URL('..', import.meta.url)),configFile:false,envFile:false,
  plugins:[react(),tailwindcss(),{name:'insights-fixture',
    resolveId(id) { if (id === '/insights-fixture.jsx') return '\0insights-fixture.jsx'; },
    load(id) { if (id === '\0insights-fixture.jsx') return fixture; },
    configureServer(vite) { vite.middlewares.use(async (req,res,next) => {
      if (req.url !== '/insights-fixture') return next();
      res.setHeader('Content-Type','text/html');
      res.end(await vite.transformIndexHtml(req.url,'<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/insights-fixture.jsx"></script></body></html>'));
    }); }
  }],logLevel:'error',server:{host:'127.0.0.1',port:0}});
let browser;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({headless:true});
  for (const width of [1440,390]) {
    const context = await browser.newContext({viewport:{width,height:900},serviceWorkers:'block'});
    const errors = [], reads = []; let mode = 'ok', release;
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      assert.equal(url.origin,origin,'no external traffic');
      if (!url.pathname.startsWith('/api/')) return route.continue();
      assert.equal(req.method(),'GET','no mutations'); reads.push(url.pathname);
      if (url.pathname.endsWith('/skills')) {
        if (mode === 'delay') await new Promise(resolve => {release = resolve;});
        if (mode === 'failed') return route.fulfill({status:503,json:{error:'offline'}});
        if (mode === 'old') return route.fulfill({status:404,json:{error:'unknown route'}});
        return route.fulfill({json:{skills:[{name:'fixture-project',description:'Project-only description',enabled:true,scope:'repo'},
          {name:'fixture-user',description:'Disabled discovery',enabled:false,scope:'user'}],observedAt:1,usage:'unknown',limited:false,discoveryErrors:0}});
      }
      const id = url.pathname.split('/').at(-1);
      if (['edit','deleted'].includes(id)) return route.fulfill({json:{updatedAt:1,message:{id,sessionKey:'s',role:'tool',toolPhase:'result',
        toolName:'fileChange',status:'sent',createdAt:1,sourceFiles:[{path:'/repo/'+id+'.ts',kind:id === 'edit'?'modified':'deleted'}],
        text:id === 'edit'?'[tool fileChange]\nstatus: completed\noutput:\n'+JSON.stringify({status:'completed',changes:[{path:'/repo/edit.ts',diff:'-old fixture\n+new fixture'}]}):'truncated record'}}});
      assert.fail('Unexpected API '+url.pathname);
    });
    const page = await context.newPage(); page.setDefaultTimeout(10_000);
    page.on('pageerror',e => errors.push(e.message));
    await page.goto(origin+'/insights-fixture');
    assert.equal(reads.length,0,'closed panels have no reads');
    const trigger = page.getByRole('button',{name:'Session skills',exact:true}), dialog = page.getByRole('dialog');
    await trigger.click();
    await dialog.getByText('fixture-project',{exact:true}).waitFor();
    await dialog.getByText('Enabled means available to Codex, not loaded or used in this turn. Actual usage is unknown.').waitFor();
    assert.equal(reads.length,1,'one explicit discovery request');
    await dialog.getByRole('searchbox').fill('fixture-user');
    assert.equal(await dialog.locator('.session-skills-list li').count(),1);
    await dialog.getByText('Disabled',{exact:true}).waitFor();
    assert.equal(reads.length,1,'filter is local');
    assert.ok(await dialog.evaluate(e => e.getBoundingClientRect().width <= innerWidth),'dialog fits mobile');
    mode = 'failed'; await dialog.getByRole('button',{name:'Refresh',exact:true}).click();
    await dialog.getByText('Skill discovery unavailable. Retry when Codex is ready; no automatic retry.').waitFor();
    await page.waitForTimeout(1200); assert.equal(reads.length,2,'503 does not retry');
    mode = 'old'; await dialog.getByRole('button',{name:'Refresh',exact:true}).click();
    await dialog.getByText('This Connector does not provide session skills discovery.').waitFor();
    await page.keyboard.press('Escape'); await dialog.waitFor({state:'detached'});
    mode = 'delay'; await trigger.click();
    await dialog.getByText('Reading skills…').waitFor();
    for (let i=0; !release && i<50; i++) await page.waitForTimeout(20);
    assert.ok(release); await page.keyboard.press('Escape'); await dialog.waitFor({state:'detached'});
    release(); await page.waitForTimeout(100); assert.equal(await dialog.count(),0);
    release = undefined; await trigger.click();
    for (let i=0; !release && i<50; i++) await page.waitForTimeout(20);
    assert.ok(release); await page.evaluate(() => window.rotateScope()); await dialog.waitFor({state:'detached'});
    release(); await page.waitForTimeout(100); assert.equal(await dialog.count(),0,'account change discards late discovery');
    const before = reads.length;
    await page.getByRole('button',{name:'Session files',exact:true}).click();
    await dialog.locator('.session-file-row').filter({hasText:'/repo/edit.ts'}).click();
    assert.equal(reads.length,before,'selecting metadata without media does not fetch tool body');
    const evidence = dialog.getByRole('button',{name:/Recorded change/});
    await evidence.click();
    await dialog.getByText('Historical tool diff · not the current file').waitFor();
    assert.equal(await dialog.locator('.file-change-record pre').innerText(),'-old fixture\n+new fixture');
    assert.equal(reads.length,before+1);
    await evidence.click(); await evidence.click();
    assert.equal(reads.length,before+1,'same selected record is reused');
    await dialog.locator('.session-file-row').filter({hasText:'/repo/deleted.ts'}).click();
    await dialog.getByRole('button',{name:/Recorded change/}).click();
    await dialog.getByText('No complete structured diff was retained for this record. Current file preview is separate.').waitFor();
    assert.equal(reads.length,before+2);
    await page.keyboard.press('Escape'); await dialog.waitFor({state:'detached'});
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({width,skillsReads:before,detailReads:2,errors,writes:0,external:0}));
    await context.close();
  }
} finally {await browser?.close(); await server.close();}
