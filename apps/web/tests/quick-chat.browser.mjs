import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { QuickChatStore } from '../../server/src/hub/quick-chat-store.ts';
import { QuickChatService } from '../../server/src/hub/quick-chat-service.ts';
import { registerHubQuickChat } from '../../server/src/routes/hub-quick-chat.ts';
const require = createRequire(new URL('../../server/package.json', import.meta.url));
const { Hono } = require('hono');
const { chromium } = await import(process.env.AOD_TEST_PLAYWRIGHT ? pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href : 'playwright');
const answer = 'PRIVATE_ANSWER\n\n<script>alert("PRIVATE_HTML")</script>';
const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, envFile: false,
  plugins: [react()], logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
  for (const width of [1440, 390, 320]) {
    const db = new DatabaseSync(':memory:'); let calls = 0, catalogReads = 0, lostProfile = true, lostAck = true, unknown = false; const sentModels = [];
    let fixtureNow = Date.now();
    const store = new QuickChatStore(db, () => fixtureNow, Buffer.alloc(32, 1));
    const service = new QuickChatService(store, { url: 'https://synthetic.invalid/responses', model: 'fixture', token: 'synthetic', users: ['alice'] }, async (url, init) => {
      if (init.method === 'GET') { catalogReads++; assert.equal(String(url), 'https://synthetic.invalid/models'); return Response.json({ data: [{ id: 'fixture' }, { id: 'sol' }, { id: 'luna' }] }); }
      calls++; const body = JSON.parse(init.body);
      sentModels.push(body.model);
      if (calls === 3) assert.deepEqual(body.input, [{ role: 'user', content: 'Fresh question' }, { role: 'assistant', content: answer }, { role: 'user', content: 'Follow up' }], 'follow-up carries this temporary conversation only');
      assert.deepEqual(Object.keys(body).sort(), ['input', 'max_output_tokens', 'model', 'store', 'stream', 'tools']);
      assert.equal(body.store, false); assert.deepEqual(body.tools, []);
      if (unknown) throw Error('Synthetic lost provider response');
      return Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: answer }] }] });
    }, 45000, { discoverModels: true, defaultModel: 'sol' });
    const app = new Hono(); registerHubQuickChat(app, { service, principal: () => ({ userId: 'alice', admin: false }) });
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    await context.addInitScript(() => localStorage.setItem('agentopsdeck.locale', 'en'));
    try {
      const methods = [], errors = [];
      await context.route('**/*', async route => {
        const req = route.request(), url = new URL(req.url()); assert.equal(url.origin, origin);
        if (!url.pathname.startsWith('/api/')) return route.continue();
        assert.ok(url.pathname.startsWith('/api/hub/v1/quick-chat'), 'no session/context/model discovery calls');
        methods.push(req.method());
        const response = await app.request(url.pathname, { method: req.method(), headers: { 'Content-Type': 'application/json' }, ...(req.postData() ? { body: req.postData() } : {}) });
        if (req.method() === 'PUT' && lostProfile) { lostProfile = false; return route.abort(); }
        if (req.method() === 'POST' && lostAck) { lostAck = false; return route.abort(); }
        await route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() });
      });
      const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
      await page.goto(`${origin}/tests/fixtures/quick-chat.html`);
      let dialog = page.getByRole('dialog');
      await page.waitForFunction(() => document.querySelector('select[aria-label="Model"]')?.value === 'sol'); assert.equal(calls, 0);
      assert.equal(await dialog.getByLabel('Model', { exact: true }).inputValue(), 'sol', 'gateway model selector prefers the available configured Codex default');
      assert.equal(await dialog.getByLabel('Name', { exact: true }).count(), 0, 'configuration is secondary to conversation');
      await dialog.getByRole('button', { name: 'Model and profiles', exact: true }).click();
      await dialog.getByRole('region', { name: 'Model and profiles' }).waitFor();
      await dialog.getByRole('button', { name: 'Save profile', exact: true }).click();
      await dialog.getByRole('alert').waitFor(); assert.equal(store.profiles('alice').length, 1);
      await page.reload(); dialog = page.getByRole('dialog');
      await dialog.getByLabel('Question', { exact: true }).fill('PRIVATE_QUESTION');
      assert.equal(await dialog.getByRole('checkbox').count(), 0, 'Send is the explicit action; no redundant confirmation');
      await dialog.getByRole('button', { name: 'Send', exact: true }).click();
      await dialog.getByRole('alert').waitFor(); assert.equal(calls, 1);
      await page.reload(); dialog = page.getByRole('dialog');
      await dialog.getByText('PRIVATE_ANSWER', { exact: true }).waitFor(); assert.equal(calls, 1);
      assert.equal(await dialog.locator('script').count(), 0);
      assert.ok(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'narrow dialog does not overflow');
      const storage = await page.evaluate(() => JSON.stringify([Object.entries(sessionStorage), Object.entries(localStorage)]));
      assert.equal(/PRIVATE_QUESTION|PRIVATE_ANSWER/.test(storage), false);
      await dialog.getByLabel('Question', { exact: true }).fill('Fresh question');
      await dialog.getByRole('button', { name: 'Send', exact: true }).click();
      await page.waitForFunction(() => document.querySelectorAll('.quick-chat-turn').length === 2 && !document.querySelector('.quick-chat-composer textarea')?.disabled).catch(async error => { console.error({ calls, methods, errors, text: await dialog.innerText() }); throw error; });
      await dialog.getByLabel('Question', { exact: true }).fill('Follow up');
      await dialog.getByRole('button', { name: 'Send', exact: true }).click();
      await page.waitForFunction(() => document.querySelectorAll('.quick-chat-turn').length === 3 && !document.querySelector('.quick-chat-composer textarea')?.disabled);
      assert.equal(calls, 3); assert.equal(await dialog.locator('.is-user').count(), 2);
      assert.equal(await dialog.getByRole('button', { name: 'New question', exact: true }).count(), 0, 'continuation needs no reset action');
      await dialog.getByRole('button', { name: 'New temporary chat', exact: true }).click();
      assert.equal(await dialog.locator('.quick-chat-turn').count(), 0);
      await dialog.getByRole('button', { name: 'Model and profiles', exact: true }).click();
      await dialog.getByText('Recent quick requests', { exact: true }).click();
      await dialog.getByRole('button', { name: 'Temporary · completed', exact: true }).first().click();
      await dialog.getByText('PRIVATE_ANSWER', { exact: true }).waitFor();
      await dialog.getByRole('button', { name: 'Clear private result' }).click();
      await dialog.getByText('Result cleared or expired.', { exact: true }).waitFor();
      await dialog.getByRole('button', { name: 'New temporary chat', exact: true }).click(); unknown = true;
      fixtureNow += 61_000; // Fourth synthetic send is in the next rate-limit window.
      await dialog.getByLabel('Model', { exact: true }).selectOption('luna');
      await dialog.getByLabel('Question', { exact: true }).fill('Next');
      assert.equal(await dialog.getByRole('button', { name: 'Send', exact: true }).isEnabled(), true);
      await dialog.getByRole('button', { name: 'Send', exact: true }).click();
      await dialog.locator('.quick-chat-recovery').waitFor();
      assert.equal(store.profiles('alice').length, 1, 'sending with a model change saves the existing profile, no extra confirmation');
      assert.equal(store.profiles('alice')[0].model, 'luna'); assert.equal(store.profiles('alice')[0].revision, 2);
      await dialog.locator('.quick-chat-recovery').getByRole('button', { name: 'Check original receipt' }).click();
      assert.equal(calls, 4, JSON.stringify({ methods, sentModels, text: await dialog.innerText() })); assert.equal(await dialog.getByRole('button', { name: 'New temporary chat' }).isDisabled(), true);
      await page.evaluate(() => window.dispatchEvent(new Event('agentopsdeck:auth-required')));
      await page.waitForFunction(() => !document.querySelector('dialog'));
      assert.equal(methods.filter(m => m === 'PUT').length, 2); assert.equal(methods.filter(m => m === 'POST').length, 4);
      assert.deepEqual(sentModels, ['sol', 'sol', 'sol', 'luna']); assert.ok(catalogReads >= 1);
      assert.equal(await page.locator('body').evaluate(el => el.scrollWidth <= innerWidth), true, 'no narrow-screen overflow');
      assert.deepEqual(errors, []); console.log(`PASS quick-chat ${width}: real routes/DB, lost profile+send ACK, GET-only reload, unknown/no replay, clear, auth fence`);
    } finally { await context.close(); service.close(); db.close(); }
  }
} finally { await browser?.close(); await server.close(); }
