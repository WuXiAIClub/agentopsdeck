import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { CONNECTOR_PROTOCOL_HEADER } from '@agentopsdeck/shared';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { EXPECTED_NODE_HEADER } from './node-identity.js';
import { registerMaintenanceInspection } from './maintenance-inspection.js';
import { NativeMaintenanceInspectionError } from '../codex/maintenance.js';

const endpoint = '/api/connector/v1/maintenance/inspection';
function fixture(t: { after(fn: () => void): void }) {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-native-inspection-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const tokens = new ConnectorTokenStore(join(directory, 'tokens.json'), 'synthetic-bootstrap');
  const owner = tokens.create({ label: 'lifecycle', scopes: ['connector:lifecycle'] });
  const updater = tokens.create({ label: 'update', scopes: ['connector:update'] });
  const headers = (token = owner.token) => new Headers({ authorization: `Bearer ${token}`,
    [EXPECTED_NODE_HEADER]: 'node:1', [CONNECTOR_PROTOCOL_HEADER]: '1' });
  const result = { nodeId: 'node:1', observedAt: Date.now(), nativeVerified: true as const,
    activeRuns: 1, backgroundTerminals: 2, pendingExecutions: 3, queuedMessages: 4, inFlightWrites: 5 };
  return { tokens, owner, updater, headers, result };
}

test('inspection is read only and requires opt-in lifecycle scope plus exact node/protocol', async t => {
  const f = fixture(t), app = new Hono(); let calls = 0;
  registerMaintenanceInspection(app, { nodeId: 'node:1', tokens: f.tokens,
    inspect: async check => { calls++; check(); return f.result; } });
  for (const token of ['synthetic-bootstrap', f.updater.token, 'invalid']) {
    assert.equal((await app.request(endpoint, { headers: f.headers(token) })).status, 403);
  }
  for (const [name, value, status] of [[EXPECTED_NODE_HEADER, undefined, 409], [EXPECTED_NODE_HEADER, 'other', 409],
    [CONNECTOR_PROTOCOL_HEADER, undefined, 426], [CONNECTOR_PROTOCOL_HEADER, '2', 426], ['Origin', 'https://hub.test', 403]] as const) {
    const headers = f.headers();
    if (value === undefined) headers.delete(name); else headers.set(name, value);
    assert.equal((await app.request(endpoint, { headers })).status, status);
  }
  assert.equal(calls, 0);
  const response = await app.request(endpoint, { headers: f.headers() });
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), f.result); assert.equal(calls, 1);
  assert.equal((await app.request(endpoint, { method: 'POST', headers: f.headers() })).status, 404);
});

test('revoked authority, native errors and missing implementation never produce idle proof or leak raw errors', async t => {
  const f = fixture(t), app = new Hono(); let revoke = false;
  registerMaintenanceInspection(app, { nodeId: 'node:1', tokens: f.tokens,
    inspect: async check => {
      if (revoke) { f.tokens.revoke(f.owner.record.id); check(); return f.result; }
      throw new Error('secret prompt /private/native/path');
    } });
  let response = await app.request(endpoint, { headers: f.headers() });
  assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /secret|private/);
  revoke = true;
  response = await app.request(endpoint, { headers: f.headers() });
  assert.equal(response.status, 403); assert.doesNotMatch(await response.text(), /nativeVerified/);
  const unsupported = new Hono();
  registerMaintenanceInspection(unsupported, { nodeId: 'node:1', tokens: f.tokens });
  const another = f.tokens.create({ label: 'another', scopes: ['connector:lifecycle'] });
  assert.equal((await unsupported.request(endpoint, { headers: f.headers(another.token) })).status, 501);
});

test('native observation failures publish only an allowlisted reason and never an idle proof', async t => {
  const f = fixture(t), app = new Hono();
  registerMaintenanceInspection(app, { nodeId: 'node:1', tokens: f.tokens, inspect: async () => {
    const error = new NativeMaintenanceInspectionError('native_thread_system_error');
    error.message = 'private thread text /private/path';
    throw error;
  } });
  const response = await app.request(endpoint, { headers: f.headers() });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'Native maintenance observation unavailable; no idle proof', reason: 'native_thread_system_error' });
});
