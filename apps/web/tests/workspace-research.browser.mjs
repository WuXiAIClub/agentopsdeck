import { resourceCaption } from './resource-caption.mjs';
// Isolated real HTTP search provider + Hub + built browser assets. Synthetic
// credentials only; no production data, real external search or model calls.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createHttpServer } from 'node:http';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { HubStore } from '../../server/src/hub/hub-store.ts';
import { loadConfig } from '../../server/src/config.ts';
import { registerHubRoutes } from '../../server/src/routes/hub.ts';
import { DEFAULT_HUB_NOTEBOOK_LAYOUT } from '../../../packages/shared/src/session-notebook.ts';
import { prependNotebookReading } from '../src/lib/session-notebook.ts';
const require = createRequire(new URL('../../server/package.json', import.meta.url));
const { Hono } = require('hono'), { serve } = require('@hono/node-server');
const { serveStatic } = require('@hono/node-server/serve-static');
const { chromium } = await import(pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href);
const directory = await mkdtemp(join(tmpdir(), 'agentopsdeck-research-browser-'));
let slow = false, empty = false, providerReads = 0, providerCloses = 0, configReads = 0, allowed = true;
const testSynthesis = process.env.AOD_TEST_RESEARCH_AI === 'true';
const testAutomatic = testSynthesis && process.env.AOD_TEST_RESEARCH_AUTOMATIC_ONLY === 'true';
const testReader = process.env.AOD_TEST_RESEARCH_READER === 'true';
const testTavily = process.env.AOD_TEST_RESEARCH_PROVIDER === 'tavily';
let readerReads = 0, readerCloses = 0, readerMode = 'valid';
let aiMode = 'valid', aiReads = 0, aiCloses = 0, expectedModel = 'fixture-model', catalogReads = 0;
const errors = [], forbidden = [], chunks = [];
const site = createHttpServer(async (req, res) => {
  if (req.url === '/models') {
    catalogReads++; assert.equal(req.method, 'GET'); assert.equal(req.headers.authorization, 'Bearer synthetic-model-only');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'fixture-model' }, { id: 'fixture-sol' }, { id: 'fixture-luna' }] })); return;
  }
  if (req.url === '/extract') {
    readerReads++; assert.equal(req.method, 'POST'); assert.equal(req.headers.authorization, 'Bearer synthetic-reader-only'); assert.equal(req.headers.cookie, undefined);
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); assert.equal(body.redirects, false); assert.equal(body.format, 'text'); assert.equal(body.maxCharacters, 80_000);
    assert.ok(!raw.includes('Synthetic private query')); assert.ok(!raw.includes('never-forward'));
    assert.equal(body.url, `https://source.example/${readerReads === 1 ? '1' : '2'}`);
    if (readerMode === 'slow') { res.once('close', () => readerCloses++); res.writeHead(200, { 'content-type': 'application/json' }); res.write('{'); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ url: body.url,
      text: 'Full source text. <img src="https://forbidden.example/article">\n' + 'Article paragraph. '.repeat(300), truncated: false })); return;
  }
  if (req.url === '/responses') {
    aiReads++;
    assert.equal(req.method, 'POST'); assert.equal(req.headers.authorization, 'Bearer synthetic-model-only'); assert.equal(req.headers.cookie, undefined);
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw), input = JSON.parse(body.input[0].content);
    assert.equal(body.model, expectedModel); assert.equal(body.store, false); assert.equal(body.stream, false);
    assert.deepEqual(body.tools, []); assert.equal(body.max_output_tokens, 2000);
    assert.deepEqual(input.sources.map(source => source.id), testAutomatic || aiReads === 1 ? ['S1','S2','S3','S4','S5','S6','S7','S8'] : ['S1', 'S2']); assert.equal(input.query, 'Synthetic private query');
    assert.ok(!raw.includes('https://source.example')); assert.ok(!raw.includes('never-forward'));
    if (aiMode === 'slow') { res.once('close', () => aiCloses++); res.writeHead(200, { 'content-type': 'application/json' }); res.write('{'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text',
      text: JSON.stringify({ paragraphs: [{ text: 'A bounded synthesis. <img src="https://forbidden.example/ai">', citations: [aiMode === 'invalid' ? 'S9' : 'S1', 'S2'] }], caveat: 'Only search snippets, not verified articles.' }) }] }] })); return;
  }
  providerReads++;
  assert.equal(req.method, 'POST'); assert.equal(req.url, '/search'); assert.equal(req.headers.authorization, 'Bearer synthetic-only'); assert.equal(req.headers.cookie, undefined);
  let body = ''; for await (const chunk of req) body += chunk;
  if (testTavily) {
    assert.equal(req.headers['content-type'], 'application/json');
    const query = JSON.parse(body);
    assert.equal(typeof query.query, 'string'); assert.equal(query.max_results, 8);
    assert.equal(query.search_depth, 'basic'); assert.equal(query.auto_parameters, false);
    assert.equal(query.include_answer, false); assert.equal(query.include_raw_content, false); assert.equal(query.include_images, false);
    assert.ok(!body.includes('synthetic-only'));
  } else {
    const query = new URLSearchParams(body); assert.equal(query.get('format'), 'json'); assert.equal(query.get('pageno'), '1');
  }
  if (slow) { res.once('close', () => providerCloses++); res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"results":['); return; }
  res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'provider-secret=not-forwarded' });
  res.end(JSON.stringify({ results: empty ? [] : [{ title: 'Unsafe', url: 'javascript:alert(1)' }, ...Array.from({ length: 20 }, (_, i) => ({
    title: `<b>Source ${i + 1}</b>`, url: `https://source.example/${i + 1}`, content: `Search evidence ${i + 1}. <img src="https://forbidden.example/track">` + 'Readable excerpt. '.repeat(35), private: 'never-forward' }))] }));
});
site.listen(0, '127.0.0.1'); await once(site, 'listening');
const hub = new HubStore(join(directory, 'hub.sqlite'), 'synthetic');
const notebookId = '00000000-0000-4000-8000-000000000101', originalNote = '# Existing notes\n\nPreserve this.\n';
if (testSynthesis) {
  hub.notebooks.save('default', { resourceId: JSON.stringify(['hub-notebook-layout', 1, notebookId]), revision: 0,
    text: JSON.stringify({ ...DEFAULT_HUB_NOTEBOOK_LAYOUT, title: 'Synthesis notebook' }) });
  hub.notebooks.save('default', { resourceId: JSON.stringify(['hub-notebook', 1, notebookId]), revision: 0, text: originalNote });
}
let principal = { userId: 'default', admin: true };
const app = new Hono();
app.use('*', async (c, next) => { if (c.req.path.endsWith('/research/config')) configReads++; await next(); });
const routes = registerHubRoutes(app, { config: loadConfig({ HOME: directory, AOD_SERVER_ROLE: 'hub', AOD_RESEARCH_ENABLED: 'true',
  ...(testTavily ? { AOD_RESEARCH_PROVIDER: 'tavily' } : {}),
  AOD_RESEARCH_SEARCH_URL: `http://127.0.0.1:${site.address().port}/search`, AOD_RESEARCH_ALLOW_HTTP: 'true',
  AOD_RESEARCH_USERS: 'default', AOD_RESEARCH_SEARCH_TOKEN: 'synthetic-only',
  ...(testReader ? { AOD_RESEARCH_READER_ENABLED: 'true', AOD_RESEARCH_READER_URL: `http://127.0.0.1:${site.address().port}/extract`,
    AOD_RESEARCH_READER_ALLOW_HTTP: 'true', AOD_RESEARCH_READER_USERS: 'default', AOD_RESEARCH_READER_TOKEN: 'synthetic-reader-only',
    AOD_RESEARCH_READER_SOURCE_ORIGINS: '["https://source.example"]' } : {}),
  ...(testSynthesis ? { AOD_RESEARCH_AI_ENABLED: 'true', AOD_RESEARCH_AI_RESPONSES_URL: `http://127.0.0.1:${site.address().port}/responses`,
    AOD_RESEARCH_AI_ALLOW_HTTP: 'true', AOD_RESEARCH_AI_USERS: 'default', AOD_RESEARCH_AI_MODEL: 'fixture-model', AOD_RESEARCH_AI_TOKEN: 'synthetic-model-only' } : {}) }), hubStore: hub,
  principal: () => allowed ? principal : undefined, normalizeError: () => 'Synthetic',
  fileCardClient: () => { throw Error('No Connector file effects allowed'); },
  connectorClient: () => { throw Error('No Connector reads allowed'); } });
