import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {Hono} from '../../server/node_modules/hono/dist/index.js';
import {WorkspaceContentCoordinator} from '../../server/src/hub/workspace-content-coordinator.ts';
import {WorkspaceContentBatches} from '../../server/src/hub/workspace-content-batches.ts';
import {NativeWorkspaceCardFileProjection} from '../../server/src/hub/workspace-card-file-projection.ts';
import {WorkspaceBoards} from '../../server/src/hub/workspace-boards.ts';
import {WorkspaceCards} from '../../server/src/hub/workspace-cards.ts';
import {WorkspaceDrawings} from '../../server/src/hub/workspace-drawings.ts';
import {WorkspaceNativeDrawio} from '../../server/src/hub/workspace-native-drawio.ts';
import {WorkspaceCardConfigurations} from '../../server/src/hub/workspace-card-configurations.ts';
import {SessionNotebooks} from '../../server/src/hub/session-notebooks.ts';
import {registerHubWorkspaceContent} from '../../server/src/routes/hub-workspace-content.ts';
const {chromium}=await import(process.env.AOD_TEST_PLAYWRIGHT?pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href:'playwright');
const server=await createServer({root:fileURLToPath(new URL('..',import.meta.url)),configFile:false,envFile:false,plugins:[react()],logLevel:'error',server:{host:'127.0.0.1',port:0}});
let browser;
try{
  await server.listen();const origin=`http://127.0.0.1:${server.httpServer.address().port}`;
  browser=await chromium.launch({headless:true,executablePath:process.env.AOD_TEST_CHROMIUM});
  for(const width of [1440,390,320]){
    const db=new DatabaseSync(':memory:');
    const native=new NativeWorkspaceCardFileProjection(db,{boards:new WorkspaceBoards(db),cards:new WorkspaceCards(db),drawings:new WorkspaceDrawings(db),nativeDrawio:new WorkspaceNativeDrawio(db),configurations:new WorkspaceCardConfigurations(db),notebooks:new SessionNotebooks(db),sessionNotebook:()=>undefined});
    const replica=new Map();let installs=0;
    const target={sessionId:'fixture',sessionKey:'codex:fixture',connectionId:'fixture-connection',authority:0,valid(){},transport:{
      capability:async()=>({protocol:1,available:true}),install:async input=>{installs++;replica.set(input.id,input);return input.base;},
      view:async id=>{const v=replica.get(id);if(!v)throw Error('missing');return {resource:v.resource,generation:v.generation,sessionKey:v.sessionKey,initial:v.base,base:v.base,actualHash:v.base.hash,proposals:[]};},
      revoke:async id=>{replica.delete(id);},
    }};
    const coordinator=new WorkspaceContentCoordinator(db,native,(owner,id)=>{assert.equal(owner,'owner');assert.equal(id,'fixture');return target;});
    const source={fence:()=>({generation:0,preferencesRevision:0}),authorized:()=>true,enumerate:async()=>({complete:true,members:[{owner:'owner',nodeId:'fixture',connectionId:'fixture-connection',runtime:'codex',sessionId:'fixture',authorityEpoch:0,groupId:'dev',tags:['shared'],taskBinding:'supported'}]})};
    const batches=new WorkspaceContentBatches(db,coordinator,source),app=new Hono();
    registerHubWorkspaceContent(app,{coordinator,batches,principal:()=>({userId:'owner',admin:false}),native:(o,r)=>native.get(o,r),enabled:()=>true});
    const context=await browser.newContext({viewport:{width,height:900},serviceWorkers:'block'});await context.addInitScript(()=>localStorage.setItem('agentopsdeck.locale','en'));
    const resource=JSON.stringify(['taskboard','default']);let writes=0,dropWrite=true,dropPreview=true,previews=0,confirms=0;
    let writeId,writeReceiptReads=0;
    let holdSnapshot=false,heldSnapshot,releaseSnapshot,heldStatus;
    const snapshotHeld=()=>new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('snapshot poll did not arrive within 25s')),25000);
      heldSnapshot=()=>{clearTimeout(timer);resolve();};
    });
    try{
      await context.route('**/*',async route=>{
        const req=route.request(),url=new URL(req.url());assert.equal(url.origin,origin);
        if(!url.pathname.startsWith('/api/'))return route.continue();
        const json=body=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
        if(url.pathname.includes('/sessions'))return json({groups:[]});
        if(url.pathname.includes('/preferences'))return json({revision:0,groups:[{id:'dev',name:'Development'}],sessionTags:{},sessionGroups:{}});
        assert.ok(url.pathname.includes('/workspace/shared-content/'),'never send a message');
        if(req.method()==='PUT'&&url.pathname.endsWith('/document')){writes++;writeId=req.postDataJSON().mutationId;}
        if(req.method()==='GET'&&url.pathname.includes('/writes/')){
          assert.equal(url.pathname.split('/').at(-1),writeId,'recovery only reads the original write');writeReceiptReads++;
        }
        if(req.method()==='PUT'&&url.pathname.includes('/batches/'))previews++;
        if(url.pathname.endsWith('/confirm'))confirms++;
        const response=await app.request(url.pathname,{method:req.method(),...(req.postData()?{body:req.postData(),headers:{'content-type':'application/json'}}:{})});
        if(holdSnapshot&&req.method()==='GET'&&decodeURIComponent(url.pathname).endsWith(resource)){
          holdSnapshot=false;
          const body=await response.text();
          await new Promise(resolve=>{releaseSnapshot=resolve;heldSnapshot();});
          return route.fulfill({status:heldStatus??response.status,contentType:'application/json',body});
        }
        if(dropWrite&&url.pathname.endsWith('/document')){dropWrite=false;return route.abort();}
        if(dropPreview&&req.method()==='PUT'&&url.pathname.includes('/batches/')){dropPreview=false;return route.abort();}
        return route.fulfill({status:response.status,contentType:'application/json',body:await response.text()});
      });
      const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
      const open=()=>page.goto(`${origin}/tests/fixtures/shared-content.html`);
      await open();await page.getByLabel('Native editor',{exact:true}).fill('unsaved');
      await page.getByRole('button',{name:'Shared card access',exact:true}).click();await page.getByRole('button',{name:'Enable shared content',exact:true}).click();await page.getByRole('alert').waitFor();
      assert.equal(coordinator.store.resource('owner',resource),undefined);assert.equal(await page.getByLabel('Native editor',{exact:true}).inputValue(),'unsaved');
      await page.getByRole('button',{name:'Close sync status',exact:true}).click();
      await page.getByLabel('Native editor',{exact:true}).fill('saved native');await page.getByRole('button',{name:'Enable shared content',exact:true}).click();
      await page.getByLabel('Title',{exact:true}).waitFor();await page.getByLabel('Title',{exact:true}).fill('');
      assert.equal(await page.getByRole('button',{name:'Save',exact:true}).isEnabled(),false);
      await page.getByLabel('Title',{exact:true}).fill('Shared fixture');await page.getByRole('button',{name:'Add task',exact:true}).click();
      await page.getByLabel('Task title',{exact:true}).fill('Retained task');await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByRole('alert').waitFor();assert.equal(writes,1);
      await open();
      await page.waitForFunction(()=>document.querySelector('fieldset')&&!document.querySelector('fieldset').disabled);assert.equal(writes,1);
      assert.ok(writeReceiptReads>0,'lost acknowledgement is recovered by original receipt GET, never a repeated save');
      await page.getByLabel('Task title',{exact:true}).fill('Local draft');await open();assert.equal(await page.getByLabel('Task title',{exact:true}).inputValue(),'Local draft');
      const head=coordinator.store.resource('owner',resource),remote=JSON.parse(head.content);remote.content.title='Remote title';
      coordinator.store.write('owner',resource,{mutationId:randomUUID(),modeEpoch:head.epoch,baseRevision:head.revision,baseHash:head.hash,content:JSON.stringify(remote)});
      await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByRole('region',{name:'Content conflict',exact:true}).waitFor();
      assert.equal(await page.getByLabel('Task title',{exact:true}).inputValue(),'Local draft');
      await page.getByRole('button',{name:'Keep draft with current base',exact:true}).click();await page.getByRole('button',{name:'Save',exact:true}).click();
      await page.waitForFunction(()=>document.querySelector('fieldset')&&!document.querySelector('fieldset').disabled);assert.equal(JSON.parse(coordinator.store.resource('owner',resource).content).content.tasks[0].title,'Local draft');
      await page.getByRole('button',{name:'Shared card access',exact:true}).click();await page.getByLabel('Tags (comma-separated)',{exact:true}).fill('shared');
      await page.getByRole('button',{name:'Preview full card grant',exact:true}).click();await page.getByRole('alert').waitFor();assert.equal(previews,1);
      await open();await page.getByRole('button',{name:'Shared card access',exact:true}).click();await page.getByRole('button',{name:'Inspect batch',exact:true}).click();
      await page.getByRole('button',{name:'Confirm frozen batch',exact:true}).click();await page.waitForFunction(()=>document.querySelector('fieldset')&&!document.querySelector('fieldset').disabled);
      assert.equal(confirms,1);assert.equal(installs,1);assert.equal(previews,1);
      await page.getByRole('button',{name:'Inspect batch',exact:true}).click();assert.equal(installs,1);
      await page.getByRole('button',{name:'Revoke batch and clean up',exact:true}).click();await page.getByRole('button',{name:'Start another batch',exact:true}).waitFor();assert.equal(replica.size,0);
      // A poll already in flight must not roll the editor back after a newer save.
      for(const status of [200,404]){
      heldStatus=status;
      holdSnapshot=true;await snapshotHeld();
      const title=`Saved after old poll ${status}`;
      await page.getByLabel('Title',{exact:true}).fill(title);
      await page.getByRole('button',{name:'Save',exact:true}).click();
      await page.waitForFunction(()=>document.querySelector('fieldset')&&!document.querySelector('fieldset').disabled);
      const revision=coordinator.store.resource('owner',resource).revision;
      const responseArrived=page.waitForResponse(r=>r.request().method()==='GET'&&decodeURIComponent(new URL(r.url()).pathname).endsWith(resource));
      releaseSnapshot();await (await responseArrived).finished();
      // Flush React work; this is not an extra refresh or a business retry.
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      assert.equal(await page.getByLabel('Title',{exact:true}).inputValue(),title,'late pre-write snapshot or 404 must be ignored');
      assert.equal(await page.getByRole('region',{name:'Shared card editor'}).locator('p').first().textContent(),`Shared revision: ${revision} · Cold archive stays private. Service configuration never starts a session or service.`);
      }
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);assert.deepEqual(errors,[]);
      console.log(JSON.stringify({width,passed:true,writes,previews,confirms,installs,strictMode:true,realHubHttp:true,syntheticConnector:true,lateSnapshotIgnored:true,late404Ignored:true}));
    }finally{await context.close();await coordinator.close();db.close();}
  }
}finally{await browser?.close();await server.close();}
