import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { HubStore } from './hub-store.js';
import { OriginalHubAdministrativeCommands } from './original-administrative-commands.js';
import { createHubAdministrativeServices } from './administrative-route-services.js';
import type { AsyncHubMemberOwner } from './async-member-owner.js';
import { encodeHubSessionId } from './session-id.js';
import type { HubSessionNotebookAuthority } from './member-session-notebook-authority.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const quiet = new PerformanceDiagnostics(() => {});
const unavailable = (e: unknown) => (e as { status?: number })?.status === 503;
const tick = () => new Promise<void>(yes => setImmediate(yes));
for (const shared of [false, true]) for (const action of ['move', 'receipt', 'capabilities', 'issue', 'revoke'] as const)
  for (const phase of ['initial', 'ack', 'final'] as const) {
    if (shared && !['move', 'receipt'].includes(action)) continue;
    test(`session control ${shared ? 'shared' : 'owner'}/${action}/${phase}: close retains complete authority/ACK lifetime`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'session-control-drain-'));
      const store = new HubStore(join(root, 'hub.sqlite'), 'isolated-control');
      const original = new OriginalHubAdministrativeCommands(store, quiet);
      const userId = shared ? store.createUser('Recipient').id : 'default', key = store.identities.issueKey(userId);
      const nodeId = 'node_11111111-1111-4111-8111-111111111111', remote = 'codex:fixture';
      store.upsertConnection({ id: 'fixture', kind: 'local', connectorUrl: 'local://aod-connector', label: 'Isolated' });
      store.pinConnectionNode('fixture', 'default', store.connectionAuthority('fixture', 'default')!, nodeId);
      const sessionId = encodeHubSessionId('fixture', remote), resourceId = JSON.stringify(['default', nodeId, 'codex', 'fixture']);
      let authority: HubSessionNotebookAuthority;
      if (shared) {
        const target = { ownerUserId: 'default', connectionId: 'fixture', userId };
        store.grants.create(target, { runtime: 'codex', sessionKey: remote, actions: ['messages:read'] });
        authority = { kind: 'shared', sessionId, ownerUserId: 'default',
          proof: store.grants.authorize(target, 'messages:read', { runtime: 'codex', sessionKey: remote })! };
      } else authority = { kind: 'owner', sessionId, connectionVersion: store.connectionAuthority('fixture', 'default')! };
      store.notebooks.save(userId, { resourceId, revision: 0, text: 'hello world' });
      const input = { requestId: randomUUID(), direction: 'archive' as const, hotRevision: 1, coldRevision: 0,
        ranges: [{ start: 0, end: 5, sha256: createHash('sha256').update('hello').digest('hex') }] };
      const capability = store.notebookCapabilities.issue(userId, resourceId, { facets: ['hot:read'], expiresAt: Date.now() + 600_000 }, null)!;
      let release!: () => void, entered!: () => void, snapshots = 0, effects = 0, calls = 0;
      const gate = new Promise<void>(yes => { release = yes; }), admission = new Promise<void>(yes => { entered = yes; });
      const owner = { command: async (kind: string, command: unknown) => {
        calls++; const reply = await original.command(kind as never, command as never);
        if (kind === 'memberSnapshot') snapshots++; else effects++;
        if (phase === 'ack' ? kind === 'notebookControl' : kind === 'memberSnapshot' && snapshots === (phase === 'initial' ? 1 : 2)) {
          entered(); await gate;
        }
        return reply;
      } } as Pick<AsyncHubMemberOwner, 'command'>;
      const services = createHubAdministrativeServices(owner, quiet), port = services.notebookControl;
      const request = () => new Request('http://fixture.invalid', { headers: { authorization: `Bearer ${key.token}` } });
      const run = () => action === 'move' ? port.move(request(), userId, resourceId, input, authority)
        : action === 'receipt' ? port.receipt(request(), userId, resourceId, input.requestId, authority)
        : action === 'issue' ? port.issue(request(), userId, resourceId, { facets: ['hot:read'], expiresAt: Date.now() + 600_000 }, authority)
        : action === 'revoke' ? port.revoke(request(), userId, resourceId, capability.capability.id, authority)
        : port.capabilities(request(), userId, resourceId, authority);
      try {
        const pending = assert.rejects(run(), unavailable); await admission;
        const closing = services.close(); assert.equal(services.close(), closing);
        let closed = false; void closing.then(() => { closed = true; }); await tick(); assert.equal(closed, false);
        const before = calls; await assert.rejects(run(), unavailable); assert.equal(calls, before);
        release(); await pending; await closing;
        assert.equal(effects, phase === 'initial' ? 0 : 1);
        assert.equal(store.notebooks.get(userId, resourceId).revision, action === 'move' && phase !== 'initial' ? 2 : 1);
        assert.equal(store.notebookCapabilities.list(userId, resourceId).length, action === 'issue' && phase !== 'initial' ? 2 : 1);
        assert.ok(store.createUser('Original writer remains open'));
      } finally { release(); await services.close(); await original.close(); await store.close(); rmSync(root, { recursive: true, force: true }); }
    });
  }
