import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { verifyCandidateRelease } from './stage-candidate-release.mjs';

const [candidateRoot, command, model, providerOrigin] = process.argv.slice(2);
assert.ok(process.argv.length === 6 && isAbsolute(candidateRoot) && isAbsolute(command));
assert.match(model, /^[a-zA-Z0-9._-]+$/);
const provider = new URL(providerOrigin);
assert.ok(provider.protocol === 'http:' && provider.hostname === '127.0.0.1' && provider.port
  && !provider.username && !provider.password && !provider.search && !provider.hash && provider.pathname === '/');
const candidate = await verifyCandidateRelease(candidateRoot);
const directory = await mkdtemp('/tmp/agentopsdeck-layered-permissions-');
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
const vaultSecret = randomBytes(32).toString('hex');
let listenPort = '0';
const log = createWriteStream(join(directory, 'server.log'), { mode: 0o600 });
const launch = () => spawn(process.execPath, [join(candidateRoot, candidate.entrypoint)], {
  cwd: join(directory, 'state'), stdio: ['ignore', 'pipe', 'pipe'],
  env: { HOME: join(directory, 'home'), TMPDIR: join(directory, 'tmp'), PATH: '/usr/bin:/bin', NODE_ENV: 'production',
    CODEX_HOME: join(directory, 'native'), PORT: listenPort, AOD_LISTEN_HOST: '127.0.0.1', AOD_SERVER_ROLE: 'all',
    AOD_ACCESS_KEY: adminKey, AOD_HUB_VAULT_SECRET: vaultSecret,
    AOD_CODEX_ENABLED: 'true', AOD_CODEX_COMMAND: command, AOD_CODEX_HOME: join(directory, 'native'),
    AOD_CODEX_DEFAULT_CWD: join(directory, 'workspace'), AOD_CODEX_DEFAULT_MODEL: model,
    AOD_CODEX_MODEL_PROVIDER: 'copilot_bridge', AOD_CODEX_APPROVAL_POLICY: 'on-request',
    AOD_CONNECTOR_ENV_ID: 'parallel-codex', AOD_HUB_LOCAL_CONNECTION_ID: 'parallel-codex',
    AOD_HUB_LOCAL_EXECUTION_SETUP: 'true', AOD_LOCAL_OPENCLAW_CLI: 'false', AOD_CONNECTOR_UPDATE_ENABLED: 'false',
    AOD_MEDIA_BRIDGE_ENABLED: 'false', AOD_MEDIA_LIBRARY_ENABLED: 'false', AOD_ARTIFACT_RECEIVER_ENABLED: 'false',
    AOD_ARTIFACT_CAPABILITY_INJECTION: 'false', AOD_ARTIFACT_GATEWAY_CLIENT_ENABLED: 'false' },
});
let stdout = '', browser, exit;
let child = launch();
function attach() {
  child.stdout.on('data', chunk => { stdout += chunk; log.write(chunk); });
  child.stderr.pipe(log, { end: false });
  child.once('close', (code, signal) => { exit = { code, signal }; });
}
attach();
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
  async function api(context, path, method = 'GET', data, status = 200) {
    const response = await context.request.fetch(origin + path, { method, data, headers: { origin } });
    assert.equal(response.status(), status, method + ' ' + path);
    return response.headers()['content-type']?.includes('application/json') ? response.json() : undefined;
  }
  await api(admin, '/api/auth/login', 'POST', { accessKey: adminKey });
  const connection = '/api/hub/v1/connections/parallel-codex';
  await api(admin, connection + '/verify', 'POST', {});
  const adminPage = await admin.newPage();
  adminPage.on('dialog', dialog => dialog.accept());
  adminPage.on('pageerror', () => result.errors.push('admin pageerror'));
  await adminPage.goto(origin + '/#/tab/gateway');
  await adminPage.getByRole('button', { name: 'Member execution', exact: true }).click();
  await adminPage.getByRole('button', { name: 'Enable member sessions', exact: true }).click();
  await adminPage.getByText('Member session creation infrastructure enabled.', { exact: false }).waitFor();
  result.checks.push('Owner enables member execution in environment settings, separately from member roles');
  await adminPage.goto(origin + '/#/tab/users');
  async function member(name, width) {
    await adminPage.getByRole('textbox', { name: 'New Hub user label' }).fill(name);
    await adminPage.getByRole('button', { name: 'Create Hub record', exact: true }).click();
    const panel = adminPage.getByRole('region', { name: 'Access for ' + name, exact: true });
    await panel.waitFor();
    await panel.getByRole('button', { name: 'Issue member login key', exact: true }).click();
    const secret = panel.getByRole('textbox', { name: 'One-time member login key' });
    await secret.waitFor();
    const key = await secret.inputValue();
    await panel.getByRole('button', { name: 'Hide key', exact: true }).click();
    const matrix = panel.getByRole('region', { name: 'Permission matrix' });
    const roleSelect = matrix.getByRole('combobox').filter({ has: adminPage.locator('option[value="developer"]') });
    await roleSelect.selectOption('developer');
    await matrix.getByRole('button', { name: 'Save access', exact: true }).click();
    await matrix.getByText('Saved', { exact: true }).waitFor();
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    const page = await context.newPage();
    page.on('dialog', dialog => dialog.accept());
    page.on('pageerror', () => result.errors.push(name + ' pageerror'));
    await page.goto(origin);
    await page.getByRole('textbox', { name: 'Access key', exact: true }).fill(key);
    await page.getByRole('button', { name: 'Unlock with access key' }).click();
    await page.getByRole('heading', { name: 'Shared with me' }).waitFor();
    const identity = await api(context, '/api/hub/v1/me');
    assert.equal(identity.admin, false);
    assert.equal(await page.getByRole('textbox', { name: 'Your member ID' }).inputValue(), identity.userId);
    if (name === 'Developer Alice') {
      for (const [role, count] of [
        ['admin', 3], ['observer', 0], ['developer', 1],
      ]) {
        await roleSelect.selectOption(role);
        await matrix.getByRole('button', { name: 'Save access', exact: true }).click();
        await matrix.getByText('Saved', { exact: true }).waitFor();
        const saved = (await api(context, '/api/hub/v1/shared/grants')).grants;
        assert.equal(saved.length, count);
        if (role === 'admin') assert.ok(saved.filter(grant => grant.policy.actions.includes('messages:read')).every(grant => !grant.policy.actions.includes('messages:send')));
      }
      await adminPage.reload();
      const row = adminPage.locator('li').filter({ has: adminPage.getByRole('button', { name: 'Rename user ' + name, exact: true }) });
      await row.getByRole('button', { name: 'Manage access', exact: true }).click();
      await until('persisted Developer role', async () => await roleSelect.inputValue() === 'developer');
      assert.equal(await panel.getByRole('button', { name: 'Issue member login key', exact: true }).isVisible(), false);
      result.layout = [];
      for (const viewportWidth of [1920, 1440, 1024, 768, 390]) {
        await adminPage.setViewportSize({ width: viewportWidth, height: 1000 });
        await adminPage.getByRole('textbox', { name: 'Search Hub users' }).waitFor();
        await row.getByRole('button', { name: 'Manage access', exact: true }).click();
        await matrix.waitFor();
        const geometry = await adminPage.evaluate(() => {
          const rect = label => {
            const bounds = document.querySelector(`[aria-label="${label}"]`).getBoundingClientRect();
            return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, right: bounds.right, bottom: bounds.bottom };
          };
          return { viewportWidth: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth,
            workspace: rect('Users and access workspace'), overview: rect('People overview'),
            people: rect('Hub people'), detail: rect('Selected person access'), matrix: rect('Permission matrix') };
        });
        assert.equal(geometry.overflow, false);
        assert.ok(geometry.workspace.width >= viewportWidth * 0.75, JSON.stringify(geometry));
        assert.ok(geometry.overview.height <= 100);
        if (viewportWidth >= 1024) {
          assert.ok(geometry.detail.x >= geometry.people.right);
          assert.ok(geometry.matrix.y >= 0 && geometry.matrix.y < 450, JSON.stringify(geometry));
          assert.ok(geometry.people.height / await adminPage.locator('[aria-label="Hub people"] > li').count() < 110);
        } else {
          assert.ok(geometry.detail.y >= geometry.people.bottom);
        }
        result.layout.push(geometry);
      }
      await adminPage.setViewportSize({ width: 390, height: 844 });
      await matrix.scrollIntoViewIfNeeded();
      if (process.env.AOD_TEST_MATRIX_SCREENSHOTS === 'true') await adminPage.screenshot({ path: join(directory, 'permission-matrix-mobile.png') });
      await adminPage.setViewportSize({ width: 1440, height: 1000 });
      await row.getByRole('button', { name: 'Manage access', exact: true }).click();
      await matrix.waitFor();
      if (process.env.AOD_TEST_MATRIX_SCREENSHOTS === 'true') await adminPage.screenshot({ path: join(directory, 'permission-matrix-desktop.png') });
      result.checks.push('People master/detail uses available width at 1920/1440/1024, compact rows and first-screen matrix; tablet/mobile stack without overflow');
      result.checks.push('Visual matrix changes Connector admin/observer/developer without residual broad grants; reload is truthful, keys collapsed, mobile has no overflow');
    }
    const grants = await api(context, '/api/hub/v1/shared/grants');
    assert.equal(grants.grants.length, 1);
    assert.deepEqual(grants.grants[0].policy.actions, ['sessions:create']);
    await api(context, connection + '/execution-issuer/local', 'POST', { confirm: true, nodeVersion: 1 }, 403);
    const usage = (await api(admin, `/api/hub/v1/users/${identity.userId}/login-keys`)).keys[0];
    assert.equal(usage.loginCount, 1);
    assert.ok(usage.lastLoginAt && usage.lastUsedAt && usage.lastActiveAt);
    await api(context, '/api/auth/audit?page=true', 'GET', undefined, 403);
    return { context, page, id: identity.userId, root: grants.grants[0], width, keyId: usage.id };
  }
  const alice = await member('Developer Alice', 1440);
  const bob = await member('Developer Bob', 390);
  await adminPage.getByRole('button', { name: 'View login activity', exact: true }).click();
  const activity = adminPage.getByRole('region', { name: 'Login activity', exact: true });
  const anonymous = await browser.newContext();
  await api(anonymous, '/api/auth/login', 'POST', { accessKey: 'hub_key_synthetic_invalid' }, 401);
  await anonymous.close();
  for (let attempt = 0; attempt < 26; attempt++) await api(admin, '/api/auth/login', 'POST', { accessKey: adminKey });
  await activity.getByRole('button', { name: 'Refresh activity', exact: true }).click();
  await until('first activity page', async () => await activity.locator('li').count() === 25);
  await activity.getByRole('button', { name: 'Load older activity', exact: true }).click();
  await activity.getByText('Key login · Unattributed', { exact: true }).waitFor();
  assert.ok(await activity.locator('li').count() > 25);
  result.checks.push('Admin activity UI loads older pages and shows invalid-key failures without misattributing a user');
  await activity.getByRole('combobox', { name: 'Activity user', exact: true }).selectOption(alice.id);
  await activity.getByText('Key login · Developer Alice', { exact: true }).waitFor();
  assert.equal(await activity.getByText('Key login · Developer Bob', { exact: true }).count(), 0);
  await adminPage.setViewportSize({ width: 390, height: 844 });
  assert.equal(await adminPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await adminPage.setViewportSize({ width: 1440, height: 1000 });
  const auditBeforeRestart = (await api(admin, `/api/auth/audit?page=true&userId=${alice.id}`)).records.map(record => record.id);
  assert.equal(auditBeforeRestart.length, 6);
  result.checks.push('Actual browser member login records key usage once; admin activity filters users and fits mobile; member audit API denied');
  result.checks.push('UI creates two non-admin members, usable member IDs, create-only grants, no Connector admin delegation');
  async function createSession(actor, label) {
    await actor.page.goto(origin + '/#/tab/sessions');
    await actor.page.getByRole('button', { name: actor.width === 390 ? 'New chat' : 'New session', exact: true }).first().click();
    const dialog = actor.page.getByRole('dialog', { name: 'Create new session' });
    await until('environment selectable', async () => (await dialog.getByLabel('Environment').locator('option').allTextContents()).some(value => value.includes('shared')));
    await dialog.getByLabel('Environment').selectOption(JSON.stringify(['default', 'parallel-codex']));
    await dialog.getByLabel('Session name').fill(label);
    const accepted = actor.page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/shared/default/connections/parallel-codex/agents/codex/sessions'));
    await dialog.getByRole('button', { name: 'Create', exact: true }).click();
    const response = await accepted;
    assert.equal(response.status(), 201);
    const creation = await response.json();
    const command = response.request().postDataJSON();
    const creationPath = '/api/hub/v1/shared/default/connections/parallel-codex/agents/codex/sessions';
    assert.equal((await api(actor.context, creationPath, 'POST', command, 201)).key, creation.key);
    const receipt = await api(actor.context, creationPath + '/creation-commands/' + command.idempotencyKey);
    assert.equal(receipt.command.state, 'accepted');
    const path = '/api/hub/v1/shared/default/sessions/' + encodeURIComponent(creation.key);
    await actor.page.getByRole('textbox', { name: 'Shared message' }).waitFor();
    await until('creator can chat', async () => !(await actor.page.getByRole('textbox', { name: 'Shared message' }).isDisabled()));
    await actor.page.reload();
    await actor.page.getByRole('button', { name: 'Share session', exact: true }).waitFor();
    assert.equal(await actor.page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    return { key: creation.key, path, url: actor.page.url(), command, creationPath };
  }
  const first = await createSession(alice, 'Alice exact session');
  const second = await createSession(bob, 'Bob exact session');
  async function restart() {
    listenPort = new URL(origin).port;
    child.kill('SIGTERM');
    await until('fixture restart drain', () => exit, 120000);
    assert.equal(exit.code, 0);
    stdout = ''; exit = undefined; child = launch(); attach();
    await until('fixture restart listener', () => { assert.equal(exit, undefined); return stdout.includes('AgentOpsDeck server listening on ' + origin); }, 25000);
  }
  await restart();
  assert.deepEqual((await api(admin, `/api/auth/audit?page=true&userId=${alice.id}`)).records.map(record => record.id), auditBeforeRestart);
  assert.equal((await api(admin, `/api/hub/v1/users/${alice.id}/login-keys`)).keys[0].loginCount, 1);
  for (const [actor, session] of [[alice, first], [bob, second]]) {
    assert.equal((await api(actor.context, session.creationPath + '/creation-commands/' + session.command.idempotencyKey)).command.state, 'accepted');
    const restored = await actor.context.request.get(origin + session.path + '/messages');
    assert.equal(restored.status(), 200, 'restart history: ' + await restored.text());
    await actor.page.reload();
    await actor.page.getByRole('button', { name: 'Share session', exact: true }).waitFor();
  }
  assert.equal((await api(admin, '/api/hub/v1/sessions/state')).groups.flatMap(group => group.sessions).length, 2);
  result.checks.push('real process restart preserves original creation receipts and ownership without duplicate sessions');
  for (const [actor, own, other] of [[alice, first, second], [bob, second, first]]) {
    const grants = (await api(actor.context, '/api/hub/v1/shared/grants')).grants;
    assert.equal(grants.length, 2);
    assert.equal(grants.filter(grant => grant.policy.sessionKey).length, 1);
    assert.equal(grants.some(grant => grant.sessionId === other.key), false);
    assert.equal((await api(actor.context, own.path + '/messages')).access.sessionsShare, true);
    assert.equal((await api(actor.context, '/api/hub/v1/sessions/state')).groups.flatMap(group => group.sessions).length, 0);
    for (const endpoint of ['/messages', '/state', '/events/stream', '/collaborators', '/commands/other-key']) {
      await api(actor.context, other.path + endpoint, 'GET', undefined, 404);
    }
    await api(actor.context, other.path + '/messages', 'POST', { message: 'must not execute', idempotencyKey: 'cross-denied' }, 404);
    await api(actor.context, '/api/hub/v1/sessions/' + encodeURIComponent(own.key) + '/messages', 'GET', undefined, 404);
    await api(actor.context, other.creationPath + '/creation-commands/' + other.command.idempotencyKey, 'GET', undefined, 404);
  }
  result.checks.push('desktop/mobile UI creation, reload and idempotent receipt; mutual discovery/read/send/events/receipt and owner-route isolation');
  async function roleMember(label, role) {
    const { user } = await api(admin, '/api/hub/v1/users', 'POST', { label }, 201);
    const { token } = await api(admin, `/api/hub/v1/users/${user.id}/login-keys`, 'POST', {}, 201);
    const membershipPath = `/api/hub/v1/access/default/connections/parallel-codex/members/${user.id}`;
    const settings = await api(admin, connection + '/grants');
    await api(admin, membershipPath, 'PUT', { role, version: 0, nodeVersion: settings.nodeVersion, migrateLegacy: false,
      environments: { codex: role === 'admin' ? 'developer' : 'observer', openclaw: role === 'admin' ? 'observer' : 'disabled' } });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await api(context, '/api/auth/login', 'POST', { accessKey: token });
    return { id: user.id, context, membershipPath, page: await context.newPage() };
  }
  const manager = await roleMember('Connector Manager', 'admin');
  for (const session of [first, second]) {
    assert.equal((await api(manager.context, session.path + '/messages')).access.messagesSend, false);
    await api(manager.context, session.path + '/messages', 'POST', { message: 'must not execute', idempotencyKey: 'manager-denied' }, 403);
    await api(manager.context, session.path + '/collaborators', 'GET', undefined, 403);
  }
  await manager.page.goto(origin + '/#/tab/users');
  await manager.page.getByRole('region', { name: 'Connector member management' }).waitFor();
  await manager.page.getByRole('combobox', { name: 'Manage Connector member' }).selectOption(alice.id);
  const managerMatrix = manager.page.getByRole('region', { name: 'Permission matrix' });
  await managerMatrix.getByText('Managed role', { exact: true }).waitFor();
  assert.equal(await managerMatrix.getByRole('combobox').locator('option[value="admin"]').isDisabled(), true);
  assert.equal(await manager.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const rolePath = `/api/hub/v1/access/users/${manager.id}/hub-role`;
  await api(manager.context, rolePath, 'PUT', { role: 'admin', version: 0 }, 403);
  await api(admin, rolePath, 'PUT', { role: 'admin', version: 0 });
  assert.equal((await api(manager.context, '/api/hub/v1/me')).admin, true);
  let managerMembership = await api(admin, manager.membershipPath);
  await api(admin, manager.membershipPath, 'PUT', { role: 'none', version: managerMembership.version, nodeVersion: managerMembership.nodeVersion,
    environments: { codex: 'disabled', openclaw: 'disabled' }, migrateLegacy: false });
  assert.equal((await api(manager.context, first.path + '/messages')).access.messagesSend, false);
  await api(admin, rolePath, 'PUT', { role: 'member', version: 1 });
  assert.equal((await api(manager.context, '/api/hub/v1/me')).admin, false);
  await api(manager.context, first.path + '/messages', 'GET', undefined, 404);
  result.checks.push('Connector manager reads both members but cannot send/share; delegated management UI disallows admin assignment; Hub promotion/demotion updates existing cookies without residual inherited access');
  const observer = await roleMember('Session Observer', 'observer');
  assert.equal((await api(observer.context, '/api/hub/v1/shared/grants')).grants.length, 0);
  assert.equal((await api(observer.context, '/api/hub/v1/shared/creation-environments')).environments.length, 0);
  await api(observer.context, first.path + '/messages', 'GET', undefined, 404);
  await adminPage.goto(origin + '/#/session/' + encodeURIComponent(first.key));
  const ownerSharing = adminPage.getByRole('region', { name: 'Session sharing', exact: true });
  await ownerSharing.getByRole('button', { name: 'Share session', exact: true }).click();
  await ownerSharing.getByRole('combobox', { name: 'Share with member', exact: true }).selectOption(observer.id);
  await ownerSharing.getByRole('button', { name: 'Share', exact: true }).click();
  await ownerSharing.getByRole('button', { name: 'Remove access', exact: true }).waitFor();
  await observer.page.goto(first.url);
  await observer.page.getByRole('textbox', { name: 'Shared message' }).waitFor();
  assert.equal(await observer.page.getByRole('textbox', { name: 'Shared message' }).isDisabled(), true);
  await ownerSharing.getByText('Session permissions', { exact: true }).click();
  assert.equal(await ownerSharing.getByRole('checkbox', { name: 'Chat', exact: true }).isDisabled(), true);
  await ownerSharing.getByRole('checkbox', { name: 'Attachments', exact: true }).check();
  await ownerSharing.getByRole('button', { name: 'Save session permissions', exact: true }).click();
  await ownerSharing.getByText('Access saved.', { exact: true }).waitFor();
  await ownerSharing.getByRole('button', { name: 'Remove access', exact: true }).click();
  await observer.page.getByText(/Shared access is no longer available/).waitFor({ timeout: 20000 });
  await api(observer.context, first.path + '/messages', 'GET', undefined, 404);
  result.checks.push('Owner session panel shares to a real observer, limits Chat, edits attachments and revokes live access; no fabricated creator ownership');
  async function share(role) {
    const panel = alice.page.getByRole('region', { name: 'Session sharing', exact: true });
    if (await panel.getByRole('button', { name: 'Share session', exact: true }).count()) await panel.getByRole('button', { name: 'Share session', exact: true }).click();
    await panel.getByRole('combobox', { name: 'Share with member', exact: true }).selectOption(bob.id);
    await panel.getByRole('combobox', { name: 'Session sharing role' }).selectOption(role);
    await panel.getByRole('button', { name: 'Share', exact: true }).click();
    await panel.getByRole('button', { name: 'Remove access', exact: true }).waitFor();
    if (bob.page.url() === first.url && await bob.page.getByRole('button', { name: 'Check access again', exact: true }).count()) {
      await bob.page.getByRole('button', { name: 'Check access again', exact: true }).click();
    } else {
      await bob.page.goto(first.url);
      await bob.page.reload();
    }
    await bob.page.getByRole('textbox', { name: 'Shared message' }).waitFor();
    await until('sharing read settled', async () => (await api(bob.context, first.path + '/messages')).access.messagesSend === (role === 'collaborator'));
    return panel;
  }
  const sharing = await share('observer');
  assert.equal(await bob.page.getByRole('textbox', { name: 'Shared message' }).isDisabled(), true);
  await api(bob.context, first.path + '/messages', 'POST', { message: 'must not execute', idempotencyKey: 'observer-denied' }, 403);
  await api(bob.context, first.path + '/collaborators', 'POST', { userId: alice.id, role: 'collaborator' }, 403);
  await sharing.getByRole('button', { name: 'Remove access', exact: true }).click();
  await sharing.getByText('No explicit session collaborators.').waitFor();
  await bob.page.getByText(/Shared access is no longer available/).waitFor({ timeout: 20000 });
  await api(bob.context, first.path + '/events/stream', 'GET', undefined, 404);
  await share('collaborator');
  await until('collaborator composer', async () => !(await bob.page.getByRole('textbox', { name: 'Shared message' }).isDisabled()));
  const prompt = 'Execute exactly this harmless command once: ' + process.execPath + ' ' + join(directory, 'workspace/probe.mjs') + '. It only reads and writes the temporary fixture workspace. Wait for completion, then reply exactly MEMBER_TOOL_OK. Do not use other tools or paths.';
  await bob.page.getByRole('textbox', { name: 'Shared message' }).fill(prompt);
  const messageAccepted = bob.page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(first.path + '/messages'));
  await bob.page.getByRole('button', { name: 'Send', exact: true }).click();
  const sent = await messageAccepted;
  assert.ok([200, 202].includes(sent.status()));
  const messageCommand = sent.request().postDataJSON();
  await until('installed Codex real tool reply', async () => {
    const state = await api(bob.context, first.path + '/state');
    assert.notEqual(state.runtime?.phase, 'failed');
    if (state.runtime?.phase !== 'completed' || state.runtime?.sync !== 'current' || state.hasActiveRun) return false;
    return (await api(bob.context, first.path + '/messages')).messages.some(message => message.role === 'assistant' && message.text.trim() === 'MEMBER_TOOL_OK');
  });
  assert.equal(await readFile(join(directory, 'workspace/output.txt'), 'utf8'), nonce);
  await bob.page.getByText('MEMBER_TOOL_OK', { exact: true }).first().waitFor();
  await alice.page.getByText('MEMBER_TOOL_OK', { exact: true }).first().waitFor();
  await api(alice.context, first.path + '/commands/' + messageCommand.idempotencyKey, 'GET', undefined, 404);
  await bob.page.reload();
  await bob.page.getByRole('textbox', { name: 'Shared message' }).fill('Reply exactly MEMBER_MOBILE_OK. No tools.');
  await bob.page.getByRole('button', { name: 'Send', exact: true }).click();
  await until('mobile native followup', async () => {
    const state = await api(bob.context, first.path + '/state');
    assert.notEqual(state.runtime?.phase, 'failed');
    return state.runtime?.phase === 'completed' && state.runtime?.sync === 'current' && !state.hasActiveRun
      && (await api(bob.context, first.path + '/messages')).messages.some(message => message.role === 'assistant' && message.text.trim() === 'MEMBER_MOBILE_OK');
  });
  await bob.page.getByText('MEMBER_MOBILE_OK', { exact: true }).first().waitFor();
  assert.equal(await bob.page.getByText('Execution has not been confirmed.', { exact: false }).count(), 0);
  await bob.page.getByText('Message accepted. Follow its progress in the conversation.', { exact: true }).waitFor();
  for (const [page, filename] of [[alice.page, 'creator-sharing-desktop.png'], [bob.page, 'collaborator-mobile.png']]) {
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    if (process.env.AOD_TEST_SCREENSHOTS !== 'false') await page.screenshot({ path: join(directory, filename) });
  }
  result.checks.push('observer read-only; UI revoke clears live SSE; collaborator installed Codex real tools, mobile followup, creator sees reply; receipt actor isolation');
  const membershipPath = `/api/hub/v1/access/default/connections/parallel-codex/members/${alice.id}`;
  const membership = await api(admin, membershipPath);
  await api(admin, membershipPath, 'PUT', { role: 'none', version: membership.version, nodeVersion: membership.nodeVersion,
    environments: { codex: 'disabled', openclaw: 'disabled' }, migrateLegacy: false });
  for (const actor of [alice, bob]) {
    await actor.page.getByText(/Shared access is no longer available/).waitFor({ timeout: 20000 });
    assert.equal(await actor.page.getByText('MEMBER_TOOL_OK', { exact: true }).count(), 0);
    await api(actor.context, first.path + '/messages', 'GET', undefined, 404);
    await api(actor.context, first.path + '/events/stream', 'GET', undefined, 404);
  }
  assert.equal((await api(alice.context, '/api/hub/v1/shared/creation-environments')).environments.length, 0);
  assert.equal((await api(bob.context, second.path + '/messages')).access.messagesSend, true);
  const allGrants = (await api(admin, connection + '/grants')).grants;
  const bobSession = (await api(bob.context, '/api/hub/v1/shared/grants')).grants.find(grant => grant.policy.sessionKey)?.policy.sessionKey;
  const derived = allGrants.filter(grant => grant.policy.sessionKey && grant.policy.sessionKey !== bobSession);
  assert.ok(derived.length >= 3 && derived.every(grant => grant.revoked));
  await restart();
  for (const actor of [alice, bob]) await api(actor.context, first.path + '/messages', 'GET', undefined, 404);
  assert.equal((await api(bob.context, second.path + '/messages')).access.messagesSend, true);
  result.checks.push('environment parent revoke cascades creator and collaborator, clears both live browsers, unrelated member session remains usable');
  await api(alice.context, '/api/auth/logout', 'POST', {});
  const logout = (await api(admin, `/api/auth/audit?page=true&userId=${alice.id}`)).records[0];
  assert.equal(logout.event, 'access_key_logout');
  assert.equal(logout.keyId, alice.keyId);
  assert.equal(logout.authMethod, 'member');
  await api(admin, `/api/hub/v1/users/${bob.id}/login-keys/${bob.keyId}`, 'DELETE');
  await api(bob.context, '/api/hub/v1/me', 'GET', undefined, 401);
  const revoked = (await api(admin, `/api/auth/audit?page=true&userId=${bob.id}`)).records[0];
  assert.equal(revoked.event, 'member_key_revoked');
  assert.equal(revoked.actorUserId, 'default');
  await adminPage.goto(origin + '/#/tab/users');
  await adminPage.reload();
  await adminPage.getByRole('button', { name: 'View login activity', exact: true }).click();
  await activity.getByRole('combobox', { name: 'Activity user', exact: true }).selectOption(bob.id);
  await activity.getByText('Key revoked · Developer Bob', { exact: true }).waitFor();
  result.checks.push('Audit and login counts survive actual restarts; member logout is correctly attributed, key revoke invalidates cookie and remains visible in admin UI');
  const rollouts = (await readdir(join(directory, 'native/sessions'), { recursive: true })).filter(file => file.endsWith('.jsonl'));
  let starts = 0;
  for (const file of rollouts) starts += (await readFile(join(directory, 'native/sessions', file), 'utf8')).split('\n').filter(Boolean)
    .map(line => JSON.parse(line)).filter(event => event.type === 'event_msg' && event.payload?.type === 'task_started').length;
  assert.ok(rollouts.length >= 1 && rollouts.length <= 2);
  assert.equal(starts, 2);
  result.nativeStarts = starts;
  assert.deepEqual(result.errors, []);
  result.passed = true;
} catch (error) {
  result.errors.push('Candidate layered-permissions verification failed');
  result.failureLocation = [...String(error?.stack ?? '').slice(0, 20000).matchAll(/verify-candidate-layered-permissions\.mjs:(\d{1,7}):(\d{1,7})\b/g)]
    .slice(0, 8).map(match => `verify-candidate-layered-permissions.mjs:${match[1]}:${match[2]}`);
  process.exitCode = 1;

} finally {
  await browser?.close();
  const processes = (await Promise.all((await readdir('/proc')).filter(name => /^\d+$/.test(name)).map(async name => {
    try {
      const fields = (await readFile(`/proc/${name}/stat`, 'utf8')).split(') ').at(-1).split(' ');
      const environment = await readFile(`/proc/${name}/environ`, 'utf8').catch(() => '');
      const fixtureOwned = environment.split('\0').some(value => value === `HOME=${join(directory, 'home')}`
        || value === `CODEX_HOME=${join(directory, 'native')}`);
      return { pid: Number(name), parent: Number(fields[1]), start: fields[19], fixtureOwned };
    } catch { return undefined; }
  }))).filter(Boolean);
  const owned = new Set([child.pid]);
  for (const item of processes) if (item.fixtureOwned) owned.add(item.pid);
  for (let previous = -1; previous !== owned.size;) {
    previous = owned.size;
    for (const item of processes) if (owned.has(item.parent)) owned.add(item.pid);
  }
  const descendants = processes.filter(item => owned.has(item.pid));
  child.kill('SIGTERM');
  try {
    await until('graceful stop', () => exit, 120000); assert.equal(exit.code, 0);
    await until('fixture descendants exit', async () => {
      const remaining = await Promise.all(descendants.map(async item => {
        try {
          const fields = (await readFile(`/proc/${item.pid}/stat`, 'utf8')).split(') ').at(-1).split(' ');
          return fields[19] === item.start && fields[0] !== 'Z';
        } catch { return false; }
      }));
      result.remainingDescendants = descendants.filter((item, index) => remaining[index]).map(item => item.pid);
      return result.remainingDescendants.length === 0;
    }, 10000);
    result.descendantsExited = descendants.map(item => item.pid);
    if (result.passed) {
      const hubDatabase = new DatabaseSync(join(directory, 'state/.agentopsdeck-hub.sqlite'), { readOnly: true });
      const connectorDatabase = new DatabaseSync(join(directory, 'state/.agentopsdeck-connector-users.sqlite'), { readOnly: true });
      try {
        const leases = hubDatabase.prepare('SELECT state FROM hub_execution_leases').all();
        const executionGrants = connectorDatabase.prepare('SELECT revoked FROM connector_execution_grants').all();
        assert.ok(leases.length > 0 && leases.every(lease => lease.state === 'revoked'));
        assert.ok(executionGrants.length > 0 && executionGrants.every(grant => grant.revoked === 1));
        result.checks.push('Hub execution leases and Connector execution grants remain revoked after real restart');
      } finally { hubDatabase.close(); connectorDatabase.close(); }
    }
  }
  catch { result.passed = false; result.errors.push('Fixture shutdown or stopped-database verification failed'); process.exitCode = 1; }
  result.exit = exit;
  log.end();
  result.finishedAt = new Date().toISOString();
  await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(result));
}
