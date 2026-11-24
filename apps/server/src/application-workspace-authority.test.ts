import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from './application.js';
import { loadConfig } from './config.js';
import { HubStore } from './hub/hub-store.js';
import { OriginalHubAdministrativeCommands } from './hub/original-administrative-commands.js';
import { encodeHubSessionId } from './hub/session-id.js';

for (const backend of ['json', 'sqlite'] as const) for (const member of [false, true])
  test(`application workspace authority ${backend}/${member}: real async lane and original cookie survive reopen`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'application-workspace-authority-')), administratorKey = 'isolated-workspace-administrator';
    const config = loadConfig({ HOME: root, AOD_SERVER_ROLE: 'hub', AOD_ACCESS_KEY: administratorKey,
      AOD_HUB_DATABASE_FILE: join(root, 'hub.sqlite'), AOD_HUB_VAULT_SECRET: 'isolated-workspace-vault',
      AOD_PASSKEYS_FILE: join(root, 'passkeys.json'), AOD_AUTH_SESSIONS_FILE: join(root, 'sessions.json'),
      AOD_SESSION_TITLES_FILE: join(root, 'titles.json'), AOD_CONNECTOR_TOKENS_FILE: join(root, 'tokens.json'),
      AOD_CONNECTOR_USERS_DATABASE_FILE: join(root, 'connector.sqlite'),
      ...(backend === 'sqlite' ? { AOD_AUTH_SQLITE_FILE: join(root, 'auth.sqlite') } : {}) });
    const seed = new HubStore(config.hub.databaseFile, config.hub.vaultSecret, [], administratorKey);
    const userId = member ? seed.createUser('Workspace member').id : 'default', key = seed.identities.issueKey(userId);
    const cookie = 'agentopsdeck_session=' + seed.identities.createSession(key.token)!;
    await seed.close(); let application = createApplication(config), targets = 0;
    const original = OriginalHubAdministrativeCommands.prototype.command;
    t.mock.method(OriginalHubAdministrativeCommands.prototype, 'command', function(this: OriginalHubAdministrativeCommands, kind: never, input: never) {
      if (kind === 'connectionTarget') targets++; return original.call(this, kind, input);
    });
    try {
      for (let round = 0; round < 2; round++) {
        for (const action of ['sync', 'check']) {
          const sessionKey = encodeHubSessionId('not-owned', 'codex:original');
          const response = await application.app.request('/api/hub/v1/workspace/' + action, { method: 'POST',
            headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ version: 1, items: [{ sessionKey, limit: 200 }] }) });
          assert.equal(response.status, 200, await response.clone().text()); assert.equal(response.headers.get('cache-control'), 'no-store');
          assert.deepEqual(JSON.parse((await response.text()).trim()), { sessionKey, status: 404, body: { error: 'session not found' } });
        }
        await application.close(); if (round === 0) application = createApplication(config);
      }
      assert.equal(targets, 4, 'real application selects original awaited connection proof on every request');
    } finally { await application.close(); rmSync(root, { recursive: true, force: true }); }
  });
