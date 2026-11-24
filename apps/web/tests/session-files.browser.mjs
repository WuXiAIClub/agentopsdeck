// Component acceptance in an isolated Vite origin; no live service or credentials.
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const { chromium } = await import(process.env.AOD_TEST_PLAYWRIGHT
  ? pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href : 'playwright');
const fixture = `import React from 'react';
import { createRoot } from 'react-dom/client';
import { SessionFiles } from '/src/components/SessionFiles.tsx';
import { setRecoveryScope } from '/src/api.ts';
import '/src/styles.css';
setRecoveryScope('b'.repeat(64));
window.rotateScope = () => setRecoveryScope('c'.repeat(64));
const media = (path, id) => ({type:'file',name:path,url:'/api/hub/v1/sessions/s/messages/'+id+'/media/'+'a'.repeat(64),sourceReference:{href:path+':1',path,line:1}});
const sessionKey = location.search ? 'local:Y29kZXg6Zml4dHVyZQ' : 's';
const base = {sessionKey,status:'sent',createdAt:1,text:''};
const messages = [
 {...base,id:'edit',role:'tool',toolPhase:'result',sourceFiles:[{path:'/repo/edit.ts',kind:'modified'}],media:[media('/repo/edit.ts','edit')]},
 {...base,id:'ref',role:'assistant',media:[media('/repo/ref.ts','ref')]},
 {...base,id:'deleted',role:'tool',toolPhase:'result',sourceFiles:[{path:'/repo/deleted.ts',kind:'deleted'}]},
 {...base,id:'denied',role:'assistant',media:[media('/outside/denied.ts','denied')]},
 {...base,id:'secret',sessionKey:'other',role:'assistant',media:[media('/other/secret.ts','secret')]}
];
if (location.search === '?history') messages.push({...base,id:'edit-old',createdAt:0,role:'tool',toolPhase:'result',sourceFiles:[{path:'/repo/edit.ts',kind:'added'}]});
createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement(SessionFiles,{sessionKey,messages})));`;
const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, envFile: false,
  plugins: [react(), tailwindcss(), { name: 'session-files-fixture',
    resolveId(id) { if (id === '/files-fixture.js') return '\0files-fixture.js'; },
    load(id) { if (id === '\0files-fixture.js') return fixture; },
    configureServer(vite) {
    vite.middlewares.use(async (req, res, next) => {
      if (req.url.split('?')[0] !== '/files-fixture') return next();
      res.setHeader('Content-Type', 'text/html');
      res.end(await vite.transformIndexHtml(req.url, '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/files-fixture.js"></script></body></html>'));
    });
  } }], logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.AOD_TEST_CHROMIUM ? {executablePath:process.env.AOD_TEST_CHROMIUM} : {}) });
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({viewport:{width,height:900},serviceWorkers:'block'});
    const details = [], errors = [];
    let denied = false;
    await context.route('**/api/**', async route => {
      const request = route.request(), url = new URL(request.url());
      assert.equal(url.origin,origin); assert.equal(request.method(),'GET');
      if (url.pathname.endsWith('/connections')) return route.fulfill({json:{connections:[]}});
      if (/\/messages\/edit(-old)?$/.test(url.pathname)) {
        const id = url.pathname.split('/').at(-1); details.push(id);
        if (denied) return route.fulfill({status:403,json:{error:'forbidden'}});
        return route.fulfill({json:{message:{sessionKey:'local:Y29kZXg6Zml4dHVyZQ',id,createdAt:1,role:'tool',toolPhase:'result',status:'sent',toolName:'fileChange',sourceFiles:[{path:'/repo/edit.ts',kind:'modified'}],text:'[tool fileChange]\nstatus: completed\noutput:\n'+JSON.stringify({status:'completed',changes:[{path:'/repo/edit.ts',diff:'@@ retained patch @@\n-old '+id+'\n+<script>inert '+id+'</script>'}]})},updatedAt:1}});
      }
      return route.fulfill({json:{path:'/repo/edit.ts',line:1,startLine:1,totalLines:1,modifiedAt:1,text:'current disk is separate'}});
    });
    const page = await context.newPage(); page.setDefaultTimeout(10_000); page.on('pageerror',e=>errors.push(e.message));
    await page.goto(origin+'/files-fixture?history');
    await page.getByRole('button',{name:'Session files',exact:true}).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('.session-file-row').filter({hasText:'/repo/edit.ts'}).click();
    const select = dialog.getByRole('combobox',{name:'Choose a recorded change'});
    assert.equal(await select.locator('option').count(),2); assert.deepEqual(details,[]);
    await dialog.getByRole('button',{name:/^Recorded change/}).click();
    await dialog.locator('.file-change-record pre').filter({hasText:'old edit'}).waitFor();
    assert.equal(await dialog.locator('.file-diff-add').textContent(),'+<script>inert edit</script>');
    assert.equal(await dialog.locator('.file-change-record pre').textContent(),'@@ retained patch @@\n-old edit\n+<script>inert edit</script>');
    await select.selectOption('edit-old');
    assert.equal(await dialog.locator('.file-change-record pre').count(),0,'changing record discards body');
    assert.deepEqual(details,['edit'],'selection alone does not fetch');
    await dialog.getByRole('button',{name:/^Recorded change/}).click();
    await dialog.locator('.file-change-record pre').filter({hasText:'old edit-old'}).waitFor();
    await dialog.getByRole('button',{name:/^Recorded change/}).click();
    denied = true;
    await dialog.getByRole('button',{name:/^Recorded change/}).click();
    await dialog.getByText('Recorded change unavailable. Close and reopen to retry.').waitFor();
    assert.equal(await dialog.locator('.file-change-record pre').count(),0,'failed reauthorization reveals no cached body');
    assert.deepEqual(details,['edit','edit-old','edit-old']);
    assert.equal(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1),true);
    await page.evaluate(()=>window.rotateScope()); await dialog.waitFor({state:'detached'});
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({test:'file-history',width,detailReads:details.length,revoked:true,inertDiff:true}));
    await context.close();
  }
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    const reads = [], writes = [], errors = [], external = [];
    let approvalAvailable = false, approved = false;
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin !== origin) { external.push(url.origin); return route.abort(); }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      if (req.method() !== 'GET') {
        writes.push([req.method(), url.pathname]);
        assert.ok(approvalAvailable && req.method() === 'POST' && url.pathname.includes('/messages/denied/'));
        approved = true;
        return route.fulfill({json:{ok:true}});
      }
      reads.push(url.pathname);
      if (url.pathname.includes('/messages/denied/')) {
        if (approved) return route.fulfill({json:{path:'/outside/denied.ts',line:1,startLine:1,totalLines:1,modifiedAt:1,text:'const approvedFixture = true;',temporaryApproval:true}});
        return route.fulfill({status:404,headers:{'x-agentopsdeck-source-error':'outside-roots',...(approvalAvailable ? {'x-agentopsdeck-source-approval':'available'} : {})}});
      }
      const path = url.pathname.includes('/messages/edit/') ? '/repo/edit.ts' : '/repo/ref.ts';
      return route.fulfill({json:{path,line:1,startLine:1,totalLines:1,modifiedAt:1,text:'const previewFixture = true;'}});
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/files-fixture');
    const trigger = page.getByRole('button', { name: 'Session files', exact: true });
    await trigger.click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    assert.equal(await dialog.locator('.session-file-row').count(), 4);
    assert.equal(await dialog.getByText('Tool-recorded change', { exact: true }).count(), 1);
    assert.equal(reads.length, 0, 'opening panel must not request files or history');
    await dialog.locator('.session-file-row').filter({hasText:'/repo/edit.ts'}).click();
    // The displayed line includes its line-number child; verify the actual code
    // container rather than expecting an unnumbered standalone text element.
    await dialog.locator('.source-inline-line').filter({hasText:'const previewFixture = true;'}).waitFor();
    assert.equal(await dialog.locator('.source-inline-line').textContent(), '1const previewFixture = true;');
    assert.equal(reads.length, 1);
    await page.keyboard.press('Escape');
    await dialog.waitFor({state:'detached'});
    assert.equal(await trigger.evaluate(el => el === document.activeElement), true);
    await trigger.click();
    await dialog.locator('.session-file-row').filter({hasText:'/repo/edit.ts'}).click();
    await dialog.locator('.source-inline-line').filter({hasText:'const previewFixture = true;'}).waitFor();
    assert.equal(await dialog.locator('.source-inline-line').textContent(), '1const previewFixture = true;');
    assert.equal(reads.length, 1, 'reopen uses authorized preview cache');
    await dialog.getByRole('searchbox').fill('deleted');
    assert.equal(await dialog.locator('.session-file-row').count(), 1);
    await dialog.locator('.session-file-row').click();
    await dialog.getByText('The tool recorded a deletion. No current file is requested.').waitFor();
    assert.equal(reads.length, 1);
    await dialog.getByRole('searchbox').fill('');
    await dialog.locator('.session-file-row').filter({hasText:'/outside/denied.ts'}).click();
    const allow = dialog.getByRole('button', { name:'Allow preview', exact:true });
    const retry = dialog.getByRole('button', { name:'Retry', exact:true });
    await retry.waitFor();
    assert.equal(await allow.count(), 0, 'no approval action when the Connector does not offer it');
    assert.equal(reads.length, 2);
    approvalAvailable = true;
    await retry.click();
    await allow.waitFor();
    assert.equal(reads.length, 3);
    assert.deepEqual(writes, [], 'loading the reference must not grant access');
    assert.equal(await dialog.locator('.source-inline-card').count(), 0);
    const bounds = await dialog.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width && bounds.y + bounds.height <= 901);
    assert.equal(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
    await allow.click();
    await dialog.locator('.source-inline-line').filter({hasText:'const approvedFixture = true;'}).waitFor();
    await dialog.getByRole('button', {name:'Revoke access', exact:true}).waitFor();
    assert.deepEqual(writes, [['POST', `/api/hub/v1/sessions/s/messages/denied/media/${'a'.repeat(64)}/approval`]]);
    await page.evaluate(() => window.dispatchEvent(new Event('agentopsdeck:auth-required')));
    await dialog.waitFor({state:'detached'});
    assert.deepEqual(external, []); assert.deepEqual(errors, []);
    console.log(JSON.stringify({width,files:4,previewReads:reads.length,historyReads:0,writes:writes.length,cache:true,permissionBoundary:true,oneClickApproval:true}));
    await context.close();
  }
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    const reads = [], errors = [];
    let supported = true, conflict = false, delayed = false, release;
    await context.route('**/api/**', async route => {
      const req = route.request(), url = new URL(req.url());
      assert.equal(url.origin, origin); assert.equal(req.method(), 'GET');
      reads.push(url.pathname);
      if (url.pathname.endsWith('/capabilities')) return route.fulfill({json:{features:{sessionFileIndex:supported}}});
      if (url.pathname.endsWith('/files')) {
        if (delayed) await new Promise(resolve => { release = resolve; });
        if (conflict) return route.fulfill({status:409,json:{error:'changed'}});
        const next = url.searchParams.has('cursor');
        return route.fulfill({json:{generation:'generation',revision:1,coverage:'partial',source:'durable-events',limited:false,
          retained:{count:52,earliest:2,latest:53},
          ...(!next ? {nextCursor:'next'} : {}), entries:Array.from({length:next ? 2 : 50}, (_, i) => ({
            path:'/repo/indexed-'+(i + (next ? 50 : 0))+'.ts',kind:'modified',messageId:'indexed-'+i,createdAt:i+2,
          }))}});
      }
      throw new Error('Unexpected API read: '+url.pathname);
    });
    const page = await context.newPage(); page.setDefaultTimeout(10_000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/files-fixture?indexed');
    assert.equal(reads.length, 0, 'closed panel has no index or capability reads');
    const trigger = page.getByRole('button', {name:'Session files',exact:true}), dialog = page.getByRole('dialog');
    await trigger.click();
    await dialog.getByRole('button', {name:'Load more file records',exact:true}).waitFor();
    await dialog.getByText('Source: saved structured tool events', {exact:true}).waitFor();
    assert.match(await dialog.getByText('Retained indexed records:', {exact:false}).textContent(), /52/);
    await dialog.getByText('Recorded timestamps only; gaps and missing tools are not covered.', {exact:false}).waitFor();
    assert.equal(await dialog.locator('.session-file-row').count(), 54);
    await dialog.getByRole('button', {name:'Load more file records',exact:true}).click();
    await dialog.locator('.session-file-row').filter({hasText:'/repo/indexed-51.ts'}).waitFor();
    assert.equal(await dialog.locator('.session-file-row').count(), 56);
    await dialog.locator('.session-file-row').filter({hasText:'/repo/indexed-51.ts'}).click();
    await dialog.getByText('Preview is unavailable for this record. Connector access is not expanded automatically.').waitFor();
    conflict = true;
    await dialog.getByRole('button', {name:'Refresh file index',exact:true}).click();
    await dialog.getByText('The file index changed. Refresh to read a consistent list.').waitFor();
    assert.equal(await dialog.locator('.session-file-row').count(), 4);
    assert.equal(await dialog.getByText('Retained indexed records:', {exact:false}).count(), 0);
    conflict = false;
    await dialog.getByRole('button', {name:'Refresh file index',exact:true}).click();
    await dialog.getByRole('button', {name:'Load more file records',exact:true}).waitFor();
    await page.keyboard.press('Escape');
    await dialog.waitFor({state:'detached'});
    const indexReads = reads.filter(path => path.endsWith('/files')).length;
    supported = false;
    await trigger.click();
    await dialog.waitFor();
    await page.waitForTimeout(250);
    assert.equal(await dialog.locator('.session-file-row').count(), 4);
    assert.equal(reads.filter(path => path.endsWith('/files')).length, indexReads, 'old Connector has no index probe');
    await page.keyboard.press('Escape'); await dialog.waitFor({state:'detached'});
    supported = true; delayed = true;
    await trigger.click();
    await dialog.getByText('Reading file index…').waitFor();
    for (let attempt = 0; !release && attempt < 50; attempt++) await page.waitForTimeout(20);
    assert.ok(release, 'delayed index read started');
    await page.keyboard.press('Escape'); await dialog.waitFor({state:'detached'});
    release(); await page.waitForTimeout(100);
    assert.equal(await dialog.count(), 0, 'late response cannot reopen closed panel');
    delayed = false;
    await trigger.click();
    await dialog.getByRole('button', {name:'Load more file records',exact:true}).waitFor();
    await page.evaluate(() => window.rotateScope());
    await dialog.waitFor({state:'detached'});
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({test:'session-files-index',width,reads:reads.length,errors}));
    await context.close();
  }
  for (const source of ['durable-events', 'verified-projection']) for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    let starts = 0, steps = 0, cancels = 0, mode = 'complete', indexReads = 0, created = 0, active;
    let loseStart = false;
    const errors = [], unexpected = [];
    const id = '9e701d85-424d-43b8-969f-d58d5bed20c9';
    const progress = (step, state = 'scanning') => ({id,step,state,scanned:step*20,bytes:step*200,found:step,limited:false});
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin !== origin) { unexpected.push(url.origin); return route.abort(); }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      if (url.pathname.endsWith('/capabilities')) return route.fulfill({json:{features:{sessionFileIndex:true}}});
      if (url.pathname.endsWith('/files')) {
        indexReads++;
        return route.fulfill({json:{generation:'generation',revision:indexReads,coverage:'partial',source,
          limited:false,entries:[],rebuildAvailable:true}});
      }
      if (url.pathname.endsWith('/files/rebuild') && req.method() === 'POST') {
        starts++;
        if (active?.state !== 'scanning') { active = progress(0); created++; }
        if (loseStart) { loseStart = false; return route.fulfill({status:503,json:{error:'Unavailable'}}); }
        return route.fulfill({json:active});
      }
      if (url.pathname.endsWith('/files/rebuild/'+id)) {
        if (req.method() === 'DELETE') { cancels++; active = progress(active.step,'cancelled'); return route.fulfill({json:active}); }
        steps++;
        assert.equal(req.postDataJSON().step, active.step, 'client uses the recovered step rather than restarting at zero');
        const step = req.postDataJSON().step + 1;
        active = progress(step,mode === 'complete' && step === 2 ? 'completed' : 'scanning');
        // Model a successful server step whose response was lost downstream.
        if (mode === 'failure') return route.fulfill({status:503,json:{error:'Unavailable'}});
        return route.fulfill({json:active});
      }
      unexpected.push(req.method()+' '+url.pathname); return route.abort();
    });
    const page = await context.newPage(); page.setDefaultTimeout(10_000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/files-fixture?rebuild');
    const trigger = page.getByRole('button', {name:'Session files',exact:true}), dialog = page.getByRole('dialog');
    await trigger.click();
    const scan = dialog.getByRole('button', {name:'Scan or resume older file records',exact:true});
    await scan.waitFor(); await page.waitForTimeout(900);
    await dialog.getByText(source === 'verified-projection' ? 'Source: verified native history projection' : 'Source: saved structured tool events', {exact:true}).waitFor();
    assert.equal(starts,0,'open panel never auto-scans');
    await scan.click();
    await dialog.getByText(/Scan finished · coverage remains partial/).waitFor();
    await scan.waitFor({state:'visible'});
    await dialog.getByText(source === 'verified-projection' ? 'Source: verified native history projection' : 'Source: saved structured tool events', {exact:true}).waitFor();
    assert.equal(starts,1); assert.equal(steps,2); assert.equal(indexReads,2);
    mode = 'long';
    await scan.click();
    await dialog.getByRole('button', {name:'Cancel file scan',exact:true}).click();
    await dialog.getByText(/Scan cancelled · previous index preserved/).waitFor();
    assert.equal(cancels,1); assert.equal(indexReads,2,'cancel does not refresh/rewrite the index');
    await scan.click();
    await dialog.getByText(/Saved summaries scanned: 20/).waitFor();
    await page.keyboard.press('Escape'); await dialog.waitFor({state:'detached'});
    const stoppedAt = steps;
    await page.waitForTimeout(1100);
    assert.equal(steps,stoppedAt,'closing panel stops step requests');
    const createdBeforeResume = created, startsBeforeOpen = starts;
    await trigger.click(); await scan.waitFor();
    await page.waitForTimeout(900);
    assert.equal(starts,startsBeforeOpen,'reopening does not automatically resume');
    assert.equal(steps,stoppedAt,'reopening does not scan summaries');
    mode = 'complete'; await scan.click();
    await dialog.getByText(/Scan finished · coverage remains partial/).waitFor();
    assert.equal(created,createdBeforeResume,'explicit restart resumes the abandoned job');
    assert.equal(steps,stoppedAt+1,'resume only reads the remaining page');
    mode = 'failure';
    await scan.click();
    await dialog.getByText('File scan stopped. No automatic retry; temporary work expires within five minutes.').waitFor();
    const failedAt = steps, failedStarts = starts, failedCreated = created;
    await page.waitForTimeout(1100);
    assert.equal(steps,failedAt,'failed mutation is never automatically repeated');
    assert.equal(starts,failedStarts,'failed mutation never auto-resumes');
    mode = 'complete'; await scan.click();
    await dialog.getByText(/Scan finished · coverage remains partial/).waitFor();
    assert.equal(created,failedCreated,'manual retry recovers an uncertain step');
    assert.equal(steps,failedAt+1,'accepted but lost step is not scanned twice');
    loseStart = true; await scan.click();
    await dialog.getByText('File scan stopped. No automatic retry; temporary work expires within five minutes.').waitFor();
    const lostCreated = created, lostStarts = starts;
    await page.waitForTimeout(1100); assert.equal(starts,lostStarts);
    await scan.click(); await dialog.getByText(/Scan finished · coverage remains partial/).waitFor();
    assert.equal(created,lostCreated,'lost start receipt is recovered only on explicit click');
    mode = 'long'; await scan.click();
    await dialog.getByRole('button', {name:'Cancel file scan',exact:true}).waitFor();
    await page.evaluate(() => window.rotateScope()); await dialog.waitFor({state:'detached'});
    const scopeAt = steps;
    await page.waitForTimeout(1100); assert.equal(steps,scopeAt,'account rotation stops scans without writes using new identity');
    assert.deepEqual(errors,[]); assert.deepEqual(unexpected,[]);
    console.log(JSON.stringify({test:'session-files-rebuild',source,width,starts,steps,cancels,indexReads,errors}));
    await context.close();
  }
} finally { await browser?.close(); await server.close(); }
