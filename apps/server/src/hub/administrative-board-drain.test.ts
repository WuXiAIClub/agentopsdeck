import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HubStore } from './hub-store.js';
import { OriginalHubAdministrativeCommands } from './original-administrative-commands.js';
import { createHubAdministrativeServices } from './administrative-route-services.js';
import type { AsyncHubMemberOwner } from './async-member-owner.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const quiet = new PerformanceDiagnostics(() => {});
const unavailable = (error: unknown) => (error as { status?: number })?.status === 503;
const tick = () => new Promise<void>(yes => setImmediate(yes));
for (const operation of ['save', 'issue', 'revoke'] as const) for (const phase of ['initial', 'ack', 'final'] as const) {
  test(`board ${operation}/${phase}: group close drains complete operation and never closes original writer`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'hub-board-drain-'));
    const store = new HubStore(join(root, 'hub.sqlite'), 'isolated-board-vault');
    const original = new OriginalHubAdministrativeCommands(store, quiet);
    const key = store.identities.issueKey('default'), taskId = randomUUID();
    store.boards.save('default', 'default', { title: 'Board', revision: 0, mutationId: randomUUID(),
      tasks: [{ id: taskId, title: 'Task', detail: '', status: 'todo' }] });
    const grant = { taskIds: [taskId], fields: ['status' as const], expiresAt: Date.now() + 60_000 };
    const issued = store.boardCapabilities.issue('default', 'default', grant)!;
    let release!: () => void, entered!: () => void, snapshots = 0, effects = 0, calls = 0;
    const gate = new Promise<void>(yes => { release = yes; }), admission = new Promise<void>(yes => { entered = yes; });
    const owner = { command: async (kind: string, input: unknown) => {
      calls++;
      const reply = await original.command(kind as never, input as never);
      if (kind === 'memberSnapshot') snapshots++; else effects++;
      if (phase === 'ack' ? kind !== 'memberSnapshot' : kind === 'memberSnapshot' && snapshots === (phase === 'initial' ? 1 : 2)) {
        entered(); await gate;
      }
      return reply;
    } } as Pick<AsyncHubMemberOwner, 'command'>;
    const services = createHubAdministrativeServices(owner, quiet);
    const request = () => new Request('http://fixture.invalid/', { headers: { authorization: `Bearer ${key.token}` } });
    const actions = {
      save: () => services.boards.save(request(), 'default', 'default', { title: 'Saved', revision: 1,
        mutationId: randomUUID(), tasks: [{ id: taskId, title: 'Task', detail: '', status: 'todo' }] }),
      issue: () => services.boardCapabilities.issue(request(), 'default', 'default', grant),
      revoke: () => services.boardCapabilities.revoke(request(), 'default', 'default', issued.capability.id),
    };
    try {
      const pending = assert.rejects(actions[operation](), unavailable);
      await admission;
      const closing = services.close(); assert.equal(services.close(), closing);
      let closed = false; void closing.then(() => { closed = true; });
      await tick(); assert.equal(closed, false);
      const before = calls;
      for (const action of Object.values(actions)) await assert.rejects(action(), unavailable);
      await assert.rejects(services.boards.get(request(), 'default', 'default'), unavailable);
      await assert.rejects(services.boardCapabilities.list(request(), 'default', 'default'), unavailable);
      assert.equal(calls, before);
      release(); await pending; await closing;
      assert.equal(closed, true); assert.equal(effects, phase === 'initial' ? 0 : 1);
      assert.equal(store.boards.get('default', 'default').revision, operation === 'save' && phase !== 'initial' ? 2 : 1);
      assert.equal(store.createUser('Original writer survives').label, 'Original writer survives');
    } finally { release(); await services.close(); await original.close(); await store.close(); rmSync(root, { recursive: true, force: true }); }
  });
}