// Serve the actual assets on the Hub origin, as production does. A dev proxy
// can retain upstream requests after the browser disconnects and would test
// the proxy's cancellation behavior rather than the Hub's.
app.use('/*', serveStatic({ root: 'apps/web/dist' }));
const hubServer = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
if (!hubServer.listening) await once(hubServer, 'listening');
let browser;
const until = async check => { for (let i = 0; i < 100 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 25)); assert.ok(check()); };
try {
  const origin = `http://127.0.0.1:${hubServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.AOD_TEST_CHROMIUM });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  await context.addInitScript(() => {
    localStorage.setItem('agentopsdeck.locale', 'en');
    window.EventSource = class extends EventTarget { readyState = 1; static OPEN = 1; constructor() { super(); queueMicrotask(() => this.onopen?.(new Event('open'))); } close() { this.readyState = 2; } };
  });
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin !== origin) { forbidden.push(req.url()); return route.abort(); }
    if (url.pathname.includes('/assets/')) chunks.push(url.pathname);
    if (!url.pathname.startsWith('/api/') || url.pathname.startsWith('/api/hub/v1/workspace/research')) return route.continue();
    const json = body => route.fulfill({ json: body });
    // Configuration panes verify native/shared ownership before rendering.
    // Exercise the real isolated Hub overview, never fabricate ownership or
    // allow shared-content writes/Connector file operations in this fixture.
    if (req.method() === 'GET' && /^\/api\/hub\/v1\/workspace\/shared-content\/[^/]+$/.test(url.pathname)) return route.continue();
    if (url.pathname.startsWith('/api/hub/v1/workspace/layouts/') || url.pathname === '/api/hub/v1/workspace/preferences' || url.pathname.startsWith('/api/hub/v1/notebooks')) {
      const response = await app.request(url.pathname, { method: req.method(), headers: req.headers(), ...(req.postData() ? { body: req.postData() } : {}) });
      return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
    }
    // Layout unread indicators use a read-only POST projection, not message dispatch.
    if (url.pathname === '/api/hub/v1/completions/summary' && req.method() === 'POST') {
      const body = req.postDataJSON();
      assert.deepEqual(Object.keys(body), ['sessions']);
      assert.ok(testSynthesis && body.sessions.every(key => key === 'local:synthesis'));
      return json({ items: [] });
    }
    if (req.method() !== 'GET') { forbidden.push(`${req.method()} ${url.pathname}`); return route.abort(); }
    if (url.pathname === '/api/auth/status') return json({ authenticated: allowed, recoveryScope: hub.identities.recoveryScope(principal), passkeys: { available: false, count: 0 } });
    if (url.pathname.endsWith('/sessions/state')) return json({ revision: '1', groups: testSynthesis ? [{ agentId: 'codex', sessions: [{ sessionKey: 'local:synthesis',
      envConnectionId: 'local', source: 'codex', agentId: 'codex', title: 'Synthesis target', status: 'idle', hasActiveRun: false }] }] : [] });
    if (url.pathname.endsWith('/messages')) { if (!testSynthesis) forbidden.push('message read'); return json({ limits: { maxMessageChars: 100000 }, revision: '1', totalCount: 0, hiddenCount: 0, messages: [] }); }
    if (url.pathname.endsWith('/queue')) return json({ items: [], nextCursor: null });
    if (url.pathname === '/api/agents') return json({ agents: testSynthesis ? [{ id: 'codex', name: 'Codex' }] : [] });
    if (url.pathname === '/api/gateway/status') return json({ connected: true });
    if (url.pathname === '/api/hub/v1/connections') return json({ connections: [] });
    return route.fulfill({ status: 404, json: {} });
  });
  const page = await context.newPage(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
  const configResponses=[];
  page.on('response',response=>{
    if(new URL(response.url()).pathname.endsWith('/research/config')){
      void response.json().then(body=>configResponses.push({status:response.status(),body}),()=>configResponses.push({status:response.status(),invalidJson:true}));
    }
  });
  page.on('dialog', dialog => { forbidden.push('unexpected dialog'); void dialog.dismiss(); });
  await page.goto(origin); await page.getByLabel('Layout presets', { exact: true }).waitFor();
  assert.equal(chunks.some(chunk => chunk.includes('WorkspaceResearch')), false);
  const open = async () => { await page.getByLabel('Layout presets', { exact: true }).click(); await page.getByRole('button', { name: 'Search and sources · Preview', exact: true }).click(); };
  await open();
  const panel = page.getByRole('region', { name: 'Search and sources · Preview', exact: true });
  const pane = panel.locator('xpath=ancestor::*[@data-workspace-pane][1]');
  const query = panel.getByRole('textbox', { name: 'Search query', exact: true });
  try { await query.waitFor(); }
  catch (error) {
    console.error(JSON.stringify({ configReads, configResponses, panel: await panel.count() ? await panel.innerText() : null,
      body: (await page.locator('body').innerText()).slice(0, 6000), errors, forbidden, chunks }));
    throw error;
  }
  assert.equal(providerReads, 0); assert.equal(configReads, 1);
  if (testSynthesis) {
    await panel.getByRole('combobox', { name: 'Model', exact: true }).selectOption('fixture-sol');
    expectedModel = 'fixture-sol';
    assert.ok(catalogReads >= 1); assert.equal(aiReads, 0, 'model selection does not run inference');
    assert.equal(await panel.locator('.workspace-research-privacy[open]').count(), 0);
    assert.equal(await panel.getByText('Answer settings', { exact: false }).count(), 0);
    const originalPaneWidth = await pane.evaluate(el => el.style.width);
    for (const width of [390, 320]) {
      await pane.evaluate((el, w) => { el.style.width = `${w}px`; }, width);
      assert.ok(await panel.evaluate(el => el.scrollWidth <= el.clientWidth), `compact model toolbar fits ${width}px`);
    }
    await pane.evaluate((el, width) => { el.style.width = width; }, originalPaneWidth);
  }
  if (testAutomatic) {
    const search = panel.getByRole('button', { name: 'Search and answer', exact: true });
    const answer = panel.getByLabel('AI synthesis result', { exact: true });
    const retry = panel.getByRole('button', { name: 'Generate answer', exact: true });
    await query.fill('Synthetic private query');
    aiMode = 'invalid'; await search.click();
    await panel.getByText('Answer failed. Retry with existing sources below.', { exact: true }).waitFor();
    assert.equal(providerReads, 1); assert.equal(aiReads, 1); assert.equal(await panel.locator('article').count(), 8);
    assert.equal(await answer.count(), 0);
    aiMode = 'valid'; await retry.click(); await answer.waitFor();
    assert.equal(providerReads, 1); assert.equal(aiReads, 2, 'retry does not search or ask for source selection');
    aiMode = 'slow'; await search.click(); await until(() => aiReads === 3);
    assert.equal(await answer.count(), 0, 'new search clears the previous answer');
    await panel.getByRole('button', { name: 'Cancel synthesis', exact: true }).click();
    await until(() => aiCloses === 1);
    assert.equal(await panel.locator('article').count(), 8);
    await page.waitForTimeout(300); assert.equal(aiReads, 3); assert.equal(await answer.count(), 0);
    aiMode = 'valid'; await search.click();
    await panel.getByText('AI synthesis budget reached or another synthesis is active. Wait a minute before retrying.', { exact: true }).waitFor();
    assert.equal(aiReads, 3, 'Hub budget rejects the fourth automatic synthesis without provider I/O');
    assert.equal(providerReads, 3); assert.equal(await panel.locator('article').count(), 8);
    empty = true; await search.click(); await panel.getByText('No search results', { exact: true }).waitFor();
    assert.equal(providerReads, 4); assert.equal(aiReads, 3, 'empty search never calls synthesis');
    assert.equal(await retry.count(), 0); assert.equal(await answer.count(), 0);
  } else {
  await query.fill('Synthetic private query'); await page.waitForTimeout(400); assert.equal(providerReads, 0, 'typing must not dispatch');
  await panel.getByRole('button', { name: testSynthesis ? 'Search and answer' : 'Search', exact: true }).click(); await panel.getByRole('link', { name: 'Source 1', exact: true }).waitFor();
  assert.equal(await panel.locator('article').count(), 8); assert.equal(providerReads, 1);
  assert.equal(await panel.locator('script,img,iframe').count(), 0); assert.equal(await panel.getByText('never-forward').count(), 0);
  assert.equal(await panel.getByRole('link', { name: 'Source 1', exact: true }).getAttribute('rel'), 'noopener noreferrer');
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.__citation = text; } } }));
  await panel.getByRole('button', { name: 'Copy source S1', exact: true }).click();
  const citation = JSON.parse(await page.evaluate(() => window.__citation)); assert.equal(citation.kind, 'search-snippet'); assert.equal(citation.source.url, 'https://source.example/1');
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw Error('Denied'); } } }));
  await panel.getByRole('button', { name: 'Copy source S2', exact: true }).click();
  assert.ok((await panel.getByRole('textbox', { name: 'Source text for manual copy' }).inputValue()).includes('https://source.example/2'));
  await panel.getByRole('button', { name: 'Close', exact: true }).click();
  if (testReader) {
    const openArticle = panel.getByRole('button', { name: 'Open article reader', exact: true });
    const article = panel.getByRole('region', { name: 'Article reader', exact: true });
    assert.equal(readerReads, 0); await openArticle.nth(0).click(); await article.waitFor(); assert.equal(readerReads, 0);
    await article.getByRole('button', { name: 'Read this article', exact: true }).click();
    await article.getByText('Extracted article · verify the original source.', { exact: false }).waitFor();
    assert.equal(readerReads, 1); assert.equal(aiReads, testSynthesis ? 1 : 0, 'explicit article reading does not dispatch another synthesis'); assert.equal(await article.locator('img,script,iframe').count(), 0);
    assert.ok((await article.getByRole('textbox', { name: 'Extracted article text', exact: true }).inputValue()).includes('<img'));
    assert.equal(await page.evaluate(() => [...Object.values(localStorage), ...Object.values(sessionStorage)].some(value => /Full source text|synthetic-reader-only/.test(value))), false);
    const width = await pane.evaluate(element => { const width = element.style.width; element.style.width = '390px'; return width; });
    await article.scrollIntoViewIfNeeded(); assert.ok(await panel.evaluate(element => element.scrollWidth <= element.clientWidth));
    await pane.evaluate((element, width) => { element.style.width = width; }, width);
    await article.getByRole('button', { name: 'Close article', exact: true }).click(); assert.equal(await article.count(), 0);
    readerMode = 'slow'; await openArticle.nth(1).click(); await article.getByRole('button', { name: 'Read this article', exact: true }).click();
    await until(() => readerReads === 2); await article.getByRole('button', { name: 'Cancel reading', exact: true }).click();
    await until(() => readerCloses === 1); await page.waitForTimeout(300); assert.equal(readerReads, 2); assert.equal(await article.count(), 0);
  } else assert.equal(await panel.getByRole('button', { name: 'Open article reader', exact: true }).count(), 0);
  if (testSynthesis) {
    const answer = panel.getByLabel('AI synthesis result', { exact: true }); await answer.waitFor();
    assert.equal(await panel.getByRole('checkbox', { name: /Select source/ }).count(), 0, 'selection is not a prerequisite');
    assert.equal(await answer.evaluate(element => !!(element.compareDocumentPosition(document.querySelector('.workspace-research-results')) & Node.DOCUMENT_POSITION_FOLLOWING)), true, 'answer precedes sources');
    const submit = panel.getByRole('button', { name: 'Generate answer', exact: true });
    assert.equal(aiReads, 1); assert.equal(await answer.locator('img').count(), 0); assert.ok((await answer.innerText()).includes('<img'));
    assert.equal(await answer.getByRole('link', { name: 'S1', exact: true }).getAttribute('href'), 'https://source.example/1');
    assert.equal(await answer.getByRole('link', { name: 'S2', exact: true }).getAttribute('href'), 'https://source.example/2');
    await answer.getByRole('button', { name: 'Copy synthesis and cited snippets', exact: true }).click();
    const exported = JSON.parse(await answer.getByRole('textbox', { name: 'Source text for manual copy', exact: true }).inputValue());
    assert.equal(exported.kind, 'search-synthesis'); assert.equal(exported.mode, 'snippets'); assert.equal(exported.summary.verified, false);
    assert.deepEqual(exported.sources.map(source => source.id), Array.from({ length: 8 }, (_, i) => `S${i + 1}`), 'retain all snippets supplied to the model, including uncited context');
    assert.deepEqual(exported.summary.paragraphs[0].citations, ['S1', 'S2']);
    assert.ok(exported.sources.every(source => source.snippet.startsWith('Search evidence')));
    assert.equal(exported.searchId, undefined); assert.equal(aiReads, 1, 'copy does not call the model again');
    await answer.getByRole('button', { name: 'Place reading in a session draft', exact: true }).click();
    const draftTransfer = answer.getByRole('region', { name: 'Place reading in a session draft', exact: true });
    assert.deepEqual(JSON.parse(await draftTransfer.getByRole('textbox').inputValue()), exported);
    assert.equal(await draftTransfer.getByRole('button', { name: 'Confirm: place in session draft' }).isDisabled(), true);
    await answer.getByRole('button', { name: 'Save reading to a notebook', exact: true }).click();
    const noteTransfer = answer.getByRole('region', { name: 'Save reading to a notebook', exact: true });
    assert.deepEqual(JSON.parse(await noteTransfer.getByRole('textbox').inputValue()), exported);
    assert.equal(await noteTransfer.getByRole('button', { name: 'Confirm: add to notebook' }).isDisabled(), true);
    for (const width of [320, 390]) {
      const previous = await pane.evaluate((element, width) => { const previous = element.style.width; element.style.width = `${width}px`; return previous; }, width);
      assert.ok(await panel.evaluate(element => element.scrollWidth <= element.clientWidth), 'combined citation transfers fit narrow cards');
      await pane.evaluate((element, previous) => { element.style.width = previous; }, previous);
    }
    // Collapse previews before the existing viewport visibility assertion.
    await answer.getByRole('button', { name: 'Close', exact: true }).click();
    await answer.getByRole('button', { name: 'Place reading in a session draft', exact: true }).click();
    await answer.getByRole('button', { name: 'Save reading to a notebook', exact: true }).click();
    assert.ok(await answer.evaluate(element => { const box = element.getBoundingClientRect(); return box.bottom <= innerHeight && box.top >= 0; }), 'completed result should be visible without taking input focus');
    await page.screenshot({ path: '/tmp/agentopsdeck-d3b2-synthesis.png' });
    const aiWidth = await pane.evaluate(element => { const width = element.style.width; element.style.width = '390px'; return width; });
    await answer.scrollIntoViewIfNeeded(); assert.ok(await panel.evaluate(element => element.scrollWidth <= element.clientWidth));
    await page.screenshot({ path: '/tmp/agentopsdeck-d3b2-synthesis-narrow.png' });
    await pane.evaluate((element, width) => { element.style.width = width; }, aiWidth);
    assert.equal(await page.evaluate(() => [...Object.values(localStorage), ...Object.values(sessionStorage)].some(value => /bounded synthesis|selected snippets|synthetic-model-only/.test(value))), false);
    // Exercise the real workspace receivers, not mocked context callbacks.
    await page.locator('[data-session-card="local:synthesis"]').click();
    const sessionPane = page.locator('[data-session-pane="local:synthesis"]');
    const editor = sessionPane.locator('.desktop-composer-textarea'); await editor.waitFor({ state: 'attached' });
    const sessionCaption = await resourceCaption(sessionPane);
    const dockSession = sessionCaption.getByRole('button', { name: 'Dock pane', exact: true });
    if (await dockSession.count()) await dockSession.click();
    await answer.getByRole('button', { name: 'Place reading in a session draft', exact: true }).click();
    const sessionTarget = draftTransfer.getByRole('combobox', { name: 'Target session', exact: true });
    const sessionOptions = await sessionTarget.locator('option').evaluateAll(nodes => nodes.filter(n => n.value).map(n => n.value));
    assert.equal(sessionOptions.length, 1); await sessionTarget.selectOption(sessionOptions[0]);
    await sessionPane.locator('.desktop-composer-dock').hover(); await editor.fill('Existing draft');
    await draftTransfer.getByRole('button', { name: 'Confirm: place in session draft', exact: true }).click();
    await draftTransfer.getByText('The target already has text or attachments. Its draft was not changed.', { exact: true }).waitFor();
    assert.equal(await editor.inputValue(), 'Existing draft'); await sessionPane.locator('.desktop-composer-dock').hover(); await editor.fill('');
    await draftTransfer.getByRole('button', { name: 'Confirm: place in session draft', exact: true }).click();
    await draftTransfer.getByText('Draft placed. Review it in the target session before sending.', { exact: true }).waitFor();
    assert.deepEqual(JSON.parse(await editor.inputValue()), exported);
    assert.equal(await draftTransfer.getByRole('button', { name: 'Confirm: place in session draft', exact: true }).isDisabled(), true);
    await sessionPane.locator('.desktop-composer-dock').hover(); await editor.fill(''); // Leave no test draft for the existing persistence assertions.
    await answer.getByRole('button', { name: 'Place reading in a session draft', exact: true }).click();
    await (await resourceCaption(sessionPane)).getByRole('button', { name: 'Close pane', exact: true }).click();
    await page.getByLabel('Layout presets', { exact: true }).click();
    await page.getByRole('button', { name: 'Open notebook: Synthesis notebook', exact: true }).click();
    const notebookPane = page.locator('[data-workspace-pane]').filter({ has: page.locator(`[data-remote-notebook="${notebookId}"]`) });
    await notebookPane.getByText('Saved to Hub', { exact: true }).waitFor();
    const notebookCaption = await resourceCaption(notebookPane.locator('.session-notebook'));
    const dockNotebook = notebookCaption.getByRole('button', { name: 'Dock pane', exact: true });
    if (await dockNotebook.count()) await dockNotebook.click();
    await answer.getByRole('button', { name: 'Save reading to a notebook', exact: true }).click();
    const notebookTarget = noteTransfer.getByRole('combobox', { name: 'Target notebook', exact: true });
    const notebookOptions = await notebookTarget.locator('option').evaluateAll(nodes => nodes.filter(n => n.value).map(n => n.value));
    assert.equal(notebookOptions.length, 1); await notebookTarget.selectOption(notebookOptions[0]);
    const noteText = await noteTransfer.getByRole('textbox').inputValue();
    assert.equal(hub.notebooks.get('default', JSON.stringify(['hub-notebook', 1, notebookId])).text, originalNote);
    await noteTransfer.getByRole('button', { name: 'Confirm: add to notebook', exact: true }).click();
    await noteTransfer.getByText('Added to the notebook draft. Check its save status before closing.', { exact: true }).waitFor();
    await until(() => hub.notebooks.get('default', JSON.stringify(['hub-notebook', 1, notebookId])).text === prependNotebookReading(originalNote, noteText));
    await notebookPane.getByText('Saved to Hub', { exact: true }).waitFor();
    assert.equal(aiReads, 1, 'explicit transfers never dispatch another AI request');
    await answer.getByRole('button', { name: 'Save reading to a notebook', exact: true }).click();
    await (await resourceCaption(notebookPane.locator('.session-notebook'))).getByRole('button', { name: 'Close pane', exact: true }).click();
    await panel.getByRole('button', { name: 'Adjust sources', exact: true }).click();
    for (const id of ['S3','S4','S5','S6','S7','S8']) await panel.getByRole('checkbox', { name: `Select source ${id}`, exact: true }).uncheck();
    aiMode = 'invalid'; await submit.click();
    await panel.getByText('AI synthesis unavailable or sources expired. Check access, search again and retry manually. No automatic retry.', { exact: true }).waitFor();
    assert.equal(await answer.count(), 0); assert.equal(aiReads, 2);
    assert.equal(providerReads, 1, 'retry reuses sources without another search');
    aiMode = 'slow'; await submit.click(); await until(() => aiReads === 3);
    assert.equal(await query.isEnabled(), false); await panel.getByRole('button', { name: 'Cancel synthesis', exact: true }).click(); await until(() => aiCloses === 1);
    await panel.getByText('AI synthesis cancelled. Provider processing may still incur usage. No automatic retry.', { exact: true }).waitFor();
    await page.waitForTimeout(300); assert.equal(aiReads, 3); assert.equal(await submit.isEnabled(), true); assert.equal(await answer.count(), 0);
    await panel.getByRole('checkbox', { name: 'Auto answer', exact: true }).uncheck();
  }
  // New cards start floating; first normalize to docked before a round trip.
  if (await pane.getAttribute('data-floating') === 'true') {
    await (await resourceCaption(panel)).getByRole('button', { name: 'Dock pane', exact: true }).click();
  }
  await (await resourceCaption(panel)).getByRole('button', { name: 'Float pane', exact: true }).click();
  await (await resourceCaption(panel)).getByRole('button', { name: 'Dock pane', exact: true }).click();
  assert.equal(await pane.getAttribute('data-floating'), 'false', 'real caption controls complete the dock/float round trip');
  await page.waitForTimeout(1200); assert.equal(configReads, 1); assert.equal(providerReads, 1, 'no polling or remount read');
  const fontBefore = await panel.locator('article p').first().evaluate(element => parseFloat(getComputedStyle(element).fontSize));
  await page.evaluate(() => document.documentElement.style.setProperty('--agentopsdeck-chat-font-scale', '1.1'));
  const fontAfter = await panel.locator('article p').first().evaluate(element => parseFloat(getComputedStyle(element).fontSize));
  assert.ok(fontAfter > fontBefore, 'source snippets follow chat font scale');
  await page.evaluate(() => document.documentElement.style.removeProperty('--agentopsdeck-chat-font-scale'));
  await page.screenshot({ path: '/tmp/agentopsdeck-d3b-research.png' });
  const originalWidth = await pane.evaluate(element => { const width = element.style.width; element.style.width = '390px'; return width; });
  assert.ok(await panel.evaluate(element => element.scrollWidth <= element.clientWidth));
  await page.screenshot({ path: '/tmp/agentopsdeck-d3b-research-narrow.png' });
  await pane.evaluate((element, width) => { element.style.width = width; }, originalWidth);
  assert.equal(await page.evaluate(() => [...Object.values(localStorage), ...Object.values(sessionStorage)].some(value => /Synthetic private query|Search evidence|synthetic-only/.test(value))), false);
  const layout = hub.layouts.get('default', 'current').content; assert.ok(!layout?.includes('Synthetic private query'));
  slow = true; await query.fill('Slow search'); await panel.getByRole('button', { name: 'Search', exact: true }).click(); await until(() => providerReads === 2);
  await panel.getByRole('button', { name: 'Cancel search', exact: true }).click(); await until(() => providerCloses === 1);
  await panel.getByText('Search cancelled. No automatic retry.', { exact: true }).waitFor(); assert.equal(await panel.locator('article').count(), 0);
  await page.waitForTimeout(300); assert.equal(providerReads, 2, 'cancel must not become a submit when the button changes');
  slow = false; await query.fill('Second search'); await panel.getByRole('button', { name: 'Search', exact: true }).click(); await panel.getByRole('link', { name: 'Source 1', exact: true }).waitFor();
  slow = true; await query.fill('Close in flight'); await panel.getByRole('button', { name: 'Search', exact: true }).click(); await until(() => providerReads === 4);
  await pane.getByRole('button', { name: 'Close pane', exact: true }).click(); await until(() => providerCloses === 2);
  await open();
  // The main query stays in the card body, including after close/reopen.
  await pane.locator('input[aria-label="Search query"]').waitFor({ state: 'attached' });
  await query.waitFor(); assert.equal(await query.inputValue(), ''); assert.equal(providerReads, 4);
  // Wait for the actual account layout receipt, not a shorter-than-debounce sleep.
  const reopenedPaneId = await pane.getAttribute('data-remote-pane');
  assert.ok(reopenedPaneId);
  await until(() => {
    const content = hub.layouts.get('default', 'current').content;
    return content && JSON.parse(content).workspace.panes.some(item => item.kind === 'research' && item.id === reopenedPaneId);
  });
  await page.reload(); await pane.locator('input[aria-label="Search query"]').waitFor({ state: 'attached' }); await query.waitFor(); assert.equal(await query.inputValue(), ''); assert.equal(providerReads, 4, 'restore must not replay searches');
  await query.fill('Revoke in flight'); await panel.getByRole('button', { name: testSynthesis ? 'Search and answer' : 'Search', exact: true }).click(); await until(() => providerReads === 5);
  allowed = false; await until(() => providerCloses === 3); await page.waitForTimeout(400); assert.equal(await page.locator('.workspace-research article').count(), 0);
  allowed = true; principal = { userId: 'unlisted-admin', admin: true }; await page.reload(); await page.getByLabel('Layout presets', { exact: true }).waitFor(); await open();
  await panel.getByText('Search is unavailable. The Hub needs a configured search provider and access for this user.', { exact: true }).waitFor();
  assert.equal(await panel.getByText('Search-engine snippets, not full articles. No model is called.', { exact: true }).count(), 0, 'disabled panel does not show redundant usage instructions');
  assert.equal(await panel.getByRole('textbox', { name: 'Search query', exact: true }).count(), 0); assert.equal(providerReads, 5);
  }
  assert.deepEqual(errors, []); assert.deepEqual(forbidden, []);
  console.log(JSON.stringify({ passed: true, providerReads, providerCloses, aiReads, aiCloses, readerReads, readerCloses, configReads, browserErrors: errors.length, forbiddenRequests: forbidden.length }));
} finally {
  await browser?.close(); routes?.close(); hubServer.closeAllConnections(); await new Promise(resolve => hubServer.close(resolve)); hub.close();
  site.closeAllConnections(); await new Promise(resolve => site.close(resolve)); await rm(directory, { recursive: true, force: true });
}
