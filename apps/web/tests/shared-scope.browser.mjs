// Isolated real Hub SQLite/HTTP and production Scope; never reaches a real service.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { Hono } from '../../server/node_modules/hono/dist/index.js';
import { HubStore } from '../../server/src/hub/hub-store.ts';
import { registerHubSessionNotebookRoutes } from '../../server/src/routes/hub-session-notebooks.ts';
import { registerHubWorkspaceContent } from '../../server/src/routes/hub-workspace-content.ts';
import { verifyArchiveSplit } from './notebook-archive-split.browser.mjs';
const {chromium}=await import(pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href);
const server=await createServer({root:fileURLToPath(new URL('..',import.meta.url)),configFile:false,envFile:false,plugins:[react()],logLevel:'error',server:{host:'127.0.0.1',port:0}});
let browser;
try{
  await server.listen();const origin=`http://127.0.0.1:${server.httpServer.address().port}`;
  browser=await chromium.launch({headless:true,executablePath:process.env.AOD_TEST_CHROMIUM});
  for(const width of [1440,390,320]){
    const store=new HubStore(':memory:','synthetic'),app=new Hono(),principal=()=>({userId:'owner',admin:false});
    const coordinator=store.createContentCoordinator(()=>{throw Error('No Connector calls permitted');});
    registerHubSessionNotebookRoutes(app,{hubStore:store,principal});
    registerHubWorkspaceContent(app,{coordinator,principal,native:(o,r)=>store.cardFileProjection.get(o,r),enabled:()=>true});
    const note=await (await app.request('/api/hub/v1/notebooks/default')).json();
    assert.ok(store.notebooks.save('owner',{...note,text:'Private native hot note'}));
    const resource=JSON.stringify(['notebook','hub:default']);
    const source=store.cardFileProjection.get('owner',resource);
    coordinator.migrate('owner',resource,source.revision,randomUUID());
    const bytes=createHash('sha256').update(JSON.stringify(['agentopsdeck.workspace-file-pane',1,'browser','fixture-service'])).digest().subarray(0,16);
    bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
    const hex=bytes.toString('hex'),id=`${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
    const serviceResource=JSON.stringify(['browser',id]);
    store.cardConfigurations.save('owner',id,{kind:'browser',revision:0,mutationId:randomUUID(),content:{title:'Shared browser',url:'https://example.invalid/shared'}});
    coordinator.migrate('owner',serviceResource,1,randomUUID());
    const context=await browser.newContext({viewport:{width,height:1000},serviceWorkers:'block'});
    await context.addInitScript(()=>localStorage.setItem('agentopsdeck.locale','en'));
    let coldReads=0,coldWrites=0,hotWrites=0,hotOverviews=0;
    try{
      await context.route('**/*',async route=>{
        const req=route.request(),url=new URL(req.url());assert.equal(url.origin,origin);
        if(!url.pathname.startsWith('/api/'))return route.continue();
        if(url.pathname.includes('/workspace/file-cards/')){
          assert.equal(req.method(),'GET','fixture permits read-only file binding discovery');
          return route.fulfill({json:url.pathname.endsWith('/file-binding')?{enabled:true,binding:null}:{version:1,kind:'notebook',revision:1,content:{text:'Private native hot note',archive:''}}});
        }
        if(url.pathname.includes('/configuration'))return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({document:null})});
        assert.ok(url.pathname.includes('/notebooks')||url.pathname.includes('/workspace/shared-content/'),`Unexpected request ${url.pathname}`);
        if(req.method()==='GET'&&url.pathname.endsWith(encodeURIComponent(resource))){
          assert.equal(url.search,'?view=hot','notebook gate requests no cold text');hotOverviews++;
        }
        if(url.pathname.endsWith('/archive')){if(req.method()==='GET')coldReads++;else coldWrites++;}
        if(url.pathname.endsWith('/document')&&req.method()==='PUT')hotWrites++;
        const response=await app.request(url.pathname+url.search,{method:req.method(),...(req.postData()?{body:req.postData(),headers:{'content-type':'application/json'}}:{})});
        return route.fulfill({status:response.status,contentType:'application/json',body:await response.text()});
      });
      const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
      await page.goto(`${origin}/tests/fixtures/shared-scope.html?kind=notebook`);
      await page.getByRole('region',{name:'Shared card editor'}).waitFor();assert.equal(coldReads,0);assert.ok(hotOverviews>0);
      assert.equal(await page.getByLabel('Text',{exact:true}).getAttribute('maxlength'),'50000');
      await page.getByText('Notebook archive',{exact:true}).click();
      const cold=page.getByRole('textbox',{name:'Notebook archive',exact:true});await cold.waitFor();
      await page.waitForFunction(()=>!document.querySelector('textarea[aria-label="Notebook archive"]')?.disabled);
      await verifyArchiveSplit(page, page.locator('main'), page.getByRole('region',{name:'Shared card editor'}));
      assert.equal(coldWrites,0);assert.equal(hotWrites,0,'resizing never writes notes');
      assert.equal(await cold.getAttribute('maxlength'),'100000');await cold.fill('Private cold data');await cold.blur();
      await page.waitForFunction(()=>[...document.querySelectorAll('[role="status"]')].some(e=>e.textContent==='Saved'));
      assert.equal(coldWrites,1);assert.equal(hotWrites,0);
      assert.equal(JSON.parse(coordinator.store.resource('owner',resource).content).content.text,'Private native hot note');
      await page.reload();await page.getByText('Notebook archive',{exact:true}).click();await page.waitForFunction(()=>document.querySelector('textarea[aria-label="Notebook archive"]')?.value==='Private cold data');
      await page.goto(`${origin}/tests/fixtures/shared-scope.html?kind=service`);
      await page.getByRole('region',{name:'Native service'}).waitFor();
      assert.equal(await page.getByLabel('Service address').textContent(),'https://example.invalid/original','shared settings never auto-apply');
      await page.getByRole('button',{name:'Use file settings',exact:true}).click();assert.equal(await page.getByLabel('Service address').textContent(),'https://example.invalid/shared');
      await page.getByRole('button',{name:'Use native service',exact:true}).click();assert.equal(await page.getByLabel('Service address').textContent(),'manually used');
      assert.deepEqual(errors,[]);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
      console.log(JSON.stringify({width,passed:true,coldReads,coldWrites,hotWrites,realScope:true,privateArchive:true,explicitServiceApply:true}));
    }finally{await context.close();await coordinator.close();store.close();}
  }
}finally{await browser?.close();await server.close();}
