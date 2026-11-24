import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { authRequestSource, normalizeAuthAddress, parseAuthTrustedProxies, resolveAuthSource } from './request-source.js';
import { AuthAuditLog, fingerprintRequest, LoginAttemptLimiter, loginLimiterSubject } from './security.js';
import { registerAuthRoutes } from '../routes/auth.js';
import type { PasskeyManager } from './passkeys.js';
import { loadConfig } from '../config.js';

const request = (headers: Record<string, string> = {}) => new Request('http://localhost/api/auth/login', { headers });
test('source addresses are canonical and mapped IPv4 cannot create a second identity', () => {
  for (const raw of ['127.0.0.1', '::ffff:127.0.0.1', '::FFFF:7F00:0001']) assert.equal(normalizeAuthAddress(raw), '127.0.0.1');
  assert.equal(normalizeAuthAddress('2001:0DB8:0:0::1'), '2001:db8::1');
  for (const raw of [null, {}, '', '127.000.0.1', 'example.com', '127.0.0.1:80', '[::1]', 'fe80::1%eth0', '1'.repeat(65)]) assert.equal(normalizeAuthAddress(raw), undefined);
});
test('proxy configuration is explicit, finite and rejects ambiguous entries', () => {
  assert.deepEqual(parseAuthTrustedProxies(undefined), []);
  assert.deepEqual(parseAuthTrustedProxies('127.0.0.1, ::ffff:127.0.0.1, ::1'), ['127.0.0.1', '::1']);
  for (const raw of ['*', 'localhost', '127.0.0.0/8', '127.0.0.1,', Array(33).fill('127.0.0.1').join(','), ' '.repeat(2048) + '1']) assert.throws(() => parseAuthTrustedProxies(raw));
  assert.deepEqual(loadConfig({ AOD_AUTH_TRUSTED_PROXIES: '::1' }).authTrustedProxies, ['::1']);
  assert.throws(() => loadConfig({ AOD_AUTH_TRUSTED_PROXIES: '*' }));
});
test('direct clients cannot spoof any forwarding header or trusted-peer identity', () => {
  const req = request({ 'x-forwarded-for': '203.0.113.1', 'cf-connecting-ip': '203.0.113.2', 'x-real-ip': '203.0.113.3', forwarded: 'for=203.0.113.4' });
  assert.equal(resolveAuthSource(req, '192.0.2.8', new Set(['127.0.0.1'])), '192.0.2.8');
  assert.equal(resolveAuthSource(req, undefined, new Set(['127.0.0.1'])), undefined);
  assert.equal(resolveAuthSource(req, '127.0.0.1', new Set()), '127.0.0.1');
});
test('trusted chain is walked right-to-left only up to first untrusted hop', () => {
  const trusted = new Set(['127.0.0.1', '192.0.2.10']);
  assert.equal(resolveAuthSource(request({ 'x-forwarded-for': '203.0.113.99, 198.51.100.7, 192.0.2.10' }), '::ffff:127.0.0.1', trusted), '198.51.100.7');
  assert.equal(resolveAuthSource(request({ 'x-forwarded-for': '203.0.113.99, 198.51.100.7' }), '192.0.2.20', trusted), '192.0.2.20');
});
test('malformed/oversized chains fall back to socket peer, never an alternative header', () => {
  for (const chain of ['', 'unknown', '198.51.100.1,', 'garbage, 198.51.100.1', '1'.repeat(2049), Array(17).fill('192.0.2.1').join(',')]) {
    assert.equal(resolveAuthSource(request({ 'x-forwarded-for': chain, 'x-real-ip': '203.0.113.8' }), '127.0.0.1', new Set(['127.0.0.1'])), '127.0.0.1');
  }
});
test('missing transport remains shared unknown and user-agent never changes limiter key', () => {
  const a = fingerprintRequest(request({ 'x-forwarded-for': '192.0.2.1', 'user-agent': 'a' }));
  const b = fingerprintRequest(request({ 'x-forwarded-for': '192.0.2.2', 'user-agent': 'b' }));
  assert.equal(a.ipHash, b.ipHash);
  assert.notEqual(a.userAgentHash, b.userAgentHash);
  assert.equal(loginLimiterSubject(a), loginLimiterSubject(b));
});

for (const trusted of [false, true]) test(`actual Node HTTP login cannot bypass bans by changing headers (proxy trust=${trusted})`, async context => {
  const app = new Hono(), audit = new AuthAuditLog();
  app.use('*', authRequestSource(trusted ? ['127.0.0.1'] : []));
  registerAuthRoutes(app, { accessKey: 'test-only-key', passkeys: { status: () => ({ available: false, count: 0 }) } as PasskeyManager, sessions: new Set(),
    isAuthorizedRequest: () => false, auditLog: audit, loginLimiter: new LoginAttemptLimiter({ maxFailures: 2, windowMs: 60_000, lockoutMs: 30_000 }), lockoutSeconds: 30 });
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  context.after(() => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); if ('closeAllConnections' in server) server.closeAllConnections(); }));
  if (!server.listening) await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const attempt = async (number: number, client = '198.51.100.8', key = 'wrong') => {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/auth/login`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': `ua-${number}`, 'x-forwarded-for': trusted ? `203.0.113.${number}, ${client}` : `203.0.113.${number}`, 'x-real-ip': `203.0.113.${number}` }, body: JSON.stringify({ accessKey: key }) });
    const body = await response.json(); return { status: response.status, retry: response.headers.get('retry-after'), cookie: response.headers.get('set-cookie'), body };
  };
  assert.equal((await attempt(1)).status, 401);
  assert.equal((await attempt(2)).status, 429);
  const banned = await attempt(3, undefined, 'test-only-key');
  assert.equal(banned.status, 429); assert.equal(banned.cookie, null); assert.equal(banned.retry, '30');
  if (trusted) assert.equal((await attempt(4, '198.51.100.9', 'test-only-key')).status, 200, 'distinct trusted client has independent bucket');
  const failures = audit.list().filter(event => event.outcome !== 'success');
  assert.equal(new Set(failures.map(event => event.ipHash)).size, 1);
  assert.doesNotMatch(JSON.stringify(audit.list()), /198\.51|203\.0|127\.0|ua-|test-only-key/);
});
