import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyCandidateRelease } from './stage-candidate-release.mjs';

const [candidateRoot, command, model, providerOrigin] = process.argv.slice(2);
const sharedCreation = process.env.AOD_TEST_SHARED_CREATION === 'true';
assert.ok(process.argv.length === 6 && isAbsolute(candidateRoot) && isAbsolute(command));
assert.match(model, /^[a-zA-Z0-9._-]+$/);
const provider = new URL(providerOrigin);
assert.ok(provider.protocol === 'http:' && provider.hostname === '127.0.0.1' && provider.port
  && !provider.username && !provider.password && !provider.search && !provider.hash && provider.pathname === '/');
const candidate = await verifyCandidateRelease(candidateRoot);
const directory = await mkdtemp('/tmp/agentopsdeck-member-permissions-');
console.log('EVIDENCE', directory);
for (const name of ['home', 'native', 'state', 'workspace', 'tmp']) await mkdir(join(directory, name));
await writeFile(join(directory, 'native/config.toml'), `model = ${JSON.stringify(model)}
model_provider = "copilot_bridge"
[model_providers.copilot_bridge]
name = "copilot_bridge"
base_url = ${JSON.stringify(provider.origin)}
wire_api = "responses"
requires_openai_auth = false
`, { mode: 0o600 });
const nonce = randomBytes(12).toString('hex');
await writeFile(join(directory, 'workspace/input.txt'), nonce, { mode: 0o600 });
await writeFile(join(directory, 'workspace/probe.mjs'), `import { readFile, writeFile } from 'node:fs/promises';
const root = new URL('./', import.meta.url);
const value = await readFile(new URL('input.txt', root), 'utf8');
await writeFile(new URL('output.txt', root), value);
console.log('MEMBER_TOOL_OK');
`, { mode: 0o600 });
const adminKey = randomBytes(32).toString('hex');
const log = createWriteStream(join(directory, 'server.log'), { mode: 0o600 });
const child = spawn(process.execPath, [join(candidateRoot, candidate.entrypoint)], {
  cwd: join(directory, 'state'), stdio: ['ignore', 'pipe', 'pipe'],
  env: { HOME: join(directory, 'home'), TMPDIR: join(directory, 'tmp'), PATH: '/usr/bin:/bin', NODE_ENV: 'production',
    CODEX_HOME: join(directory, 'native'), PORT: '0', AOD_LISTEN_HOST: '127.0.0.1', AOD_SERVER_ROLE: 'all',
    AOD_ACCESS_KEY: adminKey, AOD_HUB_VAULT_SECRET: randomBytes(32).toString('hex'),
    AOD_CODEX_ENABLED: 'true', AOD_CODEX_COMMAND: command, AOD_CODEX_HOME: join(directory, 'native'),
    AOD_CODEX_DEFAULT_CWD: join(directory, 'workspace'), AOD_CODEX_DEFAULT_MODEL: model,
    AOD_CODEX_MODEL_PROVIDER: 'copilot_bridge', AOD_CODEX_APPROVAL_POLICY: 'on-request',
    AOD_CONNECTOR_ENV_ID: 'parallel-codex', AOD_HUB_LOCAL_CONNECTION_ID: 'parallel-codex',
    AOD_HUB_LOCAL_EXECUTION_SETUP: 'true', AOD_LOCAL_OPENCLAW_CLI: 'false', AOD_CONNECTOR_UPDATE_ENABLED: 'false',
    AOD_MEDIA_BRIDGE_ENABLED: 'false', AOD_MEDIA_LIBRARY_ENABLED: 'false', AOD_ARTIFACT_RECEIVER_ENABLED: 'false',
    AOD_ARTIFACT_CAPABILITY_INJECTION: 'false', AOD_ARTIFACT_GATEWAY_CLIENT_ENABLED: 'false' },
});
let stdout = '', browser, exit;
child.stdout.on('data', chunk => { stdout += chunk; log.write(chunk); });
child.stderr.pipe(log, { end: false });
child.once('close', (code, signal) => { exit = { code, signal }; log.end(); });
const result = { candidate, directory, startedAt: new Date().toISOString(), passed: false, userInstanceTouched: false,
  realModelAndTools: true, checks: [], errors: [] };
