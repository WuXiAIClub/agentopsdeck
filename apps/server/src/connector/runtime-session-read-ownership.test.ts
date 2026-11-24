import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ConnectorUserStore } from './connector-user-store.js';
import { createConnectorRuntime } from './runtime.js';
import { loadConfig } from '../config.js';

for (const first of ['resolve', 'reject'] as const) {
  test(`runtime drains both cancelled session-read authority owners, first ${first}`, { timeout: 5000 }, async context => {
    const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-session-read-owner-'));
    context.after(() => rmSync(directory, { recursive: true, force: true }));
    const file = join(directory, 'connector.sqlite');
    const config = loadConfig({ AOD_SERVER_ROLE: 'connector', AOD_CODEX_ENABLED: 'false', AOD_LOCAL_OPENCLAW_CLI: 'false',
      AOD_CONNECTOR_USERS_DATABASE_FILE: file, AOD_CONNECTOR_TOKENS_FILE: `${file}.tokens`,
      AOD_SESSION_TITLES_FILE: `${file}.titles`, AOD_QUEUE_FILE: `${file}.queue`,
      AOD_MIRROR_OUTBOX_FILE: `${file}.mirror`, AOD_ARTIFACT_INDEX_FILE: `${file}.artifacts`,
      AOD_CONNECTOR_UPDATE_STATE_FILE: `${file}.updates` });
    const runtime = createConnectorRuntime(config, () => true, { deferActivation: true });
    const originals = [0, 1].map(() => {
      let resolve!: (value: boolean) => void, reject!: (error: unknown) => void;
      const promise = new Promise<boolean>((yes, no) => { resolve = yes; reject = no; });
      return { promise, resolve, reject, calls: 0 };
    });
    const apps = originals.map(original => {
      const app = new Hono();
      runtime.registerLegacyRoutes(app, () => { original.calls++; return original.promise; });
      return app;
    });
    let storageCloses = 0, closed = false;
    const storageClose = ConnectorUserStore.prototype.close;
    context.mock.method(ConnectorUserStore.prototype, 'close', function(this: ConnectorUserStore) {
      storageCloses++; return storageClose.call(this);
    });
    const controllers = originals.map(() => new AbortController());
    const paths = ['/api/sessions/state', '/api/sessions/private-session/activity'];
    const requests = apps.map((app, index) => app.request(paths[index]!, { signal: controllers[index]!.signal }));
    let closing: Promise<void> | undefined;
    try {
      const deadline = AbortSignal.timeout(3000);
      while (originals.some(original => original.calls !== 1)) {
        deadline.throwIfAborted(); await new Promise<void>(resolve => setImmediate(resolve));
      }
      for (const controller of controllers) controller.abort();
      for (const request of requests) assert.equal((await request).status, 408);
      closing = runtime.close(); void closing.then(() => { closed = true; });
      assert.equal(runtime.close(), closing);
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(closed, false); assert.equal(storageCloses, 0);
      if (first === 'resolve') originals[0]!.resolve(true); else originals[0]!.reject(Error('PRIVATE first SQL error'));
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(closed, false); assert.equal(storageCloses, 0);
      for (const app of apps) assert.equal((await app.request(paths[0]!)).status, 503);
    } finally {
      originals[0]!.resolve(false);
      if (first === 'resolve') originals[1]!.reject(Error('PRIVATE second SQL error')); else originals[1]!.resolve(true);
      for (const controller of controllers) controller.abort();
      await Promise.all(requests); await (closing ?? runtime.close());
    }
    assert.equal(storageCloses, 1); assert.equal(closed, true);
    assert.deepEqual(originals.map(original => original.calls), [1, 1]);
    const lateApp = new Hono();
    runtime.registerLegacyRoutes(lateApp, () => assert.fail('closed runtime cannot dispatch authority'));
    assert.equal((await lateApp.request(paths[0]!)).status, 503);
  });
}

for (const settlement of ['resolve', 'reject'] as const) {
  test(`runtime retains original history refresh after caller cancellation until late ${settlement}`, { timeout: 5000 }, async context => {
    const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-session-history-owner-'));
    context.after(() => rmSync(directory, { recursive: true, force: true }));
    const file = join(directory, 'connector.sqlite');
    const config = loadConfig({ AOD_SERVER_ROLE: 'connector', AOD_CODEX_ENABLED: 'false', AOD_LOCAL_OPENCLAW_CLI: 'false',
      AOD_OPENCLAW_GATEWAY_WS_URL: 'ws://fixture.invalid',
      AOD_CONNECTOR_USERS_DATABASE_FILE: file, AOD_CONNECTOR_TOKENS_FILE: file + '.tokens',
      AOD_SESSION_TITLES_FILE: file + '.titles', AOD_QUEUE_FILE: file + '.queue',
      AOD_MIRROR_OUTBOX_FILE: file + '.mirror', AOD_ARTIFACT_INDEX_FILE: file + '.artifacts',
      AOD_CONNECTOR_UPDATE_STATE_FILE: file + '.updates' });
    const runtime = createConnectorRuntime(config, () => true, { deferActivation: true });
    let resolve!: (value: any) => void, reject!: (error: unknown) => void, entered!: () => void;
    const gate = new Promise<any>((yes, no) => { resolve = yes; reject = no; });
    const started = new Promise<void>(yes => { entered = yes; });
    let reads = 0, actors = 0, storageCloses = 0, closed = false;
    context.mock.method(runtime.gateway, 'requestWithConnection', (async (method: string) => {
      assert.equal(method, 'sessions.list'); reads++; entered(); return gate;
    }) as any);
    const storageClose = ConnectorUserStore.prototype.close;
    context.mock.method(ConnectorUserStore.prototype, 'close', function(this: ConnectorUserStore) {
      storageCloses++; return storageClose.call(this);
    });
    const app = new Hono();
    runtime.registerLegacyRoutes(app, async () => { actors++; return true; });
    const controller = new AbortController();
    const response = app.request('/api/sessions/state', { signal: controller.signal });
    let closing: Promise<void> | undefined;
    try {
      await started; const observed = actors; controller.abort();
      assert.equal((await response).status, 408); assert.equal(reads, 1);
      closing = runtime.close(); void closing.then(() => { closed = true; });
      assert.equal(runtime.close(), closing);
      await new Promise<void>(yes => setImmediate(yes));
      assert.equal(closed, false); assert.equal(storageCloses, 0);
      assert.equal((await app.request('/api/sessions/state')).status, 503);
      assert.equal(actors, observed); assert.equal(reads, 1);
    } finally {
      if (settlement === 'resolve') resolve({ payload: [], connectionId: runtime.gateway.connectionId() });
      else reject(Error('PRIVATE SELECT original history'));
      controller.abort(); await response; await (closing ?? runtime.close());
    }
    assert.equal(closed, true); assert.equal(storageCloses, 1); assert.equal(reads, 1);
  });
}
