import assert from 'node:assert/strict';
import test from 'node:test';
import type { GatewayHealth } from '@agentopsdeck/shared';
import { gatewayDisplayState } from './gateway-display.js';

test('gateway display preserves unknown, disabled, online, degraded and offline observations', () => {
  assert.equal(gatewayDisplayState(undefined).label, 'unknown');
  const health = (value: Partial<GatewayHealth>) => value as GatewayHealth;
  assert.equal(gatewayDisplayState(health({ enabled: false, ok: true })).label, 'disabled');
  assert.equal(gatewayDisplayState(health({ ok: true })).variant, 'running');
  assert.equal(gatewayDisplayState(health({ status: 'online', degraded: true })).label, 'online');
  assert.equal(gatewayDisplayState(health({ degraded: true })).variant, 'accent');
  assert.equal(gatewayDisplayState(health({ status: 'offline' })).label, 'offline');
  assert.equal(gatewayDisplayState(health({})).label, 'offline');
});
