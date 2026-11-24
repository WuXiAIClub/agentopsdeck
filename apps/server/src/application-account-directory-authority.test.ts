import assert from 'node:assert/strict';
import test from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from './application.js';
import { loadConfig } from './config.js';
import { HubStore } from './hub/hub-store.js';
import { OriginalHubAdministrativeCommands } from './hub/original-administrative-commands.js';

for (const backend of ['json', 'sqlite'] as const) for (const member of [false, true])
  test(`application account directory ${backend}/${member}: existing cookie, fixed owner, reopen, no fallback`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'application-account-directory-'));
    const administratorKey = 'isolated-account-administrator';
    const config = loadConfig({ HOME: root, AOD_SERVER_ROLE: 'hub', AOD_ACCESS_KEY: administratorKey,
      AOD_CODEX_ENABLED: 'false', AOD_LOCAL_OPENCLAW_CLI: 'false',
      AOD_HUB_DATABASE_FILE: join(root, 'hub.sqlite'), AOD_HUB_VAULT_SECRET: 'isolated-account-vault',
      AOD_PASSKEYS_FILE: join(root, 'passkeys.json'), AOD_AUTH_SESSIONS_FILE: join(root, 'sessions.json'),
      AOD_SESSION_TITLES_FILE: join(root, 'titles.json'), AOD_CONNECTOR_TOKENS_FILE: join(root, 'tokens.json'),
      ...(backend === 'sqlite' ? { AOD_AUTH_SQLITE_FILE: join(root, 'auth.sqlite') } : {}) });
    const seed = new HubStore(config.hub.databaseFile, config.hub.vaultSecret, [], administratorKey);
    const userId = member ? seed.createUser('Original member').id : 'default';
    if (!member) (seed as unknown as { db: DatabaseSync }).db.prepare("INSERT INTO hub_roles VALUES (?, 'admin', 1)").run(userId);
    const other = seed.createUser('Private other'), key = seed.identities.issueKey(userId);
    const cookie = 'agentopsdeck_session=' + seed.identities.createSession(key.token)!;
    for (const [id, ownerUserId] of [['target', userId], ['foreign', other.id]]) seed.upsertConnection({
      id, ownerUserId, kind: 'remote', label: id === 'target' ? 'Original node' : 'Private node',
      connectorUrl: 'http://account-directory-fixture.invalid', credentialToken: 'PRIVATE_TOKEN',
    });
    await seed.close();
    let application = createApplication(config), poison = true, unavailable = false;
    const counts = { users: 0, directories: 0, checks: 0 };
    const original = OriginalHubAdministrativeCommands.prototype.command;
    t.mock.method(OriginalHubAdministrativeCommands.prototype, 'command', function(this: OriginalHubAdministrativeCommands, kind: never, input: never) {
      if (kind === 'userDirectory') counts.users++;
      if (kind === 'connectionDirectory') counts.directories++;
      if (kind === 'connectionDirectoryCheck') counts.checks++;
      if (unavailable && (kind === 'userDirectory' || kind === 'connectionDirectory')) return Promise.reject(Error('PRIVATE owner failure'));
      return original.call(this, kind, input);
    });
    for (const method of ['listUsersAsync', 'listConnectionsAsync', 'connectionDirectoryVersion'] as const) {
      const existing = HubStore.prototype[method];
      t.mock.method(HubStore.prototype, method, function(this: HubStore, ...args: never[]) {
        assert.equal(poison, false, 'configured account directory must not enter legacy ' + method);
        return (existing as (...args: never[]) => unknown).apply(this, args);
      });
    }
    const read = (kind: string) => application.app.fetch(new Request('http://fixture.invalid/api/hub/v1/' + kind, { headers: { cookie } }));
    const expect = async (kind: string, status: number) => {
      const response = await read(kind), text = await response.text(); assert.equal(response.status, status, text);
      assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('set-cookie'), null);
      assert.doesNotMatch(text, /PRIVATE_TOKEN|isolated-account-vault|credentialToken|authority_version/);
      if (status === 503) { assert.deepEqual(JSON.parse(text), { error: `hub_${kind}_unavailable` }); return; }
      const body = JSON.parse(text); assert.ok(Number.isSafeInteger(body.updatedAt));
      if (kind === 'users') {
        assert.ok(body.users.some((row: { id: string }) => row.id === userId));
        if (member) { assert.deepEqual(body.users.map((row: { id: string }) => row.id), [userId]); assert.doesNotMatch(text, /Private other|usage/); }
      } else assert.deepEqual(body.connections.map((row: { id: string }) => row.id), ['target']);
    };
    try {
      await expect('users', 200); await expect('connections', 200);
      assert.deepEqual(counts, { users: 1, directories: 1, checks: 2 });
      unavailable = true; await expect('users', 503); await expect('connections', 503); unavailable = false;
      poison = false; await application.close(); application = createApplication(config); poison = true;
      await expect('users', 200); await expect('connections', 200);
      assert.deepEqual(counts, { users: 3, directories: 3, checks: 4 });
    } finally { poison = false; await application.close(); rmSync(root, { recursive: true, force: true }); }
  });
