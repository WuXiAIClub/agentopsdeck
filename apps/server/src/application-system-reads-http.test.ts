import assert from 'node:assert/strict';
import { awaitHttpAdmission, controlledHttpDeadline } from './lifecycle/http-deadline-test-support.js';
import test, { type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { loadConfig } from './config.js';
import { AdminRpcClient } from './gateway/admin-client.js';
import { GatewayWsClient } from './gateway/ws-client.js';
import { createApplicationTransactionLink } from './auth/application-transaction-gate.js';
import { originalApplicationAuthFixture } from './auth/application-transaction-test-fixture.js';
import { registerApplicationSystemReadsHttp } from './application-system-reads-http.js';
import { PerformanceDiagnostics } from './diagnostics/performance.js';
import { EXPECTED_NODE_HEADER } from './connector/node-identity.js';
import { createApplicationCommandScopes } from './auth/application-command-scope.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
async function fixture(t: TestContext, role: 'hub' | 'standalone' = 'hub', mode: 'sqlite' | 'json' = 'sqlite', keyed = true, requestWaitMs = 5_000, management = false) {
  const root = await mkdtemp(join(tmpdir(), 'application-system-read-'));
  const logs: string[] = [], diagnostics = new PerformanceDiagnostics(line => logs.push(line));
  const link = createApplicationTransactionLink(), session = 'b'.repeat(43), key = 'isolated-original-system-access';
  const auth = originalApplicationAuthFixture(root, role, mode, keyed ? key : undefined, diagnostics, link.auth);
  let close: (() => Promise<void>) | undefined;
  const releases = new Set<() => void>();
  const gateway = new GatewayWsClient({ url: undefined, ownerToken: undefined, password: undefined, diagnostics });
  t.after(async () => { for (const release of releases) release(); try { await close?.(); await auth.closeForShutdown(); await gateway.closeAndDrain(); }
    finally { link.closeUnused(); await rm(root, { recursive: true, force: true }); } });
  await auth.open(); if (keyed) await auth.issueSession(session);
  const config = loadConfig({ HOME: root, AOD_ACCESS_KEY: key, AOD_OWNER_TOKEN: 'isolated-owner-system-secret',
    AOD_CONNECTOR_UPDATE_STATE_FILE: join(root, 'update.json') });
  const admin = new AdminRpcClient({ url: undefined, ownerToken: undefined });
  let probe: (() => Promise<void>) | undefined, calls = 0, updates = 0, local = false, available = true;
  let observed: (() => Promise<void>) | undefined;
  let effect: (() => Promise<void>) | undefined, effects = 0;
  const commands = createApplicationCommandScopes({ authorize: async request => auth.authorize(request),
    assertAvailable: () => { if (!available) throw Error('draining'); }, diagnostics });
  const app = new Hono();
  const http = registerApplicationSystemReadsHttp(app, {
    config: { ...config, get localOpenClawCli() { return local; } }, admin, gateway,
    store: { updateGateway() { updates++; } }, diagnostics, requestWaitMs,
    observeActor: async request => { const ok = await auth.authorize(request); await observed?.(); return ok ? 'original-admin' : undefined; },
    available: () => available, normalizeError: () => 'system source unavailable',
    statusProbe: async () => { calls++; await probe?.(); return { gateway: { reachable: true } }; },
    ...(management ? { commands, restartEffect: async () => {
      effects++; await effect?.(); return { method: 'openclaw gateway restart', stdout: 'restarted', stderr: '' };
    } } : {}),
  });
  close = async () => { await http.close(); await commands.close(); };
  app.all('*', c => c.json({ legacy: true }, 404));
  const headers = keyed ? { cookie: `agentopsdeck_session=${session}` } : {};
  const request = (path: string, extra: Record<string, string> = {}, signal?: AbortSignal, method = 'GET') => app.request(`/api/${path}`, {
    method,
    headers: { ...headers, ...extra }, ...(signal ? { signal } : {}),
  });
  return { app, http, logs, request, headers, revoke: () => auth.revokeSession(session),
    gate() { const held = gate(); releases.add(held.release); return held; },
    probe(value: typeof probe) { probe = value; local = true; }, calls: () => calls, updates: () => updates,
    effect(value: typeof effect) { effect = value; }, effects: () => effects, local(value: boolean) { local = value; },
    restart: (extra: Record<string, string> = {}, signal?: AbortSignal) => request('gateway/restart', extra, signal, 'POST'),
    observed(value: typeof observed) { observed = value; }, available(value: boolean) { available = value; } };
}

for (const role of ['hub', 'standalone'] as const) for (const mode of ['sqlite', 'json'] as const) for (const keyed of [true, false])
  test(`${role}/${mode}/${keyed ? 'Cookie' : 'no Key'} original Gateway restart management chain`, async t => {
    const f = await fixture(t, role, mode, keyed, 5000, true);
    assert.equal((await f.restart()).status, 502); assert.equal(f.effects(), 0, 'remote CLI policy cannot be bypassed');
    f.local(true);
    const response = await f.restart(); assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json(); assert.equal(body.result.method, 'openclaw gateway restart'); assert.equal(body.ok, true);
    assert.equal(f.effects(), 1); assert.equal(f.calls(), 1); assert.equal(f.updates(), 1);
    for (const extra of [{ 'x-agentopsdeck-execution-grant': 'forged' }, { [EXPECTED_NODE_HEADER]: 'forged' }])
      assert.equal((await f.restart(extra)).status, 403);
    assert.equal(f.effects(), 1);
    if (keyed) {
      await f.revoke(); assert.equal((await f.restart()).status, 403); assert.equal(f.effects(), 1);
      assert.equal((await f.restart({ authorization: 'Bearer isolated-original-system-access' })).status, 200);
      assert.equal(f.effects(), 2, 'original Key remains accepted independently of a revoked Cookie');
    }
    assert.doesNotMatch(f.logs.join('\n'), /isolated-original|isolated-owner|agentopsdeck_session/);
  });

test('Gateway final actor fence denies revocation before CLI; original CLI failure remains 502', async t => {
  const f = await fixture(t, 'hub', 'sqlite', true, 5000, true); f.local(true);
  f.effect(async () => { throw Error('private native failure'); });
  assert.equal((await f.restart()).status, 502); assert.equal(f.effects(), 1); assert.equal(f.updates(), 0);
  let observations = 0;
  f.observed(async () => { if (++observations === 2) await f.revoke(); });
  assert.equal((await f.restart()).status, 403); assert.equal(f.effects(), 1);
});

for (const ending of ['timeout', 'disconnect', 'close'] as const)
  test(`Gateway restart ${ending} keeps one original CLI and subsequent health projection until drain`, { timeout: 15000 }, async t => {
    const f = await fixture(t, 'standalone', 'sqlite', true, ending === 'timeout' ? 150 : 5000, true);
    f.local(true); const entered = f.gate(), native = f.gate(), health = f.gate(), probing = f.gate();
    f.effect(async () => { entered.release(); await native.promise; });
    f.probe(async () => { probing.release(); await health.promise; });
    const clock = ending === 'timeout' ? controlledHttpDeadline(t) : undefined;
    try {
      const controller = new AbortController(), pending = f.restart({}, controller.signal);
      await awaitHttpAdmission(entered.promise, pending);
      if (clock) assert.equal((await clock.expire(150, pending)).status, 503);
      if (ending === 'disconnect') controller.abort();
      if (ending !== 'close') assert.equal((await pending).status, ending === 'disconnect' ? 408 : 503);
      let drained = false; const closing = f.http.close().then(() => { drained = true; });
      await tick(); assert.equal(drained, false); assert.equal(f.effects(), 1);
      assert.equal((await f.restart()).status, 503);
      native.release(); await probing.promise; await tick(); assert.equal(drained, false);
      health.release(); await closing; assert.notEqual((await pending).status, 200);
      assert.equal(f.effects(), 1); assert.equal(f.calls(), 1); assert.equal(f.updates(), 1);
    } finally { clock?.restore(); native.release(); health.release(); }
  });

for (const role of ['hub', 'standalone'] as const) for (const mode of ['sqlite', 'json'] as const)
  test(`${role}/${mode} public health does not grant protected system reads`, async t => {
    const f = await fixture(t, role, mode);
    f.observed(async () => assert.fail('Public health must not query user authority'));
    for (const method of ['GET', 'HEAD']) {
      const response = await f.app.request('/api/health', { method });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      if (method === 'GET') assert.deepEqual(Object.keys(await response.json()).sort(), ['ok', 'service', 'ts']);
    }
    f.observed(undefined);
    for (const path of ['config/debug', 'gateway/status'])
      assert.equal((await f.app.request(`/api/${path}`)).status, 403);
    assert.equal(f.calls(), 0);
    f.available(false);
    assert.equal((await f.app.request('/api/health')).status, 503);
  });

for (const role of ['hub', 'standalone'] as const) for (const mode of ['sqlite', 'json'] as const) for (const keyed of [true, false])
  test(`${role}/${mode}/${keyed ? 'Cookie' : 'no Key'} original system reads and precise route selection`, async t => {
    const f = await fixture(t, role, mode, keyed);
    const health = await f.request('health'); assert.equal(health.status, 200);
    assert.equal(health.headers.get('cache-control'), 'no-store'); assert.equal((await health.json()).service, 'agentopsdeck');
    const debug = await f.request('config/debug'); assert.equal(debug.status, 200);
    const text = await debug.text(); assert.doesNotMatch(text, /isolated-original-system-access|isolated-owner-system-secret/);
    const status = await f.request('gateway/status'); assert.equal(status.status, 200);
    const body = await status.json(); assert.equal(body.enabled, false); assert.equal(body.details.source, 'disabled');
    assert.equal(f.calls(), 0); assert.equal(f.updates(), 1);
    assert.equal((await f.request('gateway/status')).status, 200); assert.equal(f.updates(), 1, 'original cache is retained');
    for (const path of ['health', 'config/debug', 'gateway/status']) {
      assert.equal((await f.request(path, { 'x-agentopsdeck-execution-grant': 'not-user-authority' })).status, 403);
      assert.equal((await f.request(path, { [EXPECTED_NODE_HEADER]: 'not-user-authority' })).status, 403);
    }
    for (const path of ['agents', 'connector/v1/health']) assert.equal((await f.request(path)).status, 404);
    assert.equal((await f.app.request('/api/gateway/restart', { method: 'POST', headers: f.headers })).status, 404);
    if (keyed) assert.equal((await f.app.request('/api/config/debug', { headers: { authorization: 'Bearer machine-only' } })).status, 403);
  });

for (const role of ['hub', 'standalone'] as const) for (const mode of ['sqlite', 'json'] as const)
  test(`${role}/${mode} original system probe singleflight and delivery revocation`, async t => {
    const f = await fixture(t, role, mode), entered = f.gate(), held = f.gate();
    f.probe(async () => { entered.release(); await held.promise; });
    try {
      const first = f.request('gateway/status'), second = f.request('gateway/status');
      await awaitHttpAdmission(entered.promise, first); await f.revoke(); held.release();
      assert.equal((await first).status, 403); assert.equal((await second).status, 403);
      assert.equal(f.calls(), 1); assert.equal(f.updates(), 1, 'completed original observation is not replayed or rolled back');
      assert.equal((await f.request('config/debug')).status, 403);
    } finally { held.release(); }
  });

for (const ending of ['timeout', 'disconnect', 'close'] as const)
  test(`original system ${ending} retains native work until physical shutdown settlement`, { timeout: 15_000 }, async t => {
    const f = await fixture(t, 'standalone', 'sqlite', true, ending === 'timeout' ? 1_000 : 5_000);
    const entered = f.gate(), held = f.gate();
    f.probe(async () => { entered.release(); await held.promise; });
    const clock = ending === 'timeout' ? controlledHttpDeadline(t) : undefined;
    try {
      const controller = new AbortController(), request = f.request('gateway/status', {}, controller.signal);
      await awaitHttpAdmission(entered.promise, request);
      if (clock) assert.equal((await clock.expire(1000, request)).status, 503);
      if (ending === 'disconnect') controller.abort();
      if (ending !== 'close') assert.notEqual((await request).status, 200);
      let drained = false; const closing = f.http.close().then(() => { drained = true; });
      await tick(); await tick(); assert.equal(drained, false); assert.equal(f.calls(), 1);
      assert.equal((await f.request('health')).status, 503);
      assert.equal(f.http.close(), f.http.close());
      held.release(); await closing; assert.notEqual((await request).status, 200);
      assert.equal(drained, true); assert.equal(f.calls(), 1);
      assert.doesNotMatch(f.logs.join('\n'), /isolated-owner|isolated-original|agentopsdeck_session/);
    } finally { clock?.restore(); held.release(); }
  });
