import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_HUB_NOTEBOOK_LAYOUT } from '@agentopsdeck/shared';
import { HubStore } from './hub-store.js';
import { OriginalHubAdministrativeCommands } from './original-administrative-commands.js';
import { createHubAdministrativeServices } from './administrative-route-services.js';
import type { AsyncHubMemberOwner } from './async-member-owner.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const quiet = new PerformanceDiagnostics(() => {});
const unavailable = (error: unknown) => (error as { status?: number })?.status === 503;
const tick = () => new Promise<void>(yes => setImmediate(yes));
for (const area of ['hot', 'cold', 'layout'] as const) for (const phase of ['initial', 'ack', 'final'] as const) {
  test(`private notebook ${area}/${phase}: group close owns initial proof, ACK and final proof`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'hub-notebook-drain-'));
    const store = new HubStore(join(root, 'hub.sqlite'), 'isolated-notebook-vault');
    const original = new OriginalHubAdministrativeCommands(store, quiet);
    const key = store.identities.issueKey('default');
    const resourceId = JSON.stringify(area === 'layout' ? ['hub-notebook-layout', 1, 'default'] : ['hub-notebook', 1]);
    const text = area === 'layout' ? JSON.stringify(DEFAULT_HUB_NOTEBOOK_LAYOUT) : 'Private text';
    let release!: () => void, entered!: () => void, snapshots = 0, effects = 0, calls = 0;
    const gate = new Promise<void>(yes => { release = yes; }), admission = new Promise<void>(yes => { entered = yes; });
    const owner = { command: async (kind: string, input: unknown) => {
      calls++;
      const reply = await original.command(kind as never, input as never);
      if (kind === 'memberSnapshot') snapshots++; else effects++;
      if (phase === 'ack' ? kind === 'personalNotebook' : kind === 'memberSnapshot' && snapshots === (phase === 'initial' ? 1 : 2)) {
        entered(); await gate;
      }
      return reply;
    } } as Pick<AsyncHubMemberOwner, 'command'>;
    const services = createHubAdministrativeServices(owner, quiet);
    const save = () => services.privateNotebooks.savePrivate(new Request('http://fixture.invalid/', {
      headers: { authorization: `Bearer ${key.token}` },
    }), 'default', { resourceId, revision: 0, text }, area, false);
    try {
      const pending = assert.rejects(save(), unavailable);
      await admission;
      const closing = services.close(); assert.equal(services.close(), closing);
      let closed = false; void closing.then(() => { closed = true; });
      await tick(); assert.equal(closed, false);
      const before = calls; await assert.rejects(save(), unavailable); assert.equal(calls, before);
      release(); await pending; await closing;
      assert.equal(closed, true); assert.equal(effects, phase === 'initial' ? 0 : 1);
      const value = area === 'cold' ? store.notebooks.getArchive('default', resourceId) : store.notebooks.get('default', resourceId);
      assert.equal(value.revision, phase === 'initial' ? 0 : 1);
      assert.equal(store.createUser('Original writer survives').label, 'Original writer survives');
    } finally { release(); await services.close(); await original.close(); await store.close(); rmSync(root, { recursive: true, force: true }); }
  });
}
