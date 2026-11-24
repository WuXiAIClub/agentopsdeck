import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../config.js';
import { createConnectorRuntime } from './runtime.js';
import { ConnectorUserStore } from './connector-user-store.js';
import { startupApplicationCleanup } from '../lifecycle/startup-cleanup.js';
import { createApplication } from '../application.js';
import { HubStore } from '../hub/hub-store.js';
import { StorageConnectionUnavailable } from '../storage/connection-recovery.js';
import { WorkspaceContentEffects } from './workspace-content-replica.js';
import { ConnectorWorkspaceFiles } from './workspace-board-files.js';
import type { StartupOwnership } from '../lifecycle/startup-cleanup.js';

test('partial SDK factory failure drains the already constructed worker before releasing its database', async t => {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-connector-startup-'));
  const config = loadConfig({ AOD_SERVER_ROLE: 'connector', AOD_CODEX_ENABLED: 'false', AOD_LOCAL_OPENCLAW_CLI: 'false',
    AOD_CONNECTOR_USERS_DATABASE_FILE: join(root, 'users.sqlite'), AOD_CONNECTOR_TOKENS_FILE: join(root, 'tokens.json'),
    AOD_SESSION_TITLES_FILE: join(root, 'titles.json'), AOD_QUEUE_FILE: join(root, 'queue.json'),
    AOD_MIRROR_OUTBOX_FILE: join(root, 'mirror.json'), AOD_ARTIFACT_INDEX_FILE: join(root, 'artifacts.json'),
    AOD_CONNECTOR_UPDATE_STATE_FILE: join(root, 'updates.json') });
  config.claude = {} as NonNullable<typeof config.claude>;
  config.copilot = {} as NonNullable<typeof config.copilot>;
  let nativeClosed = 0, databaseClosed = 0, resolveClose!: () => void;
  const held = new Promise<void>(resolve => { resolveClose = resolve; });
  const nativeClose = ConnectorUserStore.prototype.close, original = Error('private-copilot-factory-fault');
  t.mock.method(ConnectorUserStore.prototype, 'close', function(this: ConnectorUserStore) { databaseClosed++; nativeClose.call(this); });
  try {
    assert.throws(() => createConnectorRuntime(config, () => false, {
      claude: (() => ({ close() { nativeClosed++; return held; } })) as unknown as NonNullable<NonNullable<Parameters<typeof createConnectorRuntime>[2]>['claude']>,
      copilot: () => { throw original; },
    }), error => error === original);
    assert.equal(nativeClosed, 1);
    assert.equal(databaseClosed, 0, 'unknown native cleanup must retain its authoritative database');
    resolveClose(); await startupApplicationCleanup.waitForCurrentCleanup();
    assert.equal(databaseClosed, 1);
  } finally { resolveClose(); await startupApplicationCleanup.waitForCurrentCleanup(); rmSync(root, { recursive: true, force: true }); }
});

