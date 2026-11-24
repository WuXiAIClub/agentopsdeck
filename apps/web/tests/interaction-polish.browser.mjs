// Real UI and Chromium virtual WebAuthn; synthetic loopback API only.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { PasskeyManager } from '../../server/dist/auth/passkeys.js';

const { chromium } = await import(process.env.AOD_TEST_PLAYWRIGHT ? pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href : 'playwright');
const temporary = await mkdtemp(join(tmpdir(), 'agentopsdeck-interaction-browser-'));
const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, envFile: false, plugins: [react(), tailwindcss()], server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
let browser;
try {
  await server.listen();
  const origin = `http://localhost:${server.httpServer.address().port}`;
  // Full Chromium implements notification permissions; headless-shell does not.
  browser = await chromium.launch({ headless: true, ...(process.env.AOD_TEST_CHROMIUM ? { executablePath: process.env.AOD_TEST_CHROMIUM } : { channel: 'chromium' }) });
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const mobile = viewport.width < 600;
    const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
    const manager = new PasskeyManager(join(temporary, `keys-${viewport.width}.json`));
    const session = { sessionKey: 'alpha:codex:test', title: 'Interaction checks', agentId: 'codex', source: 'codex', status: 'idle', envConnectionId: 'alpha', envConnectionLabel: 'Mac Studio', totalTokens: 900000, contextUsedTokens: 12000, contextTokens: 128000, compactionCount: 3, lastActiveAt: 1 };
    const second = { ...session, sessionKey: 'beta:codex:second', title: 'Second workspace', envConnectionId: 'beta', envConnectionLabel: 'Windows Desktop' };
    let authenticated = true, deletions = 0, deleted = false, sends = 0, logouts = 0;
    const errors = [], denied = [];
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()), method = request.method();
      if (url.origin !== origin) { denied.push(url.href); return route.abort(); }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const json = (body, status = 200) => route.fulfill({ status, json: body });
      const authRequest = new Request(url.href, { headers: { origin } });
      if (url.pathname === '/api/auth/status') return json({ authenticated, recoveryScope: 'a'.repeat(64), passkeys: manager.status('operator') });
      if (url.pathname === '/api/auth/login') { authenticated = true; return json({ ok: true, passkeys: manager.status('operator') }); }
      if (url.pathname === '/api/auth/logout') { logouts++; authenticated = false; return json({ ok: true }); }
      if (url.pathname.endsWith('/register/options')) return json(await manager.registrationOptions(authRequest, 'operator'));
      if (url.pathname.endsWith('/register/verify')) {
        const body = request.postDataJSON();
        const verified = await manager.verifyRegistration(authRequest, body.credential ?? body.response ?? body, { keyIdentityHash: 'operator', label: body.label });
        assert.equal(verified.verified, true); return json({ ok: true, passkeys: manager.status('operator') });
      }
      if (url.pathname.endsWith('/login/options')) return json(await manager.authenticationOptions(authRequest, 'operator'));
      if (url.pathname.endsWith('/login/verify')) {
        const result = await manager.verifyAuthentication(authRequest, request.postDataJSON(), 'operator');
        assert.equal(result.verified, true); authenticated = true; return json({ ok: true, passkeys: manager.status('operator') });
      }
      if (url.pathname === '/api/auth/passkeys') return json({ passkeys: manager.list('operator') });
      if (url.pathname.startsWith('/api/auth/passkeys/') && method === 'DELETE') return json({ ok: manager.revoke('operator', url.pathname.split('/').at(-1)) });
      if (url.pathname === '/api/hub/v1/me') return json({ admin: true, member: { id: 'default', displayName: 'Fixture' } });
      if (url.pathname.endsWith('/sessions/state')) return json({ groups: [{ agentId: 'codex', sessions: deleted ? [second] : [session, second] }], revision: deleted ? '2' : '1' });
      if (url.pathname.endsWith('/messages') && method === 'GET') return json({ messages: [], totalCount: 0, hiddenCount: 0, revision: '1' });
      if (url.pathname.endsWith('/queue')) return json({ items: [], nextCursor: null });
      if (method === 'DELETE' && url.pathname.startsWith('/api/sessions/')) {
        deletions++; deleted = true;
        const key = request.headers()['idempotency-key'];
        return json({ ok: true, status: 'delete_accepted', command: { id: key, key, state: 'accepted', createdAt: 1, updatedAt: 2, result: { status: 200, body: { ok: true, status: 'delete_accepted' } } } });
      }
      if (url.pathname.includes('/messages') && method === 'POST') { sends++; return json({ error: 'Synthetic rejection' }, 400); }
      if (url.pathname === '/api/agents') return json({ agents: [{ id: 'codex', name: 'Codex' }] });
      if (url.pathname === '/api/gateway/status') return json({ connected: true });
      return json({ error: 'Outside fixture' }, 404);
    });
    await context.addInitScript(() => {
      const streams = [];
      window.EventSource = class extends EventTarget { readyState = 1; static OPEN = 1; static CONNECTING = 0; static CLOSED = 2;
        constructor() { super(); streams.push(this); queueMicrotask(() => this.onopen?.(new Event('open'))); } close() { this.readyState = 2; } };
      window.emitFixture = event => streams.forEach(stream => stream.readyState === 1 && stream.dispatchEvent(new MessageEvent(event.type, { data: JSON.stringify(event) })));
      window.voiceInstances = [];
      window.SpeechRecognition = class { constructor() { window.voiceInstances.push(this); } start() {} stop() { this.onend?.(); } abort() { this.aborted = true; this.onend?.(); } };
      window.voiceResult = text => window.voiceInstances.at(-1).onresult({ results: [[{ transcript: text }]] });
      window.notificationCalls = [];
      window.Notification = class { static permission = 'granted'; constructor(title) { window.notificationCalls.push(title); } close() {} };
      window.confirm = () => { throw new Error('Native confirmation must not be used'); };
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    const cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    await page.goto(origin);
    const card = page.locator(`[data-session-card="${session.sessionKey}"]`);
    await card.waitFor();
    assert.match(await card.innerText(), /Mac Studio/);
    const identity = card.locator('.session-identity-row');
    assert.equal(await identity.locator('.session-runtime-label').innerText(), 'Codex');
    const assertIdentityLayout = async () => {
      const row = await identity.boundingBox();
      const environment = await identity.locator('.connector-mark').boundingBox();
      const runtime = await identity.locator('.session-runtime-label').boundingBox();
      assert.ok(Math.abs(environment.x - row.x) < 2, 'environment aligned left');
      assert.ok(Math.abs(runtime.x + runtime.width - row.x - row.width) < 2, 'agent aligned right');
      assert.ok(runtime.x - environment.x - environment.width >= 15, 'clear separation without overlap');
      assert.ok(Math.abs(environment.y + environment.height / 2 - runtime.y - runtime.height / 2) < 2, 'same row');
    };
    await assertIdentityLayout();
    await identity.locator('.connector-mark > span:last-child').evaluate(node => { node.textContent = 'Very long remote environment name '.repeat(10); });
    await assertIdentityLayout();
    await identity.locator('.connector-mark > span:last-child').evaluate(node => { node.textContent = 'Mac Studio'; });
    assert.match(await page.locator(`[data-session-card="${second.sessionKey}"]`).innerText(), /Windows Desktop/);
    await page.getByRole('button', { name: 'Browser and sign-in settings' }).click();
    const settings = page.getByRole('dialog', { name: 'Browser and sign-in settings' });
    const attention = settings.locator('.completion-effect-setting select');
    assert.equal(await attention.inputValue(), 'flash', 'new browser defaults to visible flash');
    for (const effect of ['off', 'heartbeat', 'glow', 'flash']) {
      await attention.selectOption(effect);
      await page.reload();
      await card.waitFor();
      await page.getByRole('button', { name: 'Browser and sign-in settings' }).click();
      assert.equal(await attention.inputValue(), effect, 'explicit completion choice survives reload');
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    console.log(`PASS ${viewport.width}px: flash default and all four choices persist without page overflow`);
    await settings.getByRole('button', { name: 'Add passkey' }).click();
    await settings.getByText('Passkey saved.', { exact: false }).waitFor();
    assert.equal(manager.list('operator').length, 1);
    await settings.getByRole('button', { name: 'Close settings' }).click();
    authenticated = false;
    await page.reload();
    await page.getByRole('button', { name: 'Sign in with passkey', exact: true }).click();
    await card.waitFor();
    assert.ok(manager.list('operator')[0].lastUsedAt, 'real WebAuthn assertion reached manager');
    await page.getByRole('button', { name: 'Browser and sign-in settings' }).click();
    await settings.getByRole('button', { name: 'Remove', exact: true }).click();
    const confirm = page.getByRole('dialog', { name: /Remove/ });
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    assert.equal(manager.list('operator').length, 1);
    await settings.getByRole('button', { name: 'Remove', exact: true }).click();
    await confirm.getByRole('button', { name: 'Remove passkey' }).click();
    await settings.getByText('Passkey removed.', { exact: true }).waitFor();
    assert.equal(manager.list('operator').length, 0);
    await settings.getByRole('button', { name: 'Close settings' }).click();
    await card.click();
    const scrolling = page.getByRole('switch', { name: /auto-scroll/i });
    const tools = page.getByRole('button', { name: 'Pane tools', exact: true });
    const openedTools = !await scrolling.isVisible();
    if (openedTools) await tools.click();
    await scrolling.waitFor();
    assert.equal(await scrolling.getAttribute('aria-checked'), 'true');
    await scrolling.click(); assert.equal(await scrolling.getAttribute('aria-checked'), 'false');
    await scrolling.click();
    if (openedTools) await page.keyboard.press('Escape');
    const composer = page.locator('textarea:visible');
    if (!await composer.isVisible()) await page.getByRole('button', { name: 'Write a message', exact: true }).click();
    await page.getByRole('button', { name: 'Start voice input' }).click();
    await composer.fill('Manual edit');
    await page.evaluate(() => window.voiceResult('must not overwrite typing'));
    assert.equal(await composer.inputValue(), 'Manual edit');
    await composer.fill('Existing draft');
    await page.getByRole('button', { name: 'Start voice input' }).click();
    await page.evaluate(() => window.voiceResult('spoken words'));
    await page.waitForFunction(() => document.querySelector('textarea')?.value.includes('spoken words'));
    assert.equal(await composer.inputValue(), 'Existing draft\nspoken words');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.evaluate(() => window.voiceResult('late result must be ignored'));
    assert.ok(!(await composer.inputValue()).includes('late result'));
    assert.equal(await page.evaluate(() => window.voiceInstances.at(-1).aborted), true);
    const now = Date.now();
    await page.evaluate(({ session, now }) => {
      for (const phase of ['running', 'completed', 'completed']) window.emitFixture({ id: `${phase}-${Math.random()}`, type: 'session.updated', sessionKey: session.sessionKey, ts: now, payload: { ...session, runtime: { phase, turnId: 'notification-turn', sync: 'current', connection: 'connected' } } });
    }, { session, now });
    await page.waitForFunction(() => window.notificationCalls.length === 1);
    assert.deepEqual(await page.evaluate(() => window.notificationCalls), ['AgentOpsDeck run finished']);
    if (process.env.AOD_TEST_SCREENSHOTS) await page.screenshot({ path: `${process.env.AOD_TEST_SCREENSHOTS}/interaction-${viewport.width}.png` });
    if (!mobile) {
      assert.equal(await page.locator('[data-desktop-chat-toolbar]').count(), 0);
      await page.getByRole('button', { name: 'Session status', exact: true }).click();
      const status = page.locator('.caption-popover:visible');
      assert.match(await status.innerText(), /12,000\/128,000/);
      assert.match(await status.innerText(), /compact 3/);
      await page.keyboard.press('Escape');
      assert.equal(await page.getByRole('button', { name: 'More session actions', exact: true }).count(), 0);
      const openDelete = async () => {
        const button = page.getByRole('button', { name: 'Delete session…', exact: true });
        if (!await button.isVisible()) await page.getByRole('button', { name: 'Pane tools', exact: true }).click();
        await button.click();
      };
      await openDelete();
      const dialog = page.getByRole('dialog', { name: 'Delete session?' });
      await dialog.waitFor();
      assert.equal(await dialog.getByRole('button', { name: 'Delete', exact: true }).evaluate(button => getComputedStyle(button).color), 'rgb(255, 255, 255)');
      if (process.env.AOD_TEST_SCREENSHOTS) await page.screenshot({ path: `${process.env.AOD_TEST_SCREENSHOTS}/delete-${viewport.width}.png` });
      assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Cancel');
      await page.keyboard.press('Escape'); assert.equal(deletions, 0);
      await openDelete(); await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
      await page.waitForFunction(() => !document.querySelector('[data-session-card="alpha:codex:test"]'));
      assert.equal(deletions, 1);
    }
    // A lock/settings icon must never end the login; logout is explicit and
    // reversible until the page-native confirmation is accepted.
    if (mobile) await page.getByRole('button', { name: 'Back to sessions', exact: true }).click();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    const signOut = page.getByRole('dialog', { name: 'Sign out?', exact: true });
    await signOut.waitFor();
    await signOut.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(logouts, 0); assert.equal(authenticated, true);
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await signOut.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.getByRole('button', { name: 'Sign in with access key', exact: true }).waitFor();
    assert.equal(logouts, 1); assert.equal(authenticated, false);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []); assert.deepEqual(denied, []);
    console.log(JSON.stringify({ viewport: viewport.width, passkeyRegistrationLoginRevoke: true, notificationOnce: true, dictationLateResultIgnored: true, unifiedConnectorLabels: true, noOverflow: true, deletionModal: !mobile }));
    await context.close();
  }
  // Exercise the actual existing PWA worker and browser notification API,
  // separately from deterministic event/dictation mocks above.
  const context = await browser.newContext();
  await context.grantPermissions(['notifications'], { origin });
  await context.route('**/api/**', route => route.fulfill({ json: { authenticated: false, passkeys: { available: false, count: 0 } } }));
  const page = await context.newPage();
  await page.goto(origin);
  const worker = await page.evaluate(async () => {
    await navigator.serviceWorker.register('/sw.js');
    const registration = await navigator.serviceWorker.ready;
    const { showDesktopNotification } = await import('/src/lib/desktop-notifications.ts');
    const shown = await showDesktopNotification('AgentOpsDeck worker test', { tag: 'agentopsdeck-browser-test' });
    const notifications = await registration.getNotifications({ tag: 'agentopsdeck-browser-test' });
    notifications.forEach(notification => notification.close());
    return { shown, count: notifications.length, script: registration.active.scriptURL, permission: Notification.permission };
  });
  assert.equal(worker.shown, true, JSON.stringify(worker));
  assert.equal(worker.count, 1);
  assert.equal(new URL(worker.script).pathname, '/sw.js');
  console.log(JSON.stringify({ actualNotificationWorker: true, notificationStoredByBrowser: true }));
  await context.close();
} finally { await browser?.close(); await server.close(); await rm(temporary, { recursive: true, force: true }); }
