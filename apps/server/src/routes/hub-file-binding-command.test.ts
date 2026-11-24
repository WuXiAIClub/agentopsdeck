import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { workspaceFileCardResource } from '@agentopsdeck/shared';
import { HubStore } from '../hub/hub-store.js';
import { OriginalHubAdministrativeCommands } from '../hub/original-administrative-commands.js';
import { createHubAdministrativeServices } from '../hub/administrative-route-services.js';
import { HubMemberRequestError } from '../hub/async-member-request.js';
import { seedFileBindings } from '../hub/file-binding-test-fixtures.js';
import type { HubFileCardService } from '../hub/workspace-card-file-service.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { registerHubCardFiles } from './hub-workspace-card-files.js';
import { registerHubBoardFiles } from './hub-workspace-board-files.js';
const quiet = new PerformanceDiagnostics(() => {});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hub-binding-http-')), store = new HubStore(join(root, 'hub.sqlite'), 'isolated-binding-vault');
  const actor = { userId: 'default', admin: true }, app = new Hono();
  return { root, store, actor, app, end: async () => { await store.close(); rmSync(root, { recursive: true, force: true }); } };
}
const cardPath = (resource: string) => '/api/hub/v1/workspace/file-cards/' + encodeURIComponent(resource) + '/file-binding';
const boardPath = '/api/hub/v1/workspace/boards/default/file-binding';
const service = { inspect: async () => assert.fail('disabled inspect cannot contact remote') } as unknown as HubFileCardService;
for (const domain of ['board', 'card'] as const) for (const composed of [false, true]) test(domain + '/' + composed + ': awaited public metadata preserves wire shape, resource isolation, disabled get', async () => {
  const f = fixture(), original = new OriginalHubAdministrativeCommands(f.store, quiet), services = createHubAdministrativeServices(original, quiet);
  const values = seedFileBindings(f.store), binding = values[domain], key = f.store.identities.issueKey('default');
  if (domain === 'board') registerHubBoardFiles(f.app, { principal: () => f.actor, files: f.store.boardFiles, service: service as never, enabled: false, bindingReads: services.fileBindingReads });
  else registerHubCardFiles(f.app, { store: f.store, principal: () => f.actor, enabled: false, bindingReads: services.fileBindingReads, ...(composed ? { service } : {}) });
  const path = domain === 'board' ? boardPath : cardPath(binding.resourceId), headers = { authorization: 'Bearer ' + key.token };
  try {
    const response = await f.app.request(path, { headers }); assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get('cache-control'), 'no-store'); assert.deepEqual(await response.json(), { enabled: false, binding });
    if (domain === 'board' || composed) {
      const get = await f.app.request(path + '/' + binding.bindingId, { headers }); assert.equal(get.status, 200); assert.deepEqual(await get.json(), { binding });
      const wrong = domain === 'board' ? path.replace('/default/', '/' + randomUUID() + '/') : cardPath(workspaceFileCardResource('browser', randomUUID()));
      assert.equal((await f.app.request(wrong + '/' + binding.bindingId, { headers })).status, 404);
      assert.equal((await f.app.request(path + '?unexpected=1', { headers })).status, 400);
    }
  } finally { await services.close(); await original.close(); await f.end(); }
});
for (const domain of ['board', 'card'] as const) for (const code of [499, 503] as const) test(domain + '/' + code + ': read failure is redacted and never falls back to sync metadata', async t => {
  const f = fixture(); let calls = 0;
  const bindingReads = { read: async () => { calls++; throw new HubMemberRequestError(code); } };
  t.mock.method(f.store.boardFiles, 'current', () => assert.fail('no sync fallback'));
  t.mock.method(f.store.cardFiles, 'current', () => assert.fail('no sync fallback'));
  if (domain === 'board') registerHubBoardFiles(f.app, { principal: () => f.actor, files: f.store.boardFiles, service: service as never, enabled: false, bindingReads });
  else registerHubCardFiles(f.app, { store: f.store, principal: () => f.actor, enabled: false, bindingReads });
  try { const response = await f.app.request(domain === 'board' ? boardPath : cardPath(workspaceFileCardResource('notebook', 'hub:default')));
    assert.equal(response.status, code); assert.equal(response.headers.get('cache-control'), 'no-store'); assert.doesNotMatch(await response.text(), /sqlite|token|PRIVATE/); assert.equal(calls, 1);
  } finally { await f.end(); }
});
for (const domain of ['board', 'card'] as const) for (const field of ['userId', 'admin'] as const) test(domain + '/' + field + ': final authority drift refuses metadata', async () => {
  const f = fixture(); const bindingReads = { read: async () => { if (field === 'userId') f.actor.userId = 'other'; else f.actor.admin = false; return null; } };
  if (domain === 'board') registerHubBoardFiles(f.app, { principal: () => f.actor, files: f.store.boardFiles, service: service as never, enabled: false, bindingReads });
  else registerHubCardFiles(f.app, { store: f.store, principal: () => f.actor, enabled: false, bindingReads });
  try { const response = await f.app.request(domain === 'board' ? boardPath : cardPath(workspaceFileCardResource('notebook', 'hub:default'))); assert.equal(response.status, 401); assert.equal(response.headers.get('cache-control'), 'no-store'); }
  finally { await f.end(); }
});
test('long canonical Unicode card resource retains empty-binding response without budget regression', async () => {
  const f = fixture(), original = new OriginalHubAdministrativeCommands(f.store, quiet), services = createHubAdministrativeServices(original, quiet), key = f.store.identities.issueKey('default');
  registerHubCardFiles(f.app, { store: f.store, principal: () => f.actor, enabled: false, bindingReads: services.fileBindingReads });
  try { const response = await f.app.request(cardPath(workspaceFileCardResource('browser', '中'.repeat(4000))), { headers: { authorization: 'Bearer ' + key.token } });
    assert.equal(response.status, 200, await response.clone().text()); assert.deepEqual(await response.json(), { enabled: false, binding: null });
  } finally { await services.close(); await original.close(); await f.end(); }
});