test('partial Connector assembly retains parent Hub dependencies until native cleanup ACK', async t => {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-parent-startup-'));
  const config = loadConfig({ HOME: root, AOD_SERVER_ROLE: 'all', AOD_CODEX_ENABLED: 'false',
    AOD_LOCAL_OPENCLAW_CLI: 'false', AOD_HUB_DATABASE_FILE: join(root, 'hub.sqlite'),
    AOD_HUB_VAULT_SECRET: 'synthetic', AOD_PASSKEYS_FILE: join(root, 'passkeys.json'),
    AOD_AUTH_SESSIONS_FILE: join(root, 'auth.json'),
    AOD_CONNECTOR_USERS_DATABASE_FILE: join(root, 'users.sqlite'), AOD_CONNECTOR_TOKENS_FILE: join(root, 'tokens.json'),
    AOD_SESSION_TITLES_FILE: join(root, 'titles.json'), AOD_QUEUE_FILE: join(root, 'queue.json'),
    AOD_MIRROR_OUTBOX_FILE: join(root, 'mirror.json'), AOD_ARTIFACT_INDEX_FILE: join(root, 'artifacts.json'),
    AOD_CONNECTOR_UPDATE_STATE_FILE: join(root, 'updates.json') });
  config.claude = {} as NonNullable<typeof config.claude>;
  config.copilot = {} as NonNullable<typeof config.copilot>;
  let nativeClosed = 0, connectorClosed = 0, hubClosed = 0, resolveClose!: () => void;
  const held = new Promise<void>(resolve => { resolveClose = resolve; });
  const connectorClose = ConnectorUserStore.prototype.close, hubClose = HubStore.prototype.close;
  const original = Error('private-parent-factory-fault');
  t.mock.method(ConnectorUserStore.prototype, 'close', function(this: ConnectorUserStore) { connectorClosed++; connectorClose.call(this); });
  t.mock.method(HubStore.prototype, 'close', function(this: HubStore) { hubClosed++; hubClose.call(this); });
  const factory: typeof createConnectorRuntime = (settings, authorize, owners) => createConnectorRuntime(settings, authorize, {
    ...owners,
    claude: (() => ({ close() { nativeClosed++; return held; } })) as unknown as NonNullable<NonNullable<Parameters<typeof createConnectorRuntime>[2]>['claude']>,
    copilot: () => { throw original; },
  });
  try {
    assert.throws(() => createApplication(config, factory), error => error === original);
    assert.equal(nativeClosed, 1);
    assert.equal(connectorClosed, 0); assert.equal(hubClosed, 0);
    assert.throws(() => startupApplicationCleanup.assertAvailable(), StorageConnectionUnavailable);
    resolveClose(); await startupApplicationCleanup.waitForCurrentCleanup();
    assert.equal(connectorClosed, 1); assert.equal(hubClosed, 1);
    startupApplicationCleanup.assertAvailable();
  } finally { resolveClose(); await startupApplicationCleanup.waitForCurrentCleanup(); rmSync(root, { recursive: true, force: true }); }
});

test('application route assembly failure cannot activate the already constructed SDK adapter', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-startup-activation-'));
  const config = loadConfig({ HOME: root, AOD_SERVER_ROLE: 'connector', AOD_CODEX_ENABLED: 'false',
    AOD_LOCAL_OPENCLAW_CLI: 'false', AOD_CONNECTOR_USERS_DATABASE_FILE: join(root, 'users.sqlite'),
    AOD_CONNECTOR_TOKENS_FILE: join(root, 'tokens.json'), AOD_SESSION_TITLES_FILE: join(root, 'titles.json'),
    AOD_QUEUE_FILE: join(root, 'queue.json'), AOD_MIRROR_OUTBOX_FILE: join(root, 'mirror.json'),
    AOD_ARTIFACT_INDEX_FILE: join(root, 'artifacts.json'), AOD_CONNECTOR_UPDATE_STATE_FILE: join(root, 'updates.json'),
    AOD_PASSKEYS_FILE: join(root, 'passkeys.json'), AOD_AUTH_SESSIONS_FILE: join(root, 'auth.json') });
  config.claude = {} as NonNullable<typeof config.claude>;
  let activated = 0, closed = 0;
  const original = Error('private-late-route-fault');
  const factory: typeof createConnectorRuntime = (settings, authorize, owners) => {
    const runtime = createConnectorRuntime(settings, authorize, { ...owners,
      claude: (() => ({ id: 'claude-code', activate() { activated++; }, close() { closed++; return Promise.resolve(); } })) as unknown as NonNullable<NonNullable<Parameters<typeof createConnectorRuntime>[2]>['claude']>,
    });
    runtime.registerLegacyRoutes = () => { throw original; };
    return runtime;
  };
  try {
    assert.throws(() => createApplication(config, factory), error => error === original);
    await startupApplicationCleanup.waitForCurrentCleanup();
    assert.equal(activated, 0, 'assembly failure must not start SDK work before application construction succeeds');
    assert.equal(closed, 1);
  } finally { await startupApplicationCleanup.waitForCurrentCleanup(); rmSync(root, { recursive: true, force: true }); }
});

