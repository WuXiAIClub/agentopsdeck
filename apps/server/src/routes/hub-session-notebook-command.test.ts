import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
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

for (const shared of [false, true]) for (const area of ['hot', 'cold'] as const)
  for (const race of ['format', 'lock', 'connection', 'grant', 'final-grant'] as const) {
    if (!shared && (race === 'grant' || race === 'final-grant')) continue;
    test(`session notebook HTTP ${shared ? 'shared' : 'owner'}/${area}/${race}: no stale authority or sync fallback`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'session-notebook-http-'));
      const store = new HubStore(join(root, 'hub.sqlite'), 'isolated-session-http');
      const original = new OriginalHubAdministrativeCommands(store, new PerformanceDiagnostics(() => {}));
      const userId = shared ? store.createUser('Recipient').id : 'default', token = store.identities.issueKey(userId).token;
      const nodeId = 'node_11111111-1111-4111-8111-111111111111', remote = 'codex:fixture';
      store.upsertConnection({ id: 'fixture', kind: 'local', connectorUrl: 'local://aod-connector', label: 'Fixture' });
      store.pinConnectionNode('fixture', 'default', store.connectionAuthority('fixture', 'default')!, nodeId);
      const target = { ownerUserId: 'default', connectionId: 'fixture', userId };
      const grant = shared ? store.grants.create(target, { runtime: 'codex', sessionKey: remote, actions: ['messages:read'] }) : undefined;
      const resourceId = JSON.stringify(['default', nodeId, 'codex', 'fixture']), body = { resourceId, revision: 0, text: 'Requested text' };
      const get = () => area === 'cold' ? store.notebooks.getArchive(userId, resourceId) : store.notebooks.get(userId, resourceId);
      const replace = () => assert.equal(store.grants.replace(target, grant!.id, grant!.version,
        { runtime: 'codex', sessionKey: remote, actions: ['messages:read'] }), true);
      let effects = 0;
      const owner = { command: async (kind: string, input: unknown) => {
        if (kind === 'personalNotebook') {
          effects++;
          if (race === 'format') {
            const changed = { ...body, text: '<span data-agentopsdeck-note="v1">Concurrent format</span>' };
            if (area === 'cold') store.notebooks.saveArchive(userId, changed); else store.notebooks.save(userId, changed);
          } else if (race === 'lock') new WorkspaceNativeFileLocks((store as unknown as { db: DatabaseSync }).db)
            .claim(userId, randomUUID(), [{ kind: area === 'cold' ? 'notebook-archive' : 'notebook', id: resourceId }]);
          else if (race === 'connection') (store as unknown as { db: DatabaseSync }).db
            .prepare('UPDATE env_connections SET authority_version = authority_version + 1 WHERE id = ?').run('fixture');
          else if (race === 'grant') replace();
        }
        const reply = await original.command(kind as never, input as never);
        if (kind === 'personalNotebook' && race === 'final-grant') replace();
        return reply;
      } } as Pick<AsyncHubMemberOwner, 'command'>;
      const services = createHubAdministrativeServices(owner), app = new Hono();
      registerHubSessionNotebookRoutes(app, { hubStore: store,
        principal: c => store.identities.requestPrincipal(c.req.raw, () => false)!, sessionNotebooks: services.privateNotebooks });
      try {
        const path = '/api/hub/v1/' + (shared ? 'shared/default/sessions/' : 'sessions/')
          + encodeURIComponent(encodeHubSessionId('fixture', remote)) + '/notebook' + (area === 'cold' ? '/archive' : '');
        const response = await app.request(path, { method: 'PUT', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
        assert.equal(response.status, race === 'format' || race === 'lock' ? 409 : 403);
        assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(effects, 1);
        assert.equal(get().revision, race === 'format' || race === 'final-grant' ? 1 : 0);
        assert.equal(get().text, race === 'format' ? '<span data-agentopsdeck-note="v1">Concurrent format</span>'
          : race === 'final-grant' ? body.text : '');
        if (shared) assert.equal(store.notebooks.get('default', resourceId).revision, 0);
      } finally { await services.close(); await original.close(); await store.close(); rmSync(root, { recursive: true, force: true }); }
    });
  }
