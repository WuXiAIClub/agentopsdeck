import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { workspaceFileCardResource, type WorkspaceFileCardWrite } from '@agentopsdeck/shared';
import { HubStore } from '../hub/hub-store.js';
import { OriginalHubAdministrativeCommands } from '../hub/original-administrative-commands.js';
import { createHubAdministrativeServices } from '../hub/administrative-route-services.js';
import { HubMemberRequestError } from '../hub/async-member-request.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { registerHubCardFiles } from './hub-workspace-card-files.js';
const quiet = new PerformanceDiagnostics(() => {});
const write = (revision = 0, text = 'Report'): WorkspaceFileCardWrite => ({ kind: 'report', content: { title: 'Report', text }, revision, mutationId: randomUUID() });
function fixture(member = false) {
  const root = mkdtempSync(join(tmpdir(), 'hub-report-http-')), store = new HubStore(join(root, 'hub.sqlite'), 'isolated-report-vault');
  const actor = { userId: member ? store.createUser('Member').id : 'default', admin: !member };
  const key = store.identities.issueKey(actor.userId), resource = workspaceFileCardResource('report', randomUUID()), app = new Hono();
  const url = '/api/hub/v1/workspace/file-cards/' + encodeURIComponent(resource) + '/document';
  const request = (document = write(), binding = 'none') => app.request(url, { method: 'PUT',
    headers: { authorization: `Bearer ${key.token}`, 'content-type': 'application/json', 'X-AgentOpsDeck-File-Binding': binding }, body: JSON.stringify(document) });
  return { root, store, actor, key, resource, app, url, request,
    end: async () => { await store.close(); rmSync(root, { recursive: true, force: true }); } };
}
for (const member of [false, true]) test(`${member ? 'member' : 'administrator'}: awaited local report PUT keeps original save/CAS/receipt response`, async () => {
  const f = fixture(member), original = new OriginalHubAdministrativeCommands(f.store, quiet), services = createHubAdministrativeServices(original, quiet);
  registerHubCardFiles(f.app, { store: f.store, principal: () => f.actor, enabled: false, reports: services.reports });
  try {
    const first = write(), a = await f.request(first); assert.equal(a.status, 200, await a.clone().text());
    assert.equal(a.headers.get('cache-control'), 'no-store');
    const d = await a.json() as { revision: number };
    const b = await f.request(write(d.revision, 'Later')); assert.equal(b.status, 200); const latest = await b.json();
    assert.deepEqual(await (await f.request(first)).json(), latest, 'old retry returns current projection');
    assert.equal((await f.request(write(0, 'stale'))).status, 409);
    assert.equal((await f.request(first, '')).status, 409);
  } finally { await services.close(); await original.close(); await f.end(); }
});
for (const code of [401, 499, 503] as const) test(`port ${code}: no synchronous fallback or file write on local report failure`, async t => {
  const f = fixture();
  registerHubCardFiles(f.app, { store: f.store, principal: () => f.actor, enabled: false, reports: { save: async () => { throw new HubMemberRequestError(code); } } });
  t.mock.method(f.store.cardFileProjection, 'saveReport', () => assert.fail('port failure must not fall back'));
  t.mock.method(f.store.cardFiles, 'current', () => assert.fail('port failure must not select a new destination'));
  try { const response = await f.request(); assert.equal(response.status, code); assert.equal(response.headers.get('cache-control'), 'no-store'); }
  finally { await f.end(); }
});
for (const field of ['userId', 'admin'] as const) test(`final ${field} change: response proof rejects even after report save`, async () => {
  const f = fixture();
  registerHubCardFiles(f.app, { store: f.store, principal: () => f.actor, enabled: false, reports: { save: async () => {
    if (field === 'userId') f.actor.userId = 'other'; else f.actor.admin = false;
    return { resourceId: f.resource, status: 'conflict' };
  } } });
  try { assert.equal((await f.request()).status, 401); } finally { await f.end(); }
});
test('owner binding conflict keeps original HTTP 409 and cannot turn a local save into Agent file mutation', async t => {
  const f = fixture();
  registerHubCardFiles(f.app, { store: f.store, principal: () => f.actor, enabled: false,
    reports: { save: async () => ({ resourceId: f.resource, status: 'binding-conflict' }) } });
  t.mock.method(f.store.cardFileProjection, 'saveReport', () => assert.fail('binding conflict cannot fall through'));
  try { assert.equal((await f.request()).status, 409); } finally { await f.end(); }
});
test('legacy route without port retains original local report wire', async () => {
  const f = fixture(); registerHubCardFiles(f.app, { store: f.store, principal: () => f.actor, enabled: false });
  try { const response = await f.request(); assert.equal(response.status, 200); assert.deepEqual(await response.json(), f.store.cardFileProjection.get(f.actor.userId, f.resource)); }
  finally { await f.end(); }
});
for (const field of ['userId', 'admin'] as const) test(`body await ${field} change: refuse before report command admission`, async () => {
  const f = fixture(); let checks = 0, effects = 0;
  registerHubCardFiles(f.app, { store: f.store, principal: () => {
    if (++checks > 1) { if (field === 'userId') f.actor.userId = 'other'; else f.actor.admin = false; }
    return f.actor;
  }, enabled: false, reports: { save: async () => { effects++; assert.fail('Changed actor must not admit a write'); } } });
  try { assert.equal((await f.request()).status, 401); assert.equal(effects, 0); } finally { await f.end(); }
});
