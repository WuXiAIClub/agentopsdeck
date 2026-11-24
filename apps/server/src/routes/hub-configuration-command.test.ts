import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { workspaceFileCardResource } from '@agentopsdeck/shared';
import { HubStore } from '../hub/hub-store.js';
import { OriginalHubAdministrativeCommands } from '../hub/original-administrative-commands.js';
import { createHubAdministrativeServices } from '../hub/administrative-route-services.js';
import { HubMemberRequestError } from '../hub/async-member-request.js';
import { HUB_CONFIGURATION_KINDS, type HubConfigurationKind } from '../hub/member-configuration-domain.js';
import { configurationWrite } from '../hub/configuration-test-fixtures.js';
import { WorkspaceNativeFileLocks } from '../hub/workspace-native-file-locks.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { registerHubCardFiles } from './hub-workspace-card-files.js';

const quiet = new PerformanceDiagnostics(() => {});
function fixture(kind: HubConfigurationKind) {
  const root = mkdtempSync(join(tmpdir(), 'hub-configuration-http-')), store = new HubStore(join(root, 'hub.sqlite'), 'isolated-config-vault');
  const resource = randomUUID(), app = new Hono(), actor = { userId: 'default', admin: true };
  return { store, app, actor, resource, path: `/api/hub/v1/workspace/file-cards/${encodeURIComponent(workspaceFileCardResource(kind, resource))}/configuration`,
    end: async () => { await store.close(); rmSync(root, { recursive: true, force: true }); } };
}
for (const kind of HUB_CONFIGURATION_KINDS) {
  test(`${kind}: original HTTP status/GET projection/PUT receipt and native-lock semantics stay compatible`, async () => {
    const f = fixture(kind), original = new OriginalHubAdministrativeCommands(f.store, quiet), services = createHubAdministrativeServices(original, quiet);
    const key = f.store.identities.issueKey('default'), headers = { authorization: `Bearer ${key.token}`, 'content-type': 'application/json' };
    registerHubCardFiles(f.app, { store: f.store, principal: () => f.actor, configurations: services.configurations, enabled: false });
    try {
      assert.deepEqual(await (await f.app.request(f.path, { headers })).json(), { document: null });
      const body = configurationWrite(kind), send = (value = body) => f.app.request(f.path, { method: 'PUT', headers, body: JSON.stringify(value) });
      const first = await send(); assert.equal(first.status, 200); const receipt = await first.json();
      assert.deepEqual(await (await send()).json(), receipt); assert.ok(Number.isSafeInteger(receipt.updatedAt));
      const read = await f.app.request(f.path, { headers }); assert.equal(read.headers.get('cache-control'), 'no-store');
      const { updatedAt: _time, ...projection } = receipt; assert.deepEqual(await read.json(), { document: projection });
      assert.equal((await send({ ...body, mutationId: randomUUID() })).status, 409);
      const locks = new WorkspaceNativeFileLocks((f.store as unknown as { db: DatabaseSync }).db);
      assert.equal(locks.claim('default', randomUUID(), [{ kind, id: f.resource }]), true);
      const locked = await send(); assert.equal(locked.status, 409); assert.deepEqual(await locked.json(), { error: 'file-managed' });
      assert.equal((await f.app.request(f.path + '?x=1', { headers })).status, 400);
    } finally { await services.close(); await original.close(); await f.end(); }
  });
  for (const code of [503, 499] as const) test(`${kind}/${code}: async failure is redacted/no-store and never falls back to synchronous save`, async t => {
    const f = fixture(kind); let effects = 0;
    const failure = async () => { effects++; throw new HubMemberRequestError(code); };
    t.mock.method(f.store.cardConfigurations, 'save', () => assert.fail('failed port cannot fall back'));
    t.mock.method(f.store.cardConfigurations, 'get', () => assert.fail('failed port cannot fall back'));
    registerHubCardFiles(f.app, { store: f.store, principal: () => f.actor, enabled: false, configurations: { get: failure, save: failure } });
    try {
      for (const method of ['GET', 'PUT']) {
        const response = await f.app.request(f.path, { method, ...(method === 'PUT' ? { body: JSON.stringify(configurationWrite(kind)) } : {}) });
        assert.equal(response.status, code); assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.doesNotMatch(await response.text(), /PRIVATE|sqlite|token/);
      }
      assert.equal(effects, 2);
    } finally { await f.end(); }
  });
  for (const field of ['userId', 'admin'] as const) for (const phase of ['body', 'final'] as const)
    test(`${kind}/${field}/${phase}: caller principal cannot drift across an awaited boundary`, async () => {
      const f = fixture(kind); let effects = 0;
      const change = () => { if (field === 'userId') f.actor.userId = 'other'; else f.actor.admin = false; };
      const body = configurationWrite(kind);
      registerHubCardFiles(f.app, { store: f.store, principal: () => f.actor, enabled: false, configurations: { get: async () => null,
        save: async () => { effects++; change(); return { status: 'conflict' }; } } });
      try {
        const value = phase === 'body' ? new ReadableStream<Uint8Array>({ pull(controller) { change(); controller.enqueue(new TextEncoder().encode(JSON.stringify(body))); controller.close(); } }, { highWaterMark: 0 }) : JSON.stringify(body);
        const response = await f.app.request(f.path, { method: 'PUT', body: value, ...(phase === 'body' ? { duplex: 'half' } : {}) } as RequestInit);
        assert.equal(response.status, 401); assert.equal(effects, phase === 'body' ? 0 : 1);
      } finally { await f.end(); }
    });
}
test('oversized or nonconfiguration input is refused before asynchronous effect', async () => {
  const f = fixture('browser'); let effects = 0;
  const save = async () => { effects++; return { status: 'conflict' as const }; };
  registerHubCardFiles(f.app, { store: f.store, principal: () => f.actor, enabled: false, configurations: { get: async () => null, save } });
  try {
    assert.equal((await f.app.request(f.path, { method: 'PUT', body: ' '.repeat(2 * 1024 * 1024 + 4097) })).status, 413);
    assert.equal((await f.app.request(f.path, { method: 'PUT', body: JSON.stringify(configurationWrite('terminal')) })).status, 400);
    assert.equal((await f.app.request(f.path.replace('browser', 'notebook'))).status, 400);
    assert.equal(effects, 0);
  } finally { await f.end(); }
});
