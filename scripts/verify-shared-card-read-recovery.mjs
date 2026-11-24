// Isolated real React/browser acceptance. No production server or credentials.
// node scripts/verify-shared-card-read-recovery.mjs /path/to/playwright/index.mjs
import assert from 'node:assert/strict';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
const root=fileURLToPath(new URL('../apps/web/',import.meta.url));
const {createServer}=await import(pathToFileURL(resolve(root,'node_modules/vite/dist/node/index.js')));
const {chromium}=await import(pathToFileURL(resolve(process.argv[2])));
const scope='a'.repeat(64),resource='["taskboard","default"]';
const baseContent=JSON.stringify({kind:'taskboard',content:{title:'Saved title',tasks:[]}});
const draft={base:{epoch:randomUUID(),revision:1,hash:createHash('sha256').update(baseContent).digest('hex'),content:baseContent},
  text:JSON.stringify({kind:'taskboard',content:{title:'Unsaved local title',tasks:[]}})};
const entry=`import React from 'react';
import {createRoot} from 'react-dom/client';
import Card from '/src/components/WorkspaceSharedContent.tsx';
import {setRecoveryScope} from '/src/api.ts';
setRecoveryScope('${scope}');
if(location.search.includes('draft'))sessionStorage.setItem(JSON.stringify(['shared-content-v1','${scope}',${JSON.stringify(resource)}])+':draft',${JSON.stringify(JSON.stringify(draft))});
function App(){return React.createElement(React.StrictMode,null,...['default','second'].map(id=>React.createElement('article',{'data-card':id,key:id},React.createElement(Card,{scope:'${scope}',resource:JSON.stringify(['taskboard',id]),ready:()=>true},React.createElement('input',{'aria-label':'Native '+id,defaultValue:'Native saved value'})))));}
createRoot(document.getElementById('root')).render(React.createElement(App));`;
const server=await createServer({root,configFile:false,esbuild:{jsx:'automatic'},server:{host:'127.0.0.1',port:0},
  plugins:[{name:'shared-card-fixture',resolveId(id){if(id==='/__card_entry.js')return resolve(root,'__card_entry.jsx');},
    load(id){if(id===resolve(root,'__card_entry.jsx'))return entry;},configureServer(vite){vite.middlewares.use((req,res,next)=>{
    if(req.url?.startsWith('/__card_fixture')){res.setHeader('content-type','text/html');res.end('<div id="root"></div><script type="module" src="/__card_entry.js"></script>');}
    else next();
  });}}]});
let browser;
try{
  await server.listen();const origin=server.resolvedUrls.local[0];
  browser=await chromium.launch({headless:true,...(process.env.AOD_TEST_CHROMIUM?{executablePath:process.env.AOD_TEST_CHROMIUM}:{})});
  const page=await browser.newPage(),errors=[],writes=[];let status=503,reads=0;
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/**',route=>{
    const req=route.request();if(req.method()!=='GET'){writes.push(req.method());return route.abort();}
    const path=decodeURIComponent(new URL(req.url()).pathname),second=path.includes('["taskboard","second"]');
    if(!second)reads++;
    return route.fulfill({status:second?200:status,contentType:'application/json',body:JSON.stringify(second||status===200?
      {enabled:true,head:null,native:{kind:'taskboard',content:{title:'Native',tasks:[]},revision:1},bindings:[]}:{error:'fixture_unavailable'})});
  });
  const card=page.locator('[data-card="default"]'),second=page.locator('[data-card="second"]');
  await page.goto(origin+'__card_fixture');
  await card.getByRole('status').filter({hasText:'Unable to read the latest version'}).waitFor();
  await second.getByRole('textbox',{name:'Native second'}).waitFor();
  assert.equal(await card.getByRole('textbox',{name:'Native default'}).count(),0,'Unknown migration never opens native writer');
  status=200;
  await card.getByRole('button',{name:'Refresh this card',exact:true}).click();
  await card.getByRole('textbox',{name:'Native default'}).fill('Unsaved native edit');
  status=503;
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await page.getByRole('alert').filter({hasText:'Unable to read the latest version'}).waitFor();
  assert.equal(await card.getByRole('textbox',{name:'Native default'}).inputValue(),'Unsaved native edit');
  status=200;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await page.getByRole('alert').filter({hasText:'Unable to read the latest version'}).waitFor({state:'hidden'});
  assert.equal(await card.getByRole('textbox',{name:'Native default'}).inputValue(),'Unsaved native edit');
  status=403;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await card.getByRole('status').filter({hasText:'Card access needs verification'}).waitFor();
  assert.equal(await card.getByRole('textbox',{name:'Native default'}).count(),0,'Revoked native view is unmounted');
  status=503;await page.goto(origin+'__card_fixture?draft');
  const local=card.getByRole('textbox',{name:'Local draft — read-only until verification'});
  await local.waitFor();assert.equal(await local.inputValue(),draft.text);assert.equal(await local.getAttribute('readonly'),'');
  status=404;const before=reads;
  await card.getByRole('button',{name:'Refresh this card',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[data-card="default"] button')!==null);
  assert.ok(reads>before);assert.equal(await card.getByRole('textbox',{name:'Native default'}).count(),0,'Missing receipt does not unlock native');
  assert.equal(await local.inputValue(),draft.text);
  const stored=await page.evaluate(key=>sessionStorage.getItem(key),JSON.stringify(['shared-content-v1',scope,resource])+':draft');
  assert.equal(JSON.parse(stored).text,draft.text);assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:true,checks:8,strictMode:true,productionWrites:0,reads}));
}finally{await browser?.close();await server.close();}
