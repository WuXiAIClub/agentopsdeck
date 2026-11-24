import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { CONNECTOR_PROTOCOL, CONNECTOR_PROTOCOL_HEADER } from '@agentopsdeck/shared';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { PasskeyManager, PasskeyChallengeCapacityError, PasskeyVerificationCapacityError, PasskeyVerificationRateError, PersistentDeckSessionSet } from './passkeys.js';
import { createAccessKeyGuard } from './access-key.js';
import { AuthAuditLog, LoginAttemptLimiter, keyIdentityHash } from './security.js';
import { registerAuthRoutes } from '../routes/auth.js';
import { AuthPersistenceError } from './private-store.js';
import { HubStore } from '../hub/hub-store.js';
import { HubEventBrokers } from '../hub/event-broker.js';
import { hubEventResponse } from '../hub/event-stream.js';
import { ConnectorClient } from '../hub/connector-client.js';
import { DeckStore } from '../projection/deck-store.js';
import { registerEventRoutes } from '../routes/events.js';
import { registerHubTerminals } from '../routes/hub-terminals.js';

const origin = 'https://hub.example';
const request = () => new Request(origin + '/api/auth', { headers: { origin } });
const keyHash = keyIdentityHash('fixture-access-key');
const ttl = 300_000;

function sessionFixture(t: TestContext) {
  const h = fixture(t);
  const sessions = new PersistentDeckSessionSet(h.file + '.sessions', binding =>
    binding.keyIdentityHash === keyHash && h.manager.isCredentialCurrent(binding.credentialHash, binding.keyIdentityHash));
  const authorized = createAccessKeyGuard('fixture-access-key', sessions), app = new Hono(), audit = new AuthAuditLog();
  registerAuthRoutes(app, { accessKey: 'fixture-access-key', sessions, passkeys: h.manager, isAuthorizedRequest: authorized,
    auditLog: audit, loginLimiter: new LoginAttemptLimiter({ maxFailures: 5, windowMs: 60_000, lockoutMs: 30_000 }), lockoutSeconds: 30 });
  const login = async (credentialId?: string) => {
    const options = await h.manager.authenticationOptions(request(), keyHash);
    const result = await app.request(origin + '/api/auth/passkeys/login/verify', { method: 'POST',
      headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(h.assertion(options.challenge, 1, credentialId)) });
    assert.equal(result.status, 200);
    return { cookie: result.headers.get('set-cookie')!.split(';')[0]! };
  };
  return { ...h, app, sessions, authorized, audit, login };
}

for (const mode of ['legacy', 'hub'] as const) test(`real passkey revocation closes idle ${mode} SSE and rejects reconnect`, { timeout: 6000 }, async t => {
  const h = sessionFixture(t), headers = await h.login(), deck = new DeckStore(), app = new Hono();
  const hub = new HubStore(h.file + '.sqlite', 'fixture'), brokers = new HubEventBrokers(hub, () => { throw Error('No Connector access'); });
  let active = 0;
  const base = mode === 'legacy' ? '/api/events/stream' : '/stream';
  if (mode === 'legacy') registerEventRoutes(app, deck, h.authorized);
  else app.get(base, c => {
    if (!h.authorized(c.req.raw)) throw new HTTPException(401);
    const subscription = brokers.acquire('alice'); active++;
    return hubEventResponse(c, { store: hub, ownerUserId: 'alice', subscription: {
      events: subscription.events, release() { active--; subscription.release(); },
    }, authorize() { if (!h.authorized(c.req.raw)) throw new HTTPException(401); } });
  });
  const result = await app.request(base, { headers }), reader = result.body!.getReader();
  try {
    assert.equal(result.status, 200);
    assert.match(new TextDecoder().decode((await reader.read()).value), /heartbeat/);
    h.manager.revoke(keyHash, h.manager.list(keyHash)[0]!.id);
    const start = Date.now();
    assert.equal((await reader.read()).done, true, 'no events after revocation');
    assert.ok(Date.now() - start < 3500, 'idle authority check must be bounded');
    assert.equal(active, 0); assert.equal(deck.changes.waiting, 0);
    assert.equal((await app.request(base, { headers })).status, 401);
  } finally { await reader.cancel(); brokers.close(); hub.close(); }
});

test('real passkey revocation fences pending PTY output, removes its exact lease, and preserves a sibling credential', { timeout: 6000 }, async t => {
  const h = sessionFixture(t), revokedCredential = h.manager.list(keyHash)[0]!.id, headers = await h.login();
  const registration = await h.manager.registrationOptions(request(), keyHash);
  assert.equal((await h.manager.verifyRegistration(request(), h.registration(registration.challenge), { keyIdentityHash: keyHash })).verified, true);
  const siblingHeaders = await h.login(Buffer.from('new-budget-test-credential').toString('base64url'));
  const hub = new HubStore(h.file + '.sqlite', 'fixture'), user = hub.createUser('Owner'), app = new Hono();
  hub.upsertConnection({ id: 'dev', label: 'Dev', connectorUrl: 'http://fixture', ownerUserId: user.id });
  let entered!: () => void, release!: () => void;
  const pending = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const remotes: string[] = [], deleted: string[] = []; let writes = 0;
  const routes = registerHubTerminals(app, { hubStore: hub, audit: h.audit,
    principal: c => { if (!h.authorized(c.req.raw)) throw new HTTPException(401); return { userId: user.id, admin: false }; },
    connectorClient: () => new ConnectorClient('http://fixture', 'synthetic', async req => {
      const path = new URL(req.url).pathname;
      if (req.method === 'DELETE') { deleted.push(path); return response({ stopped: true }); }
      if (path.endsWith('/input')) { writes++; return response({ accepted: true }); }
      if (path.endsWith('/output')) {
        if (path.includes(remotes[0]!)) { entered(); await gate; }
        return response({ data: 'PRIVATE output', cursor: 14, more: false, running: true, truncated: false });
      }
      const id = randomUUID(); remotes.push(id); return response({ id });
    }) });
  const base = '/api/hub/v1/connections/dev/terminals';
  const start = async (auth: typeof headers) => {
    const result = await app.request(base, { method: 'POST', headers: auth,
      body: JSON.stringify({ targetId: 'shell', requestId: randomUUID(), cols: 80, rows: 24 }) });
    assert.equal(result.status, 200); return (await result.json()).id;
  };
  try {
    const id = await start(headers), sibling = await start(siblingHeaders);
    const output = app.request(`${base}/${id}/output?cursor=0`, { headers }); await pending;
    h.manager.revoke(keyHash, revokedCredential); release();
    const result = await output;
    assert.equal(result.status, 403); assert.ok(!(await result.text()).includes('PRIVATE'));
    assert.equal((await app.request(`${base}/${id}/input`, { method: 'POST', headers, body: JSON.stringify({ sequence: 1, data: 'x' }) })).status, 401);
    assert.equal(writes, 0);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(deleted, [`/api/connector/v1/terminals/${remotes[0]}`]);
    assert.equal((await app.request(`${base}/${sibling}/output?cursor=0`, { headers: siblingHeaders })).status, 200);
    assert.equal((await app.request(`${base}/${id}/output?cursor=0`, { headers: siblingHeaders })).status, 404);
  } finally { release(); routes.close(); await new Promise(resolve => setImmediate(resolve)); hub.close(); }
});

