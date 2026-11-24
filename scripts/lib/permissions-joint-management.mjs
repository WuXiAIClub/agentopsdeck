import assert from 'node:assert/strict';
import { jointBrowserAction } from './permissions-joint-browser-action.mjs';

// Operate only a newly created disposable user through the actual candidate UI.
// No request interception, storage snapshots, screenshots or secret logging.
export async function verifyJointManagement({ browser, context, origin, request, check }) {
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const oldMember = await browser.newContext();
  let phase = 'open management page';
  let pageErrors = 0;
  page.on('pageerror', () => { pageErrors++; });
  const response = (method, path) => page.waitForResponse(value => value.request().method() === method
    && new URL(value.url()).pathname === path);
  async function submit(scope, button, path, status = 200, dialogTitle) {
    await scope.getByRole('button', { name: button, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: dialogTitle, exact: true });
    await dialog.waitFor();
    const saved = await jointBrowserAction(() => response('PUT', path),
      () => dialog.getByRole('button', { name: button, exact: true }).click());
    assert.equal(saved.status(), status);
  }
  async function memberFetch(path, method = 'GET', data, status = 200) {
    const value = await oldMember.request.fetch(origin + path, { method, data, headers: { origin }, timeout: 15_000 });
    assert.equal(value.status(), status);
    return value.headers()['content-type']?.includes('application/json') ? value.json() : undefined;
  }
  try {
    await page.goto(origin + '/#/tab/users');
    await page.getByRole('textbox', { name: 'New Hub user label', exact: true }).fill('Joint management page');
    const createdResponse = await jointBrowserAction(() => response('POST', '/api/hub/v1/users'),
      () => page.getByRole('button', { name: 'Create Hub record', exact: true }).click());
    assert.equal(createdResponse.status(), 201);
    const { user } = await createdResponse.json();
    assert.ok(user?.id && user.id !== 'default');
    const panel = page.getByRole('region', { name: 'Access for Joint management page', exact: true });
    await panel.getByText('Account enabled · version 0', { exact: true }).waitFor();
    let matrix = panel.getByRole('region', { name: 'Permission matrix', exact: true });
    const rolePath = `/api/hub/v1/access/users/${user.id}/hub-role`;
    phase = 'Hub role promotion and demotion';
    for (const role of ['admin', 'member']) {
      await matrix.getByRole('combobox', { name: 'Hub role', exact: true }).selectOption(role);
      await submit(matrix, 'Save Hub role', rolePath, 200, 'Change Hub role?');
      assert.equal((await request(rolePath)).role, role);
    }
    check('Actual administrator page creates a user and saves both Hub role transitions against the real backend');

    phase = 'Connector role save';
    const directory = await request('/api/hub/v1/access/directory');
    const index = directory.connections.findIndex(item => item.ownerUserId === 'default' && item.id === 'isolated-codex');
    assert.ok(index >= 0);
    const connection = directory.connections[index];
    const memberPath = `/api/hub/v1/access/default/connections/isolated-codex/members/${user.id}`;
    const row = () => matrix.locator('article').nth(index);
    const roleSelect = () => row().getByRole('combobox', { name: `${connection.label} role`, exact: true });
    await roleSelect().selectOption('developer');
    await submit(row(), 'Save access', memberPath, 200, 'Change environment access?');
    let membership = await request(memberPath);
    assert.equal(membership.role, 'developer');
    assert.equal(membership.environments.codex, 'developer');
    check('Actual administrator page saves Connector/environment authority with a verified current grant-set snapshot');

    phase = 'stale management snapshot';
    let writes = 0;
    page.on('request', value => { if (value.method() === 'PUT' && new URL(value.url()).pathname === memberPath) writes++; });
    await roleSelect().selectOption('observer');
    await row().getByRole('button', { name: 'Save access', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Change environment access?', exact: true });
    await dialog.waitFor();
    // A real independent administrator mutation invalidates the displayed CAS.
    await request(memberPath, 'PUT', { role: 'none', environments: { codex: 'disabled', openclaw: 'disabled' },
      version: membership.version, nodeVersion: connection.nodeVersion, grantSetDigest: membership.grantSetDigest, migrateLegacy: false });
    const conflict = await jointBrowserAction(() => response('PUT', memberPath),
      () => dialog.getByRole('button', { name: 'Save access', exact: true }).click());
    assert.equal(conflict.status(), 409);
    await row().getByText('Result unconfirmed. Refresh roles before retrying.', { exact: true }).waitFor();
    assert.equal(await roleSelect().isDisabled(), true);
    assert.equal(writes, 1, 'Stale management save must not automatically retry');
    assert.equal((await request(memberPath)).role, 'none');
    await matrix.getByRole('button', { name: 'Refresh roles', exact: true }).click();
    await roleSelect().selectOption('developer');
    await submit(row(), 'Save access', memberPath, 200, 'Change environment access?');
    membership = await request(memberPath);
    assert.equal(membership.role, 'developer');
    assert.equal(writes, 2);
    check('Actual concurrent administrator save returns 409, locks stale form and requires explicit refresh before a new reviewed save');

    phase = 'one-time key and account disable';
    const keys = panel.getByLabel('Member login keys', { exact: true });
    if (!await keys.evaluate(node => node.open)) await panel.getByText('Login & keys', { exact: true }).click();
    await panel.getByRole('button', { name: 'Issue member login key', exact: true }).click();
    const secret = panel.getByRole('textbox', { name: 'One-time member login key', exact: true });
    await secret.waitFor();
    const token = await secret.inputValue();
    assert.ok(token.length > 20);
    await memberFetch('/api/auth/login', 'POST', { accessKey: token });
    assert.equal((await memberFetch('/api/hub/v1/me')).userId, user.id);
    const accessPath = `/api/hub/v1/users/${user.id}/access`;
    await panel.getByRole('button', { name: 'Disable account', exact: true }).click();
    const disableDialog = page.getByRole('dialog', { name: 'Disable account', exact: true });
    const disabled = await jointBrowserAction(() => response('PATCH', accessPath),
      () => disableDialog.getByRole('button', { name: 'Disable account', exact: true }).click());
    assert.equal(disabled.status(), 200);
    await panel.getByText('Account disabled · version 1', { exact: true }).waitFor();
    assert.equal(await secret.count(), 0);
    assert.equal(await panel.getByRole('button', { name: 'Issue member login key', exact: true }).isDisabled(), true);
    await memberFetch('/api/hub/v1/me', 'GET', undefined, 401);
    check('Actual account-disable UI hides the one-time key, gates future issuance and revokes an already authenticated member cookie');

    phase = 'restore requires refresh and fresh key';
    await panel.getByRole('button', { name: 'Refresh account & keys', exact: true }).click();
    await panel.getByRole('button', { name: 'Restore account', exact: true }).click();
    const restoreDialog = page.getByRole('dialog', { name: 'Restore account', exact: true });
    const restored = await jointBrowserAction(() => response('PATCH', accessPath),
      () => restoreDialog.getByRole('button', { name: 'Restore account', exact: true }).click());
    assert.equal(restored.status(), 200);
    await panel.getByText('Account enabled · version 2', { exact: true }).waitFor();
    await memberFetch('/api/hub/v1/me', 'GET', undefined, 401);
    await memberFetch('/api/auth/login', 'POST', { accessKey: token }, 401);
    await panel.getByRole('button', { name: 'Refresh account & keys', exact: true }).click();
    await panel.getByRole('button', { name: 'Issue member login key', exact: true }).click();
    await secret.waitFor();
    const freshToken = await secret.inputValue();
    assert.ok(freshToken !== token && freshToken.length > 20);
    await memberFetch('/api/auth/login', 'POST', { accessKey: freshToken });
    const me = await memberFetch('/api/hub/v1/me');
    assert.equal(me.userId, user.id); assert.equal(me.admin, false);
    assert.deepEqual((await memberFetch('/api/hub/v1/shared/grants')).grants, []);
    check('Actual restore/fresh-key UI does not revive the old Key, Cookie, Hub administration or revoked grants');
    assert.equal(pageErrors, 0, 'Management page must not report uncaught JavaScript errors');
    return { passed: true, realBackend: true, accountLifecycle: true, roleCas: true };
  } catch {
    throw new Error(`Management browser acceptance failed: ${phase}; sensitive call details omitted`);
  } finally {
    await oldMember.close(); await page.close();
  }
}
