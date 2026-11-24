import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { createApplication } from './application.js';
import { loadConfig } from './config.js';
import { HubStore } from './hub/hub-store.js';
import { OriginalHubAdministrativeCommands } from './hub/original-administrative-commands.js';

const administratorKey = 'isolated-activity-admin';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
for (const backend of ['json', 'sqlite'] as const) for (const credential of ['key', 'cookie'] as const) {
  for (const outcome of ['lost', 'cancel', 'cancel-lost', 'close'] as const) {
    test(`actual ${backend}/${credential} activity ${outcome} keeps original usage and recoverable credentials`, async t => {
      const root = mkdtempSync(join(tmpdir(), 'application-activity-'));
      const config = loadConfig({ HOME: root, AOD_SERVER_ROLE: 'hub', AOD_ACCESS_KEY: administratorKey,
        AOD_HUB_DATABASE_FILE: join(root, 'hub.sqlite'), AOD_HUB_VAULT_SECRET: 'isolated-vault',
        AOD_PASSKEYS_FILE: join(root, 'passkeys.json'), AOD_AUTH_SESSIONS_FILE: join(root, 'sessions.json'),
        AOD_SESSION_TITLES_FILE: join(root, 'titles.json'),
        ...(backend === 'sqlite' ? { AOD_AUTH_SQLITE_FILE: join(root, 'auth.sqlite') } : {}) });
      // All fixture seeding finishes before the actual application opens its
      // ONE original writer. No parallel connection or production state.
      const seed = new HubStore(config.hub.databaseFile, config.hub.vaultSecret, [], administratorKey);
      const member = seed.createUser('Original activity member'), key = seed.identities.issueKey(member.id);
      const token = seed.identities.createSession(key.token)!;
      (seed as unknown as { db: DatabaseSync }).db.exec('DELETE FROM hub_key_usage; DELETE FROM hub_user_usage');
      await seed.close();
      const headers = credential === 'key' ? { 'x-agentopsdeck-key': key.token } : { cookie: 'agentopsdeck_session=' + token };
      let release!: () => void, entered!: () => void, writes = 0;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const arrived = new Promise<void>(resolve => { entered = resolve; });
      const original = OriginalHubAdministrativeCommands.prototype.command;
      t.mock.method(OriginalHubAdministrativeCommands.prototype, 'command', function(this: OriginalHubAdministrativeCommands, kind: never, input: never) {
        const result = original.call(this, kind, input);
        if (kind !== 'memberActivity' || ++writes !== 1) return result;
        return result.then(async value => {
          entered();
          if (outcome === 'lost') throw Error('PRIVATE original activity reply ' + key.token);
          await gate;
          if (outcome === 'cancel-lost') throw Error('PRIVATE aborted original activity reply ' + key.token);
          return value;
        });
      });
      let application = createApplication(config);
      const controller = new AbortController();
      const response = application.app.request('/api/auth/status', { headers, signal: controller.signal });
      try {
        await arrived;
        if (outcome === 'cancel' || outcome === 'cancel-lost') controller.abort();
        let drained = false;
        const closing = outcome === 'close' ? application.close().then(() => { drained = true; }) : undefined;
        if (closing) {
          await tick(); assert.equal(drained, false);
          assert.equal((await application.app.request('/api/auth/status', { headers })).status, 503);
          assert.equal(writes, 1);
        }
        release();
        const result = await response;
        assert.equal(result.status, outcome === 'cancel' ? 408 : 503);
        assert.equal(result.headers.get('set-cookie'), null);
        assert.doesNotMatch(await result.text(), /PRIVATE|hub_key_/);
        await closing; await application.close();
        assert.equal(writes, 1, 'no hidden activity replay');
        const reopened = new HubStore(config.hub.databaseFile, config.hub.vaultSecret, [], administratorKey);
        let usage: unknown;
        try {
          usage = reopened.identities.userUsage(member.id);
          assert.equal(typeof (usage as { lastActiveAt: unknown }).lastActiveAt, 'number');
          assert.equal(reopened.identities.requestIdentity(new Request('http://fixture.invalid/', { headers }))?.userId, member.id);
        } finally { await reopened.close(); }
        application = createApplication(config);
        const explicit = await application.app.request('/api/auth/status', { headers });
        assert.equal(explicit.status, 200); assert.equal((await explicit.json()).authenticated, true);
        await application.close();
        const old = new HubStore(config.hub.databaseFile, config.hub.vaultSecret, [], administratorKey);
        try { assert.deepEqual(old.identities.userUsage(member.id), usage, 'original 60-second usage throttle survives reopen'); }
        finally { await old.close(); }
        assert.equal(writes, 2, 'only the explicit next request starts another observation');
      } finally { release(); await response; await application.close(); rmSync(root, { recursive: true, force: true }); }
    });
  }
}
