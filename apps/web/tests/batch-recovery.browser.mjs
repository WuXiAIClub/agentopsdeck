// Real React components against an isolated, GET-only synthetic API.
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';
const { chromium } = await import(pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href);
const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const key = 'remote:synthetic';
const scope = 'a'.repeat(64);
const harness = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FilePicker } from '/src/components/WorkspaceFiles.tsx';
import { CommandRecoveryNotice } from '/src/components/CommandRecoveryNotice.tsx';
import { CommandJournal } from '/src/lib/command-recovery.ts';
import { useLatestMessages } from '/src/lib/use-latest-messages.ts';
import { setRecoveryScope, api } from '/src/api.ts';
setRecoveryScope(${JSON.stringify(scope)});
const journal = new CommandJournal(sessionStorage);
journal.begin(${JSON.stringify(scope)}, ${JSON.stringify(key)}, 'stop-original');
const legacy = journal.begin(${JSON.stringify(scope)}, ${JSON.stringify(key)}, 'legacy-original');
journal.settle(legacy, 'accepted');
function App() {
 const [linked, link] = useState(true), [file, changeFile] = useState('/safe/src/first.ts');
 const [items, setItems] = useState([]), [recovered, count] = useState(0);
 const history = useLatestMessages(${JSON.stringify(key)});
 window.harness = { relink: link, changeFile, switchAccount: () => { link(false); setRecoveryScope('b'.repeat(64)); },
   refresh: async () => { const page = await history.readLatestMessages(${JSON.stringify(key)}, 120, true); setItems(page.messages); },
   cachedNavigation: () => api.cachedSessionMessages(${JSON.stringify(key)}, 120),
   journal: () => journal.list(${JSON.stringify(scope)}) };
 return <><div id="file-picker"><FilePicker onSelect={() => {}} sessionKey={linked ? ${JSON.stringify(key)} : undefined}
   directory={linked ? { sessionKey: ${JSON.stringify(key)}, connectionId:'local', agentId:'codex', sourcePath:file } : undefined}/></div>
   <div id="history" data-cached={history.cachedHistory}>{items.map(item => <p key={item.id}>{item.text}</p>)}</div>
   <div id="receipts"><CommandRecoveryNotice sessionKey={${JSON.stringify(key)}} onRecovered={async () => count(value => value + 1)}/></div>
   <output id="recovered">{recovered}</output></>;
}
createRoot(document.getElementById('root')).render(<App/>);
`;
const server = await createServer({ root, configFile: false, envFile: false, logLevel: 'error',
  esbuild: { jsx: 'automatic' }, server: { host: '127.0.0.1', port: 0 },
  plugins: [{ name: 'isolated-batch-harness', resolveId(id) { if (id === '__batch.tsx' || id === '/__batch.tsx') return root + '/__batch.tsx'; },
    load(id) { if (id === root + '/__batch.tsx') return harness; } }] });
let browser;
try {
 await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
 browser = await chromium.launch({ headless: true, executablePath: process.env.AOD_TEST_CHROMIUM });
 const context = await browser.newContext({ serviceWorkers:'block', viewport:{width:1200,height:900} });
 const page = await context.newPage(), errors = [], writes = [], sourceQueries = [], receiptQueries = [];
 page.on('response', response => { if(response.status()>=400) console.error('HTTP', response.status(),response.url()); });
 let confirmed = false, cached = true, failSource = false;
 page.on('pageerror', error => { errors.push(error.message); console.error('Browser error:', error.message); });
 page.on('console', message => { if(message.type()==='error') console.error('Console:',message.text()); });
 await context.addInitScript(() => localStorage.setItem('agentopsdeck.locale','en'));
 await context.route('**/*', async route => {
   const request=route.request(), url=new URL(request.url());
   if(url.origin!==origin) throw Error('External browser request forbidden');
   if(url.pathname==='/batch-test') return route.fulfill({contentType:'text/html',body:'<div id="root"></div><script type="module" src="/@id/__batch.tsx"></script>'});
   if(!url.pathname.startsWith('/api/')) return route.continue();
   if(request.method()!=='GET') { writes.push(request.method()+' '+url.pathname); return route.abort(); }
   const json=body=>route.fulfill({json:body});
   if(url.pathname==='/api/hub/v1/connections') return json({connections:[{id:'local',label:'Synthetic Connector'}]});
   if(url.pathname.endsWith('/files/roots')) return json({roots:[{agentId:'codex',label:'Safe workspace'}]});
   if(url.pathname.includes('/files/agents/codex')) {
     const source=url.searchParams.get('sourcePath');
     if(source) { sourceQueries.push(source); if(failSource) return route.fulfill({status:403,json:{error:'Source directory denied'}}); }
     const path=source ? (source.includes('/next/')?'next':'src') : url.searchParams.get('path')||'';
     return json({root:'Safe workspace',path,entries:[{name:'manual',path:'manual',kind:'directory'}, {name:'example.ts',path:path+'/example.ts',kind:'file',canPreview:true}]});
   }
   if(url.pathname.includes('/commands/')) {
     const command=decodeURIComponent(url.pathname.split('/').at(-1)); receiptQueries.push(command);
     return json({command:{key:command,state:confirmed?'accepted':'outcome_unknown',...(confirmed?{result:{status:200,body:{status:command==='stop-original'?'stopped':'queued'}}}:{})}});
   }
   if(url.pathname.endsWith('/messages')) return json({messages:[{id:cached?'saved':'fresh',sessionKey:key,role:'assistant',text:cached?'Saved recent reply':'Latest verified reply',createdAt:1,status:'sent'}],updatedAt:1,revision:cached?'cached:1':'fresh:2',...(cached?{historyStatus:'cached'}:{})});
   throw Error('Unmodeled GET '+url.pathname);
 });
 await page.goto(origin+'/batch-test');
 const location=page.locator('.workspace-files-path');
 await page.waitForFunction(()=>document.querySelector('.workspace-files-path')?.textContent==='src').catch(async error => { console.error(await page.locator('body').innerText(),sourceQueries); throw error; });
 assert.equal(sourceQueries.length,1);
 await page.locator('#file-picker').getByRole('button',{name:'manual',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('.workspace-files-path')?.textContent==='manual');
 await page.evaluate(()=>window.harness.changeFile('/safe/next/later.ts'));
 await page.getByRole('button',{name:'Open session’s latest changed directory',exact:true}).waitFor();
 assert.equal(await location.textContent(),'manual'); assert.equal(sourceQueries.length,1,'new messages cannot drive browsing');
 await page.getByRole('button',{name:'Open session’s latest changed directory',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('.workspace-files-path')?.textContent==='next');
 assert.equal(sourceQueries.length,2);
 await page.evaluate(()=>window.harness.relink(false));
 await page.getByRole('button',{name:'Open session’s latest changed directory',exact:true}).waitFor({state:'detached'});
 await page.evaluate(()=>window.harness.relink(true));
 await page.waitForFunction(()=>document.querySelector('.workspace-files-path')?.textContent==='next');
 await page.waitForFunction(()=>window.harness && document.querySelector('#receipts')?.textContent.includes('Delivery'));
 assert.equal(sourceQueries.length,3,'unlink/relink performs a new single authorized lookup');
 await page.evaluate(()=>window.harness.refresh());
 assert.equal(await page.locator('#history').getAttribute('data-cached'),'true');
 assert.equal(await page.locator('#history').textContent(),'Saved recent reply');
 assert.equal(await page.evaluate(()=>window.harness.cachedNavigation()),undefined,'saved history cannot seed validated navigation cache');
 cached=false; await page.evaluate(()=>window.harness.refresh());
 assert.equal(await page.locator('#history').getAttribute('data-cached'),'false');
 assert.equal(await page.locator('#history').textContent(),'Latest verified reply');
 confirmed=true;
 await page.evaluate(()=>window.dispatchEvent(new Event('online')));
 await page.waitForFunction(()=>window.harness.journal().length===0);
 await page.waitForFunction(()=>document.querySelector('#receipts')?.textContent==='');
 assert.ok(Number(await page.locator('#recovered').textContent())>0);
 assert.ok(receiptQueries.includes('stop-original')&&receiptQueries.includes('legacy-original'));
 failSource=true;
 await page.getByRole('button',{name:'Open session’s latest changed directory',exact:true}).click();
 await page.getByRole('alert').waitFor();
 failSource=false;
 await page.getByRole('button',{name:'Open session’s latest changed directory',exact:true}).click();
 await page.getByRole('alert').waitFor({state:'detached'});
 await page.evaluate(()=>window.harness.switchAccount());
 await page.waitForFunction(()=>document.querySelector('.workspace-files-path')?.textContent==='/');
 assert.deepEqual(writes,[]); assert.deepEqual(errors,[]);
 console.log(JSON.stringify({passed:true,directoryOnceManualRelinkRetry:true,cachedReadThenVerified:true,lateStopAndLegacyReceiptRetired:true,noResend:true,accountCleanup:true,sourceQueries:sourceQueries.length,receiptQueries:receiptQueries.length}));
} finally { await browser?.close(); await server.close(); }
