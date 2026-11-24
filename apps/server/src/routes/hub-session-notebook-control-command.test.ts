import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { HubStore } from '../hub/hub-store.js';
import { OriginalHubAdministrativeCommands } from '../hub/original-administrative-commands.js';
import { createHubAdministrativeServices } from '../hub/administrative-route-services.js';
import type { AsyncHubMemberOwner } from '../hub/async-member-owner.js';
import { WorkspaceNativeFileLocks } from '../hub/workspace-native-file-locks.js';
import { encodeHubSessionId } from '../hub/session-id.js';
import { registerHubSessionNotebookRoutes } from './hub-session-notebooks.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

for (const shared of [false, true]) for (const action of ['move', 'receipt', 'capabilities', 'issue', 'revoke'] as const)
  for (const race of ['normal', 'connection', 'grant', 'final-grant', 'lock', 'lost'] as const) {
    if (shared && !['move', 'receipt'].includes(action) || !shared && ['grant', 'final-grant'].includes(race)
      || race === 'lock' && action !== 'move') continue;
    test(`session control HTTP ${shared ? 'shared' : 'owner'}/${action}/${race}: original route policy, ACK and final authority`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'session-control-http-'));
      const quiet = new PerformanceDiagnostics(() => {}), store = new HubStore(join(root, 'hub.sqlite'), 'isolated-control-http');
      const original = new OriginalHubAdministrativeCommands(store, quiet);
      const userId = shared ? store.createUser('Recipient').id : 'default', key = store.identities.issueKey(userId);
      const nodeId = 'node_11111111-1111-4111-8111-111111111111', remote = 'codex:fixture';
      store.upsertConnection({ id: 'fixture', kind: 'local', connectorUrl: 'local://aod-connector', label: 'Isolated' });
      store.pinConnectionNode('fixture', 'default', store.connectionAuthority('fixture', 'default')!, nodeId);
      const target = { ownerUserId: 'default', connectionId: 'fixture', userId };
      const grant = shared ? store.grants.create(target, { runtime: 'codex', sessionKey: remote, actions: ['messages:read'] }) : undefined;
      const resourceId = JSON.stringify(['default', nodeId, 'codex', 'fixture']);
      store.notebooks.save(userId, { resourceId, revision: 0, text: 'hello world' });
      const input = { requestId: randomUUID(), direction: 'archive', hotRevision: 1, coldRevision: 0,
        ranges: [{ start: 0, end: 5, sha256: createHash('sha256').update('hello').digest('hex') }] };
      const capability = store.notebookCapabilities.issue(userId, resourceId,
        { facets: ['hot:read'], expiresAt: Date.now() + 600_000 }, null)!;
      if (action === 'receipt') store.notebooks.move(userId, resourceId, input as never);
      const replace = () => assert.equal(store.grants.replace(target, grant!.id, grant!.version,
        { runtime: 'codex', sessionKey: remote, actions: ['messages:read'] }), true);
      let effects = 0;
      const owner = { command: async (kind: string, command: unknown) => {
        if (kind === 'notebookControl') {
          effects++;
          if (race === 'connection') (store as unknown as { db: DatabaseSync }).db
            .prepare('UPDATE env_connections SET authority_version=authority_version+1 WHERE id=?').run('fixture');
          else if (race === 'grant') replace();
          else if (race === 'lock') new WorkspaceNativeFileLocks((store as unknown as { db: DatabaseSync }).db)
            .claim(userId, randomUUID(), [{ kind: 'notebook', id: resourceId }]);
        }
        const reply = await original.command(kind as never, command as never);
        if (kind === 'notebookControl' && race === 'final-grant') replace();
        if (kind === 'notebookControl' && race === 'lost') throw Error('PRIVATE ACK lost');
        return reply;
      } } as Pick<AsyncHubMemberOwner, 'command'>;
      const services = createHubAdministrativeServices(owner, quiet), app = new Hono();
      registerHubSessionNotebookRoutes(app, { hubStore: store, notebookControl: services.notebookControl,
        principal: c => store.identities.requestPrincipal(c.req.raw, () => false)! });
      const base = '/api/hub/v1/' + (shared ? 'shared/default/sessions/' : 'sessions/')
        + encodeURIComponent(encodeHubSessionId('fixture', remote)) + '/notebook';
      const suffix = action === 'move' ? '/moves' : action === 'receipt' ? `/moves/${input.requestId}`
        : action === 'revoke' ? `/capabilities/${capability.capability.id}` : '/capabilities';
      try {
        const response = await app.request(base + suffix, { headers: { authorization: `Bearer ${key.token}` },
          method: action === 'move' || action === 'issue' ? 'POST' : action === 'revoke' ? 'DELETE' : 'GET',
          ...(['move', 'issue'].includes(action) ? { body: JSON.stringify(action === 'move' ? input
            : { facets: ['hot:read'], expiresAt: Date.now() + 600_000 }) } : {}) });
        assert.equal(response.status, race === 'normal' ? action === 'issue' ? 201 : 200
          : race === 'lost' ? 503 : race === 'lock' ? 409 : 403);
        assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(effects, 1);
        assert.doesNotMatch(await response.text(), /PRIVATE|ACK lost/);
        assert.equal(store.notebooks.get(userId, resourceId).revision,
          action === 'receipt' || action === 'move' && ['normal', 'lost', 'final-grant'].includes(race) ? 2 : 1);
        assert.equal(store.notebookCapabilities.list(userId, resourceId).length,
          action === 'issue' && ['normal', 'lost'].includes(race) ? 2 : 1);
        if (shared) assert.equal(store.notebooks.get('default', resourceId).revision, 0);
        if (action === 'revoke') assert.equal(store.notebookCapabilities.authorized(capability.token) === undefined,
          ['normal', 'lost'].includes(race));
        if (shared) assert.equal((await app.request(base + '/capabilities', {
          headers: { authorization: `Bearer ${key.token}` },
        })).status, 404, 'shared route never exposes capability management');
      } finally { await services.close(); await original.close(); await store.close(); rmSync(root, { recursive: true, force: true }); }
    });
  }