function response(value: object) {
  return new Response(JSON.stringify(value), { headers: { [CONNECTOR_PROTOCOL_HEADER]: String(CONNECTOR_PROTOCOL.max) } });
}

test('self revocation returns successful reauthentication receipt, clears its cookie, and never reports a failed revoke', async t => {
  const h = sessionFixture(t), headers = await h.login();
  const result = await h.app.request('/api/auth/passkeys/' + h.manager.list(keyHash)[0]!.id, { method: 'DELETE', headers });
  assert.equal(result.status, 200); assert.deepEqual(await result.json(), { ok: true, reauthenticate: true });
  assert.match(result.headers.get('set-cookie')!, /agentopsdeck_session=;.*Max-Age=0/);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal(h.authorized(new Request(origin, { headers })), false);
  assert.equal(h.audit.list().filter(row => row.event === 'passkey_revoke' && row.outcome === 'success').length, 1);
});

test('access-key rotation invalidates persisted bound sessions even when the credential remains present', async t => {
  const h = sessionFixture(t), headers = await h.login();
  const rotated = keyIdentityHash('different-fixture-key');
  const sessions = new PersistentDeckSessionSet(h.file + '.sessions', b => b.keyIdentityHash === rotated && h.manager.isCredentialCurrent(b.credentialHash, b.keyIdentityHash));
  assert.equal(createAccessKeyGuard('different-fixture-key', sessions)(new Request(origin, { headers })), false);
  assert.equal(h.authorized(new Request(origin, { headers })), true, 'the independent original authority remains current');
});

test('failed persisted revocation preserves bound login until explicit successful retry', async t => {
  const h = sessionFixture(t), headers = await h.login(), id = h.manager.list(keyHash)[0]!.id;
  const bytes = readFileSync(h.file, 'utf8'), lock = h.file + '.writer-lock';
  mkdirSync(lock);
  try {
    const failed = await h.app.request('/api/auth/passkeys/' + id, { method: 'DELETE', headers });
    assert.equal(failed.status, 503); assert.equal(failed.headers.get('set-cookie'), null);
    assert.equal(h.authorized(new Request(origin, { headers })), true);
    assert.equal(readFileSync(h.file, 'utf8'), bytes);
    assert.equal(h.audit.list().filter(row => row.event === 'passkey_revoke' && row.outcome === 'success').length, 0);
  } finally { rmdirSync(lock); }
  const result = await h.app.request('/api/auth/passkeys/' + id, { method: 'DELETE', headers });
  assert.equal(result.status, 200); assert.equal(h.authorized(new Request(origin, { headers })), false);
});

for (const mode of ['idle', 'pending-start'] as const) test(`real passkey revocation cleans ${mode} PTY without waiting for browser input`, { timeout: 6000 }, async t => {
  const h = sessionFixture(t), headers = await h.login(), app = new Hono();
  const hub = new HubStore(h.file + '.sqlite', 'fixture'), user = hub.createUser('Owner'), remote = randomUUID();
  hub.upsertConnection({ id: 'dev', label: 'Dev', connectorUrl: 'http://fixture', ownerUserId: user.id });
  let entered!: () => void, release!: () => void, removed!: () => void;
  const starting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const cleanup = new Promise<void>(resolve => { removed = resolve; });
  const deleted: string[] = [];
  const routes = registerHubTerminals(app, { hubStore: hub, audit: h.audit,
    principal: c => { if (!h.authorized(c.req.raw)) throw new HTTPException(401); return { userId: user.id, admin: false }; },
    connectorClient: () => new ConnectorClient('http://fixture', 'synthetic', async req => {
      if (req.method === 'DELETE') { deleted.push(new URL(req.url).pathname); removed(); return response({ stopped: true }); }
      assert.equal(req.method, 'POST'); entered(); if (mode === 'pending-start') await gate;
      return response({ id: remote });
    }) });
  try {
    const creation = app.request('/api/hub/v1/connections/dev/terminals', { method: 'POST', headers,
      body: JSON.stringify({ targetId: 'shell', requestId: randomUUID(), cols: 80, rows: 24 }) });
    await starting;
    if (mode === 'idle') assert.equal((await creation).status, 200);
    h.manager.revoke(keyHash, h.manager.list(keyHash)[0]!.id); release();
    if (mode === 'pending-start') assert.equal((await creation).status, 403);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([cleanup, new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error('Revoked terminal was not cleaned within 3 seconds')), 3000);
      })]);
    } finally { clearTimeout(deadline); }
    assert.deepEqual(deleted, [`/api/connector/v1/terminals/${remote}`]);
  } finally { release(); routes.close(); await new Promise(resolve => setImmediate(resolve)); hub.close(); }
});

