// Real component + sessionStorage; exact synthetic recovery POST, no live Hub.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { serveFixture } from './fixtures/static-assets.mjs';
import { fenceContext, verifyFence } from './fixtures/browser-network.mjs';
const { chromium } = await import(process.env.AOD_TEST_PLAYWRIGHT ? pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href : 'playwright');
const id='42337b9d-8e08-4754-8caf-d2587c4ce291',scope='a'.repeat(64),resource='["notebook","hub:default"]';
const key=JSON.stringify(['shared-content-v1',scope,resource])+':pending';
const content=JSON.stringify({kind:'notebook',content:{title:'AgentOpsDeck ideas',text:'Keep this text'}});
const head={epoch:'11111111-1111-4111-8111-111111111111',revision:0,hash:'b'.repeat(64),content};
const entry=`import React from 'react';import{createRoot}from'react-dom/client';
import '/src/styles.css';
import Shared from '/src/components/WorkspaceSharedContent.tsx';import{setRecoveryScope}from'/src/api.ts';
import{pageRefreshGate}from'/src/lib/page-refresh.ts';setRecoveryScope(${JSON.stringify(scope)});
import{setLocale}from'/src/lib/i18n.ts';window.setTestLocale=setLocale;
window.clean=()=>pageRefreshGate.ready();
window.mountPeer=()=>{const el=document.createElement('div');document.body.appendChild(el);createRoot(el).render(<Shared scope={${JSON.stringify(scope)}} resource={'["notebook","peer"]'} ready={()=>true}><p>Peer note</p></Shared>);};
createRoot(document.getElementById('root')).render(<React.StrictMode><Shared scope={${JSON.stringify(scope)}} resource={${JSON.stringify(resource)}} ready={()=>true}><p>Keep this text</p></Shared></React.StrictMode>);`;
const bundle=await build({root:fileURLToPath(new URL('..',import.meta.url)),configFile:false,envFile:false,logLevel:'error',plugins:[
  {name:'recovery-fixture',resolveId:id=>id==='/recovery-fixture.tsx'?id:undefined,load:id=>id==='/recovery-fixture.tsx'?entry:undefined},react()],
  build:{write:false,minify:false,rollupOptions:{input:'/recovery-fixture.tsx'}}});
