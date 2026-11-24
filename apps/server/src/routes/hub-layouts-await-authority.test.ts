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

const path = '/api/hub/v1/workspace/layouts/current';
for (const method of ['GET', 'PUT'] as const) for (const transition of ['revoke', 'switch-account', 'change-role'] as const) {
  test(`layout synchronous facade rechecks ${transition} after awaited principal before ${method} storage`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'hub-workspace-await-proof-'));
    const hub = new HubStore(join(root, 'hub.sqlite'), 'synthetic-r45');
    const app = new Hono(); let current: HubPrincipal | undefined = { userId: 'original', admin: false };
    let checks = 0, reads = 0, writes = 0;
    const get = hub.layouts.get.bind(hub.layouts), save = hub.layouts.save.bind(hub.layouts);
    hub.layouts.get = (...args) => { reads++; return get(...args); };
    hub.layouts.save = (...args) => { writes++; return save(...args); };
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
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision: 0, content: JSON.stringify({ id: 'current', name: 'Current', workspace: { version: 2, panes: [], floating: [] }, collapsedKeys: [] }) }),
      } : {}) });
      assert.equal(result.status, 401);
      assert.equal(result.headers.get('cache-control'), 'no-store');
      assert.equal(writes, 0, 'delivery rejection cannot undo a stale admitted CAS');
      assert.equal(reads, 0, 'revoked read must not touch workspace storage');
      assert.equal(get('original', 'current').revision, 0);
      assert.equal(get('other', 'current').revision, 0);
    } finally { routes?.close(); await hub.close(); rmSync(root, { recursive: true, force: true }); }
  });
}