test('signed passkey login persists credential-bound sessions; revoke invalidates all its tokens and reload but preserves key login', async t => {
  const h = fixture(t), file = h.file + '.sessions';
  const current = (binding: {credentialHash:string;keyIdentityHash?:string}) => binding.keyIdentityHash === keyHash && h.manager.isCredentialCurrent(binding.credentialHash,binding.keyIdentityHash);
  const sessions = new PersistentDeckSessionSet(file,current), app = new Hono();
  const authorized = createAccessKeyGuard('fixture-access-key',sessions);
  registerAuthRoutes(app,{accessKey:'fixture-access-key',sessions,passkeys:h.manager,isAuthorizedRequest:authorized,auditLog:new AuthAuditLog(),loginLimiter:new LoginAttemptLimiter({maxFailures:5,windowMs:60_000,lockoutMs:30_000}),lockoutSeconds:30});
  const tokens: string[] = [];
  for (let counter=1;counter<=2;counter++) {
    const options = await h.manager.authenticationOptions(request(),keyHash);
    const response = await app.request(origin+'/api/auth/passkeys/login/verify',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(h.assertion(options.challenge,counter))});
    assert.equal(response.status,200);
    const cookie = response.headers.get('set-cookie')!; tokens.push(decodeURIComponent(cookie.split(';')[0]!.split('=')[1]!));
  }
  const keyLogin = await app.request(origin+'/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({accessKey:'fixture-access-key'})});
  assert.equal(keyLogin.status,200);
  const keyToken = decodeURIComponent(keyLogin.headers.get('set-cookie')!.split(';')[0]!.split('=')[1]!);
  const status = async (token: string) => (await (await app.request(origin+'/api/auth/status',{headers:{cookie:'agentopsdeck_session='+token}})).json()).authenticated;
  for (const token of tokens) { assert.equal(await status(token),true); assert.equal(new PersistentDeckSessionSet(file,current).has(token),true); }
  const credential = h.manager.list(keyHash)[0]!.id;
  const revoke = await app.request(origin+'/api/auth/passkeys/'+credential,{method:'DELETE',headers:{cookie:'agentopsdeck_session='+keyToken}});
  assert.equal(revoke.status,200);
  const reloadedManager = new PasskeyManager(h.file);
  const reloaded = new PersistentDeckSessionSet(file,b=>reloadedManager.isCredentialCurrent(b.credentialHash,b.keyIdentityHash));
  for (const token of tokens) { assert.equal(await status(token),false); assert.equal(reloaded.has(token),false); }
  assert.equal(await status(keyToken),true); assert.equal(reloaded.has(keyToken),true);
  assert.equal((await app.request(origin+'/api/auth/passkeys',{headers:{cookie:'agentopsdeck_session='+tokens[0]}})).status,401);
});

for (const mode of ['register', 'login'] as const) for (const rejectedStatus of [413, 429]) {
  test(`${mode} challenge survives body ${rejectedStatus} and accepts a real proof on explicit retry`, async t => {
    const h = fixture(t);
    const options = mode === 'register' ? await h.manager.registrationOptions(request(), keyHash)
      : await h.manager.authenticationOptions(request(), keyHash);
    const proof = mode === 'register' ? h.registration(options.challenge) : h.assertion(options.challenge);
    const app = new Hono(), sessions = new Set<string>(), auditLog = new AuthAuditLog();
    registerAuthRoutes(app, { accessKey: 'fixture-access-key', passkeys: h.manager, sessions, auditLog,
      isAuthorizedRequest: () => true,
      loginLimiter: new LoginAttemptLimiter({ maxFailures: 5, windowMs: 60_000, lockoutMs: 30_000 }), lockoutSeconds: 30 });
    const aborts: AbortController[] = [], pending: Array<Response | Promise<Response>> = [];
    t.after(() => aborts.forEach(a => a.abort()));
    if (rejectedStatus === 429) {
      let entered = 0, ready!: () => void;
      const started = new Promise<void>(resolve => { ready = resolve; });
      for (let i = 0; i < 8; i++) {
        const abort = new AbortController(); aborts.push(abort);
        pending.push(app.request(new Request(origin + '/api/auth/login', { method: 'POST', signal: abort.signal,
          // Signal actual body consumption, never the stream constructor's eager prefetch.
          body: new ReadableStream({ pull() { if (++entered === 8) ready(); } }, { highWaterMark: 0 }), duplex: 'half' } as RequestInit)));
      }
      await started;
    }
    const endpoint = origin + `/api/auth/passkeys/${mode}/verify`;
    const headers = { origin, 'content-type': 'application/json' };
    const rejected = await app.request(endpoint, { method: 'POST', headers,
      body: JSON.stringify(proof) + (rejectedStatus === 413 ? ' '.repeat(128 * 1024) : '') });
    assert.equal(rejected.status, rejectedStatus); assert.equal(rejected.headers.get('set-cookie'), null);
    assert.equal(sessions.size, 0); assert.deepEqual(auditLog.list(), []);
    aborts.forEach(a => a.abort());
    await Promise.all(pending);
    const accepted = await app.request(endpoint, { method: 'POST', headers, body: JSON.stringify(proof) });
    assert.equal(accepted.status, 200);
    assert.equal(mode === 'login' ? sessions.size : h.manager.status(keyHash).count, mode === 'login' ? 1 : 2);
    assert.equal(auditLog.list().filter(r => r.outcome === 'success').length, 1);
  });
}

function fixture(t: TestContext, maxChallenges = 2, maxVerifications = 8, maxVerificationsPerMinute = 120) {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-challenge-budget-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'passkeys.json');
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  // COSE EC2/P-256/ES256 map: {1:2, 3:-7, -1:1, -2:x, -3:y}.
  const cose = Buffer.concat([Buffer.from('a5010203262001215820', 'hex'), Buffer.from(jwk.x!, 'base64url'), Buffer.from('225820', 'hex'), Buffer.from(jwk.y!, 'base64url')]);
  const id = Buffer.from('budget-test-credential').toString('base64url');
  writeFileSync(file, JSON.stringify({ credentials: [{ id, publicKey: cose.toString('base64url'), counter: 0, rpId: 'hub.example', keyIdentityHash: keyHash, label: 'fixture', createdAt: 1 }] }));
  let now = 10_000;
  const manager = new PasskeyManager(file, { maxChallenges, maxVerifications, maxVerificationsPerMinute, now: () => now });
  const assertion = (challenge: string, counter = 1, credentialId = id): AuthenticationResponseJSON => {
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin }));
    const authData = Buffer.alloc(37);
    createHash('sha256').update('hub.example').digest().copy(authData);
    authData[32] = 5; // User presence and verification.
    authData.writeUInt32BE(counter, 33);
    const signature = sign('sha256', Buffer.concat([authData, createHash('sha256').update(clientData).digest()]), privateKey);
    return { id: credentialId, rawId: credentialId, type: 'public-key', clientExtensionResults: {}, response: {
      clientDataJSON: clientData.toString('base64url'), authenticatorData: authData.toString('base64url'), signature: signature.toString('base64url'),
    } };
  };
  const registration = (challenge: string) => {
    const credentialId = Buffer.from('new-budget-test-credential');
    const authData = Buffer.alloc(37 + 16 + 2);
    createHash('sha256').update('hub.example').digest().copy(authData);
    authData[32] = 69; // User presence, verification, attested credential data.
    authData.writeUInt16BE(credentialId.length, 53);
    const attestation = isoCBOR.encode(new Map<string, string | Map<string, string> | Uint8Array>([
      ['fmt', 'none'], ['attStmt', new Map()], ['authData', new Uint8Array(Buffer.concat([authData, credentialId, cose]))],
    ]));
    return { id: credentialId.toString('base64url'), rawId: credentialId.toString('base64url'), type: 'public-key' as const,
      clientExtensionResults: {}, response: { clientDataJSON: Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin })).toString('base64url'),
        attestationObject: Buffer.from(attestation).toString('base64url') } };
  };
  return { manager, file, assertion, registration, advance: (ms: number) => { now += ms; } };
}