function activationFixture() {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-activation-'));
  const config = loadConfig({ HOME: root, AOD_SERVER_ROLE: 'connector', AOD_CODEX_ENABLED: 'false',
    AOD_LOCAL_OPENCLAW_CLI: 'false', AOD_CONNECTOR_USERS_DATABASE_FILE: join(root, 'users.sqlite'),
    AOD_CONNECTOR_TOKENS_FILE: join(root, 'tokens.json'), AOD_SESSION_TITLES_FILE: join(root, 'titles.json'),
    AOD_QUEUE_FILE: join(root, 'queue.json'), AOD_MIRROR_OUTBOX_FILE: join(root, 'mirror.json'),
    AOD_ARTIFACT_INDEX_FILE: join(root, 'artifacts.json'), AOD_CONNECTOR_UPDATE_STATE_FILE: join(root, 'updates.json'),
    AOD_PASSKEYS_FILE: join(root, 'passkeys.json'), AOD_AUTH_SESSIONS_FILE: join(root, 'auth.json') });
  config.claude = {} as NonNullable<typeof config.claude>;
  return { config, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

for (const startupFailure of [false, true]) test(`real runtime drains content before original file and database owners (${startupFailure ? 'startup cleanup' : 'normal shutdown'})`, async t => {
  const f = activationFixture(); f.config.boardFiles = { root: join(f.config.connector.usersDatabaseFile, '..', 'files'), policies: [] };
  const startup: StartupOwnership = { drains: [], cleanups: [], failed: false }, events: string[] = [];
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const closeContent = WorkspaceContentEffects.prototype.close, closeFiles = ConnectorWorkspaceFiles.prototype.close,
    closeDatabase = ConnectorUserStore.prototype.close;
  t.mock.method(WorkspaceContentEffects.prototype, 'close', async function(this: WorkspaceContentEffects<unknown, unknown>) {
    events.push('content-wait'); await gate; await closeContent.call(this); events.push('content-done');
  });
  t.mock.method(ConnectorWorkspaceFiles.prototype, 'close', async function(this: ConnectorWorkspaceFiles<unknown>) {
    events.push('files-close'); await closeFiles.call(this);
  });
  t.mock.method(ConnectorUserStore.prototype, 'close', function(this: ConnectorUserStore) {
    events.push('database-close'); return closeDatabase.call(this);
  });
  const runtime = createConnectorRuntime(f.config, () => false, { startupOwnership: startup, deferActivation: true,
    claude: (() => ({ id: 'claude-code', activate() {}, close() { return Promise.resolve(); } })) as unknown as NonNullable<NonNullable<Parameters<typeof createConnectorRuntime>[2]>['claude']>,
  });
  let closing: Promise<void>;
  if (startupFailure) {
    startup.failed = true; startupApplicationCleanup.abandon(startup.drains, startup.cleanups);
    closing = startupApplicationCleanup.waitForCurrentCleanup();
  } else closing = runtime.close();
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.ok(events.includes('content-wait'));
    assert.equal(events.includes('files-close'), false); assert.equal(events.includes('database-close'), false);
  } finally { release(); await closing; f.dispose(); }
  assert.ok(events.indexOf('content-done') < events.indexOf('files-close'));
  assert.ok(events.lastIndexOf('files-close') < events.indexOf('database-close'));
  assert.equal(events.filter(event => event === 'database-close').length, 1);
});

test('successful application construction activates SDK work only after registering its final routes', async () => {
  const f = activationFixture(), calls: string[] = [];
  const factory: typeof createConnectorRuntime = (settings, authorize, owners) => {
    assert.equal(owners?.deferActivation, true);
    const runtime = createConnectorRuntime(settings, authorize, { ...owners,
      claude: (() => ({ id: 'claude-code', activate() { calls.push('activate'); }, close() { return Promise.resolve(); } })) as unknown as NonNullable<NonNullable<Parameters<typeof createConnectorRuntime>[2]>['claude']>,
    });
    assert.equal(calls.length, 0);
    const register = runtime.registerLegacyRoutes;
    runtime.registerLegacyRoutes = (...args) => { calls.push('routes'); register(...args); };
    return runtime;
  };
  const app = createApplication(f.config, factory);
  try { assert.deepEqual(calls, ['routes', 'activate']); }
  finally { await app.close(); f.dispose(); }
});

for (const stopBeforeActivation of [false, true]) test(`deferred runtime activation is single-shot and ${stopBeforeActivation ? 'cannot start after' : 'cannot repeat after'} admission stop`, async () => {
  const f = activationFixture(); let activated = 0;
  const runtime = createConnectorRuntime(f.config, () => false, { deferActivation: true,
    claude: (() => ({ id: 'claude-code', activate() { activated++; }, close() { return Promise.resolve(); } })) as unknown as NonNullable<NonNullable<Parameters<typeof createConnectorRuntime>[2]>['claude']>,
  });
  try {
    assert.equal(activated, 0);
    if (!stopBeforeActivation) { runtime.activate(); runtime.activate(); assert.equal(activated, 1); }
    await runtime.stopAdmissions(); runtime.activate();
    assert.equal(activated, stopBeforeActivation ? 0 : 1);
    await runtime.close(); runtime.activate(); assert.equal(activated, stopBeforeActivation ? 0 : 1);
  } finally { await runtime.close(); f.dispose(); }
});

test('activation failure preserves its original error and drains the returned runtime owner', async t => {
  const f = activationFixture(), original = Error('private-activation-fault'); let closed = 0;
  const rows: Record<string, unknown>[] = [];
  t.mock.method(console, 'info', (line: unknown) => {
    if (typeof line === 'string' && line.startsWith('{')) rows.push(JSON.parse(line));
  });
  const factory: typeof createConnectorRuntime = (settings, authorize, owners) => createConnectorRuntime(settings, authorize, { ...owners,
    claude: (() => ({ id: 'claude-code', activate() { throw original; }, close() { closed++; return Promise.resolve(); } })) as unknown as NonNullable<NonNullable<Parameters<typeof createConnectorRuntime>[2]>['claude']>,
  });
  try {
    assert.throws(() => createApplication(f.config, factory), error => error === original);
    await startupApplicationCleanup.waitForCurrentCleanup(); assert.equal(closed, 1);
    assert.equal(rows.filter(row => row.operation === 'connector-startup-task' && row.step === 3 && row.unknown === 1).length, 1);
    assert.doesNotMatch(JSON.stringify(rows), /private-activation-fault/);
    startupApplicationCleanup.assertAvailable();
  } finally { await startupApplicationCleanup.waitForCurrentCleanup(); f.dispose(); }
});

test('background queue startup failure is logged without an unhandled rejection or an automatic replay', async t => {
  const f = activationFixture(); let attempts = 0;
  const rows: Record<string, unknown>[] = [];
  t.mock.method(console, 'info', (line: unknown) => {
    if (typeof line === 'string' && line.startsWith('{')) rows.push(JSON.parse(line));
  });
  const runtime = createConnectorRuntime(f.config, () => false, { deferActivation: true,
    claude: (() => ({ id: 'claude-code', activate() {}, close() { return Promise.resolve(); } })) as unknown as NonNullable<NonNullable<Parameters<typeof createConnectorRuntime>[2]>['claude']>,
  });
  try {
    t.mock.method(ConnectorUserStore.prototype, 'reconcileEndedInteractions', () => {
      attempts++; throw Error('private worker-startup/path token');
    });
    runtime.activate(); await new Promise<void>(resolve => setImmediate(resolve));
    const failures = rows.filter(row => row.operation === 'connector-startup-task' && row.step === 1 && row.category === 'failed');
    assert.equal(failures.length, 1); assert.equal(failures[0]!.unknown, 1);
    runtime.activate(); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(attempts, 1);
    assert.doesNotMatch(JSON.stringify(rows), /private worker-startup|token/);
  } finally { await runtime.close(); f.dispose(); }
});