const server=await serveFixture(bundle.output);let browser;
try{
  browser=await chromium.launch({headless:true,executablePath:process.env.AOD_TEST_CHROMIUM});
  for(const width of [1440,390,320]){
  const context=await browser.newContext({serviceWorkers:'block',viewport:{width,height:900}}),page=await context.newPage();page.setDefaultTimeout(10000);
  const errors=[];page.on('pageerror',e=>errors.push(String(e)));
  let proved=false,reads=0,snapshotHead=null,recoveryCalls=0,termination=null;
  const denied=await fenceContext(context,{origin:server.origin,apiWrites:[{method:'POST',path:'/api/hub/v1/workspace/shared-content/'+encodeURIComponent(resource)+'/migrations/'+id+'/recover'}],api:async route=>{
    const path=new URL(route.request().url()).pathname;
    if(path.endsWith('/migrations/'+id+'/recover')){
      assert.equal(route.request().method(),'POST');assert.deepEqual(route.request().postDataJSON(),{});recoveryCalls++;
      if(recoveryCalls===1)return route.fulfill({json:{receipt:null,termination:{mutationId:'wrong',resource,state:'not-executed'}}});
      termination={mutationId:id,resource,state:'not-executed'};
      return route.abort('failed'); // server persisted proof; response lost
    }
    assert.equal(route.request().method(),'GET');
    if(path.endsWith('/migrations/'+id)){reads++;return route.fulfill({json:{receipt:proved?{mutationId:id,result:head}:null,termination}});}
    assert.ok(path.startsWith('/api/hub/v1/workspace/shared-content/'));
    await route.fulfill({json:{enabled:true,head:snapshotHead,native:{kind:'notebook',content:{title:'AgentOpsDeck ideas',text:'Keep this text'},revision:0},bindings:[]}});
  }});
  await page.goto(server.origin+'/fixture');
  await page.evaluate(({key,id})=>sessionStorage.setItem(key,JSON.stringify({id,kind:'migration',original:'/migrations/'+id})),{key,id});
  await page.reload();
  await page.waitForFunction(()=>!document.querySelector('button[disabled]'));
  await page.locator('summary').click();
  const firstReads=reads;
  await page.getByRole('button',{name:'Inspect original request',exact:true}).click();
  await page.getByRole('alert').waitFor();assert.ok(reads>=firstReads+1); // automatic GET may also run
  await page.evaluate(()=>{window.originalStorageWrite=Storage.prototype.setItem;Storage.prototype.setItem=function(){throw new DOMException('Full','QuotaExceededError');};});
  await page.getByRole('button',{name:'Hide warning and keep request'}).click();
  assert.equal(await page.locator('details.shared-request-record').count(),1);
  assert.equal(await page.getByRole('alert').count(),1);
  assert.equal(await page.evaluate(key=>JSON.parse(sessionStorage.getItem(key)).warningDismissed,key),undefined);
  assert.equal(await page.evaluate(()=>window.clean()),false);
  await page.evaluate(()=>{Storage.prototype.setItem=window.originalStorageWrite;delete window.originalStorageWrite;});
  await page.getByRole('button',{name:'Hide warning and keep request'}).click();
  await page.locator('details.shared-request-record').waitFor();
  assert.equal(await page.getByRole('alert').count(),0);
  const stored=await page.evaluate(key=>JSON.parse(sessionStorage.getItem(key)),key);
  assert.deepEqual(stored,{id,kind:'migration',original:'/migrations/'+id,warningDismissed:true});
  assert.equal(await page.locator('.shared-recovery--compact').count(),1);
  assert.equal(await page.evaluate(()=>window.clean()),false);
  await page.reload();await page.locator('details.shared-request-record').waitFor();
  assert.equal(await page.getByRole('button',{name:'Hide warning and keep request'}).count(),0);
  assert.equal(await page.getByText('Keep this text',{exact:true}).count(),1);
  await page.locator('summary').click();
  const secondReads=reads;
  await page.getByRole('button',{name:'Inspect original request',exact:true}).click();
  await page.getByRole('alert').waitFor();assert.ok(reads>=secondReads+1);
  await page.getByRole('button',{name:'Show warning again'}).click();
  assert.equal(await page.locator('.shared-recovery--compact').count(),0);
  await page.getByRole('button',{name:'Hide warning and keep request'}).waitFor();
  await page.getByRole('button',{name:'Hide warning and keep request'}).click();
  proved=true;snapshotHead=head;
  const thirdReads=reads;
  await page.getByRole('button',{name:'Inspect original request',exact:true}).click();
  await page.waitForFunction(key=>sessionStorage.getItem(key)===null,key);
  assert.ok(reads>=thirdReads+1);assert.equal(await page.locator('details.shared-request-record').count(),0);
  assert.equal(await page.evaluate(()=>window.clean()),true);
  assert.deepEqual(errors,[]);await verifyFence(page,denied);
  denied.length=0;
  console.log('PASS: shared request warning hides/restores/reloads; GET-only recovery retains locks until receipt; width='+width);
  // A hidden warning must not hide the safe recovery action. A malformed proof
  // and a lost recovery ACK retain the pending intent until an exact GET proof.
  proved=false;snapshotHead=null;
  await page.evaluate(({key,id})=>sessionStorage.setItem(key,JSON.stringify({id,kind:'migration',original:'/migrations/'+id,warningDismissed:true})),{key,id});
  await page.reload();await page.getByRole('button',{name:'Check original request and restore editing'}).click();
  assert.equal(recoveryCalls,0);
  await page.getByRole('button',{name:'Confirm safe recovery'}).click();
  await page.getByText('Original result is still unavailable. The request record has been kept; nothing was resent.').waitFor({state:'attached'});
  await page.getByRole('button',{name:'Confirm safe recovery'}).waitFor({state:'visible'});
  await page.waitForFunction(()=>!document.querySelector('section[aria-label="Restore editing safely"] button').disabled);
  assert.equal(recoveryCalls,1);assert.equal(await page.evaluate(()=>window.clean()),false);
  assert.ok(await page.evaluate(key=>sessionStorage.getItem(key),key));
  await page.getByRole('button',{name:'Confirm safe recovery'}).click();
  // Automatic GET recovers the lost ACK without reload or another POST.
  await page.waitForFunction(key=>sessionStorage.getItem(key)===null,key);
  assert.equal(recoveryCalls,2);
  assert.equal(await page.evaluate(()=>window.clean()),true);
  assert.equal(await page.getByText('Keep this text',{exact:true}).count(),1);
  assert.equal(await page.getByRole('button',{name:'Check original request and restore editing'}).count(),0);
  await page.getByText('The original request was not executed and is now fenced. Editing is restored; notebook content was not changed.').waitFor();
  // Even exact server proof cannot unlock if pending removal cannot persist.
  await page.evaluate(({key,id})=>sessionStorage.setItem(key,JSON.stringify({id,kind:'migration',original:'/migrations/'+id})),{key,id});
  await page.addInitScript(()=>{window.originalStorageRemove=Storage.prototype.removeItem;Storage.prototype.removeItem=function(){throw new Error('storage blocked');};});
  await page.reload();await page.getByRole('alert').waitFor();
  assert.ok(await page.evaluate(key=>sessionStorage.getItem(key),key));assert.equal(await page.evaluate(()=>window.clean()),false);
  await page.evaluate(()=>{Storage.prototype.removeItem=window.originalStorageRemove;});
  await page.locator('summary').click();
  await page.getByRole('button',{name:'Inspect original request',exact:true}).click();
  await page.waitForFunction(key=>sessionStorage.getItem(key)===null,key);
  assert.equal(await page.evaluate(()=>window.clean()),true);assert.equal(recoveryCalls,2);
  assert.deepEqual(errors,[]);await verifyFence(page,denied);
  console.log('PASS: safe migration recovery; malformed proof stays locked; lost POST ACK recovered by GET; native text preserved; width='+width);
  await context.close();
  }
  for(const width of [1440,390,320])await ownerRecovery(width);
  for(const width of [1440,390,320])await automaticReadRecovery(width);
}finally{await browser?.close();await server.close();}

