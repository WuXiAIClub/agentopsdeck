import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { ConnectorTokenStore } from '../../server/src/auth/connector-token.ts';
import { registerConnectorIssueRoutes } from '../../server/src/connector/issues-http.ts';
const require = createRequire(new URL('../../server/package.json', import.meta.url));
const { Hono } = require('hono');
const { chromium } = await import(process.env.AOD_TEST_PLAYWRIGHT ? pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href : 'playwright');
const temp = await mkdtemp(join(tmpdir(), 'issue-browser-'));
const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, envFile: false,
  plugins: [react()], logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  const source = { id: 'project', label: 'Fixture issues', provider: 'gitlab', origin: 'https://git.fixture.invalid', project: '12', token: 'synthetic-private', epoch: 'one',workItemPath:'group/project' };
  const tokens = new ConnectorTokenStore(join(temp, 'tokens.json'));
  const body = '<img src="https://tracking.invalid/pixel"><script>window.executed=true</script>';
  let calls = 0;
  const app = new Hono(); registerConnectorIssueRoutes(app, tokens, [source], async (url, init) => {
    calls++; const u = new URL(String(url)); assert.equal(u.origin, source.origin); assert.equal(init.redirect, 'error');
    if(u.pathname==='/api/graphql'){
      assert.equal(init.method,'POST');const payload=JSON.parse(init.body);assert.ok(!payload.query.includes('mutation'));
      return Response.json({data:{project:{id:'gid://gitlab/Project/12',workItems:{nodes:[{id:'gid://gitlab/WorkItem/3',iid:'4',title:'Work item fixture',state:'OPEN',webUrl:source.origin+'/work/4',updatedAt:'2026-10-07T00:00:00Z',project:{id:'gid://gitlab/Project/12'},workItemType:{name:'Task'},widgets:[{description:body},{labels:{nodes:[{title:'work'}],pageInfo:{hasNextPage:false}}}]}],pageInfo:{hasNextPage:false,endCursor:null}}}}});
    }
    assert.equal(init.method,'GET');
    const page = u.searchParams.get('page');
    return Response.json([{ id: page === '2' ? 2 : 1, iid: 1, labels: ['bug'], assignees: [{ username: 'owner' }], project_id: 12, title: page === '2' ? 'Second page' : 'Untrusted issue', state: 'opened', web_url: source.origin + '/project/-/issues/1', description: body, updated_at: '2026-10-07T00:00:00Z' }], { headers: { 'x-next-page': page === '2' ? '' : '2' } });
  });
  await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true }); const errors = [];
  for (const width of [390, 320]) {
    const token = tokens.createTransient(['issues:read']);
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width, height: 900 } });
    await context.addInitScript(() => localStorage.setItem('agentopsdeck.locale', 'en'));
    let hold, release, delayed = false;
    let board={resourceId:'default',title:'Local source tasks',tasks:[],revision:0,updatedAt:null},boardWrites=0;
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url()); assert.equal(url.origin, origin, 'remote content never loads');
      if (!url.pathname.startsWith('/api/')) return route.continue();
      if(url.pathname==='/api/hub/v1/workspace/boards/default'){
        if(req.method()==='PUT'){const write=req.postDataJSON();assert.equal(write.revision,board.revision);board={...board,...write,revision:board.revision+1,updatedAt:Date.now()};boardWrites++;}
        return route.fulfill({json:board});
      }
      if(url.pathname==='/api/hub/v1/workspace/boards')return route.fulfill({json:{boards:[]}});
      assert.equal(req.method(), 'GET');
      if (url.pathname === '/api/hub/v1/connections') return route.fulfill({ json: { connections: [{ id: 'fixture', label: 'Fixture environment' }] } });
      assert.ok(url.pathname.startsWith('/api/hub/v1/connections/fixture/issues/'));
      const response = await app.request(url.pathname.replace('/api/hub/v1/connections/fixture', '/api/connector/v1') + url.search, { headers: { authorization: `Bearer ${token.token}` } });
      const text = await response.text(); assert.ok(!text.includes(source.token));
      if (delayed && url.pathname.endsWith('/items')) { hold?.(); await new Promise(resolve => { release = resolve; }); }
      await route.fulfill({ status: response.status, contentType: 'application/json', body: text });
    });
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${origin}/tests/fixtures/issues.html`);
    await page.getByLabel('Environment', { exact: true }).selectOption('fixture');
    await page.getByLabel('Issue source', { exact: true }).selectOption('project');
    await page.getByRole('button', { name: /Untrusted issue/ }).click();
    assert.equal(await page.locator('pre').innerText(), body);
    assert.equal(await page.locator('article img, article script').count(), 0);
    await page.getByLabel('Target session',{exact:true}).selectOption('draft');await page.getByRole('button',{name:'Confirm: place in session draft',exact:true}).click();
    assert.ok((await page.getByLabel('Fixture draft').inputValue()).includes('sourceKey'));
    await page.getByLabel('Target notebook',{exact:true}).selectOption('note');await page.getByRole('button',{name:'Confirm: add to notebook',exact:true}).click();
    assert.ok((await page.getByLabel('Fixture note').inputValue()).includes(body.replaceAll('"','\\"')));
    await page.locator('.workspace-taskboard[data-board-ready="true"]').waitFor();
    await page.getByLabel('Target task board',{exact:true}).selectOption('board');await page.getByRole('button',{name:'Confirm: import local task',exact:true}).click();
    await page.locator('.workspace-taskboard [data-board-task]').waitFor();
    await page.locator('.workspace-taskboard[data-board-ready="true"]').waitFor();
    assert.equal(board.tasks.length,1);assert.equal(boardWrites,1);assert.ok(board.tasks[0].detail.includes('Source:'));
    await page.getByRole('button', { name: 'Next page', exact: true }).click();
    await page.getByRole('button', { name: /Second page/ }).waitFor();
    await page.getByLabel('Item type',{exact:true}).selectOption('work_item');await page.getByRole('button',{name:/Work item fixture/}).click();
    await page.getByRole('heading',{name:'#4 Work item fixture'}).waitFor();
    await page.reload();await page.getByRole('button',{name:/Work item fixture/}).waitFor();assert.equal(await page.getByLabel('Item type',{exact:true}).inputValue(),'work_item');
    await page.getByLabel('Item type',{exact:true}).selectOption('issue');await page.locator('.workspace-source-card').getByRole('button',{name:/Untrusted issue/}).click();
    await page.getByLabel('Target task board',{exact:true}).selectOption('board');await page.getByRole('button',{name:'Confirm: import local task',exact:true}).click();
    await page.getByText('This source is already on the board. Existing task preserved.',{exact:true}).waitFor();assert.equal(boardWrites,1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    delayed = true; const admitted = new Promise(resolve => { hold = resolve; });
    await page.getByRole('button', { name: 'Refresh', exact: true }).click(); await admitted;
    await page.getByRole('button', { name: 'Change account', exact: true }).click(); release();
    await page.getByText('Read-only source. Work items require explicit source support; remote edits are disabled.', { exact: true }).waitFor();
    assert.equal(await page.locator('.workspace-source-card').getByRole('button', { name: /Untrusted issue|Second page/ }).count(), 0);
    assert.equal(await page.evaluate(() => Object.values(localStorage).some(value => value.includes('Untrusted issue'))), false);
    await context.close();
  }
  assert.deepEqual(errors, []); console.log(JSON.stringify({ verified: true, viewports: [390, 320], strictMode: true, realConnector: true, syntheticProvider: true, accountFence: true, remoteWrites: 0, calls }));
} finally { await browser?.close(); await server.close(); await rm(temp, { recursive: true, force: true }); }
