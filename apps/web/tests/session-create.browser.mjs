// Actual API/journal/notice, entirely synthetic loopback; no native Agent.
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
  browser = await chromium.launch({ headless: true,
    ...(process.env.AOD_TEST_CHROMIUM ? { executablePath: process.env.AOD_TEST_CHROMIUM } : {}) });
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
    const calls = [], errors = [], external = [], receipts = new Map();
    let mode = 'preflight-failed', scope = 'a'.repeat(64), appMode = false, verificationCalls = 0;
    let messageMode;
    let finishNormalCreate;
    const sessionKey = `local:${Buffer.from('codex:synthetic-created').toString('base64url')}`;
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) { external.push(url.origin); return route.abort(); }
      if (url.pathname === '/__create') return route.fulfill({ contentType: 'text/html', body: await server.transformIndexHtml('/__create',
        '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/command-recovery.fixture.tsx"></script></body></html>') });
      if (!url.pathname.startsWith('/api/')) return route.continue();
      // Old-page reads may already be in flight when the authenticated account
      // changes. Model the server's scope fence; never serve another account's
      // receipt, and still fail any cross-account mutation attempted here.
      const requestScope = request.headers()['x-agentopsdeck-recovery-scope'];
      if (requestScope && requestScope !== scope) {
        assert.equal(request.method(), 'GET', 'no stale-account mutation');
        return route.fulfill({ status: 409, json: { error: 'Authenticated account or Hub changed; reload before continuing' } });
      }
      if (appMode && !url.pathname.includes('/creation-commands/') && (request.method() === 'GET' || url.pathname === '/api/hub/v1/completions/summary' || url.pathname === '/api/hub/v1/sessions/messages/batch-meta')) {
        if (url.pathname === '/api/auth/status') return route.fulfill({ json: { authenticated: true, recoveryScope: scope, passkeys: { available: false, count: 0 } } });
        if (url.pathname === '/api/hub/v1/shared/creation-environments') return route.fulfill({ json: { environments: [], nextCursor: null } });
        if (url.pathname === '/api/hub/v1/completions/summary') return route.fulfill({ json: { summaries: {} } });
        if (url.pathname === '/api/hub/v1/sessions/messages/batch-meta') return route.fulfill({ json: { sessions: {} } });
        if (url.pathname === '/api/hub/v1/sessions/state') return route.fulfill({ json: { groups: messageMode ? [{ agentId: 'codex', sessions: [{
          sessionKey, title: 'Message presentation', agentId: 'codex', source: 'codex', envConnectionId: 'local',
          status: messageMode === 'preparing' ? 'idle' : 'running', runtime: { turnId: 'synthetic-turn',
            phase: messageMode === 'preparing' ? 'completed' : 'running', threadActivity: messageMode === 'preparing' ? 'idle' : 'running',
            connection: 'connected', sync: 'current', lastEventAt: Date.now(),
            ...(messageMode === 'retry' ? { reason: 'Model connection interrupted · Codex is retrying…' } : {}) },
        }] }] : [], updatedAt: 1, revision: `synthetic-${messageMode ?? 'empty'}`, viewKey: 'synthetic-view',
          connections: [{ id: 'local', label: 'Synthetic', kind: 'local', status: 'connected', capabilities: [] }],
          sourceStates: [{ connectionId: 'local', authority: 1, state: 'ready', cursor: 'ce1_11111111-1111-4111-8111-111111111111:1' }] } });
        if (url.pathname === '/api/agents') return route.fulfill({ json: { agents: [{ id: 'codex', label: 'Codex' }] } });
        if (url.pathname === '/api/gateway/status') return route.fulfill({ json: { connected: true } });
        if (url.pathname.endsWith('/messages')) return route.fulfill({ json: { messages: messageMode ? [{
          id: 'pending-message', sessionKey, role: 'user', text: 'Synthetic pending greeting', status: 'queued', queueVersion: 'v1', createdAt: 1,
        }] : [], updatedAt: 1 } });
        if (url.pathname.endsWith('/queue')) return route.fulfill({ json: { items: [] } });
        return route.fulfill({ status: 404, json: {} });
      }
      assert.equal(request.headers()['x-agentopsdeck-recovery-scope'], scope);
      if (request.method() === 'POST' && url.pathname === '/api/hub/v1/connections/local/verify') {
        verificationCalls++;
        return mode === 'preflight-failed' ? route.fulfill({ status: 503, json: {} })
          : route.fulfill({ json: { connection: { id: 'local', identityStatus: 'verified', nodeId: 'synthetic-node' } } });
      }
      calls.push([request.method(), url.pathname]);
      if (request.method() === 'POST') {
        assert.equal(url.pathname, '/api/hub/v1/connections/local/agents/codex/sessions');
        const { label, idempotencyKey } = request.postDataJSON();
        assert.equal(label, 'Synthetic private title'); assert.match(idempotencyKey, /^create\./);
        const command = { id: idempotencyKey, key: idempotencyKey, state: 'accepted', createdAt: 1, updatedAt: 2,
          result: { status: 201, body: { key: sessionKey } } };
        receipts.set(idempotencyKey, command);
        if (mode === 'held-accepted') await new Promise(resolve => { finishNormalCreate = resolve; });
        return mode === 'unknown' ? route.fulfill({ status: 202, json: { status: 'outcome_unknown' } })
          : route.fulfill({ status: 201, json: { key: sessionKey, command } });
      }
      assert.equal(request.method(), 'GET');
      if (url.pathname === '/api/hub/v1/connections/parallel-codex/agents/main/sessions/creation-commands/create.legacy.d9cd6628'
        || (url.pathname.includes('/settings-commands/') && url.pathname.endsWith('/settings.keep'))) {
        return route.fulfill({ status: 503, json: {} });
      }
      assert.ok(/^\/api\/hub\/v1\/(?:shared\/another-owner\/)?connections\/local\/agents\/codex\/sessions\/creation-commands\//.test(url.pathname), url.pathname);
      const command = receipts.get(decodeURIComponent(url.pathname.split('/').at(-1)));
      assert.ok(command);
      return mode === 'unknown' ? route.fulfill({ status: 503, json: {} }) : route.fulfill({ json: { command } });
    });
    await context.addInitScript(() => {
      localStorage.setItem('agentopsdeck.apiBaseUrl', location.origin);
      window.EventSource = class extends EventTarget {
        readyState = 1;
        constructor() { super(); queueMicrotask(() => this.onopen?.(new Event('open'))); }
        close() { this.readyState = 2; }
      };
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/__create?creation`);
    await page.waitForFunction(() => Boolean(window.recoveryFixture));
    const invoke = () => page.evaluate(() => window.recoveryFixture.createSession());
    const notice = page.getByRole('region', { name: 'Command delivery recovery' });
    const createdNotice = page.getByRole('region', { name: 'Created sessions' });
    assert.match((await invoke()).error, /identity could not be verified.*creation was not attempted/);
    assert.equal(verificationCalls, 1);
    assert.equal(calls.length, 0);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('agentopsdeck.command-recovery.v1')), null);
    mode = 'unknown';
    assert.match((await invoke()).error, /creation outcome is unknown/);
    assert.equal(verificationCalls, 2);
    await notice.getByText(/Session creation.*outcome unknown/).waitFor();
    assert.equal(calls.length, 2);
    assert.match((await invoke()).error, /creation outcome is unknown/);
    assert.equal(calls.length, 3, 'a repeated create action only queries the original command');
    assert.equal(calls.at(-1)[0], 'GET');
    assert.equal(calls.filter(([method]) => method === 'POST').length, 1);
    assert.equal(verificationCalls, 2, 'recovery does not begin a new creation preflight');
    assert.equal(await notice.getByRole('button', { name: 'Forget locally' }).count(), 1);

    await page.reload();
    await notice.getByText(/Session creation.*outcome unknown/).waitFor();
    await page.waitForFunction(() => !document.querySelector('[aria-label="Command delivery recovery"]')?.textContent.includes('checking receipts'));
    assert.equal(calls.length, 4, 'refresh only queries the saved receipt');
    mode = 'accepted';
    await notice.getByRole('button', { name: 'Check receipt' }).click();
    await createdNotice.getByText('Session created', { exact: true }).waitFor();
    assert.equal(await notice.count(), 0, 'successful creation is not a delivery problem');
    assert.equal(await createdNotice.innerText().then(text => /saved|receipt|create\./i.test(text)), false, 'no protocol details in the success shortcut');
    assert.ok((await createdNotice.boundingBox()).height <= 64, 'single success is a compact row, including on mobile');
    if (process.env.AOD_TEST_SCREENSHOTS) await page.screenshot({ path: `${process.env.AOD_TEST_SCREENSHOTS}/created-${viewport.width}.png` });
    const successRows = await page.evaluate(() => sessionStorage.getItem('agentopsdeck.command-recovery.v1'));
    assert.equal(calls.length, 5);
    await page.reload();
    await createdNotice.getByRole('button', { name: 'Open session' }).waitFor();
    assert.equal(calls.length, 5, 'settled creation needs no polling');
    // A failed GET must keep the successful shortcut, never create again.
    mode = 'unknown';
    await createdNotice.getByRole('button', { name: 'Open session' }).click();
    await page.getByText(/Receipt unavailable/).waitFor();
    assert.equal(await createdNotice.count(), 1);
    assert.equal(await page.evaluate(() => window.openedCreation), undefined);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('agentopsdeck.command-recovery.v1')), successRows);
    mode = 'accepted';
    await createdNotice.getByRole('button', { name: 'Open session' }).click();
    await page.waitForFunction(() => Boolean(window.openedCreation));
    assert.deepEqual(await page.evaluate(() => window.openedCreation), { key: sessionKey, target: { connectionId: 'local', agentId: 'codex' } });
    assert.equal(calls.length, 7); assert.equal(calls.filter(([method]) => method === 'POST').length, 1);
    await createdNotice.waitFor({ state: 'detached' });
    const raw = await page.evaluate(() => sessionStorage.getItem('agentopsdeck.command-recovery.v1'));
    assert.equal(raw.includes('Synthetic private title'), false); assert.equal(raw.includes('sessionKey'), false);
    assert.equal(raw.includes(sessionKey), false);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);

    // The real shells must expose creation recovery without a selected/listed
    // session, and open the confirmed identity even while projection is empty.
    appMode = true;
    await page.evaluate(raw => sessionStorage.setItem('agentopsdeck.command-recovery.v1', raw), successRows);
    await page.goto(`${origin}/#/tab/sessions`);
    await createdNotice.getByRole('button', { name: 'Open session' }).waitFor();
    await createdNotice.getByRole('button', { name: 'Open session' }).click();
    // Desktop selection is stored in its workspace, not the hash route. The
    // mobile shell still addresses the selected session in its hash.
    if (viewport.width < 600) await page.waitForFunction(key => decodeURIComponent(location.hash).includes(key), sessionKey);
    await page.getByText('New session', { exact: true }).first().waitFor();
    if (viewport.width >= 600) await page.locator('.session-workspace-pane[data-active="true"]').getByText('New session', { exact: true }).first().waitFor();
    await createdNotice.waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => sessionStorage.getItem('agentopsdeck.command-recovery.v1')), '[]');
    assert.equal(calls.filter(([method]) => method === 'POST').length, 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const beforeSwitch = calls.length;
    for (const presentation of ['preparing', 'busy', 'retry']) {
      messageMode = presentation;
      await page.reload();
      if (viewport.width < 600 && await page.getByText('Synthetic pending greeting', { exact: true }).count() === 0) {
        const card = page.getByText('Message presentation', { exact: true });
        if (await card.count()) await card.click();
      }
      await page.getByText('Synthetic pending greeting', { exact: true }).waitFor();
      if (presentation === 'preparing') {
        // Idle admission is intentionally quiet; it is not a waiting queue.
        assert.equal(await page.getByLabel('Preparing message', { exact: true }).count(), 0);
        assert.equal(await page.locator('[data-delivery="queued"]').count(), 0);
      } else await page.locator('[data-delivery="queued"]').waitFor();
      if (presentation === 'retry') await page.getByText('Model connection interrupted · Codex is retrying…', { exact: true }).waitFor();
      if (presentation !== 'preparing') assert.equal(await page.getByRole('button', { name: 'Cancel delivery', exact: true }).isEnabled(), true);
      assert.equal(calls.length, beforeSwitch, 'presentation and reload must never resend');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    }
    messageMode = undefined;
    appMode = false;

    scope = 'b'.repeat(64);
    await page.goto(`${origin}/__create?creation&scope=${scope}`);
    await page.waitForFunction(() => Boolean(window.recoveryFixture));
    assert.equal(await notice.count(), 0); assert.equal(calls.length, beforeSwitch);
    assert.deepEqual(await invoke(), { key: sessionKey });
    await createdNotice.getByText('Session created', { exact: true }).waitFor();
    assert.equal(calls.length, beforeSwitch + 1);
    await page.evaluate(() => sessionStorage.setItem('agentopsdeck.command-recovery.v1', '{broken'));
    assert.match((await invoke()).error, /damaged/); assert.equal(calls.length, beforeSwitch + 1);

    mode = 'unknown';
    const staleCreation = { scope, key: 'create.legacy.d9cd6628', createdAt: 1, state: 'outcome_unknown',
      creation: { connectionId: 'parallel-codex', agentId: 'main' } };
    const retained = [
      { ...staleCreation, scope: 'c'.repeat(64) },
      { ...staleCreation, creation: { connectionId: 'local', agentId: 'codex' }, state: 'accepted' },
      { scope, key: 'settings.keep', createdAt: 1, state: 'outcome_unknown', sessionKey: 'local:c3ludGhldGlj', settings: true },
    ];
    await page.evaluate(rows => sessionStorage.setItem('agentopsdeck.command-recovery.v1', JSON.stringify(rows)), [staleCreation, ...retained]);
    await page.reload();
    await page.getByText(/Receipt unavailable/).waitFor();
    await createdNotice.getByText('Session created', { exact: true }).waitFor();
    assert.match(await notice.innerText(), /Delivery recovery · 1 saved/);
    const beforeForget = calls.length;
    const beforeVerify = verificationCalls;
    const savedRows = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('agentopsdeck.command-recovery.v1')));
    await notice.getByRole('button', { name: 'Forget locally' }).click();
    const confirmation = page.getByRole('dialog', { name: 'Forget local recovery record?' });
    await confirmation.waitFor();
    assert.match(await confirmation.innerText(), /does not cancel the command or make resending safe/);
    await page.keyboard.press('Escape');
    assert.deepEqual(await savedRows(), [staleCreation, ...retained]);
    await notice.getByRole('button', { name: 'Forget locally' }).click();
    await confirmation.getByRole('button', { name: 'Forget locally', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[aria-label="Command delivery recovery"]')?.textContent.includes('parallel-codex / main'));
    assert.deepEqual(await savedRows(), retained, 'forget must preserve other scopes, targets and command types');
    assert.equal(await page.getByText(/Receipt unavailable/).count(), 0);
    await createdNotice.getByRole('button', { name: 'Dismiss created session notice', exact: true }).click();
    await notice.waitFor({ state: 'detached' });
    await page.reload();
    await page.waitForFunction(() => Boolean(window.recoveryFixture));
    assert.equal(await notice.count(), 0, 'dismissed banner must stay gone after refresh');
    assert.deepEqual(await savedRows(), [retained[0], retained[2]]);
    assert.equal(calls.length, beforeForget, 'forget and refresh must neither query nor replay the removed command');
    assert.equal(verificationCalls, beforeVerify, 'forget must not start another creation');
    await page.goto(`${origin}/__create?scope=${scope}`);
    await notice.getByText(/Session settings.*outcome unknown/).waitFor();
    assert.equal(await notice.getByRole('button', { name: 'Forget locally' }).count(), 0);
    // Success shortcuts remain bounded and independent of the recovery count.
    const successes = Array.from({ length: 6 }, (_, index) => ({ scope, key: `create.page.${index}`, createdAt: 1,
      state: 'accepted', creation: { connectionId: 'local', agentId: 'codex' } }));
    await page.evaluate(rows => sessionStorage.setItem('agentopsdeck.command-recovery.v1', JSON.stringify(rows)), successes);
    const beforeSuccessPage = calls.length;
    await page.goto(`${origin}/__create?creation&scope=${scope}`);
    await createdNotice.getByRole('button', { name: 'Next' }).click();
    assert.equal(await createdNotice.getByText('Session created', { exact: true }).count(), 2);
    await createdNotice.getByRole('button', { name: 'Previous' }).click();
    assert.equal(await createdNotice.getByText('Session created', { exact: true }).count(), 4);
    assert.equal(await notice.count(), 0);
    assert.equal(calls.length, beforeSuccessPage, 'paging successful shortcuts must not query or replay');

    // Normal creation through both real shells must be silent, including
    // intermediate journal events and a refresh with an empty projection.
    mode = 'accepted'; appMode = true;
    await page.evaluate(() => sessionStorage.setItem('agentopsdeck.command-recovery.v1', '[]'));
    await page.goto(`${origin}/#/tab/sessions`);
    const trigger = page.getByRole('button', { name: viewport.width < 600 ? 'New chat' : 'New session', exact: true }).first();
    await trigger.focus();
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'Create new session' });
    await dialog.getByRole('button', { name: 'Create', exact: true }).waitFor();
    assert.equal(await dialog.evaluate(node => node instanceof HTMLDialogElement && node.matches(':modal')), true);
    await dialog.getByLabel('Session name', { exact: true }).focus();
    const controls = dialog.locator('button:enabled, input:enabled, select:enabled');
    await controls.last().focus();
    await page.keyboard.press('Tab');
    assert.equal(await controls.first().evaluate(node => node === document.activeElement), true);
    await page.keyboard.press('Shift+Tab');
    assert.equal(await controls.last().evaluate(node => node === document.activeElement), true);
    for (let traversal = 0; traversal < 12; traversal++) {
      await page.keyboard.press('Tab');
      assert.equal(await dialog.evaluate(node => node.contains(document.activeElement)), true, 'native modal contains keyboard focus');
    }
    await trigger.evaluate(node => node.focus());
    assert.equal(await dialog.evaluate(node => node.contains(document.activeElement)), true, 'background stays inert');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    assert.equal(await trigger.evaluate(node => node === document.activeElement), true);
    for (const closeName of ['Cancel', 'Close']) {
      await trigger.click();
      await dialog.getByRole('button', { name: closeName, exact: true }).click();
      await dialog.waitFor({ state: 'detached' });
      assert.equal(await trigger.evaluate(node => node === document.activeElement), true);
    }
    await trigger.click();
    await dialog.waitFor();
    await page.evaluate(() => window.dispatchEvent(new Event('agentopsdeck:auth-required')));
    await dialog.waitFor({ state: 'detached' });
    console.log(`PASS modal ${viewport.width}: native :modal, Tab/Shift+Tab edges, 12 contained Tab steps, inert background, Escape/Cancel/Close focus restoration and auth dismissal`);
    await page.goto(`${origin}/#/tab/sessions`);
    await trigger.focus();
    await trigger.click();
    await dialog.getByLabel('Session name', { exact: true }).fill('Synthetic private title');
    await page.evaluate(() => {
      window.creationNotices = [];
      new MutationObserver(() => {
        for (const node of document.querySelectorAll('[aria-label="Created sessions"], [aria-label="Command delivery recovery"]')) {
          window.creationNotices.push(node.textContent);
        }
      }).observe(document.body, { childList: true, subtree: true });
    });
    const beforeNormal = calls.filter(([method]) => method === 'POST').length;
    mode = 'held-accepted';
    await dialog.getByRole('button', { name: 'Create', exact: true }).click();
    await dialog.getByRole('button', { name: 'Creating…', exact: true }).waitFor();
    assert.equal(await dialog.getByRole('button', { name: 'Creating…', exact: true }).isDisabled(), true);
    assert.equal(await dialog.getByRole('button', { name: 'Cancel', exact: true }).isDisabled(), true);
    assert.equal(await dialog.getByLabel('Session name', { exact: true }).isDisabled(), true);
    assert.equal(await dialog.getByLabel('Environment', { exact: true }).isDisabled(), true);
    assert.equal(await dialog.getByRole('button', { name: 'Close', exact: true }).isEnabled(), true);
    assert.equal(await dialog.locator('button:enabled, input:enabled, select:enabled').count(), 1);
    await dialog.getByRole('button', { name: 'Close', exact: true }).focus();
    await page.keyboard.press('Tab');
    assert.equal(await dialog.getByRole('button', { name: 'Close', exact: true }).evaluate(node => node === document.activeElement), true);
    await page.keyboard.press('Shift+Tab');
    assert.equal(await dialog.getByRole('button', { name: 'Close', exact: true }).evaluate(node => node === document.activeElement), true);
    for (let attempt = 0; !finishNormalCreate && attempt < 100; attempt++) await page.waitForTimeout(50);
    assert.ok(finishNormalCreate, 'synthetic creation response is held while controls are disabled');
    mode = 'accepted';
    finishNormalCreate();
    console.log(`PASS modal creating ${viewport.width}: disabled name/environment/Cancel/Create, one enabled Close, contained Tab/Shift+Tab`);
    if (viewport.width < 600) await page.waitForFunction(key => decodeURIComponent(location.hash).includes(key), sessionKey);
    else await page.waitForFunction(key => document.querySelector('.session-workspace-pane[data-active="true"] [data-session-pane]')?.getAttribute('data-session-pane') === key, sessionKey);
    await page.waitForFunction(() => sessionStorage.getItem('agentopsdeck.command-recovery.v1') === '[]');
    assert.deepEqual(await page.evaluate(() => window.creationNotices), [], 'normal creation must never flash a recovery or success banner');
    assert.equal(calls.filter(([method]) => method === 'POST').length, beforeNormal + 1);
    await page.reload();
    await page.getByRole('button', { name: viewport.width < 600 ? 'New chat' : 'New session', exact: true }).first().waitFor();
    assert.equal(await createdNotice.count(), 0); assert.equal(await notice.count(), 0);
    assert.deepEqual(await savedRows(), []);

    // Legacy ACK retained by an older client: silently retire only the record
    // whose authenticated receipt identifies the already-open session.
    const lastKey = [...receipts.keys()].at(-1);
    const legacy = { scope, key: lastKey, createdAt: 1, state: 'accepted', creation: { connectionId: 'local', agentId: 'codex' } };
    const otherAccount = { ...legacy, scope: 'd'.repeat(64) };
    const otherTarget = { ...legacy, key: 'create.other-target', creation: { connectionId: 'local', agentId: 'codex', ownerUserId: 'another-owner' } };
    receipts.set(otherTarget.key, { ...receipts.get(lastKey), key: otherTarget.key });
    await page.evaluate(rows => sessionStorage.setItem('agentopsdeck.command-recovery.v1', JSON.stringify(rows)), [legacy, otherAccount, otherTarget]);
    messageMode = 'preparing';
    await page.goto(`${origin}/#/session/${encodeURIComponent(sessionKey)}`);
    await page.reload();
    if (viewport.width < 600) await page.getByText('Message presentation', { exact: true }).click();
    await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('agentopsdeck.command-recovery.v1')).length === 2).catch(async error => {
      console.error('Legacy cleanup diagnostic', viewport.width, await page.evaluate(() => ({ hash: location.hash, rows: sessionStorage.getItem('agentopsdeck.command-recovery.v1'), text: document.body.innerText.slice(0, 1500) })), calls.slice(-8));
      throw error;
    });
    assert.deepEqual(await savedRows(), [otherAccount, otherTarget], 'a shared owner must not be confused with the same native session');
    // The journal write precedes React's notification-driven render. Wait for
    // the retained other-owner shortcut, not merely the storage mutation.
    if (viewport.width >= 600) await createdNotice.getByText('Session created', { exact: true }).waitFor();
    assert.equal(await createdNotice.getByText('Session created', { exact: true }).count(), viewport.width < 600 ? 0 : 1);
    assert.equal(calls.filter(([method]) => method === 'POST').length, beforeNormal + 1, 'legacy cleanup is GET-only');

    await page.evaluate(() => sessionStorage.setItem('agentopsdeck.command-recovery.v1', '[]'));
    await page.goto(`${origin}/__create?creation&scope=${scope}`);
    await page.waitForFunction(() => Boolean(window.recoveryFixture));
    appMode = false;
    await page.evaluate(() => { window.creationEntry = window.recoveryFixture.createAndEnter('wait'); });
    await page.waitForFunction(() => Boolean(window.finishCreationEntry));
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('agentopsdeck:commands-changed')));
    assert.equal(await createdNotice.count(), 0); assert.equal(await notice.count(), 0);
    assert.equal((await savedRows()).length, 1, 'receipt survives until navigation completes');
    await page.evaluate(() => window.finishCreationEntry());
    assert.deepEqual(await page.evaluate(() => window.creationEntry), { key: sessionKey });
    assert.deepEqual(await savedRows(), []);
    assert.match((await page.evaluate(() => window.recoveryFixture.createAndEnter('fail'))).error, /navigation failure/);
    await createdNotice.waitFor();
    assert.equal((await savedRows())[0].state, 'accepted', 'failed navigation must preserve the confirmed shortcut');
    const failedNavigation = await savedRows();
    const postsBeforeAccountChange = calls.filter(([method]) => method === 'POST').length;
    assert.match((await page.evaluate(() => window.recoveryFixture.createAndEnter('account-change'))).error, /Account changed/);
    const afterAccountChange = await savedRows();
    assert.deepEqual(afterAccountChange, failedNavigation, 'account changes preserve the exact original receipt, without duplicating it');
    assert.equal(calls.filter(([method]) => method === 'POST').length, postsBeforeAccountChange, 'retrying navigation recovers the original creation GET-only');
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    await context.close();
  }
  console.log('Creation recovery: preflight, GET-only recovery, confirmed local forget/cancel, exact record isolation, no replay, refresh persistence, protected settings and 1440/390px layout passed.');
} finally { await browser?.close(); await server.close(); }