async function automaticReadRecovery(width){
  const context=await browser.newContext({serviceWorkers:'block',viewport:{width,height:900}}),page=await context.newPage();page.setDefaultTimeout(10000);
  try{
    const target='/api/hub/v1/workspace/shared-content/'+encodeURIComponent(resource);
    let reads=0,peerReads=0,fail=false;
    const denied=await fenceContext(context,{origin:server.origin,api:async route=>{
      assert.equal(route.request().method(),'GET');const path=new URL(route.request().url()).pathname;
      if(path!==target){assert.equal(path,'/api/hub/v1/workspace/shared-content/'+encodeURIComponent('["notebook","peer"]'));peerReads++;}
      else {reads++;if(fail)return route.fulfill({status:503,json:{error:'temporary'}});}
      return route.fulfill({json:{enabled:true,head:null,native:null,bindings:[]}});
    }});
    await page.goto(server.origin+'/fixture');await page.getByText('Keep this text',{exact:true}).waitFor();
    await page.evaluate(()=>window.mountPeer());await page.getByText('Peer note',{exact:true}).waitFor();
    fail=true;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await page.getByRole('alert').waitFor();
    const initial=await page.getByText('Keep this text',{exact:true}).boundingBox();
    const panel=await page.locator('.shared-recovery-popover').boundingBox();assert.ok(panel.x>=0&&panel.x+panel.width<=width&&panel.y>=0&&panel.y+panel.height<=900);
    await page.getByRole('button',{name:'Close sync status',exact:true}).click();assert.deepEqual(await page.getByText('Keep this text',{exact:true}).boundingBox(),initial);
    await page.getByRole('button',{name:'Sync recovery',exact:true}).click();assert.deepEqual(await page.getByText('Keep this text',{exact:true}).boundingBox(),initial);
    const peers=peerReads,before=reads;
    await page.getByRole('button',{name:'Refresh this card',exact:true}).click();assert.ok(reads>before);assert.equal(peerReads,peers);
    // No user action, page reload or mutation: next retry must clear the error.
    fail=false;await page.getByRole('alert').waitFor({state:'detached'});assert.equal(await page.getByRole('button',{name:'Sync recovery',exact:true}).count(),0);
    assert.equal(peerReads,peers);assert.equal(await page.evaluate(()=>window.clean()),true);await verifyFence(page,denied);
    console.log('PASS: transient GET auto-recovers, manual refresh isolated, floating panel does not move content; width='+width);
  }finally{await context.close();}
}

