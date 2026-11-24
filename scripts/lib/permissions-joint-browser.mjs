import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { verifyJointManagement } from './permissions-joint-management.mjs';
import { jointBrowserAction } from './permissions-joint-browser-action.mjs';

// Real pages and real cookie-authenticated production requests. Never install
// routes, mock APIs, save storageState or log one-time credentials.
export async function openJointBrowsers({ config, origin, adminKey, actors, onError }) {
  let browser;
  let startupStage = 'module and browser launch';
  const members = new Map();
  async function safe(label, action) {
    try { return await action(); }
    catch { throw new Error(`Browser acceptance failed: ${label}; sensitive call details omitted`); }
  }
  async function api(actor, path, method = 'GET', data, status = 200) {
    const response = await actor.context.request.fetch(origin + path, { method, data, headers: { origin }, timeout: 20_000 });
    assert.equal(response.status(), status, `${method} ${path}`);
    return response.headers()['content-type']?.includes('application/json') ? response.json() : undefined;
  }
  try {
    const { chromium } = await import(pathToFileURL(config.module).href);
    browser = await chromium.launch({ executablePath: config.executable, headless: true });
    startupStage = 'administrator identity';
    const administrator = { context: await browser.newContext({ viewport: { width: 1440, height: 1000 } }) };
    await safe('administrator cookie login', () => api(administrator, '/api/auth/login', 'POST', { accessKey: adminKey }));
    assert.equal((await api(administrator, '/api/hub/v1/me')).admin, true);
    for (const [index, actor] of actors.entries()) {
      startupStage = `member ${index + 1} context`;
      const context = await browser.newContext({ viewport: index ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
        ...(index ? { isMobile: true, hasTouch: true } : {}) });
      const page = await context.newPage();
      page.setDefaultTimeout(20_000);
      page.on('pageerror', () => onError('Member browser pageerror'));
      const member = { context, page, id: actor.id };
      // Observe the actual network without substituting a stream or history.
      // Retain only bounded, non-sensitive counters/marker booleans.
      member.network = { histories: [], events: [], streamStatuses: [] };
      page.on('response', async response => {
        const path = new URL(response.url()).pathname;
        if (path.endsWith('/events/stream')) {
          member.network.streamStatuses.push(response.status());
          member.network.streamStatuses = member.network.streamStatuses.slice(-8);
        }
        if (response.request().method() !== 'GET' || !path.includes('/shared/') || !path.endsWith('/messages')) return;
        try {
          const value = response.status() === 304
            ? JSON.parse(response.headers()['x-agentopsdeck-history-meta'] ?? '{}') : await response.json();
          const delta = value.historyDelta === 1;
          const messages = delta ? value.slots?.filter(slot => typeof slot === 'object' && slot) : value.messages;
          member.network.histories.push({ status: response.status(), delta, count: value.messages?.length,
            limit: new URL(response.url()).searchParams.get('limit'), cached: value.historyStatus === 'cached',
            slots: delta ? value.slots?.length : undefined,
            reused: delta ? value.slots?.filter(slot => typeof slot === 'number').length : undefined,
            replies: [1, 2, 3, 4].map(n => messages?.some(message => message.text?.includes('JOINT_REPLY_' + n)) === true),
            cursorSeq: Number(String(delta ? value.metadata?.sourceCursor : value.sourceCursor).split(':').at(-1)) || null });
          member.network.histories = member.network.histories.slice(-16);
        } catch { /* An aborted/revoked response is not a history observation. */ }
      });
      const protocol = await context.newCDPSession(page);
      await protocol.send('Network.enable');
      protocol.on('Network.eventSourceMessageReceived', message => {
        try {
          const event = JSON.parse(message.data);
          if (!['session.invalidated', 'stream.reset', 'stream.status'].includes(event.type)) return;
          member.network.events.push({ type: event.type,
            cursorSeq: Number(String(event.sourceCursor).split(':').at(-1)) || null });
          member.network.events = member.network.events.slice(-16);
        } catch { /* Never retain arbitrary event payloads. */ }
      });
      members.set(actor.id, member);
      await safe('member UI login', async () => {
        await page.goto(origin);
        startupStage = `member ${index + 1} login input`;
        await page.getByRole('textbox', { name: 'Access key', exact: true }).fill(actor.token);
        startupStage = `member ${index + 1} login submit`;
        const login = page.waitForResponse(response => response.request().method() === 'POST'
          && response.url() === origin + '/api/auth/login');
        await page.getByRole('button', { name: 'Sign in with access key', exact: true }).click();
        assert.equal((await login).status(), 200);
        startupStage = `member ${index + 1} shared directory`;
        await page.goto(origin + '/#/shared');
        await page.getByRole('heading', { name: 'Shared with me' }).waitFor();
      });
      startupStage = `member ${index + 1} identity and management boundaries`;
      const me = await api(member, '/api/hub/v1/me');
      assert.equal(me.userId, actor.id); assert.equal(me.admin, false);
      await api(member, '/api/auth/audit?page=true', 'GET', undefined, 403);
      const directory = await api(member, '/api/hub/v1/users');
      assert.deepEqual(directory.users.map(user => user.id), [actor.id]);
      await api(member, '/api/hub/v1/users', 'POST', { label: 'Must not create' }, 403);
    }
    startupStage = 'anonymous identity';
    const anonymous = { context: await browser.newContext() };
    await api(anonymous, '/api/hub/v1/me', 'GET', undefined, 401);
    await anonymous.context.close();
    return {
      async management(check) {
        // The helper already emits only a static phase label. Preserve it so a
        // failed UI gate remains diagnosable without Playwright call details.
        return verifyJointManagement({ browser, context: administrator.context,
          origin, request: (...args) => api(administrator, ...args), check });
      },
      async chat(actor, session, text, media = []) {
        const member = members.get(actor.id);
        return safe('member UI sends original command', async () => {
          let phase = 'open original shared session';
          try {
            await member.page.goto(origin + '/#/session/' + encodeURIComponent(JSON.stringify(['shared-session-v1', 'default', session.key])));
            const input = member.page.getByRole('textbox', { name: 'Shared message', exact: true });
            phase = 'fill original draft';
            await input.waitFor();
            await input.fill(text);
            if (media.length) {
              phase = 'read original attachment';
              await member.page.locator('input[type="file"]').setInputFiles(media.map(file => ({
                name: file.name, mimeType: file.mimeType, buffer: Buffer.from(file.dataUrl.split(',')[1], 'base64'),
              })));
              // setInputFiles only dispatches change; it does not await FileReader
              // or React's committed attachment state. Do not send text alone.
              await member.page.getByRole('button', { name: 'Clear attachments', exact: true }).waitFor();
            }
            phase = 'submit original command';
            const response = await jointBrowserAction(() => member.page.waitForResponse(response => response.request().method() === 'POST'
              && response.url() === origin + session.path + '/messages'),
            () => member.page.getByRole('button', { name: 'Send', exact: true }).click());
            assert.ok([200, 202].includes(response.status()));
            const key = response.request().postDataJSON().idempotencyKey;
            assert.ok(typeof key === 'string' && key.length > 0);
            if (media.length) assert.deepEqual(response.request().postDataJSON().media, media);
            return { key, body: await response.json() };
          } catch {
            // Only static state flags and bounded fixture-marker observations;
            // never a DOM dump, draft, account key, URL or Playwright call log.
            const state = await member.page.evaluate(() => {
              const status = document.querySelector('[aria-label="Shared session status"]')?.textContent ?? '';
              const form = document.querySelector('form');
              const text = document.body.innerText;
              return { sendDisabled: form?.querySelector('button[type="submit"]')?.disabled ?? null,
                inputDisabled: form?.querySelector('textarea')?.disabled ?? null,
                readingImages: text.includes('Reading images…'),
                invalidImages: text.includes('Invalid images.'),
                messagesReady: status.includes('Messages: ready'),
                messagesUnavailable: status.includes('Messages: unavailable'),
                messagesStale: status.includes('Messages: stale'),
                readOnly: text.includes('Read-only for this access.'),
                denied: text.includes('Shared access is no longer available') };
            }).catch(() => ({ pageUnavailable: true }));
            console.log(JSON.stringify({ jointComposerFailure: { phase, mobile: members.keys().next().value !== actor.id,
              attachmentExpected: media.length > 0, ...state }, network: member.network }));
            throw new Error('Original UI submission failed');
          }
        });
      },
      async visible(actor, text) {
        const member = members.get(actor.id);
        await safe(`native response rendered (${members.keys().next().value === actor.id ? 'desktop' : 'mobile'}, ${text})`, async () => {
          try {
            await member.page.getByText(text, { exact: true }).first().waitFor({ timeout: 30_000 });
          } catch {
            const diagnostic = await member.page.evaluate(() => {
              const text = document.body.innerText;
              return { replies: [1, 2, 3, 4].map(n => text.includes('JOINT_REPLY_' + n)),
                historyLoading: /Messages: loading/.test(text), historyStale: /Messages: stale/.test(text),
                historyReady: /Messages: ready/.test(text), selected: !window.getSelection()?.isCollapsed,
                unavailable: text.includes('Messages unavailable'), stale: text.includes('last authorized snapshot'),
                revoked: text.includes('Shared access is no longer available'),
                liveUnavailable: text.includes('Live updates are unavailable'),
                viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth };
            });
            console.log(JSON.stringify({ browserDiagnostic: diagnostic, network: member.network, requestedMarker: text }));
            throw new Error('Reply not rendered');
          }
        });
        await safe(`viewport bounds (${members.keys().next().value === actor.id ? 'desktop' : 'mobile'})`, async () => {
          assert.ok(await member.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        });
      },
      async denied(actor, session, status = 404) {
        const member = members.get(actor.id);
        await api(member, session.path + '/messages', 'GET', undefined, status);
        await api(member, session.path + '/state', 'GET', undefined, status);
      },
      async revoked(actor) {
        await safe('live sharing revocation clears page', () => members.get(actor.id).page
          .getByText(/Shared access is no longer available/).waitFor({ timeout: 20_000 }));
      },
      async disabled(actor) {
        const member = members.get(actor.id);
        for (const path of ['/api/hub/v1/me', '/api/hub/v1/shared/grants', '/api/hub/v1/connections']) {
          await api(member, path, 'GET', undefined, 401);
        }
      },
      async fresh(actor, token) {
        // Old browser must stay unauthenticated even after a fresh key exists.
        await this.disabled(actor);
        const fresh = { context: await browser.newContext({ viewport: { width: 390, height: 844 } }) };
        try {
          await safe('fresh cookie login', () => api(fresh, '/api/auth/login', 'POST', { accessKey: token }));
          assert.equal((await api(fresh, '/api/hub/v1/me')).userId, actor.id);
          assert.equal((await api(fresh, '/api/hub/v1/shared/grants')).grants.length, 0);
        } finally { await fresh.context.close(); }
      },
      async close() { await browser.close(); },
    };
  } catch (error) {
    await browser?.close();
    // safe() produces only our static stage label, never Playwright's call log
    // (which may contain login credentials). Preserve that useful distinction.
    const message = `Browser startup acceptance failed: ${startupStage}; sensitive call details omitted`;
    throw new Error(message);
  }
}
