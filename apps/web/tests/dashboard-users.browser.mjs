import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const { chromium } = await import(process.env.AOD_TEST_PLAYWRIGHT
  ? pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href : 'playwright');
const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false,
  plugins: [react(), tailwindcss()], logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
let browser;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.AOD_TEST_CHROMIUM });
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    const errors = [], writes = [], unexpected = [];
    let hubFails = true, connectorFails = false, empty = false, reportZero = false, denyWrite = false;
    let connectorReads = 0;
    const sessionKey = `local:${Buffer.from('codex:dashboard-fixture').toString('base64url')}`;
    const connection = { id: 'local', label: 'Parallel Codex', kind: 'local', status: 'connected',
      ownerUserId: 'default', ownerUserLabel: 'Default local user', capabilities: [] };
    const users = [{ id: 'default', label: 'Default local user', createdAt: 1, updatedAt: 1 }];
    const accounts = [{ id: 'default', label: 'Default connector account', createdAt: 1, updatedAt: 1 }];
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) { unexpected.push(url.origin); return route.abort(); }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const path = url.pathname;
      if (request.method() !== 'GET') {
        writes.push(`${request.method()} ${path}`);
        if (denyWrite) return route.fulfill({ status: 403, json: { error: 'Administrator permission required' } });
        const rows = path.includes('connector-users') ? accounts : users;
        const label = request.postDataJSON().label;
        let user;
        if (request.method() === 'POST' && ['/api/hub/v1/users', '/api/hub/v1/connections/local/connector-users'].includes(path)) {
          user = { id: `record-${rows.length}`, label, createdAt: 1, updatedAt: 2 };
          rows.push(user);
        } else if (request.method() === 'PATCH' && /\/(users|connector-users)\/record-\d+$/.test(path)) {
          user = rows.find(item => item.id === path.split('/').at(-1));
          user.label = label;
        } else { unexpected.push(`${request.method()} ${path}`); return route.abort(); }
        await new Promise(resolve => setTimeout(resolve, 150));
        return route.fulfill({ json: { user, updatedAt: 2 } });
      }
      if (path === '/api/auth/status') return route.fulfill({ json: { authenticated: true, recoveryScope: 'a'.repeat(64), passkeys: { available: false, count: 0 } } });
      if (path === '/api/hub/v1/me') return route.fulfill({ json: { userId: 'default', admin: true } });
      if (path === '/api/hub/v1/sessions/state') return route.fulfill({ json: {
        groups: empty ? [] : [{ agentId: 'codex', sessions: [{ sessionKey, agentId: 'codex', title: 'Dashboard conversation',
          source: 'codex', envConnectionId: 'local', status: 'idle', messageCount: 17, totalTokens: 78,
          ...(reportZero ? { inputTokens: 0, outputTokens: 0 } : {}), lastActiveAt: 1 }] }],
        connections: [connection, { ...connection, id: 'remote', label: 'Offline node', kind: 'remote' }], updatedAt: empty ? 3 : reportZero ? 2 : 1, revision: `fixture-${empty}-${reportZero}`, viewKey: 'fixture',
        sourceStates: [{ connectionId: 'local', authority: 1, state: 'ready', cursor: `ce1_11111111-1111-4111-8111-111111111111:${empty ? 3 : reportZero ? 2 : 1}` },
          { connectionId: 'remote', authority: 1, state: 'unavailable' }],
      } });
      if (path === '/api/agents') return route.fulfill({ json: { agents: [{ id: 'codex', label: 'Codex' }] } });
      if (path === '/api/gateway/status') return route.fulfill({ json: { enabled: false, connected: false, status: 'disabled',
        error: 'OpenClaw is disabled on this Connector. Codex runs independently.' } });
      if (path === '/api/hub/v1/users') return route.fulfill(hubFails
        ? { status: 503, json: { error: 'Synthetic Hub unavailable' } } : { json: { users, updatedAt: 1 } });
      if (path === '/api/hub/v1/connector-users') {
        connectorReads++;
        return route.fulfill(connectorFails ? { status: 503, json: { error: 'Synthetic Connector unavailable' } }
          : { json: { connections: [{ ...connection, supported: true, users: accounts, userCount: accounts.length }], updatedAt: 1 } });
      }
      if (path.endsWith('/messages')) return route.fulfill({ json: { messages: [], updatedAt: 1 } });
      if (path.endsWith('/queue')) return route.fulfill({ json: { items: [] } });
      return route.fulfill({ status: 404, json: {} });
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/#/tab/dashboard`);
    await page.getByRole('heading', { name: 'Workspace overview' }).waitFor();
    const row = label => page.locator('dl > div').filter({ has: page.locator('dt', { hasText: label }) });
    await row('Reported input tokens').getByText('Not reported', { exact: true }).waitFor();
    assert.equal(await row('Projected token total').locator('dd').textContent(), '78');
    assert.equal(await page.getByText('/api/events/stream active', { exact: true }).count(), 0);
    await page.getByText('ready', { exact: true }).waitFor();
    await page.getByText('unavailable', { exact: true }).waitFor();
    await page.getByText('OpenClaw Gateway: disabled.', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const metrics = await page.evaluate(async () => {
      const { dashboardMetrics } = await import('/src/lib/session-utils.ts');
      return dashboardMetrics({ groups: [{ agentId: 'codex', sessions: [
        { inputTokens: 0, outputTokens: 9, totalTokens: 78 }, {},
        { inputTokens: -1, outputTokens: NaN, totalTokens: Infinity },
      ] }], updatedAt: 1 }, [{ id: 'other' }]);
    });
    assert.deepEqual([metrics.agents, metrics.inputReported, metrics.outputReported, metrics.projectedReported,
      metrics.inputTokens, metrics.outputTokens, metrics.contextTokens], [2, 1, 1, 1, 0, 9, 78]);
    const equivalence = await page.evaluate(async () => {
      const { dashboardMetrics, effectiveSessionStatus, estimateMessageCount, estimateSessionListTokens,
        formatNumber, formatCompactNumber, formatTokenValue } = await import('/src/lib/session-utils.ts');
      // Original multi-pass implementation: preserve missing-value, status and sum-order semantics.
      const reference = (state, agents) => {
        const rows = state.groups.flatMap(group => group.sessions);
        const reported = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
        return {
          sessions: rows.length,
          agents: new Set([...agents.map(agent => agent.id), ...state.groups.map(group => group.agentId)]).size,
          running: rows.filter(row => effectiveSessionStatus(row) === 'running').length,
          failed: rows.filter(row => effectiveSessionStatus(row) === 'failed').length,
          messages: rows.reduce((sum, row) => sum + estimateMessageCount(row), 0),
          inputTokens: rows.reduce((sum, row) => sum + (reported(row.inputTokens) ? row.inputTokens : 0), 0),
          outputTokens: rows.reduce((sum, row) => sum + (reported(row.outputTokens) ? row.outputTokens : 0), 0),
          contextTokens: rows.reduce((sum, row) => sum + (reported(row.totalTokens) ? row.totalTokens : 0), 0),
          inputReported: rows.filter(row => reported(row.inputTokens)).length,
          outputReported: rows.filter(row => reported(row.outputTokens)).length,
          projectedReported: rows.filter(row => reported(row.totalTokens)).length,
          estimatedTokens: rows.reduce((sum, row) => sum + estimateSessionListTokens(row), 0),
        };
      };
      const values = [undefined, null, NaN, Infinity, -Infinity, -1, -0, 0, .1, .2, 999, 1234.5, 1e20, '42'];
      const statuses = ['idle', 'running', 'failed', 'pending_subagent', undefined];
      const rows = Array.from({ length: 140 }, (_, i) => Object.freeze({
        sessionKey: `test:${i}`, title: `测试 ${i}`, recent: i % 2 ? 'recent' : undefined,
        status: statuses[i % statuses.length], hasActiveRun: i % 2 === 0, pendingSubagentCount: i % 3,
        structuredStatus: i % 4 ? undefined : Object.freeze({ runState: 'idle', childState: 'idle',
          pendingSubagentCount: 0, hasActiveRun: false, displayStatus: statuses[(i + 1) % 4] }),
        messageCount: values[i % values.length], messagesCount: '17',
        inputTokens: values[i % values.length], outputTokens: values[(i + 3) % values.length],
        totalTokens: values[(i + 5) % values.length], estimatedTokens: values[(i + 7) % values.length],
      }));
      let metricCases = 0;
      for (const sample of [[], rows.slice(0, 1), rows, [...rows].reverse()]) {
        const groups = [
          { agentId: 'codex', sessions: sample.slice(0, 40) },
          { agentId: 'codex', sessions: sample.slice(40) },
          { agentId: 'empty', sessions: [] },
        ];
        for (const group of groups) { Object.freeze(group.sessions); Object.freeze(group); }
        for (const state of [{ groups: [], updatedAt: 1 }, { groups, updatedAt: 1 }]) {
          Object.freeze(state.groups); Object.freeze(state);
          const agents = Object.freeze([{ id: 'codex' }, { id: 'codex' }, { id: 'other' }].map(Object.freeze));
          const expected = reference(state, agents), actual = dashboardMetrics(state, agents);
          for (const key of Object.keys(expected)) {
            if (!Object.is(actual[key], expected[key])) throw new Error(`metric mismatch: ${key}`);
          }
          metricCases++;
        }
      }
      for (const value of values) {
        const number = new Intl.NumberFormat('en-US').format(Math.round(value));
        const compact = Number.isFinite(Number(value))
          ? new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(Number(value)) : 'n/a';
        if (formatNumber(value) !== number || formatCompactNumber(value) !== compact || formatTokenValue(value) !== compact)
          throw new Error(`number format mismatch: ${String(value)}`);
      }
      return { metricCases, numberCases: values.length };
    });
    assert.deepEqual(equivalence, { metricCases: 8, numberCases: 14 });
    await page.getByRole('button', { name: /Dashboard conversation/ }).click();
    await page.waitForURL('**/#/session/**');
    reportZero = true;
    await page.goto(`${origin}/#/tab/dashboard`);
    await page.reload();
    await row('Reported input tokens').getByText('0', { exact: true }).waitFor();
    empty = true;
    await page.reload();
    await page.getByText(/No visible sessions yet/).waitFor();
    if (process.env.AOD_TEST_DASHBOARD_ONLY === '1') {
      assert.deepEqual(writes, []);
      assert.deepEqual(unexpected, []);
      assert.deepEqual(errors, []);
      console.log(JSON.stringify({ width, passed: true, dashboardOnly: true, equivalence, metricEdgeCases: true }));
      await context.close();
      continue;
    }

    await page.goto(`${origin}/#/tab/users`);
    await page.getByText(/Hub directory unavailable;/).waitFor();
    await page.getByText('Advanced · Connector accounts', { exact: true }).click();
    await page.getByText('Default connector account', { exact: true }).waitFor();
    hubFails = false;
    connectorFails = true;
    await page.getByRole('button', { name: 'Refresh directories' }).click();
    await page.getByText(/Connector directory unavailable;/).waitFor();
    await page.getByRole('button', { name: 'Rename user Default local user', exact: true }).waitFor();
    assert.equal(await page.getByText(/Hub directory unavailable;/).count(), 0);
    connectorFails = false;
    await page.getByRole('button', { name: 'Refresh directories' }).click();
    await page.getByText(/Connector directory unavailable;/).waitFor({ state: 'detached' });
    const createHub = page.getByRole('button', { name: 'Create Hub record', exact: true });
    await page.getByRole('button', { name: 'Refresh directories' }).waitFor();
    assert.equal(await createHub.isDisabled(), true);
    await page.getByRole('textbox', { name: 'New Hub user label' }).fill('Environment operator');
    await createHub.click();
    await page.getByRole('button', { name: 'Rename user Environment operator', exact: true }).click();
    await page.getByRole('textbox', { name: 'Rename user Environment operator', exact: true }).fill('Operator renamed');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('button', { name: 'Rename user Operator renamed', exact: true }).waitFor();
    await page.getByRole('textbox', { name: 'Search Hub users' }).fill('absent');
    await page.getByText('No matching Hub users.', { exact: true }).waitFor();
    await page.getByRole('textbox', { name: 'Search Hub users' }).fill('');
    const readsBeforeWrite = connectorReads;
    connectorFails = true;
    const accountInput = page.getByRole('textbox', { name: 'New connector account for Parallel Codex' });
    await accountInput.fill('Synthetic account');
    await accountInput.press('Enter');
    assert.equal(await page.getByRole('button', { name: 'Refresh directories' }).isDisabled(), true);
    await page.getByRole('button', { name: 'Rename connector account Synthetic account', exact: true }).click();
    assert.equal(connectorReads, readsBeforeWrite, 'confirmed write must not depend on a second directory GET');
    await page.getByRole('textbox', { name: 'Rename connector account Synthetic account', exact: true }).fill('Account renamed');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('button', { name: 'Rename connector account Account renamed', exact: true }).click();
    await page.getByRole('textbox', { name: 'Rename connector account Account renamed', exact: true }).fill('Long account '.repeat(9));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(connectorReads, readsBeforeWrite);
    assert.equal(writes.length, 4);
    denyWrite = true;
    await page.getByRole('textbox', { name: 'New Hub user label' }).fill('Denied user');
    await createHub.click();
    await page.getByRole('alert').filter({ hasText: /Administrator permission required/ }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Rename user Denied user', exact: true }).count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(unexpected, []);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ width, passed: true, writes: writes.length, metricEdgeCases: true, equivalence,
      partialDirectoryRecovery: true, confirmedWriteWithoutRefetch: true, deniedWrite: true }));
    await context.close();
  }
} finally {
  await browser?.close();
  await server.close();
}
