import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { loadConfig } from '../config.js';
import { registerSystemRoutes } from './system.js';
import { publicGatewayHealth } from './system-public-diagnostics.js';

type Dependencies = Parameters<typeof registerSystemRoutes>[1];

function fixture(connected = false) {
  const app = new Hono();
  const updates: unknown[] = [];
  let probes = 0, restarts = 0;
  const deps = {
    config: { ...loadConfig({ AOD_OPENCLAW_GATEWAY_WS_URL: 'PRIVATE-config-ws',
      AOD_OPENCLAW_GATEWAY_ADMIN_RPC_URL: 'PRIVATE-config-admin', AOD_ACCESS_KEY: 'PRIVATE-config-key',
      AOD_OPENCLAW_GATEWAY_OWNER_TOKEN: 'PRIVATE-config-owner', AOD_OPENCLAW_GATEWAY_PASSWORD: 'PRIVATE-config-password' }),
      localOpenClawCli: true, defaultAgentId: 'main' },
    gateway: { status: () => ({ configured: true, connected, url: 'PRIVATE-endpoint', lastFailure: 'PRIVATE-failure' }) },
    admin: { status: () => ({ configured: true, url: 'PRIVATE-admin' }) },
    store: { updateGateway: (health: unknown) => updates.push(health) },
    readsOnly: true,
    normalizeError: () => 'PRIVATE-normalized-error',
    statusProbe: async () => {
      probes++;
      return { runtimeVersion: 'PRIVATE-version', gateway: { reachable: true, url: 'PRIVATE-url',
        error: 'PRIVATE-error', authWarning: 'PRIVATE-warning', self: { host: 'PRIVATE-host', ip: 'PRIVATE-ip' } },
      agents: { defaultId: 'PRIVATE-agent' }, sessions: { defaults: { model: 'PRIVATE-model' } },
      heartbeat: { agents: [{ token: 'PRIVATE-token' }] }, service: { path: 'PRIVATE-path' },
      rpc: { ok: true, error: 'PRIVATE-rpc-error' } };
    },
    restart: { run: async (_request: Request, work: (check: () => Promise<void>) => Promise<unknown>) => work(async () => {}) },
    restartEffect: async () => { restarts++; return { stdout: 'PRIVATE-stdout', stderr: 'PRIVATE-stderr', extra: 'PRIVATE-result' }; },
  } as unknown as Dependencies;
  const owner = registerSystemRoutes(app, deps);
  return { app, updates, owner, calls: () => ({ probes, restarts }) };
}

for (const connected of [false, true]) test(`successful health and restart whitelist diagnostics (connected=${connected})`, async () => {
  const state = fixture(connected);
  try {
    const first = await state.app.request('/api/gateway/status');
    assert.equal(first.status, 200);
    const health = await first.json();
    assert.equal(health.ok, true);
    assert.equal(health.defaultAgentId, 'main');
    assert.deepEqual(health.gatewayWs, { configured: true, connected });
    assert.deepEqual(health.adminRpc, { configured: true });
    assert.deepEqual(health.details, { source: connected ? 'gateway ws' : 'openclaw status --json' });
    assert.doesNotMatch(JSON.stringify(health), /PRIVATE/);
    assert.equal((await state.app.request('/api/gateway/status')).status, 200);
    assert.deepEqual(state.calls(), { probes: connected ? 0 : 1, restarts: 0 });
    const restarted = await state.app.request('/api/gateway/restart', { method: 'POST' });
    assert.equal(restarted.status, 200);
    const result = await restarted.json();
    assert.deepEqual(result.result, { method: 'openclaw gateway restart' });
    assert.equal(result.gateway.ok, true);
    assert.equal(state.calls().restarts, 1);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
    assert.doesNotMatch(JSON.stringify(state.updates), /PRIVATE/);
    const debug = await state.app.request('/api/config/debug');
    assert.equal(debug.status, 200);
    assert.doesNotMatch(await debug.text(), /PRIVATE/);
  } finally { await state.owner.close(); }
});

test('public health permits numeric release versions and preserves disabled state without copying unknown fields', () => {
  const value = publicGatewayHealth({ ok: false, enabled: false, status: 'unknown', updatedAt: 1,
    version: '1.2.3', defaultAgentId: 'PRIVATE', defaultModel: 'PRIVATE', error: 'PRIVATE',
    details: { source: 'PRIVATE', unexpected: 'PRIVATE' }, note: 'PRIVATE' }, 'main');
  assert.equal(value.version, '1.2.3');
  assert.equal(value.enabled, false);
  assert.equal(value.status, 'unknown');
  assert.equal(value.defaultAgentId, undefined);
  assert.equal(value.error, 'gateway_probe_failed');
  assert.deepEqual(value.details, { source: 'unknown' });
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE/);
});

test('public health retains explicit degraded and enabled contracts', () => {
  const value = publicGatewayHealth({ ok: true, enabled: true, status: 'degraded', degraded: true,
    updatedAt: 2, version: '1.2.3-PRIVATE', details: { source: 'gateway ws + remote mode' } }, 'main');
  assert.equal(value.enabled, true);
  assert.equal(value.status, 'degraded');
  assert.equal(value.degraded, true);
  assert.equal(value.version, undefined);
  assert.equal(value.updatedAt, 2);
  assert.deepEqual(value.details, { source: 'gateway ws + remote mode' });
});