async function until(label, check, timeout = 180000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 300)); }
  throw new Error(`Timeout: ${label}`);
}
try {
  const origin = await until('listener', () => { assert.equal(exit, undefined); return stdout.match(/AgentOpsDeck server listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1]; }, 25000);
  const { chromium } = await import(pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href);
  browser = await chromium.launch({ headless: true });
  const admin = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const member = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const outsider = await browser.newContext();
  async function api(context, path, method = 'GET', data, status = 200, headers = {}) {
    const response = await context.request.fetch(origin + path, { method, data, headers: { origin, ...headers } });
    assert.equal(response.status(), status, `${method} ${path}`);
    return response.headers()['content-type']?.includes('application/json') ? response.json() : undefined;
  }
  await api(admin, '/api/auth/login', 'POST', { accessKey: adminKey });
  const connection = '/api/hub/v1/connections/parallel-codex';
  await api(admin, connection + '/verify', 'POST', {});
  const created = await api(admin, connection + '/agents/codex/sessions', 'POST', { title: 'Isolated member E2E', idempotencyKey: 'member-create' }, 201);
  let sessionKey = created.key;
  await until('owner session', async () => (await api(admin, '/api/hub/v1/sessions/state')).groups.flatMap(group => group.sessions).some(session => session.sessionKey === sessionKey));
  let ownerPath = `/api/hub/v1/sessions/${encodeURIComponent(sessionKey)}`;
  let sharedPath = `/api/hub/v1/shared/default/sessions/${encodeURIComponent(sessionKey)}`;
  const page = await admin.newPage(), memberPage = await member.newPage();
  for (const activePage of [page, memberPage]) {
    activePage.on('pageerror', () => result.errors.push('pageerror'));
    activePage.on('dialog', dialog => dialog.accept());
  }
  await page.goto(`${origin}/#/tab/users`);
  await page.getByRole('textbox', { name: 'New Hub user label' }).fill('Read write member');
  await page.getByRole('button', { name: 'Create Hub record', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Access for Read write member', exact: true });
  await panel.waitFor();
  assert.equal(await panel.getByRole('combobox', { name: 'Permission preset' }).isVisible(), false);
  assert.equal(await page.getByRole('textbox', { name: 'New connector account' }).count(), 0);
  await panel.getByRole('button', { name: 'Issue member login key', exact: true }).click();
  const secret = panel.getByRole('textbox', { name: 'One-time member login key' });
  await secret.waitFor();
  const memberKey = await secret.inputValue();
  await panel.getByRole('button', { name: 'Hide key', exact: true }).click();
  await panel.getByText('1 active key', { exact: true }).waitFor();
  assert.equal(await panel.getByRole('button', { name: 'Revoke key', exact: true }).isVisible(), false);
  await panel.locator('summary').filter({ hasText: 'Manage existing login keys' }).click();
  await panel.getByRole('button', { name: 'Revoke key', exact: true }).waitFor();
  await panel.locator('summary').filter({ hasText: 'Manage existing login keys' }).click();
  await memberPage.goto(origin);
  await memberPage.getByRole('textbox', { name: 'Access key', exact: true }).fill(memberKey);
  await memberPage.getByRole('button', { name: 'Unlock with access key' }).click();
  await memberPage.getByRole('heading', { name: 'Shared with me' }).waitFor();
  const principal = await api(member, '/api/hub/v1/me');
  assert.equal(principal.admin, false);
  await api(member, connection + '/execution-issuer/local', 'POST', { confirm: true, nodeVersion: 1 }, 403);
  await panel.locator('summary').filter({ hasText: 'Advanced permissions & environment setup' }).click();
  await panel.getByRole('button', { name: 'Enable local shared execution', exact: true }).click();
  await panel.getByText(/Environment setup saved/).waitFor();
  await panel.getByRole('button', { name: 'Refresh authorizations', exact: true }).click();
  await panel.getByText('Execution issuer configured.', { exact: true }).waitFor();
  const node = await api(admin, connection + '/grants');
  assert.equal(node.executionConfigured, true);
  await api(admin, connection + '/execution-issuer/local', 'POST', { confirm: true, nodeVersion: node.nodeVersion });
  if (sharedCreation) {
    await panel.locator('summary').filter({ hasText: 'Advanced permissions & environment setup' }).click();
    await memberPage.goto(`${origin}/#/tab/sessions`);
    await memberPage.getByRole('button', { name: 'New session', exact: true }).first().click();
    await memberPage.getByText('Environment access needed', { exact: true }).waitFor();
    assert.equal(await memberPage.getByLabel('Session name').count(), 0);
    assert.equal(await memberPage.getByLabel('Agent', { exact: true }).count(), 0);
    assert.equal(await memberPage.getByRole('dialog', { name: 'Create new session' }).getByRole('button', { name: 'Create', exact: true }).isDisabled(), true);
    await memberPage.getByRole('button', { name: 'Cancel', exact: true }).click();
    page.removeAllListeners('dialog');
    page.once('dialog', dialog => dialog.dismiss());
    await panel.getByRole('button', { name: 'Allow creating and chatting', exact: true }).click();
    assert.equal((await api(admin, connection + '/grants')).grants.length, 0);
    assert.equal((await api(admin, connection + '/execution-issuer')).issuer.creationAllowed === true, false);
    page.on('dialog', dialog => dialog.accept());
    await panel.getByRole('button', { name: 'Allow creating and chatting', exact: true }).click();
    await panel.getByText(/Access saved for Read write member/).waitFor();
    assert.equal(await panel.getByRole('combobox', { name: 'Permission preset' }).isVisible(), false);
    await panel.getByText('Saved · current environment version', { exact: true }).waitFor();
    await panel.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(directory, 'member-access-desktop.png') });
    assert.equal((await api(member, '/api/hub/v1/shared/creation-environments')).environments.length, 1);
    for (const width of [1440, 390]) {
      await memberPage.setViewportSize({ width, height: 1000 });
      await memberPage.goto(`${origin}/#/tab/sessions`);
      await memberPage.getByRole('button', { name: width === 390 ? 'New chat' : 'New session', exact: true }).first().click();
      const dialog = memberPage.getByRole('dialog', { name: 'Create new session' });
      await until('shared environment option', async () => (await dialog.getByLabel('Environment').locator('option').allTextContents()).some(label => label.includes('shared')));
      await dialog.getByLabel('Environment').selectOption(JSON.stringify(['default', 'parallel-codex']));
      await dialog.getByLabel('Session name').fill(`Member-created ${width}`);
      const accepted = memberPage.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/shared/default/connections/parallel-codex/agents/codex/sessions'));
      await dialog.getByRole('button', { name: 'Create', exact: true }).click();
      const response = await accepted;
      assert.equal(response.status(), 201);
      sessionKey = (await response.json()).key;
      ownerPath = `/api/hub/v1/sessions/${encodeURIComponent(sessionKey)}`;
      sharedPath = `/api/hub/v1/shared/default/sessions/${encodeURIComponent(sessionKey)}`;
      await memberPage.getByRole('textbox', { name: 'Shared message' }).waitFor();
      await until('created session send authorization', async () => !(await memberPage.getByRole('textbox', { name: 'Shared message' }).isDisabled()));
      await memberPage.reload();
      await memberPage.getByRole('textbox', { name: 'Shared message' }).waitFor();
      assert.equal(await memberPage.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `created session viewport ${width}`);
    }
    const firstAuthority = (await api(admin, connection + '/grants')).nodeVersion;
    await page.setViewportSize({ width: 390, height: 1000 });
    await page.getByRole('textbox', { name: 'New Hub user label' }).fill('Second creation member');
    await page.getByRole('button', { name: 'Create Hub record', exact: true }).click();
    const secondPanel = page.getByRole('region', { name: 'Access for Second creation member', exact: true });
    await secondPanel.waitFor();
    await secondPanel.getByRole('button', { name: 'Issue member login key', exact: true }).click();
    const secondSecret = secondPanel.getByRole('textbox', { name: 'One-time member login key' });
    await secondSecret.waitFor();
    const secondKey = await secondSecret.inputValue();
    await secondPanel.getByRole('button', { name: 'Hide key', exact: true }).click();
    await secondPanel.getByRole('button', { name: 'Allow creating and chatting', exact: true }).click();
    await secondPanel.getByText(/Access saved for Second creation member/).waitFor();
    await secondPanel.getByText('Saved · current environment version', { exact: true }).waitFor();
    assert.equal(await secondPanel.getByRole('combobox', { name: 'Permission preset' }).isVisible(), false);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await secondPanel.getByRole('region', { name: 'Environment authorization', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(directory, 'member-access-mobile.png') });
    await until('second member saved list', async () => !(await secondPanel.getByRole('button', { name: 'Allow creating and chatting', exact: true }).isDisabled()));
    await secondPanel.getByRole('button', { name: 'Allow creating and chatting', exact: true }).click();
    await secondPanel.getByText(/Access saved for Second creation member/).waitFor();
    const secondGrants = await api(admin, connection + '/grants');
    assert.equal(secondGrants.nodeVersion, firstAuthority);
    assert.equal(secondGrants.grants.length, 2);
    const secondMember = await browser.newContext({ viewport: { width: 390, height: 1000 } });
    await api(secondMember, '/api/auth/login', 'POST', { accessKey: secondKey });
    assert.equal((await api(secondMember, '/api/hub/v1/shared/creation-environments')).environments.length, 1);
    const secondPage = await secondMember.newPage();
    await secondPage.goto(`${origin}/#/tab/sessions`);
    await secondPage.getByRole('button', { name: 'New chat', exact: true }).first().click();
    const secondDialog = secondPage.getByRole('dialog', { name: 'Create new session' });
    await until('second member selectable environment', async () => !(await secondDialog.getByRole('button', { name: 'Create', exact: true }).isDisabled()));
    await secondDialog.getByRole('button', { name: 'Create', exact: true }).click();
    await secondPage.getByRole('textbox', { name: 'Shared message' }).waitFor();
    await secondPage.reload();
    await secondPage.getByRole('textbox', { name: 'Shared message' }).waitFor();
    await secondMember.close();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('listitem').filter({ has: page.getByText('Read write member', { exact: true }) }).getByRole('button', { name: 'Manage access' }).click();
    result.checks.push('automatic setup panel; refreshed login keys; advanced controls collapsed; actionable empty state; one-confirmation access; cancel has no writes; second new member without issuer rotation; repeated grant reconciles; desktop/mobile create/reload');
    await panel.getByRole('button', { name: 'Refresh authorizations', exact: true }).click();
    await panel.getByRole('button', { name: 'Edit authorization', exact: true }).click();
    await panel.getByRole('combobox', { name: 'Permission preset' }).selectOption('read');
    await panel.getByRole('checkbox', { name: 'Confirm grant scope' }).check();
    await panel.getByRole('button', { name: 'Save authorization changes', exact: true }).click();
    await panel.getByText(/Authorization saved/).waitFor();
    assert.equal((await api(member, '/api/hub/v1/shared/creation-environments')).environments.length, 0);
    await api(member, '/api/hub/v1/shared/default/connections/parallel-codex/agents/codex/sessions', 'POST', { label: 'Denied', idempotencyKey: 'creation-downgrade' }, 403);
    await panel.getByRole('button', { name: 'Refresh authorizations', exact: true }).click();
    await memberPage.reload();
  } else {
  await panel.getByRole('combobox', { name: 'Grant session', exact: true }).selectOption({ index: 1 });
  await panel.getByRole('checkbox', { name: 'Confirm grant scope' }).check();
  await panel.getByRole('button', { name: 'Grant access', exact: true }).click();
  await panel.getByText(/Authorization saved/).waitFor();
  await panel.getByRole('button', { name: 'Refresh authorizations', exact: true }).click();
  await memberPage.getByRole('button', { name: 'Refresh', exact: true }).click();
  await memberPage.getByRole('link', { name: 'Open session', exact: true }).click();
  }
  await memberPage.getByRole('textbox', { name: 'Shared message' }).waitFor();
  assert.equal(await memberPage.getByRole('textbox', { name: 'Shared message' }).isDisabled(), true);
  await api(member, sharedPath + '/messages', 'POST', { message: 'must not run', idempotencyKey: 'readonly-denied' }, 403);
  result.checks.push('UI create member/login/local issuer/read-only send denied');
  await panel.getByRole('button', { name: 'Edit authorization', exact: true }).click();
  await panel.getByRole('combobox', { name: 'Permission preset' }).selectOption('chat');
  await panel.getByRole('checkbox', { name: 'Confirm grant scope' }).check();
  await panel.getByRole('button', { name: 'Save authorization changes', exact: true }).click();
  await panel.getByText(/Authorization saved/).waitFor();
  await memberPage.reload();
  const prompt = `Execute exactly this harmless command once: ${process.execPath} ${join(directory, 'workspace/probe.mjs')}. It only reads and writes the temporary fixture workspace. Wait for completion, then reply exactly MEMBER_TOOL_OK. Do not use other tools or paths.`;
  await memberPage.getByRole('textbox', { name: 'Shared message' }).fill(prompt);
  await memberPage.getByRole('button', { name: 'Send', exact: true }).click();
  await until('real member tool reply', async () => {
    const state = await api(admin, '/api/hub/v1/sessions/state');
    const session = state.groups.flatMap(group => group.sessions).find(session => session.sessionKey === sessionKey);
    assert.notEqual(session.runtime?.phase, 'failed');
    if (session.runtime?.phase !== 'completed' || session.runtime?.sync !== 'current' || session.hasActiveRun) return false;
    const history = await api(member, sharedPath + '/messages');
    return history.messages.some(message => message.role === 'assistant' && message.text.trim() === 'MEMBER_TOOL_OK');
  });
  assert.equal(await readFile(join(directory, 'workspace/output.txt'), 'utf8'), nonce);
  await memberPage.getByText('MEMBER_TOOL_OK', { exact: true }).first().waitFor();
  await memberPage.setViewportSize({ width: 390, height: 900 });
  await memberPage.reload();
  await memberPage.getByRole('textbox', { name: 'Shared message' }).fill('Reply exactly MEMBER_MOBILE_OK. No tools.');
  await memberPage.getByRole('button', { name: 'Send', exact: true }).click();
  await until('mobile reply', async () => {
    const snapshot = await api(member, sharedPath + '/state');
    assert.notEqual(snapshot.runtime?.phase, 'failed');
    if (snapshot.runtime?.phase !== 'completed' || snapshot.runtime?.sync !== 'current' || snapshot.hasActiveRun) return false;
    return (await api(member, sharedPath + '/messages')).messages.some(message => message.role === 'assistant' && message.text.trim() === 'MEMBER_MOBILE_OK');
  });
  await memberPage.getByText('MEMBER_MOBILE_OK', { exact: true }).first().waitFor();
  result.checks.push('UI read-to-write edit, actual installed Codex tools, member mobile followup');
  await api(outsider, sharedPath + '/messages', 'GET', undefined, 401);
  await api(member, ownerPath + '/messages', 'GET', undefined, 404);
  await api(member, connection + '/agents/codex/sessions', 'POST', { idempotencyKey: 'forbidden-create' }, 404);
  await panel.getByRole('button', { name: 'Refresh authorizations', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 1000 });
  await page.getByRole('listitem').filter({ has: page.getByText('Read write member', { exact: true }) }).getByRole('button', { name: 'Manage access' }).click();
  await panel.getByRole('button', { name: 'Edit authorization', exact: true }).click();
  await panel.getByRole('combobox', { name: 'Permission preset' }).selectOption('queue');
  await panel.getByRole('checkbox', { name: 'Receive live events' }).uncheck();
  await panel.getByRole('checkbox', { name: 'Confirm grant scope' }).check();
  await panel.getByRole('button', { name: 'Save authorization changes', exact: true }).click();
  await panel.getByText(/Authorization saved/).waitFor();
  const updated = (await api(admin, connection + '/grants')).grants.find(grant => grant.userId === principal.userId);
  assert.ok(updated.policy.actions.includes('queue:manage'));
  assert.equal(updated.policy.actions.includes('events:read'), false);
  await memberPage.reload();
  await until('no-event authorized history', async () => (await api(member, sharedPath + '/messages')).access.eventsRead === false);
  await memberPage.getByText('MEMBER_TOOL_OK', { exact: true }).first().waitFor();
  for (const activePage of [page, memberPage]) assert.equal(await activePage.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  result.checks.push('mobile granular queue/event controls, history without events, owner/create/outsider denied');
  await panel.getByRole('button', { name: 'Refresh authorizations', exact: true }).click();
  await panel.getByRole('button', { name: 'Edit authorization', exact: true }).click();
  await panel.getByRole('combobox', { name: 'Permission preset' }).selectOption('read');
  await panel.getByRole('checkbox', { name: 'Confirm grant scope' }).check();
  await panel.getByRole('button', { name: 'Save authorization changes', exact: true }).click();
  await panel.getByText(/Authorization saved/).waitFor();
  await api(member, sharedPath + '/messages', 'POST', { message: 'revoked send must not run', idempotencyKey: 'downgrade-denied' }, 403);
  await memberPage.reload();
  await memberPage.getByRole('textbox', { name: 'Shared message' }).waitFor();
  await until('disabled member composer', () => memberPage.getByRole('textbox', { name: 'Shared message' }).isDisabled());
  await panel.getByRole('button', { name: 'Refresh authorizations', exact: true }).click();
  await panel.getByRole('button', { name: 'Revoke authorization', exact: true }).click();
  await panel.getByText(/Authorization revoked/).waitFor();
  await api(member, sharedPath + '/messages', 'GET', undefined, 404);
  await memberPage.reload();
  await memberPage.getByText(/Shared access is no longer available/).waitFor();
  assert.equal(await memberPage.getByText('MEMBER_TOOL_OK', { exact: true }).count(), 0);
  result.checks.push('write downgrade and full revoke enforced on API and UI');
  assert.deepEqual(result.errors, []);
  const rollouts = (await readdir(join(directory, 'native/sessions'), { recursive: true })).filter(file => file.endsWith('.jsonl'));
  let starts = 0;
  for (const file of rollouts) starts += (await readFile(join(directory, 'native/sessions', file), 'utf8')).split('\n').filter(Boolean)
    .map(line => JSON.parse(line)).filter(event => event.type === 'event_msg' && event.payload?.type === 'task_started').length;
  assert.equal(starts, 2);
  result.nativeStarts = starts;
  result.passed = true;
} catch (error) {
  result.errors.push(String(error.message).slice(0, 600));
  result.failureLocation = String(error.stack).split('\n').filter(line => line.includes('verify-candidate-member-permissions.mjs:')).map(line => line.trim());
  process.exitCode = 1;
} finally {
  const cleanupFailure = message => {
    result.passed = false; result.errors.push(message); process.exitCode = 1;
  };
  try { await browser?.close(); }
  catch { cleanupFailure('Browser cleanup failed'); }
  let descendants;
  try {
    const processes = (await Promise.all((await readdir('/proc')).filter(name => /^\d+$/.test(name)).map(async name => {
      try {
        const fields = (await readFile(`/proc/${name}/stat`, 'utf8')).split(') ').at(-1).split(' ');
        assert.match(fields[0] ?? '', /^[a-zA-Z]$/);
        assert.match(fields[19] ?? '', /^\d+$/);
        assert.ok(Number.isSafeInteger(Number(fields[1])) && Number(fields[1]) >= 0);
        const environment = await readFile(`/proc/${name}/environ`, 'utf8');
        const fixtureOwned = environment.split('\0').some(value => value === `HOME=${join(directory, 'home')}`
          || value === `CODEX_HOME=${join(directory, 'native')}`);
        return { pid: Number(name), parent: Number(fields[1]), start: fields[19], fixtureOwned };
      } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
    }))).filter(Boolean);
    const owned = new Set([child.pid]);
    for (const item of processes) if (item.fixtureOwned) owned.add(item.pid);
    for (let previous = -1; previous !== owned.size;) {
      previous = owned.size;
      for (const item of processes) if (owned.has(item.parent)) owned.add(item.pid);
    }
    descendants = processes.filter(item => owned.has(item.pid));
    result.trackedDescendants = descendants.map(({ pid, parent, start }) => ({ pid, parent, start }));
    result.remainingDescendants = descendants.map(item => item.pid);
  } catch { cleanupFailure('Fixture ownership collection failed; descendant outcome unknown'); }
  try { if (!exit) child.kill('SIGTERM'); }
  catch { cleanupFailure('Original fixture stop signal failed'); }
  try {
    await until('graceful stop', () => exit, 120000);
    result.originalExitProven = true;
    assert.equal(exit.code, 0);
  } catch {
    result.originalExitProven = !!exit;
    cleanupFailure('Fixture did not exit normally; no forced kill');
  }
  try {
    assert.ok(descendants, 'Fixture descendant identities unavailable');
    await until('fixture descendants exit', async () => {
      const remaining = await Promise.all(descendants.map(async item => {
        try {
          const fields = (await readFile(`/proc/${item.pid}/stat`, 'utf8')).split(') ').at(-1).split(' ');
          assert.match(fields[0] ?? '', /^[a-zA-Z]$/);
          assert.match(fields[19] ?? '', /^\d+$/);
          return fields[19] === item.start && fields[0] !== 'Z';
        } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
      }));
      result.remainingDescendants = descendants.filter((item, index) => remaining[index]).map(item => item.pid);
      return result.remainingDescendants.length === 0;
    }, 10000);
    result.descendantsExited = descendants.map(item => item.pid);
    result.descendantDrainProven = true;
  }
  catch {
    result.descendantDrainProven = false;
    cleanupFailure('Fixture descendant drain unproven; no forced kill');
  }
  result.exit = exit;
  result.finishedAt = new Date().toISOString();
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(result));
}
