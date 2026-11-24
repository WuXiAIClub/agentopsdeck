import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute, join } from 'node:path';
import { verifyCandidateRelease } from './stage-candidate-release.mjs';

const [candidateRoot, command] = process.argv.slice(2);
assert.ok(process.argv.length === 4 && isAbsolute(candidateRoot) && isAbsolute(command));
const candidate = await verifyCandidateRelease(candidateRoot);
const playwright = process.env.AOD_TEST_PLAYWRIGHT;
const executablePath = process.env.AOD_TEST_CHROMIUM;
assert.ok(playwright && executablePath);
const { chromium } = await import(playwright);
const require = createRequire(join(candidateRoot, 'apps/server/package.json'));
const { serve } = require('@hono/node-server');
const directory = await mkdtemp('/tmp/agentopsdeck-candidate-session-create-');
console.log('EVIDENCE', directory);
for (const name of ['home', 'native', 'state', 'workspace', 'tmp']) await mkdir(join(directory, name));
for (const name of Object.keys(process.env)) delete process.env[name];
Object.assign(process.env, { PATH: '/usr/bin:/bin', HOME: join(directory, 'home'), TMPDIR: join(directory, 'tmp'), CODEX_HOME: join(directory, 'native'), NODE_ENV: 'test' });
process.chdir(join(directory, 'state'));
const { loadConfig } = await import(join(candidateRoot, 'apps/server/dist/config.js'));
const { createApplication } = await import(join(candidateRoot, 'apps/server/dist/application.js'));
const { createConnectorRuntime } = await import(join(candidateRoot, 'apps/server/dist/connector/runtime.js'));
const accessKey = randomBytes(32).toString('hex');
const config = loadConfig({ AOD_SERVER_ROLE: 'all', AOD_ACCESS_KEY: accessKey,
  AOD_HUB_VAULT_SECRET: randomBytes(32).toString('hex'), AOD_CODEX_ENABLED: 'true',
  AOD_CODEX_COMMAND: command, AOD_CODEX_HOME: join(directory, 'native'), AOD_CODEX_DEFAULT_CWD: join(directory, 'workspace'),
  AOD_HUB_LOCAL_CONNECTION_ID: 'parallel-codex', AOD_HUB_LOCAL_CONNECTION_LABEL: 'Parallel Codex',
  AOD_LOCAL_OPENCLAW_CLI: 'false', AOD_CONNECTOR_UPDATE_ENABLED: 'false', AOD_MEDIA_BRIDGE_ENABLED: 'false',
  AOD_MEDIA_LIBRARY_ENABLED: 'false', AOD_ARTIFACT_RECEIVER_ENABLED: 'false' });
const evidence = { passed: false, candidate, protocol: [], creationPosts: 0, verifiedBeforeCreation: false, desktopCreated: false,
  mobileLoaded: false, refreshPreservedOriginalIdentity: false, nativeClosed: false, modelRequests: 0, errors: [] };
let application, runtime, listener, browser;
const allowedProtocol = new Set(['initialize', 'initialized', 'thread/list', 'thread/start', 'thread/read', 'thread/resume', 'model/list', 'thread/backgroundTerminals/list']);
try {
  application = createApplication(config, (...args) => {
    runtime = createConnectorRuntime(...args);
    const write = runtime.codex.write.bind(runtime.codex);
    runtime.codex.write = message => {
      assert.ok(allowedProtocol.has(message.method), 'Model and tool execution forbidden');
      if (message.method === 'thread/start') assert.equal(evidence.protocol.filter(method => method === 'thread/start').length, 0);
      evidence.protocol.push(message.method);
      return write(message);
    };
    return runtime;
  });
  listener = serve({ hostname: '127.0.0.1', port: 0, fetch: application.app.fetch });
  if (!listener.listening) await once(listener, 'listening');
  const origin = `http://127.0.0.1:${listener.address().port}`;
  browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  let verified = false;
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) return route.abort();
    if (request.method() === 'POST' && url.pathname.endsWith('/verify')) verified = true;
    if (request.method() === 'POST' && url.pathname.endsWith('/agents/codex/sessions')) {
      evidence.creationPosts++;
      evidence.verifiedBeforeCreation = verified;
    }
    const allowed = request.method() === 'GET' || ['POST /api/auth/login', 'POST /api/auth/logout',
      'POST /api/hub/v1/connections/parallel-codex/verify', 'POST /api/hub/v1/connections/parallel-codex/agents/codex/sessions'].includes(`${request.method()} ${url.pathname}`);
    if (!allowed) { evidence.errors.push('Unexpected browser write blocked'); return route.abort(); }
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', () => evidence.errors.push('Browser JavaScript error'));
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await page.getByPlaceholder('Paste AgentOpsDeck access key').fill(accessKey);
  await page.getByRole('button', { name: 'Unlock with access key', exact: true }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'New session', exact: true }).first().click();
  await page.locator('#new-session-env').selectOption('parallel-codex');
  await page.waitForFunction(() => document.querySelector('#new-session-agent')?.selectedOptions[0]?.textContent.includes('codex'));
  assert.equal(await page.locator('#new-session-env').evaluate(select => select.selectedOptions[0].textContent.includes('degraded')), false);
  await page.locator('#new-session-title').fill('Codex creation acceptance');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('agentopsdeck.command-recovery.v1') ?? '[]').some(row => row.creation?.agentId === 'codex' && row.state === 'accepted'), undefined, { timeout: 30000 });
  assert.equal(evidence.creationPosts, 1);
  assert.equal(evidence.verifiedBeforeCreation, true);
  assert.equal(evidence.protocol.filter(method => method === 'thread/start').length, 1);
  evidence.desktopCreated = true;
  const original = runtime.store.getSessionDirectory().sessions;
  assert.equal(original.length, 1);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByText('Codex creation acceptance', { exact: true }).first().waitFor();
  assert.equal(runtime.store.getSessionDirectory().sessions[0].sessionKey, original[0].sessionKey);
  evidence.refreshPreservedOriginalIdentity = true;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/#/tab/sessions`);
  await page.getByRole('button', { name: 'New chat', exact: true }).first().click();
  await page.waitForFunction(() => document.querySelector('#new-session-agent')?.selectedOptions[0]?.textContent.includes('codex'));
  evidence.mobileLoaded = true;
  assert.equal(evidence.creationPosts, 1);
  assert.equal(evidence.protocol.filter(method => method === 'thread/start').length, 1);
  assert.deepEqual(evidence.errors, []);
  await context.close();
  assert.deepEqual(await verifyCandidateRelease(candidateRoot), candidate);
  evidence.passed = true;
} catch {
  evidence.errors.push('Session creation acceptance failed; credential-bearing exception suppressed');
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (listener) {
    listener.closeAllConnections();
    await new Promise(resolve => listener.close(resolve));
  }
  if (application) { await application.close(); evidence.nativeClosed = true; }
  await writeFile(join(directory, 'result.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(evidence, null, 2));
}
