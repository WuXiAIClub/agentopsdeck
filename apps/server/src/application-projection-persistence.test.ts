import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WORKSPACE_FILE_CARD_KINDS, workspaceFileCardResource } from '@agentopsdeck/shared';
import { HUB_CONFIGURATION_KINDS } from './hub/member-configuration-domain.js';
import { configurationWrite } from './hub/configuration-test-fixtures.js';
import { createApplication } from './application.js';
import { loadConfig } from './config.js';
import { HubStore } from './hub/hub-store.js';
import { OriginalHubAdministrativeCommands } from './hub/original-administrative-commands.js';

for (const backend of ['json', 'sqlite'] as const) for (const member of [false, true])
  test(`application projection ${backend}/${member ? 'member' : 'administrator'}: all thirteen original read shapes and persisted sessions survive reopen`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'application-projection-')), administratorKey = 'isolated-projection-administrator';
    const config = loadConfig({ HOME: root, AOD_SERVER_ROLE: 'hub', AOD_ACCESS_KEY: administratorKey,
      AOD_HUB_DATABASE_FILE: join(root, 'hub.sqlite'), AOD_HUB_VAULT_SECRET: 'isolated-projection-vault',
      AOD_PASSKEYS_FILE: join(root, 'passkeys.json'), AOD_AUTH_SESSIONS_FILE: join(root, 'sessions.json'),
      AOD_SESSION_TITLES_FILE: join(root, 'titles.json'), AOD_CONNECTOR_TOKENS_FILE: join(root, 'tokens.json'),
      AOD_CONNECTOR_USERS_DATABASE_FILE: join(root, 'connector.sqlite'),
      ...(backend === 'sqlite' ? { AOD_AUTH_SQLITE_FILE: join(root, 'auth.sqlite') } : {}) });
    const seed = new HubStore(config.hub.databaseFile, config.hub.vaultSecret, [], administratorKey), id = randomUUID();
    const userId = member ? seed.createUser('Projection member').id : 'default', key = seed.identities.issueKey(userId);
    const cookie = `agentopsdeck_session=${seed.identities.createSession(key.token)!}`;
    for (const kind of HUB_CONFIGURATION_KINDS) assert.equal(seed.cardConfigurations.save(userId, id, configurationWrite(kind)).status, 'saved');
    assert.equal(seed.cards.save(userId, id, { title: 'Metric', value: '42', detail: '', tone: 'green', progress: 100, revision: 0, mutationId: randomUUID() }).status, 'saved');
    const expected = WORKSPACE_FILE_CARD_KINDS.map(kind => {
      const resource = workspaceFileCardResource(kind, kind === 'notebook' ? 'hub:default' : id);
      return { resource, document: seed.cardFileProjection.get(userId, resource) ?? null };
    });
    await seed.close();
    let application = createApplication(config), reads = 0;
    const original = OriginalHubAdministrativeCommands.prototype.command;
    t.mock.method(OriginalHubAdministrativeCommands.prototype, 'command', function(this: OriginalHubAdministrativeCommands, kind: never, input: never) {
      if (kind === 'workspaceProjection') reads++;
      return original.call(this, kind, input);
    });
    try {
      for (let round = 0; round < 2; round++) {
        for (const { resource, document } of expected) {
          const response = await application.app.request('/api/hub/v1/workspace/file-cards/' + encodeURIComponent(resource), { headers: { cookie } });
          assert.equal(response.status, document ? 200 : 404, await response.clone().text());
          assert.equal(response.headers.get('cache-control'), 'no-store');
          if (document) assert.deepEqual(await response.json(), document);
        }
        assert.equal(reads, (round + 1) * WORKSPACE_FILE_CARD_KINDS.length, 'application must use awaited original command, not a direct route read');
        await application.close();
        if (round === 0) application = createApplication(config);
      }
      const check = new HubStore(config.hub.databaseFile, config.hub.vaultSecret, [], administratorKey);
      try { for (const { resource, document } of expected) assert.deepEqual(check.cardFileProjection.get(userId, resource) ?? null, document); }
      finally { await check.close(); }
    } finally { await application.close(); rmSync(root, { recursive: true, force: true }); }
  });
