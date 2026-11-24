import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
const { chromium } = await import(process.env.AOD_TEST_PLAYWRIGHT ? pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href : 'playwright');
const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, envFile: false,
  plugins: [react()], logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true }); const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 900 } });
  await context.addInitScript(() => localStorage.setItem('agentopsdeck.locale', 'en'));
  let config, receipt, sends = 0, previews = 0, dropPreview = true, dropSubmit = true, absent = false; const tombstones = new Set(), errors = [];
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url()); assert.equal(url.origin, origin);
    if (!url.pathname.startsWith('/api/')) return route.continue();
    assert.ok(url.pathname.startsWith('/api/hub/v1/sessions/'));
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname.endsWith('/guidance')) {
      if (req.method() === 'PUT') { const v = req.postDataJSON(); assert.equal(v.revision, config?.revision ?? 0); config = { ...v, revision: v.revision + 1, hash: createHash('sha256').update(v.text).digest('hex') }; }
      return json({ guidance: config ? { config, state: 'unknown' } : null, contextVerification: 'unsupported' });
    }
    if (url.pathname.endsWith('/submissions')) {
      previews++; const {requestId, revision, input} = req.postDataJSON(); assert.equal(revision, config.revision);
      if (absent) { receipt = undefined; return route.abort(); }
      receipt = { requestId, revision, text: input ? `${config.text}\n\n${input}` : config.text, hash: config.hash, state: 'prepared', queueReceipt: null, contextEpoch: null, createdAt: Date.now(), expiresAt: Date.now() + 300000 };
      if (dropPreview) { dropPreview = false; return route.abort(); } return json({ receipt });
    }
    const id = url.pathname.split('/').at(req.method() === 'POST' ? -2 : -1);
    if (req.method() === 'DELETE') { assert.ok(!receipt || receipt.state === 'prepared'); tombstones.add(id); return json({receipt:null,cancelled:true,requestId:id}); }
    if (tombstones.has(id)) return json({receipt:null,cancelled:true,requestId:id});
    if (!receipt) return json({error:'not found'},404);
    assert.equal(receipt.requestId, id);
    if (req.method() === 'POST') { sends++; assert.deepEqual(req.postDataJSON(), {}); receipt.state = 'submitted'; receipt.queueReceipt = 'native-queue-receipt'; if (dropSubmit) { dropSubmit = false; return route.abort(); } }
    return json({ receipt });
  });
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  const open = async () => { await page.goto(`${origin}/tests/fixtures/session-guidance.html`); await page.getByRole('button', {name:'Open guidance',exact:true}).click(); await page.getByRole('button',{name:'Reload guidance settings'}).waitFor(); };
  await open(); await page.getByLabel('Guidance text').fill('Fixture guidance, keep it private.'); await page.getByLabel('Enable manual guidance submission').check();
  await page.getByLabel('Next message with guidance (optional)').fill('Private next message.');
  await page.getByRole('button',{name:'Save guidance only'}).click(); await page.getByRole('button',{name:'Preview guidance message'}).click(); await page.getByRole('alert').waitFor(); assert.equal(sends,0);
  assert.equal(await page.evaluate(() => Object.values(sessionStorage).some(v => v.includes('Fixture guidance'))), false);
  await open(); assert.equal(await page.locator('pre').innerText(),'Fixture guidance, keep it private.\n\nPrivate next message.');
  await page.getByRole('button',{name:'Confirm sending guidance once'}).click(); await page.getByRole('alert').waitFor(); assert.equal(sends,1);
  assert.equal(await page.getByRole('button',{name:'Confirm sending guidance once'}).count(),0);
  await open(); await page.getByText('Guidance accepted by queue; context unverified',{exact:true}).waitFor(); assert.equal(sends,1); assert.equal(previews,1);
  await page.getByRole('button',{name:'Dismiss resolved guidance receipt'}).click();
  absent = true; await page.getByRole('button',{name:'Preview guidance message'}).click(); await page.getByRole('alert').waitFor();
  await open(); await page.getByRole('alert').waitFor(); await page.getByRole('button',{name:'Cancel unsent guidance preview'}).click();
  await page.getByRole('button',{name:'Preview guidance message'}).waitFor(); assert.equal(tombstones.size,1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true);
  await page.getByRole('button',{name:'Close',exact:true}).click(); assert.equal(await page.evaluate(()=>document.activeElement?.textContent),'Open guidance');
  await page.getByRole('button',{name:'Open guidance',exact:true}).click(); await page.evaluate(()=>document.querySelectorAll('button')[1].click()); await page.getByRole('dialog').waitFor({state:'hidden'});
  assert.deepEqual(errors,[]); console.log(JSON.stringify({verified:true,strictMode:true,viewport:390,sends,previews,absentPreviewCancellation:true,reloadReadOnly:true,accountFence:true}));
} finally { await browser?.close(); await server.close(); }
