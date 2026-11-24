import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../server/package.json', import.meta.url));
const { chromium } = require('playwright-core');

// One failed context close must not bypass the original browser's cleanup or
// stop cleanup of its other contexts. Keep rejection handlers on every close.
export async function closeApplicationBrowser(browser, contexts) {
  try {
    await Promise.all(contexts.map(async context => context.close()));
  } finally {
    await browser.close();
  }
}

// Generated credentials stay in memory and the startup fixture's private config.
// Probe only the fixture-owned listener; never open live accounts or providers.
export async function verifyApplicationRecovery(origin, accessKey, evidence) {
  assert.equal(new URL(origin).hostname, '127.0.0.1', 'Owned loopback listener only');
  const browser = await chromium.launch({ headless: true });
  const contexts = [], errors = [], denied = [];
  const attempts = [0, 0];
  try {
    for (let index = 0; index < 2; index++) {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      contexts.push(context);
      await context.routeWebSocket('**/*', socket => {
        denied.push('websocket-request'); socket.close();
      });
      await context.route('**/*', route => {
        const request = route.request(), url = new URL(request.url());
        const layoutWrite = request.method() === 'PUT'
          && url.search === ''
          && ['/api/hub/v1/workspace/layouts/current', '/api/hub/v1/workspace/layouts/saved'].includes(url.pathname);
        if (url.origin !== origin || (request.method() !== 'GET' && !layoutWrite)) {
          denied.push(url.origin === origin ? request.method() + ':' + url.pathname : 'external-request');
          return route.abort('blockedbyclient');
        }
        if (url.pathname === '/api/hub/v1/events/stream') {
          attempts[index]++;
          if (index === 0 && attempts[index] === 1)
            return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"fixture-unavailable"}' });
        }
        return route.continue();
      });
      const login = await context.request.post(origin + '/api/auth/login', {
        headers: { Origin: origin }, data: { accessKey }, timeout: 20_000, maxRedirects: 0,
      });
      assert.equal(login.status(), 200, 'Owned browser session login');
    }
    const pages = await Promise.all(contexts.map(context => context.newPage()));
    for (const page of pages) page.on('pageerror', () => errors.push('pageerror'));
    await Promise.all(pages.map(page => page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 30_000 })));
    for (const page of pages) await page.waitForFunction(() =>
      window.__agentopsdeckEventStreamDiagnostics?.read().some(row => row.reason === 'connected'),
      undefined, { timeout: 30_000 });
    assert.ok(attempts[0] >= 2, 'Production application must recover a terminal 503');
    assert.equal(attempts[1], 1, 'Unrelated browser must not replace its healthy stream');
    const first = await pages[0].evaluate(() => window.__agentopsdeckEventStreamDiagnostics.read());
    assert.ok(first.some(row => row.reason === 'error' && row.retryMs === 1000));
    assert.doesNotMatch(JSON.stringify(first), /fixture-|lastEventId|127\.0\.0\.1|accessKey/);

    // Revoke only the second original cookie; the first session stays authorized.
    const logout = await contexts[1].request.post(origin + '/api/auth/logout', { headers: { Origin: origin }, maxRedirects: 0 });
    assert.equal(logout.status(), 200);
    assert.equal((await contexts[1].request.get(origin + '/api/hub/v1/me', { maxRedirects: 0 })).status(), 401);
    assert.equal((await contexts[0].request.get(origin + '/api/hub/v1/me', { maxRedirects: 0 })).status(), 200);
    await pages[1].reload({ waitUntil: 'domcontentloaded' });
    const attemptsAfterLogout = attempts[1];
    await pages[1].waitForTimeout(1500);
    assert.equal(attempts[1], attemptsAfterLogout, 'Logged-out scope must not orphan a retry');
    assert.equal((await contexts[0].request.get(origin + '/api/hub/v1/me', { maxRedirects: 0 })).status(), 200);
    assert.deepEqual(errors, []); assert.deepEqual(denied, []);
    evidence.checks.push('hub:compiled-application-native-browser-503-reconnect');
    evidence.checks.push('hub:two-cookie-sessions-single-logout-does-not-revoke-other');
    evidence.checks.push('hub:logged-out-application-does-not-orphan-stream-retries');
  } finally {
    await closeApplicationBrowser(browser, contexts);
  }
}