test('verification frequency bounds fast failures regardless of spoofed source headers and credential IDs', async t => {
  const h = fixture(t);
  for (let i = 0; i < 120; i++) {
    const req = new Request(origin, { headers: { origin, 'x-forwarded-for': `198.51.100.${i}`, 'user-agent': `device-${i}` } });
    assert.equal((await h.manager.verifyAuthentication(req, { id: `untrusted-${i}` } as AuthenticationResponseJSON, keyHash)).verified, false);
  }
  await assert.rejects(h.manager.verifyAuthentication(request(), {} as AuthenticationResponseJSON, keyHash), error =>
    error instanceof PasskeyVerificationRateError && error.retryAfterSeconds === 60);
  h.advance(60_000);
  assert.equal((await h.manager.verifyAuthentication(request(), {} as AuthenticationResponseJSON, keyHash)).verified, false);
});

test('successful registration and login share frequency budget and rate rejection preserves a real signed challenge', async t => {
  const h = fixture(t, 2, 8, 2);
  const login = await h.manager.authenticationOptions(request(), keyHash);
  assert.equal((await h.manager.verifyAuthentication(request(), h.assertion(login.challenge), keyHash)).verified, true);
  const registration = await h.manager.registrationOptions(request(), keyHash);
  assert.equal((await h.manager.verifyRegistration(request(), h.registration(registration.challenge), { keyIdentityHash: keyHash })).verified, true);
  const next = await h.manager.authenticationOptions(request(), keyHash), proof = h.assertion(next.challenge, 2);
  await assert.rejects(h.manager.verifyAuthentication(request(), proof, keyHash), PasskeyVerificationRateError);
  h.advance(60_000);
  assert.equal((await h.manager.verifyAuthentication(request(), proof, keyHash)).verified, true);
});

test('verification frequency uses a rolling window and a backwards clock never grants extra attempts', async t => {
  const h = fixture(t, 2, 8, 2), attempt = () => h.manager.verifyAuthentication(request(), {} as AuthenticationResponseJSON, keyHash);
  await attempt(); h.advance(59_000); await attempt();
  await assert.rejects(attempt(), error => error instanceof PasskeyVerificationRateError && error.retryAfterSeconds === 1);
  h.advance(-50_000);
  await assert.rejects(attempt(), error => error instanceof PasskeyVerificationRateError && error.retryAfterSeconds === 1);
  h.advance(51_000); await attempt();
  await assert.rejects(attempt(), error => error instanceof PasskeyVerificationRateError && error.retryAfterSeconds === 59);
});

test('concurrency rejection does not consume frequency allowance or another signed challenge', async t => {
  const h = fixture(t, 2, 1, 2), a = await h.manager.authenticationOptions(request(), keyHash), b = await h.manager.authenticationOptions(request(), keyHash);
  const pending = h.manager.verifyAuthentication(request(), h.assertion(a.challenge), keyHash);
  await assert.rejects(h.manager.verifyAuthentication(request(), h.assertion(b.challenge, 2), keyHash), PasskeyVerificationCapacityError);
  assert.equal((await pending).verified, true);
  assert.equal((await h.manager.verifyAuthentication(request(), h.assertion(b.challenge, 2), keyHash)).verified, true);
});

for (const method of ['login', 'register'] as const) test(`verification frequency ${method} HTTP receipt is bounded and retryable without side effects`, async t => {
  const h = fixture(t, 2, 8, 1), app = new Hono(), sessions = new Set<string>(), audit = new AuthAuditLog();
  registerAuthRoutes(app, { accessKey: 'fixture-access-key', sessions, passkeys: h.manager, isAuthorizedRequest: () => true,
    auditLog: audit, loginLimiter: new LoginAttemptLimiter({ maxFailures: 5, windowMs: 60_000, lockoutMs: 30_000 }), lockoutSeconds: 30 });
  await h.manager.verifyAuthentication(request(), {} as AuthenticationResponseJSON, keyHash);
  const options = method === 'login' ? await h.manager.authenticationOptions(request(), keyHash) : await h.manager.registrationOptions(request(), keyHash);
  const proof = method === 'login' ? h.assertion(options.challenge) : h.registration(options.challenge);
  const before = readFileSync(h.file, 'utf8');
  const send = () => app.request(origin + `/api/auth/passkeys/${method}/verify`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(proof) });
  const limited = await send();
  assert.equal(limited.status, 429); assert.equal(limited.headers.get('cache-control'), 'no-store');
  assert.equal(limited.headers.get('retry-after'), '60'); assert.equal(limited.headers.get('set-cookie'), null);
  assert.deepEqual(await limited.json(), { error: 'passkey_verification_rate', retryAfterSeconds: 60 });
  assert.equal(readFileSync(h.file, 'utf8'), before); assert.equal(sessions.size, 0); assert.equal(audit.list().length, 0);
  h.advance(60_000);
  const retry = await send(); assert.equal(retry.status, 200);
  assert.equal(sessions.size, method === 'login' ? 1 : 0);
  assert.equal(audit.list().length, 1);
});

test('verification frequency cannot be disabled or expanded beyond its bounded maximum', t => {
  const h = fixture(t);
  for (const value of [0, -1, 1.5, 121, Infinity, NaN]) assert.throws(() => new PasskeyManager(h.file, { maxVerificationsPerMinute: value }), /maxVerificationsPerMinute/);
});

