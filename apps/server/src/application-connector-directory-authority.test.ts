import assert from 'node:assert/strict';
import test from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CONNECTOR_PROTOCOL, CONNECTOR_PROTOCOL_HEADER } from '@agentopsdeck/shared';
import { createApplication } from './application.js';
import { loadConfig } from './config.js';
import { HubStore } from './hub/hub-store.js';
import { OriginalHubAdministrativeCommands } from './hub/original-administrative-commands.js';
import { NODE_ID_HEADER, EXPECTED_NODE_HEADER } from './connector/node-identity.js';
for (const backend of ['json', 'sqlite'] as const) for (const member of [false, true])
  for (const outcome of ['normal', 'epoch', 'cancel', 'close'] as const)
    test(`application directory ${backend}/${member}/${outcome}: original cookie, bounded read, reopen`, async t => {
      const root = mkdtempSync(join(tmpdir(), 'application-directory-authority-'));
      const administratorKey = 'isolated-directory-administrator', node = 'node_' + randomUUID();
      const config = loadConfig({ HOME: root, AOD_SERVER_ROLE: 'hub', AOD_ACCESS_KEY: administratorKey,
        AOD_CODEX_ENABLED: 'false', AOD_LOCAL_OPENCLAW_CLI: 'false',
        AOD_HUB_DATABASE_FILE: join(root, 'hub.sqlite'), AOD_HUB_VAULT_SECRET: 'isolated-directory-vault',
        AOD_PASSKEYS_FILE: join(root, 'passkeys.json'), AOD_AUTH_SESSIONS_FILE: join(root, 'sessions.json'),
        AOD_SESSION_TITLES_FILE: join(root, 'titles.json'), AOD_CONNECTOR_TOKENS_FILE: join(root, 'tokens.json'),
        ...(backend === 'sqlite' ? { AOD_AUTH_SQLITE_FILE: join(root, 'auth.sqlite') } : {}) });
      const seed = new HubStore(config.hub.databaseFile, config.hub.vaultSecret, [], administratorKey);
      const userId = member ? seed.createUser('Original member').id : 'default', key = seed.identities.issueKey(userId);
      if (!member) (seed as unknown as { db: DatabaseSync }).db.prepare("INSERT INTO hub_roles VALUES (?, 'admin', 1)").run(userId);
      const cookie = 'agentopsdeck_session=' + seed.identities.createSession(key.token)!;
      seed.upsertConnection({ id: 'target', ownerUserId: userId, kind: 'remote', label: 'Original node',
        connectorUrl: 'http://directory-authority-fixture.invalid', credentialToken: 'PRIVATE_TOKEN' });
      seed.pinConnectionNode('target', userId, seed.connectionAuthority('target', userId)!, node);
      await seed.close();
      let application = createApplication(config), reads = 0, checks = 0, snapshots = 0, poison = true, hold = outcome !== 'normal';
      let release!: () => void, entered!: () => void, database!: DatabaseSync;
      const gate = new Promise<void>(yes => { release = yes; }), admission = new Promise<void>(yes => { entered = yes; });
      const original = OriginalHubAdministrativeCommands.prototype.command;
      t.mock.method(OriginalHubAdministrativeCommands.prototype, 'command', function(this: OriginalHubAdministrativeCommands, kind: never, input: never) {
        database = (this as unknown as { store: { db: DatabaseSync } }).store.db;
        if (kind === 'connectionDirectory') snapshots++;
        if (kind === 'connectionDirectoryCheck') checks++;
        return original.call(this, kind, input);
      });
      for (const method of ['listUsersAsync', 'listConnectionsAsync', 'connectionDirectoryVersion'] as const) {
        const existing = HubStore.prototype[method];
        t.mock.method(HubStore.prototype, method, function(this: HubStore, ...args: never[]) {
          assert.equal(poison, false, 'configured production display must not enter legacy ' + method);
          return (existing as (...args: never[]) => unknown).apply(this, args);
        });
      }
      t.mock.method(globalThis, 'fetch', async (raw: Request | string | URL, init?: RequestInit) => {
        const request = raw instanceof Request ? raw : new Request(raw, init), url = new URL(request.url);
        assert.equal(url.origin, 'http://directory-authority-fixture.invalid'); assert.equal(request.method, 'GET');
        assert.equal(url.pathname, '/api/connector/v1/users'); assert.equal(request.headers.get(EXPECTED_NODE_HEADER), node);
        assert.equal(request.headers.get('authorization'), 'Bearer PRIVATE_TOKEN'); reads++;
        if (hold) { hold = false; entered(); await gate;
          if (outcome === 'epoch') database.prepare('UPDATE env_connections SET authority_version=authority_version+1 WHERE id=?').run('target');
        }
        return Response.json({ users: [{ id: 'original-user', label: 'Private user', createdAt: 1, updatedAt: 2 }], updatedAt: 2 },
          { headers: { [CONNECTOR_PROTOCOL_HEADER]: String(CONNECTOR_PROTOCOL.max), [NODE_ID_HEADER]: node } });
      });
      const request = (signal?: AbortSignal) => application.app.fetch(new Request('http://fixture.invalid/api/hub/v1/connector-users',
        { headers: { cookie }, ...(signal ? { signal } : {}) }));
      const expect = async (response: Response, code: number) => {
        const body = await response.text(); assert.equal(response.status, code, body);
        assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('set-cookie'), null);
        assert.doesNotMatch(body, /PRIVATE_TOKEN|credentialToken|authority_version/);
        if (code === 200) { const value = JSON.parse(body); assert.ok(Number.isSafeInteger(value.updatedAt));
          const row = value.connections.find((item: { id: string }) => item.id === 'target');
          assert.ok(row); assert.equal(row.supported, true); assert.equal(row.users[0].id, 'original-user');
        } else assert.doesNotMatch(body, /original-user|Private user/);
      };
      try {
        const controller = new AbortController(), pending = request(controller.signal);
        if (outcome !== 'normal') { await admission;
          if (outcome === 'cancel') controller.abort();
          if (outcome === 'close' || outcome === 'cancel') {
            let closed = false; const closing = application.close().then(() => { closed = true; });
            await new Promise<void>(done => setImmediate(done)); assert.equal(closed, false);
            release(); await expect(await pending, 503); await closing; assert.equal(closed, true);
          } else { release(); await expect(await pending, 503); }
        } else await expect(await pending, 200);
        assert.equal(reads, 1); assert.ok(snapshots >= 1); assert.ok(checks >= 2);
        poison = false; await application.close(); application = createApplication(config); poison = true;
        await expect(await request(), 200); assert.equal(reads, 2, 'recovery reads once without replaying an old request');
      } finally { release(); poison = false; await application.close(); rmSync(root, { recursive: true, force: true }); }
    });