async function ownerRecovery(width){
  const context=await browser.newContext({serviceWorkers:'block',viewport:{width,height:900}}),page=await context.newPage();page.setDefaultTimeout(10000);
  try{
    const basePath='/api/hub/v1/workspace/shared-content/'+encodeURIComponent(resource),writePath=basePath+`/writes/${head.epoch}/${id}`;
    const localText=JSON.stringify({kind:'notebook',content:{title:'My unsaved note',text:'Local ideas to preserve'}}),draft={base:head,text:localText};
    let current=head,proof=null,mode='malformed',calls=0,reads=0,failSnapshot=false,committed=false;
    const errors=[];page.on('pageerror',e=>errors.push(String(e)));
    const denied=await fenceContext(context,{origin:server.origin,apiWrites:[{method:'POST',path:writePath+'/recover'}],api:async route=>{
      const req=route.request(),path=new URL(req.url()).pathname;
      if(path===writePath+'/recover'){
        assert.equal(req.method(),'POST');assert.deepEqual(req.postDataJSON(),{});calls++;
        if(committed)return route.fulfill({json:{receipt:{mutationId:id,state:'committed'},termination:null}});
        if(mode==='malformed')return route.fulfill({json:{receipt:null,termination:{mutationId:id,resource,epoch:'wrong',state:'not-executed'}}});
        proof={mutationId:id,resource,epoch:head.epoch,state:'not-executed'};
        if(mode==='lost')return route.abort('failed');
        return route.fulfill({json:{receipt:null,termination:proof}});
      }
      assert.equal(req.method(),'GET');
      if(path===writePath){reads++;return route.fulfill({json:{receipt:null,termination:proof}});}
      assert.equal(path,basePath);
      return route.fulfill(failSnapshot?{status:503,json:{error:'offline'}}:{json:{enabled:true,head:current,native:null,bindings:[]}});
    }});
    const seed=async()=>{
      proof=null;
      await page.evaluate(({key,id,epoch,draft})=>{sessionStorage.setItem(key,JSON.stringify({id,kind:'write',original:`/writes/${epoch}/${id}`}));sessionStorage.setItem(key.replace(/:pending$/,':draft'),JSON.stringify(draft));},{key,id,epoch:head.epoch,draft});
      await page.reload();await page.getByRole('region',{name:'Sync recovery'}).waitFor();
      await page.waitForFunction(()=>!document.querySelector('section[aria-label="Sync recovery"] button').disabled);
    };
    const stored=()=>page.evaluate(key=>JSON.parse(sessionStorage.getItem(key.replace(/:pending$/,':draft'))),key);
    const recovery=page.getByRole('region',{name:'Sync recovery'});
    await page.goto(server.origin+'/fixture');
    // Let the first mount publish its clean snapshot before installing a
    // synthetic dirty draft; otherwise that mount can overwrite our test seed.
    await page.waitForFunction(key=>sessionStorage.getItem(key.replace(/:pending$/,':draft'))!==null,key);
    await seed();
    assert.ok(reads>=1);assert.equal(calls,0);
    assert.equal(await page.locator('details').getAttribute('open'),null);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.getByRole('button',{name:'Check original request and restore editing'}).focus();
    assert.equal(await page.evaluate(()=>getComputedStyle(document.activeElement).outlineStyle),'solid');
    const downloadEvent=page.waitForEvent('download');await recovery.getByRole('button',{name:'Download a copy',exact:true}).click();const download=await downloadEvent;
    assert.equal(download.suggestedFilename(),'agentopsdeck-local-draft.json');assert.equal(readFileSync(await download.path(),'utf8'),localText);
    assert.deepEqual(await stored(),draft);assert.equal(calls,0);
    if(process.env.AOD_TEST_ARTIFACT_DIR){mkdirSync(process.env.AOD_TEST_ARTIFACT_DIR,{recursive:true});await page.screenshot({path:join(process.env.AOD_TEST_ARTIFACT_DIR,`recovery-${width}-light.png`)});}
    await page.evaluate(()=>window.setTestLocale('zh-CN'));
    await page.getByRole('button',{name:'恢复编辑（保留草稿）',exact:true}).waitFor();
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    if(process.env.AOD_TEST_ARTIFACT_DIR)await page.screenshot({path:join(process.env.AOD_TEST_ARTIFACT_DIR,`recovery-${width}-zh.png`)});
    await page.evaluate(()=>window.setTestLocale('en'));
    await recovery.getByRole('button',{name:'Discard local changes',exact:true}).click();
    const confirm=page.getByRole('region',{name:'Discard local changes?',exact:true});await confirm.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(calls,0);assert.deepEqual(await stored(),draft);
    await recovery.getByRole('button',{name:'Discard local changes',exact:true}).click();await confirm.getByRole('button',{name:'Confirm discard',exact:true}).click();
    await page.getByRole('alert').waitFor();assert.equal(calls,1);assert.deepEqual(await stored(),draft);assert.ok(await page.evaluate(key=>sessionStorage.getItem(key),key));
    mode='lost';await confirm.getByRole('button',{name:'Confirm discard',exact:true}).click();
    await page.waitForFunction(key=>sessionStorage.getItem(key)===null,key);assert.equal(calls,2);assert.deepEqual(await stored(),draft);
    // Even after the original is safely fenced, a failed latest-version read
    // must leave local text intact. There is no automatic replay of discard.
    await page.getByRole('button',{name:'Discard local changes',exact:true}).click();failSnapshot=true;
    await confirm.getByRole('button',{name:'Confirm discard',exact:true}).click();await page.getByRole('alert').waitFor();assert.deepEqual(await stored(),draft);assert.equal(calls,2);
    failSnapshot=false;await confirm.getByRole('button',{name:'Confirm discard',exact:true}).click();await confirm.waitFor({state:'detached'});
    assert.equal((await stored()).text,head.content);assert.equal(await page.evaluate(()=>window.clean()),true);assert.equal(calls,2);
    // Already committed saves are not rolled back by dropping the local draft.
    current={...head,revision:1,hash:'c'.repeat(64),content:JSON.stringify({kind:'notebook',content:{title:'Remote latest',text:'Already saved elsewhere'}})};
    committed=true;await seed();await recovery.getByRole('button',{name:'Discard local changes',exact:true}).click();await confirm.getByRole('button',{name:'Confirm discard',exact:true}).click();
    await confirm.waitFor({state:'detached'});assert.equal((await stored()).text,current.content);assert.equal(calls,3);assert.equal(await page.evaluate(()=>window.clean()),true);
    // A storage failure cannot discard local content even with exact proof.
    committed=false;mode='valid';await seed();
    await page.evaluate(()=>{window.restoreSet=Storage.prototype.setItem;Storage.prototype.setItem=function(){throw Error('storage-full');};});
    await recovery.getByRole('button',{name:'Discard local changes',exact:true}).click();await confirm.getByRole('button',{name:'Confirm discard',exact:true}).click();
    await page.getByRole('alert').waitFor();assert.deepEqual(await stored(),draft);assert.equal(calls,4);
    await page.evaluate(()=>{Storage.prototype.setItem=window.restoreSet;});
    await confirm.getByRole('button',{name:'Cancel',exact:true}).click();
    // Recovery without discard preserves the original local draft for comparison.
    await seed();await page.getByRole('button',{name:'Check original request and restore editing'}).click();await page.getByRole('button',{name:'Confirm safe recovery',exact:true}).click();
    await page.waitForFunction(key=>sessionStorage.getItem(key)===null,key);assert.deepEqual(await stored(),draft);assert.equal(await page.evaluate(()=>window.clean()),false);
    // A committed original discovered on remount must not erase a newer draft.
    await seed();
    await context.route(server.origin+writePath,route=>route.fulfill({json:{receipt:{mutationId:id,state:'committed'},termination:null}}));
    await page.reload();await page.waitForFunction(key=>sessionStorage.getItem(key)===null,key);
    assert.deepEqual(await stored(),draft);assert.equal(await page.evaluate(()=>window.clean()),false);
    // Malformed JSON can still be downloaded exactly; no schema repair or save.
    const malformedDraft={...draft,text:'unfinished {'};await page.evaluate(({key,draft})=>sessionStorage.setItem(key.replace(/:pending$/,':draft'),JSON.stringify(draft)),{key,draft:malformedDraft});await page.reload();
    const rawDownload=page.waitForEvent('download');await page.getByRole('button',{name:'Download a copy',exact:true}).click();assert.equal(readFileSync(await (await rawDownload).path(),'utf8'),malformedDraft.text);
    assert.equal(calls,5);assert.deepEqual(errors,[]);await verifyFence(page,denied);
    console.log('PASS: owner-write recovery/drop/download; malformed proof, lost ACK, offline read, storage failure, committed save, local draft retained; width='+width);
  }finally{await context.close();}
}