test('full registration pool preserves a valid attestation and registration remains one-shot', async t => {
  const h = fixture(t, 1);
  const first = await h.manager.registrationOptions(request(), keyHash);
  await assert.rejects(h.manager.registrationOptions(request(), keyHash), PasskeyChallengeCapacityError);
  const response = h.registration(first.challenge);
  assert.equal((await h.manager.verifyRegistration(request(), response, { keyIdentityHash: keyHash })).verified, true);
  assert.equal(h.manager.status(keyHash).count, 2);
  assert.equal((await h.manager.verifyRegistration(request(), response, { keyIdentityHash: keyHash })).verified, false);
  await h.manager.registrationOptions(request(), keyHash);
});

test('revocation during real signature verification prevents success and counter persistence', async t => {
  const h = fixture(t);
  const options = await h.manager.authenticationOptions(request(), keyHash);
  const pending = h.manager.verifyAuthentication(request(), h.assertion(options.challenge), keyHash);
  assert.equal(h.manager.revoke(keyHash, h.manager.list(keyHash)[0]!.id), true);
  assert.equal((await pending).verified, false);
  const stored = JSON.parse(readFileSync(h.file, 'utf8')).credentials[0];
  assert.equal(stored.counter, 0);
  assert.equal(stored.lastUsedAt, undefined);
  assert.equal(new PasskeyManager(h.file).status(keyHash).count, 0);
});

test('concurrent real assertions cannot both accept the same increasing counter', async t => {
  const h = fixture(t);
  const a = await h.manager.authenticationOptions(request(), keyHash);
  const b = await h.manager.authenticationOptions(request(), keyHash);
  const results = await Promise.all([
    h.manager.verifyAuthentication(request(), h.assertion(a.challenge), keyHash),
    h.manager.verifyAuthentication(request(), h.assertion(b.challenge), keyHash),
  ]);
  assert.equal(results.filter(r => r.verified).length, 1);
  assert.equal(JSON.parse(readFileSync(h.file, 'utf8')).credentials[0].counter, 1);
});

test('duplicate registration cannot replace an active or revoked credential', async t => {
  const h = fixture(t);
  const register = async () => {
    const options = await h.manager.registrationOptions(request(), keyHash);
    return h.manager.verifyRegistration(request(), h.registration(options.challenge), { keyIdentityHash: keyHash });
  };
  const first = await register();
  assert.equal(first.verified, true);
  assert.equal((await register()).verified, false);
  if (!first.verified) throw Error('fixture registration failed');
  assert.equal(h.manager.revoke(keyHash, first.credentialHash), true);
  assert.equal((await register()).verified, false);
  assert.equal(h.manager.status(keyHash).count, 1);
});

test('verification crossing challenge expiry is rejected after crypto completes', async t => {
  const h = fixture(t);
  const login = await h.manager.authenticationOptions(request(), keyHash);
  const pendingLogin = h.manager.verifyAuthentication(request(), h.assertion(login.challenge), keyHash);
  h.advance(ttl);
  assert.equal((await pendingLogin).verified, false);
  const register = await h.manager.registrationOptions(request(), keyHash);
  const pendingRegister = h.manager.verifyRegistration(request(), h.registration(register.challenge), { keyIdentityHash: keyHash });
  h.advance(ttl);
  assert.equal((await pendingRegister).verified, false);
  assert.equal(h.manager.status(keyHash).count, 1);
});

test('zero-counter authenticators remain usable across distinct concurrent challenges', async t => {
  const h = fixture(t);
  const a = await h.manager.authenticationOptions(request(), keyHash);
  const b = await h.manager.authenticationOptions(request(), keyHash);
  const results = await Promise.all([
    h.manager.verifyAuthentication(request(), h.assertion(a.challenge, 0), keyHash),
    h.manager.verifyAuthentication(request(), h.assertion(b.challenge, 0), keyHash),
  ]);
  assert.equal(results.every(r => r.verified), true);
});

test('registration losing authorization during attestation does not persist a key', async t => {
  const h = fixture(t);
  const options = await h.manager.registrationOptions(request(), keyHash);
  let authorized = true;
  const pending = h.manager.verifyRegistration(request(), h.registration(options.challenge), {
    keyIdentityHash: keyHash, isAuthorized: () => authorized,
  });
  authorized = false;
  assert.equal((await pending).verified, false);
  assert.equal(new PasskeyManager(h.file).status(keyHash).count, 1);
});

test('authentication proof becomes unusable when the exact credential is revoked', async t => {
  const h = fixture(t);
  const options = await h.manager.authenticationOptions(request(), keyHash);
  const result = await h.manager.verifyAuthentication(request(), h.assertion(options.challenge), keyHash);
  assert.equal(result.verified, true);
  if (!result.verified) throw Error('fixture authentication failed');
  assert.equal(result.isCurrent(), true);
  h.manager.revoke(keyHash, result.credentialHash);
  assert.equal(result.isCurrent(), false);
});

test('route rejects revocation after manager success but before session issuance', async t => {
  const h = fixture(t);
  const options = await h.manager.authenticationOptions(request(), keyHash);
  const verify = h.manager.verifyAuthentication.bind(h.manager);
  h.manager.verifyAuthentication = async (...args) => {
    const result = await verify(...args);
    if (result.verified) h.manager.revoke(keyHash, result.credentialHash);
    return result;
  };
  const app = new Hono();
  const sessions = new Set<string>();
  const auditLog = new AuthAuditLog();
  registerAuthRoutes(app, { accessKey: 'fixture-access-key', passkeys: h.manager, sessions,
    isAuthorizedRequest: () => true, auditLog,
    loginLimiter: new LoginAttemptLimiter({ maxFailures: 5, windowMs: 60_000, lockoutMs: 30_000 }), lockoutSeconds: 30 });
  const response = await app.request(origin + '/api/auth/passkeys/login/verify', {
    method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(h.assertion(options.challenge)),
  });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(sessions.size, 0);
  assert.equal(auditLog.list().some(r => r.outcome === 'success'), false);
});

