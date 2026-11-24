import assert from 'node:assert/strict';
import test from 'node:test';
import { WebsiteCookieSession, parseWebsiteCookiePolicy } from './website-cookie-session.js';
import { WebsiteActionExecution, type WebsiteActionPolicy } from './website-actions.js';
import { parseWebsiteServices } from './websites.js';

const policy = { cookieNames: ['sid', 'csrf'], csrf: { cookie: 'csrf', header: 'x-csrf-token' as const } };
const url = new URL('http://127.0.0.1:3000/api/login');
function headers(...cookies: string[]) { const result = new Headers(); for (const cookie of cookies) result.append('set-cookie', cookie); return result; }
test('private website cookies require exact names, host root path and bounded CSRF policy', () => {
  assert.deepEqual(parseWebsiteCookiePolicy(policy), policy);
  for (const change of [{ cookieNames: [] }, { cookieNames: ['sid', 'sid'] }, { cookieNames: ['a=b'] }, { token: 'secret' }, { csrf: { cookie: 'other', header: 'x-csrf-token' } }, { csrf: { cookie: 'csrf', header: 'authorization' } }]) {
    assert.throws(() => parseWebsiteCookiePolicy({ ...policy, ...change }), error => !String(error).includes('secret'));
  }
  const action = { id: 'post', label: 'Post', method: 'POST', path: '/api/post', contentType: 'application/json', maxBytes: 100, csrf: true };
  const service = { id: 'dev', label: 'Dev', url: url.origin + '/', actions: [action], session: policy };
  assert.equal(parseWebsiteServices(JSON.stringify([service]))[0]?.session?.csrf?.header, 'x-csrf-token');
  assert.throws(() => parseWebsiteServices(JSON.stringify([{ ...service, session: undefined }])));
  assert.throws(() => parseWebsiteServices(JSON.stringify([{ ...service, actions: [] }])));
});

test('cookie state is origin-private, short-lived, atomic and never contains foreign headers', () => {
  let now = 1000;
  const jar = new WebsiteCookieSession(url.origin, policy, 301000, () => now);
  jar.accept(url, headers('sid=private; Path=/; HttpOnly; SameSite=Strict', 'csrf=abc%2B123; Path=/; Max-Age=60', 'unconfigured=ignore; Domain=evil.test'));
  assert.deepEqual(jar.headers(url, true), { cookie: 'sid=private; csrf=abc%2B123', 'x-csrf-token': 'abc+123' });
  assert.throws(() => jar.headers(new URL('http://127.0.0.1:3001/api/post'), true));
  for (const cookie of ['sid=evil; Domain=127.0.0.1; Path=/', 'sid=evil; Path=/api', 'sid=evil', 'sid=evil; Path=/; Path=/', 'sid=bad value; Path=/', 'sid=evil; Path=/; Max-Age=invalid']) {
    assert.throws(() => jar.accept(url, headers('csrf=changed; Path=/', cookie)));
    assert.equal(jar.headers(url, true)['x-csrf-token'], 'abc+123', 'a malformed batch cannot partially change the jar');
  }
  jar.accept(url, headers('sid=secure-only; Path=/; Secure'));
  assert.match(jar.headers(url).cookie!, /sid=private/, 'HTTP cannot replace with a Secure cookie');
  now += 61000;
  assert.throws(() => jar.headers(url, true));
  assert.deepEqual(jar.headers(url), { cookie: 'sid=private' });
  jar.accept(url, headers('sid=; Path=/; Max-Age=0'));
  assert.deepEqual(jar.headers(url), {});
  now = 301000; assert.throws(() => jar.headers(url));
});

test('configured login and CSRF action share cookies only inside the private execution context', async () => {
  const jar = new WebsiteCookieSession(url.origin, policy, Date.now() + 300000);
  const action: WebsiteActionPolicy = { id: 'login', label: 'Login', path: '/api/login', method: 'POST', contentType: 'application/json', maxBytes: 256 };
  const first = new WebsiteActionExecution(url.origin + '/', action, jar, 'dev');
  const signal = new AbortController().signal;
  let calls = 0;
  const result = await first.execute('{"password":"synthetic"}', signal, async (_url, options) => {
    calls++; assert.equal(new Headers(options?.headers).has('cookie'), false);
    return Response.json({ loggedIn: true }, { headers: headers('sid=private; Path=/; HttpOnly', 'csrf=csrf-value; Path=/') });
  });
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.equal(JSON.stringify(result).includes('csrf-value'), false);
  const next = new WebsiteActionExecution(url.origin + '/', { ...action, id: 'update', path: '/api/update', csrf: true }, jar, 'dev');
  await next.execute('{}', signal, async (_url, options) => {
    calls++; const h = new Headers(options?.headers);
    assert.equal(h.get('cookie'), 'sid=private; csrf=csrf-value'); assert.equal(h.get('x-csrf-token'), 'csrf-value'); assert.equal(h.get('authorization'), null);
    return Response.json({ saved: true });
  });
  await next.execute('{}', signal); assert.equal(calls, 2);
  const isolated = new WebsiteActionExecution(url.origin + '/', { ...action, csrf: true });
  await assert.rejects(isolated.execute('{}', signal), { status: 409 });
});
