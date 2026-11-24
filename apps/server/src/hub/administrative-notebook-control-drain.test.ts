import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HubStore } from './hub-store.js';
import { OriginalHubAdministrativeCommands } from './original-administrative-commands.js';
import { createHubAdministrativeServices } from './administrative-route-services.js';
import type { AsyncHubMemberOwner } from './async-member-owner.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { notebookHash } from './notebook-operations.js';

const quiet = new PerformanceDiagnostics(() => {});
const unavailable = (e: unknown) => (e as { status?: number })?.status === 503;
const tick = () => new Promise<void>(yes => setImmediate(yes));
for (const action of ['move', 'receipt', 'capabilities', 'issue', 'revoke'] as const)
  for (const phase of ['initial', 'ack', 'final'] as const) {
    test(`notebook ${action}/${phase}: aggregate close drains original proof, ACK and final proof`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'notebook-control-drain-'));
      const store = new HubStore(join(root, 'hub.sqlite'), 'isolated-control-drain');
      const original = new OriginalHubAdministrativeCommands(store, quiet);
      const token = store.identities.issueKey('default').token, resourceId = JSON.stringify(['hub-notebook', 1]);
      store.notebooks.save('default', { resourceId, revision: 0, text: 'hello' });
      const grant = store.notebookCapabilities.issue('default', resourceId, { facets: ['hot:read'], expiresAt: Date.now() + 600_000 }, null)!;
      let release!: () => void, entered!: () => void, snapshots = 0, effects = 0, calls = 0;
      const gate = new Promise<void>(yes => { release = yes; }), admission = new Promise<void>(yes => { entered = yes; });
      const owner = { command: async (kind: string, input: unknown) => {
        calls++; const reply = await original.command(kind as never, input as never);
        if (kind === 'memberSnapshot') snapshots++; else effects++;
        if (phase === 'ack' ? kind === 'notebookControl' : kind === 'memberSnapshot' && snapshots === (phase === 'initial' ? 1 : 2)) {
          entered(); await gate;
        }
        return reply;
      } } as Pick<AsyncHubMemberOwner, 'command'>;
      const services = createHubAdministrativeServices(owner, quiet), requestId = randomUUID();
      const run = () => {
        const request = new Request('http://fixture.invalid', { headers: { authorization: `Bearer ${token}` } });
        const c = services.notebookControl;
        switch (action) {
          case 'move': return c.move(request, 'default', resourceId, { requestId, hotRevision: 1, coldRevision: 0,
            direction: 'archive', ranges: [{ start: 0, end: 5, sha256: notebookHash('hello') }] });
          case 'receipt': return c.receipt(request, 'default', resourceId, requestId);
          case 'capabilities': return c.capabilities(request, 'default', resourceId);
          case 'issue': return c.issue(request, 'default', resourceId, { facets: ['hot:read'], expiresAt: Date.now() + 600_000 });
          case 'revoke': return c.revoke(request, 'default', resourceId, grant.capability.id);
        }
      };
      try {
        const pending = assert.rejects(run(), unavailable); await admission;
        const closing = services.close(); assert.equal(services.close(), closing);
        let closed = false; void closing.then(() => { closed = true; });
        await tick(); assert.equal(closed, false);
        const before = calls; await assert.rejects(run(), unavailable); assert.equal(calls, before);
        release(); await pending; await closing;
        assert.equal(effects, phase === 'initial' ? 0 : 1);
        assert.equal(store.notebooks.get('default', resourceId).revision, action === 'move' && phase !== 'initial' ? 2 : 1);
        assert.equal(!!store.notebookCapabilities.authorized(grant.token), !(action === 'revoke' && phase !== 'initial'));
        assert.equal(store.createUser('Original writer survives').label, 'Original writer survives');
      } finally { release(); await services.close(); await original.close(); await store.close(); rmSync(root, { recursive: true, force: true }); }
    });
  }
