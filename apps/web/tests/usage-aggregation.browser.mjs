import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
const{chromium}=await import(process.env.AOD_TEST_PLAYWRIGHT?pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href:'playwright');
const server=await createServer({root:fileURLToPath(new URL('..',import.meta.url)),configFile:false,envFile:false,plugins:[react()],logLevel:'error',server:{host:'127.0.0.1',port:0}});
let browser;
try{
  await server.listen();const origin=`http://127.0.0.1:${server.httpServer.address().port}`;browser=await chromium.launch({headless:true});
  const context=await browser.newContext({serviceWorkers:'block',viewport:{width:390,height:900}});await context.addInitScript(()=>localStorage.setItem('agentopsdeck.locale','en'));
  let manifest,previews=0,confirmations=0,reads=0;const errors=[],calls=[];
  const totals={events:1,metrics:Object.fromEntries(['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens'].map((k,i)=>[k,{knownSubtotal:i<2?10:0,knownSampleCount:i<2?1:0,unknownSampleCount:i<2?0:1}]))};
  await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());assert.equal(url.origin,origin);if(!url.pathname.startsWith('/api/'))return route.continue();calls.push(url.pathname);
    const json=body=>route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
    if(url.pathname.endsWith('/connections'))return json({connections:[{id:'dev',nodeId:'node_test',label:'Development',status:'enabled'}]});
    if(url.pathname.endsWith('/preferences'))return json({revision:1,groups:[{id:'g',name:'Work'}],sessions:{}});
    if(url.pathname.endsWith('/layouts/saved'))return json({revision:1,content:JSON.stringify([{id:'l',name:'Focus'}])});
    assert.ok(url.pathname.includes('/usage-manifests'));
    if(request.method()==='POST'&&url.pathname.endsWith('/usage-manifests')){
      previews++;const selection=request.postDataJSON();assert.equal(selection.groupId,'g');assert.deepEqual(selection.tags,['test']);
      manifest={requestId:selection.requestId,selection,directoryRevision:'a'.repeat(64),createdAt:Date.now(),expiresAt:Date.now()+300000,state:'prepared',result:null,
        members:[{sessionId:'session-a',connectionId:'dev',runtime:'codex',groupId:'g',tags:['test'],requestId:randomUUID(),state:'prepared'}]};return route.abort();
    }
    assert.ok(url.pathname.includes(manifest.requestId));
    if(request.method()==='POST'){
      confirmations++;assert.equal(manifest.state,'prepared');manifest.state='complete';manifest.members[0].state='complete';
      manifest.result={version:1,membership:'query-time',memberCount:1,manifestDigest:'b'.repeat(64),total:totals,groups:[{name:'tag:test',...totals}],coverageReasons:['partial-native-coverage'],creditEstimate:{status:'unavailable',reason:'no-verified-versioned-billing-rule'}};
      return route.abort();
    }
    assert.equal(request.method(),'GET');reads++;return json({manifest});
  });
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  const open=async()=>{await page.goto(origin+'/tests/fixtures/usage-aggregation.html');await page.getByRole('button',{name:'Toggle usage'}).click();};
  await page.goto(origin+'/tests/fixtures/usage-aggregation.html');assert.equal(calls.length,0);await page.getByRole('button',{name:'Toggle usage'}).click();
  await page.getByRole('combobox',{name:'Group',exact:true}).selectOption('g');await page.getByRole('textbox',{name:'Tags (comma separated)'}).fill('test');
  await page.getByRole('button',{name:'Preview usage scope'}).click();await page.getByRole('alert').waitFor();assert.equal(confirmations,0);
  await open();await page.getByRole('button',{name:'Confirm usage collection'}).click();await page.getByRole('alert').waitFor();assert.equal(confirmations,1);
  await open();await page.getByRole('heading',{name:'Known token subtotal'}).waitFor();assert.equal(previews,1);assert.equal(confirmations,1);
  assert.match(await page.textContent('body'),/Unknown samples: 1/);await page.getByText('Usage dimensions',{exact:true}).click();await page.getByRole('heading',{name:'tag:test'}).waitFor();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);
  console.log(JSON.stringify({verified:true,previews,confirmations,reads,strictMode:true,lostAckReadOnly:true,viewport:390}));
}finally{await browser?.close();await server.close();}
