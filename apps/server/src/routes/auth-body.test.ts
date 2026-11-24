import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { request as httpRequest, Server } from 'node:http';
import type { PasskeyManager } from '../auth/passkeys.js';
import { AuthAuditLog, LoginAttemptLimiter } from '../auth/security.js';
import { registerAuthRoutes } from './auth.js';
import { AUTH_KEY_BODY_BYTES, AUTH_PASSKEY_BODY_BYTES } from '../auth/request-body.js';

const paths = ['/api/auth/login', '/api/auth/passkeys/register/verify', '/api/auth/passkeys/login/verify'];
function harness() {
  const app = new Hono(), sessions = new Set<string>(), auditLog = new AuthAuditLog();
  let credentialCalls = 0, authorized = true;
  registerAuthRoutes(app, { accessKey: 'fixture-key', sessions, auditLog, isAuthorizedRequest: () => authorized,
    loginLimiter: new LoginAttemptLimiter({ maxFailures: 5, windowMs: 60_000, lockoutMs: 30_000 }), lockoutSeconds: 30,
    memberLogin: () => { credentialCalls++; return undefined; },
    memberSessionCurrent: () => false,
    passkeys: { status: () => ({ available: true, count: 0 }),
      verifyRegistration: async () => { credentialCalls++; return { verified: false }; },
      verifyAuthentication: async () => { credentialCalls++; return { verified: false }; },
    } as unknown as PasskeyManager,
  });
  return { app, sessions, auditLog, calls: () => credentialCalls, revoke: () => { authorized = false; } };
}
function streaming(path: string, body: ReadableStream, signal?: AbortSignal) {
  return new Request('http://localhost' + path, { method: 'POST', body, signal, duplex: 'half' } as RequestInit);
}

test('all three credential routes reject oversized bodies before credential/session/audit side effects', async () => {
  const h = harness();
  for (const [index, path] of paths.entries()) {
    const max = index === 0 ? AUTH_KEY_BODY_BYTES : AUTH_PASSKEY_BODY_BYTES;
    const response = await h.app.request(path, { method: 'POST', body: ' '.repeat(max + 1), headers: { 'content-length': '1' } });
    assert.equal(response.status, 413); assert.deepEqual(await response.json(), { error: 'auth_body_too_large' });
    assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('set-cookie'), null);
  }
  assert.equal(h.calls(), 0); assert.equal(h.sessions.size, 0); assert.deepEqual(h.auditLog.list(), []);
  assert.equal((await h.app.request(paths[0]!, { method: 'POST', body: JSON.stringify({ accessKey: 'fixture-key' }) })).status, 200);
});

test('key login and both passkey routes share eight readers; overflow consumes no credential work, abort restores admission', async t => {
  const h = harness();
  const aborts = Array.from({ length: 8 }, () => new AbortController());
  t.after(() => aborts.forEach(a => a.abort()));
  let started = 0, ready!: () => void;
  const entered = new Promise<void>(resolve => { ready = resolve; });
  const pending = aborts.map((a, i) => h.app.request(streaming(paths[i % paths.length]!, new ReadableStream({ pull() { if (++started === 8) ready(); } }), a.signal)));
  await entered;
  for (const path of paths) {
    const response = await h.app.request(path, { method: 'POST', body: '{}' });
    assert.equal(response.status, 429); assert.equal(response.headers.get('retry-after'), '1');
    assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('set-cookie'), null);
    assert.deepEqual(await response.json(), { error: 'auth_body_capacity', retryAfterSeconds: 1 });
  }
  assert.equal(h.calls(), 0); assert.deepEqual(h.auditLog.list(), []);
  aborts.forEach(a => a.abort());
  for (const response of await Promise.all(pending)) {
    assert.equal(response.status, 408); assert.equal(response.headers.get('set-cookie'), null);
    assert.deepEqual(await response.json(), { error: 'auth_body_timeout' });
  }
  assert.equal((await h.app.request(paths[0]!, { method: 'POST', body: JSON.stringify({ accessKey: 'fixture-key' }) })).status, 200);
  assert.equal(h.calls(), 1); assert.equal(h.sessions.size, 1);
});

test('unauthorized registration refuses before locking the stream; malformed passkey bodies are bounded inert errors', async () => {
  const h = harness(); h.revoke();
  let cancelled = false;
  const req = streaming(paths[1]!, new ReadableStream({ cancel() { cancelled = true; } }));
  assert.equal((await h.app.request(req)).status, 401);
  assert.equal(req.body!.locked, false); await req.body!.cancel(); assert.equal(cancelled, true);
  const response = await h.app.request(paths[2]!, { method: 'POST', body: '{fixture-secret' });
  assert.equal(response.status, 400); assert.deepEqual(await response.json(), { error: 'auth_body_invalid' });
  assert.equal(h.calls(), 0); assert.deepEqual(h.auditLog.list(), []);
});

test('real HTTP adapter rejects chunked over-limit login before EOF and permits the next valid login', async t => {
  const h = harness();
  const server = serve({ fetch: h.app.fetch, hostname: '127.0.0.1', port: 0 });
  assert.ok(server instanceof Server);
  t.after(() => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }));
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const result = await new Promise<{ status: number; body: string; cookie: unknown }>((resolve, reject) => {
    const req = httpRequest(origin + paths[0], { method: 'POST', headers: { 'content-type': 'application/json' } }, response => {
      let body = '';
      response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; });
      response.on('error', reject);
      response.on('end', () => { resolve({ status: response.statusCode!, body, cookie: response.headers['set-cookie'] }); req.destroy(); });
    });
    req.on('error', reject);
    req.setTimeout(2_000, () => req.destroy(new Error('bounded body response did not arrive')));
    req.write(' '.repeat(AUTH_KEY_BODY_BYTES)); req.write(' ');
    // Intentionally do not send EOF: size rejection must not await upload completion.
  });
  assert.equal(result.status, 413); assert.equal(result.cookie, undefined);
  assert.deepEqual(JSON.parse(result.body), { error: 'auth_body_too_large' });
  assert.equal(h.calls(), 0); assert.equal(h.sessions.size, 0); assert.deepEqual(h.auditLog.list(), []);
  const response = await fetch(origin + paths[0], { method: 'POST', body: JSON.stringify({ accessKey: 'fixture-key' }) });
  assert.equal(response.status, 200); await response.arrayBuffer();
  assert.equal(h.sessions.size, 1);
});
