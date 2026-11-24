import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAsyncStandaloneAuthLayer } from './application-standalone-auth-async.js';
import { loadConfig } from './config.js';
import { AuthPersistenceError } from './auth/private-store.js';
import { startupApplicationCleanup } from './lifecycle/startup-cleanup.js';
import { startupDatabaseOwners } from './storage/startup-owner.js';
import { ApplicationCommandScopeError, type ApplicationCommandScope } from './auth/application-command-scope.js';

const accessKey = 'fixture-standalone-key', origin = 'http://auth.example';
async function fixture(t: TestContext, format: 'json' | 'sqlite' = 'sqlite', keyed = true) {
  const root = mkdtempSync(join(tmpdir(), 'standalone-auth-layer-'));
  const config = loadConfig({ HOME: root, AOD_SERVER_ROLE: 'connector',
    AOD_PASSKEYS_FILE: join(root, 'passkeys.json'), AOD_AUTH_SESSIONS_FILE: join(root, 'sessions.json'),
    ...(keyed ? { AOD_ACCESS_KEY: accessKey } : {}),
    ...(format === 'sqlite' ? { AOD_AUTH_SQLITE_FILE: join(root, 'auth.sqlite') } : {}) });
  const layers: Awaited<ReturnType<typeof createAsyncStandaloneAuthLayer>>[] = [];
  t.after(async () => {
    try { for (const layer of layers) await layer.close(); }
    finally { rmSync(root, { recursive: true, force: true }); }
  });
  const open = async (options?: Parameters<typeof createAsyncStandaloneAuthLayer>[1]) => {
    const layer = await createAsyncStandaloneAuthLayer(config, options); layers.push(layer);
    // The private layer publishes no process health or incomplete Connector root.
    layer.app.get('/api/probe', c => c.json({ original: true }));
    return layer;
  };
  const request = (layer: Awaited<ReturnType<typeof open>>, path: string, init?: RequestInit) => layer.app.request(origin + path, init);
  const login = async (layer: Awaited<ReturnType<typeof open>>) => {
    const response = await request(layer, '/api/auth/login', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accessKey }) });
    assert.equal(response.status, 200);
    const session = response.headers.getSetCookie().find(cookie => cookie.startsWith('agentopsdeck_session='))?.split(';')[0];
    assert.ok(session); return session;
  };
  return { root, config, open, request, login };
}

for (const format of ['json', 'sqlite'] as const) for (const keyed of [true, false]) {
  test(`standalone ${format}/${keyed ? 'Key' : 'no Key'}: original HTTP login, current session, logout and reopen`, async t => {
    const h = await fixture(t, format, keyed), first = await h.open();
    assert.equal((await h.request(first, '/api/probe')).status, keyed ? 401 : 200);
    assert.equal(await first.observeActor(new Request(origin)), keyed ? undefined : 'local:daily');
    const session = await h.login(first), headers = { cookie: session };
    assert.equal((await h.request(first, '/api/probe', { headers })).status, 200);
    assert.equal(await first.observeActor(new Request(origin, { headers })), 'local:daily');
    // Standalone legacy authorization is session-first, unlike the narrower
    // Hub key-provenance check. An invalid explicit key cannot erase a valid
    // original standalone session; no member identity is manufactured.
    assert.equal((await h.request(first, '/api/probe', { headers: { ...headers, 'x-agentopsdeck-key': 'wrong' } })).status, 200);
    const status = await h.request(first, '/api/auth/status', { headers });
    assert.equal(status.status, 200); assert.equal((await status.json() as { authenticated: boolean }).authenticated, true);
    assert.equal((await h.request(first, '/api/health', { headers })).status, 404);
    assert.equal((await h.request(first, '/api/connector/v1/node', { headers })).status, 404);
    await first.close();
    const second = await h.open();
    assert.equal((await h.request(second, '/api/probe', { headers })).status, 200);
    const loggedOut = await h.request(second, '/api/auth/logout', { method: 'POST', headers });
    assert.equal(loggedOut.status, 200);
    assert.equal((await h.request(second, '/api/probe', { headers })).status, keyed ? 401 : 200);
    if (format === 'json') assert.ok(readdirSync(h.root).every(file => !file.includes('sqlite')));
    assert.equal(startupApplicationCleanup.snapshot().pending, 0);
  });
}

test('standalone application authorization preserves CSRF and explicit signed-media bypass', async t => {
  const h = await fixture(t), signed = new WeakSet<Request>();
  const layer = await h.open({ signedStream: request => signed.has(request) });
  const headers = { 'x-agentopsdeck-key': accessKey, origin: 'http://other.example' };
  assert.equal((await h.request(layer, '/api/probe', { method: 'POST', headers })).status, 403);
  assert.equal((await h.request(layer, '/api/auth/login', { method: 'POST', headers,
    body: JSON.stringify({ accessKey }) })).status, 403);
  const request = new Request(origin + '/api/probe'); signed.add(request);
  assert.equal((await layer.app.fetch(request)).status, 200);
  assert.equal((await layer.app.fetch(new Request(request))).status, 401);
  assert.equal(await layer.observeActor(request), undefined, 'signed media is not a local actor or write capability');
});

