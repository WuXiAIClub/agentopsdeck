import assert from 'node:assert/strict';
import test from 'node:test';
import { accessCookieHeader, createAccessKeyGuard, createAdministratorKeyGuard } from './access-key.js';

const guard = createAccessKeyGuard('secret-key');

test('administrator Key provenance excludes open mode and Passkey sessions, and wrong explicit keys cannot fall back', () => {
  const sessions = { isAccessKeySession: (token: string) => token === 'key-session' };
  const keyGuard = createAdministratorKeyGuard('secret-key', sessions);
  const request = (token: string, key?: string) => new Request('http://test/', { headers: {
    cookie: `agentopsdeck_session=${token}`, ...(key ? { 'x-agentopsdeck-key': key } : {}),
  } });
  assert.equal(createAdministratorKeyGuard(undefined, sessions)(request('key-session')), false);
  assert.equal(keyGuard(request('passkey-session')), false);
  assert.equal(keyGuard(request('key-session')), true);
  assert.equal(keyGuard(request('key-session', 'wrong')), false);
  assert.equal(keyGuard(request('passkey-session', 'secret-key')), true);
});

test('administrator Key compatibility inspector cannot grant from async or nonboolean results', async () => {
  const request = new Request('http://test/', { headers: { cookie: 'agentopsdeck_session=session' } });
  let calls = 0;
  const sessions = { isAccessKeySession: async () => { calls++; return true; } };
  assert.equal(createAdministratorKeyGuard('secret-key', sessions as never)(request), false);
  assert.equal(calls, 0);
  for (const result of [Promise.resolve(true), Promise.reject(Error('private-session')), 1, {}]) {
    assert.equal(createAdministratorKeyGuard('secret-key', { isAccessKeySession: () => result } as never)(request), false);
  }
  await new Promise<void>(resolve => setImmediate(resolve));
});

test('authorizes requests with the HttpOnly access cookie', () => {
  const request = new Request('https://deck.example.com/api/sessions/state', {
    headers: { cookie: 'other=value; agentopsdeck_access=secret-key' },
  });

  assert.equal(guard(request), true);
});

test('does not accept access keys in query strings', () => {
  const request = new Request('https://deck.example.com/api/sessions/state?key=secret-key');

  assert.equal(guard(request), false);
});

test('sets secure HttpOnly cookie behind HTTPS', () => {
  const request = new Request('http://127.0.0.1:8790/api/auth/login', {
    headers: { 'x-forwarded-proto': 'https' },
  });
  const cookie = accessCookieHeader('secret-key', request);

  assert.match(cookie, /agentopsdeck_access=secret-key/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=None/);
  assert.match(cookie, /Secure/);
});

test('session compatibility lookup never treats a Promise as a grant or starts native async work', async () => {
  const request = new Request('http://test/', { headers: { cookie: 'agentopsdeck_session=session' } });
  let calls = 0;
  const asyncSessions = { has: async () => { calls++; return true; } } as unknown as Set<string>;
  assert.equal(createAccessKeyGuard('secret-key', asyncSessions)(request), false);
  assert.equal(calls, 0);
  for (const result of [Promise.resolve(false), Promise.reject(Error('private-session')), 1, {}]) {
    const sessions = { has: () => result } as unknown as Set<string>;
    assert.equal(createAccessKeyGuard('secret-key', sessions)(request), false);
  }
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(createAccessKeyGuard('secret-key', new Set(['session']))(request), true);
  const keyRequest = new Request('http://test/', { headers: {
    cookie: 'agentopsdeck_session=session', authorization: 'Bearer secret-key',
  } });
  assert.equal(createAccessKeyGuard('secret-key', asyncSessions)(keyRequest), true);
  assert.equal(calls, 0);
});
