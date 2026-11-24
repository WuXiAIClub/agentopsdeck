import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
const {chromium}=await import(process.env.AOD_TEST_PLAYWRIGHT?pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href:'playwright');
const server=await createServer({root:fileURLToPath(new URL('..',import.meta.url)),configFile:false,envFile:false,plugins:[react()],logLevel:'error',server:{host:'127.0.0.1',port:0}});
let browser;
try{
  await server.listen();const origin=`http://127.0.0.1:${server.httpServer.address().port}`;
  browser=await chromium.launch({headless:true});const context=await browser.newContext({serviceWorkers:'block',viewport:{width:390,height:900}});
  await context.addInitScript(()=>localStorage.setItem('agentopsdeck.locale','en'));
  let receipt,previews=0,creates=0,binds=0;const calls=[],errors=[];
  await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());assert.equal(url.origin,origin);
    if(!url.pathname.startsWith('/api/'))return route.continue();calls.push([request.method(),url.pathname]);
    const json=body=>route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
    if(url.pathname.endsWith('/connections'))return json({connections:[{id:'dev',nodeId:'node_test',label:'Development',status:'enabled'}]});
    if(url.pathname.endsWith('/models/codex'))return json({models:[{id:'synthetic-model',label:'Synthetic model'}]});
    assert.ok(url.pathname.includes('/task-sessions'));
    if(request.method()==='POST'&&url.pathname.endsWith('/task-sessions')){
      previews++;const input=request.postDataJSON();assert.equal(input.model,'synthetic-model');receipt={intent:{...input,boardId:'default',boardRevision:1,tasks:[{id:input.taskIds[0],title:'Frozen task',status:'todo',detail:''}]},creationRequestId:randomUUID(),bindingRequestId:randomUUID(),state:'prepared',sessionId:null,bindingId:null};
      return route.abort(); // Lost preview ACK: UUID-only recovery after reload.
    }
    assert.ok(url.pathname.includes(receipt.intent.requestId));
    if(request.method()==='POST'&&url.pathname.endsWith('/create')){
      creates++;assert.equal(receipt.state,'prepared');receipt.state='created';receipt.sessionId='hub:created-session';return route.abort();
    }
    if(request.method()==='POST'&&url.pathname.endsWith('/bind')){
      binds++;assert.equal(receipt.state,'created');receipt.state='bound';receipt.bindingId=receipt.bindingRequestId;
    }
    return json({receipt});
  });
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  const open=async()=>{await page.goto(origin+'/tests/fixtures/task-session.html');await page.getByRole('button',{name:'Toggle creation'}).click();};
  await page.goto(origin+'/tests/fixtures/task-session.html');assert.equal(calls.length,0);
  await page.getByRole('button',{name:'Toggle creation'}).click();
  await page.getByRole('combobox',{name:'Target environment'}).selectOption('dev');await page.getByRole('textbox',{name:'New session title'}).fill('Fix current tasks');
  await page.getByRole('combobox',{name:'Model',exact:true}).selectOption('synthetic-model');
  await page.getByRole('button',{name:'Preview task session'}).click();await page.getByRole('alert').waitFor();assert.equal(creates,0);
  await open();await page.getByRole('button',{name:'Confirm session creation'}).click();await page.getByRole('alert').waitFor();assert.equal(creates,1);assert.equal(binds,0);
  await open();await page.getByRole('button',{name:'Confirm selected task binding'}).waitFor();assert.equal(previews,1);assert.equal(creates,1);assert.equal(binds,0);
  await page.getByRole('button',{name:'Confirm selected task binding'}).click();await page.getByRole('button',{name:'Start another task session'}).waitFor();assert.equal(binds,1);
  await open();await page.getByRole('button',{name:'Start another task session'}).waitFor();assert.equal(creates,1);assert.equal(binds,1);assert.deepEqual(errors,[]);
  console.log(JSON.stringify({verified:true,previews,creates,binds,strictMode:true,reloadReadOnly:true,viewport:390}));
}finally{await browser?.close();await server.close();}
