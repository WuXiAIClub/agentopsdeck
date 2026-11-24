import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { WORKSPACE_FILE_CARD_KINDS, workspaceFileCardResource } from '@agentopsdeck/shared';
import { HubStore } from '../hub/hub-store.js';
import { OriginalHubAdministrativeCommands } from '../hub/original-administrative-commands.js';
import { createHubAdministrativeServices } from '../hub/administrative-route-services.js';
import { HubMemberRequestError } from '../hub/async-member-request.js';
import { configurationWrite } from '../hub/configuration-test-fixtures.js';
import { HUB_CONFIGURATION_KINDS } from '../hub/member-configuration-domain.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { registerHubCardFiles } from './hub-workspace-card-files.js';
const quiet = new PerformanceDiagnostics(() => {});
function fixture(admin = true) {
  const root = mkdtempSync(join(tmpdir(), 'hub-projection-http-')), store = new HubStore(join(root, 'hub.sqlite'), 'isolated-projection-vault');
  const userId = admin ? 'default' : store.createUser('Member').id;
  const actor = { userId, admin }, app = new Hono();
  return { root, store, actor, app, end: async () => { await store.close(); rmSync(root, { recursive: true, force: true }); } };
}
const path = (resource: string) => '/api/hub/v1/workspace/file-cards/' + encodeURIComponent(resource);
for (const admin of [true, false]) for (const kind of WORKSPACE_FILE_CARD_KINDS)
  test(`${admin ? 'admin' : 'member'}/${kind}: awaited HTTP projection retains exact original shape/status and no-store`, async () => {
    const f = fixture(admin), original = new OriginalHubAdministrativeCommands(f.store, quiet), services = createHubAdministrativeServices(original, quiet);
    const key = f.store.identities.issueKey(f.actor.userId), id = randomUUID();
    if (HUB_CONFIGURATION_KINDS.includes(kind as never)) f.store.cardConfigurations.save(f.actor.userId, id, configurationWrite(kind as never));
    if (kind === 'metric-card') f.store.cards.save(f.actor.userId, id, { title: 'Metric', value: '42', detail: '', tone: 'green', progress: 100, revision: 0, mutationId: randomUUID() });
    const resource = workspaceFileCardResource(kind, kind === 'notebook' ? 'hub:default' : id), expected = f.store.cardFileProjection.get(f.actor.userId, resource);
    registerHubCardFiles(f.app, { store: f.store, principal: () => f.actor, enabled: false, projections: services.projections });
    try {
      const response = await f.app.request(path(resource), { headers: { authorization: `Bearer ${key.token}` } });
      assert.equal(response.status, expected ? 200 : 404, await response.clone().text());
      assert.equal(response.headers.get('cache-control'), 'no-store');
      if (expected) assert.deepEqual(await response.json(), expected);
      assert.equal((await f.app.request(path(resource) + '?unexpected=1')).status, 400);
    } finally { await services.close(); await original.close(); await f.end(); }
  });
for (const code of [499, 503] as const) test(`${code}: failed read is redacted, no-store and has no synchronous fallback`, async t => {
  const f = fixture(); let calls = 0;
  t.mock.method(f.store.cardFileProjection, 'get', () => assert.fail('no fallback to sync read'));
  registerHubCardFiles(f.app, { store: f.store, principal: () => f.actor, enabled: false,
    projections: { get: async () => { calls++; throw new HubMemberRequestError(code); } } });
  try {
    const response = await f.app.request(path(workspaceFileCardResource('notebook', 'hub:default')));
    assert.equal(response.status, code); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.doesNotMatch(await response.text(), /PRIVATE|sqlite|token/); assert.equal(calls, 1);
  } finally { await f.end(); }
});
for (const field of ['userId', 'admin'] as const) test(`${field}: final caller drift refuses a previously read document`, async () => {
  const f = fixture();
  registerHubCardFiles(f.app, { store: f.store, principal: () => f.actor, enabled: false, projections: { get: async () => {
    if (field === 'userId') f.actor.userId = 'other'; else f.actor.admin = false;
    return { kind: 'browser', content: { title: 'Private content', url: '' }, revision: 0 };
  } } });
  try {
    const response = await f.app.request(path(workspaceFileCardResource('browser', randomUUID())));
    assert.equal(response.status, 401); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.doesNotMatch(await response.text(), /Private content/);
  } finally { await f.end(); }
});
test('canonical long Unicode resource stays a valid missing projection rather than introducing a new size error', async () => {
  const f = fixture(), original = new OriginalHubAdministrativeCommands(f.store, quiet), services = createHubAdministrativeServices(original, quiet);
  const key = f.store.identities.issueKey('default');
  registerHubCardFiles(f.app, { store: f.store, principal: () => f.actor, enabled: false, projections: services.projections });
  try {
    const response = await f.app.request(path(workspaceFileCardResource('browser', '中'.repeat(4000))), { headers: { authorization: `Bearer ${key.token}` } });
    assert.equal(response.status, 404, await response.clone().text());
    assert.equal((await f.app.request(path('browser:invalid'))).status, 400);
  } finally { await services.close(); await original.close(); await f.end(); }
});
