import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedFileBindings } from './hub/file-binding-test-fixtures.js';
import { createApplication } from './application.js';
import { loadConfig } from './config.js';
import { HubStore } from './hub/hub-store.js';
import { OriginalHubAdministrativeCommands } from './hub/original-administrative-commands.js';

for (const backend of ['json', 'sqlite'] as const) for (const member of [false, true])
  test('application binding ' + backend + '/' + member + ': real awaited board/card queries preserve authenticated sessions and metadata across reopen', async t => {
    const root = mkdtempSync(join(tmpdir(), 'application-binding-')), administratorKey = 'isolated-binding-administrator';
    const config = loadConfig({ HOME: root, AOD_SERVER_ROLE: 'hub', AOD_ACCESS_KEY: administratorKey,
      AOD_HUB_DATABASE_FILE: join(root, 'hub.sqlite'), AOD_HUB_VAULT_SECRET: 'isolated-binding-vault',
      AOD_PASSKEYS_FILE: join(root, 'passkeys.json'), AOD_AUTH_SESSIONS_FILE: join(root, 'sessions.json'),
      AOD_SESSION_TITLES_FILE: join(root, 'titles.json'), AOD_CONNECTOR_TOKENS_FILE: join(root, 'tokens.json'),
      AOD_CONNECTOR_USERS_DATABASE_FILE: join(root, 'connector.sqlite'),
      ...(backend === 'sqlite' ? { AOD_AUTH_SQLITE_FILE: join(root, 'auth.sqlite') } : {}) });
    const seed = new HubStore(config.hub.databaseFile, config.hub.vaultSecret, [], administratorKey);
    const userId = member ? seed.createUser('Binding member').id : 'default', key = seed.identities.issueKey(userId);
    const cookie = 'agentopsdeck_session=' + seed.identities.createSession(key.token)!, expected = seedFileBindings(seed, userId);
    await seed.close(); let application = createApplication(config), reads = 0, legacyReads = 0;
    const original = OriginalHubAdministrativeCommands.prototype.command;
    t.mock.method(OriginalHubAdministrativeCommands.prototype, 'command', function(this: OriginalHubAdministrativeCommands, kind: never, input: never) {
      if (kind === 'fileBindingRead') legacyReads++;
      if (kind === 'nativeFile' && (input as {command?: {action?: string}}).command?.action === 'current') reads++;
      return original.call(this, kind, input);
    });
    try {
      for (let round = 0; round < 2; round++) {
        for (const domain of ['board', 'card'] as const) {
          const path = domain === 'board' ? '/api/hub/v1/workspace/boards/default/file-binding'
            : '/api/hub/v1/workspace/file-cards/' + encodeURIComponent(expected.card.resourceId) + '/file-binding';
          const response = await application.app.request(path, { headers: { cookie } });
          assert.equal(response.status, 200, await response.clone().text()); assert.equal(response.headers.get('cache-control'), 'no-store');
          assert.deepEqual(await response.json(), { enabled: false, binding: expected[domain] });
        }
        const malformed = await application.app.request('/api/hub/v1/workspace/boards/invalid/file-binding', { headers: { cookie } });
        assert.equal(malformed.status, 400, 'composed service preserves the original malformed-ID rejection');
        await application.close(); if (round === 0) application = createApplication(config);
      }
      assert.equal(reads, 4, 'real application selects awaited metadata, malformed IDs admit no SQL command');
      assert.equal(legacyReads, 0, 'production binding HTTP no longer falls back to the metadata-only domain');
    } finally { await application.close(); rmSync(root, { recursive: true, force: true }); }
  });
