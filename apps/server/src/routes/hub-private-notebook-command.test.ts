import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { DEFAULT_HUB_NOTEBOOK_LAYOUT } from '@agentopsdeck/shared';
import { HubStore } from '../hub/hub-store.js';
import { OriginalHubAdministrativeCommands } from '../hub/original-administrative-commands.js';
import { createHubAdministrativeServices } from '../hub/administrative-route-services.js';
import type { AsyncHubMemberOwner } from '../hub/async-member-owner.js';
import { WorkspaceNativeFileLocks } from '../hub/workspace-native-file-locks.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { registerHubSessionNotebookRoutes } from './hub-session-notebooks.js';

for (const area of ['hot', 'cold', 'layout'] as const) for (const race of ['lock', 'format'] as const) {
  if (area === 'layout' && race === 'format') continue;
  test(`private notebook HTTP ${area}/${race} race cannot flatten new formatting or bypass new native binding`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'private-notebook-http-'));
    const store = new HubStore(join(root, 'hub.sqlite'), 'isolated-notebook-http');
    const original = new OriginalHubAdministrativeCommands(store, new PerformanceDiagnostics(() => {}));
    const token = store.identities.issueKey('default').token;
    const resourceId = JSON.stringify(area === 'layout' ? ['hub-notebook-layout', 1, 'default'] : ['hub-notebook', 1]);
    const text = area === 'layout' ? JSON.stringify(DEFAULT_HUB_NOTEBOOK_LAYOUT) : 'Original private text';
    const document = { resourceId, revision: 0, text };
    let effects = 0;
    const owner = { command: async (kind: string, input: unknown) => {
      if (kind === 'personalNotebook') {
        effects++;
        if (race === 'format') {
          const changed = { ...document, text: '<span data-agentopsdeck-note="v1">Concurrent rich text</span>' };
          if (area === 'cold') store.notebooks.saveArchive('default', changed); else store.notebooks.save('default', changed);
        } else new WorkspaceNativeFileLocks((store as unknown as { db: DatabaseSync }).db)
          .claim('default', randomUUID(), [{ kind: area === 'cold' ? 'notebook-archive' : 'notebook', id: resourceId }]);
      }
      return original.command(kind as never, input as never);
    } } as Pick<AsyncHubMemberOwner, 'command'>;
    const services = createHubAdministrativeServices(owner), app = new Hono();
    registerHubSessionNotebookRoutes(app, { hubStore: store, principal: () => ({ userId: 'default', admin: true }), privateNotebooks: services.privateNotebooks });
    try {
      const path = '/api/hub/v1/notebooks/default' + (area === 'hot' ? '' : area === 'cold' ? '/archive' : '/layout');
      const response = await app.request(path, { method: 'PUT', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(document) });
      assert.equal(response.status, 409); assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(effects, 1);
      assert.match(await response.text(), race === 'format' ? /Refresh AgentOpsDeck/ : /changed in another tab/);
      const current = area === 'cold' ? store.notebooks.getArchive('default', resourceId) : store.notebooks.get('default', resourceId);
      assert.equal(current.revision, race === 'format' ? 1 : 0);
      assert.equal(current.text, race === 'format' ? '<span data-agentopsdeck-note="v1">Concurrent rich text</span>' : '');
    } finally { await services.close(); await original.close(); await store.close(); rmSync(root, { recursive: true, force: true }); }
  });
}

test('legacy private notebook endpoint uses same original command, preserves Unicode and refuses stale CAS', async () => {
  const root = mkdtempSync(join(tmpdir(), 'private-notebook-legacy-'));
  const store = new HubStore(join(root, 'hub.sqlite'), 'isolated-notebook-http');
  const original = new OriginalHubAdministrativeCommands(store, new PerformanceDiagnostics(() => {}));
  const token = store.identities.issueKey('default').token;
  const services = createHubAdministrativeServices(original), app = new Hono();
  registerHubSessionNotebookRoutes(app, { hubStore: store, principal: () => ({ userId: 'default', admin: true }), privateNotebooks: services.privateNotebooks });
  const body = { resourceId: JSON.stringify(['hub-notebook', 1]), revision: 0, text: '**中文**\n' };
  const put = (path: string) => app.request(path, { method: 'PUT', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  try {
    assert.equal((await put('/api/hub/v1/notebook')).status, 200);
    assert.equal((await put('/api/hub/v1/notebooks/default')).status, 409);
    assert.equal(store.notebooks.get('default', body.resourceId).text, body.text);
  } finally { await services.close(); await original.close(); await store.close(); rmSync(root, { recursive: true, force: true }); }
});
