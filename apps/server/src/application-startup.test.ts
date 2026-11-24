import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Hono } from 'hono';
import { createApplication } from './application.js';
import { loadConfig, type ServerRole } from './config.js';
import { HubStore } from './hub/hub-store.js';
import type { createConnectorRuntime } from './connector/runtime.js';
import { startupApplicationCleanup } from './lifecycle/startup-cleanup.js';
import { StorageConnectionUnavailable } from './storage/connection-recovery.js';

function fixture(role: ServerRole) {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-application-startup-'));
  const config = loadConfig({ HOME: root, AOD_SERVER_ROLE: role,
    AOD_HUB_DATABASE_FILE: join(root, 'hub.sqlite'), AOD_HUB_VAULT_SECRET: 'synthetic',
    AOD_PASSKEYS_FILE: join(root, 'passkeys.json'), AOD_AUTH_SESSIONS_FILE: join(root, 'auth.json'),
    AOD_SESSION_TITLES_FILE: join(root, 'titles.json') });
  return { root, config, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

test('normal application close retains Hub dependencies while Connector cleanup is unknown', async t => {
  const f = fixture('all'), original = Error('private-runtime-close-fault'), nativeClose = HubStore.prototype.close;
  let hubClosed = 0, runtimeClosed = 0, stops = 0, broken = true;
  t.mock.method(HubStore.prototype, 'close', function(this: HubStore) { hubClosed++; nativeClose.call(this); });
  const factory = (() => ({ app: new Hono(), registerLegacyRoutes() {},
    stopAdmissions() { stops++; return Promise.resolve(); },
    close() { runtimeClosed++; return broken ? Promise.reject(original) : Promise.resolve(); } })) as unknown as typeof createConnectorRuntime;
  const app = createApplication(f.config, factory);
  try {
    await assert.rejects(app.close(), error => error === original);
    assert.equal(hubClosed, 0); assert.equal(runtimeClosed, 1); assert.equal(stops, 1);
    broken = false; await app.close(); await app.close();
    assert.equal(hubClosed, 1); assert.equal(runtimeClosed, 2); assert.equal(stops, 1);
  } finally { broken = false; await app.close(); f.dispose(); }
});

test('late application startup failure closes its already constructed Connector owner', async () => {
  const f = fixture('connector'), original = Error('private-route-startup-fault');
  let closed = 0, admissionsStopped = 0;
  const factory = (() => ({ app: new Hono(), registerLegacyRoutes() { throw original; },
    stopAdmissions() { admissionsStopped++; return Promise.resolve(); },
    close() { closed++; return Promise.resolve(); } })) as unknown as typeof createConnectorRuntime;
  try {
    assert.throws(() => createApplication(f.config, factory), error => error === original);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(admissionsStopped, 1);
    assert.equal(closed, 1);
  } finally { f.dispose(); }
});

test('failed application cleanup cannot replace the original startup error', async t => {
  const f = fixture('all'), original = Error('private-connector-startup-fault'), nativeClose = HubStore.prototype.close;
  let broken = true;
  t.mock.method(HubStore.prototype, 'close', function(this: HubStore) { nativeClose.call(this); if (broken) throw Error('private-cleanup-fault'); });
  try {
    assert.throws(() => createApplication(f.config, () => { throw original; }), error => error === original);
    await new Promise(resolve => setImmediate(resolve));
    broken = false;
    await new Promise(resolve => setTimeout(resolve, 1050));
    assert.throws(() => startupApplicationCleanup.assertAvailable(), StorageConnectionUnavailable);
    await new Promise(resolve => setImmediate(resolve));
    startupApplicationCleanup.assertAvailable();
  } finally { f.dispose(); }
});
