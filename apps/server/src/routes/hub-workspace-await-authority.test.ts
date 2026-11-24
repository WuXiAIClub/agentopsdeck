import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { HubStore } from '../hub/hub-store.js';
import { loadConfig } from '../config.js';
import type { HubPrincipal } from '../hub/identity.js';
import { registerHubRoutes } from './hub.js';
import { registerHubWorkspacePreferences } from './hub-workspace-preferences.js';

const path = '/api/hub/v1/workspace/preferences';
for (const method of ['GET', 'PUT'] as const) for (const transition of ['revoke', 'switch-account', 'change-role'] as const) {
  test(`workspace synchronous facade rechecks ${transition} after awaited principal before ${method} storage`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'hub-workspace-await-proof-'));
    const hub = new HubStore(join(root, 'hub.sqlite'), 'synthetic-r45');
    const app = new Hono(); let current: HubPrincipal | undefined = { userId: 'original', admin: false };
    let checks = 0, reads = 0, writes = 0;
    const get = hub.workspace.get.bind(hub.workspace), save = hub.workspace.save.bind(hub.workspace);
    hub.workspace.get = (...args) => { reads++; return get(...args); };
    hub.workspace.save = (...args) => { writes++; return save(...args); };
    const routes = registerHubRoutes(app, {
      config: loadConfig({ HOME: root, AOD_SERVER_ROLE: 'hub' }), hubStore: hub,
      connectorClient: () => { throw Error('Workspace must not dispatch'); }, normalizeError: () => 'Synthetic',
      principal: () => {
        const observed = current;
        // First check is middleware admission; second is the route's original
        // principal. This revocation runs in the newly introduced await gap.
        if (++checks === 2) queueMicrotask(() => {
          current = transition === 'revoke' ? undefined : transition === 'switch-account'
            ? { userId: 'other', admin: false } : { userId: 'original', admin: true };
        });
        return observed;
      },
    });
    try {
      const result = await app.request(path, { method, ...(method === 'PUT' ? {
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: 0, groups: [], sessions: {} }),
      } : {}) });
      assert.equal(result.status, 401);
      assert.equal(result.headers.get('cache-control'), 'no-store');
      assert.equal(writes, 0, 'delivery rejection cannot undo a stale admitted CAS');
      assert.equal(reads, 0, 'revoked read must not touch workspace storage');
      assert.equal(get('original').revision, 0);
      assert.equal(get('other').revision, 0);
    } finally { routes?.close(); await hub.close(); rmSync(root, { recursive: true, force: true }); }
  });
}

for (const outcome of ['failure', 'abort', 'revoke', 'conflict'] as const) {
  test(`workspace awaited read ${outcome} preserves document and never replays save`, async () => {
    const app = new Hono(), abort = new AbortController();
    let actor: HubPrincipal = { userId: 'alice', admin: false }, reads = 0, writes = 0;
    let resolve!: (value: { revision: number; groups: []; sessions: {} }) => void;
    let reject!: (reason: Error) => void;
    const pending = new Promise<{ revision: number; groups: []; sessions: {} }>((yes, no) => { resolve = yes; reject = no; });
    let started!: () => void; const admitted = new Promise<void>(yes => { started = yes; });
    registerHubWorkspacePreferences(app, { principal: () => actor, synchronousStoreAuthority: () => actor,
      port: { get: () => { reads++; started(); return pending; }, save: () => { writes++; return undefined; } } });
    if (outcome === 'conflict') {
      const response = await app.request(path, { method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ revision: 1, groups: [], sessions: {} }) });
      assert.equal(response.status, 409); assert.equal(writes, 1); assert.equal(reads, 0); return;
    }
    const response = app.request(new Request(`http://local${path}`, { signal: abort.signal }));
    await admitted;
    if (outcome === 'abort') {
      abort.abort(); const cancelled = await response;
      assert.equal(cancelled.status, 499); assert.equal(cancelled.headers.get('cache-control'), 'no-store');
      resolve({ revision: 4, groups: [], sessions: {} }); await pending;
    } else {
      if (outcome === 'failure') reject(Error('private database path'));
      else { actor = { userId: 'bob', admin: false }; resolve({ revision: 4, groups: [], sessions: {} }); }
      const result = await response; assert.equal(result.status, outcome === 'failure' ? 503 : 401);
      assert.equal(result.headers.get('cache-control'), 'no-store'); assert.doesNotMatch(await result.text(), /private|"revision"/);
    }
    assert.equal(reads, 1); assert.equal(writes, 0);
  });
}

test('workspace GET retry after temporary refusal reads once again without changing or replaying saves', async () => {
  const app = new Hono(); let reads = 0, writes = 0;
  const document = { revision: 7, groups: [], sessions: {} };
  registerHubWorkspacePreferences(app, { principal: () => ({ userId: 'alice', admin: false }), port: {
    get: () => { if (++reads === 1) throw Error('temporarily unavailable'); return document; },
    save: () => { writes++; return document; },
  } });
  const refused = await app.request(path); assert.equal(refused.status, 503);
  const retry = await app.request(path); assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), document); assert.equal(reads, 2); assert.equal(writes, 0);
});
