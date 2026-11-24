import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { HubStore } from './hub-store.js';
import { HubMemberRequestError } from './async-member-request.js';
import { requestOwnerControl } from './owner-control.js';
import { encodeHubSessionId } from './session-id.js';

for (const operation of ['message', 'create', 'delete', 'settings', 'compact', 'queue'] as const)
  test(`private ${operation} Request keeps original actor; clones/headers/failure never select it`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'internal-owner-control-')), store = new HubStore(join(root, 'hub.sqlite'), 'isolated');
    store.upsertConnection({ id: 'node', kind: 'local', label: 'Local', connectorUrl: 'local://aod-connector' });
    const internal = new WeakMap<Request, unknown>(), app = new Hono();
    let actor: string | undefined = 'default', external = 0;
    const deps = { store, internalRequests: internal, client: () => { throw Error('unexpected transport'); },
      owner: () => { if (!actor) throw new HTTPException(401); return actor; },
      asyncOwnerControl: { open: async () => { external++; throw new HubMemberRequestError(503); } } };
    let retained: Awaited<ReturnType<typeof requestOwnerControl>> | undefined;
    app.get('/control/:connectionId/:agentId/:hubSessionId/:messageId', async c => {
      retained = await requestOwnerControl(c, deps, operation); await retained.check(); return c.json({ owner: retained.owner });
    });
    const raw = () => new Request(`http://hub/control/node/codex/${encodeURIComponent(encodeHubSessionId('node', 'codex:fixture'))}/queued`,
      { headers: { 'x-agentopsdeck-internal': 'true', 'x-agentopsdeck-user': 'default' } });
    try {
      const request = raw(); internal.set(request, true);
      assert.equal((await app.fetch(request)).status, 200); assert.equal(external, 0);
      assert.ok(retained); const original = retained;
      for (const imitation of [request.clone(), raw()]) assert.equal((await app.fetch(imitation)).status, 503);
      assert.equal(external, 2, 'configured async failures never downgrade to sync actor');
      actor = undefined;
      await assert.rejects(async () => original.check(), { status: 401 });
      assert.equal((await app.fetch(request)).status, 401); assert.equal(external, 2);
      actor = 'default'; internal.delete(request);
      assert.equal((await app.fetch(request)).status, 503); assert.equal(external, 3);
    } finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
  });
