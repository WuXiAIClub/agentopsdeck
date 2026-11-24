import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
const { chromium } = await import(process.env.AOD_TEST_PLAYWRIGHT ? pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href : 'playwright');
const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, envFile: false,
  plugins: [react()], logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.AOD_TEST_CHROMIUM }); const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 900 } });
  await context.addInitScript(() => localStorage.setItem('agentopsdeck.locale', 'en'));
  const calls = [], errors = [], group = randomUUID(); let batch, dropPreview = true, confirms = 0;
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()); assert.equal(url.origin, origin);
    if (!url.pathname.startsWith('/api/')) return route.continue();
    calls.push([request.method(), url.pathname]); const json = body => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname.endsWith('/preferences')) return json({ revision: 1, groups: [{ id: group, name: 'Development' }], sessions: {} });
    if (url.pathname.endsWith('/sessions/state')) return json({ groups: [] });
    assert.ok(url.pathname.includes('/delegations'));
    if (request.method() === 'POST' && url.pathname.endsWith('/delegations')) {
      const input = request.postDataJSON(); assert.equal(input.selection.groupId, group); assert.deepEqual(input.fields, ['status']);
      batch = { batchId: input.batchId, state: 'prepared', grantExpiresAt: input.expiresAt,
        preview: { expiresAt: Date.now() + 300000, selection: input.selection, resource: { resourceId: 'default', fields: input.fields,
          tasks: [{ id: input.taskIds[0], title: 'Frozen task', status: 'todo', detail: '' }] } },
        members: ['codex:a', 'codex:b'].map(sessionId => ({ requestId: randomUUID(), member: { sessionId, runtime: 'codex' }, state: 'prepared' })) };
      if (dropPreview) { dropPreview = false; return route.abort(); } return json({ batch });
    }
    assert.ok(url.pathname.includes(batch.batchId));
    if (request.method() === 'POST') { assert.ok(url.pathname.endsWith('/confirm')); assert.deepEqual(request.postDataJSON(), {}); confirms++; batch.state = 'confirmed'; batch.members.forEach(m => { m.state = 'installed'; }); }
    if (request.method() === 'DELETE') { batch.state = 'cancelled'; batch.members.forEach(m => { m.state = 'revoked'; }); }
    return json({ batch });
  });
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  const open = async () => { await page.goto(`${origin}/tests/fixtures/board-delegation.html`); await page.getByRole('button', { name: 'Toggle batch' }).click(); };
  await page.goto(`${origin}/tests/fixtures/board-delegation.html`); assert.equal(calls.length, 0);
  await page.getByRole('button', { name: 'Toggle batch' }).click();
  await page.getByRole('combobox', { name: 'Group', exact: true }).selectOption({ label: 'Development' });
  await page.getByRole('button', { name: 'Preview batch grant' }).click(); await page.getByRole('alert').waitFor();
  const original = batch.batchId; assert.equal(confirms, 0);
  await open(); await page.getByRole('button', { name: 'Confirm frozen batch' }).waitFor();
  assert.equal(batch.batchId, original); assert.equal(calls.filter(([m, p]) => m === 'POST' && p.endsWith('/delegations')).length, 1);
  await page.getByRole('button', { name: 'Confirm frozen batch' }).click(); await page.getByText('codex:a · Session bound').waitFor();
  assert.equal(confirms, 1); await open(); await page.getByText('codex:a · Session bound').waitFor(); assert.equal(confirms, 1);
  await page.getByRole('button', { name: 'Revoke batch and clean up' }).click(); await page.getByRole('button', { name: 'Start another batch' }).click();
  await page.getByRole('button', { name: 'Preview batch grant' }).waitFor(); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ verified: true, previewPosts: 1, confirmations: confirms, lostPreviewReload: true, revoke: true, viewport: 390 }));
} finally { await browser?.close(); await server.close(); }
