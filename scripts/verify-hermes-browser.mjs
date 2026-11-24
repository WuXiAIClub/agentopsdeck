// Built Hub + Connector + real pinned Hermes + browser; synthetic model, no production credentials.
// node scripts/verify-hermes-browser.mjs SOURCE PYTHON PLAYWRIGHT_INDEX
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

const [source, python, playwright] = process.argv.slice(2).map(value => resolve(value));
assert.ok(source && python && playwright, 'Expected pinned source, isolated Python and Playwright module');
const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-hermes-browser-'));
for (const name of ['home', 'hermes', 'workspace', 'state', 'tmp']) mkdirSync(join(root, name));
let release;
const gate = new Promise(resolve => { release = resolve; });
let modelRequests = 0;
const model = createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.method === 'GET') { res.end(JSON.stringify({ data: [{ id: 'fixture', context_length: 128000 }] })); return; }
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  modelRequests++; await gate;
  const message = { role: 'assistant', content: 'Hermes browser verified' };
  if (body.stream) {
    res.setHeader('content-type', 'text/event-stream');
    for (const [delta, finish_reason] of [[message, null], [{}, 'stop']]) {
      res.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
    }
    res.end('data: [DONE]\n\n');
  } else res.end(JSON.stringify({ id: 'fixture', object: 'chat.completion', model: 'fixture', choices: [{ index: 0, message, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
const modelUrl = `http://127.0.0.1:${model.address().port}/v1`;
writeFileSync(join(root, 'hermes', 'config.yaml'), `model:\n  default: fixture\n  provider: custom\n  base_url: ${modelUrl}\n  api_key: fixture-not-a-secret\ndesktop:\n  auto_continue:\n    enabled: false\nplatform_toolsets:\n  tui: []\n`, { mode: 0o600 });
const key = randomBytes(32).toString('hex');
const child = spawn(process.execPath, [resolve('apps/server/dist/index.js')], {
  cwd: join(root, 'state'), stdio: ['ignore', 'pipe', 'pipe'],
  env: { PATH: '/usr/bin:/bin', HOME: join(root, 'home'), TMPDIR: join(root, 'tmp'), NODE_ENV: 'production',
    PORT: '0', AOD_LISTEN_HOST: '127.0.0.1', AOD_SERVER_ROLE: 'all',
    AOD_ACCESS_KEY: key, AOD_HUB_VAULT_SECRET: randomBytes(32).toString('hex'),
    AOD_CODEX_ENABLED: 'false', AOD_LOCAL_OPENCLAW_CLI: 'false', AOD_CONNECTOR_UPDATE_ENABLED: 'false',
    AOD_MEDIA_BRIDGE_ENABLED: 'false', AOD_MEDIA_LIBRARY_ENABLED: 'false', AOD_ARTIFACT_RECEIVER_ENABLED: 'false',
    AOD_ARTIFACT_CAPABILITY_INJECTION: 'false', AOD_ARTIFACT_GATEWAY_CLIENT_ENABLED: 'false',
    AOD_CONNECTOR_ENV_ID: 'hermes-test', AOD_HUB_LOCAL_CONNECTION_ID: 'hermes-test',
    AOD_HERMES_ENABLED: 'true', AOD_HERMES_DEDICATED: 'true', AOD_HERMES_PYTHON: python,
    AOD_HERMES_SOURCE: source, AOD_HERMES_HOME: join(root, 'hermes'), AOD_HERMES_WORKSPACE: join(root, 'workspace'),
    OPENAI_API_KEY: 'fixture-not-a-secret', OPENAI_BASE_URL: modelUrl, NO_PROXY: '*', PYTHONDONTWRITEBYTECODE: '1', HERMES_SKIP_UPDATE_CHECK: '1' },
});
let stdout = '', exited = false, browser, page;
child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-16000); });
child.stderr.resume();
const closed = new Promise(resolve => child.once('close', () => { exited = true; resolve(); }));
const result = { passed: false, realBackend: true, syntheticModel: true, checks: [], pageErrors: 0, evidence: root };
async function until(label, check, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    assert.equal(exited, false, 'Isolated server exited');
    const value = await check(); if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('Timeout: ' + label);
}
try {
  const origin = await until('listener', () => stdout.match(/AgentOpsDeck server listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1]);
  const { chromium } = await import(pathToFileURL(playwright).href);
  browser = await chromium.launch({ headless: true, channel: 'chromium' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  async function api(path, method = 'GET', data) {
    const response = await context.request.fetch(origin + path, { method, data, headers: { origin } });
    assert.equal(response.ok(), true, `${method} ${path}: ${response.status()}`);
    return response.json();
  }
  await api('/api/auth/login', 'POST', { accessKey: key });
  await api('/api/hub/v1/connections/hermes-test/verify', 'POST', {});
  await until('Hermes ready', async () => (await api('/api/connector/v1/health')).hermes?.ready);
  page = await context.newPage();
  page.on('pageerror', () => result.pageErrors++);
  await page.goto(origin);
  await page.getByRole('button', { name: 'New session', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Create new session' });
  await until('Hermes option', async () => await dialog.locator('#new-session-agent option[value="hermes"]').count());
  await dialog.getByLabel('Agent', { exact: true }).selectOption('hermes');
  await dialog.getByLabel('Session name').fill('Hermes browser acceptance');
  const created = page.waitForResponse(r => r.request().method() === 'POST' && r.url().includes('/agents/hermes/sessions'));
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  const response = await created; assert.equal(response.status(), 201);
  const session = await response.json();
  const base = `/api/hub/v1/sessions/${encodeURIComponent(session.key)}`;
  await page.getByRole('button', { name: 'Attach file', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Attach file', exact: true }).isDisabled(), true);
  result.checks.push('Owner UI creates Hermes; unsupported attachments disabled');
  async function send(text) {
    await page.locator('textarea:visible').fill(text);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await until('composer cleared', async () => await page.locator('textarea:visible').inputValue() === '');
  }
  await send('first-browser-turn');
  await until('native model invoked', () => modelRequests >= 1);
  await send('second-browser-queued');
  await until('queued item', async () => (await api(base + '/queue')).items.length === 1);
  await page.getByText('Queued', { exact: true }).first().waitFor();
  result.checks.push('Running turn admits next message and shows Queued');
  release();
  await until('both real replies persisted', async () => modelRequests >= 2 && (await api(base + '/queue')).items.length === 0
    && (await api(base + '/messages?limit=200')).messages.filter(message => message.role === 'assistant'
      && message.text === 'Hermes browser verified' && message.status === 'sent').length === 2);
  await page.getByText('Hermes browser verified', { exact: true }).first().waitFor();
  await page.reload();
  await page.getByText('Hermes browser verified', { exact: true }).first().waitFor();
  result.checks.push('Real backend reply appears; page reload restores history');
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    // Mobile mounts its own navigation; select the chat from its list.
    if (width < 768) await page.getByRole('region', { name: 'All chats', exact: true })
      .locator('button[data-session-card]').filter({ hasText: 'Hermes browser acceptance' }).click();
    await page.getByText('Hermes browser verified', { exact: true }).first().waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Horizontal overflow');
    await page.screenshot({ path: join(root, `browser-${width}.png`) });
  }
  result.checks.push('Desktop and mobile history visible without horizontal overflow');
  await until('terminal idle before delete', async () => (await api('/api/hub/v1/sessions/state')).groups
    .flatMap(group => group.sessions).find(row => row.sessionKey === session.key)?.runtime?.phase === 'completed');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByLabel('More session actions').click();
  await page.getByRole('button', { name: 'Delete session…', exact: true }).click();
  const deletion = page.getByRole('dialog', { name: 'Delete session?' });
  await deletion.waitFor();
  assert.match(await deletion.textContent(), /delegated child sessions/);
  assert.match(await deletion.textContent(), /Workspace files are not deleted/);
  await page.keyboard.press('Escape');
  await page.getByLabel('More session actions').click();
  await page.getByRole('button', { name: 'Delete session…', exact: true }).click();
  const deleted = page.waitForResponse(r => r.request().method() === 'DELETE' && r.url().includes('/sessions/'));
  await deletion.getByRole('button', { name: 'Delete', exact: true }).click();
  const deletedResponse = await deleted;
  assert.equal(deletedResponse.status(), 200); assert.equal((await deletedResponse.json()).command.state, 'accepted');
  await until('deleted card removed', async () => await page.locator('button[data-session-card]').filter({ hasText: 'Hermes browser acceptance' }).count() === 0);
  await page.reload();
  await until('deleted session absent from directory', async () => !(await api('/api/hub/v1/sessions/state')).groups.some(group => group.sessions.some(row => row.sessionKey === session.key)));
  result.checks.push('Styled deletion confirm/cancel; real Hub → Connector → Hermes ACK; directory remains absent after reload');
  assert.equal(result.pageErrors, 0);
  result.passed = true;
} catch (error) {
  result.error = error.message;
  if (page) await page.screenshot({ path: join(root, 'failed.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  result.modelRequests = modelRequests;
  release(); await browser?.close();
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  await closed; clearTimeout(timer);
  model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
  writeFileSync(join(root, 'result.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(result));
}