test('registration route rechecks authorization after a delayed body and inside verification', async t => {
  for (const boundary of ['body', 'crypto']) {
    const h = fixture(t);
    const options = await h.manager.registrationOptions(request(), keyHash);
    let authorized = true;
    let checkedAfterBody!: () => void;
    const entered = new Promise<void>(resolve => { checkedAfterBody = resolve; });
    const app = new Hono();
    const auditLog = new AuthAuditLog();
    registerAuthRoutes(app, { accessKey: 'fixture-access-key', passkeys: h.manager, sessions: new Set(),
      isAuthorizedRequest: () => { checkedAfterBody(); return authorized; }, auditLog,
      loginLimiter: new LoginAttemptLimiter({ maxFailures: 5, windowMs: 60_000, lockoutMs: 30_000 }), lockoutSeconds: 30 });
    let controller!: ReadableStreamDefaultController;
    const body = new ReadableStream({ start(c) { controller = c; } });
    if (boundary === 'crypto') {
      const verify = h.manager.verifyRegistration.bind(h.manager);
      h.manager.verifyRegistration = (...args) => {
        const pending = verify(...args);
        authorized = false;
        return pending;
      };
    }
    const pending = app.request(new Request(origin + '/api/auth/passkeys/register/verify', {
      method: 'POST', headers: { origin, 'content-type': 'application/json' }, body, duplex: 'half',
    } as RequestInit));
    await entered;
    if (boundary === 'body') authorized = false;
    controller.enqueue(new TextEncoder().encode(JSON.stringify(h.registration(options.challenge))));
    controller.close();
    const response = await pending;
    assert.equal(response.status, 401, boundary);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(new PasskeyManager(h.file).status(keyHash).count, 1);
    assert.equal(auditLog.list().some(r => r.outcome === 'success'), false);
  }
});

test('verification slots are shared across registration and login; rejected challenges remain usable', async t => {
  const h = fixture(t, 2, 1);
  const a = await h.manager.authenticationOptions(request(), keyHash);
  const b = await h.manager.authenticationOptions(request(), keyHash);
  const r = await h.manager.registrationOptions(request(), keyHash);
  const first = h.manager.verifyAuthentication(request(), h.assertion(a.challenge), keyHash);
  await assert.rejects(h.manager.verifyRegistration(request(), h.registration(r.challenge), { keyIdentityHash: keyHash }), PasskeyVerificationCapacityError);
  await assert.rejects(h.manager.verifyAuthentication(request(), h.assertion(b.challenge, 2), keyHash), PasskeyVerificationCapacityError);
  assert.equal((await first).verified, true);
  const registration = h.manager.verifyRegistration(request(), h.registration(r.challenge), { keyIdentityHash: keyHash });
  await assert.rejects(h.manager.verifyAuthentication(request(), h.assertion(b.challenge, 2), keyHash), PasskeyVerificationCapacityError);
  assert.equal((await registration).verified, true);
  assert.equal((await h.manager.verifyAuthentication(request(), h.assertion(b.challenge, 2), keyHash)).verified, true);
});

test('verification slots release after rejection, malformed input and crypto exceptions', async t => {
  const h = fixture(t, 2, 1);
  assert.equal((await h.manager.verifyAuthentication(request(), null as never, keyHash)).verified, false);
  const invalid = await h.manager.authenticationOptions(request(), keyHash);
  const broken = h.assertion(invalid.challenge);
  broken.response.authenticatorData = 'invalid';
  await assert.rejects(h.manager.verifyAuthentication(request(), broken, keyHash));
  const valid = await h.manager.authenticationOptions(request(), keyHash);
  assert.equal((await h.manager.verifyAuthentication(request(), h.assertion(valid.challenge), keyHash)).verified, true);
  const registration = await h.manager.registrationOptions(request(), keyHash);
  const brokenRegistration = h.registration(registration.challenge);
  brokenRegistration.response.attestationObject = 'invalid';
  await assert.rejects(h.manager.verifyRegistration(request(), brokenRegistration, { keyIdentityHash: keyHash }));
  const retry = await h.manager.registrationOptions(request(), keyHash);
  assert.equal((await h.manager.verifyRegistration(request(), h.registration(retry.challenge), { keyIdentityHash: keyHash })).verified, true);
});

test('full verification budget never expires running work into oversubscription or queues work', async t => {
  const h = fixture(t, 2, 1);
  // Control only the scheduling boundary; all signature tests above use real crypto.
  const boundary = h.manager as unknown as { withVerificationSlot: <T>(verify: () => Promise<T>) => Promise<T> };
  let release!: () => void;
  const occupied = boundary.withVerificationSlot(() => new Promise<void>(resolve => { release = resolve; }));
  h.advance(ttl * 2);
  let invoked = false;
  await assert.rejects(boundary.withVerificationSlot(async () => { invoked = true; }), PasskeyVerificationCapacityError);
  assert.equal(invoked, false);
  release();
  await occupied;
  await boundary.withVerificationSlot(async () => { invoked = true; });
  assert.equal(invoked, true);
  for (const maxVerifications of [0, -1, 1.1, 33, Infinity, NaN]) {
    assert.throws(() => new PasskeyManager(h.file, { maxVerifications }), /maxVerifications/);
  }
});

test('both verification routes return bounded 429 without cookies or audit amplification, then recover', async t => {
  for (const kind of ['login', 'register'] as const) {
    const h = fixture(t, 2, 1);
    const options = kind === 'login' ? await h.manager.authenticationOptions(request(), keyHash) : await h.manager.registrationOptions(request(), keyHash);
    const payload = kind === 'login' ? h.assertion(options.challenge) : h.registration(options.challenge);
    const boundary = h.manager as unknown as { withVerificationSlot: <T>(verify: () => Promise<T>) => Promise<T> };
    let release!: () => void;
    const occupied = boundary.withVerificationSlot(() => new Promise<void>(resolve => { release = resolve; }));
    const app = new Hono(), sessions = new Set<string>(), auditLog = new AuthAuditLog();
    registerAuthRoutes(app, { accessKey: 'fixture-access-key', passkeys: h.manager, sessions,
      isAuthorizedRequest: () => true, auditLog,
      loginLimiter: new LoginAttemptLimiter({ maxFailures: 5, windowMs: 60_000, lockoutMs: 30_000 }), lockoutSeconds: 30 });
    const post = () => app.request(origin + '/api/auth/passkeys/' + kind + '/verify', {
      method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(payload),
    });
    try {
      const response = await post();
      assert.equal(response.status, 429);
      assert.equal(response.headers.get('retry-after'), '1');
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('set-cookie'), null);
      assert.deepEqual(await response.json(), { error: 'passkey_verification_capacity', retryAfterSeconds: 1 });
      assert.equal(sessions.size, 0);
      assert.equal(auditLog.list().length, 0);
    } finally { release(); await occupied; }
    const success = await post();
    assert.equal(success.status, 200, kind);
    assert.equal(sessions.size, kind === 'login' ? 1 : 0);
    assert.equal(auditLog.list().filter(r => r.outcome === 'success').length, 1);
  }
});

