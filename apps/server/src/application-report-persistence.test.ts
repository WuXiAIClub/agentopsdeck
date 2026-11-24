import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { workspaceFileCardResource, type WorkspaceFileCardWrite } from '@agentopsdeck/shared';
import { createApplication } from './application.js';
import { loadConfig } from './config.js';
import { HubStore } from './hub/hub-store.js';
import { OriginalHubAdministrativeCommands } from './hub/original-administrative-commands.js';

for (const backend of ['json', 'sqlite'] as const) for (const member of [false, true])
  test(`application report ${backend}/${member ? 'member' : 'administrator'}: original save/replay and authenticated session survive reopen`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'application-report-')), administratorKey = 'isolated-report-administrator';
    const config = loadConfig({ HOME: root, AOD_SERVER_ROLE: 'hub', AOD_ACCESS_KEY: administratorKey,
      AOD_HUB_DATABASE_FILE: join(root, 'hub.sqlite'), AOD_HUB_VAULT_SECRET: 'isolated-report-vault',
      AOD_PASSKEYS_FILE: join(root, 'passkeys.json'), AOD_AUTH_SESSIONS_FILE: join(root, 'sessions.json'),
      AOD_SESSION_TITLES_FILE: join(root, 'titles.json'), AOD_CONNECTOR_TOKENS_FILE: join(root, 'tokens.json'),
      AOD_CONNECTOR_USERS_DATABASE_FILE: join(root, 'connector.sqlite'),
      ...(backend === 'sqlite' ? { AOD_AUTH_SQLITE_FILE: join(root, 'auth.sqlite') } : {}) });
    const seed = new HubStore(config.hub.databaseFile, config.hub.vaultSecret, [], administratorKey);
    const userId = member ? seed.createUser('Report member').id : 'default', key = seed.identities.issueKey(userId);
    const cookie = `agentopsdeck_session=${seed.identities.createSession(key.token)!}`, resource = workspaceFileCardResource('report', randomUUID());
    const first: WorkspaceFileCardWrite = { kind: 'report', content: { title: 'Original report', text: 'Durable first' }, revision: 0, mutationId: randomUUID() };
    assert.equal(seed.cardFileProjection.saveReport(userId, JSON.parse(resource)[1], first), 'saved');
    const initial = seed.cardFileProjection.get(userId, resource)!; await seed.close();
    let application = createApplication(config), writes = 0;
    const original = OriginalHubAdministrativeCommands.prototype.command;
    t.mock.method(OriginalHubAdministrativeCommands.prototype, 'command', function(this: OriginalHubAdministrativeCommands, kind: never, input: never) {
      if (kind === 'workspaceReport') writes++;
      return original.call(this, kind, input);
    });
    const path = '/api/hub/v1/workspace/file-cards/' + encodeURIComponent(resource);
    const save = (input: WorkspaceFileCardWrite) => application.app.request(path + '/document', { method: 'PUT',
      headers: { cookie, 'content-type': 'application/json', 'X-AgentOpsDeck-File-Binding': 'none' }, body: JSON.stringify(input) });
    try {
      assert.deepEqual(await (await application.app.request(path, { headers: { cookie } })).json(), initial);
      const input: WorkspaceFileCardWrite = { kind: 'report', content: { title: 'Upgraded report', text: 'Durable next' }, revision: initial.revision, mutationId: randomUUID() };
      const response = await save(input); assert.equal(response.status, 200, await response.clone().text());
      assert.equal(response.headers.get('cache-control'), 'no-store'); const current = await response.json();
      await application.close(); application = createApplication(config);
      assert.deepEqual(await (await application.app.request(path, { headers: { cookie } })).json(), current);
      const replay = await save(first); assert.equal(replay.status, 200); assert.deepEqual(await replay.json(), current);
      assert.equal(writes, 2, 'real application must select awaited report command');
      await application.close();
      const check = new HubStore(config.hub.databaseFile, config.hub.vaultSecret, [], administratorKey);
      try { assert.deepEqual(check.cardFileProjection.get(userId, resource), current); } finally { await check.close(); }
    } finally { await application.close(); rmSync(root, { recursive: true, force: true }); }
  });
