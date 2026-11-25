import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { registerHubAutomation } from './hub-automation.js';
import { registerHubWebsiteRoutes } from './hub-websites.js';
import { registerHubTokenUsage } from './hub-token-usage.js';
import { registerHubTerminals } from './hub-terminals.js';
import { registerHubWebsiteActions } from './hub-website-actions.js';
import { registerHubWebsiteAccess } from './hub-website-access.js';
import { registerHubConnectionFiles } from './hub-connection-files.js';
import { registerHubHistoryMedia } from './hub-history-media.js';
import { registerHubSessionAuxiliary } from './hub-session-auxiliary.js';
import type { AuthRouteAuditStore } from '../auth/route-persistence.js';
import type { HubConnectionProxyRouteDeps } from '../hub/connection-proxy-route-deps.js';

for (const register of [registerHubAutomation, registerHubWebsiteRoutes, registerHubTokenUsage,
  registerHubTerminals, registerHubWebsiteActions, registerHubWebsiteAccess,
  registerHubConnectionFiles, registerHubHistoryMedia, registerHubSessionAuxiliary]) {
  test(`${register.name}: incomplete async composition is rejected before any route installation`, () => {
    let effects = 0;
    const begin = () => {effects++; throw Error('must not run');}, close = () => {effects++;};
    const asyncConnectorClient = () => {effects++; throw Error('must not resolve');};
    for (const deps of [
      {mode: 'async'},
      {mode: 'async', access: {begin, close}},
      {mode: 'async', asyncConnectorClient},
      {mode: 'async', access: {begin}, asyncConnectorClient},
      {mode: 'async', access: {close}, asyncConnectorClient},
      {mode: 'async', access: {begin, close}, asyncConnectorClient: null},
    ]) {
      const app = new Hono(), before = app.routes.length;
      // Deliberately invalid composition: do not invent legacy stores to satisfy
      // unrelated route options. Validation must precede their first use.
      assert.throws(() => register(app, deps as never), /ports are required/);
      assert.equal(app.routes.length, before);
    }
    assert.equal(effects, 0);
  });
}

for (const register of [registerHubTerminals, registerHubWebsiteActions]) {
  test(`${register.name}: async audit is mandatory before any route installation`, () => {
    let effects = 0;
    const begin = () => {effects++; throw Error('must not run');}, close = async () => {effects++;};
    const asyncConnectorClient = () => {effects++; throw Error('must not resolve');};
    for (const audit of [undefined, {}, {append: null}]) {
      const app = new Hono();
      const deps = {mode: 'async', access: {begin, close}, asyncConnectorClient, audit};
      assert.throws(() => register(app, deps as unknown as HubConnectionProxyRouteDeps & {audit: Pick<AuthRouteAuditStore, 'append'>}), /audit ports are required/);
      assert.equal(app.routes.length, 0);
    }
    assert.equal(effects, 0);
  });
}

for (const register of [registerHubTerminals, registerHubWebsiteActions, registerHubWebsiteAccess]) {
  test(`${register.name}: bare async access is drained exactly once without close wrapper`, async () => {
    let closes = 0, release!: () => void;
    const pending = new Promise<void>(resolve => {release = resolve;});
    const access = {begin: () => {throw Error('must not run');}, close: () => {closes++; return pending;}};
    const deps = {mode: 'async', access, audit: {append: () => {throw Error('must not audit');}},
      asyncConnectorClient: () => {throw Error('must not resolve');}};
    const routes = register(new Hono(), deps as unknown as HubConnectionProxyRouteDeps & {audit: Pick<AuthRouteAuditStore, 'append'>});
    const closing = routes.close(); assert.strictEqual(routes.close(), closing);
    let drained = false; void closing.then(() => {drained = true;});
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(closes, 1); assert.equal(drained, false);
    release(); await closing; assert.equal(closes, 1);
  });
}

test('registerHubConnectionFiles forwards antigravity model catalog requests and rejects unknown runtimes', async () => {
  const seen: string[] = [];
  const app = new Hono();
  const routes = registerHubConnectionFiles(app, {
    mode: 'async',
    access: {
      begin: async () => ({
        principal: { userId: 'owner' },
        connection: { id: 'conn-1', status: 'enabled' },
        check: async () => {},
      }),
      close: async () => {},
    } as never,
    asyncConnectorClient: async () => ({
      jsonResponseOriginal: async (path: string) => {
        seen.push(path);
        return { status: 200, body: { models: [{ id: 'gemini-4-neon-high', label: 'gemini-4-neon-high' }] } };
      },
    }) as never,
    error: (c, error) => c.json({ error: String(error) }, 500),
  });
  try {
    const allowed = await app.request('/api/hub/v1/connections/conn-1/models/antigravity');
    assert.equal(allowed.status, 200);
    assert.deepEqual(await allowed.json(), { models: [{ id: 'gemini-4-neon-high', label: 'gemini-4-neon-high' }] });
    assert.deepEqual(seen, ['/models/antigravity']);

    const rejected = await app.request('/api/hub/v1/connections/conn-1/models/unknown-runtime');
    assert.equal(rejected.status, 400);
    assert.deepEqual(seen, ['/models/antigravity']);
  } finally {
    await routes.close();
  }
});