test('failed credential persistence preserves registration, counter and revocation state and allows explicit recovery', async t => {
  for (const operation of ['register', 'authenticate', 'revoke'] as const) {
    const h = fixture(t, 2, 1);
    const original = readFileSync(h.file, 'utf8');
    const id = h.manager.list(keyHash)[0]!.id;
    const register = await h.manager.registrationOptions(request(), keyHash);
    const login = await h.manager.authenticationOptions(request(), keyHash);
    // A real competing writer blocks persistence without replacing the authority.
    // Replacement is separately tested as stale-owner fail-closed, not retryable IO.
    const lock = h.file + '.writer-lock';
    mkdirSync(lock);
    if (operation === 'register') await assert.rejects(h.manager.verifyRegistration(request(), h.registration(register.challenge), { keyIdentityHash: keyHash }), AuthPersistenceError);
    if (operation === 'authenticate') await assert.rejects(h.manager.verifyAuthentication(request(), h.assertion(login.challenge), keyHash), AuthPersistenceError);
    if (operation === 'revoke') assert.throws(() => h.manager.revoke(keyHash, id), AuthPersistenceError);
    assert.equal(h.manager.status(keyHash).count, 1, operation);
    assert.equal(h.manager.list(keyHash)[0]!.lastUsedAt, undefined);
    assert.equal(readFileSync(h.file, 'utf8'), original);
    rmdirSync(lock);
    if (operation === 'register') {
      const fresh = await h.manager.registrationOptions(request(), keyHash);
      assert.equal((await h.manager.verifyRegistration(request(), h.registration(fresh.challenge), { keyIdentityHash: keyHash })).verified, true);
      assert.equal(new PasskeyManager(h.file).status(keyHash).count, 2);
    } else if (operation === 'authenticate') {
      const fresh = await h.manager.authenticationOptions(request(), keyHash);
      assert.equal((await h.manager.verifyAuthentication(request(), h.assertion(fresh.challenge), keyHash)).verified, true, 'failed commit did not advance memory counter');
      assert.equal(JSON.parse(readFileSync(h.file, 'utf8')).credentials[0].counter, 1);
    } else {
      assert.equal(h.manager.revoke(keyHash, id), true);
      assert.equal(new PasskeyManager(h.file).status(keyHash).count, 0);
    }
  }
});

test('registration, assertion and revocation routes report storage failure without false success or credential leaks', async t => {
  for (const operation of ['register', 'login', 'revoke'] as const) {
    const h = fixture(t);
    const options = operation === 'register' ? await h.manager.registrationOptions(request(), keyHash) : await h.manager.authenticationOptions(request(), keyHash);
    const id = h.manager.list(keyHash)[0]!.id;
    mkdirSync(h.file + '.writer-lock');
    const app = new Hono(), sessions = new Set<string>(), auditLog = new AuthAuditLog();
    registerAuthRoutes(app, { accessKey: 'fixture-access-key', passkeys: h.manager, sessions,
      isAuthorizedRequest: () => true, auditLog,
      loginLimiter: new LoginAttemptLimiter({ maxFailures: 5, windowMs: 60_000, lockoutMs: 30_000 }), lockoutSeconds: 30 });
    const path = operation === 'revoke' ? id : operation + '/verify';
    const response = await app.request(origin + '/api/auth/passkeys/' + path, {
      method: operation === 'revoke' ? 'DELETE' : 'POST', headers: { origin, 'content-type': 'application/json' },
      ...(operation === 'revoke' ? {} : { body: JSON.stringify(operation === 'register' ? h.registration(options.challenge) : h.assertion(options.challenge)) }),
    });
    assert.equal(response.status, 503, operation);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.deepEqual(await response.json(), { error: 'auth_persistence_failed' });
    assert.equal(sessions.size, 0);
    assert.equal(auditLog.list().length, 0);
    assert.equal(h.manager.status(keyHash).count, 1);
  }
});

test('full authentication pool preserves all issued challenges and accepts a real signature', async t => {
  const h = fixture(t);
  const first = await h.manager.authenticationOptions(request(), keyHash);
  await h.manager.authenticationOptions(request(), keyHash);
  await assert.rejects(h.manager.authenticationOptions(request(), keyHash), error => error instanceof PasskeyChallengeCapacityError && error.retryAfterSeconds === 300);
  const response = h.assertion(first.challenge);
  assert.equal((await h.manager.verifyAuthentication(request(), response, keyHash)).verified, true);
  assert.equal((await h.manager.verifyAuthentication(request(), response, keyHash)).verified, false);
  await h.manager.authenticationOptions(request(), keyHash);
  await assert.rejects(h.manager.authenticationOptions(request(), keyHash), PasskeyChallengeCapacityError);
});

for (const kind of ['authenticationOptions', 'registrationOptions'] as const) {
  test(`${kind}: concurrent generation shares a hard capacity with issued challenges`, async t => {
    const h = fixture(t);
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => h.manager[kind](request(), keyHash)));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 2);
    for (const result of results) if (result.status === 'rejected') assert.ok(result.reason instanceof PasskeyChallengeCapacityError);
    await assert.rejects(h.manager[kind](request(), keyHash), PasskeyChallengeCapacityError);
  });
}

test('registration and login budgets are independent; mismatch consumes only its own challenge', async t => {
  const h = fixture(t, 1);
  const registration = await h.manager.registrationOptions(request(), keyHash);
  const authentication = await h.manager.authenticationOptions(request(), keyHash);
  await assert.rejects(h.manager.registrationOptions(request(), keyHash), PasskeyChallengeCapacityError);
  await assert.rejects(h.manager.authenticationOptions(request(), keyHash), PasskeyChallengeCapacityError);
  assert.equal((await h.manager.verifyRegistration(request(), h.assertion(registration.challenge) as never, { keyIdentityHash: 'wrong' })).verified, false);
  await h.manager.registrationOptions(request(), keyHash);
  assert.equal((await h.manager.verifyAuthentication(request(), h.assertion(authentication.challenge), keyHash)).verified, true);
});