test('standalone current configuration Key binding fails closed without replacing its original owner', async t => {
  const h = await fixture(t), layer = await h.open(), session = await h.login(layer);
  h.config.accessKey = 'changed-configuration-key';
  assert.equal((await h.request(layer, '/api/probe', { headers: { cookie: session } })).status, 503);
  assert.equal((await h.request(layer, '/api/auth/status', { headers: { cookie: session } })).status, 503);
  await assert.rejects(layer.observeActor(new Request(origin, { headers: { cookie: session } })), AuthPersistenceError);
  await layer.close();
  const next = await h.open();
  assert.equal((await h.request(next, '/api/probe', { headers: { cookie: session } })).status, 401);
  assert.equal((await h.request(next, '/api/probe', { headers: { 'x-agentopsdeck-key': h.config.accessKey } })).status, 200);
});

test('standalone close freezes new requests and retains the Auth owner until the original handler drains', async t => {
  const h = await fixture(t), layer = await h.open();
  let started!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  layer.app.get('/api/held', async c => { started(); await gate; return c.json({ ok: true }); });
  const pending = h.request(layer, '/api/held', { headers: { 'x-agentopsdeck-key': accessKey } });
  await entered;
  const close = layer.close(); let closed = false; void close.then(() => { closed = true; });
  try {
    assert.equal((await h.request(layer, '/api/probe', { headers: { 'x-agentopsdeck-key': accessKey } })).status, 503);
    await assert.rejects(layer.observeActor(new Request(origin, { headers: { 'x-agentopsdeck-key': accessKey } })), AuthPersistenceError);
    assert.equal(closed, false);
    assert.throws(() => startupDatabaseOwners.reserveExclusive(h.config.authSqliteFile!));
  } finally { release(); await pending; await close; }
  const replacement = await h.open();
  assert.equal((await h.request(replacement, '/api/probe', { headers: { 'x-agentopsdeck-key': accessKey } })).status, 200);
});

test('standalone role guards run before database acquisition and failed startup retains no leaked owner', async t => {
  const h = await fixture(t);
  h.config.serverRole = 'all';
  await assert.rejects(h.open(), /Standalone Auth layer/);
  h.config.serverRole = 'connector';
  // A directory is an invalid SQLite database, not permission to open JSON.
  mkdirSync(h.config.authSqliteFile!);
  await assert.rejects(h.open());
  assert.equal(startupApplicationCleanup.snapshot().pending, 0);
  const release = startupDatabaseOwners.reserveExclusive(h.config.authSqliteFile!); release();
});

const commandIntent = { action: 'message', runtime: 'codex', resource: 'original-local-session',
  commandKey: 'original-message-key', payloadDigest: 'a'.repeat(64) } as const;

for (const format of ['json', 'sqlite'] as const) for (const keyed of [true, false]) {
  test(`standalone ${format}/${keyed ? 'Key' : 'no Key'} command uses original session-first current Auth after logout`, async t => {
    const h = await fixture(t, format, keyed), layer = await h.open(), cookie = await h.login(layer);
    const original = new Request(origin, { headers: { cookie, 'x-agentopsdeck-key': 'invalid-key' } });
    assert.equal(await layer.commands.run(original, commandIntent, async scope => {
      const logout = await h.request(layer, '/api/auth/logout', { method: 'POST', headers: { cookie } });
      assert.equal(logout.status, 200);
      original.headers.set('x-agentopsdeck-key', accessKey); // Cannot upgrade original invalid Key evidence.
      original.headers.set('cookie', 'agentopsdeck_session=replaced');
      if (keyed) {
        await assert.rejects(scope.authorize('effect'), error => error instanceof ApplicationCommandScopeError && error.code === 'unauthorized');
      } else await scope.authorize('effect');
      // Already obtained original effects/receipts still own settlement; no
      // automatic replay, synthetic token or late grant is manufactured.
      return 'original-receipt-settled';
    }), 'original-receipt-settled');
    assert.equal(layer.commands.pending, 0);
  });

  test(`standalone ${format}/${keyed ? 'Key' : 'no Key'} close retains Auth until detached physical command settles`, async t => {
    const h = await fixture(t, format, keyed), layer = await h.open();
    let start!: () => void, release!: () => void, scope!: ApplicationCommandScope;
    const entered = new Promise<void>(resolve => { start = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const flight = layer.commands.run(new Request(origin, { headers: { 'x-agentopsdeck-key': accessKey } }), commandIntent, async current => {
      scope = current; await current.authorize('effect'); start(); await gate; return 'late-original-ack';
    });
    await entered;
    const closing = layer.close(); let closed = false; void closing.then(() => { closed = true; });
    try {
      assert.throws(scope.local, ApplicationCommandScopeError);
      assert.equal(closed, false); assert.equal(layer.commands.pending, 1);
      // A second owner cannot steal either original format while HTTP has
      // drained but the accepted physical command has not settled.
      assert.throws(() => startupDatabaseOwners.reserveExclusive(format === 'sqlite' ? h.config.authSqliteFile! : h.config.authSessionsFile));
    } finally { release(); assert.equal(await flight, 'late-original-ack'); await closing; }
    const next = await h.open();
    assert.equal(await next.commands.run(new Request(origin, { headers: { 'x-agentopsdeck-key': accessKey } }), commandIntent,
      async current => { await current.authorize('effect'); return 'fresh-ack'; }), 'fresh-ack');
  });
}
