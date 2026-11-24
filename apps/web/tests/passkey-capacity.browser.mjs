// Built app, synthetic capacity responses. No actual credential or business API calls.
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { preview } from 'vite';
import { generateKeyPairSync } from 'node:crypto';
const { chromium } = await import(pathToFileURL(process.env.AOD_TEST_PLAYWRIGHT).href);
const server = await preview({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, envFile: false,
  logLevel: 'error', preview: { host: '127.0.0.1', port: 0 } });
let browser;
const bodyFailures = {
  body_capacity: [429, 'auth_body_capacity', 'Sign-in requests are busy. Wait a moment and retry.', '登录请求繁忙，请稍后重试。'],
  body_timeout: [408, 'auth_body_timeout', 'The sign-in request timed out. Check your connection and retry.', '登录请求超时，请检查网络连接后重试。'],
  body_too_large: [413, 'auth_body_too_large', 'The sign-in request is too large. Check your access key or try another authenticator.', '登录请求过大，请检查访问密钥或尝试其他认证器。'],
  body_invalid: [400, 'auth_body_invalid', 'The sign-in request could not be read. Retry the sign-in flow.', '无法读取登录请求，请重新进行登录。'],
  verification_rate: [429, 'passkey_verification_rate', 'Too many passkey verification attempts. Wait one minute and retry, or sign in with your access key.', '通行密钥验证过于频繁，请等待一分钟后重试，或使用访问密钥登录。'],
};
try {
  const origin = `http://localhost:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.AOD_TEST_CHROMIUM });
  for (const [width, locale] of [[1440, 'en'], [390, 'zh-CN']]) for (const method of ['login', 'register', 'key']) for (const stage of method === 'key' ? ['body_capacity', 'body_timeout', 'body_too_large'] : ['options', 'verify', 'storage', ...Object.keys(bodyFailures)]) {
    const authenticated = method === 'register';
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    const errors = [], writes = [];
    await context.addInitScript(locale => {
      localStorage.setItem('agentopsdeck.locale', locale);
      window.EventSource = class extends EventTarget { readyState = 1; static OPEN = 1;
        constructor() { super(); queueMicrotask(() => this.onopen?.(new Event('open'))); } close() { this.readyState = 2; } };
    }, locale);
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin !== origin) { errors.push('external request'); return route.abort(); }
      if (!url.pathname.startsWith('/api/')) return route.continue();
      if (req.method() !== 'GET') {
        writes.push(url.pathname);
        const base = `/api/auth/passkeys/${authenticated ? 'register' : 'login'}`;
        if (bodyFailures[stage] && url.pathname === (method === 'key' ? '/api/auth/login' : base + '/verify')) {
          const [status, error] = bodyFailures[stage];
          const retryAfterSeconds = stage === 'verification_rate' ? 60 : 1;
          return route.fulfill({ status, headers: { 'Cache-Control': 'no-store', ...(status === 429 ? { 'Retry-After': String(retryAfterSeconds) } : {}) },
            json: { error, ...(status === 429 ? { retryAfterSeconds } : {}) } });
        }
        if (url.pathname === base + '/options' && stage !== 'options') return route.fulfill({ json: authenticated
          ? { challenge: 'dGVzdC1jaGFsbGVuZ2U', rp: { id: 'localhost', name: 'Fixture' },
            user: { id: 'dGVzdC11c2Vy', name: 'fixture', displayName: 'Fixture' }, pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
            authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' }, attestation: 'none' }
          : { challenge: 'dGVzdC1jaGFsbGVuZ2U', rpId: 'localhost', userVerification: 'required',
            allowCredentials: [{ id: 'dGVzdC1jcmVkZW50aWFs', type: 'public-key' }] } });
        if (stage === 'storage' && url.pathname === base + '/verify') return route.fulfill({ status: 503,
          headers: { 'Cache-Control': 'no-store' }, json: { error: 'auth_persistence_failed' } });
        if (url.pathname === base + '/' + stage) return route.fulfill({ status: 429,
          headers: { 'Retry-After': stage === 'options' ? '300' : '1', 'Cache-Control': 'no-store' },
          json: { error: stage === 'options' ? 'passkey_challenge_capacity' : 'passkey_verification_capacity', retryAfterSeconds: stage === 'options' ? 300 : 1 } });
        errors.push('unexpected write: ' + url.pathname); return route.abort();
      }
      const json = body => route.fulfill({ json: body });
      if (url.pathname === '/api/auth/status') return json({ authenticated, recoveryScope: 'a'.repeat(64), passkeys: { available: true, count: 1 } });
      if (url.pathname === '/api/auth/passkeys') return json({ passkeys: [] });
      if (url.pathname.endsWith('/sessions/state')) return json({ revision: '1', groups: [] });
      if (url.pathname === '/api/agents') return json({ agents: [] });
      if (url.pathname === '/api/gateway/status') return json({ connected: true });
      return route.fulfill({ status: 404, json: {} });
    });
    const page = await context.newPage(); page.setDefaultTimeout(15_000); page.on('pageerror', e => errors.push(e.message));
    if (stage !== 'options' && method !== 'key') {
      const cdp = await context.newCDPSession(page);
      await cdp.send('WebAuthn.enable');
      const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal',
        hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
      if (!authenticated) {
        const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
        await cdp.send('WebAuthn.addCredential', { authenticatorId, credential: { credentialId: Buffer.from('test-credential').toString('base64'),
          isResidentCredential: true, rpId: 'localhost', userHandle: Buffer.from('test-user').toString('base64'),
          privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'), signCount: 0 } });
      }
    }
    await page.goto(origin);
    if (authenticated) await page.getByRole('button', { name: locale === 'en' ? 'Browser and sign-in settings' : '浏览器与登录设置', exact: true }).first().click();
    if (method === 'key') await page.locator('input[type="password"]').fill('fixture-access-key');
    const action = method === 'key' ? page.locator('form button[type="submit"]') : page.getByRole('button', { name: locale === 'en'
      ? (authenticated ? 'Add passkey' : 'Sign in with passkey')
      : (authenticated ? '添加通行密钥' : '使用通行密钥登录'), exact: true });
    await action.click();
    const message = bodyFailures[stage] ? bodyFailures[stage][locale === 'en' ? 2 : 3] : stage === 'storage'
      ? (locale === 'en' ? 'Sign-in storage is unavailable. Changes were not saved. Ask the Hub administrator to check available disk space and permissions.' : '登录存储不可用，修改未保存。请联系 Hub 管理员检查剩余磁盘空间和权限。')
      : stage === 'options'
      ? (locale === 'en' ? 'Passkey requests are busy. Wait a few minutes and retry, or sign in with your access key.' : '通行密钥请求繁忙，请稍等几分钟后重试，或使用访问密钥登录。')
      : (locale === 'en' ? 'Passkey verification is busy. Wait a moment and retry, or sign in with your access key.' : '通行密钥验证繁忙，请稍后重试，或使用访问密钥登录。');
    await page.getByRole('alert').filter({ hasText: message }).waitFor().catch(async error => {
      console.error({ stage, authenticated, writes, alerts: await page.getByRole('alert').allTextContents() });
      throw error;
    });
    assert.equal(await action.isEnabled(), true, 'manual retry remains available');
    assert.equal(writes.length, stage === 'options' || method === 'key' ? 1 : 2, 'only explicit options/verification; no automatic retries');
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`PASS ${width} ${locale} ${method} ${stage}: actionable error, no send/retry`);
  }
} finally {
  await browser?.close();
  await new Promise(resolve => server.httpServer.close(resolve));
}