test('expiry at TTL frees slots and does not resurrect an old challenge', async t => {
  const h = fixture(t, 1);
  const old = await h.manager.authenticationOptions(request(), keyHash);
  h.advance(ttl - 1);
  await assert.rejects(h.manager.authenticationOptions(request(), keyHash), error => error instanceof PasskeyChallengeCapacityError && error.retryAfterSeconds === 1);
  h.advance(1);
  const fresh = await h.manager.authenticationOptions(request(), keyHash);
  assert.equal((await h.manager.verifyAuthentication(request(), h.assertion(old.challenge), keyHash)).verified, false);
  assert.equal((await h.manager.verifyAuthentication(request(), h.assertion(fresh.challenge), keyHash)).verified, true);
});

test('invalid signature consumes one slot, preserves other challenges, and cannot be retried', async t => {
  const h = fixture(t);
  const first = await h.manager.authenticationOptions(request(), keyHash);
  const second = await h.manager.authenticationOptions(request(), keyHash);
  const bad = h.assertion(first.challenge);
  bad.response.signature = sign('sha256', Buffer.from('wrong data'), generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey).toString('base64url');
  assert.equal((await h.manager.verifyAuthentication(request(), bad, keyHash)).verified, false);
  assert.equal((await h.manager.verifyAuthentication(request(), h.assertion(first.challenge), keyHash)).verified, false);
  await h.manager.authenticationOptions(request(), keyHash);
  assert.equal((await h.manager.verifyAuthentication(request(), h.assertion(second.challenge), keyHash)).verified, true);
});

test('generation failure releases reservation and pending generation cannot expire into over-allocation', async t => {
  const h = fixture(t, 1);
  // Exercise the same reservation boundary with a deterministically paused generator.
  const manager = h.manager as unknown as {
    authenticationChallenges: Map<string, never>;
    createChallenge: (map: Map<string, never>, metadata: { rpId: string; origin: string }, generate: () => Promise<{ challenge: string }>) => Promise<unknown>;
  };
  let reject!: (error: Error) => void;
  const pending = manager.createChallenge(manager.authenticationChallenges, { rpId: 'hub.example', origin }, () => new Promise((_resolve, fail) => { reject = fail; }));
  const failed = assert.rejects(pending, /generation failed/);
  h.advance(ttl + 1);
  await assert.rejects(h.manager.authenticationOptions(request(), keyHash), error => error instanceof PasskeyChallengeCapacityError && error.retryAfterSeconds === 1);
  reject(new Error('generation failed'));
  await failed;
  await h.manager.authenticationOptions(request(), keyHash);
});

test('bad inputs do not reclaim unrelated issued challenges', async t => {
  const h = fixture(t, 1);
  const first = await h.manager.authenticationOptions(request(), keyHash);
  for (const data of ['', 'not json', Buffer.from('{}').toString('base64url'), 'a'.repeat(16_385)]) {
    const malformed = h.assertion('unknown');
    malformed.response.clientDataJSON = data;
    assert.equal((await h.manager.verifyAuthentication(request(), malformed, keyHash)).verified, false);
  }
  await assert.rejects(h.manager.authenticationOptions(request(), keyHash), PasskeyChallengeCapacityError);
  assert.equal((await h.manager.verifyAuthentication(request(), h.assertion(first.challenge), keyHash)).verified, true);
});

test('constructor budget validation, default capacity and process restart semantics', async t => {
  const h = fixture(t);
  for (const maxChallenges of [0, -1, 1.5, 257, Infinity, NaN]) assert.throws(() => new PasskeyManager(h.file, { maxChallenges }), /maxChallenges/);
  const manager = new PasskeyManager(h.file);
  const results = await Promise.allSettled(Array.from({ length: 257 }, () => manager.authenticationOptions(request(), keyHash)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 256);
  assert.equal(results.filter(r => r.status === 'rejected').length, 1);
  const old = await h.manager.authenticationOptions(request(), keyHash);
  const restarted = new PasskeyManager(h.file, { maxChallenges: 1 });
  assert.equal((await restarted.verifyAuthentication(request(), h.assertion(old.challenge), keyHash)).verified, false);
  await restarted.authenticationOptions(request(), keyHash);
});

test('HTTP options expose 429/no-store/Retry-After without sessions; existing challenge still logs in', async t => {
  const h = fixture(t, 1);
  const app = new Hono();
  const sessions = new Set<string>();
  registerAuthRoutes(app, { accessKey: 'fixture-access-key', passkeys: h.manager, sessions,
    isAuthorizedRequest: req => req.headers.get('x-test-authorized') === 'yes', auditLog: new AuthAuditLog(),
    loginLimiter: new LoginAttemptLimiter({ maxFailures: 5, windowMs: 60_000, lockoutMs: 30_000 }), lockoutSeconds: 30 });
  const post = (path: string, body?: unknown, authorized = false) => app.request(origin + '/api/auth/passkeys/' + path, {
    method: 'POST', headers: { origin, 'content-type': 'application/json', ...(authorized ? { 'x-test-authorized': 'yes' } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.equal((await post('register/options')).status, 401);
  for (const path of ['register/options', 'login/options']) {
    const first = await post(path, undefined, true);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('cache-control'), 'no-store');
    const options = await first.json() as { challenge: string };
    const full = await post(path, undefined, true);
    assert.equal(full.status, 429);
    assert.equal(full.headers.get('retry-after'), '300');
    assert.equal(full.headers.get('cache-control'), 'no-store');
    assert.equal(full.headers.get('set-cookie'), null);
    assert.deepEqual(await full.json(), { error: 'passkey_challenge_capacity', retryAfterSeconds: 300 });
    assert.equal(sessions.size, 0);
    if (path === 'login/options') {
      const login = await post('login/verify', h.assertion(options.challenge));
      assert.equal(login.status, 200);
      assert.match(login.headers.get('set-cookie')!, /agentopsdeck_session=/);
      assert.equal(sessions.size, 1);
      assert.equal((await post('login/verify', h.assertion(options.challenge))).status, 401);
      assert.equal(sessions.size, 1);
    }
  }
  h.advance(ttl);
  assert.equal((await post('register/options', undefined, true)).status, 200);
  assert.equal((await post('login/options')).status, 200);
});
