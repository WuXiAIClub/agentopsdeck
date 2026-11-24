import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_HUB_NOTEBOOK_LAYOUT } from '@agentopsdeck/shared';
import { createApplication } from './application.js';
import { loadConfig } from './config.js';
import { HubStore } from './hub/hub-store.js';
import { OriginalHubAdministrativeCommands } from './hub/original-administrative-commands.js';

const tick = () => new Promise<void>(yes => setImmediate(yes));
for (const backend of ['json', 'sqlite'] as const) for (const member of [false, true])
  for (const area of ['hot', 'cold', 'layout'] as const) for (const outcome of ['normal', 'lost', 'cancel-lost', 'close'] as const) {
    test(`application private notebook ${backend}/${member ? 'member' : 'administrator'}/${area}/${outcome}: durable CAS without replay`, async t => {
      const root = mkdtempSync(join(tmpdir(), 'application-notebook-'));
      const administratorKey = 'isolated-notebook-administrator';
      const config = loadConfig({ HOME: root, AOD_SERVER_ROLE: 'hub', AOD_ACCESS_KEY: administratorKey,
        AOD_HUB_DATABASE_FILE: join(root, 'hub.sqlite'), AOD_HUB_VAULT_SECRET: 'isolated-notebook-vault',
        AOD_PASSKEYS_FILE: join(root, 'passkeys.json'), AOD_AUTH_SESSIONS_FILE: join(root, 'sessions.json'),
        AOD_SESSION_TITLES_FILE: join(root, 'titles.json'), AOD_CONNECTOR_TOKENS_FILE: join(root, 'tokens.json'),
        AOD_CONNECTOR_USERS_DATABASE_FILE: join(root, 'connector.sqlite'),
        ...(backend === 'sqlite' ? { AOD_AUTH_SQLITE_FILE: join(root, 'auth.sqlite') } : {}) });
      const seed = new HubStore(config.hub.databaseFile, config.hub.vaultSecret, [], administratorKey);
      const userId = member ? seed.createUser('Notebook member').id : 'default';
      const key = seed.identities.issueKey(userId), cookie = `agentopsdeck_session=${seed.identities.createSession(key.token)!}`;
      const resourceId = JSON.stringify(area === 'layout' ? ['hub-notebook-layout', 1, 'default'] : ['hub-notebook', 1]);
      const body = { resourceId, revision: 1, text: area === 'layout'
        ? JSON.stringify({ ...DEFAULT_HUB_NOTEBOOK_LAYOUT, title: 'Saved notebook' }) : '**PRIVATE_NOTEBOOK_TEXT**\nUnicode 中文' };
      const seedBody = { resourceId, revision: 0, text: area === 'layout' ? JSON.stringify(DEFAULT_HUB_NOTEBOOK_LAYOUT) : 'Original text' };
      if (area === 'cold') seed.notebooks.saveArchive(userId, seedBody); else seed.notebooks.save(userId, seedBody);
      await seed.close();
      let application = createApplication(config), effects = 0, snapshots = 0, holding = outcome !== 'normal';
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>(yes => { release = yes; }), admission = new Promise<void>(yes => { entered = yes; });
      const original = OriginalHubAdministrativeCommands.prototype.command;
      t.mock.method(OriginalHubAdministrativeCommands.prototype, 'command', function(this: OriginalHubAdministrativeCommands, kind: never, input: never) {
        const reply = original.call(this, kind, input);
        if (String(kind) === 'personalNotebook' && (input as {command: {action: string}}).command.action === 'snapshotPrivate') snapshots++;
        if (String(kind) === 'personalNotebook' && (input as {command: {action: string}}).command.action === 'savePrivate') {
          effects++;
          if (holding) { holding = false; return reply.then(async value => {
            entered(); await gate;
            if (outcome === 'lost' || outcome === 'cancel-lost') throw Error('PRIVATE notebook ACK lost'); return value;
          }); }
        }
        return reply;
      });
      const path = '/api/hub/v1/notebooks/default' + (area === 'hot' ? '' : area === 'cold' ? '/archive' : '/layout');
      const headers = { cookie, 'content-type': 'application/json' };
      const send = (signal?: AbortSignal) => application.app.request(path, { method: 'PUT', headers,
        body: JSON.stringify(body), ...(signal ? { signal } : {}) });
      try {
        const controller = new AbortController(), pending = send(controller.signal);
        if (outcome !== 'normal') {
          await admission; assert.equal(effects, 1);
          if (outcome === 'cancel-lost') controller.abort();
          let settled = false; void Promise.resolve(pending).then(() => { settled = true; });
          await tick(); assert.equal(settled, false, 'mutation ACK remains owned after cancellation');
          if (outcome === 'close') {
            const closing = application.close(); let drained = false; void closing.then(() => { drained = true; });
            await tick(); assert.equal(drained, false); release();
            assert.equal((await pending).status, 503); await closing; assert.equal(drained, true);
          } else { release(); const response = await pending; assert.equal(response.status, 503);
            assert.doesNotMatch(await response.text(), /PRIVATE|hub_session_|ACK lost/); }
        } else assert.equal((await pending).status, 200);
        assert.equal(effects, 1);
        await application.close(); application = createApplication(config);
        const read = await application.app.request(path, { headers }); assert.equal(read.status, 200);
        assert.equal(read.headers.get('cache-control'), 'no-store');
        const state = await read.json(); assert.equal(state.revision, 2); assert.equal(state.text, body.text);
        assert.equal(snapshots, 1, 'read uses the async snapshot domain, not a save');
        assert.equal(effects, 1, 'reopen and read never replay original save');
        assert.equal((await send()).status, 409, 'legacy CAS has no receipt; old tab must refresh, not overwrite');
        assert.deepEqual(await (await application.app.request(path, { headers })).json(), state);
      } finally { release(); await application.close(); rmSync(root, { recursive: true, force: true }); }
    });
  }
