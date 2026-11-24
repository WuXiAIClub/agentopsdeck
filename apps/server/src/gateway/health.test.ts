import assert from 'node:assert/strict';
import test from 'node:test';
import { readGatewayHealth } from './health.js';

const admin = { status: () => ({ connected: true }) } as any;
const normalizeError = (error: unknown) => error instanceof Error ? error.message : String(error);

test('intentionally disabled OpenClaw is not reported as a failed CLI probe', async () => {
  const result = await readGatewayHealth({
    admin: { status: () => ({ configured: false }) } as any,
    gateway: { status: () => ({ configured: false, connected: false }) } as any,
    defaultAgentId: 'main', localOpenClawCli: false, normalizeError,
    statusProbe: async () => assert.fail('disabled CLI must not run'),
  });
  assert.equal(result.enabled, false);
  assert.equal(result.error, undefined);
  assert.equal(result.defaultAgentId, undefined);
  assert.equal(result.details?.source, 'disabled');
  assert.match(result.note!, /Codex runs independently/);
});

test('uses a live gateway websocket without starting the OpenClaw CLI probe', async () => {
  let probes = 0;
  const result = await readGatewayHealth({
    admin,
    gateway: { status: () => ({ connected: true, url: 'ws://127.0.0.1:18789' }) } as any,
    defaultAgentId: 'main',
    normalizeError,
    statusProbe: async () => {
      probes += 1;
      throw new Error('must not run');
    },
  });

  assert.equal(probes, 0);
  assert.equal(result.ok, true);
  assert.equal(result.details?.source, 'gateway ws');
});

test('falls back to the OpenClaw CLI probe when the websocket is disconnected', async () => {
  let probes = 0;
  const result = await readGatewayHealth({
    admin,
    gateway: { status: () => ({ connected: false, url: 'ws://127.0.0.1:18789' }) } as any,
    defaultAgentId: 'main',
    normalizeError,
    statusProbe: async () => {
      probes += 1;
      return { gateway: { reachable: true, url: 'ws://127.0.0.1:18789' } };
    },
  });

  assert.equal(probes, 1);
  assert.equal(result.ok, true);
  assert.equal(result.details?.source, 'openclaw status --json');
});

test('reports offline when the websocket is disconnected and the CLI probe fails', async () => {
  const result = await readGatewayHealth({
    admin,
    gateway: { status: () => ({ connected: false, url: 'ws://127.0.0.1:18789' }) } as any,
    defaultAgentId: 'main',
    normalizeError,
    statusProbe: async () => { throw new Error('probe timed out'); },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'probe timed out');
});
